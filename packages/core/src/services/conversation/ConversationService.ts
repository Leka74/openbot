/**
 * ConversationService (architecture §4.3): groups, membership, read state, history paging,
 * rename/hide, and the transcript writes every other service uses (persist, then publish).
 */
import type {
  Bot,
  BotId,
  Conversation,
  ConversationId,
  EntryId,
  ExchangePage,
  KnownConversationEvent,
  KnownTranscriptEntry,
  TranscriptEntry,
  TranscriptPage,
  TranscriptWindow,
} from "@openbot/contracts"
import { Conflict, InvalidInput, MAX_GROUP_BOTS, MIN_GROUP_BOTS, NotFound } from "@openbot/contracts"
import { Clock, Effect, Layer, Option } from "effect"
import { IdGen } from "../../ports/IdGen.ts"
import {
  BotRepo,
  ConversationRepo,
  type EntryPage,
  type EntryPageAfter,
  EntryRepo,
  type EntryPosition,
  ReplicaLog,
  RequestRepo,
  SettingsRepo,
  TurnRepo,
} from "../../ports/repos.ts"
import { ConversationService, type EntryDraft, LiveHub } from "../../ports/services.ts"
import { ConversationStore, ConversationStoreLive } from "./internal/ConversationStore.ts"
import { summarize, visiblePage, visiblePageAfter } from "./internal/summary.ts"
import { cardRequestId, compact, isHousekeeping, orDie, required } from "./internal/util.ts"
import { currentProfileId } from "../../ports/Profiles.ts"
import { hasMemberIn } from "../profiles/lookup.ts"

/** Upper bound for `conversations.history` and `conversations.exchange` pages. */
export const MAX_HISTORY_LIMIT = 500
/** Upper bound for `conversations.around` windows. */
export const MAX_AROUND_LIMIT = 200
const MAX_TITLE_LENGTH = 200
const groupNonceKey = (nonce: string) => `brain.groupNonce.${nonce}`

type GroupConversation = Extract<Conversation, { kind: "group" }>

/** Entry kinds that move the conversation (activity time, unread, preview). */
const touchesConversation = (entry: KnownTranscriptEntry): boolean =>
  (entry.kind === "message" || entry.kind === "card" || entry.kind === "event" || entry.kind === "notice") &&
  !isHousekeeping(entry)

/** Bookkeeping applied to the conversation when `entry` is appended. */
export const bumpForEntry = (conversation: Conversation, entry: KnownTranscriptEntry): Conversation => {
  const lastActivityAt = Math.max(conversation.lastActivityAt, entry.createdAt)
  if (entry.kind === "message" && entry.role === "user") {
    // The owner is writing here: everything before is read.
    const { unreadBoundaryAt: _drop, ...rest } = conversation
    return { ...rest, lastActivityAt, unreadCount: 0 } as Conversation
  }
  const countsAsUnread =
    (entry.kind === "message" && entry.author.kind === "bot") ||
    (entry.kind === "card" && (entry.state.status === "pending" || entry.card.type === "ui")) ||
    (entry.kind === "notice" && entry.level === "error")
  if (!countsAsUnread) return { ...conversation, lastActivityAt }
  return {
    ...conversation,
    lastActivityAt,
    unreadCount: conversation.unreadCount + 1,
    unreadBoundaryAt:
      conversation.unreadCount === 0 ? entry.createdAt : (conversation.unreadBoundaryAt ?? entry.createdAt),
  }
}

/** `conversations.exchange` cursor `"<createdAt>:<id>"` (ids never contain ':'); opaque to clients. */
const exchangeCursor = (entry: EntryPosition): string => `${entry.createdAt}:${entry.id}`
const parseExchangeCursor = (cursor: string): EntryPosition | undefined => {
  const index = cursor.indexOf(":")
  const createdAt = Number(cursor.slice(0, index))
  const id = cursor.slice(index + 1)
  return index > 0 && Number.isInteger(createdAt) && id.length > 0 ? { createdAt, id } : undefined
}

/** "Scout, Writer & Reviewer". */
export const groupTitleFor = (names: ReadonlyArray<string>): string =>
  names.length <= 1 ? (names[0] ?? "Group") : `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`

export const ConversationServiceLive: Layer.Layer<
  ConversationService,
  never,
  LiveHub | ConversationRepo | EntryRepo | RequestRepo | TurnRepo | ReplicaLog | BotRepo | SettingsRepo | IdGen
> = Layer.effect(
  ConversationService,
  Effect.gen(function* () {
    const hub = yield* LiveHub
    const store = yield* ConversationStore
    const conversations = yield* ConversationRepo
    const entries = yield* EntryRepo
    const requests = yield* RequestRepo
    const bots = yield* BotRepo
    const settings = yield* SettingsRepo
    const ids = yield* IdGen
    const repos = yield* Effect.context<EntryRepo | RequestRepo | TurnRepo>()
    const turnRepo = yield* TurnRepo
    /** Part of work handed over on a voice call (it does not move the conversation). */
    const inVoiceTurn = (entry: KnownTranscriptEntry) =>
      entry.turnId === undefined
        ? Effect.succeed(false)
        : turnRepo.get(entry.turnId).pipe(
            Effect.map((t) => t._tag === "Some" && t.value.voice === true),
            Effect.orElseSucceed(() => false),
          )

    // ------------------------------------------------------------------ transcript writes

    const publishEntry = (entry: TranscriptEntry) =>
      entry.kind === "unknown"
        ? Effect.void
        : Effect.asVoid(hub.publishConversation(entry.conversationId, { type: "entry.upserted", entry }))

    const appendEntry = Effect.fn("ConversationService.appendEntry")(function* (draft: EntryDraft) {
      const conversation = yield* store.get(draft.conversationId)
      const now = yield* Clock.currentTimeMillis
      const id = draft.id ?? (yield* ids.entryId)
      const entry = compact({ ...draft, id, revision: 0, createdAt: now, updatedAt: now } as KnownTranscriptEntry)
      const outcome = yield* orDie(entries.upsert(entry))
      if (!outcome.applied) return outcome.current
      yield* publishEntry(outcome.value)
      if (touchesConversation(entry) && !(yield* inVoiceTurn(entry)))
        yield* Effect.ignore(store.update(conversation.id, (c) => bumpForEntry(c, entry)))
      return outcome.value
    })

    const updateEntry = Effect.fn("ConversationService.updateEntry")(function* (
      entryId: KnownTranscriptEntry["id"],
      update: (entry: KnownTranscriptEntry) => KnownTranscriptEntry,
    ) {
      return yield* store.withEntryLock(
        Effect.gen(function* () {
          const current = yield* orDie(entries.get(entryId))
          if (Option.isNone(current) || current.value.kind === "unknown") {
            return yield* new NotFound({ entity: "entry", id: entryId })
          }
          const before = current.value
          const now = yield* Clock.currentTimeMillis
          const next = compact({
            ...update(before),
            id: before.id,
            conversationId: before.conversationId,
            createdAt: before.createdAt,
            revision: before.revision + 1,
            updatedAt: now,
          } as KnownTranscriptEntry)
          const outcome = yield* orDie(entries.upsert(next))
          if (!outcome.applied) return outcome.current
          yield* publishEntry(outcome.value)
          // A finished bot message changes the sidebar preview.
          if (before.kind === "message" && before.streaming && next.kind === "message" && !next.streaming)
            yield* store.publishSummary(before.conversationId)
          return outcome.value
        }),
      )
    })

    // ------------------------------------------------------------------ groups

    /** Bots of the current profile: a group never mixes profiles. */
    const loadBots = (botIds: ReadonlyArray<BotId>) =>
      Effect.flatMap(currentProfileId, (profileId) =>
        Effect.forEach(botIds, (id) =>
          Effect.flatMap(required(bots.get(id), "bot", id), (bot) =>
            bot.ownerProfileId === profileId ? Effect.succeed(bot) : Effect.fail(new NotFound({ entity: "bot", id })),
          ),
        ),
      )

    const validateMembers = (memberBotIds: ReadonlyArray<BotId>) =>
      Effect.gen(function* () {
        const unique = [...new Set(memberBotIds)]
        if (unique.length !== memberBotIds.length) {
          return yield* new InvalidInput({ message: "A bot can only be in a group once." })
        }
        if (unique.length < MIN_GROUP_BOTS || unique.length > MAX_GROUP_BOTS) {
          return yield* new InvalidInput({
            message: `A group has ${MIN_GROUP_BOTS} to ${MAX_GROUP_BOTS} bots (got ${unique.length}).`,
          })
        }
        return yield* loadBots(unique)
      })

    const asGroup = (conversation: Conversation) =>
      conversation.kind === "group"
        ? Effect.succeed(conversation)
        : Effect.fail(new InvalidInput({ message: "Only group conversations have members." }))

    const validTitle = (title: string) => {
      const trimmed = title.trim()
      if (trimmed.length === 0) return Effect.fail(new InvalidInput({ message: "The title cannot be empty." }))
      if (trimmed.length > MAX_TITLE_LENGTH) {
        return Effect.fail(new InvalidInput({ message: `The title is longer than ${MAX_TITLE_LENGTH} characters.` }))
      }
      return Effect.succeed(trimmed)
    }

    const appendEvent = (input: {
      readonly conversationId: ConversationId
      readonly event: KnownConversationEvent
      readonly author?: KnownTranscriptEntry["author"] | undefined
      readonly turnId?: KnownTranscriptEntry["turnId"] | undefined
    }) =>
      appendEntry(
        compact({
          kind: "event" as const,
          conversationId: input.conversationId,
          author: input.author ?? { kind: "system" as const },
          event: input.event,
          turnId: input.turnId,
        }),
      )

    const createGroup = Effect.fn("ConversationService.createGroup")(function* (input: {
      readonly title: string
      readonly memberBotIds: ReadonlyArray<BotId>
      readonly leadBotId?: BotId | undefined
      readonly clientNonce?: string | undefined
    }) {
      const nonces = settings.forProfile(yield* currentProfileId)
      if (input.clientNonce !== undefined) {
        const known = yield* orDie(nonces.get(groupNonceKey(input.clientNonce)))
        if (Option.isSome(known) && typeof known.value === "string") {
          const existing = yield* orDie(conversations.get(known.value as ConversationId))
          if (Option.isSome(existing)) return existing.value
        }
      }
      const members = yield* validateMembers(input.memberBotIds)
      if (input.leadBotId !== undefined && !members.some((b) => b.id === input.leadBotId)) {
        return yield* new InvalidInput({ message: "The lead bot must be a member of the group." })
      }
      const named = input.title.trim().length > 0
      const title = named ? yield* validTitle(input.title) : groupTitleFor(members.map((b) => b.name))
      const now = yield* Clock.currentTimeMillis
      const group: GroupConversation = compact({
        id: yield* ids.conversationId,
        kind: "group" as const,
        title,
        memberBotIds: members.map((b) => b.id),
        leadBotId: input.leadBotId,
        namedBy: named ? ("user" as const) : ("app" as const),
        createdAt: now,
        lastActivityAt: now,
        unreadCount: 0,
        hiddenFromSidebar: false,
        epoch: yield* ids.next("epc"),
      })
      yield* store.create(group)
      if (input.clientNonce !== undefined) yield* orDie(nonces.set(groupNonceKey(input.clientNonce), group.id))
      for (const bot of members) {
        yield* Effect.ignore(
          appendEvent({ conversationId: group.id, event: { type: "joined", botId: bot.id, name: bot.name } }),
        )
      }
      return yield* store.get(group.id)
    })

    const setMembers = Effect.fn("ConversationService.setMembers")(function* (input: {
      readonly conversationId: ConversationId
      readonly memberBotIds: ReadonlyArray<BotId>
      readonly leadBotId?: BotId | null | undefined
    }) {
      const group = yield* asGroup(yield* store.get(input.conversationId))
      const members = yield* validateMembers(input.memberBotIds)
      const memberIds = members.map((b) => b.id)
      if (input.leadBotId !== undefined && input.leadBotId !== null && !memberIds.includes(input.leadBotId)) {
        return yield* new InvalidInput({ message: "The lead bot must be a member of the group." })
      }
      const lead =
        input.leadBotId === null
          ? undefined
          : (input.leadBotId ??
            (group.leadBotId !== undefined && memberIds.includes(group.leadBotId) ? group.leadBotId : undefined))
      const added = members.filter((b) => !group.memberBotIds.includes(b.id))
      const removedIds = group.memberBotIds.filter((id) => !memberIds.includes(id))
      const removed = yield* Effect.forEach(removedIds, (id) =>
        Effect.map(orDie(bots.get(id)), (bot): Pick<Bot, "id" | "name"> =>
          Option.getOrElse(bot, () => ({ id, name: id })),
        ),
      )
      const updated = yield* store.update(group.id, (current) => {
        if (current.kind !== "group") return current
        const { leadBotId: _lead, ...rest } = current
        return compact({
          ...rest,
          memberBotIds: memberIds,
          leadBotId: lead,
          sessions: current.sessions?.filter((s) => memberIds.includes(s.botId)),
        })
      })
      for (const bot of added) {
        yield* Effect.ignore(
          appendEvent({ conversationId: group.id, event: { type: "member-added", botId: bot.id, name: bot.name } }),
        )
      }
      for (const bot of removed) {
        yield* Effect.ignore(
          appendEvent({ conversationId: group.id, event: { type: "member-removed", botId: bot.id, name: bot.name } }),
        )
      }
      return added.length + removed.length > 0 ? yield* store.get(group.id) : updated
    })

    // ------------------------------------------------------------------ read state & metadata

    const markRead = Effect.fn("ConversationService.markRead")(function* (input: {
      readonly conversationId: ConversationId
      readonly unread?: boolean | undefined
      readonly at?: number | undefined
    }) {
      const conversation = yield* store.get(input.conversationId)
      if (input.unread !== true) {
        yield* store.update(conversation.id, (c) => {
          const { unreadBoundaryAt: _drop, ...rest } = c
          return { ...rest, unreadCount: 0 } as Conversation
        })
        return
      }
      const page = yield* orDie(entries.page({ conversationId: conversation.id, limit: 200 }))
      const last = page.entries[page.entries.length - 1]
      const boundary = input.at ?? last?.createdAt ?? conversation.lastActivityAt
      const after = page.entries.filter((e) => e.createdAt >= boundary).length
      yield* store.update(conversation.id, (c) => ({
        ...c,
        unreadCount: Math.max(1, after),
        unreadBoundaryAt: boundary,
      }))
    })

    const history = Effect.fn("ConversationService.history")(function* (input: {
      readonly conversationId: ConversationId
      readonly beforeCursor: string
      readonly limit: number
    }) {
      yield* store.get(input.conversationId)
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_HISTORY_LIMIT) {
        return yield* new InvalidInput({ message: `limit must be between 1 and ${MAX_HISTORY_LIMIT}.` })
      }
      const page = yield* orDie(
        Effect.provide(
          visiblePage({
            conversationId: input.conversationId,
            before: input.beforeCursor === "" ? undefined : input.beforeCursor,
            limit: input.limit,
          }),
          repos,
        ),
      )
      return compact<TranscriptPage>({
        entries: page.entries.filter((e) => e.kind !== "unknown"),
        hasMoreBefore: page.hasMoreBefore,
        beforeCursor: page.beforeCursor,
        precedingTimestamp: page.precedingTimestamp,
      })
    })

    const exchange = Effect.fn("ConversationService.exchange")(function* (input: {
      readonly botId: BotId
      readonly peerBotId: BotId
      readonly at?: number | undefined
      readonly before?: string | undefined
      readonly after?: string | undefined
      readonly limit: number
    }) {
      const { limit } = input
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
        return yield* new InvalidInput({ message: `limit must be between 1 and ${MAX_HISTORY_LIMIT}.` })
      }
      if ([input.at, input.before, input.after].filter((x) => x !== undefined).length > 1) {
        return yield* new InvalidInput({ message: "Pass at most one of at, before and after." })
      }
      if (input.botId === input.peerBotId)
        return yield* new InvalidInput({ message: "An exchange needs two different bots." })
      const a = yield* required(bots.get(input.botId), "bot", input.botId)
      const b = yield* required(bots.get(input.peerBotId), "bot", input.peerBotId)
      const scan = (direction: "older" | "newer", from: EntryPosition | undefined, size: number) =>
        orDie(
          entries.listExchange({
            botIds: [a.id, b.id],
            conversationIds: [a.directConversationId, b.directConversationId],
            direction,
            from,
            limit: size,
          }),
        )
      const positionOf = (cursor: string) => {
        const position = parseExchangeCursor(cursor)
        return position === undefined
          ? Effect.fail(new InvalidInput({ message: `Invalid cursor: ${cursor}` }))
          : Effect.succeed(position)
      }
      const page = (
        list: ReadonlyArray<TranscriptEntry>,
        moreBefore: boolean,
        moreAfter: boolean,
        edge?: EntryPosition,
      ): ExchangePage => {
        const first = list[0] ?? edge
        const last = list[list.length - 1] ?? edge
        return {
          entries: list,
          beforeCursor: moreBefore && first !== undefined ? exchangeCursor(first) : null,
          afterCursor: moreAfter && last !== undefined ? exchangeCursor(last) : null,
        }
      }
      if (input.before !== undefined) {
        const from = yield* positionOf(input.before)
        const older = yield* scan("older", from, limit)
        return page(older.entries, older.more, true, from)
      }
      if (input.after !== undefined) {
        const from = yield* positionOf(input.after)
        const newer = yield* scan("newer", from, limit)
        return page(newer.entries, true, newer.more, from)
      }
      if (input.at === undefined) {
        const newest = yield* scan("older", undefined, limit)
        return page(newest.entries, newest.more, false)
      }
      // Around `at`: up to half at or before it, the rest after; a short side leaves its room to the other.
      const bound: EntryPosition = { createdAt: input.at + 1, id: "" }
      const older = yield* scan("older", bound, limit)
      const newer = yield* scan("newer", bound, limit)
      const takeNewer = Math.min(newer.entries.length, Math.max(Math.floor(limit / 2), limit - older.entries.length))
      const takeOlder = Math.min(older.entries.length, limit - takeNewer)
      return page(
        [...older.entries.slice(older.entries.length - takeOlder), ...newer.entries.slice(0, takeNewer)],
        older.more || takeOlder < older.entries.length,
        newer.more || takeNewer < newer.entries.length,
      )
    })

    const around = Effect.fn("ConversationService.around")(function* (input: {
      readonly conversationId: ConversationId
      readonly entryId?: EntryId | undefined
      readonly beforeCursor?: string | undefined
      readonly afterCursor?: string | undefined
      readonly limit: number
    }) {
      yield* store.get(input.conversationId)
      const { conversationId, limit } = input
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AROUND_LIMIT) {
        return yield* new InvalidInput({ message: `limit must be between 1 and ${MAX_AROUND_LIMIT}.` })
      }
      if ([input.entryId, input.beforeCursor, input.afterCursor].filter((x) => x !== undefined).length > 1) {
        return yield* new InvalidInput({ message: "Pass at most one of entryId, beforeCursor and afterCursor." })
      }
      const cursorOf = (cursor: string) =>
        parseExchangeCursor(cursor) === undefined
          ? Effect.fail(new InvalidInput({ message: `Invalid cursor: ${cursor}` }))
          : Effect.succeed(cursor)
      const older = (before: string | undefined, size: number) =>
        size <= 0
          ? Effect.succeed({
              entries: [],
              hasMoreBefore: before !== undefined,
              beforeCursor: before ?? null,
            } as EntryPage)
          : orDie(Effect.provide(visiblePage({ conversationId, before, limit: size }), repos))
      const newer = (after: string, size: number) =>
        size <= 0
          ? Effect.succeed({ entries: [], hasMoreAfter: true, afterCursor: after } as EntryPageAfter)
          : orDie(Effect.provide(visiblePageAfter({ conversationId, after, limit: size }), repos))

      let list: ReadonlyArray<TranscriptEntry>
      let hasMoreBefore: boolean
      let hasMoreAfter: boolean
      let precedingTimestamp: number | undefined
      if (input.afterCursor !== undefined) {
        const page = yield* newer(yield* cursorOf(input.afterCursor), limit)
        list = page.entries
        hasMoreBefore = true
        hasMoreAfter = page.hasMoreAfter
      } else if (input.entryId === undefined) {
        // the page before a cursor, or the newest entries
        const before = input.beforeCursor === undefined ? undefined : yield* cursorOf(input.beforeCursor)
        const page = yield* older(before, limit)
        list = page.entries
        hasMoreBefore = page.hasMoreBefore
        hasMoreAfter = before !== undefined
        precedingTimestamp = page.precedingTimestamp
      } else {
        const anchor = yield* orDie(entries.get(input.entryId))
        if (Option.isNone(anchor) || anchor.value.conversationId !== conversationId) {
          return yield* new NotFound({ entity: "entry", id: input.entryId })
        }
        // Up to half before the entry, the rest after; a short side leaves its room to the other.
        const at = exchangeCursor(anchor.value)
        const room = limit - 1
        const before = yield* older(at, room)
        const after = yield* newer(at, room)
        const takeNewer = Math.min(after.entries.length, Math.max(Math.floor(room / 2), room - before.entries.length))
        const takeOlder = Math.min(before.entries.length, room - takeNewer)
        list = [
          ...before.entries.slice(before.entries.length - takeOlder),
          anchor.value,
          ...after.entries.slice(0, takeNewer),
        ]
        hasMoreBefore = before.hasMoreBefore || takeOlder < before.entries.length
        hasMoreAfter = after.hasMoreAfter || takeNewer < after.entries.length
        precedingTimestamp =
          takeOlder === before.entries.length
            ? before.precedingTimestamp
            : before.entries[before.entries.length - takeOlder - 1]?.createdAt
      }
      const shown = list.filter((e) => e.kind !== "unknown")
      const first = list[0]
      const last = list[list.length - 1]
      // the turns and card requests of the window, as the live replica has them
      const turnIds = [...new Set(shown.flatMap((e) => (e.turnId === undefined ? [] : [e.turnId])))]
      const windowTurns = (yield* Effect.forEach(turnIds, (id) => orDie(turnRepo.get(id)))).flatMap((t) =>
        Option.isSome(t) ? [t.value] : [],
      )
      const requestIds = [
        ...new Set(
          shown.flatMap((e) => {
            const id = e.kind === "card" ? cardRequestId(e.card) : undefined
            return id === undefined ? [] : [id]
          }),
        ),
      ]
      const windowRequests = (yield* Effect.forEach(requestIds, (id) => orDie(requests.get(id)))).flatMap((r) =>
        Option.isSome(r) ? [r.value] : [],
      )
      return compact<TranscriptWindow>({
        entries: shown,
        hasMoreBefore,
        hasMoreAfter,
        beforeCursor:
          hasMoreBefore && first !== undefined
            ? exchangeCursor(first)
            : hasMoreBefore
              ? (input.afterCursor ?? null)
              : null,
        afterCursor:
          hasMoreAfter && last !== undefined
            ? exchangeCursor(last)
            : hasMoreAfter
              ? (input.beforeCursor ?? null)
              : null,
        precedingTimestamp: precedingTimestamp as TranscriptWindow["precedingTimestamp"],
        turns: windowTurns,
        requests: windowRequests,
      })
    })

    return ConversationService.of({
      get: (conversationId) => store.get(conversationId),
      summaries: Effect.gen(function* () {
        const profileBots = new Set((yield* orDie(bots.listIn(yield* currentProfileId))).map((b) => b.id))
        const all = (yield* orDie(conversations.list())).filter((c) => hasMemberIn(c, profileBots))
        return yield* Effect.forEach(all, (c) => Effect.provide(summarize(c), repos))
      }),
      summary: (conversationId) =>
        Effect.flatMap(store.get(conversationId), (c) => Effect.provide(summarize(c), repos)),
      history,
      exchange,
      around,
      createGroup,
      setMembers,
      rename: Effect.fn("ConversationService.rename")(function* (conversationId: ConversationId, title: string) {
        const next = yield* validTitle(title)
        const before = yield* store.get(conversationId)
        const updated = yield* store.update(conversationId, (c) =>
          c.kind === "group" ? { ...c, title: next, namedBy: "user" as const } : { ...c, title: next },
        )
        if (before.kind === "group" && before.title !== next) {
          yield* Effect.ignore(appendEvent({ conversationId, event: { type: "name-changed", to: next } }))
          return yield* store.get(conversationId)
        }
        return updated
      }),
      markRead,
      setHidden: (conversationId, hidden) =>
        Effect.asVoid(store.update(conversationId, (c) => ({ ...c, hiddenFromSidebar: hidden }))),
      place: Effect.fn("ConversationService.place")(function* (conversationId, input) {
        const before = yield* store.get(conversationId)
        if (before.kind !== "group")
          return yield* new InvalidInput({ message: "Only group chats have their own place in the sidebar." })
        yield* store.update(conversationId, (c) => {
          if (c.kind !== "group") return c
          let next: typeof c = c
          if (input.sectionId !== undefined) {
            const { sectionId: _drop, ...rest } = next
            next = input.sectionId === null ? rest : { ...rest, sectionId: input.sectionId }
          }
          if (input.sidebarOrder !== undefined) {
            const { sidebarOrder: _drop, ...rest } = next
            next = input.sidebarOrder === null ? rest : { ...rest, sidebarOrder: input.sidebarOrder }
          }
          return next
        })
      }),
      appendEntry,
      updateEntry,
      removeEntry: Effect.fn("ConversationService.removeEntry")(function* (entryId) {
        yield* store.withEntryLock(
          Effect.gen(function* () {
            const current = yield* orDie(entries.get(entryId))
            if (Option.isNone(current)) return
            if (!(yield* orDie(entries.remove(entryId)))) return
            yield* hub.publishConversation(current.value.conversationId, {
              type: "entry.removed",
              entryId,
              reason: "retracted",
            })
            yield* store.publishSummary(current.value.conversationId)
          }),
        )
      }),
      appendEvent,
      appendNotice: (input) =>
        appendEntry(
          compact({
            kind: "notice" as const,
            conversationId: input.conversationId,
            author: { kind: "system" as const },
            level: input.level,
            code: input.code,
            text: input.text,
            turnId: input.turnId,
          }),
        ),
      removeGroup: Effect.fn("ConversationService.removeGroup")(function* (conversationId) {
        const conversation = yield* store.get(conversationId)
        if (conversation.kind !== "group") {
          return yield* new InvalidInput({
            message: "Only group chats can be deleted. A bot's direct chat is deleted with the bot.",
          })
        }
        yield* store.remove(conversationId)
      }),
      upsertRequest: Effect.fn("ConversationService.upsertRequest")(function* (request) {
        yield* store.get(request.conversationId)
        const value = compact(request)
        yield* orDie(requests.upsert(value))
        yield* hub.publishConversation(value.conversationId, { type: "request.upserted", request: value })
        yield* store.publishSummary(value.conversationId)
      }),
      createRoutineRunConversation: Effect.fn("ConversationService.createRoutineRunConversation")(function* (input) {
        yield* required(bots.get(input.botId), "bot", input.botId)
        const now = yield* Clock.currentTimeMillis
        const conversation: Conversation = {
          id: yield* ids.conversationId,
          kind: "routine-run",
          botId: input.botId,
          routineId: input.routineId,
          runId: input.runId,
          triggerSummary: input.triggerSummary,
          title: input.title.trim().length > 0 ? input.title.trim() : "Routine run",
          createdAt: now,
          lastActivityAt: now,
          unreadCount: 0,
          hiddenFromSidebar: false,
          epoch: yield* ids.next("epc"),
        }
        return yield* store.create(conversation)
      }),
    })
  }),
).pipe(Layer.provide(ConversationStoreLive))

/** Re-exported for the error union of `createGroup` / `setMembers` (kept for symmetry with the RPC). */
export type ConversationServiceError = NotFound | InvalidInput | Conflict

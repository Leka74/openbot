/**
 * SearchService: message search over `SearchRepo` for the owner (`search.query`,
 * `search.inConversation`) and for bots (`search_messages`; the repository enforces what a bot may
 * read). Validates input, turns words into a query (`parseSearchQuery`; never raw FTS syntax), and
 * maps repository hits to the contract (`SearchHit`).
 *
 * Bots also read chats back (`read_conversation`): the chats they are a member of now, and their own
 * messages with another bot (which live in both bots' DMs). Nothing else of the owner's chats with
 * other bots, and nothing of a group they left (Lekë's v1 rules, `SearchFilter`).
 */
import type {
  Bot,
  BotId,
  Conversation,
  ConversationId,
  EntryId,
  SearchHit,
  SearchPage,
  SearchPositions,
  TaskId,
  TranscriptEntry,
} from "@openbot/contracts"
import {
  BOT_SEARCH_TOTAL_CAP,
  DEFAULT_SEARCH_KINDS,
  InvalidInput,
  NotFound,
  SEARCH_PAGE_MAX,
  SEARCH_POSITIONS_MAX,
  SEARCH_QUERY_MAX_CHARS,
} from "@openbot/contracts"
import { Effect, Layer, Option } from "effect"
import {
  BotRepo,
  ConversationRepo,
  EntryRepo,
  type EntryPosition,
  type SearchRepoHit,
  SearchRepo,
  type SearchScope,
  TurnRepo,
} from "../../ports/repos.ts"
import { type BotChatRef, type BotReadPage, CANT_READ_MESSAGE, type SearchInput, SearchService } from "../../ports/services.ts"
import { visiblePage, visiblePageAfter, voiceWork } from "../conversation/internal/summary.ts"
import { compact, findBotByRef, isHousekeeping, orDie } from "../conversation/internal/util.ts"
import { decodeSearchCursor, encodeSearchCursor, parseSearchQuery, parseSnippet } from "./text.ts"

const invalid = (message: string) => new InvalidInput({ message })

/** Most entries a bot reads back at once. */
export const MAX_BOT_READ = 50

type ReadChat = Exclude<BotChatRef, { readonly kind: "all" }>

const cursorOf = (at: EntryPosition) => `${at.createdAt}:${at.id}`

export const SearchServiceLive: Layer.Layer<
  SearchService,
  never,
  SearchRepo | ConversationRepo | BotRepo | EntryRepo | TurnRepo
> = Layer.effect(
  SearchService,
  Effect.gen(function*() {
    const repo = yield* SearchRepo
    const conversations = yield* ConversationRepo
    const bots = yield* BotRepo
    const entries = yield* EntryRepo
    const turns = yield* TurnRepo
    const transcript = yield* Effect.context<EntryRepo | TurnRepo>()

    const checkQuery = (query: string) =>
      query.length > SEARCH_QUERY_MAX_CHARS
        ? Effect.fail(invalid(`A search is at most ${SEARCH_QUERY_MAX_CHARS} characters.`))
        : Effect.void

    const toHit = (hit: SearchRepoHit): SearchHit => {
      const { doc } = hit
      const { snippet, highlights } = parseSnippet(hit.snippet)
      return compact<SearchHit>({
        ref: doc.source === "task" ? { kind: "task", taskId: doc.refId as TaskId } : { kind: "entry", entryId: doc.refId as EntryId },
        conversationId: doc.conversationId,
        kind: doc.kind,
        author: doc.authorKind === "user"
          ? { kind: "owner" }
          : doc.authorKind === "bot" && doc.authorBotId !== undefined
          ? { kind: "bot", botId: doc.authorBotId }
          : { kind: "system" },
        toBotId: doc.toBotId,
        turnId: doc.turnId,
        createdAt: doc.createdAt as SearchHit["createdAt"],
        jumpEntryId: hit.jumpEntryId,
        snippet,
        highlights,
        })
    }

    const search = Effect.fn("SearchService.search")(function*(scope: SearchScope, input: SearchInput) {
      yield* checkQuery(input.query)
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > SEARCH_PAGE_MAX) {
        return yield* invalid(`limit must be between 1 and ${SEARCH_PAGE_MAX}.`)
      }
      if (input.from !== undefined && input.to !== undefined && input.from > input.to) {
        return yield* invalid("from must not be after to.")
      }
      const sort = input.sort ?? "relevance"
      const after = input.cursor === undefined ? undefined : decodeSearchCursor(input.cursor, sort)
      if (input.cursor !== undefined && after === undefined) return yield* invalid(`Invalid cursor: ${input.cursor}`)
      const indexing = yield* repo.indexing
      const match = parseSearchQuery(input.query)
      if (match === undefined) {
        return {
          page: compact<SearchPage>({ hits: [], nextCursor: null, totalCapped: 0, terms: [], indexing: indexing || undefined }),
          hitCursors: [],
        }
      }
      const page = yield* orDie(repo.query({
        scope,
        match,
        kinds: input.kinds ?? DEFAULT_SEARCH_KINDS,
        conversationIds: input.conversationIds,
        botIds: input.botIds,
        senders: input.senders,
        exchangeWith: input.exchangeWith,
        from: input.from,
        to: input.to,
        sort,
        after,
        limit: input.limit,
        ...(scope.kind === "bot" ? { totalCap: BOT_SEARCH_TOTAL_CAP } : {}),
      }))
      return {
        page: compact<SearchPage>({
          hits: page.hits.map(toHit),
          nextCursor: page.next === undefined ? null : encodeSearchCursor(page.next),
          totalCapped: page.total,
          terms: match.terms,
          indexing: indexing || undefined,
        }),
        // where a page that stops after this hit continues
        hitCursors: page.hits.map(({ doc, rank }) =>
          encodeSearchCursor(
            sort === "relevance"
              ? { sort, rank, createdAt: doc.createdAt, refId: doc.refId }
              : { sort, createdAt: doc.createdAt, refId: doc.refId },
          )
        ),
      }
    })

    // ------------------------------------------------------------------ bots reading back

    const cantRead = () => invalid(CANT_READ_MESSAGE)
    const isMember = (botId: BotId, conversationId: ConversationId) =>
      orDie(conversations.members(conversationId)).pipe(Effect.map((members) => members.includes(botId)))
    const botOf = (botId: BotId) =>
      orDie(bots.get(botId)).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.fail(cantRead()), onSome: Effect.succeed })))

    /** The other bot of a bot-to-bot message of `botId` in a DM, if `entry` is one. */
    const peerOf = (botId: BotId, entry: TranscriptEntry) =>
      Effect.gen(function*() {
        if (entry.kind !== "message" || entry.author.kind !== "bot" || entry.toBotId === undefined) return undefined
        const conversation = yield* orDie(conversations.get(entry.conversationId))
        if (Option.isNone(conversation) || conversation.value.kind !== "direct") return undefined
        if (entry.author.botId === botId && entry.toBotId !== botId) return entry.toBotId
        if (entry.toBotId === botId && entry.author.botId !== botId) return entry.author.botId
        return undefined
      })

    /** What a bot reads in a chat: no reasoning, audit or housekeeping lines; its own steps when asked. */
    const shown = (botId: BotId, includeTools: boolean) => (entry: TranscriptEntry): boolean => {
      switch (entry.kind) {
        case "unknown":
        case "reasoning":
          return false
        case "tool-call":
          return includeTools && entry.author.kind === "bot" && entry.author.botId === botId
        case "event":
          return entry.event.type !== "auto-decided" && !isHousekeeping(entry)
        default:
          return true
      }
    }

    interface Scan {
      readonly entries: ReadonlyArray<TranscriptEntry>
      readonly more: boolean
    }

    /** Whether a bot may see this entry of a chat it may read: `shown`, and not a voice call's work. */
    const visible = (botId: BotId, includeTools: boolean) => {
      const keep = shown(botId, includeTools)
      const hidden = voiceWork(turns)
      return (entry: TranscriptEntry): Effect.Effect<boolean> =>
        keep(entry) ? Effect.map(hidden(entry), (voice) => !voice) : Effect.succeed(false)
    }

    /** `want` visible entries before (`older`) or after a position, oldest first. */
    const scan = (
      bot: Bot,
      chat: ReadChat,
      direction: "older" | "newer",
      from: EntryPosition | undefined,
      want: number,
      keep: (entry: TranscriptEntry) => Effect.Effect<boolean>,
    ): Effect.Effect<Scan> =>
      Effect.gen(function*() {
        if (want <= 0) return { entries: [], more: true }
        const older = direction === "older"
        const size = Math.max(want * 2, 20)
        let peer: Bot | undefined
        if (chat.kind === "exchange") {
          peer = Option.getOrUndefined(yield* orDie(bots.get(chat.peerBotId)))
          if (peer === undefined) return { entries: [], more: false }
        }
        /** One slice from `at` towards `direction`, in order. */
        const slice = (at: EntryPosition | undefined): Effect.Effect<Scan> =>
          peer !== undefined
            ? orDie(entries.listExchange({
              botIds: [bot.id, peer.id],
              conversationIds: [bot.directConversationId, peer.directConversationId],
              direction,
              from: at,
              limit: size,
            }))
            : chat.kind === "exchange"
            ? Effect.succeed({ entries: [], more: false })
            : older
            ? orDie(Effect.provide(
              visiblePage({ conversationId: chat.conversationId, before: at === undefined ? undefined : cursorOf(at), limit: size }),
              transcript,
            )).pipe(Effect.map((page) => ({ entries: page.entries, more: page.hasMoreBefore })))
            : orDie(Effect.provide(
              visiblePageAfter({ conversationId: chat.conversationId, after: cursorOf(at ?? { createdAt: -1, id: "0" }), limit: size }),
              transcript,
            )).pipe(Effect.map((page) => ({ entries: page.entries, more: page.hasMoreAfter })))
        const kept: Array<TranscriptEntry> = []
        let at = from
        while (true) {
          const page = yield* slice(at)
          const seen: Array<TranscriptEntry> = []
          for (const entry of page.entries) if (yield* keep(entry)) seen.push(entry)
          if (older) kept.unshift(...seen)
          else kept.push(...seen)
          const edge = older ? page.entries[0] : page.entries[page.entries.length - 1]
          if (kept.length >= want || !page.more || edge === undefined) {
            return {
              entries: older ? kept.slice(Math.max(0, kept.length - want)) : kept.slice(0, want),
              more: kept.length > want || page.more,
            }
          }
          at = edge
        }
      })

    const resolveForBot = Effect.fn("SearchService.resolveForBot")(function*(
      botId: BotId,
      current: ConversationId,
      ref: string | undefined,
      fallback: "all" | "current",
    ) {
      const bot = yield* botOf(botId)
      const raw = (ref ?? "").trim().replace(/^["']|["']$/g, "").trim()
      const key = raw.toLowerCase()
      if (key === "") return fallback === "all" ? { kind: "all" } as const : { kind: "conversation", conversationId: current } as const
      if (key === "all") return { kind: "all" } as const
      if (key === "current" || key === "this" || key === "here") return { kind: "conversation", conversationId: current } as const
      if (key === "owner" || key === "dm" || key === "my dm") return { kind: "conversation", conversationId: bot.directConversationId } as const
      const team = yield* orDie(bots.list)
      const teammate = findBotByRef(team, raw)
      if (teammate !== undefined) {
        if (teammate.id === botId) return { kind: "conversation", conversationId: bot.directConversationId } as const
        return { kind: "exchange", peerBotId: teammate.id } as const
      }
      if (raw.startsWith("@")) return yield* invalid(`No teammate is called ${raw}. list_bots lists the team.`)
      const byId = yield* orDie(conversations.get(raw as ConversationId))
      if (Option.isSome(byId)) {
        if (!(yield* isMember(botId, byId.value.id))) return yield* cantRead()
        return { kind: "conversation", conversationId: byId.value.id } as const
      }
      const groups = yield* orDie(conversations.list({ botId, kind: "group" }))
      const group = groups.find((g) => g.title.trim().toLowerCase() === key)
      if (group !== undefined) return { kind: "conversation", conversationId: group.id } as const
      return yield* invalid(
        `None of your conversations is called "${raw}". Use "current", "owner" (your DM with the owner), a group's title or id, or @Name (your messages with a teammate).`,
      )
    })

    const readForBot = Effect.fn("SearchService.readForBot")(function*(botId: BotId, input: {
      readonly chat?: ReadChat | undefined
      readonly around?: EntryId | undefined
      readonly before?: EntryId | undefined
      readonly after?: EntryId | undefined
      readonly limit: number
      readonly includeTools: boolean
    }) {
      const { limit } = input
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BOT_READ) {
        return yield* invalid(`limit must be between 1 and ${MAX_BOT_READ}.`)
      }
      if ([input.around, input.before, input.after].filter((x) => x !== undefined).length > 1) {
        return yield* invalid("Pass at most one of around, before and after.")
      }
      const bot = yield* botOf(botId)
      const anchorId = input.around ?? input.before ?? input.after
      const anchor = anchorId === undefined ? undefined : Option.getOrUndefined(yield* orDie(entries.get(anchorId)))
      // An entry the bot may not see (another bot's step or reasoning, a voice call's work, a hidden
      // line) is refused as if it did not exist. Its own steps it may open without include_tools.
      if (anchorId !== undefined && (anchor === undefined || !(yield* visible(botId, true)(anchor)))) return yield* cantRead()

      // the chat: asked for, or the one the entry belongs to as this bot may read it
      let chat = input.chat
      if (anchor !== undefined) {
        const member = yield* isMember(botId, anchor.conversationId)
        const peer = member ? undefined : yield* peerOf(botId, anchor)
        if (!member && peer === undefined) return yield* cantRead()
        const own: ReadChat = member
          ? { kind: "conversation", conversationId: anchor.conversationId }
          : { kind: "exchange", peerBotId: peer! }
        if (chat === undefined) chat = own
        else if (
          chat.kind === "conversation"
            ? chat.conversationId !== anchor.conversationId
            : (yield* peerOf(botId, anchor)) !== chat.peerBotId
        ) return yield* invalid("That message is not in that conversation.")
      }
      if (chat === undefined) return yield* invalid("Name the conversation to read.")
      if (chat.kind === "conversation" && !(yield* isMember(botId, chat.conversationId))) return yield* cantRead()
      if (chat.kind === "exchange" && (chat.peerBotId === botId || Option.isNone(yield* orDie(bots.get(chat.peerBotId))))) {
        return yield* cantRead()
      }

      const keep = visible(botId, input.includeTools)
      let list: ReadonlyArray<TranscriptEntry>
      let moreBefore: boolean
      let moreAfter: boolean
      if (anchor !== undefined && input.around !== undefined) {
        // up to half before it, the entry, the rest after; a short side leaves its room to the other
        const room = limit - 1
        const older = yield* scan(bot, chat, "older", anchor, room, keep)
        const newer = yield* scan(bot, chat, "newer", anchor, room, keep)
        const takeNewer = Math.min(newer.entries.length, Math.max(Math.floor(room / 2), room - older.entries.length))
        const takeOlder = Math.min(older.entries.length, room - takeNewer)
        list = [...older.entries.slice(older.entries.length - takeOlder), anchor, ...newer.entries.slice(0, takeNewer)]
        moreBefore = older.more || takeOlder < older.entries.length
        moreAfter = newer.more || takeNewer < newer.entries.length
      } else if (anchor !== undefined && input.before !== undefined) {
        const older = yield* scan(bot, chat, "older", anchor, limit, keep)
        list = older.entries
        moreBefore = older.more
        moreAfter = true
      } else if (anchor !== undefined) {
        const newer = yield* scan(bot, chat, "newer", anchor, limit, keep)
        list = newer.entries
        moreBefore = true
        moreAfter = newer.more
      } else {
        const tail = yield* scan(bot, chat, "older", undefined, limit, keep)
        list = tail.entries
        moreBefore = tail.more
        moreAfter = false
      }
      const first = list[0]
      const last = list[list.length - 1]
      const page: BotReadPage = {
        chat,
        entries: list,
        olderFrom: moreBefore ? first?.id ?? input.after : undefined,
        newerFrom: moreAfter ? last?.id ?? input.before : undefined,
      }
      return page
    })

    return SearchService.of({
      query: (input) => Effect.map(search({ kind: "owner" }, input), ({ page }) => page),
      forBot: (botId, input) => Effect.map(search({ kind: "bot", botId }, input), ({ page, hitCursors }) => ({ ...page, hitCursors })),

      inConversation: Effect.fn("SearchService.inConversation")(function*(input) {
        yield* checkQuery(input.query)
        if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > SEARCH_POSITIONS_MAX) {
          return yield* invalid(`limit must be between 1 and ${SEARCH_POSITIONS_MAX}.`)
        }
        if (Option.isNone(yield* orDie(conversations.get(input.conversationId)))) {
          return yield* new NotFound({ entity: "conversation", id: input.conversationId })
        }
        const indexing = (yield* repo.indexing) || undefined
        const base = {
          scope: { kind: "owner" } as const,
          conversationId: input.conversationId,
          kinds: input.kinds ?? DEFAULT_SEARCH_KINDS,
          limit: input.limit,
        }
        const match = parseSearchQuery(input.query)
        if (match !== undefined) {
          const found = yield* orDie(repo.positions({ ...base, match }))
          if (found.hits.length > 0) return compact<SearchPositions>({ ...found, terms: match.terms, indexing })
        }
        // No words (punctuation), or words that match no whole word: a plain substring.
        const substring = input.query.trim()
        if (substring === "") return compact<SearchPositions>({ hits: [], more: false, terms: [], indexing })
        const found = yield* orDie(repo.positions({ ...base, substring }))
        return compact<SearchPositions>({ ...found, terms: [substring.toLowerCase()], indexing })
      }),

      canRead: isMember,
      resolveForBot,
      readForBot,
      chats: (ids) =>
        Effect.gen(function*() {
          const found = new Map<ConversationId, Conversation>()
          for (const id of new Set(ids)) {
            const conversation = yield* orDie(conversations.get(id))
            if (Option.isSome(conversation)) found.set(id, conversation.value)
          }
          return found
        }),
    })
  }),
)

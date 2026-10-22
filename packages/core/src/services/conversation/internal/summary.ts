/**
 * Sidebar rows (`ConversationSummary`) derived from repositories. Shared by LiveHub (roster
 * snapshots) and the conversation store (roster `conversation.upserted` after each change).
 */
import type { Conversation, ConversationSummary, TranscriptEntry } from "@openbot/contracts"
import { Effect } from "effect"
import type { RepoError } from "../../../ports/errors.ts"
import {
  type EntryPage,
  type EntryPageAfter,
  type EntryPageAfterQuery,
  type EntryPageQuery,
  EntryRepo,
  RequestRepo,
  TurnRepo,
} from "../../../ports/repos.ts"
import { attachmentsLine, compact, conversationBotIds, describeEvent, isHousekeeping, previewOf } from "./util.ts"

/** How many tail entries are scanned for the preview line. */
const PREVIEW_SCAN = 20

/** Whether an entry is part of work handed over on a voice call (told on the call, not shown in the chat). Remembers each turn. */
export const voiceWork = (turns: TurnRepo["Service"]) => {
  const known = new Map<string, boolean>()
  return (entry: TranscriptEntry): Effect.Effect<boolean> =>
    Effect.gen(function*() {
      const turnId = entry.turnId
      if (turnId === undefined) return false
      if (!known.has(turnId)) known.set(turnId, yield* turns.get(turnId).pipe(Effect.map((t) => t._tag === "Some" && t.value.voice === true), Effect.orElseSucceed(() => false)))
      return known.get(turnId) === true
    })
}

/**
 * A page of the transcript as the chat shows it: voice calls' work left out, and pages read further
 * back until `limit` entries are left (or the start), so a chat with many calls still fills the screen.
 */
export const visiblePage = (query: EntryPageQuery): Effect.Effect<EntryPage, RepoError, EntryRepo | TurnRepo> =>
  Effect.gen(function*() {
    const entries = yield* EntryRepo
    const hidden = voiceWork(yield* TurnRepo)
    const shown: Array<TranscriptEntry> = []
    let before = query.before
    while (true) {
      const page = yield* entries.page({ ...query, before })
      const kept: Array<TranscriptEntry> = []
      for (const entry of page.entries) if (!(yield* hidden(entry))) kept.push(entry)
      shown.unshift(...kept)
      if (shown.length >= query.limit || !page.hasMoreBefore || page.beforeCursor === null) return { ...page, entries: shown }
      before = page.beforeCursor
    }
  })

/** `visiblePage` towards the newest: the entries after `after`, voice calls' work left out. */
export const visiblePageAfter = (query: EntryPageAfterQuery): Effect.Effect<EntryPageAfter, RepoError, EntryRepo | TurnRepo> =>
  Effect.gen(function*() {
    const entries = yield* EntryRepo
    const hidden = voiceWork(yield* TurnRepo)
    const shown: Array<TranscriptEntry> = []
    let after = query.after
    while (true) {
      const page = yield* entries.pageAfter({ ...query, after })
      for (const entry of page.entries) if (!(yield* hidden(entry))) shown.push(entry)
      if (shown.length >= query.limit || !page.hasMoreAfter || page.afterCursor === null) return { ...page, entries: shown }
      after = page.afterCursor
    }
  })

/** Preview: the last message text (or event line) in the tail of the transcript (voice calls' work aside). */
export const previewFor = (conversation: Conversation): Effect.Effect<string | undefined, never, EntryRepo | TurnRepo> =>
  Effect.gen(function*() {
    const entries = yield* EntryRepo
    const turns = yield* TurnRepo
    const page = yield* Effect.orDie(entries.page({ conversationId: conversation.id, limit: PREVIEW_SCAN }))
    const hidden = voiceWork(turns)
    for (let i = page.entries.length - 1; i >= 0; i--) {
      const entry = page.entries[i]!
      if (yield* hidden(entry)) continue
      if (entry.kind === "message" && entry.text.trim().length > 0) return previewOf(entry.text)
      if (entry.kind === "message" && entry.attachments.length > 0) return previewOf(attachmentsLine(entry.attachments))
      if (entry.kind === "event" && entry.event.type !== "unknown" && !isHousekeeping(entry)) return previewOf(describeEvent(entry.event))
    }
    return undefined
  })

export const summarize = (
  conversation: Conversation,
): Effect.Effect<ConversationSummary, never, EntryRepo | RequestRepo | TurnRepo> =>
  Effect.gen(function*() {
    const requests = yield* RequestRepo
    const pending = yield* Effect.orDie(requests.list({ conversationId: conversation.id, statuses: ["pending"] }))
    const preview = yield* previewFor(conversation)
    return compact<ConversationSummary>({
      id: conversation.id,
      kind: conversation.kind,
      title: conversation.title,
      botIds: conversationBotIds(conversation),
      lastActivityAt: conversation.lastActivityAt,
      preview,
      unreadCount: conversation.unreadCount,
      pendingRequestCount: pending.length,
      hiddenFromSidebar: conversation.hiddenFromSidebar,
      sectionId: conversation.kind === "group" ? conversation.sectionId : undefined,
      sidebarOrder: conversation.kind === "group" ? conversation.sidebarOrder : undefined,
    })
  })

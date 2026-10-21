/**
 * Sidebar rows (`ConversationSummary`) derived from repositories. Shared by LiveHub (roster
 * snapshots) and the conversation store (roster `conversation.upserted` after each change).
 */
import type { Conversation, ConversationSummary } from "@openbot/contracts"
import { Effect } from "effect"
import { EntryRepo, RequestRepo } from "../../../ports/repos.ts"
import { attachmentsLine, compact, conversationBotIds, describeEvent, isHousekeeping, previewOf } from "./util.ts"

/** How many tail entries are scanned for the preview line. */
const PREVIEW_SCAN = 20

/** Preview: the last message text (or event line) in the tail of the transcript. */
export const previewFor = (conversation: Conversation): Effect.Effect<string | undefined, never, EntryRepo> =>
  Effect.gen(function*() {
    const entries = yield* EntryRepo
    const page = yield* Effect.orDie(entries.page({ conversationId: conversation.id, limit: PREVIEW_SCAN }))
    for (let i = page.entries.length - 1; i >= 0; i--) {
      const entry = page.entries[i]!
      if (entry.kind === "message" && entry.text.trim().length > 0) return previewOf(entry.text)
      if (entry.kind === "message" && entry.attachments.length > 0) return previewOf(attachmentsLine(entry.attachments))
      if (entry.kind === "event" && entry.event.type !== "unknown" && !isHousekeeping(entry)) return previewOf(describeEvent(entry.event))
    }
    return undefined
  })

export const summarize = (
  conversation: Conversation,
): Effect.Effect<ConversationSummary, never, EntryRepo | RequestRepo> =>
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

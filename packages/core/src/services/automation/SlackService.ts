/**
 * SlackService (D3.4): Bots' Slack drafts, and the text a Slack-triggered routine run reads.
 *
 * - `draft` (`slack_draft`) resolves where the message goes with the `SlackConnector` and posts a
 *   pending `slack-draft` card in the conversation the Bot works in, plus a "waiting" notification.
 *   Nothing reaches Slack: the owner edits the text and presses Send (`slack.sendDraft`, the message
 *   goes out as them) or Discard. Drafts never expire and survive restarts (the card is the state).
 * - The Bot is not told what the owner did with the draft: the card shows it.
 */
import type { Attachment, EntryId, KnownTranscriptEntry, RoutineTrigger, SlackDraftCard } from "@openbot/contracts"
import { Conflict, InvalidInput, NotFound, Unavailable } from "@openbot/contracts"
import { Effect, Layer, Option } from "effect"
import { BotRepo, EntryRepo } from "../../ports/repos.ts"
import { AttachmentStore } from "../../ports/stores.ts"
import { Notifier } from "../../ports/Notifier.ts"
import { ConversationService, type EntryDraft, type ToolContext } from "../../ports/services.ts"
import { SlackConnector, type SlackConversation, type SlackEvent, SlackService } from "../../ports/Slack.ts"
import { oneLine, truncate } from "./text.ts"

/** Slack's own limit is 40,000 characters; a message that long is a mistake. */
export const SLACK_DRAFT_MAX_CHARS = 12_000

type DraftCardEntry = Extract<KnownTranscriptEntry, { kind: "card" }> & { readonly card: typeof SlackDraftCard.Type }

const isDraft = (entry: KnownTranscriptEntry): entry is DraftCardEntry => entry.kind === "card" && entry.card.type === "slack-draft"

/** "DM with Alice Smith", "group DM with Alice, Bob", "#general". */
export const describeSlackPlace = (conversation: SlackConversation): string =>
  conversation.kind === "dm"
    ? `DM with ${conversation.label}`
    : conversation.kind === "group-dm"
    ? `group DM with ${conversation.label}`
    : conversation.label

const sameChannel = (filter: string, conversation: SlackConversation): boolean => {
  const want = filter.trim().replace(/^#/, "").toLowerCase()
  return want === conversation.id.toLowerCase() || want === conversation.label.replace(/^#/, "").toLowerCase()
}

/** Whether a Slack routine trigger fires for `event`. */
export const slackTriggerMatches = (trigger: Extract<RoutineTrigger, { type: "slack" }>, event: SlackEvent): boolean => {
  const channel = trigger.channel?.trim()
  if (channel !== undefined && channel.length > 0 && !sameChannel(channel, event.conversation)) return false
  switch (trigger.on) {
    case "dm":
      return event.conversation.kind === "dm" || event.conversation.kind === "group-dm"
    case "mention":
      return event.mentionsOwner
    case "phrase": {
      const phrase = (trigger.phrase ?? "").trim().toLowerCase()
      return phrase.length > 0 && event.message.text.toLowerCase().includes(phrase)
    }
    case "message":
      return true
  }
}

const clock = (ts: string): string => {
  const d = new Date(Number(ts) * 1000)
  return Number.isNaN(d.getTime()) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/**
 * What a Slack-triggered routine run reads after its prompt: the messages (one conversation's in a
 * row are grouped), with what a reply needs (`slack_draft` `to` and `thread`).
 */
export const slackEventsText = (events: ReadonlyArray<SlackEvent>): string => {
  const groups: Array<{ conversation: SlackConversation; events: Array<SlackEvent> }> = []
  for (const event of events) {
    const last = groups.at(-1)
    if (last !== undefined && last.conversation.id === event.conversation.id) last.events.push(event)
    else groups.push({ conversation: event.conversation, events: [event] })
  }
  return groups.map(({ conversation, events: group }) => {
    const lines = [`[Slack · ${describeSlackPlace(conversation)}]`]
    for (const { message } of group) {
      const files = message.files === undefined || message.files.length === 0 ? "" : ` [files: ${message.files.join(", ")}]`
      lines.push(`${message.author}, ${clock(message.ts)}: ${truncate(message.text, 4_000)}${files}`)
    }
    const latest = group.at(-1)!.message
    const thread = latest.threadTs !== undefined && latest.threadTs !== latest.ts ? latest.threadTs : undefined
    lines.push(
      `(to: ${conversation.id} · ts: ${latest.ts}${thread === undefined ? "" : ` · in thread: ${thread}`} · ${latest.permalink})`,
    )
    return lines.join("\n")
  }).join("\n\n")
}

const notConnected = new Unavailable({ message: "Slack isn't connected (Connect apps › Slack)." })

export const makeSlackService = Effect.gen(function*() {
  const conversations = yield* ConversationService
  const entries = yield* EntryRepo
  const bots = yield* BotRepo
  const notifier = yield* Notifier
  const attachments = yield* AttachmentStore
  const connector = Option.getOrUndefined(yield* Effect.serviceOption(SlackConnector))

  /** Tool call id → its draft (D3.3 idempotency), bounded. */
  const byCall = new Map<string, { readonly entryId: EntryId; readonly to: string; readonly inThread: boolean }>()
  /** Drafts being sent right now (a double click sends once). */
  const sending = new Set<EntryId>()

  const draft = (
    ctx: ToolContext,
    input: { readonly to: string; readonly text: string; readonly thread?: string | undefined; readonly files?: ReadonlyArray<Attachment> | undefined },
  ) =>
    Effect.gen(function*() {
      const key = ctx.callId === undefined ? undefined : `${ctx.claims.botId}:${ctx.callId}`
      const known = key === undefined ? undefined : byCall.get(key)
      if (known !== undefined) return known
      if (connector === undefined) return yield* notConnected
      const text = input.text.trim()
      const files = input.files ?? []
      if (text.length === 0 && files.length === 0) return yield* new InvalidInput({ message: "The message is empty." })
      if (text.length > SLACK_DRAFT_MAX_CHARS) {
        return yield* new InvalidInput({ message: `Keep the message under ${SLACK_DRAFT_MAX_CHARS} characters.` })
      }
      const status = yield* connector.status
      if (!status.connected) return yield* notConnected
      if (files.length > 0 && (status.missingScopes ?? []).includes("files:write")) {
        return yield* new InvalidInput({
          message: "The owner's Slack app can't upload files yet: it needs an update (Connect apps › Slack shows how). Draft the text alone, or tell the owner.",
        })
      }
      const target = yield* connector.resolve({ to: input.to, thread: input.thread })
      const card: typeof SlackDraftCard.Type = {
        type: "slack-draft",
        team: status.team ?? "Slack",
        channelId: target.conversation.id,
        to: target.conversation.label,
        text,
        ...(files.length === 0 ? {} : { files }),
        ...(target.thread === undefined ? {} : {
          threadTs: target.thread.threadTs ?? target.thread.ts,
          threadLabel: truncate(oneLine(`${target.thread.author}: ${target.thread.text}`), 120),
        }),
      }
      const entry = yield* conversations.appendEntry({
        kind: "card",
        conversationId: ctx.claims.conversationId,
        author: { kind: "bot", botId: ctx.claims.botId },
        card,
        state: { status: "pending" },
        ...(ctx.turnId === undefined ? {} : { turnId: ctx.turnId }),
      } as EntryDraft).pipe(Effect.mapError(() => new InvalidInput({ message: "This conversation is gone." })))
      const bot = yield* bots.get(ctx.claims.botId).pipe(Effect.orDie)
      yield* notifier.notify({
        kind: "waiting",
        botId: ctx.claims.botId,
        conversationId: ctx.claims.conversationId,
        title: Option.match(bot, { onNone: () => "Slack", onSome: (b) => b.name }),
        body: `Slack message for ${describeSlackPlace(target.conversation)}: ${truncate(oneLine(text), 120)}`,
      })
      const result = { entryId: entry.id, to: describeSlackPlace(target.conversation), inThread: target.thread !== undefined }
      if (key !== undefined) {
        byCall.set(key, result)
        if (byCall.size > 500) byCall.delete(byCall.keys().next().value!)
      }
      return result
    })

  const pendingDraft = (entryId: EntryId) =>
    Effect.gen(function*() {
      const found = yield* entries.get(entryId).pipe(Effect.orDie)
      if (Option.isNone(found) || !isDraft(found.value as KnownTranscriptEntry)) {
        return yield* new NotFound({ entity: "slack draft", id: entryId })
      }
      const entry = found.value as DraftCardEntry
      if (entry.state.status !== "pending") {
        return yield* new Conflict({ reason: entry.state.status === "resolved" ? "This message was already sent." : "This draft was discarded." })
      }
      return entry
    })

  const send = (input: { readonly entryId: EntryId; readonly text: string }) =>
    Effect.gen(function*() {
      if (connector === undefined) return yield* notConnected
      const text = input.text.trim()
      if (sending.has(input.entryId)) return yield* new Conflict({ reason: "This message is being sent." })
      const entry = yield* pendingDraft(input.entryId)
      const attached = entry.card.files ?? []
      if (text.length === 0 && attached.length === 0) return yield* new InvalidInput({ message: "The message is empty." })
      // the files on the brain's disk (kept in OpenBot since the Bot drafted them)
      const files: Array<{ readonly name: string; readonly path: string; readonly byteSize: number }> = []
      for (const file of attached) {
        const record = yield* attachments.get(file.id).pipe(Effect.orDie)
        if (Option.isNone(record)) return yield* new InvalidInput({ message: `${file.name} is no longer in OpenBot; ask the Bot to draft it again.` })
        files.push({ name: record.value.name, path: record.value.path, byteSize: record.value.byteSize })
      }
      sending.add(input.entryId)
      yield* Effect.gen(function*() {
        const sent = yield* connector.send({ channelId: entry.card.channelId, text, threadTs: entry.card.threadTs, ...(files.length === 0 ? {} : { files }) })
        yield* conversations.updateEntry(input.entryId, (current) =>
          isDraft(current)
            ? { ...current, card: { ...current.card, text }, state: { status: "resolved", detail: "Sent", link: sent.permalink } }
            : current).pipe(Effect.catch(() => Effect.void))
      }).pipe(Effect.ensuring(Effect.sync(() => sending.delete(input.entryId))))
    })

  const discard = (entryId: EntryId) =>
    Effect.gen(function*() {
      if (sending.has(entryId)) return yield* new Conflict({ reason: "This message is being sent." })
      yield* pendingDraft(entryId)
      yield* conversations.updateEntry(entryId, (current) =>
        isDraft(current) ? { ...current, state: { status: "dismissed", detail: "Discarded" } } : current).pipe(
          Effect.catch(() => Effect.void),
        )
    })

  return SlackService.of({ draft, send, discard })
})

export const SlackServiceLive = Layer.effect(SlackService, makeSlackService)

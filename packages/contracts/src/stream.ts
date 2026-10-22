// Ordered replica streams (snapshot + `after` resume), D4.3 / domain-contract.md §F.0.4.
// Shape combines t3code `subscribeThread` (snapshot | event{sequence} | synchronized | unknown-event)
// with Grok's ordered replicas (`ordered: {replicaKey, epoch, sequence}`, snapshot/appended/updated/cleared).
// Ported from vendor/scratch/contracts/src/stream.ts; the roster gains sections, notifications and settings.
import { Schema } from "effect"
import { BotId, ConversationId, EntryId, Millis, NodeId, NonEmptyString, NonNegativeInt, SectionId, TaskId, withUnknownFallback } from "./base.ts"
import { Bot, BotActivity, Conversation, ConversationSummary, NodeSummary, Notification, Section } from "./domain.ts"
import { RuntimeRequest } from "./runtime-request.ts"
import { Settings } from "./settings.ts"
import { Task } from "./task.ts"
import { TranscriptEntry, Turn } from "./transcript.ts"

/**
 * Resume cursor. `epoch` changes when the replica is rebuilt (new session, rollback, server
 * restore); a cursor from an old epoch always gets a fresh snapshot. `sequence` is per replica.
 */
export const StreamCursor = Schema.Struct({ epoch: NonEmptyString, sequence: NonNegativeInt })
export type StreamCursor = typeof StreamCursor.Type

// ---------------------------------------------------------------------------- conversation replica
export const ConversationChangeMembers = [
  Schema.Struct({ type: Schema.Literal("entry.upserted"), entry: TranscriptEntry }),
  Schema.Struct({ type: Schema.Literal("entry.removed"), entryId: EntryId, reason: Schema.Literals(["retracted", "rolled-back", "deleted"]) }),
  Schema.Struct({ type: Schema.Literal("request.upserted"), request: RuntimeRequest }),
  Schema.Struct({ type: Schema.Literal("turn.upserted"), turn: Turn }),
  Schema.Struct({ type: Schema.Literal("conversation.updated"), conversation: Conversation }),
] as const
const changeFallback = withUnknownFallback({ members: ConversationChangeMembers, tag: "type", keep: {} })
/** Client-side (decoding) change union: unknown change types decode to `{type: "unknown"}`. */
export const ConversationChange = changeFallback.schema
export type ConversationChange = typeof ConversationChange.Type
/** Server-side (encodable) change union. */
export const KnownConversationChange = Schema.Union(ConversationChangeMembers)
export type KnownConversationChange = typeof KnownConversationChange.Type

export const ConversationSnapshotItem = Schema.Struct({
  kind: Schema.Literal("snapshot"),
  cursor: StreamCursor,
  conversation: Conversation,
  /** Tail window of the transcript, oldest first. */
  entries: Schema.Array(TranscriptEntry),
  /** Pending requests plus recently resolved ones referenced by entries in the window. */
  requests: Schema.Array(RuntimeRequest),
  /** Active and most recent turns. */
  turns: Schema.Array(Turn),
  hasMoreBefore: Schema.Boolean,
  /** Opaque; pass to conversations.history. Never parse on the client. */
  beforeCursor: Schema.NullOr(Schema.String),
})
export const ConversationStreamMembers = [
  ConversationSnapshotItem,
  Schema.Struct({ kind: Schema.Literal("change"), cursor: StreamCursor, change: ConversationChange }),
  /** Catch-up finished; everything after this is live. */
  Schema.Struct({ kind: Schema.Literal("synchronized"), cursor: StreamCursor }),
  /** Replica was rebuilt: drop local state; a snapshot follows (Grok `cleared`). */
  Schema.Struct({ kind: Schema.Literal("reset"), epoch: NonEmptyString, reason: Schema.Literals(["new-session", "rollback", "rebuild"]) }),
] as const
const conversationStreamFallback = withUnknownFallback({
  members: ConversationStreamMembers,
  tag: "kind",
  keep: { cursor: Schema.optionalKey(StreamCursor) },
})
export const ConversationStreamItem = conversationStreamFallback.schema
export type ConversationStreamItem = typeof ConversationStreamItem.Type
/** Server-side (encodable) stream item union. */
export const KnownConversationStreamItem = Schema.Union(ConversationStreamMembers)
export type KnownConversationStreamItem = typeof KnownConversationStreamItem.Type

export const TranscriptPage = Schema.Struct({
  entries: Schema.Array(TranscriptEntry),
  hasMoreBefore: Schema.Boolean,
  beforeCursor: Schema.NullOr(Schema.String),
  /** Timestamp of the entry just before the page, for timestamp separators (Grok precedingTimestampMs). */
  precedingTimestamp: Schema.optionalKey(Millis),
})
export type TranscriptPage = typeof TranscriptPage.Type

/**
 * A window of a chat's transcript (`conversations.around`), oldest first: around an entry (a search
 * hit), or the page before / after a cursor of an earlier window.
 */
export const TranscriptWindow = Schema.Struct({
  entries: Schema.Array(TranscriptEntry),
  hasMoreBefore: Schema.Boolean,
  hasMoreAfter: Schema.Boolean,
  /** Opaque; pass as `beforeCursor` for older entries. Null when nothing is older. */
  beforeCursor: Schema.NullOr(Schema.String),
  /** Opaque; pass as `afterCursor` for newer entries. Null when the window reaches the newest. */
  afterCursor: Schema.NullOr(Schema.String),
  /** Timestamp of the entry just before the window, for timestamp separators. */
  precedingTimestamp: Schema.optionalKey(Millis),
  /** The turns of the window's entries (voice work, steps disclosure), as the live replica has them. */
  turns: Schema.Array(Turn),
  /** The requests of the window's cards (their pending / answered state). */
  requests: Schema.Array(RuntimeRequest),
})
export type TranscriptWindow = typeof TranscriptWindow.Type

/** A window of the messages two Bots sent each other (`conversations.exchange`), oldest first. */
export const ExchangePage = Schema.Struct({
  entries: Schema.Array(TranscriptEntry),
  /** Opaque; pass as `before` for older messages. Null when nothing is older. */
  beforeCursor: Schema.NullOr(Schema.String),
  /** Opaque; pass as `after` for newer messages. Null when the page reaches the newest. */
  afterCursor: Schema.NullOr(Schema.String),
})
export type ExchangePage = typeof ExchangePage.Type

// ---------------------------------------------------------------------------- roster replica (sidebar)
export const RosterChangeMembers = [
  Schema.Struct({ type: Schema.Literal("bot.upserted"), bot: Bot }),
  Schema.Struct({ type: Schema.Literal("bot.removed"), botId: BotId }),
  Schema.Struct({ type: Schema.Literal("conversation.upserted"), conversation: ConversationSummary }),
  Schema.Struct({ type: Schema.Literal("conversation.removed"), conversationId: ConversationId }),
  Schema.Struct({ type: Schema.Literal("activity.updated"), activity: BotActivity }),
  Schema.Struct({ type: Schema.Literal("node.upserted"), node: NodeSummary }),
  Schema.Struct({ type: Schema.Literal("node.removed"), nodeId: NodeId }),
  Schema.Struct({ type: Schema.Literal("section.upserted"), section: Section }),
  Schema.Struct({ type: Schema.Literal("section.removed"), sectionId: SectionId }),
  Schema.Struct({ type: Schema.Literal("settings.updated"), settings: Settings }),
  /** Web notification (architecture §3.5 Notifier). Not part of snapshots; reducers keep the most recent few. */
  Schema.Struct({ type: Schema.Literal("notification"), notification: Notification }),
  /** A background task started, changed status or progressed (throttled), D5.7. */
  Schema.Struct({ type: Schema.Literal("task.upserted"), task: Task }),
  Schema.Struct({ type: Schema.Literal("task.removed"), taskId: TaskId }),
] as const
const rosterChangeFallback = withUnknownFallback({ members: RosterChangeMembers, tag: "type", keep: {} })
export const RosterChange = rosterChangeFallback.schema
export type RosterChange = typeof RosterChange.Type
export const KnownRosterChange = Schema.Union(RosterChangeMembers)
export type KnownRosterChange = typeof KnownRosterChange.Type

export const RosterSnapshotItem = Schema.Struct({
  kind: Schema.Literal("snapshot"),
  cursor: StreamCursor,
  bots: Schema.Array(Bot),
  conversations: Schema.Array(ConversationSummary),
  activities: Schema.Array(BotActivity),
  nodes: Schema.Array(NodeSummary),
  sections: Schema.Array(Section),
  settings: Settings,
  /** Queued and running tasks plus each bot's most recent finished ones (D5.7). Absent from older brains. */
  tasks: Schema.optionalKey(Schema.Array(Task)),
})
export const RosterStreamMembers = [
  RosterSnapshotItem,
  Schema.Struct({ kind: Schema.Literal("change"), cursor: StreamCursor, change: RosterChange }),
  Schema.Struct({ kind: Schema.Literal("synchronized"), cursor: StreamCursor }),
] as const
const rosterStreamFallback = withUnknownFallback({ members: RosterStreamMembers, tag: "kind", keep: { cursor: Schema.optionalKey(StreamCursor) } })
export const RosterStreamItem = rosterStreamFallback.schema
export type RosterStreamItem = typeof RosterStreamItem.Type
export const KnownRosterStreamItem = Schema.Union(RosterStreamMembers)
export type KnownRosterStreamItem = typeof KnownRosterStreamItem.Type

// TranscriptEntry (whole-entity upserts), ConversationEvent and Turn (D4.1, domain-contract.md §F.4).
// Every entry carries its full current state; the server re-sends the whole entry on each change
// (t3code `turn_item.updated`, Grok `appended`/`updated`). Clients keep the highest `revision`.
// Ported from vendor/scratch/contracts/src/transcript.ts.
import { Schema } from "effect"
import {
  ApprovalRuleId,
  Author,
  BotId,
  ConversationId,
  EntryId,
  HarnessRef,
  Millis,
  NodeId,
  NonEmptyString,
  NonNegativeInt,
  RequestId,
  RoutineId,
  RoutineRunId,
  TurnId,
  Usage,
  withUnknownFallback,
} from "./base.ts"
import { Attachment } from "./attachment.ts"
import { Card, CardState } from "./card.ts"
import { RoutineRunStatus } from "./domain.ts"
import { BotAutonomy } from "./policy.ts"

export const EntryBaseFields = {
  id: EntryId,
  conversationId: ConversationId,
  /** Per-entry monotonic version; an upsert with a lower revision is stale and ignored. */
  revision: NonNegativeInt,
  createdAt: Millis,
  updatedAt: Millis,
  author: Author,
  turnId: Schema.optionalKey(TurnId),
  replyToId: Schema.optionalKey(EntryId),
  /** Thread root for side threads (Grok getAgentThread rootId). */
  threadRootId: Schema.optionalKey(EntryId),
  /** Native tool-call id of the parent subagent call, for nested activity (domain-contract.md §F.7). */
  parentToolCallId: Schema.optionalKey(Schema.String),
  harnessRef: Schema.optionalKey(HarnessRef),
}

export { Attachment } from "./attachment.ts"

export const MessageDelivery = Schema.Literals(["queued", "accepted", "delivered", "failed"])
export type MessageDelivery = typeof MessageDelivery.Type

// ---------------------------------------------------------------------------- entry kinds
export const MessageEntry = Schema.Struct({
  ...EntryBaseFields,
  kind: Schema.Literal("message"),
  role: Schema.Literals(["user", "bot"]),
  text: Schema.String,
  attachments: Schema.Array(Attachment),
  streaming: Schema.Boolean,
  /** Codex agentMessage.phase: interim narration vs final answer. */
  phase: Schema.optionalKey(Schema.Literals(["commentary", "final"])),
  /** Set by the sender (client) for idempotent sends (Grok clientNonce, Codex userMessage.clientId). */
  clientNonce: Schema.optionalKey(Schema.String),
  /** User sends: queued -> accepted (by OpenBot) -> delivered (harness echoed it) | failed. */
  delivery: Schema.optionalKey(MessageDelivery),
  /** Bot output cut short by an interrupt. */
  aborted: Schema.optionalKey(Schema.Boolean),
  /** Bots explicitly addressed by a group message (@mentions). */
  addressedBotIds: Schema.optionalKey(Schema.Array(BotId)),
  /** Directed bot-to-bot message (Grok message.toAgent; `message_bot`). */
  toBotId: Schema.optionalKey(BotId),
  reactions: Schema.optionalKey(Schema.Array(Schema.Struct({ emoji: Schema.String, by: Author }))),
})

export const ReasoningEntry = Schema.Struct({
  ...EntryBaseFields,
  kind: Schema.Literal("reasoning"),
  text: Schema.String,
  streaming: Schema.Boolean,
  /** Codex reasoning summaries vs raw thinking (Claude thinking, OpenCode reasoning). */
  source: Schema.Literals(["thinking", "summary"]),
})

export const ToolKind = Schema.Literals(["shell", "file-read", "file-write", "file-edit", "search", "web", "mcp", "subagent", "question", "browser", "computer", "other"])
export type ToolKind = typeof ToolKind.Type
export const ToolCallStatus = Schema.Literals(["pending", "awaiting-approval", "running", "completed", "failed", "declined", "interrupted"])
export type ToolCallStatus = typeof ToolCallStatus.Type

export const ToolOutput = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  images: Schema.optionalKey(Schema.Array(Schema.Struct({ mime: Schema.String, url: Schema.String }))),
  structured: Schema.optionalKey(Schema.Unknown),
  truncated: Schema.optionalKey(Schema.Boolean),
})
export type ToolOutput = typeof ToolOutput.Type

export const ToolCommand = Schema.Struct({ command: Schema.String, cwd: Schema.optionalKey(Schema.String), exitCode: Schema.optionalKey(Schema.Number) })
export type ToolCommand = typeof ToolCommand.Type
export const FileChange = Schema.Struct({ path: Schema.String, kind: Schema.Literals(["add", "update", "delete"]), diff: Schema.optionalKey(Schema.String) })
export type FileChange = typeof FileChange.Type
export const ToolMcpRef = Schema.Struct({ server: Schema.String, tool: Schema.String })
export type ToolMcpRef = typeof ToolMcpRef.Type

export const ToolCallEntry = Schema.Struct({
  ...EntryBaseFields,
  kind: Schema.Literal("tool-call"),
  toolCallId: NonEmptyString,
  /** Raw tool name as the harness saw it (Bash, exec_command, shell, mcp__openbot__shell). */
  name: NonEmptyString,
  title: Schema.optionalKey(Schema.String),
  toolKind: ToolKind,
  status: ToolCallStatus,
  input: Schema.Unknown,
  /** One-line human summary of the input ("ls -la", "README.md"); used by the steps disclosure. */
  inputSummary: Schema.optionalKey(Schema.String),
  output: Schema.optionalKey(ToolOutput),
  error: Schema.optionalKey(Schema.String),
  mcp: Schema.optionalKey(ToolMcpRef),
  command: Schema.optionalKey(ToolCommand),
  fileChanges: Schema.optionalKey(Schema.Array(FileChange)),
  /** Hands node the tool executed on (absent = where the harness runs). */
  nodeId: Schema.optionalKey(NodeId),
  requestId: Schema.optionalKey(RequestId),
  startedAt: Millis,
  completedAt: Schema.optionalKey(Millis),
})

export const CardEntry = Schema.Struct({
  ...EntryBaseFields,
  kind: Schema.Literal("card"),
  card: Card,
  state: CardState,
})

// ---------------------------------------------------------------------------- conversation events
// Centered event lines (Grok `event` entries). Each member carries the refs the UI needs to render
// and link it ("Messaged @Scout", "Routine ‹Daily brief› started", "Updated memory").
export const ConversationEventMembers = [
  Schema.Struct({ type: Schema.Literal("name-changed"), to: Schema.String }),
  /** A bot joined the team (created) or this conversation. */
  Schema.Struct({ type: Schema.Literal("joined"), botId: BotId, name: Schema.String }),
  Schema.Struct({ type: Schema.Literal("member-added"), botId: BotId, name: Schema.String }),
  Schema.Struct({ type: Schema.Literal("member-removed"), botId: BotId, name: Schema.String }),
  /** In the sender's conversation after `message_bot`: "Messaged @Recipient". */
  Schema.Struct({
    type: Schema.Literal("messaged-bot"),
    toBotId: BotId,
    toName: Schema.String,
    /** The recipient's direct conversation and the delivered message entry. */
    conversationId: ConversationId,
    entryId: Schema.optionalKey(EntryId),
    urgency: Schema.optionalKey(Schema.Literals(["urgent", "background"])),
  }),
  /** In the sender's conversation after `post_to_group`. */
  Schema.Struct({ type: Schema.Literal("posted-to-group"), conversationId: ConversationId, title: Schema.String, entryId: Schema.optionalKey(EntryId) }),
  /** `handoff_task` from one bot to another. */
  Schema.Struct({
    type: Schema.Literal("handoff"),
    fromBotId: BotId,
    toBotId: BotId,
    toName: Schema.String,
    task: Schema.String,
    conversationId: Schema.optionalKey(ConversationId),
  }),
  /** Collapsed bot<->bot traffic ("2 messages with Research Scout"). */
  Schema.Struct({ type: Schema.Literal("bot-exchange"), peerBotIds: Schema.Array(BotId), messageCount: NonNegativeInt, threadRootId: Schema.optionalKey(EntryId) }),
  /** Bot-to-bot chain stopped by the hop limit (D5.2): "Stopped: too many hand-offs". */
  Schema.Struct({ type: Schema.Literal("hop-limit"), hops: NonNegativeInt }),
  Schema.Struct({
    type: Schema.Literal("routine-changed"),
    action: Schema.Literals(["created", "updated", "enabled", "disabled", "deleted"]),
    routineId: RoutineId,
    routineName: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("routine-run"),
    routineId: RoutineId,
    routineName: Schema.String,
    runId: RoutineRunId,
    status: RoutineRunStatus,
  }),
  Schema.Struct({
    type: Schema.Literal("memory-updated"),
    botId: BotId,
    action: Schema.Literals(["remembered", "forgot", "edited"]),
    title: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("skill-saved"), name: Schema.String }),
  /** A native request resolved without asking, by a rule or the bot's autonomy (D5.6 / §4.3.4). */
  Schema.Struct({
    type: Schema.Literal("auto-decided"),
    decision: Schema.Literals(["allowed", "denied"]),
    summary: Schema.String,
    toolName: Schema.optionalKey(Schema.String),
    ruleId: Schema.optionalKey(ApprovalRuleId),
    /** Set when the bot's autonomy (not a rule) allowed it ("workspace" | "full"). */
    autonomy: Schema.optionalKey(BotAutonomy),
    /**
     * Native key of the tool call it gated (`HarnessApprovalRequest.toolKey`, = the tool-call entry's
     * `toolCallId` when the harness links them): the steps disclosure badges that step.
     */
    toolKey: Schema.optionalKey(Schema.String),
  }),
  /** In a group: the approval/question card was posted to the bot's direct conversation instead. */
  Schema.Struct({ type: Schema.Literal("request-elsewhere"), botId: BotId, requestId: RequestId, conversationId: ConversationId }),
  /** New session / compact (D0.4). */
  Schema.Struct({ type: Schema.Literal("session-changed"), botId: BotId, action: Schema.Literals(["new-session", "compacted"]) }),
] as const
const eventFallback = withUnknownFallback({ members: ConversationEventMembers, tag: "type", keep: {} })
export const ConversationEvent = eventFallback.schema
export type ConversationEvent = typeof ConversationEvent.Type
export type KnownConversationEvent = (typeof ConversationEventMembers)[number]["Type"]
export const KnownConversationEvent = Schema.Union(ConversationEventMembers)

export const EventEntry = Schema.Struct({ ...EntryBaseFields, kind: Schema.Literal("event"), event: ConversationEvent })

export const NoticeLevel = Schema.Literals(["info", "warning", "error"])
export type NoticeLevel = typeof NoticeLevel.Type
export const NoticeEntry = Schema.Struct({
  ...EntryBaseFields,
  kind: Schema.Literal("notice"),
  level: NoticeLevel,
  /** Machine code: interrupted, turn-failed, usage-limit, compacted, retrying, harness-crashed, … */
  code: Schema.String,
  text: Schema.String,
})

export const TranscriptEntryMembers = [MessageEntry, ReasoningEntry, ToolCallEntry, CardEntry, EventEntry, NoticeEntry] as const
const entryFallback = withUnknownFallback({ members: TranscriptEntryMembers, tag: "kind", keep: EntryBaseFields })
/** Decodes unknown kinds into `{ kind: "unknown", originalTag, ...base }` (decode-only). */
export const TranscriptEntry = entryFallback.schema
export type TranscriptEntry = typeof TranscriptEntry.Type
export type KnownTranscriptEntry = (typeof TranscriptEntryMembers)[number]["Type"]
export type TranscriptEntryKind = KnownTranscriptEntry["kind"]
export type TranscriptEntryOf<K extends TranscriptEntryKind> = Extract<KnownTranscriptEntry, { kind: K }>
export const KnownEntryKinds = entryFallback.known
/** Encodable (server-side) entry union: no unknown arm. */
export const KnownTranscriptEntry = Schema.Union(TranscriptEntryMembers)

// ---------------------------------------------------------------------------- Turn
export const TurnStatus = Schema.Literals(["queued", "running", "waiting", "completed", "interrupted", "failed"])
export type TurnStatus = typeof TurnStatus.Type
export const TurnTrigger = Schema.Literals(["user", "routine", "bot", "system"])
export type TurnTrigger = typeof TurnTrigger.Type

export const TurnFailure = Schema.Struct({ code: Schema.String, message: Schema.String, retryable: Schema.Boolean })
export type TurnFailure = typeof TurnFailure.Type

export const Turn = Schema.Struct({
  id: TurnId,
  conversationId: ConversationId,
  botId: BotId,
  /** `waiting` = a blocking request is pending (Grok "Action needed"). */
  status: TurnStatus,
  trigger: TurnTrigger,
  /** Message entry that started it (absent for routines and system resumes). */
  inputEntryId: Schema.optionalKey(EntryId),
  /** Failed turns: the messages it was answering, delivered again by `turns.retry`. */
  sourceEntryIds: Schema.optionalKey(Schema.Array(EntryId)),
  harnessRef: Schema.optionalKey(HarnessRef),
  startedAt: Millis,
  endedAt: Schema.optionalKey(Millis),
  usage: Schema.optionalKey(Usage),
  stopReason: Schema.optionalKey(Schema.String),
  failure: Schema.optionalKey(TurnFailure),
})
export type Turn = typeof Turn.Type

export const isTerminalTurnStatus = (status: TurnStatus): boolean => status === "completed" || status === "interrupted" || status === "failed"

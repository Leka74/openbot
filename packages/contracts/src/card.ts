// Card union = the immutable content of a `card` transcript entry. Mutable state
// (pending/resolved/…) lives on the entry (`CardState`), mirroring Grok, which keeps
// respondedValue/widgetDismissed/formResolution on the send-message ENTRY (domain-contract.md §F.0.2).
// Ported from vendor/scratch/contracts/src/card.ts; connector cards are cut for v1.
import { Schema } from "effect"
import { NodeId, RequestId, RoutineId, withUnknownFallback } from "./base.ts"
import { SuggestedRule } from "./policy.ts"
import { FormField, Question, RuntimeRequestKind, RuntimeResponse } from "./runtime-request.ts"
import { Attachment } from "./attachment.ts"

export const ApprovalCard = Schema.Struct({
  type: Schema.Literal("approval"),
  requestId: RequestId,
  /** Which approval kind (tool / command / file / mcp); drives the card's icon and detail view. */
  requestKind: Schema.optionalKey(RuntimeRequestKind),
  title: Schema.String,
  summary: Schema.optionalKey(Schema.String),
  toolName: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  diff: Schema.optionalKey(Schema.String),
  paths: Schema.optionalKey(Schema.Array(Schema.String)),
  nodeId: Schema.optionalKey(NodeId),
  nodeLabel: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  /** "Always allow" saves this rule (D5.6). */
  suggestedRule: Schema.optionalKey(SuggestedRule),
  /**
   * "Allow in ‹folder›": the folder outside the bot's workspace this request works in (its git repo
   * root, else its directory). Answering with `scope: "project-folder"` adds it to the bot's
   * project folders and allows.
   */
  projectFolder: Schema.optionalKey(Schema.String),
  /** Raised by the bot's background work of this title (D5.7): shown as the card's subtitle. */
  taskTitle: Schema.optionalKey(Schema.String),
})
export const QuestionCard = Schema.Struct({
  type: Schema.Literal("question"),
  /** Absent only for purely informational question cards (no answer expected). */
  requestId: Schema.optionalKey(RequestId),
  title: Schema.optionalKey(Schema.String),
  /** See `ApprovalCard.taskTitle`. */
  taskTitle: Schema.optionalKey(Schema.String),
  questions: Schema.Array(Question),
})
export const FormCard = Schema.Struct({
  type: Schema.Literal("form"),
  requestId: RequestId,
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
  fields: Schema.Array(FormField),
})
export const SecretRequestCard = Schema.Struct({
  type: Schema.Literal("secret-request"),
  requestId: RequestId,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  /** Where the value goes: an env var for the bot's sessions. */
  envVar: Schema.optionalKey(Schema.String),
})
/** Computer hand-off: the owner takes over the bot's browser/desktop, then hands back. */
export const HandoffCard = Schema.Struct({
  type: Schema.Literal("handoff"),
  requestId: RequestId,
  nodeId: NodeId,
  instruction: Schema.String,
  screenshotUrl: Schema.optionalKey(Schema.String),
})
/** Informational card posted when a bot creates or changes a routine. */
export const RoutineCard = Schema.Struct({
  type: Schema.Literal("routine"),
  action: Schema.Literals(["created", "updated"]),
  routineId: RoutineId,
  name: Schema.String,
  /** Human schedule, e.g. "Every Friday at 10:00 AM". */
  triggerSummary: Schema.String,
  prompt: Schema.optionalKey(Schema.String),
})

/**
 * A Slack message a Bot drafted (`slack_draft`, D3.4): the owner edits it and presses Send (it goes
 * out as them) or Discard. Pending until then; it never expires. When sent, `text` becomes what was
 * sent and the state's `link` opens the message in Slack.
 */
export const SlackDraftCard = Schema.Struct({
  type: Schema.Literal("slack-draft"),
  /** Workspace name. */
  team: Schema.String,
  channelId: Schema.String,
  /** Who it goes to: "#general", "Alice Smith", "Alice, Bob". */
  to: Schema.String,
  /** Reply in this thread (the parent message's `ts`). */
  threadTs: Schema.optionalKey(Schema.String),
  /** The start of the thread's first message. */
  threadLabel: Schema.optionalKey(Schema.String),
  text: Schema.String,
  /** Files the Bot attached (kept in OpenBot until sent; uploaded to Slack with the message). */
  files: Schema.optionalKey(Schema.Array(Attachment)),
})

export const CardMembers = [ApprovalCard, QuestionCard, FormCard, SecretRequestCard, HandoffCard, RoutineCard, SlackDraftCard] as const
const fallback = withUnknownFallback({ members: CardMembers, tag: "type", keep: {} })
/** Decodes unknown card types into `{ type: "unknown", originalTag }` (decode-only). */
export const Card = fallback.schema
export type Card = typeof Card.Type
export type KnownCard = (typeof CardMembers)[number]["Type"]
export const KnownCardTypes = fallback.known

export const CardStatus = Schema.Literals(["pending", "resolved", "dismissed", "expired", "cancelled", "info"])
export type CardStatus = typeof CardStatus.Type

export const CardState = Schema.Struct({
  /** `info` = an informational card with nothing to answer (e.g. `routine`). */
  status: CardStatus,
  response: Schema.optionalKey(RuntimeResponse),
  /** e.g. "Saved securely and kept private", "Blocked by your rules". */
  detail: Schema.optionalKey(Schema.String),
  /** Where the result lives, e.g. a sent Slack message. */
  link: Schema.optionalKey(Schema.String),
})
export type CardState = typeof CardState.Type

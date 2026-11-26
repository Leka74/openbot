// Normalized harness events, requests and status (architecture §3.1). Adapters emit WHOLE items
// keyed by a stable native key; core (TurnIngest) allocates EntryIds and revisions, persists and
// publishes them. SDK types never appear here.
import { Schema } from "effect"
import { BotId, HarnessKindName, Millis, NodeId, NonEmptyString, NonNegativeInt, TurnId, Usage } from "./base.ts"
import { ApprovalSurface } from "./policy.ts"
import { DecisionId, Question } from "./runtime-request.ts"
import { FileChange, NoticeLevel, ToolCommand, ToolKind, ToolMcpRef, ToolOutput } from "./transcript.ts"

// ---------------------------------------------------------------------------- capabilities & placement
/** Where a bot session's tools run (architecture §3.3). Later: "claude-cli-on-node" | "opencode-on-node". */
export const PlacementMode = Schema.Literals(["native-local", "brain-mcp-hands", "codex-environment"])
export type PlacementMode = typeof PlacementMode.Type

export const ApprovalSupport = Schema.Literals(["interactive", "policy-only", "none"])
export type ApprovalSupport = typeof ApprovalSupport.Type

/** Declared, never faked (D2). Mirrors core's `HarnessCapabilities` so the UI can gate actions. */
export const HarnessCapabilities = Schema.Struct({
  /** Reopen a native session by id. */
  resume: Schema.Boolean,
  /** Inject user input into a running turn. */
  steer: Schema.Boolean,
  interrupt: Schema.Boolean,
  approvals: ApprovalSupport,
  /** Native AskUserQuestion / requestUserInput / form. */
  questions: Schema.Boolean,
  compact: Schema.Boolean,
  contextUsage: Schema.Boolean,
  /** Image attachments in user input. */
  images: Schema.Boolean,
  /** Which remote placement modes the driver implements. */
  remotePlacements: Schema.Array(PlacementMode),
})
export type HarnessCapabilities = typeof HarnessCapabilities.Type

// ---------------------------------------------------------------------------- status & models
export const HarnessAuthState = Schema.Literals(["signed-in", "signed-out", "unknown"])
export type HarnessAuthState = typeof HarnessAuthState.Type

/** The account a probe saw (D2.6), split out of `auth.label` so the UI can show it compactly. Never a token. */
export const HarnessAccount = Schema.Struct({
  email: Schema.optionalKey(Schema.String),
  /** Subscription / plan ("max", "team", "ChatGPT plus"…), as the harness names it. */
  plan: Schema.optionalKey(Schema.String),
  organization: Schema.optionalKey(Schema.String),
})
export type HarnessAccount = typeof HarnessAccount.Type

/** Probe result (D2.6): installed? version? auth/account label? Never requires a model call. */
export const HarnessStatus = Schema.Struct({
  kind: HarnessKindName,
  /** "Claude", "Codex", "OpenCode", "Fake". */
  displayName: Schema.optionalKey(Schema.String),
  installed: Schema.Boolean,
  version: Schema.optionalKey(Schema.String),
  auth: Schema.Struct({
    state: HarnessAuthState,
    /** Account label, e.g. "user@example.com (Max)". Never a token. */
    label: Schema.optionalKey(Schema.String),
  }),
  /** Human-readable problems ("codex not found on PATH", "version 0.150 < 0.162.1"). */
  problems: Schema.Array(Schema.String),
  capabilities: Schema.optionalKey(HarnessCapabilities),
  checkedAt: Schema.optionalKey(Schema.Number),
  /**
   * The harness account (profile) this status is for: `harnesses.status` returns one status per
   * (kind, profile). `DEFAULT_HARNESS_PROFILE_ID` for the harness's default login. Absent from old brains.
   */
  profileId: Schema.optionalKey(Schema.String),
  /** The profile's owner-given label ("Work"), or "Default". */
  profileLabel: Schema.optionalKey(Schema.String),
  /** The profile's config dir (Claude `CLAUDE_CONFIG_DIR`, the Codex home holding `auth.json`). */
  configDir: Schema.optionalKey(Schema.String),
  /** The signed-in account, when the probe reports one. */
  account: Schema.optionalKey(HarnessAccount),
  signInFromApp: Schema.optionalKey(Schema.Boolean),
})
export type HarnessStatus = typeof HarnessStatus.Type

export const HarnessSignInStart = Schema.Struct({ url: Schema.String })
export type HarnessSignInStart = typeof HarnessSignInStart.Type

// ---------------------------------------------------------------------------- profiles (accounts)
/**
 * Every harness has an implicit default profile: its usual login (Claude: no `CLAUDE_CONFIG_DIR`
 * override, i.e. `~/.claude`; Codex: `~/.codex`). A bot whose `harness.profileId` is absent uses it.
 */
export const DEFAULT_HARNESS_PROFILE_ID = "default"

/**
 * A harness account ("profile"): a login/config home on the brain machine. Claude: a
 * `CLAUDE_CONFIG_DIR`; Codex: the `CODEX_HOME` whose `auth.json` OpenBot links; OpenCode: only the
 * default for now. OpenBot only points the user's own CLI at the user's own config dir; it never
 * reads, copies or forwards credentials.
 */
export const HarnessProfile = Schema.Struct({
  /** `DEFAULT_HARNESS_PROFILE_ID` for the built-in default profile of each harness. */
  id: NonEmptyString,
  kind: HarnessKindName,
  label: Schema.String,
  /** Absolute path; absent when the harness has no notion of one (OpenCode). */
  configDir: Schema.optionalKey(Schema.String),
  /** The built-in default profile (cannot be removed). */
  isDefault: Schema.optionalKey(Schema.Boolean),
  createdAt: Schema.Number,
})
export type HarnessProfile = typeof HarnessProfile.Type

/** A config dir found on the brain machine that is not a profile yet (`harnesses.discover`). */
export const HarnessProfileCandidate = Schema.Struct({
  kind: HarnessKindName,
  configDir: Schema.String,
  /** A label to prefill ("leka@example.com" or the dir name). */
  suggestedLabel: Schema.String,
  /** The account found in the dir's non-secret metadata (Claude `.claude.json`), when cheap. */
  account: Schema.optionalKey(HarnessAccount),
})
export type HarnessProfileCandidate = typeof HarnessProfileCandidate.Type

/** `undefined` for the default profile (absent, empty or `"default"`), else the id. */
export const normalizeProfileId = (profileId: string | undefined | null): string | undefined =>
  profileId === undefined || profileId === null || profileId === "" || profileId === DEFAULT_HARNESS_PROFILE_ID
    ? undefined
    : profileId

/** The profile id a bot harness uses, with the default spelled out (`"default"`). */
export const profileIdOf = (harness: { readonly profileId?: string | undefined }): string =>
  normalizeProfileId(harness.profileId) ?? DEFAULT_HARNESS_PROFILE_ID

/** "leka@example.com (team)" style label of an account; `undefined` when there is nothing to show. */
export const describeAccount = (account: HarnessAccount | undefined): string | undefined => {
  if (account === undefined) return undefined
  const who = account.email ?? account.organization
  if (who === undefined) return account.plan
  return account.plan !== undefined ? `${who} (${account.plan})` : who
}

// ---------------------------------------------------------------------------- quota (plan limits)
/**
 * One limit window of an account's plan: `session` (Claude: the rolling 5 hours), `week` (7 days,
 * every model) or `week-model` (7 days, one model family).
 */
export const HarnessQuotaWindow = Schema.Struct({
  kind: Schema.Literals(["session", "week", "week-model"]),
  /** The model family of a `week-model` window, as the provider names it ("Fable", "Opus"). */
  model: Schema.optionalKey(Schema.String),
  /** 0-100 (the provider may report more than 100). */
  usedPercent: Schema.Number,
  /** When the window resets (epoch ms); absent when the provider gives none (nothing used yet). */
  resetsAt: Schema.optionalKey(Schema.Number),
})
export type HarnessQuotaWindow = typeof HarnessQuotaWindow.Type

/**
 * An account's plan limits as the harness itself reports them (`HarnessDriver.quota`; Claude: the
 * data behind `/usage`). The harness's own CLI asks its provider with its own login: OpenBot never
 * reads a credential for it. Never a token.
 */
export const HarnessQuotaReport = Schema.Struct({
  /** Empty when the account has no plan limits (API key, Bedrock, Vertex…) or the report failed (`problem`). */
  windows: Schema.Array(HarnessQuotaWindow),
  account: Schema.optionalKey(HarnessAccount),
  /** Paid extra usage is on: reaching a plan limit does not stop the account. */
  extraUsage: Schema.optionalKey(Schema.Boolean),
  /** Why there are no windows ("Claude is not signed in.", "This account has no plan limits."). */
  problem: Schema.optionalKey(Schema.String),
  checkedAt: Schema.Number,
})
export type HarnessQuotaReport = typeof HarnessQuotaReport.Type

/** A Bot whose last turn ended on the provider's limit message (the fallback signal of `harnesses.quota`). */
export const HarnessLimitHit = Schema.Struct({
  botId: BotId,
  at: Millis,
  /** The provider's own text ("You've hit your session limit · resets 3pm"). */
  message: Schema.String,
})
export type HarnessLimitHit = typeof HarnessLimitHit.Type

/** `harnesses.quota`: the plan limits of one (kind, profile) with the Bots that run on it. */
export const HarnessQuota = Schema.Struct({
  kind: HarnessKindName,
  profileId: Schema.String,
  profileLabel: Schema.String,
  ...HarnessQuotaReport.fields,
  /** Bots of the owner's active profile on this account. */
  botIds: Schema.Array(BotId),
  /** Bots of the owner's other profiles on this account. */
  otherProfileBots: NonNegativeInt,
  /** Bots of `botIds` whose last finished turn failed on a usage limit, newest first. */
  limitHits: Schema.Array(HarnessLimitHit),
})
export type HarnessQuota = typeof HarnessQuota.Type

/** From this share of a window on, an account counts as near its limit. */
export const QUOTA_NEAR_PERCENT = 80

/** `ok` below `QUOTA_NEAR_PERCENT`, `out` from 100; a window whose reset time has passed is `ok`. */
export const quotaLevel = (
  window: Pick<HarnessQuotaWindow, "usedPercent" | "resetsAt">,
  now: number,
): "ok" | "near" | "out" =>
  window.resetsAt !== undefined && window.resetsAt <= now
    ? "ok"
    : window.usedPercent >= 100
      ? "out"
      : window.usedPercent >= QUOTA_NEAR_PERCENT
        ? "near"
        : "ok"

/**
 * Whether a window limits a Bot running `model`. `session` and `week` limit every Bot of the
 * account; a `week-model` window only the Bots whose model id names its family. A Bot on the harness
 * default model is not matched to a family: OpenBot does not know what the default resolves to.
 */
export const quotaWindowApplies = (
  window: Pick<HarnessQuotaWindow, "kind" | "model">,
  model: string | undefined,
): boolean =>
  window.kind !== "week-model" ||
  (model !== undefined && window.model !== undefined && model.toLowerCase().includes(window.model.toLowerCase()))

export interface QuotaWarning {
  readonly level: "near" | "out"
  readonly window: HarnessQuotaWindow
  /** The Bots of the account the window limits. */
  readonly botIds: ReadonlyArray<BotId>
}

/** The windows of an account that are near or at their limit, used-up ones first. */
export const quotaWarnings = (
  quota: Pick<HarnessQuota, "windows" | "botIds">,
  modelOf: (botId: BotId) => string | undefined,
  now: number,
): ReadonlyArray<QuotaWarning> =>
  quota.windows
    .flatMap((window): ReadonlyArray<QuotaWarning> => {
      const level = quotaLevel(window, now)
      if (level === "ok") return []
      return [{ level, window, botIds: quota.botIds.filter((id) => quotaWindowApplies(window, modelOf(id))) }]
    })
    .sort((a, b) => Number(b.level === "out") - Number(a.level === "out"))

export const ModelInfo = Schema.Struct({
  id: NonEmptyString,
  label: Schema.String,
  default: Schema.optionalKey(Schema.Boolean),
  /** Reasoning effort levels the model accepts, when known. */
  efforts: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type ModelInfo = typeof ModelInfo.Type

// `ContextUsage` ({usedTokens, windowTokens}) lives in base.ts (shared with domain.ts `ConversationSession`).

// ---------------------------------------------------------------------------- items
export const HarnessToolStatus = Schema.Literals(["pending", "running", "completed", "failed", "declined"])
export type HarnessToolStatus = typeof HarnessToolStatus.Type

export const HarnessMessageItem = Schema.TaggedStruct("Message", {
  role: Schema.Literal("bot"),
  text: Schema.String,
  streaming: Schema.Boolean,
  phase: Schema.optionalKey(Schema.Literals(["commentary", "final"])),
  aborted: Schema.optionalKey(Schema.Boolean),
})
export const HarnessReasoningItem = Schema.TaggedStruct("Reasoning", {
  text: Schema.String,
  streaming: Schema.Boolean,
  /** Raw thinking (Claude, OpenCode) vs summaries (Codex). Default "thinking". */
  source: Schema.optionalKey(Schema.Literals(["thinking", "summary"])),
})
export const HarnessToolCallItem = Schema.TaggedStruct("ToolCall", {
  /** Raw tool name as the harness saw it. */
  toolName: NonEmptyString,
  title: Schema.String,
  kind: ToolKind,
  status: HarnessToolStatus,
  /** One-line summary of the input ("ls -la", "README.md"). */
  inputSummary: Schema.String,
  /** Tool output, truncated by the adapter (≈2 KB). */
  outputPreview: Schema.optionalKey(Schema.String),
  /** Node the tool ran on, when known (gateway node tools carry it in `input.node`). */
  nodeId: Schema.optionalKey(NodeId),
  /** Key of the parent subagent tool call. */
  parentKey: Schema.optionalKey(Schema.String),
  // Optional detail for the transcript entry (all adapter-normalized, no SDK shapes).
  input: Schema.optionalKey(Schema.Unknown),
  output: Schema.optionalKey(ToolOutput),
  error: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(ToolCommand),
  fileChanges: Schema.optionalKey(Schema.Array(FileChange)),
  mcp: Schema.optionalKey(ToolMcpRef),
})
export const HarnessNoticeItem = Schema.TaggedStruct("Notice", {
  level: NoticeLevel,
  text: Schema.String,
  /** Machine code (see NoticeEntry.code); default "harness". */
  code: Schema.optionalKey(Schema.String),
})
export const HarnessItem = Schema.Union([
  HarnessMessageItem,
  HarnessReasoningItem,
  HarnessToolCallItem,
  HarnessNoticeItem,
]).pipe(Schema.toTaggedUnion("_tag"))
export type HarnessItem = typeof HarnessItem.Type

// ---------------------------------------------------------------------------- events
export const HarnessTurnError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
})
export type HarnessTurnError = typeof HarnessTurnError.Type

export const SessionBound = Schema.TaggedStruct("SessionBound", { nativeSessionId: NonEmptyString })
export const TurnStarted = Schema.TaggedStruct("TurnStarted", {
  turnId: TurnId,
  /**
   * `"harness"`: a turn OpenBot did not start (Claude Code answering its own background-command
   * notification). Its `turnId` is adapter-generated; core either folds it into the running turn or
   * runs it as a turn of its own (BotRunner). Absent: one of OpenBot's turns (`startTurn`).
   */
  initiator: Schema.optionalKey(Schema.Literal("harness")),
})
export const ItemUpserted = Schema.TaggedStruct("ItemUpserted", {
  turnId: TurnId,
  /** Stable native key (Claude `msgId:blockIndex` / tool_use id, Codex item id, OpenCode part key). */
  key: NonEmptyString,
  item: HarnessItem,
})
export const ActivityEvent = Schema.TaggedStruct("Activity", {
  /** "Searching the web", "Typing…". */
  label: Schema.String,
  toolKind: Schema.optionalKey(ToolKind),
})
export const UsageEvent = Schema.TaggedStruct("Usage", { usage: Usage, turnId: Schema.optionalKey(TurnId) })
export const ContextUsageEvent = Schema.TaggedStruct("ContextUsage", {
  usedTokens: NonNegativeInt,
  windowTokens: NonNegativeInt,
})
export const TurnCompleted = Schema.TaggedStruct("TurnCompleted", {
  turnId: TurnId,
  stopReason: Schema.optionalKey(Schema.String),
})
export const TurnFailed = Schema.TaggedStruct("TurnFailed", { turnId: TurnId, error: HarnessTurnError })
export const TurnInterrupted = Schema.TaggedStruct("TurnInterrupted", { turnId: TurnId })
export const SessionClosed = Schema.TaggedStruct("SessionClosed", { reason: Schema.String })

export const HarnessEvent = Schema.Union([
  SessionBound,
  TurnStarted,
  ItemUpserted,
  ActivityEvent,
  UsageEvent,
  ContextUsageEvent,
  TurnCompleted,
  TurnFailed,
  TurnInterrupted,
  SessionClosed,
]).pipe(Schema.toTaggedUnion("_tag"))
export type HarnessEvent = typeof HarnessEvent.Type
export type HarnessEventOf<T extends HarnessEvent["_tag"]> = Extract<HarnessEvent, { _tag: T }>

// ---------------------------------------------------------------------------- requests
export const HarnessApprovalKind = Schema.Literals([
  "tool-approval",
  "command-approval",
  "file-approval",
  "mcp-approval",
])
export type HarnessApprovalKind = typeof HarnessApprovalKind.Type

export const HarnessDecisionSuggestion = Schema.Struct({
  decision: DecisionId,
  label: Schema.optionalKey(Schema.String),
  /** Adapter-private payload echoed back in the resolution (e.g. Claude permission suggestions). */
  native: Schema.optionalKey(Schema.Unknown),
})
export type HarnessDecisionSuggestion = typeof HarnessDecisionSuggestion.Type

export const HarnessApprovalRequest = Schema.Struct({
  kind: HarnessApprovalKind,
  toolName: Schema.String,
  title: Schema.String,
  detail: Schema.String,
  /**
   * Rule surface (D5.6) as classified by the adapter/gateway, which knows its tools (Claude `Read`
   * → file-read, `WebFetch` → network). Absent → ApprovalService derives it from `kind`:
   * command → shell, file → file-edit, mcp → mcp, tool → other.
   */
  surface: Schema.optionalKey(ApprovalSurface),
  /** Native key of the ToolCall item this request gates, when the harness links them. */
  toolKey: Schema.optionalKey(Schema.String),
  /** Native request id (Claude requestId, Codex JSON-RPC id, OpenCode permission id). */
  nativeRequestId: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  paths: Schema.optionalKey(Schema.Array(Schema.String)),
  diff: Schema.optionalKey(Schema.String),
  /** MCP server for mcp-approval. */
  server: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.Unknown),
  nodeId: Schema.optionalKey(NodeId),
  /** Extra decisions the harness can honor beyond allow-once / deny (which are always offered). */
  suggestions: Schema.optionalKey(Schema.Array(HarnessDecisionSuggestion)),
})
export type HarnessApprovalRequest = typeof HarnessApprovalRequest.Type

export const HarnessQuestionRequest = Schema.Struct({
  kind: Schema.Literal("question"),
  title: Schema.optionalKey(Schema.String),
  toolKey: Schema.optionalKey(Schema.String),
  nativeRequestId: Schema.optionalKey(Schema.String),
  questions: Schema.Array(Question),
})
export type HarnessQuestionRequest = typeof HarnessQuestionRequest.Type

/** An approval or question raised by the native harness (passed to `OpenSessionInput.onRequest`). */
export const HarnessRequest = Schema.Union([HarnessApprovalRequest, HarnessQuestionRequest])
export type HarnessRequest = typeof HarnessRequest.Type

export const HarnessDecisionResolution = Schema.Struct({
  decision: DecisionId,
  message: Schema.optionalKey(Schema.String),
  /** Edited tool input to pass back (Claude `updatedInput`). */
  updatedInput: Schema.optionalKey(Schema.Unknown),
  /** The suggestion the user picked (its `native` payload), when any. */
  native: Schema.optionalKey(Schema.Unknown),
})
export type HarnessDecisionResolution = typeof HarnessDecisionResolution.Type
export const HarnessAnswersResolution = Schema.Struct({
  answers: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)])),
})
export type HarnessAnswersResolution = typeof HarnessAnswersResolution.Type
/** How a HarnessRequest was resolved; the adapter maps it to the native reply (domain-contract.md §F.8). */
export const HarnessRequestResolution = Schema.Union([HarnessDecisionResolution, HarnessAnswersResolution])
export type HarnessRequestResolution = typeof HarnessRequestResolution.Type

export const isAnswersResolution = (r: HarnessRequestResolution): r is HarnessAnswersResolution => "answers" in r

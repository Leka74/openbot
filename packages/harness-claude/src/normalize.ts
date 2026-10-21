/**
 * Claude Agent SDK frames → normalized `HarnessEvent`s (architecture §3.1, §4.5; domain-contract
 * §F.6/F.7; sdk-claude.md §13-15, §18).
 *
 * `ClaudeEventPipeline` is a synchronous, per-session state machine with no Effect or SDK runtime
 * dependency, so it is unit-tested by replaying recorded frames (`test/normalize.test.ts`). The
 * session feeds it every SDK frame plus OpenBot's own control actions (send, steer, interrupt,
 * permission decisions) and forwards the events it returns.
 *
 * Identity rules (sdk-claude.md §14):
 * - tool items are keyed by `tool_use.id`;
 * - text/thinking items by `<api message id>:<block index>`. Complete `assistant` frames carry one
 *   block each and share `message.id`, so the k-th frame of a message is block k — never the
 *   `content` array index (the harness prior-art collision bug).
 *
 * Turn rules:
 * - every `send` gets a turn; the CLI processes sends in order, so turns form a FIFO and the head is
 *   the active turn. The CLI also runs turns of its own (CLI turns = the frames up to one `result`):
 *   `<task-notification>`s for its background shells — after a resume even for shells of the previous
 *   process, as a transcript-only turn (`num_turns: 0`, no model call) right before OpenBot's next
 *   send (2026-10-17: such a result completed the owner's turn 0.5 s in, with no reply, and the
 *   answer landed in the next turn);
 * - so a `result` ends the head only when its CLI turn took the head's input: the input the CLI
 *   reports taking (`command_lifecycle` `started`, `user_message_uuid(s)` on status / stream /
 *   assistant / result frames) names one of the head's uuids. A result whose turn took none of it
 *   ends nothing: one that names other input, one with a non-`human` `origin` (task notifications),
 *   or one while the CLI still reports the head's input as `queued`. Without any of these signals
 *   (older CLIs) the FIFO order decides, as before. Coalesced sends the result names end with it;
 * - output of a CLI turn that is not OpenBot's goes to the active turn when there is one (it never
 *   ends it); with nothing active it opens a harness-initiated turn (`TurnStarted` with
 *   `initiator: "harness"` and a generated id), which occupies the FIFO head until its CLI turn's
 *   result, can be steered and interrupted, and ends like any turn;
 * - `steer` folds into the active turn (`priority: "next"`). The CLI folds it in between tool rounds;
 *   when the turn ends first, the steered input runs as the CLI's next turn. Results echo the client
 *   uuids they consumed (`user_message_uuids`), so a result that leaves steered input unconsumed
 *   keeps the OpenBot turn open until the steered input is answered — also when the CLI aborted the
 *   step for that input (`aborted_*` without an OpenBot interrupt: a preempting follow-up), so
 *   steering never ends a turn as "interrupted";
 * - queued input the CLI drops without running it (`command_lifecycle` `cancelled` before `started`)
 *   ends the turn waiting for it, so it never hangs;
 * - internal commands (`/compact`) occupy the FIFO like turns but emit no items or turn events.
 */
import type {
  ContextUsage,
  HarnessEvent,
  HarnessItem,
  HarnessTurnError,
  NodeId,
  ToolKind,
  TurnId,
  Usage,
} from "@openbot/contracts"
import { classifyTool, OPENBOT_MCP_SERVER, type ToolClassification } from "./tools.ts"

// ---------------------------------------------------------------------------- frame shapes (subset)

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
const int = (value: unknown): number => Math.max(0, Math.round(num(value) ?? 0))

/** Prefixes of usage-limit error texts (mirrors the SDK's `USAGE_LIMIT_ERROR_PREFIXES`). */
const USAGE_LIMIT_PREFIXES = [
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  "Your org is out of usage",
  "Your seat type doesn't include",
  "Your usage allocation has been disabled",
  "Your group's usage limit",
  "You're out of extra usage",
]

export interface PipelineOptions {
  /** Max characters of a tool's `outputPreview` (default 2000). */
  readonly previewChars?: number
  /** Max characters of a tool's `output.text` (default 16000). */
  readonly outputChars?: number
  /** Max JSON characters of `output.structured` (default 4000). */
  readonly structuredChars?: number
  /** Max base64 characters of an inlined tool-result image (default 512 KB). */
  readonly imageChars?: number
  /**
   * The session was resumed: the first `result`'s cumulative `total_cost_usd` includes earlier
   * turns, so it only establishes the cost baseline (sdk-claude.md §18).
   */
  readonly resumed?: boolean
  /** Native session id already bound by the caller (suppresses a duplicate `SessionBound`). */
  readonly sessionId?: string | undefined
  /**
   * The session's host node: OpenBot node tools called without a `node` argument run there, so
   * their entries are attributed to it (as the Codex adapter does).
   */
  readonly hostNodeId?: NodeId | undefined
  /** Id of a harness-initiated turn (default: `cli-turn-<n>`). */
  readonly newTurnId?: (() => string) | undefined
}

/** Gateway tools that execute on a node (`node` argument, default: the host node). */
const NODE_TOOLS = new Set(["shell", "read_file", "write_file", "edit_file", "list_dir", "glob", "grep", "browser", "computer"])

interface TurnEntry {
  readonly kind: "turn"
  readonly turnId: TurnId
  /** Client uuids still to be answered: the send, then steered input. */
  readonly uuids: Set<string>
  /** The send that started it (`undefined` for a harness-initiated turn, whose input is only steers). */
  readonly own: string | undefined
}
interface CommandEntry {
  readonly kind: "command"
  readonly id: string
  readonly uuids: Set<string>
}
type Entry = TurnEntry | CommandEntry

/** An internal command (e.g. `/compact`) that finished. */
export interface SettledCommand {
  readonly id: string
  readonly ok: boolean
  readonly error?: string | undefined
}

export interface PipelineOutput {
  readonly events: ReadonlyArray<HarnessEvent>
  readonly settled: ReadonlyArray<SettledCommand>
}

interface BlockState {
  readonly key: string
  readonly type: string
  readonly parent: string | null
  text: string
  /** tool_use id when `type === "tool_use"`. */
  toolId?: string | undefined
  finalized: boolean
}

interface ToolState {
  readonly key: string
  readonly toolName: string
  input: unknown
  parentKey?: string | undefined
  classification: ToolClassification
  status: "pending" | "running" | "completed" | "failed" | "declined"
  item: Extract<HarnessItem, { _tag: "ToolCall" }>
}

interface OpenText {
  readonly turnId: TurnId
  readonly kind: "text" | "thinking"
  text: string
}

type ToolItem = Extract<HarnessItem, { _tag: "ToolCall" }>

const truncate = (text: string, max: number): { readonly text: string; readonly truncated: boolean } =>
  text.length > max ? { text: `${text.slice(0, max - 1)}…`, truncated: true } : { text, truncated: false }

/** Client uuids a frame says its CLI turn took (`user_message_uuid(s)`). */
const echoOf = (frame: Json): ReadonlyArray<string> => {
  const out: Array<string> = []
  if (Array.isArray(frame.user_message_uuids)) {
    for (const u of frame.user_message_uuids) if (typeof u === "string" && u.length > 0) out.push(u)
  }
  const single = str(frame.user_message_uuid)
  if (single) out.push(single)
  return out
}

/** A result whose prompt was not a client's (`origin.kind` other than `human`: task notifications, …). */
const foreignOrigin = (frame: Json): boolean => {
  const kind = isRecord(frame.origin) ? str(frame.origin.kind) : undefined
  return kind !== undefined && kind !== "human"
}

/** `error` of an assistant message the CLI made up to report a failed API call (not model output). */
const CLI_ERROR_MESSAGES: ReadonlySet<string> = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "cloud_credential_error",
  "billing_error",
  "rate_limit",
  "server_error",
  "overloaded",
])

export class ClaudeEventPipeline {
  private readonly previewChars: number
  private readonly outputChars: number
  private readonly structuredChars: number
  private readonly imageChars: number

  private sessionId: string | undefined
  private resumedBaselinePending: boolean
  private lastTotalCost: number | undefined

  private readonly fifo: Array<Entry> = []
  private interruptRequested = false

  /** Client uuids the CLI turn in progress took (lifecycle `started`, frame echoes); reset per result. */
  private readonly turnClaims = new Set<string>()
  /** Client uuids the CLI reported `queued` and has not started yet. */
  private readonly waiting = new Set<string>()
  /** The CLI reports what it takes (lifecycle frames or echoes seen): an absent echo means "not taken". */
  private reportsInput = false
  /** The failure of the last result skipped while the head's input still waited (reported if it is dropped). */
  private skippedFailure: HarnessTurnError | undefined
  private readonly newTurnId: () => string
  private harnessTurns = 0

  /** Stream blocks by `<msgId>:<index>`. */
  private readonly blocks = new Map<string, BlockState>()
  /** Latest api message id per `parent_tool_use_id` (null = main thread). */
  private readonly messageByParent = new Map<string | null, string>()
  /** Complete `assistant` frames seen per api message id (frame k = block k). */
  private readonly frameCounts = new Map<string, number>()
  private readonly tools = new Map<string, ToolState>()
  /** Streaming text/thinking items not yet finalized, by key. */
  private readonly openTexts = new Map<string, OpenText>()
  /** Tool uses OpenBot denied (canUseTool), with the message sent back. */
  private readonly denied = new Map<string, string>()

  private lastActivity: string | undefined
  private assistantError: string | undefined
  private callInputTokens = 0
  private callOutputTokens = 0
  private contextWindow: number | undefined
  private lastContext: ContextUsage | undefined

  private readonly hostNodeId: NodeId | undefined

  constructor(options: PipelineOptions = {}) {
    this.previewChars = options.previewChars ?? 2000
    this.outputChars = options.outputChars ?? 16_000
    this.structuredChars = options.structuredChars ?? 4000
    this.imageChars = options.imageChars ?? 512 * 1024
    this.resumedBaselinePending = options.resumed ?? false
    this.sessionId = options.sessionId
    this.hostNodeId = options.hostNodeId
    this.newTurnId = options.newTurnId ?? (() => `cli-turn-${++this.harnessTurns}`)
  }

  // ------------------------------------------------------------------------ queries

  /** The turn the CLI is working on (head of the FIFO), if it is a turn. */
  get activeTurnId(): TurnId | undefined {
    const head = this.fifo[0]
    return head?.kind === "turn" ? head.turnId : undefined
  }

  /** True while the CLI has accepted input it has not finished (turns or commands). */
  get busy(): boolean {
    return this.fifo.length > 0
  }

  get nativeSessionId(): string | undefined {
    return this.sessionId
  }

  /** Last context-window usage derived from the stream (fallback for `getContextUsage`). */
  get contextUsage(): ContextUsage | undefined {
    return this.lastContext
  }

  // ------------------------------------------------------------------------ control actions

  /** A user turn was pushed into the streaming input with client `uuid`. */
  send(turnId: TurnId, uuid: string): ReadonlyArray<HarnessEvent> {
    this.fifo.push({ kind: "turn", turnId, uuids: new Set([uuid]), own: uuid })
    return this.fifo.length === 1 ? this.activate() : []
  }

  /** True when `turnId` is the running turn and it can still take steered input (not being interrupted). */
  canSteer(turnId: TurnId): boolean {
    const head = this.fifo[0]
    return head?.kind === "turn" && head.turnId === turnId && !this.interruptRequested
  }

  /**
   * Input folded into the running turn `turnId` (`priority: "next"`). Returns false, changing
   * nothing, when `turnId` is not running (`canSteer`).
   */
  steer(turnId: TurnId, uuid: string): boolean {
    const head = this.fifo[0]
    if (head?.kind !== "turn" || !this.canSteer(turnId)) return false
    head.uuids.add(uuid)
    return true
  }

  /** An internal command (e.g. `/compact`) was pushed with client `uuid`. */
  command(id: string, uuid: string): ReadonlyArray<HarnessEvent> {
    this.fifo.push({ kind: "command", id, uuids: new Set([uuid]) })
    return this.fifo.length === 1 ? this.activate() : []
  }

  /** `q.interrupt()` was requested; the next error result ends the active turn as interrupted. */
  requestInterrupt(): boolean {
    if (this.fifo.length === 0) return false
    this.interruptRequested = true
    return true
  }

  /** Records OpenBot's answer to `canUseTool` so the tool result is classified as declined. */
  noteDecision(toolUseId: string, decision: "allow" | "deny", message?: string): void {
    if (decision === "deny") this.denied.set(toolUseId, message ?? "Denied")
    else this.denied.delete(toolUseId)
  }

  /** Binds the native session id; returns `SessionBound` when it changed. */
  bindSession(sessionId: string): ReadonlyArray<HarnessEvent> {
    if (sessionId.length === 0 || sessionId === this.sessionId) return []
    this.sessionId = sessionId
    return [{ _tag: "SessionBound", nativeSessionId: sessionId }]
  }

  /**
   * The native session is gone. Unexpected closes fail every accepted turn (`closed`, retryable);
   * deliberate closes interrupt them. Always ends with `SessionClosed`.
   */
  close(reason: string, unexpected: boolean): PipelineOutput {
    const events: Array<HarnessEvent> = []
    const settled: Array<SettledCommand> = []
    let first = true
    for (const entry of this.fifo.splice(0)) {
      if (entry.kind === "command") {
        settled.push({ id: entry.id, ok: false, error: reason })
        continue
      }
      if (!first) events.push({ _tag: "TurnStarted", turnId: entry.turnId })
      events.push(...this.finalizeTurn(entry.turnId, unexpected ? "failed" : "interrupted"))
      events.push(
        unexpected
          ? { _tag: "TurnFailed", turnId: entry.turnId, error: { code: "closed", message: reason, retryable: true } }
          : { _tag: "TurnInterrupted", turnId: entry.turnId },
      )
      first = false
    }
    this.resetTurnState()
    this.turnClaims.clear()
    this.waiting.clear()
    events.push({ _tag: "SessionClosed", reason })
    return { events, settled }
  }

  // ------------------------------------------------------------------------ SDK frames

  /** Feeds one SDK output frame. Unknown frame types are ignored. */
  message(frame: unknown): PipelineOutput {
    if (!isRecord(frame)) return { events: [], settled: [] }
    const events: Array<HarnessEvent> = []
    const sessionId = str(frame.session_id)
    const type = str(frame.type)
    if (type === "system" && str(frame.subtype) === "init" && sessionId) events.push(...this.bindSession(sessionId))
    // Input the CLI turn in progress took (status / stream / assistant echoes); results are judged in onResult.
    if (type !== "result") this.claim(echoOf(frame))
    switch (type) {
      case "system":
        events.push(...this.onSystem(frame))
        break
      case "stream_event":
        events.push(...this.onStreamEvent(frame))
        break
      case "assistant":
        events.push(...this.onAssistant(frame))
        break
      case "user":
        events.push(...this.onUser(frame))
        break
      case "result":
        return this.onResult(frame, events)
      case "command_lifecycle":
        return this.onLifecycle(frame, events)
      default:
        // rate_limit_event, tool_progress, tool_use_summary, auth_status, … (§F.7)
        if (type === "tool_progress") events.push(...this.onToolProgress(frame))
        break
    }
    return { events, settled: [] }
  }

  // ------------------------------------------------------------------------ internals: turns

  private activate(): ReadonlyArray<HarnessEvent> {
    this.interruptRequested = false
    this.lastActivity = undefined
    const head = this.fifo[0]
    return head?.kind === "turn" ? [{ _tag: "TurnStarted", turnId: head.turnId }] : []
  }

  private resetTurnState(): void {
    this.blocks.clear()
    this.messageByParent.clear()
    this.frameCounts.clear()
    this.tools.clear()
    this.openTexts.clear()
    this.denied.clear()
    this.assistantError = undefined
    this.interruptRequested = false
    this.lastActivity = undefined
    this.callInputTokens = 0
    this.callOutputTokens = 0
  }

  /**
   * Output with nothing in the FIFO to hold it: the CLI is running a turn of its own (a task
   * notification). It becomes a harness-initiated turn, the FIFO head until its CLI turn's result.
   */
  private ensureTurn(): ReadonlyArray<HarnessEvent> {
    if (this.fifo.length > 0) return []
    const turnId = this.newTurnId() as TurnId
    this.fifo.push({ kind: "turn", turnId, uuids: new Set(), own: undefined })
    this.interruptRequested = false
    this.lastActivity = undefined
    return [{ _tag: "TurnStarted", turnId, initiator: "harness" }]
  }

  private item(key: string, item: HarnessItem): ReadonlyArray<HarnessEvent> {
    const opened = this.ensureTurn()
    const turnId = this.activeTurnId
    return turnId === undefined ? opened : [...opened, { _tag: "ItemUpserted", turnId, key, item }]
  }

  private activity(label: string, toolKind?: ToolKind): ReadonlyArray<HarnessEvent> {
    const opened = this.ensureTurn()
    if (label === this.lastActivity) return opened
    this.lastActivity = label
    return [...opened, { _tag: "Activity", label, ...(toolKind ? { toolKind } : {}) }]
  }

  /** Records client uuids the CLI turn in progress took (only OpenBot's own input counts). */
  private claim(uuids: ReadonlyArray<string>): void {
    if (uuids.length === 0) return
    this.reportsInput = true
    for (const u of uuids) {
      if (!this.fifo.some((e) => e.uuids.has(u))) continue
      this.waiting.delete(u)
      this.turnClaims.add(u)
    }
  }

  /**
   * Whether the CLI turn a result ends took the head's input (module doc, "Turn rules"). A
   * harness-initiated turn IS that CLI turn. Without any signal (older CLIs) the FIFO order decides.
   */
  private owns(head: Entry, claims: ReadonlySet<string>, foreign: boolean): boolean {
    if (head.kind === "turn" && head.own === undefined) return true
    if (claims.size > 0) return [...head.uuids].some((u) => claims.has(u))
    if (foreign) return false
    // The CLI said the head's input still waits in its queue. Commands are exempt: whether `/compact`
    // reports its lifecycle is not verified, and it must settle.
    if (head.kind === "turn" && [...head.uuids].every((u) => this.waiting.has(u))) return false
    return true
  }

  /** `command_lifecycle` (undocumented, live; sdk-claude.md §4, §13): the CLI's receipts for client input. */
  private onLifecycle(frame: Json, events: Array<HarnessEvent>): PipelineOutput {
    const uuid = str(frame.command_uuid)
    const state = str(frame.state)
    if (!uuid || !state) return { events, settled: [] }
    this.reportsInput = true
    if (!this.fifo.some((e) => e.uuids.has(uuid))) return { events, settled: [] }
    switch (state) {
      case "queued":
        this.waiting.add(uuid)
        break
      case "started":
        this.claim([uuid])
        break
      case "cancelled":
      case "discarded":
        if (this.waiting.delete(uuid)) return this.dropped(uuid, events)
        break
      default:
        this.waiting.delete(uuid)
    }
    return { events, settled: [] }
  }

  /**
   * The CLI dropped queued input without running it (a turn that could not start, a cancelled
   * queue): a turn (or command) left with nothing to answer ends instead of waiting forever.
   */
  private dropped(uuid: string, events: Array<HarnessEvent>): PipelineOutput {
    const settled: Array<SettledCommand> = []
    const index = this.fifo.findIndex((e) => e.uuids.has(uuid))
    const entry = this.fifo[index]
    if (entry === undefined) return { events, settled }
    entry.uuids.delete(uuid)
    // A harness-initiated turn is the CLI turn itself: losing a steer does not end it.
    if (entry.uuids.size > 0 || (entry.kind === "turn" && entry.own === undefined)) return { events, settled }
    this.fifo.splice(index, 1)
    const interrupted = index === 0 && this.interruptRequested
    const failure: HarnessTurnError = (index === 0 ? this.skippedFailure : undefined) ??
      { code: "turn-rejected", message: "Claude Code dropped this message without answering it.", retryable: true }
    this.skippedFailure = undefined
    if (entry.kind === "command") {
      settled.push({ id: entry.id, ok: false, error: failure.message })
    } else {
      if (index > 0) events.push({ _tag: "TurnStarted", turnId: entry.turnId })
      else events.push(...this.finalizeTurn(entry.turnId, interrupted ? "interrupted" : "failed"))
      events.push(interrupted ? { _tag: "TurnInterrupted", turnId: entry.turnId } : { _tag: "TurnFailed", turnId: entry.turnId, error: failure })
    }
    if (index === 0) {
      this.resetTurnState()
      if (this.fifo.length > 0) events.push(...this.activate())
    }
    return { events, settled }
  }

  /** Finalizes every streaming item and unfinished tool of the turn. */
  private finalizeTurn(turnId: TurnId, outcome: "completed" | "interrupted" | "failed"): Array<HarnessEvent> {
    const events: Array<HarnessEvent> = []
    for (const [key, open] of this.openTexts) {
      if (open.turnId !== turnId) continue
      const item: HarnessItem = open.kind === "text"
        ? { _tag: "Message", role: "bot", text: open.text, streaming: false, ...(outcome === "interrupted" ? { aborted: true } : {}) }
        : { _tag: "Reasoning", text: open.text, streaming: false, source: "thinking" }
      events.push({ _tag: "ItemUpserted", turnId, key, item })
    }
    this.openTexts.clear()
    for (const tool of this.tools.values()) {
      if (tool.status !== "pending" && tool.status !== "running") continue
      tool.status = "failed"
      const error = outcome === "interrupted" ? "Interrupted" : "The turn ended before the tool finished"
      tool.item = { ...tool.item, status: "failed", error }
      events.push({ _tag: "ItemUpserted", turnId, key: tool.key, item: tool.item })
    }
    return events
  }

  private onResult(frame: Json, events: Array<HarnessEvent>): PipelineOutput {
    const settled: Array<SettledCommand> = []
    const head = this.fifo[0]
    const subtype = str(frame.subtype) ?? "success"
    const isError = frame.is_error === true
    const terminal = str(frame.terminal_reason)
    const success = subtype === "success" && !isError

    // Cumulative accounting (sdk-claude.md §18): cost is a running total per query().
    const usage = this.usageOf(frame)
    this.updateContextWindow(frame)

    // Client input this CLI turn took: the result's echo (absent from older CLIs and from turns that
    // took none) plus what the turn's lifecycle / echo frames reported.
    const echoed = echoOf(frame)
    if (echoed.length > 0) this.reportsInput = true
    const claims = new Set([...this.turnClaims, ...echoed])
    this.turnClaims.clear()

    this.skippedFailure = undefined
    if (head === undefined) return { events, settled } // a CLI turn without output (transcript-only notification)

    // A CLI turn that did not take the head's input (a task notification, an interrupted turn's
    // leftover steer): it ends nothing, its spend counts for the turn that is waiting.
    const foreign = foreignOrigin(frame)
    if (!this.owns(head, claims, foreign)) {
      if (usage && head.kind === "turn") events.push({ _tag: "Usage", usage, turnId: head.turnId })
      // A failure nobody claimed may be the head's turn failing to start (its `cancelled` receipt follows).
      if (!success && !foreign && claims.size === 0) this.skippedFailure = this.failureOf(frame, subtype)
      this.assistantError = undefined
      return { events, settled }
    }

    // Coalesced sends: every FIFO entry whose uuid the CLI turn took ends with it (head always does).
    const ended: Array<Entry> = [head]
    for (const entry of this.fifo.slice(1)) {
      if ([...entry.uuids].some((u) => claims.has(u))) ended.push(entry)
      else break
    }

    const aborted = terminal === "aborted_streaming" || terminal === "aborted_tools"
    const interrupted = aborted || (this.interruptRequested && !success)
    // Input of the head this CLI turn did not take.
    const pending = head.kind === "turn" ? [...head.uuids].filter((u) => !claims.has(u)) : []
    // An abort OpenBot did not ask for, with steered input still pending, is the CLI making room for
    // that input (preemption): not an interrupt of the OpenBot turn.
    const pendingSteer = head.kind === "turn" && pending.some((u) => u !== head.own)
    const preempted = aborted && !this.interruptRequested && pendingSteer
    // Whether "not taken" can be told from "not reported": the CLI reported what this turn took, or
    // (a harness-initiated turn's steers) reports input at all.
    const known = claims.size > 0 || preempted || (head.kind === "turn" && head.own === undefined && this.reportsInput)

    // Steered input the CLI did not fold in runs as its next turn: the OpenBot turn stays open
    // (unless the owner asked to stop it).
    if (
      head.kind === "turn" && ended.length === 1 && (!interrupted || preempted) && !this.interruptRequested && known &&
      pending.length > 0
    ) {
      head.uuids.clear()
      for (const u of pending) head.uuids.add(u)
      if (usage) events.push({ _tag: "Usage", usage, turnId: head.turnId })
      const context = this.contextFromCall()
      if (context) events.push({ _tag: "ContextUsage", ...context })
      this.assistantError = undefined
      return { events, settled }
    }

    this.fifo.splice(0, ended.length)
    for (const entry of ended) for (const u of entry.uuids) this.waiting.delete(u)
    const failure = interrupted || success ? undefined : this.failureOf(frame, subtype)

    for (const [index, entry] of ended.entries()) {
      if (entry.kind === "command") {
        settled.push({ id: entry.id, ok: success, ...(success ? {} : { error: failure?.message ?? subtype }) })
        continue
      }
      if (index > 0) events.push({ _tag: "TurnStarted", turnId: entry.turnId })
      if (index === 0) {
        if (usage) events.push({ _tag: "Usage", usage, turnId: entry.turnId })
        const context = this.contextFromCall()
        if (context) events.push({ _tag: "ContextUsage", ...context })
      }
      events.push(...this.finalizeTurn(entry.turnId, interrupted ? "interrupted" : success ? "completed" : "failed"))
      if (interrupted) events.push({ _tag: "TurnInterrupted", turnId: entry.turnId })
      else if (success) {
        const stopReason = terminal ?? str(frame.stop_reason)
        events.push({ _tag: "TurnCompleted", turnId: entry.turnId, ...(stopReason ? { stopReason } : {}) })
      } else events.push({ _tag: "TurnFailed", turnId: entry.turnId, error: failure! })
    }
    this.resetTurnState()
    if (this.fifo.length > 0) events.push(...this.activate())
    return { events, settled }
  }

  private usageOf(frame: Json): Usage | undefined {
    const raw = isRecord(frame.usage) ? frame.usage : {}
    const input = int(raw.input_tokens)
    const cacheCreate = int(raw.cache_creation_input_tokens)
    const cacheRead = int(raw.cache_read_input_tokens)
    const output = int(raw.output_tokens)
    const details = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : {}
    const reasoning = int(details.thinking_tokens)
    const total = num(frame.total_cost_usd)
    let cost: number | undefined
    if (total !== undefined) {
      if (this.resumedBaselinePending) this.resumedBaselinePending = false
      else {
        const delta = total - (this.lastTotalCost ?? 0)
        if (delta > 0) cost = delta
      }
      this.lastTotalCost = total
    }
    const inputTokens = input + cacheCreate + cacheRead
    if (inputTokens === 0 && output === 0 && cost === undefined) return undefined
    return {
      inputTokens,
      outputTokens: output,
      ...(cacheRead > 0 ? { cachedInputTokens: cacheRead } : {}),
      ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
      ...(cost !== undefined ? { costUsd: cost } : {}),
    }
  }

  private updateContextWindow(frame: Json): void {
    if (!isRecord(frame.modelUsage)) return
    let window: number | undefined
    for (const value of Object.values(frame.modelUsage)) {
      if (!isRecord(value)) continue
      const w = num(value.contextWindow)
      if (w !== undefined && w > 0) window = Math.max(window ?? 0, w)
    }
    if (window !== undefined) this.contextWindow = window
  }

  private contextFromCall(): ContextUsage | undefined {
    const used = this.callInputTokens + this.callOutputTokens
    if (this.contextWindow === undefined || used <= 0) return undefined
    this.lastContext = { usedTokens: used, windowTokens: Math.round(this.contextWindow) }
    return this.lastContext
  }

  private failureOf(frame: Json, subtype: string): HarnessTurnError {
    const errors = Array.isArray(frame.errors) ? frame.errors.filter((e): e is string => typeof e === "string") : []
    const text = (subtype === "success" ? str(frame.result) : undefined) ?? (errors.join("\n") || subtype)
    const apiStatus = num(frame.api_error_status)
    const assistantError = this.assistantError
    if (
      assistantError === "rate_limit" || assistantError === "billing_error" ||
      USAGE_LIMIT_PREFIXES.some((prefix) => text.startsWith(prefix))
    ) return { code: "usage-limit", message: text, retryable: false }
    if (
      assistantError === "authentication_failed" || assistantError === "oauth_org_not_allowed" ||
      assistantError === "cloud_credential_error" || apiStatus === 401 || apiStatus === 403
    ) return { code: "auth", message: text, retryable: false }
    if (subtype === "error_max_turns") return { code: "max-turns", message: text, retryable: false }
    if (subtype === "error_max_budget_usd") return { code: "budget", message: text, retryable: false }
    if (
      assistantError === "overloaded" || assistantError === "server_error" ||
      (apiStatus !== undefined && apiStatus >= 500) || apiStatus === 429
    ) return { code: "api-error", message: text, retryable: true }
    return { code: "turn-failed", message: text, retryable: true }
  }

  // ------------------------------------------------------------------------ internals: system

  private onSystem(frame: Json): ReadonlyArray<HarnessEvent> {
    switch (str(frame.subtype)) {
      case "status": {
        const status = str(frame.status)
        if (status === "requesting") return this.activity("Thinking…")
        if (status === "compacting") return this.activity("Compacting…")
        return []
      }
      case "api_retry":
        return this.activity("Retrying…")
      case "compact_boundary": {
        const meta = isRecord(frame.compact_metadata) ? frame.compact_metadata : {}
        const post = num(meta.post_tokens)
        const events: Array<HarnessEvent> = []
        if (post !== undefined && this.contextWindow !== undefined) {
          this.lastContext = { usedTokens: int(post), windowTokens: Math.round(this.contextWindow) }
          events.push({ _tag: "ContextUsage", ...this.lastContext })
        }
        const pre = num(meta.pre_tokens)
        const text = pre !== undefined && post !== undefined
          ? `Context compacted (${int(pre).toLocaleString("en-US")} → ${int(post).toLocaleString("en-US")} tokens)`
          : "Context compacted"
        events.push(...this.item(`compact:${str(frame.uuid) ?? "boundary"}`, { _tag: "Notice", level: "info", code: "compacted", text }))
        return events
      }
      case "permission_denied": {
        const toolUseId = str(frame.tool_use_id)
        if (!toolUseId) return []
        const message = str(frame.message) ?? "Denied automatically"
        this.denied.set(toolUseId, message)
        return this.updateTool(toolUseId, { status: "declined", error: message })
      }
      default:
        return []
    }
  }

  private onToolProgress(frame: Json): ReadonlyArray<HarnessEvent> {
    const toolUseId = str(frame.tool_use_id)
    const tool = toolUseId ? this.tools.get(toolUseId) : undefined
    return tool ? this.activity(tool.classification.activity, tool.classification.kind) : []
  }

  // ------------------------------------------------------------------------ internals: stream events

  private onStreamEvent(frame: Json): ReadonlyArray<HarnessEvent> {
    const event = isRecord(frame.event) ? frame.event : undefined
    if (!event) return []
    const parent = str(frame.parent_tool_use_id) ?? null
    const eventType = str(event.type)
    if (eventType === "message_start") {
      const message = isRecord(event.message) ? event.message : {}
      const id = str(message.id) ?? str(frame.api_message_id)
      if (id) this.messageByParent.set(parent, id)
      if (parent === null) {
        const usage = isRecord(message.usage) ? message.usage : {}
        this.callInputTokens = int(usage.input_tokens) + int(usage.cache_creation_input_tokens) +
          int(usage.cache_read_input_tokens)
        this.callOutputTokens = int(usage.output_tokens)
      }
      return []
    }
    if (eventType === "message_delta") {
      if (parent === null && isRecord(event.usage)) {
        const output = num(event.usage.output_tokens)
        if (output !== undefined) this.callOutputTokens = int(output)
      }
      return []
    }
    const msgId = str(frame.api_message_id) ?? this.messageByParent.get(parent)
    const index = num(event.index)
    if (msgId === undefined || index === undefined) return []
    const key = `${msgId}:${index}`
    if (eventType === "content_block_start") {
      const block = isRecord(event.content_block) ? event.content_block : {}
      const blockType = str(block.type) ?? "unknown"
      const state: BlockState = { key, type: blockType, parent, text: "", finalized: false }
      this.blocks.set(key, state)
      if (blockType === "tool_use") {
        const toolId = str(block.id)
        const name = str(block.name)
        if (!toolId || !name) return []
        state.toolId = toolId
        return [...this.upsertTool(toolId, name, {}, parent, "pending"), ...this.toolActivity(toolId)]
      }
      if (parent !== null) return []
      if (blockType === "text") return this.activity("Typing…")
      if (blockType === "thinking") return this.activity("Thinking…")
      return []
    }
    if (eventType === "content_block_delta") {
      const state = this.blocks.get(key)
      const delta = isRecord(event.delta) ? event.delta : {}
      if (!state || state.finalized || state.parent !== null) return []
      const deltaType = str(delta.type)
      if (deltaType === "text_delta" && state.type === "text") {
        state.text += str(delta.text) ?? ""
        return this.streamText(key, "text", state.text)
      }
      if (deltaType === "thinking_delta" && state.type === "thinking") {
        state.text += str(delta.thinking) ?? ""
        return this.streamText(key, "thinking", state.text)
      }
      return [] // signature_delta, input_json_delta (final input comes from the assistant frame)
    }
    return [] // content_block_stop, message_stop
  }

  private streamText(key: string, kind: "text" | "thinking", text: string): ReadonlyArray<HarnessEvent> {
    if (text.length === 0) return []
    const opened = this.ensureTurn()
    const turnId = this.activeTurnId
    if (turnId === undefined) return opened
    this.openTexts.set(key, { turnId, kind, text })
    return [...opened, ...this.item(
      key,
      kind === "text"
        ? { _tag: "Message", role: "bot", text, streaming: true }
        : { _tag: "Reasoning", text, streaming: true, source: "thinking" },
    )]
  }

  // ------------------------------------------------------------------------ internals: assistant / user

  /** Resolves the stream key of the k-th complete block of message `msgId`. */
  private blockKey(msgId: string, index: number, blockType: string): string {
    const direct = this.blocks.get(`${msgId}:${index}`)
    if (direct === undefined || direct.type === blockType) return `${msgId}:${index}`
    for (const block of this.blocks.values()) {
      if (!block.finalized && block.type === blockType && block.key.startsWith(`${msgId}:`)) return block.key
    }
    return `${msgId}:${index}`
  }

  private onAssistant(frame: Json): ReadonlyArray<HarnessEvent> {
    const message = isRecord(frame.message) ? frame.message : undefined
    if (!message) return []
    const parent = str(frame.parent_tool_use_id) ?? null
    const error = str(frame.error)
    if (error && parent === null) this.assistantError = error
    // The CLI's own error text ("Failed to authenticate…", "You've hit your limit…") is not the bot
    // speaking: the turn's failure reports it.
    const cliError = error !== undefined && parent === null && CLI_ERROR_MESSAGES.has(error)
    const msgId = str(message.id) ?? str(frame.uuid) ?? "msg"
    const content = Array.isArray(message.content) ? message.content : []
    const base = this.frameCounts.get(msgId) ?? 0
    this.frameCounts.set(msgId, base + content.length)
    const aborted = frame.aborted === true
    const events: Array<HarnessEvent> = []
    content.forEach((rawBlock, offset) => {
      if (!isRecord(rawBlock)) return
      const blockType = str(rawBlock.type) ?? "unknown"
      if (blockType === "tool_use") {
        const toolId = str(rawBlock.id)
        const name = str(rawBlock.name)
        if (!toolId || !name) return
        events.push(...this.upsertTool(toolId, name, rawBlock.input ?? {}, parent, "running"))
        events.push(...this.toolActivity(toolId))
        return
      }
      if (parent !== null) return // subagent text/thinking has no home (§F.7)
      const key = this.blockKey(msgId, base + offset, blockType)
      const stream = this.blocks.get(key)
      if (stream) stream.finalized = true
      if (blockType === "text") {
        const text = str(rawBlock.text) ?? stream?.text ?? ""
        this.openTexts.delete(key)
        if (cliError) return
        if (text.length === 0 && !aborted) return
        events.push(...this.item(key, { _tag: "Message", role: "bot", text, streaming: false, ...(aborted ? { aborted: true } : {}) }))
      } else if (blockType === "thinking") {
        const text = str(rawBlock.thinking) || stream?.text || ""
        this.openTexts.delete(key)
        if (text.length === 0) return // omitted/redacted thinking display
        events.push(...this.item(key, { _tag: "Reasoning", text, streaming: false, source: "thinking" }))
      }
    })
    return events
  }

  private onUser(frame: Json): ReadonlyArray<HarnessEvent> {
    if (frame.isReplay === true) return []
    const message = isRecord(frame.message) ? frame.message : undefined
    const content = message && Array.isArray(message.content) ? message.content : []
    const events: Array<HarnessEvent> = []
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_result") continue
      const toolUseId = str(block.tool_use_id)
      if (!toolUseId) continue
      events.push(...this.completeTool(toolUseId, block, frame.tool_use_result))
    }
    return events // plain user text (interrupt echo, subagent prompts) has no home (§F.7)
  }

  // ------------------------------------------------------------------------ internals: tools

  private toolActivity(toolId: string): ReadonlyArray<HarnessEvent> {
    const tool = this.tools.get(toolId)
    return tool && tool.parentKey === undefined ? this.activity(tool.classification.activity, tool.classification.kind) : []
  }

  private upsertTool(
    toolId: string,
    toolName: string,
    input: unknown,
    parent: string | null,
    status: "pending" | "running",
  ): ReadonlyArray<HarnessEvent> {
    const existing = this.tools.get(toolId)
    if (existing && existing.status !== "pending" && existing.status !== "running") return []
    const classified = classifyTool(toolName, input)
    const classification = classified.nodeId === undefined && this.hostNodeId !== undefined && classified.mcp !== undefined &&
        classified.mcp.server === OPENBOT_MCP_SERVER && NODE_TOOLS.has(classified.mcp.tool)
      ? { ...classified, nodeId: this.hostNodeId }
      : classified
    const nextStatus = existing?.status === "running" ? "running" : status
    const item: ToolItem = {
      _tag: "ToolCall",
      toolName,
      title: classification.title,
      kind: classification.kind,
      status: nextStatus,
      inputSummary: classification.inputSummary,
      input,
      ...(classification.nodeId ? { nodeId: classification.nodeId } : {}),
      ...(parent !== null ? { parentKey: parent } : {}),
      ...(classification.command !== undefined ? { command: { command: classification.command } } : {}),
      ...(classification.mcp ? { mcp: classification.mcp } : {}),
      ...(classification.paths && (classification.kind === "file-edit" || classification.kind === "file-write")
        ? { fileChanges: classification.paths.map((path) => ({ path, kind: "update" as const })) }
        : {}),
    }
    this.tools.set(toolId, {
      key: toolId,
      toolName,
      input,
      parentKey: parent ?? undefined,
      classification,
      status: nextStatus,
      item,
    })
    return this.item(toolId, item)
  }

  private updateTool(toolId: string, patch: Partial<ToolItem>): ReadonlyArray<HarnessEvent> {
    const tool = this.tools.get(toolId)
    if (!tool) return []
    tool.item = { ...tool.item, ...patch } as ToolItem
    if (patch.status) tool.status = patch.status
    return this.item(toolId, tool.item)
  }

  private completeTool(toolUseId: string, block: Json, structured: unknown): ReadonlyArray<HarnessEvent> {
    const tool = this.tools.get(toolUseId)
    if (!tool) return []
    const { text, images } = this.resultContent(block.content)
    const deniedMessage = this.denied.get(toolUseId)
    const isError = block.is_error === true
    const status = deniedMessage !== undefined && isError ? "declined" : isError ? "failed" : "completed"
    const preview = truncate(text, this.previewChars)
    const full = truncate(text, this.outputChars)
    let structuredOut: unknown
    if (structured !== undefined && structured !== null && typeof structured !== "string") {
      try {
        const json = JSON.stringify(structured)
        if (json !== undefined && json.length <= this.structuredChars) structuredOut = structured
      } catch {
        structuredOut = undefined
      }
    }
    const created = isRecord(structured) && structured.type === "create"
    const patch: Partial<ToolItem> = {
      status,
      ...(text.length > 0 ? { outputPreview: preview.text } : {}),
      output: {
        ...(text.length > 0 ? { text: full.text } : {}),
        ...(images.length > 0 ? { images } : {}),
        ...(structuredOut !== undefined ? { structured: structuredOut } : {}),
        ...(full.truncated ? { truncated: true } : {}),
      },
      ...(isError ? { error: text.length > 0 ? preview.text : status === "declined" ? deniedMessage : "Tool failed" } : {}),
      ...(created && tool.item.fileChanges
        ? { fileChanges: tool.item.fileChanges.map((change) => ({ ...change, kind: "add" as const })) }
        : {}),
    }
    return this.updateTool(toolUseId, patch)
  }

  private resultContent(content: unknown): {
    readonly text: string
    readonly images: ReadonlyArray<{ readonly mime: string; readonly url: string }>
  } {
    if (typeof content === "string") return { text: content, images: [] }
    if (!Array.isArray(content)) return { text: "", images: [] }
    const texts: Array<string> = []
    const images: Array<{ readonly mime: string; readonly url: string }> = []
    for (const part of content) {
      if (!isRecord(part)) continue
      if (part.type === "text") texts.push(str(part.text) ?? "")
      else if (part.type === "image") {
        const source = isRecord(part.source) ? part.source : {}
        const data = str(source.data)
        const mime = str(source.media_type) ?? "image/png"
        if (source.type === "base64" && data && data.length <= this.imageChars) {
          images.push({ mime, url: `data:${mime};base64,${data}` })
        } else texts.push("[image]")
      }
    }
    return { text: texts.join("\n"), images }
  }
}

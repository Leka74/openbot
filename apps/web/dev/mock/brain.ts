// DEV MOCK ONLY: an in-memory brain that implements every `OpenBotRpcs` method well enough to drive
// the web UI without apps/server: live roster + conversation replicas, simulated bot turns (thinking,
// tool steps, streamed replies), approvals / questions / forms / secrets resolved through
// `requests.respond`, interrupts, group routing, bot-to-bot messages, routines, memory, skills,
// rules, nodes and settings. Not a reference for server semantics; see docs/architecture.md.
import { Effect, Stream } from "effect"
import {
  type ApprovalRule,
  type Attachment,
  type AttachmentId,
  type Author,
  type Bot,
  type BotActivity,
  type BotActivityState,
  type BotId,
  type BotMemory,
  type BotUsage,
  type Card,
  compareEntries,
  type ComputerStatus,
  type CardState,
  Conflict,
  type Conversation,
  type ConversationId,
  type ConversationSummary,
  DEFAULT_SETTINGS,
  defaultBotAvatar,
  type EntryId,
  type HarnessStatus,
  Forbidden,
  InvalidInput,
  type KnownConversationEvent,
  type KnownConversationStreamItem,
  type KnownRosterStreamItem,
  type KnownTranscriptEntry,
  MAX_GROUP_BOTS,
  MIN_GROUP_BOTS,
  type ModelInfo,
  type NodeId,
  type NodeSummary,
  NotFound,
  OWNER_USER_ID,
  OpenBotRpcs,
  type RequestId,
  RequestNotPending,
  type Routine,
  type RoutineId,
  type RoutineRun,
  type RoutineRunId,
  type RuntimeRequest,
  type RuntimeResponse,
  type RuntimeResponseInput,
  type Section,
  type SectionId,
  type SendInput,
  type SendResult,
  type Settings,
  type Skill,
  type SkillName,
  type SkillPreview,
  type SlackStatus,
  type SttStatus,
  type ToolKind,
  type Turn,
  type TurnFailure,
  type TurnId,
  Unavailable,
  applySettingsPatch,
  memoryFactIdFromTitle,
} from "@openbot/contracts"
import { ConversationReplica, RosterReplica, subscribeTo } from "./replica.ts"
import { parseSkillMd, SKILLS_SH } from "./skillsSh.ts"

export const OWNER: Author = { kind: "user", userId: OWNER_USER_ID }
export const botAuthor = (botId: string): Author => ({ kind: "bot", botId: botId as BotId })

type Entry = KnownTranscriptEntry
type Running = { readonly ac: AbortController; readonly conversationId: string; readonly botId: string; streamingId?: string; toolIds: string[] }

class Aborted extends Error {}
class TurnFailed extends Error {
  constructor(readonly failure: TurnFailure) {
    super(failure.message)
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Aborted())
    const t = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(new Aborted())), { once: true })
  })

export const preview = (text: string, max = 90): string => {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const phraseFor: Record<string, string> = {
  shell: "Running a few commands",
  "file-read": "Reading the file",
  "file-edit": "Jotting it down",
  "file-write": "Jotting it down",
  search: "Digging around",
  web: "Doing some reading",
  mcp: "Working in a connected app",
}

export interface ToolStep {
  readonly name: string
  readonly toolKind: ToolKind
  readonly summary: string
  readonly command?: string
  readonly output?: string
  readonly fail?: string
}

const STT_DOWNLOAD_BYTES = 500 * 1024 * 1024
const STT_DOWNLOAD_STEP_BYTES = 200 * 1024 * 1024

export class MockBrain {
  readonly roster = new RosterReplica()
  readonly convs = new Map<string, ConversationReplica>()
  readonly revisions = new Map<string, number>()
  readonly running = new Map<string, Running>()
  readonly queues = new Map<string, Promise<void>>()
  readonly waiters = new Map<string, (r: RuntimeResponse) => void>()
  readonly routines = new Map<string, Routine>()
  readonly runs = new Map<string, RoutineRun[]>()
  readonly memory = new Map<string, BotMemory>()
  readonly skills = new Map<string, Skill>()
  readonly rules = new Map<string, ApprovalRule>()
  /** Slack (D3.4): any `xoxp-` token connects the mock to workspace "Acme". */
  slack: SlackStatus = { connected: false, events: "off" }
  stt: SttStatus = { state: "ready", model: "Parakeet TDT 0.6B v3" }
  sttFailsAppend = false
  sttDiscards = 0
  readonly attachments = new Map<string, { readonly mime: string; readonly bytes: Uint8Array }>()
  readonly sends = new Map<string, SendResult>()
  readonly usage = new Map<string, BotUsage>()
  harnesses: HarnessStatus[] = []
  origin = "http://127.0.0.1:4321"
  firstRun = false
  private seq = 0
  /** Speed factor for simulated turns (tests use a smaller value). */
  speed = 1

  // ------------------------------------------------------------------------------------- basics
  id(prefix: string): string {
    return `${prefix}_${(++this.seq).toString(36).padStart(4, "0")}`
  }
  now(): number {
    return Date.now()
  }
  get settings(): Settings {
    return this.roster.state.settings ?? DEFAULT_SETTINGS
  }
  bot(id: string): Bot | undefined {
    return this.roster.state.bots.get(id as BotId)
  }
  conv(id: string): ConversationReplica {
    const r = this.convs.get(id)
    if (!r) throw new NotFound({ entity: "conversation", id })
    return r
  }
  private wait(ms: number, signal?: AbortSignal) {
    return sleep(ms * this.speed, signal)
  }

  // ------------------------------------------------------------------------------------ writers
  putBot(bot: Bot): Bot {
    this.roster.apply({ type: "bot.upserted", bot })
    return bot
  }
  putSection(section: Section) {
    this.roster.apply({ type: "section.upserted", section })
  }
  putNode(node: NodeSummary) {
    this.roster.apply({ type: "node.upserted", node })
  }
  addConversation(conversation: Conversation, previewText?: string): ConversationReplica {
    const r = new ConversationReplica(conversation)
    this.convs.set(conversation.id, r)
    this.publishSummary(conversation.id, previewText)
    return r
  }
  put<E extends Entry>(entry: E): E {
    const rev = (this.revisions.get(entry.id) ?? -1) + 1
    this.revisions.set(entry.id, rev)
    const next = { ...entry, revision: rev, updatedAt: Math.max(entry.createdAt, entry.updatedAt) } as E
    this.conv(entry.conversationId).apply({ type: "entry.upserted", entry: next })
    return next
  }
  putTurn(turn: Turn) {
    this.conv(turn.conversationId).apply({ type: "turn.upserted", turn })
  }
  putRequest(request: RuntimeRequest) {
    this.conv(request.conversationId).apply({ type: "request.upserted", request })
    this.publishSummary(request.conversationId)
  }
  setActivity(botId: string, state: BotActivityState, opts: { conversationId?: string; label?: string; toolKind?: string } = {}) {
    const activity: BotActivity = {
      botId: botId as BotId,
      state,
      since: this.now(),
      ...(opts.conversationId ? { conversationId: opts.conversationId as ConversationId } : {}),
      ...(opts.label ? { label: opts.label } : {}),
      ...(opts.toolKind ? { toolKind: opts.toolKind } : {}),
    }
    this.roster.apply({ type: "activity.updated", activity })
  }
  updateConversation(id: string, patch: Partial<Conversation>, previewText?: string) {
    const r = this.conv(id)
    r.apply({ type: "conversation.updated", conversation: { ...r.conversation, ...patch } as Conversation })
    this.publishSummary(id, previewText)
  }
  publishSummary(id: string, previewText?: string) {
    const r = this.conv(id)
    const c = r.conversation
    const prev = this.roster.state.conversations.get(c.id)
    const summary: ConversationSummary = {
      id: c.id,
      kind: c.kind,
      title: c.title,
      botIds: c.kind === "group" ? c.memberBotIds : [c.botId],
      lastActivityAt: c.lastActivityAt,
      unreadCount: c.unreadCount,
      // The mock counts only blocking requests as "waiting for you" (async asks stay quiet).
      pendingRequestCount: r.requests.filter((q) => q.status === "pending" && q.blocking).length,
      hiddenFromSidebar: c.hiddenFromSidebar,
      ...((previewText ?? prev?.preview) !== undefined ? { preview: previewText ?? prev?.preview } : {}),
    }
    this.roster.apply({ type: "conversation.upserted", conversation: summary })
  }

  // ------------------------------------------------------------------------------ entry helpers
  message(conversationId: string, author: Author, text: string, at: number, extra: Partial<Extract<Entry, { kind: "message" }>> = {}): Extract<Entry, { kind: "message" }> {
    return {
      id: (extra.id ?? this.id("ent")) as EntryId,
      conversationId: conversationId as ConversationId,
      revision: 0,
      createdAt: at,
      updatedAt: at,
      author,
      kind: "message",
      role: author.kind === "user" ? "user" : "bot",
      text,
      attachments: [],
      streaming: false,
      ...extra,
    } as Extract<Entry, { kind: "message" }>
  }
  event(conversationId: string, author: Author, event: KnownConversationEvent, at: number, turnId?: string): Extract<Entry, { kind: "event" }> {
    return {
      id: this.id("ent") as EntryId,
      conversationId: conversationId as ConversationId,
      revision: 0,
      createdAt: at,
      updatedAt: at,
      author,
      kind: "event",
      event,
      ...(turnId ? { turnId: turnId as TurnId } : {}),
    }
  }
  card(conversationId: string, botId: string, card: Card, state: CardState, at: number, turnId?: string): Extract<Entry, { kind: "card" }> {
    return {
      id: this.id("ent") as EntryId,
      conversationId: conversationId as ConversationId,
      revision: 0,
      createdAt: at,
      updatedAt: at,
      author: botAuthor(botId),
      kind: "card",
      card: card as Extract<Entry, { kind: "card" }>["card"],
      state,
      ...(turnId ? { turnId: turnId as TurnId } : {}),
    }
  }
  tool(conversationId: string, botId: string, turnId: string, step: ToolStep, at: number, status: Extract<Entry, { kind: "tool-call" }>["status"]): Extract<Entry, { kind: "tool-call" }> {
    return {
      id: this.id("ent") as EntryId,
      conversationId: conversationId as ConversationId,
      revision: 0,
      createdAt: at,
      updatedAt: at,
      author: botAuthor(botId),
      turnId: turnId as TurnId,
      kind: "tool-call",
      toolCallId: this.id("call"),
      name: step.name,
      toolKind: step.toolKind,
      status,
      input: step.command ? { command: step.command } : { target: step.summary },
      inputSummary: step.summary,
      ...(step.command ? { command: { command: step.command, cwd: "~/openbot" } } : {}),
      startedAt: at,
    }
  }
  /** A request + its card in one go. */
  request(input: {
    conversationId: string
    botId: string
    turnId?: string
    kind: RuntimeRequest["kind"]
    title: string
    card: Card
    capability: RuntimeRequest["responseCapability"]
    blocking: boolean
    at: number
    status?: RuntimeRequest["status"]
    subject?: RuntimeRequest["subject"]
    suggestedRule?: RuntimeRequest["suggestedRule"]
    expiresInMs?: number
  }): { request: RuntimeRequest; entry: Extract<Entry, { kind: "card" }> } {
    const requestId = (input.card as { requestId?: string }).requestId as RequestId
    const status = input.status ?? "pending"
    const entry = this.card(
      input.conversationId,
      input.botId,
      input.card,
      { status: status === "pending" ? "pending" : status === "expired" ? "expired" : status === "cancelled" ? "cancelled" : "resolved" },
      input.at,
      input.turnId,
    )
    const request: RuntimeRequest = {
      id: requestId,
      conversationId: input.conversationId as ConversationId,
      botId: input.botId as BotId,
      cardEntryId: entry.id,
      kind: input.kind,
      status,
      title: input.title,
      subject: input.subject ?? {},
      responseCapability: input.capability,
      source: { origin: "fake", method: "mock", nativeRequestId: requestId },
      blocking: input.blocking,
      createdAt: input.at,
      expiresAt: input.at + (input.expiresInMs ?? this.settings.approvalExpiryMinutes * 60_000),
      ...(input.turnId ? { turnId: input.turnId as TurnId } : {}),
      ...(input.suggestedRule ? { suggestedRule: input.suggestedRule } : {}),
      ...(status === "expired" ? { statusReason: "timeout" } : {}),
    }
    return { request, entry }
  }

  // ------------------------------------------------------------------------------------- turns
  private touchActivity(conversationId: string, at: number, previewText?: string, unread = false) {
    const c = this.conv(conversationId).conversation
    const patch: { -readonly [K in "lastActivityAt" | "unreadCount" | "unreadBoundaryAt"]?: number } = { lastActivityAt: at }
    if (unread) {
      patch.unreadCount = c.unreadCount + 1
      if (c.unreadCount === 0) patch.unreadBoundaryAt = at - 1
    }
    this.updateConversation(conversationId, patch, previewText)
  }

  enqueue(conversationId: string, botId: string, run: () => Promise<void>): Promise<void> {
    const key = `${botId}/${conversationId}`
    const prev = this.queues.get(key) ?? Promise.resolve()
    const next = prev.then(run, run)
    this.queues.set(key, next)
    return next
  }

  startTurn(conversationId: string, botId: string, trigger: Turn["trigger"], script: (turn: Turn, signal: AbortSignal) => Promise<void>, inputEntryId?: string): TurnId {
    const turnId = this.id("trn") as TurnId
    const queued: Turn = {
      id: turnId,
      conversationId: conversationId as ConversationId,
      botId: botId as BotId,
      status: this.running.size > 0 && [...this.running.values()].some((r) => r.botId === botId && r.conversationId === conversationId) ? "queued" : "running",
      trigger,
      startedAt: this.now(),
      ...(inputEntryId ? { inputEntryId: inputEntryId as EntryId } : {}),
    }
    this.putTurn(queued)
    void this.enqueue(conversationId, botId, async () => {
      const turn: Turn = { ...queued, status: "running", startedAt: this.now() }
      const current = this.conv(conversationId).state.turns.get(turnId)
      if (current && current.status !== "queued" && current.status !== "running") return
      this.putTurn(turn)
      const ac = new AbortController()
      this.running.set(turnId, { ac, conversationId, botId, toolIds: [] })
      this.setActivity(botId, "thinking", { conversationId, label: "Thinking it through" })
      try {
        await script(turn, ac.signal)
        this.finishTurn(turnId, "completed")
      } catch (error) {
        if (error instanceof TurnFailed) this.finishTurn(turnId, "failed", error.failure)
        else if (error instanceof Aborted || ac.signal.aborted) this.finishTurn(turnId, "interrupted")
        else this.finishTurn(turnId, "failed", { code: "internal", message: String((error as Error)?.message ?? error), retryable: true })
      }
    })
    return turnId
  }

  finishTurn(turnId: string, status: "completed" | "failed" | "interrupted", failure?: TurnFailure) {
    const run = this.running.get(turnId)
    const conversationId = run?.conversationId ?? [...this.convs.values()].find((c) => c.state.turns.has(turnId as TurnId))?.conversation.id
    if (!conversationId) return
    const r = this.conv(conversationId)
    const turn = r.state.turns.get(turnId as TurnId)
    if (!turn || turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted") return
    this.running.delete(turnId)
    const now = this.now()
    // Close a streaming reply and running tools.
    for (const e of r.entries) {
      if (e.turnId !== turnId) continue
      if (e.kind === "message" && e.streaming) this.put({ ...e, streaming: false, ...(status === "interrupted" ? { aborted: true } : {}), updatedAt: now })
      if (e.kind === "tool-call" && (e.status === "running" || e.status === "pending" || e.status === "awaiting-approval")) this.put({ ...e, status: status === "interrupted" ? "interrupted" : "failed", completedAt: now, updatedAt: now })
    }
    for (const q of r.requests) if (q.turnId === turnId && q.status === "pending" && q.blocking) this.cancelRequest(q, "turn-ended")
    const usage = { inputTokens: 1200 + Math.round(Math.random() * 3000), outputTokens: 200 + Math.round(Math.random() * 600) }
    this.putTurn({ ...turn, status, endedAt: now, usage, ...(failure ? { failure } : {}), ...(status === "interrupted" ? { stopReason: "interrupted" } : {}) })
    const prevUsage = this.usage.get(turn.botId)
    this.usage.set(turn.botId, {
      botId: turn.botId,
      usage: {
        inputTokens: (prevUsage?.usage.inputTokens ?? 0) + usage.inputTokens,
        outputTokens: (prevUsage?.usage.outputTokens ?? 0) + usage.outputTokens,
        costUsd: Number((((prevUsage?.usage.costUsd ?? 0) as number) + usage.inputTokens * 3e-6 + usage.outputTokens * 15e-6).toFixed(4)),
      },
      turnCount: (prevUsage?.turnCount ?? 0) + 1,
      lastAt: now,
    })
    // Context ring.
    const c = r.conversation
    const sessions = [...(c.sessions ?? [])]
    const i = sessions.findIndex((s) => s.botId === turn.botId)
    const used = Math.min(195_000, (i >= 0 ? (sessions[i]!.contextUsage?.usedTokens ?? 0) : 8_000) + usage.inputTokens + usage.outputTokens * 4)
    const session = { botId: turn.botId, active: true, contextUsage: { usedTokens: used, windowTokens: 200_000 }, updatedAt: now }
    if (i >= 0) sessions[i] = session
    else sessions.push(session)
    this.updateConversation(conversationId, { sessions })
    this.setActivity(turn.botId, status === "failed" ? "error" : "idle", status === "failed" ? { conversationId, label: failure?.message ?? "Failed" } : {})
    if (status === "failed") setTimeout(() => this.setActivity(turn.botId, "idle"), 1500)
  }

  /** Streams `text` into one bot message, a few characters per tick. */
  async stream(turn: Turn, text: string, signal: AbortSignal, extra: Partial<Extract<Entry, { kind: "message" }>> = {}): Promise<Extract<Entry, { kind: "message" }>> {
    const run = this.running.get(turn.id)
    const at = this.now()
    let entry = this.put(this.message(turn.conversationId, botAuthor(turn.botId), "", at, { streaming: true, turnId: turn.id, ...extra }))
    if (run) run.streamingId = entry.id
    this.setActivity(turn.botId, "working", { conversationId: turn.conversationId, label: "Typing…" })
    const words = text.split(/(\s+)/)
    let shown = ""
    for (let i = 0; i < words.length; i += 3) {
      await this.wait(55, signal)
      shown += words.slice(i, i + 3).join("")
      entry = this.put({ ...entry, text: shown, updatedAt: this.now() })
    }
    entry = this.put({ ...entry, text, streaming: false, updatedAt: this.now() })
    if (run) run.streamingId = undefined
    this.touchActivity(turn.conversationId, entry.createdAt, preview(text), true)
    return entry
  }

  async steps(turn: Turn, steps: ReadonlyArray<ToolStep>, signal: AbortSignal) {
    if (steps.length > 0) {
      await this.wait(500, signal)
      this.put({
        id: this.id("ent") as EntryId,
        conversationId: turn.conversationId,
        revision: 0,
        createdAt: this.now(),
        updatedAt: this.now(),
        author: botAuthor(turn.botId),
        turnId: turn.id,
        kind: "reasoning",
        text: `Plan: ${steps.map((s) => s.summary).join(" → ")}.`,
        streaming: false,
        source: "thinking",
      })
    }
    for (const step of steps) {
      const started = this.tool(turn.conversationId, turn.botId, turn.id, step, this.now(), "running")
      let entry = this.put(started)
      this.setActivity(turn.botId, "working", { conversationId: turn.conversationId, label: phraseFor[step.toolKind] ?? "Working on it", toolKind: step.toolKind })
      await this.wait(700, signal)
      entry = this.put({
        ...entry,
        status: step.fail ? "failed" : "completed",
        completedAt: this.now(),
        updatedAt: this.now(),
        ...(step.output ? { output: { text: step.output } } : {}),
        ...(step.fail ? { error: step.fail } : {}),
        ...(entry.command ? { command: { ...entry.command, exitCode: step.fail ? 1 : 0 } } : {}),
      })
    }
  }

  /** Blocks the turn on a request until `requests.respond` (or interrupt). */
  async ask(turn: Turn, input: Omit<Parameters<MockBrain["request"]>[0], "conversationId" | "botId" | "turnId" | "at" | "blocking">, signal: AbortSignal, label: string): Promise<RuntimeResponse> {
    const { request, entry } = this.request({ ...input, conversationId: turn.conversationId, botId: turn.botId, turnId: turn.id, at: this.now(), blocking: true })
    this.put(entry)
    this.putRequest(request)
    this.putTurn({ ...turn, status: "waiting" })
    this.setActivity(turn.botId, "waiting", { conversationId: turn.conversationId, label: `Waiting for you: ${label}` })
    this.publishSummary(turn.conversationId, `Waiting for you: ${label}`)
    const response = await new Promise<RuntimeResponse>((resolve, reject) => {
      this.waiters.set(request.id, resolve)
      signal.addEventListener("abort", () => reject(new Aborted()), { once: true })
    })
    this.waiters.delete(request.id)
    this.putTurn({ ...turn, status: "running" })
    return response
  }

  cancelRequest(q: RuntimeRequest, reason: string) {
    this.putRequest({ ...q, status: "cancelled", statusReason: reason, resolvedAt: this.now() })
    const r = this.conv(q.conversationId)
    const entry = r.state.entries.get(q.cardEntryId)
    if (entry?.kind === "card") this.put({ ...entry, state: { status: "cancelled" }, updatedAt: this.now() } as Entry)
  }

  // --------------------------------------------------------------------------------- scripts
  /** Picks a scripted behaviour for a user message. */
  replyTo(conversationId: string, botId: string, text: string, inputEntryId?: string): TurnId {
    const lower = text.toLowerCase()
    const bot = this.bot(botId)
    const name = bot?.name ?? "Bot"
    if (/\bfail|\bbreak\b|\berror\b/.test(lower)) {
      return this.startTurn(conversationId, botId, "user", async (turn, signal) => {
        await this.wait(600, signal)
        await this.stream(turn, "Pulling the cohort table now.", signal)
        await this.steps(turn, [{ name: "Bash", toolKind: "shell", summary: "psql -f cohort.sql", command: "psql -f queries/cohort.sql", fail: "connection timed out" }], signal)
        await this.wait(900, signal)
        throw new TurnFailed({ code: "timeout", message: "The reply timed out", retryable: true })
      }, inputEntryId)
    }
    if (/\b(approve|run|deploy|delete|clean|push|archive)\b/.test(lower)) {
      const command = /deploy|push/.test(lower) ? "git push origin --tags" : /delete|clean|archive/.test(lower) ? "rm -rf ~/builds/2024-*" : "npm test"
      return this.startTurn(conversationId, botId, "user", async (turn, signal) => {
        await this.wait(500, signal)
        await this.steps(turn, [{ name: "Read", toolKind: "file-read", summary: "package.json", output: '{ "name": "app", "scripts": { "test": "bun test" } }' }], signal)
        const requestId = this.id("req")
        const tool = this.put(this.tool(conversationId, botId, turn.id, { name: "Bash", toolKind: "shell", summary: command, command }, this.now(), "awaiting-approval"))
        const response = await this.ask(
          turn,
          {
            kind: "command-approval",
            title: `Allow ${name} to run a command on your computer?`,
            card: { type: "approval", requestId: requestId as RequestId, requestKind: "command-approval", title: `Allow ${name} to run a command on your computer?`, summary: `Run \`${command}\` in ~/openbot.`, command, cwd: "~/openbot", toolName: "Bash", nodeLabel: "This computer", suggestedRule: { surface: "shell", match: { commandPrefix: command.split(" ").slice(0, 2).join(" ") } } },
            capability: { type: "decision", options: [{ id: "allow-once" }, { id: "allow-always" }, { id: "deny" }], allowMessage: true },
            subject: { toolName: "Bash", command, cwd: "~/openbot", toolCallEntryId: tool.id },
            suggestedRule: { surface: "shell", match: { commandPrefix: command.split(" ").slice(0, 2).join(" ") } },
          },
          signal,
          "run a command",
        )
        const allowed = response.type === "decision" && response.decision.startsWith("allow")
        this.put({ ...tool, status: allowed ? "running" : "declined", updatedAt: this.now() })
        if (allowed) {
          this.setActivity(botId, "working", { conversationId, label: "Running a few commands", toolKind: "shell" })
          await this.wait(900, signal)
          this.put({ ...tool, status: "completed", completedAt: this.now(), updatedAt: this.now(), output: { text: "✓ done in 1.2s" }, command: { command, cwd: "~/openbot", exitCode: 0 } })
          await this.stream(turn, `Done. Ran \`${command}\` and it finished cleanly.\n\n- **Exit code** → 0\n- **Time** → 1.2s`, signal)
        } else {
          await this.stream(turn, "Okay, I won't run it. Tell me if you want a different approach.", signal)
        }
      }, inputEntryId)
    }
    if (/\b(choose|pick|which|options?|ask me)\b/.test(lower)) {
      return this.startTurn(conversationId, botId, "user", async (turn, signal) => {
        await this.wait(700, signal)
        await this.stream(turn, "I found three that fit. Which should I go with?", signal)
        const requestId = this.id("req")
        const { request, entry } = this.request({
          conversationId,
          botId,
          turnId: turn.id,
          kind: "question",
          title: "Which one should I go with?",
          card: {
            type: "question",
            requestId: requestId as RequestId,
            questions: [
              { id: "q1", prompt: "Which one should I go with?", options: [{ label: "The fastest option" }, { label: "The cheapest option" }, { label: "Show me all three" }], multiSelect: false, allowFreeText: true },
            ],
          },
          capability: { type: "answers", questions: [] },
          blocking: false,
          at: this.now(),
        })
        this.put(entry)
        this.putRequest(request)
      }, inputEntryId)
    }
    const ask = /\bask\s+@?([\w ]+?)(?:\s+(?:to|about|for|if)\b|[?.!,]|$)/i.exec(text)
    const peer = ask ? [...this.roster.state.bots.values()].find((b) => b.id !== botId && b.name.toLowerCase() === ask[1]!.trim().toLowerCase()) : undefined
    if (peer) {
      return this.startTurn(conversationId, botId, "user", async (turn, signal) => {
        await this.wait(600, signal)
        const at = this.now()
        const delivered = this.put(this.message(peer.directConversationId, botAuthor(botId), `Quick one from the owner: ${text}`, at, { toBotId: peer.id }))
        this.put(this.event(conversationId, botAuthor(botId), { type: "messaged-bot", toBotId: peer.id, toName: peer.name, conversationId: peer.directConversationId, entryId: delivered.id }, at, turn.id))
        this.touchActivity(peer.directConversationId, at, preview(delivered.text), true)
        this.replyTo(peer.directConversationId, peer.id, "status update", delivered.id)
        await this.stream(turn, `I asked **${peer.name}**. I'll pass along what they say.`, signal)
      }, inputEntryId)
    }
    return this.startTurn(conversationId, botId, "user", async (turn, signal) => {
      await this.wait(650, signal)
      await this.steps(
        turn,
        [
          { name: "Read", toolKind: "file-read", summary: "notes/today.md", output: "- deck review 2pm\n- offsite venue\n- expense report" },
          { name: "Bash", toolKind: "shell", summary: "rg -n \"TODO\" ops/", command: "rg -n \"TODO\" ops/", output: "ops/offsite.md:12: TODO confirm catering\nops/deck.md:4: TODO refresh Q3 numbers" },
        ],
        signal,
      )
      await this.stream(turn, cannedReply(text, name), signal)
    }, inputEntryId)
  }

  /** Follow-up after an async (non-blocking) request is answered. */
  followUp(request: RuntimeRequest, response: RuntimeResponse) {
    const { conversationId, botId } = request
    let text: string
    if (response.type === "answers") {
      const answer = Object.values(response.answers)[0]?.join(", ") ?? "that"
      text = `Got it: **${answer}**. I'll take it from here.`
    } else if (response.type === "decision") {
      text = response.decision.startsWith("allow") ? "Done. Archived 14 folders and freed 6.2 GB." : "Okay, I'll leave them where they are."
    } else if (response.type === "form") text = "Thanks, I've saved those details."
    else if (response.type === "secret") text = "Thanks. I'll use it for this session only."
    else if (response.type === "acknowledge") text = response.action === "skip" ? "No problem, skipping that step." : "Thanks for handing it back. Continuing."
    else return
    this.startTurn(conversationId, botId, "user", async (turn, signal) => {
      await this.wait(500, signal)
      await this.stream(turn, text, signal)
    })
  }

  // ------------------------------------------------------------------------------- computers
  // Desktops (D1.7) on nodes with `desktop@1`: one per bot, asleep (`absent`) until woken, 1920×1200;
  // the owner's control lease; `/ws/computer/:botId` (dev/mock-server.ts) serves a fake RFB desktop.
  // Like the brain, handing control back answers the bot's pending hand-offs "done".
  readonly desktops = new Map<string, { state: "absent" | "ready"; controller: "bot" | "user" }>()
  /** What a node lacks for desktops (`node.hello.desktop.missing`), by node id. */
  readonly desktopMissing = new Map<string, ReadonlyArray<string>>()
  /** Open desktop viewer sockets per bot (closed on release / reset). */
  readonly desktopViewers = new Map<string, Set<{ readonly mode: "view" | "control"; readonly close: (code: number, reason: string) => void }>>()
  /** Bots whose screen can't be reached: their viewer sockets close at once with 1011 + this reason. */
  readonly desktopBroken = new Map<string, string>()
  /** Input the fake desktops received (dev diagnostics, `/api/mock/desktop`). */
  readonly desktopInput = { pointer: 0, keys: 0 }

  private desktopOf(botId: string) {
    let d = this.desktops.get(botId)
    if (!d) {
      d = { state: "absent", controller: "bot" }
      this.desktops.set(botId, d)
    }
    return d
  }

  computerStatus(botId: string): ComputerStatus {
    const bot = this.bot(botId)
    if (!bot) throw new NotFound({ entity: "bot", id: botId })
    const node = this.roster.state.nodes.get(bot.hostNodeId)
    const missing = this.desktopMissing.get(bot.hostNodeId)
    const base = { botId: bot.id, nodeId: bot.hostNodeId, ...(missing && missing.length > 0 ? { missing } : {}) }
    if (node?.capabilities.includes("desktop@1")) {
      const d = this.desktopOf(botId)
      return { ...base, state: d.state, surface: "desktop", controller: d.controller, viewPath: `/ws/computer/${bot.id}`, ...(d.state === "ready" ? { width: 1920, height: 1200 } : {}) }
    }
    if (node?.capabilities.includes("browser@1")) {
      return { ...base, state: "error", surface: "browser", controller: "bot", viewPath: `/ws/computer/${bot.id}`, message: "The dev mock has no browser screencast." }
    }
    return { ...base, state: "unsupported", surface: "none", controller: "bot", message: `${node?.label ?? "This computer"} has no screen to show.` }
  }

  computerEnsure(botId: string): ComputerStatus {
    const st = this.computerStatus(botId)
    if (st.surface === "desktop") this.desktopOf(botId).state = "ready"
    return this.computerStatus(botId)
  }

  computerLease(botId: string, take: boolean): ComputerStatus {
    const st = this.computerStatus(botId)
    if (st.surface !== "desktop") throw new Conflict({ reason: "This computer has no screen to take over" })
    const d = this.desktopOf(botId)
    d.controller = take ? "user" : "bot"
    if (!take) {
      for (const v of this.desktopViewers.get(botId) ?? []) if (v.mode === "control") v.close(1000, "control released")
      // the brain answers the bot's pending hand-offs when the owner hands the screen back
      for (const c of this.convs.values()) {
        for (const q of c.state.requests.values()) {
          if (q.botId === botId && q.kind === "handoff" && q.status === "pending") this.respond(q.id, { type: "acknowledge", action: "done" })
        }
      }
    }
    return this.computerStatus(botId)
  }

  computerReset(botId: string): ComputerStatus {
    const st = this.computerStatus(botId)
    if (st.surface !== "desktop") return st
    for (const v of this.desktopViewers.get(botId) ?? []) v.close(1012, "screen reset")
    this.desktops.set(botId, { state: "absent", controller: "bot" })
    return this.computerStatus(botId)
  }

  /** `/ws/computer/:botId` before the upgrade: the brain's HTTP refusals. */
  desktopViewerCheck(botId: string, mode: "view" | "control"): { readonly ok: true; readonly accent: string; readonly page: "signin" | "dashboard" } | { readonly ok: false; readonly status: number; readonly text: string } {
    const bot = this.bot(botId)
    if (!bot) return { ok: false, status: 404, text: "unknown bot" }
    const st = this.computerStatus(botId)
    if (st.surface !== "desktop") return { ok: false, status: 409, text: st.message ?? "no live view" }
    if (mode === "control" && st.controller !== "user") return { ok: false, status: 403, text: "Take control first" }
    // a viewer wakes the desktop (like the brain's viewer, which ensures it first)
    this.desktopOf(botId).state = "ready"
    const handoff = [...this.convs.values()].some((c) => [...c.state.requests.values()].some((q) => q.botId === botId && q.kind === "handoff" && q.status === "pending"))
    return { ok: true, accent: bot.avatar.color, page: handoff ? "signin" : "dashboard" }
  }

  joinDesktop(botId: string, viewer: { readonly mode: "view" | "control"; readonly close: (code: number, reason: string) => void }): () => void {
    let set = this.desktopViewers.get(botId)
    if (!set) {
      set = new Set()
      this.desktopViewers.set(botId, set)
    }
    set.add(viewer)
    return () => set.delete(viewer)
  }

  /** A bot's `request_takeover`: an async "Action needed" hand-off card (D1.7). */
  takeover(conversationId: string, botId: string, instruction: string, at = this.now(), turnId?: string) {
    const requestId = this.id("req") as RequestId
    const bot = this.bot(botId)
    const { request, entry } = this.request({
      conversationId,
      botId,
      ...(turnId ? { turnId } : {}),
      kind: "handoff",
      title: instruction,
      card: { type: "handoff", requestId, nodeId: (bot?.hostNodeId ?? "node_local") as NodeId, instruction },
      capability: { type: "acknowledge", actions: ["done", "skip"] },
      subject: { toolName: "request_takeover" },
      blocking: false,
      at,
      expiresInMs: 60 * 60_000,
    })
    this.put(entry)
    this.putRequest(request)
    return request
  }

  // ----------------------------------------------------------------------------------- RPCs
  send(input: SendInput): SendResult {
    const r = this.conv(input.conversationId)
    const prior = this.sends.get(input.clientNonce)
    if (prior) return { ...prior, disposition: "duplicate" }
    const at = this.now()
    const attachments = (input.attachmentIds ?? []).flatMap((id): Attachment[] => {
      const a = this.attachments.get(id)
      return a ? [{ id: id as AttachmentId, name: (a as { name?: string }).name ?? id, mime: a.mime, byteSize: a.bytes.byteLength, url: `/api/attachments/${id}` }] : []
    })
    const entry = this.put(
      this.message(input.conversationId, OWNER, input.text, at, {
        clientNonce: input.clientNonce,
        delivery: "accepted",
        attachments,
        ...(input.replyToId ? { replyToId: input.replyToId } : {}),
        ...(input.addressedBotIds ? { addressedBotIds: input.addressedBotIds } : {}),
      }),
    )
    this.updateConversation(input.conversationId, { lastActivityAt: at, unreadCount: 0 }, preview(input.text))
    const c = r.conversation
    let targets: string[]
    if (c.kind === "group") {
      const members = c.memberBotIds as ReadonlyArray<string>
      if (input.addressEveryone) targets = [...members]
      else if (input.addressedBotIds && input.addressedBotIds.length > 0) targets = input.addressedBotIds.filter((id) => members.includes(id))
      else if (input.replyToId) {
        const replied = r.state.entries.get(input.replyToId)
        targets = replied?.author.kind === "bot" && members.includes(replied.author.botId) ? [replied.author.botId] : [c.leadBotId ?? members[0]!]
      } else targets = [c.leadBotId ?? members[0]!]
    } else targets = [c.botId]
    const turnIds = targets.map((botId, i) => {
      if (i === 0) return this.replyTo(input.conversationId, botId, input.text, entry.id)
      return this.startTurn(input.conversationId, botId, "user", async (turn, signal) => {
        await this.wait(1200 + i * 600, signal)
        await this.stream(turn, cannedGroupReply(this.bot(botId)?.name ?? "Bot", input.text), signal)
      }, entry.id)
    })
    const result: SendResult = { entryId: entry.id, turnIds, disposition: turnIds.length > 0 ? "started" : "queued" }
    this.sends.set(input.clientNonce, result)
    return result
  }

  interrupt(conversationId: string, turnId?: string): Turn[] {
    const r = this.conv(conversationId)
    const out: Turn[] = []
    for (const t of r.turns) {
      if (turnId && t.id !== turnId) continue
      if (t.status !== "running" && t.status !== "waiting" && t.status !== "queued") continue
      const run = this.running.get(t.id)
      if (run) run.ac.abort()
      else this.finishTurn(t.id, "interrupted")
      if (t.status === "queued") this.putTurn({ ...t, status: "interrupted", endedAt: this.now() })
      out.push(r.state.turns.get(t.id) ?? t)
    }
    return out
  }

  /** A failed reply tries again (the mock answers instead of failing a second time). */
  retry(conversationId: string, turnId: string) {
    const turn = this.conv(conversationId).state.turns.get(turnId as TurnId)
    if (!turn) throw new NotFound({ entity: "turn", id: turnId })
    if (turn.status !== "failed") throw new InvalidInput({ message: "Only a reply that failed can be retried." })
    this.replyTo(conversationId, turn.botId, "retry", turn.inputEntryId)
  }

  advanceSttInstall(): SttStatus {
    if (this.stt.state !== "installing") return this.stt
    const downloadedBytes = Math.min(STT_DOWNLOAD_BYTES, (this.stt.downloadedBytes ?? 0) + STT_DOWNLOAD_STEP_BYTES)
    this.stt = downloadedBytes >= STT_DOWNLOAD_BYTES
      ? { state: "ready", model: this.stt.model }
      : { state: "installing", model: this.stt.model, downloadBytes: STT_DOWNLOAD_BYTES, downloadedBytes }
    return this.stt
  }

  /** A Slack draft card (by entry): Send (with the owner's edits) or Discard. */
  answerSlackDraft(entryId: string, text: string | undefined) {
    const conv = [...this.convs.values()].find((c) => c.state.entries.has(entryId as EntryId))
    const entry = conv?.state.entries.get(entryId as EntryId)
    if (entry?.kind !== "card" || entry.card.type !== "slack-draft") throw new NotFound({ entity: "slack draft", id: entryId })
    if (entry.state.status !== "pending") throw new Conflict({ reason: entry.state.status === "resolved" ? "This message was already sent." : "This draft was discarded." })
    if (text !== undefined && !this.slack.connected) throw new Unavailable({ message: "Slack isn't connected (Connect apps › Slack)." })
    const card = text === undefined ? entry.card : { ...entry.card, text }
    const state = text === undefined
      ? { status: "dismissed" as const, detail: "Discarded" }
      : { status: "resolved" as const, detail: "Sent", link: `https://acme.slack.com/archives/${entry.card.channelId}/p${this.now()}000` }
    this.put({ ...entry, card, state, updatedAt: this.now() } as Entry)
  }

  respond(requestId: string, input: RuntimeResponseInput): RuntimeRequest {
    const conv = [...this.convs.values()].find((c) => c.state.requests.has(requestId as RequestId))
    if (!conv) throw new NotFound({ entity: "request", id: requestId })
    const q = conv.state.requests.get(requestId as RequestId)!
    if (q.status !== "pending") throw new RequestNotPending({ requestId: q.id, status: q.status })
    const response: RuntimeResponse = input.type === "secret" ? { type: "secret", provided: true } : (input as RuntimeResponse)
    const resolved: RuntimeRequest = { ...q, status: "resolved", response, resolvedAt: this.now(), resolvedBy: OWNER }
    this.putRequest(resolved)
    const entry = conv.state.entries.get(q.cardEntryId)
    if (entry?.kind === "card") this.put({ ...entry, state: { status: response.type === "dismiss" ? "dismissed" : "resolved", response, ...(response.type === "secret" ? { detail: "Saved securely and kept private" } : {}) }, updatedAt: this.now() } as Entry)
    if (response.type === "decision" && response.decision === "allow-always" && q.suggestedRule) {
      const rule: ApprovalRule = { id: this.id("rul") as ApprovalRule["id"], botId: q.botId, surface: q.suggestedRule.surface, match: q.suggestedRule.match, action: "allow", origin: "always-allow", createdAt: this.now() }
      this.rules.set(rule.id, rule)
    }
    const waiter = this.waiters.get(q.id)
    if (waiter) waiter(response)
    else if (response.type !== "dismiss") this.followUp(resolved, response)
    this.publishSummary(q.conversationId)
    return resolved
  }

  createBot(input: { name: string; label?: string; avatar?: Bot["avatar"]; harness: Bot["harness"]; hostNodeId?: string; instructions?: string; autonomy?: Bot["autonomy"] }): Bot {
    const id = this.id("bot") as BotId
    const conversationId = this.id("cnv") as ConversationId
    const at = this.now()
    const bot: Bot = {
      id,
      name: input.name,
      ...(input.label ? { label: input.label } : {}),
      avatar: input.avatar ?? defaultBotAvatar(id),
      harness: input.harness,
      hostNodeId: (input.hostNodeId ?? "node_local") as NodeId,
      boundNodeIds: [],
      instructions: input.instructions ?? "",
      directConversationId: conversationId,
      pinned: false,
      hidden: false,
      notify: "all",
      autonomy: input.autonomy ?? "workspace",
      projectFolders: [],
      skills: [],
      createdAt: at,
      updatedAt: at,
    }
    this.putBot(bot)
    this.memory.set(id, { index: "", facts: [] })
    this.addConversation({ id: conversationId, kind: "direct", botId: id, title: bot.name, createdAt: at, lastActivityAt: at, unreadCount: 0, hiddenFromSidebar: false, epoch: "e1" }, "Joined the team")
    this.put(this.event(conversationId, { kind: "system" }, { type: "joined", botId: id, name: bot.name }, at))
    this.startTurn(conversationId, id, "system", async (turn, signal) => {
      await this.wait(700, signal)
      await this.stream(turn, `Hi, I'm **${bot.name}**. I run on ${input.harness.kind === "fake" ? "the offline demo harness" : input.harness.kind}. What would you like me to take off your plate?`, signal)
      const requestId = this.id("req")
      const { request, entry } = this.request({
        conversationId,
        botId: id,
        turnId: turn.id,
        kind: "question",
        title: "What would you like me to take off your plate?",
        card: {
          type: "question",
          requestId: requestId as RequestId,
          questions: [
            {
              id: "q1",
              prompt: "What would you like me to take off your plate?",
              options: [{ label: "Triage my inbox every morning" }, { label: "Keep an eye on competitors" }, { label: "Prep my meetings" }, { label: "Something else" }],
              multiSelect: false,
              allowFreeText: true,
            },
          ],
        },
        capability: { type: "answers", questions: [] },
        blocking: false,
        at: this.now(),
      })
      this.put(entry)
      this.putRequest(request)
    })
    return bot
  }

  createGroup(input: { title: string; memberBotIds: ReadonlyArray<string>; leadBotId?: string }): Conversation {
    const members = [...new Set(input.memberBotIds)]
    if (members.length < MIN_GROUP_BOTS || members.length > MAX_GROUP_BOTS) throw new InvalidInput({ message: `A group chat needs ${MIN_GROUP_BOTS}–${MAX_GROUP_BOTS} Bots` })
    for (const id of members) if (!this.bot(id)) throw new NotFound({ entity: "bot", id })
    const at = this.now()
    const conversation: Conversation = {
      id: this.id("cnv") as ConversationId,
      kind: "group",
      memberBotIds: members as BotId[],
      ...(input.leadBotId ? { leadBotId: input.leadBotId as BotId } : {}),
      namedBy: input.title ? "user" : "app",
      title: input.title || members.map((m) => this.bot(m)!.name).join(", "),
      createdAt: at,
      lastActivityAt: at,
      unreadCount: 0,
      hiddenFromSidebar: false,
      epoch: "e1",
    }
    this.addConversation(conversation, "New group chat")
    for (const id of members) this.put(this.event(conversation.id, { kind: "system" }, { type: "member-added", botId: id as BotId, name: this.bot(id)!.name }, at))
    return conversation
  }

  /** `conversations.exchange`: both directions from both DMs, paged by `"<createdAt>:<id>"` cursors. */
  exchange(input: { readonly botId: string; readonly peerBotId: string; readonly at?: number; readonly before?: string; readonly after?: string; readonly limit: number }) {
    const a = this.bot(input.botId)
    const b = this.bot(input.peerBotId)
    if (!a || !b) throw new NotFound({ entity: "bot", id: a ? input.peerBotId : input.botId })
    const all = [a, b]
      .flatMap((bot) => this.conv(bot.directConversationId).entries)
      .filter((e) => e.kind === "message" && e.author.kind === "bot" && ((e.author.botId === a.id && e.toBotId === b.id) || (e.author.botId === b.id && e.toBotId === a.id)))
      .sort(compareEntries)
    const cursor = (e: { readonly createdAt: number; readonly id: string }) => `${e.createdAt}:${e.id}`
    const position = (c: string) => ({ createdAt: Number(c.slice(0, c.indexOf(":"))), id: c.slice(c.indexOf(":") + 1) })
    const countUpTo = (p: { readonly createdAt: number; readonly id: string }, inclusive: boolean) => all.filter((e) => compareEntries(e, p) < (inclusive ? 1 : 0)).length
    let start: number
    let end: number
    if (input.before) {
      end = countUpTo(position(input.before), false)
      start = Math.max(0, end - input.limit)
    } else if (input.after) {
      start = countUpTo(position(input.after), true)
      end = Math.min(all.length, start + input.limit)
    } else {
      const split = input.at === undefined ? all.length : all.filter((e) => e.createdAt <= input.at!).length
      end = Math.min(all.length, Math.max(0, split - Math.ceil(input.limit / 2)) + input.limit)
      start = Math.max(0, end - input.limit)
    }
    const entries = all.slice(start, end)
    return {
      entries,
      beforeCursor: start > 0 && entries[0] ? cursor(entries[0]) : null,
      afterCursor: end < all.length && entries.length > 0 ? cursor(entries[entries.length - 1]!) : null,
    }
  }

  markRead(conversationId: string, unread?: boolean, at?: number) {
    const r = this.conv(conversationId)
    if (unread) {
      const lastBot = [...r.entries].reverse().find((e) => e.author.kind === "bot")
      this.updateConversation(conversationId, { unreadCount: 1, unreadBoundaryAt: (lastBot?.createdAt ?? this.now()) - 1 })
    } else this.updateConversation(conversationId, { unreadCount: 0, unreadBoundaryAt: at ?? this.now() })
  }

  // ---------------------------------------------------------------------------------- skills
  /** Exactly `botIds` have the skill afterwards (skills.assign; delete passes none). */
  setSkillHolders(name: string, botIds: ReadonlyArray<string>) {
    for (const bot of this.roster.state.bots.values()) {
      const has = (bot.skills ?? []).includes(name as SkillName)
      const wants = botIds.includes(bot.id)
      if (has === wants) continue
      const skills = wants ? [...(bot.skills ?? []), name as SkillName] : (bot.skills ?? []).filter((n) => n !== name)
      this.putBot({ ...bot, skills, updatedAt: this.now() })
    }
  }

  /** A canned skills.sh skill as `skills.preview` shows it. */
  previewSkill(id: string): SkillPreview {
    const canned = SKILLS_SH.find((c) => c.result.id === id)
    if (!canned) throw new NotFound({ entity: "skill", id })
    const md = parseSkillMd(canned.files.find((f) => f.path === "SKILL.md")!.contents)
    const name = md.name ?? canned.result.name
    return {
      id,
      name,
      description: md.description ?? "",
      body: md.body,
      files: canned.files.map((f) => ({ path: f.path, bytes: new TextEncoder().encode(f.contents).byteLength })),
      replaces: this.skills.has(name),
    }
  }

  // -------------------------------------------------------------------------------- handlers
  handlers(): Record<string, (payload: any) => unknown> {
    const sync =
      <A>(f: () => A) =>
      () =>
        Effect.try({ try: f, catch: (e) => e as never })
    const h: Record<string, (p: any) => unknown> = {
      "session.info": () => Effect.succeed({ ownerName: this.settings.ownerName ?? "Alex", version: "0.0.0-dev", dataDir: "(in-memory mock)", firstRun: this.firstRun && this.roster.state.bots.size === 0 }),
      "roster.subscribe": ({ after }) => subscribeTo<KnownRosterStreamItem>(this.roster, after, () => this.roster.snapshot()),
      "conversations.subscribe": ({ conversationId, after }) => {
        const r = this.convs.get(conversationId)
        if (!r) return Stream.fail(new NotFound({ entity: "conversation", id: conversationId }))
        return subscribeTo<KnownConversationStreamItem>(r, after, () => r.snapshot())
      },
      "conversations.history": () => Effect.succeed({ entries: [], hasMoreBefore: false, beforeCursor: null }),
      "conversations.exchange": (p) => sync(() => this.exchange(p))(),
      "bots.create": (p) => sync(() => this.createBot(p))(),
      "bots.update": ({ botId, patch }) =>
        sync(() => {
          const bot = this.bot(botId)
          if (!bot) throw new NotFound({ entity: "bot", id: botId })
          const unknown = (patch.skills as string[] | undefined)?.find((n) => !this.skills.has(n))
          if (unknown) throw new InvalidInput({ message: `There's no skill named "${unknown}" in the library.` })
          const next: Record<string, unknown> = { ...bot, updatedAt: this.now() }
          for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
            if (v === null) delete next[k]
            else if (v !== undefined) next[k] = v
          }
          if (patch.name && patch.name !== bot.name) {
            const at = this.now()
            this.put(this.event(bot.directConversationId, OWNER, { type: "name-changed", to: patch.name }, at))
            this.updateConversation(bot.directConversationId, { title: patch.name })
          }
          return this.putBot(next as unknown as Bot)
        })(),
      "bots.delete": ({ botId }) =>
        sync(() => {
          const bot = this.bot(botId)
          if (!bot) throw new NotFound({ entity: "bot", id: botId })
          this.roster.apply({ type: "bot.removed", botId })
          this.roster.apply({ type: "conversation.removed", conversationId: bot.directConversationId })
          this.convs.delete(bot.directConversationId)
        })(),
      "bots.get": ({ botId }) => (this.bot(botId) ? Effect.succeed(this.bot(botId)) : Effect.fail(new NotFound({ entity: "bot", id: botId }))),
      "bots.readContext": ({ botId }) =>
        sync(() => {
          const bot = this.bot(botId)
          if (!bot) throw new NotFound({ entity: "bot", id: botId })
          const memory = this.memory.get(botId) ?? { index: "", facts: [] }
          return {
            instructions: `# ${bot.name}\n\n${bot.instructions || "(no persona yet)"}\n\n## Team\n${[...this.roster.state.bots.values()].map((b) => `- ${b.name}${b.label ? ` (${b.label})` : ""}`).join("\n")}\n\n## Memory\n${memory.index || "(empty)"}\n\n## Placement\nTools run on This computer.`,
            memory,
          }
        })(),
      "bots.newSession": ({ botId }) =>
        sync(() => {
          const bot = this.bot(botId)
          if (!bot) throw new NotFound({ entity: "bot", id: botId })
          const c = this.conv(bot.directConversationId).conversation
          this.put(this.event(c.id, { kind: "system" }, { type: "session-changed", botId, action: "new-session" }, this.now()))
          this.updateConversation(c.id, { sessions: (c.sessions ?? []).map((s) => (s.botId === botId ? { botId: s.botId, active: false, updatedAt: this.now() } : s)) })
        })(),
      "bots.compact": ({ botId }) =>
        sync(() => {
          const bot = this.bot(botId)
          if (!bot) throw new NotFound({ entity: "bot", id: botId })
          const c = this.conv(bot.directConversationId).conversation
          this.put(this.event(c.id, { kind: "system" }, { type: "session-changed", botId, action: "compacted" }, this.now()))
          this.updateConversation(c.id, { sessions: (c.sessions ?? []).map((s) => (s.botId === botId ? { ...s, contextUsage: { usedTokens: 18_000, windowTokens: s.contextUsage?.windowTokens ?? 200_000 }, updatedAt: this.now() } : s)) })
        })(),
      "sections.list": () => Effect.succeed([...this.roster.state.sections.values()]),
      "sections.create": ({ name }) =>
        sync(() => {
          const section: Section = { id: this.id("sec") as SectionId, name, order: this.roster.state.sections.size + 1 }
          this.putSection(section)
          return section
        })(),
      "sections.rename": ({ sectionId, name }) =>
        sync(() => {
          const s = this.roster.state.sections.get(sectionId)
          if (!s) throw new NotFound({ entity: "section", id: sectionId })
          const next = { ...s, name }
          this.putSection(next)
          return next
        })(),
      "sections.delete": ({ sectionId }) =>
        sync(() => {
          for (const b of this.roster.state.bots.values()) if (b.sectionId === sectionId) this.putBot(Object.fromEntries(Object.entries(b).filter(([k]) => k !== "sectionId")) as unknown as Bot)
          this.roster.apply({ type: "section.removed", sectionId })
        })(),
      "sections.reorder": ({ sectionIds }) =>
        sync(() =>
          (sectionIds as string[]).map((id, i) => {
            const s = this.roster.state.sections.get(id as SectionId)
            if (!s) throw new NotFound({ entity: "section", id })
            const next = { ...s, order: i + 1 }
            this.putSection(next)
            return next
          }),
        )(),
      "conversations.createGroup": (p) => sync(() => this.createGroup(p))(),
      "conversations.setMembers": ({ conversationId, memberBotIds, leadBotId }) =>
        sync(() => {
          const c = this.conv(conversationId).conversation
          if (c.kind !== "group") throw new InvalidInput({ message: "Not a group chat" })
          const at = this.now()
          for (const id of memberBotIds as string[]) if (!c.memberBotIds.includes(id as BotId)) this.put(this.event(conversationId, OWNER, { type: "member-added", botId: id as BotId, name: this.bot(id)?.name ?? "Bot" }, at))
          for (const id of c.memberBotIds) if (!(memberBotIds as string[]).includes(id)) this.put(this.event(conversationId, OWNER, { type: "member-removed", botId: id, name: this.bot(id)?.name ?? "Bot" }, at))
          const next = { ...c, memberBotIds, ...(leadBotId === null ? { leadBotId: undefined } : leadBotId ? { leadBotId } : {}) } as Conversation
          this.updateConversation(conversationId, next)
          return this.conv(conversationId).conversation
        })(),
      "conversations.rename": ({ conversationId, title }) =>
        sync(() => {
          this.put(this.event(conversationId, OWNER, { type: "name-changed", to: title }, this.now()))
          this.updateConversation(conversationId, { title, ...(this.conv(conversationId).conversation.kind === "group" ? { namedBy: "user" } : {}) } as Partial<Conversation>)
          return this.conv(conversationId).conversation
        })(),
      "conversations.markRead": ({ conversationId, unread, at }) => sync(() => this.markRead(conversationId, unread, at))(),
      "conversations.setHidden": ({ conversationId, hidden }) => sync(() => this.updateConversation(conversationId, { hiddenFromSidebar: hidden }))(),
      "conversations.delete": ({ conversationId }) =>
        sync(() => {
          const c = this.conv(conversationId).conversation
          if (c.kind !== "group") throw new InvalidInput({ message: "Only group chats can be deleted." })
          this.roster.apply({ type: "conversation.removed", conversationId })
          this.convs.delete(conversationId)
        })(),
      "messages.send": (input) => sync(() => this.send(input))(),
      "messages.lookupSend": ({ clientNonce }) => {
        const s = this.sends.get(clientNonce)
        return Effect.succeed(s ? { outcome: "found", entryId: s.entryId, delivery: "accepted" } : { outcome: "not-found" })
      },
      "messages.react": ({ conversationId, entryId, emoji }) =>
        sync(() => {
          const e = this.conv(conversationId).state.entries.get(entryId)
          if (!e || e.kind !== "message") throw new NotFound({ entity: "entry", id: entryId })
          const reactions = e.reactions ?? []
          const mine = reactions.findIndex((r) => r.emoji === emoji && r.by.kind === "user")
          this.put({ ...e, reactions: mine >= 0 ? reactions.filter((_, i) => i !== mine) : [...reactions, { emoji, by: OWNER }], updatedAt: this.now() } as Entry)
        })(),
      "turns.interrupt": ({ conversationId, turnId }) => sync(() => this.interrupt(conversationId, turnId))(),
      "turns.retry": ({ conversationId, turnId }) => sync(() => this.retry(conversationId, turnId))(),
      "attachments.upload": ({ name, mime, bytesBase64 }) =>
        sync(() => {
          const bytes = Uint8Array.from(Buffer.from(bytesBase64, "base64"))
          if (bytes.byteLength === 0) throw new InvalidInput({ message: `${name} is empty` })
          const id = this.id("att") as AttachmentId
          this.attachments.set(id, Object.assign({ mime, bytes }, { name }))
          return { id, name, mime, byteSize: bytes.byteLength, url: `/api/attachments/${id}` } satisfies Attachment
        })(),
      "requests.respond": ({ requestId, response }) => sync(() => this.respond(requestId, response))(),
      "requests.listPending": ({ conversationId }) =>
        Effect.succeed([...this.convs.values()].filter((c) => !conversationId || c.conversation.id === conversationId).flatMap((c) => c.requests.filter((q) => q.status === "pending"))),
      "routines.list": ({ botId }) => Effect.succeed([...this.routines.values()].filter((r) => !botId || r.botId === botId)),
      "routines.create": ({ botId, spec }) =>
        sync(() => {
          const bot = this.bot(botId)
          if (!bot) throw new NotFound({ entity: "bot", id: botId })
          const at = this.now()
          const routine: Routine = { id: this.id("rtn") as RoutineId, botId, ...spec, createdAt: at, updatedAt: at, nextRunAt: at + 86_400_000 }
          this.routines.set(routine.id, routine)
          this.put(this.event(bot.directConversationId, OWNER, { type: "routine-changed", action: "created", routineId: routine.id, routineName: routine.name }, at))
          return routine
        })(),
      "routines.update": ({ routineId, spec }) =>
        sync(() => {
          const r = this.routines.get(routineId)
          if (!r) throw new NotFound({ entity: "routine", id: routineId })
          const next = { ...r, ...spec, updatedAt: this.now() }
          this.routines.set(routineId, next)
          return next
        })(),
      "routines.setEnabled": ({ routineId, enabled }) =>
        sync(() => {
          const r = this.routines.get(routineId)
          if (!r) throw new NotFound({ entity: "routine", id: routineId })
          const next = { ...r, enabled, updatedAt: this.now() }
          this.routines.set(routineId, next)
          const bot = this.bot(r.botId)
          if (bot) this.put(this.event(bot.directConversationId, OWNER, { type: "routine-changed", action: enabled ? "enabled" : "disabled", routineId: r.id, routineName: r.name }, this.now()))
          return next
        })(),
      "routines.delete": ({ routineId }) =>
        sync(() => {
          const r = this.routines.get(routineId)
          if (!r) throw new NotFound({ entity: "routine", id: routineId })
          this.routines.delete(routineId)
          const bot = this.bot(r.botId)
          if (bot) this.put(this.event(bot.directConversationId, OWNER, { type: "routine-changed", action: "deleted", routineId: r.id, routineName: r.name }, this.now()))
        })(),
      "routines.runNow": ({ routineId }) =>
        sync(() => {
          const r = this.routines.get(routineId)
          if (!r) throw new NotFound({ entity: "routine", id: routineId })
          const bot = this.bot(r.botId)!
          const at = this.now()
          const run: RoutineRun = { id: this.id("run") as RoutineRunId, routineId: r.id, firedBy: "manual", startedAt: at, status: "running", conversationId: bot.directConversationId }
          this.runs.set(r.id, [run, ...(this.runs.get(r.id) ?? [])].slice(0, 20))
          this.put(this.event(bot.directConversationId, { kind: "system" }, { type: "routine-run", routineId: r.id, routineName: r.name, runId: run.id, status: "running" }, at))
          this.startTurn(bot.directConversationId, bot.id, "routine", async (turn, signal) => {
            await this.steps(turn, [{ name: "Read", toolKind: "file-read", summary: "calendar/today.ics" }], signal)
            const msg = await this.stream(turn, `**${r.name}** · ${new Date().toLocaleDateString("en-US", { weekday: "long" })}\n\n- 2 meetings, first at 10:00\n- 3 emails need a reply\n- Nothing blocked`, signal)
            const done: RoutineRun = { ...run, status: "succeeded", finishedAt: this.now(), turnId: turn.id, summary: preview(msg.text, 140) }
            this.runs.set(r.id, (this.runs.get(r.id) ?? []).map((x) => (x.id === run.id ? done : x)))
            this.routines.set(r.id, { ...r, lastRunAt: this.now(), lastRunStatus: "succeeded" })
          })
          return run
        })(),
      "routines.runs": ({ routineId }) => Effect.succeed(this.runs.get(routineId) ?? []),
      "memory.get": ({ botId }) => Effect.succeed(this.memory.get(botId) ?? { index: "", facts: [] }),
      "memory.putFact": ({ botId, fact }) =>
        sync(() => {
          const m = this.memory.get(botId) ?? { index: "", facts: [] }
          const id = fact.id ?? memoryFactIdFromTitle(fact.title)
          const next = { id, title: fact.title, ...(fact.description ? { description: fact.description } : {}), body: fact.body, updatedAt: this.now() }
          const facts = [...m.facts.filter((f) => f.id !== id), next]
          this.memory.set(botId, { index: facts.map((f) => `- [${f.title}](${f.id}.md)${f.description ? ` — ${f.description}` : ""}`).join("\n"), facts })
          return next
        })(),
      "memory.deleteFact": ({ botId, factId }) =>
        sync(() => {
          const m = this.memory.get(botId) ?? { index: "", facts: [] }
          const facts = m.facts.filter((f) => f.id !== factId)
          this.memory.set(botId, { index: facts.map((f) => `- [${f.title}](${f.id}.md)`).join("\n"), facts })
        })(),
      "memory.setIndex": ({ botId, index }) =>
        sync(() => {
          const m = this.memory.get(botId) ?? { index: "", facts: [] }
          const next = { ...m, index }
          this.memory.set(botId, next)
          return next
        })(),
      "skills.list": () => Effect.succeed([...this.skills.values()]),
      "skills.upsert": (input) =>
        sync(() => {
          // an imported skill keeps its source and other files
          const s: Skill = { ...this.skills.get(input.name), ...input, updatedAt: this.now() }
          this.skills.set(s.name, s)
          return s
        })(),
      "skills.delete": ({ name }) =>
        sync(() => {
          if (!this.skills.delete(name)) throw new NotFound({ entity: "skill", id: name })
          this.setSkillHolders(name, [])
        })(),
      "skills.assign": ({ name, botIds }) =>
        sync(() => {
          if (!this.skills.has(name)) throw new NotFound({ entity: "skill", id: name })
          const missing = (botIds as string[]).find((id) => !this.bot(id))
          if (missing) throw new NotFound({ entity: "bot", id: missing })
          this.setSkillHolders(name, botIds)
        })(),
      // skills.sh (canned, with a little latency); "offline" fails like skills.sh being down
      "skills.search": ({ query }) =>
        Effect.promise(() => sleep(250)).pipe(
          Effect.andThen(() =>
            sync(() => {
              const q = (query as string).trim().toLowerCase()
              if (q === "") throw new InvalidInput({ message: "Type something to search for." })
              if (q.includes("offline")) throw new Unavailable({ message: "skills.sh did not answer (search): fetch failed" })
              return SKILLS_SH.map((c) => c.result).filter((r) => q.split(/\s+/).every((w) => r.id.toLowerCase().includes(w)))
            })(),
          ),
        ),
      "skills.preview": ({ id }) => Effect.promise(() => sleep(400)).pipe(Effect.andThen(() => sync(() => this.previewSkill(id))())),
      "skills.install": ({ id, botIds }) =>
        Effect.promise(() => sleep(400)).pipe(
          Effect.andThen(() =>
            sync(() => {
              const p = this.previewSkill(id)
              const canned = SKILLS_SH.find((c) => c.result.id === id)!
              const skill: Skill = {
                name: p.name as SkillName,
                description: p.description,
                body: p.body,
                updatedAt: this.now(),
                source: { kind: "skills.sh", id, hash: `sha-${id.length}` },
                files: canned.files.map((f) => f.path).filter((f) => f !== "SKILL.md"),
              }
              this.skills.set(skill.name, skill)
              const holders = [...this.roster.state.bots.values()].filter((b) => (b.skills ?? []).includes(skill.name)).map((b) => b.id as string)
              this.setSkillHolders(skill.name, [...new Set([...holders, ...(botIds as string[])])])
              return skill
            })(),
          ),
        ),
      "harnesses.status": () => Effect.succeed(this.harnesses),
      "harnesses.models": ({ kind }) => Effect.succeed(MODELS[kind] ?? []),
      // accounts (profiles) derived from the seeded statuses; add/remove edit `harnesses`
      "harnesses.profiles": ({ kind }) =>
        Effect.succeed(
          this.harnesses
            .filter((h) => kind === undefined || h.kind === kind)
            .map((h) => ({
              id: h.profileId ?? "default",
              kind: h.kind,
              label: h.profileLabel ?? "Default",
              ...(h.configDir ? { configDir: h.configDir } : {}),
              ...((h.profileId ?? "default") === "default" ? { isDefault: true } : {}),
              createdAt: 0,
            })),
        ),
      "harnesses.discover": ({ kind }) =>
        Effect.succeed(kind === "claude" && !this.harnesses.some((h) => h.configDir === "/home/alex/.claude-3") ? [{ kind, configDir: "/home/alex/.claude-3", suggestedLabel: "alex@side.dev (Side)" }] : []),
      "harnesses.addProfile": ({ kind, label, configDir }) =>
        sync(() => {
          const base = this.harnesses.find((h) => h.kind === kind)
          if (!base) throw new InvalidInput({ message: `${kind} supports only its default account for now.` })
          const id = `hpf_${Math.random().toString(36).slice(2, 8)}`
          this.harnesses = [...this.harnesses, { ...base, profileId: id, profileLabel: label || configDir, configDir, auth: { state: "signed-in", label }, account: { email: label } }]
          return { id, kind, label: label || configDir, configDir, createdAt: this.now() }
        })(),
      "harnesses.removeProfile": ({ profileId }) =>
        sync(() => {
          if (profileId === "default") throw new Forbidden({ reason: "The default account cannot be removed." })
          this.harnesses = this.harnesses.filter((h) => h.profileId !== profileId)
        })(),
      "nodes.list": () => Effect.succeed([...this.roster.state.nodes.values()]),
      "nodes.createPairingCode": () => {
        const raw = Array.from({ length: 8 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("")
        const code = `${raw.slice(0, 4)}-${raw.slice(4)}`
        return Effect.succeed({ code, expiresAt: this.now() + 600_000, command: `openbot-node pair ${this.origin} ${code}` })
      },
      "nodes.rename": ({ nodeId, label }) =>
        sync(() => {
          const n = this.roster.state.nodes.get(nodeId)
          if (!n) throw new NotFound({ entity: "node", id: nodeId })
          const next = { ...n, label }
          this.putNode(next)
          return next
        })(),
      "nodes.revoke": ({ nodeId }) =>
        sync(() => {
          if (nodeId === "node_local") throw new InvalidInput({ message: "The local node can't be revoked" })
          this.roster.apply({ type: "node.removed", nodeId })
        })(),
      "nodes.setCapabilities": ({ nodeId, approved }) =>
        sync(() => {
          const n = this.roster.state.nodes.get(nodeId)
          if (!n) throw new NotFound({ entity: "node", id: nodeId })
          const next = { ...n, capabilities: (approved as string[]).filter((c) => n.declaredCapabilities.includes(c)) }
          this.putNode(next)
          return next
        })(),
      "computer.status": ({ botId }) => sync(() => this.computerStatus(botId))(),
      "computer.ensure": ({ botId }) => sync(() => this.computerEnsure(botId))(),
      "computer.lease": ({ botId, take }) => sync(() => this.computerLease(botId, take))(),
      "computer.reset": ({ botId }) => sync(() => this.computerReset(botId))(),
      "slack.status": () => Effect.succeed(this.slack),
      "slack.connect": ({ userToken, appToken }) =>
        sync(() => {
          if (!this.slack.connected && !(userToken ?? "").startsWith("xoxp-")) throw new InvalidInput({ message: "Paste the User OAuth Token: it starts with xoxp-." })
          const events = appToken !== undefined || this.slack.events === "live" ? ("live" as const) : ("off" as const)
          this.slack = { connected: true, team: "Acme", teamUrl: "https://acme.slack.com/", userId: "U_OWNER", userName: this.settings.ownerName ?? "Alex", events }
          return this.slack
        })(),
      "slack.disconnect": () =>
        sync(() => {
          this.slack = { connected: false, events: "off" }
          return this.slack
        })(),
      "slack.sendDraft": ({ entryId, text }) => sync(() => this.answerSlackDraft(entryId, text))(),
      "slack.discardDraft": ({ entryId }) => sync(() => this.answerSlackDraft(entryId, undefined))(),
      "stt.status": () => sync(() => this.advanceSttInstall())(),
      "stt.install": () =>
        sync(() => {
          this.stt = { state: "installing", model: this.stt.model, downloadBytes: STT_DOWNLOAD_BYTES, downloadedBytes: 0 }
          return this.stt
        })(),
      "stt.remove": () =>
        sync(() => {
          this.stt = { state: "absent", model: this.stt.model, downloadBytes: STT_DOWNLOAD_BYTES }
          return this.stt
        })(),
      "stt.open": () =>
        sync(() => {
          if (this.stt.state !== "ready") throw new Unavailable({ message: "Voice input isn't set up on this OpenBot yet." })
          return { sessionId: this.id("dic") }
        })(),
      "stt.append": () =>
        sync(() => {
          if (this.sttFailsAppend) throw new Unavailable({ message: "Voice input could not transcribe; the details are in the brain's log." })
          return { text: "Check the staging deploy" }
        })(),
      "stt.finish": () => Effect.succeed({ text: "Check the staging deploy and tell me if it is green." }),
      "stt.discard": () =>
        sync(() => {
          this.sttDiscards++
        })(),
      "settings.get": () => Effect.succeed(this.settings),
      "settings.update": ({ patch }) =>
        sync(() => {
          const next = applySettingsPatch(this.settings, patch)
          this.roster.apply({ type: "settings.updated", settings: next })
          return next
        })(),
      "rules.list": ({ botId }) => Effect.succeed([...this.rules.values()].filter((r) => !botId || r.botId === botId || r.botId === undefined)),
      "rules.upsert": ({ rule }) =>
        sync(() => {
          const r: ApprovalRule = { ...rule, id: rule.id ?? (this.id("rul") as ApprovalRule["id"]), createdAt: this.rules.get(rule.id)?.createdAt ?? this.now() }
          this.rules.set(r.id, r)
          return r
        })(),
      "rules.delete": ({ ruleId }) => sync(() => void this.rules.delete(ruleId))(),
      "usage.byBot": () => Effect.succeed([...this.usage.values()]),
      // background tasks (D5.7): the offline mock runs none
      "tasks.list": () => Effect.succeed([]),
    }
    for (const tag of OpenBotRpcs.requests.keys()) if (!(tag in h)) h[tag] = () => Effect.die(new Error(`${tag} not implemented in the dev mock`))
    return h
  }
}

const MODELS: Record<string, ModelInfo[]> = {
  claude: [
    { id: "claude-opus-4-1", label: "Opus", efforts: ["low", "medium", "high"] },
    { id: "claude-sonnet-4-5", label: "Sonnet", default: true, efforts: ["low", "medium", "high"] },
    { id: "claude-haiku-4-5", label: "Haiku" },
  ],
  codex: [
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", default: true, efforts: ["low", "medium", "high"] },
    { id: "gpt-5.6-mini", label: "GPT-5.6 mini" },
  ],
  opencode: [{ id: "opencode/mimo-v2.6-flash-free", label: "MiMo Flash (free)", default: true }],
  fake: [{ id: "scripted", label: "Scripted (offline demo)", default: true }],
}

const cannedReply = (text: string, name: string): string => {
  const t = text.toLowerCase()
  if (/today|morning|agenda|needs me/.test(t)) return "Two things need you today:\n\n1. **Deck review** at 2pm, numbers are checked\n2. **Offsite venue**, a yes or no by Friday\n\nEverything else is handled."
  if (/status|update|progress/.test(t)) return `Here's where things stand:\n\n- **Done** → 3 of 5 items\n- **In progress** → the Q3 summary\n- **Blocked** → nothing\n\nI'll post again when the summary is ready.`
  if (/code|script|snippet/.test(t)) return "Here's the script:\n\n```ts\nconst total = rows.reduce((sum, r) => sum + r.amount, 0)\nconsole.log(total.toFixed(2))\n```\n\nRun it with `bun total.ts`."
  return `On it. I checked your notes and the ops folder: two TODOs are open (\`ops/offsite.md\` and \`ops/deck.md\`). I'll handle the catering confirmation and flag the Q3 numbers for you.\n\n— ${name}`
}

const cannedGroupReply = (name: string, text: string): string =>
  `${name} here. ${/launch|release|ship/i.test(text) ? "My side is ready: checks are green and the notes are drafted." : "Noted. I'll pick up anything in my area and report back here."}`

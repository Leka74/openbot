/**
 * BackgroundTasks (docs/decisions.md D5.7): a bot hands long work to a separate, short-lived harness
 * session of its own and stays free to chat.
 *
 * - `start` (the `start_task` tool) records a queued task whose origin is the conversation of the
 *   calling turn and returns at once: the turn that started it ends normally.
 * - Each task runs in its OWN ephemeral session of the bot: same driver/account/model/effort, the
 *   same placement (computer, workspace), autonomy and project folders; its MCP token carries
 *   `taskId` (the gateway then keeps the origin conversation and hides the task tools and the
 *   ask-the-owner tools). Instructions = the bot's instructions + a task section; the first turn's
 *   text is the recent messages of the origin conversation (so the brief can stay short) followed by
 *   the brief. At most `maxPerBot` tasks of one bot run at a time; more wait in line (FIFO).
 * - `update` (the `update_task` tool) passes the bot's follow-up on to running work: steered into
 *   its running turn when the driver can steer, otherwise its session's next turn (the work goes on
 *   with it after the current turn). Never dropped: work that is already over says so. Each update
 *   is one of the task's steps.
 * - Its harness events become the task's STEPS (`TaskRepo.putStep`), never conversation entries:
 *   they are not chat bubbles. Progress (activity label, step count) is published on the roster
 *   (`task.upserted`), throttled; status changes are published at once.
 * - Approvals (native and gateway tools) are evaluated in the origin conversation with the bot's
 *   rules and autonomy; their cards are labelled with the task title and the answer goes back to
 *   the task's session. Auto-decisions go to the task's steps. A task cannot ask the owner.
 * - When a task ends, a `task-result` delivery (`results`, drained by the Orchestrator) brings its
 *   result — or why it failed / that the owner stopped it — to the bot's MAIN session in the origin
 *   conversation (its DM when it left that conversation), so the bot reports in its own words. Work
 *   started on a voice call reports on the call while it lasts (a `voice` delivery: `CallPresence`).
 *   A task the bot stopped itself, or one stopped because its bot / group was deleted, is not reported.
 * - Restart: boot recovery fails queued/running tasks ("interrupted by a restart"); `recover`
 *   publishes them and tells each bot once the drivers are registered.
 *
 * Layer 5b (services.ts): never calls the Orchestrator.
 */
import type {
  Bot,
  BotId,
  ConversationId,
  EntryId,
  HarnessEvent,
  HarnessItem,
  HarnessRequest,
  HarnessRequestResolution,
  KnownConversationEvent,
  KnownTranscriptEntry,
  Task,
  TaskId,
  TaskStoppedBy,
  TranscriptEntry,
  TurnId,
  Usage,
} from "@openbot/contracts"
import {
  DEFAULT_TASKS_PER_BOT,
  InvalidInput,
  isTerminalTaskStatus,
  MAX_TASK_RESTARTS,
  NotFound,
  ROSTER_FINISHED_TASKS,
  TASK_BRIEF_MAX_CHARS,
  TASK_RESULT_MAX_CHARS,
  TASK_TITLE_MAX_CHARS,
} from "@openbot/contracts"
import { Cause, Clock, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Queue, Stream } from "effect"
import type { RenderedInstructions } from "../../ports/Harness.ts"
import { type HarnessSession, HarnessRegistry, sessionKeyOf, taskSessionKeyOf } from "../../ports/Harness.ts"
import { IdGen } from "../../ports/IdGen.ts"
import { McpBindingIssuer, type McpClaims } from "../../ports/Mcp.ts"
import type { BootRecoveryReport } from "../../ports/Persistence.ts"
import { PlacementService } from "../../ports/Placement.ts"
import { inProfile } from "../../ports/Profiles.ts"
import { BotRepo, ConversationRepo, EntryRepo, TaskRepo, TurnRepo } from "../../ports/repos.ts"
import { SkillStore } from "../../ports/stores.ts"
import {
  ApprovalService,
  type ApprovalWorkspace,
  BackgroundTasks,
  CallPresence,
  type DeliveryInput,
  InstructionRenderer,
  LiveHub,
  type ToolContext,
  UsageService,
} from "../../ports/services.ts"
import { ownerOnlySkills } from "./internal/skills.ts"
import { capUtf8, compact, hashText, messageWithAttachments, orDie } from "./internal/util.ts"
import { addUsage, itemFields, type TurnTerminal } from "./TurnIngest.ts"

export interface BackgroundTasksOptions {
  /** Tasks of one bot running at the same time (more wait in line). */
  readonly maxPerBot: number
  /** After asking the harness to stop, wait this long for it to confirm. */
  readonly interruptGrace: Duration.Input
  /** Minimum time between two progress publishes of one task (status changes are immediate). */
  readonly progressThrottle: Duration.Input
}

export const DEFAULT_BACKGROUND_TASKS_OPTIONS: BackgroundTasksOptions = {
  maxPerBot: DEFAULT_TASKS_PER_BOT,
  interruptGrace: Duration.seconds(10),
  progressThrottle: Duration.millis(1_500),
}

/** `tasks.list` default page. */
const LIST_LIMIT = 50
/** Partial output carried into a failure / stop report. */
const PARTIAL_CHARS = 2_000
/** The origin conversation's recent messages a task's first turn opens with: at most this many… */
export const TASK_CONTEXT_MESSAGES = 30
/** …within this many UTF-8 bytes (newest kept)… */
export const TASK_CONTEXT_BYTES = 12 * 1024
/** …each message capped at this many bytes. */
const TASK_CONTEXT_MESSAGE_BYTES = 4 * 1024
/** Entries scanned for those messages (tool calls and events are skipped). */
const TASK_CONTEXT_SCAN = 400

/** A task a restart cut off, back in its own session (model-facing). */
const TASK_RESUME_TEXT =
  "[This work was cut off before you finished: OpenBot restarted. Continue where you left off. A command that was still running was stopped, so check its result or run it again.]"
/** The same, when its session could not be resumed and it starts over. */
const TASK_RESTART_NOTE =
  "[This work was started before and cut off by a restart. Some of it may already be done: check the workspace before redoing anything.]"

// ============================================================================ texts

/**
 * The task section appended to the bot's instructions in the task's own session. States the rules;
 * no example phrases (models repeat them).
 */
export const renderTaskSection = (title: string): string =>
  [
    "## Right now",
    `You are doing one piece of work for yourself: ${JSON.stringify(title)}. The message below opens with the recent messages of the conversation the work was started from, for context, followed by the brief: what to do. Your tools, files and memory are the same as always.`,
    "- Work on it until it is done, then give the result as your final answer. That answer is not posted to anyone: it comes back to you in the conversation the work was started from, and you report to the owner there. Make it complete: findings, answers, decisions, file paths.",
    "- Your final answer ends this work and stops anything still running. Run long commands (renders, builds, installs, test suites) in the foreground and wait for them to finish; never leave a command running in the background and never answer that you are waiting for something. Only give your final answer once everything has finished.",
    "- A message that opens with `[Update to this work]` brings feedback or changes from that conversation while you work: take it into account in the work in progress, changing course where it applies, without starting over unless it requires that.",
    "- To share a file you produced, use `send_file` (it is posted in that conversation) or name its path in your result.",
    "- You cannot ask the owner anything from here, and starting or managing other parallel work is not available here. If you need the owner's input or a decision, finish with what you have and say in your result what you need from them.",
  ].join("\n")

export const withTaskSection = (base: RenderedInstructions, title: string): RenderedInstructions => {
  const text = `${base.text}\n\n${renderTaskSection(title)}`
  return { ...base, text, hash: hashText(text) }
}

const quoted = (title: string) => `"${title.replace(/["\r\n]+/g, " ").trim()}"`

/** One message of the origin conversation as the task reads it. */
export interface ContextMessage {
  /** `You` (the bot itself), `Owner`, or `@Name` (another bot). */
  readonly speaker: string
  readonly text: string
}

/**
 * The first turn of a task: the origin conversation's recent messages (oldest first, compact, with
 * speakers; the newest kept within `TASK_CONTEXT_BYTES`), then the brief, then updates that arrived
 * before it started. Model-facing.
 */
export const renderTaskTurn = (input: {
  /** "your direct chat with the owner", `the group chat "…"`, `the routine run "…"`. */
  readonly where: string
  readonly messages: ReadonlyArray<ContextMessage>
  readonly brief: string
  readonly updates?: ReadonlyArray<string> | undefined
}): string => {
  const lines = input.messages.slice(-TASK_CONTEXT_MESSAGES).map((m) => {
    const text = m.text.trim()
    const capped = capUtf8(text, TASK_CONTEXT_MESSAGE_BYTES)
    return `[${m.speaker}]: ${capped.length < text.length ? `${capped}…` : capped}`
  })
  const kept: Array<string> = []
  let budget = TASK_CONTEXT_BYTES
  for (let i = lines.length - 1; i >= 0; i--) {
    const size = new TextEncoder().encode(lines[i]!).length + 1
    if (size > budget) break
    budget -= size
    kept.unshift(lines[i]!)
  }
  const parts: Array<string> = []
  if (kept.length > 0) {
    parts.push(
      `[Recent messages of ${input.where}, where this work was started (oldest first, for context)]\n${kept.join("\n")}`,
    )
  }
  parts.push(`[The brief]\n${input.brief.trim()}`)
  for (const update of input.updates ?? []) parts.push(renderTaskUpdate(update))
  return parts.join("\n\n")
}

/** A follow-up the bot passes on to running work (`update_task`). Model-facing. */
export const renderTaskUpdate = (message: string, options?: { readonly afterAnswer?: boolean }): string =>
  options?.afterAnswer === true
    ? `[Update to this work]\n${message.trim()}\n\n(Your previous answer has not been used yet. Apply this update, then give your complete final answer again, as it should be now.)`
    : `[Update to this work]\n${message.trim()}`

const capText = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/**
 * What the bot's main session reads when a task ends (a `task-result` delivery). Plain content: the
 * first line names the work, the rest is its result or why it stopped.
 */
export const taskResultText = (task: Task, partial?: string | undefined): string => {
  const head = `[Result of ${quoted(task.title)}]`
  const sofar =
    partial !== undefined && partial.trim() !== ""
      ? `\nWhat it had so far:\n${capText(partial.trim(), PARTIAL_CHARS)}`
      : ""
  switch (task.status) {
    case "succeeded":
      return `${head}\n${task.result !== undefined && task.result.trim() !== "" ? task.result : "(It finished without a written result.)"}`
    case "cancelled":
      return `${head}\nThe owner stopped it before it finished.${sofar}`
    default:
      return `${head}\nIt could not be finished: ${(task.error ?? "unknown error").replace(/\.$/, "")}.${sofar}`
  }
}

// ============================================================================ the task's steps

interface TaskIngest {
  readonly begin: (turnId: TurnId) => Effect.Effect<Deferred.Deferred<TurnTerminal>>
  readonly handle: (event: HarnessEvent) => Effect.Effect<void>
  /** An auto-decided approval (rule / autonomy) of this task: one of its steps. */
  readonly recordDecision: (event: Extract<KnownConversationEvent, { type: "auto-decided" }>) => Effect.Effect<void>
  /** Closes streaming steps when the task ends. */
  readonly finalize: (completed: boolean) => Effect.Effect<void>
  /** Text of the last non-empty bot message so far. */
  readonly lastText: () => string | undefined
  readonly usage: () => Usage | undefined
  readonly stepCount: () => number
}

const TERMINAL_TOOL = new Set(["completed", "failed", "declined", "interrupted"])

const makeTaskIngest = (deps: {
  readonly task: Task
  readonly harness: string
  readonly model: string | undefined
  readonly ids: IdGen["Service"]
  readonly repo: TaskRepo["Service"]
  readonly usage: UsageService["Service"]
  /** Activity label / step count changed. */
  readonly onProgress: (progress: {
    readonly label?: string | undefined
    readonly steps: number
  }) => Effect.Effect<void>
  readonly onClosed: (reason: string) => Effect.Effect<void>
}): Effect.Effect<TaskIngest> =>
  Effect.sync(() => {
    const keys = new Map<string, EntryId>()
    const steps = new Map<EntryId, KnownTranscriptEntry>()
    const texts: Array<{ readonly key: string; text: string }> = []
    const tools = new Set<string>()
    const terminals = new Map<TurnId, Deferred.Deferred<TurnTerminal>>()
    let turnId: TurnId | undefined
    let usage: Usage | undefined
    let label: string | undefined

    const put = (entry: KnownTranscriptEntry) =>
      Effect.gen(function* () {
        steps.set(entry.id, entry)
        yield* orDie(deps.repo.putStep(deps.task.id, entry))
      })

    const upsertItem = (key: string, item: HarnessItem) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const id = keys.get(key) ?? (yield* deps.ids.entryId)
        keys.set(key, id)
        const previous = steps.get(id)
        const entry = compact({
          id,
          conversationId: deps.task.conversationId,
          revision: (previous?.revision ?? -1) + 1,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
          author: { kind: "bot" as const, botId: deps.task.botId },
          turnId,
          harnessRef: { harness: deps.harness, nativeId: key },
          ...itemFields(item, key, now, previous),
        }) as unknown as KnownTranscriptEntry
        yield* put(entry)
        if (item._tag === "Message" && item.role === "bot") {
          const existing = texts.find((t) => t.key === key)
          if (existing === undefined) texts.push({ key, text: item.text })
          else existing.text = item.text
          if (item.streaming && label === undefined) label = "Writing"
        }
        if (item._tag === "ToolCall") {
          tools.add(key)
          if (!TERMINAL_TOOL.has(item.status)) label = item.title ?? item.toolName
        }
        yield* deps.onProgress({ label, steps: tools.size })
      })

    const complete = (id: TurnId, terminal: TurnTerminal) =>
      Effect.suspend(() => {
        const deferred = terminals.get(id)
        return deferred === undefined ? Effect.void : Effect.asVoid(Deferred.succeed(deferred, terminal))
      })

    const handle = (event: HarnessEvent): Effect.Effect<void> => {
      switch (event._tag) {
        case "ItemUpserted":
          return upsertItem(event.key, event.item)
        case "Activity":
          return Effect.suspend(() => {
            label = event.label.replace(/\.\.\.$|…$/, "").trim() || undefined
            return deps.onProgress({ label, steps: tools.size })
          })
        case "Usage":
          return Effect.gen(function* () {
            usage = usage === undefined ? event.usage : addUsage(usage, event.usage)
            yield* deps.usage.record(
              compact({
                botId: deps.task.botId,
                conversationId: deps.task.conversationId,
                harness: deps.harness,
                model: deps.model,
                usage: event.usage,
              }),
            )
          })
        case "TurnCompleted":
          return complete(event.turnId, { _tag: "completed", stopReason: event.stopReason })
        case "TurnFailed":
          return complete(event.turnId, {
            _tag: "failed",
            code: event.error.code,
            message: event.error.message,
            retryable: event.error.retryable,
          })
        case "TurnInterrupted":
          return complete(event.turnId, { _tag: "interrupted" })
        case "SessionClosed":
          return deps.onClosed(event.reason)
        default:
          return Effect.void
      }
    }

    return {
      begin: (id) =>
        Effect.gen(function* () {
          turnId = id
          const deferred = yield* Deferred.make<TurnTerminal>()
          terminals.set(id, deferred)
          return deferred
        }),
      handle: (event) =>
        handle(event).pipe(
          Effect.catchCause((cause) => Effect.logError(`BackgroundTasks: ${event._tag} failed`, cause)),
        ),
      recordDecision: (event) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          yield* put(
            compact({
              id: yield* deps.ids.entryId,
              conversationId: deps.task.conversationId,
              revision: 0,
              createdAt: now,
              updatedAt: now,
              author: { kind: "system" as const },
              turnId,
              kind: "event" as const,
              event,
            }) as KnownTranscriptEntry,
          )
        }),
      finalize: (completed) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          for (const step of [...steps.values()]) {
            let next: KnownTranscriptEntry | undefined
            if ((step.kind === "message" || step.kind === "reasoning") && step.streaming) {
              next =
                step.kind === "message" && !completed
                  ? { ...step, streaming: false, aborted: true }
                  : { ...step, streaming: false }
            } else if (
              step.kind === "tool-call" &&
              (step.status === "pending" || step.status === "running" || step.status === "awaiting-approval")
            ) {
              next = { ...step, status: completed ? "completed" : "interrupted", completedAt: now }
            }
            if (next !== undefined) yield* put({ ...next, revision: step.revision + 1, updatedAt: now })
          }
        }),
      lastText: () => [...texts].reverse().find((t) => t.text.trim() !== "")?.text,
      usage: () => usage,
      stepCount: () => tools.size,
    }
  })

// ============================================================================ the service

interface Stop {
  readonly by: TaskStoppedBy
  readonly reason: string
  /** Do not report it to the bot (it stopped it itself, or its bot / group is being deleted). */
  readonly silent: boolean
}

interface Live {
  task: Task
  readonly stop: Deferred.Deferred<Stop>
  readonly done: Deferred.Deferred<void>
  ingest: TaskIngest | undefined
  workspace: ApprovalWorkspace | undefined
  stopped: Stop | undefined
  publishedAt: number
  flushing: boolean
  /** Updates not delivered yet: they open the task's first turn, or its next one. */
  readonly pending: Array<string>
  /** The task's running turn, while updates can be steered into it (its driver can steer). */
  turn: { readonly session: HarnessSession; readonly turnId: TurnId } | undefined
  /** Its outcome is decided: updates are refused from now on ("already over"). */
  ending: boolean
  /** It had started before a restart cut it off: it resumes its session, or starts over knowing that. */
  readonly restarted: boolean
  /** Its run, while it runs (`handOff` interrupts it). */
  fiber?: Fiber.Fiber<void> | undefined
}

/** How `update` delivered a follow-up. */
export type TaskUpdateDelivery = "steered" | "queued" | "finished"

type Outcome =
  | { readonly _tag: "succeeded"; readonly result: string }
  | { readonly _tag: "failed"; readonly error: string }
  | { readonly _tag: "cancelled"; readonly stop: Stop }

const failed = (error: string): Outcome => ({ _tag: "failed", error })

const makeBackgroundTasks = (options: BackgroundTasksOptions) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const hub = yield* LiveHub
    const approvals = yield* ApprovalService
    const renderer = yield* InstructionRenderer
    const usageService = yield* UsageService
    const registry = yield* HarnessRegistry
    const placement = yield* PlacementService
    const issuer = yield* McpBindingIssuer
    const ids = yield* IdGen
    const bots = yield* BotRepo
    const conversations = yield* ConversationRepo
    const entries = yield* EntryRepo
    const repo = yield* TaskRepo
    const skills = yield* SkillStore
    // voice calls (experiment): work started on a call reports back on it
    const presence = Option.getOrUndefined(yield* Effect.serviceOption(CallPresence))
    const turnRepo = Option.getOrUndefined(yield* Effect.serviceOption(TurnRepo))
    const fromCall = new Set<TaskId>()

    const throttleMs = Duration.toMillis(Duration.fromInputUnsafe(options.progressThrottle))
    const results = yield* Queue.unbounded<DeliveryInput>()
    yield* Effect.addFinalizer(() => Queue.shutdown(results))

    /** Queued and running tasks (the queue is in memory: boot recovery fails them, `recover` reruns them). */
    const lives = new Map<TaskId, Live>()
    /** Deploys (`hold`): queued tasks stay queued. */
    let held = false
    /** `start_task` idempotency: `<botId>:<callId>` → task. */
    const startedBy = new Map<string, TaskId>()

    // ------------------------------------------------------------------ writes

    const publish = (task: Task) => Effect.asVoid(hub.publishRoster({ type: "task.upserted", task }))

    /** Persists and publishes a task (and keeps the live copy in sync). */
    const save = (task: Task) =>
      Effect.gen(function* () {
        const live = lives.get(task.id)
        if (live !== undefined) {
          live.task = task
          live.publishedAt = yield* Clock.currentTimeMillis
        }
        yield* orDie(repo.upsert(task))
        yield* publish(task)
      })

    /** Updates a live task's progress; publishes at most once per throttle window (trailing). */
    const touch = (taskId: TaskId, f: (task: Task) => Task) =>
      Effect.gen(function* () {
        const live = lives.get(taskId)
        if (live === undefined || live.task.status !== "running") return
        const next = f(live.task)
        if (JSON.stringify(next) === JSON.stringify(live.task)) return
        live.task = { ...next, updatedAt: yield* Clock.currentTimeMillis }
        const now = yield* Clock.currentTimeMillis
        if (now - live.publishedAt >= throttleMs) {
          yield* save(live.task)
          return
        }
        if (live.flushing) return
        live.flushing = true
        yield* Effect.forkIn(
          Effect.sleep(Duration.millis(throttleMs - (now - live.publishedAt))).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                live.flushing = false
                return lives.get(taskId) === live && live.task.status === "running" ? save(live.task) : Effect.void
              }),
            ),
          ),
          scope,
          { startImmediately: true },
        )
      })

    const read = (taskId: TaskId) =>
      Effect.gen(function* () {
        const live = lives.get(taskId)
        if (live !== undefined) return live.task
        const stored = yield* orDie(repo.get(taskId))
        if (Option.isNone(stored)) return yield* new NotFound({ entity: "task", id: taskId })
        return stored.value
      })

    const overlay = (tasks: ReadonlyArray<Task>) => tasks.map((t) => lives.get(t.id)?.task ?? t)

    // ------------------------------------------------------------------ reporting

    /** Where a task's result goes: its origin while the bot is still there, else the bot's DM. */
    const reportTo = (task: Task) =>
      Effect.gen(function* () {
        const bot = yield* orDie(bots.get(task.botId))
        if (Option.isNone(bot)) return undefined
        const members = yield* orDie(conversations.members(task.conversationId))
        return members.includes(task.botId) ? task.conversationId : bot.value.directConversationId
      })

    const report = (task: Task, partial: string | undefined) =>
      Effect.gen(function* () {
        const conversationId = yield* reportTo(task)
        if (conversationId === undefined) return
        const onCall = fromCall.delete(task.id) && presence?.onCall(task.botId) === true
        yield* Queue.offer(results, {
          conversationId,
          botId: task.botId,
          kind: "task-result",
          text: taskResultText(task, partial),
          urgency: "urgent",
          taskId: task.id,
          ...(onCall ? { voice: true } : {}),
        })
      })

    // ------------------------------------------------------------------ approvals

    const denyAll: HarnessRequestResolution = { decision: "deny" }

    const approve = (taskId: TaskId, request: HarnessRequest, workspace?: ApprovalWorkspace) =>
      Effect.gen(function* () {
        const live = lives.get(taskId)
        if (live === undefined || live.task.status !== "running") return denyAll
        if (request.kind === "question") {
          return {
            decision: "deny",
            message:
              "You cannot ask the owner from here. Finish with what you have and say in your result what you need from them.",
          } satisfies HarnessRequestResolution
        }
        const found = yield* orDie(bots.get(live.task.botId))
        if (Option.isNone(found)) return denyAll
        const bot = found.value
        const where = workspace ?? live.workspace
        let waited = false
        const resolution = yield* approvals.evaluate(
          {
            bot,
            conversationId: live.task.conversationId,
            harness: bot.harness.kind,
            ...(where === undefined ? {} : { workspace: where }),
            task: { id: taskId, title: live.task.title },
            recordDecision: (event) => (live.ingest === undefined ? Effect.void : live.ingest.recordDecision(event)),
            onPending: (pending) => {
              waited = true
              return Effect.gen(function* () {
                if (lives.get(taskId) !== live) return
                live.task = {
                  ...live.task,
                  waiting: true,
                  progress: `Waiting for you: ${pending.title}`,
                  updatedAt: yield* Clock.currentTimeMillis,
                }
                yield* save(live.task)
              })
            },
          },
          request,
        )
        if (waited && lives.get(taskId) === live && live.task.status === "running") {
          const { waiting: _w, progress: _p, ...rest } = live.task
          live.task = { ...rest, updatedAt: yield* Clock.currentTimeMillis }
          yield* save(live.task)
        }
        return resolution
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("BackgroundTasks: approval failed; denying", cause).pipe(Effect.as(denyAll)),
        ),
      )

    // ------------------------------------------------------------------ the first turn

    /**
     * The task's first turn: the recent messages of its origin conversation (so the bot's brief can
     * stay short), the brief, and updates that arrived while it waited to start.
     */
    const firstTurnText = (task: Task, updates: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const found = yield* orDie(conversations.get(task.conversationId))
        const conversation = Option.getOrUndefined(found)
        const where =
          conversation === undefined || conversation.kind === "direct"
            ? "your direct chat with the owner"
            : conversation.kind === "group"
              ? `the group chat ${quoted(conversation.title)}`
              : `the routine run ${quoted(conversation.title)}`
        const page = yield* orDie(entries.page({ conversationId: task.conversationId, limit: TASK_CONTEXT_SCAN }))
        const names = new Map<BotId, string>()
        const messages: Array<ContextMessage> = []
        for (const entry of page.entries) {
          let text: string
          if (entry.kind === "card" && entry.card.type === "ui") text = entry.card.fallback
          else if (
            entry.kind !== "message" ||
            entry.streaming ||
            (entry.text.trim() === "" && entry.attachments.length === 0)
          )
            continue
          else text = messageWithAttachments(entry.text, entry.attachments)
          let speaker: string
          if (entry.author.kind === "user") speaker = "Owner"
          else if (entry.author.kind !== "bot") continue
          else if (entry.author.botId === task.botId) speaker = "You"
          else {
            const id = entry.author.botId
            if (!names.has(id))
              names.set(
                id,
                Option.match(yield* orDie(bots.get(id)), { onNone: () => "a teammate", onSome: (b) => b.name }),
              )
            speaker = `@${names.get(id)!}`
          }
          messages.push({ speaker, text })
        }
        return renderTaskTurn({ where, messages, brief: task.brief, updates })
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning(
                "BackgroundTasks: could not read the origin conversation; the brief goes alone",
                cause,
              ).pipe(Effect.as(renderTaskTurn({ where: "", messages: [], brief: task.brief, updates }))),
        ),
      )

    // ------------------------------------------------------------------ running one task

    const execute = (live: Live): Effect.Effect<Outcome> =>
      Effect.scoped(
        Effect.gen(function* () {
          const task = live.task
          const found = yield* orDie(bots.get(task.botId))
          if (Option.isNone(found)) return failed("its bot was deleted")
          const bot: Bot = found.value
          const driver = yield* Effect.result(registry.get(bot.harness.kind, bot.harness.profileId))
          if (driver._tag === "Failure") return failed(driver.failure.message)
          const resolved = yield* Effect.result(placement.resolve({ bot, driver: driver.success }))
          if (resolved._tag === "Failure") return failed(resolved.failure.message)
          const where = resolved.success
          live.workspace = { nodeId: where.hostNodeId, path: where.workspacePath }
          const claims: McpClaims = {
            botId: bot.id,
            conversationId: task.conversationId,
            sessionKey: sessionKeyOf(bot.id, task.conversationId),
            toolsets: [...where.toolsets],
            hostNodeId: where.hostNodeId,
            workspacePath: where.workspacePath,
            boundNodeIds: [...bot.boundNodeIds],
            taskId: task.id,
          }
          const binding = yield* issuer.issue(claims)
          const instructions = withTaskSection(yield* renderer.render({ bot, placement: where }), task.title)
          const closed = yield* Deferred.make<string>()
          const ingest = yield* makeTaskIngest({
            task,
            harness: driver.success.kind,
            model: bot.harness.model,
            ids,
            repo,
            usage: usageService,
            onProgress: ({ label, steps }) =>
              touch(task.id, (t) =>
                compact({ ...t, progress: t.waiting === true ? t.progress : label, stepCount: steps }),
              ),
            onClosed: (reason) => Effect.asVoid(Deferred.succeed(closed, reason)),
          })
          live.ingest = ingest
          const ownerOnly = yield* ownerOnlySkills(skills, bot.skills).pipe(inProfile(bot.ownerProfileId))
          const open = (nativeSessionId: string | undefined) =>
            Effect.result(
              driver.success.openSession({
                purpose: "task",
                bot,
                ownerOnlySkills: ownerOnly,
                conversationId: task.conversationId,
                sessionKey: taskSessionKeyOf(bot.id, task.id),
                nativeSessionId,
                placement: where,
                instructions,
                mcp: [binding],
                model: bot.harness.model,
                effort: bot.harness.effort,
                onRequest: (request) =>
                  approve(task.id, request, { nodeId: where.hostNodeId, path: where.workspacePath }),
              }),
            )
          // Cut off by a restart: its own session again when the harness can resume it.
          const resumeId = live.restarted ? task.nativeSessionId : undefined
          let opened = yield* open(resumeId)
          const resumed = resumeId !== undefined && opened._tag === "Success"
          if (opened._tag === "Failure" && resumeId !== undefined) {
            yield* Effect.logWarning(
              `BackgroundTasks: could not resume task ${task.id}; starting it over`,
              opened.failure,
            )
            opened = yield* open(undefined)
          }
          if (opened._tag === "Failure") return failed(`could not start: ${opened.failure.message}`)
          const session = opened.success
          /** Saved at once (not throttled): a crash right after must still find it. */
          const remember = (event: HarnessEvent) =>
            event._tag !== "SessionBound" || live.task.nativeSessionId === event.nativeSessionId
              ? Effect.void
              : save({ ...live.task, nativeSessionId: event.nativeSessionId })
          yield* Effect.forkScoped(
            Stream.runForEach(session.events, (event) => Effect.andThen(remember(event), ingest.handle(event))).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.logError("BackgroundTasks: event stream failed", cause),
              ),
              Effect.ensuring(Deferred.succeed(closed, "the harness event stream ended")),
            ),
            { startImmediately: true },
          )
          const steerable = driver.success.capabilities.steer
          // The first turn: the origin conversation's recent messages, the brief, early updates.
          let text = resumed
            ? TASK_RESUME_TEXT
            : live.restarted
              ? `${yield* firstTurnText(task, live.pending.splice(0))}\n\n${TASK_RESTART_NOTE}`
              : yield* firstTurnText(task, live.pending.splice(0))
          type Ended =
            | { readonly kind: "terminal"; readonly terminal: TurnTerminal }
            | { readonly kind: "closed"; readonly reason: string }
            | { readonly kind: "stop"; readonly stop: Stop }
          for (;;) {
            const turnId = yield* ids.turnId
            const terminal = yield* ingest.begin(turnId)
            if (live.stopped !== undefined) return { _tag: "cancelled", stop: live.stopped } satisfies Outcome
            const started = yield* Effect.result(
              session.startTurn({ turnId, conversationId: task.conversationId, text, attachments: [] }),
            )
            if (started._tag === "Failure") return failed(started.failure.message)
            if (steerable) live.turn = { session, turnId }
            const ended = yield* Effect.raceAllFirst([
              Effect.map(Deferred.await(terminal), (t): Ended => ({ kind: "terminal", terminal: t })),
              Effect.map(Deferred.await(closed), (reason): Ended => ({ kind: "closed", reason })),
              Effect.map(Deferred.await(live.stop), (stop): Ended => ({ kind: "stop", stop })),
            ])
            // From here on, until the next turn starts, updates wait in `pending` (synchronously:
            // an update either landed in the turn that just ended or is picked up below).
            live.turn = undefined
            if (ended.kind === "stop") {
              live.ending = true
              yield* session.interrupt.pipe(
                Effect.timeoutOption(Duration.seconds(5)),
                Effect.catchCause(() => Effect.void),
              )
              yield* Deferred.await(terminal).pipe(Effect.timeoutOption(options.interruptGrace))
              return { _tag: "cancelled", stop: ended.stop } satisfies Outcome
            }
            if (ended.kind === "closed") return failed(`the session closed: ${ended.reason}`)
            switch (ended.terminal._tag) {
              case "completed": {
                // Updates that arrived during that turn: the work goes on with them in its next turn.
                const updates = live.pending.splice(0)
                if (updates.length > 0) {
                  text = updates.map((u) => renderTaskUpdate(u, { afterAnswer: true })).join("\n\n")
                  continue
                }
                live.ending = true
                return { _tag: "succeeded", result: ingest.lastText() ?? "" } satisfies Outcome
              }
              case "failed":
                return failed(ended.terminal.message)
              case "interrupted":
                return failed("it was cut off")
            }
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              live.ending = true
              live.turn = undefined
            }),
          ),
        ),
      )

    /** Records how a task ended, reports it to the bot unless silent, and frees its slot. */
    const finish = (live: Live, outcome: Outcome) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const ingest = live.ingest
        if (ingest !== undefined) yield* ingest.finalize(outcome._tag === "succeeded")
        const usage = ingest?.usage()
        const { progress: _p, waiting: _w, ...base } = live.task
        const task: Task = compact({
          ...base,
          status: outcome._tag,
          endedAt: now,
          updatedAt: now,
          result: outcome._tag === "succeeded" ? capText(outcome.result, TASK_RESULT_MAX_CHARS) : undefined,
          error:
            outcome._tag === "failed" ? outcome.error : outcome._tag === "cancelled" ? outcome.stop.reason : undefined,
          stoppedBy: outcome._tag === "cancelled" ? outcome.stop.by : undefined,
          usage: usage ?? base.usage,
          stepCount: ingest?.stepCount() ?? base.stepCount,
        })
        lives.delete(task.id)
        yield* orDie(repo.upsert(task))
        yield* publish(task)
        yield* approvals.cancelPending({ botId: task.botId, taskId: task.id, reason: "task-ended" })
        const silent = outcome._tag === "cancelled" && outcome.stop.silent
        if (!silent) yield* report(task, outcome._tag === "succeeded" ? undefined : ingest?.lastText())
        yield* Deferred.succeed(live.done, undefined)
      })

    const runTask = (live: Live) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* save({ ...live.task, status: "running", startedAt: now, updatedAt: now })
        const exit = yield* Effect.exit(execute(live))
        if (Exit.isFailure(exit)) {
          // Interrupted = the brain is shutting down: boot recovery fails the task next time.
          if (Cause.hasInterruptsOnly(exit.cause)) return
          yield* Effect.logError(`BackgroundTasks: task ${live.task.id} crashed`, exit.cause)
          yield* finish(live, failed("internal error"))
          return
        }
        yield* finish(live, exit.value)
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("BackgroundTasks: finishing a task failed", cause),
        ),
        Effect.ensuring(
          Effect.suspend(() => {
            if (lives.get(live.task.id) === live) lives.delete(live.task.id)
            return Effect.andThen(Deferred.succeed(live.done, undefined), pump(live.task.botId))
          }),
        ),
      )

    /** Starts the bot's oldest queued tasks while fewer than `maxPerBot` run. */
    const pump = (botId: BotId): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (;;) {
          if (held) return
          const mine = [...lives.values()].filter((l) => l.task.botId === botId)
          if (mine.filter((l) => l.task.status === "running").length >= options.maxPerBot) return
          const next = mine
            .filter((l) => l.task.status === "queued" && l.stopped === undefined)
            .sort((a, b) => a.task.createdAt - b.task.createdAt || (a.task.id < b.task.id ? -1 : 1))[0]
          if (next === undefined) return
          // claimed synchronously: the next loop iteration sees it running
          next.task = { ...next.task, status: "running" }
          next.fiber = yield* Effect.forkIn(runTask(next), scope, { startImmediately: true })
        }
      })

    // ------------------------------------------------------------------ API

    const start = Effect.fn("BackgroundTasks.start")(function* (
      ctx: ToolContext,
      input: { readonly title: string; readonly brief: string },
    ) {
      if (ctx.taskId !== undefined) {
        return yield* new InvalidInput({
          message: "Starting more parallel work is not available here; do it yourself as part of this work.",
        })
      }
      const title = input.title.replace(/\s+/g, " ").trim()
      const brief = input.brief.trim()
      if (title === "") return yield* new InvalidInput({ message: "Give the work a short title." })
      if (title.length > TASK_TITLE_MAX_CHARS) {
        return yield* new InvalidInput({
          message: `The title is longer than ${TASK_TITLE_MAX_CHARS} characters; shorten it.`,
        })
      }
      if (brief === "")
        return yield* new InvalidInput({ message: "Write the brief: what to do and what result to bring back." })
      if (brief.length > TASK_BRIEF_MAX_CHARS) {
        return yield* new InvalidInput({
          message: `The brief is longer than ${TASK_BRIEF_MAX_CHARS} characters; shorten it or put details in a file and name its path.`,
        })
      }
      const key = ctx.callId === undefined ? undefined : `${ctx.claims.botId}:${ctx.callId}`
      const again = key === undefined ? undefined : startedBy.get(key)
      if (again !== undefined) return yield* read(again)
      const found = yield* orDie(bots.get(ctx.claims.botId))
      if (Option.isNone(found)) return yield* new NotFound({ entity: "bot", id: ctx.claims.botId })
      const now = yield* Clock.currentTimeMillis
      const task: Task = {
        id: yield* ids.taskId,
        botId: found.value.id,
        conversationId: ctx.claims.conversationId,
        title,
        brief,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      }
      if (key !== undefined) {
        startedBy.set(key, task.id)
        if (startedBy.size > 1_000) startedBy.delete(startedBy.keys().next().value!)
      }
      // started from a voice call's turn: it reports back on the call (if it is still on)
      if (ctx.turnId !== undefined && turnRepo !== undefined) {
        const turn = yield* turnRepo.get(ctx.turnId).pipe(Effect.orElseSucceed(() => Option.none()))
        if (Option.isSome(turn) && turn.value.voice === true) fromCall.add(task.id)
      }
      lives.set(task.id, {
        task,
        stop: yield* Deferred.make<Stop>(),
        done: yield* Deferred.make<void>(),
        ingest: undefined,
        workspace: undefined,
        stopped: undefined,
        publishedAt: now,
        flushing: false,
        pending: [],
        turn: undefined,
        ending: false,
        restarted: false,
      })
      yield* orDie(repo.upsert(task))
      yield* publish(task)
      yield* pump(task.botId)
      return lives.get(task.id)?.task ?? task
    })

    /** Stops one task; waits (bounded) until a running one has ended. */
    const stopTask = (taskId: TaskId, stop: Stop) =>
      Effect.gen(function* () {
        const live = lives.get(taskId)
        if (live === undefined) return yield* read(taskId)
        if (live.stopped === undefined) live.stopped = stop
        if (live.ingest === undefined && live.task.status === "queued") {
          // never started: nothing to interrupt
          yield* finish(live, { _tag: "cancelled", stop: live.stopped })
          return yield* read(taskId)
        }
        yield* Deferred.succeed(live.stop, live.stopped)
        yield* Deferred.await(live.done).pipe(
          Effect.timeoutOption(Duration.sum(Duration.fromInputUnsafe(options.interruptGrace), Duration.seconds(6))),
        )
        return yield* read(taskId)
      })

    const cancel = Effect.fn("BackgroundTasks.cancel")(function* (taskId: TaskId, by: TaskStoppedBy) {
      const task = yield* read(taskId)
      if (isTerminalTaskStatus(task.status)) return task
      return yield* stopTask(taskId, {
        by,
        reason: by === "owner" ? "stopped by the owner" : by === "bot" ? "stopped" : "stopped",
        silent: by !== "owner",
      })
    })

    /** One update as a step of the task (the Tasks tab shows it among the steps). */
    const recordUpdate = (task: Task, message: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* orDie(
          repo.putStep(task.id, {
            id: yield* ids.entryId,
            conversationId: task.conversationId,
            revision: 0,
            createdAt: now,
            updatedAt: now,
            author: { kind: "bot", botId: task.botId },
            kind: "message",
            role: "user",
            text: message,
            attachments: [],
            streaming: false,
          }),
        )
      })

    const update = Effect.fn("BackgroundTasks.update")(function* (
      ctx: ToolContext,
      input: { readonly taskId: TaskId; readonly message: string },
    ) {
      if (ctx.taskId !== undefined) {
        return yield* new InvalidInput({ message: "Passing updates to parallel work is not available here." })
      }
      const message = input.message.trim()
      if (message === "")
        return yield* new InvalidInput({ message: "Write the update: what to change or take into account." })
      if (message.length > TASK_BRIEF_MAX_CHARS) {
        return yield* new InvalidInput({
          message: `The update is longer than ${TASK_BRIEF_MAX_CHARS} characters; shorten it or put details in a file and name its path.`,
        })
      }
      const task = yield* read(input.taskId)
      if (task.botId !== ctx.claims.botId) return yield* new NotFound({ entity: "task", id: input.taskId })
      const live = lives.get(task.id)
      const over = (current: Task) => ({ task: current, delivery: "finished" as TaskUpdateDelivery })
      if (live === undefined || live.ending || live.stopped !== undefined || isTerminalTaskStatus(live.task.status))
        return over(yield* read(task.id))
      const at = live.turn
      if (at !== undefined) {
        const steered = yield* Effect.result(
          at.session.steer({
            turnId: at.turnId,
            conversationId: live.task.conversationId,
            text: renderTaskUpdate(message),
            attachments: [],
          }),
        )
        if (steered._tag === "Success") {
          yield* recordUpdate(live.task, message)
          yield* save({ ...live.task, updatedAt: yield* Clock.currentTimeMillis })
          return { task: live.task, delivery: "steered" as TaskUpdateDelivery }
        }
        yield* Effect.logWarning(
          `BackgroundTasks: steering an update into ${task.id} failed; it waits for the next turn`,
          steered.failure,
        )
      }
      // (synchronous from the check to the push: the run loop reads `pending` when a turn ends)
      if (live.ending || lives.get(task.id) !== live) return over(yield* read(task.id))
      live.pending.push(message)
      yield* recordUpdate(live.task, message)
      if (live.task.status === "running") yield* save({ ...live.task, updatedAt: yield* Clock.currentTimeMillis })
      return { task: live.task, delivery: "queued" as TaskUpdateDelivery }
    })

    const list = (input: { readonly botId: BotId; readonly limit?: number | undefined }) =>
      Effect.map(orDie(repo.list({ botId: input.botId, limit: input.limit ?? LIST_LIMIT })), overlay)

    const find = Effect.fn("BackgroundTasks.find")(function* (botId: BotId, ref: string) {
      const want = ref.trim()
      const all = overlay(yield* orDie(repo.list({ botId, limit: 200 })))
      const byId = all.find((t) => t.id === want)
      if (byId !== undefined) return byId
      const key = want
        .replace(/^["“”']+|["“”']+$/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
      const rank = (t: Task) => (isTerminalTaskStatus(t.status) ? 1 : 0)
      const ordered = [...all].sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt)
      const exact = ordered.find((t) => t.title.toLowerCase() === key)
      if (exact !== undefined) return exact
      const partial = ordered.filter((t) => key !== "" && t.title.toLowerCase().includes(key))
      const active = partial.filter((t) => !isTerminalTaskStatus(t.status))
      if (active.length === 1) return active[0]!
      if (partial.length === 1) return partial[0]!
      return yield* new NotFound({ entity: "task", id: want })
    })

    const get = Effect.fn("BackgroundTasks.get")(function* (taskId: TaskId) {
      const task = yield* read(taskId)
      const steps: ReadonlyArray<TranscriptEntry> = yield* orDie(repo.steps(taskId))
      return { task, steps }
    })

    const removeBot = (botId: BotId) =>
      Effect.gen(function* () {
        const mine = [...lives.values()].filter((l) => l.task.botId === botId)
        yield* Effect.forEach(
          mine,
          (l) => stopTask(l.task.id, { by: "system", reason: "its bot was deleted", silent: true }),
          {
            concurrency: "unbounded",
            discard: true,
          },
        )
        for (const task of yield* orDie(repo.list({ botId }))) yield* orDie(repo.delete(task.id))
      }).pipe(Effect.catchCause((cause) => Effect.logError("BackgroundTasks.removeBot failed", cause)))

    const cancelForConversation = (conversationId: ConversationId) =>
      Effect.forEach(
        [...lives.values()].filter((l) => l.task.conversationId === conversationId),
        (l) => stopTask(l.task.id, { by: "system", reason: "its conversation was deleted", silent: true }),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.catchCause((cause) => Effect.logError("BackgroundTasks.cancelForConversation failed", cause)))

    /** Runs a task a restart cut off again, under its id (`restarts` + 1). */
    const restart = (task: Task) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const next = compact<Task>({
          ...task,
          status: "queued",
          error: undefined,
          endedAt: undefined,
          restarts: (task.restarts ?? 0) + 1,
          updatedAt: now,
        })
        lives.set(task.id, {
          task: next,
          stop: yield* Deferred.make<Stop>(),
          done: yield* Deferred.make<void>(),
          ingest: undefined,
          workspace: undefined,
          stopped: undefined,
          publishedAt: now,
          flushing: false,
          pending: [],
          turn: undefined,
          ending: false,
          restarted: task.startedAt !== undefined,
        })
        yield* orDie(repo.upsert(next))
        yield* publish(next)
        yield* pump(task.botId)
      })

    const recover = (bootReport: BootRecoveryReport) =>
      Effect.forEach(
        bootReport.interruptedTasks,
        (task) =>
          Effect.gen(function* () {
            const bot = yield* orDie(bots.get(task.botId))
            if (Option.isSome(bot) && (task.restarts ?? 0) < MAX_TASK_RESTARTS) return yield* restart(task)
            yield* publish(task)
            const steps = yield* orDie(repo.steps(task.id))
            const last = [...steps]
              .reverse()
              .find(
                (s): s is Extract<TranscriptEntry, { kind: "message" }> =>
                  s.kind === "message" && s.role === "bot" && s.text.trim() !== "",
              )
            yield* report(task, last?.text)
          }),
        { discard: true },
      ).pipe(Effect.catchCause((cause) => Effect.logError("BackgroundTasks.recover failed", cause)))

    // Running tasks stop with the layer (shutdown): boot recovery reports them next time.
    yield* Effect.addFinalizer(() => Effect.sync(() => lives.clear()))

    /**
     * The brain is stopping: running tasks are interrupted now, before the harness drivers close
     * (a Codex task's app-server belongs to its driver: closing it first would end the task as
     * failed). Interrupted, they stay `running`; the next boot runs them again (`recover`).
     */
    const handOff = Effect.gen(function* () {
      held = true
      const running = [...lives.values()].flatMap((l) =>
        l.task.status === "running" && l.fiber !== undefined ? [l.fiber] : [],
      )
      if (running.length > 0) yield* Effect.logInfo("handing running tasks to the next boot", { tasks: running.length })
      yield* Fiber.interruptAll(running)
    })

    return BackgroundTasks.of({
      hold: Effect.sync(() => {
        held = true
      }),
      handOff,
      running: Effect.sync(() => [...lives.values()].filter((l) => l.task.status === "running").length),
      start,
      list,
      get,
      find,
      cancel,
      update,
      removeBot,
      cancelForConversation,
      approve: (taskId, request, workspace) => approve(taskId, request, workspace),
      results: Stream.fromQueue(results),
      recover,
    })
  })

/** The roster snapshot's tasks: every active task plus each bot's most recent finished ones. */
export const rosterTasks = (repo: TaskRepo["Service"]) =>
  Effect.gen(function* () {
    const active = yield* repo.list({ statuses: ["queued", "running"] })
    const finished = yield* repo.list({ statuses: ["succeeded", "failed", "cancelled"], limit: 500 })
    const perBot = new Map<BotId, number>()
    const recent = finished.filter((t) => {
      const n = perBot.get(t.botId) ?? 0
      perBot.set(t.botId, n + 1)
      return n < ROSTER_FINISHED_TASKS
    })
    return [...active, ...recent]
  })

/** The BackgroundTasks layer with custom options (tests); `BackgroundTasksLive` uses the defaults. */
export const makeBackgroundTasksLayer = (
  options?: Partial<BackgroundTasksOptions>,
): Layer.Layer<
  BackgroundTasks,
  never,
  | LiveHub
  | ApprovalService
  | InstructionRenderer
  | UsageService
  | HarnessRegistry
  | PlacementService
  | McpBindingIssuer
  | IdGen
  | BotRepo
  | ConversationRepo
  | EntryRepo
  | TaskRepo
  | SkillStore
> => Layer.effect(BackgroundTasks, makeBackgroundTasks({ ...DEFAULT_BACKGROUND_TASKS_OPTIONS, ...options }))

export const BackgroundTasksLive = makeBackgroundTasksLayer()

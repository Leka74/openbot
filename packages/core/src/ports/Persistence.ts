/**
 * Persistence-facing ports (architecture §3.2, §4.4, D2.5).
 *
 * - `RepositoryPorts`: every repository/store tag. `@openbot/persistence` provides all of them with
 *   one layer (`PersistenceLive(dataDir)`); `@openbot/core/testing` mirrors it with
 *   `MemoryPersistence`.
 * - `BootRecovery`: the boot-time recovery step (§4.4 `Persistence.boot`). Its domain rules live
 *   here (`runBootRecovery`) so every implementation agrees; only killing process groups is
 *   platform-specific and injected.
 *
 * Boot order (apps/server): migrations → `BootRecovery.run` → `Orchestrator.recover(report)` (which
 * publishes the report's changes through LiveHub so resumed client cursors stay consistent).
 */
import type { RoutineRun, RuntimeRequest, Task, TranscriptEntry, Turn } from "@openbot/contracts"
import { Clock, Context, Effect, Option } from "effect"
import type { RepoError } from "./errors.ts"
import { McpTokenRepo } from "./Mcp.ts"
import { ProcessLedger, type ProcessRecord } from "./ProcessLedger.ts"
import {
  type ApprovalRuleRepo,
  type BotRepo,
  type ConversationRepo,
  EntryRepo,
  type NodeRepo,
  type ReplicaLog,
  RequestRepo,
  RoutineRepo,
  type SearchRepo,
  type SectionRepo,
  type SettingsRepo,
  TaskRepo,
  TurnRepo,
  type UsageRepo,
} from "./repos.ts"
import type { AttachmentStore, CarryoverStore, MemoryStore, SkillStore } from "./stores.ts"

/** Every repository and store port (what `PersistenceLive(dataDir)` provides). */
export type RepositoryPorts =
  | BotRepo
  | SectionRepo
  | ConversationRepo
  | EntryRepo
  | SearchRepo
  | RequestRepo
  | TurnRepo
  | TaskRepo
  | RoutineRepo
  | NodeRepo
  | ApprovalRuleRepo
  | SettingsRepo
  | UsageRepo
  | ReplicaLog
  | McpTokenRepo
  | ProcessLedger
  | MemoryStore
  | SkillStore
  | AttachmentStore
  | CarryoverStore

/** What boot recovery changed; `Orchestrator.recover` publishes the entity changes. */
export interface BootRecoveryReport {
  /** Ledger records whose process group was signalled (then the ledger is cleared). */
  readonly killedProcesses: ReadonlyArray<ProcessRecord>
  /** Turns that were queued | running | waiting, now `interrupted` (stopReason "brain-restart"). */
  readonly interruptedTurns: ReadonlyArray<Turn>
  /** The ones of them that were running | waiting: cut off mid-reply (`Orchestrator.resume` continues them). */
  readonly cutOffTurns: ReadonlyArray<Turn>
  /** Requests that were pending, now `expired` with statusReason "not_resumable". */
  readonly expiredRequests: ReadonlyArray<RuntimeRequest>
  /**
   * Entries rewritten (revision + 1): streaming messages/reasoning of interrupted turns finalized
   * (messages `aborted`), unfinished tool calls `interrupted`, pending cards of expired requests `expired`.
   */
  readonly updatedEntries: ReadonlyArray<TranscriptEntry>
  /** Routine runs that were `running`, now `interrupted` (their routine's `lastRunStatus` too). */
  readonly interruptedRuns: ReadonlyArray<RoutineRun>
  /**
   * Background tasks that were queued | running, now `failed` with `TASK_RESTART_ERROR` (D5.7).
   * `BackgroundTasks.recover` publishes them and tells each bot once the drivers are up.
   */
  readonly interruptedTasks: ReadonlyArray<Task>
}

export class BootRecovery extends Context.Service<BootRecovery, {
  /** Runs once at boot, before any runner or listener starts. Also revokes every MCP token. */
  readonly run: Effect.Effect<BootRecoveryReport, RepoError>
}>()("openbot/core/BootRecovery") {}

export const BOOT_RECOVERY_STOP_REASON = "brain-restart"
export const BOOT_RECOVERY_REQUEST_REASON = "not_resumable"
/** The error of a task the restart cut off (D5.7). */
export const TASK_RESTART_ERROR = "interrupted by a restart"

const UNFINISHED_TOOL_STATUSES: ReadonlyArray<string> = ["pending", "awaiting-approval", "running"]

/**
 * The D2.5 / §4.4 recovery rules over the repository ports:
 * 1. signal every process group in `ProcessLedger` (via `killProcessGroup`), then clear the ledger;
 * 2. every active turn → `interrupted`; finalize its streaming entries and unfinished tool calls;
 * 3. every pending request → `expired` (`not_resumable`) and its pending card → `expired`;
 * 4. every running routine run → `interrupted`;
 * 5. every queued / running background task → `failed` ("interrupted by a restart"), its unfinished
 *    steps finalized;
 * 6. revoke every MCP token (no harness session survives a restart).
 */
export const runBootRecovery = (options: {
  /** Kills the record's process group; returns true when a signal was delivered. Never fails. */
  readonly killProcessGroup: (record: ProcessRecord) => Effect.Effect<boolean>
}): Effect.Effect<
  BootRecoveryReport,
  RepoError,
  ProcessLedger | TurnRepo | EntryRepo | RequestRepo | RoutineRepo | TaskRepo | McpTokenRepo
> =>
  Effect.gen(function*() {
    const ledger = yield* ProcessLedger
    const turns = yield* TurnRepo
    const entries = yield* EntryRepo
    const requests = yield* RequestRepo
    const routines = yield* RoutineRepo
    const tasks = yield* TaskRepo
    const tokens = yield* McpTokenRepo
    const now = yield* Clock.currentTimeMillis

    // 1. leftover child processes
    const killedProcesses: Array<ProcessRecord> = []
    for (const record of yield* ledger.list) {
      if (yield* options.killProcessGroup(record)) killedProcesses.push(record)
    }
    yield* ledger.clear

    const updatedEntries: Array<TranscriptEntry> = []
    const rewrite = Effect.fn("BootRecovery.rewrite")(function*(entry: TranscriptEntry) {
      if (entry.kind === "unknown") return
      let next: TranscriptEntry | undefined
      if (entry.kind === "message" && entry.streaming) {
        next = { ...entry, streaming: false, ...(entry.role === "bot" ? { aborted: true } : {}) }
      } else if (entry.kind === "reasoning" && entry.streaming) {
        next = { ...entry, streaming: false }
      } else if (entry.kind === "tool-call" && UNFINISHED_TOOL_STATUSES.includes(entry.status)) {
        next = { ...entry, status: "interrupted", completedAt: now }
      }
      if (next === undefined || next.kind === "unknown") return
      const outcome = yield* entries.upsert({ ...next, revision: entry.revision + 1, updatedAt: now })
      if (outcome.applied) updatedEntries.push(outcome.value)
    })

    // 2. in-flight turns
    const interruptedTurns: Array<Turn> = []
    const cutOffTurns: Array<Turn> = []
    for (const turn of yield* turns.listActive) {
      const next: Turn = { ...turn, status: "interrupted", endedAt: now, stopReason: BOOT_RECOVERY_STOP_REASON }
      yield* turns.upsert(next)
      interruptedTurns.push(next)
      if (turn.status !== "queued") cutOffTurns.push(next)
      for (const entry of yield* entries.listByTurn(turn.id)) yield* rewrite(entry)
    }

    // 3. pending requests and their cards
    const expiredRequests: Array<RuntimeRequest> = []
    for (const request of yield* requests.list({ statuses: ["pending"] })) {
      const next: RuntimeRequest = {
        ...request,
        status: "expired",
        statusReason: BOOT_RECOVERY_REQUEST_REASON,
        resolvedAt: now,
      }
      yield* requests.upsert(next)
      expiredRequests.push(next)
      const card = yield* entries.get(request.cardEntryId)
      if (Option.isSome(card) && card.value.kind === "card" && card.value.state.status === "pending") {
        const outcome = yield* entries.upsert({
          ...card.value,
          state: { ...card.value.state, status: "expired" },
          revision: card.value.revision + 1,
          updatedAt: now,
        })
        if (outcome.applied) updatedEntries.push(outcome.value)
      }
    }

    // 4. routine runs
    const interruptedRuns: Array<RoutineRun> = []
    for (const routine of yield* routines.list()) {
      let touched = false
      for (const run of yield* routines.listRuns(routine.id)) {
        if (run.status !== "running") continue
        const next: RoutineRun = { ...run, status: "interrupted", finishedAt: now }
        yield* routines.upsertRun(next)
        interruptedRuns.push(next)
        touched = true
      }
      if (touched) yield* routines.upsert({ ...routine, lastRunStatus: "interrupted", updatedAt: now })
    }

    // 5. background tasks
    const interruptedTasks: Array<Task> = []
    for (const task of yield* tasks.list({ statuses: ["queued", "running"] })) {
      const { progress: _progress, waiting: _waiting, ...rest } = task
      const next: Task = { ...rest, status: "failed", error: TASK_RESTART_ERROR, endedAt: now, updatedAt: now }
      yield* tasks.upsert(next)
      interruptedTasks.push(next)
      for (const step of yield* tasks.steps(task.id)) {
        if (step.kind === "unknown") continue
        let done: TranscriptEntry | undefined
        if ((step.kind === "message" || step.kind === "reasoning") && step.streaming) done = { ...step, streaming: false }
        else if (step.kind === "tool-call" && UNFINISHED_TOOL_STATUSES.includes(step.status)) {
          done = { ...step, status: "interrupted", completedAt: now }
        }
        if (done !== undefined && done.kind !== "unknown") {
          yield* tasks.putStep(task.id, { ...done, revision: step.revision + 1, updatedAt: now })
        }
      }
    }

    // 6. MCP tokens
    yield* tokens.revokeAll()

    return { killedProcesses, interruptedTurns, cutOffTurns, expiredRequests, updatedEntries, interruptedRuns, interruptedTasks }
  })

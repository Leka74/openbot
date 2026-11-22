/**
 * `HarnessSession` over one long-lived Claude Agent SDK `query()` in streaming-input mode
 * (architecture §4.5 Claude; D2.1; sdk-claude.md §4, §12, §21).
 *
 * Lifetime = the caller's `Scope`:
 * - open: create the workspace, spawn the CLI (`query`), register the OpenBot MCP server with
 *   `setMcpServers` (headers travel over stdin, never argv), start the reader fiber, emit
 *   `SessionBound`. If anything after the spawn fails, the CLI is closed at once (not when the
 *   caller's scope ends);
 * - close (scope): deny pending approvals, interrupt accepted turns, emit `SessionClosed`, end the
 *   prompt input, `q.close()` (graceful: stdin EOF flushes the transcript), wait for the CLI to exit
 *   (bounded; then SIGKILL its process group) and drop it from the `ProcessLedger`.
 *
 * `events` is a single-consumer stream backed by an unbounded queue: events produced before the
 * runner subscribes are buffered, never lost.
 */
import type { ContextUsage, HarnessEvent } from "@openbot/contracts"
import type { HarnessSession, OpenSessionInput, TurnInput } from "@openbot/core"
import { HarnessError } from "@openbot/core"
import { Cause, Clock, Deferred, Effect, Exit, Option, Queue, Stream } from "effect"
import { buildQueryOptions, mcpServersConfig, TOOL_OUTPUT_CAPS } from "./config.ts"
import { type ClaudeUserMessage, commandMessage, type ReadFile, toUserMessage } from "./input.ts"
import { ClaudeEventPipeline, type SettledCommand } from "./normalize.ts"
import { type CanUseToolOptions, toHarnessRequest, toPermissionResult } from "./permissions.ts"
import { type ClaudeQueryFunction, type ClaudeQueryHandle, queryMessages, type SdkOptions } from "./sdk.ts"
import { makeProcessGroupSpawner, supportsProcessGroups } from "./spawn.ts"

/** Background work runs long commands in the foreground: generous default, 2 h ceiling (Claude's Bash timeout envs). */
export const TASK_BASH_DEFAULT_TIMEOUT_MS = 30 * 60_000
export const TASK_BASH_MAX_TIMEOUT_MS = 2 * 60 * 60_000

export const HARNESS = "claude"

/** Everything a session needs besides `OpenSessionInput` (resolved by the driver). */
export interface SessionDeps {
  readonly query: ClaudeQueryFunction
  /** Clean base environment (`cleanEnv`); `placement.env` is merged on top. */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly executable: string | undefined
  readonly memoryDirectory: string | undefined
  readonly skillsLibrary: string | undefined
  readonly additionalDirectories: ReadonlyArray<string>
  readonly mcpTimeoutMs: number
  readonly mcpRegistrationTimeoutMs: number
  readonly interruptTimeoutMs: number
  /** How long close waits for the CLI to exit before SIGKILLing its process group. */
  readonly closeTimeoutMs: number
  readonly newUuid: () => string
  readonly readFile: ReadFile
  readonly ensureDirectory: (path: string) => Promise<void>
  /** "process-group" (default on POSIX) or let the SDK spawn. */
  readonly spawn: "process-group" | "sdk"
  /** Records/removes the CLI pid in the `ProcessLedger` (D2.5). */
  readonly ledger?:
    | {
        readonly record: (pid: number, label: string) => Effect.Effect<void>
        readonly remove: (pid: number) => Effect.Effect<void>
      }
    | undefined
}

const harnessError = (
  code: HarnessError["code"],
  message: string,
  extra: { readonly retryable?: boolean; readonly cause?: unknown } = {},
) =>
  new HarnessError({
    harness: HARNESS,
    code,
    message,
    ...(extra.retryable !== undefined ? { retryable: extra.retryable } : {}),
    ...(extra.cause !== undefined ? { cause: extra.cause } : {}),
  })

const closedError = () => harnessError("closed", "The Claude session is closed.", { retryable: true })
const notRunningError = () =>
  harnessError("turn-rejected", "Claude is not working on that turn any more; send it as a new turn.", {
    retryable: true,
  })

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "unknown error"

const NOT_INSTALLED = /native cli binary|enoent|not found/i
const STDERR_TAIL_CHARS = 2000
/** After a forced group kill, how long to wait for the exit event (ledger cleanup). */
const KILL_GRACE_MS = 1000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Parses `getContextUsage()` (`{totalTokens, maxTokens}`). */
export const parseContextUsage = (value: unknown): ContextUsage | undefined => {
  if (!isRecord(value)) return undefined
  const used = value.totalTokens
  const max = value.maxTokens
  if (typeof used !== "number" || typeof max !== "number" || max <= 0) return undefined
  return { usedTokens: Math.max(0, Math.round(used)), windowTokens: Math.round(max) }
}

export const openClaudeSession = Effect.fn("ClaudeSession.open")(function* (
  input: OpenSessionInput,
  deps: SessionDeps,
) {
  const context = yield* Effect.context<never>()
  const runPromiseExit = Effect.runPromiseExitWith(context)
  const placement = input.placement

  const directories = [
    placement.harnessCwd,
    ...deps.additionalDirectories,
    ...(deps.memoryDirectory !== undefined ? [deps.memoryDirectory] : []),
  ]
  for (const directory of directories) {
    yield* Effect.tryPromise({
      try: () => deps.ensureDirectory(directory),
      catch: (cause) => harnessError("open-failed", `Cannot create ${directory}: ${errorMessage(cause)}`, { cause }),
    })
  }

  const resumed = input.nativeSessionId !== undefined
  const sessionId = input.nativeSessionId ?? deps.newUuid()
  const pipeline = new ClaudeEventPipeline({
    resumed,
    sessionId,
    hostNodeId: input.placement.hostNodeId,
    // Harness-initiated turns (Claude Code answering its own notifications); core maps them to its ids.
    newTurnId: () => `cli-${deps.newUuid()}`,
  })
  const events = yield* Queue.unbounded<HarnessEvent, Cause.Done>()
  const inbox = yield* Queue.unbounded<ClaudeUserMessage, Cause.Done>()
  const commands = new Map<string, Deferred.Deferred<void, HarnessError>>()
  const closeController = new AbortController()
  let ended = false
  let stderrTail = ""

  const emit = (batch: ReadonlyArray<HarnessEvent>) => {
    if (ended) return
    for (const event of batch) Queue.offerUnsafe(events, event)
  }
  const settle = (settled: ReadonlyArray<SettledCommand>) => {
    for (const s of settled) {
      const deferred = commands.get(s.id)
      if (!deferred) continue
      commands.delete(s.id)
      Deferred.doneUnsafe(
        deferred,
        s.ok ? Effect.void : Effect.fail(harnessError("other", s.error ?? "The command failed.")),
      )
    }
  }
  /** Terminal: emits the pipeline's close events once and ends both queues. */
  const finish = (reason: string, unexpected: boolean) => {
    if (ended) return
    const out = pipeline.close(reason, unexpected)
    emit(out.events)
    settle(out.settled)
    for (const deferred of commands.values()) Deferred.doneUnsafe(deferred, Effect.fail(closedError()))
    commands.clear()
    ended = true
    closeController.abort()
    Queue.endUnsafe(events)
    Queue.endUnsafe(inbox)
  }
  const pushStderr = (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS)
  }

  // ---------------------------------------------------------------- approvals (canUseTool → onRequest)
  const canUseTool = async (toolName: string, toolInput: Record<string, unknown>, options: CanUseToolOptions) => {
    const request = toHarnessRequest(toolName, toolInput, options, placement.harnessCwd)
    const signals = [closeController.signal, ...(options.signal ? [options.signal] : [])]
    const exit = await runPromiseExit(input.onRequest(request), { signal: AbortSignal.any(signals) })
    const resolution = Exit.isSuccess(exit)
      ? exit.value
      : { decision: "deny" as const, message: "The approval request was cancelled." }
    const result = toPermissionResult(toolName, toolInput, options, resolution)
    // Background work must wait for its own commands: a harness-managed background shell would be
    // killed when the task's session closes after its final answer (2026-10-17: a render was lost).
    if (input.purpose === "task" && result.behavior === "allow" && toolName === "Bash") {
      const updated = result.updatedInput as Record<string, unknown>
      if (updated.run_in_background === true) {
        const timeout = typeof updated.timeout === "number" ? updated.timeout : 0
        return {
          ...result,
          updatedInput: { ...updated, run_in_background: false, timeout: Math.max(timeout, TASK_BASH_MAX_TIMEOUT_MS) },
        }
      }
    }
    pipeline.noteDecision(options.toolUseID, result.behavior, result.behavior === "deny" ? result.message : undefined)
    return result
  }

  // ---------------------------------------------------------------- process (+ ProcessLedger, D2.5)
  const ledger = deps.ledger
  // Ledger writes run in order (a fast exit must not remove the pid before it was recorded) and
  // outlive the session scope: the CLI's exit is observed after the scope has closed.
  let ledgerChain: Promise<unknown> = Promise.resolve()
  const ledgerOp = (op: Effect.Effect<void>) => {
    ledgerChain = ledgerChain.then(() => runPromiseExit(op))
  }
  const spawner =
    deps.spawn === "process-group" && supportsProcessGroups
      ? makeProcessGroupSpawner({
          onSpawn: (pid) => {
            if (ledger) ledgerOp(ledger.record(pid, input.sessionKey))
          },
          onExit: (pid) => {
            if (ledger) ledgerOp(ledger.remove(pid))
          },
          onStderr: pushStderr,
        })
      : undefined

  const abortController = new AbortController()
  const options = buildQueryOptions({
    session: input,
    ...(resumed ? { resume: sessionId } : { sessionId }),
    env: {
      ...TOOL_OUTPUT_CAPS,
      ...deps.env,
      ...placement.env,
      ...(input.purpose === "task"
        ? {
            BASH_DEFAULT_TIMEOUT_MS: String(TASK_BASH_DEFAULT_TIMEOUT_MS),
            BASH_MAX_TIMEOUT_MS: String(TASK_BASH_MAX_TIMEOUT_MS),
          }
        : {}),
    },
    executable: deps.executable,
    memoryDirectory: deps.memoryDirectory,
    skillsLibrary: deps.skillsLibrary,
    additionalDirectories: deps.additionalDirectories,
    abortController,
    canUseTool: canUseTool as unknown as SdkOptions["canUseTool"],
    ...(spawner
      ? { spawnClaudeCodeProcess: spawner.spawn as unknown as SdkOptions["spawnClaudeCodeProcess"] }
      : { stderr: pushStderr }),
  })

  const prompt = Stream.toAsyncIterable(Stream.fromQueue(inbox))

  let released = false
  const release = (h: ClaudeQueryHandle) =>
    Effect.gen(function* () {
      if (released) return
      released = true
      finish("closed", false)
      try {
        h.close()
      } catch {
        // already closed
      }
      abortController.abort()
      if (spawner) {
        const exited = yield* Effect.promise(() => spawner.waitExit()).pipe(Effect.timeoutOption(deps.closeTimeoutMs))
        if (Option.isNone(exited)) {
          spawner.killGroup()
          yield* Effect.promise(() => spawner.waitExit()).pipe(Effect.timeoutOption(KILL_GRACE_MS))
        }
      }
      yield* Effect.promise(() => ledgerChain).pipe(Effect.timeoutOption(KILL_GRACE_MS))
    })

  const handle: ClaudeQueryHandle = yield* Effect.acquireRelease(
    Effect.try({
      try: () => deps.query({ prompt, options: options as Readonly<Record<string, unknown>> }),
      catch: (cause) =>
        harnessError(
          NOT_INSTALLED.test(errorMessage(cause)) ? "not-installed" : "open-failed",
          `Cannot start Claude Code: ${errorMessage(cause)}`,
          { cause },
        ),
    }),
    release,
  )

  // ---------------------------------------------------------------- MCP (stdin, never argv)
  if (input.mcp.length > 0) {
    const servers = mcpServersConfig(input.mcp, deps.mcpTimeoutMs)
    const result = yield* Effect.tryPromise({
      try: () => handle.setMcpServers(servers),
      // Error texts can echo headers: only our own texts are reported, and no cause is kept. A CLI
      // that cannot start fails this first control request ("native binary not found at …").
      catch: (cause) =>
        NOT_INSTALLED.test(errorMessage(cause))
          ? harnessError(
              "not-installed",
              `Claude Code is not installed${deps.executable !== undefined ? ` at ${deps.executable}` : ""}.`,
            )
          : harnessError("open-failed", `Claude rejected the MCP servers ${Object.keys(servers).join(", ")}.`, {
              retryable: true,
            }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: deps.mcpRegistrationTimeoutMs,
        orElse: () =>
          Effect.fail(
            harnessError("open-failed", "Claude Code did not answer the MCP server registration.", { retryable: true }),
          ),
      }),
      // The CLI is running: close it now rather than when the caller's scope ends.
      Effect.onError(() => release(handle)),
    )
    const failed = isRecord(result) && isRecord(result.errors) ? Object.keys(result.errors) : []
    if (failed.length > 0) {
      yield* Effect.logWarning("harness-claude: MCP servers failed to connect", { servers: failed })
    }
  }

  // ---------------------------------------------------------------- reader
  const onReaderEnd = (cause: unknown) =>
    Effect.sync(() => {
      if (ended) return
      const detail = cause === undefined ? "Claude Code exited." : `Claude Code stopped: ${errorMessage(cause)}`
      const tail = stderrTail.trim()
      finish(tail.length > 0 ? `${detail}\n${tail.slice(-500)}` : detail, true)
    })
  yield* Stream.fromAsyncIterable(queryMessages(handle), (cause) => cause).pipe(
    Stream.runForEach((frame) =>
      Effect.sync(() => {
        const out = pipeline.message(frame)
        emit(out.events)
        settle(out.settled)
      }),
    ),
    Effect.matchCauseEffect({
      onSuccess: () => onReaderEnd(undefined),
      onFailure: (cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : onReaderEnd(Cause.squash(cause))),
    }),
    Effect.forkScoped({ startImmediately: true }),
  )
  // Runs first on scope close: settle everything before the reader and the process are torn down.
  yield* Effect.addFinalizer(() => Effect.sync(() => finish("closed", false)))

  emit([{ _tag: "SessionBound", nativeSessionId: sessionId }])

  // ---------------------------------------------------------------- operations
  const buildMessage = (turn: TurnInput, uuid: string, priority?: "next") =>
    Effect.promise(() => toUserMessage(turn, { uuid, readFile: deps.readFile, ...(priority ? { priority } : {}) }))

  /** Pushes `message` and records it in the pipeline atomically (no frame can be handled in between). */
  const push = (message: ClaudeUserMessage, record: () => boolean) =>
    Effect.sync(() => {
      if (ended) return "closed" as const
      if (!record()) return "rejected" as const
      return Queue.offerUnsafe(inbox, message) ? ("accepted" as const) : ("closed" as const)
    })

  const startTurn = (turn: TurnInput) =>
    Effect.gen(function* () {
      if (ended) return yield* Effect.fail(closedError())
      const uuid = deps.newUuid()
      const message = yield* buildMessage(turn, uuid)
      const outcome = yield* push(message, () => {
        emit(pipeline.send(turn.turnId, uuid))
        return true
      })
      if (outcome !== "accepted") return yield* Effect.fail(closedError())
    })

  /**
   * Folds input into the running turn; fails `turn-rejected` when it is not running. Uses
   * `priority: "next"`: the CLI takes it at its next step. Never `"now"`: the CLI PREEMPTS the
   * running turn for a "now" message (`turn_preempted`, `terminal_reason: aborted_streaming`), which
   * cut bots off mid-task whenever a teammate's message arrived.
   */
  const steer = (turn: TurnInput) =>
    Effect.gen(function* () {
      if (ended) return yield* Effect.fail(closedError())
      if (!pipeline.canSteer(turn.turnId)) return yield* Effect.fail(notRunningError())
      const uuid = deps.newUuid()
      const message = yield* buildMessage(turn, uuid, "next")
      const outcome = yield* push(message, () => pipeline.steer(turn.turnId, uuid))
      if (outcome === "closed") return yield* Effect.fail(closedError())
      if (outcome === "rejected") return yield* Effect.fail(notRunningError())
    })

  const interrupt: Effect.Effect<void> = Effect.suspend(() => {
    if (ended || !pipeline.requestInterrupt()) return Effect.void
    return Effect.tryPromise(() => handle.interrupt()).pipe(Effect.timeout(deps.interruptTimeoutMs), Effect.ignore)
  })

  const compact: Effect.Effect<void, HarnessError> = Effect.gen(function* () {
    if (ended) return yield* Effect.fail(closedError())
    const uuid = deps.newUuid()
    const deferred = yield* Deferred.make<void, HarnessError>()
    const outcome = yield* push(commandMessage("/compact", uuid), () => {
      commands.set(uuid, deferred)
      emit(pipeline.command(uuid, uuid))
      return true
    })
    if (outcome !== "accepted") return yield* Effect.fail(closedError())
    yield* Deferred.await(deferred)
  })

  const contextUsage: Effect.Effect<ContextUsage | undefined> = Effect.suspend(() => {
    if (ended) return Effect.succeed(pipeline.contextUsage)
    return Effect.tryPromise(() => handle.getContextUsage()).pipe(
      Effect.timeout(5000),
      Effect.map((value) => parseContextUsage(value) ?? pipeline.contextUsage),
      Effect.orElseSucceed(() => pipeline.contextUsage),
    )
  })

  return {
    events: Stream.fromQueue(events),
    nativeSessionId: Effect.sync(() => pipeline.nativeSessionId),
    startTurn,
    steer,
    interrupt,
    compact,
    contextUsage,
  } satisfies HarnessSession
})

/** A `ProcessLedger` adapter for `SessionDeps.ledger`. */
export const ledgerHooks = (ledger: {
  readonly record: (entry: {
    pid: number
    pgid: number
    kind: string
    label?: string
    startedAt: number
  }) => Effect.Effect<void, unknown>
  readonly remove: (pid: number) => Effect.Effect<void, unknown>
}): NonNullable<SessionDeps["ledger"]> => ({
  record: (pid, label) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((startedAt) => ledger.record({ pid, pgid: pid, kind: "claude", label, startedAt })),
      Effect.catchCause((cause) => Effect.logWarning("harness-claude: ProcessLedger.record failed", cause)),
    ),
  remove: (pid) =>
    ledger
      .remove(pid)
      .pipe(Effect.catchCause((cause) => Effect.logWarning("harness-claude: ProcessLedger.remove failed", cause))),
})

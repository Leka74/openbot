/**
 * `HarnessSession` over one Codex thread on the shared app-server (architecture §4.5 Codex; D1.5,
 * D2.2; sdk-codex.md §6.2; remote-codex.md §7; hands-architecture-synthesis.md G3).
 *
 * Lifetime = the caller's `Scope`:
 * - open: plan the placement (explicit `environments` ALWAYS), `environment/add` for a
 *   `codex-environment`, per-thread skill rules, `thread/start` (or `thread/resume`), route the
 *   thread's notifications and server requests into a mailbox, emit `SessionBound`;
 * - close: answer pending approvals with a decline, interrupt the running native turn, emit
 *   `SessionClosed`, then `thread/unsubscribe` and drop the mailbox. The app-server stays up for
 *   the other bots.
 *
 * Every server request of the thread goes to `onRequest` on its own fiber (an approval can wait
 * for minutes without blocking the thread's events). Codex withdraws a request it no longer needs
 * with `serverRequest/resolved` (interrupt, turn end): the waiting `onRequest` fiber is interrupted
 * and nothing is answered.
 *
 * `events` is a single-consumer stream backed by an unbounded queue: events produced before the
 * runner subscribes are buffered, never lost.
 */
import type { ContextUsage, HarnessEvent, HarnessRequestResolution, TurnId } from "@openbot/contracts"
import { HarnessError, type HarnessSession, type OpenSessionInput, type TurnInput } from "@openbot/core"
import { Cause, Clock, Deferred, Duration, Effect, Fiber, Queue, Scope, Stream } from "effect"
import type { AppServerConnection, ThreadMailbox, ThreadMessage } from "./appServer.ts"
import {
  planThread,
  skillRulesFor,
  type ThreadConfigOptions,
  threadConfig,
  type ThreadPlan,
  threadResumeParams,
  threadStartParams,
  turnStartParams,
  turnSteerParams,
} from "./config.ts"
import { type CodexPeerError, harnessError, toHarnessError } from "./errors.ts"
import { CodexNormalizer, type TurnOutcome } from "./normalize.ts"
import { NoReply, type RequestReply } from "./protocol.ts"
import { mapServerRequest } from "./requests.ts"

export const HARNESS = "codex"

/** Everything a session needs besides `OpenSessionInput` (resolved by the driver). */
export interface CodexSessionDeps {
  /** The app-server of the Bot's owner profile on OpenBot's `CODEX_HOME` (started on first use). */
  readonly acquire: Effect.Effect<AppServerConnection, HarnessError>
  readonly threadConfig: ThreadConfigOptions
  /** Control requests (`turn/start`, `turn/steer`, `turn/interrupt`, …). */
  readonly requestTimeout: Duration.Input
  /** `thread/start` / `thread/resume` / `environment/add` (wait for required MCP servers). */
  readonly openTimeout: Duration.Input
  /** How long `compact` waits for the compaction turn to finish. */
  readonly compactTimeout: Duration.Input
  readonly ensureDirectory: (path: string) => Promise<void>
  /**
   * The skills root of the Bot's profile (`<skills-lib>/skills`) when it exists: mounted as an extra
   * skill root; every other discovered skill (the user's `~/.agents/skills`, repo skills) is
   * disabled for the thread (harness-context-isolation.md §4.3). `undefined`
   * → no library, still isolated.
   */
  readonly skillsRoot?: string | undefined
  /** Disable host skills per thread (default true). */
  readonly isolateSkills?: boolean | undefined
}

interface PendingRequest {
  readonly reply: Deferred.Deferred<RequestReply>
  /** The native reply that declines (session closing). */
  readonly decline: () => unknown
  fiber?: Fiber.Fiber<void> | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined)

/** `thread/start` and `thread/resume` results carry `thread.id`. */
const threadOf = (result: unknown): Record<string, unknown> | undefined =>
  isRecord(result) && isRecord(result.thread) ? result.thread : undefined

/** `turn/start` → `{turn: {id}}`. */
const nativeTurnIdOf = (result: unknown): string | undefined =>
  isRecord(result) && isRecord(result.turn) ? str(result.turn.id) : undefined

/** A request that failed because the thread is gone means the session is closed (reopen/resume). */
const THREAD_GONE = /thread\b.*\b(not found|not loaded|unknown|no longer)|no such thread|unknown thread/i

const turnError = (code: HarnessError["code"], error: CodexPeerError, prefix: string): HarnessError =>
  toHarnessError(error._tag === "CodexRpcError" && THREAD_GONE.test(error.message) ? "closed" : code, error, prefix)

const closedError = () =>
  new HarnessError({ harness: HARNESS, code: "closed", message: "The Codex session is closed.", retryable: true })

/**
 * The skills root mounted on each connection (`skills/extraRoots/set` is process-global): an
 * app-server serves one owner profile, so it is that profile's library.
 */
const mountedRoots = new WeakMap<AppServerConnection, string>()

export const openCodexSession = Effect.fn("CodexSession.open")(function* (
  input: OpenSessionInput,
  deps: CodexSessionDeps,
) {
  const sessionScope = yield* Effect.scope
  const placement = input.placement

  const planned = planThread(placement)
  if (planned instanceof HarnessError) return yield* planned
  const plan: ThreadPlan = planned

  yield* Effect.tryPromise({
    try: () => deps.ensureDirectory(plan.cwd),
    catch: (cause) => harnessError("open-failed", `Cannot create the bot workspace ${plan.cwd}.`, cause),
  })

  const connection = yield* deps.acquire
  const request = (method: string, params: unknown, timeout: Duration.Input = deps.requestTimeout) =>
    connection.request(method, params, { timeout })

  // ---------------------------------------------------------------- environment (codex-environment)
  if (plan.register) {
    const register = plan.register
    yield* request("environment/add", register, deps.openTimeout).pipe(
      Effect.mapError((error) =>
        toHarnessError("open-failed", error, `Codex could not attach the environment of node ${placement.hostNodeId}`),
      ),
    )
  }

  // ---------------------------------------------------------------- skills (best effort)
  const skillRules =
    (deps.isolateSkills ?? true)
      ? yield* Effect.gen(function* () {
          const root = deps.skillsRoot
          if (root !== undefined && mountedRoots.get(connection) !== root) {
            const mounted = yield* request("skills/extraRoots/set", { extraRoots: [root] }).pipe(
              Effect.as(true),
              Effect.catch((error) =>
                Effect.logWarning(`Codex: could not mount the OpenBot skills library: ${error._tag}`).pipe(
                  Effect.as(false),
                ),
              ),
            )
            if (mounted) mountedRoots.set(connection, root)
          }
          const listed = yield* request("skills/list", { cwds: [plan.cwd], forceReload: true }).pipe(
            Effect.catch((error) =>
              Effect.logWarning(`Codex: skills/list failed, host skills stay visible: ${error._tag}`).pipe(
                Effect.as(undefined),
              ),
            ),
          )
          // an owner-only skill reaches the Bot only through the owner's `/name` (inline in the turn text)
          const own = input.bot.skills.filter((name) => !input.ownerOnlySkills?.includes(name))
          return skillRulesFor(listed, root, own)
        })
      : []
  const config = threadConfig(input.mcp, { ...deps.threadConfig, skillRules, effort: input.effort })

  // ---------------------------------------------------------------- state
  const events = yield* Queue.unbounded<HarnessEvent, Cause.Done>()
  const pending = new Map<string, PendingRequest>()
  const compactWaiters: Array<Deferred.Deferred<void, HarnessError>> = []
  let ended = false
  let interruptWanted: TurnId | undefined

  const emit = (batch: ReadonlyArray<HarnessEvent>) => {
    if (ended) return
    for (const event of batch) Queue.offerUnsafe(events, event)
  }

  const normalizer = new CodexNormalizer({
    hostNodeId: placement.hostNodeId,
    onInternalTurnEnd: (_native, outcome: TurnOutcome) => {
      const waiter = compactWaiters.shift()
      if (!waiter) return
      Deferred.doneUnsafe(
        waiter,
        outcome._tag === "completed"
          ? Effect.void
          : Effect.fail(
              harnessError(
                "other",
                outcome._tag === "failed"
                  ? `Codex could not compact: ${outcome.error.message}`
                  : "Compaction was interrupted.",
              ),
            ),
      )
    },
  })

  // ---------------------------------------------------------------- thread
  let threadId: string
  let mailbox: ThreadMailbox
  if (input.nativeSessionId !== undefined) {
    threadId = input.nativeSessionId
    // Registered first: the resume replays nothing, but later notifications must find it.
    mailbox = yield* connection.openThreadMailbox(threadId)
    const resumed = yield* request(
      "thread/resume",
      threadResumeParams(threadId, input, plan, config),
      deps.openTimeout,
    ).pipe(Effect.mapError((error) => toHarnessError("open-failed", error, "Codex could not resume the thread")))
    const resumedId = str(threadOf(resumed)?.id)
    if (resumedId !== undefined && resumedId !== threadId) {
      return yield* harnessError("protocol", `Codex resumed thread ${resumedId} instead of ${threadId}.`)
    }
  } else {
    const started = yield* request("thread/start", threadStartParams(input, plan, config), deps.openTimeout).pipe(
      Effect.mapError((error) => toHarnessError("open-failed", error, "Codex could not start a thread")),
    )
    const thread = threadOf(started)
    const id = str(thread?.id)
    if (id === undefined) return yield* harnessError("protocol", "Codex answered thread/start without a thread id.")
    threadId = id
    mailbox = yield* connection.openThreadMailbox(threadId)
    // G3: the explicit environments must be the only ones. A server that ignored them would let a
    // colocated bot run commands on another node.
    const reported = Array.isArray(thread?.environments) ? thread.environments : undefined
    if (reported !== undefined) {
      const wanted = new Set(plan.environments.map((environment) => environment.environmentId))
      const extra = reported
        .map((environment) => (isRecord(environment) ? str(environment.environmentId) : undefined))
        .filter((environmentId): environmentId is string => environmentId !== undefined && !wanted.has(environmentId))
      if (extra.length > 0) {
        yield* request("thread/unsubscribe", { threadId }).pipe(Effect.ignore)
        return yield* harnessError(
          "open-failed",
          `Codex attached environments OpenBot did not select (${extra.join(", ")}); refusing to run this bot there.`,
        )
      }
    }
  }

  // Runs last on close: the server stops routing this thread to us.
  yield* Effect.addFinalizer(() =>
    connection.isClosed.pipe(
      Effect.flatMap((closed) => (closed ? Effect.void : request("thread/unsubscribe", { threadId }, "5 seconds"))),
      Effect.ignore,
    ),
  )
  // onRequest fibers live here; closed after the close finalizer answered them.
  const requestScope = yield* Scope.fork(sessionScope, "parallel")

  // ---------------------------------------------------------------- closing
  /** Terminal: ends the active turn (`failed` when Codex went away), emits `SessionClosed`. */
  const finish = (reason: string, outcome: TurnOutcome | undefined): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (ended) return Effect.void
      const active = normalizer.activeTurn
      if (active !== undefined && outcome !== undefined) emit(normalizer.finishTurn(active, outcome))
      const fibers: Array<Fiber.Fiber<void>> = []
      for (const entry of pending.values()) {
        Deferred.doneUnsafe(entry.reply, Effect.succeed<RequestReply>(safeReply(entry.decline)))
        if (entry.fiber) fibers.push(entry.fiber)
      }
      pending.clear()
      for (const waiter of compactWaiters.splice(0)) Deferred.doneUnsafe(waiter, Effect.fail(closedError()))
      emit([{ _tag: "SessionClosed", reason }])
      ended = true
      Queue.endUnsafe(events)
      return fibers.length === 0
        ? Effect.void
        : Effect.forkIn(Fiber.interruptAll(fibers), sessionScope).pipe(Effect.asVoid)
    })

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (ended) return
      // Decline what is still waiting so Codex does not hang on a closed session.
      for (const entry of pending.values()) {
        const decline = safeReply(entry.decline)
        Deferred.doneUnsafe(entry.reply, Effect.succeed<RequestReply>(decline))
      }
      // Their fibers are interrupted when `requestScope` closes, right after this finalizer.
      pending.clear()
      const active = normalizer.activeTurn
      const native = active !== undefined ? normalizer.nativeTurnOf(active) : undefined
      if (native !== undefined && !(yield* connection.isClosed)) {
        yield* request("turn/interrupt", { threadId, turnId: native }, "3 seconds").pipe(Effect.ignore)
      }
      yield* finish("closed", { _tag: "interrupted" })
    }),
  )

  // ---------------------------------------------------------------- interrupts
  const sendInterrupt = (native: string) =>
    request("turn/interrupt", { threadId, turnId: native }).pipe(
      Effect.catch((error) => Effect.logWarning(`Codex: turn/interrupt failed: ${error._tag}`)),
    )

  /** An interrupt asked for before the native turn id was known is sent once it is. */
  const flushInterrupt: Effect.Effect<void> = Effect.suspend(() => {
    const wanted = interruptWanted
    if (wanted === undefined) return Effect.void
    const native = normalizer.nativeTurnOf(wanted)
    if (native === undefined) return Effect.void
    interruptWanted = undefined
    return Effect.forkIn(sendInterrupt(native), sessionScope, { startImmediately: true }).pipe(Effect.asVoid)
  })

  // ---------------------------------------------------------------- server requests
  const requestContext = { normalizer, nodeIdForEnvironment: plan.nodeIdForEnvironment }

  const handleRequest = (message: Extract<ThreadMessage, { readonly _tag: "Request" }>): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (message.method === "currentTime/read") {
        const now = yield* Clock.currentTimeMillis
        Deferred.doneUnsafe(
          message.reply,
          Effect.succeed<RequestReply>({ result: { currentTimeAt: Math.floor(now / 1000) } }),
        )
        return
      }
      const mapped = mapServerRequest(message.id, message.method, message.params, requestContext)
      if (mapped._tag === "Answer") {
        Deferred.doneUnsafe(message.reply, Effect.succeed<RequestReply>(mapped.reply))
        return
      }
      const decline = () => mapped.reply({ decision: "deny" })
      if (ended) {
        Deferred.doneUnsafe(message.reply, Effect.succeed<RequestReply>(safeReply(decline)))
        return
      }
      const key = String(message.id)
      const entry: PendingRequest = { reply: message.reply, decline }
      pending.set(key, entry)
      entry.fiber = yield* input.onRequest(mapped.request).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("Codex: onRequest failed; declining", cause).pipe(
                Effect.as<HarnessRequestResolution>({ decision: "deny", message: "The request could not be handled." }),
              ),
        ),
        Effect.flatMap((resolution) =>
          Effect.sync(() => {
            if (pending.get(key) !== entry) return // withdrawn or the session closed meanwhile
            pending.delete(key)
            Deferred.doneUnsafe(entry.reply, Effect.succeed<RequestReply>(safeReply(() => mapped.reply(resolution))))
          }),
        ),
        Effect.forkIn(requestScope, { startImmediately: true }),
      )
    })

  /** `serverRequest/resolved`: Codex no longer needs the answer (it was given, or withdrawn). */
  const withdraw = (requestId: unknown): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (typeof requestId !== "string" && typeof requestId !== "number") return Effect.void
      const key = String(requestId)
      const entry = pending.get(key)
      if (!entry) return Effect.void
      pending.delete(key)
      Deferred.doneUnsafe(entry.reply, Effect.succeed<RequestReply>(NoReply))
      const fiber = entry.fiber
      return fiber ? Effect.forkIn(Fiber.interrupt(fiber), sessionScope).pipe(Effect.asVoid) : Effect.void
    })

  // ---------------------------------------------------------------- reader
  const handleNotification = (method: string, params: Record<string, unknown>): Effect.Effect<void> =>
    Effect.gen(function* () {
      switch (method) {
        case "serverRequest/resolved":
          return yield* withdraw(params.requestId)
        case "thread/closed":
          return yield* finish("Codex closed the thread.", {
            _tag: "failed",
            error: { code: "closed", message: "Codex closed the thread.", retryable: true },
          })
        case "mcpServer/startupStatus/updated": {
          const status = str(params.status)
          if (status === "failed" || status === "error") {
            const name = str(params.name) ?? "mcp"
            const detail = str(params.error) ?? str(params.failureReason) ?? "unknown error"
            yield* Effect.logWarning(`Codex: MCP server ${name} failed to start: ${detail}`)
            const active = normalizer.activeTurn
            if (active !== undefined) {
              emit([
                {
                  _tag: "ItemUpserted",
                  turnId: active,
                  key: `mcp-startup:${name}`,
                  item: {
                    _tag: "Notice",
                    level: "warning",
                    code: "mcp-unavailable",
                    text: `The ${name} tools are unavailable: ${detail}`,
                  },
                },
              ])
            }
          }
          return
        }
        case "thread/environment/disconnected":
          return yield* Effect.logWarning(`Codex: environment ${str(params.environmentId) ?? "?"} disconnected`)
        default:
          emit(normalizer.handle(method, params))
          return yield* flushInterrupt
      }
    })

  const handleMessage = (message: ThreadMessage): Effect.Effect<void> => {
    switch (message._tag) {
      case "Notification":
        return handleNotification(message.method, message.params)
      case "Request":
        return handleRequest(message)
      case "Closed":
        return finish(message.reason, {
          _tag: "failed",
          error: { code: "closed", message: `Codex stopped: ${message.reason}`, retryable: true },
        })
    }
  }

  yield* Stream.fromQueue(mailbox).pipe(
    Stream.runForEach((message) =>
      handleMessage(message).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logError("Codex: handling a thread message failed", cause),
        ),
      ),
    ),
    // The mailbox ends when the connection dies or another session took the thread over.
    Effect.andThen(
      finish("The Codex app-server connection ended.", {
        _tag: "failed",
        error: { code: "closed", message: "The Codex app-server connection ended.", retryable: true },
      }),
    ),
    Effect.forkIn(sessionScope, { startImmediately: true }),
  )

  emit([{ _tag: "SessionBound", nativeSessionId: threadId }])

  // ---------------------------------------------------------------- operations
  const turnOptions = { model: input.model, effort: input.effort }

  const startTurn = (turn: TurnInput): Effect.Effect<void, HarnessError> =>
    Effect.gen(function* () {
      if (ended) return yield* closedError()
      const stale = normalizer.activeTurn
      if (stale !== undefined && stale !== turn.turnId) {
        // The runner already ended it (forced interrupt) while Codex never confirmed.
        emit(normalizer.finishTurn(stale, { _tag: "interrupted" }))
      }
      if (interruptWanted !== undefined && interruptWanted !== turn.turnId) interruptWanted = undefined
      normalizer.expectTurn(turn.turnId)
      const result = yield* request("turn/start", turnStartParams(threadId, turn, plan, turnOptions)).pipe(
        Effect.tapError(() => Effect.sync(() => normalizer.cancelExpected(turn.turnId))),
        Effect.mapError((error) => turnError("turn-rejected", error, "Codex rejected the turn")),
      )
      const native = nativeTurnIdOf(result)
      if (native !== undefined) emit(normalizer.bindTurn(native, turn.turnId))
      yield* flushInterrupt
    })

  const steer = (turn: TurnInput): Effect.Effect<void, HarnessError> =>
    Effect.gen(function* () {
      if (ended) return yield* closedError()
      const active = normalizer.activeTurn
      const native = active !== undefined ? normalizer.nativeTurnOf(active) : undefined
      if (native === undefined) return yield* harnessError("turn-rejected", "No Codex turn is running to steer.")
      yield* request("turn/steer", turnSteerParams(threadId, native, turn)).pipe(
        Effect.mapError((error) => turnError("turn-rejected", error, "Codex rejected the message")),
      )
    })

  const interrupt: Effect.Effect<void> = Effect.suspend(() => {
    if (ended) return Effect.void
    const active = normalizer.activeTurn
    if (active === undefined) return Effect.void
    const native = normalizer.nativeTurnOf(active)
    if (native === undefined) {
      interruptWanted = active
      return Effect.void
    }
    return sendInterrupt(native)
  })

  const compact: Effect.Effect<void, HarnessError> = Effect.gen(function* () {
    if (ended) return yield* closedError()
    const done = yield* Deferred.make<void, HarnessError>()
    compactWaiters.push(done)
    const forget = Effect.sync(() => {
      const index = compactWaiters.indexOf(done)
      if (index >= 0) compactWaiters.splice(index, 1)
    })
    yield* request("thread/compact/start", { threadId }).pipe(
      Effect.mapError((error) => turnError("other", error, "Codex could not compact")),
      Effect.tapError(() => forget),
    )
    yield* Deferred.await(done).pipe(
      Effect.timeoutOrElse({
        duration: deps.compactTimeout,
        orElse: () =>
          forget.pipe(Effect.andThen(Effect.fail(harnessError("other", "Codex did not finish compacting in time.")))),
      }),
    )
  })

  const contextUsage: Effect.Effect<ContextUsage | undefined> = Effect.sync(() => normalizer.contextUsage)

  return {
    events: Stream.fromQueue(events),
    nativeSessionId: Effect.succeed(threadId),
    startTurn,
    steer,
    interrupt,
    compact,
    contextUsage,
  } satisfies HarnessSession
})

/** Builds a reply from a mapper that must never throw. */
const safeReply = (build: () => unknown): RequestReply => {
  try {
    return { result: build() }
  } catch (cause) {
    return { error: { code: -32603, message: `OpenBot could not build the reply: ${String(cause)}` } }
  }
}

/** The default duration knobs. */
export const DEFAULT_SESSION_TIMEOUTS = {
  requestTimeout: Duration.seconds(60),
  openTimeout: Duration.seconds(90),
  compactTimeout: Duration.minutes(10),
} as const

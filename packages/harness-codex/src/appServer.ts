/**
 * `codex app-server` process management (architecture §4.5 Codex, D2.2, sdk-codex.md §6.1):
 *
 * - `connectAppServer`: the JSON-RPC peer plus the `initialize`/`initialized` handshake and the
 *   **per-thread router**. Notifications and server requests carry `threadId`; each OpenBot session
 *   registers a mailbox for its thread. Messages that arrive before the session registered (the
 *   `thread/started` that races the `thread/start` response) wait in a small orphan buffer; a
 *   `thread/closed` for a thread no session holds is about an earlier load and is never replayed.
 * - `makeChildProcessLauncher`: spawns the binary detached (own process group, killed as a group on
 *   scope close) with `CODEX_HOME` and the bundled `codex-path` on PATH.
 * - `makeCodexRuntime`: one app-server on OpenBot's `CODEX_HOME` (the driver keeps one per owner
 *   profile), started lazily, recorded in the `ProcessLedger`, and restarted on next use after it dies. Probes reuse it when it runs and
 *   otherwise use a short-lived process.
 */
import { delimiter } from "node:path"
import type { ProcessRecord } from "@openbot/core"
import type { HarnessError, RepoError } from "@openbot/core"
import {
  Cause,
  Clock,
  Deferred,
  type Duration,
  Effect,
  Exit,
  Option,
  Queue,
  Scope,
  Semaphore,
  Sink,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { type CodexBinary, parseCodexVersion } from "./binary.ts"
import { type CodexPeerError, harnessError, RpcErrorCodes, toHarnessError } from "./errors.ts"
import {
  type CodexTransport,
  type IncomingNotification,
  type IncomingRequest,
  makeCodexPeer,
  type ProtocolLogEvent,
  type RequestReply,
} from "./protocol.ts"

// ============================================================================ connection

export interface AppServerInfo {
  readonly userAgent: string
  /** Parsed from `userAgent`; `undefined` when unparseable. */
  readonly version: string | undefined
  readonly codexHome: string
  readonly platformOs: string
  readonly platformFamily: string
}

/** What a session's mailbox receives, in wire order. */
export type ThreadMessage =
  | { readonly _tag: "Notification"; readonly method: string; readonly params: Record<string, unknown> }
  | {
      readonly _tag: "Request"
      readonly id: string | number
      readonly method: string
      readonly params: Record<string, unknown>
      /** Complete exactly once; `NoReply` when Codex withdrew the request. */
      readonly reply: Deferred.Deferred<RequestReply>
    }
  | { readonly _tag: "Closed"; readonly reason: string }

export type ThreadMailbox = Queue.Dequeue<ThreadMessage, Cause.Done>

export interface AppServerConnection {
  readonly info: AppServerInfo
  readonly pid: number | undefined
  readonly request: (
    method: string,
    params?: unknown,
    options?: { readonly timeout?: Duration.Input | undefined },
  ) => Effect.Effect<unknown, CodexPeerError>
  /**
   * Routes `threadId`'s notifications and server requests to the returned mailbox until the scope
   * closes. Buffered early messages for the thread are delivered first.
   */
  readonly openThreadMailbox: (threadId: string) => Effect.Effect<ThreadMailbox, never, Scope.Scope>
  /** Completes with the reason once the app-server is gone. */
  readonly closed: Effect.Effect<string>
  readonly isClosed: Effect.Effect<boolean>
  /** Last stderr lines (diagnostics only; never shown to models). */
  readonly stderrTail: () => ReadonlyArray<string>
}

export interface ConnectOptions {
  readonly transport: CodexTransport
  readonly pid?: number | undefined
  readonly stderrTail?: (() => ReadonlyArray<string>) | undefined
  readonly clientInfo?: { readonly name: string; readonly title: string; readonly version: string } | undefined
  readonly initializeTimeout?: Duration.Input | undefined
  readonly log?: ((event: ProtocolLogEvent) => Effect.Effect<void>) | undefined
}

/** Notifications OpenBot never uses (noise, or they leak the host name: sdk-codex.md §3.4). */
export const OPT_OUT_NOTIFICATIONS: ReadonlyArray<string> = [
  "rawResponseItem/completed",
  "rawResponse/completed",
  "remoteControl/status/changed",
  "turn/diff/updated",
  "turn/plan/updated",
  "item/plan/delta",
  "account/rateLimits/updated",
]

const MAX_ORPHAN_THREADS = 16
const MAX_ORPHAN_MESSAGES = 128

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The thread a notification or server request belongs to (`thread/started` nests it). */
export const threadIdOf = (params: unknown): string | undefined => {
  if (!isRecord(params)) return undefined
  if (typeof params.threadId === "string") return params.threadId
  const thread = params.thread
  if (isRecord(thread) && typeof thread.id === "string") return thread.id
  return undefined
}

export const connectAppServer = Effect.fnUntraced(function* (options: ConnectOptions) {
  const mailboxes = new Map<string, Queue.Queue<ThreadMessage, Cause.Done>>()
  const orphans = new Map<string, Array<ThreadMessage>>()
  let closedReason: string | undefined

  const buffer = (threadId: string, message: ThreadMessage) => {
    let list = orphans.get(threadId)
    if (!list) {
      if (orphans.size >= MAX_ORPHAN_THREADS) {
        const oldest = orphans.keys().next().value
        if (oldest !== undefined) orphans.delete(oldest)
      }
      list = []
      orphans.set(threadId, list)
    }
    list.push(message)
    if (list.length > MAX_ORPHAN_MESSAGES) list.shift()
  }

  const onNotification = (notification: IncomingNotification): Effect.Effect<void> =>
    Effect.suspend(() => {
      const params = isRecord(notification.params) ? notification.params : {}
      const threadId = threadIdOf(params)
      if (threadId === undefined) {
        const level =
          notification.method === "configWarning" ||
          notification.method === "deprecationNotice" ||
          notification.method === "warning"
            ? "Warn"
            : "Debug"
        return Effect.logWithLevel(level)(`Codex app-server: ${notification.method}`).pipe(
          Effect.annotateLogs({ method: notification.method }),
        )
      }
      const message: ThreadMessage = { _tag: "Notification", method: notification.method, params }
      const mailbox = mailboxes.get(threadId)
      if (mailbox) Queue.offerUnsafe(mailbox, message)
      // Codex unloading a thread no session holds (it unloads unsubscribed threads after a delay)
      // ends an earlier load: replayed into the next session it would close that session at once.
      else if (notification.method === "thread/closed") orphans.delete(threadId)
      else buffer(threadId, message)
      return Effect.void
    })

  const onRequest = (request: IncomingRequest): Effect.Effect<Effect.Effect<RequestReply>> =>
    Effect.sync(() => {
      const params = isRecord(request.params) ? request.params : {}
      const threadId = threadIdOf(params)
      const mailbox = threadId === undefined ? undefined : mailboxes.get(threadId)
      if (!mailbox) {
        return Effect.succeed<RequestReply>({
          error: {
            code: RpcErrorCodes.methodNotFound,
            message: `OpenBot has no session for this ${request.method} request.`,
          },
        })
      }
      const reply = Deferred.makeUnsafe<RequestReply>()
      Queue.offerUnsafe(mailbox, { _tag: "Request", id: request.id, method: request.method, params, reply })
      return Deferred.await(reply)
    })

  const onTermination = (reason: string): Effect.Effect<void> =>
    Effect.sync(() => {
      closedReason = reason
      for (const mailbox of mailboxes.values()) {
        Queue.offerUnsafe(mailbox, { _tag: "Closed", reason })
        Queue.endUnsafe(mailbox)
      }
      mailboxes.clear()
      orphans.clear()
    })

  const peer = yield* makeCodexPeer({
    transport: options.transport,
    onNotification,
    onRequest,
    onTermination,
    log: options.log,
  })

  const clientInfo = options.clientInfo ?? { name: "openbot", title: "OpenBot", version: "0.0.0" }
  const initialized = yield* peer.request(
    "initialize",
    {
      clientInfo,
      capabilities: { experimentalApi: true, optOutNotificationMethods: OPT_OUT_NOTIFICATIONS },
    },
    { timeout: options.initializeTimeout ?? "30 seconds" },
  )
  yield* peer.notify("initialized")
  const init = isRecord(initialized) ? initialized : {}
  const userAgent = typeof init.userAgent === "string" ? init.userAgent : ""
  const info: AppServerInfo = {
    userAgent,
    version: parseCodexVersion(userAgent),
    codexHome: typeof init.codexHome === "string" ? init.codexHome : "",
    platformOs: typeof init.platformOs === "string" ? init.platformOs : "",
    platformFamily: typeof init.platformFamily === "string" ? init.platformFamily : "",
  }

  const openThreadMailbox = (threadId: string): Effect.Effect<ThreadMailbox, never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.map(Queue.unbounded<ThreadMessage, Cause.Done>(), (mailbox) => {
        if (closedReason !== undefined) {
          Queue.offerUnsafe(mailbox, { _tag: "Closed", reason: closedReason })
          Queue.endUnsafe(mailbox)
          return mailbox
        }
        const previous = mailboxes.get(threadId)
        if (previous) {
          Queue.offerUnsafe(previous, {
            _tag: "Closed",
            reason: "Another OpenBot session took over this Codex thread.",
          })
          Queue.endUnsafe(previous)
        }
        for (const message of orphans.get(threadId) ?? []) Queue.offerUnsafe(mailbox, message)
        orphans.delete(threadId)
        mailboxes.set(threadId, mailbox)
        return mailbox
      }),
      (mailbox) =>
        Effect.sync(() => {
          if (mailboxes.get(threadId) === mailbox) mailboxes.delete(threadId)
          Queue.endUnsafe(mailbox)
        }),
    )

  return {
    info,
    pid: options.pid,
    request: peer.request,
    openThreadMailbox,
    closed: peer.terminated,
    isClosed: peer.isTerminated,
    stderrTail: options.stderrTail ?? (() => []),
  } satisfies AppServerConnection
})

// ============================================================================ launching

export interface LaunchSpec {
  readonly binary: CodexBinary
  readonly args: ReadonlyArray<string>
  readonly codexHome: string
  /** Extra environment (merged over the brain's environment). */
  readonly env: Readonly<Record<string, string>>
  readonly cwd?: string | undefined
}

export interface LaunchedAppServer {
  readonly transport: CodexTransport
  readonly pid?: number | undefined
  readonly stderrTail?: (() => ReadonlyArray<string>) | undefined
}

/** Starts an app-server whose lifetime is the provided scope. Tests inject an in-memory one. */
export type AppServerLauncher = (spec: LaunchSpec) => Effect.Effect<LaunchedAppServer, HarnessError, Scope.Scope>

/** Inherited `CODEX_*` variables that are the user's own auth, not session state. */
const KEPT_CODEX_VARS = new Set(["CODEX_API_KEY", "CODEX_CA_CERTIFICATE"])

/**
 * The environment every OpenBot app-server gets: the brain's environment without inherited
 * `CODEX_*` state (a brain started from inside a Codex session must not leak its `CODEX_HOME`,
 * sandbox or thread variables), then `spec.env`, then OpenBot's profile and the bundled `rg`.
 */
export const appServerEnv = (
  spec: Pick<LaunchSpec, "binary" | "codexHome" | "env">,
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (key.startsWith("CODEX_") && !KEPT_CODEX_VARS.has(key)) continue
    env[key] = value
  }
  Object.assign(env, spec.env)
  const basePath = env.PATH ?? ""
  return {
    ...env,
    CODEX_HOME: spec.codexHome,
    // The models cache is refreshed before `initialize` names the client (t3code CodexProvider).
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "openbot",
    PATH: [...spec.binary.pathDirs, basePath].filter((part) => part !== "").join(delimiter),
  }
}

const STDERR_TAIL_LINES = 40

/** Spawns `codex app-server` as a detached child (own process group) of the brain. */
export const makeChildProcessLauncher = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const encoder = new TextEncoder()
  const launcher: AppServerLauncher = (spec) =>
    Effect.gen(function* () {
      const handle = yield* spawner
        .spawn(
          ChildProcess.make(spec.binary.path, [...spec.args], {
            env: appServerEnv(spec),
            extendEnv: false,
            detached: true,
            forceKillAfter: "3 seconds",
            ...(spec.cwd ? { cwd: spec.cwd } : {}),
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            harnessError("not-installed", `Could not start Codex (${spec.binary.path}): ${cause.message}`, cause),
          ),
        )
      const tail: Array<string> = []
      yield* handle.stderr.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) =>
          Effect.sync(() => {
            tail.push(line)
            if (tail.length > STDERR_TAIL_LINES) tail.shift()
          }),
        ),
        Effect.ignore,
        Effect.forkScoped,
      )
      const transport: CodexTransport = {
        incoming: handle.stdout,
        outgoing: Sink.mapInput(handle.stdin, (line: string) => encoder.encode(line)),
        terminationReason: handle.exitCode.pipe(
          Effect.timeoutOption("2 seconds"),
          Effect.map((code) =>
            Option.isSome(code)
              ? `Codex app-server exited with code ${code.value}`
              : "Codex app-server closed its output",
          ),
          Effect.catch(() => Effect.succeed("Codex app-server closed its output")),
        ),
      }
      return { transport, pid: handle.pid, stderrTail: () => [...tail] } satisfies LaunchedAppServer
    })
  return launcher
})

// ============================================================================ runtime (one per CODEX_HOME)

export interface ProcessLedgerLike {
  readonly record: (entry: ProcessRecord) => Effect.Effect<void, RepoError>
  readonly remove: (pid: number) => Effect.Effect<void, RepoError>
}

export interface CodexRuntimeOptions {
  /** Resolves the binary at (re)start time; `undefined` = not installed. */
  readonly binary: () => CodexBinary | undefined
  readonly launcher: AppServerLauncher
  readonly codexHome: string
  readonly env?: Readonly<Record<string, string>> | undefined
  /** cwd of the app-server process (threads pass their own cwd). */
  readonly cwd?: string | undefined
  readonly clientVersion?: string | undefined
  readonly ledger?: ProcessLedgerLike | undefined
  readonly initializeTimeout?: Duration.Input | undefined
  readonly log?: ((event: ProtocolLogEvent) => Effect.Effect<void>) | undefined
  /** Runs before every launch (prepares `CODEX_HOME`: hermetic config, auth link). */
  readonly beforeStart?: Effect.Effect<void, HarnessError> | undefined
}

export interface CodexRuntime {
  /** The shared app-server, started on first use and restarted after it died. */
  readonly acquire: Effect.Effect<AppServerConnection, HarnessError>
  /** The shared app-server when it is running. */
  readonly current: Effect.Effect<AppServerConnection | undefined>
  /** Runs `f` on the shared app-server when it runs, else on a short-lived one (probes). */
  readonly withConnection: <A, E>(
    f: (connection: AppServerConnection) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | HarnessError>
}

export const makeCodexRuntime = Effect.fnUntraced(function* (options: CodexRuntimeOptions) {
  const runtimeScope = yield* Effect.scope
  const lock = yield* Semaphore.make(1)
  let current: { readonly connection: AppServerConnection; readonly scope: Scope.Closeable } | undefined

  /** Launches and initializes an app-server whose lifetime is `scope`. */
  const start = (scope: Scope.Scope): Effect.Effect<AppServerConnection, HarnessError> =>
    Effect.gen(function* () {
      const binary = options.binary()
      if (!binary) {
        return yield* harnessError(
          "not-installed",
          "Codex is not installed: the bundled @openai/codex binary is missing and `codex` is not on PATH.",
        )
      }
      if (options.beforeStart) yield* options.beforeStart
      const launched = yield* options.launcher({
        binary,
        args: ["app-server"],
        codexHome: options.codexHome,
        env: options.env ?? {},
        cwd: options.cwd,
      })
      const pid = launched.pid
      if (pid !== undefined && options.ledger) {
        const ledger = options.ledger
        const startedAt = yield* Clock.currentTimeMillis
        // Detached → the child leads its own process group (pgid = pid).
        yield* ledger
          .record({ pid, pgid: pid, kind: "codex-app-server", label: options.codexHome, startedAt })
          .pipe(Effect.catchCause((cause) => Effect.logWarning("Could not record the Codex app-server pid", cause)))
        yield* Effect.addFinalizer(() =>
          ledger
            .remove(pid)
            .pipe(Effect.catchCause((cause) => Effect.logWarning("Could not remove the Codex pid", cause))),
        )
      }
      return yield* connectAppServer({
        transport: launched.transport,
        pid,
        stderrTail: launched.stderrTail,
        clientInfo: { name: "openbot", title: "OpenBot", version: options.clientVersion ?? "0.0.0" },
        initializeTimeout: options.initializeTimeout,
        log: options.log,
      }).pipe(Effect.mapError((error) => toHarnessError("open-failed", error, "Codex app-server did not initialize")))
    }).pipe(Scope.provide(scope))

  const acquire: Effect.Effect<AppServerConnection, HarnessError> = lock.withPermits(1)(
    Effect.gen(function* () {
      const existing = current
      if (existing && !(yield* existing.connection.isClosed)) return existing.connection
      const scope = yield* Scope.fork(runtimeScope, "sequential")
      const connection = yield* start(scope).pipe(Effect.onError(() => Scope.close(scope, Exit.void)))
      const entry = { connection, scope }
      current = entry
      // When the process dies: release its resources and start a fresh one on next use.
      yield* connection.closed.pipe(
        Effect.tap((reason) =>
          Effect.logWarning(`Codex app-server stopped: ${reason}`).pipe(
            Effect.annotateLogs({ stderr: connection.stderrTail().slice(-5).join("\n") }),
          ),
        ),
        Effect.andThen(
          Effect.sync(() => {
            if (current === entry) current = undefined
          }),
        ),
        Effect.andThen(Scope.close(scope, Exit.void)),
        Effect.forkIn(runtimeScope),
      )
      return connection
    }),
  )

  const currentConnection = Effect.gen(function* () {
    const existing = current
    if (!existing) return undefined
    return (yield* existing.connection.isClosed) ? undefined : existing.connection
  })

  const withConnection = <A, E>(f: (connection: AppServerConnection) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const live = yield* currentConnection
      if (live) return yield* f(live)
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope
          const connection = yield* start(scope)
          return yield* f(connection)
        }),
      )
    })

  return { acquire, current: currentConnection, withConnection } satisfies CodexRuntime
})

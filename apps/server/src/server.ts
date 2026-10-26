/**
 * The brain's composition root (architecture §4.9; layer order in core `ports/services.ts` and
 * interfaces.md §2.3).
 *
 * Build order (each step only needs the ones before it):
 *  1. config, data dir (+ single-brain lock), ids
 *  2. both listener sockets bound (routes are attached in steps 13 and 15; until then they answer 404)
 *  3. persistence: SQLite + migrations
 *  4. boot recovery (kill leftover process groups, interrupt turns, expire requests, revoke MCP tokens)
 *  5. layer-0 ports: internal address, harness registry, brain identity + node config, brain-nodes
 *     (registry, streams, relays, placement, computer), MCP binding issuer, web auth
 *  6. LiveHub → settings/usage/notifier/conversations/attachments → memory/skills → approvals →
 *     instructions → background tasks → orchestrator
 *  7. `Orchestrator.recover(report)` publishes what boot recovery changed
 *  8. harness drivers (fake always; claude/codex/opencode probe their install/auth lazily), then
 *     the drivers of the owner's added harness accounts (profiles.ts; first boot adds discovered ones)
 *  9. the local node (`node_local`, unless `--no-local-node`)
 * 10. messaging + routine scheduler (its fiber starts here) → bot service
 * 11. MCP gateway
 * 12. node gateway
 * 13. RPC handlers; the internal routes (`/mcp`, `/relay`) and the public routes are mounted
 * 14. ready: print the login URL
 * 15. resume what the previous run handed off or a crash cut off (`ResumeLive`); SIGUSR2 drains the
 *     brain for a deploy (`DrainOnSignalLive`, drain.ts); the message search index catches up in the
 *     background (`SearchIndexLive`)
 *
 * Shutdown runs the same graph backwards; the ready layer first hands off what runs or waits to the
 * next boot (`Orchestrator.handOff`: saved, then every runner and its harness session stops) and closes node control sockets (`NodeRegistry.closeAll`) before the public routes are
 * detached, so Bun's `server.stop()` never waits on an open WebSocket. Harness processes close with
 * their driver/runner scopes and SQLite closes last.
 */
import {
  BrainIdentity,
  BrainNodesConfig,
  BrainNodesLive,
  HostPathsLive,
  loadOrCreateIdentity,
  LocalNodeDaemonLive,
  type LocalNodeDaemonOptions,
  makeBrainNodesConfig,
  NodeGatewayLive,
  NodeRegistry,
} from "@openbot/brain-nodes"
import {
  CallPresence,
  SignInRequests,
  ApprovalServiceLive,
  AttachmentServiceLive,
  BackgroundTasks,
  BackgroundTasksLive,
  BootRecovery,
  type BootRecoveryReport,
  BotServiceLive,
  ConversationServiceLive,
  DataDir,
  HarnessRegistry,
  IdGen,
  InstructionRendererLive,
  LiveHubLive,
  makeDataDir,
  MAX_SENT_FILES,
  MemoryServiceLive,
  MessagingLive,
  NotifierLive,
  Orchestrator,
  OrchestratorLive,
  RoutineSchedulerLive,
  SearchRepo,
  SearchServiceLive,
  SendFileLimits,
  SettingsServiceLive,
  type SkillDirectory,
  SkillServiceLive,
  SlackServiceLive,
  SlackShortcutsLive,
  UiCardServiceLive,
  UsageServiceLive,
} from "@openbot/core"
import { McpBindingIssuerLive, McpGatewayLive } from "@openbot/gateway"
import { ClaudeHarnessLive } from "@openbot/harness-claude"
import { CodexHarnessLive } from "@openbot/harness-codex"
import { FakeHarnessLive } from "@openbot/harness-fake"
import { OpenCodeHarnessLive } from "@openbot/harness-opencode"
import { PersistenceLive } from "@openbot/persistence"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { existsSync } from "node:fs"
import { chmod, mkdir, unlink } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { WebAuth, WebAuthLayer } from "./auth.ts"
import { DrainOnSignalLive } from "./drain.ts"
import { OPENBOT_VERSION, ServerConfig, type ServerConfigShape } from "./config.ts"
import {
  InternalAddressLive,
  InternalHttpServer,
  InternalListener,
  InternalListenerLive,
  PublicHttpServer,
  PublicListener,
  PublicListenerLive,
} from "./listeners.ts"
import { HarnessProfilesLayer, type ProfileOptions } from "./profiles.ts"
import { InternalRoutes, PublicRoutes } from "./routes.ts"
import { RpcHandlersLive } from "./rpc.ts"
import { setShutdownPhase } from "./shutdown.ts"
import { SkillsShLive } from "./skillsSh.ts"
import { SlackConnectorLive } from "./slack/connector.ts"
import { type SpeechToText, SpeechToTextLive } from "./stt/service.ts"
import { VoiceCallsLive } from "./voice/service.ts"
import { UpdatesLive, type UpdatesOptions } from "./updates.ts"
import { OwnerPresence } from "./presence.ts"
import { HarkLive } from "./hark.ts"
import { NtfyLive } from "./ntfy.ts"

// ============================================================================ startup errors

/** A startup failure with a message for the owner (data dir in use, not writable, …). */
export class StartupError extends Schema.TaggedError<StartupError>()("StartupError", { message: Schema.String }) {}

// ============================================================================ step 1: data dir

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === "EPERM"
  }
}

/**
 * Creates the data root (0700) and takes `<data>/brain.pid`: two brains on one data dir would kill
 * each other's harness processes at boot recovery. A stale pid file (dead process) is replaced; the
 * same process (a `bun --hot` reload) may retake it.
 */
export const DataDirLockLive: Layer.Layer<never, StartupError, DataDir> = Layer.effectDiscard(
  Effect.gen(function* () {
    const dataDir = yield* DataDir
    const lockPath = `${dataDir.root}/brain.pid`
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          await mkdir(dataDir.root, { recursive: true, mode: 0o700 })
          await mkdir(dataDir.logs, { recursive: true })
          await mkdir(`${dataDir.root}/bots`, { recursive: true })
          const lock = Bun.file(lockPath)
          if (await lock.exists()) {
            const pid = Number((await lock.text()).trim())
            if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)) {
              throw new Error(`another OpenBot brain (pid ${pid}) is using ${dataDir.root}`)
            }
          }
          await Bun.write(lockPath, `${process.pid}\n`)
          await chmod(lockPath, 0o600)
        },
        catch: (error) =>
          new StartupError({
            message:
              error instanceof Error && error.message.startsWith("another OpenBot brain")
                ? error.message
                : `cannot use the data dir ${dataDir.root}: ${error instanceof Error ? error.message : String(error)}`,
          }),
      }),
      () =>
        Effect.promise(async () => {
          try {
            if ((await Bun.file(lockPath).text()).trim() === String(process.pid)) await unlink(lockPath)
          } catch {
            // already gone
          }
        }),
    )
  }),
)

// ============================================================================ step 4: boot recovery

/** What boot recovery changed (published by `Orchestrator.recover` once the services are up). */
export class BootReport extends Context.Service<BootReport, BootRecoveryReport>()("openbot/server/BootReport") {}

export const BootReportLive: Layer.Layer<BootReport, StartupError, BootRecovery> = Layer.effect(
  BootReport,
  Effect.gen(function* () {
    const recovery = yield* BootRecovery
    const report = yield* recovery.run.pipe(
      Effect.mapError((error) => new StartupError({ message: `boot recovery failed: ${error.message}` })),
    )
    const changed =
      report.killedProcesses.length +
      report.interruptedTurns.length +
      report.expiredRequests.length +
      report.interruptedRuns.length +
      report.interruptedTasks.length
    if (changed > 0) {
      yield* Effect.logInfo("Recovered from the previous run", {
        killedProcesses: report.killedProcesses.length,
        interruptedTurns: report.interruptedTurns.length,
        expiredRequests: report.expiredRequests.length,
        interruptedRoutineRuns: report.interruptedRuns.length,
        interruptedTasks: report.interruptedTasks.length,
      })
    }
    return report
  }),
)

/** Step 7: `Orchestrator.recover(report)` (before any runner, scheduler or listener starts). */
export const RecoveredLive: Layer.Layer<never, never, BootReport | Orchestrator> = Layer.effectDiscard(
  Effect.gen(function* () {
    const report = yield* BootReport
    yield* (yield* Orchestrator).recover(report)
  }),
)

/**
 * Step 15, once the routes serve (a resumed turn calls `/mcp` at once): the work the previous run
 * handed off or a crash cut off continues — queued messages are delivered, cut-off bots continue
 * where they were (`Orchestrator.resume`), cut-off background tasks run again (`BackgroundTasks.recover`).
 */
export const ResumeLive: Layer.Layer<never, never, BootReport | Orchestrator | BackgroundTasks> = Layer.effectDiscard(
  Effect.gen(function* () {
    const report = yield* BootReport
    yield* (yield* Orchestrator).resume(report)
    yield* (yield* BackgroundTasks).recover(report)
  }),
)

/**
 * Step 15 too: the message search index catches up with what is stored, in the background (the
 * first boot after the upgrade indexes everything; later boots only what an older release wrote).
 * Searches meanwhile report `indexing`.
 */
export const SearchIndexLive: Layer.Layer<never, never, SearchRepo> = Layer.effectDiscard(
  Effect.gen(function* () {
    const search = yield* SearchRepo
    yield* Effect.forkScoped(
      search.ensure.pipe(
        Effect.tap((report) =>
          report.rebuilt || report.indexed > 0 ? Effect.logInfo("Message search index ready", report) : Effect.void,
        ),
        Effect.catchCause((cause) => Effect.logError("Message search index failed", cause)),
      ),
    )
  }),
)

// ============================================================================ step 5: ports

/** The node daemon's entry in this repository (apps/node), built for other computers on request. */
const NODE_ENTRY = fileURLToPath(new URL("../../node/src/main.ts", import.meta.url))

export const BrainNodesConfigLive: Layer.Layer<BrainNodesConfig, never, ServerConfig | PublicListener> = Layer.effect(
  BrainNodesConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const listener = yield* PublicListener
    return makeBrainNodesConfig({
      brainOrigin: listener.brainOrigin,
      extraOrigins: listener.allowedOrigins.filter((origin) => origin !== listener.brainOrigin),
      brainVersion: OPENBOT_VERSION,
      localNode: { enabled: config.localNode },
      desktopIdleMs: config.desktopIdleMs,
      // run from source: other computers get the node built from it (`curl …/node/install.sh | sh`)
      ...(existsSync(NODE_ENTRY) ? { nodeInstall: { entry: NODE_ENTRY } } : {}),
    })
  }),
)

export const WebAuthLive: Layer.Layer<WebAuth, never, DataDir | PublicListener> = Layer.unwrap(
  Effect.gen(function* () {
    const dataDir = yield* DataDir
    const listener = yield* PublicListener
    return WebAuthLayer({
      path: `${dataDir.root}/auth.json`,
      allowedOrigins: listener.allowedOrigins,
      publicOrigins: listener.publicOrigins,
    })
  }),
)

const BrainIdentityLive: Layer.Layer<BrainIdentity, StartupError, DataDir> = Layer.effect(
  BrainIdentity,
  Effect.flatMap(DataDir, (dataDir) =>
    loadOrCreateIdentity(dataDir.brainIdentity).pipe(
      Effect.mapError((error) => new StartupError({ message: `brain identity (${error.path}): ${error.message}` })),
    ),
  ),
)

// ============================================================================ step 8: drivers

/** Fake always; the others when configured (`--harness`). Their probes report install and auth. */
export const harnessDrivers = (config: ServerConfigShape): Layer.Layer<never, never, HarnessRegistry | DataDir> => {
  const layers: Array<Layer.Layer<never, never, HarnessRegistry | DataDir>> = [FakeHarnessLive]
  if (config.harnesses.includes("claude")) {
    // default: the SDK's bundled CLI (version-matched with the SDK); `--claude-path` overrides
    layers.push(
      ClaudeHarnessLive({ executable: config.claudePath ?? "bundled", clientApp: `openbot/${OPENBOT_VERSION}` }),
    )
  }
  if (config.harnesses.includes("codex")) layers.push(CodexHarnessLive({ clientVersion: OPENBOT_VERSION }))
  if (config.harnesses.includes("opencode")) layers.push(OpenCodeHarnessLive())
  return Layer.mergeAll(...(layers as [Layer.Layer<never, never, HarnessRegistry | DataDir>]))
}

// ============================================================================ step 14: ready + shutdown

export interface ReadyOptions {
  /** Do not print the banner (tests). */
  readonly quiet?: boolean | undefined
}

/** Prints the login URL; on shutdown hands work off, stops runners and disconnects nodes before the listeners go. */
export const ReadyLive = (options?: ReadyOptions) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const listener = yield* PublicListener
      const internal = yield* InternalListener
      const auth = yield* WebAuth
      const orchestrator = yield* Orchestrator
      const registry = yield* NodeRegistry

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Effect.logInfo("OpenBot is shutting down")
          setShutdownPhase("stopping harness sessions")
          // What runs or waits is saved for the next boot first, then the sessions stop. Budgeted: the
          // whole shutdown has OPENBOT_SHUTDOWN_TIMEOUT_MS (default 5 s) before the watchdog kills
          // every child process group (main.ts, shutdown.ts)
          yield* orchestrator.handOff.pipe(
            Effect.timeoutOrElse({
              duration: "3 seconds",
              orElse: () => Effect.logWarning("Some harness sessions did not stop within 3 s"),
            }),
          )
          setShutdownPhase("closing node connections")
          yield* registry.closeAll(1001, "brain shutting down")
          setShutdownPhase("releasing services (listeners, local node, harness drivers, SQLite)")
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("Shutdown step failed", cause))),
      )

      yield* Effect.logInfo("OpenBot started", {
        version: OPENBOT_VERSION,
        dataDir: config.dataDir,
        public: listener.selfBase,
        internal: internal.baseUrl,
        web: listener.web.mode,
        harnesses: config.harnesses,
        localNode: config.localNode,
      })
      if (options?.quiet !== true) {
        const token = encodeURIComponent(auth.ownerToken)
        const lines = [
          "",
          `OpenBot is running → ${listener.loginBase}/?token=${token}`,
          ...listener.publicOrigins.map((origin) => `                also at ${origin}/?token=${token}`),
          `Data: ${config.dataDir}${config.dev ? "  (dev mode)" : ""}`,
          "",
        ]
        console.log(lines.join("\n"))
      }
    }),
  )

// ============================================================================ the whole brain

export interface ServerOptions {
  /** node-daemon options of the local node (tests: no browser, no binary detection). */
  readonly localNode?: LocalNodeDaemonOptions | undefined
  /** Replaces the harness drivers (tests). */
  readonly drivers?: Layer.Layer<never, never, HarnessRegistry | DataDir> | undefined
  /** Harness accounts: discovery home/env, test drivers, first-boot seeding (profiles.ts). */
  readonly profiles?: ProfileOptions | undefined
  /** Replaces skills.sh (tests). */
  readonly skillDirectory?: Layer.Layer<SkillDirectory> | undefined
  readonly speechToText?: Layer.Layer<SpeechToText> | undefined
  /** Voice calls' folders (tests: an installed copy). */
  readonly voiceCalls?: { readonly dir: string; readonly sttDir: string } | undefined
  /** Updates from GitHub Releases (tests: a fake GitHub, no timer). */
  readonly updates?: Omit<UpdatesOptions, "dataDir"> | undefined
  readonly quiet?: boolean | undefined
}

/**
 * The brain as one layer. Building it boots the brain (steps above); releasing it shuts it down.
 * Every service stays in the output so tests can reach them.
 */
export const ServerLive = (config: ServerConfigShape, options?: ServerOptions) => {
  // `--max-file-mb`: the send_file cap (core's `SendFileLimits` reference; default 200 MB)
  const limits =
    config.maxFileBytes === undefined
      ? Layer.empty
      : Layer.succeed(SendFileLimits, { maxFileBytes: config.maxFileBytes, maxFiles: MAX_SENT_FILES })
  const base = Layer.mergeAll(ServerConfig.layer(config), DataDir.layer(config.dataDir), IdGen.layer, limits)
  const listeners = Layer.mergeAll(PublicListenerLive, InternalListenerLive)
  // HostPathsLive: the local computer's home and git repo roots (project folders, "Allow in ‹folder›").
  const ports = Layer.mergeAll(
    InternalAddressLive,
    HarnessRegistry.layer,
    BrainNodesConfigLive,
    BrainIdentityLive,
    WebAuthLive,
    HostPathsLive,
    // the owner's Slack (D3.4): tokens in <data>/slack.json
    SlackConnectorLive({ file: makeDataDir(config.dataDir).slack, apiUrl: config.slackApiUrl }),
    options?.speechToText ?? SpeechToTextLive({ dir: makeDataDir(config.dataDir).stt }),
    // voice calls (experiment): who is on a call (background work started on one reports back on it)
    CallPresence.layer,
    // browsers waiting to be allowed to sign in ("Sign in with another device")
    SignInRequests.layer,
    // whether the owner is at a computer whose desktop app shows notifications (Hark waits meanwhile)
    OwnerPresence.layer,
  )
  const level2 = Layer.mergeAll(
    SettingsServiceLive,
    UsageServiceLive,
    NotifierLive,
    ConversationServiceLive,
    AttachmentServiceLive,
    SearchServiceLive,
  )

  const publicServed = HttpRouter.serve(PublicRoutes, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provide(PublicHttpServer),
  )
  const internalServed = HttpRouter.serve(InternalRoutes, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provide(InternalHttpServer),
  )

  // steps 1-5: everything below the core services
  const foundation = Layer.mergeAll(BrainNodesLive, McpBindingIssuerLive).pipe(
    Layer.provideMerge(ports), // 5
    Layer.provideMerge(BootReportLive), // 4
    Layer.provideMerge(PersistenceLive(config.dataDir)), // 3
    Layer.provideMerge(listeners), // 2
    Layer.provideMerge(DataDirLockLive), // 1
    Layer.provideMerge(base),
  )
  // steps 6-10: core services, recovery, drivers, local node
  const services = SkillServiceLive.pipe(
    Layer.provide(
      options?.skillDirectory ??
        SkillsShLive(config.skillsShUrl === undefined ? undefined : { baseUrl: config.skillsShUrl }),
    ), // skills.sh import (D5.5)
    Layer.provideMerge(BotServiceLive),
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(MessagingLive, RoutineSchedulerLive, SlackShortcutsLive, UiCardServiceLive)), // 10 (+ Slack's "Send to OpenBot", ui cards)
    // voice calls (experiment): <data>/voice, and voice input's Parakeet + sherpa-onnx
    Layer.provideMerge(
      VoiceCallsLive(
        options?.voiceCalls ?? { dir: makeDataDir(config.dataDir).voice, sttDir: makeDataDir(config.dataDir).stt },
      ),
    ),
    // updates: the newest release of OpenBot, installed through scripts/deploy.ts
    Layer.provideMerge(
      UpdatesLive({
        dataDir: config.dataDir,
        repo: process.env["OPENBOT_UPDATE_REPO"],
        // OPENBOT_UPDATES=off: no checking on a timer (tests, or a brain updated by other means)
        schedule: process.env["OPENBOT_UPDATES"] !== "off",
        ...options?.updates,
      }),
    ),
    Layer.provideMerge(LocalNodeDaemonLive(options?.localNode)), // 9
    Layer.provideMerge(HarnessProfilesLayer(options?.profiles)), // 8b: added accounts (profiles.ts)
    Layer.provideMerge(options?.drivers ?? harnessDrivers(config)), // 8
    Layer.provideMerge(RecoveredLive), // 7
    Layer.provideMerge(OrchestratorLive), // 6
    Layer.provideMerge(BackgroundTasksLive), // 5b (D5.7)
    Layer.provideMerge(InstructionRendererLive),
    Layer.provideMerge(ApprovalServiceLive),
    Layer.provideMerge(SlackServiceLive), // Slack drafts (D3.4)
    Layer.provideMerge(HarkLive({ file: makeDataDir(config.dataDir).hark, baseUrl: config.harkUrl })), // iPhone notifications (D3.5)
    Layer.provideMerge(NtfyLive({ file: makeDataDir(config.dataDir).ntfy })), // phone notifications (D3.6)
    Layer.provideMerge(MemoryServiceLive),
    Layer.provideMerge(level2),
    Layer.provideMerge(LiveHubLive),
    Layer.provideMerge(foundation),
  )
  // steps 11-14: gateways, both listeners' routes, ready. The two `HttpRouter.serve` layers are
  // SIBLINGS: a serve layer's output context carries its router (and memo map), so stacking one on
  // the other would mount every route on both listeners.
  return Layer.mergeAll(ResumeLive, DrainOnSignalLive, SearchIndexLive).pipe(
    // 15
    Layer.provideMerge(ReadyLive({ quiet: options?.quiet })), // 14
    Layer.provideMerge(Layer.mergeAll(internalServed, publicServed)), // 13
    Layer.provideMerge(RpcHandlersLive),
    Layer.provideMerge(NodeGatewayLive), // 12
    Layer.provideMerge(McpGatewayLive), // 11
    Layer.provideMerge(services),
  )
}

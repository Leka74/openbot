/**
 * Codex `HarnessDriver` (architecture §3.1, §4.5 Codex; D1.5, D2.2, D2.5, D2.6) and its layer.
 *
 * `CodexHarnessLive(config?)` registers the driver in `HarnessRegistry` for the layer's lifetime.
 * It needs `DataDir` (`codexHome`, skills library) and uses `ProcessLedger` when it is provided
 * (app-server pids for boot recovery). The layer owns one `codex app-server` per owner profile for
 * OpenBot's `CODEX_HOME` (the skill roots of a server are process-global, so each profile's Bots see
 * only its library), started on first use and stopped (process group) when the layer closes.
 */
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { BunServices } from "@effect/platform-bun"
import {
  type Bot,
  type HarnessCapabilities,
  type HarnessStatus,
  MAIN_PROFILE_ID,
  type ModelInfo,
  type OwnerProfileId,
} from "@openbot/contracts"
import { DataDir, type DataDirShape, type HarnessDriver, HarnessRegistry, joinPath, ProcessLedger } from "@openbot/core"
import { Clock, Duration, Effect, Layer, Option, RcMap, Ref, type Scope } from "effect"
import {
  type AppServerLauncher,
  type CodexRuntime,
  makeChildProcessLauncher,
  makeCodexRuntime,
  type ProcessLedgerLike,
} from "./appServer.ts"
import { resolveCodexBinary, type ResolveCodexOptions } from "./binary.ts"
import { type CodexAuthLink, defaultUserCodexHome, prepareCodexHome } from "./codexHome.ts"
import { harnessError, toHarnessError } from "./errors.ts"
import type { ProtocolLogEvent } from "./protocol.ts"
import { DISPLAY_NAME, listModelsOn, runProbe } from "./probe.ts"
import { DEFAULT_SESSION_TIMEOUTS, HARNESS, openCodexSession } from "./Session.ts"

/** Declared, never faked (D2): what this driver actually implements. */
export const CODEX_CAPABILITIES: HarnessCapabilities = {
  resume: true,
  steer: true,
  interrupt: true,
  approvals: "interactive",
  questions: true,
  compact: true,
  contextUsage: true,
  images: true,
  // E: app-server on the brain, built-ins on the node through `environment/add`; B1 fallback:
  // `environments: []` + gateway node tools. H (app-server on the node) is not implemented.
  remotePlacements: ["codex-environment", "brain-mcp-hands"],
}

export interface CodexHarnessConfig extends ResolveCodexOptions {
  /** OpenBot's `CODEX_HOME`. Default: `DataDir.codexHome` (`<data>/codex-home`). */
  readonly codexHome?: string | undefined
  /** The user's Codex home holding `auth.json`. Default `$CODEX_HOME`, else `~/.codex`. */
  readonly userCodexHome?: string | undefined
  /** Symlink the user's `auth.json` into OpenBot's profile (default true). */
  readonly linkUserAuth?: boolean | undefined
  /** Extra environment for the app-server process. */
  readonly env?: Readonly<Record<string, string>> | undefined
  /** Inject the process launcher (tests: an in-memory fake app-server). */
  readonly launcher?: AppServerLauncher | undefined
  /** `mcp_servers.openbot.tool_timeout_sec` (default 900). */
  readonly mcpToolTimeoutSec?: number | undefined
  /** `mcp_servers.openbot.startup_timeout_sec` (default 30). */
  readonly mcpStartupTimeoutSec?: number | undefined
  /** Merged into every thread `config` (tests: a mock model provider). */
  readonly threadConfigExtra?: Readonly<Record<string, unknown>> | undefined
  /** Mount `<data>/skills-lib/skills` and disable every other skill per thread (default true). */
  readonly skills?: boolean | undefined
  readonly requestTimeout?: Duration.Input | undefined
  readonly openTimeout?: Duration.Input | undefined
  readonly compactTimeout?: Duration.Input | undefined
  readonly initializeTimeout?: Duration.Input | undefined
  readonly probeTimeout?: Duration.Input | undefined
  /** `model/list` results are reused for this long (default 10 minutes). */
  readonly modelsTtl?: Duration.Input | undefined
  /** `clientInfo.version` in `initialize`. */
  readonly clientVersion?: string | undefined
  /** Protocol tracing (messages may contain MCP bearer headers: redact before logging). */
  readonly log?: ((event: ProtocolLogEvent) => Effect.Effect<void>) | undefined
  readonly ensureDirectory?: ((path: string) => Promise<void>) | undefined
  /**
   * The account (profile) this driver instance serves. A profile = which `auth.json` backs the
   * OpenBot `CODEX_HOME`: the server gives each profile its own `codexHome`
   * (`<data>/codex-home/<profileId>`) and `userCodexHome` (the profile's config dir), so each
   * profile runs its own app-server. Absent = the default profile (`~/.codex`).
   */
  readonly profile?: { readonly id: string; readonly label?: string | undefined } | undefined
}

export interface CodexDriverDeps {
  readonly dataDir: DataDirShape
  readonly ledger?: ProcessLedgerLike | undefined
  /** Required unless `config.launcher` is given. */
  readonly launcher?: AppServerLauncher | undefined
}

/**
 * Builds the driver. The app-server runtime lives in the current scope (the layer's): nothing is
 * spawned until `probe`, `listModels` or `openSession`.
 */
export const makeCodexDriver = Effect.fnUntraced(function* (config: CodexHarnessConfig, deps: CodexDriverDeps) {
  const launcher = config.launcher ?? deps.launcher
  if (!launcher) return yield* Effect.die(new Error("harness-codex: no app-server launcher"))
  const codexHome = config.codexHome ?? deps.dataDir.codexHome
  const resolveBinary = () => resolveCodexBinary(config)
  const ensureDirectory =
    config.ensureDirectory ??
    (async (path: string) => {
      await mkdir(path, { recursive: true })
    })
  let authLink: CodexAuthLink | undefined

  const makeRuntime = makeCodexRuntime({
    binary: resolveBinary,
    launcher,
    codexHome,
    env: config.env,
    clientVersion: config.clientVersion,
    ledger: deps.ledger,
    initializeTimeout: config.initializeTimeout,
    log: config.log,
    beforeStart: prepareCodexHome({
      codexHome,
      userCodexHome: config.userCodexHome,
      linkUserAuth: config.linkUserAuth,
    }).pipe(
      Effect.tap((report) =>
        Effect.sync(() => {
          authLink = report.auth
        }),
      ),
      Effect.asVoid,
    ),
  })
  const runtimes = yield* RcMap.make<OwnerProfileId, CodexRuntime, never, Scope.Scope>({
    lookup: () => makeRuntime,
    // a profile's app-server stays until the layer closes
    idleTimeToLive: Duration.infinity,
  })
  const runtimeOf = (profileId: OwnerProfileId) => Effect.scoped(RcMap.get(runtimes, profileId))
  /** The main profile's: probes and model lists (the login is the same for every profile). */
  const runtime = yield* runtimeOf(MAIN_PROFILE_ID)

  const modelsTtl = Duration.toMillis(Duration.fromInputUnsafe(config.modelsTtl ?? Duration.minutes(10)))
  const models = yield* Ref.make<{ readonly at: number; readonly list: ReadonlyArray<ModelInfo> } | undefined>(
    undefined,
  )
  const remember = (list: ReadonlyArray<ModelInfo>) =>
    Effect.flatMap(Clock.currentTimeMillis, (at) => Ref.set(models, { at, list }))
  const timeouts = {
    requestTimeout: config.requestTimeout ?? DEFAULT_SESSION_TIMEOUTS.requestTimeout,
    openTimeout: config.openTimeout ?? DEFAULT_SESSION_TIMEOUTS.openTimeout,
    compactTimeout: config.compactTimeout ?? DEFAULT_SESSION_TIMEOUTS.compactTimeout,
  }

  const skillsRoot = (bot: Bot) => {
    if (config.skills === false) return undefined
    const root = joinPath(deps.dataDir.profile(bot.ownerProfileId).skillsLib, "skills")
    return existsSync(root) ? root : undefined
  }

  const profile = config.profile
  const userCodexHome = resolve(config.userCodexHome ?? defaultUserCodexHome())
  /** Stamps the profile on the probe's status (the server overlays the owner's label too). */
  const stamp = (status: HarnessStatus): HarnessStatus =>
    profile === undefined
      ? status
      : {
          ...status,
          profileId: profile.id,
          ...(profile.label !== undefined ? { profileLabel: profile.label } : {}),
          configDir: userCodexHome,
        }

  const driver: HarnessDriver = {
    kind: HARNESS,
    ...(profile !== undefined ? { profileId: profile.id } : {}),
    displayName: DISPLAY_NAME,
    capabilities: CODEX_CAPABILITIES,
    probe: runProbe({
      runtime,
      binary: resolveBinary,
      capabilities: CODEX_CAPABILITIES,
      timeout: config.probeTimeout,
      authLink: () => authLink,
      onModels: remember,
    }).pipe(Effect.map(stamp)),
    listModels: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const cached = yield* Ref.get(models)
      if (cached && now - cached.at < modelsTtl) return cached.list
      if (!resolveBinary()) return yield* harnessError("not-installed", "Codex is not installed.")
      const list = yield* runtime.withConnection((connection) =>
        listModelsOn(connection, timeouts.requestTimeout).pipe(
          Effect.mapError((error) => toHarnessError("other", error, "Codex could not list its models")),
        ),
      )
      yield* remember(list)
      return list
    }),
    openSession: (input) =>
      openCodexSession(input, {
        acquire: Effect.flatMap(runtimeOf(input.bot.ownerProfileId), (profileRuntime) => profileRuntime.acquire),
        threadConfig: {
          mcpToolTimeoutSec: config.mcpToolTimeoutSec,
          mcpStartupTimeoutSec: config.mcpStartupTimeoutSec,
          extra: config.threadConfigExtra,
        },
        ...timeouts,
        ensureDirectory,
        skillsRoot: skillsRoot(input.bot),
        isolateSkills: config.skills !== false,
      }),
    // the main profile's app-server also serves probes and model lists, and the main profile is never deleted
    forgetOwnerProfile: (profileId) =>
      profileId === MAIN_PROFILE_ID ? Effect.void : RcMap.invalidate(runtimes, profileId),
  }
  return driver
})

/** A `ProcessLedger` as the runtime's ledger hooks. */
export const ledgerOf = (ledger: ProcessLedger["Service"]): ProcessLedgerLike => ({
  record: (entry) => ledger.record(entry),
  remove: (pid) => ledger.remove(pid),
})

/** The driver with its dependencies from the context (`DataDir`, optional `ProcessLedger`). */
export const codexDriver = (config: CodexHarnessConfig = {}) =>
  Effect.gen(function* () {
    const dataDir = yield* DataDir
    const ledger = yield* Effect.serviceOption(ProcessLedger)
    // Built in the layer's scope: the spawner's services live as long as the driver.
    const launcher =
      config.launcher ??
      (yield* Effect.flatMap(Layer.build(BunServices.layer), (services) =>
        makeChildProcessLauncher.pipe(Effect.provideContext(services)),
      ))
    return yield* makeCodexDriver(config, {
      dataDir,
      launcher,
      ledger: Option.isSome(ledger) ? ledgerOf(ledger.value) : undefined,
    })
  })

/** Registers the Codex driver in `HarnessRegistry` (interfaces §2.1). */
export const CodexHarnessLive = (
  config: CodexHarnessConfig = {},
): Layer.Layer<never, never, HarnessRegistry | DataDir> => HarnessRegistry.registerLayer(codexDriver(config))

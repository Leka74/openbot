/**
 * Claude `HarnessDriver` (architecture §3.1, §4.5; D2.1, D2.6) and its registration layer.
 *
 * `ClaudeHarnessLive(config?)` registers the driver in `HarnessRegistry` for the layer's lifetime.
 * It needs `DataDir` (bot memory directory, skills library, attachments) and uses `ProcessLedger`
 * when it is provided (CLI pids for boot recovery, D2.5).
 */
import type { HarnessCapabilities, HarnessStatus, ModelInfo } from "@openbot/contracts"
import {
  type DataDirShape,
  HarnessError,
  type HarnessDriver,
  HarnessRegistry,
  joinPath,
  ProcessLedger,
} from "@openbot/core"
import { botSkillsPlugin } from "./skillsPlugin.ts"
import { DataDir } from "@openbot/core"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { Effect, Layer, Option, Ref } from "effect"
import { cleanEnv, DEFAULT_MCP_TIMEOUT_MS } from "./config.ts"
import { bunReadFile, type ReadFile } from "./input.ts"
import { PROBE_TIMEOUT_MS, runProbe } from "./probe.ts"
import { type ClaudeProfile, profileEnv } from "./profile.ts"
import { type ClaudeQueryFunction, defaultQuery } from "./sdk.ts"
import { HARNESS, ledgerHooks, openClaudeSession, type SessionDeps } from "./Session.ts"

/** Declared, never faked (D2): what this driver actually implements. */
export const CLAUDE_CAPABILITIES: HarnessCapabilities = {
  resume: true,
  steer: true,
  interrupt: true,
  approvals: "interactive",
  questions: true,
  compact: true,
  contextUsage: true,
  images: true,
  // B1: CLI on the brain, built-ins off, gateway node tools. R1 (CLI on the node) is not implemented.
  remotePlacements: ["brain-mcp-hands"],
}

export interface ClaudeHarnessConfig {
  /** Inject a fake `query()` (tests). Default: the SDK's. */
  readonly query?: ClaudeQueryFunction | undefined
  /**
   * Claude Code CLI: an absolute path, `"bundled"` for the SDK's bundled CLI, or undefined for the
   * user's `claude` on PATH when present, else the bundled one (D2.1).
   */
  readonly executable?: string | undefined
  /** Base environment (default `process.env`); cleaned with `cleanEnv`. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  /**
   * Claude's native auto-memory. "off" (default): `autoMemoryEnabled: false` — OpenBot already puts
   * the bot's `MEMORY.md` index in the instructions and the gateway's `remember`/`forget` tools keep
   * it (D5.4), so native memory would inject the index twice and write facts OpenBot never announces.
   * "native": `autoMemoryDirectory` = the bot's memory directory (same on-disk format, D2.1).
   */
  readonly memory?: "native" | "off" | undefined
  /** Mount the Bot's skills from `<data>/skills-lib` as its own local plugin (default true; D5.5). */
  readonly skills?: boolean | undefined
  /** "process-group" (default on POSIX): detached CLI, group-killed on close. "sdk": SDK spawns. */
  readonly spawn?: "process-group" | "sdk" | undefined
  readonly mcpTimeoutMs?: number | undefined
  readonly mcpRegistrationTimeoutMs?: number | undefined
  readonly interruptTimeoutMs?: number | undefined
  /** How long session close waits for the CLI to exit before SIGKILLing its process group (default 5 s). */
  readonly closeTimeoutMs?: number | undefined
  readonly probeTimeoutMs?: number | undefined
  /** `CLAUDE_AGENT_SDK_CLIENT_APP` (User-Agent). */
  readonly clientApp?: string | undefined
  /** Native ids (session ids, message uuids). Default `crypto.randomUUID`. */
  readonly newUuid?: (() => string) | undefined
  readonly readFile?: ReadFile | undefined
  readonly ensureDirectory?: ((path: string) => Promise<void>) | undefined
  /**
   * The account (profile) this driver instance runs with: its CLI (sessions and probe) gets
   * `CLAUDE_CONFIG_DIR=<configDir>` (see `profileEnv`). Absent = the default profile: the brain's
   * environment unchanged. `HOME` is never changed and credentials are never read or copied.
   */
  readonly profile?: ClaudeProfile | undefined
  /** `$HOME` used to recognize `~/.claude` (tests). */
  readonly home?: string | undefined
}

/** Resolves `pathToClaudeCodeExecutable` (undefined = SDK bundled CLI). */
export const resolveExecutable = (configured: string | undefined): string | undefined => {
  if (configured === "bundled") return undefined
  if (configured !== undefined) return configured
  return Bun.which("claude") ?? undefined
}

export interface DriverDeps {
  readonly dataDir: DataDirShape
  readonly ledger?: SessionDeps["ledger"]
}

/** Builds the driver (pure construction; no process is started until `probe`/`openSession`). */
export const makeClaudeDriver = (config: ClaudeHarnessConfig, deps: DriverDeps): Effect.Effect<HarnessDriver> =>
  Effect.gen(function* () {
    const query = config.query ?? defaultQuery
    const executable = resolveExecutable(config.executable)
    const env = profileEnv(cleanEnv(config.env ?? process.env, {}, config.clientApp), config.profile, config.home)
    const profile = config.profile
    /** Stamps the profile on the probe's status (the server overlays the owner's label too). */
    const stamp = (status: HarnessStatus): HarnessStatus =>
      profile === undefined
        ? status
        : {
            ...status,
            profileId: profile.id,
            ...(profile.label !== undefined ? { profileLabel: profile.label } : {}),
            configDir: profile.configDir,
          }
    const ensureDirectory =
      config.ensureDirectory ??
      (async (path: string) => {
        await mkdir(path, { recursive: true })
      })
    const models = yield* Ref.make<ReadonlyArray<ModelInfo> | undefined>(undefined)

    const probeOnce = runProbe({
      query,
      env,
      executable,
      cwd: tmpdir(),
      timeoutMs: config.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
      capabilities: CLAUDE_CAPABILITIES,
    }).pipe(Effect.tap((result) => (result.models ? Ref.set(models, result.models) : Effect.void)))

    const driver: HarnessDriver = {
      kind: "claude",
      ...(profile !== undefined ? { profileId: profile.id } : {}),
      displayName: "Claude",
      capabilities: CLAUDE_CAPABILITIES,
      probe: Effect.map(probeOnce, (result) => stamp(result.status)),
      listModels: Effect.gen(function* () {
        const cached = yield* Ref.get(models)
        if (cached) return cached
        const result = yield* probeOnce
        if (result.models) return result.models
        return yield* Effect.fail(
          new HarnessError({
            harness: HARNESS,
            code: result.status.installed ? "other" : "not-installed",
            message: result.status.problems[0] ?? "Claude models are unavailable.",
          }),
        )
      }),
      openSession: (input) => {
        const profile = deps.dataDir.profile(input.bot.ownerProfileId)
        let skillsLibrary: string | undefined
        try {
          skillsLibrary =
            (config.skills ?? true)
              ? botSkillsPlugin({
                  root: joinPath(deps.dataDir.botDir(input.bot.id), "skills-plugin"),
                  library: profile.skillsLib,
                  skills: input.bot.skills,
                })
              : undefined
        } catch {
          // without its skills the Bot still works; the next session open retries
          skillsLibrary = undefined
        }
        const sessionDeps: SessionDeps = {
          query,
          env,
          executable,
          memoryDirectory: config.memory === "native" ? deps.dataDir.memoryDir(input.bot.id) : undefined,
          skillsLibrary,
          // Uploaded attachments are referenced by path in the turn text (input.ts).
          additionalDirectories: [profile.attachments],
          mcpTimeoutMs: config.mcpTimeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
          mcpRegistrationTimeoutMs: config.mcpRegistrationTimeoutMs ?? 15_000,
          interruptTimeoutMs: config.interruptTimeoutMs ?? 10_000,
          closeTimeoutMs: config.closeTimeoutMs ?? 5_000,
          newUuid: config.newUuid ?? (() => crypto.randomUUID()),
          readFile: config.readFile ?? bunReadFile,
          ensureDirectory,
          spawn: config.spawn ?? "process-group",
          ledger: deps.ledger,
        }
        return openClaudeSession(input, sessionDeps)
      },
    }
    return driver
  })

/** The driver with its dependencies taken from the context (`DataDir`, optional `ProcessLedger`). */
export const claudeDriver = (config: ClaudeHarnessConfig = {}): Effect.Effect<HarnessDriver, never, DataDir> =>
  Effect.gen(function* () {
    const dataDir = yield* DataDir
    const ledger = yield* Effect.serviceOption(ProcessLedger)
    return yield* makeClaudeDriver(config, {
      dataDir,
      ledger: Option.isSome(ledger) ? ledgerHooks(ledger.value) : undefined,
    })
  })

/** Registers the Claude driver in `HarnessRegistry` (interfaces §2.1). */
export const ClaudeHarnessLive = (
  config: ClaudeHarnessConfig = {},
): Layer.Layer<never, never, HarnessRegistry | DataDir> => HarnessRegistry.registerLayer(claudeDriver(config))

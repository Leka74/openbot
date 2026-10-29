/**
 * Harness accounts ("profiles") on the brain (user request: several Claude logins on one machine).
 *
 * - Every registered harness has an implicit DEFAULT profile (`"default"`): the driver registered
 *   by `harnessDrivers` with no profile id, i.e. today's behavior (Claude: no `CLAUDE_CONFIG_DIR`
 *   override; Codex: `<data>/codex-home` linked to `~/.codex`).
 * - Added profiles are stored in the settings repo (`brain.harnessProfiles`, a JSON array) and each
 *   gets its own driver instance, registered in `HarnessRegistry` under (kind, profileId) inside its
 *   own scope: adding/removing an account needs no restart. Claude: the CLI runs with
 *   `CLAUDE_CONFIG_DIR=<configDir>`. Codex: its own app-server on `<data>/codex-home/<profileId>`
 *   with `auth.json` symlinked to `<configDir>/auth.json`. OpenCode/fake: default profile only.
 * - First boot (per harness kind, `brain.harnessProfiles.seeded`): discovered config dirs
 *   (`~/.claude-*`, `~/.codex-*` with a login) are added automatically. Afterwards the owner manages
 *   them in Settings › Harnesses (`harnesses.addProfile` / `removeProfile` / `discover`).
 * - Removing a profile is REFUSED (Conflict) while a bot uses it: silently moving a bot to another
 *   login would bill another account. The owner moves the bots first (details › Brain).
 *
 * Policy: OpenBot only points the owner's own CLI at the owner's own config dir on this machine. It
 * never reads, copies or forwards credentials and never changes `HOME` (AGENTS.md, D0.2, D2.1).
 * Discovery reads only Claude's non-secret `.claude.json` account metadata for a label.
 */
import {
  Conflict,
  DEFAULT_HARNESS_PROFILE_ID,
  Forbidden,
  type HarnessProfile,
  HarnessProfile as HarnessProfileSchema,
  type HarnessProfileCandidate,
  type HarnessStatus,
  InvalidInput,
  normalizeProfileId,
  NotFound,
} from "@openbot/contracts"
import {
  BotRepo,
  type CurrentProfile,
  currentProfileId,
  DataDir,
  type HarnessDriver,
  HarnessRegistry,
  IdGen,
  SettingsRepo,
} from "@openbot/core"
import {
  claudeDriver,
  defaultClaudeConfigDir,
  discoverClaudeConfigDirs,
  looksLikeClaudeConfigDir,
} from "@openbot/harness-claude"
import { codexDriver, discoverCodexHomes, looksLikeCodexHome, profileCodexHome } from "@openbot/harness-codex"
import { Cause, Clock, Context, Effect, Exit, Layer, Option, Schema, Scope, Semaphore } from "effect"
import { statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"
import { OPENBOT_VERSION, ServerConfig, type ServerConfigShape } from "./config.ts"

export const PROFILES_KEY = "brain.harnessProfiles"
export const PROFILES_SEEDED_KEY = "brain.harnessProfiles.seeded"
/** Harness kinds that support more than their default account. */
export const PROFILE_KINDS: ReadonlyArray<string> = ["claude", "codex"]
const KIND_ORDER = ["claude", "codex", "opencode", "fake"]
const MAX_LABEL = 64

type Env = Readonly<Record<string, string | undefined>>

/** Builds the driver of an added profile, or `undefined` when its kind has no accounts. */
export type ProfileDriverFactory = (
  profile: HarnessProfile,
) => Effect.Effect<HarnessDriver, never, Scope.Scope | DataDir> | undefined

export interface ProfileOptions {
  /** `$HOME` for discovery and `~` expansion (default: the OS home). */
  readonly home?: string | undefined
  /** Environment for the default config dirs (default `process.env`). */
  readonly env?: Env | undefined
  /** Replaces the live Claude/Codex drivers of added profiles (tests). */
  readonly driverFor?: ProfileDriverFactory | undefined
  /** Auto-add discovered accounts on first boot (default true). */
  readonly seed?: boolean | undefined
}

// ============================================================================ pure helpers

const kindRank = (kind: string) => (KIND_ORDER.includes(kind) ? KIND_ORDER.indexOf(kind) : KIND_ORDER.length)
const displayKind = (kind: string) => (kind === "opencode" ? "OpenCode" : kind.charAt(0).toUpperCase() + kind.slice(1))

/** `~` / `~/x` → absolute; trims; `undefined` for relative paths. */
export const expandConfigDir = (raw: string, home: string): string | undefined => {
  const trimmed = raw.trim()
  if (trimmed === "") return undefined
  const expanded = trimmed === "~" ? home : trimmed.startsWith("~/") ? join(home, trimmed.slice(2)) : trimmed
  return isAbsolute(expanded) ? resolve(expanded) : undefined
}

/** The config dir the DEFAULT profile of `kind` uses (`undefined` when the kind has none). */
export const defaultConfigDirOf = (kind: string, env: Env, home: string): string | undefined => {
  if (kind === "claude") return defaultClaudeConfigDir(env, home)
  if (kind === "codex")
    return resolve(env.CODEX_HOME && env.CODEX_HOME.trim() !== "" ? env.CODEX_HOME : join(home, ".codex"))
  return undefined
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Candidates of `kind` in `home` (including the default's dir, flagged). */
export const discoverDirs = async (
  kind: string,
  home: string,
  env: Env,
): Promise<ReadonlyArray<HarnessProfileCandidate & { readonly isDefault: boolean }>> => {
  if (kind === "claude") {
    return (await discoverClaudeConfigDirs({ home, env })).map((c) => ({
      kind,
      configDir: c.configDir,
      suggestedLabel: c.suggestedLabel,
      isDefault: c.isDefault,
      ...(c.account ? { account: c.account } : {}),
    }))
  }
  if (kind === "codex") {
    return discoverCodexHomes({ home, env }).map((c) => ({
      kind,
      configDir: c.configDir,
      suggestedLabel: c.suggestedLabel,
      isDefault: c.isDefault,
    }))
  }
  return []
}

const decodeProfiles = Schema.decodeUnknownOption(Schema.Array(HarnessProfileSchema))
const encodeProfiles = Schema.encodeSync(Schema.Array(HarnessProfileSchema))

/** The live drivers of added profiles (same options as the default drivers in server.ts). */
export const liveProfileDrivers =
  (config: ServerConfigShape): ProfileDriverFactory =>
  (profile) => {
    if (profile.configDir === undefined) return undefined
    const configDir = profile.configDir
    if (profile.kind === "claude") {
      return claudeDriver({
        executable: config.claudePath ?? "bundled",
        clientApp: `openbot/${OPENBOT_VERSION}`,
        profile: { id: profile.id, label: profile.label, configDir },
      })
    }
    if (profile.kind === "codex") {
      return Effect.flatMap(DataDir, (dataDir) =>
        codexDriver({
          clientVersion: OPENBOT_VERSION,
          codexHome: profileCodexHome(dataDir.codexHome, profile.id),
          userCodexHome: configDir,
          profile: { id: profile.id, label: profile.label },
        }),
      )
    }
    return undefined
  }

// ============================================================================ service

export interface HarnessProfilesShape {
  /** The default profile of every registered harness, then the added ones (optionally of one kind). */
  readonly list: (kind?: string | undefined) => Effect.Effect<ReadonlyArray<HarnessProfile>>
  readonly add: (input: {
    readonly kind: string
    readonly label: string
    readonly configDir: string
  }) => Effect.Effect<HarnessProfile, InvalidInput | Conflict>
  readonly remove: (profileId: string) => Effect.Effect<void, NotFound | Conflict | Forbidden, CurrentProfile>
  /** Config dirs of `kind` that look like logins and are neither the default nor added yet. */
  readonly discover: (kind: string) => Effect.Effect<ReadonlyArray<HarnessProfileCandidate>>
  /** One status per registered (kind, profile), with the profile's id, label and config dir. */
  readonly status: (
    probe: (driver: HarnessDriver) => Effect.Effect<HarnessStatus>,
  ) => Effect.Effect<ReadonlyArray<HarnessStatus>>
}

export class HarnessProfiles extends Context.Service<HarnessProfiles, HarnessProfilesShape>()(
  "openbot/server/HarnessProfiles",
) {}

export const HarnessProfilesLayer = (
  options?: ProfileOptions,
): Layer.Layer<HarnessProfiles, never, ServerConfig | HarnessRegistry | SettingsRepo | BotRepo | IdGen | DataDir> =>
  Layer.effect(
    HarnessProfiles,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const registry = yield* HarnessRegistry
      const settings = yield* SettingsRepo
      const bots = yield* BotRepo
      const ids = yield* IdGen
      const home = options?.home ?? homedir()
      const env: Env = options?.env ?? process.env
      const driverFor = options?.driverFor ?? liveProfileDrivers(config)
      // Drivers are built with the brain's context (DataDir, ProcessLedger, …) in a child of this scope.
      const context = yield* Effect.context<DataDir>()
      const layerScope = yield* Effect.scope
      const lock = yield* Semaphore.make(1)
      const active = new Map<string, Scope.Closeable>()

      const load = Effect.map(Effect.orDie(settings.get(PROFILES_KEY)), (raw) =>
        Option.isSome(raw) ? Option.getOrElse(decodeProfiles(raw.value), (): ReadonlyArray<HarnessProfile> => []) : [],
      )
      const save = (profiles: ReadonlyArray<HarnessProfile>) =>
        Effect.orDie(settings.set(PROFILES_KEY, encodeProfiles(profiles)))

      const enabled = (kind: string) => (config.harnesses as ReadonlyArray<string>).includes(kind)

      /** Registers the profile's driver in its own scope (no-op when the kind is disabled). */
      const activate = (profile: HarnessProfile) =>
        Effect.gen(function* () {
          if (!enabled(profile.kind) || active.has(profile.id)) return
          const build = driverFor(profile)
          if (build === undefined) return
          const scope = yield* Scope.fork(layerScope)
          const exit = yield* Effect.exit(
            Effect.flatMap(build, (driver) => registry.register(driver)).pipe(
              Scope.provide(scope),
              Effect.provideContext(context),
            ),
          )
          if (Exit.isFailure(exit)) {
            yield* Scope.close(scope, Exit.void)
            yield* Effect.logWarning(
              `Could not start the ${displayKind(profile.kind)} account "${profile.label}"`,
              Cause.pretty(exit.cause),
            )
            return
          }
          active.set(profile.id, scope)
        })

      const deactivate = (profileId: string) =>
        Effect.gen(function* () {
          const scope = active.get(profileId)
          if (scope === undefined) return
          active.delete(profileId)
          yield* Scope.close(scope, Exit.void)
        })

      const defaults = Effect.map(registry.list, (drivers) =>
        drivers
          .filter((d) => normalizeProfileId(d.profileId) === undefined)
          .map((d): HarnessProfile => {
            const dir = defaultConfigDirOf(d.kind, env, home)
            return {
              id: DEFAULT_HARNESS_PROFILE_ID,
              kind: d.kind,
              label: "Default",
              ...(dir !== undefined ? { configDir: dir } : {}),
              isDefault: true,
              createdAt: 0,
            }
          }),
      )

      const sortProfiles = (profiles: ReadonlyArray<HarnessProfile>) =>
        [...profiles].sort(
          (a, b) =>
            kindRank(a.kind) - kindRank(b.kind) ||
            a.kind.localeCompare(b.kind) ||
            Number(b.isDefault === true) - Number(a.isDefault === true) ||
            a.createdAt - b.createdAt,
        )

      const list = (kind?: string) =>
        Effect.gen(function* () {
          const all = sortProfiles([...(yield* defaults), ...(yield* load)])
          return kind === undefined ? all : all.filter((p) => p.kind === kind)
        })

      const discover = (kind: string) =>
        Effect.gen(function* () {
          const taken = new Set((yield* load).filter((p) => p.kind === kind).map((p) => p.configDir))
          const found = yield* Effect.promise(() => discoverDirs(kind, home, env))
          return found
            .filter((c) => !c.isDefault && !taken.has(c.configDir))
            .map(({ isDefault: _drop, ...candidate }): HarnessProfileCandidate => candidate)
        })

      const insert = (kind: string, label: string, configDir: string) =>
        Effect.gen(function* () {
          const profile: HarnessProfile = {
            id: yield* ids.next("hpf"),
            kind,
            label,
            configDir,
            createdAt: yield* Clock.currentTimeMillis,
          }
          yield* save([...(yield* load), profile])
          yield* activate(profile)
          return profile
        })

      const add = (input: { readonly kind: string; readonly label: string; readonly configDir: string }) =>
        lock.withPermit(
          Effect.gen(function* () {
            if (!PROFILE_KINDS.includes(input.kind)) {
              return yield* new InvalidInput({
                message: `${displayKind(input.kind)} supports only its default account for now.`,
              })
            }
            const configDir = expandConfigDir(input.configDir, home)
            if (configDir === undefined)
              return yield* new InvalidInput({
                message: "Enter the full path of the account's config folder (for example ~/.claude-2).",
              })
            if (!isDirectory(configDir))
              return yield* new InvalidInput({ message: `${configDir} is not a folder on the server.` })
            const label = input.label.trim() === "" ? basename(configDir).replace(/^\./, "") : input.label.trim()
            if (label.length > MAX_LABEL)
              return yield* new InvalidInput({ message: `The label is longer than ${MAX_LABEL} characters.` })
            if (/[\r\n]/.test(label)) return yield* new InvalidInput({ message: "The label must be one line." })
            if (configDir === defaultConfigDirOf(input.kind, env, home)) {
              return yield* new Conflict({
                reason: `${configDir} is already the default ${displayKind(input.kind)} account.`,
              })
            }
            const existing = (yield* load).find((p) => p.kind === input.kind && p.configDir === configDir)
            if (existing !== undefined)
              return yield* new Conflict({ reason: `${configDir} is already added as "${existing.label}".` })
            return yield* insert(input.kind, label, configDir)
          }),
        )

      const remove = (profileId: string) =>
        lock.withPermit(
          Effect.gen(function* () {
            if (normalizeProfileId(profileId) === undefined)
              return yield* new Forbidden({ reason: "The default account cannot be removed." })
            const profiles = yield* load
            const profile = profiles.find((p) => p.id === profileId)
            if (profile === undefined) return yield* new NotFound({ entity: "harness profile", id: profileId })
            const users = (yield* Effect.orDie(bots.list)).filter(
              (b) => b.harness.kind === profile.kind && b.harness.profileId === profileId,
            )
            if (users.length > 0) {
              const current = yield* currentProfileId
              const names = users.filter((b) => b.ownerProfileId === current).map((b) => b.name)
              const elsewhere = users.length - names.length
              if (elsewhere > 0)
                names.push(elsewhere === 1 ? "1 Bot in another profile" : `${elsewhere} Bots in other profiles`)
              const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
              const one = users.length === 1
              return yield* new Conflict({
                reason: `${who} ${one ? "uses" : "use"} this account. Move ${one ? "it" : "them"} to another account first.`,
              })
            }
            yield* deactivate(profileId)
            yield* save(profiles.filter((p) => p.id !== profileId))
          }),
        )

      const status = (probe: (driver: HarnessDriver) => Effect.Effect<HarnessStatus>) =>
        Effect.gen(function* () {
          const drivers = yield* registry.list
          const stored = new Map((yield* load).map((p) => [p.id, p] as const))
          const statuses = yield* Effect.forEach(
            drivers,
            (driver) =>
              Effect.map(probe(driver), (s): HarnessStatus => {
                const id = normalizeProfileId(driver.profileId)
                const profile = id === undefined ? undefined : stored.get(id)
                const dir =
                  id === undefined ? defaultConfigDirOf(driver.kind, env, home) : (profile?.configDir ?? s.configDir)
                return {
                  ...s,
                  profileId: id ?? DEFAULT_HARNESS_PROFILE_ID,
                  profileLabel: id === undefined ? "Default" : (profile?.label ?? s.profileLabel ?? id),
                  ...(dir !== undefined ? { configDir: dir } : {}),
                }
              }),
            { concurrency: "unbounded" },
          )
          const order = new Map((yield* list()).map((p, i) => [`${p.kind}/${p.id}`, i] as const))
          const rank = (s: HarnessStatus) => order.get(`${s.kind}/${s.profileId}`) ?? Number.MAX_SAFE_INTEGER
          return [...statuses].sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || rank(a) - rank(b))
        })

      // ------------------------------------------------------------------ boot: seed, then activate
      if (options?.seed !== false) {
        const seededRaw = yield* Effect.orDie(settings.get(PROFILES_SEEDED_KEY))
        const seeded = new Set(
          Option.isSome(seededRaw) && Array.isArray(seededRaw.value)
            ? seededRaw.value.filter((k): k is string => typeof k === "string")
            : [],
        )
        const toSeed = PROFILE_KINDS.filter((kind) => enabled(kind) && !seeded.has(kind))
        for (const kind of toSeed) {
          const found = yield* discover(kind)
          for (const candidate of found) {
            // the same checks as harnesses.addProfile, then the driver starts below
            const valid =
              kind === "claude"
                ? looksLikeClaudeConfigDir(candidate.configDir, home)
                : looksLikeCodexHome(candidate.configDir)
            if (!valid) continue
            const profile: HarnessProfile = {
              id: yield* ids.next("hpf"),
              kind,
              label: candidate.suggestedLabel,
              configDir: candidate.configDir,
              createdAt: yield* Clock.currentTimeMillis,
            }
            yield* save([...(yield* load), profile])
            yield* Effect.logInfo(`Added the ${displayKind(kind)} account "${profile.label}" (${candidate.configDir})`)
          }
          seeded.add(kind)
        }
        if (toSeed.length > 0) yield* Effect.orDie(settings.set(PROFILES_SEEDED_KEY, [...seeded].sort()))
      }
      for (const profile of yield* load) yield* activate(profile)

      return HarnessProfiles.of({ list, add, remove, discover, status })
    }),
  )

/**
 * Restart guard (seen in practice: a recovery helper restarted the brain about 120 times in 21
 * minutes; every restart cut off running work, spent the tasks' restart budget and resumed every
 * cut-off bot again, only to be cut off once more).
 *
 * - Boot history (`<data>/boot-history.json`): when each boot of the last hour started.
 * - Restart storm: `stormBoots` boots within `stormWindowMs`, this one included. The brain then waits
 *   `stormHoldMs` BEFORE boot recovery: stopped again meanwhile, it has changed nothing (no task run
 *   again, no restart budget spent, no turn resumed); still up after it, it recovers everything once.
 * - Drains (SIGUSR2, drain.ts) are refused while the brain is younger than `minUptimeMs`, or after
 *   `maxBootsPerHour` boots in the last hour, unless `drain.json` says `"force": true`. The outcome of
 *   every drain request is written to `<data>/drain-result.json` for the helper that asked.
 *
 * On by default for the CLI brain (`main.ts`); `OPENBOT_RESTART_GUARD=off` turns it off. Tests boot
 * without it (no `restartGuard` in their config).
 */
import { chmod, rename } from "node:fs/promises"
import { join } from "node:path"

export interface RestartGuardOptions {
  /** This many boots within `stormWindowMs` (this one included) make a restart storm… */
  readonly stormBoots: number
  readonly stormWindowMs: number
  /** …and the brain waits this long before boot recovery. */
  readonly stormHoldMs: number
  /** A drain is refused while the brain has been up less than this. */
  readonly minUptimeMs: number
  /** A drain is refused after this many boots in the last hour. */
  readonly maxBootsPerHour: number
}

export const DEFAULT_RESTART_GUARD: RestartGuardOptions = {
  stormBoots: 4,
  stormWindowMs: 5 * 60_000,
  stormHoldMs: 60_000,
  minUptimeMs: 2 * 60_000,
  maxBootsPerHour: 6,
}

/** `OPENBOT_RESTART_GUARD=off` (or `0`, `false`) turns the guard off. */
export const restartGuardFromEnv = (env: Record<string, string | undefined>): RestartGuardOptions | undefined => {
  const value = env["OPENBOT_RESTART_GUARD"]?.trim().toLowerCase()
  return value === "off" || value === "0" || value === "false" ? undefined : DEFAULT_RESTART_GUARD
}

export const BOOT_HISTORY_FILE = "boot-history.json"
export const DRAIN_RESULT_FILE = "drain-result.json"

const HOUR_MS = 60 * 60_000

// ============================================================================ rules (pure)

/** The boots of the last hour, oldest first. */
export const recentBoots = (boots: ReadonlyArray<number>, now: number): ReadonlyArray<number> =>
  boots.filter((t) => Number.isFinite(t) && t > now - HOUR_MS && t <= now).sort((a, b) => a - b)

/** How long to wait before boot recovery (0 = no storm). `boots` includes this boot. */
export const stormHoldMs = (boots: ReadonlyArray<number>, now: number, options: RestartGuardOptions): number =>
  boots.filter((t) => t > now - options.stormWindowMs && t <= now).length >= options.stormBoots
    ? options.stormHoldMs
    : 0

/** Why a drain must not happen now, or undefined when it may. */
export const drainRefusal = (
  input: {
    readonly boots: ReadonlyArray<number>
    readonly bootedAt: number
    readonly now: number
    readonly force: boolean
  },
  options: RestartGuardOptions,
): string | undefined => {
  if (input.force) return undefined
  const upMs = input.now - input.bootedAt
  if (upMs < options.minUptimeMs) {
    return `the brain has been up ${Math.round(upMs / 1000)} s; another restart needs at least ${Math.round(options.minUptimeMs / 1000)} s`
  }
  const lastHour = recentBoots(input.boots, input.now).length
  if (lastHour >= options.maxBootsPerHour) {
    return `${lastHour} boots in the last hour; at most ${options.maxBootsPerHour} are allowed`
  }
  return undefined
}

// ============================================================================ files

const writePrivate = async (path: string, text: string) => {
  const temp = `${path}.${process.pid}.tmp`
  await Bun.write(temp, text)
  await chmod(temp, 0o600)
  await rename(temp, path)
}

export const readBootHistory = async (dataDir: string): Promise<ReadonlyArray<number>> => {
  try {
    const parsed = JSON.parse(await Bun.file(join(dataDir, BOOT_HISTORY_FILE)).text()) as { boots?: unknown }
    return Array.isArray(parsed.boots) ? parsed.boots.filter((t): t is number => typeof t === "number") : []
  } catch {
    return []
  }
}

/** Adds this boot to the history (keeping the last hour); returns the history, oldest first. */
export const recordBoot = async (dataDir: string, now: number): Promise<ReadonlyArray<number>> => {
  const boots = recentBoots([...(await readBootHistory(dataDir)), now], now)
  try {
    await writePrivate(join(dataDir, BOOT_HISTORY_FILE), `${JSON.stringify({ boots })}\n`)
  } catch {
    // the guard never stops a boot
  }
  return boots
}

export interface DrainResult {
  readonly status: "refused" | "draining" | "drained"
  readonly at: number
  readonly pid: number
  readonly reason?: string | undefined
}

export const writeDrainResult = async (dataDir: string, result: DrainResult): Promise<void> => {
  try {
    await writePrivate(join(dataDir, DRAIN_RESULT_FILE), `${JSON.stringify(result)}\n`)
  } catch {
    // best effort: the log says the same
  }
}

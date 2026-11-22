/**
 * Restart guard (restartGuard.ts): a restart storm — a recovery helper restarted the brain every
 * ~11 s for 21 minutes — must cost no work: boot recovery waits out a storm, drains are rate-limited.
 */
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readDrainRequest } from "../src/drain.ts"
import {
  BOOT_HISTORY_FILE,
  DEFAULT_RESTART_GUARD,
  drainRefusal,
  readBootHistory,
  recentBoots,
  recordBoot,
  restartGuardFromEnv,
  stormHoldMs,
} from "../src/restartGuard.ts"
import { BootRecovery } from "@openbot/core"
import { Effect, Layer } from "effect"
import { ServerConfig } from "../src/config.ts"
import { BootReportLive } from "../src/server.ts"

const MIN = 60_000
const guard = DEFAULT_RESTART_GUARD

describe("restart storms", () => {
  test("a boot after three others within five minutes waits before recovery; a normal restart does not", () => {
    const now = 100 * MIN
    // a boot every ~11 s
    const storm = [now - 33_000, now - 22_000, now - 11_000, now]
    expect(stormHoldMs(storm, now, guard)).toBe(guard.stormHoldMs)
    // a deploy, then a fix-up restart a few minutes later
    expect(stormHoldMs([now - 20 * MIN, now - 3 * MIN, now], now, guard)).toBe(0)
    // the four boots spread over more than the window
    expect(stormHoldMs([now - 6 * MIN, now - 4 * MIN, now - 2 * MIN, now], now, guard)).toBe(0)
  })

  test("the history keeps the last hour, oldest first", () => {
    const now = 100 * MIN
    expect(recentBoots([now, now - 2 * 60 * MIN, now - 10 * MIN, Number.NaN, now + 1], now)).toEqual([
      now - 10 * MIN,
      now,
    ])
  })

  test("boots are recorded in a private file; a missing or broken file is an empty history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-guard-"))
    try {
      expect(await readBootHistory(dir)).toEqual([])
      await Bun.write(join(dir, BOOT_HISTORY_FILE), "{not json")
      expect(await readBootHistory(dir)).toEqual([])
      const now = 100 * MIN
      await recordBoot(dir, now - 70 * MIN)
      await recordBoot(dir, now - 5 * MIN)
      expect(await recordBoot(dir, now)).toEqual([now - 5 * MIN, now])
      expect((await stat(join(dir, BOOT_HISTORY_FILE))).mode & 0o777).toBe(0o600)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("boot recovery in a storm", () => {
  const bootOnce = async (dir: string) => {
    const started = Date.now()
    let recoveredAt = 0
    const empty = {
      killedProcesses: [],
      interruptedTurns: [],
      cutOffTurns: [],
      expiredRequests: [],
      updatedEntries: [],
      interruptedRuns: [],
      interruptedTasks: [],
    }
    const recovery = Layer.succeed(BootRecovery, {
      run: Effect.sync(() => {
        recoveredAt = Date.now()
        return empty
      }),
    })
    const config = ServerConfig.layer({
      dataDir: dir,
      port: 0,
      host: "127.0.0.1",
      publicOrigins: [],
      localNode: false,
      dev: false,
      harnesses: ["fake"],
      claudePath: undefined,
      restartGuard: { ...guard, stormHoldMs: 300 },
    })
    await Effect.runPromise(
      Effect.scoped(Layer.build(BootReportLive.pipe(Layer.provide(Layer.merge(recovery, config))))),
    )
    return recoveredAt - started
  }

  test("waits before recovering after the fourth quick boot, not before", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-storm-"))
    try {
      for (let i = 0; i < 3; i++) expect(await bootOnce(dir)).toBeLessThan(250)
      expect(await bootOnce(dir)).toBeGreaterThanOrEqual(290)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("drains", () => {
  const now = 300 * MIN

  test("refused right after a boot and after too many boots in an hour; force overrides", () => {
    const young = drainRefusal({ boots: [now - 30_000], bootedAt: now - 30_000, now, force: false }, guard)
    expect(young).toContain("up 30 s")
    const busyHour = Array.from({ length: guard.maxBootsPerHour }, (_, i) => now - (50 - i * 5) * MIN)
    const many = drainRefusal({ boots: busyHour, bootedAt: now - 10 * MIN, now, force: false }, guard)
    expect(many).toContain(`${guard.maxBootsPerHour} boots in the last hour`)
    expect(drainRefusal({ boots: busyHour, bootedAt: now - 30_000, now, force: true }, guard)).toBeUndefined()
  })

  test("allowed for a brain that has been up a while", () => {
    expect(drainRefusal({ boots: [now - 40 * MIN], bootedAt: now - 40 * MIN, now, force: false }, guard)).toBe(
      undefined,
    )
  })

  test("drain.json gives the grace and force, and is removed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-drain-"))
    try {
      await Bun.write(join(dir, "drain.json"), JSON.stringify({ graceMs: 15_000, force: true }))
      expect(await Effect.runPromise(readDrainRequest(dir))).toEqual({ graceMs: 15_000, force: true })
      expect(await Bun.file(join(dir, "drain.json")).exists()).toBe(false)
      expect(await Effect.runPromise(readDrainRequest(dir))).toEqual({ graceMs: 3 * MIN, force: false })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("on unless OPENBOT_RESTART_GUARD=off", () => {
    expect(restartGuardFromEnv({})).toEqual(DEFAULT_RESTART_GUARD)
    expect(restartGuardFromEnv({ OPENBOT_RESTART_GUARD: "off" })).toBeUndefined()
    expect(restartGuardFromEnv({ OPENBOT_RESTART_GUARD: "0" })).toBeUndefined()
  })
})

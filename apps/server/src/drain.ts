/**
 * Deploys without losing work (`bun run deploy`, scripts/deploy.ts). SIGUSR2 drains the brain:
 * no new turn or task starts (messages still arrive and wait), running ones get up to the grace
 * period, what is left is handed to the next boot (`Orchestrator.drain` → `handOff`). Then the brain
 * stops the normal way (SIGTERM to itself) and the deploy script starts the new release, which
 * resumes everything (`ResumeLive`).
 *
 * The grace comes from `<data>/drain.json` (`{"graceMs": …}`, written by the deploy script and
 * removed here), else `DEFAULT_DRAIN_GRACE_MS`. The deploy script knows a brain can drain when this
 * file exists in its release.
 *
 * With the restart guard on (restartGuard.ts) a drain asked for too soon after a boot, or after too
 * many boots in the last hour, is refused (`"force": true` in drain.json overrides): the brain keeps
 * running and a later SIGUSR2 is heard again. Each request's outcome goes to `<data>/drain-result.json`.
 */
import { Orchestrator } from "@openbot/core"
import { Effect, Layer, Queue } from "effect"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { ServerConfig } from "./config.ts"
import { drainRefusal, readBootHistory, writeDrainResult } from "./restartGuard.ts"
import { setShutdownPhase } from "./shutdown.ts"

export const DEFAULT_DRAIN_GRACE_MS = 3 * 60_000

export interface DrainRequest {
  readonly graceMs: number
  /** Drain even when the restart guard would refuse (the owner's call). */
  readonly force: boolean
}

export const readDrainRequest = (dataDir: string) =>
  Effect.promise(async (): Promise<DrainRequest> => {
    const path = join(dataDir, "drain.json")
    try {
      const parsed = JSON.parse(await Bun.file(path).text()) as { graceMs?: unknown; force?: unknown }
      await rm(path, { force: true })
      return {
        graceMs: typeof parsed.graceMs === "number" && parsed.graceMs >= 0 ? parsed.graceMs : DEFAULT_DRAIN_GRACE_MS,
        force: parsed.force === true,
      }
    } catch {
      return { graceMs: DEFAULT_DRAIN_GRACE_MS, force: false }
    }
  })

export const DrainOnSignalLive: Layer.Layer<never, never, Orchestrator | ServerConfig> = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator
    const config = yield* ServerConfig
    const requests = yield* Queue.sliding<void>(1)
    const onSignal = () => {
      Queue.offerUnsafe(requests, undefined)
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => process.on("SIGUSR2", onSignal)),
      () => Effect.sync(() => process.off("SIGUSR2", onSignal)),
    )
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        for (;;) {
          yield* Queue.take(requests)
          const request = yield* readDrainRequest(config.dataDir)
          const guard = config.restartGuard
          if (guard !== undefined) {
            const now = Date.now()
            const refusal = drainRefusal(
              {
                boots: yield* Effect.promise(() => readBootHistory(config.dataDir)),
                bootedAt: now - Math.round(process.uptime() * 1000),
                now,
                force: request.force,
              },
              guard,
            )
            if (refusal !== undefined) {
              yield* Effect.logWarning("drain refused by the restart guard: the brain keeps running", { refusal })
              yield* Effect.promise(() =>
                writeDrainResult(config.dataDir, { status: "refused", at: now, pid: process.pid, reason: refusal }),
              )
              continue
            }
          }
          yield* Effect.promise(() =>
            writeDrainResult(config.dataDir, { status: "draining", at: Date.now(), pid: process.pid }),
          )
          setShutdownPhase("draining for a deploy")
          yield* orchestrator.drain({ graceMs: request.graceMs })
          yield* Effect.logInfo("drained: stopping for the deploy")
          yield* Effect.promise(() =>
            writeDrainResult(config.dataDir, { status: "drained", at: Date.now(), pid: process.pid }),
          )
          process.kill(process.pid, "SIGTERM")
          return
        }
      }),
    )
  }),
)

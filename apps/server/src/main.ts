/**
 * `openbot` — the brain's entry point (architecture §4.9).
 *
 *   bun apps/server/src/main.ts [--data-dir <path>] [--port 7420] [--host 127.0.0.1] [--dev] …
 *   bun run dev                  (repo root: `bun --hot src/main.ts --dev` in apps/server)
 *
 * SIGINT/SIGTERM interrupt the main fiber, which releases the brain layer (graceful shutdown). A
 * watchdog (`shutdown.ts`) forces the exit, killing every child process group, when that takes longer
 * than `OPENBOT_SHUTDOWN_TIMEOUT_MS` (default 5 s) or a second signal arrives.
 * Under `bun --hot` the module is re-evaluated in the same process: the previous brain is stopped
 * (and its ports released) before the new one boots.
 */
import { BunRuntime } from "@effect/platform-bun"
import { Cause, Deferred, Effect, Exit, Layer } from "effect"
import { homedir } from "node:os"
import { ConfigError, OPENBOT_VERSION, parseCommand, USAGE } from "./config.ts"
import { restartGuardFromEnv } from "./restartGuard.ts"
import { ServerLive } from "./server.ts"
import { makeShutdownWatchdog, setShutdownPhase, shutdownTimeoutFromEnv } from "./shutdown.ts"

interface HotHandle {
  readonly stop: () => Promise<void>
}
const hot = globalThis as typeof globalThis & { __openbotBrain?: HotHandle | undefined }

/** A readable reason for a failed boot (port in use, data dir locked, migration failed, …). */
const describeFailure = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.findErrorOption(cause)
  if (error._tag === "Some") {
    const e = error.value as { _tag?: string; message?: string; cause?: unknown }
    if (e._tag === "ServeError") {
      const inner = e.cause instanceof Error ? e.cause.message : String(e.cause)
      return `cannot listen: ${inner}`
    }
    if (typeof e.message === "string" && e.message !== "") return e.message
    return String(error.value)
  }
  const defect = Cause.squash(cause)
  return defect instanceof Error ? defect.message : Cause.pretty(cause)
}

const main = async () => {
  let command
  try {
    command = parseCommand(process.argv.slice(2), process.env, { home: homedir(), cwd: process.cwd() })
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`openbot: ${error.message}`)
      process.exit(2)
    }
    throw error
  }
  if (command._tag === "Help") {
    console.log(USAGE)
    return
  }
  if (command._tag === "Version") {
    console.log(OPENBOT_VERSION)
    return
  }

  // `bun --hot`: stop the brain started by the previous evaluation of this module first.
  const previous = hot.__openbotBrain
  if (previous !== undefined) {
    hot.__openbotBrain = undefined
    await previous.stop()
  }

  const stopSignal = Deferred.makeUnsafe<void>()
  let markStopped: () => void = () => undefined
  const stopped = new Promise<void>((resolve) => {
    markStopped = resolve
  })
  hot.__openbotBrain = {
    stop: async () => {
      Deferred.doneUnsafe(stopSignal, Exit.void)
      await stopped
    },
  }

  // A stuck finalizer must never keep the brain (and its harness processes) alive.
  const watchdog = makeShutdownWatchdog({ timeoutMs: shutdownTimeoutFromEnv(process.env) })
  for (const name of ["SIGINT", "SIGTERM"] as const) {
    process.on(name, () => {
      setShutdownPhase("interrupting the brain")
      watchdog.signal(name)
    })
  }

  // restart storms and too-frequent drains (restartGuard.ts); OPENBOT_RESTART_GUARD=off turns it off
  const config = { ...command.config, restartGuard: restartGuardFromEnv(process.env) }
  const program = Layer.launch(ServerLive(config)).pipe(
    Effect.raceFirst(Deferred.await(stopSignal)),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.sync(() => {
            console.error(`openbot: failed to start: ${describeFailure(cause)}`)
            process.exitCode = 1
          }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        watchdog.done()
        markStopped()
      }),
    ),
  )
  BunRuntime.runMain(program, { disableErrorReporting: true })
}

await main()

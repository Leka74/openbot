/**
 * Routine gates (`RoutineGate`, see RoutineScheduler): an executable file the owner puts at
 * `<data>/routine-gates/<routineId>` runs before each scheduled or catch-up run of that routine, so a
 * run with nothing to do costs no bot turn. It runs with no shell and no arguments, in the owner's
 * home, with the brain's environment, for at most 60 s; its stdout (the first 4 KB) is kept, its
 * stderr dropped. Exit 0 = run (the output follows the prompt), 1 = skip, anything else = run anyway.
 */
import { RoutineGate, type RoutineGateResult } from "@openbot/core"
import { Effect, Layer } from "effect"
import { access, constants, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export const GATE_TIMEOUT_MS = 60_000
export const GATE_OUTPUT_BYTES = 4 * 1024
/** After the gate exits, how long its last output may take to arrive (a child it left may hold the pipe). */
const OUTPUT_DRAIN_MS = 1_000

export interface RoutineGateOptions {
  /** `<data>/routine-gates` */
  readonly dir: string
  /** Tests: shorter. */
  readonly timeoutMs?: number | undefined
  /** The gate's working directory (default: the owner's home). */
  readonly cwd?: string | undefined
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Reads `stream` to its end, keeping its first `max` bytes (the rest is drained, so the gate never blocks on it). */
const readCapped = (stream: ReadableStream<Uint8Array>, max: number) => {
  const reader = stream.getReader()
  const kept: Array<Uint8Array> = []
  let size = 0
  const done = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (size >= max) continue
      const part = value.subarray(0, max - size)
      kept.push(part)
      size += part.byteLength
    }
  })().catch(() => undefined)
  return {
    done,
    text: () => new TextDecoder().decode(Buffer.concat(kept)),
    stop: () => void reader.cancel().catch(() => undefined),
  }
}

/** Runs the gate at `file`, if there is one. Never throws. */
export const runGate = async (
  file: string,
  options?: { readonly timeoutMs?: number | undefined; readonly cwd?: string | undefined },
): Promise<RoutineGateResult> => {
  try {
    if (!(await stat(file)).isFile()) return { _tag: "none" }
  } catch {
    return { _tag: "none" }
  }
  try {
    await access(file, constants.X_OK)
  } catch {
    return { _tag: "error", message: `${file} is not executable` }
  }
  let proc: Bun.Subprocess<"ignore", "pipe", "ignore">
  try {
    proc = Bun.spawn([file], {
      cwd: options?.cwd ?? homedir(),
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
  } catch (error) {
    return { _tag: "error", message: `could not start: ${messageOf(error)}` }
  }
  const output = readCapped(proc.stdout, GATE_OUTPUT_BYTES)
  const timeoutMs = options?.timeoutMs ?? GATE_TIMEOUT_MS
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill("SIGKILL")
  }, timeoutMs)
  try {
    const code = await proc.exited
    if (timedOut) return { _tag: "error", message: `timed out after ${Math.round(timeoutMs / 1000)} s` }
    if (code === 1) return { _tag: "skip" }
    if (code !== 0) {
      return {
        _tag: "error",
        message: proc.signalCode === null ? `exited with code ${code}` : `ended by ${proc.signalCode}`,
      }
    }
    await Promise.race([output.done, Bun.sleep(OUTPUT_DRAIN_MS)])
    return { _tag: "pass", output: output.text().trim() }
  } catch (error) {
    return { _tag: "error", message: messageOf(error) }
  } finally {
    clearTimeout(timer)
    output.stop()
  }
}

/** Routine ids are generated (`rtn_…`); anything that could leave the gates folder has no gate. */
const SAFE_NAME = /^[A-Za-z0-9_-]+$/

export const RoutineGateLive = (options: RoutineGateOptions): Layer.Layer<RoutineGate> =>
  Layer.succeed(
    RoutineGate,
    RoutineGate.of({
      check: (routineId) =>
        SAFE_NAME.test(routineId)
          ? Effect.promise(() =>
              runGate(path.join(options.dir, routineId), { timeoutMs: options.timeoutMs, cwd: options.cwd }),
            )
          : Effect.succeed({ _tag: "none" }),
    }),
  )

// Routine gates: `<data>/routine-gates/<routineId>` runs without a shell in the given folder; exit 0
// passes (stdout trimmed, first 4 KB), 1 skips, anything else (other codes, a timeout, a file that is
// not executable) is an error the scheduler runs through; no file = no gate.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { RoutineGate, type RoutineGateResult } from "@openbot/core"
import { Effect } from "effect"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GATE_OUTPUT_BYTES, RoutineGateLive } from "../src/routineGate.ts"

let root = ""
let gates = ""
let cwd = ""

const gate = (name: string, script: string, mode = 0o755) => {
  const file = join(gates, name)
  writeFileSync(file, `#!/bin/sh\n${script}\n`)
  chmodSync(file, mode)
}

const check = (routineId: string, timeoutMs?: number): Promise<RoutineGateResult> =>
  Effect.runPromise(
    Effect.flatMap(RoutineGate, (g) => g.check(routineId as never)).pipe(
      Effect.provide(RoutineGateLive({ dir: gates, cwd, timeoutMs })),
    ),
  )

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "openbot-gates-")))
  gates = join(root, "routine-gates")
  cwd = join(root, "home")
  mkdirSync(gates)
  mkdirSync(cwd)
  gate("rtn_pass", 'printf "  3 new mails in %s\\n\\n" "$PWD"; echo noise >&2')
  gate("rtn_quiet", "exit 0")
  gate("rtn_skip", "echo nothing to do; exit 1")
  gate("rtn_broken", "exit 3")
  gate("rtn_slow", "sleep 5")
  gate("rtn_loud", `head -c ${GATE_OUTPUT_BYTES * 4} /dev/zero | tr '\\0' 'x'`)
  gate("rtn_plain", "exit 0", 0o644)
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("routine gates", () => {
  test("exit 0 passes with its stdout trimmed (stderr dropped), run in the given folder", async () => {
    expect(await check("rtn_pass")).toEqual({ _tag: "pass", output: `3 new mails in ${cwd}` })
    expect(await check("rtn_quiet")).toEqual({ _tag: "pass", output: "" })
  })

  test("exit 1 skips; other exit codes and timeouts are errors", async () => {
    expect(await check("rtn_skip")).toEqual({ _tag: "skip" })
    expect(await check("rtn_broken")).toEqual({ _tag: "error", message: "exited with code 3" })
    const started = Date.now()
    const slow = await check("rtn_slow", 300)
    expect(slow._tag).toBe("error")
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  test("only the first 4 KB of output is kept", async () => {
    const loud = await check("rtn_loud")
    expect(loud._tag).toBe("pass")
    expect(loud._tag === "pass" ? loud.output.length : 0).toBe(GATE_OUTPUT_BYTES)
  })

  test("no file (or an unsafe id) is no gate; a file that is not executable is an error", async () => {
    expect(await check("rtn_missing")).toEqual({ _tag: "none" })
    expect(await check("../routine-gates/rtn_pass")).toEqual({ _tag: "none" })
    expect((await check("rtn_plain"))._tag).toBe("error")
  })
})

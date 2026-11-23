import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bundledClaudeExecutable, startClaudeSignIn } from "../src/signIn.ts"

const workDir = mkdtempSync(join(tmpdir(), "openbot-claude-sign-in-"))
afterAll(() => rmSync(workDir, { recursive: true, force: true }))

const SIGN_IN_URL = "https://claude.com/cai/oauth/authorize?code=true&state=abc"

const fakeClaude = (name: string, body: string): string => {
  const path = join(workDir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

const loginCli = fakeClaude(
  "claude-login",
  [
    `[ "$1 $2" = "auth login" ] || exit 2`,
    `echo "$CLAUDE_CONFIG_DIR" > "$SEEN_CONFIG_DIR"`,
    `echo "Opening browser to sign in"`,
    `printf "If the browser didn't open, visit: \\033]8;;${SIGN_IN_URL}\\007${SIGN_IN_URL}\\033]8;;\\007\\n"`,
    `printf "Paste code here if prompted > "`,
    `read code`,
    `if [ "$code" = "good#abc" ]; then echo "Login successful."; else echo "Login failed: Request failed with status code 400"; fi`,
  ].join("\n"),
)

const envFor = (seenFile: string) => ({
  PATH: process.env.PATH,
  CLAUDE_CONFIG_DIR: "/home/owner/.claude-2",
  SEEN_CONFIG_DIR: seenFile,
})

const runScoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromiseExit(Effect.scoped(effect))

describe("startClaudeSignIn", () => {
  test("gives the sign-in link and saves the login with the right code", async () => {
    const seenFile = join(workDir, "seen-good")
    const exit = await runScoped(
      Effect.gen(function* () {
        const signIn = yield* startClaudeSignIn({ executable: loginCli, env: envFor(seenFile) })
        expect(signIn.url).toBe(SIGN_IN_URL)
        yield* signIn.complete("good#abc")
      }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(readFileSync(seenFile, "utf8").trim()).toBe("/home/owner/.claude-2")
  })

  test("reports the reason when Claude refuses the code, and refuses a second code", async () => {
    const exit = await runScoped(
      Effect.gen(function* () {
        const signIn = yield* startClaudeSignIn({ executable: loginCli, env: envFor(join(workDir, "seen-bad")) })
        const refused = yield* Effect.flip(signIn.complete("wrong#abc"))
        expect(refused.code).toBe("auth")
        expect(refused.message).toContain("status code 400")
        const again = yield* Effect.flip(signIn.complete("good#abc"))
        expect(again.message).toContain("Start again")
      }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("fails when the CLI ends without a sign-in link", async () => {
    const silentCli = fakeClaude("claude-silent", `echo "Not available in this region" >&2`)
    const exit = await runScoped(startClaudeSignIn({ executable: silentCli, env: { PATH: process.env.PATH } }))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("Not available in this region")
  })

  test("stops the CLI when the sign-in is dropped", async () => {
    const pidFile = join(workDir, "waiting-pid")
    const waitingCli = fakeClaude(
      "claude-waiting",
      [`echo $$ > "${pidFile}"`, `echo "visit: ${SIGN_IN_URL}"`, `read code`].join("\n"),
    )
    const scope = Effect.runSync(Scope.make())
    await Effect.runPromise(
      Scope.provide(scope)(startClaudeSignIn({ executable: waitingCli, env: { PATH: process.env.PATH } })),
    )
    const pid = Number(readFileSync(pidFile, "utf8").trim())
    const alive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    expect(alive()).toBe(true)
    await Effect.runPromise(Scope.close(scope, Exit.void))
    for (let attempt = 0; attempt < 100 && alive(); attempt++) await Bun.sleep(10)
    expect(alive()).toBe(false)
  })
})

test("finds the Claude Code CLI bundled with the Agent SDK", () => {
  const executable = bundledClaudeExecutable()
  expect(executable).toBeDefined()
  expect(existsSync(executable!)).toBe(true)
})

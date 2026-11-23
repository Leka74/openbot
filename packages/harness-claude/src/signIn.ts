import { HarnessError, type HarnessErrorCode, type HarnessSignIn } from "@openbot/core"
import { Effect, type Scope } from "effect"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { HARNESS } from "./Session.ts"

const SIGN_IN_URL = /https:\/\/\S+\/oauth\/authorize\?\S+/
const LOGIN_SUCCEEDED = /Login successful/i
const LOGIN_FAILED = /Login failed:?[ \t]*([^\n]*)/i

const URL_TIMEOUT_MS = 20_000
const COMPLETE_TIMEOUT_MS = 30_000

export interface ClaudeSignInInput {
  readonly executable: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly urlTimeoutMs?: number | undefined
  readonly completeTimeoutMs?: number | undefined
}

type LoginOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export const bundledClaudeExecutable = (): string | undefined => {
  const resolveFromSdk = createRequire(import.meta.resolve("@anthropic-ai/claude-agent-sdk"))
  const binary = process.platform === "win32" ? "claude.exe" : "claude"
  for (const libcSuffix of ["", "-musl"]) {
    const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${libcSuffix}`
    try {
      const path = join(dirname(resolveFromSdk.resolve(`${platformPackage}/package.json`)), binary)
      if (existsSync(path)) return path
    } catch {
      continue
    }
  }
  return undefined
}

const signInError = (code: HarnessErrorCode, message: string) => new HarnessError({ harness: HARNESS, code, message })

const definedEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))

const lastLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1) ?? ""

class LoginOutput {
  private raw = ""
  private readonly listeners = new Set<() => void>()

  get text(): string {
    return Bun.stripANSI(this.raw).replace(/\r/g, "\n")
  }

  async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      this.raw += decoder.decode(chunk, { stream: true })
      for (const listener of this.listeners) listener()
    }
  }

  waitFor<A>(
    read: (text: string) => A | undefined,
    drained: Promise<unknown>,
    timeoutMs: number,
  ): Promise<A | undefined> {
    return new Promise((resolve) => {
      const finish = (found: A | undefined) => {
        clearTimeout(timer)
        this.listeners.delete(check)
        resolve(found)
      }
      const check = () => {
        const found = read(this.text)
        if (found !== undefined) finish(found)
      }
      const timer = setTimeout(() => finish(read(this.text)), timeoutMs)
      this.listeners.add(check)
      void drained.then(() => finish(read(this.text)))
      check()
    })
  }
}

const readOutcome = (text: string): LoginOutcome | undefined => {
  if (LOGIN_SUCCEEDED.test(text)) return { ok: true }
  const failed = LOGIN_FAILED.exec(text)
  return failed === null ? undefined : { ok: false, reason: failed[1]?.trim() || "unknown reason" }
}

export const startClaudeSignIn = (input: ClaudeSignInInput): Effect.Effect<HarnessSignIn, HarnessError, Scope.Scope> =>
  Effect.gen(function* () {
    const login = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.spawn([input.executable, "auth", "login"], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            env: definedEnv(input.env),
          }),
        catch: (cause) =>
          signInError(
            "not-installed",
            `Could not start ${input.executable}: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
      }),
      (child) =>
        Effect.sync(() => {
          if (child.exitCode === null) child.kill("SIGKILL")
        }),
    )
    const output = new LoginOutput()
    const drained = Promise.all([output.pump(login.stdout), output.pump(login.stderr)])
    const url = yield* Effect.promise(() =>
      output.waitFor((text) => SIGN_IN_URL.exec(text)?.[0], drained, input.urlTimeoutMs ?? URL_TIMEOUT_MS),
    )
    if (url === undefined) {
      return yield* Effect.fail(
        signInError("other", `Claude did not give a sign-in link. ${lastLine(output.text)}`.trim()),
      )
    }

    let codeSent = false
    const complete = (code: string): Effect.Effect<void, HarnessError> =>
      Effect.gen(function* () {
        if (codeSent) return yield* Effect.fail(signInError("auth", "This sign-in already used its code. Start again."))
        codeSent = true
        yield* Effect.sync(() => {
          login.stdin.write(`${code}\n`)
          void login.stdin.flush()
        })
        const outcome = yield* Effect.promise(() =>
          output.waitFor(readOutcome, drained, input.completeTimeoutMs ?? COMPLETE_TIMEOUT_MS),
        )
        if (outcome === undefined) {
          return yield* Effect.fail(signInError("auth", "Claude did not confirm the sign-in. Start again."))
        }
        if (!outcome.ok) return yield* Effect.fail(signInError("auth", `Claude refused the code (${outcome.reason}).`))
      })

    return { url, complete }
  })

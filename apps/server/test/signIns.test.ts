import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { HarnessStatus } from "@openbot/contracts"
import { HarnessError, type HarnessDriver, HarnessRegistry } from "@openbot/core"
import { FakeHarnessLive, makeFakeDriver } from "@openbot/harness-fake"
import { Effect, Layer } from "effect"
import { login, type OpenBotClient, rpcClient, startServer, type TestServer } from "./helpers.ts"

const GOOD_CODE = "good#state"

interface FlowRecord {
  readonly url: string
  readonly codes: Array<string>
  closed: boolean
}

const flows: Array<FlowRecord> = []

const signInDriver = (): HarnessDriver => {
  const base = makeFakeDriver({ displayName: "Claude" })
  return {
    ...base,
    kind: "claude",
    probe: Effect.succeed({
      kind: "claude",
      installed: true,
      auth: { state: "signed-out" },
      problems: [],
    } satisfies HarnessStatus),
    signIn: Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => {
          const flow: FlowRecord = {
            url: `https://claude.test/oauth/authorize?flow=${flows.length}`,
            codes: [],
            closed: false,
          }
          flows.push(flow)
          return flow
        }),
        (flow) =>
          Effect.sync(() => {
            flow.closed = true
          }),
      ),
      (flow) => ({
        url: flow.url,
        complete: (code: string) =>
          Effect.suspend(() => {
            flow.codes.push(code)
            return code === GOOD_CODE
              ? Effect.void
              : Effect.fail(
                  new HarnessError({ harness: "claude", code: "auth", message: "Claude refused the code (400)." }),
                )
          }),
      }),
    ),
  }
}

let server: TestServer
let cookie: string

beforeAll(async () => {
  server = await startServer({
    config: { harnesses: ["fake", "claude"] },
    server: {
      drivers: Layer.mergeAll(FakeHarnessLive, HarnessRegistry.registerLayer(Effect.succeed(signInDriver()))),
      profiles: { env: {}, seed: false },
    },
  })
  cookie = await login(server.base, server.ownerToken)
}, 30_000)

afterAll(async () => {
  await server?.close()
}, 30_000)

const withClient = <A, E>(f: (client: OpenBotClient) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base }), f)),
  )

const lastFlow = () => flows.at(-1)!

describe("harness sign-in from the app", () => {
  test("status marks only the harnesses that can sign in from the app", async () => {
    const status = await withClient((client) => client["harnesses.status"]())
    expect(status.find((s) => s.kind === "claude")?.signInFromApp).toBe(true)
    expect(status.find((s) => s.kind === "fake")?.signInFromApp).toBeUndefined()
  })

  test("start gives the link and the right code finishes the sign-in", async () => {
    const started = await withClient((client) => client["harnesses.startSignIn"]({ kind: "claude" }))
    const flow = lastFlow()
    expect(started.url).toBe(flow.url)
    await withClient((client) =>
      client["harnesses.completeSignIn"]({ kind: "claude", profileId: "default", code: `  ${GOOD_CODE}\n` }),
    )
    expect(flow.codes).toEqual([GOOD_CODE])
    expect(flow.closed).toBe(true)
  })

  test("a refused code ends the sign-in with the reason", async () => {
    await withClient((client) => client["harnesses.startSignIn"]({ kind: "claude" }))
    const flow = lastFlow()
    const refused = await withClient((client) =>
      Effect.flip(client["harnesses.completeSignIn"]({ kind: "claude", code: "wrong#state" })),
    )
    expect(refused._tag).toBe("InvalidInput")
    expect(refused._tag === "InvalidInput" && refused.message).toContain("refused the code")
    expect(flow.closed).toBe(true)
    const again = await withClient((client) =>
      Effect.flip(client["harnesses.completeSignIn"]({ kind: "claude", code: GOOD_CODE })),
    )
    expect(again._tag === "InvalidInput" && again.message).toContain("no longer open")
  })

  test("a new start replaces the open sign-in, and cancel closes it", async () => {
    await withClient((client) => client["harnesses.startSignIn"]({ kind: "claude" }))
    const first = lastFlow()
    await withClient((client) => client["harnesses.startSignIn"]({ kind: "claude" }))
    const second = lastFlow()
    expect(first.closed).toBe(true)
    expect(second.closed).toBe(false)
    await withClient((client) => client["harnesses.cancelSignIn"]({ kind: "claude" }))
    expect(second.closed).toBe(true)
  })

  test("a code with spaces inside is refused before it reaches the CLI", async () => {
    await withClient((client) => client["harnesses.startSignIn"]({ kind: "claude" }))
    const flow = lastFlow()
    const refused = await withClient((client) =>
      Effect.flip(client["harnesses.completeSignIn"]({ kind: "claude", code: "good #state" })),
    )
    expect(refused._tag).toBe("InvalidInput")
    expect(flow.codes).toEqual([])
    expect(flow.closed).toBe(false)
    await withClient((client) => client["harnesses.cancelSignIn"]({ kind: "claude" }))
  })

  test("a harness without sign-in in the app says so", async () => {
    const refused = await withClient((client) => Effect.flip(client["harnesses.startSignIn"]({ kind: "fake" })))
    expect(refused._tag).toBe("HarnessUnavailable")
  })
})

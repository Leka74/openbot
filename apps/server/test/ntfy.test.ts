// ntfy (D3.6) through the brain against a fake ntfy server: connecting sends a test push (a server
// that refuses it or does not answer is reported); OpenBot's notifications become markdown pushes
// with a link to the chat and a high priority when a Bot needs the owner; a slow push does not hold
// back the next; "when a Bot needs you" and "not while I'm at my computer" drop the rest.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { MAIN_PROFILE_ID } from "@openbot/contracts"
import { inProfile } from "@openbot/core"
import { Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { makeNtfy, ntfyTarget } from "../src/ntfy.ts"
import { clipBytes } from "../src/push.ts"
import { eventually, login, rpcClient, startServer, type TestServer } from "./helpers.ts"

interface Push {
  readonly authorization: string | null
  readonly body: Record<string, unknown>
}

const startFakeNtfy = () => {
  const pushes: Array<Push> = []
  const state = { refuse: false }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/") {
        return new Response("not found", { status: 404 })
      }
      if (state.refuse) return Response.json({ error: "forbidden" }, { status: 403 })
      const body = (await request.json()) as Record<string, unknown>
      // a server that hangs on this one push
      if (body.message === "slow one") await new Promise(() => {})
      pushes.push({ authorization: request.headers.get("authorization"), body })
      return Response.json({ id: `id${pushes.length}`, event: "message" })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, pushes, state, stop: () => server.stop(true) }
}

const fakeFetch = (respond: (url: string, init: RequestInit) => Promise<Response>): typeof fetch =>
  Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => respond(String(input), init ?? {}), {
    preconnect: fetch.preconnect,
  })

const LONG_TOPIC = "openbot-abcdefghij0123456789"

describe("ntfy", () => {
  let ntfy: ReturnType<typeof startFakeNtfy>
  let server: TestServer
  let cookie: string
  beforeAll(async () => {
    ntfy = startFakeNtfy()
    server = await startServer({ config: { publicOrigins: ["https://box.tailnet.ts.net:8444"] } })
    cookie = await login(server.base, server.ownerToken)
  }, 30_000)
  afterAll(async () => {
    await server?.close()
    ntfy?.stop()
  }, 30_000)

  const refusal = (input: Parameters<typeof ntfyTarget>[0]) => Effect.runSync(Effect.flip(ntfyTarget(input))).message

  test("topics, server addresses and tokens", () => {
    expect(Effect.runSync(ntfyTarget({ topic: ` ${LONG_TOPIC} ` }))).toEqual({
      server: "https://ntfy.sh",
      topic: LONG_TOPIC,
    })
    expect(
      Effect.runSync(ntfyTarget({ topic: "alerts", server: "https://ntfy.example.com/", token: " tk_1 " })),
    ).toEqual({ server: "https://ntfy.example.com", topic: "alerts", token: "tk_1" })
    expect(Effect.runSync(ntfyTarget({ topic: "alerts", server: "http://ntfy.lan:8080" }))).toEqual({
      server: "http://ntfy.lan:8080",
      topic: "alerts",
    })
    expect(refusal({ topic: "has space" })).toContain("letters, digits")
    expect(refusal({ topic: "" })).toContain("letters, digits")
    // on ntfy.sh anyone who knows the topic reads it
    expect(refusal({ topic: "alerts" })).toContain("at least 20 characters")
    expect(refusal({ topic: "alerts", server: "https://ntfy.sh/" })).toContain("at least 20 characters")
    expect(refusal({ topic: LONG_TOPIC, server: `https://ntfy.sh/${LONG_TOPIC}` })).toContain("has its own field")
    expect(refusal({ topic: "alerts", server: "https://ntfy.example.com/?x=1" })).toContain("has its own field")
    expect(refusal({ topic: "alerts", server: "https://ntfy.example.com/#x" })).toContain("has its own field")
    expect(refusal({ topic: "alerts", server: "https://me:pw@ntfy.example.com" })).toContain("access token")
    expect(refusal({ topic: "alerts", server: "http://ntfy.lan", token: "tk_1" })).toContain("https://")
    expect(refusal({ topic: "alerts", server: "http://127.evil.example", token: "tk_1" })).toContain("https://")
    // a token over http to this computer does not leave it
    for (const server of ["http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080"]) {
      expect(Effect.runSync(ntfyTarget({ topic: "alerts", server, token: "tk_1" }))).toEqual({
        server,
        topic: "alerts",
        token: "tk_1",
      })
    }
    expect(refusal({ topic: "alerts", server: "ftp://ntfy.example.com" })).toContain("address like")
    expect(refusal({ topic: "alerts", server: "not a url" })).toContain("address like")
  })

  test("a long message is cut by bytes, never inside a character", () => {
    expect(clipBytes("short", 3_800)).toBe("short")
    const clipped = clipBytes("👋".repeat(2_000), 3_800)
    expect(new TextEncoder().encode(clipped).length).toBeLessThanOrEqual(3_800)
    expect(clipped.endsWith("👋…")).toBe(true)
  })

  test("the topic, server, token and settings are kept in a 0600 file and read back", () =>
    server.run(
      Effect.gen(function* () {
        const file = join(server.dataDir, "ntfy-reload.json")
        const seen: Array<{ url: string; authorization: string | null }> = []
        const fetchImpl = fakeFetch(async (url, init) => {
          seen.push({ url, authorization: new Headers(init.headers).get("authorization") })
          return Response.json({ id: "x" })
        })
        const first = yield* makeNtfy({ file: () => file, fetch: fetchImpl })
        yield* first.connect({ topic: "alerts", server: "https://ntfy.example.com/", token: "tk_secret" })
        yield* first.setSends("needs-you")
        yield* first.setQuietAtComputer(false)
        expect(seen).toEqual([{ url: "https://ntfy.example.com", authorization: "Bearer tk_secret" }])
        expect(statSync(file).mode & 0o777).toBe(0o600)
        expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ token: "tk_secret" })

        const reloaded = yield* makeNtfy({ file: () => file, fetch: fetchImpl })
        expect(yield* reloaded.status).toEqual({
          connected: true,
          sends: "needs-you",
          quietAtComputer: false,
          server: "https://ntfy.example.com",
          topic: "alerts",
        })
        yield* reloaded.test
        expect(seen.at(-1)).toEqual({ url: "https://ntfy.example.com", authorization: "Bearer tk_secret" })
        expect(yield* reloaded.disconnect).toEqual({ connected: false, sends: "all" })
      }).pipe(inProfile(MAIN_PROFILE_ID)),
    ))

  test("a server that never answers times out as Unavailable", () =>
    server.run(
      Effect.gen(function* () {
        const started = Promise.withResolvers<void>()
        const fetchImpl = fakeFetch(() => {
          started.resolve()
          return new Promise<never>(() => {})
        })
        const service = yield* makeNtfy({ file: () => join(server.dataDir, "ntfy-timeout.json"), fetch: fetchImpl })
        const call = yield* service
          .connect({ topic: "alerts", server: "https://ntfy.example.com" })
          .pipe(Effect.flip, Effect.forkScoped)
        yield* Effect.promise(() => started.promise)
        yield* TestClock.adjust("15 seconds")
        expect(yield* Fiber.join(call)).toMatchObject({ _tag: "Unavailable", message: "ntfy did not answer." })
        expect(yield* service.status).toEqual({ connected: false, sends: "all" })
      }).pipe(Effect.provide(TestClock.layer()), inProfile(MAIN_PROFILE_ID)),
    ))

  test(
    "connect, push OpenBot's notifications to the phone, choose what is sent, disconnect",
    () =>
      server.run(
        Effect.gen(function* () {
          const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })
          expect(yield* client["ntfy.status"]()).toEqual({ connected: false, sends: "all" })

          const badTopic = yield* Effect.flip(client["ntfy.connect"]({ topic: "not a topic", server: ntfy.url }))
          expect(badTopic).toMatchObject({ _tag: "InvalidInput" })

          // nobody listens there
          const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
          closed.stop(true)
          const unreachable = yield* Effect.flip(
            client["ntfy.connect"]({ topic: "openbot-test", server: `http://127.0.0.1:${closed.port}` }),
          )
          expect(unreachable).toMatchObject({ _tag: "Unavailable", message: "ntfy did not answer." })

          // a server that refuses the test push is not kept
          ntfy.state.refuse = true
          const refused = yield* Effect.flip(client["ntfy.connect"]({ topic: "openbot-test", server: ntfy.url }))
          expect(refused).toMatchObject({ _tag: "InvalidInput", message: expect.stringContaining("access token") })
          expect(yield* client["ntfy.status"]()).toEqual({ connected: false, sends: "all" })
          ntfy.state.refuse = false

          const connected = yield* client["ntfy.connect"]({ topic: "openbot-test", server: `${ntfy.url}/` })
          expect(connected).toMatchObject({
            connected: true,
            sends: "all",
            quietAtComputer: true,
            server: ntfy.url,
            topic: "openbot-test",
          })
          expect(ntfy.pushes.at(-1)).toEqual({
            authorization: null,
            body: {
              topic: "openbot-test",
              title: "OpenBot",
              message: "Connected. Your Bots' notifications will show up here.",
              click: "https://box.tailnet.ts.net:8444/",
            },
          })

          // a Bot answers: "finished" becomes a push to the chat
          const bot = yield* client["bots.create"]({
            name: "Scout",
            harness: { kind: "fake" },
            clientNonce: "ntfy-scout",
            introduce: false,
          })
          yield* client["messages.send"]({
            conversationId: bot.directConversationId,
            text: "echo: The report is ready.",
            clientNonce: "ntfy-1",
          })
          yield* eventually(
            Effect.sync(() => ntfy.pushes.length),
            (n) => n === 2,
            { label: "the finished push", timeout: 20_000 },
          )
          expect(ntfy.pushes[1]!.body).toEqual({
            topic: "openbot-test",
            title: "Scout",
            message: "The report is ready.",
            markdown: true,
            click: `https://box.tailnet.ts.net:8444/#/c/${bot.directConversationId}`,
          })

          // a push the server hangs on does not hold back the next one
          yield* client["messages.send"]({
            conversationId: bot.directConversationId,
            text: "echo: slow one",
            clientNonce: "ntfy-slow",
          })
          yield* client["messages.send"]({
            conversationId: bot.directConversationId,
            text: "echo: fast one",
            clientNonce: "ntfy-fast",
          })
          yield* eventually(
            Effect.sync(() => ntfy.pushes.some((p) => p.body.message === "fast one")),
            (seen) => seen,
            // well under the 15 s a push may take
            { label: "the push after a slow one", timeout: 8_000 },
          )

          // only when a Bot needs you: a finished reply is not pushed, a question is (at high priority)
          yield* client["ntfy.setSends"]({ sends: "needs-you" })
          yield* client["messages.send"]({
            conversationId: bot.directConversationId,
            text: "echo: Done again.",
            clientNonce: "ntfy-2",
          })
          yield* client["messages.send"]({
            conversationId: bot.directConversationId,
            text: "ask: Which format? | PDF | Slides",
            clientNonce: "ntfy-3",
          })
          const question = yield* eventually(
            Effect.sync(() => ntfy.pushes.find((p) => String(p.body.message).includes("Which format?"))),
            (push) => push !== undefined,
            { label: "the question push", timeout: 20_000 },
          )
          expect(question!.body).toMatchObject({ title: "Scout", priority: 4 })
          expect(ntfy.pushes.some((p) => p.body.message === "Done again.")).toBe(false)

          // the owner is at a computer whose desktop app shows notifications: nothing is pushed meanwhile
          yield* client["presence.active"]()
          expect(yield* client["ntfy.status"]()).toMatchObject({ atComputer: true })
          const other = yield* client["bots.create"]({
            name: "Ranger",
            harness: { kind: "fake" },
            clientNonce: "ntfy-ranger",
            introduce: false,
          })
          yield* client["messages.send"]({
            conversationId: other.directConversationId,
            text: "ask: Which day? | Monday | Friday",
            clientNonce: "ntfy-4",
          })
          yield* Effect.sleep("1500 millis")
          expect(ntfy.pushes.some((p) => String(p.body.message).includes("Which day?"))).toBe(false)
          // turned off: pushed even then (another Bot: Ranger still waits for its answer)
          expect(yield* client["ntfy.setQuietAtComputer"]({ quiet: false })).toMatchObject({ quietAtComputer: false })
          const third = yield* client["bots.create"]({
            name: "Pilot",
            harness: { kind: "fake" },
            clientNonce: "ntfy-pilot",
            introduce: false,
          })
          yield* client["messages.send"]({
            conversationId: third.directConversationId,
            text: "ask: Which room? | A | B",
            clientNonce: "ntfy-5",
          })
          yield* eventually(
            Effect.sync(() => ntfy.pushes.some((p) => String(p.body.message).includes("Which room?"))),
            (seen) => seen,
            { label: "the push while at the computer, quiet off", timeout: 20_000 },
          )

          // the server starts refusing: the next push fails and says why
          ntfy.state.refuse = true
          const tested = yield* Effect.flip(client["ntfy.test"]())
          expect(tested).toMatchObject({ _tag: "Unavailable" })
          expect(yield* client["ntfy.status"]()).toMatchObject({
            connected: true,
            problem: expect.stringContaining("access token"),
          })

          expect(yield* client["ntfy.disconnect"]()).toEqual({ connected: false, sends: "all" })
        }),
      ),
    60_000,
  )
})

// ntfy (D3.6) through the brain against a fake ntfy server: connecting sends a test push (a server
// that refuses it is reported); OpenBot's notifications become pushes with a link to the chat and a
// high priority when a Bot needs the owner; "when a Bot needs you" drops the rest; a server that
// starts refusing shows as a problem.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ntfyServer, ntfyTopic } from "../src/ntfy.ts"
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
      pushes.push({
        authorization: request.headers.get("authorization"),
        body: (await request.json()) as Record<string, unknown>,
      })
      return Response.json({ id: `id${pushes.length}`, event: "message" })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, pushes, state, stop: () => server.stop(true) }
}

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

  test("topics and server addresses", () => {
    expect(ntfyTopic(" openbot-abc_123 ")).toBe("openbot-abc_123")
    expect(ntfyTopic("has space")).toBeUndefined()
    expect(ntfyTopic("")).toBeUndefined()
    expect(ntfyServer("")).toBe("https://ntfy.sh")
    expect(ntfyServer(undefined)).toBe("https://ntfy.sh")
    expect(ntfyServer("https://ntfy.example.com/")).toBe("https://ntfy.example.com")
    expect(ntfyServer("ftp://ntfy.example.com")).toBeUndefined()
    expect(ntfyServer("not a url")).toBeUndefined()
  })

  test(
    "connect, push OpenBot's notifications to the phone, choose what is sent, disconnect",
    () =>
      server.run(
        Effect.gen(function* () {
          const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })
          expect(yield* client["ntfy.status"]()).toEqual({ connected: false, sends: "all" })

          const badTopic = yield* Effect.flip(client["ntfy.connect"]({ topic: "not a topic", server: ntfy.url }))
          expect(badTopic).toMatchObject({ _tag: "InvalidInput" })

          // a server that refuses the test push is not kept
          ntfy.state.refuse = true
          const refused = yield* Effect.flip(client["ntfy.connect"]({ topic: "openbot-test", server: ntfy.url }))
          expect(refused).toMatchObject({ _tag: "InvalidInput", message: expect.stringContaining("access token") })
          expect(yield* client["ntfy.status"]()).toEqual({ connected: false, sends: "all" })
          ntfy.state.refuse = false

          const connected = yield* client["ntfy.connect"]({
            topic: "openbot-test",
            server: `${ntfy.url}/`,
            token: "tk_secret",
          })
          expect(connected).toMatchObject({ connected: true, sends: "all", server: ntfy.url, topic: "openbot-test" })
          expect(connected).not.toHaveProperty("token")
          expect(ntfy.pushes.at(-1)).toEqual({
            authorization: "Bearer tk_secret",
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
            click: `https://box.tailnet.ts.net:8444/#/c/${bot.directConversationId}`,
          })

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
          yield* eventually(
            Effect.sync(() => ntfy.pushes.length),
            (n) => n === 3,
            { label: "the question push", timeout: 20_000 },
          )
          expect(ntfy.pushes[2]!.body).toMatchObject({
            title: "Scout",
            message: expect.stringContaining("Which format?"),
            priority: 4,
          })
          expect(ntfy.pushes.some((p) => p.body.message === "Done again.")).toBe(false)

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

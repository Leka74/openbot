// Hark (D3.5) through the brain against a fake Hark: connecting sends a test push (an unknown
// webhook is refused); OpenBot's notifications become pushes with the Bot as project and a link to
// the chat; "when a Bot needs you" drops the rest; a webhook Hark forgets shows as a problem.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { harkToken } from "../src/hark.ts"
import { eventually, login, rpcClient, startServer, type TestServer } from "./helpers.ts"

interface Push {
  readonly token: string
  readonly key: string | null
  readonly body: Record<string, unknown>
}

const startFakeHark = () => {
  const pushes: Array<Push> = []
  const known = new Set(["whk_good"])
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const match = /^\/hooks\/([^/]+)$/.exec(new URL(request.url).pathname)
      if (request.method !== "POST" || match === null) return new Response("not found", { status: 404 })
      if (!known.has(match[1]!)) return Response.json({ ok: false, error: "unknown webhook" }, { status: 404 })
      pushes.push({ token: match[1]!, key: request.headers.get("idempotency-key"), body: (await request.json()) as Record<string, unknown> })
      return Response.json({ ok: true, eventId: `evt_${pushes.length}`, delivered: 1 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, pushes, known, stop: () => server.stop(true) }
}

describe("Hark", () => {
  let hark: ReturnType<typeof startFakeHark>
  let server: TestServer
  let cookie: string
  beforeAll(async () => {
    hark = startFakeHark()
    server = await startServer({ config: { harkUrl: hark.url, publicOrigins: ["https://box.tailnet.ts.net:8444"] } })
    cookie = await login(server.base, server.ownerToken)
  }, 30_000)
  afterAll(async () => {
    await server?.close()
    hark?.stop()
  }, 30_000)

  test("webhook URLs and bare tokens", () => {
    expect(harkToken("https://hark.ryan.ceo/hooks/whk_abc-123")).toBe("whk_abc-123")
    expect(harkToken(" whk_abc ")).toBe("whk_abc")
    expect(harkToken("https://hark.ryan.ceo/hooks/abc")).toBeUndefined()
  })

  test("connect, push OpenBot's notifications to the iPhone, choose what is sent, disconnect", () =>
    server.run(Effect.gen(function*() {
      const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })
      expect(yield* client["hark.status"]()).toEqual({ connected: false, sends: "all" })
      const unknown = yield* Effect.flip(client["hark.connect"]({ webhook: "https://hark.ryan.ceo/hooks/whk_nope" }))
      expect(unknown).toMatchObject({ _tag: "InvalidInput", message: expect.stringContaining("doesn't know this webhook") })
      const connected = yield* client["hark.connect"]({ webhook: "https://hark.ryan.ceo/hooks/whk_good" })
      expect(connected).toMatchObject({ connected: true, sends: "all" })
      expect(hark.pushes.at(-1)!.body).toEqual({
        title: "OpenBot",
        body: "Connected. Your Bots' notifications will show up here.",
        url: "https://box.tailnet.ts.net:8444/",
      })

      // a Bot answers: "finished" becomes a push to the chat
      const bot = yield* client["bots.create"]({ name: "Scout", harness: { kind: "fake" }, clientNonce: "hark-scout", introduce: false })
      yield* client["messages.send"]({ conversationId: bot.directConversationId, text: "echo: The report is ready.", clientNonce: "hark-1" })
      yield* eventually(Effect.sync(() => hark.pushes.length), (n) => n === 2, { label: "the finished push", timeout: 20_000 })
      const finished = hark.pushes[1]!
      expect(finished.body).toEqual({
        title: "Scout",
        body: "The report is ready.",
        url: `https://box.tailnet.ts.net:8444/#/c/${bot.directConversationId}`,
        project: "Scout",
      })
      expect(finished.key).toMatch(/^ntf_/)

      // only when a Bot needs you: a finished reply is not pushed, a question is
      yield* client["hark.setSends"]({ sends: "needs-you" })
      yield* client["messages.send"]({ conversationId: bot.directConversationId, text: "echo: Done again.", clientNonce: "hark-2" })
      yield* client["messages.send"]({ conversationId: bot.directConversationId, text: "ask: Which format? | PDF | Slides", clientNonce: "hark-3" })
      yield* eventually(Effect.sync(() => hark.pushes.length), (n) => n === 3, { label: "the question push", timeout: 20_000 })
      expect(hark.pushes[2]!.body).toMatchObject({ title: "Scout", body: expect.stringContaining("Which format?") })
      expect(hark.pushes.some((p) => p.body.body === "Done again.")).toBe(false)

      // Hark forgets the webhook: the next push fails and says why
      hark.known.delete("whk_good")
      const tested = yield* Effect.flip(client["hark.test"]())
      expect(tested).toMatchObject({ _tag: "Unavailable" })
      expect(yield* client["hark.status"]()).toMatchObject({ connected: true, problem: expect.stringContaining("doesn't know this webhook") })

      expect(yield* client["hark.disconnect"]()).toEqual({ connected: false, sends: "all" })
    })), 60_000)
})

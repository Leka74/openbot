// End-to-end through the real brain: one booted server (temp data dir, port 0, fake harness), an
// Effect RPC client over `/rpc` with the session cookie, the MCP SDK on the internal listener, and a
// real node-daemon pairing and dialing `/node`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  type Bot,
  isTerminalTurnStatus,
  LOCAL_NODE_ID,
  pendingRequestsOf,
  type TranscriptEntry,
  transcriptOf,
} from "@openbot/contracts"
import { DataDir, McpBindingIssuer, sessionKeyOf } from "@openbot/core"
import { makeKeyStore, pairNode, RemoteNodeLive } from "@openbot/node-daemon"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Effect, Layer, Ref, Stream } from "effect"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  eventually,
  login,
  type OpenBotClient,
  rpcClient,
  startServer,
  type TestServer,
  upgradeStatus,
  watchConversation,
} from "./helpers.ts"

let server: TestServer
let cookie: string

beforeAll(async () => {
  server = await startServer()
  cookie = await login(server.base, server.ownerToken)
}, 30_000)

afterAll(async () => {
  await server?.close()
}, 30_000)

const connect = (): Effect.Effect<OpenBotClient, never, import("effect").Scope.Scope> =>
  rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })

const botMessages = (entries: ReadonlyArray<TranscriptEntry>) =>
  entries.flatMap((e) => (e.kind === "message" && e.role === "bot" && !e.streaming ? [e.text] : []))

let nonce = 0
const createBot = (client: OpenBotClient, name: string) =>
  client["bots.create"]({ name, harness: { kind: "fake" }, clientNonce: `create-${name}-${++nonce}` })

describe("web", () => {
  test("login page without a session; ?token= sets the cookie; the app HTML with one", async () => {
    const anonymous = await fetch(`${server.base}/`)
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get("content-type")).toContain("text/html")
    const loginHtml = await anonymous.text()
    expect(loginHtml).toContain("OpenBot is running")
    expect(loginHtml).not.toContain(server.ownerToken)

    const wrong = await fetch(`${server.base}/?token=nope`, { redirect: "manual" })
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get("set-cookie")).toBeNull()

    const good = await fetch(`${server.base}/?token=${server.ownerToken}`, { redirect: "manual" })
    expect(good.status).toBe(302)
    expect(good.headers.get("location")).toBe("/")
    const setCookie = good.headers.get("set-cookie") ?? ""
    expect(setCookie).toMatch(/^openbot_session=[A-Za-z0-9_-]{20,};/)
    expect(setCookie).toContain("HttpOnly")
    expect(setCookie).toContain("SameSite=Lax")
    expect(setCookie).not.toContain("Secure")

    // behind an https proxy the cookie is Secure
    const proxied = await fetch(`${server.base}/api/auth/login?token=${server.ownerToken}`, {
      redirect: "manual",
      headers: { "x-forwarded-proto": "https" },
    })
    expect(proxied.headers.get("set-cookie")).toContain("Secure")

    // the HTML import, bundled with Tailwind
    const app = await fetch(`${server.base}/`, { headers: { cookie } })
    expect(app.status).toBe(200)
    const html = await app.text()
    expect(html).toContain('<div id="root"></div>')
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]!)
    expect(assets.some((a) => a.endsWith(".js"))).toBe(true)
    expect(assets.some((a) => a.endsWith(".css"))).toBe(true)
    for (const asset of assets) {
      const res = await fetch(`${server.base}${asset}`)
      expect(res.status).toBe(200)
      const body = await res.text()
      if (asset.endsWith(".css")) expect(body).not.toContain("@theme")
    }
  }, 60_000)
})

describe("auth negatives", () => {
  test("/rpc and viewer sockets need a session (401) from an allowed origin (403)", async () => {
    expect(await upgradeStatus(`${server.base}/rpc`, {})).toBe(401)
    expect(await upgradeStatus(`${server.base}/rpc`, { origin: server.base })).toBe(401)
    expect(await upgradeStatus(`${server.base}/rpc`, { cookie: "openbot_session=forged-session-token-value" })).toBe(
      401,
    )
    expect(await upgradeStatus(`${server.base}/rpc`, { cookie, origin: "https://evil.example" })).toBe(403)
    expect(await upgradeStatus(`${server.base}/rpc`, { cookie, origin: "null" })).toBe(403)
    expect(await upgradeStatus(`${server.base}/rpc`, { cookie, "sec-fetch-site": "cross-site" })).toBe(403)
    expect(await upgradeStatus(`${server.base}/ws/computer/bot_x`, {})).toBe(401)
    expect(await upgradeStatus(`${server.base}/ws/computer/bot_x`, { cookie, origin: "https://evil.example" })).toBe(
      403,
    )
    expect(await upgradeStatus(`${server.base}/ws/terminal/bot_x`, { cookie, origin: "https://evil.example" })).toBe(
      403,
    )
  })

  test("cookie-authenticated HTTP endpoints check the origin too", async () => {
    expect((await fetch(`${server.base}/api/attachments/att_x`)).status).toBe(401)
    expect(
      (await fetch(`${server.base}/api/attachments/att_x`, { headers: { cookie, origin: "https://evil.example" } }))
        .status,
    ).toBe(403)
    expect((await fetch(`${server.base}/api/favicon?host=example.com`)).status).toBe(401)
    expect(
      (
        await fetch(`${server.base}/api/favicon?host=example.com`, {
          headers: { cookie, origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403)
    // only domain names are looked up: never an address on the brain's network
    expect((await fetch(`${server.base}/api/favicon?host=127.0.0.1`, { headers: { cookie } })).status).toBe(400)
    expect((await fetch(`${server.base}/api/auth/ws-ticket`, { method: "POST" })).status).toBe(401)
    expect(
      (
        await fetch(`${server.base}/api/auth/ws-ticket`, {
          method: "POST",
          headers: { cookie, origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403)
    expect(await (await fetch(`${server.base}/api/auth/status`, { headers: { cookie } })).json()).toEqual({
      authenticated: true,
    })
    expect(await (await fetch(`${server.base}/api/auth/status`)).json()).toEqual({ authenticated: false })
  })

  test("the iPhone app: a one-time code from the signed-in web app (or the owner token) buys a session it sends as the cookie header", async () => {
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${server.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      })
    // minting needs the web session
    expect((await post("/api/auth/app-code", {})).status).toBe(401)
    const minted = (await (await post("/api/auth/app-code", {}, { cookie, origin: server.base })).json()) as {
      code: string
      expiresInSeconds: number
    }
    expect(minted.expiresInSeconds).toBe(300)
    const login = await post("/api/auth/app-login", { code: minted.code })
    expect(login.status).toBe(200)
    const { sessionToken } = (await login.json()) as { sessionToken: string }
    // the app's session works as a bearer (or cookie) without an Origin, on HTTP and on the RPC socket
    const bearer = { authorization: `Bearer ${sessionToken}` }
    expect(await (await fetch(`${server.base}/api/auth/status`, { headers: bearer })).json()).toEqual({
      authenticated: true,
    })
    expect(
      await (
        await fetch(`${server.base}/api/auth/status`, { headers: { cookie: `openbot_session=${sessionToken}` } })
      ).json(),
    ).toEqual({ authenticated: true })
    expect(await upgradeStatus(`${server.base}/rpc`, bearer)).toBe(101)
    expect(await upgradeStatus(`${server.base}/rpc`, { authorization: "Bearer forged-session-token-value" })).toBe(401)
    // its in-app web pages: a one-time code puts the app's own session in the web view's cookie
    const web = (await (await post("/api/auth/web-code", {}, bearer)).json()) as { code: string }
    const next = encodeURIComponent("#/settings/computers")
    const signedIn = await fetch(`${server.base}/api/auth/login?code=${web.code}&next=${next}`, { redirect: "manual" })
    expect(signedIn.status).toBe(302)
    expect(signedIn.headers.get("location")).toBe("/#/settings/computers")
    expect(signedIn.headers.get("set-cookie")).toContain(`openbot_session=${sessionToken}`)
    expect((await fetch(`${server.base}/api/auth/login?code=${web.code}`, { redirect: "manual" })).status).toBe(401)
    expect((await post("/api/auth/web-code", {})).status).toBe(401)
    // single use
    expect((await post("/api/auth/app-login", { code: minted.code })).status).toBe(401)
    // the printed login link's token works too; anything else does not
    expect((await post("/api/auth/app-login", { token: server.ownerToken })).status).toBe(200)
    expect((await post("/api/auth/app-login", { token: "nope" })).status).toBe(401)
    expect((await post("/api/auth/app-login", {})).status).toBe(401)
  })

  test("the desktop app: its code is allowed in the signed-in browser, then its poll buys a session", async () => {
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${server.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      })
    const started = (await (await post("/api/auth/device/start", {})).json()) as {
      deviceCode: string
      userCode: string
      expiresInSeconds: number
    }
    expect(started.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(started.expiresInSeconds).toBe(600)
    expect(await (await post("/api/auth/device/poll", { deviceCode: started.deviceCode })).json()).toEqual({
      status: "pending",
    })
    // allowing needs the web session; the code may be typed in any case and without its dash
    expect((await post("/api/auth/device/approve", { code: started.userCode })).status).toBe(401)
    expect(
      (await post("/api/auth/device/approve", { code: "ZZZZ-ZZZZ" }, { cookie, origin: server.base })).status,
    ).toBe(404)
    const typed = started.userCode.replace("-", "").toLowerCase()
    expect((await post("/api/auth/device/approve", { code: typed }, { cookie, origin: server.base })).status).toBe(200)
    const approved = (await (await post("/api/auth/device/poll", { deviceCode: started.deviceCode })).json()) as {
      status: string
      code: string
    }
    expect(approved.status).toBe("approved")
    const login = (await (await post("/api/auth/app-login", { code: approved.code })).json()) as {
      sessionToken: string
    }
    expect(
      await (
        await fetch(`${server.base}/api/auth/status`, { headers: { authorization: `Bearer ${login.sessionToken}` } })
      ).json(),
    ).toEqual({ authenticated: true })
    // once only; unknown device codes are gone
    expect((await post("/api/auth/device/poll", { deviceCode: started.deviceCode })).status).toBe(410)
    expect((await post("/api/auth/device/poll", { deviceCode: "nope" })).status).toBe(410)
  })

  test("a browser signs in with another device: a signed-in app picks the number it shows", async () => {
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${server.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      })
    const chrome = { origin: server.base, "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/156.0 Safari/537.36" }
    type Started = { deviceCode: string; match: number; expiresInSeconds: number }
    const start = async () =>
      (await (await post("/api/auth/device/start", { kind: "browser" }, chrome)).json()) as Started
    // only from the login page itself
    expect((await post("/api/auth/device/start", { kind: "browser" }, { origin: "https://evil.example" })).status).toBe(
      403,
    )
    // the login page loads its script, and nothing else
    const page = await fetch(`${server.base}/`)
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'")
    expect(await page.text()).toContain(`<script src="/login.js" defer></script>`)
    expect((await fetch(`${server.base}/login.js`)).headers.get("content-type")).toContain("text/javascript")

    // the request reaches every signed-in app (roster snapshots) with three numbers to pick from
    const wrong = await start()
    expect(wrong.match).toBeGreaterThanOrEqual(10)
    expect(wrong.expiresInSeconds).toBe(300)
    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* connect()
          const first = yield* client["roster.subscribe"]({}).pipe(Stream.take(1), Stream.runCollect)
          return [...first][0]!
        }),
      ),
    )
    const request = snapshot.kind === "snapshot" ? snapshot.signIns?.[0] : undefined
    expect(request?.from).toBe("Chrome on Linux")
    expect(request?.choices).toHaveLength(3)
    expect(request?.choices).toContain(wrong.match)
    // a wrong number cancels it
    const other = request!.choices.find((n) => n !== wrong.match)!
    const picked = await post(
      "/api/auth/device/approve",
      { code: request!.code, match: other },
      { cookie, origin: server.base },
    )
    expect(picked.status).toBe(409)
    expect(await (await post("/api/auth/device/poll", { deviceCode: wrong.deviceCode }, chrome)).json()).toEqual({
      status: "refused",
    })

    // the right number: the browser's poll comes back with a session cookie
    const right = await start()
    expect(await (await post("/api/auth/device/poll", { deviceCode: right.deviceCode }, chrome)).json()).toEqual({
      status: "pending",
    })
    const roster = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* connect()
          const first = yield* client["roster.subscribe"]({}).pipe(Stream.take(1), Stream.runCollect)
          return [...first][0]!
        }),
      ),
    )
    const code =
      roster.kind === "snapshot" ? roster.signIns?.find((r) => r.choices.includes(right.match))?.code : undefined
    expect((await post("/api/auth/device/approve", { code, match: right.match })).status).toBe(401)
    expect(
      (await post("/api/auth/device/approve", { code, match: right.match }, { cookie, origin: server.base })).status,
    ).toBe(200)
    const allowed = await post("/api/auth/device/poll", { deviceCode: right.deviceCode }, chrome)
    expect(await allowed.json()).toEqual({ status: "approved" })
    const session = (allowed.headers.get("set-cookie") ?? "").split(";")[0]!
    expect(session).toMatch(/^openbot_session=/)
    expect(await (await fetch(`${server.base}/api/auth/status`, { headers: { cookie: session } })).json()).toEqual({
      authenticated: true,
    })
    expect((await post("/api/auth/device/poll", { deviceCode: right.deviceCode }, chrome)).status).toBe(410)

    // "Not me" turns it down
    const unknown = await start()
    const pending = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* connect()
          const first = yield* client["roster.subscribe"]({}).pipe(Stream.take(1), Stream.runCollect)
          return [...first][0]!
        }),
      ),
    )
    const theirs =
      pending.kind === "snapshot" ? pending.signIns?.find((r) => r.choices.includes(unknown.match)) : undefined
    expect(
      (await post("/api/auth/device/approve", { code: theirs?.code, refuse: true }, { cookie, origin: server.base }))
        .status,
    ).toBe(200)
    expect(await (await post("/api/auth/device/poll", { deviceCode: unknown.deviceCode }, chrome)).json()).toEqual({
      status: "refused",
    })
  })

  test("the desktop app downloads: an install script with this OpenBot's address; unknown targets are refused", async () => {
    const script = await (await fetch(`${server.base}/desktop/install.sh`)).text()
    expect(script).toStartWith("#!/bin/sh")
    expect(script).toContain(`ORIGIN='${server.base}'`)
    expect(script).toContain('"$ORIGIN/desktop/download/$TARGET"')
    expect((await fetch(`${server.base}/desktop/download/beos-x86`)).status).toBe(404)
  })

  test("each listener serves only its own routes; the MCP gateway is bearer-only", async () => {
    // internal routes are not mounted on the public listener, and vice versa
    expect((await fetch(`${server.base}/mcp/bot_x`, { method: "POST", headers: { cookie } })).status).toBe(404)
    expect((await fetch(`${server.base}/relay/node_x/codex.exec-server`)).status).toBe(404)
    expect((await fetch(`${server.internalBase}/`)).status).toBe(404)
    expect((await fetch(`${server.internalBase}/api/auth/status`)).status).toBe(404)
    expect(await upgradeStatus(`${server.internalBase}/rpc`, { cookie })).toBe(404)
    expect(await upgradeStatus(`${server.internalBase}/node`, {})).toBe(404)
    // a browser cookie is not an MCP credential
    const res = await fetch(`${server.internalBase}/mcp/bot_x`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    })
    expect(res.status).toBe(401)
  })
})

describe("rpc", () => {
  test(
    "bot → message → streamed entries → approval card → routine runNow",
    () =>
      server.run(
        Effect.gen(function* () {
          const client = yield* connect()
          const info = yield* client["session.info"]()
          expect(info).toMatchObject({ firstRun: true, dataDir: server.dataDir })

          const statuses = yield* client["harnesses.status"]()
          expect(statuses).toHaveLength(1)
          expect(statuses[0]).toMatchObject({ kind: "fake", installed: true })

          // roster: snapshot then live bot.upserted
          const roster = yield* Ref.make<ReadonlyArray<string>>([])
          yield* client["roster.subscribe"]({}).pipe(
            Stream.runForEach((item) =>
              Ref.update(roster, (all) => [
                ...all,
                item.kind === "change" ? `change:${(item.change as { type: string }).type}` : item.kind,
              ]),
            ),
            Effect.forkScoped,
          )
          yield* eventually(Ref.get(roster), (items) => items.includes("synchronized"), {
            label: "roster synchronized",
          })

          const bot: Bot = yield* createBot(client, "Scout")
          expect(bot).toMatchObject({ name: "Scout", harness: { kind: "fake" }, hostNodeId: LOCAL_NODE_ID })
          yield* eventually(Ref.get(roster), (items) => items.includes("change:bot.upserted"), {
            label: "roster bot.upserted",
          })
          expect((yield* client["session.info"]()).firstRun).toBe(false)

          // a message: the reply streams in as entry upserts
          const convo = yield* watchConversation(client, bot.directConversationId)
          yield* eventually(Ref.get(convo.state), (s) => s.synchronized, { label: "conversation synchronized" })
          // a Bot the owner creates first introduces itself in a hidden turn (no user bubble)
          const introduced = yield* eventually(
            Ref.get(convo.state),
            (s) => s.turns.size === 1 && [...s.turns.values()].every((t) => isTerminalTurnStatus(t.status)),
            { label: "introduction turn" },
          )
          expect([...introduced.turns.values()].map((t) => t.trigger)).toEqual(["system"])
          expect(transcriptOf(introduced).some((e) => e.kind === "message" && e.role === "user")).toBe(false)
          expect(botMessages(transcriptOf(introduced))).toEqual([
            "Hi, I'm Scout, running on the offline Fake harness. What should I help with first?",
          ])
          const sent = yield* client["messages.send"]({
            conversationId: bot.directConversationId,
            text: "echo: hello from the test",
            clientNonce: "send-1",
          })
          expect(sent.disposition).toBe("started")
          expect(sent.turnIds).toHaveLength(1)
          const replied = yield* eventually(
            Ref.get(convo.state),
            (s) => botMessages(transcriptOf(s)).some((t) => t.includes("hello from the test")),
            { label: "bot reply" },
          )
          const userEntry = transcriptOf(replied).find((e) => e.kind === "message" && e.role === "user")
          expect(userEntry).toMatchObject({ text: "echo: hello from the test" })
          const items = yield* Ref.get(convo.items)
          const upserts = items.filter(
            (i) => i.kind === "change" && (i.change as { type: string }).type === "entry.upserted",
          )
          expect(upserts.length).toBeGreaterThan(2)
          // the same entry arrives more than once while it streams (whole-entry upserts with revisions)
          const botEntryIds = upserts.flatMap((i) => {
            const change = (i as { change: { entry?: TranscriptEntry } }).change
            return change.entry?.kind === "message" && change.entry.role === "bot" ? [change.entry.id] : []
          })
          expect(new Set(botEntryIds).size).toBeLessThan(botEntryIds.length)
          // a duplicate send (same nonce) is not delivered twice
          const again = yield* client["messages.send"]({
            conversationId: bot.directConversationId,
            text: "echo: hello from the test",
            clientNonce: "send-1",
          })
          expect(again.disposition).toBe("duplicate")

          // new bots work freely in their own workspace ("workspace" autonomy); "ask" brings cards back
          expect(bot.autonomy).toBe("workspace")
          expect((yield* client["bots.update"]({ botId: bot.id, patch: { autonomy: "ask" } })).autonomy).toBe("ask")

          // an approval card (fake directive `approve:`), answered over RPC
          yield* client["messages.send"]({
            conversationId: bot.directConversationId,
            text: "approve: rm -rf ./build",
            clientNonce: "send-2",
          })
          const asking = yield* eventually(Ref.get(convo.state), (s) => pendingRequestsOf(s).length === 1, {
            label: "pending approval",
          })
          const request = pendingRequestsOf(asking)[0]!
          expect(request.kind).toBe("command-approval")
          expect(yield* client["requests.listPending"]({ conversationId: bot.directConversationId })).toHaveLength(1)
          const resolved = yield* client["requests.respond"]({
            requestId: request.id,
            response: { type: "decision", decision: "allow-once" },
          })
          expect(resolved.status).toBe("resolved")
          yield* eventually(
            Ref.get(convo.state),
            (s) => botMessages(transcriptOf(s)).some((t) => t.includes("Approved (allow-once)")),
            { label: "post-approval reply" },
          )
          const answeredAgain = yield* Effect.flip(
            client["requests.respond"]({
              requestId: request.id,
              response: { type: "decision", decision: "deny" },
            }),
          )
          expect(answeredAgain._tag).toBe("RequestNotPending")

          // back on "workspace": the same kind of command inside the workspace runs without a card,
          // leaving an auto-decided event line
          yield* client["bots.update"]({ botId: bot.id, patch: { autonomy: "workspace" } })
          yield* client["messages.send"]({
            conversationId: bot.directConversationId,
            text: "approve: bun test",
            clientNonce: "send-3",
          })
          const auto = yield* eventually(
            Ref.get(convo.state),
            (s) => botMessages(transcriptOf(s)).filter((t) => t.includes("Approved (allow-once)")).length >= 2,
            { label: "auto-approved reply" },
          )
          expect(pendingRequestsOf(auto)).toHaveLength(0)
          expect(
            transcriptOf(auto).some(
              (e) => e.kind === "event" && e.event.type === "auto-decided" && e.event.autonomy === "workspace",
            ),
          ).toBe(true)
          // the auto-decided event carries its turn and the tool call it gated (the UI folds it into steps)
          const autoEvent = transcriptOf(auto).find((e) => e.kind === "event" && e.event.type === "auto-decided")!
          expect(autoEvent.turnId).toBeDefined()
          expect(
            autoEvent.kind === "event" && autoEvent.event.type === "auto-decided" && autoEvent.event.toolKey,
          ).toBeTruthy()

          // project folders: work in a git repo outside the workspace asks with "Allow in <repo root>";
          // answering it adds the folder to the bot, and later work there needs no card
          const repo = join(server.dataDir, "projects", "snip")
          mkdirSync(join(repo, ".git"), { recursive: true })
          mkdirSync(join(repo, "src"), { recursive: true })
          const invalid = yield* Effect.flip(client["bots.update"]({ botId: bot.id, patch: { projectFolders: ["/"] } }))
          expect(invalid._tag).toBe("InvalidInput")
          yield* client["messages.send"]({
            conversationId: bot.directConversationId,
            text: `approve: bun test @ ${repo}/src`,
            clientNonce: "send-4",
          })
          const offered = yield* eventually(Ref.get(convo.state), (s) => pendingRequestsOf(s).length === 1, {
            label: "folder offer",
          })
          const offer = pendingRequestsOf(offered)[0]!
          expect(offer.projectFolder).toBe(repo)
          yield* client["requests.respond"]({
            requestId: offer.id,
            response: { type: "decision", decision: "allow-once", scope: "project-folder" },
          })
          expect((yield* client["bots.get"]({ botId: bot.id })).projectFolders).toEqual([repo])
          yield* eventually(
            Ref.get(convo.state),
            (s) => botMessages(transcriptOf(s)).filter((t) => t.includes("Approved (allow-once)")).length >= 3,
            { label: "allowed in folder" },
          )
          yield* client["messages.send"]({
            conversationId: bot.directConversationId,
            text: `approve: bun run build @ ${repo}`,
            clientNonce: "send-5",
          })
          const inFolder = yield* eventually(
            Ref.get(convo.state),
            (s) => botMessages(transcriptOf(s)).filter((t) => t.includes("Approved (allow-once)")).length >= 4,
            { label: "auto-approved in the project folder" },
          )
          expect(pendingRequestsOf(inFolder)).toHaveLength(0)
          yield* client["bots.update"]({ botId: bot.id, patch: { projectFolders: [] } })

          // the default autonomy for new bots (Settings)
          yield* client["settings.update"]({ patch: { defaultAutonomy: "ask", sharedProjectFolders: ["~/projects"] } })
          expect((yield* createBot(client, "Careful")).autonomy).toBe("ask")
          const badShared = yield* Effect.flip(client["settings.update"]({ patch: { sharedProjectFolders: ["~"] } }))
          expect(badShared._tag).toBe("InvalidInput")
          yield* client["settings.update"]({ patch: { defaultAutonomy: "workspace", sharedProjectFolders: [] } })

          // a routine, run now
          const routine = yield* client["routines.create"]({
            botId: bot.id,
            spec: {
              name: "Echo routine",
              prompt: "echo: routine ran",
              trigger: { type: "manual" },
              enabled: true,
              output: "direct",
            },
          })
          const run = yield* client["routines.runNow"]({ routineId: routine.id })
          expect(run.routineId).toBe(routine.id)
          const runs = yield* eventually(
            client["routines.runs"]({ routineId: routine.id }),
            (all) => all[0]?.status === "succeeded",
            { label: "routine run succeeded" },
          )
          expect(runs[0]!.id).toBe(run.id)
          yield* eventually(
            Ref.get(convo.state),
            (s) => botMessages(transcriptOf(s)).some((t) => t.includes("routine ran")),
            { label: "routine reply" },
          )

          // typed errors cross the edge unchanged
          const missing = yield* Effect.flip(client["bots.get"]({ botId: "bot_missing" as Bot["id"] }))
          expect(missing).toMatchObject({ _tag: "NotFound" })
          const unknownHarness = yield* Effect.flip(client["harnesses.models"]({ kind: "nope" }))
          expect(unknownHarness._tag).toBe("HarnessUnavailable")
          expect((yield* client["harnesses.models"]({ kind: "fake" })).length).toBeGreaterThan(0)
        }),
      ),
    60_000,
  )

  test(
    "one mind per bot: a group turn and a DM turn share the bot's session; deleting the group keeps the bots",
    () =>
      server.run(
        Effect.gen(function* () {
          const client = yield* connect()
          const ada = yield* createBot(client, "Ada")
          const bob = yield* createBot(client, "Bob")
          const group = yield* client["conversations.createGroup"]({
            title: "secret project",
            memberBotIds: [ada.id, bob.id],
            leadBotId: ada.id,
          })
          const groupView = yield* watchConversation(client, group.id)
          yield* client["messages.send"]({
            conversationId: group.id,
            text: "@Ada echo: renamed the repo to tick",
            clientNonce: "om-1",
          })
          yield* eventually(
            Ref.get(groupView.state),
            (s) => botMessages(transcriptOf(s)).includes("renamed the repo to tick"),
            {
              label: "group reply",
            },
          )
          // In her DM, Ada remembers what she just did in the group: same native session.
          const dm = yield* watchConversation(client, ada.directConversationId)
          yield* client["messages.send"]({
            conversationId: ada.directConversationId,
            text: "recall:",
            clientNonce: "om-2",
          })
          const recalled = yield* eventually(
            Ref.get(dm.state),
            (s) => botMessages(transcriptOf(s)).some((t) => t.startsWith("Session ")),
            {
              label: "dm recall",
            },
          )
          const memory = botMessages(transcriptOf(recalled)).find((t) => t.startsWith("Session "))!
          expect(memory).toContain(`fake-${sessionKeyOf(ada.id, ada.directConversationId).replaceAll(":", "-")}-`)
          // the group turn and this DM turn: creating the group changed Ada's instructions (they list her
          // groups), so her session was reopened, resuming the same native session
          expect(memory).toContain("turn 2")
          expect(memory).toContain('I last said: "renamed the repo to tick"')
          // The group's transcript holds the group turn only (nothing from the DM leaked in).
          expect(botMessages(transcriptOf(yield* Ref.get(groupView.state)))).toEqual(["renamed the repo to tick"])

          // conversations.delete: groups only
          const refused = yield* Effect.flip(
            client["conversations.delete"]({ conversationId: ada.directConversationId }),
          )
          expect(refused._tag).toBe("InvalidInput")
          yield* client["conversations.delete"]({ conversationId: group.id })
          const gone = yield* Effect.flip(
            client["conversations.history"]({ conversationId: group.id, beforeCursor: "", limit: 10 }),
          )
          expect(gone._tag).toBe("NotFound")
          expect((yield* client["bots.get"]({ botId: ada.id })).name).toBe("Ada")
          expect((yield* client["bots.get"]({ botId: bob.id })).name).toBe("Bob")
        }),
      ),
    60_000,
  )

  test(
    "attachments upload over RPC and download with the cookie",
    () =>
      server.run(
        Effect.gen(function* () {
          const client = yield* connect()
          const attachment = yield* client["attachments.upload"]({
            name: "notes.txt",
            mime: "text/plain",
            bytesBase64: Buffer.from("hello attachment").toString("base64"),
          })
          const res = yield* Effect.promise(() =>
            fetch(`${server.base}/api/attachments/${attachment.id}`, { headers: { cookie } }),
          )
          expect(res.status).toBe(200)
          expect(res.headers.get("content-type")).toContain("text/plain")
          expect(res.headers.get("x-content-type-options")).toBe("nosniff")
          expect(yield* Effect.promise(() => res.text())).toBe("hello attachment")
          const bad = yield* Effect.flip(
            client["attachments.upload"]({ name: "x", mime: "text/plain", bytesBase64: "%%%" }),
          )
          expect(bad._tag).toBe("InvalidInput")
        }),
      ),
    30_000,
  )

  test(
    "send_file end to end: fake bot → MCP gateway → local node transfer → attachment → message → ranged download",
    () =>
      server.run(
        Effect.gen(function* () {
          const client = yield* connect()
          const bot: Bot = yield* createBot(client, "Renderer")
          // the bot rendered a video into its workspace on the local node
          const workspace = join(server.dataDir, "bots", bot.id, "workspace")
          mkdirSync(join(workspace, "output"), { recursive: true })
          const video = new Uint8Array(3 * 1024 * 1024 + 99)
          for (let i = 0; i < video.length; i++) video[i] = (i * 13 + (i >> 8)) & 0xff
          video.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
          yield* Effect.promise(() => Bun.write(join(workspace, "output", "cache-demo.mp4"), video))

          const convo = yield* watchConversation(client, bot.directConversationId)
          yield* eventually(Ref.get(convo.state), (s) => s.synchronized, { label: "conversation synchronized" })
          yield* client["messages.send"]({
            conversationId: bot.directConversationId,
            text: `tool: send_file {"path":"output/cache-demo.mp4","caption":"Here is the render"}`,
            clientNonce: "send-file-1",
          })
          const done = yield* eventually(
            Ref.get(convo.state),
            (s) => transcriptOf(s).some((e) => e.kind === "message" && e.role === "bot" && e.attachments.length > 0),
            { label: "file message", timeout: 20_000 },
          )
          const message = transcriptOf(done).find(
            (e) => e.kind === "message" && e.role === "bot" && e.attachments.length > 0,
          )!
          if (message.kind !== "message") throw new Error("unreachable")
          expect(message).toMatchObject({
            author: { kind: "bot", botId: bot.id },
            text: "Here is the render",
            conversationId: bot.directConversationId,
          })
          const attachment = message.attachments[0]!
          expect(attachment).toMatchObject({ name: "cache-demo.mp4", mime: "video/mp4", byteSize: video.byteLength })

          const fetched = yield* Effect.promise(async () => {
            const res = await fetch(`${server.base}${attachment.url}`, { headers: { cookie } })
            return {
              status: res.status,
              type: res.headers.get("content-type"),
              body: new Uint8Array(await res.arrayBuffer()),
            }
          })
          expect(fetched.status).toBe(200)
          expect(fetched.type).toBe("video/mp4")
          expect(new Bun.CryptoHasher("sha256").update(fetched.body).digest("hex")).toBe(
            new Bun.CryptoHasher("sha256").update(video).digest("hex"),
          )
          const tail = yield* Effect.promise(async () => {
            const res = await fetch(`${server.base}${attachment.url}`, { headers: { cookie, range: "bytes=-1000" } })
            return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) }
          })
          expect(tail.status).toBe(206)
          expect(tail.body).toEqual(video.subarray(video.length - 1000))
        }),
      ),
    60_000,
  )

  test(
    "bot → bot: send_file `to` lands in the recipient's chat and in its workspace inbox on disk",
    () =>
      server.run(
        Effect.gen(function* () {
          const client = yield* connect()
          const ada: Bot = yield* createBot(client, "Sender")
          const bob: Bot = yield* createBot(client, "Receiver")
          const out = join(server.dataDir, "bots", ada.id, "workspace", "out")
          mkdirSync(out, { recursive: true })
          const chart = new Uint8Array(70_000)
          for (let i = 0; i < chart.length; i++) chart[i] = (i * 31) & 0xff
          chart.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
          yield* Effect.promise(() => Bun.write(join(out, "chart.png"), chart))

          const bobConvo = yield* watchConversation(client, bob.directConversationId)
          yield* client["messages.send"]({
            conversationId: ada.directConversationId,
            text: `tool: send_file {"path":"out/chart.png","to":"Receiver","caption":"The chart"}`,
            clientNonce: "send-file-bot-1",
          })
          // Bob's chat: the file message from Ada, then Bob's (fake) reply to it (not his introduction,
          // which may come first)
          const state = yield* eventually(
            Ref.get(bobConvo.state),
            (s) => {
              const entries = transcriptOf(s)
              const file = entries.findIndex((e) => e.kind === "message" && e.attachments.length > 0)
              return (
                file >= 0 &&
                entries
                  .slice(file + 1)
                  .some(
                    (e) => e.kind === "message" && e.author.kind === "bot" && e.author.botId === bob.id && !e.streaming,
                  )
              )
            },
            { label: "the file, then the recipient's reply", timeout: 20_000 },
          )
          const fileMessage = transcriptOf(state).find((e) => e.kind === "message" && e.attachments.length > 0)!
          if (fileMessage.kind !== "message") throw new Error("unreachable")
          expect(fileMessage).toMatchObject({
            author: { kind: "bot", botId: ada.id },
            toBotId: bob.id,
            text: "The chart",
          })
          const attachment = fileMessage.attachments[0]!
          const inbox = join(server.dataDir, "bots", bob.id, "workspace", "inbox", attachment.id, "chart.png")
          const copied = new Uint8Array(yield* Effect.promise(() => Bun.file(inbox).arrayBuffer()))
          expect(new Bun.CryptoHasher("sha256").update(copied).digest("hex")).toBe(
            new Bun.CryptoHasher("sha256").update(chart).digest("hex"),
          )
        }),
      ),
    60_000,
  )

  test(
    "attachments stream with byte ranges (206 / 416), inline media, downloads on request",
    () =>
      server.run(
        Effect.gen(function* () {
          const client = yield* connect()
          const bytes = new Uint8Array(100_000)
          for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
          bytes.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
          const video = yield* client["attachments.upload"]({
            name: "cache demo.mp4",
            mime: "video/mp4",
            bytesBase64: Buffer.from(bytes).toString("base64"),
          })
          const url = `${server.base}/api/attachments/${video.id}`
          const get = (headers: Record<string, string> = {}, path = url, method = "GET") =>
            Effect.promise(async () => {
              const res = await fetch(path, { method, headers: { cookie, ...headers } })
              return { status: res.status, headers: res.headers, body: new Uint8Array(await res.arrayBuffer()) }
            })

          const full = yield* get()
          expect(full.status).toBe(200)
          expect(full.headers.get("content-type")).toBe("video/mp4")
          expect(full.headers.get("content-length")).toBe("100000")
          expect(full.headers.get("accept-ranges")).toBe("bytes")
          expect(full.headers.get("content-disposition")).toBe(
            `inline; filename="cache demo.mp4"; filename*=UTF-8''cache%20demo.mp4`,
          )
          expect(full.headers.get("x-content-type-options")).toBe("nosniff")
          expect(full.headers.get("content-security-policy")).toStartWith("sandbox;")
          expect(full.body).toEqual(bytes)

          // iOS Safari probes with bytes=0-1 before it plays a video
          const probe = yield* get({ range: "bytes=0-1" })
          expect(probe.status).toBe(206)
          expect(probe.headers.get("content-range")).toBe("bytes 0-1/100000")
          expect(probe.headers.get("content-length")).toBe("2")
          expect(probe.headers.get("content-type")).toBe("video/mp4")
          expect([...probe.body]).toEqual([0, 0])
          const middle = yield* get({ range: "bytes=50000-50999" })
          expect(middle.status).toBe(206)
          expect(middle.headers.get("content-range")).toBe("bytes 50000-50999/100000")
          expect(middle.body).toEqual(bytes.subarray(50000, 51000))
          const open = yield* get({ range: "bytes=99990-" })
          expect(open.headers.get("content-range")).toBe("bytes 99990-99999/100000")
          expect(open.body).toEqual(bytes.subarray(99990))
          const suffix = yield* get({ range: "bytes=-16" })
          expect(suffix.headers.get("content-range")).toBe("bytes 99984-99999/100000")
          expect(suffix.body).toEqual(bytes.subarray(99984))
          const beyond = yield* get({ range: "bytes=100000-" })
          expect(beyond.status).toBe(416)
          expect(beyond.headers.get("content-range")).toBe("bytes */100000")
          const several = yield* get({ range: "bytes=0-1,5-9" })
          expect(several.status).toBe(200)
          expect(several.body.byteLength).toBe(100_000)

          const head = yield* get({}, url, "HEAD")
          expect(head.status).toBe(200)
          expect(head.headers.get("content-length")).toBe("100000")
          expect(head.body.byteLength).toBe(0)

          const forced = yield* get({}, `${url}?download=1`)
          expect(forced.headers.get("content-disposition")).toStartWith("attachment;")

          const pdf = yield* client["attachments.upload"]({
            name: "report.pdf",
            mime: "application/pdf",
            bytesBase64: Buffer.from("%PDF-1.7\n").toString("base64"),
          })
          const pdfRes = yield* get({}, `${server.base}/api/attachments/${pdf.id}`)
          expect(pdfRes.headers.get("content-disposition")).toStartWith("inline;")
          expect(pdfRes.headers.get("content-security-policy")).not.toContain("sandbox")
          const zip = yield* client["attachments.upload"]({
            name: "site.zip",
            mime: "application/zip",
            bytesBase64: Buffer.from("PK\u0003\u0004").toString("base64"),
          })
          const zipRes = yield* get({}, `${server.base}/api/attachments/${zip.id}`)
          expect(zipRes.headers.get("content-disposition")).toStartWith("attachment;")
          expect(zipRes.headers.get("content-security-policy")).toStartWith("sandbox;")
          // HTML opens as a page, scripts on, but never as our origin (no allow-same-origin)
          for (const [name, mime] of [
            ["mockup.html", "text/html"],
            ["mockup.htm", "application/octet-stream"],
          ] as const) {
            const page = yield* client["attachments.upload"]({
              name,
              mime,
              bytesBase64: Buffer.from("<!doctype html><script>1</script>").toString("base64"),
            })
            const pageRes = yield* get({}, `${server.base}/api/attachments/${page.id}`)
            expect(pageRes.headers.get("content-type")).toStartWith("text/html")
            expect(pageRes.headers.get("content-disposition")).toStartWith("inline;")
            const csp = pageRes.headers.get("content-security-policy") ?? ""
            expect(csp).toStartWith("sandbox allow-scripts")
            expect(csp).not.toContain("allow-same-origin")
            const pageDl = yield* get({}, `${server.base}/api/attachments/${page.id}?download=1`)
            expect(pageDl.headers.get("content-disposition")).toStartWith("attachment;")
          }
          expect((yield* get({ cookie: "" }, url)).status).toBe(401)
        }),
      ),
    30_000,
  )
})

describe("sessions", () => {
  test("a wsTicket opens /rpc once without a cookie", async () => {
    const res = await fetch(`${server.base}/api/auth/ws-ticket`, {
      method: "POST",
      headers: { cookie, origin: server.base },
    })
    expect(res.status).toBe(200)
    const { ticket } = (await res.json()) as { ticket: string }
    await server.run(
      Effect.gen(function* () {
        const client = yield* rpcClient(`${server.wsBase}/rpc?wsTicket=${ticket}`, {})
        expect((yield* client["settings.get"]()).theme).toBeDefined()
      }),
    )
    expect(await upgradeStatus(`${server.base}/rpc?wsTicket=${ticket}`, {})).toBe(401)
  }, 30_000)

  test("logging out closes the session's open sockets", async () => {
    const second = await login(server.base, server.ownerToken)
    await server.run(
      Effect.gen(function* () {
        const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie: second, origin: server.base })
        yield* client["nodes.list"]()
        const out = yield* Effect.promise(() =>
          fetch(`${server.base}/api/auth/logout`, { method: "POST", headers: { cookie: second, origin: server.base } }),
        )
        expect(out.status).toBe(204)
        expect(out.headers.get("set-cookie")).toContain("Max-Age=0")
        const after = yield* Effect.flip(client["nodes.list"]().pipe(Effect.timeout("5 seconds")))
        expect(after._tag).not.toBe("TimeoutError")
      }),
    )
    expect(await upgradeStatus(`${server.base}/rpc`, { cookie: second, origin: server.base })).toBe(401)
    // the first session is unaffected
    expect(await (await fetch(`${server.base}/api/auth/status`, { headers: { cookie } })).json()).toEqual({
      authenticated: true,
    })
  }, 30_000)
})

describe("mcp", () => {
  test(
    "an MCP SDK client with a minted binding calls list_bots on the internal listener",
    () =>
      server.run(
        Effect.gen(function* () {
          const rpc = yield* connect()
          const bot = yield* createBot(rpc, "Gateway")
          const dataDir = yield* DataDir
          const binding = yield* (yield* McpBindingIssuer).issue({
            botId: bot.id,
            conversationId: bot.directConversationId,
            sessionKey: sessionKeyOf(bot.id, bot.directConversationId),
            toolsets: ["bot"],
            hostNodeId: LOCAL_NODE_ID,
            workspacePath: dataDir.workspaceDir(bot.id),
            boundNodeIds: [],
          })
          expect(binding.url).toBe(`${server.internalBase}/mcp/${bot.id}`)
          const client = new Client({ name: "openbot-server-test", version: "1.0.0" })
          yield* Effect.acquireRelease(
            Effect.promise(() =>
              client.connect(
                new StreamableHTTPClientTransport(new URL(binding.url), { requestInit: { headers: binding.headers } }),
              ),
            ),
            () => Effect.promise(() => client.close()),
          )
          const tools = yield* Effect.promise(() => client.listTools())
          expect(tools.tools.map((t) => t.name)).toContain("list_bots")
          const result = yield* Effect.promise(() => client.callTool({ name: "list_bots", arguments: {} }))
          expect(result.isError).not.toBe(true)
          expect(result.structuredContent).toBeUndefined()
          const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n")
          expect(text).toContain("Gateway")
          expect(text).toContain("Scout")
        }),
      ),
    30_000,
  )
})

describe("nodes", () => {
  test(
    "a node-daemon pairs over /node/pair, connects over /node and shows online",
    () =>
      server.run(
        Effect.gen(function* () {
          const client = yield* connect()
          const local = yield* client["nodes.list"]()
          expect(local.find((n) => n.id === LOCAL_NODE_ID)).toMatchObject({ kind: "local", status: "online" })

          const pairing = yield* client["nodes.createPairingCode"]()
          expect(pairing.command).toContain(server.base)
          const machine = join(server.dataDir, "..", `${server.dataDir.split("/").at(-1)}-remote`)
          const root = join(machine, "openbot")
          mkdirSync(root, { recursive: true })
          const identity = yield* pairNode({
            brainUrl: server.base,
            code: pairing.code,
            keyStore: makeKeyStore(join(machine, "node-data")),
            hostname: "remote-box",
          })
          expect(identity.brainOrigin).toBe(server.base)
          // a pairing code is single use
          const reused = yield* Effect.flip(
            pairNode({
              brainUrl: server.base,
              code: pairing.code,
              keyStore: makeKeyStore(join(machine, "node-data-2")),
            }),
          )
          expect(reused._tag).toBe("PairingError")

          yield* Layer.build(
            RemoteNodeLive({
              node: {
                nodeId: identity.nodeId,
                dataDir: join(machine, "node-data"),
                roots: [root],
                hostname: "remote-box",
                detectBinaries: false,
                browser: { enabled: false },
                forwardAudit: false,
              },
              dial: { identity, heartbeatMs: 0 },
            }),
          )
          const nodes = yield* eventually(
            client["nodes.list"](),
            (all) => all.some((n) => n.id === identity.nodeId && n.status === "online"),
            { label: "remote node online" },
          )
          expect(nodes.find((n) => n.id === identity.nodeId)).toMatchObject({
            kind: "remote",
            label: "remote-box",
            roots: [root],
          })
        }),
      ),
    30_000,
  )
})

describe("computer", () => {
  test(
    "computer.reset over RPC: returns the bot's screen status (no desktop: unchanged); unknown bot → NotFound",
    () =>
      server.run(
        Effect.gen(function* () {
          const client = yield* connect()
          const bot = yield* createBot(client, "Screeny")
          const before = yield* client["computer.status"]({ botId: bot.id })
          const reset = yield* client["computer.reset"]({ botId: bot.id })
          expect(reset).toMatchObject({ botId: bot.id, nodeId: LOCAL_NODE_ID, controller: "bot" })
          if (before.surface !== "desktop") expect(reset).toEqual(before)
          expect(yield* client["computer.status"]({ botId: bot.id })).toEqual(reset)
          const unknown = yield* Effect.flip(client["computer.reset"]({ botId: "bot_nobody" as Bot["id"] }))
          expect(unknown._tag).toBe("NotFound")
        }),
      ),
    30_000,
  )
})

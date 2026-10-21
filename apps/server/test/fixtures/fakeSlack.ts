// A fake Slack for tests (D3.4): the Web API methods OpenBot calls (`POST /api/<method>`, Bearer
// token, form body) and a Socket Mode WebSocket. Workspace "Acme": the owner (U_OWNER), Alice Smith
// (U_ALICE, @alice, DM D_ALICE), Bob (U_BOB); #general (C_GENERAL). `push` sends a Socket Mode
// envelope; `posted`, `acks`, `responses` (replies to shortcut clicks, through `response_url`),
// `uploads` (files' bytes, through the URL `files.getUploadURLExternal` hands out) and `shared`
// (`files.completeUploadExternal`) record what OpenBot sent. `setScopes` changes the token's scopes
// (an app updated in Slack).
import type { Server, ServerWebSocket } from "bun"

export const FAKE_USER_TOKEN = "xoxp-good"
export const FAKE_APP_TOKEN = "xapp-good"
/** An app made from the manifest before files could be attached. */
export const SCOPES_WITHOUT_FILES =
  "channels:history,channels:read,groups:history,groups:read,im:history,im:read,im:write,mpim:history,mpim:read,search:read,users:read,chat:write"
export const ALL_SCOPES = `${SCOPES_WITHOUT_FILES},files:write`

const members = [
  { id: "U_OWNER", name: "owner", real_name: "Owner Person", profile: { display_name: "Owner", real_name: "Owner Person", title: "" } },
  { id: "U_ALICE", name: "alice", real_name: "Alice Smith", profile: { display_name: "", real_name: "Alice Smith", title: "Designer" } },
  { id: "U_BOB", name: "bob", real_name: "Bob Jones", profile: { display_name: "Bob", real_name: "Bob Jones", title: "" } },
]
const channels = [
  { id: "C_GENERAL", name: "general", is_channel: true, is_private: false, topic: { value: "Company news" } },
  { id: "D_ALICE", is_im: true, user: "U_ALICE" },
]

export interface FakeSlack {
  readonly url: string
  readonly posted: ReadonlyArray<Record<string, string>>
  readonly acks: ReadonlyArray<string>
  readonly calls: ReadonlyArray<string>
  readonly responses: ReadonlyArray<Record<string, unknown>>
  readonly uploads: ReadonlyArray<{ readonly fileId: string; readonly filename: string; readonly length: number; readonly bytes: number; readonly authorized: boolean }>
  readonly shared: ReadonlyArray<Record<string, string>>
  readonly setScopes: (scopes: string) => void
  /** The `response_url` a shortcut click carries. */
  readonly responseUrl: string
  /** Sends a Socket Mode envelope to every connected socket. */
  readonly push: (envelope: Record<string, unknown>) => void
  readonly sockets: () => number
  readonly stop: () => void
}

export const startFakeSlack = (options?: { readonly scopes?: string }): FakeSlack => {
  const posted: Array<Record<string, string>> = []
  const acks: Array<string> = []
  const calls: Array<string> = []
  const responses: Array<Record<string, unknown>> = []
  const uploads: Array<{ fileId: string; filename: string; length: number; bytes: number; authorized: boolean }> = []
  const shared: Array<Record<string, string>> = []
  let scopes = options?.scopes ?? ALL_SCOPES
  const sockets = new Set<ServerWebSocket<unknown>>()
  let server: Server<unknown>
  const ok = (body: Record<string, unknown>, headers?: Record<string, string>) =>
    Response.json({ ok: true, ...body }, { headers: { "x-oauth-scopes": scopes, ...headers } })
  const fail = (error: string) => Response.json({ ok: false, error })
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, srv) {
      const url = new URL(request.url)
      if (url.pathname === "/socket") {
        return srv.upgrade(request, { data: undefined }) ? undefined : new Response("no", { status: 400 })
      }
      if (url.pathname.startsWith("/upload/")) {
        const upload = uploads.find((u) => u.fileId === url.pathname.slice("/upload/".length))
        if (upload === undefined) return new Response("no such upload", { status: 404 })
        upload.bytes = (await request.arrayBuffer()).byteLength
        upload.authorized = request.headers.get("authorization") === `Bearer ${FAKE_USER_TOKEN}`
        return new Response(`OK - ${upload.bytes}`)
      }
      if (url.pathname === "/respond") {
        responses.push((await request.json()) as Record<string, unknown>)
        return new Response("ok")
      }
      const method = url.pathname.replace(/^\/api\//, "")
      calls.push(method)
      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "")
      const args = Object.fromEntries(new URLSearchParams(await request.text()))
      if (method === "apps.connections.open") {
        if (token !== FAKE_APP_TOKEN) return fail("invalid_auth")
        return ok({ url: `ws://127.0.0.1:${server.port}/socket` })
      }
      if (token !== FAKE_USER_TOKEN) return fail("invalid_auth")
      switch (method) {
        case "auth.test":
          return ok({ url: "https://acme.slack.com/", team: "Acme", user: "owner", team_id: "T1", user_id: "U_OWNER" })
        case "users.list":
          return ok({ members, response_metadata: { next_cursor: "" } })
        case "users.info": {
          const user = members.find((m) => m.id === args.user)
          return user === undefined ? fail("user_not_found") : ok({ user })
        }
        case "users.conversations":
          return ok({ channels, response_metadata: { next_cursor: "" } })
        case "conversations.info": {
          const channel = channels.find((c) => c.id === args.channel)
          return channel === undefined ? fail("channel_not_found") : ok({ channel })
        }
        case "conversations.open":
          return args.users === "U_ALICE" ? ok({ channel: { id: "D_ALICE" } }) : ok({ channel: { id: "G_GROUP" } })
        case "conversations.history":
          return ok({
            messages: [
              { ts: "1729340100.000100", user: "U_ALICE", text: "Ping <@U_OWNER>, the deploy failed" },
              { ts: "1729340000.000100", user: "U_BOB", text: "see <https://x.com/doc|the doc> &amp; <#C_GENERAL>", thread_ts: "1729340000.000100", reply_count: 2 },
            ],
            has_more: true,
          })
        case "conversations.replies":
          return ok({
            messages: [
              { ts: args.ts, thread_ts: args.ts, user: "U_ALICE", text: "Can someone look at the deploy?", reply_count: 1 },
              ...(args.limit === "1" ? [] : [{ ts: "1729340300.000100", thread_ts: args.ts, user: "U_BOB", text: "On it" }]),
            ],
            has_more: false,
          })
        case "search.messages":
          return ok({
            messages: {
              total: 3,
              matches: [{
                channel: { id: "C_GENERAL", name: "general" },
                user: "U_ALICE",
                ts: "1729340000.000100",
                text: `${args.query} is broken`,
                permalink: "https://acme.slack.com/archives/C_GENERAL/p1729340050000100?thread_ts=1729340000.000100&cid=C_GENERAL",
              }],
            },
          })
        case "chat.postMessage":
          posted.push(args)
          return ok({ channel: args.channel, ts: "1729340400.000100" })
        case "files.getUploadURLExternal": {
          if (!scopes.split(",").includes("files:write")) return Response.json({ ok: false, error: "missing_scope", needed: "files:write" })
          const fileId = `F_${uploads.length + 1}`
          uploads.push({ fileId, filename: String(args.filename), length: Number(args.length), bytes: -1, authorized: false })
          return ok({ upload_url: `http://127.0.0.1:${server.port}/upload/${fileId}`, file_id: fileId })
        }
        case "files.completeUploadExternal": {
          const files = JSON.parse(args.files ?? "[]") as Array<{ id: string; title?: string }>
          if (files.some((f) => (uploads.find((u) => u.fileId === f.id)?.bytes ?? -1) < 0)) return fail("file_not_found")
          shared.push(args)
          return ok({ files: files.map((f) => ({ id: f.id, title: f.title })) })
        }
        default:
          return fail("unknown_method")
      }
    },
    websocket: {
      open(ws) {
        sockets.add(ws)
        ws.send(JSON.stringify({ type: "hello", num_connections: 1, connection_info: { app_id: "A_OPENBOT" } }))
      },
      message(_ws, message) {
        const data = JSON.parse(String(message)) as { envelope_id?: string }
        if (data.envelope_id !== undefined) acks.push(data.envelope_id)
      },
      close(ws) {
        sockets.delete(ws)
      },
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/api`,
    posted,
    acks,
    calls,
    responses,
    uploads,
    shared,
    setScopes: (next) => {
      scopes = next
    },
    responseUrl: `http://127.0.0.1:${server.port}/respond`,
    push: (envelope) => {
      for (const ws of sockets) ws.send(JSON.stringify(envelope))
    },
    sockets: () => sockets.size,
    stop: () => server.stop(true),
  }
}

let envelopes = 0
/** A Socket Mode `events_api` envelope carrying a message event. */
export const messageEnvelope = (event: Record<string, unknown>): Record<string, unknown> => {
  envelopes++
  return {
    type: "events_api",
    envelope_id: `env-${envelopes}`,
    payload: { event_id: `Ev${envelopes}`, event: { type: "message", ts: `17293405${String(envelopes).padStart(2, "0")}.000100`, ...event } },
  }
}

/** A Socket Mode `interactive` envelope: someone clicked "Send to OpenBot" on a message. */
export const shortcutEnvelope = (input: { readonly by: string; readonly channel: string; readonly message: Record<string, unknown>; readonly responseUrl: string }): Record<string, unknown> => {
  envelopes++
  return {
    type: "interactive",
    envelope_id: `env-${envelopes}`,
    payload: {
      type: "message_action",
      callback_id: "openbot_send",
      user: { id: input.by },
      channel: { id: input.channel },
      message: input.message,
      response_url: input.responseUrl,
      trigger_id: `trigger-${envelopes}`,
    },
  }
}

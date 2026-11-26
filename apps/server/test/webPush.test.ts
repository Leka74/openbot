// Web Push (D3.7) against a fake push service: payloads are encrypted as RFC 8291's example and open
// with the device's key; the VAPID token verifies; every notification goes to each live subscription,
// none while the owner is at the desktop; a logged-out session's subscription and one the push service
// forgot (404/410) are dropped; the routes need a session and keep one subscription per endpoint; the
// service worker shows pushes and opens their chat.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Notifier } from "@openbot/core"
import { sha256Hex } from "@openbot/node-protocol"
import { Effect } from "effect"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { OwnerPresence } from "../src/presence.ts"
import { SERVICE_WORKER } from "../src/web.ts"
import { encryptPayload, generateVapidKeys, makeWebPush, vapidAuthorization } from "../src/webPush.ts"
import { eventually, login, startServer, type TestServer } from "./helpers.ts"

const b64 = (text: string) => new Uint8Array(Buffer.from(text.replace(/\s/g, ""), "base64url"))
const text = (bytes: ArrayBuffer | Uint8Array) => new TextDecoder().decode(bytes)

/** A browser's side of a subscription: its key pair and auth secret, and how it opens a push. */
const makeDevice = async () => {
  const ecdh = { name: "ECDH", namedCurve: "P-256" } as const
  const pair = await crypto.subtle.generateKey(ecdh, true, ["deriveBits"])
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  const auth = crypto.getRandomValues(new Uint8Array(16))
  const hkdf = async (salt: Uint8Array<ArrayBuffer>, ikm: ArrayBuffer, info: Uint8Array<ArrayBuffer>, bytes: number) =>
    crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]),
      bytes * 8,
    )
  const decrypt = async (body: Uint8Array<ArrayBuffer>) => {
    const salt = body.slice(0, 16)
    const senderKey = body.slice(21, 21 + body[20]!)
    const sender = await crypto.subtle.importKey("raw", senderKey, ecdh, false, [])
    const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, pair.privateKey, 256)
    const info = new Uint8Array(Buffer.concat([Buffer.from("WebPush: info\0"), publicKey, senderKey]))
    const ikm = await hkdf(auth, secret, info, 32)
    const cek = await hkdf(salt, ikm, new Uint8Array(Buffer.from("Content-Encoding: aes128gcm\0")), 16)
    const nonce = await hkdf(salt, ikm, new Uint8Array(Buffer.from("Content-Encoding: nonce\0")), 12)
    const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"])
    const record = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(nonce) }, aes, body.slice(21 + body[20]!)),
    )
    expect(record.at(-1)).toBe(2)
    return JSON.parse(text(record.slice(0, -1))) as Record<string, unknown>
  }
  const keys = { p256dh: Buffer.from(publicKey).toString("base64url"), auth: Buffer.from(auth).toString("base64url") }
  return { keys, decrypt }
}

interface Sent {
  readonly url: string
  readonly headers: Headers
  readonly body: Uint8Array<ArrayBuffer>
}

/** A push service: records each request and answers `status[url]` (201 when absent). */
const fakePushService = () => {
  const sent: Array<Sent> = []
  const status: Record<string, number> = {}
  const fetchImpl = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      sent.push({ url, headers: new Headers(init?.headers), body: new Uint8Array(init?.body as Uint8Array) })
      return new Response(null, { status: status[url] ?? 201 })
    },
    { preconnect: fetch.preconnect },
  )
  return { sent, status, fetch: fetchImpl }
}

describe("Web Push", () => {
  let server: TestServer
  beforeAll(async () => {
    server = await startServer({ config: { publicOrigins: ["https://box.tailnet.ts.net:8444"] } })
  }, 30_000)
  afterAll(() => server?.close(), 30_000)

  test("encrypts as RFC 8291's example, and the device opens a push with its key", async () => {
    const body = await encryptPayload(
      {
        p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        auth: "BTBZMqHH6r4Tts7J_aSIgg",
      },
      new Uint8Array(Buffer.from("When I grow up, I want to be a watermelon")),
      {
        salt: b64("DGv6ra1nlYgDCS1FRnbzlw"),
        sender: {
          publicKey: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
          privateKey: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
        },
      },
    )
    expect(Buffer.from(body).toString("base64url")).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    )

    const device = await makeDevice()
    const sealed = await encryptPayload(device.keys, new Uint8Array(Buffer.from(JSON.stringify({ title: "Scout" }))))
    expect(await device.decrypt(sealed)).toEqual({ title: "Scout" })
  })

  test("the VAPID token is signed by the brain's key, for the push service's origin, for under 24 hours", async () => {
    const keys = await generateVapidKeys()
    const now = Date.UTC(2026, 10, 25)
    const header = await vapidAuthorization(keys, "https://web.push.apple.com/QH4x/abc", "https://box.example", now)
    const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!
    expect(k).toBe(keys.publicKey)
    const [head, claims, signature] = token!.split(".") as [string, string, string]
    expect(JSON.parse(text(b64(head)))).toEqual({ typ: "JWT", alg: "ES256" })
    const { aud, exp, sub } = JSON.parse(text(b64(claims)))
    expect({ aud, sub }).toEqual({ aud: "https://web.push.apple.com", sub: "https://box.example" })
    expect(exp * 1000 - now).toBeGreaterThan(0)
    expect(exp * 1000 - now).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
    const key = await crypto.subtle.importKey("raw", b64(k!), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
    const signed = new Uint8Array(Buffer.from(`${head}.${claims}`))
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64(signature), signed)).toBe(true)
  })

  test(
    "pushes every notification to each live subscription; drops gone ones; quiet at the desktop",
    () =>
      server.run(
        Effect.gen(function* () {
          const file = join(server.dataDir, "web-push-send.json")
          const push = fakePushService()
          const service = yield* makeWebPush({ file, fetch: push.fetch })
          const sessionOf = (cookie: string) => sha256Hex(cookie.slice(cookie.indexOf("=") + 1))
          const phoneCookie = yield* Effect.promise(() => login(server.base, server.ownerToken))
          const laptopCookie = yield* Effect.promise(() => login(server.base, server.ownerToken))
          const phone = yield* Effect.promise(makeDevice)
          const laptop = yield* Effect.promise(makeDevice)
          const gone = yield* Effect.promise(makeDevice)
          const PHONE = "https://web.push.apple.com/phone"
          const LAPTOP = "https://fcm.googleapis.com/fcm/send/laptop"
          const GONE = "https://updates.push.services.mozilla.com/gone"
          yield* service.subscribe(yield* sessionOf(phoneCookie), { endpoint: PHONE, keys: phone.keys })
          yield* service.subscribe(yield* sessionOf(laptopCookie), { endpoint: LAPTOP, keys: laptop.keys })
          yield* service.subscribe(yield* sessionOf(laptopCookie), { endpoint: GONE, keys: gone.keys })
          push.status[GONE] = 410

          const notifier = yield* Notifier
          const saved = () =>
            JSON.parse(readFileSync(file, "utf8")).subscriptions.map((s: { endpoint: string }) => s.endpoint)
          yield* notifier.notify({ kind: "message", title: "Scout", body: "The report is ready." })
          yield* eventually(
            Effect.sync(() => saved()),
            (endpoints) => !endpoints.includes(GONE),
            { label: "the gone subscription dropped" },
          )
          expect(push.sent.map((s) => s.url).sort()).toEqual([GONE, PHONE, LAPTOP].sort())
          const toPhone = push.sent.find((s) => s.url === PHONE)!
          expect(toPhone.headers.get("content-encoding")).toBe("aes128gcm")
          expect(toPhone.headers.get("ttl")).toBe("86400")
          expect(toPhone.headers.get("urgency")).toBe("normal")
          expect(toPhone.headers.get("authorization")).toStartWith(`vapid t=`)
          expect(toPhone.headers.get("authorization")).toEndWith(`, k=${service.publicKey}`)
          const opened = yield* Effect.promise(() => phone.decrypt(toPhone.body))
          expect(opened).toMatchObject({ kind: "message", title: "Scout", body: "The report is ready." })
          expect(opened).not.toHaveProperty("conversationId")

          // the laptop's session signs out: its subscription gets nothing more and is dropped
          yield* Effect.promise(() =>
            fetch(`${server.base}/api/auth/logout`, { method: "POST", headers: { cookie: laptopCookie } }),
          )
          push.sent.length = 0
          yield* notifier.notify({ kind: "error", title: "Ranger", body: "The turn failed." })
          yield* eventually(
            Effect.sync(() => push.sent.length),
            (n) => n === 1,
            { label: "the push to the phone" },
          )
          expect(push.sent[0]!.url).toBe(PHONE)
          expect(push.sent[0]!.headers.get("urgency")).toBe("high")
          expect(saved()).toEqual([PHONE])

          // a 404 drops it too
          push.status[PHONE] = 404
          yield* notifier.notify({ kind: "message", title: "Scout", body: "Again." })
          yield* eventually(Effect.sync(saved), (endpoints) => endpoints.length === 0, { label: "404 dropped" })

          // the owner is at a computer whose desktop app shows notifications: nothing is pushed
          delete push.status[PHONE]
          yield* service.subscribe(yield* sessionOf(phoneCookie), { endpoint: PHONE, keys: phone.keys })
          push.sent.length = 0
          yield* (yield* OwnerPresence).active
          yield* notifier.notify({ kind: "waiting", title: "Scout", body: "Which format?" })
          yield* Effect.sleep("500 millis")
          expect(push.sent).toEqual([])
        }),
      ),
    30_000,
  )

  test("the key pair is made once and kept with the subscriptions in a 0600 file", () =>
    server.run(
      Effect.gen(function* () {
        const file = join(server.dataDir, "web-push-keys.json")
        const first = yield* makeWebPush({ file })
        expect(statSync(file).mode & 0o777).toBe(0o600)
        expect(b64(first.publicKey).length).toBe(65)
        const again = yield* makeWebPush({ file })
        expect(again.publicKey).toBe(first.publicKey)
      }),
    ))

  test("the routes need a session, refuse what isn't a subscription, and keep one per endpoint", async () => {
    const cookie = await login(server.base, server.ownerToken)
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie }) =>
      fetch(`${server.base}${path}`, {
        method,
        headers: { ...headers, origin: server.base, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    const subscription = (endpoint: string) => ({ endpoint, keys: { p256dh: "BCVx", auth: "BTBZ" } })
    const saved = () => JSON.parse(readFileSync(join(server.dataDir, "web-push.json"), "utf8"))

    expect((await call("GET", "/api/push/key", undefined, {})).status).toBe(401)
    expect((await call("POST", "/api/push/subscription", subscription("https://push.example/a"), {})).status).toBe(401)
    expect(await (await call("GET", "/api/push/key")).json()).toEqual({ publicKey: saved().vapid.publicKey })

    expect((await call("POST", "/api/push/subscription", subscription("http://push.example/a"))).status).toBe(400)
    expect((await call("POST", "/api/push/subscription", { endpoint: "https://push.example/a" })).status).toBe(400)
    expect((await call("DELETE", "/api/push/subscription", {})).status).toBe(400)

    expect((await call("POST", "/api/push/subscription", subscription("https://push.example/a"))).status).toBe(204)
    expect((await call("POST", "/api/push/subscription", subscription("https://push.example/a"))).status).toBe(204)
    const sessionId = await Effect.runPromise(sha256Hex(cookie.slice(cookie.indexOf("=") + 1)))
    expect(saved().subscriptions).toEqual([
      { endpoint: "https://push.example/a", p256dh: "BCVx", auth: "BTBZ", sessionId },
    ])
    expect((await call("DELETE", "/api/push/subscription", { endpoint: "https://push.example/a" })).status).toBe(204)
    expect(saved().subscriptions).toEqual([])

    const worker = await fetch(`${server.base}/sw.js`)
    expect(worker.headers.get("content-type")).toStartWith("text/javascript")
    expect(await worker.text()).toBe(SERVICE_WORKER)
  })

  describe("the service worker", () => {
    const run = (windows: Array<{ url: string; focused: boolean; visibilityState: string }>) => {
      const listeners: Record<string, (event: unknown) => void> = {}
      const shown: Array<{ title: string; options: Record<string, unknown> }> = []
      const opened: Array<string> = []
      const navigated: Array<string> = []
      const clients = windows.map((w) => ({
        ...w,
        focus: async function () {
          return this
        },
        navigate: async (url: string) => void navigated.push(url),
      }))
      const self = {
        location: { origin: "https://box.example" },
        skipWaiting: () => {},
        addEventListener: (type: string, listener: (event: unknown) => void) => void (listeners[type] = listener),
        registration: {
          showNotification: async (title: string, options: Record<string, unknown>) =>
            void shown.push({ title, options }),
        },
        clients: {
          matchAll: async () => clients,
          openWindow: async (url: string) => void opened.push(url),
          claim: async () => {},
        },
      }
      new Function("self", SERVICE_WORKER)(self)
      const dispatch = async (type: string, event: object) => {
        let done: Promise<unknown> = Promise.resolve()
        listeners[type]!({ ...event, waitUntil: (p: Promise<unknown>) => void (done = p) })
        await done
      }
      const push = (payload: object) => dispatch("push", { data: { json: () => payload } })
      const click = (path: string) =>
        dispatch("notificationclick", { notification: { data: { path }, close: () => {} } })
      return { push, click, shown, opened, navigated }
    }

    test("always shows a push, also for the chat on screen, one entry per chat", async () => {
      const sw = run([{ url: "https://box.example/#/c/conv_1", focused: true, visibilityState: "visible" }])
      await sw.push({ id: "n1", kind: "finished", title: "Scout", body: "Done.", conversationId: "conv_1" })
      await sw.push({ id: "n2", kind: "waiting", title: "Scout", body: "Which day?", conversationId: "conv_1" })
      await sw.push({ id: "n3", kind: "update", title: "OpenBot", body: "A new version." })
      expect(sw.shown).toEqual([
        {
          title: "Scout",
          options: {
            body: "Done.",
            tag: "conv_1",
            renotify: true,
            requireInteraction: false,
            data: { path: "/#/c/conv_1" },
          },
        },
        {
          title: "Scout",
          options: {
            body: "Which day?",
            tag: "conv_1",
            renotify: true,
            requireInteraction: true,
            data: { path: "/#/c/conv_1" },
          },
        },
        {
          title: "OpenBot",
          options: {
            body: "A new version.",
            tag: "n3",
            renotify: true,
            requireInteraction: false,
            data: { path: "/" },
          },
        },
      ])
    })

    test("a click opens the chat in an open window, or a new one", async () => {
      const open = run([{ url: "https://box.example/", focused: false, visibilityState: "hidden" }])
      await open.click("/#/c/conv_2")
      expect(open.navigated).toEqual(["https://box.example/#/c/conv_2"])
      const closed = run([])
      await closed.click("/")
      expect(closed.opened).toEqual(["https://box.example/"])
    })
  })
})

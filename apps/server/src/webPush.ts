/**
 * Web Push (D3.7): the owner's notifications on every browser that turned on "Notifications on this device"
 * (Settings › General), also OpenBot added to an iPhone's Home Screen, with OpenBot closed. The brain
 * is its own application server: no account anywhere. It makes its VAPID key pair (RFC 8292) on first
 * start and keeps it with the subscriptions in `<data>/web-push.json` (0600). Payloads are encrypted for
 * the device (RFC 8291), so the push service (Apple, Google, Mozilla) cannot read them.
 *
 * A subscription belongs to the session that made it: once that session is gone (logged out, revoked,
 * expired) or the push service answers 404 or 410, it is dropped. Like Hark and ntfy, nothing is pushed
 * while the owner is at a computer whose desktop app shows the notifications (presence.ts).
 */
import type { Notification } from "@openbot/contracts"
import { LiveHub } from "@openbot/core"
import { Context, Effect, Layer, Option, Result, Schema, Stream } from "effect"
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { WebAuth } from "./auth.ts"
import { ServerConfig } from "./config.ts"
import { OwnerPresence } from "./presence.ts"
import { clipBytes, needsYou, notificationText } from "./push.ts"

const Base64Url = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/))

/** What `PushSubscription.toJSON()` gives the web app. */
export const PushSubscriptionInput = Schema.Struct({
  endpoint: Schema.String.check(Schema.isPattern(/^https:\/\//)),
  keys: Schema.Struct({ p256dh: Base64Url, auth: Base64Url }),
})
export interface PushSubscriptionInput extends Schema.Schema.Type<typeof PushSubscriptionInput> {}

const Subscription = Schema.Struct({
  endpoint: Schema.String,
  p256dh: Schema.String,
  auth: Schema.String,
  /** The session that subscribed (auth.ts `Session.id`). */
  sessionId: Schema.String,
})
interface Subscription extends Schema.Schema.Type<typeof Subscription> {}

const VapidKeys = Schema.Struct({
  /** The uncompressed P-256 point, base64url: what browsers take as `applicationServerKey`. */
  publicKey: Schema.String,
  /** The private scalar `d`, base64url. */
  privateKey: Schema.String,
})
export interface VapidKeys extends Schema.Schema.Type<typeof VapidKeys> {}

const Saved = Schema.Struct({
  version: Schema.Literal(1),
  vapid: VapidKeys,
  subscriptions: Schema.Array(Subscription),
})

export class WebPush extends Context.Service<
  WebPush,
  {
    readonly publicKey: string
    /** Keeps the subscription for the session (again: it moves to this session). */
    readonly subscribe: (sessionId: string, input: PushSubscriptionInput) => Effect.Effect<void>
    readonly unsubscribe: (endpoint: string) => Effect.Effect<void>
  }
>()("openbot/server/WebPush") {}

export interface WebPushOptions {
  /** `<data>/web-push.json` */
  readonly file: string
  readonly fetch?: typeof fetch | undefined
}

// ============================================================================ crypto (WebCrypto only)

const encoder = new TextEncoder()
const toBase64Url = (bytes: Uint8Array | ArrayBuffer) => Buffer.from(new Uint8Array(bytes)).toString("base64url")
const fromBase64Url = (text: string) => new Uint8Array(Buffer.from(text, "base64url"))
const concat = (...parts: Array<Uint8Array>) => new Uint8Array(Buffer.concat(parts))

/** A P-256 key as a JWK, from its uncompressed public point and (to sign or derive) its private scalar. */
const p256Jwk = (publicKey: string, privateKey?: string) => {
  const point = fromBase64Url(publicKey)
  return {
    kty: "EC",
    crv: "P-256",
    x: toBase64Url(point.slice(1, 33)),
    y: toBase64Url(point.slice(33, 65)),
    ...(privateKey === undefined ? {} : { d: privateKey }),
  }
}

export const generateVapidKeys = async (): Promise<VapidKeys> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey)
  return { publicKey: toBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey)), privateKey: jwk.d! }
}

/** `Authorization: vapid t=…, k=…` for a push to `endpoint` (RFC 8292): an ES256 JWT for its origin. */
export const vapidAuthorization = async (
  keys: VapidKeys,
  endpoint: string,
  subject: string,
  nowMs: number,
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "jwk",
    p256Jwk(keys.publicKey, keys.privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  )
  const part = (value: object) => toBase64Url(encoder.encode(JSON.stringify(value)))
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 60 * 60, sub: subject }
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part(claims)}`
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(unsigned))
  return `vapid t=${unsigned}.${toBase64Url(signature)}, k=${keys.publicKey}`
}

const hkdf = async (
  salt: Uint8Array<ArrayBuffer>,
  ikm: ArrayBuffer | Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
) => {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8))
}

const RECORD_SIZE = 4096

/**
 * The `aes128gcm` body of a push (RFC 8291, one record). `fixed` replaces the random salt and the
 * one-time sender key pair (RFC 8291's worked example).
 */
export const encryptPayload = async (
  subscription: { readonly p256dh: string; readonly auth: string },
  plaintext: Uint8Array<ArrayBuffer>,
  fixed?: {
    readonly salt: Uint8Array<ArrayBuffer>
    readonly sender: { readonly publicKey: string; readonly privateKey: string }
  },
): Promise<Uint8Array<ArrayBuffer>> => {
  const ecdh = { name: "ECDH", namedCurve: "P-256" } as const
  const sender =
    fixed === undefined
      ? await crypto.subtle.generateKey(ecdh, true, ["deriveBits"])
      : {
          privateKey: await crypto.subtle.importKey(
            "jwk",
            p256Jwk(fixed.sender.publicKey, fixed.sender.privateKey),
            ecdh,
            false,
            ["deriveBits"],
          ),
          publicKey: await crypto.subtle.importKey("jwk", p256Jwk(fixed.sender.publicKey), ecdh, true, []),
        }
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const receiverKey = fromBase64Url(subscription.p256dh)
  const receiver = await crypto.subtle.importKey("raw", receiverKey, ecdh, false, [])
  const senderKey = new Uint8Array(await crypto.subtle.exportKey("raw", sender.publicKey))
  const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: receiver }, sender.privateKey, 256)
  const keyInfo = concat(encoder.encode("WebPush: info\0"), receiverKey, senderKey)
  const ikm = await hkdf(fromBase64Url(subscription.auth), secret, keyInfo, 32)
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16)
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12)
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"])
  // 2: the padding delimiter of the last (only) record
  const record = concat(plaintext, new Uint8Array([2]))
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, record)
  const header = new Uint8Array(21)
  header.set(salt)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE)
  header[20] = senderKey.length
  return concat(header, senderKey, new Uint8Array(ciphertext))
}

// ============================================================================ the service

const decodeSaved = Schema.decodeUnknownOption(Schema.fromJsonString(Saved))

export const makeWebPush = (options: WebPushOptions) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const hub = yield* LiveHub
    const auth = yield* WebAuth
    const presence = yield* Effect.serviceOption(OwnerPresence)
    const atComputer = () => Option.isSome(presence) && presence.value.atComputer()
    const fetchImpl = options.fetch ?? fetch
    // push services want a contact (an https: or mailto: URL); the brain's own address is the only one it has
    const subject = config.publicOrigins.find((origin) => origin.startsWith("https:")) ?? "mailto:openbot@localhost"

    const read = Result.try(() => readFileSync(options.file, "utf8"))
    const loaded = Result.isSuccess(read) ? decodeSaved(read.success) : Option.none()
    const vapid = Option.isSome(loaded) ? loaded.value.vapid : yield* Effect.promise(generateVapidKeys)
    let subscriptions: ReadonlyArray<Subscription> = Option.isSome(loaded) ? loaded.value.subscriptions : []

    const save = (next: ReadonlyArray<Subscription>) =>
      Effect.try(() => {
        subscriptions = next
        mkdirSync(dirname(options.file), { recursive: true })
        const tmp = `${options.file}.tmp`
        writeFileSync(tmp, JSON.stringify({ version: 1, vapid, subscriptions }, null, 2), { mode: 0o600 })
        chmodSync(tmp, 0o600)
        renameSync(tmp, options.file)
      }).pipe(Effect.ignore({ log: "Warn", message: "Web Push: couldn't save the subscriptions" }))

    const drop = (endpoints: ReadonlyArray<string>) =>
      endpoints.length === 0 ? Effect.void : save(subscriptions.filter((s) => !endpoints.includes(s.endpoint)))

    if (Option.isNone(loaded)) yield* save(subscriptions)

    /** The push service's status, or none when it did not answer in 15 s. */
    const post = (subscription: Subscription, payload: Uint8Array<ArrayBuffer>, urgency: "high" | "normal") =>
      Effect.tryPromise(async (signal) => {
        const response = await fetchImpl(subscription.endpoint, {
          method: "POST",
          headers: {
            authorization: await vapidAuthorization(vapid, subscription.endpoint, subject, Date.now()),
            "content-encoding": "aes128gcm",
            "content-type": "application/octet-stream",
            ttl: "86400",
            urgency,
          },
          body: await encryptPayload(subscription, payload),
          signal,
        })
        return response.status
      }).pipe(Effect.timeout("15 seconds"), Effect.option)

    const forward = (n: Notification) =>
      Effect.gen(function* () {
        // the owner is at a computer whose desktop app shows it already
        if (subscriptions.length === 0 || atComputer()) return
        const live = yield* Effect.filter(subscriptions, (s) => auth.isLive(s.sessionId))
        yield* drop(subscriptions.filter((s) => !live.includes(s)).map((s) => s.endpoint))
        const payload = encoder.encode(
          JSON.stringify({
            id: n.id,
            kind: n.kind,
            title: clipBytes(n.title, 200),
            // a push carries at most 4 KB, and JSON escapes can double the text
            body: clipBytes(notificationText(n), 1_000),
            ...(n.conversationId === undefined ? {} : { conversationId: n.conversationId }),
          }),
        )
        const gone: Array<string> = []
        yield* Effect.forEach(
          live,
          (subscription) =>
            Effect.gen(function* () {
              const status = yield* post(subscription, payload, needsYou(n) ? "high" : "normal")
              if (Option.isNone(status)) {
                yield* Effect.logWarning(`Web Push: ${new URL(subscription.endpoint).host} did not answer`)
              } else if (status.value === 404 || status.value === 410) {
                gone.push(subscription.endpoint)
              } else if (status.value >= 300) {
                yield* Effect.logWarning(
                  `Web Push: ${new URL(subscription.endpoint).host} refused (HTTP ${status.value})`,
                )
              }
            }),
          { concurrency: "unbounded", discard: true },
        )
        yield* drop(gone)
      })

    yield* hub.subscribeRoster({}).pipe(
      Stream.filterMap((item) =>
        item.kind === "change" && item.change.type === "notification"
          ? Result.succeed(item.change.notification)
          : Result.failVoid,
      ),
      Stream.mapEffect(forward, { concurrency: 4, unordered: true }),
      Stream.runDrain,
      Effect.catchCause((cause) => Effect.logWarning("Web Push: notifications ended", cause)),
      Effect.forkScoped({ startImmediately: true }),
    )

    return WebPush.of({
      publicKey: vapid.publicKey,
      subscribe: (sessionId, input) =>
        save([
          ...subscriptions.filter((s) => s.endpoint !== input.endpoint),
          { endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, sessionId },
        ]),
      unsubscribe: (endpoint) => drop([endpoint]),
    })
  })

export const WebPushLive = (options: WebPushOptions): Layer.Layer<WebPush, never, ServerConfig | LiveHub | WebAuth> =>
  Layer.effect(WebPush, makeWebPush(options))

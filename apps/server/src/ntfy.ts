/**
 * ntfy (D3.6): the owner's notifications on their phone through ntfy (Android, iPhone, desktop), on
 * ntfy.sh or the owner's own ntfy server. The owner picks a topic and subscribes to it in the ntfy
 * app; the topic, the server and an optional access token are kept in `<data>/ntfy.json` (0600).
 *
 * Every notification OpenBot makes (the roster's `notification` changes: a Bot finished, needs the
 * owner, wrote, a routine ran, something failed) becomes a push: the title (the Bot's name), the text
 * and a link that opens the chat in OpenBot (the first `--public-origin`; none when OpenBot is only
 * on loopback). `sends: "needs-you"` keeps only a Bot waiting for the owner and failures; those two
 * go out at high priority. On ntfy.sh anyone who knows the topic can read it: it should be long and
 * random (the app offers one).
 */
import {
  InvalidInput,
  NTFY_DISCONNECTED,
  NTFY_URL,
  type Notification,
  type NtfySends,
  type NtfyStatus,
  Unavailable,
} from "@openbot/contracts"
import { LiveHub } from "@openbot/core"
import { Clock, Context, Effect, Layer, Stream } from "effect"
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { ServerConfig } from "./config.ts"

export class Ntfy extends Context.Service<
  Ntfy,
  {
    readonly status: Effect.Effect<NtfyStatus>
    /** Sends a test notification to the topic and keeps it when ntfy takes it. */
    readonly connect: (input: {
      readonly topic: string
      readonly server?: string | undefined
      readonly token?: string | undefined
    }) => Effect.Effect<NtfyStatus, InvalidInput | Unavailable>
    readonly disconnect: Effect.Effect<NtfyStatus>
    readonly test: Effect.Effect<NtfyStatus, InvalidInput | Unavailable>
    readonly setSends: (sends: NtfySends) => Effect.Effect<NtfyStatus, InvalidInput>
  }
>()("openbot/server/Ntfy") {}

export interface NtfyOptions {
  /** Where the topic is kept (`DataDir.ntfy`). */
  readonly file: string
  readonly fetch?: typeof fetch | undefined
}

interface Saved {
  readonly version: 1
  readonly server: string
  readonly topic: string
  readonly token?: string | undefined
  readonly sends: NtfySends
}

const readSaved = (file: string): Saved | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Saved>
    if (parsed.version !== 1 || typeof parsed.server !== "string" || typeof parsed.topic !== "string") return undefined
    return {
      version: 1,
      server: parsed.server,
      topic: parsed.topic,
      ...(typeof parsed.token === "string" && parsed.token !== "" ? { token: parsed.token } : {}),
      sends: parsed.sends === "needs-you" ? "needs-you" : "all",
    }
  } catch {
    return undefined
  }
}

const writeSaved = (file: string, saved: Saved): void => {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(saved, null, 2), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}

/** A topic ntfy accepts: letters, digits, `_` and `-`, up to 64. */
export const ntfyTopic = (text: string): string | undefined => {
  const topic = text.trim()
  return /^[A-Za-z0-9_-]{1,64}$/.test(topic) ? topic : undefined
}

/** An ntfy server's address (`https://ntfy.example.com`), without a trailing slash; blank is ntfy.sh. */
export const ntfyServer = (text: string | undefined): string | undefined => {
  const server = (text ?? "").trim().replace(/\/+$/, "")
  if (server === "") return NTFY_URL
  try {
    const url = new URL(server)
    return url.protocol === "http:" || url.protocol === "https:" ? server : undefined
  } catch {
    return undefined
  }
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** A Bot waiting for the owner, or something failing. */
const needsYou = (n: Notification) => n.kind === "waiting" || n.kind === "error"

export const makeNtfy = (options: NtfyOptions) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const hub = yield* LiveHub
    const fetchImpl = options.fetch ?? fetch
    /** Where a notification's link opens: the first address OpenBot is reached at from other devices. */
    const origin = config.publicOrigins[0]?.replace(/\/+$/, "")

    let saved = readSaved(options.file)
    let problem: string | undefined
    let lastSentAt: number | undefined

    const status = (): NtfyStatus =>
      saved === undefined
        ? NTFY_DISCONNECTED
        : {
            connected: true,
            sends: saved.sends,
            server: saved.server,
            topic: saved.topic,
            ...(problem === undefined ? {} : { problem }),
            ...(lastSentAt === undefined ? {} : { lastSentAt }),
          }

    /** Publishes one notification as JSON; a failure is the reason in words. */
    const post = (target: Pick<Saved, "server" | "topic" | "token">, body: Record<string, unknown>) =>
      Effect.tryPromise({
        try: async (signal): Promise<string | undefined> => {
          const response = await fetchImpl(target.server, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(target.token === undefined ? {} : { authorization: `Bearer ${target.token}` }),
            },
            body: JSON.stringify({ topic: target.topic, ...body }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          })
          if (response.ok) return undefined
          switch (response.status) {
            case 401:
            case 403:
              return "ntfy refused it: this server needs an access token that can publish to the topic."
            case 404:
              return "ntfy doesn't answer there: check the server address."
            case 413:
              return "ntfy found the notification too large."
            case 429:
              return "ntfy's limit for now was reached; notifications resume in a minute."
            default:
              return `ntfy refused it (HTTP ${response.status}).`
          }
        },
        catch: () => "ntfy did not answer.",
      }).pipe(Effect.catch((reason) => Effect.succeed<string | undefined>(reason)))

    const linkTo = (conversationId: string | undefined) =>
      origin === undefined
        ? {}
        : { click: conversationId === undefined ? `${origin}/` : `${origin}/#/c/${conversationId}` }

    const forward = (n: Notification) => {
      const current = saved
      if (current === undefined || (current.sends === "needs-you" && !needsYou(n))) return Effect.void
      const text = n.body.trim() === "" ? n.title : n.body
      return post(current, {
        title: clip(n.title, 250),
        message: clip(text, 3_500),
        ...(needsYou(n) ? { priority: 4 } : {}),
        ...linkTo(n.conversationId),
      }).pipe(
        Effect.flatMap((failed) =>
          Effect.gen(function* () {
            if (saved !== current) return
            problem = failed
            if (failed === undefined) lastSentAt = yield* Clock.currentTimeMillis
            else yield* Effect.logWarning(`ntfy: notification not pushed: ${failed}`)
          }),
        ),
      )
    }

    yield* hub.subscribeRoster({}).pipe(
      Stream.runForEach((item) =>
        item.kind === "change" && item.change.type === "notification" ? forward(item.change.notification) : Effect.void,
      ),
      Effect.catchCause((cause) => Effect.logWarning("ntfy: notifications ended", cause)),
      Effect.forkScoped({ startImmediately: true }),
    )

    const sendTest = (target: Pick<Saved, "server" | "topic" | "token">) =>
      post(target, {
        title: "OpenBot",
        message: "Connected. Your Bots' notifications will show up here.",
        ...linkTo(undefined),
      })

    const connect = (input: {
      readonly topic: string
      readonly server?: string | undefined
      readonly token?: string | undefined
    }) =>
      Effect.gen(function* () {
        const topic = ntfyTopic(input.topic)
        if (topic === undefined) {
          return yield* new InvalidInput({
            message: "A topic is letters, digits, _ and -, up to 64 characters.",
          })
        }
        const server = ntfyServer(input.server)
        if (server === undefined) {
          return yield* new InvalidInput({ message: "The server is an address like https://ntfy.example.com." })
        }
        const token = input.token?.trim()
        const target = { server, topic, ...(token === undefined || token === "" ? {} : { token }) }
        const failed = yield* sendTest(target)
        if (failed !== undefined) return yield* new InvalidInput({ message: failed })
        const next: Saved = { version: 1, ...target, sends: saved?.sends ?? "all" }
        yield* Effect.try({
          try: () => writeSaved(options.file, next),
          catch: () => new Unavailable({ message: "Couldn't save the topic on the brain." }),
        })
        saved = next
        problem = undefined
        lastSentAt = yield* Clock.currentTimeMillis
        return status()
      })

    return Ntfy.of({
      status: Effect.sync(status),
      connect,
      disconnect: Effect.sync(() => {
        saved = undefined
        problem = undefined
        lastSentAt = undefined
        rmSync(options.file, { force: true })
        return status()
      }),
      test: Effect.gen(function* () {
        const current = saved
        if (current === undefined) return yield* new InvalidInput({ message: "ntfy isn't connected." })
        const failed = yield* sendTest(current)
        problem = failed
        if (failed !== undefined) return yield* new Unavailable({ message: failed })
        lastSentAt = yield* Clock.currentTimeMillis
        return status()
      }),
      setSends: (sends) =>
        Effect.gen(function* () {
          const current = saved
          if (current === undefined) return yield* new InvalidInput({ message: "ntfy isn't connected." })
          const next: Saved = { ...current, sends }
          yield* Effect.try({
            try: () => writeSaved(options.file, next),
            catch: () => new InvalidInput({ message: "Couldn't save the setting on the brain." }),
          })
          saved = next
          return status()
        }),
    })
  })

export const NtfyLive = (options: NtfyOptions): Layer.Layer<Ntfy, never, ServerConfig | LiveHub> =>
  Layer.effect(Ntfy, makeNtfy(options))

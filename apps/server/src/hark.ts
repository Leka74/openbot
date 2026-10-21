/**
 * Hark (D3.5): the owner's notifications on their iPhone through hark.ryan.ceo, until the OpenBot
 * iPhone app has its own push. The owner creates a Hark "service" and pastes its webhook
 * (`https://hark.ryan.ceo/hooks/whk_…`); it is kept in `<data>/hark.json` (0600).
 *
 * Every notification OpenBot makes (the roster's `notification` changes: a Bot finished, needs the
 * owner, wrote, a routine ran, something failed) becomes a push: the title (the Bot's name), the text,
 * the Bot as Hark's project (one group per Bot) and a link that opens the chat in OpenBot (the first
 * `--public-origin`; none when OpenBot is only on loopback). `sends: "needs-you"` keeps only a Bot
 * waiting for the owner and failures. Each push is sent once (`Idempotency-Key`: the notification id).
 */
import { HARK_DISCONNECTED, HARK_URL, type HarkSends, type HarkStatus, InvalidInput, type Notification, Unavailable } from "@openbot/contracts"
import { BotRepo, LiveHub } from "@openbot/core"
import { Clock, Context, Effect, Layer, Option, Stream } from "effect"
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { ServerConfig } from "./config.ts"

export class Hark extends Context.Service<Hark, {
  readonly status: Effect.Effect<HarkStatus>
  /** Sends a test notification to the webhook and keeps it when Hark takes it. */
  readonly connect: (webhook: string) => Effect.Effect<HarkStatus, InvalidInput | Unavailable>
  readonly disconnect: Effect.Effect<HarkStatus>
  readonly test: Effect.Effect<HarkStatus, InvalidInput | Unavailable>
  readonly setSends: (sends: HarkSends) => Effect.Effect<HarkStatus, InvalidInput>
}>()("openbot/server/Hark") {}

export interface HarkOptions {
  /** Where the webhook is kept (`DataDir.hark`). */
  readonly file: string
  /** Hark's address (tests: a fake). */
  readonly baseUrl?: string | undefined
  readonly fetch?: typeof fetch | undefined
}

interface Saved {
  readonly version: 1
  readonly token: string
  readonly sends: HarkSends
}

const readSaved = (file: string): Saved | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Saved>
    if (parsed.version !== 1 || typeof parsed.token !== "string") return undefined
    return { version: 1, token: parsed.token, sends: parsed.sends === "needs-you" ? "needs-you" : "all" }
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

/** `https://hark.ryan.ceo/hooks/whk_…` or `whk_…` → the token. */
export const harkToken = (webhook: string): string | undefined => {
  const text = webhook.trim()
  const match = /^(?:https?:\/\/[^/\s]+\/hooks\/)?(whk_[A-Za-z0-9_-]+)\/?$/.exec(text)
  return match?.[1]
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** A Bot waiting for the owner, or something failing. */
const needsYou = (n: Notification) => n.kind === "waiting" || n.kind === "error"

export const makeHark = (options: HarkOptions) =>
  Effect.gen(function*() {
    const config = yield* ServerConfig
    const hub = yield* LiveHub
    const bots = yield* BotRepo
    const base = (options.baseUrl ?? HARK_URL).replace(/\/+$/, "")
    const fetchImpl = options.fetch ?? fetch
    /** Where a notification's link opens: the first address OpenBot is reached at from other devices. */
    const origin = config.publicOrigins[0]?.replace(/\/+$/, "")

    let saved = readSaved(options.file)
    let problem: string | undefined
    let lastSentAt: number | undefined

    const status = (): HarkStatus =>
      saved === undefined
        ? HARK_DISCONNECTED
        : { connected: true, sends: saved.sends, ...(problem === undefined ? {} : { problem }), ...(lastSentAt === undefined ? {} : { lastSentAt }) }

    /** POSTs one notification; a failure is the reason in words. */
    const post = (token: string, body: Record<string, unknown>, idempotencyKey: string) =>
      Effect.tryPromise({
        try: async (): Promise<string | undefined> => {
          const response = await fetchImpl(`${base}/hooks/${token}`, {
            method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15_000),
          })
          if (response.ok) return undefined
          const detail = await response.json().then((j: unknown) => {
            const answer = (j ?? {}) as { readonly error?: unknown; readonly message?: unknown }
            return String(answer.message ?? answer.error ?? "")
          }, () => "")
          switch (response.status) {
            case 404:
              return "Hark doesn't know this webhook (was the service deleted?). Paste a new one."
            case 402:
              return "Hark wants a Pro plan for this."
            case 429:
              return "Hark's limit for now was reached; notifications resume in a minute."
            case 502:
              return "Hark couldn't reach your iPhone (is the app still installed and allowed to notify?)."
            default:
              return `Hark refused it (HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}).`
          }
        },
        catch: () => "Hark did not answer.",
      }).pipe(Effect.catch((reason) => Effect.succeed<string | undefined>(reason)))

    const linkTo = (conversationId: string | undefined) =>
      origin === undefined ? {} : { url: conversationId === undefined ? `${origin}/` : `${origin}/#/c/${conversationId}` }

    const forward = (n: Notification) =>
      Effect.gen(function*() {
        const current = saved
        if (current === undefined || (current.sends === "needs-you" && !needsYou(n))) return
        const bot = n.botId === undefined ? Option.none() : yield* bots.get(n.botId).pipe(Effect.orElseSucceed(() => Option.none()))
        const text = n.body.trim() === "" ? n.title : n.body
        const failed = yield* post(current.token, {
          title: clip(n.title, 80),
          body: clip(text, 8_000),
          ...linkTo(n.conversationId),
          ...(Option.isSome(bot) ? { project: clip(bot.value.name, 80) } : {}),
        }, n.id)
        if (saved !== current) return
        problem = failed
        if (failed === undefined) lastSentAt = yield* Clock.currentTimeMillis
        else yield* Effect.logWarning(`Hark: notification not pushed: ${failed}`)
      })

    yield* hub.subscribeRoster({}).pipe(
      Stream.runForEach((item) =>
        item.kind === "change" && item.change.type === "notification" ? forward(item.change.notification) : Effect.void
      ),
      Effect.catchCause((cause) => Effect.logWarning("Hark: notifications ended", cause)),
      Effect.forkScoped({ startImmediately: true }),
    )

    const sendTest = (token: string) =>
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        return yield* post(token, { title: "OpenBot", body: "Connected. Your Bots' notifications will show up here.", ...linkTo(undefined) }, `openbot-test-${now}`)
      })

    const connect = (webhook: string) =>
      Effect.gen(function*() {
        const token = harkToken(webhook)
        if (token === undefined) {
          return yield* new InvalidInput({ message: "Paste the service's webhook URL from Hark (…/hooks/whk_…)." })
        }
        const failed = yield* sendTest(token)
        if (failed !== undefined) return yield* new InvalidInput({ message: failed })
        const next: Saved = { version: 1, token, sends: saved?.sends ?? "all" }
        yield* Effect.try({ try: () => writeSaved(options.file, next), catch: () => new Unavailable({ message: "Couldn't save the webhook on the brain." }) })
        saved = next
        problem = undefined
        lastSentAt = yield* Clock.currentTimeMillis
        return status()
      })

    return Hark.of({
      status: Effect.sync(status),
      connect,
      disconnect: Effect.sync(() => {
        saved = undefined
        problem = undefined
        lastSentAt = undefined
        rmSync(options.file, { force: true })
        return status()
      }),
      test: Effect.gen(function*() {
        const current = saved
        if (current === undefined) return yield* new InvalidInput({ message: "Hark isn't connected." })
        const failed = yield* sendTest(current.token)
        problem = failed
        if (failed !== undefined) return yield* new Unavailable({ message: failed })
        lastSentAt = yield* Clock.currentTimeMillis
        return status()
      }),
      setSends: (sends) =>
        Effect.gen(function*() {
          const current = saved
          if (current === undefined) return yield* new InvalidInput({ message: "Hark isn't connected." })
          const next: Saved = { ...current, sends }
          yield* Effect.try({ try: () => writeSaved(options.file, next), catch: () => new InvalidInput({ message: "Couldn't save the setting on the brain." }) })
          saved = next
          return status()
        }),
    })
  })

export const HarkLive = (options: HarkOptions): Layer.Layer<Hark, never, ServerConfig | LiveHub | BotRepo> => Layer.effect(Hark, makeHark(options))

/**
 * Hark (D3.5): the owner's notifications on their iPhone through hark.ryan.ceo, until the OpenBot
 * iPhone app has its own push. The owner creates a Hark "service" and pastes its webhook
 * (`https://hark.ryan.ceo/hooks/whk_…`); it is kept in the profile's `hark.json` (0600).
 *
 * Every notification OpenBot makes becomes a push (push.ts): the title (the Bot's name), the text,
 * the Bot as Hark's project (one group per Bot) and a link that opens the chat in OpenBot. Each push
 * is sent once (`Idempotency-Key`: the notification id).
 */
import { HARK_DISCONNECTED, HARK_URL, type HarkStatus, InvalidInput, type OwnerProfileId } from "@openbot/contracts"
import { BotRepo, LiveHub, OwnerProfiles } from "@openbot/core"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { ServerConfig } from "./config.ts"
import { clip, makePush, notificationText, type PushService } from "./push.ts"

export class Hark extends Context.Service<Hark, PushService<HarkStatus, string>>()("openbot/server/Hark") {}

export interface HarkOptions {
  /** Where a profile's webhook is kept (`DataDir.profile(id).hark`). */
  readonly file: (profileId: OwnerProfileId) => string
  /** Hark's address (tests: a fake). */
  readonly baseUrl?: string | undefined
  readonly fetch?: typeof fetch | undefined
}

/** `https://hark.ryan.ceo/hooks/whk_…` or `whk_…` → the token. */
export const harkToken = (webhook: string): string | undefined => {
  const text = webhook.trim()
  const match = /^(?:https?:\/\/[^/\s]+\/hooks\/)?(whk_[A-Za-z0-9_-]+)\/?$/.exec(text)
  return match?.[1]
}

const refused = async (response: Response) => {
  const detail = await response.json().then(
    (j: unknown) => {
      const answer = (j ?? {}) as { readonly error?: unknown; readonly message?: unknown }
      return String(answer.message ?? answer.error ?? "")
    },
    () => "",
  )
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
}

export const makeHark = (options: HarkOptions) =>
  Effect.gen(function* () {
    const bots = yield* BotRepo
    const base = (options.baseUrl ?? HARK_URL).replace(/\/+$/, "")
    const push = yield* makePush({
      name: "Hark",
      file: options.file,
      what: "webhook",
      target: Schema.Struct({ token: Schema.String }),
      disconnected: HARK_DISCONNECTED,
      show: (status) => status,
      body: (n, link) =>
        Effect.gen(function* () {
          const bot =
            n.botId === undefined
              ? Option.none()
              : yield* bots.get(n.botId).pipe(Effect.orElseSucceed(() => Option.none()))
          return {
            title: clip(n.title, 80),
            body: clip(notificationText(n), 8_000),
            ...(link === undefined ? {} : { url: link }),
            ...(Option.isSome(bot) ? { project: clip(bot.value.name, 80) } : {}),
          }
        }),
      testBody: (link) => ({
        title: "OpenBot",
        body: "Connected. Your Bots' notifications will show up here.",
        ...(link === undefined ? {} : { url: link }),
      }),
      request: (target, body, key) => ({
        url: `${base}/hooks/${target.token}`,
        headers: { "idempotency-key": key },
        json: body,
      }),
      refused,
      fetch: options.fetch,
    })
    return Hark.of({
      ...push,
      connect: (webhook) => {
        const token = harkToken(webhook)
        if (token === undefined) {
          return Effect.fail(
            new InvalidInput({ message: "Paste the service's webhook URL from Hark (…/hooks/whk_…)." }),
          )
        }
        return push.connect({ token })
      },
    })
  })

export const HarkLive = (
  options: HarkOptions,
): Layer.Layer<Hark, never, ServerConfig | LiveHub | BotRepo | OwnerProfiles> => Layer.effect(Hark, makeHark(options))

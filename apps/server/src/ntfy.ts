/** ntfy (D3.6): the owner's notifications on any phone with the ntfy app, pushed through push.ts. */
import { InvalidInput, NTFY_DISCONNECTED, NTFY_URL, type NtfyStatus, type OwnerProfileId } from "@openbot/contracts"
import { BotRepo, LiveHub, OwnerProfiles } from "@openbot/core"
import { Context, Effect, Layer, Schema } from "effect"
import { ServerConfig } from "./config.ts"
import { clip, clipBytes, makePush, needsYou, notificationText, type PushService } from "./push.ts"

export interface NtfyConnect {
  readonly topic: string
  /** Absent or blank: ntfy.sh. */
  readonly server?: string | undefined
  readonly token?: string | undefined
}

export class Ntfy extends Context.Service<Ntfy, PushService<NtfyStatus, NtfyConnect>>()("openbot/server/Ntfy") {}

export interface NtfyOptions {
  /** Where a profile's topic is kept (`DataDir.profile(id).ntfy`). */
  readonly file: (profileId: OwnerProfileId) => string
  readonly fetch?: typeof fetch | undefined
}

const NtfyTarget = Schema.Struct({
  server: Schema.String,
  topic: Schema.String,
  token: Schema.optionalKey(Schema.String),
})
type NtfyTarget = typeof NtfyTarget.Type

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

const invalid = (message: string) => Effect.fail(new InvalidInput({ message }))

/** Where to publish, from what the owner typed: the server is kept as its origin only. */
export const ntfyTarget = (input: NtfyConnect): Effect.Effect<NtfyTarget, InvalidInput> => {
  const topic = input.topic.trim()
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) return invalid("A topic is letters, digits, _ and -, up to 64 characters.")
  const url = URL.parse(input.server?.trim() || NTFY_URL)
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return invalid("The server is an address like https://ntfy.example.com.")
  }
  if (url.username !== "" || url.password !== "") {
    return invalid("Leave the sign-in out of the server's address and give an access token instead.")
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return invalid("The server is just its address, like https://ntfy.example.com: the topic has its own field.")
  }
  if (url.origin === NTFY_URL && topic.length < 20) {
    return invalid(
      "On ntfy.sh anyone who knows a topic can read its notifications: use one of at least 20 characters that nobody could guess (New topic makes one).",
    )
  }
  const token = input.token?.trim() ?? ""
  if (token !== "" && url.protocol === "http:" && !LOOPBACK.has(url.hostname)) {
    return invalid("An access token is only sent to an https:// server or one on this computer.")
  }
  return Effect.succeed({ server: url.origin, topic, ...(token === "" ? {} : { token }) })
}

const refused = (response: Response) => {
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
}

export const makeNtfy = (options: NtfyOptions) =>
  Effect.gen(function* () {
    const push = yield* makePush({
      name: "ntfy",
      file: options.file,
      what: "topic",
      target: NtfyTarget,
      disconnected: NTFY_DISCONNECTED,
      show: (status, target) => ({ ...status, server: target.server, topic: target.topic }),
      body: (n, link) =>
        Effect.succeed({
          title: clip(n.title, 250),
          // ntfy turns a message over 4,096 bytes into an attachment
          message: clipBytes(notificationText(n), 3_800),
          markdown: true,
          ...(needsYou(n) ? { priority: 4 } : {}),
          ...(link === undefined ? {} : { click: link }),
        }),
      testBody: (link) => ({
        title: "OpenBot",
        message: "Connected. Your Bots' notifications will show up here.",
        ...(link === undefined ? {} : { click: link }),
      }),
      request: (target, body) => ({
        url: target.server,
        ...(target.token === undefined ? {} : { headers: { authorization: `Bearer ${target.token}` } }),
        json: { topic: target.topic, ...body },
      }),
      refused,
      fetch: options.fetch,
    })
    return Ntfy.of({ ...push, connect: (input) => Effect.flatMap(ntfyTarget(input), push.connect) })
  })

export const NtfyLive = (
  options: NtfyOptions,
): Layer.Layer<Ntfy, never, ServerConfig | LiveHub | BotRepo | OwnerProfiles> => Layer.effect(Ntfy, makeNtfy(options))

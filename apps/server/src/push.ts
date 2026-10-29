/**
 * What the phone-push apps (Hark D3.5, ntfy D3.6) share: the saved file (0600), following the roster's
 * notifications, which ones go out (`sends`, `quietAtComputer`), and the status (problem, lastSentAt).
 * Each app gives only its target (what it publishes to), how a notification reads there and the request.
 *
 * Each owner profile connects its own target in its own file. The roster carries only the active
 * profile's notifications (the others are held for their "While you were away" list), so they go to
 * the active profile's target.
 */
import { InvalidInput, type Notification, type OwnerProfileId, Unavailable } from "@openbot/contracts"
import { BotRepo, type CurrentProfile, currentProfileId, LiveHub, OwnerProfiles } from "@openbot/core"
import { Clock, Effect, Option, Result, Schema, Stream } from "effect"
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { ServerConfig } from "./config.ts"
import { OwnerPresence } from "./presence.ts"

export type PushSends = "all" | "needs-you"

export interface PushStatus {
  readonly connected: boolean
  readonly sends: PushSends
  readonly quietAtComputer?: boolean
  readonly atComputer?: boolean
  readonly problem?: string
  readonly lastSentAt?: number
}

/** The current profile's connection. */
export interface PushService<Status, Input> {
  readonly status: Effect.Effect<Status, never, CurrentProfile>
  /** Sends a test notification and keeps the target when the app takes it. */
  readonly connect: (input: Input) => Effect.Effect<Status, InvalidInput | Unavailable, CurrentProfile>
  readonly disconnect: Effect.Effect<Status, Unavailable, CurrentProfile>
  readonly test: Effect.Effect<Status, InvalidInput | Unavailable, CurrentProfile>
  readonly setSends: (sends: PushSends) => Effect.Effect<Status, InvalidInput | Unavailable, CurrentProfile>
  readonly setQuietAtComputer: (quiet: boolean) => Effect.Effect<Status, Unavailable, CurrentProfile>
}

export interface PushApp<Target, Status extends PushStatus> {
  /** In messages and logs: "Hark", "ntfy". */
  readonly name: string
  /** Where a profile's target is kept. */
  readonly file: (profileId: OwnerProfileId) => string
  /** What the owner connected with, in messages: "webhook", "topic". */
  readonly what: string
  /** The target's fields in the saved file, beside the shared ones. */
  readonly target: Schema.Codec<Target>
  readonly disconnected: Status
  /** The connected status: the shared part and what it shows of the target. */
  readonly show: (status: PushStatus, target: Target) => Status
  readonly body: (n: Notification, link: string | undefined) => Effect.Effect<Record<string, unknown>>
  readonly testBody: (link: string | undefined) => Record<string, unknown>
  readonly request: (
    target: Target,
    body: Record<string, unknown>,
    key: string,
  ) => { readonly url: string; readonly headers?: Record<string, string>; readonly json: Record<string, unknown> }
  /** Why the app refused a push, in words. */
  readonly refused: (response: Response) => string | Promise<string>
  readonly fetch?: typeof fetch | undefined
}

const Shared = Schema.Struct({
  version: Schema.Literal(1),
  sends: Schema.Literals(["all", "needs-you"]).pipe(Schema.withDecodingDefaultKey(Effect.succeed("all" as const))),
  /** Absent: on. */
  quietAtComputer: Schema.optionalKey(Schema.Boolean),
})

type Saved<Target> = typeof Shared.Type & { readonly target: Target }

/** One profile's connection. */
interface Connection<Target> {
  readonly file: string
  saved: Saved<Target> | undefined
  problem: string | undefined
  lastSentAt: number | undefined
}

/** A Bot waiting for the owner, something failing, or a browser asking to sign in. */
export const needsYou = (n: Notification) => n.kind === "waiting" || n.kind === "error" || n.kind === "sign-in"

export const notificationText = (n: Notification) => (n.body.trim() === "" ? n.title : n.body)

export const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

const encoder = new TextEncoder()

/** Cuts to at most `max` UTF-8 bytes without splitting a character. */
export const clipBytes = (text: string, max: number) => {
  if (encoder.encode(text).length <= max) return text
  // "…" is 3 bytes
  const { read } = encoder.encodeInto(text, new Uint8Array(max - 3))
  return `${text.slice(0, read)}…`
}

export const makePush = <Target, Status extends PushStatus>(app: PushApp<Target, Status>) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const hub = yield* LiveHub
    const profiles = yield* OwnerProfiles
    const bots = yield* BotRepo
    const presence = yield* Effect.serviceOption(OwnerPresence)
    const atComputer = () => Option.isSome(presence) && presence.value.atComputer()
    const fetchImpl = app.fetch ?? fetch
    /** Where a notification's link opens: the first address OpenBot is reached at from other devices. */
    const origin = config.publicOrigins[0]?.replace(/\/+$/, "")
    const decodeShared = Schema.decodeUnknownOption(Schema.fromJsonString(Shared))
    const decodeTarget = Schema.decodeUnknownOption(Schema.fromJsonString(app.target))

    const connections = new Map<OwnerProfileId, Connection<Target>>()

    /** The profile's connection, read from its file the first time. */
    const connectionOf = (profileId: OwnerProfileId): Connection<Target> => {
      const known = connections.get(profileId)
      if (known !== undefined) return known
      const file = app.file(profileId)
      const read = Result.try(() => readFileSync(file, "utf8"))
      const saved = Result.isSuccess(read)
        ? Option.getOrUndefined(
            Option.all({ shared: decodeShared(read.success), target: decodeTarget(read.success) }).pipe(
              Option.map(({ shared, target }) => ({ ...shared, target })),
            ),
          )
        : undefined
      const connection: Connection<Target> = { file, saved, problem: undefined, lastSentAt: undefined }
      connections.set(profileId, connection)
      return connection
    }
    const current = Effect.map(currentProfileId, connectionOf)

    const status = (connection: Connection<Target>): Status => {
      const { saved, problem, lastSentAt } = connection
      if (saved === undefined) return app.disconnected
      const quiet = saved.quietAtComputer !== false
      return app.show(
        {
          connected: true,
          sends: saved.sends,
          quietAtComputer: quiet,
          ...(quiet && atComputer() ? { atComputer: true } : {}),
          ...(problem === undefined ? {} : { problem }),
          ...(lastSentAt === undefined ? {} : { lastSentAt }),
        },
        saved.target,
      )
    }

    const save = (connection: Connection<Target>, next: Saved<Target>, message: string) =>
      Effect.try({
        try: () => {
          const { target, ...shared } = next
          mkdirSync(dirname(connection.file), { recursive: true })
          const tmp = `${connection.file}.tmp`
          writeFileSync(tmp, JSON.stringify({ ...shared, ...target }, null, 2), { mode: 0o600 })
          chmodSync(tmp, 0o600)
          renameSync(tmp, connection.file)
          connection.saved = next
        },
        catch: () => new Unavailable({ message }),
      })

    const didNotAnswer = () => new Unavailable({ message: `${app.name} did not answer.` })

    /** A refusal is InvalidInput (the target is wrong), no answer is Unavailable. */
    const post = (target: Target, body: Record<string, unknown>, key: string) =>
      Effect.tryPromise({
        try: async (signal) => {
          const { url, headers, json } = app.request(target, body, key)
          const response = await fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(json),
            signal,
          })
          return response.ok ? undefined : await app.refused(response)
        },
        catch: didNotAnswer,
      }).pipe(
        Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.fail(didNotAnswer()) }),
        Effect.flatMap((refused) =>
          refused === undefined ? Effect.void : Effect.fail(new InvalidInput({ message: refused })),
        ),
      )

    /** Posts for the saved target and keeps the outcome as the status (unless it was disconnected meanwhile). */
    const send = (connection: Connection<Target>, saved: Saved<Target>, body: Record<string, unknown>, key: string) =>
      Effect.gen(function* () {
        const sent = yield* Effect.result(post(saved.target, body, key))
        if (connection.saved !== saved) return sent
        if (Result.isSuccess(sent)) {
          connection.problem = undefined
          connection.lastSentAt = yield* Clock.currentTimeMillis
        } else connection.problem = sent.failure.message
        return sent
      })

    const linkTo = (conversationId: string | undefined) => {
      if (origin === undefined) return undefined
      return conversationId === undefined ? `${origin}/` : `${origin}/#/c/${conversationId}`
    }

    /**
     * A Bot's notification goes to its own profile's phone, even when the owner switched profiles since
     * it was sent; one without a Bot is the brain's and goes to the active profile's. None → the
     * Bot is gone.
     */
    const profileOf = (n: Notification) =>
      n.botId === undefined
        ? Effect.map(profiles.active, Option.some)
        : Effect.map(
            Effect.orDie(bots.get(n.botId)),
            Option.map((bot) => bot.ownerProfileId),
          )

    const forward = (n: Notification) =>
      Effect.gen(function* () {
        const profileId = yield* profileOf(n)
        if (Option.isNone(profileId)) return
        const connection = connectionOf(profileId.value)
        const saved = connection.saved
        if (saved === undefined || (saved.sends === "needs-you" && !needsYou(n))) return
        // the owner is at a computer whose desktop app shows it already
        if (saved.quietAtComputer !== false && atComputer()) return
        const sent = yield* send(connection, saved, yield* app.body(n, linkTo(n.conversationId)), n.id)
        if (Result.isFailure(sent)) {
          yield* Effect.logWarning(`${app.name}: notification not pushed: ${sent.failure.message}`)
        }
      })

    yield* hub.subscribeRoster({}).pipe(
      Stream.filterMap((item) =>
        item.kind === "change" && item.change.type === "notification"
          ? Result.succeed(item.change.notification)
          : Result.failVoid,
      ),
      // a few at once, so one slow server does not hold back the rest
      Stream.mapEffect(forward, { concurrency: 4, unordered: true }),
      Stream.runDrain,
      Effect.catchCause((cause) => Effect.logWarning(`${app.name}: notifications ended`, cause)),
      Effect.forkScoped({ startImmediately: true }),
    )

    const testKey = Effect.map(Clock.currentTimeMillis, (now) => `openbot-test-${now}`)

    const notConnected = () => new InvalidInput({ message: `${app.name} isn't connected.` })

    const service: PushService<Status, Target> = {
      status: Effect.map(current, status),
      connect: (target) =>
        Effect.gen(function* () {
          const connection = yield* current
          yield* post(target, app.testBody(linkTo(undefined)), yield* testKey)
          yield* save(
            connection,
            { version: 1, target, sends: connection.saved?.sends ?? "all" },
            `Couldn't save the ${app.what} on the brain.`,
          )
          connection.problem = undefined
          connection.lastSentAt = yield* Clock.currentTimeMillis
          return status(connection)
        }),
      disconnect: Effect.gen(function* () {
        const connection = yield* current
        yield* Effect.try({
          try: () => rmSync(connection.file, { force: true }),
          catch: () => new Unavailable({ message: `Couldn't forget the ${app.what} on the brain.` }),
        })
        connection.saved = undefined
        connection.problem = undefined
        connection.lastSentAt = undefined
        return status(connection)
      }),
      test: Effect.gen(function* () {
        const connection = yield* current
        const saved = connection.saved
        if (saved === undefined) return yield* notConnected()
        const sent = yield* send(connection, saved, app.testBody(linkTo(undefined)), yield* testKey)
        if (Result.isFailure(sent)) return yield* new Unavailable({ message: sent.failure.message })
        return status(connection)
      }),
      setSends: (sends) =>
        Effect.gen(function* () {
          const connection = yield* current
          const saved = connection.saved
          if (saved === undefined) return yield* notConnected()
          yield* save(connection, { ...saved, sends }, "Couldn't save the setting on the brain.")
          return status(connection)
        }),
      setQuietAtComputer: (quiet) =>
        Effect.gen(function* () {
          const connection = yield* current
          const saved = connection.saved
          if (saved === undefined) return status(connection)
          yield* save(connection, { ...saved, quietAtComputer: quiet }, "Couldn't save the setting on the brain.")
          return status(connection)
        }),
    }
    return service
  })

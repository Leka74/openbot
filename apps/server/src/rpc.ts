/**
 * `OpenBotRpcs` handlers (architecture §4.1.1, §4.9; interfaces.md §3.1): every RPC delegates to one
 * core service / brain-nodes port method. Contract errors pass through unchanged; defects (and
 * repository failures, which services `orDie`) are logged with their cause and returned as `Internal`.
 */
import {
  HarnessUnavailable,
  type HarnessStatus,
  Internal,
  InvalidInput,
  MAIN_PROFILE_ID,
  MAX_DICTATION_CHUNK_BYTES,
  NotFound,
  OpenBotRpcs,
  type OwnerProfileId,
  type SessionInfo,
} from "@openbot/contracts"
import {
  ApprovalService,
  AttachmentService,
  Away,
  BackgroundTasks,
  BotService,
  ComputerPort,
  ConversationService,
  CurrentProfile,
  currentProfileId,
  type HarnessDriver,
  HarnessRegistry,
  LiveHub,
  MAX_ATTACHMENT_BYTES,
  MemoryService,
  NodeAdmin,
  NodeDirectory,
  inProfile,
  Orchestrator,
  OwnerProfiles,
  ProfileGuard,
  ProfileRemoval,
  RoutineScheduler,
  SearchService,
  SettingsService,
  SkillService,
  SlackConnector,
  SlackService,
  UiCardService,
  UsageService,
  userActor,
} from "@openbot/core"
import { Cause, Clock, Context, Effect, Option, Schema, Stream } from "effect"
import { RpcSchema } from "effect/rpc"
import { userInfo } from "node:os"
import { OPENBOT_VERSION, ServerConfig } from "./config.ts"
import { Hark } from "./hark.ts"
import { Ntfy } from "./ntfy.ts"
import { HarnessProfiles } from "./profiles.ts"
import { SpeechToText } from "./stt/service.ts"
import { VoiceCalls } from "./voice/service.ts"
import { Updates } from "./updates.ts"
import { OwnerPresence } from "./presence.ts"

const INTERNAL_MESSAGE = "Something went wrong on the brain; the details are in its log."

/** The RPC edge: typed failures pass, interrupts propagate, anything else is logged and becomes `Internal`. */
export const edge = <A, E, R>(rpc: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | Internal, R> =>
  Effect.catchCause(effect, (cause): Effect.Effect<never, E | Internal> => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
    const failure = Cause.findErrorOption(cause)
    if (Option.isSome(failure)) return Effect.fail(failure.value)
    return Effect.logError(`RPC ${rpc} failed`, cause).pipe(
      Effect.andThen(Effect.fail(new Internal({ message: INTERNAL_MESSAGE }))),
    )
  })

/** `edge` for streaming RPCs. */
export const edgeStream = <A, E, R>(rpc: string, stream: Stream.Stream<A, E, R>): Stream.Stream<A, E | Internal, R> =>
  Stream.catchCause(stream, (cause): Stream.Stream<never, E | Internal> => {
    if (Cause.hasInterruptsOnly(cause)) return Stream.failCause(cause)
    const failure = Cause.findErrorOption(cause)
    if (Option.isSome(failure)) return Stream.fail(failure.value)
    return Stream.fromEffect(
      Effect.logError(`RPC ${rpc} stream failed`, cause).pipe(
        Effect.andThen(Effect.fail(new Internal({ message: INTERNAL_MESSAGE }))),
      ),
    )
  })

/** Base64 (standard or url alphabet, optional padding) → bytes; `undefined` when malformed. */
export const decodeBase64 = (input: string): Uint8Array | undefined => {
  const compact = input.replace(/\s+/g, "")
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact) || compact.replace(/=+$/, "").length % 4 === 1) return undefined
  return new Uint8Array(Buffer.from(compact.replace(/-/g, "+").replace(/_/g, "/"), "base64"))
}

const BASE64_PADDING_ALLOWANCE = 16
const MAX_DICTATION_CHUNK_BASE64_LENGTH = Math.ceil((MAX_DICTATION_CHUNK_BYTES * 4) / 3) + BASE64_PADDING_ALLOWANCE

const withPcm = <A, E>(
  pcmBase64: string,
  use: (pcm: Uint8Array) => Effect.Effect<A, E>,
): Effect.Effect<A, E | InvalidInput> =>
  Effect.suspend((): Effect.Effect<A, E | InvalidInput> => {
    if (pcmBase64.length > MAX_DICTATION_CHUNK_BASE64_LENGTH)
      return Effect.fail(new InvalidInput({ message: "That piece of audio is too large." }))
    const pcm = decodeBase64(pcmBase64)
    if (pcm === undefined) return Effect.fail(new InvalidInput({ message: "pcmBase64 is not valid base64." }))
    return use(pcm)
  })

const PROBE_TIMEOUT = "20 seconds"

/** A driver's probe, bounded so one slow harness cannot hold `harnesses.status`. */
export const probeDriver = (driver: HarnessDriver): Effect.Effect<HarnessStatus> =>
  driver.probe.pipe(
    Effect.timeoutOrElse({
      duration: PROBE_TIMEOUT,
      orElse: () =>
        Effect.map(Clock.currentTimeMillis, (now): HarnessStatus => ({
          kind: driver.kind,
          displayName: driver.displayName,
          installed: false,
          auth: { state: "unknown" },
          problems: [`The ${driver.displayName} probe did not answer within ${PROBE_TIMEOUT}.`],
          capabilities: driver.capabilities,
          checkedAt: now,
        })),
    }),
    Effect.catchCause((cause) =>
      Effect.map(Clock.currentTimeMillis, (now): HarnessStatus => ({
        kind: driver.kind,
        displayName: driver.displayName,
        installed: false,
        auth: { state: "unknown" },
        problems: [`The ${driver.displayName} probe failed: ${Cause.pretty(cause).split("\n")[0] ?? "unknown error"}`],
        capabilities: driver.capabilities,
        checkedAt: now,
      })),
    ),
  )

const defaultOwnerName = (): string => {
  try {
    const name = userInfo().username
    return name.length > 0 ? name.charAt(0).toUpperCase() + name.slice(1) : "You"
  } catch {
    return "You"
  }
}

/** The profile one owner request works in, fixed when it arrives. */
const RequestProfile = Context.Reference<OwnerProfileId | undefined>("openbot/server/RequestProfile", {
  defaultValue: () => undefined,
})

export const RpcHandlersLive = OpenBotRpcs.toLayer(
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const hub = yield* LiveHub
    const bots = yield* BotService
    const conversations = yield* ConversationService
    const orchestrator = yield* Orchestrator
    const attachments = yield* AttachmentService
    const approvals = yield* ApprovalService
    const routines = yield* RoutineScheduler
    const memory = yield* MemoryService
    const skills = yield* SkillService
    const settings = yield* SettingsService
    const usage = yield* UsageService
    const harnesses = yield* HarnessRegistry
    const profiles = yield* HarnessProfiles
    const nodes = yield* NodeDirectory
    const nodeAdmin = yield* NodeAdmin
    const computer = yield* ComputerPort
    const tasks = yield* BackgroundTasks
    const search = yield* SearchService
    const slack = yield* SlackConnector
    const slackDrafts = yield* SlackService
    const uiCards = yield* UiCardService
    const speech = yield* SpeechToText
    const voice = yield* VoiceCalls
    const updates = yield* Updates
    const hark = yield* Hark
    const presence = yield* OwnerPresence
    const ntfy = yield* Ntfy
    const ownerProfiles = yield* OwnerProfiles
    const guard = yield* ProfileGuard
    const profileRemoval = yield* ProfileRemoval
    const away = yield* Away
    const ownerFallback = defaultOwnerName()

    // The owner's requests work in the profile the apps show, read once per request (`guarded`).
    const requestProfile = Effect.flatMap(RequestProfile, (pinned) =>
      pinned === undefined ? ownerProfiles.active : Effect.succeed(pinned),
    )
    const owner = <A, E, R>(rpc: string, effect: Effect.Effect<A, E, R>) =>
      edge(
        rpc,
        Effect.flatMap(requestProfile, (id) => inProfile(id)(effect)),
      )
    const ownerStream = <A, E, R>(rpc: string, stream: Stream.Stream<A, E, R>) =>
      edgeStream(
        rpc,
        Stream.unwrap(Effect.map(requestProfile, (id) => Stream.provideService(stream, CurrentProfile, { id }))),
      )

    // What a request names (a Bot, a chat, an entry, …) must be of the active profile. Requests that
    // cannot answer "not found" (filters of lists and searches) are scoped by their services instead.
    const missing = new NotFound({ entity: "", id: "" })
    const answersNotFound = new Set<string>(
      [...OpenBotRpcs.requests.values()]
        .filter((rpc) =>
          RpcSchema.isStreamSchema(rpc.successSchema)
            ? Schema.is(rpc.successSchema.error)(missing)
            : Schema.is(rpc.errorSchema)(missing),
        )
        .map((rpc) => rpc._tag),
    )
    const checked = (tag: string, payload: unknown, profileId: OwnerProfileId) =>
      answersNotFound.has(tag) ? inProfile(profileId)(guard.check(payload)) : Effect.void
    const guarded = <H extends Record<string, (payload: never, options: never) => unknown>>(handlers: H): H =>
      Object.fromEntries(
        Object.entries(handlers).map(([tag, handler]) => [
          tag,
          (payload: never, options: never) => {
            const result = handler(payload, options)
            return Stream.isStream(result)
              ? Stream.unwrap(
                  Effect.map(ownerProfiles.active, (id) =>
                    Stream.unwrap(Effect.as(checked(tag, payload, id), result)).pipe(
                      Stream.provideService(RequestProfile, id),
                    ),
                  ),
                )
              : Effect.flatMap(ownerProfiles.active, (id) =>
                  Effect.andThen(checked(tag, payload, id), result as Effect.Effect<unknown, unknown, unknown>).pipe(
                    Effect.provideService(RequestProfile, id),
                  ),
                )
          },
        ]),
      ) as H

    return guarded(
      OpenBotRpcs.of({
        // ---------------------------------------------------------------- session
        "session.info": () =>
          owner(
            "session.info",
            Effect.gen(function* () {
              const current = yield* settings.get
              const all = yield* bots.list
              // the computer's user name is the main profile's to show, never a demo's
              const fallback = (yield* currentProfileId) === MAIN_PROFILE_ID ? ownerFallback : "You"
              const info: SessionInfo = {
                ownerName: current.ownerName ?? fallback,
                version: OPENBOT_VERSION,
                dataDir: config.dataDir,
                firstRun: all.length === 0,
              }
              return info
            }),
          ),

        // ---------------------------------------------------------------- roster
        "roster.subscribe": ({ after }) => ownerStream("roster.subscribe", hub.subscribeRoster({ after })),

        // ---------------------------------------------------------------- owner profiles
        "profiles.list": () => owner("profiles.list", ownerProfiles.view),
        "profiles.subscribe": () => ownerStream("profiles.subscribe", ownerProfiles.changes),
        "profiles.create": ({ name }) => owner("profiles.create", ownerProfiles.create(name)),
        "profiles.rename": ({ name, profileId }) => owner("profiles.rename", ownerProfiles.rename(profileId, name)),
        "profiles.switch": ({ profileId }) => owner("profiles.switch", ownerProfiles.switchTo(profileId)),
        "profiles.delete": ({ profileId }) => owner("profiles.delete", profileRemoval.remove(profileId)),
        "profiles.away": () => owner("profiles.away", away.summary),
        "profiles.dismissAway": ({ through }) => owner("profiles.dismissAway", away.dismiss(through)),

        // ---------------------------------------------------------------- bots
        "bots.create": (input) => owner("bots.create", bots.create(input, { introduce: input.introduce !== false })),
        "bots.update": ({ botId, patch }) => owner("bots.update", bots.update(botId, patch)),
        "bots.delete": ({ botId }) => owner("bots.delete", bots.delete(botId)),
        "bots.get": ({ botId }) => owner("bots.get", bots.get(botId)),
        "bots.readContext": ({ botId }) => owner("bots.readContext", bots.readContext(botId)),
        "bots.newSession": ({ botId }) => owner("bots.newSession", bots.newSession(botId)),
        "bots.compact": ({ botId }) => owner("bots.compact", bots.compact(botId)),

        // ---------------------------------------------------------------- sections
        "sections.list": () => owner("sections.list", bots.listSections),
        "sections.create": ({ name }) => owner("sections.create", bots.createSection(name)),
        "sections.rename": ({ name, sectionId }) => owner("sections.rename", bots.renameSection(sectionId, name)),
        "sections.delete": ({ sectionId }) => owner("sections.delete", bots.deleteSection(sectionId)),
        "sections.reorder": ({ sectionIds }) => owner("sections.reorder", bots.reorderSections(sectionIds)),

        // ---------------------------------------------------------------- conversations
        // a chat of a profile the owner switches away from closes
        "conversations.subscribe": ({ after, conversationId, tailLimit }) =>
          ownerStream(
            "conversations.subscribe",
            Stream.unwrap(
              Effect.map(requestProfile, (profileId) =>
                hub.subscribeConversation({ conversationId, after, tailLimit, closeOnSwitchFrom: profileId }),
              ),
            ),
          ),
        "conversations.history": (input) => owner("conversations.history", conversations.history(input)),
        "conversations.exchange": (input) => owner("conversations.exchange", conversations.exchange(input)),
        "conversations.around": (input) => owner("conversations.around", conversations.around(input)),
        "conversations.createGroup": (input) => owner("conversations.createGroup", conversations.createGroup(input)),
        "conversations.setMembers": (input) => owner("conversations.setMembers", conversations.setMembers(input)),
        "conversations.rename": ({ conversationId, title }) =>
          owner("conversations.rename", conversations.rename(conversationId, title)),
        "conversations.markRead": (input) => owner("conversations.markRead", conversations.markRead(input)),
        "conversations.setHidden": ({ conversationId, hidden }) =>
          owner("conversations.setHidden", conversations.setHidden(conversationId, hidden)),
        "conversations.delete": ({ conversationId }) =>
          owner("conversations.delete", orchestrator.deleteConversation(conversationId)),

        // ---------------------------------------------------------------- messages + turns
        "messages.send": (input) => owner("messages.send", orchestrator.send(input)),
        "messages.lookupSend": (input) => owner("messages.lookupSend", orchestrator.lookupSend(input)),
        "messages.react": (input) => owner("messages.react", orchestrator.react(input)),
        "turns.interrupt": (input) => owner("turns.interrupt", orchestrator.interrupt(input)),
        "turns.retry": (input) => owner("turns.retry", orchestrator.retry(input)),
        "attachments.upload": ({ bytesBase64, mime, name }) =>
          owner(
            "attachments.upload",
            Effect.suspend(() => {
              // base64 is 4/3 of the bytes: refuse oversized payloads before decoding them
              if (bytesBase64.length > Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 16) {
                return Effect.fail(
                  new InvalidInput({ message: `The file is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.` }),
                )
              }
              const bytes = decodeBase64(bytesBase64)
              if (bytes === undefined)
                return Effect.fail(new InvalidInput({ message: "bytesBase64 is not valid base64." }))
              return attachments.upload({ name, mime, bytes })
            }),
          ),

        // ---------------------------------------------------------------- runtime requests
        "requests.respond": (input) => owner("requests.respond", approvals.respond(input)),
        "requests.listPending": (input) => owner("requests.listPending", approvals.listPending(input)),

        // ---------------------------------------------------------------- routines
        "routines.list": ({ botId }) => owner("routines.list", routines.list({ botId })),
        "routines.create": (input) => owner("routines.create", routines.create(userActor, input)),
        "routines.update": (input) => owner("routines.update", routines.update(userActor, input)),
        "routines.setEnabled": ({ enabled, routineId }) =>
          owner("routines.setEnabled", routines.setEnabled(routineId, enabled)),
        "routines.delete": ({ routineId }) => owner("routines.delete", routines.delete(routineId)),
        "routines.runNow": ({ routineId }) => owner("routines.runNow", routines.runNow(routineId)),
        "routines.runs": ({ routineId }) => owner("routines.runs", routines.runs(routineId)),

        // ---------------------------------------------------------------- memory
        "memory.get": ({ botId }) => owner("memory.get", memory.get(botId)),
        "memory.putFact": ({ botId, fact }) => owner("memory.putFact", memory.putFact(userActor, botId, fact)),
        "memory.deleteFact": ({ botId, factId }) =>
          owner("memory.deleteFact", memory.deleteFact(userActor, botId, factId)),
        "memory.setIndex": ({ botId, index }) => owner("memory.setIndex", memory.setIndex(botId, index)),

        // ---------------------------------------------------------------- skills
        "skills.list": () => owner("skills.list", skills.list),
        "skills.upsert": (input) => owner("skills.upsert", skills.upsert(userActor, input)),
        "skills.delete": ({ name }) => owner("skills.delete", skills.delete(name)),
        "skills.assign": ({ name, botIds }) => owner("skills.assign", skills.assign(name, botIds)),
        "skills.search": ({ query }) => owner("skills.search", skills.search(query)),
        "skills.preview": ({ id }) => owner("skills.preview", skills.preview(id)),
        "skills.install": ({ id, botIds, name }) => owner("skills.install", skills.install(id, botIds, name)),

        // ---------------------------------------------------------------- harnesses
        "harnesses.status": () => owner("harnesses.status", profiles.status(probeDriver)),
        "harnesses.models": ({ kind, profileId }) =>
          owner(
            "harnesses.models",
            Effect.flatMap(harnesses.get(kind, profileId), (driver) =>
              driver.listModels.pipe(
                Effect.mapError((error) => new HarnessUnavailable({ harness: kind, message: error.message })),
              ),
            ),
          ),
        "harnesses.profiles": ({ kind }) => owner("harnesses.profiles", profiles.list(kind)),
        "harnesses.addProfile": (input) => owner("harnesses.addProfile", profiles.add(input)),
        "harnesses.removeProfile": ({ profileId }) => owner("harnesses.removeProfile", profiles.remove(profileId)),
        "harnesses.discover": ({ kind }) => owner("harnesses.discover", profiles.discover(kind)),

        // ---------------------------------------------------------------- nodes
        "nodes.list": () => owner("nodes.list", nodes.list),
        "nodes.createPairingCode": () => owner("nodes.createPairingCode", nodeAdmin.createPairingCode),
        "nodes.rename": ({ label, nodeId }) => owner("nodes.rename", nodeAdmin.rename(nodeId, label)),
        "nodes.revoke": ({ nodeId }) => owner("nodes.revoke", nodeAdmin.revoke(nodeId)),
        "nodes.setCapabilities": ({ approved, nodeId }) =>
          owner("nodes.setCapabilities", nodeAdmin.setCapabilities(nodeId, approved)),

        // ---------------------------------------------------------------- computer
        "computer.status": ({ botId }) => owner("computer.status", computer.status(botId)),
        "computer.ensure": ({ botId }) => owner("computer.ensure", computer.ensure(botId)),
        "computer.lease": ({ botId, take }) => owner("computer.lease", computer.lease(botId, take)),
        // stops the bot's desktop (and the owner's control with it); a browser-only screen is unchanged
        "computer.reset": ({ botId }) => owner("computer.reset", computer.reset(botId)),

        // ---------------------------------------------------------------- settings + rules
        "settings.get": () => owner("settings.get", settings.get),
        "settings.update": ({ patch }) => owner("settings.update", settings.update(patch)),
        "rules.list": ({ botId }) => owner("rules.list", settings.listRules({ botId })),
        "rules.upsert": ({ rule }) => owner("rules.upsert", settings.upsertRule(rule)),
        "rules.delete": ({ ruleId }) => owner("rules.delete", settings.deleteRule(ruleId)),

        // ---------------------------------------------------------------- background tasks (D5.7)
        "tasks.list": ({ botId, limit }) =>
          owner("tasks.list", Effect.andThen(bots.get(botId), tasks.list({ botId, limit }))),
        "tasks.get": ({ taskId }) => owner("tasks.get", tasks.get(taskId)),
        // the owner's Stop: only that task; the bot is told
        "tasks.cancel": ({ taskId }) => owner("tasks.cancel", tasks.cancel(taskId, "owner")),

        // ---------------------------------------------------------------- message search
        "search.query": (input) => owner("search.query", search.query(input)),
        "search.inConversation": (input) => owner("search.inConversation", search.inConversation(input)),

        // ---------------------------------------------------------------- Slack (D3.4)
        "slack.status": () =>
          owner(
            "slack.status",
            Effect.flatMap(slack.connection, (c) => c.status),
          ),
        "slack.connect": (input) =>
          owner(
            "slack.connect",
            Effect.flatMap(slack.connection, (c) => c.connect(input)),
          ),
        "slack.disconnect": () =>
          owner(
            "slack.disconnect",
            Effect.flatMap(slack.connection, (c) => Effect.andThen(c.disconnect, c.status)),
          ),
        "slack.sendDraft": ({ entryId, text }) => owner("slack.sendDraft", slackDrafts.send({ entryId, text })),
        "slack.discardDraft": ({ entryId }) => owner("slack.discardDraft", slackDrafts.discard(entryId)),
        "cards.act": (input) => owner("cards.act", uiCards.act(input)),

        "stt.status": () => owner("stt.status", speech.status),
        "stt.install": () => owner("stt.install", speech.install),
        "stt.remove": () => owner("stt.remove", speech.remove),
        "stt.open": () => owner("stt.open", speech.open),
        "stt.append": ({ sessionId, pcmBase64 }) =>
          owner(
            "stt.append",
            withPcm(pcmBase64, (pcm) => speech.append(sessionId, pcm)),
          ),
        "stt.finish": ({ sessionId, pcmBase64 }) =>
          owner(
            "stt.finish",
            withPcm(pcmBase64, (pcm) => speech.finish(sessionId, pcm)),
          ),
        "stt.discard": ({ sessionId }) => owner("stt.discard", speech.discard(sessionId)),
        "voice.status": () => owner("voice.status", voice.status),
        "voice.install": () => owner("voice.install", voice.install),
        "voice.remove": () => owner("voice.remove", voice.remove),
        "voice.preview": ({ voice: id, text }) => owner("voice.preview", voice.preview(id, text)),
        "updates.status": () => owner("updates.status", updates.status),
        "updates.check": () => owner("updates.check", updates.check),
        "updates.install": () => owner("updates.install", updates.install),
        "updates.rollback": () => owner("updates.rollback", updates.rollback),

        // ---------------------------------------------------------------- sidebar (drag and drop)
        "sidebar.arrange": (input) => owner("sidebar.arrange", bots.arrangeSidebar(input)),

        // ---------------------------------------------------------------- Hark (D3.5)
        "hark.status": () => owner("hark.status", hark.status),
        "hark.connect": ({ webhook }) => owner("hark.connect", hark.connect(webhook)),
        "hark.disconnect": () => owner("hark.disconnect", hark.disconnect),
        "hark.test": () => owner("hark.test", hark.test),
        "hark.setSends": ({ sends }) => owner("hark.setSends", hark.setSends(sends)),
        "hark.setQuietAtComputer": ({ quiet }) => owner("hark.setQuietAtComputer", hark.setQuietAtComputer(quiet)),
        "presence.active": () => owner("presence.active", presence.active),
        // ---------------------------------------------------------------- ntfy (D3.6)
        "ntfy.status": () => owner("ntfy.status", ntfy.status),
        "ntfy.connect": (input) => owner("ntfy.connect", ntfy.connect(input)),
        "ntfy.disconnect": () => owner("ntfy.disconnect", ntfy.disconnect),
        "ntfy.test": () => owner("ntfy.test", ntfy.test),
        "ntfy.setSends": ({ sends }) => owner("ntfy.setSends", ntfy.setSends(sends)),
        "ntfy.setQuietAtComputer": ({ quiet }) => owner("ntfy.setQuietAtComputer", ntfy.setQuietAtComputer(quiet)),

        // ---------------------------------------------------------------- usage
        "usage.byBot": ({ sinceMs }) => owner("usage.byBot", usage.byBot({ sinceMs })),
      }),
    )
  }),
)

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
  MAX_DICTATION_CHUNK_BYTES,
  OpenBotRpcs,
  type SessionInfo,
} from "@openbot/contracts"
import {
  ApprovalService,
  AttachmentService,
  BackgroundTasks,
  BotService,
  ComputerPort,
  ConversationService,
  type HarnessDriver,
  HarnessRegistry,
  LiveHub,
  MAX_ATTACHMENT_BYTES,
  MemoryService,
  NodeAdmin,
  NodeDirectory,
  Orchestrator,
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
import { Cause, Clock, Effect, Option, Stream } from "effect"
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
    const ownerFallback = defaultOwnerName()

    return OpenBotRpcs.of({
      // ---------------------------------------------------------------- session
      "session.info": () =>
        edge(
          "session.info",
          Effect.gen(function* () {
            const current = yield* settings.get
            const all = yield* bots.list
            const info: SessionInfo = {
              ownerName: current.ownerName ?? ownerFallback,
              version: OPENBOT_VERSION,
              dataDir: config.dataDir,
              firstRun: all.length === 0,
            }
            return info
          }),
        ),

      // ---------------------------------------------------------------- roster
      "roster.subscribe": ({ after }) => edgeStream("roster.subscribe", hub.subscribeRoster({ after })),

      // ---------------------------------------------------------------- bots
      "bots.create": (input) => edge("bots.create", bots.create(input, { introduce: input.introduce !== false })),
      "bots.update": ({ botId, patch }) => edge("bots.update", bots.update(botId, patch)),
      "bots.delete": ({ botId }) => edge("bots.delete", bots.delete(botId)),
      "bots.get": ({ botId }) => edge("bots.get", bots.get(botId)),
      "bots.readContext": ({ botId }) => edge("bots.readContext", bots.readContext(botId)),
      "bots.newSession": ({ botId }) => edge("bots.newSession", bots.newSession(botId)),
      "bots.compact": ({ botId }) => edge("bots.compact", bots.compact(botId)),

      // ---------------------------------------------------------------- sections
      "sections.list": () => edge("sections.list", bots.listSections),
      "sections.create": ({ name }) => edge("sections.create", bots.createSection(name)),
      "sections.rename": ({ name, sectionId }) => edge("sections.rename", bots.renameSection(sectionId, name)),
      "sections.delete": ({ sectionId }) => edge("sections.delete", bots.deleteSection(sectionId)),
      "sections.reorder": ({ sectionIds }) => edge("sections.reorder", bots.reorderSections(sectionIds)),

      // ---------------------------------------------------------------- conversations
      "conversations.subscribe": ({ after, conversationId, tailLimit }) =>
        edgeStream("conversations.subscribe", hub.subscribeConversation({ conversationId, after, tailLimit })),
      "conversations.history": (input) => edge("conversations.history", conversations.history(input)),
      "conversations.exchange": (input) => edge("conversations.exchange", conversations.exchange(input)),
      "conversations.around": (input) => edge("conversations.around", conversations.around(input)),
      "conversations.createGroup": (input) => edge("conversations.createGroup", conversations.createGroup(input)),
      "conversations.setMembers": (input) => edge("conversations.setMembers", conversations.setMembers(input)),
      "conversations.rename": ({ conversationId, title }) =>
        edge("conversations.rename", conversations.rename(conversationId, title)),
      "conversations.markRead": (input) => edge("conversations.markRead", conversations.markRead(input)),
      "conversations.setHidden": ({ conversationId, hidden }) =>
        edge("conversations.setHidden", conversations.setHidden(conversationId, hidden)),
      "conversations.delete": ({ conversationId }) =>
        edge("conversations.delete", orchestrator.deleteConversation(conversationId)),

      // ---------------------------------------------------------------- messages + turns
      "messages.send": (input) => edge("messages.send", orchestrator.send(input)),
      "messages.lookupSend": (input) => edge("messages.lookupSend", orchestrator.lookupSend(input)),
      "messages.react": (input) => edge("messages.react", orchestrator.react(input)),
      "turns.interrupt": (input) => edge("turns.interrupt", orchestrator.interrupt(input)),
      "turns.retry": (input) => edge("turns.retry", orchestrator.retry(input)),
      "attachments.upload": ({ bytesBase64, mime, name }) =>
        edge(
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
      "requests.respond": (input) => edge("requests.respond", approvals.respond(input)),
      "requests.listPending": (input) => edge("requests.listPending", approvals.listPending(input)),

      // ---------------------------------------------------------------- routines
      "routines.list": ({ botId }) => edge("routines.list", routines.list({ botId })),
      "routines.create": (input) => edge("routines.create", routines.create(userActor, input)),
      "routines.update": (input) => edge("routines.update", routines.update(userActor, input)),
      "routines.setEnabled": ({ enabled, routineId }) =>
        edge("routines.setEnabled", routines.setEnabled(routineId, enabled)),
      "routines.delete": ({ routineId }) => edge("routines.delete", routines.delete(routineId)),
      "routines.runNow": ({ routineId }) => edge("routines.runNow", routines.runNow(routineId)),
      "routines.runs": ({ routineId }) => edge("routines.runs", routines.runs(routineId)),

      // ---------------------------------------------------------------- memory
      "memory.get": ({ botId }) => edge("memory.get", memory.get(botId)),
      "memory.putFact": ({ botId, fact }) => edge("memory.putFact", memory.putFact(userActor, botId, fact)),
      "memory.deleteFact": ({ botId, factId }) =>
        edge("memory.deleteFact", memory.deleteFact(userActor, botId, factId)),
      "memory.setIndex": ({ botId, index }) => edge("memory.setIndex", memory.setIndex(botId, index)),

      // ---------------------------------------------------------------- skills
      "skills.list": () => edge("skills.list", skills.list),
      "skills.upsert": (input) => edge("skills.upsert", skills.upsert(userActor, input)),
      "skills.delete": ({ name }) => edge("skills.delete", skills.delete(name)),
      "skills.assign": ({ name, botIds }) => edge("skills.assign", skills.assign(name, botIds)),
      "skills.search": ({ query }) => edge("skills.search", skills.search(query)),
      "skills.preview": ({ id }) => edge("skills.preview", skills.preview(id)),
      "skills.install": ({ id, botIds }) => edge("skills.install", skills.install(id, botIds)),

      // ---------------------------------------------------------------- harnesses
      "harnesses.status": () => edge("harnesses.status", profiles.status(probeDriver)),
      "harnesses.models": ({ kind, profileId }) =>
        edge(
          "harnesses.models",
          Effect.flatMap(harnesses.get(kind, profileId), (driver) =>
            driver.listModels.pipe(
              Effect.mapError((error) => new HarnessUnavailable({ harness: kind, message: error.message })),
            ),
          ),
        ),
      "harnesses.profiles": ({ kind }) => edge("harnesses.profiles", profiles.list(kind)),
      "harnesses.addProfile": (input) => edge("harnesses.addProfile", profiles.add(input)),
      "harnesses.removeProfile": ({ profileId }) => edge("harnesses.removeProfile", profiles.remove(profileId)),
      "harnesses.discover": ({ kind }) => edge("harnesses.discover", profiles.discover(kind)),

      // ---------------------------------------------------------------- nodes
      "nodes.list": () => edge("nodes.list", nodes.list),
      "nodes.createPairingCode": () => edge("nodes.createPairingCode", nodeAdmin.createPairingCode),
      "nodes.rename": ({ label, nodeId }) => edge("nodes.rename", nodeAdmin.rename(nodeId, label)),
      "nodes.revoke": ({ nodeId }) => edge("nodes.revoke", nodeAdmin.revoke(nodeId)),
      "nodes.setCapabilities": ({ approved, nodeId }) =>
        edge("nodes.setCapabilities", nodeAdmin.setCapabilities(nodeId, approved)),

      // ---------------------------------------------------------------- computer
      "computer.status": ({ botId }) => edge("computer.status", computer.status(botId)),
      "computer.ensure": ({ botId }) => edge("computer.ensure", computer.ensure(botId)),
      "computer.lease": ({ botId, take }) => edge("computer.lease", computer.lease(botId, take)),
      // stops the bot's desktop (and the owner's control with it); a browser-only screen is unchanged
      "computer.reset": ({ botId }) => edge("computer.reset", computer.reset(botId)),

      // ---------------------------------------------------------------- settings + rules
      "settings.get": () => edge("settings.get", settings.get),
      "settings.update": ({ patch }) => edge("settings.update", settings.update(patch)),
      "rules.list": ({ botId }) => edge("rules.list", settings.listRules({ botId })),
      "rules.upsert": ({ rule }) => edge("rules.upsert", settings.upsertRule(rule)),
      "rules.delete": ({ ruleId }) => edge("rules.delete", settings.deleteRule(ruleId)),

      // ---------------------------------------------------------------- background tasks (D5.7)
      "tasks.list": ({ botId, limit }) =>
        edge("tasks.list", Effect.andThen(bots.get(botId), tasks.list({ botId, limit }))),
      "tasks.get": ({ taskId }) => edge("tasks.get", tasks.get(taskId)),
      // the owner's Stop: only that task; the bot is told
      "tasks.cancel": ({ taskId }) => edge("tasks.cancel", tasks.cancel(taskId, "owner")),

      // ---------------------------------------------------------------- message search
      "search.query": (input) => edge("search.query", search.query(input)),
      "search.inConversation": (input) => edge("search.inConversation", search.inConversation(input)),

      // ---------------------------------------------------------------- Slack (D3.4)
      "slack.status": () => edge("slack.status", slack.status),
      "slack.connect": (input) => edge("slack.connect", slack.connect(input)),
      "slack.disconnect": () => edge("slack.disconnect", Effect.andThen(slack.disconnect, slack.status)),
      "slack.sendDraft": ({ entryId, text }) => edge("slack.sendDraft", slackDrafts.send({ entryId, text })),
      "slack.discardDraft": ({ entryId }) => edge("slack.discardDraft", slackDrafts.discard(entryId)),
      "cards.act": (input) => edge("cards.act", uiCards.act(input)),

      "stt.status": () => edge("stt.status", speech.status),
      "stt.install": () => edge("stt.install", speech.install),
      "stt.remove": () => edge("stt.remove", speech.remove),
      "stt.open": () => edge("stt.open", speech.open),
      "stt.append": ({ sessionId, pcmBase64 }) =>
        edge(
          "stt.append",
          withPcm(pcmBase64, (pcm) => speech.append(sessionId, pcm)),
        ),
      "stt.finish": ({ sessionId, pcmBase64 }) =>
        edge(
          "stt.finish",
          withPcm(pcmBase64, (pcm) => speech.finish(sessionId, pcm)),
        ),
      "stt.discard": ({ sessionId }) => edge("stt.discard", speech.discard(sessionId)),
      "voice.status": () => edge("voice.status", voice.status),
      "voice.install": () => edge("voice.install", voice.install),
      "voice.remove": () => edge("voice.remove", voice.remove),
      "voice.preview": ({ voice: id, text }) => edge("voice.preview", voice.preview(id, text)),
      "updates.status": () => edge("updates.status", updates.status),
      "updates.check": () => edge("updates.check", updates.check),
      "updates.install": () => edge("updates.install", updates.install),
      "updates.rollback": () => edge("updates.rollback", updates.rollback),

      // ---------------------------------------------------------------- sidebar (drag and drop)
      "sidebar.arrange": (input) => edge("sidebar.arrange", bots.arrangeSidebar(input)),

      // ---------------------------------------------------------------- Hark (D3.5)
      "hark.status": () => edge("hark.status", hark.status),
      "hark.connect": ({ webhook }) => edge("hark.connect", hark.connect(webhook)),
      "hark.disconnect": () => edge("hark.disconnect", hark.disconnect),
      "hark.test": () => edge("hark.test", hark.test),
      "hark.setSends": ({ sends }) => edge("hark.setSends", hark.setSends(sends)),
      "hark.setQuietAtComputer": ({ quiet }) => edge("hark.setQuietAtComputer", hark.setQuietAtComputer(quiet)),
      "presence.active": () => edge("presence.active", presence.active),
      // ---------------------------------------------------------------- ntfy (D3.6)
      "ntfy.status": () => edge("ntfy.status", ntfy.status),
      "ntfy.connect": (input) => edge("ntfy.connect", ntfy.connect(input)),
      "ntfy.disconnect": () => edge("ntfy.disconnect", ntfy.disconnect),
      "ntfy.test": () => edge("ntfy.test", ntfy.test),
      "ntfy.setSends": ({ sends }) => edge("ntfy.setSends", ntfy.setSends(sends)),

      // ---------------------------------------------------------------- usage
      "usage.byBot": ({ sinceMs }) => edge("usage.byBot", usage.byBot({ sinceMs })),
    })
  }),
)

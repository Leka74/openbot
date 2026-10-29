/**
 * BotService (architecture §4.3): bot CRUD with avatar defaults (FNV-1a of the id, interfaces §8.9),
 * the direct conversation, sections, New session / Compact (via the Orchestrator) and the
 * instruction preview of `bots.readContext`.
 *
 * Names are unique (case-insensitive) because they are how bots are addressed (`@Name`,
 * `message_bot {to}`); "everyone" is reserved for `@everyone`.
 */
import type {
  Bot,
  BotAutonomy,
  BotCreateInput,
  BotHarness,
  BotId,
  BotPatch,
  Conversation,
  NodeId,
  Section,
  SectionId,
  SidebarItemRef,
  SidebarPlace,
} from "@openbot/contracts"
import {
  Conflict,
  kokoroVoice,
  defaultBotAvatar,
  InvalidInput,
  LOCAL_NODE_ID,
  minAutonomy,
  cleanProjectFolders,
  normalizeProfileId,
  NotFound,
} from "@openbot/contracts"
import { Clock, Effect, Layer, Option, Result } from "effect"
import { DataDir } from "../../ports/DataDir.ts"
import { HarnessRegistry } from "../../ports/Harness.ts"
import { IdGen } from "../../ports/IdGen.ts"
import { McpTokenRepo } from "../../ports/Mcp.ts"
import { NodeDirectory } from "../../ports/NodeDirectory.ts"
import { describePlacement, type PlacementSummary, planPlacement, workspacePathFor } from "../../ports/Placement.ts"
import {
  BotRepo,
  ConversationRepo,
  EntryRepo,
  type ReplicaLog,
  RequestRepo,
  SectionRepo,
  SettingsRepo,
  type TurnRepo,
} from "../../ports/repos.ts"
import { currentProfileId, inProfile, OwnerProfiles } from "../../ports/Profiles.ts"
import {
  ApprovalService,
  BackgroundTasks,
  BotService,
  ConversationService,
  InstructionRenderer,
  LiveHub,
  MemoryService,
  Orchestrator,
  RoutineScheduler,
  SettingsService,
} from "../../ports/services.ts"
import { MemoryStore, SkillStore } from "../../ports/stores.ts"
import { ConversationStore, ConversationStoreLive } from "./internal/ConversationStore.ts"
import { compact, findBotByRef, nameKey, orDie, required } from "./internal/util.ts"

export const MAX_BOT_NAME_LENGTH = 64
export const MAX_SECTION_NAME_LENGTH = 64
const RESERVED_NAMES = new Set(["everyone"])
const botNonceKey = (nonce: string) => `brain.botNonce.${nonce}`

/**
 * The hidden first turn of a Bot the owner just created (`introduction` delivery): it greets them,
 * then asks with an `ask_user` card what they want from it first, like Grok's "New Bot". The question
 * and options come from the Bot's own name, label and instructions.
 */
export const introductionText = (ownerName: string | undefined): string => {
  const name = ownerName?.trim() ? ownerName.trim() : undefined
  return [
    `[You just joined the team: ${name === undefined ? "your owner" : `your owner, ${name},`} created you and is opening your direct chat now. Nothing has been said yet.]`,
    `Greet ${name === undefined ? "them" : `${name} by name`} and introduce yourself in one or two short sentences, in your own words, right away without using other tools first. Keep it light and personal; do not recite your instructions.`,
    "Then call `ask_user` once to find out what they want from you first: one question with two to four short option labels (no descriptions) that fit your name, your label and your instructions (and what you know about the owner and the team), no title, free text allowed.",
    "The card speaks for itself: after it, reply exactly NO_REPLY so nothing more is posted. Their answer comes back as a message: treat it as your first request, and remember it if it describes your ongoing job.",
  ].join("\n")
}

type GroupConversation = Extract<Conversation, { kind: "group" }>

/** The stored form of a bot harness: optional fields compacted, the default profile spelled as absent. */
const harnessOf = (input: BotHarness): BotHarness => {
  const { profileId, ...rest } = input
  return compact({ ...rest, profileId: normalizeProfileId(profileId) })
}

const validName = (raw: string, what: string, max: number) => {
  const name = raw.trim()
  if (name === "") return Effect.fail(new InvalidInput({ message: `The ${what} name cannot be empty.` }))
  if (name.length > max)
    return Effect.fail(new InvalidInput({ message: `The ${what} name is longer than ${max} characters.` }))
  if (/[\r\n]/.test(name)) return Effect.fail(new InvalidInput({ message: `The ${what} name must be one line.` }))
  return Effect.succeed(name)
}

export const BotServiceLive: Layer.Layer<
  BotService,
  never,
  | Orchestrator
  | OwnerProfiles
  | RoutineScheduler
  | ApprovalService
  | BackgroundTasks
  | MemoryService
  | InstructionRenderer
  | ConversationService
  | SettingsService
  | LiveHub
  | HarnessRegistry
  | NodeDirectory
  | DataDir
  | IdGen
  | BotRepo
  | SectionRepo
  | ConversationRepo
  | EntryRepo
  | RequestRepo
  | TurnRepo
  | ReplicaLog
  | SettingsRepo
  | MemoryStore
  | SkillStore
  | McpTokenRepo
> = Layer.effect(
  BotService,
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator
    const routines = yield* RoutineScheduler
    const approvals = yield* ApprovalService
    const tasks = yield* BackgroundTasks
    const memory = yield* MemoryService
    const renderer = yield* InstructionRenderer
    const conversationService = yield* ConversationService
    const settingsService = yield* SettingsService
    const store = yield* ConversationStore
    const hub = yield* LiveHub
    const registry = yield* HarnessRegistry
    const directory = yield* NodeDirectory
    const dataDir = yield* DataDir
    const ids = yield* IdGen
    const bots = yield* BotRepo
    const sections = yield* SectionRepo
    const conversations = yield* ConversationRepo
    const settingsRepo = yield* SettingsRepo
    const memoryStore = yield* MemoryStore
    const skillStore = yield* SkillStore
    const tokens = yield* McpTokenRepo
    const ownerProfiles = yield* OwnerProfiles

    /** A Bot of the current profile (another profile's is not found). */
    const getBot = (botId: BotId) =>
      Effect.gen(function* () {
        const bot = yield* required(bots.get(botId), "bot", botId)
        if (bot.ownerProfileId !== (yield* currentProfileId)) return yield* new NotFound({ entity: "bot", id: botId })
        return bot
      })

    const getSection = (sectionId: SectionId) =>
      Effect.gen(function* () {
        const section = yield* required(sections.get(sectionId), "section", sectionId)
        if (section.ownerProfileId !== (yield* currentProfileId))
          return yield* new NotFound({ entity: "section", id: sectionId })
        return section
      })

    const profileBots = Effect.flatMap(currentProfileId, (profileId) => orDie(bots.listIn(profileId)))
    const profileSections = Effect.flatMap(currentProfileId, (profileId) => orDie(sections.list(profileId)))

    const publishBot = (bot: Bot) =>
      Effect.gen(function* () {
        yield* orDie(bots.upsert(bot))
        yield* hub.publishRoster({ type: "bot.upserted", bot })
      })

    /** Unique, non-reserved bot name. */
    const uniqueName = (raw: string, except?: BotId) =>
      Effect.gen(function* () {
        const name = yield* validName(raw, "bot", MAX_BOT_NAME_LENGTH)
        const key = nameKey(name.startsWith("@") ? name.slice(1) : name)
        if (RESERVED_NAMES.has(key)) return yield* new InvalidInput({ message: `"${name}" is reserved.` })
        const all = yield* profileBots
        const taken = all.find((b) => b.id !== except && nameKey(b.name) === key)
        if (taken !== undefined) return yield* new Conflict({ reason: `A bot named "${taken.name}" already exists.` })
        return name
      })

    const nodeExists = (nodeId: NodeId) =>
      directory.get(nodeId).pipe(Effect.mapError(() => new NotFound({ entity: "node", id: nodeId })))

    /** Forgets the bot's native session (a new driver, account or host cannot resume it). */
    const dropNativeSession = (bot: Bot) =>
      Effect.gen(function* () {
        yield* orDie(bots.clearSession(bot.id))
        const now = yield* Clock.currentTimeMillis
        yield* Effect.ignore(
          store.update(bot.directConversationId, (c) =>
            c.sessions === undefined
              ? c
              : {
                  ...c,
                  sessions: c.sessions.map((s) =>
                    s.botId === bot.id ? { botId: bot.id, active: false, updatedAt: now } : s,
                  ),
                },
          ),
        )
      })

    // ------------------------------------------------------------------ create / update / delete

    const create = Effect.fn("BotService.create")(function* (
      input: BotCreateInput,
      options?: { readonly autonomyCeiling?: BotAutonomy | undefined; readonly introduce?: boolean | undefined },
    ) {
      const profileId = yield* currentProfileId
      const nonces = settingsRepo.forProfile(profileId)
      const known = yield* orDie(nonces.get(botNonceKey(input.clientNonce)))
      if (Option.isSome(known) && typeof known.value === "string") {
        const existing = yield* orDie(bots.get(known.value as BotId))
        if (Option.isSome(existing)) return existing.value
      }
      const name = yield* uniqueName(input.name)
      const harness = harnessOf(input.harness)
      // An unknown kind or account (profile) fails here: a bot never falls back to another login.
      yield* registry.get(harness.kind, harness.profileId)
      const hostNodeId = input.hostNodeId ?? LOCAL_NODE_ID
      yield* nodeExists(hostNodeId)
      const label = input.label?.trim()
      const requested = input.autonomy ?? (yield* settingsService.get).defaultAutonomy
      const autonomy =
        options?.autonomyCeiling === undefined ? requested : minAutonomy(requested, options.autonomyCeiling)
      const now = yield* Clock.currentTimeMillis
      const id = yield* ids.botId
      const directConversationId = yield* ids.conversationId
      const bot: Bot = compact({
        id,
        ownerProfileId: profileId,
        name,
        label: label === undefined || label === "" ? undefined : label,
        avatar: input.avatar ?? defaultBotAvatar(id),
        harness,
        hostNodeId,
        boundNodeIds: [],
        instructions: input.instructions ?? "",
        directConversationId,
        pinned: false,
        hidden: false,
        notify: "all" as const,
        autonomy,
        projectFolders: [],
        skills: [],
        createdAt: now,
        updatedAt: now,
      })
      yield* ownerProfiles.adding(
        profileId,
        Effect.gen(function* () {
          yield* publishBot(bot)
          yield* store.create({
            id: directConversationId,
            kind: "direct",
            botId: id,
            title: name,
            createdAt: now,
            lastActivityAt: now,
            unreadCount: 0,
            hiddenFromSidebar: false,
            epoch: yield* ids.next("epc"),
          })
          yield* orDie(nonces.set(botNonceKey(input.clientNonce), id))
        }),
      )
      yield* Effect.ignore(
        conversationService.appendEvent({
          conversationId: directConversationId,
          event: { type: "joined", botId: id, name },
        }),
      )
      if (options?.introduce === true) {
        const { ownerName } = yield* settingsService.get
        yield* orchestrator
          .deliver({
            conversationId: directConversationId,
            botId: id,
            kind: "introduction",
            text: introductionText(ownerName),
            urgency: "urgent",
          })
          .pipe(
            Effect.asVoid,
            Effect.catch((error) => Effect.logWarning("BotService.create: introduction not started", error)),
          )
      }
      return bot
    })

    const update = Effect.fn("BotService.update")(function* (botId: BotId, patch: BotPatch) {
      const before = yield* getBot(botId)
      let next: Bot = { ...before }
      if (patch.name !== undefined) next = { ...next, name: yield* uniqueName(patch.name, botId) }
      if (patch.label !== undefined) {
        const label = patch.label?.trim() ?? ""
        const { label: _drop, ...rest } = next
        next = label === "" ? rest : { ...rest, label }
      }
      if (patch.avatar !== undefined) next = { ...next, avatar: patch.avatar }
      if (patch.harness !== undefined) {
        const harness = harnessOf(patch.harness)
        yield* registry
          .get(harness.kind, harness.profileId)
          .pipe(Effect.mapError((e) => new InvalidInput({ message: e.message })))
        next = { ...next, harness }
      }
      if (patch.hostNodeId !== undefined) {
        yield* nodeExists(patch.hostNodeId)
        next = { ...next, hostNodeId: patch.hostNodeId }
      }
      if (patch.boundNodeIds !== undefined) {
        const unique = [...new Set(patch.boundNodeIds)].filter((id) => id !== next.hostNodeId)
        for (const nodeId of unique) yield* nodeExists(nodeId)
        next = { ...next, boundNodeIds: unique }
      }
      if (patch.instructions !== undefined) next = { ...next, instructions: patch.instructions }
      if (patch.sectionId !== undefined) {
        const { sectionId: _drop, ...rest } = next
        if (patch.sectionId === null) next = rest
        else {
          yield* getSection(patch.sectionId)
          next = { ...rest, sectionId: patch.sectionId }
        }
      }
      if (patch.pinned !== undefined) next = { ...next, pinned: patch.pinned }
      if (patch.sidebarOrder !== undefined) {
        const { sidebarOrder: _drop, ...rest } = next
        next = patch.sidebarOrder === null ? rest : { ...rest, sidebarOrder: patch.sidebarOrder }
      }
      if (patch.hidden !== undefined) next = { ...next, hidden: patch.hidden }
      if (patch.notify !== undefined) next = { ...next, notify: patch.notify }
      if (patch.voice !== undefined) {
        const { voice: _drop, ...rest } = next
        if (patch.voice === null) next = rest
        else if (kokoroVoice(patch.voice) === undefined)
          return yield* new InvalidInput({ message: `There is no voice called "${patch.voice}".` })
        else next = { ...rest, voice: patch.voice }
      }
      if (patch.autonomy !== undefined) next = { ...next, autonomy: patch.autonomy }
      if (patch.projectFolders !== undefined) {
        const cleaned = cleanProjectFolders(patch.projectFolders)
        if ("problem" in cleaned) return yield* new InvalidInput({ message: cleaned.problem })
        next = { ...next, projectFolders: cleaned.folders }
      }
      if (patch.skills !== undefined) {
        const skills = [...new Set(patch.skills)]
        for (const name of skills) {
          // a skill already deleted from the library may be dropped, never added
          const inLibrary = yield* orDie(skillStore.get(name)).pipe(inProfile(before.ownerProfileId))
          if (!before.skills.includes(name) && Option.isNone(inLibrary)) {
            return yield* new InvalidInput({ message: `There is no skill named "${name}" in the library.` })
          }
        }
        next = { ...next, skills }
      }

      const relocated =
        next.harness.kind !== before.harness.kind ||
        normalizeProfileId(next.harness.profileId) !== normalizeProfileId(before.harness.profileId) ||
        next.hostNodeId !== before.hostNodeId
      if (relocated) {
        // A different driver, account or host cannot resume the native sessions (they live in the
        // harness's config home): stop and forget them.
        yield* orchestrator.stopBot(botId)
        yield* dropNativeSession(next)
      }
      next = { ...next, updatedAt: yield* Clock.currentTimeMillis }
      yield* publishBot(next)
      if (next.name !== before.name) {
        yield* Effect.ignore(store.update(next.directConversationId, (c) => ({ ...c, title: next.name })))
        yield* Effect.ignore(
          conversationService.appendEvent({
            conversationId: next.directConversationId,
            event: { type: "name-changed", to: next.name },
          }),
        )
      }
      return next
    })

    /** The Bot stops: its turns, background work and requests end and its tools stop answering. */
    const haltBot = (botId: BotId) =>
      Effect.gen(function* () {
        yield* orDie(tokens.revokeAll(botId))
        yield* orchestrator.stopBot(botId)
        // Its background work stops and its records go (D5.7).
        yield* tasks.removeBot(botId)
        yield* approvals.cancelPending({ botId, reason: "bot-deleted" })
      })

    const deleteBot = Effect.fn("BotService.delete")(function* (botId: BotId) {
      const bot = yield* getBot(botId)
      yield* haltBot(botId)
      for (const routine of yield* routines.list({ botId })) yield* Effect.ignore(routines.delete(routine.id))
      yield* orDie(memoryStore.deleteAll(botId))
      yield* orDie(bots.clearSession(botId))
      const owned = yield* orDie(conversations.list({ botId }))
      for (const conversation of owned) {
        if (conversation.kind !== "group") {
          if (conversation.botId === botId) yield* store.remove(conversation.id)
          continue
        }
        const remaining = conversation.memberBotIds.filter((id) => id !== botId)
        if (remaining.length === 0) {
          yield* store.remove(conversation.id)
          continue
        }
        yield* Effect.ignore(
          store.update(conversation.id, (c) => {
            if (c.kind !== "group") return c
            const { leadBotId, ...rest } = c
            const group: GroupConversation = compact({
              ...rest,
              memberBotIds: c.memberBotIds.filter((id) => id !== botId),
              leadBotId: leadBotId === botId ? undefined : leadBotId,
              sessions: c.sessions?.filter((s) => s.botId !== botId),
            })
            return group
          }),
        )
        yield* Effect.ignore(
          conversationService.appendEvent({
            conversationId: conversation.id,
            event: { type: "member-removed", botId, name: bot.name },
          }),
        )
      }
      yield* orDie(bots.delete(botId))
      yield* hub.publishRoster({ type: "bot.removed", botId }, bot.ownerProfileId)
    })

    // ------------------------------------------------------------------ context preview

    /** Placement preview for `readContext` (pure rules, nothing is opened). */
    const previewPlacement = (bot: Bot) =>
      Effect.gen(function* () {
        const node = yield* Effect.option(directory.get(bot.hostNodeId))
        const driver = yield* Effect.option(registry.get(bot.harness.kind, bot.harness.profileId))
        const workspacePath = Option.isSome(node)
          ? workspacePathFor({ node: node.value, botId: bot.id, dataDir })
          : dataDir.workspaceDir(bot.id)
        const fallback = (reason: string): PlacementSummary => ({
          mode: "native-local",
          hostNodeId: bot.hostNodeId,
          workspacePath,
          toolsets: ["bot"],
          promptAppend: `Where your tools run is decided when your session opens (${reason}).`,
        })
        if (Option.isNone(node)) return fallback("your host computer is unknown")
        if (Option.isNone(driver)) return fallback(`the ${bot.harness.kind} harness is not available`)
        const plan = planPlacement({
          bot,
          driverKind: driver.value.kind,
          capabilities: driver.value.capabilities,
          hostNode: node.value,
        })
        if (Result.isFailure(plan)) return fallback(plan.failure.message)
        const summary: PlacementSummary = {
          mode: plan.success.mode,
          hostNodeId: node.value.id,
          workspacePath,
          toolsets: plan.success.toolsets,
          ...(plan.success.sharedScreen ? { sharedScreen: true } : {}),
          promptAppend: describePlacement(plan.success, node.value, workspacePath),
        }
        return summary
      })

    // ------------------------------------------------------------------ sections

    const publishSection = (section: Section) =>
      Effect.gen(function* () {
        yield* orDie(sections.upsert(section))
        yield* hub.publishRoster({ type: "section.upserted", section })
      })

    const createSection = Effect.fn("BotService.createSection")(function* (raw: string) {
      const name = yield* validName(raw, "section", MAX_SECTION_NAME_LENGTH)
      const all = yield* profileSections
      const order = all.reduce((max, s) => Math.max(max, s.order), -1) + 1
      const section: Section = { id: yield* ids.sectionId, ownerProfileId: yield* currentProfileId, name, order }
      yield* publishSection(section)
      return section
    })

    const renameSection = Effect.fn("BotService.renameSection")(function* (sectionId: SectionId, raw: string) {
      const current = yield* getSection(sectionId)
      const name = yield* validName(raw, "section", MAX_SECTION_NAME_LENGTH)
      const section: Section = { ...current, name }
      if (name !== current.name) yield* publishSection(section)
      return section
    })

    const deleteSection = Effect.fn("BotService.deleteSection")(function* (sectionId: SectionId) {
      const section = yield* getSection(sectionId)
      const now = yield* Clock.currentTimeMillis
      for (const bot of yield* profileBots) {
        if (bot.sectionId !== sectionId) continue
        const { sectionId: _drop, ...rest } = bot
        yield* publishBot({ ...rest, updatedAt: now })
      }
      // its group chats go back to Group chats
      for (const group of yield* orDie(conversations.list({ kind: "group" }))) {
        if (group.kind === "group" && group.sectionId === sectionId) {
          yield* Effect.ignore(conversationService.place(group.id, { sectionId: null }))
        }
      }
      yield* orDie(sections.delete(sectionId))
      yield* hub.publishRoster({ type: "section.removed", sectionId }, section.ownerProfileId)
    })

    const arrangeSidebar = Effect.fn("BotService.arrangeSidebar")(function* (input: {
      readonly place: SidebarPlace
      readonly items: ReadonlyArray<SidebarItemRef>
    }) {
      const { place } = input
      const section = place === "pinned" || place === "unassigned" || place === "groups" ? undefined : place
      if (section !== undefined) yield* getSection(section)
      for (const [index, item] of input.items.entries()) {
        if (item.kind === "bot") {
          if (place === "groups")
            return yield* new InvalidInput({
              message: "Bots go in a section, Unassigned or the pins, not in Group chats.",
            })
          // pinning keeps the Bot's section: unpinned, it goes back there
          yield* update(item.botId, {
            pinned: place === "pinned",
            sidebarOrder: index,
            ...(place === "pinned" ? {} : { sectionId: section ?? null }),
          }).pipe(Effect.catchTag("Conflict", (e) => Effect.fail(new InvalidInput({ message: e.reason }))))
        } else {
          if (place === "pinned") return yield* new InvalidInput({ message: "Group chats can't be pinned." })
          yield* conversationService.place(item.conversationId, { sectionId: section ?? null, sidebarOrder: index })
        }
      }
    })

    const reorderSections = Effect.fn("BotService.reorderSections")(function* (sectionIds: ReadonlyArray<SectionId>) {
      const all = yield* profileSections
      const byId = new Map(all.map((s) => [s.id, s] as const))
      if (new Set(sectionIds).size !== sectionIds.length) {
        return yield* new InvalidInput({ message: "A section can only appear once." })
      }
      for (const id of sectionIds) if (!byId.has(id)) return yield* new NotFound({ entity: "section", id })
      if (sectionIds.length !== all.length) {
        return yield* new Conflict({ reason: "The section list changed; reload and try again." })
      }
      const ordered: Array<Section> = []
      for (const [order, id] of sectionIds.entries()) {
        const current = byId.get(id)!
        const next: Section = { ...current, order }
        if (current.order !== order) yield* publishSection(next)
        ordered.push(next)
      }
      return ordered
    })

    return BotService.of({
      create,
      update,
      delete: deleteBot,
      halt: (botId) => Effect.andThen(getBot(botId), haltBot(botId)),
      get: getBot,
      list: profileBots,
      resolve: (ref) =>
        Effect.flatMap(profileBots, (all) => {
          const bot = findBotByRef(all, ref)
          return bot === undefined ? Effect.fail(new NotFound({ entity: "bot", id: ref.trim() })) : Effect.succeed(bot)
        }),
      readContext: Effect.fn("BotService.readContext")(function* (botId: BotId) {
        const bot = yield* getBot(botId)
        const botMemory = yield* memory.get(botId)
        const placement = yield* previewPlacement(bot)
        const rendered = yield* renderer.render({ bot, placement })
        return { instructions: rendered.text, memory: botMemory }
      }),
      newSession: (botId) => Effect.andThen(getBot(botId), orchestrator.newSession({ botId })),
      compact: (botId) => Effect.andThen(getBot(botId), orchestrator.compact({ botId })),
      listSections: profileSections,
      createSection,
      renameSection,
      deleteSection,
      arrangeSidebar,
      reorderSections,
    })
  }),
).pipe(Layer.provide(ConversationStoreLive))

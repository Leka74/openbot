import { describe, expect, test } from "bun:test"
import type { Bot, ExchangePage, KnownConversationStreamItem, Notification } from "@openbot/contracts"
import { ANSWERED_IN_CHAT, defaultBotAvatar, LOCAL_NODE_ID, OWNER_USER_ID } from "@openbot/contracts"
import { Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import {
  ApprovalService,
  AttachmentService,
  BotRepo,
  BotService,
  ConversationService,
  DataDir,
  HarnessRegistry,
  LiveHub,
  Notifier,
  Orchestrator,
  RequestRepo,
  SettingsService,
  TurnRepo,
} from "../../src/ports/index.ts"
import { introductionText } from "../../src/services/conversation/BotService.ts"
import { AttachmentServiceLive, LiveHubLive, NotifierLive } from "../../src/services/conversation/index.ts"
import { OwnerProfilesLive } from "../../src/services/profiles/index.ts"
import { ApprovalServiceFake, botId, makeBot, makeTurn, runTest, TestPorts } from "../../src/testing/index.ts"
import {
  appLayer,
  collect,
  conversation,
  createBot,
  eventsOf,
  eventually,
  holdBehavior,
  messagesOf,
  send,
  settled,
  TestDriver,
  transcript,
  turnsOf,
} from "./helpers.ts"

describe("BotService", () => {
  test("create: avatar default, DM with a joined event, idempotent nonce, unique names, harness check", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const bots = yield* BotService
        const ada = yield* bots.create({
          name: " Ada ",
          label: "Research",
          harness: { kind: "fake" },
          clientNonce: "c-1",
        })
        const again = yield* bots.create({ name: "Ada", harness: { kind: "fake" }, clientNonce: "c-1" })
        const taken = yield* Effect.flip(bots.create({ name: "ada", harness: { kind: "fake" }, clientNonce: "c-2" }))
        const reserved = yield* Effect.flip(
          bots.create({ name: "Everyone", harness: { kind: "fake" }, clientNonce: "c-3" }),
        )
        const noHarness = yield* Effect.flip(
          bots.create({ name: "Cy", harness: { kind: "claude" }, clientNonce: "c-4" }),
        )
        const noNode = yield* Effect.flip(
          bots.create({
            name: "Cy",
            harness: { kind: "fake" },
            hostNodeId: "nod_missing" as never,
            clientNonce: "c-5",
          }),
        )
        const dm = yield* conversation(ada.directConversationId)
        return {
          ada,
          again,
          taken,
          reserved,
          noHarness,
          noNode,
          dm,
          entries: yield* transcript(ada.directConversationId),
          resolved: yield* bots.resolve("@ADA"),
          list: yield* bots.list,
        }
      }),
      appLayer(),
    )
    expect(out.ada.name).toBe("Ada")
    expect(out.ada.label).toBe("Research")
    expect(out.ada.avatar).toEqual(defaultBotAvatar(out.ada.id))
    expect(out.ada.hostNodeId).toBe(LOCAL_NODE_ID)
    expect(out.again).toEqual(out.ada)
    expect(out.taken._tag).toBe("Conflict")
    expect(out.reserved._tag).toBe("InvalidInput")
    expect(out.noHarness._tag).toBe("HarnessUnavailable")
    expect(out.noNode._tag).toBe("NotFound")
    expect(out.dm).toMatchObject({ kind: "direct", botId: out.ada.id, title: "Ada" })
    expect(eventsOf(out.entries)).toEqual([{ type: "joined", botId: out.ada.id, name: "Ada" }])
    expect(out.resolved.id).toBe(out.ada.id)
    expect(out.list.map((b) => b.id)).toEqual([out.ada.id])
  })

  test("introduce: an owner-created Bot greets the owner in a hidden first turn; without it nothing runs", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const bots = yield* BotService
        const testing = yield* bots.create(
          { name: "Testing Bot", label: "QA", harness: { kind: "fake" }, clientNonce: "n-intro" },
          { introduce: true },
        )
        const quiet = yield* bots.create({ name: "Quiet", harness: { kind: "fake" }, clientNonce: "n-quiet" })
        yield* settled(testing.directConversationId)
        return {
          inputs: (yield* (yield* TestDriver).turns).map((h) => h.input.text),
          turns: yield* turnsOf(testing.directConversationId),
          entries: yield* transcript(testing.directConversationId),
          quietTurns: yield* turnsOf(quiet.directConversationId),
        }
      }),
      appLayer({ settings: { ownerName: "Lekë" } }),
    )
    expect(out.inputs).toEqual([introductionText("Lekë")])
    expect(out.inputs[0]).toContain("Greet Lekë by name")
    expect(out.inputs[0]).toContain("`ask_user`")
    expect(out.turns.map((t) => t.trigger)).toEqual(["system"])
    expect(messagesOf(out.entries).filter((m) => m.role === "user")).toEqual([])
    expect(out.quietTurns).toEqual([])
    expect(introductionText(undefined)).toContain("Greet them")
  })

  test("readContext renders the instructions with a placement preview and the memory", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const ada = yield* createBot("Ada", { instructions: "Research things carefully." })
        yield* createBot("Bob")
        return yield* (yield* BotService).readContext(ada.id)
      }),
      appLayer(),
    )
    expect(out.instructions).toContain("You are Ada")
    expect(out.instructions).toContain("Research things carefully.")
    expect(out.instructions).toContain("@Bob")
    expect(out.instructions).toContain("Your tools run on this computer")
    expect(out.memory.facts).toEqual([])
  })

  test("update: rename follows into the DM; a harness/host change stops runners and drops native sessions", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const bots = yield* BotService
        const botRepo = yield* BotRepo
        const ada = yield* createBot("Ada")
        yield* send(ada.directConversationId, "hello")
        yield* settled(ada.directConversationId)
        const sessionBefore = yield* Effect.orDie(botRepo.getSession(ada.id))
        const renamed = yield* bots.update(ada.id, { name: "Ada Lovelace", label: null, pinned: true })
        const badHarness = yield* Effect.flip(bots.update(ada.id, { harness: { kind: "codex" } }))
        const moved = yield* bots.update(ada.id, {
          harness: { kind: "fake", model: "m-2" },
          hostNodeId: "node_local" as never,
        })
        const sessionAfterModel = yield* Effect.orDie(botRepo.getSession(ada.id))
        return {
          renamed,
          badHarness,
          moved,
          sessionBefore,
          sessionAfterModel,
          dm: yield* conversation(ada.directConversationId),
          entries: yield* transcript(ada.directConversationId),
        }
      }),
      appLayer(),
    )
    expect(out.renamed.name).toBe("Ada Lovelace")
    expect(out.renamed.label).toBeUndefined()
    expect(out.renamed.pinned).toBe(true)
    expect(out.dm.title).toBe("Ada Lovelace")
    expect(eventsOf(out.entries)).toContainEqual({ type: "name-changed", to: "Ada Lovelace" })
    expect(out.badHarness._tag).toBe("InvalidInput")
    expect(out.moved.harness).toEqual({ kind: "fake", model: "m-2" })
    // Same driver and host: the native session is kept (it resumes with the new model).
    expect(Option.isSome(out.sessionBefore)).toBe(true)
    expect(Option.isSome(out.sessionAfterModel)).toBe(true)
  })

  test("harness accounts: profileId is validated, normalized, routed to its driver; switching drops sessions", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const bots = yield* BotService
        const botRepo = yield* BotRepo
        const registry = yield* HarnessRegistry
        const control = yield* TestDriver
        // A second account of the same harness: its own driver instance.
        const alt = { ...control.driver, profileId: "hpf_alt" }
        yield* registry.register(alt)
        const explicitDefault = yield* bots.create({
          name: "Dee",
          harness: { kind: "fake", profileId: "default" },
          clientNonce: "p-1",
        })
        const unknown = yield* Effect.flip(
          bots.create({ name: "Uno", harness: { kind: "fake", profileId: "hpf_gone" }, clientNonce: "p-2" }),
        )
        const ada = yield* bots.create({
          name: "Ada",
          harness: { kind: "fake", profileId: "hpf_alt" },
          clientNonce: "p-3",
        })
        yield* send(ada.directConversationId, "hello")
        yield* settled(ada.directConversationId)
        const opened = (yield* control.opened).map((o) => o.bot.harness.profileId)
        const sessionBefore = yield* Effect.orDie(botRepo.getSession(ada.id))
        const badSwitch = yield* Effect.flip(bots.update(ada.id, { harness: { kind: "fake", profileId: "hpf_gone" } }))
        const switched = yield* bots.update(ada.id, { harness: { kind: "fake", profileId: "default" } })
        const sessionAfter = yield* Effect.orDie(botRepo.getSession(ada.id))
        return { explicitDefault, unknown, ada, opened, sessionBefore, badSwitch, switched, sessionAfter }
      }),
      appLayer(),
    )
    expect(out.explicitDefault.harness).toEqual({ kind: "fake" })
    expect(out.unknown._tag).toBe("HarnessUnavailable")
    expect(out.ada.harness).toEqual({ kind: "fake", profileId: "hpf_alt" })
    expect(out.opened).toEqual(["hpf_alt"])
    expect(Option.isSome(out.sessionBefore)).toBe(true)
    expect(out.badSwitch._tag).toBe("InvalidInput")
    expect(out.switched.harness).toEqual({ kind: "fake" })
    // Another account cannot resume the native session (it lives in that account's config home).
    expect(Option.isNone(out.sessionAfter)).toBe(true)
  })

  test("delete: stops the bot, removes its DM, leaves groups, cancels requests", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const bots = yield* BotService
        const conversations = yield* ConversationService
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const cy = yield* createBot("Cy")
        const group = yield* conversations.createGroup({
          title: "Trio",
          memberBotIds: [ada.id, bob.id, cy.id],
          leadBotId: ada.id,
        })
        yield* bots.delete(ada.id)
        const missing = yield* Effect.flip(bots.get(ada.id))
        const dm = yield* Effect.flip(conversations.get(ada.directConversationId))
        return {
          ada,
          missing,
          dm,
          group: yield* conversations.get(group.id),
          groupEntries: yield* transcript(group.id),
          cancelled: yield* (yield* ApprovalServiceFake).cancelled,
          again: yield* Effect.flip(bots.delete(ada.id)),
        }
      }),
      appLayer(),
    )
    expect(out.missing._tag).toBe("NotFound")
    expect(out.dm._tag).toBe("NotFound")
    expect(out.group.kind === "group" && out.group.memberBotIds).not.toContain(out.ada.id)
    expect(out.group.kind === "group" && out.group.leadBotId).toBeUndefined()
    expect(eventsOf(out.groupEntries).at(-1)).toEqual({ type: "member-removed", botId: out.ada.id, name: "Ada" })
    expect(out.cancelled).toEqual([{ botId: out.ada.id, reason: "bot-deleted" }])
    expect(out.again._tag).toBe("NotFound")
  })

  test("sections: create, rename, reorder (strict), delete unassigns bots", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const bots = yield* BotService
        const ada = yield* createBot("Ada")
        const work = yield* bots.createSection("Work")
        const home = yield* bots.createSection("Home")
        const empty = yield* Effect.flip(bots.createSection("   "))
        yield* bots.update(ada.id, { sectionId: work.id })
        const renamed = yield* bots.renameSection(work.id, "Jobs")
        const reordered = yield* bots.reorderSections([home.id, work.id])
        const partial = yield* Effect.flip(bots.reorderSections([home.id]))
        const dupes = yield* Effect.flip(bots.reorderSections([home.id, home.id]))
        yield* bots.deleteSection(work.id)
        return {
          renamed,
          reordered,
          partial,
          dupes,
          empty,
          sections: yield* bots.listSections,
          ada: yield* bots.get(ada.id),
        }
      }),
      appLayer(),
    )
    expect(out.empty._tag).toBe("InvalidInput")
    expect(out.renamed.name).toBe("Jobs")
    expect(out.reordered.map((s) => [s.name, s.order])).toEqual([
      ["Home", 0],
      ["Jobs", 1],
    ])
    expect(out.partial._tag).toBe("Conflict")
    expect(out.dupes._tag).toBe("InvalidInput")
    expect(out.sections.map((s) => s.name)).toEqual(["Home"])
    expect(out.ada.sectionId).toBeUndefined()
  })
})

describe("dragging chats in the sidebar", () => {
  test("Bots and group chats move between places and keep the order they were dropped in", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const bots = yield* BotService
        const conversations = yield* ConversationService
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const work = yield* bots.createSection("Work")
        const group = yield* conversations.createGroup({ title: "Crew", memberBotIds: [ada.id, bob.id] })
        const groupRef = { kind: "group" as const, conversationId: group.id }
        yield* bots.arrangeSidebar({
          place: work.id,
          items: [{ kind: "bot", botId: bob.id }, groupRef, { kind: "bot", botId: ada.id }],
        })
        const placed = {
          ada: yield* bots.get(ada.id),
          bob: yield* bots.get(bob.id),
          group: yield* conversations.summary(group.id),
        }
        yield* bots.arrangeSidebar({ place: "pinned", items: [{ kind: "bot", botId: ada.id }] })
        const pinned = yield* bots.get(ada.id)
        const groupPinned = yield* Effect.flip(bots.arrangeSidebar({ place: "pinned", items: [groupRef] }))
        const botInGroups = yield* Effect.flip(
          bots.arrangeSidebar({ place: "groups", items: [{ kind: "bot", botId: bob.id }] }),
        )
        yield* bots.arrangeSidebar({ place: "unassigned", items: [{ kind: "bot", botId: bob.id }] })
        const unassigned = yield* bots.get(bob.id)
        yield* bots.deleteSection(work.id)
        return {
          placed,
          pinned,
          groupPinned,
          botInGroups,
          unassigned,
          groupAfter: yield* conversations.summary(group.id),
        }
      }),
      appLayer(),
    )
    expect(out.placed.bob).toMatchObject({ sectionId: expect.any(String), sidebarOrder: 0 })
    expect(out.placed.group).toMatchObject({ sectionId: out.placed.bob.sectionId, sidebarOrder: 1 })
    expect(out.placed.ada).toMatchObject({ sectionId: out.placed.bob.sectionId, sidebarOrder: 2, pinned: false })
    // pinned keeps its section: unpinned it goes back there
    expect(out.pinned).toMatchObject({ pinned: true, sidebarOrder: 0, sectionId: out.placed.bob.sectionId })
    expect(out.groupPinned._tag).toBe("InvalidInput")
    expect(out.botInGroups._tag).toBe("InvalidInput")
    expect(out.unassigned.sectionId).toBeUndefined()
    // a deleted section's group chats go back to Group chats
    expect(out.groupAfter.sectionId).toBeUndefined()
  })
})

describe("ConversationService bookkeeping", () => {
  test("unread counts, markRead, history paging, rename and hide", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const conversations = yield* ConversationService
        const ada = yield* createBot("Ada")
        const dm = ada.directConversationId
        yield* send(dm, "one")
        yield* settled(dm)
        const afterReply = yield* conversation(dm)
        yield* conversations.markRead({ conversationId: dm })
        const read = yield* conversation(dm)
        yield* conversations.markRead({ conversationId: dm, unread: true })
        const unread = yield* conversation(dm)
        const tail = yield* conversations.history({ conversationId: dm, beforeCursor: "", limit: 2 })
        const older = yield* conversations.history({ conversationId: dm, beforeCursor: tail.beforeCursor!, limit: 2 })
        const badLimit = yield* Effect.flip(conversations.history({ conversationId: dm, beforeCursor: "", limit: 0 }))
        const renamed = yield* conversations.rename(dm, "  Ada's desk ")
        yield* conversations.setHidden(dm, true)
        const summary = yield* conversations.summary(dm)
        return { afterReply, read, unread, tail, older, badLimit, renamed, summary }
      }),
      appLayer(),
    )
    expect(out.afterReply.unreadCount).toBe(1)
    expect(out.afterReply.unreadBoundaryAt).toBeDefined()
    expect(out.read.unreadCount).toBe(0)
    expect(out.read.unreadBoundaryAt).toBeUndefined()
    expect(out.unread.unreadCount).toBeGreaterThanOrEqual(1)
    expect(out.tail.entries.map((e) => e.kind)).toEqual(["message", "message"])
    expect(out.tail.hasMoreBefore).toBe(true)
    expect(out.older.entries.map((e) => e.kind)).toEqual(["event"])
    expect(out.older.hasMoreBefore).toBe(false)
    expect(out.badLimit._tag).toBe("InvalidInput")
    expect(out.renamed.title).toBe("Ada's desk")
    expect(out.summary).toMatchObject({
      kind: "direct",
      hiddenFromSidebar: true,
      preview: "Reply from Ada",
      unreadCount: out.unread.unreadCount,
    })
  })

  test("exchange: two bots' messages from both DMs, a page around a time, older and newer pages", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const conversations = yield* ConversationService
        const [ada, bob, cy] = [yield* createBot("Ada"), yield* createBot("Bob"), yield* createBot("Cy")]
        // what message_bot writes: the message in the recipient's DM, addressed to it
        const say = (from: Bot, to: Bot, text: string) =>
          Effect.andThen(
            TestClock.adjust("1 second"),
            conversations.appendEntry({
              kind: "message",
              conversationId: to.directConversationId,
              author: { kind: "bot", botId: from.id },
              role: "bot",
              text,
              attachments: [],
              streaming: false,
              toBotId: to.id,
            }),
          )
        const sent = []
        for (let i = 1; i <= 9; i++) sent.push(yield* i % 2 === 1 ? say(ada, bob, `m${i}`) : say(bob, ada, `m${i}`))
        yield* say(cy, ada, "from Cy")
        const view = (page: ExchangePage) => ({
          texts: page.entries.map((e) => (e.kind === "message" ? e.text : e.kind)),
          older: page.beforeCursor !== null,
          newer: page.afterCursor !== null,
        })
        const pair = { botId: ada.id, peerBotId: bob.id, limit: 4 }
        const around = yield* conversations.exchange({
          ...pair,
          botId: bob.id,
          peerBotId: ada.id,
          at: sent[4]!.createdAt,
        })
        return {
          newest: view(yield* conversations.exchange(pair)),
          around: view(around),
          older: view(yield* conversations.exchange({ ...pair, before: around.beforeCursor! })),
          newer: view(yield* conversations.exchange({ ...pair, after: around.afterCursor! })),
          atNewest: view(yield* conversations.exchange({ ...pair, at: sent[8]!.createdAt })),
          atOldest: view(yield* conversations.exchange({ ...pair, at: sent[0]!.createdAt })),
          refused: yield* Effect.forEach(
            [
              conversations.exchange({ ...pair, limit: 0 }),
              conversations.exchange({ ...pair, at: 1, before: around.beforeCursor! }),
              conversations.exchange({ ...pair, before: "nope" }),
              conversations.exchange({ ...pair, peerBotId: ada.id }),
              conversations.exchange({ ...pair, peerBotId: "bot_gone" as Bot["id"] }),
            ],
            (call) => Effect.map(Effect.flip(call), (e) => e._tag),
          ),
        }
      }),
      appLayer(),
    )
    expect(out.newest).toEqual({ texts: ["m6", "m7", "m8", "m9"], older: true, newer: false })
    // half at or before m5 (the target), half after
    expect(out.around).toEqual({ texts: ["m4", "m5", "m6", "m7"], older: true, newer: true })
    expect(out.older).toEqual({ texts: ["m1", "m2", "m3"], older: false, newer: true })
    expect(out.newer).toEqual({ texts: ["m8", "m9"], older: true, newer: false })
    // a short side leaves its room to the other
    expect(out.atNewest).toEqual({ texts: ["m6", "m7", "m8", "m9"], older: true, newer: false })
    expect(out.atOldest).toEqual({ texts: ["m1", "m2", "m3", "m4"], older: false, newer: true })
    expect(out.refused).toEqual(["InvalidInput", "InvalidInput", "InvalidInput", "InvalidInput", "NotFound"])
  })
})

describe("Orchestrator extras", () => {
  test("answers to async requests (ask_user / request_approval) become deliveries", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const ada = yield* createBot("Ada")
        yield* (yield* ApprovalServiceFake).answer({
          conversationId: ada.directConversationId,
          botId: ada.id,
          kind: "user-message",
          text: "Answer: blue",
          urgency: "urgent",
        })
        yield* settled(ada.directConversationId)
        return { handles: yield* driver.turns, turns: yield* turnsOf(ada.directConversationId) }
      }),
      appLayer(),
    )
    expect(out.handles.map((h) => h.input.text)).toEqual(["Answer: blue"])
    expect(out.turns[0]!.trigger).toBe("user")
  })

  test("writing in a DM settles the Bot's open questions there (answered in chat); a group message does not", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const group = yield* (yield* ConversationService).createGroup({
          title: "Duo",
          memberBotIds: [ada.id, bob.id],
          leadBotId: ada.id,
        })
        yield* send(ada.directConversationId, "The first one")
        yield* send(group.id, "Morning")
        yield* settled(ada.directConversationId)
        yield* settled(group.id)
        return { ada, cancelled: yield* (yield* ApprovalServiceFake).cancelled }
      }),
      appLayer(),
    )
    // (every turn's end also cancels that turn's own requests)
    expect(out.cancelled.filter((c) => c.reason !== "turn-ended")).toEqual([
      {
        conversationId: out.ada.directConversationId,
        kinds: ["question"],
        asyncOnly: true,
        reason: ANSWERED_IN_CHAT,
        cardDetail: "Answered in chat",
      },
    ])
  })

  test("react toggles the owner's reaction on a message", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator
        const ada = yield* createBot("Ada")
        const sent = yield* send(ada.directConversationId, "hi")
        yield* settled(ada.directConversationId)
        yield* orchestrator.react({ conversationId: ada.directConversationId, entryId: sent.entryId, emoji: "👍" })
        const on = messagesOf(yield* transcript(ada.directConversationId))[0]!
        yield* orchestrator.react({ conversationId: ada.directConversationId, entryId: sent.entryId, emoji: "👍" })
        const off = messagesOf(yield* transcript(ada.directConversationId))[0]!
        return { on, off }
      }),
      appLayer(),
    )
    expect(out.on.reactions).toEqual([{ emoji: "👍", by: { kind: "user", userId: OWNER_USER_ID } }])
    expect(out.off.reactions).toBeUndefined()
  })

  test("native approval: the turn waits while the owner decides, then continues", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const approvals = yield* ApprovalService
        const requests = yield* RequestRepo
        const hub = yield* LiveHub
        const ada = yield* createBot("Ada")
        const dm = ada.directConversationId
        yield* driver.setBehavior(ada.id, (turn) =>
          Effect.gen(function* () {
            const resolution = yield* turn.request({
              kind: "command-approval",
              toolName: "Bash",
              title: "Run ls",
              detail: "ls -la",
              command: "ls -la",
            })
            yield* turn.say(`${turn.turnId}/m`, "decision" in resolution ? `Got ${resolution.decision}` : "answers")
            yield* turn.complete()
          }),
        )
        yield* send(dm, "list files")
        yield* eventually(
          Effect.map(turnsOf(dm), (turns) => turns[0]?.status === "waiting"),
          "turn waiting",
        )
        const waitingActivity = (yield* hub.activities).find((a) => a.botId === ada.id)
        const pending = yield* Effect.orDie(requests.list({ conversationId: dm, statuses: ["pending"] }))
        yield* approvals.respond({ requestId: pending[0]!.id, response: { type: "decision", decision: "allow-once" } })
        yield* settled(dm)
        return { waitingActivity, pending, turns: yield* turnsOf(dm), entries: yield* transcript(dm) }
      }),
      appLayer({ approvals: "live" }),
    )
    expect(out.waitingActivity?.state).toBe("waiting")
    expect(out.waitingActivity?.label).toContain("Waiting for you")
    expect(out.pending).toHaveLength(1)
    expect(out.turns.map((t) => t.status)).toEqual(["completed"])
    expect(messagesOf(out.entries).at(-1)?.text).toBe("Got allow-once")
    expect(out.entries.some((e) => e.kind === "card" && e.state.status === "resolved")).toBe(true)
  })

  test('autonomy: a new bot ("workspace") runs commands in its workspace without a card; "ask" brings the card back', async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const requests = yield* RequestRepo
        const bots = yield* BotService
        const approvals = yield* ApprovalService
        const ada = yield* createBot("Ada")
        const dm = ada.directConversationId
        const workspace = (yield* DataDir).workspaceDir(ada.id)
        yield* driver.setBehavior(ada.id, (turn) =>
          Effect.gen(function* () {
            const resolution = yield* turn.request({
              kind: "command-approval",
              toolName: "Bash",
              title: "Run bun tests",
              detail: "bun test",
              command: "bun test",
              cwd: `${workspace}/wordfreq`,
            })
            yield* turn.say(`${turn.turnId}/m`, "decision" in resolution ? `Got ${resolution.decision}` : "answers")
            yield* turn.complete()
          }),
        )
        yield* send(dm, "run the tests")
        yield* settled(dm)
        const auto = yield* transcript(dm)
        yield* bots.update(ada.id, { autonomy: "ask" })
        yield* send(dm, "again")
        yield* eventually(
          Effect.map(turnsOf(dm), (turns) => turns[1]?.status === "waiting"),
          "turn waiting",
        )
        const pending = yield* Effect.orDie(requests.list({ conversationId: dm, statuses: ["pending"] }))
        yield* approvals.respond({ requestId: pending[0]!.id, response: { type: "decision", decision: "deny" } })
        yield* settled(dm)
        return { autonomy: ada.autonomy, auto, pending }
      }),
      appLayer({ approvals: "live" }),
    )
    expect(out.autonomy).toBe("workspace")
    expect(out.auto.some((e) => e.kind === "card")).toBe(false)
    expect(messagesOf(out.auto).at(-1)?.text).toBe("Got allow-once")
    expect(eventsOf(out.auto)).toContainEqual(
      expect.objectContaining({ type: "auto-decided", decision: "allowed", autonomy: "workspace" }),
    )
    expect(out.pending).toHaveLength(1)
  })

  test("default autonomy from Settings; create_bot's ceiling caps it; project folders are validated and rendered", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const bots = yield* BotService
        const settings = yield* SettingsService
        const byDefault = yield* bots.create({ name: "Ada", harness: { kind: "fake" }, clientNonce: "d-1" })
        const explicit = yield* bots.create({
          name: "Bo",
          harness: { kind: "fake" },
          autonomy: "full",
          clientNonce: "d-2",
        })
        yield* settings.update({ defaultAutonomy: "full" })
        const capped = yield* bots.create(
          { name: "Cy", harness: { kind: "fake" }, clientNonce: "d-3" },
          { autonomyCeiling: "workspace" },
        )
        const uncapped = yield* bots.create(
          { name: "Di", harness: { kind: "fake" }, clientNonce: "d-4" },
          { autonomyCeiling: "full" },
        )
        const updated = yield* bots.update(byDefault.id, {
          projectFolders: ["/home/me/projects/snip/", "/home/me/projects/snip", "~/code"],
        })
        const refused = yield* Effect.flip(bots.update(byDefault.id, { projectFolders: ["/"] }))
        yield* settings.update({ sharedProjectFolders: ["/srv/shared"] })
        const context = yield* bots.readContext(byDefault.id)
        return { byDefault, explicit, capped, uncapped, updated, refused, instructions: context.instructions }
      }),
      appLayer({ settings: { defaultAutonomy: "ask" } }),
    )
    expect(out.byDefault.autonomy).toBe("ask")
    expect(out.byDefault.projectFolders).toEqual([])
    expect(out.explicit.autonomy).toBe("full")
    expect(out.capped.autonomy).toBe("workspace")
    expect(out.uncapped.autonomy).toBe("full")
    expect(out.updated.projectFolders).toEqual(["/home/me/projects/snip", "~/code"])
    expect(out.refused._tag).toBe("InvalidInput")
    expect(out.instructions).toContain("Project folders:")
    expect(out.instructions).toContain("- /srv/shared\n- /home/me/projects/snip\n- ~/code")
  })

  test("stopBot interrupts the running turn and drops queued ones", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const ada = yield* createBot("Ada")
        const dm = ada.directConversationId
        yield* driver.setBehavior(ada.id, holdBehavior)
        const first = yield* send(dm, "one")
        yield* eventually(
          Effect.map(driver.turns, (t) => t.length === 1),
          "turn started",
        )
        yield* send(dm, "two")
        yield* (yield* Orchestrator).stopBot(ada.id)
        const outcome = yield* Effect.flatMap(Orchestrator, (o) => o.awaitDelivery("missing")).pipe(Effect.flip)
        return { first, outcome, turns: yield* turnsOf(dm) }
      }),
      appLayer(),
    )
    expect(out.turns.map((t) => t.status)).toEqual(["interrupted", "interrupted"])
    expect(out.outcome._tag).toBe("NotFound")
  })

  test("recover republishes boot-recovery changes and resets activities", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const hub = yield* LiveHub
        const ada = yield* createBot("Ada")
        const dm = ada.directConversationId
        const live = yield* collect(hub.subscribeConversation({ conversationId: dm }))
        yield* eventually(
          Effect.map(live.items, (items) => items.length === 2),
          "snapshot",
        )
        const turn = makeTurn({ conversationId: dm, botId: ada.id, status: "interrupted", stopReason: "brain-restart" })
        yield* Effect.orDie((yield* TurnRepo).upsert(turn))
        yield* (yield* Orchestrator).recover({
          killedProcesses: [],
          interruptedTurns: [turn],
          cutOffTurns: [],
          expiredRequests: [],
          updatedEntries: [],
          interruptedRuns: [],
          interruptedTasks: [],
        })
        yield* eventually(
          Effect.map(live.items, (items) => items.length >= 3),
          "republished turn",
        )
        return {
          items: (yield* live.items) as ReadonlyArray<KnownConversationStreamItem>,
          activities: yield* hub.activities,
          ada,
        }
      }),
      appLayer(),
    )
    expect(out.items[2]).toMatchObject({
      kind: "change",
      change: { type: "turn.upserted", turn: { status: "interrupted" } },
    })
    expect(out.activities).toContainEqual(expect.objectContaining({ botId: out.ada.id, state: "idle" }))
  })
})

describe("NotifierLive and AttachmentServiceLive", () => {
  const layer = () =>
    Layer.mergeAll(NotifierLive, AttachmentServiceLive).pipe(
      Layer.provideMerge(LiveHubLive),
      Layer.provideMerge(OwnerProfilesLive),
      Layer.provideMerge(TestPorts()),
    )

  test("notify honors the bot's preference and publishes a roster notification", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const bots = yield* BotRepo
        const notifier = yield* Notifier
        const hub = yield* LiveHub
        const all = makeBot({ id: botId("bot_all"), notify: "all" })
        const mentions = makeBot({ id: botId("bot_mentions"), notify: "mentions" })
        const none = makeBot({ id: botId("bot_none"), notify: "none" })
        for (const bot of [all, mentions, none]) yield* Effect.orDie(bots.upsert(bot))
        const live = yield* collect(hub.subscribeRoster({}))
        const results: Array<Notification | undefined> = []
        results.push(yield* notifier.notify({ kind: "finished", botId: all.id, title: "A", body: "done" }))
        results.push(yield* notifier.notify({ kind: "finished", botId: mentions.id, title: "M", body: "done" }))
        results.push(yield* notifier.notify({ kind: "waiting", botId: mentions.id, title: "M", body: "needs you" }))
        results.push(yield* notifier.notify({ kind: "error", botId: none.id, title: "N", body: "broken" }))
        yield* eventually(
          Effect.map(live.items, (items) => items.length === 4),
          "notifications",
        )
        return { results, items: yield* live.items }
      }),
      layer(),
    )
    expect(out.results.map((n) => n?.kind)).toEqual(["finished", undefined, "waiting", undefined])
    expect(out.items.slice(2).map((i) => i.kind === "change" && i.change.type)).toEqual([
      "notification",
      "notification",
    ])
  })

  test("upload validates and returns the contract view", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const attachments = yield* AttachmentService
        const ok = yield* attachments.upload({
          name: "notes/today.txt",
          mime: "text/plain",
          bytes: new TextEncoder().encode("hi"),
        })
        const empty = yield* Effect.flip(
          attachments.upload({ name: "a.txt", mime: "text/plain", bytes: new Uint8Array() }),
        )
        const badMime = yield* Effect.flip(
          attachments.upload({ name: "a.txt", mime: "nope", bytes: new Uint8Array([1]) }),
        )
        return { ok, empty, badMime, got: yield* attachments.get(ok.id) }
      }),
      layer(),
    )
    expect(out.ok).toMatchObject({
      name: "notes_today.txt",
      mime: "text/plain",
      byteSize: 2,
      url: `/api/attachments/${out.ok.id}`,
    })
    expect(out.got).toEqual(out.ok)
    expect(out.empty._tag).toBe("InvalidInput")
    expect(out.badMime._tag).toBe("InvalidInput")
  })
})

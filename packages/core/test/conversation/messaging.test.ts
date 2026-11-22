import { describe, expect, test } from "bun:test"
import type { ConversationId } from "@openbot/contracts"
import { Deferred, Effect, Exit, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import { ConversationService, Messaging, Orchestrator, type ToolContext } from "../../src/ports/index.ts"
import { BOT_DM_HINT } from "../../src/services/conversation/BotRunner.ts"
import { HOP_LIMIT_MESSAGE, MESSAGING_DISABLED, MessagingLive } from "../../src/services/conversation/index.ts"
import {
  botId,
  conversationId,
  CoreServiceFakes,
  makeBot,
  makeClaims,
  makeDirectConversation,
  OrchestratorFake,
  runTest,
  TestPorts,
} from "../../src/testing/index.ts"
import { BotRepo, ConversationRepo } from "../../src/ports/index.ts"
import {
  appLayer,
  createBot,
  eventsOf,
  eventually,
  messagesOf,
  passBotWakeDebounce,
  send,
  settled,
  TestDriver,
  transcript,
  turnsOf,
} from "./helpers.ts"

const toolFor = (bot: { readonly id: string }, conversation: ConversationId, callId?: string): ToolContext => ({
  claims: makeClaims({ botId: bot.id as never, conversationId: conversation }),
  ...(callId === undefined ? {} : { callId }),
})

const yieldMany = Effect.gen(function* () {
  for (let i = 0; i < 200; i++) yield* Effect.yieldNow
})

describe("message_bot (D5.2)", () => {
  test("urgent: the recipient's DM gets the message and wakes; the sender's chat gets an event line", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const messaging = yield* Messaging
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const results = yield* Ref.make<ReadonlyArray<unknown>>([])
        yield* driver.setBehavior(ada.id, (turn) =>
          Effect.gen(function* () {
            const sent = yield* messaging.messageBot(turn.tool, {
              to: "@bob",
              text: "Can you check the build?",
              urgency: "urgent",
            })
            yield* Ref.update(results, (all) => [...all, sent])
            yield* turn.say(`${turn.turnId}/m`, "Asked Bob.")
            yield* turn.complete()
          }).pipe(Effect.orDie),
        )
        yield* send(ada.directConversationId, "Ask Bob about the build")
        yield* settled(ada.directConversationId)
        yield* settled(bob.directConversationId)
        return {
          ada,
          bob,
          results: yield* Ref.get(results),
          adaEntries: yield* transcript(ada.directConversationId),
          bobEntries: yield* transcript(bob.directConversationId),
          bobTurns: yield* turnsOf(bob.directConversationId),
          handles: yield* driver.turns,
        }
      }),
      appLayer(),
    )
    const delivered = messagesOf(out.bobEntries).find((m) => m.toBotId === out.bob.id)!
    expect(delivered.author).toEqual({ kind: "bot", botId: out.ada.id })
    expect(delivered.role).toBe("bot")
    expect(delivered.text).toBe("Can you check the build?")
    expect(out.results).toEqual([
      expect.objectContaining({
        recipientBotId: out.bob.id,
        conversationId: out.bob.directConversationId,
        entryId: delivered.id,
      }),
    ])
    expect(eventsOf(out.adaEntries)).toContainEqual({
      type: "messaged-bot",
      toBotId: out.bob.id,
      toName: "Bob",
      conversationId: out.bob.directConversationId,
      entryId: delivered.id,
      urgency: "urgent",
    })
    expect(out.bobTurns.map((t) => [t.trigger, t.status])).toEqual([["bot", "completed"]])
    const bobTurn = out.handles.find((h) => h.bot.id === out.bob.id)!
    expect(bobTurn.input.text).toBe(`${BOT_DM_HINT}\n[Direct message from @Ada]: Can you check the build?`)
    // Bob's reply stays in Bob's DM.
    expect(messagesOf(out.bobEntries).at(-1)?.text).toBe("Reply from Bob")
    expect(messagesOf(out.adaEntries).some((m) => m.text === "Reply from Bob")).toBe(false)
  })

  test("background: an idle recipient wakes after botWakeDebounce, with everything that arrived meanwhile in one turn", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const messaging = yield* Messaging
        const orchestrator = yield* Orchestrator
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const cy = yield* createBot("Cy")
        yield* messaging.messageBot(toolFor(ada, ada.directConversationId), {
          to: "Bob",
          text: "FYI: the report is in the shared folder.",
          urgency: "background",
        })
        yield* TestClock.adjust("30 seconds")
        yield* yieldMany
        // measured from the first queued message: this one does not push the wake-up back
        const receipt = yield* orchestrator.deliver({
          conversationId: bob.directConversationId,
          botId: bob.id,
          kind: "bot-message",
          text: "Mine is done too.",
          fromBotId: cy.id,
          urgency: "background",
        })
        yield* TestClock.adjust("14 seconds")
        yield* yieldMany
        const early = (yield* driver.turns).length
        yield* TestClock.adjust("1 second")
        yield* settled(bob.directConversationId)
        return { receipt, early, handles: yield* driver.turns, after: yield* turnsOf(bob.directConversationId) }
      }),
      appLayer(),
    )
    expect(out.receipt.disposition).toBe("batched")
    expect(out.early).toBe(0)
    expect(out.after).toHaveLength(1)
    expect(out.handles).toHaveLength(1)
    expect(out.handles[0]!.input.text).toContain("[Direct message from @Ada]: FYI: the report is in the shared folder.")
    expect(out.handles[0]!.input.text).toContain("Mine is done too.")
  })

  test("background: an owner message during the debounce wakes the bot at once and takes the waiting message along", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const messaging = yield* Messaging
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        yield* messaging.messageBot(toolFor(ada, ada.directConversationId), {
          to: "Bob",
          text: "FYI: the report is in the shared folder.",
          urgency: "background",
        })
        yield* TestClock.adjust("5 seconds")
        yield* send(bob.directConversationId, "Anything new?")
        yield* settled(bob.directConversationId)
        // nothing is left to wake the bot later
        yield* passBotWakeDebounce
        yield* yieldMany
        return { handles: yield* driver.turns, after: yield* turnsOf(bob.directConversationId) }
      }),
      appLayer(),
    )
    expect(out.after.map((t) => t.trigger)).toEqual(["user"])
    expect(out.handles).toHaveLength(1)
    expect(out.handles[0]!.input.text).toContain("FYI: the report is in the shared folder.")
    expect(out.handles[0]!.input.text).toContain("Anything new?")
  })

  test("background: a busy recipient is not interrupted; the message runs after its turn, once the debounce has passed", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const messaging = yield* Messaging
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const release = yield* Deferred.make<void>()
        yield* driver.setBehavior(bob.id, (turn) =>
          Effect.gen(function* () {
            if (turn.input.text === "Long task") yield* Deferred.await(release)
            yield* turn.complete()
          }),
        )
        yield* send(bob.directConversationId, "Long task")
        yield* eventually(
          Effect.map(driver.turns, (all) => all.length === 1),
          "bob busy",
        )
        yield* messaging.messageBot(toolFor(ada, ada.directConversationId), {
          to: "Bob",
          text: "Done with mine.",
          urgency: "background",
        })
        const whileBusy = (yield* driver.turns).length
        yield* Deferred.succeed(release, undefined)
        yield* settled(bob.directConversationId)
        yield* yieldMany
        const afterTurn = (yield* driver.turns).length
        yield* passBotWakeDebounce
        yield* eventually(
          Effect.map(driver.turns, (all) => all.length === 2),
          "follow-up turn",
        )
        yield* settled(bob.directConversationId)
        return { whileBusy, afterTurn, handles: yield* driver.turns }
      }),
      appLayer(),
    )
    expect(out.whileBusy).toBe(1)
    expect(out.afterTurn).toBe(1)
    expect(out.handles).toHaveLength(2)
    expect(out.handles[1]!.input.text).toBe(`${BOT_DM_HINT}\n[Direct message from @Ada]: Done with mine.`)
  })

  test("bot ping-pong through message_bot stops after 8 hops with a model-readable refusal", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const messaging = yield* Messaging
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const refusals = yield* Ref.make<ReadonlyArray<string>>([])
        const pingPong = (to: string) => (turn: Parameters<Parameters<typeof driver.setBehavior>[1]>[0]) =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(
              messaging.messageBot(turn.tool, { to, text: "your turn", urgency: "urgent" }),
            )
            if (Exit.isFailure(exit)) {
              const error = exit.cause.toString()
              yield* Ref.update(refusals, (all) => [...all, error])
            }
            yield* turn.complete()
          })
        yield* driver.setBehavior(ada.id, pingPong("Bob"))
        yield* driver.setBehavior(bob.id, pingPong("Ada"))
        yield* send(ada.directConversationId, "Start the rally")
        yield* eventually(
          Effect.map(Ref.get(refusals), (all) => all.length === 1),
          "hop refusal",
        )
        yield* settled(ada.directConversationId, 5)
        yield* settled(bob.directConversationId, 4)
        return {
          ada,
          bob,
          refusals: yield* Ref.get(refusals),
          adaTurns: yield* turnsOf(ada.directConversationId),
          bobTurns: yield* turnsOf(bob.directConversationId),
          adaEntries: yield* transcript(ada.directConversationId),
        }
      }),
      appLayer(),
    )
    // 1 owner turn + 8 bot hops = 9 turns; the 9th turn's message_bot call is refused.
    expect(out.adaTurns.length + out.bobTurns.length).toBe(9)
    expect(out.adaTurns).toHaveLength(5)
    expect(out.refusals).toHaveLength(1)
    expect(out.refusals[0]).toContain("too many hand-offs")
    // The refusing turn ran in Ada's DM (hops 8 → the next hop would be 9).
    expect(eventsOf(out.adaEntries).filter((e) => e.type === "hop-limit")).toEqual([{ type: "hop-limit", hops: 8 }])
  })

  test("hop limit, kill switch, self-messages and idempotency (Orchestrator fake)", async () => {
    const ADA = makeBot({ id: botId("bot_a"), name: "Ada", directConversationId: conversationId("cnv_a") })
    const BOB = makeBot({ id: botId("bot_b"), name: "Bob", directConversationId: conversationId("cnv_b") })
    const seed = Effect.gen(function* () {
      const bots = yield* BotRepo
      const conversations = yield* ConversationRepo
      for (const bot of [ADA, BOB]) {
        yield* Effect.orDie(bots.upsert(bot))
        yield* Effect.orDie(
          conversations.upsert(makeDirectConversation({ id: bot.directConversationId, botId: bot.id })),
        )
      }
    })
    const layer = (botMessaging: boolean) =>
      MessagingLive.pipe(
        Layer.provideMerge(CoreServiceFakes({ settings: { botMessaging } })),
        Layer.provideMerge(TestPorts()),
      )
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const messaging = yield* Messaging
        const fake = yield* OrchestratorFake
        const tool = toolFor(ADA, ADA.directConversationId, "call-1")
        const first = yield* messaging.messageBot(tool, { to: "Bob", text: "hi", urgency: "urgent" })
        const retried = yield* messaging.messageBot(tool, { to: "Bob", text: "hi", urgency: "urgent" })
        const self = yield* Effect.flip(
          messaging.messageBot(toolFor(ADA, ADA.directConversationId), { to: "ada", text: "x", urgency: "urgent" }),
        )
        const unknown = yield* Effect.flip(
          messaging.messageBot(toolFor(ADA, ADA.directConversationId), { to: "Zed", text: "x", urgency: "urgent" }),
        )
        yield* fake.setChain(ADA.id, { rootId: "dlv_root", hops: 7 })
        const lastHop = yield* messaging.messageBot(toolFor(ADA, ADA.directConversationId), {
          to: "Bob",
          text: "8th",
          urgency: "urgent",
        })
        yield* fake.setChain(ADA.id, { rootId: "dlv_root", hops: 8 })
        const limited = yield* Effect.flip(
          messaging.messageBot(toolFor(ADA, ADA.directConversationId), { to: "Bob", text: "9th", urgency: "urgent" }),
        )
        return { first, retried, self, unknown, lastHop, limited, deliveries: yield* fake.deliveries }
      }),
      layer(true),
    )
    expect(out.retried).toEqual(out.first)
    expect(out.self._tag).toBe("InvalidInput")
    expect(out.unknown._tag).toBe("NotFound")
    expect(out.limited).toMatchObject({ _tag: "InvalidInput", message: HOP_LIMIT_MESSAGE })
    expect(out.deliveries.map((d) => [d.kind, d.botId, d.fromBotId, d.causalChain.hops])).toEqual([
      ["bot-message", BOB.id, ADA.id, 1],
      ["bot-message", BOB.id, ADA.id, 8],
    ])
    expect(out.deliveries[1]!.causalChain.rootId).toBe("dlv_root")

    const disabled = await runTest(
      Effect.gen(function* () {
        yield* seed
        return yield* Effect.flip(
          (yield* Messaging).messageBot(toolFor(ADA, ADA.directConversationId), {
            to: "Bob",
            text: "hi",
            urgency: "urgent",
          }),
        )
      }),
      layer(false),
    )
    expect(disabled).toMatchObject({ _tag: "InvalidInput", message: MESSAGING_DISABLED })
  })
})

describe("post_to_group and handoff_task", () => {
  test("post_to_group posts as the bot and wakes the mentioned members only", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const messaging = yield* Messaging
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const cy = yield* createBot("Cy")
        const outsider = yield* createBot("Dee")
        const group = yield* (yield* ConversationService).createGroup({
          title: "Launch",
          memberBotIds: [ada.id, bob.id, cy.id],
        })
        const posted = yield* messaging.postToGroup(toolFor(ada, ada.directConversationId), {
          conversationId: group.id,
          text: "@Bob please review the draft",
        })
        yield* settled(group.id)
        const notInGroup = yield* Effect.flip(
          messaging.postToGroup(toolFor(outsider, outsider.directConversationId), {
            conversationId: group.id,
            text: "hello",
          }),
        )
        const notAGroup = yield* Effect.flip(
          messaging.postToGroup(toolFor(ada, ada.directConversationId), { text: "hello" }),
        )
        return {
          ada,
          bob,
          group,
          posted,
          notInGroup,
          notAGroup,
          groupEntries: yield* transcript(group.id),
          adaEntries: yield* transcript(ada.directConversationId),
          turns: yield* turnsOf(group.id),
          handles: yield* driver.turns,
        }
      }),
      appLayer(),
    )
    const post = messagesOf(out.groupEntries).find((m) => m.id === out.posted.entryId)!
    expect(post.author).toEqual({ kind: "bot", botId: out.ada.id })
    expect(post.addressedBotIds).toEqual([out.bob.id])
    expect(eventsOf(out.adaEntries)).toContainEqual({
      type: "posted-to-group",
      conversationId: out.group.id,
      title: "Launch",
      entryId: out.posted.entryId,
    })
    expect(out.turns.map((t) => t.botId)).toEqual([out.bob.id])
    expect(out.handles[0]!.input.text).toContain("[@Ada]: @Bob please review the draft")
    expect(out.notInGroup._tag).toBe("InvalidInput")
    expect(out.notAGroup._tag).toBe("InvalidInput")
  })

  test("in a group turn, message_bot / handoff_task to a member are noted (no duplicate post): a reply that @mentions them wakes them, else the text is posted; non-members get a DM", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const messaging = yield* Messaging
        const lead = yield* createBot("Lead")
        const claude = yield* createBot("Claude Engineer")
        const codex = yield* createBot("Codex")
        const chief = yield* createBot("Chief")
        const group = yield* (yield* ConversationService).createGroup({
          title: "secret project",
          memberBotIds: [lead.id, claude.id, codex.id],
        })
        const results = yield* Ref.make<ReadonlyArray<unknown>>([])
        yield* driver.setBehavior(lead.id, (turn) =>
          Effect.gen(function* () {
            // one tool call id per call (the ids are idempotency keys)
            const call = (callId: string) => ({ ...turn.tool, callId })
            const asked = yield* messaging.messageBot(call("c1"), {
              to: "Claude Engineer",
              text: "please build the tick parser",
              urgency: "urgent",
            })
            const handed = yield* messaging.handoffTask(call("c2"), {
              to: "@Codex",
              task: "Write the tests",
              context: "See tick.ts",
            })
            const outside = yield* messaging.messageBot(call("c3"), {
              to: "Chief",
              text: "FYI: started",
              urgency: "background",
            })
            yield* Ref.set(results, [asked, handed, outside])
            // The reply carries the message: it mentions Claude; Codex was only noted.
            yield* turn.say(
              `${turn.turnId}/m`,
              "@Claude Engineer please build the tick parser; Codex owns the tests (see tick.ts).",
            )
            yield* turn.complete()
          }).pipe(Effect.orDie),
        )
        yield* send(group.id, "@Lead kick off the tick project")
        yield* settled(group.id, 3)
        yield* passBotWakeDebounce
        yield* settled(chief.directConversationId)
        return {
          lead,
          claude,
          codex,
          chief,
          group,
          results: yield* Ref.get(results),
          groupEntries: yield* transcript(group.id),
          claudeDm: yield* transcript(claude.directConversationId),
          chiefDm: yield* transcript(chief.directConversationId),
          groupTurns: yield* turnsOf(group.id),
          handles: yield* driver.turns,
        }
      }),
      appLayer(),
    )
    const [asked, handed, outside] = out.results as ReadonlyArray<{
      conversationId: string
      postedInGroup?: boolean
      noted?: boolean
      entryId?: string
    }>
    expect(asked).toMatchObject({ conversationId: out.group.id, postedInGroup: true, noted: true })
    expect(asked!.entryId).toBeUndefined()
    expect(handed).toMatchObject({ conversationId: out.group.id, postedInGroup: true, noted: true })
    expect(outside!.conversationId).toBe(out.chief.directConversationId)
    expect(outside!.postedInGroup).toBeUndefined()

    // The reply addressed Claude: no separate post for it (no near-identical double). Codex was not
    // @mentioned in the reply, so its handoff is posted on its own.
    const posts = messagesOf(out.groupEntries).filter((m) => m.author.kind === "bot" && m.author.botId === out.lead.id)
    expect(posts.map((m) => m.text)).toEqual([
      "@Claude Engineer please build the tick parser; Codex owns the tests (see tick.ts).",
      "@Codex Task handed off to you:\nWrite the tests\n\nContext:\nSee tick.ts",
    ])
    // nothing leaked into the members' DMs; no "messaged" / "handoff" side-channel events
    expect(messagesOf(out.claudeDm).some((m) => m.author.kind === "bot")).toBe(false)
    const sideChannel = eventsOf(out.groupEntries).flatMap((e) =>
      e.type === "messaged-bot" || e.type === "handoff" ? [e.toBotId] : [],
    )
    expect(sideChannel).toEqual([out.chief.id]) // only the outsider got a DM ("Messaged @Chief" line)
    // both members ran in the GROUP, woken once each by the reply; the outsider in its DM
    const groupTurnBots = out.groupTurns.map((t) => t.botId)
    expect(groupTurnBots.filter((id) => id === out.claude.id)).toHaveLength(1)
    expect(groupTurnBots.filter((id) => id === out.codex.id)).toHaveLength(1)
    const claudeTurn = out.handles.find((h) => h.bot.id === out.claude.id)!
    expect(claudeTurn.conversationId).toBe(out.group.id)
    expect(claudeTurn.input.text).toStartWith(
      '[Group chat "secret project" · members: @Lead, @Claude Engineer (you), @Codex · your reply is posted here; @mention a teammate',
    )
    expect(claudeTurn.input.text).toContain(
      "[@Lead]: @Claude Engineer please build the tick parser; Codex owns the tests",
    )
    const codexTurn = out.handles.find((h) => h.bot.id === out.codex.id)!
    expect(codexTurn.input.text).toContain("[@Lead]: @Codex Task handed off to you:")
    expect(messagesOf(out.chiefDm).find((m) => m.toBotId === out.chief.id)?.text).toBe("FYI: started")
  })

  test("a group turn that ends without a reply (NO_REPLY) still delivers its noted message_bot texts, once", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const messaging = yield* Messaging
        const lead = yield* createBot("Lead")
        const bob = yield* createBot("Bob")
        const group = yield* (yield* ConversationService).createGroup({ title: "g", memberBotIds: [lead.id, bob.id] })
        yield* driver.setBehavior(lead.id, (turn) =>
          Effect.gen(function* () {
            yield* messaging.messageBot(
              { ...turn.tool, callId: "n1" },
              { to: "Bob", text: "check the logs", urgency: "urgent" },
            )
            yield* turn.say(`${turn.turnId}/m`, "NO_REPLY")
            yield* turn.complete()
          }).pipe(Effect.orDie),
        )
        yield* send(group.id, "@Lead anything?")
        yield* settled(group.id, 2)
        return { lead, bob, groupEntries: yield* transcript(group.id), handles: yield* driver.turns }
      }),
      appLayer(),
    )
    const botTexts = messagesOf(out.groupEntries)
      .filter((m) => m.author.kind === "bot")
      .map((m) => m.text)
    expect(botTexts).toEqual(["@Bob check the logs", "Reply from Bob"])
    expect(out.handles.map((h) => h.bot.name)).toEqual(["Lead", "Bob"])
  })

  test("regression: a lead delegating in a 3-bot group keeps everything in the group (no DM entries, one wake, one post)", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const messaging = yield* Messaging
        const lead = yield* createBot("Lead")
        const claude = yield* createBot("Claude Engineer")
        const codex = yield* createBot("Codex")
        const group = yield* (yield* ConversationService).createGroup({
          title: "tick",
          memberBotIds: [lead.id, claude.id, codex.id],
        })
        const dmsBefore = yield* Effect.forEach([lead, claude, codex], (b) => transcript(b.directConversationId))
        yield* driver.setBehavior(lead.id, (turn) =>
          Effect.gen(function* () {
            yield* messaging.messageBot(
              { ...turn.tool, callId: "d1" },
              { to: "Claude Engineer", text: "build the parser", urgency: "background" },
            )
            // the reply names the delegate again: it must not wake it a second time
            yield* turn.say(`${turn.turnId}/m`, "I asked @Claude Engineer to build the parser.")
            yield* turn.complete()
          }).pipe(Effect.orDie),
        )
        yield* driver.setBehavior(claude.id, (turn) =>
          Effect.gen(function* () {
            yield* turn.say(`${turn.turnId}/m`, "Parser done.")
            yield* turn.complete()
          }),
        )
        yield* send(group.id, "@Lead please get the parser built")
        yield* settled(group.id, 2)
        return {
          lead,
          claude,
          group,
          dmsBefore,
          dmsAfter: yield* Effect.forEach([lead, claude, codex], (b) => transcript(b.directConversationId)),
          groupEntries: yield* transcript(group.id),
          handles: yield* driver.turns,
        }
      }),
      appLayer(),
    )
    expect(out.dmsAfter.map((t) => t.length)).toEqual(out.dmsBefore.map((t) => t.length))
    expect(out.handles.map((h) => [h.bot.name, h.conversationId])).toEqual([
      ["Lead", out.group.id],
      ["Claude Engineer", out.group.id],
    ])
    const botTexts = messagesOf(out.groupEntries)
      .filter((m) => m.author.kind === "bot")
      .map((m) => m.text)
    expect(botTexts).toEqual(["I asked @Claude Engineer to build the parser.", "Parser done."])
  })

  test("handoff_task delivers the task urgently with a handoff event", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const messaging = yield* Messaging
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        yield* messaging.handoffTask(toolFor(ada, ada.directConversationId), {
          to: "Bob",
          task: "Write the release notes",
          context: "Version 1.2, see CHANGELOG.md",
        })
        yield* settled(bob.directConversationId)
        return { ada, bob, handles: yield* driver.turns, adaEntries: yield* transcript(ada.directConversationId) }
      }),
      appLayer(),
    )
    expect(out.handles[0]!.input.text).toBe(
      `${BOT_DM_HINT}\n` +
        "[Direct message from @Ada]: Task handed off to you:\nWrite the release notes\n\nContext:\nVersion 1.2, see CHANGELOG.md",
    )
    expect(eventsOf(out.adaEntries)).toContainEqual({
      type: "handoff",
      fromBotId: out.ada.id,
      toBotId: out.bob.id,
      toName: "Bob",
      task: "Write the release notes",
      conversationId: out.bob.directConversationId,
    })
  })
})

import { describe, expect, test } from "bun:test"
import type { KnownConversationStreamItem, KnownRosterStreamItem } from "@openbot/contracts"
import { Effect, Option } from "effect"
import { TestClock } from "effect/testing"
import { BotRepo, ConversationService, LiveHub, Orchestrator, sessionKeyOf } from "../../src/ports/index.ts"
import { NotifierFake, runTest, UsageServiceFake } from "../../src/testing/index.ts"
import {
  appLayer,
  collect,
  conversation,
  createBot,
  eventually,
  eventsOf,
  holdBehavior,
  messagesOf,
  send,
  settled,
  TestDriver,
  transcript,
  turnsOf,
} from "./helpers.ts"

describe("DM turn end to end", () => {
  test("user message → session open → streamed bot reply, revisions, turn, usage, activity", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const hub = yield* LiveHub
        const driver = yield* TestDriver
        const bot = yield* createBot("Ada", { instructions: "Be brief." })
        const dm = bot.directConversationId

        // Observe the conversation replica and the roster while the turn runs.
        const convItems = yield* collect(hub.subscribeConversation({ conversationId: dm }))
        const rosterItems = yield* collect(hub.subscribeRoster({}))

        const result = yield* send(dm, "Hello there")
        expect(result.disposition).toBe("started")
        expect(result.turnIds).toHaveLength(1)
        yield* settled(dm)

        const entries = yield* transcript(dm)
        const turns = yield* turnsOf(dm)
        const opened = yield* driver.opened
        const native = yield* Effect.orDie((yield* BotRepo).getSession(bot.id))
        const usage = yield* (yield* UsageServiceFake).recorded
        const notifications = yield* (yield* NotifierFake).sent
        const conv = yield* conversation(dm)
        return {
          bot,
          entries,
          turns,
          opened,
          native,
          usage,
          notifications,
          conv,
          convItems: yield* convItems.items,
          rosterItems: yield* rosterItems.items,
        }
      }),
      appLayer(),
    )

    // Transcript: joined event, the user message (delivered), the final bot reply.
    expect(out.entries.map((e) => e.kind)).toEqual(["event", "message", "message"])
    const [user, reply] = messagesOf(out.entries)
    expect(user!.role).toBe("user")
    expect(user!.delivery).toBe("delivered")
    expect(user!.text).toBe("Hello there")
    expect(reply!.role).toBe("bot")
    expect(reply!.author).toEqual({ kind: "bot", botId: out.bot.id })
    expect(reply!.text).toBe("Reply from Ada")
    expect(reply!.streaming).toBe(false)
    expect(reply!.aborted).toBeUndefined()
    expect(reply!.revision).toBeGreaterThanOrEqual(1)
    expect(reply!.turnId).toBe(out.turns[0]!.id)
    expect(reply!.harnessRef?.nativeId).toBe(`${out.turns[0]!.id}/msg`)

    // Turn record: completed with usage and the stop reason.
    expect(out.turns).toHaveLength(1)
    expect(out.turns[0]!.status).toBe("completed")
    expect(out.turns[0]!.trigger).toBe("user")
    expect(out.turns[0]!.inputEntryId).toBe(user!.id)
    expect(out.turns[0]!.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(out.turns[0]!.stopReason).toBe("end_turn")
    expect(out.usage).toHaveLength(1)

    // Session: opened once with the session key, instructions and an MCP binding; native id persisted.
    expect(out.opened).toHaveLength(1)
    expect(out.opened[0]!.sessionKey).toBe(sessionKeyOf(out.bot.id, out.bot.directConversationId))
    expect(out.opened[0]!.nativeSessionId).toBeUndefined()
    expect(out.opened[0]!.instructions.text).toContain("You are Ada")
    expect(out.opened[0]!.instructions.text).toContain("Be brief.")
    expect(out.opened[0]!.mcp).toHaveLength(1)
    expect(Option.getOrThrow(out.native).nativeSessionId).toBe("native-1")

    // Context ring on the conversation (D6.5) and a "finished" notification.
    expect(out.conv.sessions?.[0]).toMatchObject({ botId: out.bot.id, active: true, contextUsage: { usedTokens: 1_100 } })
    expect(out.notifications.map((n) => n.kind)).toEqual(["finished"])

    // The replica carried the user entry, the streamed upserts (increasing revisions) and the turn.
    const changes = out.convItems.flatMap((i: KnownConversationStreamItem) => (i.kind === "change" ? [i.change] : []))
    const replyRevisions = changes.flatMap((c) => (c.type === "entry.upserted" && c.entry.id === reply!.id ? [c.entry.revision] : []))
    expect(replyRevisions.length).toBeGreaterThanOrEqual(2)
    expect([...replyRevisions].sort((a, b) => a - b)).toEqual(replyRevisions)
    expect(changes.some((c) => c.type === "turn.upserted" && c.turn.status === "running")).toBe(true)

    // Activity: thinking → Typing… → idle.
    const states = out.rosterItems.flatMap((i: KnownRosterStreamItem) => (i.kind === "change" && i.change.type === "activity.updated" ? [i.change.activity] : []))
    expect(states[0]!.state).toBe("thinking")
    expect(states.some((a) => a.label === "Typing…")).toBe(true)
    expect(states[states.length - 1]!.state).toBe("idle")
  })

  test("duplicate clientNonce returns the first entry; lookupSend finds it", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const orchestrator = yield* Orchestrator
        const bot = yield* createBot("Ada")
        const first = yield* orchestrator.send({ conversationId: bot.directConversationId, text: "hi", clientNonce: "n-1" })
        const again = yield* orchestrator.send({ conversationId: bot.directConversationId, text: "hi", clientNonce: "n-1" })
        yield* settled(bot.directConversationId)
        const found = yield* orchestrator.lookupSend({ conversationId: bot.directConversationId, clientNonce: "n-1" })
        const missing = yield* orchestrator.lookupSend({ conversationId: bot.directConversationId, clientNonce: "n-2" })
        const empty = yield* Effect.flip(orchestrator.send({ conversationId: bot.directConversationId, text: "  ", clientNonce: "n-3" }))
        return { first, again, found, missing, empty, turns: yield* turnsOf(bot.directConversationId) }
      }),
      appLayer(),
    )
    expect(out.again).toEqual({ entryId: out.first.entryId, turnIds: [], disposition: "duplicate" })
    expect(out.found).toEqual({ outcome: "found", entryId: out.first.entryId, delivery: "delivered" })
    expect(out.missing).toEqual({ outcome: "not-found" })
    expect(out.empty._tag).toBe("InvalidInput")
    expect(out.turns).toHaveLength(1)
  })
})

describe("finished notifications", () => {
  test("a turn that ends without a message (NO_REPLY, a reaction, only steps) notifies nobody", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const bot = yield* createBot("Ada")
        yield* driver.setBehavior(bot.id, (turn) => turn.complete())
        yield* send(bot.directConversationId, "thanks!")
        yield* settled(bot.directConversationId)
        yield* driver.setBehavior(bot.id, (turn) => turn.say(`${turn.turnId}/m`, "Here it is.").pipe(Effect.andThen(turn.complete())))
        yield* send(bot.directConversationId, "and the report?")
        yield* settled(bot.directConversationId, 2)
        return (yield* (yield* NotifierFake).sent).filter((n) => n.kind === "finished")
      }),
      appLayer(),
    )
    expect(out.map((n) => n.body)).toEqual(["Here it is."])
  })
})

describe("a signed-out harness", () => {
  test("says so in plain words, notifies once for the account, and leaves the bot no note", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        for (const bot of [ada, bob]) {
          yield* driver.setBehavior(bot.id, (turn) => turn.fail("auth", "Failed to authenticate: OAuth session expired"))
        }
        yield* send(ada.directConversationId, "hi")
        yield* settled(ada.directConversationId)
        yield* send(bob.directConversationId, "hi")
        yield* settled(bob.directConversationId)
        // signed in again: the next turn carries no "ended early" note
        yield* driver.setBehavior(ada.id, (turn) => turn.say(`${turn.turnId}/m`, "Hello!").pipe(Effect.andThen(turn.complete())))
        yield* send(ada.directConversationId, "again")
        yield* settled(ada.directConversationId, 2)
        return {
          failure: (yield* turnsOf(ada.directConversationId)).find((t) => t.status === "failed")?.failure,
          errors: (yield* (yield* NotifierFake).sent).filter((n) => n.kind === "error"),
          inputs: (yield* driver.turns).map((t) => t.input.text),
        }
      }),
      appLayer(),
    )
    expect(out.failure).toMatchObject({ code: "auth" })
    expect(out.failure!.message).toContain("is signed out on the computer OpenBot runs on, so Ada can't reply")
    expect(out.failure!.message).toContain("(Failed to authenticate: OAuth session expired)")
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]!.title).toContain("is signed out")
    expect(out.inputs.at(-1)).not.toContain("[Note:")
  })
})

describe("queue vs steer", () => {
  test("auto steers into a running turn when the harness can; queue mode always queues", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const bot = yield* createBot("Ada")
        const dm = bot.directConversationId
        yield* driver.setBehavior(bot.id, holdBehavior)
        const first = yield* send(dm, "start")
        yield* eventually(Effect.map(driver.turns, (t) => t.length === 1), "turn 1 started")
        const steered = yield* send(dm, "also this")
        const queued = yield* send(dm, "later", { mode: "queue" })
        const queuedTurn = (yield* turnsOf(dm)).find((t) => t.id === queued.turnIds[0])
        yield* driver.release(bot.id)
        yield* settled(dm, 2)
        return {
          first,
          steered,
          queued,
          queuedTurn,
          steers: yield* driver.steers,
          turns: yield* turnsOf(dm),
          handles: yield* driver.turns,
          entries: yield* transcript(dm),
        }
      }),
      appLayer({ capabilities: { steer: true } }),
    )
    expect(out.first.disposition).toBe("started")
    expect(out.steered.disposition).toBe("steered")
    expect(out.steered.turnIds).toEqual(out.first.turnIds)
    expect(out.steers.map((s) => s.input.text.split("\n\n(Sent while")[0])).toEqual(["also this"])
    expect(out.steers[0]!.input.text).toContain("start_task")
    expect(out.queued.disposition).toBe("queued")
    expect(out.queuedTurn?.status).toBe("queued")
    // Two turns ran, in order; the queued one got its own turn and input.
    expect(out.turns.map((t) => t.status)).toEqual(["completed", "completed"])
    expect(out.handles.map((h) => h.input.text)).toEqual(["start", "later"])
    // The steered message was marked delivered.
    const steeredEntry = messagesOf(out.entries).find((m) => m.text === "also this")
    expect(steeredEntry?.delivery).toBe("delivered")
  })

  test("without steer support a busy bot queues auto sends (FIFO, one turn each)", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const bot = yield* createBot("Ada")
        const dm = bot.directConversationId
        yield* driver.setBehavior(bot.id, holdBehavior)
        yield* send(dm, "one")
        yield* eventually(Effect.map(driver.turns, (t) => t.length === 1), "turn 1 started")
        const second = yield* send(dm, "two")
        const third = yield* send(dm, "three", { mode: "steer" })
        yield* driver.release(bot.id)
        yield* settled(dm, 3)
        return { second, third, handles: yield* driver.turns, steers: yield* driver.steers }
      }),
      appLayer(),
    )
    expect(out.second.disposition).toBe("queued")
    expect(out.third.disposition).toBe("queued")
    expect(out.steers).toHaveLength(0)
    expect(out.handles.map((h) => h.input.text)).toEqual(["one", "two", "three"])
  })
})

describe("interrupts", () => {
  test("interrupting a running turn marks streaming bot text aborted and the turn interrupted", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const orchestrator = yield* Orchestrator
        const driver = yield* TestDriver
        const bot = yield* createBot("Ada")
        const dm = bot.directConversationId
        yield* driver.setBehavior(bot.id, holdBehavior)
        const sent = yield* send(dm, "long job")
        yield* eventually(
          Effect.map(transcript(dm), (entries) => messagesOf(entries).some((m) => m.role === "bot" && m.streaming)),
          "streaming reply",
        )
        const affected = yield* orchestrator.interrupt({ conversationId: dm })
        yield* settled(dm)
        return { sent, affected, turns: yield* turnsOf(dm), entries: yield* transcript(dm) }
      }),
      appLayer(),
    )
    expect(out.affected.map((t) => t.id)).toEqual([...out.sent.turnIds])
    expect(out.turns[0]!.status).toBe("interrupted")
    const reply = messagesOf(out.entries).find((m) => m.role === "bot")!
    expect(reply.text).toBe("Working on it")
    expect(reply.streaming).toBe(false)
    expect(reply.aborted).toBe(true)
  })

  test("interrupting a queued turn by id drops it; the running turn continues", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const orchestrator = yield* Orchestrator
        const driver = yield* TestDriver
        const bot = yield* createBot("Ada")
        const dm = bot.directConversationId
        yield* driver.setBehavior(bot.id, holdBehavior)
        yield* send(dm, "one")
        yield* eventually(Effect.map(driver.turns, (t) => t.length === 1), "turn 1 started")
        const queued = yield* send(dm, "two")
        const affected = yield* orchestrator.interrupt({ conversationId: dm, turnId: queued.turnIds[0] })
        yield* driver.release(bot.id)
        yield* settled(dm, 2)
        return { affected, turns: yield* turnsOf(dm), handles: yield* driver.turns }
      }),
      appLayer(),
    )
    expect(out.affected.map((t) => t.status)).toEqual(["interrupted"])
    expect(out.turns.map((t) => t.status).sort()).toEqual(["completed", "interrupted"])
    expect(out.handles).toHaveLength(1)
  })
})

describe("retry", () => {
  test("a failed turn's bot answers the same message again; nothing new is posted", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const orchestrator = yield* Orchestrator
        const driver = yield* TestDriver
        const bot = yield* createBot("Ada")
        const dm = bot.directConversationId
        yield* driver.setBehavior(bot.id, (turn) => turn.crash("harness died"))
        yield* send(dm, "fix the render")
        yield* settled(dm)
        const [failed] = yield* turnsOf(dm)
        yield* driver.setBehavior(bot.id, (turn) => turn.say(`${turn.turnId}/m`, "on it").pipe(Effect.andThen(turn.complete())))
        yield* orchestrator.retry({ conversationId: dm, turnId: failed!.id })
        yield* settled(dm, 2)
        const completed = yield* Effect.flip(orchestrator.retry({ conversationId: dm, turnId: (yield* turnsOf(dm))[1]!.id }))
        return { failed: failed!, turns: yield* turnsOf(dm), handles: yield* driver.turns, entries: yield* transcript(dm), completed }
      }),
      appLayer(),
    )
    const userMessages = messagesOf(out.entries).filter((m) => m.role === "user")
    expect(userMessages.map((m) => m.text)).toEqual(["fix the render"])
    expect(out.failed.sourceEntryIds).toEqual([userMessages[0]!.id])
    expect(out.turns.map((t) => t.status)).toEqual(["failed", "completed"])
    expect(out.handles.at(-1)!.input.text).toContain("fix the render")
    expect(out.completed._tag).toBe("InvalidInput")
  })
})

describe("idle compaction", () => {
  /** One finished turn (context 1 100 tokens), then idle time passes. */
  const idleFor = (minutes: number, options: { readonly minTokens: number; readonly enabled?: boolean }) =>
    runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const bot = yield* createBot("Ada")
        const dm = bot.directConversationId
        yield* send(dm, "hi")
        yield* settled(dm)
        yield* TestClock.adjust(`${minutes} minutes`)
        for (let i = 0; i < 200; i++) yield* Effect.yieldNow
        return { compactions: yield* driver.compactions, entries: yield* transcript(dm), conv: yield* conversation(dm) }
      }),
      appLayer({
        capabilities: { compact: true },
        runner: { idleCompactMinTokens: options.minTokens },
        ...(options.enabled === false ? { settings: { compactIdleBots: false } } : {}),
      }),
    )

  test("a large context is compacted once after 10 idle minutes, before the session closes", async () => {
    const early = await idleFor(9, { minTokens: 1_000 })
    expect(early.compactions).toBe(0)
    const out = await idleFor(11, { minTokens: 1_000 })
    expect(out.compactions).toBe(1)
    expect(eventsOf(out.entries).filter((e) => e.type === "session-changed" && e.action === "compacted")).toHaveLength(1)
    expect(out.conv.sessions?.[0]?.contextUsage?.usedTokens).toBe(500)
    const later = await idleFor(20, { minTokens: 1_000 })
    expect(later.compactions).toBe(1)
  })

  test("a small context, or the setting off, is left alone", async () => {
    expect((await idleFor(11, { minTokens: 5_000 })).compactions).toBe(0)
    expect((await idleFor(11, { minTokens: 1_000, enabled: false })).compactions).toBe(0)
  })
})

describe("session lifecycle", () => {
  test("after SessionClosed the next turn reopens the session with resume", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const bot = yield* createBot("Ada")
        const dm = bot.directConversationId
        yield* driver.setBehavior(bot.id, (turn) => turn.crash("harness died"))
        yield* send(dm, "first")
        yield* settled(dm)
        const afterCrash = yield* turnsOf(dm)
        yield* driver.setBehavior(bot.id, (turn) => turn.say(`${turn.turnId}/m`, "back").pipe(Effect.andThen(turn.complete())))
        yield* send(dm, "second")
        yield* settled(dm, 2)
        return { afterCrash, turns: yield* turnsOf(dm), opened: yield* driver.opened, entries: yield* transcript(dm) }
      }),
      appLayer(),
    )
    expect(out.afterCrash[0]!.status).toBe("failed")
    expect(out.afterCrash[0]!.failure).toMatchObject({ code: "crashed", retryable: true })
    expect(out.turns.map((t) => t.status)).toEqual(["failed", "completed"])
    // Opened twice: fresh, then resuming the native session bound by the first one.
    expect(out.opened.map((o) => o.nativeSessionId)).toEqual([undefined, "native-1"])
    const notices = out.entries.flatMap((e) => (e.kind === "notice" ? [e] : []))
    expect(notices).toHaveLength(1)
    expect(notices[0]!.level).toBe("error")
    expect(messagesOf(out.entries).at(-1)?.text).toBe("back")
  })

  test("New session: Conflict while busy, then forgets the native session, new epoch and event", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const orchestrator = yield* Orchestrator
        const driver = yield* TestDriver
        const bots = yield* BotRepo
        const bot = yield* createBot("Ada")
        const dm = bot.directConversationId
        yield* driver.setBehavior(bot.id, holdBehavior)
        yield* send(dm, "one")
        yield* eventually(Effect.map(driver.turns, (t) => t.length === 1), "turn started")
        const busy = yield* Effect.flip(orchestrator.newSession({ botId: bot.id }))
        yield* driver.release(bot.id)
        yield* settled(dm)
        const epochBefore = (yield* conversation(dm)).epoch
        yield* orchestrator.newSession({ botId: bot.id })
        const native = yield* Effect.orDie(bots.getSession(bot.id))
        const after = yield* conversation(dm)
        yield* send(dm, "two")
        yield* settled(dm, 2)
        return { busy, epochBefore, native, after, opened: yield* driver.opened, entries: yield* transcript(dm) }
      }),
      appLayer(),
    )
    expect(out.busy._tag).toBe("Conflict")
    expect(Option.isNone(out.native)).toBe(true)
    expect(out.after.epoch).not.toBe(out.epochBefore)
    expect(out.after.sessions?.find((s) => s.botId)?.active).toBe(false)
    expect(eventsOf(out.entries).some((e) => e.type === "session-changed" && e.action === "new-session")).toBe(true)
    // The next turn opened a fresh session (no resume id).
    expect(out.opened.map((o) => o.nativeSessionId)).toEqual([undefined, undefined])
  })

  test("Compact needs the capability and appends a session-changed event", async () => {
    const unsupported = await runTest(
      Effect.gen(function*() {
        const bot = yield* createBot("Ada")
        return yield* Effect.flip((yield* Orchestrator).compact({ botId: bot.id }))
      }),
      appLayer(),
    )
    expect(unsupported._tag).toBe("HarnessUnavailable")

    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const bot = yield* createBot("Ada")
        yield* driver.setBehavior(bot.id, (turn) => turn.say(`${turn.turnId}/m`, "Hello there.").pipe(Effect.andThen(turn.complete())))
        yield* send(bot.directConversationId, "hi")
        yield* settled(bot.directConversationId)
        const before = yield* conversation(bot.directConversationId)
        yield* TestClock.adjust("5 minutes")
        yield* (yield* Orchestrator).compact({ botId: bot.id })
        return {
          compactions: yield* driver.compactions,
          entries: yield* transcript(bot.directConversationId),
          before,
          conv: yield* conversation(bot.directConversationId),
          summary: yield* Effect.flatMap(ConversationService, (c) => c.summary(bot.directConversationId)),
        }
      }),
      appLayer({ capabilities: { compact: true } }),
    )
    expect(out.compactions).toBe(1)
    expect(eventsOf(out.entries).some((e) => e.type === "session-changed" && e.action === "compacted")).toBe(true)
    expect(out.conv.sessions?.[0]?.contextUsage?.usedTokens).toBe(500)
    // housekeeping: the chat neither moves nor shows it as its preview
    expect(out.conv.lastActivityAt).toBe(out.before.lastActivityAt)
    expect(out.summary.preview).toBe("Hello there.")
  })
})

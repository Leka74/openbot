import { describe, expect, test } from "bun:test"
import type { MemoryFactId } from "@openbot/contracts"
import { MEMORY_INDEX_PROMPT_CAP_BYTES } from "@openbot/contracts"
import { Effect, Exit, Fiber, Layer, Stream } from "effect"
import {
  BotRepo,
  botActor,
  inProfile,
  MemoryService,
  MemoryStore,
  SettingsRepo,
  SettingsService,
  UsageService,
  userActor,
} from "../../src/ports/index.ts"
import { MemoryServiceLive, SettingsServiceLive, UsageServiceLive } from "../../src/services/automation/index.ts"
import {
  botId,
  ConversationServiceFake,
  makeBot,
  OTHER_PROFILE,
  LiveHubFake,
  makeClaims,
  runTest,
  setTime,
  turnId,
} from "../../src/testing/index.ts"
import { BOT_A, BOT_B, baseLayer, DM_A, GROUP, seed } from "./helpers.ts"

const failsWith = (exit: Exit.Exit<unknown, unknown>, tag: string) =>
  Exit.isFailure(exit) && JSON.stringify(exit.cause).includes(tag)

describe("MemoryService", () => {
  const layer = () => MemoryServiceLive.pipe(Layer.provideMerge(baseLayer()))
  const asBotA = botActor({ claims: makeClaims({ botId: BOT_A.id, conversationId: GROUP.id }) })

  test("fact CRUD keeps MEMORY.md in sync and bot changes emit memory-updated events", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const memory = yield* MemoryService
        const store = yield* MemoryStore
        yield* memory.setIndex(BOT_A.id, "# Ada's memory\n")
        const fact = yield* memory.putFact(asBotA, BOT_A.id, {
          title: "Prefers dark mode",
          description: "UI preference",
          body: "The owner likes dark themes.",
        })
        const afterPut = yield* store.readIndex(BOT_A.id)
        yield* memory.putFact(asBotA, BOT_A.id, {
          id: fact.id,
          title: "Prefers dark mode",
          description: "Confirmed twice",
          body: "x",
        })
        const userFact = yield* memory.putFact(userActor, BOT_A.id, { title: "Timezone", body: "Europe/Berlin" })
        const afterUpdate = yield* memory.get(BOT_A.id)
        const recalled = yield* memory.recall(BOT_A.id, "BERLIN")
        yield* memory.deleteFact(asBotA, BOT_A.id, fact.id)
        const afterDelete = yield* memory.get(BOT_A.id)
        const written = yield* (yield* ConversationServiceFake).written
        return { fact, userFact, afterPut, afterUpdate, recalled, afterDelete, written }
      }),
      layer(),
    )
    expect(out.fact).toMatchObject({
      id: "prefers-dark-mode",
      title: "Prefers dark mode",
      body: "The owner likes dark themes.",
    })
    expect(out.afterPut).toBe("# Ada's memory\n- [Prefers dark mode](prefers-dark-mode.md) — UI preference\n")
    expect(out.afterUpdate.index).toBe(
      "# Ada's memory\n- [Prefers dark mode](prefers-dark-mode.md) — Confirmed twice\n- [Timezone](timezone.md)\n",
    )
    expect(out.afterUpdate.facts.map((f) => f.id)).toEqual(["prefers-dark-mode", "timezone"] as Array<MemoryFactId>)
    expect(out.recalled.map((f) => f.id)).toEqual([out.userFact.id])
    expect(out.afterDelete.index).toBe("# Ada's memory\n- [Timezone](timezone.md)\n")
    expect(out.afterDelete.facts.map((f) => f.id)).toEqual([out.userFact.id])
    const events = out.written.flatMap((e) => (e.kind === "event" && e.event.type === "memory-updated" ? [e] : []))
    // Only bot actors produce events; user edits (details pane) do not.
    expect(events.map((e) => e.kind === "event" && e.event.type === "memory-updated" && e.event.action)).toEqual([
      "remembered",
      "edited",
      "forgot",
    ])
    expect(events[0]).toMatchObject({ conversationId: GROUP.id, author: { kind: "bot", botId: BOT_A.id } })
  })

  test("refusals: unknown bot, another bot's memory, invalid input, missing fact", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const memory = yield* MemoryService
        return {
          unknownBot: yield* Effect.exit(memory.get(botId("bot_missing"))),
          otherBot: yield* Effect.exit(memory.putFact(asBotA, BOT_B.id, { title: "x", body: "y" })),
          blank: yield* Effect.exit(memory.putFact(userActor, BOT_A.id, { title: "   ", body: "y" })),
          badId: yield* Effect.exit(
            memory.putFact(userActor, BOT_A.id, { id: "Not A Slug" as MemoryFactId, title: "x", body: "y" }),
          ),
          missing: yield* Effect.exit(memory.deleteFact(userActor, BOT_A.id, "nope" as MemoryFactId)),
        }
      }),
      layer(),
    )
    expect(failsWith(out.unknownBot, "NotFound")).toBe(true)
    expect(failsWith(out.otherBot, "InvalidInput")).toBe(true)
    expect(failsWith(out.blank, "InvalidInput")).toBe(true)
    expect(failsWith(out.badId, "InvalidInput")).toBe(true)
    expect(failsWith(out.missing, "NotFound")).toBe(true)
  })

  test("promptIndex caps MEMORY.md at 4 KB", async () => {
    const index = await runTest(
      Effect.gen(function* () {
        yield* seed
        const memory = yield* MemoryService
        yield* memory.setIndex(BOT_A.id, "é".repeat(5000))
        return yield* memory.promptIndex(BOT_A.id)
      }),
      layer(),
    )
    expect(new TextEncoder().encode(index).length).toBeLessThanOrEqual(MEMORY_INDEX_PROMPT_CAP_BYTES)
    expect(index.length).toBe(MEMORY_INDEX_PROMPT_CAP_BYTES / 2)
  })
})

describe("SettingsService", () => {
  const layer = () => SettingsServiceLive.pipe(Layer.provideMerge(baseLayer()))

  test("update persists one key per field, publishes settings.updated and streams changes", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const repo = yield* SettingsRepo
        yield* repo.set("theme", "dark")
        // Built after seeding so the initial value is read from the repo.
        return yield* Effect.gen(function* () {
          const settings = yield* SettingsService
          const initial = yield* settings.get
          const changes = yield* Stream.runCollect(Stream.take(settings.changes, 2)).pipe(
            Effect.forkChild({ startImmediately: true }),
          )
          const updated = yield* settings.update({ approvalExpiryMinutes: 3, defaultHarness: "codex" })
          const cleared = yield* settings.update({ defaultHarness: null })
          const invalid = yield* Effect.exit(settings.update({ approvalExpiryMinutes: 0 }))
          return {
            initial,
            updated,
            cleared,
            invalid,
            stored: yield* repo.getAll,
            streamed: yield* Fiber.join(changes),
            roster: yield* (yield* LiveHubFake).rosterChanges,
          }
        }).pipe(Effect.provide(SettingsServiceLive))
      }),
      baseLayer(),
    )
    expect(out.initial).toMatchObject({ theme: "dark", approvalExpiryMinutes: 10, botMessaging: true })
    expect(out.updated).toMatchObject({ theme: "dark", approvalExpiryMinutes: 3, defaultHarness: "codex" })
    expect(out.cleared.defaultHarness).toBeUndefined()
    expect(failsWith(out.invalid, "InvalidInput")).toBe(true)
    expect(out.stored.get("approvalExpiryMinutes")).toBe(3)
    expect(out.stored.has("defaultHarness")).toBe(false)
    expect(out.streamed.map((s) => s.approvalExpiryMinutes)).toEqual([10, 3])
    expect(out.roster.map((c) => c.type)).toEqual(["settings.updated", "settings.updated"])
  })

  test("rules CRUD: ids and createdAt allocated, updates keep createdAt, bot scope validated", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        yield* setTime(1000)
        const settings = yield* SettingsService
        const global = yield* settings.upsertRule({
          surface: "shell",
          match: { commandPrefix: "git status" },
          action: "allow",
        })
        yield* setTime(2000)
        const scoped = yield* settings.upsertRule({ botId: BOT_A.id, surface: "file-edit", match: {}, action: "ask" })
        const edited = yield* settings.upsertRule({
          id: global.id,
          surface: "shell",
          match: { commandPrefix: "git" },
          action: "deny",
        })
        const forB = yield* settings.listRules({ botId: BOT_B.id })
        const forA = yield* settings.listRules({ botId: BOT_A.id })
        const unknownBot = yield* Effect.exit(
          settings.upsertRule({ botId: botId("bot_x"), surface: "shell", match: {}, action: "deny" }),
        )
        const blank = yield* Effect.exit(
          settings.upsertRule({ surface: "shell", match: { commandPrefix: "  " }, action: "deny" }),
        )
        yield* settings.deleteRule(scoped.id)
        const deleteAgain = yield* Effect.exit(settings.deleteRule(scoped.id))
        return {
          global,
          scoped,
          edited,
          forA,
          forB,
          unknownBot,
          blank,
          deleteAgain,
          all: yield* settings.listRules({}),
        }
      }),
      layer(),
    )
    expect(out.global).toMatchObject({ createdAt: 1000, origin: "user", action: "allow" })
    expect(out.global.id).toMatch(/^rul_/)
    expect(out.edited).toMatchObject({
      id: out.global.id,
      createdAt: 1000,
      action: "deny",
      match: { commandPrefix: "git" },
    })
    expect(out.forB.map((r) => r.id)).toEqual([out.global.id])
    expect(out.forA.map((r) => r.id).sort()).toEqual([out.global.id, out.scoped.id].sort())
    expect(failsWith(out.unknownBot, "NotFound")).toBe(true)
    expect(failsWith(out.blank, "InvalidInput")).toBe(true)
    expect(failsWith(out.deleteAgain, "NotFound")).toBe(true)
    expect(out.all.map((r) => r.id)).toEqual([out.global.id])
  })
})

describe("UsageService", () => {
  test("records usage and aggregates per bot (turn count, since filter)", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const usage = yield* UsageService
        const base = { conversationId: DM_A.id, harness: "fake" }
        yield* setTime(100)
        yield* usage.record({
          ...base,
          botId: BOT_A.id,
          turnId: turnId("trn_1"),
          usage: { inputTokens: 10, outputTokens: 5 },
        })
        yield* setTime(200)
        yield* usage.record({
          ...base,
          botId: BOT_A.id,
          turnId: turnId("trn_1"),
          usage: { inputTokens: 1, outputTokens: 1 },
        })
        yield* usage.record({
          ...base,
          botId: BOT_A.id,
          turnId: turnId("trn_2"),
          usage: { inputTokens: 2, outputTokens: 2 },
        })
        yield* usage.record({ ...base, botId: BOT_B.id, usage: { inputTokens: 7, outputTokens: 0 } })
        const other = makeBot({ id: botId("bot_other"), ownerProfileId: OTHER_PROFILE })
        yield* (yield* BotRepo).upsert(other)
        yield* usage.record({ ...base, botId: other.id, usage: { inputTokens: 99, outputTokens: 0 } })
        return {
          all: yield* usage.byBot({}),
          since: yield* usage.byBot({ sinceMs: 150 }),
          other: yield* inProfile(OTHER_PROFILE)(usage.byBot({})),
        }
      }),
      UsageServiceLive.pipe(Layer.provideMerge(baseLayer())),
    )
    const a = out.all.find((u) => u.botId === BOT_A.id)
    expect(a).toMatchObject({ usage: { inputTokens: 13, outputTokens: 8 }, turnCount: 2, lastAt: 200 })
    expect(out.all.find((u) => u.botId === BOT_B.id)).toMatchObject({ usage: { inputTokens: 7 }, turnCount: 0 })
    expect(out.all.map((u) => u.botId)).not.toContain(botId("bot_other"))
    expect(out.other.map((u) => u.botId)).toEqual([botId("bot_other")])
    expect(out.since.find((u) => u.botId === BOT_A.id)).toMatchObject({
      usage: { inputTokens: 3, outputTokens: 3 },
      turnCount: 2,
    })
  })
})

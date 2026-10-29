// Deleting a profile while its Bots work: they stop first, nothing of the profile starts again,
// switching to it is refused, and what it held is gone.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { type Bot, MAIN_PROFILE_ID } from "@openbot/contracts"
import {
  BotRepo,
  ConversationService,
  EntryRepo,
  HeldNotificationRepo,
  inProfile,
  Notifier,
  Orchestrator,
  ProfileRemoval,
  TurnRepo,
} from "@openbot/core"
import { Effect, Exit, Fiber } from "effect"
import { login, type OpenBotClient, rpcClient, startServer, type TestServer } from "./helpers.ts"
import { callTool, connectBot } from "./profile-isolation-helpers.ts"

let server: TestServer
let cookie: string
beforeEach(async () => {
  server = await startServer()
  cookie = await login(server.base, server.ownerToken)
}, 30_000)
afterEach(async () => {
  await server?.close()
}, 30_000)

const connect = () => rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })

/** A profile with Bots [slow, other]; the first one's DM is padded so deleting it takes a while. */
const seed = (client: OpenBotClient, padding: number) =>
  Effect.gen(function* () {
    const profile = yield* client["profiles.create"]({ name: "Doomed" })
    yield* client["profiles.switch"]({ profileId: profile.id })
    const make = (name: string) =>
      client["bots.create"]({ name, harness: { kind: "fake" }, clientNonce: name, introduce: false })
    const slow = yield* make("Slow")
    const other = yield* make("Other")
    const conversations = yield* ConversationService
    for (let i = 0; i < padding; i++) {
      yield* conversations
        .appendEvent({
          conversationId: slow.directConversationId,
          event: { type: "joined", botId: slow.id, name: `${i}` },
        })
        .pipe(Effect.orDie, inProfile(profile.id))
    }
    yield* client["profiles.switch"]({ profileId: MAIN_PROFILE_ID })
    return { profileId: profile.id, slow, other }
  })

/** Waits until the removal is deleting `bot`'s DM (its newest entry changed). */
const deletingDmOf = (bot: Bot) =>
  Effect.gen(function* () {
    const entries = yield* EntryRepo
    const newest = (yield* Effect.orDie(entries.page({ conversationId: bot.directConversationId, limit: 1 })))
      .entries[0]?.id
    for (let i = 0; i < 20_000; i++) {
      const now = (yield* Effect.orDie(entries.page({ conversationId: bot.directConversationId, limit: 1 }))).entries[0]
        ?.id
      if (now !== newest) return true
      yield* Effect.sleep("1 millis")
    }
    return false
  })

describe("profiles.delete while the profile's Bots work", () => {
  test(
    "its held notifications go with it",
    () =>
      server.run(
        Effect.gen(function* () {
          const client = yield* connect()
          const { profileId, other } = yield* seed(client, 0)
          yield* (yield* Notifier).notify({ kind: "waiting", botId: other.id, title: "x", body: "Approve?" })
          yield* client["profiles.delete"]({ profileId })
          const summary = yield* Effect.orDie((yield* HeldNotificationRepo).summary(profileId))
          expect(summary.items).toEqual([])
        }),
      ),
    30_000,
  )

  test(
    "a Bot of the profile can no longer create a teammate once the delete started",
    () =>
      server.run(
        Effect.gen(function* () {
          const client = yield* connect()
          const { profileId, slow, other } = yield* seed(client, 1500)
          const otherMcp = yield* connectBot(other)
          const removal = yield* Effect.forkScoped(
            (yield* ProfileRemoval).remove(profileId).pipe(inProfile(MAIN_PROFILE_ID)),
            { startImmediately: true },
          )
          expect(yield* deletingDmOf(slow)).toBe(true)
          yield* Effect.exit(callTool(otherMcp, "create_bot", { name: "Ghost", harness: "fake" }))
          expect(Exit.isSuccess(yield* Fiber.await(removal))).toBe(true)
          const left = (yield* Effect.orDie((yield* BotRepo).list)).filter((bot) => bot.ownerProfileId === profileId)
          expect(left).toEqual([])
        }),
      ),
    60_000,
  )

  test(
    "switching to the profile mid-delete is refused; the delete finishes",
    () =>
      server.run(
        Effect.gen(function* () {
          const client = yield* connect()
          const { profileId, slow } = yield* seed(client, 1500)
          const removal = yield* Effect.forkScoped(client["profiles.delete"]({ profileId }), { startImmediately: true })
          expect(yield* deletingDmOf(slow)).toBe(true)
          const switched = yield* Effect.exit(client["profiles.switch"]({ profileId }))
          expect(Exit.isFailure(switched) && JSON.stringify(switched.cause).includes("NotFound")).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.await(removal))).toBe(true)
          const view = yield* client["profiles.list"]()
          expect(view.activeId).toBe(MAIN_PROFILE_ID)
          expect(view.profiles.map((p) => p.id)).not.toContain(profileId)
        }),
      ),
    60_000,
  )

  test(
    "a teammate's message to a Bot being deleted starts nothing that outlives the delete",
    () =>
      server.run(
        Effect.gen(function* () {
          const client = yield* connect()
          const { profileId, slow, other } = yield* seed(client, 1500)
          const otherMcp = yield* connectBot(other)
          const removal = yield* Effect.forkScoped(
            (yield* ProfileRemoval).remove(profileId).pipe(inProfile(MAIN_PROFILE_ID)),
            { startImmediately: true },
          )
          expect(yield* deletingDmOf(slow)).toBe(true)
          yield* Effect.exit(
            callTool(otherMcp, "message_bot", { to: "Slow", text: "slow: still talking", urgency: "urgent" }),
          )
          expect(Exit.isSuccess(yield* Fiber.await(removal))).toBe(true)
          expect((yield* (yield* Orchestrator).activeTurn(slow.id))._tag).toBe("None")
          const active = (yield* Effect.orDie((yield* TurnRepo).listActive)).filter((turn) => turn.botId === slow.id)
          expect(active).toEqual([])
          const entries = yield* Effect.orDie(
            (yield* EntryRepo).page({ conversationId: slow.directConversationId, limit: 10 }),
          )
          expect(entries.entries).toEqual([])
        }),
      ),
    60_000,
  )
})

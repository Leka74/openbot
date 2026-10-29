// Owner profiles over `/rpc`: the owner creates and switches profiles, every app follows the switch,
// and what the owner creates lands in the profile the apps show.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  applyRosterStreamItem,
  emptyRosterState,
  MAIN_PROFILE_ID,
  type OwnerProfileId,
  type RosterState,
} from "@openbot/contracts"
import { BotRepo, ConversationRepo, Notifier, SectionRepo } from "@openbot/core"
import { Effect, Exit, Fiber, Option, Ref, Stream } from "effect"
import {
  eventually,
  login,
  type OpenBotClient,
  rpcClient,
  startServer,
  type TestServer,
  watchConversation,
} from "./helpers.ts"

let server: TestServer
let cookie: string

beforeAll(async () => {
  server = await startServer()
  cookie = await login(server.base, server.ownerToken)
}, 30_000)

afterAll(async () => {
  await server?.close()
}, 30_000)

const connect = (): Effect.Effect<OpenBotClient, never, import("effect").Scope.Scope> =>
  rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })

describe("owner profiles over /rpc", () => {
  test("a switch made in one app reaches the others; new Bots land in the active profile", async () => {
    await server.run(
      Effect.gen(function* () {
        const client = yield* connect()
        const other = yield* connect()
        expect((yield* client["profiles.list"]()).activeId).toBe(MAIN_PROFILE_ID)
        const followed = yield* Effect.forkScoped(Stream.runCollect(Stream.take(other["profiles.subscribe"](), 3)), {
          startImmediately: true,
        })

        const demo = yield* client["profiles.create"]({ name: "Demo" })
        yield* client["profiles.switch"]({ profileId: demo.id })
        const bot = yield* client["bots.create"]({
          name: "Presenter",
          harness: { kind: "fake" },
          clientNonce: "profiles-bot",
          introduce: false,
        })
        const section = yield* client["sections.create"]({ name: "Demo work" })

        const views = yield* Fiber.join(followed)
        expect(views.map((v) => v.activeId)).toEqual([MAIN_PROFILE_ID, MAIN_PROFILE_ID, demo.id])
        expect(bot.ownerProfileId).toBe(demo.id)
        expect(section.ownerProfileId).toBe(demo.id)

        const renamed = yield* client["profiles.rename"]({ profileId: demo.id, name: "Demo day" })
        expect(renamed.name).toBe("Demo day")
        const missing = yield* Effect.exit(client["profiles.switch"]({ profileId: "prf_nope" as OwnerProfileId }))
        expect(Exit.isFailure(missing) && JSON.stringify(missing.cause).includes("NotFound")).toBe(true)

        yield* client["profiles.switch"]({ profileId: MAIN_PROFILE_ID })
        expect((yield* other["profiles.list"]()).activeId).toBe(MAIN_PROFILE_ID)
      }),
    )
  }, 30_000)

  test("after a switch every app shows only the active profile; what is named from another is not found", async () => {
    await server.run(
      Effect.gen(function* () {
        const client = yield* connect()
        const roster = yield* Ref.make<RosterState>(emptyRosterState)
        yield* client["roster.subscribe"]({}).pipe(
          Stream.runForEach((item) => Ref.update(roster, (state) => applyRosterStreamItem(state, item))),
          Effect.forkScoped,
        )
        const mainBot = yield* client["bots.create"]({
          name: "Private",
          harness: { kind: "fake" },
          clientNonce: "main-private",
          introduce: false,
        })
        yield* eventually(Ref.get(roster), (state) => state.bots.has(mainBot.id), { label: "main bot shown" })
        const chat = yield* watchConversation(client, mainBot.directConversationId)

        const demo = yield* client["profiles.create"]({ name: "Stage" })
        yield* client["profiles.switch"]({ profileId: demo.id })
        const shown = yield* eventually(Ref.get(roster), (state) => state.synchronized && !state.bots.has(mainBot.id), {
          label: "main bot hidden",
        })
        expect([...shown.conversations.keys()]).not.toContain(mainBot.directConversationId)
        expect(Exit.isFailure(yield* Fiber.await(chat.fiber))).toBe(true)

        const notFound = (exit: Exit.Exit<unknown, unknown>) =>
          Exit.isFailure(exit) && JSON.stringify(exit.cause).includes("NotFound")
        expect(notFound(yield* Effect.exit(client["bots.get"]({ botId: mainBot.id })))).toBe(true)
        expect(notFound(yield* Effect.exit(client["memory.get"]({ botId: mainBot.id })))).toBe(true)
        expect(
          notFound(
            yield* Effect.exit(
              client["messages.send"]({
                conversationId: mainBot.directConversationId,
                text: "hello",
                clientNonce: "cross",
              }),
            ),
          ),
        ).toBe(true)
        const info = yield* client["session.info"]()
        expect(info.firstRun).toBe(true)
        // nothing set in this profile: not the computer's user name the main profile shows
        expect(info.ownerName).toBe("You")

        yield* client["profiles.switch"]({ profileId: MAIN_PROFILE_ID })
        yield* eventually(Ref.get(roster), (state) => state.bots.has(mainBot.id), { label: "main bot back" })
      }),
    )
  }, 30_000)

  test("a profile's notifications while another is active wait in its away list until dismissed", async () => {
    await server.run(
      Effect.gen(function* () {
        const client = yield* connect()
        const notifier = yield* Notifier
        const away = yield* client["profiles.create"]({ name: "Away" })
        yield* client["profiles.switch"]({ profileId: away.id })
        const bot = yield* client["bots.create"]({
          name: "Night shift",
          harness: { kind: "fake" },
          clientNonce: "away-bot",
          introduce: false,
        })
        yield* client["profiles.switch"]({ profileId: MAIN_PROFILE_ID })
        const held = yield* notifier.notify({ kind: "waiting", botId: bot.id, title: bot.name, body: "Approve?" })
        expect((yield* client["profiles.away"]()).items).toEqual([])

        yield* client["profiles.switch"]({ profileId: away.id })
        const summary = yield* client["profiles.away"]()
        expect(summary.items).toEqual([{ notification: held!, needsYou: true, botName: "Night shift" }])
        expect(summary.since).toBeNumber()
        expect((yield* client["profiles.dismissAway"]({ through: held!.id })).items).toEqual([])
        yield* client["profiles.switch"]({ profileId: MAIN_PROFILE_ID })
      }),
    )
  }, 30_000)

  test("deleting a profile removes its Bots and chats; never the main or the active one", async () => {
    await server.run(
      Effect.gen(function* () {
        const client = yield* connect()
        const forbidden = (exit: Exit.Exit<unknown, unknown>) =>
          Exit.isFailure(exit) && JSON.stringify(exit.cause).includes("Forbidden")
        const doomed = yield* client["profiles.create"]({ name: "Doomed" })
        yield* client["profiles.switch"]({ profileId: doomed.id })
        const bot = yield* client["bots.create"]({
          name: "Temp",
          harness: { kind: "fake" },
          clientNonce: "doomed-bot",
          introduce: false,
        })
        yield* client["sections.create"]({ name: "Temp work" })
        expect(forbidden(yield* Effect.exit(client["profiles.delete"]({ profileId: doomed.id })))).toBe(true)
        yield* client["profiles.switch"]({ profileId: MAIN_PROFILE_ID })
        expect(forbidden(yield* Effect.exit(client["profiles.delete"]({ profileId: MAIN_PROFILE_ID })))).toBe(true)

        yield* client["profiles.delete"]({ profileId: doomed.id })
        expect((yield* client["profiles.list"]()).profiles.map((p) => p.id)).not.toContain(doomed.id)
        expect(Option.isNone(yield* Effect.orDie((yield* BotRepo).get(bot.id)))).toBe(true)
        expect(yield* Effect.orDie((yield* SectionRepo).list(doomed.id))).toEqual([])
        expect(Option.isNone(yield* Effect.orDie((yield* ConversationRepo).get(bot.directConversationId)))).toBe(true)
      }),
    )
  }, 30_000)
})

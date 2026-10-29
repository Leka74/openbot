import { afterAll, expect, test } from "bun:test"
import { MAIN_PROFILE_ID } from "@openbot/contracts"
import { Effect, Exit } from "effect"
import { cleanupTempDirs } from "../../../packages/persistence/test/helpers.ts"
import { legacyData } from "../../../packages/persistence/test/profile-migration-fixture.ts"
import { login, startServer } from "./helpers.ts"
import { connectOwner, rosterSnapshot } from "./profile-isolation-helpers.ts"

afterAll(cleanupTempDirs)

test("a second profile cannot read migrated main-profile rows or settings over RPC", async () => {
  const legacy = await legacyData()
  const server = await startServer({ dataDir: legacy.dir })
  try {
    const cookie = await login(server.base, server.ownerToken)
    await server.run(
      Effect.gen(function* () {
        const client = yield* connectOwner(server, cookie)
        expect((yield* client["profiles.list"]()).activeId).toBe(MAIN_PROFILE_ID)
        const main = yield* rosterSnapshot(client)
        expect(main.kind).toBe("snapshot")
        if (main.kind === "snapshot") expect(main.bots.map((bot) => bot.id)).toContain(legacy.bot.id)
        expect((yield* client["settings.get"]()).ownerName).toBe("Legacy owner")
        const chat = yield* client["conversations.around"]({ conversationId: legacy.conversation.id, limit: 20 })
        expect(chat.entries.map((entry) => entry.id)).toContain(legacy.entry.id)

        const demo = yield* client["profiles.create"]({ name: "Demo" })
        yield* client["profiles.switch"]({ profileId: demo.id })
        const roster = yield* rosterSnapshot(client)
        expect(roster.kind).toBe("snapshot")
        if (roster.kind === "snapshot") {
          expect(roster.bots).toEqual([])
          expect(roster.conversations).toEqual([])
        }
        expect((yield* client["settings.get"]()).ownerName).toBeUndefined()
        const bot = yield* Effect.exit(client["bots.get"]({ botId: legacy.bot.id }))
        expect(Exit.isFailure(bot)).toBe(true)
        if (Exit.isFailure(bot)) expect(JSON.stringify(bot.cause)).toContain("NotFound")
        const foreignChat = yield* Effect.exit(
          client["conversations.around"]({ conversationId: legacy.conversation.id, limit: 20 }),
        )
        expect(Exit.isFailure(foreignChat)).toBe(true)
        if (Exit.isFailure(foreignChat)) expect(JSON.stringify(foreignChat.cause)).toContain("NotFound")

        yield* client["profiles.switch"]({ profileId: MAIN_PROFILE_ID })
        expect((yield* client["bots.get"]({ botId: legacy.bot.id })).name).toBe(legacy.bot.name)
        expect((yield* client["settings.get"]()).ownerName).toBe("Legacy owner")
        const restored = yield* client["conversations.around"]({ conversationId: legacy.conversation.id, limit: 20 })
        expect(restored.entries.map((entry) => entry.id)).toContain(legacy.entry.id)
      }),
    )
  } finally {
    await server.close()
  }
}, 30_000)

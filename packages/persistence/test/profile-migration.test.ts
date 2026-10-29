import { afterAll, describe, expect, test } from "bun:test"
import { DEFAULT_SEARCH_KINDS, MAIN_PROFILE_ID, SkillName } from "@openbot/contracts"
import {
  AttachmentStore,
  BotRepo,
  ConversationRepo,
  EntryRepo,
  inProfile,
  MemoryStore,
  parseSearchQuery,
  RoutineRepo,
  SearchRepo,
  SettingsRepo,
  SkillStore,
  TaskRepo,
} from "@openbot/core"
import { Effect, Option } from "effect"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupTempDirs, run, testPersistence } from "./helpers.ts"
import { legacyData } from "./profile-migration-fixture.ts"

afterAll(cleanupTempDirs)

describe("default profile migration", () => {
  test("0004 chats, routines, tasks, files, settings and search survive migration and reopening", async () => {
    const legacy = await legacyData()
    for (let boot = 0; boot < 2; boot++) {
      await run(
        Effect.gen(function* () {
          expect(Option.getOrThrow(yield* (yield* BotRepo).get(legacy.bot.id))).toEqual(legacy.bot)
          expect(Option.getOrThrow(yield* (yield* ConversationRepo).get(legacy.conversation.id))).toMatchObject(
            legacy.conversation,
          )
          expect(Option.getOrThrow(yield* (yield* EntryRepo).get(legacy.entry.id))).toEqual(legacy.entry)
          expect(Option.getOrThrow(yield* (yield* RoutineRepo).get(legacy.routine.id))).toMatchObject(legacy.routine)
          expect(yield* (yield* RoutineRepo).listRuns(legacy.routine.id)).toEqual([legacy.routineRun])
          expect(Option.getOrThrow(yield* (yield* TaskRepo).get(legacy.task.id))).toMatchObject(legacy.task)
          expect(Option.getOrThrow(yield* (yield* AttachmentStore).read(legacy.attachment.id))).toEqual(
            new TextEncoder().encode("legacy bytes"),
          )
          expect(yield* (yield* MemoryStore).readIndex(legacy.bot.id)).toBe("legacy memory index\n")
          expect((yield* (yield* MemoryStore).listFacts(legacy.bot.id))[0]?.body).toBe("legacy memory body\n")
          expect(Option.getOrThrow(yield* (yield* SkillStore).get(SkillName.make("legacy"))).body).toBe(
            "legacy instructions\n",
          )
          expect(yield* (yield* SettingsRepo).get("ownerName")).toEqual(Option.some("Legacy owner"))
          expect(yield* (yield* SettingsRepo).get("brain.harnessProfiles")).toEqual(Option.some([]))
          const search = yield* SearchRepo
          yield* search.ensure
          const results = yield* search.query({
            scope: { kind: "owner", profileId: MAIN_PROFILE_ID },
            match: parseSearchQuery("legacy")!,
            kinds: DEFAULT_SEARCH_KINDS,
            sort: "oldest",
            limit: 20,
          })
          expect(results.hits.map((hit) => hit.doc.refId).sort()).toEqual([legacy.entry.id, legacy.task.id].sort())
        }).pipe(inProfile(MAIN_PROFILE_ID)),
        testPersistence(legacy.dir),
      )
    }
    expect(readFileSync(join(legacy.memoryDir, "MEMORY.md"), "utf8")).toBe("legacy memory index\n")
    expect(readFileSync(legacy.attachment.path, "utf8")).toBe("legacy bytes")
    for (const connection of legacy.connections) expect(readFileSync(connection.path, "utf8")).toBe(connection.text)
  })
})

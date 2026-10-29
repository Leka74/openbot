/**
 * Migration 0002 "one mind per bot": a bot adopts its DM's native session; group sessions are
 * dropped; non-direct conversations lose their per-conversation context-ring rows.
 */
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { type ApprovalRule, MAIN_PROFILE_ID, type OwnerProfileId } from "@openbot/contracts"
import {
  ApprovalRuleRepo,
  BotRepo,
  ConversationRepo,
  OwnerProfileRepo,
  SectionRepo,
  SettingsRepo,
  TaskRepo,
} from "@openbot/core"
import {
  botId,
  conversationId,
  entryId,
  makeBot,
  makeRule,
  makeSection,
  makeTask,
  makeToolCallEntry,
  taskId,
} from "@openbot/core/testing"
import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { join } from "node:path"
import Initial from "../src/migrations/0001_initial.ts"
import OneMind from "../src/migrations/0002_one_mind_per_bot.ts"
import BackgroundTasks from "../src/migrations/0003_background_tasks.ts"
import MessageSearch from "../src/migrations/0004_message_search.ts"
import { cleanupTempDirs, run, tempDataDir, testPersistence } from "./helpers.ts"

afterAll(cleanupTempDirs)

const conversationRow = (id: string, kind: string, payload: object) => ({
  id,
  kind,
  last_activity_at: 1,
  hidden: 0,
  payload_json: JSON.stringify({
    id,
    kind,
    title: id,
    createdAt: 1,
    lastActivityAt: 1,
    unreadCount: 0,
    hiddenFromSidebar: false,
    epoch: "epc_1",
    ...payload,
  }),
})

const sessionRow = (conversation: string, bot: string, native: string, extra: object = {}) => ({
  conversation_id: conversation,
  bot_id: bot,
  driver: "claude",
  native_session_id: native,
  updated_at: 5,
  payload_json: JSON.stringify({
    conversationId: conversation,
    botId: bot,
    driver: "claude",
    nativeSessionId: native,
    updatedAt: 5,
    ...extra,
  }),
})

describe("0002_one_mind_per_bot", () => {
  test("adopts each bot's DM session, drops its group sessions and the groups' context rows", async () => {
    const dir = await tempDataDir()
    // A database at schema 0001 with per-(conversation, bot) sessions.
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord({ "0001_initial": Initial }) })
        const sql = yield* SqlClient.SqlClient
        const ring = {
          sessions: [
            { botId: "bot_ada", active: true, contextUsage: { usedTokens: 10, windowTokens: 100 }, updatedAt: 1 },
          ],
        }
        yield* sql`INSERT INTO conversations ${sql.insert([
          conversationRow("cnv_ada", "direct", { botId: "bot_ada", ...ring }),
          conversationRow("cnv_bob", "direct", { botId: "bot_bob" }),
          conversationRow("cnv_group", "group", { memberBotIds: ["bot_ada", "bot_bob"], namedBy: "user", ...ring }),
        ])}`
        yield* sql`INSERT INTO native_sessions ${sql.insert([
          sessionRow("cnv_ada", "bot_ada", "dm-session", { instructionsHash: "h1" }),
          sessionRow("cnv_group", "bot_ada", "group-session-ada", { lastSeenEntryId: "ent_9" }),
          // Bob only ever worked in the group: nothing to adopt.
          sessionRow("cnv_group", "bot_bob", "group-session-bob"),
        ])}`
      }).pipe(Effect.provide(SqliteClient.layer({ filename: join(dir, "openbot.sqlite") }))),
    )
    const out = await run(
      Effect.gen(function* () {
        const bots = yield* BotRepo
        const conversations = yield* ConversationRepo
        const sql = yield* SqlClient.SqlClient
        const tables = yield* sql<{
          name: string
        }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'native_sessions'`
        return {
          ada: yield* bots.getSession(botId("bot_ada")),
          bob: yield* bots.getSession(botId("bot_bob")),
          dm: yield* conversations.get(conversationId("cnv_ada")),
          group: yield* conversations.get(conversationId("cnv_group")),
          legacyTable: tables.length,
        }
      }),
      testPersistence(dir),
    )
    expect(Option.getOrThrow(out.ada) as unknown).toEqual({
      botId: "bot_ada",
      driver: "claude",
      nativeSessionId: "dm-session",
      instructionsHash: "h1",
      updatedAt: 5,
    })
    expect(Option.isNone(out.bob)).toBe(true)
    expect(out.legacyTable).toBe(0)
    expect(Option.getOrThrow(out.dm).sessions).toHaveLength(1)
    expect(Option.getOrThrow(out.group).sessions).toBeUndefined()
  })
})

describe("0003_background_tasks", () => {
  test("a 0002 database gains the tasks tables; tasks and their steps round-trip", async () => {
    const dir = await tempDataDir()
    await Effect.runPromise(
      SqliteMigrator.run({
        loader: SqliteMigrator.fromRecord({ "0001_initial": Initial, "0002_one_mind_per_bot": OneMind }),
      }).pipe(Effect.provide(SqliteClient.layer({ filename: join(dir, "openbot.sqlite") }))),
    )
    const out = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskRepo
        yield* tasks.upsert(makeTask({ id: taskId("tsk_1"), botId: botId("bot_ada"), status: "running", startedAt: 1 }))
        yield* tasks.putStep(taskId("tsk_1"), makeToolCallEntry({ id: entryId("ent_step"), status: "running" }))
        return { task: yield* tasks.get(taskId("tsk_1")), steps: yield* tasks.steps(taskId("tsk_1")) }
      }),
      testPersistence(dir),
    )
    expect(Option.getOrThrow(out.task).status).toBe("running")
    expect(out.steps.map((s) => s.id)).toEqual([entryId("ent_step")])
  })
})

describe("0005_owner_profiles", () => {
  test("everything of a 0004 database belongs to the main profile, unchanged", async () => {
    const dir = await tempDataDir()
    // what a 0004 brain stored: no profile anywhere
    const withoutProfile = (value: object) => JSON.stringify({ ...value, ownerProfileId: undefined })
    const bot = makeBot({ id: botId("bot_ada"), name: "Ada" })
    const section = makeSection()
    const rule = makeRule({ botId: bot.id })
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* SqliteMigrator.run({
          loader: SqliteMigrator.fromRecord({
            "0001_initial": Initial,
            "0002_one_mind_per_bot": OneMind,
            "0003_background_tasks": BackgroundTasks,
            "0004_message_search": MessageSearch,
          }),
        })
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO bots (id, created_at, payload_json)
          VALUES (${bot.id}, ${bot.createdAt}, ${withoutProfile(bot)})`
        yield* sql`INSERT INTO sections (id, sort_order, payload_json)
          VALUES (${section.id}, ${section.order}, ${withoutProfile(section)})`
        yield* sql`INSERT INTO approval_rules (id, bot_id, created_at, payload_json)
          VALUES (${rule.id}, ${bot.id}, ${rule.createdAt}, ${withoutProfile(rule)})`
        yield* sql`INSERT INTO settings (key, value_json) VALUES ('theme', '"dark"'), ('brain.harnessProfiles', '[]')`
      }).pipe(Effect.provide(SqliteClient.layer({ filename: join(dir, "openbot.sqlite") }))),
    )
    const out = await run(
      Effect.gen(function* () {
        const settings = yield* SettingsRepo
        const sql = yield* SqlClient.SqlClient
        return {
          profiles: yield* (yield* OwnerProfileRepo).list,
          bots: yield* (yield* BotRepo).list,
          sections: yield* (yield* SectionRepo).list(MAIN_PROFILE_ID),
          rules: yield* (yield* ApprovalRuleRepo).list({ profileId: MAIN_PROFILE_ID }),
          theme: yield* settings.get("theme"),
          accounts: yield* settings.get("brain.harnessProfiles"),
          // what an older release writes after a rollback
          rollbackWrite: yield* sql`INSERT INTO settings (key, value_json) VALUES ('theme', '"light"')
            ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`.pipe(
            Effect.andThen(settings.get("theme")),
          ),
          columns: yield* sql<{ owner_profile_id: string }>`SELECT owner_profile_id FROM bots
            UNION ALL SELECT owner_profile_id FROM sections`,
        }
      }),
      testPersistence(dir),
    )
    expect(out.profiles.map((p) => [p.id, p.name])).toEqual([[MAIN_PROFILE_ID, "Main"]])
    expect(out.bots).toEqual([bot])
    expect(out.sections).toEqual([section])
    expect(out.rules).toEqual([rule])
    expect(out.theme).toEqual(Option.some("dark"))
    expect(out.accounts).toEqual(Option.some([]))
    expect(out.rollbackWrite).toEqual(Option.some("light"))
    expect(out.columns.map((row) => row.owner_profile_id)).toEqual([MAIN_PROFILE_ID, MAIN_PROFILE_ID])
  })

  test("an older release reads only the main profile's approval rules, never another profile's allow", async () => {
    const dir = await tempDataDir()
    const demo = "prf_demo" as OwnerProfileId
    const mainAsk = makeRule({ id: "rul_main" as ApprovalRule["id"] })
    const demoAllow = makeRule({ id: "rul_demo" as ApprovalRule["id"], ownerProfileId: demo, action: "allow" })
    const out = await run(
      Effect.gen(function* () {
        const rules = yield* ApprovalRuleRepo
        yield* rules.upsert(mainAsk)
        yield* rules.upsert(demoAllow)
        const sql = yield* SqlClient.SqlClient
        return {
          // what an older release reads: every row of approval_rules applies to every Bot
          legacy: yield* sql<{ id: string }>`SELECT id FROM approval_rules`,
          main: yield* rules.list({ profileId: MAIN_PROFILE_ID }),
          demo: yield* rules.list({ profileId: demo }),
          demoById: yield* rules.get(demoAllow.id),
        }
      }),
      testPersistence(dir),
    )
    expect(out.legacy.map((row) => row.id)).toEqual([mainAsk.id])
    expect(out.main).toEqual([mainAsk])
    expect(out.demo).toEqual([demoAllow])
    expect(out.demoById).toEqual(Option.some(demoAllow))
  })
})

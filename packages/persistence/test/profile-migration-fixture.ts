import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { AttachmentId } from "@openbot/contracts"
import {
  botId,
  entryId,
  makeBot,
  makeDirectConversation,
  makeMessageEntry,
  makeRoutine,
  makeRoutineRun,
  makeTask,
} from "@openbot/core/testing"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import Initial from "../src/migrations/0001_initial.ts"
import OneMind from "../src/migrations/0002_one_mind_per_bot.ts"
import BackgroundTasks from "../src/migrations/0003_background_tasks.ts"
import MessageSearch from "../src/migrations/0004_message_search.ts"
import { tempDataDir } from "./helpers.ts"

export const legacyData = async () => {
  const dir = await tempDataDir()
  const bot = makeBot({ id: botId("bot_legacy"), name: "Legacy" })
  const conversation = makeDirectConversation({ id: bot.directConversationId, botId: bot.id })
  const entry = makeMessageEntry({
    id: entryId("ent_legacy"),
    conversationId: conversation.id,
    text: "legacy transcript",
  })
  const routine = makeRoutine({ botId: bot.id })
  const routineRun = makeRoutineRun({ routineId: routine.id, conversationId: conversation.id, status: "succeeded" })
  const task = makeTask({
    botId: bot.id,
    conversationId: conversation.id,
    title: "legacy task",
    status: "succeeded",
    result: "legacy result",
  })
  const attachment = {
    id: AttachmentId.make("att_legacy"),
    name: "legacy.txt",
    mime: "text/plain",
    byteSize: 12,
    path: join(dir, "attachments", "att_legacy"),
    createdAt: 0,
  }
  const json = (value: object) => JSON.stringify({ ...value, ownerProfileId: undefined })
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
      yield* sql`INSERT INTO bots (id, created_at, payload_json) VALUES (${bot.id}, 0, ${json(bot)})`
      yield* sql`INSERT INTO conversations (id, kind, last_activity_at, hidden, payload_json) VALUES (${conversation.id}, 'direct', 0, 0, ${json(conversation)})`
      yield* sql`INSERT INTO conversation_members (conversation_id, bot_id, position) VALUES (${conversation.id}, ${bot.id}, 0)`
      yield* sql`INSERT INTO entries (id, conversation_id, revision, created_at, kind, payload_json) VALUES (${entry.id}, ${conversation.id}, 0, 0, 'message', ${json(entry)})`
      yield* sql`INSERT INTO routines (id, bot_id, created_at, payload_json) VALUES (${routine.id}, ${bot.id}, 0, ${json(routine)})`
      yield* sql`INSERT INTO routine_runs (id, routine_id, started_at, status, payload_json) VALUES (${routineRun.id}, ${routine.id}, 0, 'succeeded', ${json(routineRun)})`
      yield* sql`INSERT INTO tasks (id, bot_id, conversation_id, status, created_at, payload_json) VALUES (${task.id}, ${bot.id}, ${conversation.id}, 'succeeded', 0, ${json(task)})`
      yield* sql`INSERT INTO attachments (id, created_at, payload_json) VALUES (${attachment.id}, 0, ${json(attachment)})`
      yield* sql`INSERT INTO settings (key, value_json) VALUES ('ownerName', '"Legacy owner"'), ('brain.harnessProfiles', '[]')`
    }).pipe(Effect.provide(SqliteClient.layer({ filename: join(dir, "openbot.sqlite") }))),
  )
  const memoryDir = join(dir, "bots", bot.id, "memory")
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(join(memoryDir, "MEMORY.md"), "legacy memory index\n")
  writeFileSync(join(memoryDir, "legacy.md"), "---\nname: Legacy fact\n---\n\nlegacy memory body\n")
  const skillDir = join(dir, "skills-lib", "skills", "legacy")
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: legacy\ndescription: Legacy skill\n---\n\nlegacy instructions\n",
  )
  mkdirSync(join(dir, "attachments"), { recursive: true })
  writeFileSync(attachment.path, "legacy bytes")
  const connections = ["slack.json", "hark.json", "ntfy.json"].map((name) => ({
    path: join(dir, name),
    text: JSON.stringify({ version: 1, token: `legacy-${name}` }),
  }))
  for (const connection of connections) writeFileSync(connection.path, connection.text)
  return { dir, bot, conversation, entry, routine, routineRun, task, attachment, memoryDir, connections }
}

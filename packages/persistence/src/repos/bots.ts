/** `BotRepo` (with the bot's single native session, `bot_sessions`) and `SectionRepo` over SQLite. */
import { Bot, Section } from "@openbot/contracts"
import { BotRepo, BotSessionRecord, SectionRepo } from "@openbot/core"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { jsonCodec, repoOp } from "../codec.ts"

interface PayloadRow {
  readonly id: string
  readonly payload_json: string
}

const BotJson = jsonCodec(Bot, "bot")
const SectionJson = jsonCodec(Section, "section")
const SessionJson = jsonCodec(BotSessionRecord, "bot session")

export const makeSqlBotRepo = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const decodeAll = (op: string, rows: ReadonlyArray<PayloadRow>) =>
    Effect.forEach(rows, (row) => BotJson.decode(op, row.payload_json, row.id))

  return BotRepo.of({
    get: (id) =>
      Effect.gen(function* () {
        const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM bots WHERE id = ${id}`
        const row = rows[0]
        return row === undefined
          ? Option.none()
          : Option.some(yield* BotJson.decode("BotRepo.get", row.payload_json, row.id))
      }).pipe(repoOp("BotRepo.get")),
    list: Effect.gen(function* () {
      const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM bots ORDER BY created_at, rowid`
      return yield* decodeAll("BotRepo.list", rows)
    }).pipe(repoOp("BotRepo.list")),
    listIn: (profileId) =>
      Effect.gen(function* () {
        const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM bots
          WHERE owner_profile_id = ${profileId} ORDER BY created_at, rowid`
        return yield* decodeAll("BotRepo.listIn", rows)
      }).pipe(repoOp("BotRepo.listIn")),
    upsert: (bot) =>
      Effect.gen(function* () {
        const payload = yield* BotJson.encode("BotRepo.upsert", bot)
        yield* sql`INSERT INTO bots (id, owner_profile_id, created_at, payload_json)
          VALUES (${bot.id}, ${bot.ownerProfileId}, ${bot.createdAt}, ${payload})
          ON CONFLICT (id) DO UPDATE SET created_at = excluded.created_at, payload_json = excluded.payload_json`
      }).pipe(repoOp("BotRepo.upsert")),
    delete: (id) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM bot_sessions WHERE bot_id = ${id}`
        const rows = yield* sql<{ id: string }>`DELETE FROM bots WHERE id = ${id} RETURNING id`
        return rows.length > 0
      }).pipe(sql.withTransaction, repoOp("BotRepo.delete")),
    getSession: (botId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ payload_json: string }>`SELECT payload_json FROM bot_sessions WHERE bot_id = ${botId}`
        const row = rows[0]
        return row === undefined
          ? Option.none()
          : Option.some(yield* SessionJson.decode("BotRepo.getSession", row.payload_json, botId))
      }).pipe(repoOp("BotRepo.getSession")),
    setSession: (record) =>
      Effect.gen(function* () {
        const payload = yield* SessionJson.encode("BotRepo.setSession", record)
        yield* sql`INSERT INTO bot_sessions (bot_id, driver, native_session_id, updated_at, payload_json)
          VALUES (${record.botId}, ${record.driver}, ${record.nativeSessionId}, ${record.updatedAt}, ${payload})
          ON CONFLICT (bot_id) DO UPDATE SET driver = excluded.driver, native_session_id = excluded.native_session_id,
            updated_at = excluded.updated_at, payload_json = excluded.payload_json`
      }).pipe(repoOp("BotRepo.setSession")),
    clearSession: (botId) =>
      sql`DELETE FROM bot_sessions WHERE bot_id = ${botId}`.pipe(Effect.asVoid, repoOp("BotRepo.clearSession")),
  })
})

export const makeSqlSectionRepo = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return SectionRepo.of({
    list: (profileId) =>
      Effect.gen(function* () {
        const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM sections
          WHERE owner_profile_id = ${profileId} ORDER BY sort_order, id`
        return yield* Effect.forEach(rows, (row) => SectionJson.decode("SectionRepo.list", row.payload_json, row.id))
      }).pipe(repoOp("SectionRepo.list")),
    get: (id) =>
      Effect.gen(function* () {
        const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM sections WHERE id = ${id}`
        const row = rows[0]
        return row === undefined
          ? Option.none()
          : Option.some(yield* SectionJson.decode("SectionRepo.get", row.payload_json, row.id))
      }).pipe(repoOp("SectionRepo.get")),
    upsert: (section) =>
      Effect.gen(function* () {
        const payload = yield* SectionJson.encode("SectionRepo.upsert", section)
        yield* sql`INSERT INTO sections (id, owner_profile_id, sort_order, payload_json)
          VALUES (${section.id}, ${section.ownerProfileId}, ${section.order}, ${payload})
          ON CONFLICT (id) DO UPDATE SET sort_order = excluded.sort_order, payload_json = excluded.payload_json`
      }).pipe(repoOp("SectionRepo.upsert")),
    delete: (id) =>
      sql<{ id: string }>`DELETE FROM sections WHERE id = ${id} RETURNING id`.pipe(
        Effect.map((rows) => rows.length > 0),
        repoOp("SectionRepo.delete"),
      ),
  })
})

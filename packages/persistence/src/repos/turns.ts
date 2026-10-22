/** `RequestRepo` and `TurnRepo` over SQLite. */
import { RuntimeRequest, Turn } from "@openbot/contracts"
import { RequestRepo, TurnRepo } from "@openbot/core"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { jsonCodec, repoOp } from "../codec.ts"
import { hideVoiceTurn } from "./search.ts"

interface PayloadRow {
  readonly id: string
  readonly payload_json: string
}

const RequestJson = jsonCodec(RuntimeRequest, "runtime request")
const TurnJson = jsonCodec(Turn, "turn")

export const makeSqlRequestRepo = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const decodeAll = (op: string, rows: ReadonlyArray<PayloadRow>) =>
    Effect.forEach(rows, (row) => RequestJson.decode(op, row.payload_json, row.id))
  const first = (op: string, rows: ReadonlyArray<PayloadRow>) => {
    const row = rows[0]
    return row === undefined
      ? Effect.succeed(Option.none<RuntimeRequest>())
      : Effect.map(RequestJson.decode(op, row.payload_json, row.id), Option.some)
  }

  return RequestRepo.of({
    get: (id) =>
      sql<PayloadRow>`SELECT id, payload_json FROM requests WHERE id = ${id}`.pipe(
        Effect.flatMap((rows) => first("RequestRepo.get", rows)),
        repoOp("RequestRepo.get"),
      ),
    upsert: (request) =>
      Effect.gen(function*() {
        const payload = yield* RequestJson.encode("RequestRepo.upsert", request)
        yield* sql`INSERT INTO requests (id, conversation_id, bot_id, turn_id, status, native_request_id, created_at, payload_json)
          VALUES (${request.id}, ${request.conversationId}, ${request.botId}, ${request.turnId ?? null}, ${request.status},
            ${request.source.nativeRequestId ?? null}, ${request.createdAt}, ${payload})
          ON CONFLICT (id) DO UPDATE SET conversation_id = excluded.conversation_id, bot_id = excluded.bot_id,
            turn_id = excluded.turn_id, status = excluded.status, native_request_id = excluded.native_request_id,
            created_at = excluded.created_at, payload_json = excluded.payload_json`
      }).pipe(repoOp("RequestRepo.upsert")),
    list: (filter) =>
      Effect.gen(function*() {
        if (filter?.statuses !== undefined && filter.statuses.length === 0) return []
        const clauses = [
          ...(filter?.conversationId === undefined ? [] : [sql`conversation_id = ${filter.conversationId}`]),
          ...(filter?.botId === undefined ? [] : [sql`bot_id = ${filter.botId}`]),
          ...(filter?.turnId === undefined ? [] : [sql`turn_id = ${filter.turnId}`]),
          ...(filter?.statuses === undefined ? [] : [sql.in("status", filter.statuses)]),
        ]
        const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM requests WHERE ${sql.and(clauses)}
          ORDER BY created_at, rowid`
        return yield* decodeAll("RequestRepo.list", rows)
      }).pipe(repoOp("RequestRepo.list")),
    findByNativeId: (botId, nativeRequestId) =>
      sql<PayloadRow>`SELECT id, payload_json FROM requests
        WHERE bot_id = ${botId} AND native_request_id = ${nativeRequestId} ORDER BY created_at, rowid LIMIT 1`.pipe(
        Effect.flatMap((rows) => first("RequestRepo.findByNativeId", rows)),
        repoOp("RequestRepo.findByNativeId"),
      ),
    deleteByConversation: (conversationId) =>
      sql`DELETE FROM requests WHERE conversation_id = ${conversationId}`.pipe(
        Effect.asVoid,
        repoOp("RequestRepo.deleteByConversation"),
      ),
  })
})

export const makeSqlTurnRepo = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const decodeAll = (op: string, rows: ReadonlyArray<PayloadRow>) =>
    Effect.forEach(rows, (row) => TurnJson.decode(op, row.payload_json, row.id))

  return TurnRepo.of({
    get: (id) =>
      Effect.gen(function*() {
        const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM turns WHERE id = ${id}`
        const row = rows[0]
        return row === undefined ? Option.none() : Option.some(yield* TurnJson.decode("TurnRepo.get", row.payload_json, row.id))
      }).pipe(repoOp("TurnRepo.get")),
    upsert: (turn) =>
      Effect.gen(function*() {
        const payload = yield* TurnJson.encode("TurnRepo.upsert", turn)
        yield* sql`INSERT INTO turns (id, conversation_id, bot_id, status, started_at, payload_json)
          VALUES (${turn.id}, ${turn.conversationId}, ${turn.botId}, ${turn.status}, ${turn.startedAt}, ${payload})
          ON CONFLICT (id) DO UPDATE SET conversation_id = excluded.conversation_id, bot_id = excluded.bot_id,
            status = excluded.status, started_at = excluded.started_at, payload_json = excluded.payload_json`
        if (turn.voice === true) yield* hideVoiceTurn(sql, turn.id)
      }).pipe(repoOp("TurnRepo.upsert")),
    listByConversation: (conversationId, limit) =>
      Effect.gen(function*() {
        const size = Math.floor(limit)
        if (size <= 0) return []
        const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM turns WHERE conversation_id = ${conversationId}
          ORDER BY started_at DESC, id DESC LIMIT ${size}`
        return yield* decodeAll("TurnRepo.listByConversation", [...rows].reverse())
      }).pipe(repoOp("TurnRepo.listByConversation")),
    listActive: Effect.gen(function*() {
      const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM turns
        WHERE status IN ('queued', 'running', 'waiting') ORDER BY started_at, id`
      return yield* decodeAll("TurnRepo.listActive", rows)
    }).pipe(repoOp("TurnRepo.listActive")),
    deleteByConversation: (conversationId) =>
      sql`DELETE FROM turns WHERE conversation_id = ${conversationId}`.pipe(
        Effect.asVoid,
        repoOp("TurnRepo.deleteByConversation"),
      ),
  })
})

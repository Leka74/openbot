/** `TaskRepo` over SQLite (background tasks, D5.7): task records and their steps. */
import { KnownTranscriptEntry as KnownTranscriptEntrySchema, Task, TranscriptEntry as TranscriptEntrySchema } from "@openbot/contracts"
import { TaskRepo } from "@openbot/core"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { jsonCodec, repoOp } from "../codec.ts"
import { indexTask } from "./search.ts"

interface PayloadRow {
  readonly id: string
  readonly payload_json: string
}

const TaskJson = jsonCodec(Task, "task")
const KnownStepJson = jsonCodec(KnownTranscriptEntrySchema, "task step")
const StepJson = jsonCodec(TranscriptEntrySchema, "task step")

export const makeSqlTaskRepo = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const decodeAll = (op: string, rows: ReadonlyArray<PayloadRow>) =>
    Effect.forEach(rows, (row) => TaskJson.decode(op, row.payload_json, row.id))

  return TaskRepo.of({
    get: (id) =>
      Effect.gen(function*() {
        const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM tasks WHERE id = ${id}`
        const row = rows[0]
        return row === undefined ? Option.none() : Option.some(yield* TaskJson.decode("TaskRepo.get", row.payload_json, row.id))
      }).pipe(repoOp("TaskRepo.get")),
    upsert: (task) =>
      Effect.gen(function*() {
        const payload = yield* TaskJson.encode("TaskRepo.upsert", task)
        yield* sql`INSERT INTO tasks (id, bot_id, conversation_id, status, created_at, payload_json)
          VALUES (${task.id}, ${task.botId}, ${task.conversationId}, ${task.status}, ${task.createdAt}, ${payload})
          ON CONFLICT (id) DO UPDATE SET bot_id = excluded.bot_id, conversation_id = excluded.conversation_id,
            status = excluded.status, created_at = excluded.created_at, payload_json = excluded.payload_json`
        yield* indexTask(sql, task)
      }).pipe(sql.withTransaction, repoOp("TaskRepo.upsert")),
    list: (filter) =>
      Effect.gen(function*() {
        if (filter?.statuses !== undefined && filter.statuses.length === 0) return []
        const clauses = [
          ...(filter?.botId === undefined ? [] : [sql`bot_id = ${filter.botId}`]),
          ...(filter?.conversationId === undefined ? [] : [sql`conversation_id = ${filter.conversationId}`]),
          ...(filter?.statuses === undefined ? [] : [sql.in("status", filter.statuses)]),
        ]
        const limit = filter?.limit === undefined ? -1 : Math.max(0, Math.floor(filter.limit))
        const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM tasks WHERE ${sql.and(clauses)}
          ORDER BY created_at DESC, id DESC LIMIT ${limit}`
        return yield* decodeAll("TaskRepo.list", rows)
      }).pipe(repoOp("TaskRepo.list")),
    delete: (id) =>
      Effect.gen(function*() {
        yield* sql`DELETE FROM task_steps WHERE task_id = ${id}`
        const rows = yield* sql<{ readonly id: string }>`DELETE FROM tasks WHERE id = ${id} RETURNING id`
        return rows.length > 0
      }).pipe(repoOp("TaskRepo.delete")),
    putStep: (taskId, step) =>
      Effect.gen(function*() {
        const payload = yield* KnownStepJson.encode("TaskRepo.putStep", step)
        yield* sql`INSERT INTO task_steps (task_id, id, created_at, payload_json)
          VALUES (${taskId}, ${step.id}, ${step.createdAt}, ${payload})
          ON CONFLICT (task_id, id) DO UPDATE SET payload_json = excluded.payload_json`
      }).pipe(repoOp("TaskRepo.putStep")),
    steps: (taskId) =>
      Effect.gen(function*() {
        const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM task_steps WHERE task_id = ${taskId}
          ORDER BY created_at, id`
        return yield* Effect.forEach(rows, (row) => StepJson.decode("TaskRepo.steps", row.payload_json, row.id))
      }).pipe(repoOp("TaskRepo.steps")),
  })
})

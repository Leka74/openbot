/**
 * `EntryRepo` over SQLite: whole-entry upserts with a revision guard, `(createdAt, id)` ordering
 * and cursor paging. Entries are encoded with `KnownTranscriptEntry` and decoded with the
 * fallback-aware `TranscriptEntry` (unknown kinds written by a newer build survive as `unknown`).
 */
import type { KnownTranscriptEntry, Millis, TranscriptEntry } from "@openbot/contracts"
import { KnownTranscriptEntry as KnownTranscriptEntrySchema, TranscriptEntry as TranscriptEntrySchema } from "@openbot/contracts"
import { type EntryPage, type EntryPageAfter, EntryRepo, type ExchangeSlice, RepoError, type UpsertOutcome } from "@openbot/core"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { jsonCodec, repoOp } from "../codec.ts"
import { indexEntry } from "./search.ts"

interface EntryRow {
  readonly id: string
  readonly created_at: number
  readonly payload_json: string
}

const KnownEntryJson = jsonCodec(KnownTranscriptEntrySchema, "transcript entry")
const EntryJson = jsonCodec(TranscriptEntrySchema, "transcript entry")

/** Opaque page cursor `"<createdAt>:<id>"` (ids never contain ':'). Same format as the in-memory double. */
export const encodeEntryCursor = (entry: { readonly createdAt: number; readonly id: string }): string =>
  `${entry.createdAt}:${entry.id}`

export const decodeEntryCursor = (cursor: string): { readonly createdAt: number; readonly id: string } | undefined => {
  const index = cursor.indexOf(":")
  if (index <= 0) return undefined
  const createdAt = Number(cursor.slice(0, index))
  const id = cursor.slice(index + 1)
  return Number.isFinite(createdAt) && id.length > 0 ? { createdAt, id } : undefined
}

export const makeSqlEntryRepo = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  const decodeRow = (op: string) => (row: EntryRow) => EntryJson.decode(op, row.payload_json, row.id)
  const decodeRows = (op: string, rows: ReadonlyArray<EntryRow>) => Effect.forEach(rows, decodeRow(op))
  const first = (op: string, rows: ReadonlyArray<EntryRow>) => {
    const row = rows[0]
    return row === undefined ? Effect.succeed(Option.none<TranscriptEntry>()) : Effect.map(decodeRow(op)(row), Option.some)
  }

  const nativeIdOf = (entry: KnownTranscriptEntry) => entry.harnessRef?.nativeId ?? null
  const clientNonceOf = (entry: KnownTranscriptEntry) =>
    entry.kind === "message" && entry.clientNonce !== undefined ? entry.clientNonce : null

  return EntryRepo.of({
    get: (id) =>
      sql<EntryRow>`SELECT id, created_at, payload_json FROM entries WHERE id = ${id}`.pipe(
        Effect.flatMap((rows) => first("EntryRepo.get", rows)),
        repoOp("EntryRepo.get"),
      ),

    upsert: (entry) =>
      Effect.gen(function*() {
        const rows = yield* sql<EntryRow & { readonly revision: number }>`SELECT id, created_at, revision, payload_json
          FROM entries WHERE id = ${entry.id}`
        const currentRow = rows[0]
        if (currentRow !== undefined && currentRow.revision >= entry.revision) {
          const current = yield* decodeRow("EntryRepo.upsert")(currentRow)
          return { applied: false, current } satisfies UpsertOutcome<TranscriptEntry>
        }
        // createdAt is immutable once written.
        const value: KnownTranscriptEntry = currentRow !== undefined && currentRow.created_at !== entry.createdAt
          ? { ...entry, createdAt: currentRow.created_at as Millis }
          : entry
        const payload = yield* KnownEntryJson.encode("EntryRepo.upsert", value)
        yield* sql`INSERT INTO entries (id, conversation_id, revision, created_at, kind, turn_id, client_nonce, native_id, payload_json)
          VALUES (${value.id}, ${value.conversationId}, ${value.revision}, ${value.createdAt}, ${value.kind},
            ${value.turnId ?? null}, ${clientNonceOf(value)}, ${nativeIdOf(value)}, ${payload})
          ON CONFLICT (id) DO UPDATE SET conversation_id = excluded.conversation_id, revision = excluded.revision,
            kind = excluded.kind, turn_id = excluded.turn_id, client_nonce = excluded.client_nonce,
            native_id = excluded.native_id, payload_json = excluded.payload_json`
        yield* indexEntry(sql, value)
        return { applied: true, value } satisfies UpsertOutcome<TranscriptEntry>
      }).pipe(sql.withTransaction, repoOp("EntryRepo.upsert")),

    remove: (id) =>
      sql<{ id: string }>`DELETE FROM entries WHERE id = ${id} RETURNING id`.pipe(
        Effect.map((rows) => rows.length > 0),
        repoOp("EntryRepo.remove"),
      ),

    page: ({ conversationId, before, limit }) =>
      Effect.gen(function*() {
        const size = Math.max(0, Math.floor(limit))
        let rows: ReadonlyArray<EntryRow>
        if (before === undefined) {
          rows = yield* sql<EntryRow>`SELECT id, created_at, payload_json FROM entries
            WHERE conversation_id = ${conversationId}
            ORDER BY created_at DESC, id DESC LIMIT ${size + 1}`
        } else {
          const cursor = decodeEntryCursor(before)
          if (cursor === undefined) {
            return yield* new RepoError({ op: "EntryRepo.page", message: `Invalid cursor: ${before}` })
          }
          rows = yield* sql<EntryRow>`SELECT id, created_at, payload_json FROM entries
            WHERE conversation_id = ${conversationId}
              AND (created_at < ${cursor.createdAt} OR (created_at = ${cursor.createdAt} AND id < ${cursor.id}))
            ORDER BY created_at DESC, id DESC LIMIT ${size + 1}`
        }
        const pageRows = rows.slice(0, size).reverse()
        const preceding = rows[size]
        const entries = yield* decodeRows("EntryRepo.page", pageRows)
        const head = pageRows[0]
        const hasMoreBefore = preceding !== undefined
        const page: EntryPage = {
          entries,
          hasMoreBefore,
          beforeCursor: hasMoreBefore && head !== undefined ? encodeEntryCursor({ createdAt: head.created_at, id: head.id }) : null,
          precedingTimestamp: preceding === undefined ? undefined : (preceding.created_at as Millis),
        }
        return page
      }).pipe(repoOp("EntryRepo.page")),

    pageAfter: ({ conversationId, after, limit }) =>
      Effect.gen(function*() {
        const size = Math.max(0, Math.floor(limit))
        const cursor = decodeEntryCursor(after)
        if (cursor === undefined) {
          return yield* new RepoError({ op: "EntryRepo.pageAfter", message: `Invalid cursor: ${after}` })
        }
        const rows = yield* sql<EntryRow>`SELECT id, created_at, payload_json FROM entries
          WHERE conversation_id = ${conversationId}
            AND (created_at > ${cursor.createdAt} OR (created_at = ${cursor.createdAt} AND id > ${cursor.id}))
          ORDER BY created_at, id LIMIT ${size + 1}`
        const pageRows = rows.slice(0, size)
        const entries = yield* decodeRows("EntryRepo.pageAfter", pageRows)
        const last = pageRows[pageRows.length - 1]
        const hasMoreAfter = rows.length > size
        const page: EntryPageAfter = {
          entries,
          hasMoreAfter,
          afterCursor: hasMoreAfter && last !== undefined ? encodeEntryCursor({ createdAt: last.created_at, id: last.id }) : null,
        }
        return page
      }).pipe(repoOp("EntryRepo.pageAfter")),

    listExchange: ({ botIds: [a, b], conversationIds, direction, from, limit }) =>
      Effect.gen(function*() {
        const size = Math.max(0, Math.floor(limit))
        if (conversationIds.length === 0) return { entries: [], more: false } satisfies ExchangeSlice
        const older = direction === "older"
        const clauses = [
          sql.in("conversation_id", conversationIds),
          sql`kind = 'message'`,
          sql`((json_extract(payload_json, '$.author.botId') = ${a} AND json_extract(payload_json, '$.toBotId') = ${b})
            OR (json_extract(payload_json, '$.author.botId') = ${b} AND json_extract(payload_json, '$.toBotId') = ${a}))`,
          ...(from === undefined ? [] : [
            older
              ? sql`(created_at < ${from.createdAt} OR (created_at = ${from.createdAt} AND id < ${from.id}))`
              : sql`(created_at > ${from.createdAt} OR (created_at = ${from.createdAt} AND id > ${from.id}))`,
          ]),
        ]
        const rows = older
          ? yield* sql<EntryRow>`SELECT id, created_at, payload_json FROM entries WHERE ${sql.and(clauses)}
              ORDER BY created_at DESC, id DESC LIMIT ${size + 1}`
          : yield* sql<EntryRow>`SELECT id, created_at, payload_json FROM entries WHERE ${sql.and(clauses)}
              ORDER BY created_at, id LIMIT ${size + 1}`
        const kept = rows.slice(0, size)
        const entries = yield* decodeRows("EntryRepo.listExchange", older ? kept.reverse() : kept)
        return { entries, more: rows.length > size } satisfies ExchangeSlice
      }).pipe(repoOp("EntryRepo.listExchange")),

    listAfter: (conversationId, afterEntryId, limit) =>
      Effect.gen(function*() {
        const size = Math.max(0, Math.floor(limit))
        const anchors = afterEntryId === undefined
          ? []
          : yield* sql<{ id: string; created_at: number }>`SELECT id, created_at FROM entries
              WHERE id = ${afterEntryId} AND conversation_id = ${conversationId}`
        const anchor = anchors[0]
        const rows = anchor === undefined
          ? yield* sql<EntryRow>`SELECT id, created_at, payload_json FROM entries
              WHERE conversation_id = ${conversationId}
              ORDER BY created_at, id LIMIT ${size}`
          : yield* sql<EntryRow>`SELECT id, created_at, payload_json FROM entries
              WHERE conversation_id = ${conversationId}
                AND (created_at > ${anchor.created_at} OR (created_at = ${anchor.created_at} AND id > ${anchor.id}))
              ORDER BY created_at, id LIMIT ${size}`
        return yield* decodeRows("EntryRepo.listAfter", rows)
      }).pipe(repoOp("EntryRepo.listAfter")),

    findByClientNonce: (conversationId, clientNonce) =>
      sql<EntryRow>`SELECT id, created_at, payload_json FROM entries
        WHERE conversation_id = ${conversationId} AND client_nonce = ${clientNonce}
        ORDER BY created_at, id LIMIT 1`.pipe(
        Effect.flatMap((rows) => first("EntryRepo.findByClientNonce", rows)),
        repoOp("EntryRepo.findByClientNonce"),
      ),

    findByNativeId: (conversationId, nativeId) =>
      sql<EntryRow>`SELECT id, created_at, payload_json FROM entries
        WHERE conversation_id = ${conversationId} AND native_id = ${nativeId}
        ORDER BY created_at, id LIMIT 1`.pipe(
        Effect.flatMap((rows) => first("EntryRepo.findByNativeId", rows)),
        repoOp("EntryRepo.findByNativeId"),
      ),

    listByTurn: (turnId) =>
      sql<EntryRow>`SELECT id, created_at, payload_json FROM entries WHERE turn_id = ${turnId} ORDER BY created_at, id`.pipe(
        Effect.flatMap((rows) => decodeRows("EntryRepo.listByTurn", rows)),
        repoOp("EntryRepo.listByTurn"),
      ),
  })
})

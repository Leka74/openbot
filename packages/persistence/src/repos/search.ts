/**
 * Message search over SQLite (migration 0004): `search_docs` + the FTS5 indexes `search_fts` (chat
 * items) and `search_steps_fts` (tool steps).
 *
 * - **Writes.** `EntryRepo.upsert` and `TaskRepo.upsert` call `indexEntry` / `indexTask` in their
 *   transaction: the doc is written only when its derived text (or a filter column) changed, so the
 *   many revisions of a streaming message and reaction-only edits cost nothing. A voice turn hides
 *   its docs (`hideVoiceTurn`, from `TurnRepo.upsert`). Deletes go through the migration's triggers.
 * - **Reads.** Every scope rule (`SearchFilter`) is part of the SQL, so limits, counts and cursors
 *   never see what the scope leaves out. Time sorts walk `search_docs` in time order and keep the
 *   matches (stopping at the page); relevance filters the best bm25 matches first (`byRelevance`).
 *   Snippets are cut from the stored text (`makeSnippet`).
 * - **Boot.** `ensure` indexes what is stored: everything when the stored text version differs from
 *   core's `SEARCH_TEXT_VERSION`, else only the entries and tasks without a doc.
 */
import type { EntryId, Millis, Task, TranscriptEntry, TurnId } from "@openbot/contracts"
import { SEARCH_TOTAL_CAP, Task as TaskSchema, TranscriptEntry as TranscriptEntrySchema } from "@openbot/contracts"
import {
  isStreamingEntry,
  makeSnippet,
  type SearchCursor,
  type SearchDoc,
  type SearchFilter,
  type SearchIndexReport,
  SearchRepo,
  type SearchRepoHit,
  type SearchRepoQuery,
  SEARCH_TEXT_VERSION,
  searchDocOfEntry,
  searchDocOfTask,
  toFtsQuery,
} from "@openbot/core"
import { Clock, Effect, Option, Ref } from "effect"
import { SqlClient } from "effect/sql"
import type { Statement } from "effect/sql"
import { jsonCodec, repoOp } from "../codec.ts"

/** Settings key of the text version the stored docs were derived with. */
export const SEARCH_VERSION_KEY = "brain.searchTextVersion"
/** Rows decoded and indexed per transaction by `ensure`. */
const BACKFILL_BATCH = 500
/** Relevance: how many of the best matches are filtered first, and the most before filtering all. */
const RELEVANCE_FIRST_CANDIDATES = 256
const RELEVANCE_MAX_CANDIDATES = 16_384
/** Entry kinds that can have a doc (reasoning never has one). */
const INDEXED_KINDS = ["message", "card", "event", "notice", "tool-call"]

const EntryJson = jsonCodec(TranscriptEntrySchema, "transcript entry")
const TaskJson = jsonCodec(TaskSchema, "task")

interface DocRow {
  readonly source: "entry" | "task"
  readonly ref_id: string
  readonly conversation_id: string
  readonly turn_id: string | null
  readonly kind: string
  readonly author_kind: "user" | "bot" | "system"
  readonly author_bot_id: string | null
  readonly to_bot_id: string | null
  readonly created_at: number
  readonly text: string
}

type FtsTable = "search_fts" | "search_steps_fts"

interface SortRow {
  readonly id: number
  readonly created_at: number
  readonly ref_id: string
  readonly score: number
}

const docOfRow = (row: DocRow): SearchDoc => ({
  source: row.source,
  refId: row.ref_id,
  conversationId: row.conversation_id as SearchDoc["conversationId"],
  turnId: (row.turn_id ?? undefined) as TurnId | undefined,
  kind: row.kind as SearchDoc["kind"],
  authorKind: row.author_kind,
  authorBotId: (row.author_bot_id ?? undefined) as SearchDoc["authorBotId"],
  toBotId: (row.to_bot_id ?? undefined) as SearchDoc["toBotId"],
  createdAt: row.created_at,
  text: row.text,
})

// ============================================================================ writes

/** Writes `doc` unless the stored one is the same; `hidden` = its turn was a voice turn. */
const writeDoc = (sql: SqlClient.SqlClient, doc: SearchDoc) =>
  sql`INSERT INTO search_docs (source, ref_id, conversation_id, turn_id, kind, author_kind, author_bot_id, to_bot_id,
      hidden, created_at, text, text_version)
    VALUES (${doc.source}, ${doc.refId}, ${doc.conversationId}, ${doc.turnId ?? null}, ${doc.kind}, ${doc.authorKind},
      ${doc.authorBotId ?? null}, ${doc.toBotId ?? null},
      COALESCE((SELECT 1 FROM turns WHERE id = ${doc.turnId ?? null} AND json_extract(payload_json, '$.voice') = 1), 0),
      ${doc.createdAt}, ${doc.text}, ${SEARCH_TEXT_VERSION})
    ON CONFLICT (ref_id) DO UPDATE SET conversation_id = excluded.conversation_id, turn_id = excluded.turn_id,
      kind = excluded.kind, author_kind = excluded.author_kind, author_bot_id = excluded.author_bot_id,
      to_bot_id = excluded.to_bot_id, hidden = excluded.hidden, created_at = excluded.created_at, text = excluded.text,
      text_version = excluded.text_version
    WHERE search_docs.text IS NOT excluded.text OR search_docs.hidden IS NOT excluded.hidden
      OR search_docs.created_at IS NOT excluded.created_at OR search_docs.conversation_id IS NOT excluded.conversation_id
      OR search_docs.turn_id IS NOT excluded.turn_id OR search_docs.text_version IS NOT excluded.text_version`

/** Keeps the doc of an entry that was just written (call inside the write's transaction). */
export const indexEntry = (sql: SqlClient.SqlClient, entry: TranscriptEntry) => {
  if (isStreamingEntry(entry)) return Effect.void
  const doc = searchDocOfEntry(entry)
  return doc === undefined ? Effect.asVoid(sql`DELETE FROM search_docs WHERE ref_id = ${entry.id}`) : Effect.asVoid(writeDoc(sql, doc))
}

/** Keeps the doc of a task that was just written. */
export const indexTask = (sql: SqlClient.SqlClient, task: Task) => {
  const doc = searchDocOfTask(task)
  return doc === undefined ? Effect.asVoid(sql`DELETE FROM search_docs WHERE ref_id = ${task.id}`) : Effect.asVoid(writeDoc(sql, doc))
}

/** A voice turn's work stays out of search (it is told on the call, not shown in the chat). */
export const hideVoiceTurn = (sql: SqlClient.SqlClient, turnId: TurnId) =>
  Effect.asVoid(sql`UPDATE search_docs SET hidden = 1 WHERE turn_id = ${turnId} AND hidden = 0`)

// ============================================================================ the repository

export const makeSqlSearchRepo = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  const storedVersion = sql<{ value_json: string }>`SELECT value_json FROM settings WHERE key = ${SEARCH_VERSION_KEY}`.pipe(
    Effect.map((rows) => rows[0]?.value_json),
  )
  const indexing = yield* Ref.make((yield* storedVersion.pipe(Effect.orElseSucceed(() => undefined))) !== String(SEARCH_TEXT_VERSION))

  /** The WHERE clauses of a filter over `search_docs d` (scope first). */
  const filterClauses = (filter: SearchFilter): Array<Statement.Fragment> => {
    const clauses: Array<Statement.Fragment> = [
      sql`d.hidden = 0`,
      filter.kinds.length === 0 ? sql`0` : sql.in("d.kind", filter.kinds),
      // background work started in a chat that was deleted is gone with the chat
      sql`(d.source = 'entry' OR EXISTS (SELECT 1 FROM conversations c WHERE c.id = d.conversation_id))`,
    ]
    // EXISTS, not `IN (SELECT …)`: a lookup per row is ~10× faster here than probing a list
    if (filter.scope.kind === "bot") {
      const bot = filter.scope.botId
      const member = sql`EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = d.conversation_id AND m.bot_id = ${bot})`
      clauses.push(sql`(
        (d.source = 'task' AND d.author_bot_id = ${bot} AND ${member})
        OR (d.source = 'entry' AND (d.kind <> 'tool-call' OR d.author_bot_id = ${bot}) AND (
          ${member}
          OR (d.kind = 'message' AND (d.author_bot_id = ${bot} OR d.to_bot_id = ${bot})
            AND EXISTS (SELECT 1 FROM conversations dm WHERE dm.id = d.conversation_id AND dm.kind = 'direct'))
        ))
      )`)
    }
    if (filter.conversationIds !== undefined) {
      clauses.push(filter.conversationIds.length === 0 ? sql`0` : sql.in("d.conversation_id", filter.conversationIds))
    }
    if (filter.botIds !== undefined) {
      clauses.push(
        filter.botIds.length === 0
          ? sql`0`
          : sql`(EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = d.conversation_id
                AND ${sql.in("m.bot_id", filter.botIds)})
              OR ${sql.in("d.author_bot_id", filter.botIds)})`,
      )
    }
    if (filter.senders !== undefined) {
      const bots = filter.senders.filter((s) => s !== "owner" && s !== "system")
      const any = [
        ...(filter.senders.includes("owner") ? [sql`d.author_kind = 'user'`] : []),
        ...(filter.senders.includes("system") ? [sql`d.author_kind = 'system'`] : []),
        ...(bots.length === 0 ? [] : [sql.in("d.author_bot_id", bots)]),
      ]
      clauses.push(any.length === 0 ? sql`0` : sql.or(any))
    }
    if (filter.exchangeWith !== undefined) {
      const me = filter.scope.kind === "bot" ? filter.scope.botId : undefined
      const peer = filter.exchangeWith
      clauses.push(
        me === undefined
          ? sql`0`
          : sql`(d.kind = 'message' AND ((d.author_bot_id = ${me} AND d.to_bot_id = ${peer})
              OR (d.author_bot_id = ${peer} AND d.to_bot_id = ${me})))`,
      )
    }
    if (filter.from !== undefined) clauses.push(sql`d.created_at >= ${filter.from}`)
    if (filter.to !== undefined) clauses.push(sql`d.created_at <= ${filter.to}`)
    return clauses
  }

  /** Rows after `after` in its sort order (`p`: the column prefix). */
  const keyset = (after: SearchCursor, p = "") => {
    const createdAt = sql.literal(`${p}created_at`)
    const refId = sql.literal(`${p}ref_id`)
    return after.sort === "relevance"
      ? sql`(score > ${after.rank} OR (score = ${after.rank} AND (${createdAt} < ${after.createdAt}
          OR (${createdAt} = ${after.createdAt} AND ${refId} < ${after.refId}))))`
      : after.sort === "newest"
      ? sql`(${createdAt} < ${after.createdAt} OR (${createdAt} = ${after.createdAt} AND ${refId} < ${after.refId}))`
      : sql`(${createdAt} > ${after.createdAt} OR (${createdAt} = ${after.createdAt} AND ${refId} > ${after.refId}))`
  }

  /** The FTS tables that hold `kinds`: chat items, tool steps, or both. */
  const tablesFor = (kinds: ReadonlyArray<string>): ReadonlyArray<FtsTable> => [
    ...(kinds.some((kind) => kind !== "tool-call") ? ["search_fts" as const] : []),
    ...(kinds.includes("tool-call") ? ["search_steps_fts" as const] : []),
  ]

  /** `SELECT rowid` of every match in `tables`. */
  const matchIds = (tables: ReadonlyArray<FtsTable>, fts: string) =>
    tables
      .map((table) => sql`SELECT rowid FROM ${sql.literal(table)} WHERE ${sql.literal(table)} MATCH ${fts}`)
      .reduce((all, one) => sql`${all} UNION ALL ${one}`)

  /**
   * The best `wanted` matches by bm25 that the filter lets through. bm25 needs every match, so the
   * filter (a join per row) runs only on the best `k` of them, `k` growing until enough pass; past
   * `RELEVANCE_MAX_CANDIDATES` it runs on all of them.
   */
  const byRelevance = (tables: ReadonlyArray<FtsTable>, fts: string, query: SearchRepoQuery, wanted: number) =>
    Effect.gen(function*() {
      const after = query.after?.sort === "relevance" ? query.after : undefined
      const filters = sql.and(filterClauses(query))
      for (let k = Math.max(RELEVANCE_FIRST_CANDIDATES, wanted * 16); k <= RELEVANCE_MAX_CANDIDATES; k *= 8) {
        let complete = true
        const candidates: Array<{ readonly id: number; readonly score: number }> = []
        for (const table of tables) {
          const best = yield* sql<{ readonly id: number; readonly score: number }>`SELECT id, score FROM (
              SELECT rowid AS id, bm25(${sql.literal(table)}) AS score FROM ${sql.literal(table)}
              WHERE ${sql.literal(table)} MATCH ${fts}
            ) WHERE ${after === undefined ? sql`1` : sql`score >= ${after.rank}`} ORDER BY score LIMIT ${k}`
          if (best.length >= k) complete = false
          candidates.push(...best)
        }
        if (candidates.length === 0) return []
        const passed = yield* sql<{ readonly id: number; readonly created_at: number; readonly ref_id: string }>`SELECT d.id,
            d.created_at, d.ref_id FROM search_docs d WHERE ${sql.in("d.id", candidates.map((c) => c.id))} AND ${filters}`
        const keys = new Map(passed.map((row) => [row.id, row]))
        const rows: Array<SortRow> = []
        for (const { id, score } of candidates) {
          const row = keys.get(id)
          if (row === undefined) continue
          if (
            after !== undefined &&
            !(score > after.rank || (score === after.rank && (row.created_at < after.createdAt ||
              (row.created_at === after.createdAt && row.ref_id < after.refId))))
          ) continue
          rows.push({ id, created_at: row.created_at, ref_id: row.ref_id, score })
        }
        rows.sort((x, y) => x.score - y.score || y.created_at - x.created_at || (x.ref_id < y.ref_id ? 1 : x.ref_id > y.ref_id ? -1 : 0))
        // Enough passed, or every match was a candidate. (Each table's candidates are its best, so
        // anything better than the last row taken is among them.)
        if (rows.length >= wanted || complete) return rows.slice(0, wanted)
      }
      const scored = tables
        .map((table) =>
          sql`SELECT d.id, d.created_at, d.ref_id, bm25(${sql.literal(table)}) AS score
            FROM ${sql.literal(table)} JOIN search_docs d ON d.id = ${sql.literal(table)}.rowid
            WHERE ${sql.literal(table)} MATCH ${fts} AND ${filters}`
        )
        .reduce((all, one) => sql`${all} UNION ALL ${one}`)
      return yield* sql<SortRow>`SELECT id, created_at, ref_id, score FROM (${scored})
        WHERE ${after === undefined ? sql`1` : keyset(after)}
        ORDER BY score, created_at DESC, ref_id DESC LIMIT ${wanted}`
    })

  /** A task's report: its bot's first message in the task's chat at or after the task's time. */
  const reportOf = (row: DocRow) =>
    sql<{ readonly ref_id: string }>`SELECT ref_id FROM search_docs
      WHERE conversation_id = ${row.conversation_id} AND created_at >= ${row.created_at} AND source = 'entry'
        AND kind = 'message' AND author_bot_id = ${row.author_bot_id} AND hidden = 0
      ORDER BY created_at, ref_id LIMIT 1`.pipe(Effect.map((rows) => rows[0]?.ref_id))

  const DOC_COLUMNS = sql`d.id, d.source, d.ref_id, d.conversation_id, d.turn_id, d.kind, d.author_kind, d.author_bot_id,
    d.to_bot_id, d.created_at, d.text`

  const backfill = Effect.fn("SearchRepo.backfill")(function*(rebuild: boolean) {
    let indexed = 0
    let last = ""
    while (true) {
      const count = yield* Effect.gen(function*() {
        const rows = rebuild
          ? yield* sql<{ id: string; payload_json: string }>`SELECT id, payload_json FROM entries
              WHERE id > ${last} AND ${sql.in("kind", INDEXED_KINDS)} ORDER BY id LIMIT ${BACKFILL_BATCH}`
          : yield* sql<{ id: string; payload_json: string }>`SELECT e.id, e.payload_json FROM entries e
              WHERE e.id > ${last} AND ${sql.in("e.kind", INDEXED_KINDS)}
                AND NOT EXISTS (SELECT 1 FROM search_docs d WHERE d.ref_id = e.id)
              ORDER BY e.id LIMIT ${BACKFILL_BATCH}`
        for (const row of rows) {
          const entry = yield* Effect.option(EntryJson.decode("SearchRepo.ensure", row.payload_json, row.id))
          if (Option.isSome(entry)) {
            yield* indexEntry(sql, entry.value)
            indexed++
          }
        }
        if (rows.length > 0) last = rows[rows.length - 1]!.id
        return rows.length
      }).pipe(sql.withTransaction)
      if (count < BACKFILL_BATCH) break
    }
    last = ""
    while (true) {
      const count = yield* Effect.gen(function*() {
        const rows = rebuild
          ? yield* sql<{ id: string; payload_json: string }>`SELECT id, payload_json FROM tasks
              WHERE id > ${last} ORDER BY id LIMIT ${BACKFILL_BATCH}`
          : yield* sql<{ id: string; payload_json: string }>`SELECT t.id, t.payload_json FROM tasks t
              WHERE t.id > ${last} AND NOT EXISTS (SELECT 1 FROM search_docs d WHERE d.ref_id = t.id)
              ORDER BY t.id LIMIT ${BACKFILL_BATCH}`
        for (const row of rows) {
          const task = yield* Effect.option(TaskJson.decode("SearchRepo.ensure", row.payload_json, row.id))
          if (Option.isSome(task)) {
            yield* indexTask(sql, task.value)
            indexed++
          }
        }
        if (rows.length > 0) last = rows[rows.length - 1]!.id
        return rows.length
      }).pipe(sql.withTransaction)
      if (count < BACKFILL_BATCH) break
    }
    return indexed
  })

  const ensure: Effect.Effect<SearchIndexReport, unknown> = Effect.gen(function*() {
    const started = yield* Clock.currentTimeMillis
    const rebuild = (yield* storedVersion) !== String(SEARCH_TEXT_VERSION)
    if (rebuild) {
      yield* Ref.set(indexing, true)
      yield* sql`DELETE FROM search_docs`
    }
    const indexed = yield* backfill(rebuild)
    if (rebuild) {
      yield* sql`INSERT INTO search_fts (search_fts) VALUES ('optimize')`
      yield* sql`INSERT INTO search_steps_fts (search_steps_fts) VALUES ('optimize')`
      yield* sql`INSERT INTO settings (key, value_json) VALUES (${SEARCH_VERSION_KEY}, ${String(SEARCH_TEXT_VERSION)})
        ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`
    }
    yield* Ref.set(indexing, false)
    return { rebuilt: rebuild, indexed, ms: (yield* Clock.currentTimeMillis) - started }
  })

  return SearchRepo.of({
    query: (query) =>
      Effect.gen(function*() {
        const size = Math.max(0, Math.floor(query.limit))
        const tables = tablesFor(query.kinds)
        if (tables.length === 0) return { hits: [], next: undefined, total: 0 }
        const fts = toFtsQuery(query.match)
        const filters = filterClauses(query)
        const rows = query.sort === "relevance"
          ? yield* byRelevance(tables, fts, query, size + 1)
          : yield* sql<SortRow>`SELECT d.id, d.created_at, d.ref_id, 0 AS score
              FROM search_docs d INDEXED BY search_docs_created
              WHERE d.id IN (${matchIds(tables, fts)})
                AND ${sql.and([...filters, ...(query.after === undefined ? [] : [keyset(query.after, "d.")])])}
              ORDER BY ${query.sort === "newest" ? sql`d.created_at DESC, d.ref_id DESC` : sql`d.created_at, d.ref_id`}
              LIMIT ${size + 1}`
        const page = rows.slice(0, size)
        const ids = page.map((row) => row.id)
        const docs = ids.length === 0 ? [] : yield* sql<DocRow & { readonly id: number }>`SELECT ${DOC_COLUMNS}
          FROM search_docs d WHERE ${sql.in("d.id", ids)}`
        const docOf = new Map(docs.map((row) => [row.id, row]))
        const cap = query.totalCap ?? SEARCH_TOTAL_CAP
        let total = 0
        // a first page that holds every match is the count
        if (query.after === undefined && rows.length <= size) total = Math.min(rows.length, cap)
        else for (const table of tables) {
          const counted = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM (
              SELECT 1 FROM ${sql.literal(table)} JOIN search_docs d ON d.id = ${sql.literal(table)}.rowid
              WHERE ${sql.literal(table)} MATCH ${fts} AND ${sql.and(filters)} LIMIT ${cap - total}
            )`
          total += counted[0]?.n ?? 0
          if (total >= cap) break
        }
        const hits: Array<SearchRepoHit> = []
        for (const { id, score } of page) {
          const row = docOf.get(id)
          if (row === undefined) continue
          const jump = row.source === "task" ? yield* reportOf(row) : undefined
          hits.push({
            doc: docOfRow(row),
            rank: score,
            snippet: makeSnippet(row.text, query.match),
            ...(jump === undefined ? {} : { jumpEntryId: jump as EntryId }),
          })
        }
        const lastRow = page[page.length - 1]
        const next: SearchCursor | undefined = rows.length > size && lastRow !== undefined
          ? query.sort === "relevance"
            ? { sort: "relevance", rank: lastRow.score, createdAt: lastRow.created_at, refId: lastRow.ref_id }
            : { sort: query.sort, createdAt: lastRow.created_at, refId: lastRow.ref_id }
          : undefined
        return { hits, next, total }
      }).pipe(repoOp("SearchRepo.query")),

    positions: (query) =>
      Effect.gen(function*() {
        const size = Math.max(0, Math.floor(query.limit))
        const clauses = [
          sql`d.source = 'entry'`,
          sql`d.conversation_id = ${query.conversationId}`,
          ...filterClauses(query),
        ]
        let rows: ReadonlyArray<{ readonly ref_id: string; readonly created_at: number }>
        const tables = tablesFor(query.kinds)
        if (tables.length === 0) rows = []
        else if (query.match !== undefined) {
          rows = yield* sql<{ ref_id: string; created_at: number }>`SELECT d.ref_id, d.created_at
            FROM search_docs d INDEXED BY search_docs_conversation
            WHERE d.id IN (${matchIds(tables, toFtsQuery(query.match))}) AND ${sql.and(clauses)}
            ORDER BY d.created_at DESC, d.ref_id DESC LIMIT ${size + 1}`
        } else if (query.substring !== undefined && query.substring !== "") {
          rows = yield* sql<{ ref_id: string; created_at: number }>`SELECT d.ref_id, d.created_at
            FROM search_docs d INDEXED BY search_docs_conversation
            WHERE ${sql.and(clauses)} AND instr(lower(d.text), lower(${query.substring})) > 0
            ORDER BY d.created_at DESC, d.ref_id DESC LIMIT ${size + 1}`
        } else rows = []
        const kept = rows.slice(0, size).reverse()
        return {
          hits: kept.map((row) => ({ entryId: row.ref_id as never, createdAt: row.created_at as Millis })),
          more: rows.length > size,
        }
      }).pipe(repoOp("SearchRepo.positions")),

    ensure: ensure.pipe(repoOp("SearchRepo.ensure")),
    indexing: Ref.get(indexing),
  })
})

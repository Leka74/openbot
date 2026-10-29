/**
 * Message search on SQLite: migration 0004 over a database written by an older release and the
 * boot backfill (`SearchRepo.ensure`), the FTS index staying in step with `search_docs`, rebuilds
 * when the text version changes, and any query text never reaching SQLite as FTS syntax.
 */
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { KnownTranscriptEntry, MAIN_PROFILE_ID, Task } from "@openbot/contracts"
import {
  BotRepo,
  ConversationRepo,
  EntryRepo,
  parseSearchQuery,
  type SearchCursor,
  SearchRepo,
  SEARCH_TEXT_VERSION,
  TaskRepo,
} from "@openbot/core"
import {
  botId,
  conversationId,
  entryId,
  makeBot,
  makeDirectConversation,
  makeEventEntry,
  makeMessageEntry,
  makeTask,
  makeToolCallEntry,
  taskId,
} from "@openbot/core/testing"
import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Fiber, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { join } from "node:path"
import Initial from "../src/migrations/0001_initial.ts"
import OneMind from "../src/migrations/0002_one_mind_per_bot.ts"
import BackgroundTasks from "../src/migrations/0003_background_tasks.ts"
import { SEARCH_VERSION_KEY } from "../src/index.ts"
import { cleanupTempDirs, run, tempDataDir, testPersistence } from "./helpers.ts"

afterAll(cleanupTempDirs)

const encodeEntry = Schema.encodeSync(Schema.fromJsonString(KnownTranscriptEntry))
const encodeTask = Schema.encodeSync(Schema.fromJsonString(Task))
const A = botId("bot_a")
const dm = conversationId("cnv_a")

const integrity = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO search_fts (search_fts, rank) VALUES ('integrity-check', 1)`
  yield* sql`INSERT INTO search_steps_fts (search_steps_fts, rank) VALUES ('integrity-check', 1)`
})

/** Rows of both FTS indexes matching `fts`. */
const ftsCount = (fts: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const a = yield* sql<{ n: number }>`SELECT count(*) AS n FROM search_fts WHERE search_fts MATCH ${fts}`
    const b = yield* sql<{ n: number }>`SELECT count(*) AS n FROM search_steps_fts WHERE search_steps_fts MATCH ${fts}`
    return a[0]!.n + b[0]!.n
  })

const count = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ n: number }>`SELECT count(*) AS n FROM ${sql(table)}`
    return rows[0]!.n
  })

describe("0004_message_search", () => {
  test("a 0003 database gains the index; the boot backfill indexes what is stored, once", async () => {
    const dir = await tempDataDir()
    const entries = [
      makeMessageEntry({
        id: entryId("ent_1"),
        conversationId: dm,
        createdAt: 1,
        text: "the migration waits for Lekë",
      }),
      makeMessageEntry({
        id: entryId("ent_2"),
        conversationId: dm,
        createdAt: 2,
        role: "bot",
        author: { kind: "bot", botId: A },
        text: "half",
        streaming: true,
      }),
      makeToolCallEntry({
        id: entryId("ent_3"),
        conversationId: dm,
        createdAt: 3,
        author: { kind: "bot", botId: A },
        inputSummary: "git log migration",
        status: "completed",
      }),
      makeEventEntry({
        id: entryId("ent_4"),
        conversationId: dm,
        createdAt: 4,
        event: { type: "auto-decided", decision: "allowed", summary: "ls" },
      }),
    ]
    // a database as an older release left it
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* SqliteMigrator.run({
          loader: SqliteMigrator.fromRecord({
            "0001_initial": Initial,
            "0002_one_mind_per_bot": OneMind,
            "0003_background_tasks": BackgroundTasks,
          }),
        })
        const sql = yield* SqlClient.SqlClient
        for (const entry of entries) {
          yield* sql`INSERT INTO entries (id, conversation_id, revision, created_at, kind, payload_json)
            VALUES (${entry.id}, ${entry.conversationId}, 0, ${entry.createdAt}, ${entry.kind}, ${encodeEntry(entry)})`
        }
        const task = makeTask({
          id: taskId("tsk_1"),
          botId: A,
          conversationId: dm,
          title: "Migration check",
          result: "fine",
          endedAt: 9,
        })
        yield* sql`INSERT INTO tasks (id, bot_id, conversation_id, status, created_at, payload_json)
          VALUES (${task.id}, ${task.botId}, ${task.conversationId}, 'succeeded', 0, ${encodeTask(task)})`
      }).pipe(Effect.provide(SqliteClient.layer({ filename: join(dir, "openbot.sqlite") }))),
    )

    const out = await run(
      Effect.gen(function* () {
        const search = yield* SearchRepo
        yield* (yield* BotRepo).upsert(makeBot({ id: A }))
        yield* (yield* ConversationRepo).upsert(makeDirectConversation({ id: dm, botId: A }))
        const before = { indexing: yield* search.indexing, docs: yield* count("search_docs") }
        const first = yield* search.ensure
        const after = { indexing: yield* search.indexing, docs: yield* count("search_docs") }
        yield* integrity
        const sql = yield* SqlClient.SqlClient
        const chatIndex = yield* sql<{
          n: number
        }>`SELECT count(*) AS n FROM search_fts WHERE search_fts MATCH 'migration'`
        const stepsIndex = yield* sql<{
          n: number
        }>`SELECT count(*) AS n FROM search_steps_fts WHERE search_steps_fts MATCH 'migration'`
        const page = yield* search.query({
          scope: { kind: "owner", profileId: MAIN_PROFILE_ID },
          match: parseSearchQuery("migration ")!,
          kinds: ["message", "tool-call", "task"],
          sort: "oldest",
          limit: 10,
        })
        const second = yield* search.ensure
        const version = yield* sql<{
          value_json: string
        }>`SELECT value_json FROM settings WHERE key = ${SEARCH_VERSION_KEY}`
        return {
          before,
          first,
          after,
          split: [chatIndex[0]!.n, stepsIndex[0]!.n],
          refs: page.hits.map((h) => h.doc.refId),
          second,
          version: version[0]?.value_json,
        }
      }),
      testPersistence(dir),
    )
    expect(out.before).toEqual({ indexing: true, docs: 0 })
    expect(out.first).toMatchObject({ rebuilt: true, indexed: 5 })
    // the streaming message and the audit line have no doc
    expect(out.after).toEqual({ indexing: false, docs: 3 })
    expect(out.refs).toEqual(["ent_1", "ent_3", "tsk_1"])
    // chat items and tool steps are indexed apart
    expect(out.split).toEqual([2, 1])
    expect(out.version).toBe(String(SEARCH_TEXT_VERSION))
    // next boot: nothing was written since without its doc
    expect(out.second).toMatchObject({ rebuilt: false, indexed: 0 })
  })

  test("a new text version rebuilds the index", async () => {
    const dir = await tempDataDir()
    const out = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const search = yield* SearchRepo
        const repo = yield* EntryRepo
        yield* search.ensure
        for (let i = 0; i < 1_200; i++) {
          yield* repo.upsert(
            makeMessageEntry({
              id: entryId(`ent_${String(i).padStart(5, "0")}`),
              conversationId: dm,
              createdAt: i,
              text: `heron number ${i}`,
            }),
          )
        }
        yield* sql`UPDATE settings SET value_json = '0' WHERE key = ${SEARCH_VERSION_KEY}`
        yield* sql`UPDATE search_docs SET text = 'stale words' WHERE ref_id = 'ent_00007'`
        const report = yield* search.ensure
        yield* integrity
        const stale = yield* sql<{ n: number }>`SELECT count(*) AS n FROM search_docs WHERE text = 'stale words'`
        return { report, docs: yield* count("search_docs"), stale: stale[0]!.n }
      }),
      testPersistence(dir),
    )
    expect(out.report).toMatchObject({ rebuilt: true, indexed: 1_200 })
    expect(out.docs).toBe(1_200)
    expect(out.stale).toBe(0)
  })

  test("entries written while a rebuild runs, between its batches, stay indexed", async () => {
    const dir = await tempDataDir()
    const total = 2_000
    const out = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const search = yield* SearchRepo
        const repo = yield* EntryRepo
        yield* (yield* BotRepo).upsert(makeBot({ id: A }))
        yield* (yield* ConversationRepo).upsert(makeDirectConversation({ id: dm, botId: A }))
        yield* search.ensure
        const id = (i: number) => entryId(`ent_${String(i).padStart(5, "0")}`)
        for (let i = 0; i < total; i++) {
          yield* repo.upsert(
            makeMessageEntry({ id: id(i), conversationId: dm, createdAt: i, text: `heron number ${i}` }),
          )
        }
        yield* sql`UPDATE settings SET value_json = '0' WHERE key = ${SEARCH_VERSION_KEY}`
        const rebuild = yield* Effect.forkChild(search.ensure)
        // Wait until the first batches are in, then write: an entry the rebuild has passed, one it
        // has yet to read, and a new one. (Queries wait for a batch's transaction to end.)
        let docsWhenWritten = 0
        for (let polls = 0; docsWhenWritten === 0 && polls < 10_000; polls++) {
          const docs = yield* count("search_docs")
          if (docs > 0 && docs < total) {
            docsWhenWritten = docs
            yield* repo.upsert(
              makeMessageEntry({ id: id(7), revision: 1, conversationId: dm, createdAt: 7, text: "egret passed" }),
            )
            yield* repo.upsert(
              makeMessageEntry({
                id: id(total - 3),
                revision: 1,
                conversationId: dm,
                createdAt: total - 3,
                text: "egret ahead",
              }),
            )
            yield* repo.upsert(
              makeMessageEntry({ id: id(total + 5), conversationId: dm, createdAt: total + 5, text: "egret new" }),
            )
          }
          yield* Effect.yieldNow
        }
        const report = yield* Fiber.join(rebuild)
        yield* integrity
        const egrets = yield* search.query({
          scope: { kind: "owner", profileId: MAIN_PROFILE_ID },
          match: parseSearchQuery("egret")!,
          kinds: ["message"],
          sort: "oldest",
          limit: 10,
        })
        return {
          docsWhenWritten,
          report,
          docs: yield* count("search_docs"),
          egrets: egrets.hits.map((hit) => hit.doc.text),
          herons: yield* ftsCount("heron"),
        }
      }),
      testPersistence(dir),
    )
    // the writes landed mid-rebuild
    expect(out.docsWhenWritten).toBeGreaterThan(0)
    expect(out.docsWhenWritten).toBeLessThan(total)
    expect(out.report).toMatchObject({ rebuilt: true })
    expect(out.docs).toBe(total + 1)
    expect(out.egrets).toEqual(["egret passed", "egret ahead", "egret new"])
    expect(out.herons).toBe(total - 2)
  })

  test("after a rollback, what the older release wrote or changed is indexed at the next boot", async () => {
    const dir = await tempDataDir()
    const out = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const search = yield* SearchRepo
        const repo = yield* EntryRepo
        const tasks = yield* TaskRepo
        yield* (yield* BotRepo).upsert(makeBot({ id: A }))
        yield* (yield* ConversationRepo).upsert(makeDirectConversation({ id: dm, botId: A }))
        yield* search.ensure
        const first = makeMessageEntry({
          id: entryId("ent_1"),
          conversationId: dm,
          createdAt: 1,
          text: "priorword stays",
        })
        const second = makeMessageEntry({
          id: entryId("ent_2"),
          conversationId: dm,
          createdAt: 2,
          text: "priorword goes",
        })
        const task = makeTask({
          id: taskId("tsk_1"),
          botId: A,
          conversationId: dm,
          title: "Audit",
          status: "running",
          createdAt: 3,
        })
        yield* repo.upsert(first)
        yield* repo.upsert(second)
        yield* tasks.upsert(task)

        // the older release (0003's writers: no search docs, no search_rev) edits, adds and finishes work
        const oldEntryWrite = (entry: KnownTranscriptEntry) =>
          sql`INSERT INTO entries (id, conversation_id, revision, created_at, kind, turn_id, client_nonce, native_id, payload_json)
            VALUES (${entry.id}, ${entry.conversationId}, ${entry.revision}, ${entry.createdAt}, ${entry.kind}, NULL, NULL, NULL, ${encodeEntry(entry)})
            ON CONFLICT (id) DO UPDATE SET conversation_id = excluded.conversation_id, revision = excluded.revision,
              kind = excluded.kind, turn_id = excluded.turn_id, client_nonce = excluded.client_nonce,
              native_id = excluded.native_id, payload_json = excluded.payload_json`
        yield* oldEntryWrite({ ...second, revision: 1, text: "replacementword now" } as KnownTranscriptEntry)
        yield* oldEntryWrite(
          makeMessageEntry({ id: entryId("ent_3"), conversationId: dm, createdAt: 4, text: "addedword later" }),
        )
        const finished = { ...task, status: "succeeded" as const, result: "resultword found", endedAt: 5 }
        yield* sql`INSERT INTO tasks (id, bot_id, conversation_id, status, created_at, payload_json)
          VALUES (${finished.id}, ${finished.botId}, ${finished.conversationId}, ${finished.status}, ${finished.createdAt}, ${encodeTask(finished)})
          ON CONFLICT (id) DO UPDATE SET bot_id = excluded.bot_id, conversation_id = excluded.conversation_id,
            status = excluded.status, created_at = excluded.created_at, payload_json = excluded.payload_json`

        const report = yield* search.ensure
        yield* integrity
        const hits = (words: string) =>
          search
            .query({
              scope: { kind: "owner", profileId: MAIN_PROFILE_ID },
              match: parseSearchQuery(words)!,
              kinds: ["message", "task"],
              sort: "oldest",
              limit: 10,
            })
            .pipe(Effect.map((page) => page.hits.map((hit) => hit.doc.refId)))
        return {
          report,
          prior: yield* hits("priorword"),
          replacement: yield* hits("replacementword"),
          added: yield* hits("addedword"),
          result: yield* hits("resultword"),
          again: yield* search.ensure,
        }
      }),
      testPersistence(dir),
    )
    expect(out.report).toMatchObject({ rebuilt: false, indexed: 3 })
    expect(out.prior).toEqual(["ent_1"])
    expect(out.replacement).toEqual(["ent_2"])
    expect(out.added).toEqual(["ent_3"])
    expect(out.result).toEqual(["tsk_1"])
    expect(out.again).toMatchObject({ rebuilt: false, indexed: 0 })
  })

  test("relevance paging reaches every match, however many share a score", async () => {
    const dir = await tempDataDir()
    const total = 600
    const out = await run(
      Effect.gen(function* () {
        const search = yield* SearchRepo
        const repo = yield* EntryRepo
        yield* (yield* BotRepo).upsert(makeBot({ id: A }))
        yield* (yield* ConversationRepo).upsert(makeDirectConversation({ id: dm, botId: A }))
        yield* search.ensure
        for (let i = 1; i <= total; i++) {
          yield* repo.upsert(
            makeMessageEntry({
              id: entryId(`ent_${String(i).padStart(4, "0")}`),
              conversationId: dm,
              createdAt: i,
              text: "same heron words",
            }),
          )
        }
        const seen: Array<string> = []
        let after: SearchCursor | undefined
        for (let pages = 0; pages < 100; pages++) {
          const page = yield* search.query({
            scope: { kind: "owner", profileId: MAIN_PROFILE_ID },
            match: parseSearchQuery("heron")!,
            kinds: ["message"],
            sort: "relevance",
            limit: 20,
            ...(after === undefined ? {} : { after }),
          })
          seen.push(...page.hits.map((hit) => hit.doc.refId))
          if (page.next === undefined) break
          after = page.next
        }
        return seen
      }),
      testPersistence(dir),
    )
    // tied scores: newest first, every one of them once
    expect(out[0]).toBe("ent_0600")
    expect(out.length).toBe(total)
    expect(new Set(out).size).toBe(total)
  })

  test("the FTS index follows inserts, edits, deletes and repeated revisions", async () => {
    const dir = await tempDataDir()
    const out = await run(
      Effect.gen(function* () {
        const repo = yield* EntryRepo
        const tasks = yield* TaskRepo
        const sql = yield* SqlClient.SqlClient
        for (let revision = 0; revision < 30; revision++) {
          yield* repo.upsert(
            makeMessageEntry({
              id: entryId("ent_s"),
              conversationId: dm,
              revision,
              createdAt: 1,
              text: "stream ".repeat(revision + 1),
              streaming: revision < 29,
            }),
          )
        }
        const afterStream = yield* sql<{ text: string }>`SELECT text FROM search_docs WHERE ref_id = 'ent_s'`
        // a reaction-only revision leaves the doc row untouched
        const changesBefore = yield* sql<{ n: number }>`SELECT total_changes() AS n`
        yield* repo.upsert(
          makeMessageEntry({
            id: entryId("ent_s"),
            conversationId: dm,
            revision: 30,
            createdAt: 1,
            text: "stream ".repeat(30),
            reactions: [{ emoji: "👍", by: { kind: "system" } }],
          }),
        )
        const changesAfter = yield* sql<{ n: number }>`SELECT total_changes() AS n`
        yield* tasks.upsert(makeTask({ id: taskId("tsk_x"), botId: A, conversationId: dm, title: "egret" }))
        yield* tasks.upsert(
          makeTask({
            id: taskId("tsk_x"),
            botId: A,
            conversationId: dm,
            title: "egret",
            progress: "Running a command",
          }),
        )
        yield* tasks.delete(taskId("tsk_x"))
        yield* repo.remove(entryId("ent_s"))
        yield* integrity
        return {
          streamed: afterStream[0]?.text.split(" ").length,
          // the entry row itself changes; the doc does not
          reactionChanges: changesAfter[0]!.n - changesBefore[0]!.n,
          docs: yield* count("search_docs"),
          fts: yield* ftsCount("stream OR egret"),
        }
      }),
      testPersistence(dir),
    )
    expect(out.streamed).toBe(30)
    expect(out.reactionChanges).toBe(1)
    expect(out.docs).toBe(0)
    expect(out.fts).toBe(0)
  })

  test("no input reaches SQLite as FTS syntax (nothing fails)", async () => {
    const dir = await tempDataDir()
    const inputs = [
      '"',
      '"""',
      'a"b"c',
      "NEAR(a b)",
      "a OR b",
      "a AND",
      "NOT a",
      "-",
      "--a",
      "col:val",
      "text:x",
      "^a",
      "a*b*",
      "*a",
      "(",
      ")",
      "{a b}",
      "a + b",
      "'; DROP TABLE search_docs; --",
      "\u0000",
      "\u0002x\u0003",
      "🙂 emoji 🙂",
      "ẞtraße",
      "日本語のテキスト",
      "x".repeat(3_000),
      Array.from({ length: 60 }, (_, i) => `w${i}`).join(" "),
    ]
    const results = await run(
      Effect.gen(function* () {
        const repo = yield* EntryRepo
        const search = yield* SearchRepo
        yield* (yield* BotRepo).upsert(makeBot({ id: A }))
        yield* (yield* ConversationRepo).upsert(makeDirectConversation({ id: dm, botId: A }))
        yield* repo.upsert(
          makeMessageEntry({
            id: entryId("ent_1"),
            conversationId: dm,
            createdAt: 1,
            text: "a b c NEAR text val 日本語のテキスト emoji",
          }),
        )
        const out: Array<number> = []
        for (const input of inputs) {
          const match = parseSearchQuery(input)
          if (match === undefined) continue
          for (const sort of ["relevance", "newest"] as const) {
            const page = yield* search.query({
              scope: { kind: "bot", botId: A },
              match,
              kinds: ["message"],
              sort,
              limit: 5,
            })
            out.push(page.hits.length)
          }
          yield* search.positions({
            scope: { kind: "owner", profileId: MAIN_PROFILE_ID },
            conversationId: dm,
            match,
            kinds: ["message"],
            limit: 5,
          })
          yield* search.positions({
            scope: { kind: "owner", profileId: MAIN_PROFILE_ID },
            conversationId: dm,
            substring: input,
            kinds: ["message"],
            limit: 5,
          })
        }
        return out
      }),
      testPersistence(dir),
    )
    expect(results.length).toBeGreaterThan(20)
  })
})

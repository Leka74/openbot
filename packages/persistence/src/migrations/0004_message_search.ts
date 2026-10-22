/**
 * Message search: `search_docs` holds one row per searchable item (an entry of a chat, or a task's
 * brief and result) with its normalized text and the columns searches filter on; two FTS5 indexes
 * over that text: `search_fts` (messages, cards, event lines, notices, tasks) and `search_steps_fts`
 * (tool steps).
 *
 * The repositories keep `search_docs` up to date as they write (core's `searchDocOfEntry` /
 * `searchDocOfTask` derive the text); the triggers below keep the FTS indexes in step with it and
 * drop the docs of deleted entries and tasks, whoever deletes them. The rows of what is already
 * stored are written at boot, in the background (`SearchRepo.ensure`).
 *
 * Tokenizer `unicode61 remove_diacritics 2`: "Leke" finds "Lekë"; no stemming (the chats mix
 * languages). `prefix='2 3'` keeps type-ahead prefix queries cheap.
 */
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE search_docs (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    ref_id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL,
    turn_id TEXT,
    kind TEXT NOT NULL,
    author_kind TEXT NOT NULL,
    author_bot_id TEXT,
    to_bot_id TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    text TEXT NOT NULL,
    text_version INTEGER NOT NULL
  )`
  yield* sql`CREATE INDEX search_docs_conversation ON search_docs (conversation_id, created_at, ref_id)`
  yield* sql`CREATE INDEX search_docs_created ON search_docs (created_at, ref_id)`
  yield* sql`CREATE INDEX search_docs_author_bot ON search_docs (author_bot_id, created_at) WHERE author_bot_id IS NOT NULL`
  yield* sql`CREATE INDEX search_docs_to_bot ON search_docs (to_bot_id, created_at) WHERE to_bot_id IS NOT NULL`
  yield* sql`CREATE INDEX search_docs_turn ON search_docs (turn_id) WHERE turn_id IS NOT NULL`

  // Chat items and tool steps get separate indexes: a search without steps (the default) never
  // ranks or scans tool output. Contentless (the text is in `search_docs`); deletable.
  for (const table of ["search_fts", "search_steps_fts"]) {
    yield* sql.unsafe(`CREATE VIRTUAL TABLE ${table} USING fts5(
      text,
      content = '',
      contentless_delete = 1,
      tokenize = 'unicode61 remove_diacritics 2',
      prefix = '2 3'
    )`)
  }

  yield* sql`CREATE TRIGGER search_docs_ai AFTER INSERT ON search_docs BEGIN
    INSERT INTO search_fts (rowid, text) SELECT new.id, new.text WHERE new.kind <> 'tool-call';
    INSERT INTO search_steps_fts (rowid, text) SELECT new.id, new.text WHERE new.kind = 'tool-call';
  END`
  yield* sql`CREATE TRIGGER search_docs_ad AFTER DELETE ON search_docs BEGIN
    DELETE FROM search_fts WHERE rowid = old.id;
    DELETE FROM search_steps_fts WHERE rowid = old.id;
  END`
  yield* sql`CREATE TRIGGER search_docs_au AFTER UPDATE OF text, kind ON search_docs BEGIN
    DELETE FROM search_fts WHERE rowid = old.id;
    DELETE FROM search_steps_fts WHERE rowid = old.id;
    INSERT INTO search_fts (rowid, text) SELECT new.id, new.text WHERE new.kind <> 'tool-call';
    INSERT INTO search_steps_fts (rowid, text) SELECT new.id, new.text WHERE new.kind = 'tool-call';
  END`

  // Deleted entries and tasks leave the index (a deleted group's transcript, a deleted bot's tasks).
  yield* sql`CREATE TRIGGER entries_search_ad AFTER DELETE ON entries BEGIN
    DELETE FROM search_docs WHERE ref_id = old.id;
  END`
  yield* sql`CREATE TRIGGER tasks_search_ad AFTER DELETE ON tasks BEGIN
    DELETE FROM search_docs WHERE ref_id = old.id;
  END`
})

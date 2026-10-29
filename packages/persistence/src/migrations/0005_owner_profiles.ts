/**
 * Owner profiles: the owner switches between profiles, each with its own Bots (and through them their
 * chats, memory, routines and tasks), sections, rules, attachments and settings. Computers and harness
 * logins stay shared.
 *
 * Everything stored so far belongs to the main profile (`prf_main`): the new `owner_profile_id`
 * columns default to it. `settings` and `approval_rules` stay the main profile's (settings also the
 * brain's) so an older release still reads and writes them and never applies another profile's rules
 * to the main profile's Bots; the other profiles' are in `profile_settings` and `profile_approval_rules`.
 * Nothing moves on disk.
 */
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE owner_profiles (
    id TEXT PRIMARY KEY NOT NULL,
    created_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  )`
  const now = Date.now()
  yield* sql`INSERT INTO owner_profiles (id, created_at, payload_json)
    VALUES ('prf_main', ${now}, json_object('id', 'prf_main', 'name', 'Main', 'createdAt', ${now}))`

  for (const table of ["bots", "sections", "attachments"]) {
    yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN owner_profile_id TEXT NOT NULL DEFAULT 'prf_main'`)
    yield* sql.unsafe(`CREATE INDEX ${table}_owner_profile ON ${table} (owner_profile_id)`)
  }

  yield* sql`CREATE TABLE profile_settings (
    owner_profile_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    PRIMARY KEY (owner_profile_id, key)
  )`
  yield* sql`CREATE TABLE profile_approval_rules (
    id TEXT PRIMARY KEY NOT NULL,
    owner_profile_id TEXT NOT NULL,
    bot_id TEXT,
    created_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  )`
  yield* sql`CREATE INDEX profile_approval_rules_owner_profile ON profile_approval_rules (owner_profile_id)`
})

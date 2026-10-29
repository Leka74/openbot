/**
 * Held notifications: a profile that isn't active keeps running, but its notifications wait in
 * `held_notifications` for its "While you were away" view instead of being shown or pushed.
 * `away_state` keeps, per profile, when the owner last left it and how many held items were dropped
 * past the cap.
 */
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE held_notifications (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    owner_profile_id TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`
  yield* sql`CREATE INDEX held_notifications_profile ON held_notifications (owner_profile_id, seq)`
  yield* sql`CREATE TABLE away_state (
    owner_profile_id TEXT PRIMARY KEY NOT NULL,
    left_at INTEGER,
    dropped INTEGER NOT NULL DEFAULT 0
  )`
})

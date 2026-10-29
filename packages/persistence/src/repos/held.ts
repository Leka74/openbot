/** `HeldNotificationRepo` over SQLite. */
import { HeldNotification, type Millis } from "@openbot/contracts"
import { HeldNotificationRepo } from "@openbot/core"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { jsonCodec, repoOp } from "../codec.ts"

interface HeldRow {
  readonly id: string
  readonly payload_json: string
}

interface AwayRow {
  readonly left_at: Millis | null
  readonly dropped: number
}

const HeldJson = jsonCodec(HeldNotification, "held notification")

export const makeSqlHeldNotificationRepo = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return HeldNotificationRepo.of({
    hold: (profileId, held, cap) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const payload = yield* HeldJson.encode("HeldNotificationRepo.hold", held)
            yield* sql`INSERT INTO held_notifications (id, owner_profile_id, payload_json)
              VALUES (${held.notification.id}, ${profileId}, ${payload})`
            const over = yield* sql<{ readonly seq: number }>`SELECT seq FROM held_notifications
              WHERE owner_profile_id = ${profileId} ORDER BY seq DESC LIMIT -1 OFFSET ${cap}`
            const newest = over[0]
            if (newest === undefined) return
            yield* sql`DELETE FROM held_notifications
              WHERE owner_profile_id = ${profileId} AND seq <= ${newest.seq}`
            yield* sql`INSERT INTO away_state (owner_profile_id, dropped) VALUES (${profileId}, ${over.length})
              ON CONFLICT (owner_profile_id) DO UPDATE SET dropped = dropped + excluded.dropped`
          }),
        )
        .pipe(repoOp("HeldNotificationRepo.hold")),
    summary: (profileId) =>
      Effect.gen(function* () {
        const rows = yield* sql<HeldRow>`SELECT id, payload_json FROM held_notifications
          WHERE owner_profile_id = ${profileId} ORDER BY seq`
        const items = yield* Effect.forEach(rows, (row) =>
          HeldJson.decode("HeldNotificationRepo.summary", row.payload_json, row.id),
        )
        const state = (yield* sql<AwayRow>`SELECT left_at, dropped FROM away_state
          WHERE owner_profile_id = ${profileId}`)[0]
        return {
          ...(state?.left_at == null ? {} : { since: state.left_at }),
          items,
          dropped: state?.dropped ?? 0,
        }
      }).pipe(repoOp("HeldNotificationRepo.summary")),
    dismiss: (profileId, through) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const found = (yield* sql<{ readonly seq: number }>`SELECT seq FROM held_notifications
              WHERE owner_profile_id = ${profileId} AND id = ${through}`)[0]
            if (found === undefined) return
            yield* sql`DELETE FROM held_notifications
              WHERE owner_profile_id = ${profileId} AND seq <= ${found.seq}`
            yield* sql`UPDATE away_state SET dropped = 0 WHERE owner_profile_id = ${profileId}`
          }),
        )
        .pipe(repoOp("HeldNotificationRepo.dismiss")),
    markLeft: (profileId, at) =>
      sql`INSERT INTO away_state (owner_profile_id, left_at) VALUES (${profileId}, ${at})
        ON CONFLICT (owner_profile_id) DO UPDATE SET left_at = excluded.left_at`.pipe(
        Effect.asVoid,
        repoOp("HeldNotificationRepo.markLeft"),
      ),
  })
})

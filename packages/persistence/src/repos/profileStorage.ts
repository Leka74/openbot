/** `ProfileStorage` over SQLite: a deleted profile's leftover rows, in one transaction. */
import { ProfileStorage } from "@openbot/core"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { repoOp } from "../codec.ts"

export const makeSqlProfileStorage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return ProfileStorage.of({
    purge: (profileId, gone) =>
      Effect.gen(function* () {
        for (const table of [
          "sections",
          "profile_approval_rules",
          "attachments",
          "profile_settings",
          "held_notifications",
        ])
          yield* sql.unsafe(`DELETE FROM ${table} WHERE owner_profile_id = ?`, [profileId])
        yield* sql`DELETE FROM away_state WHERE owner_profile_id = ${profileId}`
        const named = [...gone.botIds, ...gone.conversationIds].map((id) => JSON.stringify(id))
        if (named.length > 0) {
          yield* sql`DELETE FROM settings WHERE (key LIKE 'brain.botNonce.%' OR key LIKE 'brain.groupNonce.%')
            AND ${sql.in("value_json", named)}`
        }
      }).pipe(sql.withTransaction, repoOp("ProfileStorage.purge")),
  })
})

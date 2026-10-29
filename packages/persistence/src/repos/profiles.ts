/** `OwnerProfileRepo` over SQLite. */
import { OwnerProfile } from "@openbot/contracts"
import { OwnerProfileRepo } from "@openbot/core"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { jsonCodec, repoOp } from "../codec.ts"

interface PayloadRow {
  readonly id: string
  readonly payload_json: string
}

const ProfileJson = jsonCodec(OwnerProfile, "owner profile")

export const makeSqlOwnerProfileRepo = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return OwnerProfileRepo.of({
    list: Effect.gen(function* () {
      const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM owner_profiles ORDER BY created_at, rowid`
      return yield* Effect.forEach(rows, (row) => ProfileJson.decode("OwnerProfileRepo.list", row.payload_json, row.id))
    }).pipe(repoOp("OwnerProfileRepo.list")),
    get: (id) =>
      Effect.gen(function* () {
        const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM owner_profiles WHERE id = ${id}`
        const row = rows[0]
        return row === undefined
          ? Option.none()
          : Option.some(yield* ProfileJson.decode("OwnerProfileRepo.get", row.payload_json, row.id))
      }).pipe(repoOp("OwnerProfileRepo.get")),
    upsert: (profile) =>
      Effect.gen(function* () {
        const payload = yield* ProfileJson.encode("OwnerProfileRepo.upsert", profile)
        yield* sql`INSERT INTO owner_profiles (id, created_at, payload_json)
          VALUES (${profile.id}, ${profile.createdAt}, ${payload})
          ON CONFLICT (id) DO UPDATE SET payload_json = excluded.payload_json`
      }).pipe(repoOp("OwnerProfileRepo.upsert")),
    delete: (id) =>
      sql`DELETE FROM owner_profiles WHERE id = ${id}`.pipe(Effect.asVoid, repoOp("OwnerProfileRepo.delete")),
  })
})

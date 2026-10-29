/** `ApprovalRuleRepo`, `SettingsRepo` and `UsageRepo` over SQLite. */
import type { BotId, Millis, OwnerProfileId, Usage } from "@openbot/contracts"
import { ApprovalRule, MAIN_PROFILE_ID } from "@openbot/contracts"
import {
  ApprovalRuleRepo,
  SettingsRepo,
  type SettingsStore,
  UsageRecord,
  UsageRepo,
  type UsageTotals,
} from "@openbot/core"
import { Effect, Option } from "effect"
import { SqlClient, type Statement } from "effect/sql"
import { decodeRawJson, encodeRawJson, jsonCodec, repoOp } from "../codec.ts"

interface PayloadRow {
  readonly id: string
  readonly payload_json: string
}

const RuleJson = jsonCodec(ApprovalRule, "approval rule")
const UsageJson = jsonCodec(UsageRecord, "usage record")

// The main profile's rules and settings stay in `approval_rules` and `settings`, as an older release
// reads them; the other profiles' are in `profile_approval_rules` and `profile_settings`
const ownTable = (profileId: OwnerProfileId, main: string, others: string) =>
  profileId === MAIN_PROFILE_ID ? { table: main, owner: {} } : { table: others, owner: { owner_profile_id: profileId } }

export const makeSqlApprovalRuleRepo = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rulesOf = (profileId: OwnerProfileId) => ownTable(profileId, "approval_rules", "profile_approval_rules")
  return ApprovalRuleRepo.of({
    get: (id) =>
      Effect.gen(function* () {
        const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM approval_rules WHERE id = ${id}
          UNION ALL SELECT id, payload_json FROM profile_approval_rules WHERE id = ${id}`
        const row = rows[0]
        return row === undefined
          ? Option.none()
          : Option.some(yield* RuleJson.decode("ApprovalRuleRepo.get", row.payload_json, row.id))
      }).pipe(repoOp("ApprovalRuleRepo.get")),
    list: (filter) =>
      Effect.gen(function* () {
        const { table, owner } = rulesOf(filter.profileId)
        const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM ${sql(table)} WHERE ${sql.and([
          ...Object.entries(owner).map(([column, value]) => sql`${sql(column)} = ${value}`),
          ...(filter.botId === undefined ? [] : [sql`(bot_id IS NULL OR bot_id = ${filter.botId})`]),
        ])} ORDER BY created_at, rowid`
        return yield* Effect.forEach(rows, (row) => RuleJson.decode("ApprovalRuleRepo.list", row.payload_json, row.id))
      }).pipe(repoOp("ApprovalRuleRepo.list")),
    upsert: (rule) =>
      Effect.gen(function* () {
        const payload = yield* RuleJson.encode("ApprovalRuleRepo.upsert", rule)
        const { table, owner } = rulesOf(rule.ownerProfileId)
        yield* sql`INSERT INTO ${sql(table)} ${sql.insert({
          id: rule.id,
          ...owner,
          bot_id: rule.botId ?? null,
          created_at: rule.createdAt,
          payload_json: payload,
        })}
          ON CONFLICT (id) DO UPDATE SET bot_id = excluded.bot_id, created_at = excluded.created_at,
            payload_json = excluded.payload_json`
      }).pipe(repoOp("ApprovalRuleRepo.upsert")),
    delete: (id) =>
      Effect.gen(function* () {
        const main = yield* sql<{ id: string }>`DELETE FROM approval_rules WHERE id = ${id} RETURNING id`
        const others = yield* sql<{ id: string }>`DELETE FROM profile_approval_rules WHERE id = ${id} RETURNING id`
        return main.length + others.length > 0
      }).pipe(repoOp("ApprovalRuleRepo.delete")),
  })
})

export const makeSqlSettingsRepo = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const storeOf = (profileId: OwnerProfileId): SettingsStore => {
    const { table, owner } = ownTable(profileId, "settings", "profile_settings")
    const where = (...clauses: ReadonlyArray<Statement.Fragment>) =>
      sql.and([...Object.entries(owner).map(([column, value]) => sql`${sql(column)} = ${value}`), ...clauses])
    return {
      get: (key) =>
        Effect.gen(function* () {
          const rows = yield* sql<{ value_json: string }>`SELECT value_json FROM ${sql(table)}
            WHERE ${where(sql`key = ${key}`)}`
          const row = rows[0]
          return row === undefined
            ? Option.none()
            : Option.some(yield* decodeRawJson("SettingsRepo.get", row.value_json, key))
        }).pipe(repoOp("SettingsRepo.get")),
      getAll: Effect.gen(function* () {
        const rows = yield* sql<{ key: string; value_json: string }>`SELECT key, value_json FROM ${sql(table)}
          WHERE ${where()} ORDER BY key`
        const values = new Map<string, unknown>()
        for (const row of rows)
          values.set(row.key, yield* decodeRawJson("SettingsRepo.getAll", row.value_json, row.key))
        return values as ReadonlyMap<string, unknown>
      }).pipe(repoOp("SettingsRepo.getAll")),
      set: (key, value) =>
        Effect.gen(function* () {
          const json = yield* encodeRawJson("SettingsRepo.set", value)
          const conflict = sql.literal([...Object.keys(owner), "key"].join(", "))
          yield* sql`INSERT INTO ${sql(table)} ${sql.insert({ ...owner, key, value_json: json })}
            ON CONFLICT (${conflict}) DO UPDATE SET value_json = excluded.value_json`
        }).pipe(repoOp("SettingsRepo.set")),
      remove: (key) =>
        sql`DELETE FROM ${sql(table)} WHERE ${where(sql`key = ${key}`)}`.pipe(
          Effect.asVoid,
          repoOp("SettingsRepo.remove"),
        ),
    }
  }
  return SettingsRepo.of({ ...storeOf(MAIN_PROFILE_ID), forProfile: storeOf })
})

/** Sum of two usages; optional counters stay absent unless either side has them (same as the in-memory double). */
export const addUsage = (a: Usage, b: Usage): Usage => {
  const sumOptional = (x: number | undefined, y: number | undefined) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0)
  const cached = sumOptional(a.cachedInputTokens, b.cachedInputTokens)
  const reasoning = sumOptional(a.reasoningTokens, b.reasoningTokens)
  const cost = sumOptional(a.costUsd, b.costUsd)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    ...(cost === undefined ? {} : { costUsd: cost }),
  }
}

export const makeSqlUsageRepo = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const select = (op: string, filter: { readonly botId?: BotId | undefined; readonly sinceMs?: Millis | undefined }) =>
    Effect.gen(function* () {
      const clauses = [
        ...(filter.botId === undefined ? [] : [sql`bot_id = ${filter.botId}`]),
        ...(filter.sinceMs === undefined ? [] : [sql`at >= ${filter.sinceMs}`]),
      ]
      const rows = yield* sql<{
        seq: number
        json: string
      }>`SELECT seq, json FROM usage WHERE ${sql.and(clauses)} ORDER BY seq`
      return yield* Effect.forEach(rows, (row) => UsageJson.decode(op, row.json, String(row.seq)))
    })

  return UsageRepo.of({
    record: (record) =>
      Effect.gen(function* () {
        const json = yield* UsageJson.encode("UsageRepo.record", record)
        yield* sql`INSERT INTO usage (bot_id, at, json) VALUES (${record.botId}, ${record.at}, ${json})`
      }).pipe(repoOp("UsageRepo.record")),
    totalsByBot: (sinceMs) =>
      Effect.gen(function* () {
        const records = yield* select("UsageRepo.totalsByBot", { sinceMs })
        const totals = new Map<BotId, { usage: Usage; records: number; turns: Set<string>; lastAt: Millis }>()
        for (const r of records) {
          const current = totals.get(r.botId)
          if (current === undefined) {
            totals.set(r.botId, {
              usage: r.usage,
              records: 1,
              turns: new Set(r.turnId === undefined ? [] : [r.turnId]),
              lastAt: r.at,
            })
          } else {
            current.usage = addUsage(current.usage, r.usage)
            current.records += 1
            if (r.turnId !== undefined) current.turns.add(r.turnId)
            current.lastAt = Math.max(current.lastAt, r.at) as Millis
          }
        }
        return [...totals.entries()]
          .map(([botId, t]): UsageTotals => ({
            botId,
            usage: t.usage,
            records: t.records,
            turnCount: t.turns.size,
            lastAt: t.lastAt,
          }))
          .sort((a, b) => (a.botId < b.botId ? -1 : a.botId > b.botId ? 1 : 0))
      }).pipe(repoOp("UsageRepo.totalsByBot")),
    list: (filter) => select("UsageRepo.list", filter ?? {}).pipe(repoOp("UsageRepo.list")),
  })
})

/**
 * UsageService (architecture §4.3): records per-step/turn usage reported by harnesses (TurnIngest)
 * and aggregates it per bot for Settings › Usage (`usage.byBot`), and over time for the Ops view
 * (`stats.overview`, from usage records, turns and background tasks).
 */
import {
  type BotId,
  type BotUsage,
  InvalidInput,
  type Millis,
  type StatsBucket,
  type StatsByBot,
  type StatsByModel,
  type StatsOverview,
  type Task,
  type Turn,
} from "@openbot/contracts"
import { Clock, Effect, Layer } from "effect"
import { currentProfileId } from "../../ports/Profiles.ts"
import { BotRepo, TaskRepo, TurnRepo, type UsageRecord, UsageRepo } from "../../ports/repos.ts"
import { UsageService } from "../../ports/services.ts"

export const MAX_STATS_BUCKETS = 500
const MIN_BUCKET_MS = 60_000

const tokensOf = (u: UsageRecord["usage"]): number => u.inputTokens + u.outputTokens

const percentile = (sorted: ReadonlyArray<number>, p: number): number | undefined =>
  sorted.length === 0 ? undefined : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]

/**
 * Buckets everything that started in `[sinceMs, nowMs)`. Pure, so the Ops view's numbers are
 * testable without a database. Interrupted turns are not failures; cancelled tasks are not either.
 */
export const computeOverview = (input: {
  readonly sinceMs: Millis
  readonly bucketMs: number
  readonly nowMs: number
  readonly usage: ReadonlyArray<UsageRecord>
  readonly turns: ReadonlyArray<Turn>
  readonly tasks: ReadonlyArray<Task>
}): StatsOverview => {
  const { sinceMs, bucketMs, nowMs } = input
  const count = Math.max(1, Math.ceil((nowMs - sinceMs) / bucketMs))
  const buckets: Array<{ -readonly [K in keyof StatsBucket]: StatsBucket[K] }> = Array.from(
    { length: count },
    (_, i) => ({
      at: (sinceMs + i * bucketMs) as Millis,
      turns: 0,
      turnsFailed: 0,
      tasks: 0,
      tasksFailed: 0,
      costUsd: 0,
      tokens: 0,
    }),
  )
  const bucketAt = (at: number) => {
    const i = Math.floor((at - sinceMs) / bucketMs)
    return i >= 0 && i < count ? buckets[i] : undefined
  }
  type BotRow = { -readonly [K in keyof StatsByBot]: StatsByBot[K] } & { durations: Array<number> }
  const bots = new Map<BotId, BotRow>()
  const bot = (botId: BotId): BotRow => {
    let row = bots.get(botId)
    if (row === undefined) {
      row = { botId, turns: 0, turnsFailed: 0, tasks: 0, tasksFailed: 0, costUsd: 0, tokens: 0, durations: [] }
      bots.set(botId, row)
    }
    return row
  }
  const models = new Map<string, { -readonly [K in keyof StatsByModel]: StatsByModel[K] }>()
  for (const r of input.usage) {
    if (r.at < sinceMs) continue
    const cost = r.usage.costUsd ?? 0
    const tokens = tokensOf(r.usage)
    const b = bucketAt(r.at)
    if (b !== undefined) {
      b.costUsd += cost
      b.tokens += tokens
    }
    const row = bot(r.botId)
    row.costUsd += cost
    row.tokens += tokens
    const model = r.model ?? "unknown"
    const key = `${r.harness ?? ""}/${model}`
    const m = models.get(key) ?? {
      model,
      ...(r.harness === undefined ? {} : { harness: r.harness }),
      costUsd: 0,
      tokens: 0,
      records: 0,
    }
    m.costUsd += cost
    m.tokens += tokens
    m.records += 1
    models.set(key, m)
  }
  const allDurations: Array<number> = []
  for (const t of input.turns) {
    if (t.startedAt < sinceMs) continue
    const failed = t.status === "failed"
    const b = bucketAt(t.startedAt)
    if (b !== undefined) {
      b.turns += 1
      if (failed) b.turnsFailed += 1
    }
    const row = bot(t.botId)
    row.turns += 1
    if (failed) row.turnsFailed += 1
    if (t.endedAt !== undefined && t.endedAt >= t.startedAt) {
      row.durations.push(t.endedAt - t.startedAt)
      allDurations.push(t.endedAt - t.startedAt)
    }
  }
  for (const t of input.tasks) {
    if (t.createdAt < sinceMs) continue
    const failed = t.status === "failed"
    const b = bucketAt(t.createdAt)
    if (b !== undefined) {
      b.tasks += 1
      if (failed) b.tasksFailed += 1
    }
    const row = bot(t.botId)
    row.tasks += 1
    if (failed) row.tasksFailed += 1
  }
  allDurations.sort((a, b) => a - b)
  const p50 = percentile(allDurations, 0.5)
  const p90 = percentile(allDurations, 0.9)
  return {
    sinceMs,
    bucketMs,
    buckets,
    byBot: [...bots.values()]
      .map(({ durations, ...row }): StatsByBot => {
        const median = percentile(
          durations.sort((a, b) => a - b),
          0.5,
        )
        return median === undefined ? row : { ...row, turnP50Ms: median }
      })
      .sort((a, b) => b.costUsd - a.costUsd || b.turns - a.turns),
    byModel: [...models.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens),
    ...(p50 === undefined ? {} : { turnP50Ms: p50 }),
    ...(p90 === undefined ? {} : { turnP90Ms: p90 }),
  }
}

export const makeUsageService = Effect.gen(function* () {
  const repo = yield* UsageRepo
  const bots = yield* BotRepo
  const turns = yield* TurnRepo
  const tasks = yield* TaskRepo
  return UsageService.of({
    // Usage is bookkeeping: a storage failure is logged, never propagated into a turn.
    record: (input) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        yield* repo.record({
          botId: input.botId,
          conversationId: input.conversationId,
          turnId: input.turnId,
          harness: input.harness,
          model: input.model,
          at,
          usage: input.usage,
        })
      }).pipe(Effect.catch((error) => Effect.logWarning("UsageService.record failed", error))),
    byBot: ({ sinceMs }) =>
      Effect.gen(function* () {
        const profileBots = new Set((yield* Effect.orDie(bots.listIn(yield* currentProfileId))).map((b) => b.id))
        const totals = yield* Effect.orDie(repo.totalsByBot(sinceMs))
        return totals
          .filter((t) => profileBots.has(t.botId))
          .map((t): BotUsage => ({ botId: t.botId, usage: t.usage, turnCount: t.turnCount, lastAt: t.lastAt }))
      }),
    overview: ({ sinceMs, bucketMs }) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis
        if (!Number.isFinite(bucketMs) || bucketMs < MIN_BUCKET_MS)
          return yield* new InvalidInput({ message: "bucketMs must be at least a minute." })
        if (sinceMs >= nowMs || (nowMs - sinceMs) / bucketMs > MAX_STATS_BUCKETS)
          return yield* new InvalidInput({ message: `At most ${MAX_STATS_BUCKETS} buckets, ending now.` })
        const mine = new Set((yield* Effect.orDie(bots.listIn(yield* currentProfileId))).map((b) => b.id))
        const usage = (yield* Effect.orDie(repo.list({ sinceMs }))).filter((r) => mine.has(r.botId))
        const turnList = (yield* Effect.orDie(turns.listSince(sinceMs))).filter((t) => mine.has(t.botId))
        const taskList = (yield* Effect.orDie(tasks.list())).filter((t) => mine.has(t.botId) && t.createdAt >= sinceMs)
        return computeOverview({ sinceMs, bucketMs, nowMs, usage, turns: turnList, tasks: taskList })
      }),
  })
})

export const UsageServiceLive: Layer.Layer<UsageService, never, UsageRepo | BotRepo | TurnRepo | TaskRepo> =
  Layer.effect(UsageService, makeUsageService)

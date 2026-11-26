/**
 * Plan limits per harness account (`harnesses.quota`, Settings › Usage): what each account's own
 * harness reports (`HarnessDriver.quota`; Claude: the data behind `/usage`), with the Bots that run
 * on the account.
 *
 * - One answer per (kind, profile), in the order of `HarnessProfiles.list`. A driver without a
 *   report (Codex, OpenCode) still gets a row, so its Bots and limit messages show.
 * - Reports are kept for `ttl` (a report starts the account's CLI), and one refresh runs at a time:
 *   a second caller waits and reads what the first one fetched.
 * - Fallback signal: a Bot whose last finished turn failed with `usage-limit` is listed with the
 *   provider's message (`limitHits`). It is what OpenBot saw, not the account's state: it stays
 *   until the Bot finishes another turn, also after the limit has reset.
 */
import {
  type BotId,
  DEFAULT_HARNESS_PROFILE_ID,
  type HarnessLimitHit,
  type HarnessQuota,
  type HarnessQuotaReport,
  normalizeProfileId,
  profileIdOf,
} from "@openbot/contracts"
import {
  BotRepo,
  type CurrentProfile,
  currentProfileId,
  driverKeyOf,
  type HarnessDriver,
  HarnessRegistry,
  TurnRepo,
} from "@openbot/core"
import { Clock, Context, Duration, Effect, Layer, Semaphore } from "effect"
import { HarnessProfiles } from "./profiles.ts"

const DEFAULT_TTL: Duration.Input = "1 minute"
const REPORT_TIMEOUT: Duration.Input = "30 seconds"
/** How far back a usage-limit failure still counts (the longest limit window is a week). */
const LIMIT_HIT_WINDOW_MS = 7 * 86_400_000

export interface HarnessQuotasShape {
  /** `refresh` asks every account again instead of answering from reports younger than the ttl. */
  readonly list: (refresh?: boolean | undefined) => Effect.Effect<ReadonlyArray<HarnessQuota>, never, CurrentProfile>
}

export class HarnessQuotas extends Context.Service<HarnessQuotas, HarnessQuotasShape>()(
  "openbot/server/HarnessQuotas",
) {}

export interface HarnessQuotasOptions {
  readonly ttl?: Duration.Input | undefined
}

/** A driver's report, bounded so one slow account cannot hold `harnesses.quota`. */
const reportOf = (driver: HarnessDriver): Effect.Effect<HarnessQuotaReport> => {
  const without = (problem: string) =>
    Effect.map(Clock.currentTimeMillis, (checkedAt): HarnessQuotaReport => ({ windows: [], problem, checkedAt }))
  if (driver.quota === undefined) return without(`${driver.displayName} does not report plan limits to OpenBot.`)
  return driver.quota.pipe(
    Effect.timeoutOrElse({
      duration: REPORT_TIMEOUT,
      orElse: () => without(`${driver.displayName} did not answer in time.`),
    }),
    Effect.catchCause(() => without(`${driver.displayName} could not report this account's plan limits.`)),
  )
}

export const HarnessQuotasLayer = (
  options?: HarnessQuotasOptions,
): Layer.Layer<HarnessQuotas, never, HarnessRegistry | HarnessProfiles | BotRepo | TurnRepo> =>
  Layer.effect(
    HarnessQuotas,
    Effect.gen(function* () {
      const registry = yield* HarnessRegistry
      const profiles = yield* HarnessProfiles
      const bots = yield* BotRepo
      const turns = yield* TurnRepo
      const lock = yield* Semaphore.make(1)
      const ttlMs = Duration.toMillis(options?.ttl ?? DEFAULT_TTL)
      const reports = new Map<string, HarnessQuotaReport>()

      const refreshReports = (refresh: boolean) =>
        lock.withPermit(
          Effect.gen(function* () {
            const drivers = yield* registry.list
            const now = yield* Clock.currentTimeMillis
            const keys = new Set(drivers.map((d) => driverKeyOf(d.kind, d.profileId)))
            for (const key of reports.keys()) if (!keys.has(key)) reports.delete(key)
            const stale = drivers.filter((d) => {
              const kept = reports.get(driverKeyOf(d.kind, d.profileId))
              return refresh || kept === undefined || now - kept.checkedAt >= ttlMs
            })
            yield* Effect.forEach(
              stale,
              (driver) =>
                Effect.map(reportOf(driver), (report) => {
                  reports.set(driverKeyOf(driver.kind, driver.profileId), report)
                }),
              { concurrency: "unbounded", discard: true },
            )
            return drivers
          }),
        )

      const list = (refresh?: boolean) =>
        Effect.gen(function* () {
          const drivers = yield* refreshReports(refresh === true)
          const now = yield* Clock.currentTimeMillis
          const current = yield* currentProfileId
          const allBots = yield* Effect.orDie(bots.list)
          const finished = yield* Effect.orDie(turns.lastFinishedByBot(now - LIMIT_HIT_WINDOW_MS))
          const hits = new Map<BotId, HarnessLimitHit>()
          for (const turn of finished) {
            if (turn.failure?.code === "usage-limit")
              hits.set(turn.botId, {
                botId: turn.botId,
                at: turn.endedAt ?? turn.startedAt,
                message: turn.failure.message,
              })
          }
          const known = yield* profiles.list()
          const order = new Map(known.map((p, i) => [driverKeyOf(p.kind, p.id), i] as const))
          const labels = new Map(known.map((p) => [driverKeyOf(p.kind, p.id), p.label] as const))
          const rank = (d: HarnessDriver) => order.get(driverKeyOf(d.kind, d.profileId)) ?? Number.MAX_SAFE_INTEGER
          return [...drivers]
            .sort((a, b) => rank(a) - rank(b))
            .map((driver): HarnessQuota => {
              const key = driverKeyOf(driver.kind, driver.profileId)
              const profileId = normalizeProfileId(driver.profileId) ?? DEFAULT_HARNESS_PROFILE_ID
              const users = allBots.filter(
                (b) => b.harness.kind === driver.kind && profileIdOf(b.harness) === profileId,
              )
              const mine = users.filter((b) => b.ownerProfileId === current)
              return {
                kind: driver.kind,
                profileId,
                profileLabel: labels.get(key) ?? profileId,
                ...(reports.get(key) ?? { windows: [], checkedAt: now }),
                botIds: mine.map((b) => b.id),
                otherProfileBots: users.length - mine.length,
                limitHits: mine.flatMap((b) => hits.get(b.id) ?? []).sort((a, b) => b.at - a.at),
              }
            })
        })

      return HarnessQuotas.of({ list })
    }),
  )

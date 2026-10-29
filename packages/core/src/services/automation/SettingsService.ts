/**
 * SettingsService (architecture §4.3, D5.6): typed owner settings with decoding defaults over
 * `SettingsRepo` (one key per `Settings` field, see `readSettings`), plus approval-rule CRUD over
 * `ApprovalRuleRepo` (`rules.*`). Settings changes are persisted, then published to the roster
 * (`settings.updated`) and emitted on `changes`.
 */
import type { ApprovalRule, ApprovalRuleId, OwnerProfileId, Settings, SettingsPatch } from "@openbot/contracts"
import {
  applySettingsPatch,
  cleanProjectFolders,
  InvalidInput,
  NotFound,
  SettingsPatch as SettingsPatchSchema,
} from "@openbot/contracts"
import { Clock, Effect, Layer, Option, Result, Schema, Semaphore, Stream, SubscriptionRef } from "effect"
import { IdGen } from "../../ports/IdGen.ts"
import { ApprovalRuleRepo, BotRepo, readSettings, SettingsRepo, writeSettings } from "../../ports/repos.ts"
import { currentProfileId } from "../../ports/Profiles.ts"
import { LiveHub, SettingsService } from "../../ports/services.ts"
import { validateRuleMatch } from "./policy.ts"

const decodePatch = Schema.decodeUnknownResult(SettingsPatchSchema)

export const makeSettingsService = Effect.gen(function* () {
  const repo = yield* SettingsRepo
  const rulesRepo = yield* ApprovalRuleRepo
  const bots = yield* BotRepo
  const hub = yield* LiveHub
  const ids = yield* IdGen

  const lock = yield* Semaphore.make(1)
  const states = new Map<OwnerProfileId, SubscriptionRef.SubscriptionRef<Settings>>()

  /** The current profile's settings, read once per profile. */
  const state = Effect.gen(function* () {
    const profileId = yield* currentProfileId
    const known = states.get(profileId)
    if (known !== undefined) return known
    const read = yield* Effect.provideService(readSettings(profileId), SettingsRepo, repo).pipe(Effect.orDie)
    const created = yield* SubscriptionRef.make<Settings>(read)
    states.set(profileId, created)
    return created
  })

  const update = (patch: SettingsPatch) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const profileId = yield* currentProfileId
        const current = yield* state
        const decoded = decodePatch(patch)
        if (Result.isFailure(decoded)) {
          return yield* new InvalidInput({ message: `Invalid settings: ${String(decoded.failure)}` })
        }
        let accepted = decoded.success
        if (accepted.sharedProjectFolders !== undefined) {
          const cleaned = cleanProjectFolders(accepted.sharedProjectFolders)
          if ("problem" in cleaned) return yield* new InvalidInput({ message: cleaned.problem })
          accepted = { ...accepted, sharedProjectFolders: cleaned.folders }
        }
        if (typeof accepted.slackSendTo === "string") {
          const bot = yield* bots.get(accepted.slackSendTo).pipe(Effect.orDie)
          if (Option.isNone(bot) || bot.value.ownerProfileId !== profileId) {
            return yield* new InvalidInput({ message: "Send to OpenBot needs one of this profile's Bots." })
          }
        }
        const next = applySettingsPatch(yield* SubscriptionRef.get(current), accepted)
        yield* Effect.provideService(writeSettings(profileId, next), SettingsRepo, repo).pipe(Effect.orDie)
        yield* SubscriptionRef.set(current, next)
        yield* hub.publishSettings(profileId, next)
        return next
      }),
    )

  const upsertRule = Effect.fn("SettingsService.upsertRule")(function* (
    input: Parameters<SettingsService["Service"]["upsertRule"]>[0],
  ) {
    const problem = validateRuleMatch(input.match)
    if (problem !== undefined) return yield* new InvalidInput({ message: problem })
    const profileId = yield* currentProfileId
    if (input.botId !== undefined) {
      const bot = yield* bots.get(input.botId).pipe(Effect.orDie)
      if (Option.isNone(bot) || bot.value.ownerProfileId !== profileId)
        return yield* new NotFound({ entity: "bot", id: input.botId })
    }
    const existing = Option.filter(
      input.id === undefined ? Option.none<ApprovalRule>() : yield* rulesRepo.get(input.id).pipe(Effect.orDie),
      (rule) => rule.ownerProfileId === profileId,
    )
    if (input.id !== undefined && Option.isNone(existing)) {
      return yield* new NotFound({ entity: "rule", id: input.id })
    }
    const rule: ApprovalRule = {
      id: input.id ?? (yield* ids.ruleId),
      ownerProfileId: profileId,
      surface: input.surface,
      match: input.match,
      action: input.action,
      origin: Option.isSome(existing) ? (existing.value.origin ?? "user") : "user",
      createdAt: Option.isSome(existing) ? existing.value.createdAt : yield* Clock.currentTimeMillis,
      ...(input.botId === undefined ? {} : { botId: input.botId }),
      ...(input.note === undefined ? {} : { note: input.note }),
    }
    yield* rulesRepo.upsert(rule).pipe(Effect.orDie)
    return rule
  })

  return SettingsService.of({
    get: Effect.flatMap(lock.withPermits(1)(state), SubscriptionRef.get),
    update,
    changes: Stream.unwrap(Effect.map(lock.withPermits(1)(state), SubscriptionRef.changes)),
    listRules: ({ botId }) =>
      Effect.flatMap(currentProfileId, (profileId) => rulesRepo.list({ profileId, botId }).pipe(Effect.orDie)),
    upsertRule,
    deleteRule: (ruleId: ApprovalRuleId) =>
      Effect.gen(function* () {
        const rule = yield* rulesRepo.get(ruleId).pipe(Effect.orDie)
        if (Option.isNone(rule) || rule.value.ownerProfileId !== (yield* currentProfileId))
          return yield* new NotFound({ entity: "rule", id: ruleId })
        yield* rulesRepo.delete(ruleId).pipe(Effect.orDie)
      }),
    forgetProfile: (id) => lock.withPermits(1)(Effect.sync(() => void states.delete(id))),
  })
})

/** `SettingsService` over `SettingsRepo` + `ApprovalRuleRepo`; publishes `settings.updated`. */
export const SettingsServiceLive: Layer.Layer<
  SettingsService,
  never,
  SettingsRepo | ApprovalRuleRepo | BotRepo | LiveHub | IdGen
> = Layer.effect(SettingsService, makeSettingsService)

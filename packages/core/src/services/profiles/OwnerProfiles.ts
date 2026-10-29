/**
 * OwnerProfiles over `OwnerProfileRepo`; the active profile is the brain setting `brain.activeProfile`
 * (the main profile when unset or unknown), so a restart comes back to it.
 */
import type { OwnerProfileId, OwnerProfilesView } from "@openbot/contracts"
import {
  Forbidden,
  InvalidInput,
  MAIN_PROFILE_ID,
  NotFound,
  OwnerProfile,
  OwnerProfileId as OwnerProfileIdSchema,
} from "@openbot/contracts"
import { Clock, Effect, Layer, Option, Schema, Semaphore, SubscriptionRef } from "effect"
import { IdGen } from "../../ports/IdGen.ts"
import { ProfileDirs } from "../../ports/ProfileDirs.ts"
import { OwnerProfileRepo, OwnerProfiles } from "../../ports/Profiles.ts"
import { SettingsRepo } from "../../ports/repos.ts"

export const ACTIVE_PROFILE_KEY = "brain.activeProfile"

const decodeId = Schema.decodeUnknownOption(OwnerProfileIdSchema)
const decodeName = Schema.decodeUnknownEffect(OwnerProfile.fields.name)

const cleanName = (name: string): Effect.Effect<string, InvalidInput> =>
  decodeName(name.trim()).pipe(
    Effect.mapError((error) => new InvalidInput({ message: `Invalid profile name: ${error.message}` })),
  )

export const OwnerProfilesLive: Layer.Layer<
  OwnerProfiles,
  never,
  OwnerProfileRepo | SettingsRepo | ProfileDirs | IdGen
> = Layer.effect(
  OwnerProfiles,
  Effect.gen(function* () {
    const repo = yield* OwnerProfileRepo
    const settings = yield* SettingsRepo
    const dirs = yield* ProfileDirs
    const ids = yield* IdGen
    const lock = yield* Semaphore.make(1)
    // adds take one permit each, a delete's mark takes them all
    const adds = yield* Semaphore.make(Number.MAX_SAFE_INTEGER)

    const profiles = yield* Effect.orDie(repo.list)
    const stored = Option.flatMap(yield* Effect.orDie(settings.get(ACTIVE_PROFILE_KEY)), decodeId)
    const activeId = Option.getOrElse(
      Option.filter(stored, (id) => profiles.some((p) => p.id === id)),
      () => MAIN_PROFILE_ID,
    )
    const state = yield* SubscriptionRef.make<OwnerProfilesView>({ profiles, activeId })

    const require = (id: OwnerProfileId) =>
      Effect.flatMap(SubscriptionRef.get(state), (view) => {
        const found = view.profiles.find((p) => p.id === id)
        return found === undefined ? Effect.fail(new NotFound({ entity: "profile", id })) : Effect.succeed(found)
      })

    /** Profiles being deleted: nothing switches to them and nothing new starts in them. */
    const deleting = new Set<OwnerProfileId>()

    const usable = (id: OwnerProfileId) =>
      deleting.has(id) ? Effect.fail(new NotFound({ entity: "profile", id })) : Effect.asVoid(require(id))

    const save = (profile: OwnerProfile) =>
      Effect.gen(function* () {
        yield* Effect.orDie(repo.upsert(profile))
        yield* SubscriptionRef.update(state, (view) => ({
          ...view,
          profiles: view.profiles.some((p) => p.id === profile.id)
            ? view.profiles.map((p) => (p.id === profile.id ? profile : p))
            : [...view.profiles, profile],
        }))
        return profile
      })

    return OwnerProfiles.of({
      view: SubscriptionRef.get(state),
      active: Effect.map(SubscriptionRef.get(state), (view) => view.activeId),
      withActive: (f) => lock.withPermit(Effect.flatMap(SubscriptionRef.get(state), (view) => f(view.activeId))),
      changes: SubscriptionRef.changes(state),
      require,
      create: Effect.fn("OwnerProfiles.create")(function* (name: string) {
        const profile: OwnerProfile = {
          id: yield* ids.profileId,
          name: yield* cleanName(name),
          createdAt: yield* Clock.currentTimeMillis,
        }
        yield* Effect.orDie(dirs.ensure(profile.id))
        return yield* lock.withPermit(save(profile))
      }),
      rename: Effect.fn("OwnerProfiles.rename")(function* (id: OwnerProfileId, name: string) {
        const clean = yield* cleanName(name)
        return yield* lock.withPermit(Effect.flatMap(require(id), (profile) => save({ ...profile, name: clean })))
      }),
      usable,
      adding: (id, f) => adds.withPermit(Effect.andThen(usable(id), f)),
      remove: <E>(id: OwnerProfileId, purge: Effect.Effect<void, E>) =>
        Effect.gen(function* () {
          yield* lock.withPermit(
            Effect.gen(function* () {
              if (id === MAIN_PROFILE_ID) return yield* new Forbidden({ reason: "The main profile can't be deleted." })
              yield* usable(id)
              if (id === (yield* SubscriptionRef.get(state)).activeId)
                return yield* new Forbidden({ reason: "Switch to another profile before deleting this one." })
              yield* adds.withPermits(Number.MAX_SAFE_INTEGER)(Effect.sync(() => deleting.add(id)))
            }),
          )
          yield* purge.pipe(Effect.onError(() => Effect.sync(() => deleting.delete(id))))
          yield* lock.withPermit(
            Effect.gen(function* () {
              yield* Effect.orDie(repo.delete(id))
              deleting.delete(id)
              yield* SubscriptionRef.update(state, (view) => ({
                ...view,
                profiles: view.profiles.filter((p) => p.id !== id),
              }))
            }),
          )
        }),
      switchTo: Effect.fn("OwnerProfiles.switchTo")(function* (id: OwnerProfileId) {
        yield* lock.withPermit(
          Effect.gen(function* () {
            yield* usable(id)
            yield* Effect.orDie(settings.set(ACTIVE_PROFILE_KEY, id))
            yield* SubscriptionRef.update(state, (view) => ({ ...view, activeId: id }))
          }),
        )
      }),
    })
  }),
)

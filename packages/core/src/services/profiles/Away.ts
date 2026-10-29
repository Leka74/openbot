/**
 * The "While you were away" list of the active profile, over `HeldNotificationRepo` (`Notifier` holds
 * what the inactive profiles notify). Records when the owner leaves a profile, for the list's `since`.
 */
import type { OwnerProfileId } from "@openbot/contracts"
import { Clock, Effect, Layer, Ref, Stream } from "effect"
import { Away, currentProfileId, HeldNotificationRepo, OwnerProfiles } from "../../ports/Profiles.ts"
import { LiveHub } from "../../ports/services.ts"

export const AwayLive: Layer.Layer<Away, never, HeldNotificationRepo | OwnerProfiles | LiveHub> = Layer.effect(
  Away,
  Effect.gen(function* () {
    const held = yield* HeldNotificationRepo
    const profiles = yield* OwnerProfiles
    const hub = yield* LiveHub

    const shown = yield* Ref.make<OwnerProfileId>(yield* profiles.active)
    yield* profiles.changes.pipe(
      Stream.runForEach((view) =>
        Effect.gen(function* () {
          const left = yield* Ref.getAndSet(shown, view.activeId)
          if (left === view.activeId) return
          yield* Effect.orDie(held.markLeft(left, yield* Clock.currentTimeMillis))
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    const summary = Effect.flatMap(currentProfileId, (id) => Effect.orDie(held.summary(id)))

    return Away.of({
      summary,
      dismiss: Effect.fn("Away.dismiss")(function* (through) {
        yield* Effect.orDie(held.dismiss(yield* currentProfileId, through))
        yield* hub.publishRoster({ type: "away.changed" })
        return yield* summary
      }),
    })
  }),
)

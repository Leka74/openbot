// The owner's profiles (`profiles.subscribe`): all of them and the active one, live. Switching is
// brain-wide, so every open app watches `activeId` and starts over when it changes.
import { Effect, Stream } from "effect"
import type { OwnerProfilesView } from "@openbot/contracts"
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity"
import { clientConfigAtom } from "./config.ts"
import { isRetryableSubscribeError, waitForRetry } from "./replica.ts"
import { makeReplicaHolder, replicaStream } from "./resume.ts"
import { OpenBotClient } from "./rpc.ts"

export const profilesAtom = OpenBotClient.runtime
  .atom((get) => {
    const backoff = get(clientConfigAtom).resubscribe
    return Stream.unwrap(
      Effect.gen(function* () {
        const client = yield* OpenBotClient
        const registry = yield* AtomRegistry.AtomRegistry
        return replicaStream<OwnerProfilesView | undefined, OwnerProfilesView, unknown>({
          holder: makeReplicaHolder<OwnerProfilesView | undefined>(undefined),
          open: () => client("profiles.subscribe", undefined),
          reduce: (_, view) => view,
          cursor: () => undefined,
          hasGap: () => false,
          markStale: (view) => view,
          isRetryable: isRetryableSubscribeError,
          backoff,
          wait: waitForRetry(registry),
        }).pipe(Stream.filter((view) => view !== undefined))
      }),
    )
  })
  .pipe(Atom.keepAlive, Atom.withLabel("openbot/profiles"))

/** The active profile's id; undefined until the first view arrives. */
export const activeProfileIdAtom = Atom.make((get) => {
  const profiles = get(profilesAtom)
  return AsyncResult.isSuccess(profiles) ? profiles.value.activeId : undefined
})

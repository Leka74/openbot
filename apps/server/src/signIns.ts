import { type HarnessSignInStart, HarnessUnavailable, InvalidInput } from "@openbot/contracts"
import { driverKeyOf, HarnessRegistry, type HarnessSignIn } from "@openbot/core"
import { Context, type Duration, Effect, Exit, Layer, Scope, Semaphore } from "effect"

const DEFAULT_LIFETIME: Duration.Input = "10 minutes"
const MAX_CODE_LENGTH = 2048

interface OpenSignIn {
  readonly signIn: HarnessSignIn
  readonly scope: Scope.Closeable
}

export interface HarnessSignInsShape {
  readonly start: (kind: string, profileId: string | undefined) => Effect.Effect<HarnessSignInStart, HarnessUnavailable>
  readonly complete: (kind: string, profileId: string | undefined, code: string) => Effect.Effect<void, InvalidInput>
  readonly cancel: (kind: string, profileId: string | undefined) => Effect.Effect<void>
}

export class HarnessSignIns extends Context.Service<HarnessSignIns, HarnessSignInsShape>()(
  "openbot/server/HarnessSignIns",
) {}

export interface HarnessSignInsOptions {
  readonly lifetime?: Duration.Input | undefined
}

export const HarnessSignInsLayer = (
  options?: HarnessSignInsOptions,
): Layer.Layer<HarnessSignIns, never, HarnessRegistry> =>
  Layer.effect(
    HarnessSignIns,
    Effect.gen(function* () {
      const registry = yield* HarnessRegistry
      const layerScope = yield* Effect.scope
      const startLock = yield* Semaphore.make(1)
      const open = new Map<string, OpenSignIn>()
      const lifetime = options?.lifetime ?? DEFAULT_LIFETIME

      const closeIfCurrent = (key: string, entry: OpenSignIn) =>
        Effect.suspend(() => {
          if (open.get(key) !== entry) return Effect.void
          open.delete(key)
          return Scope.close(entry.scope, Exit.void)
        })

      const closeCurrent = (key: string) =>
        Effect.suspend(() => {
          const entry = open.get(key)
          return entry === undefined ? Effect.void : closeIfCurrent(key, entry)
        })

      const start = (kind: string, profileId: string | undefined) =>
        startLock.withPermit(
          Effect.gen(function* () {
            const driver = yield* registry.get(kind, profileId)
            if (driver.signIn === undefined) {
              return yield* new HarnessUnavailable({
                harness: kind,
                message: `${driver.displayName} has no sign-in in OpenBot. Sign in from a terminal on the server.`,
              })
            }
            const key = driverKeyOf(kind, profileId)
            yield* closeCurrent(key)
            const scope = yield* Scope.fork(layerScope)
            const signIn = yield* driver.signIn.pipe(
              Scope.provide(scope),
              Effect.onError(() => Scope.close(scope, Exit.void)),
              Effect.mapError((error) => new HarnessUnavailable({ harness: kind, message: error.message })),
            )
            const entry: OpenSignIn = { signIn, scope }
            open.set(key, entry)
            yield* Effect.forkIn(Effect.andThen(Effect.sleep(lifetime), closeIfCurrent(key, entry)), layerScope)
            return { url: signIn.url }
          }),
        )

      const complete = (kind: string, profileId: string | undefined, code: string) =>
        Effect.gen(function* () {
          const trimmedCode = code.trim()
          if (trimmedCode === "" || trimmedCode.length > MAX_CODE_LENGTH || /\s/.test(trimmedCode)) {
            return yield* new InvalidInput({ message: "Paste only the code that the sign-in page shows." })
          }
          const key = driverKeyOf(kind, profileId)
          const entry = open.get(key)
          if (entry === undefined) {
            return yield* new InvalidInput({ message: "This sign-in is no longer open. Start the sign-in again." })
          }
          open.delete(key)
          yield* entry.signIn.complete(trimmedCode).pipe(
            Effect.mapError((error) => new InvalidInput({ message: error.message })),
            Effect.ensuring(Scope.close(entry.scope, Exit.void)),
          )
        })

      const cancel = (kind: string, profileId: string | undefined) => closeCurrent(driverKeyOf(kind, profileId))

      return { start, complete, cancel }
    }),
  )

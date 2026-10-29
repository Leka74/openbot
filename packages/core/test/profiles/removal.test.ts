import { describe, expect, test } from "bun:test"
import { MAIN_PROFILE_ID } from "@openbot/contracts"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { OwnerProfiles } from "../../src/ports/index.ts"
import { OwnerProfilesLive } from "../../src/services/profiles/index.ts"
import {
  MemoryOwnerProfileRepo,
  MemoryProfileDirs,
  MemorySettingsRepo,
  runTest,
  SequentialIdGen,
} from "../../src/testing/index.ts"

const layer = () =>
  OwnerProfilesLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(MemoryOwnerProfileRepo, MemorySettingsRepo(), MemoryProfileDirs, SequentialIdGen()),
    ),
  )

const failsWith = (exit: Exit.Exit<unknown, unknown>, tag: string) =>
  Exit.isFailure(exit) && JSON.stringify(exit.cause).includes(tag)

describe("deleting a profile", () => {
  test("while it is being deleted, nothing switches to it or starts in it; then it is gone", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const profiles = yield* OwnerProfiles
        const doomed = yield* profiles.create("Doomed")
        const purging = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const removal = yield* Effect.forkChild(
          profiles.remove(
            doomed.id,
            Deferred.succeed(purging, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        )
        yield* Deferred.await(purging)
        const duringSwitch = yield* Effect.exit(profiles.switchTo(doomed.id))
        const duringUsable = yield* Effect.exit(profiles.usable(doomed.id))
        const twice = yield* Effect.exit(profiles.remove(doomed.id, Effect.void))
        yield* Deferred.succeed(release, undefined)
        const removed = yield* Fiber.await(removal)
        return { doomed, duringSwitch, duringUsable, twice, removed, view: yield* profiles.view }
      }),
      layer(),
    )
    expect(failsWith(out.duringSwitch, "NotFound")).toBe(true)
    expect(failsWith(out.duringUsable, "NotFound")).toBe(true)
    expect(failsWith(out.twice, "NotFound")).toBe(true)
    expect(Exit.isSuccess(out.removed)).toBe(true)
    expect(out.view.activeId).toBe(MAIN_PROFILE_ID)
    expect(out.view.profiles.map((p) => p.id)).not.toContain(out.doomed.id)
  })

  test("what is being added when a delete starts is finished first and then removed with the rest", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const profiles = yield* OwnerProfiles
        const doomed = yield* profiles.create("Doomed")
        const order: Array<string> = []
        const adding = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        const add = yield* Effect.forkChild(
          profiles.adding(
            doomed.id,
            Deferred.succeed(adding, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.andThen(Effect.sync(() => order.push("added"))),
            ),
          ),
        )
        yield* Deferred.await(adding)
        const removal = yield* Effect.forkChild(
          profiles.remove(
            doomed.id,
            Effect.sync(() => order.push("purged")),
          ),
        )
        for (let i = 0; i < 100; i++) yield* Effect.yieldNow
        const purgedBeforeAdd = order.includes("purged")
        yield* Deferred.succeed(finish, undefined)
        const added = yield* Fiber.await(add)
        const removed = yield* Fiber.await(removal)
        const late = yield* Effect.exit(
          profiles.adding(
            doomed.id,
            Effect.sync(() => order.push("late")),
          ),
        )
        return { purgedBeforeAdd, order, added, removed, late }
      }),
      layer(),
    )
    expect(out.purgedBeforeAdd).toBe(false)
    expect(Exit.isSuccess(out.added)).toBe(true)
    expect(Exit.isSuccess(out.removed)).toBe(true)
    expect(out.order).toEqual(["added", "purged"])
    expect(failsWith(out.late, "NotFound")).toBe(true)
  })

  test("a profile switched to first is not deleted; a failed purge leaves it to delete again", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const profiles = yield* OwnerProfiles
        const active = yield* profiles.create("Active")
        const flaky = yield* profiles.create("Flaky")
        yield* profiles.switchTo(active.id)
        const refused = yield* Effect.exit(profiles.remove(active.id, Effect.void))
        const failed = yield* Effect.exit(profiles.remove(flaky.id, Effect.fail("disk full")))
        const afterFailure = yield* Effect.exit(profiles.usable(flaky.id))
        const retried = yield* Effect.exit(profiles.remove(flaky.id, Effect.void))
        return { refused, failed, afterFailure, retried, view: yield* profiles.view, flaky }
      }),
      layer(),
    )
    expect(failsWith(out.refused, "Forbidden")).toBe(true)
    expect(Exit.isFailure(out.failed)).toBe(true)
    expect(Exit.isSuccess(out.afterFailure)).toBe(true)
    expect(Exit.isSuccess(out.retried)).toBe(true)
    expect(out.view.profiles.map((p) => p.id)).not.toContain(out.flaky.id)
  })
})

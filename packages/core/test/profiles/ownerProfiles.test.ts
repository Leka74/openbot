import { describe, expect, test } from "bun:test"
import { MAIN_PROFILE_ID, type OwnerProfileId } from "@openbot/contracts"
import { Effect, Exit, Fiber, Layer, Stream } from "effect"
import { OwnerProfileRepo, OwnerProfiles, SettingsRepo } from "../../src/ports/index.ts"
import { ACTIVE_PROFILE_KEY, OwnerProfilesLive } from "../../src/services/profiles/index.ts"
import {
  MemoryOwnerProfileRepo,
  MemoryProfileDirs,
  MemorySettingsRepo,
  runTest,
  SequentialIdGen,
} from "../../src/testing/index.ts"

const stores = () => Layer.mergeAll(MemoryOwnerProfileRepo, MemorySettingsRepo(), MemoryProfileDirs, SequentialIdGen())
const layer = () => OwnerProfilesLive.pipe(Layer.provideMerge(stores()))

describe("OwnerProfiles", () => {
  test("starts in the main profile; creates, renames and switches", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const profiles = yield* OwnerProfiles
        const first = yield* profiles.view
        const demo = yield* profiles.create("  Demo  ")
        yield* profiles.rename(demo.id, "Demo day")
        yield* profiles.switchTo(demo.id)
        return {
          first,
          demo,
          view: yield* profiles.view,
          stored: yield* (yield* SettingsRepo).get(ACTIVE_PROFILE_KEY),
        }
      }),
      layer(),
    )
    expect(out.first.activeId).toBe(MAIN_PROFILE_ID)
    expect(out.first.profiles.map((p) => p.name)).toEqual(["Main"])
    expect(out.demo.name).toBe("Demo")
    expect(out.view.activeId).toBe(out.demo.id)
    expect(out.view.profiles.map((p) => p.name)).toEqual(["Main", "Demo day"])
    expect(out.stored._tag === "Some" && out.stored.value).toBe(out.demo.id)
  })

  test("a new brain comes back to the active profile; an unknown one falls back to main", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const settings = yield* SettingsRepo
        const repo = yield* OwnerProfileRepo
        const demo = yield* Effect.provide(
          Effect.flatMap(OwnerProfiles, (profiles) =>
            Effect.tap(profiles.create("Demo"), (p) => profiles.switchTo(p.id)),
          ),
          OwnerProfilesLive,
        )
        const restarted = yield* Effect.provide(
          Effect.flatMap(OwnerProfiles, (p) => p.active),
          OwnerProfilesLive,
        )
        yield* settings.set(ACTIVE_PROFILE_KEY, "prf_gone")
        const unknown = yield* Effect.provide(
          Effect.flatMap(OwnerProfiles, (p) => p.active),
          OwnerProfilesLive,
        )
        return { demo, restarted, unknown, stored: (yield* repo.list).length }
      }),
      stores(),
    )
    expect(out.restarted).toBe(out.demo.id)
    expect(out.unknown).toBe(MAIN_PROFILE_ID)
    expect(out.stored).toBe(2)
  })

  test("refuses unknown profiles and empty names; changes follow every switch", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const profiles = yield* OwnerProfiles
        const seen = yield* Effect.forkScoped(Stream.runCollect(Stream.take(profiles.changes, 3)), {
          startImmediately: true,
        })
        const demo = yield* profiles.create("Demo")
        yield* profiles.switchTo(demo.id)
        return {
          unknown: yield* Effect.exit(profiles.switchTo("prf_nope" as OwnerProfileId)),
          empty: yield* Effect.exit(profiles.create("   ")),
          seen: (yield* Fiber.join(seen)).map((v) => [v.activeId, v.profiles.length]),
          demo,
        }
      }),
      layer(),
    )
    expect(Exit.isFailure(out.unknown) && JSON.stringify(out.unknown.cause).includes("NotFound")).toBe(true)
    expect(Exit.isFailure(out.empty) && JSON.stringify(out.empty.cause).includes("InvalidInput")).toBe(true)
    expect(out.seen).toEqual([
      [MAIN_PROFILE_ID, 1],
      [MAIN_PROFILE_ID, 2],
      [out.demo.id, 2],
    ])
  })
})

import { describe, expect, test } from "bun:test"
import { MAIN_PROFILE_ID, type RosterStreamItem } from "@openbot/contracts"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Away, BotRepo, inProfile, LiveHub, Notifier, OwnerProfiles } from "../../src/ports/index.ts"
import { LiveHubLive, NotifierLive } from "../../src/services/conversation/index.ts"
import { AwayLive, OwnerProfilesLive } from "../../src/services/profiles/index.ts"
import { botId, makeBot, runTest, TestPorts } from "../../src/testing/index.ts"
import { collect, eventually } from "../conversation/helpers.ts"

const layer = () =>
  Layer.mergeAll(NotifierLive, AwayLive).pipe(
    Layer.provideMerge(LiveHubLive),
    Layer.provideMerge(OwnerProfilesLive),
    Layer.provideMerge(TestPorts()),
  )

/** The real hub, except that a notification waits for `release` after saying it `entered`. */
const gatedNotifications = (entered: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
  Layer.effect(
    LiveHub,
    Effect.map(LiveHub, (hub) =>
      LiveHub.of({
        ...hub,
        publishRoster: (change) =>
          change.type === "notification"
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(hub.publishRoster(change)),
              )
            : hub.publishRoster(change),
      }),
    ),
  )

const rosterTypes = (items: ReadonlyArray<RosterStreamItem>) =>
  items.flatMap((item) => (item.kind === "change" ? [item.change.type] : []))

const notified = (items: ReadonlyArray<RosterStreamItem>) =>
  items.flatMap((item) =>
    item.kind === "change" && item.change.type === "notification" ? [item.change.notification.body] : [],
  )

describe("Notifier with profiles", () => {
  test("an inactive profile's notifications are held, not shown; brain-wide ones always show", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const profiles = yield* OwnerProfiles
        const notifier = yield* Notifier
        const away = yield* Away
        const bots = yield* BotRepo
        const demo = yield* profiles.create("Demo")
        const ada = makeBot({ id: botId("bot_ada"), name: "Ada" })
        const muted = makeBot({ id: botId("bot_muted"), notify: "none" })
        const demoBot = makeBot({ id: botId("bot_demo"), name: "Demo bot", ownerProfileId: demo.id })
        for (const bot of [ada, muted, demoBot]) yield* Effect.orDie(bots.upsert(bot))
        const live = yield* collect((yield* LiveHub).subscribeRoster({}))

        yield* notifier.notify({ kind: "finished", botId: ada.id, title: "Ada", body: "main while main" })
        yield* notifier.notify({ kind: "finished", botId: demoBot.id, title: "Demo", body: "demo while main" })
        yield* TestClock.adjust(1_000)
        yield* profiles.switchTo(demo.id)
        const held = yield* notifier.notify({ kind: "waiting", botId: ada.id, title: "Ada", body: "main while demo" })
        yield* notifier.notify({ kind: "error", botId: muted.id, title: "Muted", body: "muted while demo" })
        yield* notifier.notify({ kind: "sign-in", title: "Sign-in request", body: "sign-in while demo" })
        yield* notifier.notify({ kind: "finished", botId: demoBot.id, title: "Demo", body: "demo while demo" })
        yield* eventually(
          Effect.map(live.items, (items) => notified(items).length === 3),
          "notifications",
        )
        return {
          held,
          shown: notified(yield* live.items),
          main: yield* inProfile(MAIN_PROFILE_ID)(away.summary),
          demo: yield* inProfile(demo.id)(away.summary),
        }
      }),
      layer(),
    )
    expect(out.shown).toEqual(["main while main", "sign-in while demo", "demo while demo"])
    expect(out.main.since).toBe(1_000)
    expect(out.main.items).toEqual([{ notification: out.held!, needsYou: true, botName: "Ada" }])
    expect(out.demo.items.map((i) => i.notification.body)).toEqual(["demo while main"])
    expect(out.demo.since).toBeUndefined()
  })

  test("a switch waits for a notification being published, so the open roster still gets it", async () => {
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const out = await runTest(
      Effect.gen(function* () {
        const profiles = yield* OwnerProfiles
        const notifier = yield* Notifier
        const away = yield* Away
        yield* Effect.orDie((yield* BotRepo).upsert(makeBot({ id: botId("bot_ada"), name: "Ada" })))
        const demo = yield* profiles.create("Demo")
        const live = yield* collect((yield* LiveHub).subscribeRoster({}))

        const notifying = yield* Effect.forkChild(
          notifier.notify({ kind: "finished", botId: botId("bot_ada"), title: "Ada", body: "at the switch" }),
        )
        yield* Deferred.await(entered)
        const switching = yield* Effect.forkChild(profiles.switchTo(demo.id))
        for (let i = 0; i < 100; i++) yield* Effect.yieldNow
        const activeMidPublish = yield* profiles.active
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(notifying)
        yield* Fiber.join(switching)
        yield* eventually(
          Effect.map(live.items, (items) => notified(items).length === 1),
          "notification",
        )
        return {
          activeMidPublish,
          shown: notified(yield* live.items),
          held: yield* inProfile(MAIN_PROFILE_ID)(away.summary),
          active: yield* profiles.active,
          demo,
        }
      }),
      NotifierLive.pipe(
        Layer.provide(gatedNotifications(entered, release)),
        Layer.provideMerge(AwayLive),
        Layer.provideMerge(LiveHubLive),
        Layer.provideMerge(OwnerProfilesLive),
        Layer.provideMerge(TestPorts()),
      ),
    )
    expect(out.activeMidPublish).toBe(MAIN_PROFILE_ID)
    expect(out.shown).toEqual(["at the switch"])
    expect(out.held.items).toEqual([])
    expect(out.active).toBe(out.demo.id)
  })

  test("dismissing through an id keeps what was held after it and announces the change", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const profiles = yield* OwnerProfiles
        const notifier = yield* Notifier
        const away = yield* Away
        yield* Effect.orDie((yield* BotRepo).upsert(makeBot({ id: botId("bot_ada") })))
        const demo = yield* profiles.create("Demo")
        yield* profiles.switchTo(demo.id)
        const first = yield* notifier.notify({ kind: "finished", botId: botId("bot_ada"), title: "Ada", body: "1" })
        yield* notifier.notify({ kind: "message", botId: botId("bot_ada"), title: "Ada", body: "2" })
        yield* profiles.switchTo(MAIN_PROFILE_ID)
        const live = yield* collect((yield* LiveHub).subscribeRoster({}))
        const after = yield* inProfile(MAIN_PROFILE_ID)(away.dismiss(first!.id))
        yield* eventually(Effect.map(live.items, (items) => rosterTypes(items).includes("away.changed")))
        return after
      }),
      layer(),
    )
    expect(out.items.map((i) => [i.notification.body, i.needsYou])).toEqual([["2", false]])
  })
})

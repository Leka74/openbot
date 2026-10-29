import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { inProfile, Notifier } from "@openbot/core"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { eventually } from "./helpers.ts"
import { connectOwner, type ProfileFixture, rosterSnapshot, startProfiles } from "./profile-isolation-helpers.ts"

let fixture: Awaited<ReturnType<typeof startProfiles>>
let sink: ReturnType<typeof Bun.serve>
let pushes: Array<{ path: string; body: Record<string, unknown> }>
let sinkUrl: string
/** The sink answers a push whose message starts with "hold" only once this resolves. */
let held: PromiseWithResolvers<void>

beforeEach(async () => {
  pushes = []
  held = Promise.withResolvers<void>()
  sink = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>
      if (String(body.message).startsWith("hold")) await held.promise
      pushes.push({ path: new URL(request.url).pathname, body })
      return Response.json({ id: "push", event: "message" })
    },
  })
  sinkUrl = `http://127.0.0.1:${sink.port}`
  fixture = await startProfiles({ config: { harkUrl: sinkUrl } })
}, 30_000)
afterEach(async () => {
  await fixture?.server.close()
  sink?.stop(true)
}, 30_000)

const notify = (profile: ProfileFixture, body: string) =>
  Effect.flatMap(Notifier, (notifier) =>
    notifier.notify({
      kind: "waiting",
      botId: profile.bot.id,
      conversationId: profile.bot.directConversationId,
      title: profile.bot.name,
      body,
    }),
  ).pipe(inProfile(profile.profileId))

describe("inactive profile notifications and connections", () => {
  test(
    "roster notifications hide inactive work and still deliver active work",
    () =>
      fixture.server.run(
        Effect.gen(function* () {
          const client = yield* connectOwner(fixture.server, fixture.cookie)
          const [a, b] = fixture.profiles
          for (const [inactive, active] of [
            [a, b],
            [b, a],
          ] as const) {
            yield* client["profiles.switch"]({ profileId: active.profileId })
            const ready = yield* Deferred.make<void>()
            const observed = yield* client["roster.subscribe"]({}).pipe(
              Stream.tap((item) => (item.kind === "synchronized" ? Deferred.succeed(ready, undefined) : Effect.void)),
              Stream.filter((item) => item.kind === "change" && item.change.type === "notification"),
              Stream.takeUntil(
                (item) =>
                  item.kind === "change" &&
                  item.change.type === "notification" &&
                  item.change.notification.body === "active sentinel",
              ),
              Stream.runCollect,
              Effect.forkScoped({ startImmediately: true }),
            )
            yield* Deferred.await(ready)
            yield* notify(inactive, `${inactive.marker} hidden notification`)
            yield* notify(active, "active sentinel")
            const items = yield* Fiber.join(observed)
            expect(JSON.stringify(items)).toContain("active sentinel")
            expect(JSON.stringify(items)).not.toContain(`${inactive.marker} hidden notification`)
          }
        }),
      ),
    30_000,
  )

  test(
    "a roster resume cursor from another profile cannot replay its changes",
    () =>
      fixture.server.run(
        Effect.gen(function* () {
          const client = yield* connectOwner(fixture.server, fixture.cookie)
          const [a, b] = fixture.profiles
          yield* client["profiles.switch"]({ profileId: a.profileId })
          const snapshot = yield* rosterSnapshot(client)
          expect(snapshot.kind).toBe("snapshot")
          if (snapshot.kind !== "snapshot") return
          yield* notify(a, "Cobalt replay secret")
          yield* client["profiles.switch"]({ profileId: b.profileId })
          const replay = yield* client["roster.subscribe"]({ after: snapshot.cursor }).pipe(
            Stream.takeUntil((item) => item.kind === "synchronized"),
            Stream.runCollect,
          )
          expect(JSON.stringify(replay)).not.toContain("Cobalt replay secret")
          expect(JSON.stringify(replay)).not.toContain(a.bot.id)
        }),
      ),
    30_000,
  )

  for (const app of ["hark", "ntfy"] as const) {
    test(
      `${app} starts disconnected in a new profile and restores its own connection on return`,
      () =>
        fixture.server.run(
          Effect.gen(function* () {
            const client = yield* connectOwner(fixture.server, fixture.cookie)
            const [a, b] = fixture.profiles
            yield* client["profiles.switch"]({ profileId: a.profileId })
            if (app === "hark") yield* client["hark.connect"]({ webhook: "whk_cobalt" })
            else yield* client["ntfy.connect"]({ topic: "cobalt", server: sinkUrl })
            yield* client["profiles.switch"]({ profileId: b.profileId })
            const hidden = app === "hark" ? yield* client["hark.status"]() : yield* client["ntfy.status"]()
            expect(hidden.connected).toBe(false)
            expect(JSON.stringify(hidden)).not.toContain("cobalt")
            yield* client["profiles.switch"]({ profileId: a.profileId })
            const restored = app === "hark" ? yield* client["hark.status"]() : yield* client["ntfy.status"]()
            expect(restored.connected).toBe(true)
          }),
        ),
      30_000,
    )

    test(
      `${app} never pushes inactive profile notifications to either profile's target`,
      () =>
        fixture.server.run(
          Effect.gen(function* () {
            const client = yield* connectOwner(fixture.server, fixture.cookie)
            const [a, b] = fixture.profiles
            for (const profile of [a, b]) {
              yield* client["profiles.switch"]({ profileId: profile.profileId })
              if (app === "hark") {
                yield* client["hark.connect"]({ webhook: `whk_${profile.marker.toLowerCase()}` })
                yield* client["hark.setQuietAtComputer"]({ quiet: false })
              } else {
                yield* client["ntfy.connect"]({ topic: profile.marker.toLowerCase(), server: sinkUrl })
                yield* client["ntfy.setQuietAtComputer"]({ quiet: false })
              }
            }
            pushes.length = 0
            yield* notify(a, "Cobalt hidden push")
            yield* notify(b, "Saffron active push")
            yield* eventually(
              Effect.sync(() => pushes),
              (items) => JSON.stringify(items).includes("Saffron active push"),
            )
            expect(JSON.stringify(pushes)).not.toContain("Cobalt hidden push")
            const active = pushes.find((push) => JSON.stringify(push.body).includes("Saffron active push"))!
            if (app === "hark") expect(active.path).toBe("/hooks/whk_saffron")
            else expect(active.body.topic).toBe("saffron")
          }),
        ),
      30_000,
    )
  }

  test(
    "a push waiting its turn goes to its own profile's phone after a switch",
    () =>
      fixture.server.run(
        Effect.gen(function* () {
          const client = yield* connectOwner(fixture.server, fixture.cookie)
          const [a, b] = fixture.profiles
          for (const profile of [a, b]) {
            yield* client["profiles.switch"]({ profileId: profile.profileId })
            yield* client["ntfy.connect"]({ topic: profile.marker.toLowerCase(), server: sinkUrl })
            yield* client["ntfy.setQuietAtComputer"]({ quiet: false })
          }
          yield* client["profiles.switch"]({ profileId: a.profileId })
          pushes.length = 0
          // four pushes the server holds take every slot, so the fifth waits until after the switch
          for (let i = 0; i < 4; i++) yield* notify(a, `hold ${i}`)
          yield* notify(a, "Cobalt waiting push")
          yield* client["profiles.switch"]({ profileId: b.profileId })
          held.resolve()
          yield* eventually(
            Effect.sync(() => pushes),
            (items) => JSON.stringify(items).includes("Cobalt waiting push"),
          )
          const waiting = pushes.find((push) => JSON.stringify(push.body).includes("Cobalt waiting push"))!
          expect(waiting.body.topic).toBe("cobalt")
          expect(pushes.every((push) => push.body.topic === "cobalt")).toBe(true)
        }),
      ),
    30_000,
  )
})

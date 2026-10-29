import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { projectFolderRoots } from "@openbot/brain-nodes"
import type { OwnerProfileId, StreamCursor } from "@openbot/contracts"
import { ReplicaLog, rosterReplicaKey } from "@openbot/core"
import { Effect, Exit, Option, Stream } from "effect"
import { eventually, type OpenBotClient } from "./helpers.ts"
import { connectOwner, type ProfileFixture, rosterSnapshot, startProfiles } from "./profile-isolation-helpers.ts"

let fixture: Awaited<ReturnType<typeof startProfiles>>
beforeEach(async () => {
  fixture = await startProfiles()
}, 30_000)
afterEach(async () => {
  await fixture?.server.close()
}, 30_000)

const checkProfiles = (
  name: string,
  check: (client: OpenBotClient, own: ProfileFixture, foreign: ProfileFixture) => Effect.Effect<unknown, unknown>,
) =>
  test(
    name,
    () =>
      fixture.server.run(
        Effect.gen(function* () {
          const client = yield* connectOwner(fixture.server, fixture.cookie)
          const [a, b] = fixture.profiles
          for (const [own, foreign] of [
            [a, b],
            [b, a],
          ] as const) {
            yield* client["profiles.switch"]({ profileId: own.profileId })
            yield* check(client, own, foreign)
          }
        }),
      ),
    30_000,
  )

const notFound = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(JSON.stringify(exit.cause)).toContain("NotFound")
  })

describe("profile isolation over owner RPCs", () => {
  checkProfiles("roster snapshots contain only the active profile's bots, chats and sections", (client, own, foreign) =>
    Effect.gen(function* () {
      const snapshot = yield* rosterSnapshot(client)
      expect(snapshot.kind).toBe("snapshot")
      expect(JSON.stringify(snapshot)).toContain(own.bot.id)
      expect(JSON.stringify(snapshot)).toContain(own.section.id)
      expect(JSON.stringify(snapshot)).not.toContain(foreign.marker)
      expect(JSON.stringify(snapshot)).not.toContain(foreign.bot.id)
      expect(JSON.stringify(snapshot)).not.toContain(foreign.bot.directConversationId)
    }),
  )

  checkProfiles("bots.get refuses a known bot id from another profile", (client, own, foreign) =>
    Effect.gen(function* () {
      expect((yield* client["bots.get"]({ botId: own.bot.id })).name).toBe(own.marker)
      yield* notFound(client["bots.get"]({ botId: foreign.bot.id }))
    }),
  )

  checkProfiles("bot and section mutations refuse ids from another profile", (client, own, foreign) =>
    Effect.gen(function* () {
      yield* notFound(client["bots.update"]({ botId: foreign.bot.id, patch: { name: "intruder" } }))
      yield* notFound(client["sections.rename"]({ sectionId: foreign.section.id, name: "intruder" }))
      yield* client["profiles.switch"]({ profileId: foreign.profileId })
      expect((yield* client["bots.get"]({ botId: foreign.bot.id })).name).toBe(foreign.marker)
      yield* client["profiles.switch"]({ profileId: own.profileId })
    }),
  )

  checkProfiles("conversation subscriptions refuse another profile's chat", (client, own, foreign) =>
    Effect.gen(function* () {
      const ownView = yield* client["conversations.subscribe"]({ conversationId: own.bot.directConversationId }).pipe(
        Stream.take(1),
        Stream.runCollect,
      )
      expect(JSON.stringify(ownView)).toContain(own.marker)
      yield* notFound(
        client["conversations.subscribe"]({ conversationId: foreign.bot.directConversationId }).pipe(
          Stream.take(1),
          Stream.runCollect,
        ),
      )
    }),
  )

  checkProfiles("conversation windows refuse foreign chat and entry ids", (client, own, foreign) =>
    Effect.gen(function* () {
      const page = yield* client["conversations.around"]({ conversationId: own.bot.directConversationId, limit: 20 })
      expect(page.entries.map((entry) => entry.id)).toContain(own.entry.id)
      yield* notFound(
        client["conversations.around"]({
          conversationId: foreign.bot.directConversationId,
          entryId: foreign.entry.id,
          limit: 20,
        }),
      )
    }),
  )

  checkProfiles("messages.send cannot wake another profile's bot", (client, _own, foreign) =>
    notFound(
      client["messages.send"]({
        conversationId: foreign.bot.directConversationId,
        text: "echo: intruder",
        clientNonce: "intruder-message",
      }),
    ),
  )

  checkProfiles("messages.send cannot attach a known foreign upload to an owned chat", (client, own, foreign) =>
    notFound(
      client["messages.send"]({
        conversationId: own.bot.directConversationId,
        text: "echo: intruder attachment",
        attachmentIds: [foreign.attachment.id],
        clientNonce: "intruder-attachment",
      }),
    ),
  )

  checkProfiles("group creation cannot add a bot from another profile", (client, own, foreign) =>
    notFound(
      client["conversations.createGroup"]({ title: "intruder group", memberBotIds: [own.bot.id, foreign.bot.id] }),
    ),
  )

  checkProfiles("a clientNonce used in another profile creates a new Bot and group here", (client, own, foreign) =>
    Effect.gen(function* () {
      // the foreign Bot was created with its marker as the clientNonce
      const input = { name: "Twin", harness: { kind: "fake" }, clientNonce: foreign.marker, introduce: false } as const
      const twin = yield* client["bots.create"](input)
      expect(twin.id).not.toBe(foreign.bot.id)
      expect(twin.ownerProfileId).toBe(own.profileId)
      expect((yield* client["bots.create"](input)).id).toBe(twin.id)
      const group = yield* client["conversations.createGroup"]({
        title: "",
        memberBotIds: [own.bot.id, twin.id],
        clientNonce: "same-group-nonce",
      })
      expect(group.kind === "group" && group.memberBotIds).toEqual([own.bot.id, twin.id])
    }),
  )

  checkProfiles("Send to OpenBot can only name a Bot of the active profile", (client, own, foreign) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(client["settings.update"]({ patch: { slackSendTo: foreign.bot.id } }))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(JSON.stringify(exit.cause)).toContain("InvalidInput")
      expect((yield* client["settings.update"]({ patch: { slackSendTo: own.bot.id } })).slackSendTo).toBe(own.bot.id)
    }),
  )

  checkProfiles("search.query and explicit conversation filters hide foreign indexed text", (client, own, foreign) =>
    Effect.gen(function* () {
      const found = yield* client["search.query"]({ query: own.marker, limit: 20 })
      expect(found.hits.length).toBeGreaterThan(0)
      expect(JSON.stringify(found)).not.toContain(foreign.marker)
      const hidden = yield* client["search.query"]({ query: foreign.marker, limit: 20 })
      expect(hidden.hits).toEqual([])
      expect(hidden.totalCapped).toBe(0)
      const byId = yield* client["search.query"]({
        query: foreign.marker,
        conversationIds: [foreign.bot.directConversationId],
        limit: 20,
      })
      expect(byId.hits).toEqual([])
      const sharedWord = yield* client["search.query"]({ query: "private", limit: 20 })
      expect(sharedWord.totalCapped).toBe(2)
      expect(sharedWord.hits.every((hit) => hit.conversationId === own.bot.directConversationId)).toBe(true)
    }),
  )

  checkProfiles("search.inConversation refuses a foreign chat id", (client, _own, foreign) =>
    notFound(
      client["search.inConversation"]({
        conversationId: foreign.bot.directConversationId,
        query: foreign.marker,
        limit: 20,
      }),
    ),
  )

  checkProfiles("routines.list hides foreign routines including an explicit bot filter", (client, own, foreign) =>
    Effect.gen(function* () {
      expect((yield* client["routines.list"]({})).map((routine) => routine.id)).toEqual([own.routine.id])
      expect(yield* client["routines.list"]({ botId: foreign.bot.id })).toEqual([])
    }),
  )

  checkProfiles("routines.runs and runNow refuse a foreign routine id", (client, own, foreign) =>
    Effect.gen(function* () {
      expect(yield* client["routines.runs"]({ routineId: own.routine.id })).toEqual([])
      yield* notFound(client["routines.runs"]({ routineId: foreign.routine.id }))
      yield* notFound(client["routines.runNow"]({ routineId: foreign.routine.id }))
    }),
  )

  checkProfiles("rules.list contains only the active profile's global rules", (client, own, foreign) =>
    Effect.gen(function* () {
      const rules = yield* client["rules.list"]({})
      expect(rules.map((rule) => rule.id)).toContain(own.rule.id)
      expect(rules.map((rule) => rule.id)).not.toContain(foreign.rule.id)
    }),
  )

  checkProfiles("settings.get returns the active profile's saved settings", (client, own) =>
    Effect.gen(function* () {
      expect((yield* client["settings.get"]()).ownerName).toBe(`${own.marker} owner`)
    }),
  )

  checkProfiles("tasks.list and tasks.get refuse another profile's work", (client, own, foreign) =>
    Effect.gen(function* () {
      expect((yield* client["tasks.list"]({ botId: own.bot.id })).map((task) => task.id)).toContain(own.task.id)
      yield* notFound(client["tasks.list"]({ botId: foreign.bot.id }))
      yield* notFound(client["tasks.get"]({ taskId: foreign.task.id }))
    }),
  )

  checkProfiles("memory.get and memory mutations refuse a foreign bot id", (client, own, foreign) =>
    Effect.gen(function* () {
      expect((yield* client["memory.get"]({ botId: own.bot.id })).facts).toContainEqual(own.fact)
      yield* notFound(client["memory.get"]({ botId: foreign.bot.id }))
      yield* notFound(
        client["memory.putFact"]({ botId: foreign.bot.id, fact: { title: "intruder", body: "intruder" } }),
      )
      yield* notFound(client["memory.deleteFact"]({ botId: foreign.bot.id, factId: foreign.fact.id }))
    }),
  )

  checkProfiles("skills.list and assignments stay within one profile", (client, own, foreign) =>
    Effect.gen(function* () {
      expect((yield* client["skills.list"]()).map((skill) => skill.name)).toEqual([own.skill.name])
      yield* notFound(client["skills.assign"]({ name: own.skill.name, botIds: [foreign.bot.id] }))
    }),
  )

  test(
    "skills with the same name keep separate bodies in each profile",
    () =>
      fixture.server.run(
        Effect.gen(function* () {
          const client = yield* connectOwner(fixture.server, fixture.cookie)
          const [a, b] = fixture.profiles
          yield* client["profiles.switch"]({ profileId: b.profileId })
          yield* client["skills.upsert"]({
            name: a.skill.name,
            description: "Saffron same-name skill",
            body: "Saffron same-name instructions",
          })
          yield* client["profiles.switch"]({ profileId: a.profileId })
          const skills = yield* client["skills.list"]()
          expect(skills.find((skill) => skill.name === a.skill.name)?.body).toBe("Cobalt instructions")
        }),
      ),
    30_000,
  )

  checkProfiles("attachments refuse foreign ids for full, ranged and download requests", (client, own, foreign) =>
    Effect.gen(function* () {
      const get = (id: string, suffix = "", range?: string) =>
        Effect.promise(async () => {
          const response = await fetch(`${fixture.server.base}/api/attachments/${id}${suffix}`, {
            headers: { cookie: fixture.cookie, ...(range === undefined ? {} : { range }) },
          })
          return { status: response.status, body: await response.text() }
        })
      expect(yield* get(own.attachment.id)).toEqual({ status: 200, body: `${own.marker} private attachment` })
      for (const [suffix, range] of [
        ["", undefined],
        ["", "bytes=0-3"],
        ["?download=1", undefined],
      ]) {
        const response = yield* get(foreign.attachment.id, suffix, range)
        expect(response.status).toBe(404)
        expect(response.body).not.toContain(foreign.marker)
      }
      expect((yield* client["profiles.list"]()).activeId).toBe(own.profileId)
    }),
  )

  test(
    "each Bot's project folder roots come from its own profile, whichever is active",
    () =>
      fixture.server.run(
        Effect.gen(function* () {
          const client = yield* connectOwner(fixture.server, fixture.cookie)
          const [a, b] = fixture.profiles
          for (const p of [b, a]) {
            yield* client["profiles.switch"]({ profileId: p.profileId })
            yield* client["settings.update"]({ patch: { sharedProjectFolders: [`/srv/${p.marker}-shared`] } })
            yield* client["bots.update"]({ botId: p.bot.id, patch: { projectFolders: [`/srv/${p.marker}-project`] } })
          }
          const roots = (yield* projectFolderRoots)!
          expect(roots(a.bot.id)).toEqual(["/srv/Cobalt-shared", "/srv/Cobalt-project"])
          expect(roots(b.bot.id)).toEqual(["/srv/Saffron-shared", "/srv/Saffron-project"])
          yield* client["profiles.switch"]({ profileId: b.profileId })
          yield* client["bots.update"]({ botId: b.bot.id, patch: { projectFolders: ["/srv/Saffron-moved"] } })
          yield* eventually(
            Effect.sync(() => roots(b.bot.id)),
            (folders) => folders.includes("/srv/Saffron-moved"),
          )
          expect(roots(a.bot.id)).toEqual(["/srv/Cobalt-shared", "/srv/Cobalt-project"])
        }),
      ),
    30_000,
  )

  test(
    "removals reach only the owning profile's roster",
    () =>
      fixture.server.run(
        Effect.gen(function* () {
          const client = yield* connectOwner(fixture.server, fixture.cookie)
          const log = yield* ReplicaLog
          const [a, b] = fixture.profiles
          const headOf = (profileId: OwnerProfileId) =>
            Effect.map(log.head(rosterReplicaKey(profileId)), Option.getOrThrow)
          const changesSince = (profileId: OwnerProfileId, cursor: StreamCursor) =>
            Effect.map(log.readAfter(rosterReplicaKey(profileId), cursor), (records) =>
              JSON.stringify(Option.getOrThrow(records)),
            )
          const before = { a: yield* headOf(a.profileId), b: yield* headOf(b.profileId) }
          yield* client["profiles.switch"]({ profileId: b.profileId })
          yield* client["sections.delete"]({ sectionId: b.section.id })
          yield* client["bots.delete"]({ botId: b.bot.id })
          const own = yield* changesSince(b.profileId, before.b)
          for (const removed of ["section.removed", "conversation.removed", "bot.removed"])
            expect(own).toContain(removed)
          const other = yield* changesSince(a.profileId, before.a)
          for (const id of [b.section.id, b.bot.id, b.bot.directConversationId]) expect(other).not.toContain(id)
        }),
      ),
    30_000,
  )

  test(
    "a switch closes the terminal of a Bot in the profile left",
    () =>
      fixture.server.run(
        Effect.gen(function* () {
          const client = yield* connectOwner(fixture.server, fixture.cookie)
          const [a, b] = fixture.profiles
          yield* client["profiles.switch"]({ profileId: a.profileId })
          const terminal = new WebSocket(`${fixture.server.wsBase}/ws/terminal/${a.bot.id}`, {
            headers: { cookie: fixture.cookie, origin: fixture.server.base },
          })
          const closed = new Promise<number>((resolve) =>
            terminal.addEventListener("close", (event) => resolve(event.code)),
          )
          yield* Effect.promise(
            () => new Promise((resolve) => terminal.addEventListener("message", resolve, { once: true })),
          )
          yield* client["profiles.switch"]({ profileId: b.profileId })
          expect(yield* Effect.promise(() => closed).pipe(Effect.timeout("5 seconds"))).toBe(1001)
        }),
      ),
    30_000,
  )

  test(
    "nodes and harness accounts remain shared after switching profiles",
    () =>
      fixture.server.run(
        Effect.gen(function* () {
          const client = yield* connectOwner(fixture.server, fixture.cookie)
          const [a, b] = fixture.profiles
          yield* client["profiles.switch"]({ profileId: a.profileId })
          const nodes = yield* client["nodes.list"]()
          const accounts = yield* client["harnesses.profiles"]({})
          const status = yield* client["harnesses.status"]()
          expect(nodes.length).toBeGreaterThan(0)
          expect(accounts.length).toBeGreaterThan(0)
          yield* client["profiles.switch"]({ profileId: b.profileId })
          expect(yield* client["nodes.list"]()).toEqual(nodes)
          expect(yield* client["harnesses.profiles"]({})).toEqual(accounts)
          const identity = (items: typeof status) => items.map(({ checkedAt: _checkedAt, ...account }) => account)
          expect(identity(yield* client["harnesses.status"]())).toEqual(identity(status))
        }),
      ),
    30_000,
  )
})

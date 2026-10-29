import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { SettingsRepo, SlackConnector } from "@openbot/core"
import { Effect } from "effect"
import { eventually } from "./helpers.ts"
import {
  FAKE_APP_TOKEN,
  FAKE_USER_TOKEN,
  type FakeSlack,
  shortcutEnvelope,
  startFakeSlack,
} from "./fixtures/fakeSlack.ts"
import { callTool, connectBot, connectOwner, startProfiles } from "./profile-isolation-helpers.ts"

let fixture: Awaited<ReturnType<typeof startProfiles>>
let slack: FakeSlack
beforeEach(async () => {
  slack = startFakeSlack()
  fixture = await startProfiles({ config: { slackApiUrl: slack.url } })
}, 30_000)
afterEach(async () => {
  await fixture?.server.close()
  slack?.stop()
}, 30_000)

describe("Slack belongs to an owner profile", () => {
  test(
    "switching away hides the Slack connection and switching back restores it",
    () =>
      fixture.server.run(
        Effect.gen(function* () {
          const client = yield* connectOwner(fixture.server, fixture.cookie)
          const [a, b] = fixture.profiles
          yield* client["profiles.switch"]({ profileId: a.profileId })
          expect((yield* client["slack.connect"]({ userToken: FAKE_USER_TOKEN })).connected).toBe(true)
          yield* client["profiles.switch"]({ profileId: b.profileId })
          const hidden = yield* client["slack.status"]()
          expect(hidden.connected).toBe(false)
          expect(JSON.stringify(hidden)).not.toContain("Acme")
          yield* client["slack.disconnect"]()
          yield* client["profiles.switch"]({ profileId: a.profileId })
          expect((yield* client["slack.status"]()).connected).toBe(true)
        }),
      ),
    30_000,
  )

  test(
    "MCP Slack tools use the bot's connection while the other profile is active",
    () =>
      fixture.server.run(
        Effect.gen(function* () {
          const client = yield* connectOwner(fixture.server, fixture.cookie)
          const [a, b] = fixture.profiles
          yield* client["profiles.switch"]({ profileId: a.profileId })
          yield* client["slack.connect"]({ userToken: FAKE_USER_TOKEN })
          yield* client["profiles.switch"]({ profileId: b.profileId })
          const aClient = yield* connectBot(a.bot)
          const bClient = yield* connectBot(b.bot)
          const result = yield* callTool(aClient, "slack_read", { conversation: "#general" })
          expect(result.isError).toBe(false)
          expect(result.text).toContain("deploy failed")
          const calls = slack.calls.length
          const hidden = yield* callTool(bClient, "slack_read", { conversation: "#general" })
          expect(hidden.isError).toBe(true)
          expect(hidden.text).not.toContain("deploy failed")
          expect(slack.calls.length).toBe(calls)
        }),
      ),
    30_000,
  )

  test(
    "forgetting a profile closes its Slack and leaves the other profile's connected",
    () =>
      fixture.server.run(
        Effect.gen(function* () {
          const client = yield* connectOwner(fixture.server, fixture.cookie)
          const [a, b] = fixture.profiles
          for (const profile of [a, b]) {
            yield* client["profiles.switch"]({ profileId: profile.profileId })
            yield* client["slack.connect"]({ userToken: FAKE_USER_TOKEN, appToken: FAKE_APP_TOKEN })
            yield* eventually(client["slack.status"](), (status) => status.events === "live")
          }
          yield* eventually(
            Effect.sync(() => slack.sockets()),
            (count) => count === 2,
          )
          yield* client["profiles.switch"]({ profileId: a.profileId })
          yield* (yield* SlackConnector).forget(b.profileId)
          yield* eventually(
            Effect.sync(() => slack.sockets()),
            (count) => count === 1,
          )
          expect((yield* client["slack.status"]()).events).toBe("live")
        }),
      ),
    30_000,
  )

  test(
    "Send to OpenBot never picks another profile's Bot, even from a stale setting",
    () =>
      fixture.server.run(
        Effect.gen(function* () {
          const client = yield* connectOwner(fixture.server, fixture.cookie)
          const [a] = fixture.profiles
          const empty = yield* client["profiles.create"]({ name: "Empty" })
          // saved before Send to OpenBot checked the profile
          yield* (yield* SettingsRepo).forProfile(empty.id).set("slackSendTo", a.bot.id)
          yield* client["profiles.switch"]({ profileId: empty.id })
          yield* client["slack.connect"]({ userToken: FAKE_USER_TOKEN, appToken: FAKE_APP_TOKEN })
          yield* eventually(client["slack.status"](), (status) => status.events === "live", { label: "live" })
          slack.push(
            shortcutEnvelope({
              by: "U_OWNER",
              channel: "C_GENERAL",
              message: { ts: "1729340300.000100", user: "U_BOB", text: "Rollback done" },
              responseUrl: slack.responseUrl,
            }),
          )
          yield* eventually(
            Effect.sync(() => slack.responses.length),
            (n) => n === 1,
            { label: "the reply" },
          )
          expect(slack.responses).toEqual([
            { response_type: "ephemeral", text: "There's no Bot in OpenBot yet: create one first." },
          ])
        }),
      ),
    30_000,
  )
})

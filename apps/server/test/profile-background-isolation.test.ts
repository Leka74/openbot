import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { inProfile, RoutineScheduler } from "@openbot/core"
import { Effect } from "effect"
import { eventually } from "./helpers.ts"
import { connectOwner, startProfiles } from "./profile-isolation-helpers.ts"

let fixture: Awaited<ReturnType<typeof startProfiles>>
beforeEach(async () => {
  fixture = await startProfiles()
}, 30_000)
afterEach(async () => {
  await fixture?.server.close()
}, 30_000)

describe("background work while the owner views another profile", () => {
  for (const output of ["direct", "own-conversation"] as const) {
    test(
      `${output} routine uses its bot's MCP profile and writes into its own chat`,
      () =>
        fixture.server.run(
          Effect.gen(function* () {
            const client = yield* connectOwner(fixture.server, fixture.cookie)
            const [a, b] = fixture.profiles
            for (const [own, active] of [
              [a, b],
              [b, a],
            ] as const) {
              yield* client["profiles.switch"]({ profileId: own.profileId })
              yield* client["routines.update"]({
                routineId: own.routine.id,
                spec: {
                  name: own.routine.name,
                  prompt: "tool: list_bots {}",
                  trigger: { type: "manual" },
                  enabled: true,
                  output,
                },
              })
              yield* client["profiles.switch"]({ profileId: active.profileId })
              const before = yield* client["conversations.around"]({
                conversationId: active.bot.directConversationId,
                limit: 50,
              })
              const scheduler = yield* RoutineScheduler
              const run = yield* scheduler.runNow(own.routine.id).pipe(inProfile(own.profileId))
              const runs = yield* eventually(scheduler.runs(own.routine.id).pipe(inProfile(own.profileId)), (items) =>
                items.some((item) => item.id === run.id && item.status !== "running"),
              )
              expect(runs.find((item) => item.id === run.id)?.status).toBe("succeeded")
              expect((yield* client["profiles.list"]()).activeId).toBe(active.profileId)
              const activeChat = yield* client["conversations.around"]({
                conversationId: active.bot.directConversationId,
                limit: 50,
              })
              expect(activeChat.entries).toEqual(before.entries)
              yield* client["profiles.switch"]({ profileId: own.profileId })
              const ownChat = yield* client["conversations.around"]({ conversationId: run.conversationId, limit: 50 })
              const result = ownChat.entries.find(
                (entry) => entry.kind === "message" && entry.text.startsWith("I called list_bots"),
              )
              expect(result?.kind).toBe("message")
              if (result?.kind !== "message") return
              expect(result.text).toContain(own.marker)
              expect(result.text).not.toContain(active.marker)
            }
          }),
        ),
      30_000,
    )
  }
})

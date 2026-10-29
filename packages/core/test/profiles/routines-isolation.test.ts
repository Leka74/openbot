import { describe, expect, test } from "bun:test"
import { MAIN_PROFILE_ID, type BotId, type OwnerProfileId } from "@openbot/contracts"
import { Effect, Layer, Option } from "effect"
import {
  BotRepo,
  ConversationRepo,
  CurrentProfile,
  inProfile,
  Orchestrator,
  OwnerProfiles,
  RoutineRepo,
  RoutineScheduler,
  userActor,
} from "../../src/ports/index.ts"
import { OwnerProfilesLive } from "../../src/services/profiles/index.ts"
import { RoutineSchedulerLive } from "../../src/services/automation/index.ts"
import {
  advance,
  botId,
  makeBot,
  makeDirectConversation,
  makeRoutine,
  OrchestratorFake,
  routineId,
  runTest,
  setTime,
} from "../../src/testing/index.ts"
import { baseLayer, eventually } from "../automation/helpers.ts"

const recording = (seen: Array<{ botId: BotId; profileId: OwnerProfileId | undefined }>) =>
  Layer.effect(
    Orchestrator,
    Effect.gen(function* () {
      const base = yield* Orchestrator
      return Orchestrator.of({
        ...base,
        deliver: (input) =>
          Effect.gen(function* () {
            const profile = yield* Effect.serviceOption(CurrentProfile)
            seen.push({
              botId: input.botId,
              profileId: Option.getOrUndefined(Option.map(profile, (value) => value.id)),
            })
            return yield* base.deliver(input)
          }),
      })
    }),
  )

describe("background routines preserve their profile", () => {
  for (const output of ["direct", "own-conversation"] as const) {
    test(`scheduled ${output} runs keep firing in inactive profiles with the bot's context`, () => {
      const seen: Array<{ botId: BotId; profileId: OwnerProfileId | undefined }> = []
      const layer = RoutineSchedulerLive.pipe(
        Layer.provideMerge(OwnerProfilesLive),
        Layer.provideMerge(recording(seen)),
        Layer.provideMerge(baseLayer({ autoComplete: { status: "completed", lastBotMessage: "done" } })),
      )
      return runTest(
        Effect.gen(function* () {
          const profiles = yield* OwnerProfiles
          const demo = yield* profiles.create("Demo")
          const bots = yield* BotRepo
          const conversations = yield* ConversationRepo
          const scheduler = yield* RoutineScheduler
          const a = makeBot({ id: botId("bot_main"), name: "Main", ownerProfileId: MAIN_PROFILE_ID })
          const b = makeBot({ id: botId("bot_demo"), name: "Demo", ownerProfileId: demo.id })
          const routines = []
          for (const [bot, everyMinutes] of [
            [a, 5],
            [b, 10],
          ] as const) {
            yield* bots.upsert(bot).pipe(inProfile(bot.ownerProfileId))
            yield* conversations
              .upsert(makeDirectConversation({ id: bot.directConversationId, botId: bot.id }))
              .pipe(inProfile(bot.ownerProfileId))
            routines.push(
              yield* scheduler
                .create(userActor, {
                  botId: bot.id,
                  spec: {
                    name: bot.name,
                    prompt: `${bot.name} private work`,
                    trigger: { type: "interval", everyMinutes },
                    enabled: true,
                    output,
                  },
                })
                .pipe(inProfile(bot.ownerProfileId)),
            )
          }
          yield* profiles.switchTo(demo.id)
          yield* advance("5 minutes")
          yield* eventually(Effect.map((yield* OrchestratorFake).deliveries, (items) => items.length === 1))
          expect(seen).toEqual([{ botId: a.id, profileId: MAIN_PROFILE_ID }])
          yield* profiles.switchTo(MAIN_PROFILE_ID)
          yield* advance("5 minutes")
          yield* eventually(Effect.map((yield* OrchestratorFake).deliveries, (items) => items.length === 3))
          expect(seen.filter((item) => item.botId === b.id)).toEqual([{ botId: b.id, profileId: demo.id }])
          for (const routine of routines) {
            const profileId = routine.botId === a.id ? MAIN_PROFILE_ID : demo.id
            const runs = yield* scheduler.runs(routine.id).pipe(inProfile(profileId))
            expect(runs.length).toBeGreaterThan(0)
            for (const run of runs) {
              const conversation = yield* conversations.get(run.conversationId).pipe(inProfile(profileId))
              expect(Option.getOrThrow(conversation)).toMatchObject({ botId: routine.botId })
            }
          }
        }),
        layer,
      )
    })
  }

  test("boot catch-up fires a non-main profile's missed routine in its own context", () => {
    const seen: Array<{ botId: BotId; profileId: OwnerProfileId | undefined }> = []
    const layer = OwnerProfilesLive.pipe(
      Layer.provideMerge(recording(seen)),
      Layer.provideMerge(baseLayer({ autoComplete: { status: "completed", lastBotMessage: "done" } })),
    )
    return runTest(
      Effect.gen(function* () {
        const profiles = yield* OwnerProfiles
        const demo = yield* profiles.create("Demo")
        const bot = makeBot({ id: botId("bot_catchup"), ownerProfileId: demo.id })
        yield* (yield* BotRepo).upsert(bot).pipe(inProfile(demo.id))
        yield* (yield* ConversationRepo)
          .upsert(makeDirectConversation({ id: bot.directConversationId, botId: bot.id }))
          .pipe(inProfile(demo.id))
        yield* setTime(60 * 60_000)
        const routine = makeRoutine({ id: routineId("rtn_catchup"), botId: bot.id, nextRunAt: 30 * 60_000 })
        yield* (yield* RoutineRepo).upsert(routine).pipe(inProfile(demo.id))
        yield* profiles.switchTo(MAIN_PROFILE_ID)
        yield* Effect.gen(function* () {
          yield* eventually(Effect.map((yield* OrchestratorFake).deliveries, (items) => items.length === 1))
          expect(seen).toEqual([{ botId: bot.id, profileId: demo.id }])
          const runs = yield* (yield* RoutineScheduler).runs(routine.id).pipe(inProfile(demo.id))
          expect(runs[0]?.firedBy).toBe("catch-up")
        }).pipe(Effect.provide(RoutineSchedulerLive))
      }),
      layer,
    )
  })
})

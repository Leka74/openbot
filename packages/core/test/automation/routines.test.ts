import { describe, expect, test } from "bun:test"
import type { RoutineSpec, TranscriptEntry } from "@openbot/contracts"
import { ROUTINE_RUNS_KEPT } from "@openbot/contracts"
import { Effect, Exit, Fiber, Layer, Option } from "effect"
import {
  botActor,
  ConversationRepo,
  EntryRepo,
  Orchestrator,
  RoutineGate,
  type RoutineGateResult,
  RoutineRepo,
  RoutineScheduler,
  userActor,
} from "../../src/ports/index.ts"
import { RoutineSchedulerLive } from "../../src/services/automation/index.ts"
import { DONE_ONCE_RETENTION_MS } from "../../src/services/automation/RoutineScheduler.ts"
import {
  advance,
  ConversationServiceFake,
  entryId,
  makeClaims,
  makeEventEntry,
  makeMessageEntry,
  makeRoutine,
  OrchestratorFake,
  routineId,
  routineRunId,
  runTest,
  setTime,
} from "../../src/testing/index.ts"
import { BOT_A, BOT_B, baseLayer, DM_A, eventually, seed } from "./helpers.ts"

const done = { status: "completed" as const, lastBotMessage: "All done: 3 new items." }
const layer = (autoComplete = true) =>
  RoutineSchedulerLive.pipe(Layer.provideMerge(baseLayer(autoComplete ? { autoComplete: done } : undefined)))

const hourly: RoutineSpec = {
  name: "Inbox sweep",
  prompt: "Check the inbox",
  trigger: { type: "interval", everyMinutes: 60 },
  enabled: true,
  output: "direct",
}

const deliveries = Effect.flatMap(OrchestratorFake, (o) => o.deliveries)
const deliveryCount = (n: number) => Effect.map(deliveries, (all) => all.length === n)
const runsOf = (id: Parameters<RoutineScheduler["Service"]["runs"]>[0]) =>
  Effect.flatMap(RoutineScheduler, (s) => s.runs(id))
const routineEvents = Effect.flatMap(ConversationServiceFake, (c) => c.written).pipe(
  Effect.map((all) => all.filter((e): e is Extract<TranscriptEntry, { kind: "event" }> => e.kind === "event")),
)

describe("RoutineScheduler", () => {
  test("an interval routine fires on schedule with TestClock, closes its run and reschedules", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const scheduler = yield* RoutineScheduler
        const routine = yield* scheduler.create(userActor, { botId: BOT_A.id, spec: hourly })
        yield* advance("59 minutes")
        const before = (yield* deliveries).length
        yield* advance("1 minute")
        yield* eventually(deliveryCount(1))
        yield* eventually(Effect.map(runsOf(routine.id), (runs) => runs[0]?.status === "succeeded"))
        const firstRuns = yield* runsOf(routine.id)
        const afterFirst = yield* scheduler.get(routine.id)
        yield* advance("60 minutes")
        yield* eventually(deliveryCount(2))
        return { routine, before, firstRuns, afterFirst, deliveries: yield* deliveries, events: yield* routineEvents }
      }),
      layer(),
    )
    expect(out.routine).toMatchObject({ enabled: true, nextRunAt: 60 * 60_000 })
    expect(out.before).toBe(0)
    expect(out.deliveries[0]).toMatchObject({
      botId: BOT_A.id,
      conversationId: DM_A.id,
      kind: "routine",
      urgency: "urgent",
      mode: "queue",
      routineRunId: out.firstRuns[0]!.id,
    })
    expect(out.deliveries[0]!.text).toContain("Check the inbox")
    expect(out.firstRuns).toHaveLength(1)
    expect(out.firstRuns[0]).toMatchObject({
      firedBy: "schedule",
      status: "succeeded",
      startedAt: 60 * 60_000,
      conversationId: DM_A.id,
      summary: "All done: 3 new items.",
    })
    expect(out.firstRuns[0]!.turnId).toBeDefined()
    expect(out.afterFirst).toMatchObject({
      lastRunAt: 60 * 60_000,
      lastRunStatus: "succeeded",
      nextRunAt: 120 * 60_000,
    })
    // The "Routine ‹name› started" event line is updated with the final status.
    const runEvent = out.events.findLast((e) => e.event.type === "routine-run")
    expect(runEvent).toMatchObject({
      conversationId: DM_A.id,
      event: { type: "routine-run", routineName: "Inbox sweep", status: "succeeded" },
    })
    expect(runEvent!.revision).toBeGreaterThan(0)
  })

  test("a once routine switches itself off after its scheduled run; Run now is tagged manual; done ones are removed after 7 days", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const scheduler = yield* RoutineScheduler
        const routine = yield* scheduler.create(userActor, {
          botId: BOT_A.id,
          spec: {
            name: "BOO reminder",
            prompt: "Say BOO",
            trigger: { type: "once", at: 5 * 60_000 },
            enabled: true,
            output: "direct",
          },
        })
        yield* advance("5 minutes")
        yield* eventually(deliveryCount(1))
        yield* eventually(Effect.map(runsOf(routine.id), (runs) => runs[0]?.status === "succeeded"))
        const afterRun = yield* scheduler.get(routine.id)
        yield* scheduler.runNow(routine.id)
        yield* eventually(deliveryCount(2))
        yield* eventually(
          Effect.map(runsOf(routine.id), (runs) => runs.length === 2 && runs.every((r) => r.status === "succeeded")),
        )
        const afterManual = yield* scheduler.get(routine.id)
        yield* advance(`${Math.ceil(DONE_ONCE_RETENTION_MS / 3_600_000) + 2} hours`)
        const gone = yield* Effect.exit(scheduler.get(routine.id))
        return { afterRun, afterManual, deliveries: yield* deliveries, gone }
      }),
      layer(),
    )
    expect(out.afterRun.enabled).toBe(false)
    expect(out.afterRun.nextRunAt).toBeUndefined()
    expect(out.afterRun.lastRunAt).toBe(5 * 60_000)
    expect(out.deliveries[0]!.text).toContain("scheduled run")
    expect(out.deliveries[1]!.text).toContain("manual run")
    expect(out.deliveries[1]!.text).toContain("not a duplicate")
    expect(out.afterManual.enabled).toBe(false)
    expect(Exit.isFailure(out.gone)).toBe(true)
  })

  test("a cron routine fires at the next matching time in its timezone", async () => {
    const start = Date.parse("2026-10-15T06:00:00Z")
    const out = await runTest(
      Effect.gen(function* () {
        // Move the clock before the scheduler starts: TestClock would otherwise replay its hourly
        // re-checks across the whole jump.
        yield* setTime(start)
        yield* seed
        return yield* Effect.gen(function* () {
          const scheduler = yield* RoutineScheduler
          const routine = yield* scheduler.create(userActor, {
            botId: BOT_A.id,
            spec: {
              ...hourly,
              name: "Morning brief",
              trigger: { type: "cron", schedule: "0 9 * * *", timezone: "Europe/Berlin" },
            },
          })
          yield* advance("59 minutes")
          const before = (yield* deliveries).length
          yield* advance("1 minute")
          yield* eventually(deliveryCount(1))
          return { routine, before, after: yield* scheduler.get(routine.id) }
        }).pipe(Effect.provide(RoutineSchedulerLive))
      }),
      baseLayer({ autoComplete: done }),
    )
    expect(out.routine.nextRunAt).toBe(Date.parse("2026-10-15T07:00:00Z"))
    expect(out.before).toBe(0)
    expect(out.after.nextRunAt).toBe(Date.parse("2026-10-16T07:00:00Z"))
  })

  test("keeps only the last 20 runs, newest first", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const scheduler = yield* RoutineScheduler
        const routine = yield* scheduler.create(userActor, {
          botId: BOT_A.id,
          spec: { ...hourly, trigger: { type: "interval", everyMinutes: 5 } },
        })
        for (let i = 1; i <= 25; i++) {
          yield* advance("5 minutes")
          yield* eventually(deliveryCount(i))
          yield* eventually(Effect.map(runsOf(routine.id), (runs) => runs[0]?.status === "succeeded"))
        }
        return yield* runsOf(routine.id)
      }),
      layer(),
    )
    expect(out).toHaveLength(ROUTINE_RUNS_KEPT)
    expect(out[0]!.startedAt).toBe(25 * 5 * 60_000)
    expect(out[19]!.startedAt).toBe(6 * 5 * 60_000)
  })

  test("runNow starts a test run; a second runNow while it runs is a Conflict; completion closes it", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const scheduler = yield* RoutineScheduler
        const routine = yield* scheduler.create(userActor, {
          botId: BOT_A.id,
          spec: { ...hourly, trigger: { type: "manual" } },
        })
        const run = yield* scheduler.runNow(routine.id)
        const conflict = yield* Effect.exit(scheduler.runNow(routine.id))
        const delivery = (yield* deliveries)[0]!
        yield* (yield* OrchestratorFake).complete(delivery.id, { status: "failed" })
        yield* eventually(
          Effect.map(runsOf(routine.id), (runs) => runs.find((r) => r.id === run.id)?.status === "failed"),
        )
        const second = yield* scheduler.runNow(routine.id)
        return { routine, run, conflict, runs: yield* runsOf(routine.id), second }
      }),
      layer(false),
    )
    expect(out.routine.nextRunAt).toBeUndefined()
    expect(out.run).toMatchObject({ firedBy: "manual", status: "running" })
    expect(out.run.turnId).toBeDefined()
    expect(Exit.isFailure(out.conflict) && JSON.stringify(out.conflict.cause)).toContain("Conflict")
    expect(out.runs.find((r) => r.id === out.run.id)).toMatchObject({
      status: "failed",
      error: "The bot's turn failed.",
    })
    expect(out.second.status).toBe("running")
  })

  test("boot catch-up: one run for a routine missed within 24 h; older misses only reschedule", async () => {
    const now = 10 * 24 * 60 * 60_000
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        yield* setTime(now)
        const repo = yield* RoutineRepo
        const recent = makeRoutine({ id: routineId("rtn_recent"), botId: BOT_A.id, nextRunAt: now - 60 * 60_000 })
        const stale = makeRoutine({
          id: routineId("rtn_stale"),
          name: "Stale",
          botId: BOT_A.id,
          nextRunAt: now - 30 * 60 * 60_000,
        })
        const paused = makeRoutine({
          id: routineId("rtn_paused"),
          name: "Paused",
          botId: BOT_A.id,
          enabled: false,
          nextRunAt: now - 1,
        })
        for (const r of [recent, stale, paused]) yield* repo.upsert(r)
        // Build the scheduler now (as at brain boot), after the clock moved.
        return yield* Effect.gen(function* () {
          yield* eventually(deliveryCount(1))
          const scheduler = yield* RoutineScheduler
          return {
            recentRuns: yield* scheduler.runs(recent.id),
            staleRuns: yield* scheduler.runs(stale.id),
            pausedRuns: yield* scheduler.runs(paused.id),
            stale: yield* scheduler.get(stale.id),
            recent: yield* scheduler.get(recent.id),
          }
        }).pipe(Effect.provide(RoutineSchedulerLive))
      }),
      baseLayer({ autoComplete: done }),
    )
    expect(out.recentRuns).toHaveLength(1)
    expect(out.recentRuns[0]!.firedBy).toBe("catch-up")
    expect(out.recent.nextRunAt).toBe(now + 60 * 60_000)
    expect(out.staleRuns).toHaveLength(0)
    expect(out.stale.nextRunAt).toBe(now + 60 * 60_000)
    expect(out.pausedRuns).toHaveLength(0)
  })

  test("own-conversation output opens a routine-run conversation per run", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const scheduler = yield* RoutineScheduler
        const routine = yield* scheduler.create(userActor, {
          botId: BOT_A.id,
          spec: { ...hourly, output: "own-conversation" },
        })
        const run = yield* scheduler.runNow(routine.id)
        const conversation = yield* Effect.flatMap(ConversationRepo, (r) => r.get(run.conversationId)).pipe(
          Effect.map(Option.getOrThrow),
        )
        return { run, conversation, delivery: (yield* deliveries)[0]! }
      }),
      layer(),
    )
    expect(out.conversation).toMatchObject({
      kind: "routine-run",
      botId: BOT_A.id,
      runId: out.run.id,
      title: "Inbox sweep",
    })
    expect(out.delivery.conversationId).toBe(out.run.conversationId)
  })

  test("validation, ownership, pause/resume and the transcript notes", async () => {
    const claimsA = makeClaims({ botId: BOT_A.id, conversationId: DM_A.id })
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const scheduler = yield* RoutineScheduler
        const notMine = yield* Effect.exit(
          scheduler.create(botActor({ claims: claimsA }), { botId: BOT_B.id, spec: hourly }),
        )
        const past = yield* Effect.exit(
          scheduler.create(userActor, { botId: BOT_A.id, spec: { ...hourly, trigger: { type: "once", at: 0 } } }),
        )
        const badCron = yield* Effect.exit(
          scheduler.create(userActor, {
            botId: BOT_A.id,
            spec: { ...hourly, trigger: { type: "cron", schedule: "x", timezone: "UTC" } },
          }),
        )
        const created = yield* scheduler.create(botActor({ claims: claimsA }), { botId: BOT_A.id, spec: hourly })
        const duplicate = yield* Effect.exit(scheduler.create(userActor, { botId: BOT_A.id, spec: hourly }))
        const paused = yield* scheduler.setEnabled(created.id, false)
        const resumedAt = 30 * 60_000
        yield* advance("30 minutes")
        const resumed = yield* scheduler.setEnabled(created.id, true)
        const renamed = yield* scheduler.update(userActor, {
          routineId: created.id,
          spec: { ...hourly, name: "Renamed" },
        })
        yield* scheduler.delete(created.id)
        const gone = yield* Effect.exit(scheduler.get(created.id))
        const written = yield* (yield* ConversationServiceFake).written
        return { notMine, past, badCron, created, duplicate, paused, resumed, resumedAt, renamed, gone, written }
      }),
      layer(),
    )
    for (const exit of [out.notMine, out.past, out.badCron]) {
      expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("InvalidInput")
    }
    expect(Exit.isFailure(out.duplicate) && JSON.stringify(out.duplicate.cause)).toContain("Conflict")
    expect(out.paused.enabled).toBe(false)
    expect(out.paused.nextRunAt).toBeUndefined()
    expect(out.resumed.nextRunAt).toBe(out.resumedAt + 60 * 60_000)
    // Same trigger: the schedule is kept on update.
    expect(out.renamed).toMatchObject({ name: "Renamed", nextRunAt: out.resumed.nextRunAt })
    expect(Exit.isFailure(out.gone)).toBe(true)
    const card = out.written.find((e) => e.kind === "card")
    expect(card).toMatchObject({
      conversationId: DM_A.id,
      author: { kind: "bot", botId: BOT_A.id },
      card: { type: "routine", action: "created", name: "Inbox sweep", triggerSummary: "Every hour" },
      state: { status: "info" },
    })
    const changes = out.written.flatMap((e) =>
      e.kind === "event" && e.event.type === "routine-changed" ? [e.event.action] : [],
    )
    expect(changes).toEqual(["disabled", "enabled", "updated", "deleted"])
  })
})

describe("a run whose delivery dies or is cancelled", () => {
  const withDeliver = (deliver: Effect.Effect<never>) =>
    RoutineSchedulerLive.pipe(
      Layer.provide(
        Layer.effect(
          Orchestrator,
          Effect.gen(function* () {
            return Orchestrator.of({ ...(yield* Orchestrator), deliver: () => deliver })
          }),
        ),
      ),
      Layer.provideMerge(baseLayer()),
    )
  const manual: RoutineSpec = { ...hourly, trigger: { type: "manual" } }

  test("a defect closes the run as failed and the routine can run again", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const scheduler = yield* RoutineScheduler
        const routine = yield* scheduler.create(userActor, { botId: BOT_A.id, spec: manual })
        yield* Effect.exit(scheduler.runNow(routine.id))
        const second = yield* Effect.exit(scheduler.runNow(routine.id))
        return { second, runs: yield* runsOf(routine.id) }
      }),
      withDeliver(Effect.die("boom")),
    )
    expect(JSON.stringify(out.second)).not.toContain("Conflict")
    expect(out.runs.map((r) => [r.status, r.error])).toEqual([
      ["failed", "Internal error."],
      ["failed", "Internal error."],
    ])
  })

  test("an interruption closes the run as interrupted", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const scheduler = yield* RoutineScheduler
        const routine = yield* scheduler.create(userActor, { botId: BOT_A.id, spec: manual })
        const fiber = yield* Effect.forkChild(scheduler.runNow(routine.id))
        yield* eventually(Effect.map(runsOf(routine.id), (runs) => runs.length === 1))
        yield* Fiber.interrupt(fiber)
        return yield* runsOf(routine.id)
      }),
      withDeliver(Effect.never),
    )
    expect(out.map((r) => r.status)).toEqual(["interrupted"])
  })
})

describe("routine runs with nothing to say", () => {
  const silentLayer = RoutineSchedulerLive.pipe(
    Layer.provideMerge(baseLayer({ autoComplete: { status: "completed" } })),
  )
  const dmEntries = Effect.flatMap(EntryRepo, (repo) => repo.page({ conversationId: DM_A.id, limit: 100 })).pipe(
    Effect.orDie,
    Effect.map((page) => page.entries),
  )

  test("a run that ends without a message leaves no line in the chat; the run is still recorded", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const scheduler = yield* RoutineScheduler
        const routine = yield* scheduler.create(userActor, { botId: BOT_A.id, spec: hourly })
        yield* scheduler.runNow(routine.id)
        yield* eventually(Effect.map(runsOf(routine.id), (runs) => runs[0]?.status === "succeeded"))
        yield* eventually(
          Effect.map(dmEntries, (all) => !all.some((e) => e.kind === "event" && e.event.type === "routine-run")),
        )
        return { runs: yield* runsOf(routine.id), entries: yield* dmEntries }
      }),
      silentLayer,
    )
    expect(out.runs[0]).toMatchObject({ status: "succeeded" })
    expect(out.runs[0]!.summary).toBeUndefined()
    expect(out.entries.filter((e) => e.kind === "event" && e.event.type === "routine-run")).toEqual([])
  })

  test("at boot, lines of earlier silent runs go; a run that said something keeps its line", async () => {
    const run = (id: string, at: number) =>
      makeEventEntry({
        id: entryId(`ent_run_${id}`),
        conversationId: DM_A.id,
        createdAt: at,
        updatedAt: at,
        event: {
          type: "routine-run",
          routineId: routineId("rtn_brief"),
          routineName: "Briefing",
          runId: routineRunId(`run_${id}`),
          status: "succeeded",
        },
      })
    const seeded = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* seed
        const repo = yield* EntryRepo
        for (const entry of [
          run("1", 1_000),
          run("2", 2_000),
          makeMessageEntry({
            id: entryId("ent_said"),
            conversationId: DM_A.id,
            createdAt: 2_500,
            updatedAt: 2_500,
            role: "bot",
            author: { kind: "bot", botId: BOT_A.id },
            text: "Meeting at 3",
          }),
          run("3", 3_000),
          makeMessageEntry({
            id: entryId("ent_owner"),
            conversationId: DM_A.id,
            createdAt: 3_500,
            updatedAt: 3_500,
            text: "thanks",
          }),
          run("4", 4_000),
        ])
          yield* repo.upsert(entry).pipe(Effect.orDie)
      }),
    )
    const remaining = await runTest(
      Effect.gen(function* () {
        yield* eventually(Effect.map(dmEntries, (all) => all.length === 3))
        return (yield* dmEntries).map((e) => e.id)
      }),
      RoutineSchedulerLive.pipe(Layer.provideMerge(seeded), Layer.provideMerge(baseLayer())),
    )
    expect(remaining.map(String)).toEqual(["ent_run_2", "ent_said", "ent_owner"])
  })
})

describe("RoutineScheduler gates", () => {
  /** A gate whose verdicts are taken in order (the last one repeats); `checked` counts its runs. */
  const gated = (verdicts: ReadonlyArray<RoutineGateResult>) => {
    const calls = { checked: 0 }
    const gate = Layer.succeed(
      RoutineGate,
      RoutineGate.of({
        check: () => Effect.sync(() => verdicts[Math.min(calls.checked++, verdicts.length - 1)]!),
      }),
    )
    const scheduler = RoutineSchedulerLive.pipe(Layer.provide(gate))
    return { calls, scheduler, layer: scheduler.pipe(Layer.provideMerge(baseLayer({ autoComplete: done }))) }
  }

  test("exit 0: the run goes ahead with the gate's output after the prompt (none when it printed nothing)", async () => {
    const { calls, layer } = gated([
      { _tag: "pass", output: "  3 new mails\n" },
      { _tag: "pass", output: "" },
    ])
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const routine = yield* (yield* RoutineScheduler).create(userActor, { botId: BOT_A.id, spec: hourly })
        yield* advance("60 minutes")
        yield* eventually(deliveryCount(1))
        yield* eventually(Effect.map(runsOf(routine.id), (runs) => runs[0]?.status === "succeeded"))
        yield* advance("60 minutes")
        yield* eventually(deliveryCount(2))
        return yield* deliveries
      }),
      layer,
    )
    expect(calls.checked).toBe(2)
    expect(out[0]!.text).toContain("Check the inbox\n\nGate output:\n3 new mails\n\n")
    expect(out[1]!.text).not.toContain("Gate output")
  })

  test("exit 1: the fire is skipped quietly and the schedule moves on; the next fire runs", async () => {
    const { calls, layer } = gated([{ _tag: "skip" }, { _tag: "pass", output: "" }])
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const scheduler = yield* RoutineScheduler
        const routine = yield* scheduler.create(userActor, { botId: BOT_A.id, spec: hourly })
        const eventsBefore = (yield* routineEvents).length
        yield* advance("60 minutes")
        yield* eventually(Effect.sync(() => calls.checked === 1))
        yield* eventually(Effect.map(scheduler.get(routine.id), (r) => r.nextRunAt === 120 * 60_000))
        const skipped = {
          deliveries: (yield* deliveries).length,
          runs: yield* runsOf(routine.id),
          routine: yield* scheduler.get(routine.id),
          newEvents: (yield* routineEvents).length - eventsBefore,
        }
        yield* advance("60 minutes")
        yield* eventually(deliveryCount(1))
        return { skipped, runs: yield* runsOf(routine.id) }
      }),
      layer,
    )
    expect(out.skipped.deliveries).toBe(0)
    expect(out.skipped.runs).toHaveLength(0)
    expect(out.skipped.newEvents).toBe(0)
    expect(out.skipped.routine.lastRunAt).toBeUndefined()
    expect(out.runs).toHaveLength(1)
    expect(out.runs[0]!.startedAt).toBe(120 * 60_000)
  })

  test("a broken gate (other exit, timeout, spawn error) fails open; Run now never checks it", async () => {
    const { calls, layer } = gated([{ _tag: "error", message: "exited with code 2" }])
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const scheduler = yield* RoutineScheduler
        const routine = yield* scheduler.create(userActor, { botId: BOT_A.id, spec: hourly })
        yield* scheduler.runNow(routine.id)
        yield* eventually(Effect.map(runsOf(routine.id), (runs) => runs[0]?.status === "succeeded"))
        const afterManual = calls.checked
        yield* advance("60 minutes")
        yield* eventually(deliveryCount(2))
        return { afterManual, deliveries: yield* deliveries }
      }),
      layer,
    )
    expect(out.afterManual).toBe(0)
    expect(calls.checked).toBe(1)
    expect(out.deliveries[1]!.text).toContain("scheduled run")
    expect(out.deliveries[1]!.text).not.toContain("Gate output")
  })

  test("a missed run caught up at boot checks the gate too", async () => {
    const now = 10 * 24 * 60 * 60_000
    const { calls, scheduler } = gated([{ _tag: "skip" }])
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        yield* setTime(now)
        const repo = yield* RoutineRepo
        const recent = makeRoutine({ id: routineId("rtn_recent"), botId: BOT_A.id, nextRunAt: now - 60 * 60_000 })
        yield* repo.upsert(recent)
        return yield* Effect.gen(function* () {
          yield* eventually(Effect.sync(() => calls.checked === 1))
          const scheduler = yield* RoutineScheduler
          yield* eventually(Effect.map(scheduler.get(recent.id), (r) => r.nextRunAt === now + 60 * 60_000))
          return { runs: yield* scheduler.runs(recent.id), deliveries: (yield* deliveries).length }
        }).pipe(Effect.provide(scheduler))
      }),
      baseLayer({ autoComplete: done }),
    )
    expect(out.runs).toHaveLength(0)
    expect(out.deliveries).toBe(0)
  })
})

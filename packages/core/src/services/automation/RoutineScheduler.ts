/**
 * RoutineScheduler (D5.3, architecture §4.3.5).
 *
 * - Routines live in `RoutineRepo`; each enabled routine carries its persisted `nextRunAt`
 *   (effect `Cron` in the routine's timezone, an interval anchored at the last run / enabling, or
 *   a one-time `at`). A new routine never runs at creation ("Test run" = `runNow`).
 * - One scheduler fiber (forked in the layer scope) sleeps with `Clock` until the earliest
 *   `nextRunAt` (or a wake-up after a change), so `TestClock` drives it in tests.
 * - Boot: a routine whose `nextRunAt` passed while the brain was down runs ONCE as `catch-up` when
 *   it was due within the last 24 h; older misses are skipped. Its next run is computed from now.
 * - A run: `RoutineRun` (running) + a `routine-run` event entry in the bot's direct conversation
 *   (`output: direct`) or a new routine-run conversation, then a `routine` delivery through
 *   `Orchestrator.deliver`; when the turn ends the run is closed with a status and a summary (the
 *   last bot message, truncated) and the event entry is updated. `RoutineRepo` keeps the last 20.
 * - One run per routine at a time: a scheduled fire while the previous run is still going is
 *   skipped (logged); `runNow` fails with `Conflict`.
 * - A run the Bot had nothing to say about (it succeeded without a message) leaves no line in the
 *   Bot's chat: its `routine-run` event is removed; the run stays in the routine's history. At boot
 *   the lines such runs left before this rule (in the Bots' chats) are removed too.
 * - Slack triggers (D3.4, with a `SlackConnector` in the context): each Slack message is matched
 *   against the enabled Slack routines (`slackTriggerMatches`). Messages for one routine within
 *   `SLACK_BATCH_MS` make one `event` run, which reads them after its prompt (`slackEventsText`);
 *   messages arriving while it runs wait and make the next run.
 */
import type {
  Bot,
  BotId,
  ConversationId,
  EntryId,
  Routine,
  RoutineId,
  RoutineRun,
  RoutineRunId,
  RoutineRunStatus,
  RoutineSpec,
} from "@openbot/contracts"
import { Conflict, InvalidInput, NotFound } from "@openbot/contracts"
import { Cause, Clock, Duration, Effect, FiberSet, Layer, Option, Queue, Semaphore, Stream } from "effect"
import { IdGen } from "../../ports/IdGen.ts"
import { BotRepo, EntryRepo, RoutineRepo } from "../../ports/repos.ts"
import {
  type Actor,
  ConversationService,
  type EntryDraft,
  Orchestrator,
  RoutineScheduler,
} from "../../ports/services.ts"
import { SlackConnector, type SlackEvent } from "../../ports/Slack.ts"
import { CATCH_UP_WINDOW_MS, describeTrigger, nextRunAfter, sameTrigger, validateTrigger } from "./schedule.ts"
import { slackEventsText, slackTriggerMatches } from "./SlackService.ts"
import { oneLine, truncate, utf8Length } from "./text.ts"
import { currentProfileId, inProfile } from "../../ports/Profiles.ts"

export const ROUTINE_LIMITS = {
  nameChars: 80,
  promptBytes: 8 * 1024,
  perBot: 50,
  summaryChars: 500,
} as const

/** Ends every routine run's message: only the run's final message reaches the owner (TurnIngest's quiet turns). */
export const ROUTINE_REPLY_NOTE =
  "(Only your final message from this run is posted for the owner, as it is: write it for them. If this run turned up nothing worth telling them, reply exactly NO_REPLY.)"

/** Slack messages for one routine within this window make one run. */
export const SLACK_BATCH_MS = 5_000
/** At most this many Slack messages wait for one routine (the oldest are dropped). */
const SLACK_QUEUE_MAX = 20

/** The scheduler re-checks at least this often (clock jumps, missed wake-ups). */
export const MAX_SCHEDULER_SLEEP_MS = 60 * 60 * 1000

type FiredBy = RoutineRun["firedBy"]

/** How long a finished one-time routine stays (switched off, under "Done") before it is removed. */
export const DONE_ONCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

const withoutNextRun = (routine: Routine): Routine => {
  const { nextRunAt: _drop, ...rest } = routine
  return rest
}

const withNextRun = (routine: Routine, nextRunAt: number | undefined): Routine =>
  nextRunAt === undefined ? withoutNextRun(routine) : { ...routine, nextRunAt }

/** Next run when a routine is (re)enabled or its trigger changes at `now`. */
const scheduleFrom = (routine: Routine, now: number): Routine =>
  routine.enabled
    ? withNextRun(routine, nextRunAfter(routine.trigger, now, { anchor: now, ranOnce: false }))
    : withoutNextRun(routine)

export const makeRoutineScheduler = Effect.gen(function* () {
  const repo = yield* RoutineRepo
  const bots = yield* BotRepo
  const entries = yield* EntryRepo
  const conversations = yield* ConversationService
  const orchestrator = yield* Orchestrator
  const ids = yield* IdGen
  const slack = Option.getOrUndefined(yield* Effect.serviceOption(SlackConnector))

  const lock = yield* Semaphore.make(1)
  const wake = yield* Queue.sliding<void>(1)
  const watchers = yield* FiberSet.make()
  /** routineId → its run in progress. */
  const running = new Map<RoutineId, RoutineRunId>()
  /** runId → the `routine-run` event entry to update when the run ends. */
  const runEvents = new Map<RoutineRunId, EntryId>()

  const signal = Queue.offer(wake, undefined).pipe(Effect.asVoid)

  const getRoutine = (routineId: RoutineId) =>
    repo.get(routineId).pipe(
      Effect.orDie,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new NotFound({ entity: "routine", id: routineId })),
          onSome: Effect.succeed,
        }),
      ),
    )

  const requireBot = (botId: BotId) =>
    bots.get(botId).pipe(
      Effect.orDie,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new NotFound({ entity: "bot", id: botId })),
          onSome: Effect.succeed,
        }),
      ),
    )

  const checkOwner = (actor: Actor, botId: BotId) =>
    actor.kind === "bot" && actor.tool.claims.botId !== botId
      ? Effect.fail(new InvalidInput({ message: "A bot can only manage its own routines." }))
      : Effect.void

  /** A Slack trigger needs the Slack of the Bot's profile. */
  const validateSpec = (bot: Bot, spec: RoutineSpec, now: number) => {
    const name = spec.name.trim()
    if (name.length === 0) return Effect.fail(new InvalidInput({ message: "A routine needs a name." }))
    if ([...name].length > ROUTINE_LIMITS.nameChars) {
      return Effect.fail(
        new InvalidInput({ message: `The routine name is too long (max ${ROUTINE_LIMITS.nameChars} characters).` }),
      )
    }
    if (spec.prompt.trim().length === 0) {
      return Effect.fail(new InvalidInput({ message: "A routine needs an instruction (prompt)." }))
    }
    if (utf8Length(spec.prompt) > ROUTINE_LIMITS.promptBytes) {
      return Effect.fail(
        new InvalidInput({
          message: `The routine instruction is too long (max ${ROUTINE_LIMITS.promptBytes / 1024} KB).`,
        }),
      )
    }
    const problem = validateTrigger(spec.trigger, now)
    if (problem !== undefined) return Effect.fail(new InvalidInput({ message: problem }))
    if (spec.trigger.type !== "slack") return Effect.succeed(name)
    const notConnected = new InvalidInput({
      message: "Slack isn't connected: the owner connects it in Connect apps › Slack.",
    })
    return slack === undefined
      ? Effect.fail(notConnected)
      : Effect.flatMap(slack.connection, (connection) => connection.status).pipe(
          inProfile(bot.ownerProfileId),
          Effect.flatMap((status) => (status.connected ? Effect.succeed(name) : Effect.fail(notConnected))),
        )
  }

  const checkNameFree = (botId: BotId, name: string, except?: RoutineId) =>
    Effect.gen(function* () {
      const existing = yield* repo.list({ botId }).pipe(Effect.orDie)
      const lower = name.toLowerCase()
      if (existing.some((r) => r.id !== except && r.name.toLowerCase() === lower)) {
        return yield* new Conflict({ reason: `A routine named "${name}" already exists for this bot.` })
      }
      return existing
    })

  /** Transcript note of a routine change: a routine card for bot actors, an event line for the owner. */
  const announce = (
    actor: Actor,
    bot: Bot,
    routine: Routine,
    action: "created" | "updated" | "enabled" | "disabled" | "deleted",
  ) => {
    const write =
      actor.kind === "bot" && (action === "created" || action === "updated")
        ? conversations.appendEntry({
            kind: "card",
            conversationId: actor.tool.claims.conversationId,
            author: { kind: "bot", botId: bot.id },
            card: {
              type: "routine",
              action,
              routineId: routine.id,
              name: routine.name,
              triggerSummary: describeTrigger(routine.trigger),
              prompt: routine.prompt,
            },
            state: { status: "info" },
          } as EntryDraft)
        : conversations.appendEvent({
            conversationId: bot.directConversationId,
            event: { type: "routine-changed", action, routineId: routine.id, routineName: routine.name },
          })
    return write.pipe(
      Effect.asVoid,
      Effect.catch((error) => Effect.logWarning("RoutineScheduler: change not announced", error)),
    )
  }

  // ------------------------------------------------------------------------ runs

  const updateRunEvent = (runId: RoutineRunId, status: RoutineRunStatus) => {
    const entryId = runEvents.get(runId)
    if (entryId === undefined) return Effect.void
    return conversations
      .updateEntry(entryId, (entry) =>
        entry.kind === "event" && entry.event.type === "routine-run"
          ? { ...entry, event: { ...entry.event, status } }
          : entry,
      )
      .pipe(
        Effect.asVoid,
        Effect.catch((error) => Effect.logWarning("RoutineScheduler: run event not updated", error)),
      )
  }

  const removeRunEvent = (runId: RoutineRunId) => {
    const entryId = runEvents.get(runId)
    if (entryId === undefined) return Effect.void
    return conversations
      .removeEntry(entryId)
      .pipe(Effect.catchCause((cause) => Effect.logWarning("RoutineScheduler: run event not removed", cause)))
  }

  /** Closes a run (idempotent: only a running run changes). */
  const finishRun = (
    routineId: RoutineId,
    runId: RoutineRunId,
    result: {
      readonly status: Exclude<RoutineRunStatus, "running">
      readonly summary?: string | undefined
      readonly error?: string | undefined
      readonly turnId?: RoutineRun["turnId"] | undefined
    },
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (running.get(routineId) === runId) running.delete(routineId)
        const run = yield* repo.getRun(runId).pipe(Effect.orDie)
        const routine = yield* repo.get(routineId).pipe(Effect.orDie)
        // A deleted routine took its runs with it: nothing to close.
        if (Option.isNone(run) || Option.isNone(routine) || run.value.status !== "running") return
        const finishedAt = yield* Clock.currentTimeMillis
        const summary =
          result.summary === undefined ? undefined : truncate(result.summary.trim(), ROUTINE_LIMITS.summaryChars)
        const next: RoutineRun = {
          ...run.value,
          status: result.status,
          finishedAt,
          ...(summary === undefined || summary.length === 0 ? {} : { summary }),
          ...(result.error === undefined ? {} : { error: result.error }),
          ...(result.turnId === undefined ? {} : { turnId: result.turnId }),
        }
        yield* repo.upsertRun(next).pipe(Effect.orDie)
        if (routine.value.lastRunAt === run.value.startedAt) {
          yield* repo.upsert({ ...routine.value, lastRunStatus: result.status }).pipe(Effect.orDie)
        }
        // nothing to say: no line in the Bot's chat (the run stays in the routine's history)
        const silent = result.status === "succeeded" && (summary === undefined || summary.length === 0)
        yield* silent && routine.value.output === "direct"
          ? removeRunEvent(runId)
          : updateRunEvent(runId, result.status)
        runEvents.delete(runId)
      }),
    )

  const watch = (routineId: RoutineId, runId: RoutineRunId, deliveryId: string) =>
    orchestrator.awaitDelivery(deliveryId).pipe(
      Effect.flatMap((outcome) =>
        finishRun(routineId, runId, {
          status:
            outcome.status === "completed" ? "succeeded" : outcome.status === "interrupted" ? "interrupted" : "failed",
          summary: outcome.lastBotMessage,
          turnId: outcome.turn?.id,
          ...(outcome.status === "dropped"
            ? { error: "The run was dropped before it started." }
            : outcome.status === "failed"
              ? { error: outcome.turn?.failure?.message ?? "The bot's turn failed." }
              : {}),
        }),
      ),
      Effect.catch((error) =>
        finishRun(routineId, runId, { status: "failed", error: `Delivery lost (${error._tag}).` }),
      ),
      Effect.catchDefect((defect) =>
        Effect.logError("RoutineScheduler: run watcher failed", defect).pipe(
          Effect.andThen(finishRun(routineId, runId, { status: "failed", error: "Internal error." })),
        ),
      ),
    )

  /**
   * Starts a run of `routine`. Scheduled fires advance `nextRunAt` (even when skipped); manual runs
   * leave the schedule alone. Returns none when a scheduled fire was skipped.
   */
  const fire = (routineId: RoutineId, firedBy: FiredBy, eventText?: string) =>
    Effect.gen(function* () {
      const started = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const routine = yield* getRoutine(routineId)
          const now = yield* Clock.currentTimeMillis
          const scheduled = firedBy !== "manual"
          const advanced = !scheduled
            ? routine
            : routine.trigger.type === "once"
              ? // A one-time routine is done after its scheduled run: switch it off (the UI shows "Ran …").
                { ...withNextRun(routine, undefined), enabled: false }
              : withNextRun(routine, nextRunAfter(routine.trigger, now, { anchor: now, ranOnce: false }))
          if (running.has(routine.id)) {
            if (!scheduled) return yield* new Conflict({ reason: `"${routine.name}" is already running.` })
            yield* Effect.logInfo(`RoutineScheduler: skipped ${routine.id}, the previous run is still going`)
            yield* repo.upsert(advanced).pipe(Effect.orDie)
            return Option.none()
          }
          const bot = yield* bots.get(routine.botId).pipe(Effect.orDie)
          if (Option.isNone(bot)) {
            if (!scheduled) return yield* new NotFound({ entity: "bot", id: routine.botId })
            yield* repo.upsert(advanced).pipe(Effect.orDie)
            return Option.none()
          }
          const runId = yield* ids.routineRunId
          const triggerSummary = describeTrigger(routine.trigger)
          const conversationId: ConversationId =
            routine.output === "own-conversation"
              ? (yield* conversations.createRoutineRunConversation({
                  botId: bot.value.id,
                  routineId: routine.id,
                  runId,
                  title: routine.name,
                  triggerSummary,
                })).id
              : bot.value.directConversationId
          const event = yield* conversations.appendEvent({
            conversationId,
            event: { type: "routine-run", routineId: routine.id, routineName: routine.name, runId, status: "running" },
          })
          runEvents.set(runId, event.id)
          const run: RoutineRun = {
            id: runId,
            routineId: routine.id,
            firedBy,
            startedAt: now,
            status: "running",
            conversationId,
          }
          yield* repo.upsertRun(run).pipe(Effect.orDie)
          yield* repo.upsert({ ...advanced, lastRunAt: now, lastRunStatus: "running" }).pipe(Effect.orDie)
          running.set(routine.id, runId)
          return Option.some({ routine, bot: bot.value, run, eventId: event.id, triggerSummary })
        }),
      )
      if (Option.isNone(started)) return Option.none<RoutineRun>()
      const { bot, eventId, routine, run, triggerSummary } = started.value
      const receipt = yield* orchestrator
        .deliver({
          conversationId: run.conversationId,
          botId: bot.id,
          kind: "routine",
          text: `Routine "${oneLine(routine.name)}" (${triggerSummary}) — ${
            run.firedBy === "manual"
              ? "manual run: the owner pressed Run now (this is not a duplicate scheduled run)"
              : run.firedBy === "catch-up"
                ? "catch-up run: it was due while OpenBot was offline"
                : run.firedBy === "event"
                  ? "it was triggered by what follows the instruction"
                  : "scheduled run"
          }:\n${routine.prompt}${eventText === undefined ? "" : `\n\n${eventText}`}\n\n${ROUTINE_REPLY_NOTE}`,
          // Wakes an idle bot; queues behind a running turn instead of steering into it.
          urgency: "urgent",
          mode: "queue",
          sourceEntryId: eventId,
          routineRunId: run.id,
        })
        .pipe(
          Effect.onError((cause) => {
            const error = Cause.findErrorOption(cause)
            if (Option.isSome(error)) {
              const e = error.value
              return finishRun(routine.id, run.id, {
                status: "failed",
                error: e._tag === "HarnessUnavailable" ? e.message : `${e._tag}: ${e.entity} ${e.id}`,
              })
            }
            if (Cause.hasInterruptsOnly(cause)) return finishRun(routine.id, run.id, { status: "interrupted" })
            return finishRun(routine.id, run.id, { status: "failed", error: "Internal error." })
          }),
        )
      const withTurn: RoutineRun = receipt.turnId === undefined ? run : { ...run, turnId: receipt.turnId }
      if (receipt.turnId !== undefined) {
        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* repo.getRun(run.id).pipe(Effect.orDie)
            if (Option.isSome(current) && current.value.status === "running") {
              yield* repo.upsertRun({ ...current.value, turnId: receipt.turnId! }).pipe(Effect.orDie)
            }
          }),
        )
      }
      yield* FiberSet.run(watchers, watch(routine.id, run.id, receipt.deliveryId))
      return Option.some(withTurn)
    })

  // ------------------------------------------------------------------------ scheduler loop

  /** A run is work of its Bot's profile, whichever profile the owner looks at. */
  const inRoutineProfile =
    (routineId: RoutineId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const routine = yield* repo.get(routineId).pipe(Effect.orDie)
        const bot = Option.isSome(routine) ? yield* bots.get(routine.value.botId).pipe(Effect.orDie) : Option.none()
        return yield* Option.isSome(bot) ? inProfile(bot.value.ownerProfileId)(effect) : effect
      })

  const fireSafely = (routineId: RoutineId, firedBy: FiredBy, eventText?: string) =>
    inRoutineProfile(routineId)(fire(routineId, firedBy, eventText)).pipe(
      Effect.catch((error) => Effect.logWarning(`RoutineScheduler: ${routineId} did not start`, error)),
      Effect.catchDefect((defect) => Effect.logError(`RoutineScheduler: ${routineId} failed to fire`, defect)),
      Effect.asVoid,
    )

  /** Boot pass: fill missing `nextRunAt`, catch up misses from the last 24 h once. */
  const boot = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const routines = yield* repo.list().pipe(Effect.orDie)
    for (const routine of routines) {
      if (!routine.enabled) continue
      if (routine.nextRunAt === undefined) {
        const next = nextRunAfter(routine.trigger, now, {
          anchor: routine.lastRunAt ?? now,
          ranOnce: routine.lastRunAt !== undefined,
        })
        if (next !== undefined)
          yield* lock.withPermits(1)(repo.upsert({ ...routine, nextRunAt: next }).pipe(Effect.orDie))
        continue
      }
      if (routine.nextRunAt > now) continue
      if (now - routine.nextRunAt <= CATCH_UP_WINDOW_MS) {
        yield* fireSafely(routine.id, "catch-up")
      } else {
        yield* lock.withPermits(1)(
          repo
            .upsert(
              withNextRun(
                routine,
                nextRunAfter(routine.trigger, now, { anchor: now, ranOnce: routine.trigger.type === "once" }),
              ),
            )
            .pipe(Effect.orDie),
        )
      }
    }
  })

  /** One iteration: fire everything due, then sleep until the next due time or a wake-up. */
  const tick = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    // Finished one-time routines are kept (switched off, under "Done") for a week, then removed.
    for (const r of yield* repo.list().pipe(Effect.orDie)) {
      if (
        r.trigger.type === "once" &&
        !r.enabled &&
        r.lastRunAt !== undefined &&
        !running.has(r.id) &&
        now - r.lastRunAt > DONE_ONCE_RETENTION_MS
      ) {
        // Silent: no "deleted" event line in the chat for this housekeeping.
        yield* lock.withPermits(1)(repo.delete(r.id).pipe(Effect.orDie))
      }
    }
    const due = (yield* repo.list().pipe(Effect.orDie)).filter(
      (r) => r.enabled && r.nextRunAt !== undefined && r.nextRunAt <= now,
    )
    for (const routine of due) yield* fireSafely(routine.id, "schedule")
    const after = yield* Clock.currentTimeMillis
    const upcoming = (yield* repo.list().pipe(Effect.orDie)).flatMap((r) =>
      r.enabled && r.nextRunAt !== undefined ? [r.nextRunAt] : [],
    )
    const earliest = upcoming.length === 0 ? undefined : Math.min(...upcoming)
    const sleepMs =
      earliest === undefined ? MAX_SCHEDULER_SLEEP_MS : Math.min(MAX_SCHEDULER_SLEEP_MS, Math.max(0, earliest - after))
    yield* Effect.raceFirst(Effect.sleep(Duration.millis(sleepMs)), Queue.take(wake))
  })

  /**
   * Boot: removes the lines that silent runs left in the Bots' chats (a finished `routine-run` event
   * with no message or card from the Bot before the next run or the owner's next message), among
   * each chat's latest entries.
   */
  const SILENT_SCAN_ENTRIES = 500
  const cleanSilentRuns = Effect.gen(function* () {
    let removed = 0
    for (const bot of yield* bots.list.pipe(Effect.orDie)) {
      const page = yield* entries
        .page({ conversationId: bot.directConversationId, limit: SILENT_SCAN_ENTRIES })
        .pipe(Effect.orDie)
      const list = page.entries
      for (let i = 0; i < list.length; i++) {
        const entry = list[i]!
        if (entry.kind !== "event" || entry.event.type !== "routine-run" || entry.event.status !== "succeeded") continue
        let said = false
        for (let j = i + 1; j < list.length; j++) {
          const next = list[j]!
          if (next.kind === "event" && next.event.type === "routine-run") break
          if (next.kind === "message" && next.role === "user") break
          if ((next.kind === "message" && next.role === "bot") || next.kind === "card") {
            said = true
            break
          }
        }
        if (said) continue
        yield* conversations.removeEntry(entry.id)
        removed++
      }
    }
    if (removed > 0)
      yield* Effect.logInfo(`RoutineScheduler: removed ${removed} lines of routine runs that had nothing to say`)
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("RoutineScheduler: silent run lines not cleaned", cause)))
  yield* Effect.forkScoped(cleanSilentRuns, { startImmediately: true })

  const loop = boot.pipe(
    Effect.catchDefect((defect) => Effect.logError("RoutineScheduler: boot pass failed", defect)),
    Effect.andThen(
      Effect.forever(
        tick.pipe(
          Effect.catchDefect((defect) =>
            Effect.logError("RoutineScheduler: tick failed", defect).pipe(Effect.andThen(Effect.sleep("1 minute"))),
          ),
        ),
      ),
    ),
  )
  yield* Effect.forkScoped(loop, { startImmediately: true })

  // ------------------------------------------------------------------------ Slack triggers (D3.4)

  /** routineId → Slack messages waiting for its next run; a routine is in `flushing` while one is due. */
  const slackQueue = new Map<RoutineId, Array<SlackEvent>>()
  const flushing = new Set<RoutineId>()

  const flushSlack = (routineId: RoutineId): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* Effect.sleep(Duration.millis(SLACK_BATCH_MS))
      // messages that arrive while a run is going wait for it to end
      if (running.has(routineId)) return yield* flushSlack(routineId)
      flushing.delete(routineId)
      const events = slackQueue.get(routineId) ?? []
      slackQueue.delete(routineId)
      const routine = yield* repo.get(routineId).pipe(Effect.orDie)
      if (
        events.length === 0 ||
        Option.isNone(routine) ||
        !routine.value.enabled ||
        routine.value.trigger.type !== "slack"
      )
        return
      yield* fireSafely(routineId, "event", slackEventsText(events))
    })

  const onSlackEvent = (event: SlackEvent) =>
    Effect.gen(function* () {
      // a profile's Slack starts only its own Bots' routines
      const profileBots = new Set((yield* bots.listIn(event.profileId).pipe(Effect.orDie)).map((b) => b.id))
      const matching = (yield* repo.list().pipe(Effect.orDie)).filter(
        (r) =>
          r.enabled && r.trigger.type === "slack" && profileBots.has(r.botId) && slackTriggerMatches(r.trigger, event),
      )
      for (const routine of matching) {
        const queue = slackQueue.get(routine.id) ?? []
        queue.push(event)
        if (queue.length > SLACK_QUEUE_MAX) queue.shift()
        slackQueue.set(routine.id, queue)
        if (flushing.has(routine.id)) continue
        flushing.add(routine.id)
        yield* FiberSet.run(watchers, flushSlack(routine.id))
      }
    }).pipe(Effect.catchDefect((defect) => Effect.logError("RoutineScheduler: Slack message not handled", defect)))

  if (slack !== undefined) {
    yield* slack.events.pipe(
      Stream.runForEach(onSlackEvent),
      Effect.catchCause((cause) => Effect.logWarning("RoutineScheduler: Slack messages ended", cause)),
      Effect.forkScoped({ startImmediately: true }),
    )
  }

  // ------------------------------------------------------------------------ service

  const create = (actor: Actor, input: { readonly botId: BotId; readonly spec: RoutineSpec }) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const bot = yield* requireBot(input.botId)
          yield* checkOwner(actor, bot.id)
          const now = yield* Clock.currentTimeMillis
          const name = yield* validateSpec(bot, input.spec, now)
          const existing = yield* checkNameFree(bot.id, name)
          if (existing.length >= ROUTINE_LIMITS.perBot) {
            return yield* new InvalidInput({ message: `A bot can have at most ${ROUTINE_LIMITS.perBot} routines.` })
          }
          const routine = scheduleFrom(
            {
              id: yield* ids.routineId,
              botId: bot.id,
              name,
              prompt: input.spec.prompt,
              trigger: input.spec.trigger,
              enabled: input.spec.enabled,
              output: input.spec.output,
              createdAt: now,
              updatedAt: now,
            },
            now,
          )
          yield* repo.upsert(routine).pipe(Effect.orDie)
          return { bot, routine }
        }),
      )
      .pipe(
        Effect.tap(({ bot, routine }) => announce(actor, bot, routine, "created").pipe(Effect.andThen(signal))),
        Effect.map(({ routine }) => routine),
      )

  const update = (actor: Actor, input: { readonly routineId: RoutineId; readonly spec: RoutineSpec }) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const current = yield* getRoutine(input.routineId)
          yield* checkOwner(actor, current.botId)
          const bot = yield* requireBot(current.botId)
          const now = yield* Clock.currentTimeMillis
          const triggerChanged = !sameTrigger(current.trigger, input.spec.trigger)
          // An unchanged one-time trigger may lie in the past (already ran); only new triggers are checked.
          const name = yield* validateSpec(
            bot,
            triggerChanged ? input.spec : { ...input.spec, trigger: { type: "manual" } },
            now,
          )
          yield* checkNameFree(current.botId, name, current.id)
          const base: Routine = {
            ...current,
            name,
            prompt: input.spec.prompt,
            trigger: input.spec.trigger,
            enabled: input.spec.enabled,
            output: input.spec.output,
            updatedAt: now,
          }
          const routine = !base.enabled
            ? withoutNextRun(base)
            : triggerChanged || !current.enabled
              ? scheduleFrom(base, now)
              : base
          yield* repo.upsert(routine).pipe(Effect.orDie)
          return { bot, routine }
        }),
      )
      .pipe(
        Effect.tap(({ bot, routine }) => announce(actor, bot, routine, "updated").pipe(Effect.andThen(signal))),
        Effect.map(({ routine }) => routine),
      )

  const setEnabled = (routineId: RoutineId, enabled: boolean) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const current = yield* getRoutine(routineId)
          if (current.enabled === enabled) return { routine: current, changed: false }
          const now = yield* Clock.currentTimeMillis
          const routine = scheduleFrom({ ...current, enabled, updatedAt: now }, now)
          yield* repo.upsert(routine).pipe(Effect.orDie)
          return { routine, changed: true }
        }),
      )
      .pipe(
        Effect.tap(({ changed, routine }) =>
          changed
            ? bots.get(routine.botId).pipe(
                Effect.orDie,
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.void,
                    onSome: (bot) => announce({ kind: "user" }, bot, routine, enabled ? "enabled" : "disabled"),
                  }),
                ),
                Effect.andThen(signal),
              )
            : Effect.void,
        ),
        Effect.map(({ routine }) => routine),
      )

  const remove = (routineId: RoutineId) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const routine = yield* getRoutine(routineId)
          yield* repo.delete(routineId).pipe(Effect.orDie)
          return routine
        }),
      )
      .pipe(
        Effect.tap((routine) =>
          bots.get(routine.botId).pipe(
            Effect.orDie,
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: (bot) => announce({ kind: "user" }, bot, routine, "deleted"),
              }),
            ),
            Effect.andThen(signal),
          ),
        ),
        Effect.asVoid,
      )

  const runNow = (routineId: RoutineId) =>
    inRoutineProfile(routineId)(fire(routineId, "manual")).pipe(
      Effect.flatMap(
        Option.match({
          // Unreachable for manual runs (they fail instead of skipping); kept total.
          onNone: () => Effect.fail(new Conflict({ reason: "The routine did not start." })),
          onSome: Effect.succeed,
        }),
      ),
    )

  return RoutineScheduler.of({
    list: ({ botId }) =>
      Effect.gen(function* () {
        const profileBots = new Set((yield* bots.listIn(yield* currentProfileId).pipe(Effect.orDie)).map((b) => b.id))
        const routines = yield* repo.list(botId === undefined ? undefined : { botId }).pipe(Effect.orDie)
        return routines.filter((routine) => profileBots.has(routine.botId))
      }),
    get: getRoutine,
    create,
    update,
    setEnabled,
    delete: remove,
    runNow,
    runs: (routineId) =>
      getRoutine(routineId).pipe(
        Effect.andThen(repo.listRuns(routineId).pipe(Effect.orDie)),
        Effect.map((runs) => runs.slice(0, 20)),
      ),
  })
})

/** `RoutineScheduler` with its scheduler fiber running in the layer scope. */
export const RoutineSchedulerLive: Layer.Layer<
  RoutineScheduler,
  never,
  Orchestrator | ConversationService | RoutineRepo | BotRepo | EntryRepo | IdGen
> = Layer.effect(RoutineScheduler, makeRoutineScheduler)

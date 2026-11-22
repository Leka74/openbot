/**
 * Shared setup for the conversation service tests (W1.2): an inline, test-controlled harness driver
 * (`TestDriver`), the full conversation layer graph over in-memory ports and automation fakes, and
 * small polling helpers.
 */
import type {
  Bot,
  BotId,
  ConversationId,
  HarnessCapabilities,
  HarnessEvent,
  HarnessRequest,
  HarnessRequestResolution,
  KnownTranscriptEntry,
  Settings,
  TaskId,
  TranscriptEntry,
  TurnId,
} from "@openbot/contracts"
import { Cause, Context, Deferred, Effect, Fiber, Layer, Queue, Ref, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  CallPresence,
  BotService,
  ConversationService,
  EntryRepo,
  HarnessError,
  type HarnessDriver,
  HarnessRegistry,
  type HarnessSession,
  type OpenSessionInput,
  Orchestrator,
  type ToolContext,
  TurnRepo,
  type TurnInput,
} from "../../src/ports/index.ts"
import { ApprovalServiceLive, RoutineSchedulerLive } from "../../src/services/automation/index.ts"
import {
  AttachmentServiceLive,
  type BackgroundTasksOptions,
  BotServiceLive,
  ConversationServiceLive,
  DEFAULT_RUNNER_OPTIONS,
  InstructionRendererLive,
  LiveHubLive,
  makeBackgroundTasksLayer,
  makeOrchestratorLayer,
  MessagingLive,
  type RunnerOptions,
} from "../../src/services/conversation/index.ts"
import {
  type ApprovalPolicy,
  ApprovalServiceFake,
  makeClaims,
  MemoryServiceFake,
  SettingsServiceFake,
  TestPorts,
  UsageServiceFake,
} from "../../src/testing/index.ts"

// ============================================================================ the test driver

/** One turn as the test driver sees it. Behaviors drive it with `emit` and end it with `complete` & co. */
export interface TurnHandle {
  readonly bot: Bot
  readonly conversationId: ConversationId
  readonly sessionNumber: number
  /** The driver-facing session key (`<botId>:<taskId>` for a background task's own session). */
  readonly sessionKey: string
  /** Set when this turn runs in a background task's own session (D5.7). */
  readonly taskId: TaskId | undefined
  /** The instructions the session was opened with. */
  readonly instructions: string
  readonly input: TurnInput
  readonly turnId: TurnId
  /** Inputs steered into this turn, in order. */
  readonly steered: Array<TurnInput>
  /** A tool context for gateway-style calls made "by the model" during this turn. */
  readonly tool: ToolContext
  /** Non-terminal events. */
  readonly emit: (event: HarnessEvent) => Effect.Effect<void>
  /** Streams a bot message under `key` (a streaming upsert, then the final one). */
  readonly say: (key: string, text: string) => Effect.Effect<void>
  /** Ends the turn: usage + context usage + `TurnCompleted`. */
  readonly complete: (stopReason?: string) => Effect.Effect<void>
  /** Ends the turn with `TurnFailed`. */
  readonly fail: (code: string, message: string, retryable?: boolean) => Effect.Effect<void>
  /** `TurnFailed` + `SessionClosed` + end of the event stream (a harness crash). */
  readonly crash: (reason: string) => Effect.Effect<void>
  /** Resolves when the test calls `TestDriver.release(botId)`. */
  readonly waitForRelease: Effect.Effect<void>
  /** The native `onRequest` callback (approvals and questions). */
  readonly request: (request: HarnessRequest) => Effect.Effect<HarnessRequestResolution>
}

export type Behavior = (turn: TurnHandle) => Effect.Effect<void>

/** Default: one short final reply without mentions. */
export const replyBehavior =
  (text?: (turn: TurnHandle) => string): Behavior =>
  (turn) =>
    Effect.gen(function* () {
      yield* turn.emit({ _tag: "Activity", label: "Typing…" })
      yield* turn.say(`${turn.turnId}/msg`, text?.(turn) ?? `Reply from ${turn.bot.name}`)
      yield* turn.complete("end_turn")
    })

/** Streams a partial message, then waits for `release` (or an interrupt), then completes. */
export const holdBehavior: Behavior = (turn) =>
  Effect.gen(function* () {
    yield* turn.emit({ _tag: "Activity", label: "Working", toolKind: "shell" })
    yield* turn.emit({
      _tag: "ItemUpserted",
      turnId: turn.turnId,
      key: `${turn.turnId}/msg`,
      item: { _tag: "Message", role: "bot", text: "Working on it", streaming: true },
    })
    yield* turn.waitForRelease
    yield* turn.emit({
      _tag: "ItemUpserted",
      turnId: turn.turnId,
      key: `${turn.turnId}/msg`,
      item: { _tag: "Message", role: "bot", text: "Done", streaming: false, phase: "final" },
    })
    yield* turn.complete("end_turn")
  })

export interface SteerRecord {
  readonly botId: BotId
  readonly turnId: TurnId
  readonly input: TurnInput
}

export interface TestDriverControl {
  readonly driver: HarnessDriver
  /** Every `openSession` input, oldest first. */
  readonly opened: Effect.Effect<ReadonlyArray<OpenSessionInput>>
  /** Every started turn, oldest first. */
  readonly turns: Effect.Effect<ReadonlyArray<TurnHandle>>
  readonly steers: Effect.Effect<ReadonlyArray<SteerRecord>>
  readonly compactions: Effect.Effect<number>
  /** Sets the behavior of a bot's turns (default: `replyBehavior()`). */
  readonly setBehavior: (botId: BotId, behavior: Behavior) => Effect.Effect<void>
  /** Releases every `waitForRelease` of the bot's turns (current and future). */
  readonly release: (botId: BotId) => Effect.Effect<void>
  /**
   * Emits events on the bot's latest main session outside any started turn (a harness-initiated
   * turn, D2.1). Dies when the bot has no session.
   */
  readonly inject: (botId: BotId, ...events: ReadonlyArray<HarnessEvent>) => Effect.Effect<void>
}

export class TestDriver extends Context.Service<TestDriver, TestDriverControl>()("openbot/test/TestDriver") {
  static readonly layer = (options?: {
    readonly kind?: "fake" | "codex"
    readonly capabilities?: Partial<HarnessCapabilities>
  }): Layer.Layer<TestDriver, never, HarnessRegistry> =>
    Layer.effect(
      TestDriver,
      Effect.gen(function* () {
        const registry = yield* HarnessRegistry
        const opened = yield* Ref.make<ReadonlyArray<OpenSessionInput>>([])
        const turns = yield* Ref.make<ReadonlyArray<TurnHandle>>([])
        const steers = yield* Ref.make<ReadonlyArray<SteerRecord>>([])
        const compactions = yield* Ref.make(0)
        const behaviors = new Map<BotId, Behavior>()
        const gates = new Map<BotId, Deferred.Deferred<void>>()
        /** The latest main session's event sink per bot (`inject`). */
        const sinks = new Map<BotId, (event: HarnessEvent) => Effect.Effect<void>>()
        let sessionCount = 0

        const gateOf = (botId: BotId) =>
          Effect.gen(function* () {
            const existing = gates.get(botId)
            if (existing !== undefined) return existing
            const gate = yield* Deferred.make<void>()
            gates.set(botId, gate)
            return gate
          })

        const capabilities: HarnessCapabilities = {
          resume: true,
          steer: false,
          interrupt: true,
          approvals: "interactive",
          questions: true,
          compact: false,
          contextUsage: true,
          images: false,
          remotePlacements: ["brain-mcp-hands"],
          ...options?.capabilities,
        }
        const kind = options?.kind ?? "fake"

        const openSession = (input: OpenSessionInput): Effect.Effect<HarnessSession, HarnessError, Scope.Scope> =>
          Effect.gen(function* () {
            const sessionNumber = ++sessionCount
            yield* Ref.update(opened, (all) => [...all, input])
            const nativeSessionId = input.nativeSessionId ?? `native-${sessionNumber}`
            const events = yield* Queue.unbounded<HarnessEvent, Cause.Done>()
            const scope = yield* Effect.scope
            const state = {
              closed: false,
              used: 1_000,
              active: undefined as { readonly handle: TurnHandle; fiber?: Fiber.Fiber<void> } | undefined,
            }
            const offer = (event: HarnessEvent) => Effect.asVoid(Queue.offer(events, event))
            if (input.purpose !== "task") sinks.set(input.bot.id, offer)
            yield* offer({ _tag: "SessionBound", nativeSessionId })
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                state.closed = true
              }).pipe(Effect.andThen(Queue.end(events))),
            )

            /** Clears the active turn BEFORE the terminal event (the runner may start the next turn at once). */
            const finish = (turnId: TurnId, terminal: ReadonlyArray<HarnessEvent>) =>
              Effect.suspend(() => {
                if (state.active?.handle.turnId !== turnId) return Effect.void
                state.active = undefined
                return Effect.forEach(terminal, offer, { discard: true })
              })

            const makeHandle = (turn: TurnInput): TurnHandle => {
              const turnId = turn.turnId
              // One session per bot: the turn names its conversation; tool calls resolve to it
              // (as the gateway does per call).
              const conversationId = turn.conversationId ?? input.conversationId
              // A background task's own session (D5.7): its calls carry the task, never the turn.
              const keyed = input.sessionKey.slice(input.sessionKey.indexOf(":") + 1)
              const taskId = keyed.startsWith("tsk_") ? (keyed as TaskId) : undefined
              const claims = makeClaims({
                botId: input.bot.id,
                conversationId,
                sessionKey: `${input.bot.id}:${conversationId}`,
                ...(taskId === undefined ? {} : { taskId }),
              })
              const handle: TurnHandle = {
                bot: input.bot,
                conversationId,
                sessionNumber,
                sessionKey: input.sessionKey,
                taskId,
                instructions: input.instructions.text,
                input: turn,
                turnId,
                steered: [],
                tool:
                  taskId === undefined
                    ? { claims, callId: `${turnId}/call`, turnId }
                    : { claims, callId: `${turnId}/call`, taskId },
                emit: offer,
                say: (key, text) =>
                  Effect.gen(function* () {
                    yield* offer({
                      _tag: "ItemUpserted",
                      turnId,
                      key,
                      item: {
                        _tag: "Message",
                        role: "bot",
                        text: text.slice(0, Math.ceil(text.length / 2)),
                        streaming: true,
                      },
                    })
                    yield* offer({
                      _tag: "ItemUpserted",
                      turnId,
                      key,
                      item: { _tag: "Message", role: "bot", text, streaming: false, phase: "final" },
                    })
                  }),
                complete: (stopReason) =>
                  Effect.suspend(() => {
                    state.used += 100
                    return finish(turnId, [
                      { _tag: "Usage", turnId, usage: { inputTokens: 10, outputTokens: 5 } },
                      { _tag: "ContextUsage", usedTokens: state.used, windowTokens: 200_000 },
                      stopReason === undefined
                        ? { _tag: "TurnCompleted", turnId }
                        : { _tag: "TurnCompleted", turnId, stopReason },
                    ])
                  }),
                fail: (code, message, retryable = false) =>
                  finish(turnId, [{ _tag: "TurnFailed", turnId, error: { code, message, retryable } }]),
                crash: (reason) =>
                  finish(turnId, [
                    { _tag: "TurnFailed", turnId, error: { code: "crashed", message: reason, retryable: true } },
                    { _tag: "SessionClosed", reason },
                  ]).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        state.closed = true
                      }),
                    ),
                    Effect.andThen(Queue.end(events)),
                  ),
                waitForRelease: Effect.flatMap(gateOf(input.bot.id), Deferred.await),
                request: input.onRequest,
              }
              return handle
            }

            const session: HarnessSession = {
              events: Stream.fromQueue(events),
              nativeSessionId: Effect.succeed(nativeSessionId),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  if (state.closed) return yield* new HarnessError({ harness: kind, code: "closed", message: "closed" })
                  if (state.active !== undefined) {
                    return yield* new HarnessError({ harness: kind, code: "turn-rejected", message: "busy" })
                  }
                  const handle = makeHandle(turn)
                  const active: { readonly handle: TurnHandle; fiber?: Fiber.Fiber<void> } = { handle }
                  state.active = active
                  yield* Ref.update(turns, (all) => [...all, handle])
                  yield* offer({ _tag: "TurnStarted", turnId: turn.turnId })
                  const behavior = behaviors.get(input.bot.id) ?? replyBehavior()
                  active.fiber = yield* Effect.forkIn(behavior(handle), scope, { startImmediately: true })
                }),
              steer: (turn) =>
                Effect.gen(function* () {
                  if (!capabilities.steer) {
                    return yield* new HarnessError({ harness: kind, code: "unsupported", message: "no steer" })
                  }
                  const active = state.active
                  if (active === undefined) {
                    return yield* new HarnessError({ harness: kind, code: "turn-rejected", message: "idle" })
                  }
                  active.handle.steered.push(turn)
                  yield* Ref.update(steers, (all) => [
                    ...all,
                    { botId: input.bot.id, turnId: active.handle.turnId, input: turn },
                  ])
                }),
              interrupt: Effect.suspend(() => {
                const active = state.active
                if (active === undefined) return Effect.void
                state.active = undefined
                return Effect.gen(function* () {
                  if (active.fiber !== undefined) yield* Fiber.interrupt(active.fiber)
                  yield* offer({ _tag: "TurnInterrupted", turnId: active.handle.turnId })
                })
              }),
              compact: Effect.gen(function* () {
                if (!capabilities.compact)
                  return yield* new HarnessError({ harness: kind, code: "unsupported", message: "no" })
                yield* Ref.update(compactions, (n) => n + 1)
                state.used = 500
              }),
              contextUsage: Effect.sync(() => ({ usedTokens: state.used, windowTokens: 200_000 })),
            }
            return session
          })

        const driver: HarnessDriver = {
          kind,
          displayName: "Test",
          capabilities,
          probe: Effect.succeed({ kind, installed: true, auth: { state: "signed-in" }, problems: [] }),
          listModels: Effect.succeed([]),
          openSession,
        }
        yield* registry.register(driver)
        return TestDriver.of({
          driver,
          opened: Ref.get(opened),
          turns: Ref.get(turns),
          steers: Ref.get(steers),
          compactions: Ref.get(compactions),
          setBehavior: (botId, behavior) => Effect.sync(() => void behaviors.set(botId, behavior)),
          release: (botId) => Effect.flatMap(gateOf(botId), (gate) => Effect.asVoid(Deferred.succeed(gate, undefined))),
          inject: (botId, ...events) =>
            Effect.suspend(() => {
              const sink = sinks.get(botId)
              if (sink === undefined) return Effect.die(new Error(`no session for ${botId}`))
              return Effect.forEach(events, sink, { discard: true })
            }),
        })
      }),
    )
}

// ============================================================================ the layer graph

export interface AppOptions {
  readonly capabilities?: Partial<HarnessCapabilities>
  readonly policy?: ApprovalPolicy
  readonly settings?: Partial<Settings>
  readonly runner?: Partial<RunnerOptions>
  /** "live" uses the real ApprovalService (cards, RuntimeRequests); default: the allow-all fake. */
  readonly approvals?: "fake" | "live"
  /** Background task options (D5.7). */
  readonly tasks?: Partial<BackgroundTasksOptions>
}

/**
 * The fake ApprovalService (allow-all policy by default), or the real one (cards, RuntimeRequests,
 * `onPending`) with the fake's control tag still present (its `asyncAnswers` is then unused).
 */
const approvalLayer = (options?: AppOptions) => {
  const fake = ApprovalServiceFake.layer(options?.policy === undefined ? undefined : { policy: options.policy })
  return options?.approvals === "live" ? Layer.merge(fake, ApprovalServiceLive) : fake
}

/**
 * Ports (in memory) → LiveHub → ConversationService/Attachment + settings/usage fakes → memory fake →
 * approval fake → InstructionRenderer → Orchestrator → Messaging + RoutineScheduler → BotService,
 * plus the `TestDriver` registered as harness kind "fake".
 */
export const appLayer = (options?: AppOptions) => {
  const ports = TestPorts()
  const driver = TestDriver.layer(
    options?.capabilities === undefined ? undefined : { capabilities: options.capabilities },
  )
  const level2 = Layer.mergeAll(
    ConversationServiceLive,
    AttachmentServiceLive,
    SettingsServiceFake.layer(options?.settings === undefined ? undefined : { initial: options.settings }),
    UsageServiceFake.layer,
  )
  return BotServiceLive.pipe(
    Layer.provideMerge(Layer.mergeAll(MessagingLive, RoutineSchedulerLive)),
    Layer.provideMerge(makeOrchestratorLayer(options?.runner)),
    Layer.provideMerge(makeBackgroundTasksLayer(options?.tasks)),
    Layer.provideMerge(InstructionRendererLive),
    Layer.provideMerge(approvalLayer(options)),
    Layer.provideMerge(MemoryServiceFake.layer),
    Layer.provideMerge(level2),
    Layer.provideMerge(LiveHubLive),
    Layer.provideMerge(driver),
    Layer.provideMerge(CallPresence.layer),
    Layer.provideMerge(ports),
  )
}

// ============================================================================ helpers

/** Yields (and lets the scheduler run other fibers) until `check` holds; fails after `tries`. */
export const eventually = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  label = "condition",
  tries = 5_000,
): Effect.Effect<void, E | Error, R> =>
  Effect.gen(function* () {
    for (let i = 0; i < tries; i++) {
      if (yield* check) return
      yield* Effect.yieldNow
    }
    return yield* Effect.fail(new Error(`eventually: ${label} not met`))
  })

/** Collects a (live) stream in the background; `items` reads what arrived so far. */
export const collect = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  Effect.gen(function* () {
    const items = yield* Ref.make<ReadonlyArray<A>>([])
    yield* Effect.forkScoped(
      Stream.runForEach(stream, (item) => Ref.update(items, (all) => [...all, item])),
      {
        startImmediately: true,
      },
    )
    return { items: Ref.get(items) }
  })

let nonce = 0
/** A fresh client nonce. */
export const freshNonce = () => `nonce-${++nonce}`

/** Creates a bot through the real BotService with the test driver ("fake"). */
export const createBot = (name: string, extra?: { readonly instructions?: string }) =>
  Effect.flatMap(BotService, (bots) =>
    bots.create({
      name,
      harness: { kind: "fake" },
      clientNonce: freshNonce(),
      ...(extra?.instructions === undefined ? {} : { instructions: extra.instructions }),
    }),
  )

/** Sends an owner message. */
export const send = (
  conversationId: ConversationId,
  text: string,
  extra?: Partial<Omit<Parameters<Orchestrator["Service"]["send"]>[0], "conversationId" | "text">>,
) => Effect.flatMap(Orchestrator, (o) => o.send({ conversationId, text, clientNonce: freshNonce(), ...extra }))

/** The whole transcript of a conversation, oldest first (known entries only). */
export const transcript = (conversationId: ConversationId) =>
  Effect.gen(function* () {
    const entries = yield* EntryRepo
    const page = yield* Effect.orDie(entries.page({ conversationId, limit: 10_000 }))
    return page.entries.filter((e): e is KnownTranscriptEntry => e.kind !== "unknown")
  })

export const messagesOf = (entries: ReadonlyArray<TranscriptEntry>) =>
  entries.flatMap((e) => (e.kind === "message" ? [e] : []))

export const eventsOf = (entries: ReadonlyArray<TranscriptEntry>) =>
  entries.flatMap((e) => (e.kind === "event" && e.event.type !== "unknown" ? [e.event] : []))

/** Turns of a conversation, oldest first. */
export const turnsOf = (conversationId: ConversationId) =>
  Effect.flatMap(TurnRepo, (repo) => Effect.orDie(repo.listByConversation(conversationId, 1_000)))

/** Lets queued background bot messages wake their recipient: `botWakeDebounce` passes. */
export const passBotWakeDebounce = TestClock.adjust(DEFAULT_RUNNER_OPTIONS.botWakeDebounce)

/** Waits until every turn of the conversation is terminal (and at least `min` exist). */
export const settled = (conversationId: ConversationId, min = 1) =>
  eventually(
    Effect.map(
      turnsOf(conversationId),
      (turns) =>
        turns.length >= min &&
        turns.every((t) => t.status === "completed" || t.status === "failed" || t.status === "interrupted"),
    ),
    `settled ${conversationId}`,
  )

export const conversation = (id: ConversationId) => Effect.flatMap(ConversationService, (c) => c.get(id))

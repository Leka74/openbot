/**
 * Fakes of the §4.3 service tags (ports/services.ts) for CROSS-WP tests: W1.2 (conversation
 * services) and W1.3 (automation services) are written in parallel and depend on each other's
 * services; the gateway and the server need them too. Each fake implements only what its
 * consumers' tests need; everything else dies with "<Fake>: <method> is not implemented".
 * For a one-off partial stub of any tag, use `Layer.mock(Tag, { ...methods })` (effect 4.0.4).
 *
 * Each fake comes with a control service (`*Fake`) to drive and inspect it, like the port fakes.
 *
 * - `LiveHubFake`: records every publish with a per-replica cursor; subscriptions stream
 *   `synchronized` then live items (no snapshots).
 * - `ConversationServiceFake`: the transcript-write subset over EntryRepo/RequestRepo/ConversationRepo
 *   + LiveHub (append/update/remove entries, events, notices, requests, routine-run conversations).
 * - `OrchestratorFake`: records deliveries; `awaitDelivery` resolves via `complete` or `autoComplete`.
 * - `ApprovalServiceFake`: `evaluate` follows a policy (default: allow / first options); tool
 *   requests return pending receipts; `asyncAnswers` is fed by `answer`.
 * - `SettingsServiceFake`, `UsageServiceFake`, `MemoryServiceFake`: small in-memory versions.
 * - `CoreServiceFakes()`: all of the above in one layer (needs repositories + IdGen, e.g. `TestPorts()`).
 */
import type {
  ApprovalRule,
  BotActivity,
  BotId,
  BotUsage,
  ConversationId,
  HarnessRequest,
  HarnessRequestResolution,
  KnownConversationChange,
  KnownConversationStreamItem,
  KnownRosterChange,
  KnownRosterStreamItem,
  KnownTranscriptEntry,
  MemoryFact,
  RequestId,
  Settings,
  StreamCursor,
  TranscriptEntry,
  Turn,
  TurnId,
  Usage,
} from "@openbot/contracts"
import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  MEMORY_INDEX_PROMPT_CAP_BYTES,
  memoryFactIdFromTitle,
  NotFound,
} from "@openbot/contracts"
import { Clock, Context, Deferred, Effect, Layer, Option, PubSub, Queue, Ref, Result, Stream, SubscriptionRef } from "effect"
import { IdGen } from "../ports/IdGen.ts"
import {
  ConversationRepo,
  conversationReplicaKey,
  EntryRepo,
  type ReplicaChange,
  type ReplicaKey,
  RequestRepo,
  rosterReplicaKey,
} from "../ports/repos.ts"
import {
  type Actor,
  type ApprovalContext,
  ApprovalService,
  type CausalChain,
  ConversationService,
  type Delivery,
  type DeliveryInput,
  type DeliveryOutcome,
  type EntryDraft,
  LiveHub,
  MemoryService,
  type NodeApprovalInput,
  Orchestrator,
  SettingsService,
  type ToolContext,
  UsageService,
} from "../ports/services.ts"
import { MemoryStore } from "../ports/stores.ts"
import { addUsage } from "./memoryRepos.ts"

const notImplemented = (fake: string, method: string) =>
  Effect.die(new Error(`${fake}: ${method} is not implemented`))

const repoOrDie = Effect.orDie

// ============================================================================ LiveHub

/** One published change with the cursor the fake assigned to it. */
export interface PublishedChange {
  readonly replicaKey: ReplicaKey
  readonly cursor: StreamCursor
  readonly change: ReplicaChange
}

type HubItem =
  | { readonly replicaKey: ReplicaKey; readonly conversation: KnownConversationStreamItem }
  | { readonly replicaKey: ReplicaKey; readonly roster: KnownRosterStreamItem }

export class LiveHubFake extends Context.Service<LiveHubFake, {
  /** Every published change (both replicas), oldest first. */
  readonly published: Effect.Effect<ReadonlyArray<PublishedChange>>
  /** Changes published to one conversation replica, oldest first. */
  readonly conversationChanges: (conversationId: ConversationId) => Effect.Effect<ReadonlyArray<KnownConversationChange>>
  /** Changes published to the roster replica, oldest first. */
  readonly rosterChanges: Effect.Effect<ReadonlyArray<KnownRosterChange>>
  /** `resetConversation` calls, oldest first. */
  readonly resets: Effect.Effect<ReadonlyArray<{ readonly conversationId: ConversationId; readonly epoch: string; readonly reason: string }>>
}>()("openbot/core/testing/LiveHubFake") {
  static readonly layer: Layer.Layer<LiveHub | LiveHubFake> = Layer.effectContext(
    Effect.gen(function*() {
      const log = yield* Ref.make<ReadonlyArray<PublishedChange>>([])
      const resets = yield* Ref.make<ReadonlyArray<{ conversationId: ConversationId; epoch: string; reason: string }>>([])
      const heads = new Map<ReplicaKey, StreamCursor>()
      const activities = yield* Ref.make<ReadonlyMap<BotId, BotActivity>>(new Map())
      const items = yield* PubSub.unbounded<HubItem>()
      yield* Effect.addFinalizer(() => PubSub.shutdown(items))
      let epochs = 0

      const headOf = (key: ReplicaKey): StreamCursor => heads.get(key) ?? { epoch: "epc_test", sequence: 0 }
      const append = (replicaKey: ReplicaKey, change: ReplicaChange) =>
        Effect.gen(function*() {
          const head = headOf(replicaKey)
          const cursor: StreamCursor = { epoch: head.epoch, sequence: head.sequence + 1 }
          heads.set(replicaKey, cursor)
          yield* Ref.update(log, (all) => [...all, { replicaKey, cursor, change }])
          yield* PubSub.publish(
            items,
            change.replica === "conversation"
              ? { replicaKey, conversation: { kind: "change", cursor, change: change.change } }
              : { replicaKey, roster: { kind: "change", cursor, change: change.change } },
          )
          return cursor
        })
      const publishRoster = (change: KnownRosterChange) => append(rosterReplicaKey, { replica: "roster", change })

      const hub = LiveHub.of({
        publishConversation: (conversationId, change) =>
          append(conversationReplicaKey(conversationId), { replica: "conversation", change }),
        publishRoster,
        subscribeConversation: ({ conversationId }) =>
          Stream.unwrap(
            Effect.gen(function*() {
              const key = conversationReplicaKey(conversationId)
              const subscription = yield* PubSub.subscribe(items)
              const live = Stream.fromSubscription(subscription).pipe(
                Stream.filterMap((item) =>
                  item.replicaKey === key && "conversation" in item ? Result.succeed(item.conversation) : Result.failVoid
                ),
              )
              const synced: KnownConversationStreamItem = { kind: "synchronized", cursor: headOf(key) }
              return Stream.concat(Stream.make(synced), live)
            }),
          ),
        subscribeRoster: () =>
          Stream.unwrap(
            Effect.gen(function*() {
              const subscription = yield* PubSub.subscribe(items)
              const live = Stream.fromSubscription(subscription).pipe(
                Stream.filterMap((item) => ("roster" in item ? Result.succeed(item.roster) : Result.failVoid)),
              )
              const synced: KnownRosterStreamItem = { kind: "synchronized", cursor: headOf(rosterReplicaKey) }
              return Stream.concat(Stream.make(synced), live)
            }),
          ),
        resetConversation: (conversationId, reason) =>
          Effect.gen(function*() {
            const key = conversationReplicaKey(conversationId)
            const epoch = `epc_test_${++epochs}`
            heads.set(key, { epoch, sequence: 0 })
            yield* Ref.update(resets, (all) => [...all, { conversationId, epoch, reason }])
            yield* PubSub.publish(items, { replicaKey: key, conversation: { kind: "reset", epoch, reason } })
            return epoch
          }),
        activities: Effect.map(Ref.get(activities), (map) => [...map.values()]),
        setActivity: (activity) =>
          Ref.update(activities, (map) => new Map(map).set(activity.botId, activity)).pipe(
            Effect.andThen(publishRoster({ type: "activity.updated", activity })),
            Effect.asVoid,
          ),
      })
      const control = LiveHubFake.of({
        published: Ref.get(log),
        conversationChanges: (conversationId) =>
          Effect.map(Ref.get(log), (all) =>
            all.flatMap((p) =>
              p.replicaKey === conversationReplicaKey(conversationId) && p.change.replica === "conversation"
                ? [p.change.change]
                : []
            )),
        rosterChanges: Effect.map(Ref.get(log), (all) =>
          all.flatMap((p) => (p.change.replica === "roster" ? [p.change.change] : []))),
        resets: Ref.get(resets),
      })
      return Context.make(LiveHub, hub).pipe(Context.add(LiveHubFake, control))
    }),
  )
}

// ============================================================================ ConversationService

export class ConversationServiceFake extends Context.Service<ConversationServiceFake, {
  /** Every entry value written through the fake (appends and updates), oldest first. */
  readonly written: Effect.Effect<ReadonlyArray<TranscriptEntry>>
}>()("openbot/core/testing/ConversationServiceFake") {
  /**
   * Implements `get`, `appendEntry`, `updateEntry`, `appendEvent`, `appendNotice`, `upsertRequest`
   * and `createRoutineRunConversation` (persist, then publish through LiveHub). Conversation
   * bookkeeping (lastActivityAt, unread, previews, summaries) is NOT done.
   */
  static readonly layer: Layer.Layer<
    ConversationService | ConversationServiceFake,
    never,
    ConversationRepo | EntryRepo | RequestRepo | IdGen | LiveHub
  > = Layer.effectContext(
    Effect.gen(function*() {
      const conversations = yield* ConversationRepo
      const entries = yield* EntryRepo
      const requests = yield* RequestRepo
      const ids = yield* IdGen
      const hub = yield* LiveHub
      const written = yield* Ref.make<ReadonlyArray<TranscriptEntry>>([])

      const getConversation = (conversationId: ConversationId) =>
        conversations.get(conversationId).pipe(
          repoOrDie,
          Effect.flatMap(Option.match({
            onNone: () => Effect.fail(new NotFound({ entity: "conversation", id: conversationId })),
            onSome: Effect.succeed,
          })),
        )
      const write = (entry: KnownTranscriptEntry) =>
        Effect.gen(function*() {
          const outcome = yield* repoOrDie(entries.upsert(entry))
          const value = outcome.applied ? outcome.value : outcome.current
          if (outcome.applied) {
            yield* Ref.update(written, (all) => [...all, value])
            if (value.kind !== "unknown") yield* hub.publishConversation(value.conversationId, { type: "entry.upserted", entry: value })
          }
          return value
        })
      const appendEntry = (draft: EntryDraft) =>
        Effect.gen(function*() {
          yield* getConversation(draft.conversationId)
          const now = yield* Clock.currentTimeMillis
          const id = draft.id ?? (yield* ids.entryId)
          return yield* write({ ...draft, id, revision: 0, createdAt: now, updatedAt: now } as KnownTranscriptEntry)
        })

      const service = ConversationService.of({
        get: getConversation,
        summaries: notImplemented("ConversationServiceFake", "summaries"),
        summary: () => notImplemented("ConversationServiceFake", "summary"),
        history: () => notImplemented("ConversationServiceFake", "history"),
        exchange: () => notImplemented("ConversationServiceFake", "exchange"),
        around: () => notImplemented("ConversationServiceFake", "around"),
        createGroup: () => notImplemented("ConversationServiceFake", "createGroup"),
        setMembers: () => notImplemented("ConversationServiceFake", "setMembers"),
        rename: () => notImplemented("ConversationServiceFake", "rename"),
        markRead: () => notImplemented("ConversationServiceFake", "markRead"),
        setHidden: () => notImplemented("ConversationServiceFake", "setHidden"),
        removeGroup: () => notImplemented("ConversationServiceFake", "removeGroup"),
        place: () => notImplemented("ConversationServiceFake", "place"),
        removeEntry: (entryId) =>
          Effect.gen(function*() {
            const current = yield* repoOrDie(entries.get(entryId))
            if (Option.isNone(current)) return
            yield* repoOrDie(entries.remove(entryId))
            yield* hub.publishConversation(current.value.conversationId, { type: "entry.removed", entryId, reason: "retracted" })
          }),
        appendEntry,
        updateEntry: (entryId, update) =>
          Effect.gen(function*() {
            const current = yield* repoOrDie(entries.get(entryId))
            if (Option.isNone(current) || current.value.kind === "unknown") {
              return yield* new NotFound({ entity: "entry", id: entryId })
            }
            const now = yield* Clock.currentTimeMillis
            const next = update(current.value)
            return yield* write({
              ...next,
              id: current.value.id,
              conversationId: current.value.conversationId,
              createdAt: current.value.createdAt,
              revision: current.value.revision + 1,
              updatedAt: now,
            } as KnownTranscriptEntry)
          }),
        appendEvent: ({ author, conversationId, event, turnId }) =>
          appendEntry({
            kind: "event",
            conversationId,
            author: author ?? { kind: "system" },
            event,
            ...(turnId === undefined ? {} : { turnId }),
          } as EntryDraft),
        appendNotice: ({ code, conversationId, level, text, turnId }) =>
          appendEntry({
            kind: "notice",
            conversationId,
            author: { kind: "system" },
            level,
            code,
            text,
            ...(turnId === undefined ? {} : { turnId }),
          } as EntryDraft),
        upsertRequest: (request) =>
          Effect.gen(function*() {
            yield* getConversation(request.conversationId)
            yield* repoOrDie(requests.upsert(request))
            yield* hub.publishConversation(request.conversationId, { type: "request.upserted", request })
          }),
        createRoutineRunConversation: ({ botId, routineId, runId, title, triggerSummary }) =>
          Effect.gen(function*() {
            const now = yield* Clock.currentTimeMillis
            const conversation = {
              id: yield* ids.conversationId,
              kind: "routine-run" as const,
              botId,
              routineId,
              runId,
              triggerSummary,
              title,
              createdAt: now,
              lastActivityAt: now,
              unreadCount: 0,
              hiddenFromSidebar: false,
              epoch: yield* ids.next("epc"),
            }
            yield* repoOrDie(conversations.upsert(conversation))
            return conversation
          }),
      })
      return Context.make(ConversationService, service).pipe(
        Context.add(ConversationServiceFake, ConversationServiceFake.of({ written: Ref.get(written) })),
      )
    }),
  )
}

// ============================================================================ Orchestrator

export type DeliveryResult = Omit<DeliveryOutcome, "deliveryId">

export class OrchestratorFake extends Context.Service<OrchestratorFake, {
  /** Every delivery, oldest first (defaults applied: id, mode "auto", attachmentIds [], new chain). */
  readonly deliveries: Effect.Effect<ReadonlyArray<Delivery>>
  /** Resolves `awaitDelivery(deliveryId)`. */
  readonly complete: (deliveryId: string, result: DeliveryResult) => Effect.Effect<void>
  /** What `currentChain(botId)` returns (default none). */
  readonly setChain: (botId: BotId, chain: CausalChain | undefined) => Effect.Effect<void>
  /** What `activeTurn(botId)` returns (default none); the gateway resolves tool calls' conversation from it. */
  readonly setActiveTurn: (botId: BotId, turn: Turn | undefined) => Effect.Effect<void>
  /**
   * Other calls, e.g. "stopBot:<botId>", "newSession:<botId>", "compact:<botId>", "recover",
   * "approveToolCall:<botId>:<toolName>" (plus ":<taskId>" for a background task's call).
   */
  readonly calls: Effect.Effect<ReadonlyArray<string>>
}>()("openbot/core/testing/OrchestratorFake") {
  /**
   * `deliver` records and returns `{disposition: "started", turnId: <fresh>}`; with `autoComplete`,
   * every delivery's outcome resolves immediately with that result. `send`, `lookupSend`, `react`
   * and `interrupt` are not implemented.
   */
  static readonly layer = (options?: {
    readonly autoComplete?: DeliveryResult
    /** What `approveToolCall` returns (default allow-once). */
    readonly toolApproval?: HarnessRequestResolution
  }): Layer.Layer<
    Orchestrator | OrchestratorFake,
    never,
    IdGen
  > =>
    Layer.effectContext(
      Effect.gen(function*() {
        const ids = yield* IdGen
        const deliveries = yield* Ref.make<ReadonlyArray<Delivery>>([])
        const outcomes = new Map<string, Deferred.Deferred<DeliveryOutcome>>()
        const chains = new Map<string, CausalChain>()
        const turns = new Map<string, Turn>()
        const calls = yield* Ref.make<ReadonlyArray<string>>([])
        const call = (name: string) => Ref.update(calls, (all) => [...all, name])

        const orchestrator = Orchestrator.of({
          send: () => notImplemented("OrchestratorFake", "send"),
          lookupSend: () => notImplemented("OrchestratorFake", "lookupSend"),
          react: () => notImplemented("OrchestratorFake", "react"),
          interrupt: () => notImplemented("OrchestratorFake", "interrupt"),
          retry: () => notImplemented("OrchestratorFake", "retry"),
          drain: () => notImplemented("OrchestratorFake", "drain"),
          draining: Effect.succeed(false),
          handOff: Effect.void,
          resume: () => Effect.void,
          deleteConversation: (conversationId) => call(`deleteConversation:${conversationId}`),
          deliver: (input: DeliveryInput) =>
            Effect.gen(function*() {
              const id = input.id ?? (yield* ids.next("dlv"))
              const delivery: Delivery = {
                ...input,
                id,
                mode: input.mode ?? "auto",
                attachmentIds: input.attachmentIds ?? [],
                causalChain: input.causalChain ?? { rootId: id, hops: 0 },
              }
              const deferred = yield* Deferred.make<DeliveryOutcome>()
              outcomes.set(id, deferred)
              yield* Ref.update(deliveries, (all) => [...all, delivery])
              if (options?.autoComplete !== undefined) {
                yield* Deferred.succeed(deferred, { ...options.autoComplete, deliveryId: id })
              }
              return { deliveryId: id, disposition: "started" as const, turnId: yield* ids.turnId }
            }),
          awaitDelivery: (deliveryId) => {
            const deferred = outcomes.get(deliveryId)
            return deferred === undefined
              ? Effect.fail(new NotFound({ entity: "delivery", id: deliveryId }))
              : Deferred.await(deferred)
          },
          approveToolCall: (tool, request) =>
            call(`approveToolCall:${tool.claims.botId}:${request.toolName}${tool.taskId === undefined ? "" : `:${tool.taskId}`}`).pipe(
              Effect.as(options?.toolApproval ?? { decision: "allow-once" as const }),
            ),
          newSession: ({ botId }) => call(`newSession:${botId}`),
          compact: ({ botId }) => call(`compact:${botId}`),
          stopBot: (botId) => call(`stopBot:${botId}`),
          noteGroupAddress: (input) =>
            call(`noteGroupAddress:${input.botId}:${input.recipientBotId}`).pipe(
              Effect.andThen(Effect.sync(() => turns.get(input.botId)?.conversationId === input.conversationId)),
            ),
          currentChain: (botId) => Effect.sync(() => Option.fromNullishOr(chains.get(botId))),
          activeTurn: (botId) => Effect.sync(() => Option.fromNullishOr(turns.get(botId))),
          recover: () => call("recover"),
        })
        const control = OrchestratorFake.of({
          deliveries: Ref.get(deliveries),
          complete: (deliveryId, result) =>
            Effect.suspend(() => {
              const deferred = outcomes.get(deliveryId)
              return deferred === undefined
                ? Effect.die(new Error(`OrchestratorFake: unknown delivery ${deliveryId}`))
                : Effect.asVoid(Deferred.succeed(deferred, { ...result, deliveryId }))
            }),
          setChain: (botId, chain) =>
            Effect.sync(() => {
              if (chain === undefined) chains.delete(botId)
              else chains.set(botId, chain)
            }),
          setActiveTurn: (botId, turn) =>
            Effect.sync(() => {
              if (turn === undefined) turns.delete(botId)
              else turns.set(botId, turn)
            }),
          calls: Ref.get(calls),
        })
        return Context.make(Orchestrator, orchestrator).pipe(Context.add(OrchestratorFake, control))
      }),
    )
}

// ============================================================================ ApprovalService

type ApprovalShape = (typeof ApprovalService)["Service"]

export type ApprovalPolicy = (ctx: ApprovalContext, request: HarnessRequest) => HarnessRequestResolution

/** Default fake policy: approvals → allow-once; questions → the first option (or "") per question. */
export const allowAllPolicy: ApprovalPolicy = (_ctx, request) =>
  request.kind === "question"
    ? { answers: Object.fromEntries(request.questions.map((q) => [q.id, q.options[0]?.label ?? ""])) }
    : { decision: "allow-once" }

export interface EvaluatedRequest {
  readonly ctx: ApprovalContext
  readonly request: HarnessRequest
  readonly resolution: HarnessRequestResolution
}

export interface ToolRequestRecord {
  readonly tool: "ask_user" | "request_approval" | "request_takeover"
  readonly ctx: ToolContext
  readonly input: unknown
  readonly requestId: RequestId
}

export class ApprovalServiceFake extends Context.Service<ApprovalServiceFake, {
  readonly evaluated: Effect.Effect<ReadonlyArray<EvaluatedRequest>>
  readonly setPolicy: (policy: ApprovalPolicy) => Effect.Effect<void>
  /** `ask_user` / `request_approval` / `request_takeover` calls, oldest first. */
  readonly toolRequests: Effect.Effect<ReadonlyArray<ToolRequestRecord>>
  /** `evaluateNode` calls, oldest first. */
  readonly nodeRequests: Effect.Effect<ReadonlyArray<NodeApprovalInput>>
  /** Emits an answered async request on `asyncAnswers`. */
  readonly answer: (delivery: DeliveryInput) => Effect.Effect<void>
  /** `cancelPending` calls, oldest first. */
  readonly cancelled: Effect.Effect<ReadonlyArray<Parameters<ApprovalShape["cancelPending"]>[0]>>
}>()("openbot/core/testing/ApprovalServiceFake") {
  /**
   * `evaluate` resolves immediately with the policy (it never creates RuntimeRequests or cards and
   * never calls `ctx.onPending`). `evaluateNode` → allow-once by "rule". `respond` is not
   * implemented; `listPending` → [].
   */
  static readonly layer = (options?: { readonly policy?: ApprovalPolicy }): Layer.Layer<
    ApprovalService | ApprovalServiceFake,
    never,
    IdGen
  > =>
    Layer.effectContext(
      Effect.gen(function*() {
        const ids = yield* IdGen
        const policy = yield* Ref.make<ApprovalPolicy>(options?.policy ?? allowAllPolicy)
        const evaluated = yield* Ref.make<ReadonlyArray<EvaluatedRequest>>([])
        const toolRequests = yield* Ref.make<ReadonlyArray<ToolRequestRecord>>([])
        const nodeRequests = yield* Ref.make<ReadonlyArray<NodeApprovalInput>>([])
        const cancelled = yield* Ref.make<ReadonlyArray<Parameters<ApprovalShape["cancelPending"]>[0]>>([])
        const answers = yield* Queue.unbounded<DeliveryInput>()

        const toolRequest = (tool: ToolRequestRecord["tool"], ctx: ToolContext, input: unknown) =>
          Effect.gen(function*() {
            const requestId = yield* ids.requestId
            yield* Ref.update(toolRequests, (all) => [...all, { tool, ctx, input, requestId }])
            return { status: "pending" as const, requestId }
          })

        const service = ApprovalService.of({
          evaluate: (ctx, request) =>
            Effect.gen(function*() {
              const resolution = (yield* Ref.get(policy))(ctx, request)
              yield* Ref.update(evaluated, (all) => [...all, { ctx, request, resolution }])
              return resolution
            }),
          evaluateNode: (input) =>
            Ref.update(nodeRequests, (all) => [...all, input]).pipe(
              Effect.as({ decision: "allow-once" as const, by: "rule" }),
            ),
          respond: () => notImplemented("ApprovalServiceFake", "respond"),
          listPending: () => Effect.succeed([]),
          askUser: (ctx, input) => toolRequest("ask_user", ctx, input),
          requestApproval: (ctx, input) => toolRequest("request_approval", ctx, input),
          requestTakeover: (ctx, input) => toolRequest("request_takeover", ctx, input),
          asyncAnswers: Stream.fromQueue(answers),
          cancelPending: (input) => Ref.update(cancelled, (all) => [...all, input]).pipe(Effect.as(0)),
        })
        const control = ApprovalServiceFake.of({
          evaluated: Ref.get(evaluated),
          setPolicy: (next) => Ref.set(policy, next),
          toolRequests: Ref.get(toolRequests),
          nodeRequests: Ref.get(nodeRequests),
          answer: (delivery) => Effect.asVoid(Queue.offer(answers, delivery)),
          cancelled: Ref.get(cancelled),
        })
        return Context.make(ApprovalService, service).pipe(Context.add(ApprovalServiceFake, control))
      }),
    )
}

// ============================================================================ SettingsService

export class SettingsServiceFake extends Context.Service<SettingsServiceFake, {
  /** Replaces the current settings (emitted on `changes`). */
  readonly set: (settings: Settings) => Effect.Effect<void>
}>()("openbot/core/testing/SettingsServiceFake") {
  /** In-memory settings (defaults + `initial`) and rules; no LiveHub publishing. */
  static readonly layer = (options?: { readonly initial?: Partial<Settings> }): Layer.Layer<
    SettingsService | SettingsServiceFake,
    never,
    IdGen
  > =>
    Layer.effectContext(
      Effect.gen(function*() {
        const ids = yield* IdGen
        const state = yield* SubscriptionRef.make<Settings>({ ...DEFAULT_SETTINGS, ...options?.initial })
        const rules = yield* Ref.make<ReadonlyArray<ApprovalRule>>([])
        const service = SettingsService.of({
          get: SubscriptionRef.get(state),
          update: (patch) =>
            SubscriptionRef.update(state, (current) => applySettingsPatch(current, patch)).pipe(
              Effect.andThen(SubscriptionRef.get(state)),
            ),
          changes: SubscriptionRef.changes(state),
          listRules: ({ botId }) =>
            Effect.map(Ref.get(rules), (all) =>
              all.filter((r) => botId === undefined || r.botId === undefined || r.botId === botId)),
          upsertRule: (input) =>
            Effect.gen(function*() {
              const existing = input.id === undefined ? undefined : (yield* Ref.get(rules)).find((r) => r.id === input.id)
              const rule: ApprovalRule = {
                ...input,
                id: input.id ?? (yield* ids.ruleId),
                origin: existing?.origin ?? "user",
                createdAt: existing?.createdAt ?? (yield* Clock.currentTimeMillis),
              }
              yield* Ref.update(rules, (all) => [...all.filter((r) => r.id !== rule.id), rule])
              return rule
            }),
          deleteRule: (ruleId) =>
            Effect.gen(function*() {
              const all = yield* Ref.get(rules)
              if (!all.some((r) => r.id === ruleId)) return yield* new NotFound({ entity: "rule", id: ruleId })
              yield* Ref.set(rules, all.filter((r) => r.id !== ruleId))
            }),
        })
        return Context.make(SettingsService, service).pipe(
          Context.add(SettingsServiceFake, SettingsServiceFake.of({ set: (settings) => SubscriptionRef.set(state, settings) })),
        )
      }),
    )
}

// ============================================================================ UsageService

export interface RecordedUsage {
  readonly botId: BotId
  readonly conversationId: ConversationId
  readonly turnId?: TurnId | undefined
  readonly harness: string
  readonly model?: string | undefined
  readonly usage: Usage
  readonly at: number
}

export class UsageServiceFake extends Context.Service<UsageServiceFake, {
  readonly recorded: Effect.Effect<ReadonlyArray<RecordedUsage>>
}>()("openbot/core/testing/UsageServiceFake") {
  /** Records usage in memory; `byBot` aggregates it (turnCount = distinct turn ids). */
  static readonly layer: Layer.Layer<UsageService | UsageServiceFake> = Layer.effectContext(
    Effect.gen(function*() {
      const recorded = yield* Ref.make<ReadonlyArray<RecordedUsage>>([])
      const service = UsageService.of({
        record: (input) =>
          Effect.flatMap(Clock.currentTimeMillis, (at) => Ref.update(recorded, (all) => [...all, { ...input, at }])),
        byBot: ({ sinceMs }) =>
          Effect.map(Ref.get(recorded), (all) => {
            const byBot = new Map<BotId, { usage: Usage; turns: Set<string>; lastAt: number }>()
            for (const r of all) {
              if (sinceMs !== undefined && r.at < sinceMs) continue
              const current = byBot.get(r.botId) ?? { usage: { inputTokens: 0, outputTokens: 0 }, turns: new Set<string>(), lastAt: 0 }
              current.usage = addUsage(current.usage, r.usage)
              if (r.turnId !== undefined) current.turns.add(r.turnId)
              current.lastAt = Math.max(current.lastAt, r.at)
              byBot.set(r.botId, current)
            }
            return [...byBot.entries()].map(([botId, t]): BotUsage => ({
              botId,
              usage: t.usage,
              turnCount: t.turns.size,
              lastAt: t.lastAt,
            }))
          }),
      })
      return Context.make(UsageService, service).pipe(
        Context.add(UsageServiceFake, UsageServiceFake.of({ recorded: Ref.get(recorded) })),
      )
    }),
  )
}

// ============================================================================ MemoryService

export class MemoryServiceFake extends Context.Service<MemoryServiceFake, {
  /** Calls as `"<method>:<botId>:<actor kind>"`, oldest first (actor kind "-" for read-only methods). */
  readonly calls: Effect.Effect<ReadonlyArray<string>>
}>()("openbot/core/testing/MemoryServiceFake") {
  /**
   * Straight over `MemoryStore`: no bot existence checks, no index maintenance, no events.
   * `promptIndex` caps MEMORY.md at `MEMORY_INDEX_PROMPT_CAP_BYTES`.
   */
  static readonly layer: Layer.Layer<MemoryService | MemoryServiceFake, never, MemoryStore> = Layer.effectContext(
    Effect.gen(function*() {
      const store = yield* MemoryStore
      const calls = yield* Ref.make<ReadonlyArray<string>>([])
      const call = (method: string, botId: BotId, actor?: Actor) =>
        Ref.update(calls, (all) => [...all, `${method}:${botId}:${actor?.kind ?? "-"}`])
      const read = (botId: BotId) =>
        Effect.all({ index: store.readIndex(botId), facts: store.listFacts(botId) }).pipe(repoOrDie)

      const service = MemoryService.of({
        get: (botId) => call("get", botId).pipe(Effect.andThen(read(botId))),
        putFact: (actor, botId, input) =>
          Effect.gen(function*() {
            yield* call("putFact", botId, actor)
            const fact: MemoryFact = {
              id: input.id ?? memoryFactIdFromTitle(input.title),
              title: input.title,
              body: input.body,
              updatedAt: yield* Clock.currentTimeMillis,
              ...(input.description === undefined ? {} : { description: input.description }),
            }
            yield* repoOrDie(store.putFact(botId, fact))
            return fact
          }),
        deleteFact: (actor, botId, factId) =>
          Effect.gen(function*() {
            yield* call("deleteFact", botId, actor)
            if (!(yield* repoOrDie(store.deleteFact(botId, factId)))) {
              return yield* new NotFound({ entity: "memory-fact", id: factId })
            }
          }),
        setIndex: (botId, index) =>
          call("setIndex", botId).pipe(Effect.andThen(repoOrDie(store.writeIndex(botId, index))), Effect.andThen(read(botId))),
        recall: (botId, query) =>
          Effect.gen(function*() {
            yield* call("recall", botId)
            const facts = yield* repoOrDie(store.listFacts(botId))
            if (query === undefined || query.trim() === "") return facts
            const q = query.toLowerCase()
            return facts.filter((f) => `${f.title}\n${f.description ?? ""}\n${f.body}`.toLowerCase().includes(q))
          }),
        promptIndex: (botId) =>
          Effect.map(repoOrDie(store.readIndex(botId)), (index) => capUtf8(index, MEMORY_INDEX_PROMPT_CAP_BYTES)),
      })
      return Context.make(MemoryService, service).pipe(
        Context.add(MemoryServiceFake, MemoryServiceFake.of({ calls: Ref.get(calls) })),
      )
    }),
  )
}

/** Truncates `text` to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export const capUtf8 = (text: string, maxBytes: number): string => {
  const encoder = new TextEncoder()
  if (encoder.encode(text).length <= maxBytes) return text
  let out = ""
  let used = 0
  for (const char of text) {
    const size = encoder.encode(char).length
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return out
}

// ============================================================================ all together

export type CoreServiceFakeServices =
  | LiveHub
  | LiveHubFake
  | ConversationService
  | ConversationServiceFake
  | Orchestrator
  | OrchestratorFake
  | ApprovalService
  | ApprovalServiceFake
  | SettingsService
  | SettingsServiceFake
  | UsageService
  | UsageServiceFake
  | MemoryService
  | MemoryServiceFake

/**
 * Every service fake in one layer. Needs repositories + `IdGen` + `MemoryStore`, e.g.
 * `CoreServiceFakes().pipe(Layer.provideMerge(TestPorts()))`. Replace the fake of the service
 * under test by building your real layer on top of this one.
 */
export const CoreServiceFakes = (options?: {
  readonly autoComplete?: DeliveryResult
  readonly policy?: ApprovalPolicy
  readonly settings?: Partial<Settings>
}): Layer.Layer<CoreServiceFakeServices, never, ConversationRepo | EntryRepo | RequestRepo | IdGen | MemoryStore> =>
  Layer.mergeAll(
    ConversationServiceFake.layer,
    OrchestratorFake.layer(options?.autoComplete === undefined ? undefined : { autoComplete: options.autoComplete }),
    ApprovalServiceFake.layer(options?.policy === undefined ? undefined : { policy: options.policy }),
    SettingsServiceFake.layer(options?.settings === undefined ? undefined : { initial: options.settings }),
    UsageServiceFake.layer,
    MemoryServiceFake.layer,
  ).pipe(Layer.provideMerge(LiveHubFake.layer))

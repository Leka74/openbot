/**
 * BotRunner (architecture §4.3, §4.3.1, §5.1; decision D5.0 "one mind per bot"): ONE per bot.
 *
 * - Owns the bot's single scoped `HarnessSession`, shared by all of its conversations (its DM, each
 *   group, routine runs, bot-to-bot DMs): opened lazily on the first turn (placement → MCP binding →
 *   instructions → `driver.openSession`, resuming the bot's stored native session when the driver
 *   can), reopened when the bot's harness settings or rendered instructions change, dropped on
 *   `SessionClosed`, compacted after 10 idle minutes when its context is large (setting
 *   `compactIdleBots`), and closed after 15 idle minutes (the runner is then evicted).
 * - Every turn belongs to exactly ONE conversation (its delivery's): its replies, tool calls, cards
 *   and activity land there, and its text says where it comes from (origin tags, see
 *   `renderTurnText`).
 * - Deliveries (§4.3.1) from every conversation queue FIFO here. A waking delivery starts a turn
 *   when idle; it steers into the running turn only when that turn is in the SAME conversation
 *   (`mode` steer/auto with `capabilities.steer`); otherwise it queues (one turn each). Background
 *   bot messages never interrupt a busy bot: they wait in the queue and are batched into the next
 *   turn of THEIR conversation (never into another conversation's turn), and wake an idle bot.
 * - Approvals (`approve`): in the context of the running turn (cards in its conversation); native
 *   requests carry the session's placement workspace, gateway tool requests the claims' workspace,
 *   so ApprovalService can apply the bot's autonomy.
 * - One turn at a time on the runner's fiber; harness events are consumed by a per-session fiber
 *   (TurnIngest) that completes the turn's terminal `Deferred`.
 * - Harness-initiated turns (`TurnStarted` with `initiator: "harness"`: Claude Code reporting its own
 *   background command, D2.1) join the running turn, or else run as a "system" turn in the
 *   conversation of the session's latest turn (`adoptHarnessTurn`), under the same one-at-a-time rule.
 * - Interrupts call `session.interrupt` and wait for `TurnInterrupted` (forced after a grace period);
 *   a turn not yet accepted by the harness is cancelled directly. A conversation's interrupt never
 *   touches a turn of another conversation.
 *
 * Internal module (not exported from the package).
 */
import type {
  AttachmentId,
  Bot,
  BotId,
  ContextUsage,
  Conversation,
  ConversationId,
  DecisionId,
  EntryId,
  HarnessCapabilities,
  HarnessRequest,
  HarnessRequestResolution,
  RuntimeRequest,
  SkillName,
  Turn,
  TurnId,
} from "@openbot/contracts"
import { Conflict, HarnessUnavailable, NotFound } from "@openbot/contracts"
import { Cause, Clock, Deferred, Duration, Effect, Exit, Fiber, Option, Queue, Scope, Semaphore, Stream } from "effect"
import type {
  HarnessDriver,
  HarnessRegistryShape,
  HarnessSession,
  TurnAttachment,
  TurnInput,
} from "../../ports/Harness.ts"
import { sessionKeyOf } from "../../ports/Harness.ts"
import type { IdGenShape } from "../../ports/IdGen.ts"
import type { McpBindingIssuer, McpClaims } from "../../ports/Mcp.ts"
import type { NodeFiles } from "../../ports/NodeFiles.ts"
import type { Notifier } from "../../ports/Notifier.ts"
import type { PlacementService, ResolvedPlacement } from "../../ports/Placement.ts"
import { inProfile } from "../../ports/Profiles.ts"
import {
  BotRepo,
  type BotSessionRecord,
  type ConversationRepo,
  type EntryRepo,
  type TurnRepo,
} from "../../ports/repos.ts"
import type {
  ApprovalService,
  ApprovalWorkspace,
  Carryover,
  CausalChain,
  ConversationService,
  Delivery,
  DeliveryInput,
  DeliveryOutcome,
  DeliveryReceipt,
  InstructionRenderer,
  LiveHub,
  SettingsService,
  UsageService,
} from "../../ports/services.ts"
import { MAX_BOT_HOPS } from "../../ports/services.ts"
import type { AttachmentRecord, AttachmentStore, SkillStore } from "../../ports/stores.ts"
import { routeBotMessage } from "./GroupRouter.ts"
import type { ConversationStore } from "./internal/ConversationStore.ts"
import { attachmentsLine, receiveFiles } from "./internal/inbox.ts"
import { ownerOnlySkills } from "./internal/skills.ts"
import { parseSkillCommand, renderSkillCommand, type SkillCommand } from "./skillCommand.ts"
import { capUtf8, compact, messageWithAttachments, orDie, previewOf } from "./internal/util.ts"
import {
  finalizeTurnEntries,
  type HarnessTurnRoute,
  makeSessionIngest,
  persistBotSession,
  type SessionIngest,
  type TurnTerminal,
  updateSessionRow,
} from "./TurnIngest.ts"
import { inBotProfile } from "../profiles/lookup.ts"

type Service<T extends { readonly Service: unknown }> = T["Service"]

export interface RunnerOptions {
  /** Close the session and evict the runner after this much idle time (architecture: 15 min). */
  readonly idleTimeout: Duration.Input
  /**
   * Idle this long with at least `idleCompactMinTokens` of context: compact while the prompt cache
   * is still warm (setting `compactIdleBots`), so the next turn does not re-read the whole history
   * uncached. Before `idleTimeout`, which closes the session.
   */
  readonly idleCompactAfter: Duration.Input
  readonly idleCompactMinTokens: number
  /** After `session.interrupt`, force the turn to end after this long without `TurnInterrupted`. */
  readonly interruptGrace: Duration.Input
  /** Consecutive open failures before the bot's activity becomes `error` (§6: 3). */
  readonly maxOpenFailures: number
}

export const DEFAULT_RUNNER_OPTIONS: RunnerOptions = {
  idleTimeout: Duration.minutes(15),
  idleCompactAfter: Duration.minutes(10),
  idleCompactMinTokens: 100_000,
  interruptGrace: Duration.seconds(10),
  maxOpenFailures: 3,
}

/** Group catch-up text budget (§4.3.2: capped at 8 KB, newest kept). */
export const GROUP_CATCH_UP_BYTES = 8 * 1024
const GROUP_CATCH_UP_ENTRIES = 200
const GROUP_FIRST_TURN_ENTRIES = 100

/** Origin tag of a turn in the owner's DM after a turn elsewhere (D5.0). */
export const DM_ORIGIN_TAG = "[DM with the owner]"

/** Leads a turn of teammates' messages in the owner's DM (like the group header's reply hint). */
export const BOT_DM_HINT =
  "[From teammates · your reply is posted to the owner, not sent to them (answer a teammate with message_bot) · nothing new the owner needs to know or decide → NO_REPLY]"

/** Delivery outcome registry (owned by the Orchestrator). */
export interface DeliveryOutcomes {
  readonly register: (deliveryId: string) => Effect.Effect<void>
  readonly resolve: (deliveryId: string, outcome: Omit<DeliveryOutcome, "deliveryId">) => Effect.Effect<void>
}

export interface RunnerDeps {
  readonly ids: IdGenShape
  readonly bots: Service<typeof BotRepo>
  readonly conversations: Service<typeof ConversationRepo>
  readonly entries: Service<typeof EntryRepo>
  readonly turns: Service<typeof TurnRepo>
  readonly attachments: Service<typeof AttachmentStore>
  readonly skills: Service<typeof SkillStore>
  /** Received files are copied into the bot's workspace on its host node (internal/inbox.ts). */
  readonly nodeFiles: Service<typeof NodeFiles>
  /** Largest file copied into a bot's inbox (`SendFileLimits.maxFileBytes`). */
  readonly maxFileBytes: number
  readonly registry: HarnessRegistryShape
  readonly placement: Service<typeof PlacementService>
  readonly issuer: Service<typeof McpBindingIssuer>
  readonly renderer: Service<typeof InstructionRenderer>
  readonly approvals: Service<typeof ApprovalService>
  readonly conversationService: Service<typeof ConversationService>
  readonly store: Service<typeof ConversationStore>
  readonly hub: Service<typeof LiveHub>
  readonly usage: Service<typeof UsageService>
  readonly notifier: Service<typeof Notifier>
  readonly settings: Service<typeof SettingsService>
  readonly outcomes: DeliveryOutcomes
  /** Orchestrator.deliver (errors ignored): group mention follow-ups. */
  readonly followUp: (input: DeliveryInput) => Effect.Effect<void>
  /** Removes the runner from the Orchestrator's registry. */
  readonly onEvicted: (runner: Runner) => Effect.Effect<void>
  /** Deploys (`Orchestrator.drain`): no turn starts while true; deliveries queue. */
  readonly held: () => boolean
  /** The Orchestrator layer's scope: runner fibers and session scopes live under it. */
  readonly scope: Scope.Scope
  readonly options: RunnerOptions
  /** When each harness account (`kind:profile`) was last reported signed out, shared by every runner. */
  readonly signedOut?: Map<string, number> | undefined
}

export interface Runner {
  readonly botId: BotId
  /** `"closed"` when the runner was evicted/stopped meanwhile (the caller retries with a new one). */
  readonly deliver: (delivery: Delivery, capabilities: HarnessCapabilities) => Effect.Effect<DeliveryReceipt | "closed">
  /** Interrupts the given running or queued turn. Returns the affected turns. */
  readonly interruptTurn: (turnId: TurnId) => Effect.Effect<ReadonlyArray<Turn>>
  /**
   * Stop in a conversation: interrupts the running turn when it belongs to `conversationId`;
   * otherwise cancels the queued turns of `conversationId` (the running turn elsewhere continues).
   */
  readonly interruptConversation: (conversationId: ConversationId) => Effect.Effect<ReadonlyArray<Turn>>
  /**
   * The conversation is being deleted: interrupts its running turn and drops ALL of its queued
   * deliveries, waits (bounded) until that turn has ended, and forgets the conversation's cursor.
   */
  readonly cancelConversation: (conversationId: ConversationId) => Effect.Effect<void>
  /** Stops for good: interrupts the active turn, drops queued deliveries, closes the session. */
  readonly stop: (reason: string) => Effect.Effect<void>
  /** A turn (or a compaction) is running. */
  readonly isWorking: Effect.Effect<boolean>
  /**
   * The first half of a hand-off (`Orchestrator.handOff`): closes the runner to new work and returns
   * what it held — its queued deliveries (with their turn ids), the deliveries of a turn its harness
   * has not accepted yet, and the accepted turn it will cut off. `stop` then ends that turn.
   */
  readonly takeOver: Effect.Effect<Carryover>
  /**
   * Closes the session (New session) and runs `afterDrop` (forget the native session, new epoch,
   * event) under the runner's lock, so no turn can start in between. `Conflict` while busy.
   */
  readonly resetSession: (afterDrop: Effect.Effect<void>) => Effect.Effect<void, Conflict>
  /** Compacts the native session. `Conflict` while busy. */
  readonly compact: Effect.Effect<void, Conflict | HarnessUnavailable | NotFound>
  /**
   * `message_bot` / `handoff_task` to a fellow member from a group turn: instead of a separate
   * post, the recipient is woken by the turn's reply (or, if the turn posts no reply, this text is
   * posted for it). False when the bot has no running turn in `conversationId`.
   */
  readonly noteAddress: (input: NotedAddress & { readonly conversationId: ConversationId }) => Effect.Effect<boolean>
  /** The running turn (any conversation). */
  readonly activeTurn: Effect.Effect<Option.Option<Turn>>
  readonly currentChain: Effect.Effect<Option.Option<CausalChain>>
  /**
   * Native approvals and gateway tool approvals in the context of the running turn. `workspace`
   * defaults to the open session's placement. Never fails.
   */
  readonly approve: (request: HarnessRequest, workspace?: ApprovalWorkspace) => Effect.Effect<HarnessRequestResolution>
}

/** A member addressed through `message_bot` / `handoff_task` during a group turn (woken by the reply). */
export interface NotedAddress {
  readonly recipientBotId: BotId
  /** `@Recipient …`: posted only when the turn ends without a reply. */
  readonly text: string
  readonly causalChain: CausalChain
}

/** A queued delivery. Waking deliveries own a turn id (and a `queued` Turn record); background ones batch. */
interface Queued {
  readonly arrival: number
  readonly delivery: Delivery
  readonly turnId: TurnId | undefined
}

interface ActiveTurn {
  readonly turnId: TurnId
  /** A harness-initiated turn (D2.1): the harness's own id for it (steering targets it). */
  readonly nativeTurnId?: TurnId | undefined
  readonly conversationId: ConversationId
  readonly deliveries: Array<Delivery>
  /** Deliveries folded in with `steer` (re-queued if the turn ends early without the owner's Stop). */
  readonly steered: Array<Delivery>
  readonly chain: CausalChain
  /** Members addressed with message_bot / handoff_task during this (group) turn. */
  readonly noted: Array<NotedAddress>
  /** Completed by interrupt fallbacks / cancellation before the harness accepted the turn. */
  readonly cancel: Deferred.Deferred<TurnTerminal>
  /** Completed once the turn is finished and released. */
  readonly done: Deferred.Deferred<void>
  turn: Turn | undefined
  accepted: boolean
  ending: boolean
  interruptRequested: boolean
}

interface OpenSession {
  readonly driver: HarnessDriver
  readonly session: HarnessSession
  readonly scope: Scope.Closeable
  readonly placement: ResolvedPlacement
  readonly instructionsHash: string
  readonly signature: string
  readonly ingest: SessionIngest
  readonly closed: Deferred.Deferred<string>
}

/** The owner's `/skill` command (D5.5) and the instruction the turn text carries for it. */
type RenderedSkillCommand = SkillCommand & { readonly instruction: string }

interface SessionConfig {
  readonly signature: string
  readonly ownerOnlySkills: ReadonlyArray<SkillName>
}

interface TurnFailure {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

const fail = (code: string, message: string, retryable = false): TurnFailure => ({ code, message, retryable })

/** Every delivery in it came from a voice call: the turn stays out of the chat. */
const voiceTurn = (deliveries: ReadonlyArray<Delivery>): true | undefined =>
  deliveries.length > 0 && deliveries.every((d) => d.voice === true) ? true : undefined

const triggerOf = (delivery: Delivery): Turn["trigger"] => {
  switch (delivery.kind) {
    case "user-message":
      return "user"
    case "bot-message":
      return "bot"
    case "routine":
      return "routine"
    case "system-resume":
    case "task-result":
    case "introduction":
      return "system"
  }
}

/** Harness settings a live session was opened with; a change means reopening. */
const signatureOf = (bot: Bot, ownerOnlySkills: ReadonlyArray<SkillName>): string =>
  JSON.stringify([
    bot.harness.kind,
    bot.harness.model ?? null,
    bot.harness.effort ?? null,
    bot.hostNodeId,
    [...bot.boundNodeIds].sort(),
    // the skills a session mounts (D5.5)
    [...bot.skills].sort(),
    [...ownerOnlySkills].sort(),
  ])

const isWaking = (delivery: Delivery): boolean => delivery.kind !== "bot-message" || delivery.urgency === "urgent"

/** The messages a turn answers, in order (a failed turn's `sourceEntryIds`, for Retry). */
const sourcesOf = (deliveries: ReadonlyArray<Delivery>): ReadonlyArray<EntryId> | undefined => {
  const ids = [...new Set(deliveries.flatMap((d) => (d.sourceEntryId === undefined ? [] : [d.sourceEntryId])))]
  return ids.length > 0 ? ids : undefined
}

/** Images harnesses can be shown inline (TurnInput.attachments). */
const INLINE_IMAGE = /^image\/(png|jpeg|gif|webp)$/i

/**
 * Appended (model-facing only) to an owner message folded into a running turn: a new request that
 * arrives mid-work should not silently extend this turn with more long work.
 */
const STEER_NOTE =
  "\n\n(Sent while you were still working. If this asks for more work that will take more than about a minute, start it with start_task and reply right away instead of doing it in this turn. If it concerns work you already started in parallel, pass it on with update_task.)"

const isSteerable = (delivery: Delivery): boolean =>
  delivery.mode === "steer" ||
  (delivery.mode === "auto" && (delivery.kind === "user-message" || delivery.kind === "bot-message"))

const denyAll: HarnessRequestResolution = { decision: "deny" satisfies DecisionId }

/** `"secret project"` with straight quotes stripped from the title (keeps the tag on one line). */
const HARNESS_NAMES: Readonly<Record<string, string>> = { claude: "Claude", codex: "Codex", opencode: "OpenCode" }

/**
 * An "auth" failure (the harness's login on the brain's computer expired or was revoked) in plain
 * words, with the fix; the harness's own text stays in brackets.
 */
export const signedOutText = (harness: string, botName: string, detail: string): string =>
  `${HARNESS_NAMES[harness] ?? harness} is signed out on the computer OpenBot runs on, so ${botName} can't reply. Sign in again (Settings › Harnesses shows how), then press Retry. (${detail})`

/** One "signed out" notification per harness account in this window. */
export const SIGNED_OUT_NOTIFY_MS = 30 * 60_000

const quoted = (title: string) => `"${title.replace(/["\r\n]+/g, " ").trim()}"`

export const makeRunner = (deps: RunnerDeps, botId: BotId): Effect.Effect<Runner> =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1)
    const signal = yield* Queue.unbounded<void>()
    const state = {
      closed: false,
      control: false,
      arrivals: 0,
      active: undefined as ActiveTurn | undefined,
      queue: [] as Array<Queued>,
      session: undefined as OpenSession | undefined,
      openFailures: 0,
      /** Per-conversation cursors not yet persisted (no session record yet); the record wins otherwise. */
      seen: new Map<ConversationId, EntryId>(),
      /** The conversation of the session's latest turn (undefined = unknown: falls back to the record). */
      lastConversationId: undefined as ConversationId | undefined,
      /**
       * Group entries after the conversation's cursor that the session already read in steered input:
       * never repeated in the next catch-up.
       */
      shown: new Map<ConversationId, Set<EntryId>>(),
      /** Steered deliveries already re-queued once (never twice). */
      requeued: new Set<string>(),
      /** Told to the next turn: the previous one ended early, so its reply may not have been posted. */
      carryNote: undefined as string | undefined,
    }
    const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect)

    // ------------------------------------------------------------------ small writers

    const writeTurn = (turn: Turn) =>
      Effect.gen(function* () {
        yield* orDie(deps.turns.upsert(turn))
        yield* deps.hub.publishConversation(turn.conversationId, { type: "turn.upserted", turn })
      })

    const setActivity = (activity: Parameters<typeof deps.hub.setActivity>[0]) =>
      deps.hub.setActivity(compact(activity))

    const setTurnStatus = (active: ActiveTurn, status: "running" | "waiting") =>
      locked(
        Effect.gen(function* () {
          if (state.active !== active || active.ending || active.turn === undefined || active.turn.status === status)
            return
          active.turn = { ...active.turn, status }
          yield* writeTurn(active.turn)
        }),
      )

    const botName = (id: BotId | undefined) =>
      id === undefined
        ? Effect.succeed("bot")
        : Effect.map(orDie(deps.bots.get(id)), (bot) => (Option.isSome(bot) ? bot.value.name : id))

    const settings = inBotProfile(botId)(deps.settings.get).pipe(Effect.provideService(BotRepo, deps.bots))
    const ownerName = Effect.map(settings, (s) => (s.ownerName?.trim() ? s.ownerName.trim() : "owner"))

    // ------------------------------------------------------------------ session record (cursors)

    const sessionRecord = orDie(deps.bots.getSession(botId))

    /** Writes cursors / the last conversation into the session record when one exists. */
    const syncRecord = (record: BotSessionRecord) =>
      Effect.gen(function* () {
        const seen: Record<string, EntryId> = { ...record.seen }
        for (const [conversationId, entryId] of state.seen) seen[conversationId] = entryId
        const next = compact({
          ...record,
          seen: Object.keys(seen).length === 0 ? undefined : seen,
          lastConversationId: state.lastConversationId ?? record.lastConversationId,
        })
        if (JSON.stringify(next) === JSON.stringify(record)) return
        yield* orDie(deps.bots.setSession({ ...next, updatedAt: yield* Clock.currentTimeMillis }))
      })

    const persistCursors = Effect.gen(function* () {
      const record = yield* sessionRecord
      if (Option.isSome(record)) yield* syncRecord(record.value)
    })

    const seenOf = (conversationId: ConversationId) =>
      Effect.gen(function* () {
        const local = state.seen.get(conversationId)
        if (local !== undefined) return local
        const record = yield* sessionRecord
        return Option.isSome(record) ? record.value.seen?.[conversationId] : undefined
      })

    const lastConversationOf = Effect.gen(function* () {
      if (state.lastConversationId !== undefined) return state.lastConversationId
      const record = yield* sessionRecord
      return Option.isSome(record) ? record.value.lastConversationId : undefined
    })

    /** Forgets the session's cursors (New session / resume failure: the new session saw nothing). */
    const forgetCursors = () => {
      state.seen.clear()
      state.shown.clear()
      state.lastConversationId = undefined
    }

    const markShown = (conversationId: ConversationId, entryId: EntryId | undefined) => {
      if (entryId === undefined) return
      const set = state.shown.get(conversationId) ?? new Set<EntryId>()
      set.add(entryId)
      state.shown.set(conversationId, set)
    }

    // ------------------------------------------------------------------ approvals

    const markWaiting = (
      active: ActiveTurn | undefined,
      conversationId: ConversationId | undefined,
      request: RuntimeRequest,
    ) =>
      Effect.gen(function* () {
        if (active !== undefined) yield* setTurnStatus(active, "waiting")
        yield* setActivity({
          botId,
          conversationId: active?.conversationId ?? conversationId,
          state: "waiting",
          label: `Waiting for you: ${previewOf(request.title, 80)}`,
          since: yield* Clock.currentTimeMillis,
        })
      })

    /** The open session's workspace (where its tools run), for autonomy "workspace". */
    const sessionWorkspace = (): ApprovalWorkspace | undefined => {
      const placement = state.session?.placement
      return placement === undefined ? undefined : { nodeId: placement.hostNodeId, path: placement.workspacePath }
    }

    const approve = (request: HarnessRequest, workspace?: ApprovalWorkspace): Effect.Effect<HarnessRequestResolution> =>
      Effect.gen(function* () {
        const found = yield* orDie(deps.bots.get(botId))
        if (Option.isNone(found)) return denyAll
        const bot = found.value
        const active = state.active
        // The card lands where the bot is working: the running turn's conversation, else its DM.
        const conversationId = active?.conversationId ?? bot.directConversationId
        let waited = false
        const where = workspace ?? sessionWorkspace()
        const resolution = yield* deps.approvals.evaluate(
          {
            bot,
            conversationId,
            turnId: active?.turnId,
            harness: bot.harness.kind,
            ...(where === undefined ? {} : { workspace: where }),
            onPending: (pending) => {
              waited = true
              return markWaiting(active, conversationId, pending)
            },
          },
          request,
        )
        if (waited && active !== undefined && state.active === active && !active.ending) {
          yield* setTurnStatus(active, "running")
          yield* setActivity({ botId, conversationId, state: "thinking", since: yield* Clock.currentTimeMillis })
        }
        return resolution
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("BotRunner: approval failed; denying", cause).pipe(Effect.as(denyAll)),
        ),
      )

    // ------------------------------------------------------------------ the session

    const dropSession = (reason: string) =>
      Effect.gen(function* () {
        const open = state.session
        if (open === undefined) return
        state.session = undefined
        yield* Effect.logDebug(`BotRunner ${botId}: closing session (${reason})`)
        yield* Scope.close(open.scope, Exit.void)
      })

    const openOnce = (bot: Bot, driver: HarnessDriver, config: SessionConfig, resumeId: string | undefined) =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(deps.scope, "sequential")
        const home = bot.directConversationId
        const sessionKey = sessionKeyOf(bot.id, home)
        const opened = Effect.gen(function* () {
          const placement = yield* deps.placement
            .resolve({ bot, driver })
            .pipe(Effect.mapError((e) => fail(`placement-${e.reason}`, e.message, e.reason === "node-unavailable")))
          // One binding for the bot's one session: the gateway resolves each call's conversation.
          const claims: McpClaims = {
            botId: bot.id,
            conversationId: home,
            sessionKey,
            toolsets: [...placement.toolsets],
            hostNodeId: placement.hostNodeId,
            workspacePath: placement.workspacePath,
            boundNodeIds: [...bot.boundNodeIds],
          }
          const binding = yield* deps.issuer.issue(claims)
          const instructions = yield* deps.renderer.render({ bot, placement })
          const closed = yield* Deferred.make<string>()
          const ingest = yield* makeSessionIngest({
            botId,
            homeConversationId: home,
            harness: driver.kind,
            model: () => bot.harness.model,
            instructionsHash: instructions.hash,
            conversationService: deps.conversationService,
            store: deps.store,
            hub: deps.hub,
            usage: deps.usage,
            entries: deps.entries,
            bots: deps.bots,
            activeTurnId: () => state.active?.turnId,
            onSessionBound: () => persistCursors,
            onSessionClosed: (reason) => Effect.asVoid(Deferred.succeed(closed, reason)),
            onHarnessTurn: (nativeTurnId, self) =>
              adoptHarnessTurn({ nativeTurnId, ingest: self, home, closed, displayName: driver.displayName }),
          })
          const session = yield* driver
            .openSession({
              bot,
              ownerOnlySkills: config.ownerOnlySkills,
              conversationId: home,
              sessionKey,
              nativeSessionId: resumeId,
              placement,
              instructions,
              mcp: [binding],
              model: bot.harness.model,
              effort: bot.harness.effort,
              // The placement is known here even before `state.session` is set.
              onRequest: (request) => approve(request, { nodeId: placement.hostNodeId, path: placement.workspacePath }),
            })
            .pipe(
              Effect.mapError((e) =>
                fail(e.code === "unsupported" ? "open-failed" : e.code, e.message, e.retryable ?? false),
              ),
            )
          yield* Effect.forkIn(
            Stream.runForEach(session.events, ingest.handle).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError("BotRunner: event stream failed", cause),
              ),
              Effect.ensuring(Deferred.succeed(closed, "the harness event stream ended")),
            ),
            scope,
            { startImmediately: true },
          )
          const open: OpenSession = {
            driver,
            session,
            scope,
            placement,
            instructionsHash: instructions.hash,
            signature: config.signature,
            ingest,
            closed,
          }
          return open
        }).pipe(Scope.provide(scope))
        return yield* opened.pipe(
          Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit))),
        )
      })

    const openSession = (bot: Bot, driver: HarnessDriver, config: SessionConfig, noticeIn: ConversationId) =>
      Effect.gen(function* () {
        const native = yield* sessionRecord
        const resumeId =
          Option.isSome(native) && native.value.driver === driver.kind && driver.capabilities.resume
            ? native.value.nativeSessionId
            : undefined
        const first = yield* Effect.result(openOnce(bot, driver, config, resumeId))
        let open: OpenSession
        if (first._tag === "Success") {
          open = first.success
        } else if (resumeId !== undefined && first.failure.code !== "not-installed" && first.failure.code !== "auth") {
          // The stored native session cannot be resumed: start a fresh one (and say so).
          yield* orDie(deps.bots.clearSession(botId))
          forgetCursors()
          yield* Effect.ignore(
            deps.conversationService.appendNotice({
              conversationId: noticeIn,
              level: "warning",
              code: "resume-failed",
              text: `Couldn't resume the previous ${driver.displayName} session (${first.failure.message}). Started a new one.`,
            }),
          )
          open = yield* openOnce(bot, driver, config, undefined)
        } else {
          return yield* Effect.fail(first.failure)
        }
        state.session = open
        state.openFailures = 0
        const nativeId = yield* open.session.nativeSessionId
        if (nativeId !== undefined) {
          yield* persistBotSession(deps.bots, {
            botId,
            driver: driver.kind,
            nativeSessionId: nativeId,
            instructionsHash: open.instructionsHash,
          })
          yield* persistCursors
        }
        yield* updateSessionRow(deps.store, bot.directConversationId, botId, (row, now) =>
          row?.active === true
            ? undefined
            : compact({ botId, active: true, contextUsage: row?.contextUsage, updatedAt: now }),
        )
        return open
      })

    const ensureSession = (bot: Bot, noticeIn: ConversationId): Effect.Effect<OpenSession, TurnFailure> =>
      Effect.gen(function* () {
        const driver = yield* deps.registry
          .get(bot.harness.kind, bot.harness.profileId)
          .pipe(Effect.mapError((e) => fail("harness-unavailable", e.message)))
        const ownerOnly = yield* ownerOnlySkills(deps.skills, bot.skills).pipe(inProfile(bot.ownerProfileId))
        const config: SessionConfig = { signature: signatureOf(bot, ownerOnly), ownerOnlySkills: ownerOnly }
        const current = state.session
        if (current !== undefined) {
          const closed = yield* Deferred.isDone(current.closed)
          if (!closed && current.driver === driver && current.signature === config.signature) {
            const instructions = yield* deps.renderer.render({ bot, placement: current.placement })
            if (instructions.hash === current.instructionsHash) return current
          }
          yield* dropSession(closed ? "closed" : "reconfigured")
        }
        return yield* openSession(bot, driver, config, noticeIn)
      })

    // ------------------------------------------------------------------ turn text

    /** Stored records of attachment ids (unknown ids are skipped), in order, without duplicates. */
    const recordsOf = (ids: ReadonlyArray<AttachmentId>) =>
      Effect.gen(function* () {
        const out: Array<AttachmentRecord> = []
        for (const id of new Set(ids)) {
          const record = yield* orDie(deps.attachments.get(id))
          if (Option.isSome(record)) out.push(record.value)
        }
        return out
      })

    /**
     * Files the turn carries (owner uploads, files from other bots, files in the group catch-up):
     * copied into the workspace inbox on the host node and listed in the turn text. The harness also
     * gets the images inline when it can see images, and any file that could not be copied by its
     * brain path.
     */
    const receivedFilesOf = (open: OpenSession, conversationId: ConversationId, ids: ReadonlyArray<AttachmentId>) =>
      Effect.gen(function* () {
        const records = yield* recordsOf(ids)
        if (records.length === 0) return { line: "", attachments: [] as ReadonlyArray<TurnAttachment> }
        const received = yield* receiveFiles(
          { nodeFiles: deps.nodeFiles, attachments: deps.attachments, ids: deps.ids, maxFileBytes: deps.maxFileBytes },
          { botId, conversationId, placement: open.placement, records },
        )
        const attachments: Array<TurnAttachment> = received
          .filter(
            (file) =>
              (open.driver.capabilities.images && INLINE_IMAGE.test(file.record.mime)) ||
              file.relativePath === undefined,
          )
          .map((file) => ({ path: file.record.path, mime: file.record.mime, name: file.record.name }))
        return { line: attachmentsLine(received), attachments }
      })

    /** One delivery as the bot reads it: group lines carry `[@Name]:`, bot DMs `[Direct message from @Name]:`. */
    const renderDelivery = (delivery: Delivery, kind: Conversation["kind"]) =>
      Effect.gen(function* () {
        if (delivery.kind === "bot-message") {
          const name = yield* botName(delivery.fromBotId)
          const text =
            kind === "group" ? `[@${name}]: ${delivery.text}` : `[Direct message from @${name}]: ${delivery.text}`
          return { text }
        }
        if (delivery.kind === "user-message") {
          const command = yield* skillCommandOf(delivery.text)
          const text = command?.instruction ?? delivery.text
          return { text: kind === "group" ? `[@${yield* ownerName}]: ${text}` : text, command }
        }
        return { text: delivery.text }
      })

    /** The owner's `/skill` command in `text` (D5.5), with the instruction the Bot reads for it. */
    const skillCommandOf = (text: string) =>
      Effect.gen(function* () {
        if (!text.trimStart().startsWith("/")) return undefined
        const bot = yield* orDie(deps.bots.get(botId))
        if (Option.isNone(bot)) return undefined
        const command = parseSkillCommand(text, bot.value.skills)
        const name = bot.value.skills.find((skill) => skill === command?.name)
        if (command === undefined || name === undefined) return undefined
        const inBotProfile = inProfile(bot.value.ownerProfileId)
        const skill = yield* orDie(deps.skills.get(name)).pipe(inBotProfile)
        if (Option.isNone(skill)) return undefined
        const dir = yield* deps.skills.dir(name).pipe(inBotProfile)
        const instruction = renderSkillCommand(command, { body: skill.value.body, dir })
        return { ...command, instruction }
      })

    const renderDeliveries = (deliveries: ReadonlyArray<Delivery>, kind: Conversation["kind"]) =>
      Effect.map(
        Effect.forEach(deliveries, (d) => renderDelivery(d, kind)),
        (parts) => ({
          text: parts.map((part) => part.text).join("\n\n"),
          command: parts.find((part) => part.command !== undefined)?.command,
        }),
      )

    /**
     * One compact line framing a group turn: where the bot is, who is in it, that its reply is posted
     * here and that coordination happens here (with @mentions), not in direct messages.
     */
    const groupHeader = (conversation: Extract<Conversation, { kind: "group" }>) =>
      Effect.gen(function* () {
        const members: Array<string> = []
        for (const id of conversation.memberBotIds)
          members.push(`@${yield* botName(id)}${id === botId ? " (you)" : ""}`)
        return `[Group chat ${quoted(conversation.title)} · members: ${members.join(", ")} · your reply is posted here; @mention a teammate in it only when you need them to act or answer (not to thank) · nothing for you to add → react or reply NO_REPLY · new messages since your last turn here]`
      })

    /**
     * The turn's text (D5.0 origin tags, §4.3.2 catch-up):
     * - group: the group header, then the group messages this session has not seen yet;
     * - the owner's DM / a routine-run conversation: the deliveries, opened with an origin tag line
     *   (`[DM with the owner]`, `[Routine run "…"]`) when the session's previous turn was elsewhere;
     * - bot messages in a DM read `[Direct message from @Name]: …`, led by `BOT_DM_HINT` when the turn
     *   carries only teammates' messages.
     */
    const renderTurnText = (bot: Bot, conversation: Conversation, deliveries: ReadonlyArray<Delivery>) =>
      Effect.gen(function* () {
        const conversationId = conversation.id
        if (conversation.kind !== "group") {
          const body = yield* renderDeliveries(deliveries, conversation.kind)
          const previous = (yield* lastConversationOf) ?? bot.directConversationId
          const fromBotsOnly = deliveries.every((d) => d.kind === "bot-message")
          const tag =
            previous === conversationId || (conversation.kind === "direct" && fromBotsOnly)
              ? undefined
              : conversation.kind === "direct"
                ? DM_ORIGIN_TAG
                : `[Routine run ${quoted(conversation.title)} · your reply is posted there]`
          // Teammates writing in the owner's DM: the reply lands with the owner, so it should be rare.
          const lead = conversation.kind === "direct" && fromBotsOnly ? [tag, BOT_DM_HINT] : [tag]
          const prefix = lead.filter((line) => line !== undefined).join("\n")
          return {
            text: prefix === "" ? body.text : `${prefix}\n${body.text}`,
            lastSeen: undefined as EntryId | undefined,
            attachmentIds: [] as ReadonlyArray<AttachmentId>,
            command: body.command,
          }
        }
        const header = yield* groupHeader(conversation)
        const seen = yield* seenOf(conversationId)
        let window =
          seen === undefined
            ? (yield* orDie(deps.entries.page({ conversationId, limit: GROUP_FIRST_TURN_ENTRIES }))).entries
            : yield* orDie(deps.entries.listAfter(conversationId, seen, GROUP_CATCH_UP_ENTRIES))
        if (window.length >= GROUP_CATCH_UP_ENTRIES) {
          window = (yield* orDie(deps.entries.page({ conversationId, limit: GROUP_FIRST_TURN_ENTRIES }))).entries
        }
        const owner = yield* ownerName
        // `bytes` counts the owner's `/skill` command as typed, so its skill inline never crowds out the catch-up
        const lines: Array<{ readonly text: string; readonly bytes: number }> = []
        const push = (text: string, counted = text) =>
          lines.push({ text, bytes: new TextEncoder().encode(counted).length + 1 })
        let command: RenderedSkillCommand | undefined
        // The owner's messages this turn answers: a `/skill` command among them is expanded, never an older one.
        const current = new Set(deliveries.flatMap((d) => (d.kind === "user-message" ? [d.sourceEntryId] : [])))
        const rendered = new Set<EntryId>()
        /** Files in the catch-up (sent by the owner or teammates): copied into the inbox too. */
        const attachmentIds: Array<AttachmentId> = []
        // Read already (steered into an earlier turn): never repeated.
        const shown = state.shown.get(conversationId) ?? new Set<EntryId>()
        state.shown.delete(conversationId)
        for (const entry of window) {
          if (shown.has(entry.id)) {
            rendered.add(entry.id)
            continue
          }
          // a teammate's ui card reads as its fallback text
          if (entry.kind === "card" && entry.card.type === "ui" && entry.author.kind === "bot") {
            if (entry.author.botId === botId) continue
            push(`[@${yield* botName(entry.author.botId)}]: ${entry.card.fallback}`)
            rendered.add(entry.id)
            continue
          }
          if (
            entry.kind !== "message" ||
            (entry.text.trim() === "" && entry.attachments.length === 0) ||
            entry.streaming
          )
            continue
          const text = messageWithAttachments(entry.text, entry.attachments)
          if (entry.author.kind === "bot") {
            // Its own messages are in its memory already (one mind).
            if (entry.author.botId === botId) continue
            push(`[@${yield* botName(entry.author.botId)}]: ${text}`)
            rendered.add(entry.id)
            attachmentIds.push(...entry.attachments.map((a) => a.id))
          } else if (entry.author.kind === "user") {
            const found = current.has(entry.id) ? yield* skillCommandOf(entry.text) : undefined
            command ??= found
            push(
              `[@${owner}]: ${found === undefined ? text : messageWithAttachments(found.instruction, entry.attachments)}`,
              `[@${owner}]: ${text}`,
            )
            rendered.add(entry.id)
            attachmentIds.push(...entry.attachments.map((a) => a.id))
          }
        }
        // Deliveries whose source is not a group message in the window (routine prompts, answers to
        // async questions, messages older than the window) are appended verbatim.
        const extra = deliveries.filter((d) => d.sourceEntryId === undefined || !rendered.has(d.sourceEntryId))
        for (const delivery of extra) {
          const line = yield* renderDelivery(delivery, "group")
          command ??= line.command
          push(line.text, line.command === undefined ? line.text : `[@${owner}]: ${delivery.text}`)
        }
        const lastSeen = window[window.length - 1]?.id ?? seen
        if (lines.length === 0) {
          const body = yield* renderDeliveries(deliveries, "group")
          return { text: `${header}\n${body.text}`, lastSeen, attachmentIds, command: body.command }
        }
        // Keep the newest whole lines within the budget.
        const kept: Array<string> = []
        let budget = GROUP_CATCH_UP_BYTES
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i]!
          if (line.bytes > budget) {
            if (kept.length === 0) kept.unshift(capUtf8(line.text, budget))
            break
          }
          budget -= line.bytes
          kept.unshift(line.text)
        }
        return { text: `${header}\n${kept.join("\n")}`, lastSeen, attachmentIds, command }
      })

    // ------------------------------------------------------------------ turns

    const markUserMessages = (deliveries: ReadonlyArray<Delivery>, delivery: "queued" | "delivered" | "failed") =>
      Effect.forEach(
        deliveries.filter((d) => d.kind === "user-message" && d.sourceEntryId !== undefined),
        (d) =>
          Effect.ignore(
            deps.conversationService.updateEntry(d.sourceEntryId!, (entry) =>
              entry.kind === "message" &&
              entry.role === "user" &&
              entry.delivery !== "delivered" &&
              entry.delivery !== delivery
                ? { ...entry, delivery }
                : entry,
            ),
          ),
        { discard: true },
      )

    const executeTurn = (active: ActiveTurn): Effect.Effect<TurnTerminal> =>
      Effect.gen(function* () {
        const conversationId = active.conversationId
        const now = yield* Clock.currentTimeMillis
        const first = active.deliveries.find(isWaking) ?? active.deliveries[0]!
        const inputEntryId = active.deliveries.find((d) => d.kind === "user-message")?.sourceEntryId
        active.turn = compact<Turn>({
          id: active.turnId,
          conversationId,
          botId,
          status: "running",
          trigger: triggerOf(first),
          inputEntryId,
          startedAt: now,
          voice: voiceTurn(active.deliveries),
        })
        yield* writeTurn(active.turn)
        yield* setActivity({ botId, conversationId, state: "thinking", since: now })

        const found = yield* orDie(deps.bots.get(botId))
        if (Option.isNone(found))
          return { _tag: "failed", code: "bot-missing", message: "This bot was deleted.", retryable: false }
        const bot = found.value
        const conversation = yield* Effect.result(deps.store.get(conversationId))
        if (conversation._tag === "Failure") {
          return {
            _tag: "failed",
            code: "conversation-missing",
            message: "This conversation was deleted.",
            retryable: false,
          }
        }

        const opened = yield* Effect.result(ensureSession(bot, conversationId))
        if (opened._tag === "Failure") {
          state.openFailures++
          const { code, message, retryable } = opened.failure
          return { _tag: "failed", code, message: `Couldn't start ${bot.harness.kind}: ${message}`, retryable }
        }
        const open = opened.success
        if (active.interruptRequested) return { _tag: "interrupted" }

        const rendered = yield* renderTurnText(bot, conversation.success, active.deliveries)
        const files = yield* receivedFilesOf(open, conversationId, [
          ...active.deliveries.flatMap((d) => d.attachmentIds),
          ...rendered.attachmentIds,
        ])
        if (active.interruptRequested) return { _tag: "interrupted" }
        const note = state.carryNote
        const text = [note, rendered.text, files.line].filter((part) => part !== undefined && part !== "").join("\n")
        const command = rendered.command
        const input: TurnInput = {
          turnId: active.turnId,
          conversationId,
          text,
          attachments: files.attachments,
          ...(command === undefined
            ? {}
            : {
                skillCommand: {
                  name: command.name,
                  args: text.replace(command.instruction, () => command.rest).trim(),
                },
              }),
        }
        // a routine run is quiet: only its final message is posted, its narration goes with its steps
        const terminal = yield* open.ingest.beginTurn(active.turnId, conversationId, {
          quiet: active.deliveries.every((d) => d.kind === "routine"),
        })
        const started = yield* Effect.result(open.session.startTurn(input))
        if (started._tag === "Failure") {
          if (started.failure.code === "closed") yield* dropSession("closed")
          return {
            _tag: "failed",
            code: started.failure.code,
            message: started.failure.message,
            retryable: started.failure.retryable ?? false,
          }
        }
        const interruptNow = yield* locked(
          Effect.sync(() => {
            active.accepted = true
            return active.interruptRequested
          }),
        )
        if (interruptNow) yield* requestHarnessInterrupt(active, open)
        if (note !== undefined && state.carryNote === note) state.carryNote = undefined
        yield* markUserMessages(active.deliveries, "delivered")
        // The session now knows this conversation up to here (group cursor) and that it is in it.
        state.lastConversationId = conversationId
        if (rendered.lastSeen !== undefined) state.seen.set(conversationId, rendered.lastSeen)
        yield* persistCursors

        return yield* awaitTerminal(terminal, open.closed, open.driver.displayName)
      })

    /** The turn's terminal event, or the session closing under it. */
    const awaitTerminal = (
      terminal: Deferred.Deferred<TurnTerminal>,
      closed: Deferred.Deferred<string>,
      displayName: string,
    ): Effect.Effect<TurnTerminal> =>
      Effect.gen(function* () {
        const outcome = yield* Effect.raceFirst(
          Deferred.await(terminal),
          Effect.map(Deferred.await(closed), (reason): TurnTerminal => ({
            _tag: "failed",
            code: "closed",
            message: `The ${displayName} session closed: ${reason}`,
            retryable: true,
          })),
        )
        if (outcome._tag === "failed" && outcome.code === "closed") yield* dropSession("closed")
        return outcome
      })

    /** Calls `session.interrupt` and forces the turn to end if the harness never confirms. */
    const requestHarnessInterrupt = (active: ActiveTurn, open: OpenSession) =>
      Effect.gen(function* () {
        yield* open.session.interrupt.pipe(
          Effect.catchCause((cause) => Effect.logWarning("BotRunner: interrupt failed", cause)),
        )
        yield* Effect.forkIn(
          Effect.sleep(deps.options.interruptGrace).pipe(
            Effect.andThen(
              Deferred.succeed(active.cancel, { _tag: "interrupted", reason: "no confirmation from the harness" }),
            ),
          ),
          deps.scope,
          { startImmediately: true },
        )
      })

    /**
     * Members this bot already addressed in the group during the turn (`message_bot` /
     * `handoff_task` / `post_to_group` posts, which deliver themselves): its reply mentioning them
     * again ("I asked @Bob to …") must not wake them a second time.
     */
    const addressedDuringTurn = (active: ActiveTurn) =>
      Effect.gen(function* () {
        const addressed = new Set<BotId>()
        const since = active.deliveries.find((d) => d.sourceEntryId !== undefined)?.sourceEntryId
        if (since === undefined) return addressed
        for (const entry of yield* orDie(
          deps.entries.listAfter(active.conversationId, since, GROUP_CATCH_UP_ENTRIES),
        )) {
          if (entry.kind !== "message" || entry.author.kind !== "bot" || entry.author.botId !== botId) continue
          for (const id of entry.addressedBotIds ?? []) addressed.add(id)
        }
        return addressed
      })

    /**
     * Wakes the members a finished group turn addressed: @mentions in its posted reply. Each member
     * is woken ONCE, with the latest message addressing it, preferring final messages over mid-turn
     * commentary. Members noted through message_bot / handoff_task are woken by the reply when it
     * @mentions them; otherwise (or with no reply: `NO_REPLY`, failure, interrupt) the noted text is
     * posted as-is.
     */
    const followUpMentions = (
      bot: Bot,
      conversation: Conversation,
      active: ActiveTurn,
      messages: ReadonlyArray<{ readonly id: EntryId; readonly text: string; readonly commentary: boolean }>,
    ) =>
      Effect.gen(function* () {
        if (conversation.kind !== "group") return
        const members = (yield* Effect.forEach(conversation.memberBotIds, (id) => orDie(deps.bots.get(id)))).flatMap(
          (b) => (Option.isSome(b) ? [b.value] : []),
        )
        const hops = active.chain.hops + 1
        let limited = false
        const delivered = yield* addressedDuringTurn(active)
        const targets = new Map<BotId, { readonly id: EntryId; readonly text: string; readonly commentary: boolean }>()
        for (const message of messages) {
          for (const target of routeBotMessage({
            group: conversation,
            members,
            text: message.text,
            senderBotId: bot.id,
          })) {
            const previous = targets.get(target)
            if (previous === undefined || !(message.commentary && !previous.commentary)) targets.set(target, message)
          }
        }
        // Noted members the reply does not @mention: their message_bot / handoff_task text is posted
        // as its own message (the reply was not for them, so this is no duplicate).
        const leftovers = active.noted.filter(
          (note) => !targets.has(note.recipientBotId) && !delivered.has(note.recipientBotId),
        )
        for (const [target, message] of targets) {
          if (delivered.has(target)) continue
          if (hops > MAX_BOT_HOPS) {
            limited = true
            continue
          }
          delivered.add(target)
          yield* deps.followUp({
            conversationId: conversation.id,
            botId: target,
            kind: "bot-message",
            text: message.text,
            fromBotId: bot.id,
            sourceEntryId: message.id,
            causalChain: { rootId: active.chain.rootId, hops },
            urgency: "urgent",
          })
        }
        yield* postNoted(bot, conversation.id, leftovers, delivered)
        if (limited) {
          yield* Effect.ignore(
            deps.conversationService.appendEvent({
              conversationId: conversation.id,
              event: { type: "hop-limit", hops: active.chain.hops },
            }),
          )
        }
      })

    /** Posts noted message_bot / handoff_task texts that no reply carried, and wakes their recipients. */
    const postNoted = (
      bot: Bot,
      conversationId: ConversationId,
      notes: ReadonlyArray<NotedAddress>,
      delivered: Set<BotId>,
    ) =>
      Effect.forEach(
        notes,
        (note) =>
          Effect.gen(function* () {
            if (delivered.has(note.recipientBotId)) return
            delivered.add(note.recipientBotId)
            const posted = yield* Effect.result(
              deps.conversationService.appendEntry({
                kind: "message",
                conversationId,
                author: { kind: "bot", botId: bot.id },
                role: "bot",
                text: note.text,
                attachments: [],
                streaming: false,
                addressedBotIds: [note.recipientBotId],
              }),
            )
            if (posted._tag === "Failure") return
            yield* deps.followUp({
              conversationId,
              botId: note.recipientBotId,
              kind: "bot-message",
              text: note.text,
              fromBotId: bot.id,
              sourceEntryId: posted.success.id,
              causalChain: note.causalChain,
              urgency: "urgent",
            })
          }),
        { discard: true },
      )

    /** A signed-out harness's failure, in plain words with the fix. */
    const explainFailure = (terminal: TurnTerminal) =>
      terminal._tag !== "failed" || terminal.code !== "auth"
        ? Effect.succeed(terminal)
        : Effect.map(orDie(deps.bots.get(botId)), (bot): TurnTerminal =>
            Option.isNone(bot)
              ? terminal
              : { ...terminal, message: signedOutText(bot.value.harness.kind, bot.value.name, terminal.message) },
          )

    const finishTurn = (active: ActiveTurn, reported: TurnTerminal) =>
      Effect.gen(function* () {
        const terminal = yield* explainFailure(reported)
        const conversationId = active.conversationId
        yield* locked(
          Effect.sync(() => {
            active.ending = true
          }),
        )
        const conversation0 = yield* Effect.result(deps.store.get(conversationId))
        const status = terminal._tag
        const finalized = yield* finalizeTurnEntries(
          { conversationService: deps.conversationService, entries: deps.entries },
          active.turnId,
          status,
        )
        const open = state.session
        const usage = open?.ingest.usageOf(active.turnId)
        if (open !== undefined) {
          yield* open.ingest.flushContextUsage
          open.ingest.endTurn(active.turnId)
        }
        const now = yield* Clock.currentTimeMillis
        const base: Turn = active.turn ?? {
          id: active.turnId,
          conversationId,
          botId,
          status: "running",
          trigger: triggerOf(active.deliveries[0]!),
          startedAt: now,
          ...(voiceTurn(active.deliveries) ? { voice: true } : {}),
        }
        const turn = compact<Turn>({
          ...base,
          status,
          endedAt: now,
          stopReason:
            terminal._tag === "completed"
              ? terminal.stopReason
              : terminal._tag === "interrupted"
                ? terminal.reason
                : undefined,
          failure:
            terminal._tag === "failed"
              ? { code: terminal.code, message: terminal.message, retryable: terminal.retryable }
              : undefined,
          sourceEntryIds: terminal._tag === "failed" ? sourcesOf(active.deliveries) : undefined,
          usage: usage ?? base.usage,
        })
        active.turn = turn
        yield* writeTurn(turn)
        if (terminal._tag === "failed") {
          if (!active.accepted) yield* markUserMessages(active.deliveries, "failed")
          yield* Effect.ignore(
            deps.conversationService.appendNotice({
              conversationId,
              level: "error",
              code: terminal.code === "usage-limit" ? "usage-limit" : "turn-failed",
              text: terminal.message,
              turnId: active.turnId,
            }),
          )
        }
        yield* deps.approvals.cancelPending({ turnId: active.turnId, reason: "turn-ended" })
        const requeued = terminal._tag === "completed" ? [] : yield* requeueSteered(active)
        // a signed-out harness never ran the turn: nothing for the bot to pick up
        if (
          terminal._tag !== "completed" &&
          active.accepted &&
          !(terminal._tag === "failed" && terminal.code === "auth")
        ) {
          const where =
            conversation0._tag === "Success" && conversation0.success.kind === "group"
              ? ` in the group ${quoted(conversation0.success.title)}`
              : conversation0._tag === "Success" && conversation0.success.kind === "direct"
                ? " in your DM with the owner"
                : ""
          state.carryNote = active.interruptRequested
            ? `[Note: your previous turn${where} was stopped by the owner before you finished; only what was already posted reached them.]`
            : `[Note: your previous turn${where} ended early (${terminal._tag === "failed" ? terminal.message : "cut off"}); only what was already posted reached the conversation — repeat anything important.]`
        }
        const failedToOpen = state.openFailures >= deps.options.maxOpenFailures && terminal._tag === "failed"
        // One runner per bot: it is the only writer of the bot's activity.
        yield* setActivity({
          botId,
          conversationId,
          state: failedToOpen ? "error" : "idle",
          label: failedToOpen ? terminal.message : undefined,
          since: now,
        })
        const conversation = yield* Effect.result(deps.store.get(conversationId))
        if (conversation._tag === "Success") yield* deps.store.publishSummary(conversationId)
        const bot = yield* orDie(deps.bots.get(botId))
        if (Option.isSome(bot)) {
          // The bot's report of finished background work (D5.7, or a harness-initiated turn: its own
          // background command finished) is news too.
          const reported =
            active.deliveries.some((d) => d.kind === "task-result") ||
            (active.nativeTurnId !== undefined && finalized.lastBotMessage !== undefined)
          // Only with something to read: a turn that ended quietly (NO_REPLY, a reaction, only steps)
          // is not news.
          const said = finalized.lastBotMessage?.trim()
          // a voice call's work is told on the call: no notification
          if (
            terminal._tag === "completed" &&
            said &&
            turn.voice !== true &&
            (turn.trigger === "user" || turn.trigger === "routine" || reported)
          ) {
            yield* deps.notifier.notify({
              kind: "finished",
              botId,
              conversationId,
              title: bot.value.name,
              body: previewOf(said),
            })
          } else if (terminal._tag === "failed" && terminal.code === "auth") {
            // once per account for a while: every Bot (and routine) on it fails the same way. The
            // account is shared by every profile, so the alert names no Bot or conversation and
            // reaches whichever profile is active.
            const account = `${bot.value.harness.kind}:${bot.value.harness.profileId ?? "default"}`
            const last = deps.signedOut?.get(account)
            if (last === undefined || now - last >= SIGNED_OUT_NOTIFY_MS) {
              deps.signedOut?.set(account, now)
              yield* deps.notifier.notify({
                kind: "error",
                title: `${HARNESS_NAMES[bot.value.harness.kind] ?? bot.value.harness.kind} is signed out`,
                body: `Bots on this account can't reply until you sign in again on the computer OpenBot runs on (Settings › Harnesses).`,
              })
            }
          } else if (terminal._tag === "failed") {
            yield* deps.notifier.notify({
              kind: "error",
              botId,
              conversationId,
              title: bot.value.name,
              body: previewOf(terminal.message),
            })
          }
        }
        // The runner is idle from here on: waiters and follow-ups see it ready for the next turn.
        yield* release(active)
        for (const delivery of active.deliveries) {
          if (requeued.includes(delivery.id)) continue
          yield* deps.outcomes.resolve(delivery.id, compact({ status, turn, lastBotMessage: finalized.lastBotMessage }))
        }
        if (Option.isSome(bot) && conversation._tag === "Success") {
          if (terminal._tag === "completed") {
            yield* followUpMentions(
              bot.value,
              conversation.success,
              active,
              finalized.botMessages.map((m) => ({ id: m.id, text: m.text, commentary: m.phase === "commentary" })),
            )
          } else {
            // Not finished: members it addressed with message_bot / handoff_task still get the message.
            yield* postNoted(bot.value, conversationId, active.noted, new Set())
          }
        }
      }).pipe(
        Effect.catchCause((cause) => Effect.logError(`BotRunner ${botId}: finishing a turn failed`, cause)),
        Effect.ensuring(release(active)),
      )

    /**
     * A turn that ended early WITHOUT the owner's Stop may not have read what was steered into it:
     * those deliveries run again as turns of their own, first in line (once each; never dropped).
     */
    const requeueSteered = (active: ActiveTurn) =>
      locked(
        Effect.gen(function* () {
          if (active.interruptRequested || state.closed) return [] as Array<string>
          const again = active.steered.filter((d) => !state.requeued.has(d.id))
          const items: Array<Queued> = []
          for (const delivery of again) {
            state.requeued.add(delivery.id)
            if (delivery.sourceEntryId !== undefined)
              state.shown.get(delivery.conversationId)?.delete(delivery.sourceEntryId)
            const turnId = yield* deps.ids.turnId
            items.push({ arrival: 0, delivery, turnId })
            yield* writeTurn({
              id: turnId,
              conversationId: delivery.conversationId,
              botId,
              status: "queued",
              trigger: triggerOf(delivery),
              ...(delivery.voice === true ? { voice: true } : {}),
              startedAt: yield* Clock.currentTimeMillis,
            })
          }
          if (state.requeued.size > 500) state.requeued.clear()
          state.queue = [...items, ...state.queue]
          if (items.length > 0) yield* Queue.offer(signal, undefined)
          return again.map((d) => d.id)
        }),
      )

    const release = (active: ActiveTurn) =>
      locked(
        Effect.gen(function* () {
          if (state.active === active) state.active = undefined
          yield* Deferred.succeed(active.done, undefined)
        }),
      )

    const runTurn = (active: ActiveTurn, work: Effect.Effect<TurnTerminal> = executeTurn(active)) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(restore(Effect.raceFirst(work, Deferred.await(active.cancel))))
          const terminal: TurnTerminal = Exit.isSuccess(exit)
            ? exit.value
            : Cause.hasInterruptsOnly(exit.cause)
              ? { _tag: "interrupted", reason: "stopped" }
              : {
                  _tag: "failed",
                  code: "internal",
                  message: "Internal error while running the turn.",
                  retryable: false,
                }
          if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
            yield* Effect.logError(`BotRunner ${botId}: turn crashed`, exit.cause)
          }
          yield* finishTurn(active, terminal)
        }),
      )

    /** A harness-initiated turn's conversation: the session's latest turn's (if it still exists), else the DM. */
    const harnessTurnConversation = (home: ConversationId) =>
      Effect.gen(function* () {
        const last = yield* lastConversationOf
        if (last === undefined || last === home) return home
        const exists = yield* Effect.result(deps.store.get(last))
        return exists._tag === "Success" ? last : home
      })

    /**
     * A turn the harness started on its own (D2.1: Claude Code answering the notification of its own
     * background command). While one of OpenBot's turns runs (or is being started), its output
     * belongs to that turn and its end ends nothing (joined). Otherwise it becomes a turn of its own,
     * trigger "system", in the conversation of the session's latest turn: one turn at a time like any
     * other (deliveries queue behind it or steer into it; Stop interrupts it), its reply posted there.
     * A turn that is already ending is waited for first. Runs on the session's event fiber, so the
     * turn is registered before its next event is handled.
     */
    const adoptHarnessTurn = (input: {
      readonly nativeTurnId: TurnId
      readonly ingest: SessionIngest
      readonly home: ConversationId
      readonly closed: Deferred.Deferred<string>
      readonly displayName: string
    }): Effect.Effect<HarnessTurnRoute | undefined> =>
      Effect.gen(function* () {
        for (;;) {
          const decision = yield* locked(
            Effect.gen(function* () {
              if (state.closed) return { _tag: "none" as const }
              const running = state.active
              if (running !== undefined) {
                const over =
                  running.ending || input.ingest.hasEnded(running.turnId) || (yield* Deferred.isDone(running.cancel))
                if (over) return { _tag: "wait" as const, done: running.done }
                const route: HarnessTurnRoute = {
                  turnId: running.turnId,
                  conversationId: running.conversationId,
                  joined: true,
                }
                return { _tag: "route" as const, route }
              }
              const now = yield* Clock.currentTimeMillis
              const conversationId = yield* harnessTurnConversation(input.home)
              const turnId = yield* deps.ids.turnId
              const active: ActiveTurn = {
                turnId,
                nativeTurnId: input.nativeTurnId,
                conversationId,
                deliveries: [],
                steered: [],
                chain: { rootId: turnId, hops: 0 },
                noted: [],
                cancel: yield* Deferred.make<TurnTerminal>(),
                done: yield* Deferred.make<void>(),
                turn: { id: turnId, conversationId, botId, status: "running", trigger: "system", startedAt: now },
                accepted: true,
                ending: false,
                interruptRequested: false,
              }
              state.active = active
              const terminal = yield* input.ingest.beginTurn(turnId, conversationId)
              yield* writeTurn(active.turn!)
              yield* setActivity({ botId, conversationId, state: "thinking", since: now })
              yield* Effect.forkIn(
                runTurn(active, awaitTerminal(terminal, input.closed, input.displayName)).pipe(
                  // The loop sleeps while a turn it did not take runs: wake it for what queued meanwhile.
                  Effect.ensuring(Queue.offer(signal, undefined)),
                ),
                deps.scope,
                { startImmediately: true },
              )
              const route: HarnessTurnRoute = { turnId, conversationId, joined: false }
              return { _tag: "route" as const, route }
            }),
          )
          if (decision._tag === "none") return undefined
          if (decision._tag === "route") return decision.route
          yield* Deferred.await(decision.done)
        }
      })

    // ------------------------------------------------------------------ the loop

    /**
     * The next turn: the oldest queued delivery, plus every queued BACKGROUND delivery of the same
     * conversation (batched with attribution lines). Other conversations wait their turn.
     */
    const takeNext = locked(
      Effect.gen(function* () {
        if (state.closed) return "exit" as const
        if (state.active !== undefined || state.control || deps.held()) return undefined
        const head = state.queue[0]
        if (head === undefined) return undefined
        const conversationId = head.delivery.conversationId
        const taken = state.queue.filter(
          (q) => q === head || (q.turnId === undefined && q.delivery.conversationId === conversationId),
        )
        state.queue = state.queue.filter((q) => !taken.includes(q))
        const active: ActiveTurn = {
          turnId: head.turnId ?? (yield* deps.ids.turnId),
          conversationId,
          deliveries: taken.sort((a, b) => a.arrival - b.arrival).map((q) => q.delivery),
          chain: head.delivery.causalChain,
          noted: [],
          steered: [],
          cancel: yield* Deferred.make<TurnTerminal>(),
          done: yield* Deferred.make<void>(),
          turn: undefined,
          accepted: false,
          ending: false,
          interruptRequested: false,
        }
        state.active = active
        return active
      }),
    )

    const tryEvict = locked(
      Effect.sync(() => {
        if (state.active !== undefined || state.control || state.queue.length > 0) return "busy" as const
        state.closed = true
        return "evict" as const
      }),
    )

    let self: Runner | undefined

    /** Going idle with a large context: compact now, while the harness's prompt cache is warm. */
    const compactBeforeSleep = Effect.gen(function* () {
      const open = state.session
      if (
        open === undefined ||
        deps.held() ||
        !open.driver.capabilities.compact ||
        (yield* Deferred.isDone(open.closed))
      )
        return
      if (!(yield* Effect.map(settings, (s) => s.compactIdleBots))) return
      const usage = yield* open.session.contextUsage
      if (usage === undefined || usage.usedTokens < deps.options.idleCompactMinTokens) return
      yield* Effect.logInfo("compacting an idle bot's context", { botId, usedTokens: usage.usedTokens })
      // Defined below; a delivery arriving meanwhile waits for it (or makes it a Conflict: skipped).
      const compacted = yield* Effect.result(Effect.suspend(() => compactSession))
      if (compacted._tag === "Failure")
        return yield* Effect.logWarning(`BotRunner ${botId}: idle compaction skipped`, compacted.failure)
      const bot = yield* orDie(deps.bots.get(botId))
      if (Option.isNone(bot)) return
      yield* Effect.ignore(
        deps.conversationService.appendEvent({
          conversationId: bot.value.directConversationId,
          event: { type: "session-changed", botId, action: "compacted" },
        }),
      )
    })

    const idleMs = Duration.toMillis(Duration.fromInputUnsafe(deps.options.idleTimeout))
    const compactMs = Math.min(Duration.toMillis(Duration.fromInputUnsafe(deps.options.idleCompactAfter)), idleMs)
    const waitForWork = (ms: number) => Effect.timeoutOption(Queue.take(signal), Duration.millis(ms))

    const loop: Effect.Effect<void> = Effect.gen(function* () {
      for (;;) {
        const next = yield* takeNext
        if (next === "exit") return
        if (next !== undefined) {
          yield* runTurn(next)
          continue
        }
        if (Option.isSome(yield* waitForWork(compactMs))) continue
        yield* compactBeforeSleep
        if (Option.isSome(yield* waitForWork(idleMs - compactMs))) continue
        const decision = yield* tryEvict
        if (decision === "busy") continue
        yield* dropSession("idle")
        if (self !== undefined) yield* deps.onEvicted(self)
        return
      }
    })

    const fiber = yield* Effect.forkIn(loop, deps.scope, { startImmediately: true })

    // ------------------------------------------------------------------ public API

    const deliver = (delivery: Delivery, capabilities: HarnessCapabilities) =>
      locked(
        Effect.gen(function* () {
          if (state.closed) return "closed" as const
          const arrival = ++state.arrivals
          const idle = state.active === undefined && !state.control && state.queue.length === 0 && !deps.held()
          // `background` only means "don't interrupt a busy bot": an idle recipient wakes immediately.
          if (!isWaking(delivery) && !idle) {
            state.queue.push({ arrival, delivery, turnId: undefined })
            yield* deps.outcomes.register(delivery.id)
            const receipt: DeliveryReceipt = { deliveryId: delivery.id, disposition: "batched" }
            return receipt
          }
          const active = state.active
          const open = state.session
          // Steer only into a running turn of the SAME conversation: a turn belongs to one conversation.
          if (
            active !== undefined &&
            active.conversationId === delivery.conversationId &&
            active.accepted &&
            !active.ending &&
            open !== undefined &&
            capabilities.steer &&
            isSteerable(delivery) &&
            delivery.attachmentIds.length === 0
          ) {
            // (files are copied into the workspace before a turn starts, so deliveries with files queue)
            const conversation = yield* Effect.result(deps.store.get(delivery.conversationId))
            const kind = conversation._tag === "Success" ? conversation.success.kind : "direct"
            const steered = yield* Effect.result(
              open.session.steer({
                turnId: active.nativeTurnId ?? active.turnId,
                conversationId: active.conversationId,
                text: `${(yield* renderDelivery(delivery, kind)).text}${delivery.kind === "user-message" ? STEER_NOTE : ""}`,
                attachments: [],
              }),
            )
            if (steered._tag === "Success") {
              active.deliveries.push(delivery)
              active.steered.push(delivery)
              if (kind === "group") markShown(delivery.conversationId, delivery.sourceEntryId)
              yield* deps.outcomes.register(delivery.id)
              yield* markUserMessages([delivery], "delivered")
              const receipt: DeliveryReceipt = {
                deliveryId: delivery.id,
                disposition: "steered",
                turnId: active.turnId,
              }
              return receipt
            }
            yield* Effect.logWarning(`BotRunner ${botId}: steer failed; queueing`, steered.failure)
          }
          const turnId = delivery.turnId ?? (yield* deps.ids.turnId)
          state.queue.push({ arrival, delivery, turnId })
          yield* deps.outcomes.register(delivery.id)
          if (!idle) {
            yield* writeTurn({
              id: turnId,
              conversationId: delivery.conversationId,
              botId,
              status: "queued",
              trigger: triggerOf(delivery),
              ...(delivery.voice === true ? { voice: true } : {}),
              ...(delivery.kind === "user-message" && delivery.sourceEntryId !== undefined
                ? { inputEntryId: delivery.sourceEntryId }
                : {}),
              startedAt: yield* Clock.currentTimeMillis,
            })
            yield* markUserMessages([delivery], "queued")
          }
          yield* Queue.offer(signal, undefined)
          const receipt: DeliveryReceipt = { deliveryId: delivery.id, disposition: idle ? "started" : "queued", turnId }
          return receipt
        }),
      )

    /** Marks dropped queued work as interrupted (waking) or dropped (background). */
    const abandon = (dropped: ReadonlyArray<Queued>, reason: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const affected: Array<Turn> = []
        for (const work of dropped) {
          if (work.turnId === undefined) {
            yield* deps.outcomes.resolve(work.delivery.id, { status: "dropped" })
            continue
          }
          const stored = yield* orDie(deps.turns.get(work.turnId))
          const turn: Turn = compact({
            ...(Option.isSome(stored)
              ? stored.value
              : {
                  id: work.turnId,
                  conversationId: work.delivery.conversationId,
                  botId,
                  trigger: triggerOf(work.delivery),
                  ...(work.delivery.voice === true ? { voice: true } : {}),
                  startedAt: now,
                }),
            status: "interrupted" as const,
            endedAt: now,
            stopReason: reason,
          })
          yield* writeTurn(turn)
          affected.push(turn)
          yield* deps.outcomes.resolve(work.delivery.id, { status: "interrupted", turn })
        }
        return affected
      })

    /** Interrupts `hit` (the running turn): through the harness once accepted, else directly. */
    const interruptActive = (hit: ActiveTurn, open: OpenSession | undefined) =>
      open !== undefined
        ? requestHarnessInterrupt(hit, open)
        : Effect.asVoid(Deferred.succeed(hit.cancel, { _tag: "interrupted", reason: "interrupted before start" }))

    const interruptTurn = (turnId: TurnId) =>
      Effect.gen(function* () {
        const decision = yield* locked(
          Effect.sync(() => {
            const active = state.active
            const hit = active !== undefined && !active.ending && active.turnId === turnId ? active : undefined
            if (hit !== undefined) hit.interruptRequested = true
            const removed = state.queue.filter((q) => q.turnId === turnId)
            if (removed.length > 0) state.queue = state.queue.filter((q) => q.turnId !== turnId)
            return { hit, open: hit?.accepted ? state.session : undefined, removed }
          }),
        )
        const affected: Array<Turn> = []
        if (decision.hit !== undefined) {
          if (decision.hit.turn !== undefined) affected.push(decision.hit.turn)
          yield* interruptActive(decision.hit, decision.open)
        }
        affected.push(...(yield* abandon(decision.removed, "interrupted")))
        return affected
      })

    const interruptConversation = (conversationId: ConversationId) =>
      Effect.gen(function* () {
        const decision = yield* locked(
          Effect.sync(() => {
            const active = state.active
            const hit =
              active !== undefined && !active.ending && active.conversationId === conversationId ? active : undefined
            if (hit !== undefined) {
              hit.interruptRequested = true
              return { hit, open: hit.accepted ? state.session : undefined, removed: [] as Array<Queued> }
            }
            // Busy elsewhere (or idle): Stop here cancels this conversation's queued turns.
            const removed = state.queue.filter(
              (q) => q.turnId !== undefined && q.delivery.conversationId === conversationId,
            )
            state.queue = state.queue.filter((q) => !removed.includes(q))
            return { hit: undefined, open: undefined, removed }
          }),
        )
        const affected: Array<Turn> = []
        if (decision.hit !== undefined) {
          if (decision.hit.turn !== undefined) affected.push(decision.hit.turn)
          yield* interruptActive(decision.hit, decision.open)
        }
        affected.push(...(yield* abandon(decision.removed, "interrupted")))
        return affected
      })

    const cancelConversation = (conversationId: ConversationId) =>
      Effect.gen(function* () {
        const decision = yield* locked(
          Effect.sync(() => {
            const active = state.active
            const hit =
              active !== undefined && !active.ending && active.conversationId === conversationId ? active : undefined
            if (hit !== undefined) hit.interruptRequested = true
            const removed = state.queue.filter((q) => q.delivery.conversationId === conversationId)
            state.queue = state.queue.filter((q) => !removed.includes(q))
            state.seen.delete(conversationId)
            const running = active !== undefined && active.conversationId === conversationId ? active : undefined
            return { hit, open: hit?.accepted ? state.session : undefined, removed, running }
          }),
        )
        if (decision.hit !== undefined) yield* interruptActive(decision.hit, decision.open)
        yield* abandon(decision.removed, "conversation deleted")
        if (decision.running !== undefined) {
          yield* Deferred.await(decision.running.done).pipe(
            Effect.timeoutOption(
              Duration.sum(Duration.fromInputUnsafe(deps.options.interruptGrace), Duration.seconds(1)),
            ),
          )
        }
        // Forget the deleted conversation's cursor in the stored record too.
        const record = yield* sessionRecord
        if (Option.isSome(record) && record.value.seen?.[conversationId] !== undefined) {
          const { [conversationId]: _drop, ...rest } = record.value.seen
          yield* orDie(
            deps.bots.setSession(
              compact({
                ...record.value,
                seen: Object.keys(rest).length === 0 ? undefined : rest,
                updatedAt: yield* Clock.currentTimeMillis,
              }),
            ),
          )
        }
      })

    const stop = (reason: string) =>
      Effect.gen(function* () {
        const taken = yield* locked(
          Effect.sync(() => {
            state.closed = true
            const active = state.active
            if (active !== undefined) active.interruptRequested = true
            const queued = state.queue.splice(0)
            return { active, open: active?.accepted ? state.session : undefined, queued }
          }),
        )
        if (taken.open !== undefined) {
          yield* taken.open.session.interrupt.pipe(
            Effect.timeoutOption(Duration.seconds(5)),
            Effect.catchCause(() => Effect.void),
          )
        }
        yield* Fiber.interrupt(fiber)
        yield* abandon(taken.queued, reason)
        yield* dropSession(reason)
        if (self !== undefined) yield* deps.onEvicted(self)
      })

    const isWorking = locked(Effect.sync(() => state.active !== undefined || state.control))

    const takeOver = Effect.gen(function* () {
      const taken = yield* locked(
        Effect.sync(() => {
          state.closed = true
          const active = state.active
          const queued = state.queue.splice(0)
          // A turn its harness has not accepted yet is still queued work: it runs again under its id.
          const unaccepted =
            active !== undefined && !active.accepted
              ? active.deliveries.map((delivery, i) => (i === 0 ? { ...delivery, turnId: active.turnId } : delivery))
              : []
          const cutOff =
            active !== undefined && active.accepted && !active.ending
              ? [{ botId, conversationId: active.conversationId, turnId: active.turnId }]
              : []
          return { queued, unaccepted, cutOff }
        }),
      )
      // Nobody waits on these any more in this process; the next boot delivers them afresh.
      for (const work of taken.queued) yield* deps.outcomes.resolve(work.delivery.id, { status: "dropped" })
      const carried: Carryover = {
        deliveries: [
          ...taken.unaccepted,
          ...taken.queued.map((work) =>
            work.turnId === undefined ? work.delivery : { ...work.delivery, turnId: work.turnId },
          ),
        ],
        cutOff: taken.cutOff,
      }
      return carried
    })

    const noteAddress = (input: NotedAddress & { readonly conversationId: ConversationId }) =>
      locked(
        Effect.sync(() => {
          const active = state.active
          if (active === undefined || active.ending || active.conversationId !== input.conversationId) return false
          if (!active.noted.some((n) => n.recipientBotId === input.recipientBotId)) {
            active.noted.push({
              recipientBotId: input.recipientBotId,
              text: input.text,
              causalChain: input.causalChain,
            })
          }
          return true
        }),
      )

    const busyConflict = () =>
      Effect.gen(function* () {
        const where = state.active?.conversationId ?? state.queue[0]?.delivery.conversationId
        const conversation = where === undefined ? undefined : yield* Effect.option(deps.store.get(where))
        const title =
          conversation !== undefined && Option.isSome(conversation) && conversation.value.kind === "group"
            ? ` in "${conversation.value.title}"`
            : ""
        return new Conflict({ reason: `The bot is working${title}. Stop it first.` })
      })

    const resetSession = (afterDrop: Effect.Effect<void>) =>
      locked(
        Effect.gen(function* () {
          if (state.active !== undefined || state.control || state.queue.length > 0) return yield* yield* busyConflict()
          forgetCursors()
          yield* dropSession("new session")
          yield* afterDrop
        }),
      )

    const compactSession = Effect.gen(function* () {
      yield* locked(
        Effect.gen(function* () {
          if (state.active !== undefined || state.control || state.queue.length > 0) return yield* yield* busyConflict()
          state.control = true
        }),
      )
      return yield* Effect.gen(function* () {
        const bot = yield* Effect.flatMap(orDie(deps.bots.get(botId)), (b) =>
          Option.isSome(b) ? Effect.succeed(b.value) : Effect.fail(new NotFound({ entity: "bot", id: botId })),
        )
        const open = yield* ensureSession(bot, bot.directConversationId).pipe(
          Effect.mapError((e) => new HarnessUnavailable({ harness: bot.harness.kind, message: e.message })),
        )
        yield* open.session.compact.pipe(
          Effect.mapError((e) => new HarnessUnavailable({ harness: bot.harness.kind, message: e.message })),
        )
        const usage: ContextUsage | undefined = yield* open.session.contextUsage
        if (usage !== undefined) {
          yield* updateSessionRow(deps.store, bot.directConversationId, botId, (_row, now) => ({
            botId,
            active: true,
            contextUsage: usage,
            updatedAt: now,
          }))
        }
      }).pipe(
        Effect.ensuring(
          locked(
            Effect.gen(function* () {
              state.control = false
              if (state.queue.length > 0) yield* Queue.offer(signal, undefined)
            }),
          ),
        ),
      )
    })

    self = {
      botId,
      deliver,
      interruptTurn,
      interruptConversation,
      cancelConversation,
      stop,
      isWorking,
      takeOver,
      resetSession,
      compact: compactSession,
      noteAddress,
      activeTurn: Effect.sync(() => Option.fromNullishOr(state.active?.turn)),
      currentChain: Effect.sync(() => Option.fromNullishOr(state.active?.chain)),
      approve,
    }
    return self
  })

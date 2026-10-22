/**
 * Domain service interface shapes (architecture §4.3) — the cross-WP contract for wave 1.
 *
 * These are `Context.Service` tags with method signatures only. Implementations:
 * - `services/conversation` (W1.2): LiveHub, BotService, ConversationService, Orchestrator,
 *   Messaging, InstructionRenderer (+ internal BotRunner, TurnIngest, GroupRouter).
 * - `services/automation` (W1.3): ApprovalService, RoutineScheduler, MemoryService, SkillService,
 *   SettingsService, UsageService.
 *
 * Consumers: the RPC handlers in apps/server (§4.1.1, one method per RPC) and the gateway toolkits
 * (§4.6, one method per bot tool).
 *
 * Error conventions:
 * - Error channels list only contract errors (`NotFound`, `InvalidInput`, `Conflict`,
 *   `HarnessUnavailable`, `RequestNotPending`) that the RPC/tool edge maps 1:1.
 * - Repository failures (`RepoError`) are defect-like: services `Effect.orDie` them; the RPC edge logs
 *   defects and returns `Internal`; the gateway returns `ERROR: Internal error`.
 * - Tool-facing methods (`Actor` = bot) that are refused by policy (bot messaging disabled, hop limit,
 *   not the owner of a routine) fail with `InvalidInput` whose `message` is model-readable.
 *
 * Layer dependency order (a service may only depend on services ABOVE it, so layers never cycle):
 *   0. ports: repositories/stores, BootRecovery, IdGen, DataDir, InternalAddress, HarnessRegistry,
 *      NodeDirectory, NodeAdmin, PlacementService, McpBindingIssuer, ComputerPort.
 *      Their implementations (persistence, brain-nodes, gateway issuer, harness drivers) must not
 *      depend on any service below. brain-nodes serves `node.requestApproval` (remote nodes and the
 *      local node's in-process BrainLink) from a SEPARATE top-level layer that needs
 *      `ApprovalService.evaluateNode`; the node registry itself stays at layer 0.
 *   1. LiveHub                                    (snapshots read repositories + NodeDirectory;
 *                                                  forwards `NodeDirectory.changes` to the roster)
 *   2. SettingsService, UsageService, Notifier (LiveHub-backed), ConversationService, AttachmentService,
 *      SearchService                          (repositories only)
 *   3. MemoryService, SkillService                (events via ConversationService)
 *   4. ApprovalService                            (never calls Orchestrator: emits `asyncAnswers`;
 *                                                  optional ComputerPort for hand-offs, D1.7)
 *   5. InstructionRenderer                        (MemoryService, BotRepo, ConversationRepo, SettingsService)
 *   5b. BackgroundTasks                           (never calls Orchestrator: emits `results`)
 *   6. Orchestrator                               (drains `ApprovalService.asyncAnswers`; group
 *                                                  routing of bot replies is internal)
 *   7. Messaging, RoutineScheduler                (call Orchestrator; resolve bots via BotRepo)
 *   8. BotService                                 (Orchestrator.stopBot/newSession/compact,
 *                                                  RoutineScheduler.delete, ApprovalService.cancelPending)
 *
 * One mind per bot (docs/decisions.md D5.0): every bot has ONE native harness session shared by all
 * of its conversations, driven by one `BotRunner`. Each turn belongs to exactly one conversation
 * (its delivery's); replies, tool calls, cards and activity land there.
 */
import type {
  ApprovalRule,
  ApprovalRuleId,
  ApprovalRuleInput,
  Attachment,
  AttachmentId,
  Author,
  Bot,
  BotActivity,
  BotContext,
  BotAutonomy,
  BotCreateInput,
  BotId,
  BotMemory,
  BotPatch,
  BotUsage,
  Conflict,
  Conversation,
  ConversationId,
  ConversationSummary,
  EntryId,
  ExchangePage,
  HarnessApprovalRequest,
  HarnessKindName,
  HarnessRequest,
  HarnessRequestResolution,
  HarnessUnavailable,
  InvalidInput,
  KnownConversationChange,
  KnownConversationEvent,
  KnownConversationStreamItem,
  KnownRosterChange,
  KnownRosterStreamItem,
  KnownTranscriptEntry,
  MemoryFact,
  MemoryFactId,
  MemoryFactInput,
  Millis,
  NodeId,
  NoticeLevel,
  NotFound,
  Question,
  RequestId,
  RequestNotPending,
  Routine,
  RoutineId,
  RoutineRun,
  RoutineRunId,
  RoutineSpec,
  RuntimeRequest,
  RuntimeResponseInput,
  SearchKind,
  SearchPage,
  SearchPositions,
  SearchSender,
  SearchSort,
  Section,
  SectionId,
  SidebarItemRef,
  SidebarPlace,
  SendInput,
  SendLookup,
  SendMode,
  SendResult,
  Settings,
  SettingsPatch,
  Skill,
  SkillInput,
  SkillName,
  SkillPreview,
  SkillSearchResult,
  StreamCursor,
  Task,
  TaskDetail,
  TaskId,
  TaskStoppedBy,
  TranscriptEntry,
  TranscriptPage,
  TranscriptWindow,
  Unavailable,
  Turn,
  TurnId,
  Usage,
} from "@openbot/contracts"
import type { Invocation, NodeApprovalRequest, NodeApprovalResponse } from "@openbot/node-protocol"
import { Context, Effect, Layer, Option, Stream } from "effect"
import type { RenderedInstructions } from "./Harness.ts"
import type { McpClaims } from "./Mcp.ts"
import type { BootRecoveryReport } from "./Persistence.ts"
import type { PlacementSummary } from "./Placement.ts"

// ============================================================================ shared types

/**
 * The context of a gateway tool call: the verified token claims plus the harness tool-call id
 * (idempotency key, D3.3) when the harness exposes one.
 *
 * `claims.conversationId` / `claims.sessionKey` are resolved AT CALL TIME by the gateway: the
 * conversation of the bot's current turn (`Orchestrator.activeTurn(botId)`), falling back to the
 * bot's DM (the token's home conversation) when no turn is running (D5.0).
 */
export interface ToolContext {
  readonly claims: McpClaims
  /** Harness tool-call id (`_meta` / MCP request id), used as an idempotency key. */
  readonly callId?: string | undefined
  /** The bot's turn the call was made in (when one was running at call time). */
  readonly turnId?: TurnId | undefined
  /**
   * The call comes from one of the bot's background tasks (its own session, D5.7): never set
   * together with `turnId`; `claims.conversationId` is the conversation the task was started from.
   */
  readonly taskId?: TaskId | undefined
}

/** Who performs a mutation: the owner through the UI/RPC, or a bot through a gateway tool. */
export type Actor =
  | { readonly kind: "user" }
  | { readonly kind: "bot"; readonly tool: ToolContext }

export const userActor: Actor = { kind: "user" }
export const botActor = (tool: ToolContext): Actor => ({ kind: "bot", tool })

/**
 * Delivery kinds (§4.3.1). `task-result`: a background task ended (D5.7) — its result (or why it
 * stopped) comes back to the bot in the task's origin conversation; never steered, always its own turn.
 * `introduction`: the hidden first turn of a Bot the owner just created (it greets them and asks what
 * they need, like Grok's "New Bot"); nothing of it is shown but the Bot's own reply and question card.
 * `system-resume`: after a restart cut a bot off mid-turn, it continues there (`Orchestrator.resume`).
 */
export type DeliveryKind = "user-message" | "bot-message" | "routine" | "system-resume" | "task-result" | "introduction"
export type DeliveryUrgency = "urgent" | "background"
/** `messages.send` mode (`contracts.SendMode`): auto = steer when supported and busy, else queue. */
export type DeliveryMode = SendMode

/** Causal chain for hop limiting (D5.2): root delivery id + number of bot hops so far. */
export interface CausalChain {
  readonly rootId: string
  readonly hops: number
}

/** Hop limit per causal chain (D5.2). */
export const MAX_BOT_HOPS = 8

/**
 * A unit of input for one bot in one conversation (§4.3.1). Producers: `Orchestrator.send` (user),
 * `Messaging` (bot→bot), `RoutineScheduler`, `ApprovalService` (answered async questions).
 * Consumer: the bot's single `BotRunner` (FIFO across conversations; the turn it starts belongs to
 * `conversationId`).
 */
export interface Delivery {
  readonly id: string
  readonly conversationId: ConversationId
  readonly botId: BotId
  readonly kind: DeliveryKind
  /** Text as the bot should see it (attribution lines are added by the runner when batching). */
  readonly text: string
  readonly attachmentIds: ReadonlyArray<AttachmentId>
  /** The transcript entry this delivery came from (user/bot message, routine event). */
  readonly sourceEntryId?: EntryId | undefined
  /** Sender bot for bot-message deliveries (attribution `[@Name]: …`). */
  readonly fromBotId?: BotId | undefined
  readonly causalChain: CausalChain
  readonly urgency: DeliveryUrgency
  readonly mode: DeliveryMode
  /** Set for routine deliveries so the run can be closed when the turn ends. */
  readonly routineRunId?: RoutineRunId | undefined
  /** Set for `task-result` deliveries. */
  readonly taskId?: TaskId | undefined
  /** Carried over a restart: the turn it was queued as keeps its id. */
  readonly turnId?: TurnId | undefined
  /** Handed over on a voice call: its turn is marked `voice` (out of the chat, no notification). */
  readonly voice?: boolean | undefined
}

/**
 * Work a stopping brain hands to the next boot (deploys, D7.4): deliveries that were queued but never
 * started, and the turns it cut off mid-reply. Saved by `Orchestrator.handOff`, replayed by `resume`.
 */
export interface Carryover {
  readonly deliveries: ReadonlyArray<Delivery>
  readonly cutOff: ReadonlyArray<{ readonly botId: BotId; readonly conversationId: ConversationId; readonly turnId: TurnId }>
}

/** `Orchestrator.deliver` input; `id` is allocated when absent, `mode` defaults to "auto". */
export type DeliveryInput =
  & Omit<Delivery, "id" | "mode" | "attachmentIds" | "causalChain">
  & {
    readonly id?: string | undefined
    readonly mode?: DeliveryMode | undefined
    readonly attachmentIds?: ReadonlyArray<AttachmentId> | undefined
    /** Absent = a new chain rooted at this delivery with 0 hops. */
    readonly causalChain?: CausalChain | undefined
  }

export interface DeliveryReceipt {
  readonly deliveryId: string
  /** started a turn, queued behind the active one, steered into it, or batched into a pending turn. */
  readonly disposition: "started" | "queued" | "steered" | "batched"
  /** Known when started/steered; queued deliveries get one when their turn starts. */
  readonly turnId?: TurnId | undefined
}

export interface DeliveryOutcome {
  readonly deliveryId: string
  readonly status: "completed" | "failed" | "interrupted" | "dropped"
  readonly turn?: Turn | undefined
  /** Text of the last bot message of the turn (routine run summaries). */
  readonly lastBotMessage?: string | undefined
}

/** A transcript entry to append; id/revision/timestamps are allocated by `ConversationService`. */
export type EntryDraft = KnownTranscriptEntry extends infer E
  ? E extends KnownTranscriptEntry
    ? Omit<E, "id" | "revision" | "createdAt" | "updatedAt"> & { readonly id?: EntryId | undefined }
  : never
  : never

/** Result of a non-blocking tool request (D3.3): the answer arrives later as a new message. */
export interface PendingRequestReceipt {
  readonly status: "pending"
  readonly requestId: RequestId
}

// ============================================================================ LiveHub (§4.3.6)

export class LiveHub extends Context.Service<LiveHub, {
  /**
   * Appends a change to the conversation replica (`sequence++`, ReplicaLog, ring buffer of 256) and
   * publishes it. Call AFTER the change is committed to its repository.
   */
  readonly publishConversation: (
    conversationId: ConversationId,
    change: KnownConversationChange,
  ) => Effect.Effect<StreamCursor>
  /** Same for the roster replica. */
  readonly publishRoster: (change: KnownRosterChange) => Effect.Effect<StreamCursor>
  /**
   * `conversations.subscribe`: matching epoch and gap ≤ 256 → replay, else snapshot (tail of 100
   * entries + pending requests + recent turns); then `synchronized`; then live changes.
   */
  readonly subscribeConversation: (input: {
    readonly conversationId: ConversationId
    readonly after?: StreamCursor | undefined
    readonly tailLimit?: number | undefined
  }) => Stream.Stream<KnownConversationStreamItem, NotFound>
  /** `roster.subscribe`: same resume rules for the roster replica. */
  readonly subscribeRoster: (input: { readonly after?: StreamCursor | undefined }) => Stream.Stream<KnownRosterStreamItem>
  /** Starts a new epoch for a conversation (new session / rebuild); subscribers get `reset` then a snapshot. */
  readonly resetConversation: (
    conversationId: ConversationId,
    reason: "new-session" | "rollback" | "rebuild",
  ) => Effect.Effect<string>
  /** Current activity per bot (roster snapshot) — kept in memory, not persisted. */
  readonly activities: Effect.Effect<ReadonlyArray<BotActivity>>
  /** Updates a bot's activity and publishes `activity.updated`. */
  readonly setActivity: (activity: BotActivity) => Effect.Effect<void>
}>()("openbot/core/LiveHub") {}

// ============================================================================ BotService

export class BotService extends Context.Service<BotService, {
  /**
   * `bots.create`: validates the harness kind is registered and the host node exists, allocates the
   * avatar default (`contracts.defaultBotAvatar(id)`, FNV-1a), creates the direct conversation,
   * appends a `joined` event, publishes. Idempotent on `clientNonce`. Without `input.autonomy` the
   * bot gets Settings' `defaultAutonomy`; `options.autonomyCeiling` (a bot creating a bot:
   * `create_bot`) caps the result at the creator's autonomy. `options.introduce` (the owner created it)
   * starts its hidden `introduction` turn in its DM; a bot-created Bot is briefed by its creator instead.
   */
  readonly create: (
    input: BotCreateInput,
    options?: { readonly autonomyCeiling?: BotAutonomy | undefined; readonly introduce?: boolean | undefined },
  ) => Effect.Effect<Bot, NotFound | InvalidInput | Conflict | HarnessUnavailable>
  /**
   * `bots.update`. Changing `harness.kind` or `hostNodeId` stops the bot's runners and drops native
   * sessions (a different driver/placement cannot resume them).
   */
  readonly update: (botId: BotId, patch: BotPatch) => Effect.Effect<Bot, NotFound | InvalidInput | Conflict>
  /** `bots.delete`: stops runners, revokes MCP tokens, deletes routines, memory and conversations it solely owns. */
  readonly delete: (botId: BotId) => Effect.Effect<void, NotFound>
  /** `bots.get`. */
  readonly get: (botId: BotId) => Effect.Effect<Bot, NotFound>
  /** `list_bots` tool and roster snapshot; ordered by `createdAt`. */
  readonly list: Effect.Effect<ReadonlyArray<Bot>>
  /** Resolves a bot by id, exact name or `@name` (case-insensitive) — used by bot tools (`to`). */
  readonly resolve: (ref: string) => Effect.Effect<Bot, NotFound>
  /**
   * `bots.readContext`: instructions as rendered for the harness (with a placement PREVIEW from
   * `planPlacement` + `describePlacement` + `workspacePathFor`; nothing is opened) + memory.
   */
  readonly readContext: (botId: BotId) => Effect.Effect<BotContext, NotFound>
  /**
   * `bots.newSession`: drops the bot's single native session (its DM gets a new replica epoch and a
   * `session-changed` event). `Conflict` while the bot has a running or queued turn.
   */
  readonly newSession: (botId: BotId) => Effect.Effect<void, NotFound | Conflict>
  /**
   * `bots.compact`: compacts the bot's single session. `HarnessUnavailable` when the harness lacks
   * `capabilities.compact`; `Conflict` while the bot has a running or queued turn.
   */
  readonly compact: (botId: BotId) => Effect.Effect<void, NotFound | Conflict | HarnessUnavailable>

  /** `sections.list`. */
  readonly listSections: Effect.Effect<ReadonlyArray<Section>>
  /** `sections.create`: appended at the end. */
  readonly createSection: (name: string) => Effect.Effect<Section, InvalidInput>
  /** `sections.rename`. */
  readonly renameSection: (sectionId: SectionId, name: string) => Effect.Effect<Section, NotFound | InvalidInput>
  /** `sections.delete`: bots in it become Unassigned. */
  readonly deleteSection: (sectionId: SectionId) => Effect.Effect<void, NotFound>
  /**
   * `sidebar.arrange`: `items` (Bots and group chats) is the new order at `place`; each moves there
   * (pinned, a section, Unassigned or Group chats) and keeps its position.
   */
  readonly arrangeSidebar: (input: { readonly place: SidebarPlace; readonly items: ReadonlyArray<SidebarItemRef> }) => Effect.Effect<
    void,
    NotFound | InvalidInput
  >
  /** `sections.reorder`: full ordered list of section ids. */
  readonly reorderSections: (
    sectionIds: ReadonlyArray<SectionId>,
  ) => Effect.Effect<ReadonlyArray<Section>, NotFound | InvalidInput | Conflict>
}>()("openbot/core/BotService") {}

// ============================================================================ ConversationService

export class ConversationService extends Context.Service<ConversationService, {
  readonly get: (conversationId: ConversationId) => Effect.Effect<Conversation, NotFound>
  /** Sidebar rows (roster snapshot). */
  readonly summaries: Effect.Effect<ReadonlyArray<ConversationSummary>>
  readonly summary: (conversationId: ConversationId) => Effect.Effect<ConversationSummary, NotFound>
  /** `conversations.history`. */
  readonly history: (input: {
    readonly conversationId: ConversationId
    readonly beforeCursor: string
    readonly limit: number
  }) => Effect.Effect<TranscriptPage, NotFound | InvalidInput>
  /**
   * `conversations.exchange`: the messages two Bots sent each other, from both direct
   * conversations: the newest `limit`, the `limit` before / after a cursor, or a page around `at`.
   */
  readonly exchange: (input: {
    readonly botId: BotId
    readonly peerBotId: BotId
    readonly at?: Millis | undefined
    readonly before?: string | undefined
    readonly after?: string | undefined
    readonly limit: number
  }) => Effect.Effect<ExchangePage, NotFound | InvalidInput>
  /**
   * `conversations.around`: a window of the chat around `entryId` (up to half before it, the entry,
   * the rest after), or the page before / after a window's cursor, or the newest entries; voice
   * calls' work left out. With the turns and card requests of its entries.
   */
  readonly around: (input: {
    readonly conversationId: ConversationId
    readonly entryId?: EntryId | undefined
    readonly beforeCursor?: string | undefined
    readonly afterCursor?: string | undefined
    readonly limit: number
  }) => Effect.Effect<TranscriptWindow, NotFound | InvalidInput>
  /** `conversations.createGroup`: 2–6 bots; idempotent on `clientNonce` when given. */
  readonly createGroup: (input: {
    readonly title: string
    readonly memberBotIds: ReadonlyArray<BotId>
    readonly leadBotId?: BotId | undefined
    readonly clientNonce?: string | undefined
  }) => Effect.Effect<Conversation, NotFound | InvalidInput | Conflict>
  /** `conversations.setMembers` (groups only); emits member-added/removed events. */
  readonly setMembers: (input: {
    readonly conversationId: ConversationId
    readonly memberBotIds: ReadonlyArray<BotId>
    readonly leadBotId?: BotId | null | undefined
  }) => Effect.Effect<Conversation, NotFound | InvalidInput | Conflict>
  /** `conversations.rename`. */
  readonly rename: (conversationId: ConversationId, title: string) => Effect.Effect<Conversation, NotFound | InvalidInput>
  /** `conversations.markRead`: `unread: true` marks unread from `at` (default: last entry). */
  readonly markRead: (input: {
    readonly conversationId: ConversationId
    readonly unread?: boolean | undefined
    readonly at?: Millis | undefined
  }) => Effect.Effect<void, NotFound>
  /** `conversations.setHidden`. */
  readonly setHidden: (conversationId: ConversationId, hidden: boolean) => Effect.Effect<void, NotFound>
  /** A group chat's sidebar section (`null`: Group chats) and place (`null`: by recent activity). */
  readonly place: (conversationId: ConversationId, input: {
    readonly sectionId?: SectionId | null | undefined
    readonly sidebarOrder?: number | null | undefined
  }) => Effect.Effect<void, NotFound | InvalidInput>

  // ---- transcript writes shared by every service (persist, then publish `entry.upserted`)
  // Conversation.sessions (context ring) is maintained by W1.2 internals (TurnIngest on
  // `ContextUsage` events, throttled; newSession → `active: false`) via `conversation.updated`.
  /** Appends a new entry (revision 0, timestamps from `Clock`), bumps `lastActivityAt`/unread/preview. */
  readonly appendEntry: (draft: EntryDraft) => Effect.Effect<TranscriptEntry, NotFound>
  /** Read-modify-write of an existing entry with `revision + 1` and a new `updatedAt`. */
  readonly updateEntry: (
    entryId: EntryId,
    update: (entry: KnownTranscriptEntry) => KnownTranscriptEntry,
  ) => Effect.Effect<TranscriptEntry, NotFound>
  /** Removes an entry (a silent `NO_REPLY` bot message); publishes `entry.removed`. Missing → no-op. */
  readonly removeEntry: (entryId: EntryId) => Effect.Effect<void>
  /** Centered event line (author system unless given). */
  readonly appendEvent: (input: {
    readonly conversationId: ConversationId
    readonly event: KnownConversationEvent
    readonly author?: Author | undefined
    readonly turnId?: TurnId | undefined
  }) => Effect.Effect<TranscriptEntry, NotFound>
  readonly appendNotice: (input: {
    readonly conversationId: ConversationId
    readonly level: NoticeLevel
    readonly code: string
    readonly text: string
    readonly turnId?: TurnId | undefined
  }) => Effect.Effect<TranscriptEntry, NotFound>
  /** Persists a RuntimeRequest and publishes `request.upserted` in its conversation. */
  readonly upsertRequest: (request: RuntimeRequest) => Effect.Effect<void, NotFound>
  /**
   * Deletes a GROUP conversation's records: entries, turns, requests, replica log and the record
   * itself (member bots stay); publishes roster `conversation.removed`. `InvalidInput` for direct /
   * routine-run conversations (they go with their bot). Storage only: `Orchestrator.deleteConversation`
   * stops the work first — call that.
   */
  readonly removeGroup: (conversationId: ConversationId) => Effect.Effect<void, NotFound | InvalidInput>
  /** Creates a `routine-run` conversation for a run with `output = own-conversation`. */
  readonly createRoutineRunConversation: (input: {
    readonly botId: BotId
    readonly routineId: RoutineId
    readonly runId: RoutineRunId
    readonly title: string
    readonly triggerSummary: string
  }) => Effect.Effect<Conversation, NotFound>
}>()("openbot/core/ConversationService") {}

// ============================================================================ Orchestrator

export class Orchestrator extends Context.Service<Orchestrator, {
  /**
   * `messages.send`: persist the user entry (idempotent by clientNonce → `duplicate`), route (groups:
   * mentions > `@everyone` > reply-to author > lead bot), deliver one Delivery per target bot.
   */
  readonly send: (input: SendInput) => Effect.Effect<SendResult, NotFound | InvalidInput | HarnessUnavailable>
  /** `messages.lookupSend`. */
  readonly lookupSend: (input: {
    readonly conversationId: ConversationId
    readonly clientNonce: string
  }) => Effect.Effect<SendLookup, NotFound>
  /** `messages.react`: toggles the owner's reaction. */
  readonly react: (input: {
    readonly conversationId: ConversationId
    readonly entryId: EntryId
    readonly emoji: string
  }) => Effect.Effect<void, NotFound>
  /**
   * `turns.interrupt`: interrupts `turnId` (running or queued), or — without one — for every member
   * bot: its running turn when that turn belongs to this conversation, otherwise its queued turns of
   * this conversation (a bot busy in ANOTHER conversation keeps working there). Streaming bot text
   * becomes `aborted`. Returns the affected turns.
   */
  readonly interrupt: (input: {
    readonly conversationId: ConversationId
    readonly turnId?: TurnId | undefined
  }) => Effect.Effect<ReadonlyArray<Turn>, NotFound>
  /**
   * `turns.retry`: delivers the messages a failed turn was answering (`sourceEntryIds`, else its
   * input message, else the conversation's latest message from someone else) to that turn's bot
   * again. Nothing is posted; other bots are not woken.
   */
  readonly retry: (input: {
    readonly conversationId: ConversationId
    readonly turnId: TurnId
  }) => Effect.Effect<void, NotFound | InvalidInput | HarnessUnavailable>
  /**
   * Deploys: stops starting turns (deliveries are held, their turns `queued`) and tells
   * `BackgroundTasks` to hold too; waits until no turn or task runs or `graceMs` passed; then
   * `handOff`. The brain exits afterwards.
   */
  readonly drain: (input: { readonly graceMs: number }) => Effect.Effect<void>
  /** True from `drain` on (the web shows that OpenBot is updating). */
  readonly draining: Effect.Effect<boolean>
  /**
   * Stops every runner and saves what it held for the next boot (`CarryoverStore`): queued
   * deliveries (a turn not yet accepted by its harness counts as queued) and the turns cut off.
   * Shutdown runs it, so a plain restart loses no queued message either.
   */
  readonly handOff: Effect.Effect<void>
  /**
   * After boot, once the routes serve: replays the carried deliveries (queued turns keep their ids),
   * then has every cut-off bot continue where it was (`system-resume`): the carried ones and, after a
   * crash, the turns boot recovery found running. A crash's queued owner messages are delivered again.
   */
  readonly resume: (report: BootRecoveryReport) => Effect.Effect<void>
  /**
   * Enqueues a delivery for `(botId, conversationId)` in the bot's runner (Messaging,
   * RoutineScheduler, ApprovalService). Steers only into a running turn of the SAME conversation.
   */
  readonly deliver: (input: DeliveryInput) => Effect.Effect<DeliveryReceipt, NotFound | HarnessUnavailable>
  /** Waits until the delivery's turn ends (or it is dropped). */
  readonly awaitDelivery: (deliveryId: string) => Effect.Effect<DeliveryOutcome, NotFound>
  /**
   * Drops the bot's single native session (events and the context ring live in its DM). `Conflict`
   * while the bot has a running or queued turn in any conversation.
   */
  readonly newSession: (input: { readonly botId: BotId }) => Effect.Effect<void, NotFound | Conflict>
  /** Compacts the bot's session (`HarnessUnavailable` without `capabilities.compact`). */
  readonly compact: (input: { readonly botId: BotId }) => Effect.Effect<void, NotFound | Conflict | HarnessUnavailable>
  /**
   * `conversations.delete` (groups only, `InvalidInput` otherwise): cancels the members' running and
   * queued turns of the group, cancels its pending requests, then `ConversationService.removeGroup`.
   * Member bots stay (their single session keeps what it saw there).
   */
  readonly deleteConversation: (conversationId: ConversationId) => Effect.Effect<void, NotFound | InvalidInput>
  /**
   * Approval for a gateway tool call (shell / write_file / edit_file …). mcp-conformance.md R10:
   * adapters pre-approve `mcp__openbot__*` natively, so OpenBot's own layer decides here. Runs
   * `ApprovalService.evaluate` in the context of the bot's current turn (its card lands in that
   * turn's conversation; the turn is marked `waiting` while asking, like a native request). Never
   * fails: no runner / errors → evaluated without a turn in `tool.claims.conversationId`; expiry → deny.
   */
  readonly approveToolCall: (tool: ToolContext, request: HarnessApprovalRequest) => Effect.Effect<HarnessRequestResolution>
  /** Stops and evicts every runner of a bot (bot deleted, harness or host node changed). */
  readonly stopBot: (botId: BotId) => Effect.Effect<void>
  /**
   * `message_bot` / `handoff_task` from a group turn to a fellow member: no separate post — the
   * recipient is woken by the turn's reply when it @mentions them; otherwise (or without a reply)
   * `text` is posted for it. False when the bot has no running turn in `conversationId` (the caller
   * posts directly).
   */
  readonly noteGroupAddress: (input: {
    readonly botId: BotId
    readonly conversationId: ConversationId
    readonly recipientBotId: BotId
    readonly text: string
    readonly causalChain: CausalChain
  }) => Effect.Effect<boolean>
  /** Causal chain of the bot's running turn (Messaging hop limits). */
  readonly currentChain: (botId: BotId) => Effect.Effect<Option.Option<CausalChain>>
  /**
   * The bot's running turn (any conversation; a bot runs one turn at a time). The gateway uses its
   * `conversationId` as the current conversation of tool calls.
   */
  readonly activeTurn: (botId: BotId) => Effect.Effect<Option.Option<Turn>>
  /**
   * Boot hook, right after `BootRecovery.run` and before listeners start: publishes the report's
   * changes (turns, requests, entries) through LiveHub so resumed cursors see them, and sets every
   * bot's activity to idle. Deliveries are in-memory and do not survive a restart.
   */
  readonly recover: (report: BootRecoveryReport) => Effect.Effect<void>
}>()("openbot/core/Orchestrator") {}

// ============================================================================ Messaging (§4.3.3)

export interface MessageBotResult {
  readonly recipientBotId: BotId
  /**
   * Where the message was posted: the recipient's direct conversation, or — when the sender works
   * in a group the recipient is a member of — that group (`postedInGroup`).
   */
  readonly conversationId: ConversationId
  /** The posted entry; absent when `noted` (the turn's reply carries the message). */
  readonly entryId?: EntryId | undefined
  readonly deliveryId: string
  readonly postedInGroup?: boolean | undefined
  /**
   * Group turn → fellow member: nothing was posted; the recipient is woken when the sender's reply
   * is posted in the group (the sender should address it there).
   */
  readonly noted?: boolean | undefined
}

/** One file `send_file` delivered. */
export interface SentFile {
  readonly attachment: Attachment
  /** Where it came from (canonical path on the node). */
  readonly path: string
}

export interface SendFilesResult {
  /** Where the message was posted (see `destination`). */
  readonly conversationId: ConversationId
  readonly entryId: EntryId
  readonly files: ReadonlyArray<SentFile>
  /** `current`: the conversation of the bot's turn; `group`: a group chat; `direct`: the recipient's DM. */
  readonly destination: "current" | "group" | "direct"
  /** `to` named a Bot: it was woken with the files (they are copied into its workspace inbox). */
  readonly recipientBotId?: BotId | undefined
  /** The same tool call was answered before: nothing was sent again. */
  readonly replayed?: boolean | undefined
}

/** Default cap on one file a bot sends (`send_file`); the server may override it (`SendFileLimits`). */
export const MAX_SENT_FILE_BYTES = 200_000_000
/** Files per `send_file` call. */
export const MAX_SENT_FILES = 10

/** Limits of `send_file` (a `Context.Reference`: defaults apply unless the server provides others). */
export const SendFileLimits = Context.Reference<{ readonly maxFileBytes: number; readonly maxFiles: number }>(
  "openbot/core/SendFileLimits",
  { defaultValue: () => ({ maxFileBytes: MAX_SENT_FILE_BYTES, maxFiles: MAX_SENT_FILES }) },
)

export class Messaging extends Context.Service<Messaging, {
  /** `message_bot {to, text, urgency}`. */
  readonly messageBot: (
    ctx: ToolContext,
    input: { readonly to: string; readonly text: string; readonly urgency: DeliveryUrgency },
  ) => Effect.Effect<MessageBotResult, NotFound | InvalidInput>
  /** `post_to_group {conversationId?, text}`: defaults to the conversation in the claims when it is a group. */
  readonly postToGroup: (
    ctx: ToolContext,
    input: { readonly conversationId?: ConversationId | undefined; readonly text: string },
  ) => Effect.Effect<{ readonly conversationId: ConversationId; readonly entryId: EntryId }, NotFound | InvalidInput>
  /**
   * `react {emoji, message_id?}`: the bot reacts to a message (author = the bot) instead of posting
   * an acknowledgement. Default target: the latest message from someone else in the conversation of
   * the bot's current turn (what triggered it). Idempotent per (bot, entry, emoji): reacting twice
   * keeps one reaction. `InvalidInput` unless `emoji` is one emoji.
   */
  readonly react: (
    ctx: ToolContext,
    input: { readonly emoji: string; readonly messageId?: EntryId | undefined },
  ) => Effect.Effect<{ readonly conversationId: ConversationId; readonly entryId: EntryId; readonly emoji: string }, NotFound | InvalidInput>
  /** `handoff_task {to, task, context?}`: like message_bot plus a `handoff` event. */
  readonly handoffTask: (
    ctx: ToolContext,
    input: { readonly to: string; readonly task: string; readonly context?: string | undefined },
  ) => Effect.Effect<MessageBotResult, NotFound | InvalidInput>
  /**
   * `send_file {path | paths, caption?, node?, to?}`: copies files from a node into the attachment
   * store (streamed, `NodeFiles.download`; the node's path policy applies) and posts ONE bot-authored
   * message with them (and the caption):
   * - no `to`: in the conversation of the bot's current turn (counts as its message; the turn may
   *   still reply);
   * - `to` = a Bot: in a group turn the recipient is also in, in that group (addressed to it);
   *   otherwise in the recipient's DM (`toBotId`, a "Messaged" event in the sender's conversation),
   *   like `message_bot`; the recipient gets a `bot-message` delivery carrying the files (woken when
   *   idle, else after its turn; hop limit and the bot-messaging switch apply);
   * - `to` = a group conversation id the sender is in: posted there, @mentioned members are woken.
   * Recipients get the files copied into their workspace inbox (BotRunner). Idempotent per tool
   * call id (`clientNonce`). Failures become `InvalidInput` with a model-readable reason; nothing is
   * posted then.
   */
  readonly sendFiles: (
    ctx: ToolContext,
    input: {
      readonly nodeId: NodeId
      readonly inv: Invocation
      /** Base of relative paths: the bot's workspace on that node. */
      readonly cwd?: string | undefined
      readonly paths: ReadonlyArray<string>
      readonly caption?: string | undefined
      /** A Bot (name or id) or a group conversation id; absent = the current conversation. */
      readonly to?: string | undefined
      /** Progress lines while large files transfer (the gateway forwards them to the harness). */
      readonly progress?: ((message: string) => Effect.Effect<void>) | undefined
    },
  ) => Effect.Effect<SendFilesResult, NotFound | InvalidInput>
  /**
   * The files at `paths` on a node, brought into OpenBot (attachments) without posting them: for a
   * Slack draft's files. Same limits and path policy as `sendFiles`.
   */
  readonly importFiles: (input: {
    readonly nodeId: NodeId
    readonly inv: Invocation
    readonly cwd?: string | undefined
    readonly paths: ReadonlyArray<string>
    readonly progress?: ((message: string) => Effect.Effect<void>) | undefined
  }) => Effect.Effect<ReadonlyArray<Attachment>, InvalidInput>
}>()("openbot/core/Messaging") {}

// ============================================================================ InstructionRenderer (§4.3.7)

export class InstructionRenderer extends Context.Service<InstructionRenderer, {
  /**
   * base + bot instructions + team roster + memory index (≤ 4 KB) + `placement.promptAppend`.
   * The runner passes its `ResolvedPlacement`; `BotService.readContext` passes a preview built with
   * `planPlacement` + `describePlacement` + `workspacePathFor` (no tunnels are opened).
   */
  readonly render: (input: {
    readonly bot: Bot
    readonly placement: PlacementSummary
  }) => Effect.Effect<RenderedInstructions>
}>()("openbot/core/InstructionRenderer") {}

// ============================================================================ ApprovalService (§4.3.4)

/** The bot's workspace on the node its tools run on (`ResolvedPlacement.workspacePath` / claims). */
export interface ApprovalWorkspace {
  readonly nodeId: NodeId
  /** Absolute path on that node (may start with `~` for a remote node's default root). */
  readonly path: string
  /**
   * Project folders on that node that count as workspace too (Settings' shared ∪ the bot's own).
   * ApprovalService fills them in from the bot and settings; callers pass only the workspace.
   */
  readonly projectFolders?: ReadonlyArray<string> | undefined
  /** The node's home directory when known (`HostPaths.home`): expands `~` in folders and paths. */
  readonly home?: string | undefined
}

export interface ApprovalContext {
  readonly bot: Bot
  /** The conversation the turn runs in: cards land here (also in groups, next to the work). */
  readonly conversationId: ConversationId
  readonly turnId?: TurnId | undefined
  readonly harness: HarnessKindName
  /**
   * Where the session's tools run, for the bot's `autonomy: "workspace"` (requests provably inside
   * it are allowed without a card). Absent → autonomy "workspace" asks (as "ask" does).
   */
  readonly workspace?: ApprovalWorkspace | undefined
  /**
   * Called once when `evaluate` decides to ASK (after the RuntimeRequest and its card are
   * persisted, before waiting). The runner uses it to mark the turn `waiting` and set the activity
   * ("Waiting for you: …"); it marks the turn `running` again when `evaluate` returns.
   * ApprovalService never writes Turns.
   */
  readonly onPending?: ((request: RuntimeRequest) => Effect.Effect<void>) | undefined
  /**
   * The request comes from a background task's own session (D5.7): its card is labelled with the
   * task title (`taskTitle`) and carries `taskId`; the task cannot ask the owner questions.
   */
  readonly task?: { readonly id: TaskId; readonly title: string } | undefined
  /**
   * Where an `auto-decided` event goes instead of the conversation's transcript (a task's steps).
   */
  readonly recordDecision?: ((event: Extract<KnownConversationEvent, { type: "auto-decided" }>) => Effect.Effect<void>) | undefined
}

/** `node.requestApproval` as received by the brain (BrainRpcs handler in brain-nodes). */
export interface NodeApprovalInput {
  /** From the brain mux stamp (`x-openbot-node-id`), never from the payload. */
  readonly nodeId: NodeId
  /** The wire payload. `runId` is the session key (`parseSessionKey`) when the node passes it. */
  readonly request: NodeApprovalRequest
}

export class ApprovalService extends Context.Service<ApprovalService, {
  /**
   * The runner's `onRequest`: rules (bot deny > bot ask > bot allow > global deny > global ask >
   * global allow > default ask); `ask` → RuntimeRequest + card + await answer or expiry (→ deny).
   * Never fails.
   */
  readonly evaluate: (ctx: ApprovalContext, request: HarnessRequest) => Effect.Effect<HarnessRequestResolution>
  /**
   * A node's own ceiling said `ask` (D1.4): same rules, surface mapped from the node `action`
   * (`run-command` → shell, `write-file` → file-edit, `read-file` → file-read, `browser` → browser,
   * else other). Ask → card in the conversation from `runId` (else the bot's DM), blocking until
   * answered or expired. Never fails: errors and expiry → `{decision: "deny"}`. `by` is
   * "rule" | "user" | "expired".
   */
  readonly evaluateNode: (input: NodeApprovalInput) => Effect.Effect<NodeApprovalResponse>
  /** `requests.respond`: resolves a pending request (allow-always also saves a rule). */
  readonly respond: (input: {
    readonly requestId: RequestId
    readonly response: RuntimeResponseInput
  }) => Effect.Effect<RuntimeRequest, NotFound | RequestNotPending | InvalidInput>
  /** `requests.listPending`. */
  readonly listPending: (input: { readonly conversationId?: ConversationId | undefined }) => Effect.Effect<ReadonlyArray<RuntimeRequest>>
  /** `ask_user` tool (D3.3): posts a question card, returns immediately; the answer becomes a delivery. */
  readonly askUser: (
    ctx: ToolContext,
    input: { readonly title?: string | undefined; readonly questions: ReadonlyArray<Question> },
  ) => Effect.Effect<PendingRequestReceipt, InvalidInput>
  /** `request_approval` tool (D3.3): posts an approval card, returns immediately. */
  readonly requestApproval: (
    ctx: ToolContext,
    input: {
      readonly title: string
      readonly detail?: string | undefined
      readonly command?: string | undefined
      readonly paths?: ReadonlyArray<string> | undefined
    },
  ) => Effect.Effect<PendingRequestReceipt, InvalidInput>
  /**
   * `request_takeover` tool (D1.7): posts an "Action needed" hand-off card (kind `handoff`,
   * acknowledge `done` | `skip`) asking the owner to take over the bot's screen, returns immediately.
   * The owner takes control with `computer.lease {take: true}`; handing it back (`computer.lease
   * {take: false}`, the computer view's "I'm done") answers every pending hand-off of the bot with
   * `done`, and answering the card (`done` / `skip`) gives the lease back. The answer (or the expiry,
   * `HANDOFF_EXPIRY_MINUTES`, extended while the owner still holds control) becomes a delivery.
   * `InvalidInput` from a background task or for an empty instruction.
   */
  readonly requestTakeover: (
    ctx: ToolContext,
    input: { readonly instruction: string },
  ) => Effect.Effect<PendingRequestReceipt, InvalidInput>
  /**
   * Answers to NON-blocking requests (`ask_user` / `request_approval` / `request_takeover`), each as a
   * `user-message` delivery for the asking bot. Buffered single-consumer stream: the Orchestrator
   * drains it from its layer (this keeps ApprovalService independent of Orchestrator).
   */
  readonly asyncAnswers: Stream.Stream<DeliveryInput>
  /** Cancels pending requests matching the filter (turn interrupted/ended, task ended, bot deleted). Returns the count. */
  readonly cancelPending: (input: {
    readonly botId?: BotId | undefined
    readonly conversationId?: ConversationId | undefined
    readonly turnId?: TurnId | undefined
    readonly taskId?: TaskId | undefined
    /** Only requests of these kinds (default: all). */
    readonly kinds?: ReadonlyArray<RuntimeRequest["kind"]> | undefined
    /** Only non-blocking requests (async `ask_user` / `request_approval`), never a waiting turn's. */
    readonly asyncOnly?: boolean | undefined
    readonly reason: string
    /** Shown on the closed card instead of "Skipped" (e.g. "Answered in chat"). */
    readonly cardDetail?: string | undefined
  }) => Effect.Effect<number>
}>()("openbot/core/ApprovalService") {}

// ============================================================================ BackgroundTasks (D5.7)

/**
 * Background tasks: a bot hands long work to a separate, short-lived harness session of its own
 * (same driver, account, model, effort, computer, autonomy and project folders; its toolkit lacks
 * the task tools and the ask-the-owner tools), so its main session stays free to chat. Layer 5b:
 * below the Orchestrator, which drains `results` (the same pattern as `ApprovalService.asyncAnswers`)
 * and routes task approvals here.
 */
export class BackgroundTasks extends Context.Service<BackgroundTasks, {
  /**
   * `start_task {title, brief}`: records a queued task (origin = `ctx.claims.conversationId`) and
   * returns at once; it runs as soon as fewer than the per-bot limit run. `InvalidInput` from a task
   * session (`ctx.taskId`), for an empty title/brief or over-long text.
   */
  readonly start: (
    ctx: ToolContext,
    input: { readonly title: string; readonly brief: string },
  ) => Effect.Effect<Task, NotFound | InvalidInput>
  /** `tasks.list` / `list_tasks`: newest first. */
  readonly list: (input: { readonly botId: BotId; readonly limit?: number | undefined }) => Effect.Effect<ReadonlyArray<Task>>
  /** `tasks.get`: the task and its steps. */
  readonly get: (taskId: TaskId) => Effect.Effect<TaskDetail, NotFound>
  /**
   * The bot's task named `ref` (`check_task` / `cancel_task`): its id, else its title (exact, then a
   * unique partial match; running ones first, then the newest).
   */
  readonly find: (botId: BotId, ref: string) => Effect.Effect<Task, NotFound>
  /**
   * Stops ONE queued or running task (never the bot's other tasks or its main session). The owner's
   * stop is reported to the bot (a `task-result` delivery); the bot's own `cancel_task` is not. A
   * finished task is returned unchanged.
   */
  readonly cancel: (taskId: TaskId, by: TaskStoppedBy) => Effect.Effect<Task, NotFound>
  /**
   * `update_task`: passes a follow-up on to the bot's queued or running task — steered into its
   * running turn when its driver can steer (`"steered"`), otherwise its session's next turn, or its
   * first turn when it has not started (`"queued"`); recorded as one of its steps. Never dropped:
   * work that is already over (or being stopped) comes back as `"finished"`. `InvalidInput` from a
   * task session, for an empty or over-long message; `NotFound` for another bot's task.
   */
  readonly update: (
    ctx: ToolContext,
    input: { readonly taskId: TaskId; readonly message: string },
  ) => Effect.Effect<{ readonly task: Task; readonly delivery: "steered" | "queued" | "finished" }, NotFound | InvalidInput>
  /** The bot is being deleted: stops its tasks without telling it and deletes their records. */
  readonly removeBot: (botId: BotId) => Effect.Effect<void>
  /** A group chat is being deleted: stops the tasks started there (nobody is told). */
  readonly cancelForConversation: (conversationId: ConversationId) => Effect.Effect<void>
  /** Approval of a gateway tool call made by a task (`Orchestrator.approveToolCall` routes here). */
  readonly approve: (
    taskId: TaskId,
    request: HarnessApprovalRequest,
    workspace?: ApprovalWorkspace | undefined,
  ) => Effect.Effect<HarnessRequestResolution>
  /** Finished tasks as `task-result` deliveries for their bots. Single consumer: the Orchestrator. */
  readonly results: Stream.Stream<DeliveryInput>
  /**
   * After boot (routes serving): the tasks boot recovery failed because a restart cut them off run
   * again under their own ids, resuming their harness session (`Task.nativeSessionId`) when there is
   * one. A task restarted `MAX_TASK_RESTARTS` times already is reported to its bot instead (`task-result`).
   */
  readonly recover: (report: BootRecoveryReport) => Effect.Effect<void>
  /** Deploys (`Orchestrator.drain`): queued tasks stay queued from now on; running ones go on. */
  readonly hold: Effect.Effect<void>
  /** Tasks running now (not queued). */
  readonly running: Effect.Effect<number>
  /**
   * The brain is stopping (`Orchestrator.handOff`): running tasks are interrupted before the harness
   * drivers close and stay `running`, so the next boot runs them again (`recover`).
   */
  readonly handOff: Effect.Effect<void>
}>()("openbot/core/BackgroundTasks") {}

// ============================================================================ RoutineScheduler (§4.3.5)

export class RoutineScheduler extends Context.Service<RoutineScheduler, {
  /** `routines.list` / `list_routines` tool. */
  readonly list: (input: { readonly botId?: BotId | undefined }) => Effect.Effect<ReadonlyArray<Routine>>
  readonly get: (routineId: RoutineId) => Effect.Effect<Routine, NotFound>
  /** `routines.create` / `create_routine` (a bot may only create routines for itself). */
  readonly create: (
    actor: Actor,
    input: { readonly botId: BotId; readonly spec: RoutineSpec },
  ) => Effect.Effect<Routine, NotFound | InvalidInput | Conflict>
  /**
   * `routines.update` (full spec) / `update_routine` tool (the toolkit merges its partial args over
   * the current routine first). A bot may only update its own routines.
   */
  readonly update: (
    actor: Actor,
    input: { readonly routineId: RoutineId; readonly spec: RoutineSpec },
  ) => Effect.Effect<Routine, NotFound | InvalidInput | Conflict>
  /** `routines.setEnabled` (Active / Paused). */
  readonly setEnabled: (routineId: RoutineId, enabled: boolean) => Effect.Effect<Routine, NotFound>
  /** `routines.delete`. */
  readonly delete: (routineId: RoutineId) => Effect.Effect<void, NotFound>
  /** `routines.runNow` ("Test run"): fires immediately, returns the started run. */
  readonly runNow: (routineId: RoutineId) => Effect.Effect<RoutineRun, NotFound | Conflict | HarnessUnavailable>
  /** `routines.runs`: newest first, at most 20. */
  readonly runs: (routineId: RoutineId) => Effect.Effect<ReadonlyArray<RoutineRun>, NotFound>
}>()("openbot/core/RoutineScheduler") {}

// ============================================================================ MemoryService (D5.4)

export class MemoryService extends Context.Service<MemoryService, {
  /** `memory.get`. */
  readonly get: (botId: BotId) => Effect.Effect<BotMemory, NotFound>
  /** `memory.putFact` / `remember` tool: upserts the fact and its index line; emits `memory-updated`. */
  readonly putFact: (actor: Actor, botId: BotId, input: MemoryFactInput) => Effect.Effect<MemoryFact, NotFound | InvalidInput>
  /** `memory.deleteFact` / `forget` tool. */
  readonly deleteFact: (actor: Actor, botId: BotId, factId: MemoryFactId) => Effect.Effect<void, NotFound>
  /** `memory.setIndex`: replaces MEMORY.md verbatim. */
  readonly setIndex: (botId: BotId, index: string) => Effect.Effect<BotMemory, NotFound | InvalidInput>
  /** `recall_memory` tool: facts matching `query` (case-insensitive substring of title/description/body); all when absent. */
  readonly recall: (botId: BotId, query?: string) => Effect.Effect<ReadonlyArray<MemoryFact>, NotFound>
  /** MEMORY.md capped at `MEMORY_INDEX_PROMPT_CAP_BYTES` for instructions. */
  readonly promptIndex: (botId: BotId) => Effect.Effect<string>
}>()("openbot/core/MemoryService") {}

// ============================================================================ SkillService (D5.5)

export class SkillService extends Context.Service<SkillService, {
  /** `skills.list` / `list_skills` tool. */
  readonly list: Effect.Effect<ReadonlyArray<Skill>>
  readonly get: (name: SkillName) => Effect.Effect<Skill, NotFound>
  /**
   * `skills.upsert` / `save_skill` tool. A Bot saving a skill gets it (`Bot.skills`) and a
   * `skill-saved` event; it may replace only a skill it has (InvalidInput otherwise).
   */
  readonly upsert: (actor: Actor, input: SkillInput) => Effect.Effect<Skill, InvalidInput>
  /** `skills.delete`: from the library and from every Bot. */
  readonly delete: (name: SkillName) => Effect.Effect<void, NotFound>
  /** `skills.assign`: exactly `botIds` have the skill afterwards. */
  readonly assign: (name: SkillName, botIds: ReadonlyArray<BotId>) => Effect.Effect<void, NotFound | InvalidInput>
  /** `skills.search` (skills.sh). */
  readonly search: (query: string) => Effect.Effect<ReadonlyArray<SkillSearchResult>, InvalidInput | Unavailable>
  /** `skills.preview`: downloads and reads a skills.sh skill without installing it. */
  readonly preview: (id: string) => Effect.Effect<SkillPreview, NotFound | InvalidInput | Unavailable>
  /**
   * `skills.install`: downloads a skills.sh skill into the library (replacing a same-named one,
   * which keeps its Bots) and gives it to `botIds` too.
   */
  readonly install: (id: string, botIds: ReadonlyArray<BotId>) => Effect.Effect<Skill, NotFound | InvalidInput | Unavailable>
}>()("openbot/core/SkillService") {}

// ============================================================================ SettingsService

export class SettingsService extends Context.Service<SettingsService, {
  /** `settings.get` (defaults applied). */
  readonly get: Effect.Effect<Settings>
  /** `settings.update`: applies the patch, persists, publishes `settings.updated`. */
  readonly update: (patch: SettingsPatch) => Effect.Effect<Settings, InvalidInput>
  /** Current value first, then every change. */
  readonly changes: Stream.Stream<Settings>
  /** `rules.list`: all rules, or a bot's rules plus global ones. */
  readonly listRules: (input: { readonly botId?: BotId | undefined }) => Effect.Effect<ReadonlyArray<ApprovalRule>>
  /** `rules.upsert`: allocates id/createdAt when absent. */
  readonly upsertRule: (input: ApprovalRuleInput) => Effect.Effect<ApprovalRule, NotFound | InvalidInput>
  /** `rules.delete`. */
  readonly deleteRule: (ruleId: ApprovalRuleId) => Effect.Effect<void, NotFound>
}>()("openbot/core/SettingsService") {}

// ============================================================================ UsageService

export class UsageService extends Context.Service<UsageService, {
  /** Called by TurnIngest for each `Usage` event. */
  readonly record: (input: {
    readonly botId: BotId
    readonly conversationId: ConversationId
    readonly turnId?: TurnId | undefined
    readonly harness: HarnessKindName
    readonly model?: string | undefined
    readonly usage: Usage
  }) => Effect.Effect<void>
  /** `usage.byBot {sinceMs?}`. */
  readonly byBot: (input: { readonly sinceMs?: Millis | undefined }) => Effect.Effect<ReadonlyArray<BotUsage>>
}>()("openbot/core/UsageService") {}

// ============================================================================ AttachmentService

export class AttachmentService extends Context.Service<AttachmentService, {
  /** `attachments.upload` (base64 decoded by the RPC handler); enforces size/mime limits. */
  readonly upload: (input: {
    readonly name: string
    readonly mime: string
    readonly bytes: Uint8Array
  }) => Effect.Effect<Attachment, InvalidInput>
  /** Contract view (`url` = `/api/attachments/<id>`). */
  readonly get: (attachmentId: AttachmentId) => Effect.Effect<Attachment, NotFound>
}>()("openbot/core/AttachmentService") {}

/** A search (`search.query`, and a bot's `search_messages`). See `SearchFilter` for what a bot may read. */
export interface SearchInput {
  /** Words or "an exact phrase"; `-word` excludes; at most `SEARCH_QUERY_MAX_CHARS`. */
  readonly query: string
  readonly conversationIds?: ReadonlyArray<ConversationId> | undefined
  readonly botIds?: ReadonlyArray<BotId> | undefined
  readonly senders?: ReadonlyArray<SearchSender> | undefined
  /** Bots' search only: the messages between the bot and this one. */
  readonly exchangeWith?: BotId | undefined
  /** Default `DEFAULT_SEARCH_KINDS`. */
  readonly kinds?: ReadonlyArray<SearchKind> | undefined
  readonly from?: number | undefined
  readonly to?: number | undefined
  /** Default relevance. */
  readonly sort?: SearchSort | undefined
  readonly cursor?: string | undefined
  /** 1–`SEARCH_PAGE_MAX`. */
  readonly limit: number
}

/** A chat a bot names in its search tools ("current", "owner", a group, @Name; see `SearchService.resolveForBot`). */
export type BotChatRef =
  | { readonly kind: "all" }
  | { readonly kind: "conversation"; readonly conversationId: ConversationId }
  /** The messages the bot and `peerBotId` sent each other (they live in both bots' DMs). */
  | { readonly kind: "exchange"; readonly peerBotId: BotId }

/** What a bot reads back (`read_conversation`): entries oldest first, and where the next pages start. */
export interface BotReadPage {
  readonly chat: Exclude<BotChatRef, { readonly kind: "all" }>
  readonly entries: ReadonlyArray<TranscriptEntry>
  /** Read further back with `before` = this entry; absent at the start. */
  readonly olderFrom?: EntryId | undefined
  /** Read on with `after` = this entry; absent at the newest. */
  readonly newerFrom?: EntryId | undefined
}

/** The model-readable refusal for anything a bot may not read (it never says whether it exists). */
export const CANT_READ_MESSAGE = "You can't read that conversation."

/** Message search over the index (layer 2: repositories only). */
export class SearchService extends Context.Service<SearchService, {
  /** `search.query`: the owner's search over every chat. */
  readonly query: (input: SearchInput) => Effect.Effect<SearchPage, InvalidInput>
  /**
   * `search.inConversation`: every hit in one chat, for the Find bar. A query without words
   * (punctuation), or whose words match nothing, falls back to a plain substring match.
   */
  readonly inConversation: (input: {
    readonly conversationId: ConversationId
    readonly query: string
    readonly kinds?: ReadonlyArray<SearchKind> | undefined
    readonly limit: number
  }) => Effect.Effect<SearchPositions, NotFound | InvalidInput>
  /** A bot's search (`search_messages`): only what it may read (`SearchFilter`), counted up to `BOT_SEARCH_TOTAL_CAP`. */
  readonly forBot: (botId: BotId, input: SearchInput) => Effect.Effect<SearchPage, InvalidInput>
  /** The bot may read this whole chat now: it is a member (its DM, a group it is in, its routine runs). */
  readonly canRead: (botId: BotId, conversationId: ConversationId) => Effect.Effect<boolean>
  /**
   * A chat as a bot names it: "all"; "current" (the conversation it works in); "owner" (its DM);
   * a group's title or a conversation id (only chats it is a member of); "@Name" or a teammate's
   * name (its messages with that bot). Undefined or "" → `fallback`. Refused: `InvalidInput`.
   */
  readonly resolveForBot: (
    botId: BotId,
    current: ConversationId,
    ref: string | undefined,
    fallback: "all" | "current",
  ) => Effect.Effect<BotChatRef, InvalidInput>
  /**
   * A bot reads back a chat it may read: around an entry (a search hit; with no `chat` the entry
   * decides which), before or after one, or the newest. Voice calls' work, reasoning and audit lines
   * are left out; tool steps only its own and only with `includeTools`.
   */
  readonly readForBot: (botId: BotId, input: {
    readonly chat?: Exclude<BotChatRef, { readonly kind: "all" }> | undefined
    readonly around?: EntryId | undefined
    readonly before?: EntryId | undefined
    readonly after?: EntryId | undefined
    readonly limit: number
    readonly includeTools: boolean
  }) => Effect.Effect<BotReadPage, InvalidInput>
  /** The records of these chats (labels for what a bot found). */
  readonly chats: (ids: ReadonlyArray<ConversationId>) => Effect.Effect<ReadonlyMap<ConversationId, Conversation>>
}>()("openbot/core/SearchService") {}

/**
 * Voice calls (experiment): which Bots are on a call right now. Background work started on a call
 * reports back on it while the call lasts (and to the chat after).
 */
export class CallPresence extends Context.Service<CallPresence, {
  readonly onCall: (botId: BotId) => boolean
  readonly enter: (botId: BotId) => void
  readonly leave: (botId: BotId) => void
}>()("openbot/core/CallPresence") {
  static readonly layer: Layer.Layer<CallPresence> = Layer.sync(CallPresence, () => {
    const calls = new Map<BotId, number>()
    return CallPresence.of({
      onCall: (botId) => (calls.get(botId) ?? 0) > 0,
      enter: (botId) => void calls.set(botId, (calls.get(botId) ?? 0) + 1),
      leave: (botId) => {
        const left = (calls.get(botId) ?? 0) - 1
        if (left > 0) calls.set(botId, left)
        else calls.delete(botId)
      },
    })
  })
}

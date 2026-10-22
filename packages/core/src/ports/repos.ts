/**
 * Repository ports (architecture §3.2). Implemented by `@openbot/persistence` (SQLite + files) and by
 * the in-memory doubles in `@openbot/core/testing`. Both must behave identically; the shared contract
 * tests in `packages/core/test/ports` describe that behavior.
 *
 * Conventions:
 * - Every method fails only with `RepoError` (defect-like; services `orDie` it).
 * - Lookups return `Option`; "not found" is not an error at this layer.
 * - `upsert` = insert or replace the whole entity (whole-entity upserts, D4.1).
 * - Lists are ordered as documented per method; nothing is implicitly paginated unless stated.
 */
import type {
  ApprovalRule,
  ApprovalRuleId,
  Bot,
  BotId,
  Conversation,
  ConversationId,
  ConversationKind,
  EntryId,
  KnownConversationChange,
  KnownRosterChange,
  KnownTranscriptEntry,
  Millis,
  NodeId,
  RequestId,
  Routine,
  RoutineId,
  RoutineRun,
  RoutineRunId,
  RuntimeRequest,
  RuntimeRequestStatus,
  SearchKind,
  SearchSender,
  SearchSort,
  Section,
  SectionId,
  StreamCursor,
  Task,
  TaskId,
  TaskStatus,
  TranscriptEntry,
  Turn,
  TurnId,
  Usage,
} from "@openbot/contracts"
import {
  BotId as BotIdSchema,
  ConversationId as ConversationIdSchema,
  DEFAULT_SETTINGS,
  EntryId as EntryIdSchema,
  HarnessKindName as HarnessKindNameSchema,
  KnownConversationChange as KnownConversationChangeSchema,
  KnownRosterChange as KnownRosterChangeSchema,
  Millis as MillisSchema,
  NodeId as NodeIdSchema,
  Settings as SettingsSchema,
  TurnId as TurnIdSchema,
  Usage as UsageSchema,
} from "@openbot/contracts"
import type { Settings } from "@openbot/contracts"
import { Context, Effect, Option, Result, Schema } from "effect"
import type { SearchCursor, SearchDoc, SearchMatch } from "../services/search/text.ts"
import type { RepoError } from "./errors.ts"

// ============================================================================ shared shapes

/** Result of a revision-guarded upsert. */
export type UpsertOutcome<A> =
  | { readonly applied: true; readonly value: A }
  /** The stored entity has a revision >= the incoming one; nothing was written. */
  | { readonly applied: false; readonly current: A }

/** A page of transcript entries, oldest first (mirrors `contracts.TranscriptPage`). */
export interface EntryPage {
  readonly entries: ReadonlyArray<TranscriptEntry>
  readonly hasMoreBefore: boolean
  /** Opaque cursor for the page before this one; `null` when there is none. */
  readonly beforeCursor: string | null
  /** `createdAt` of the entry just before the page (timestamp separators). */
  readonly precedingTimestamp?: Millis | undefined
}

/** A position in the `(createdAt, id)` entry order. */
export interface EntryPosition {
  readonly createdAt: number
  readonly id: string
}

/**
 * The messages two Bots sent each other (`EntryRepo.listExchange`): messages authored by one of
 * `botIds` and addressed (`toBotId`) to the other, in `conversationIds` (their direct conversations).
 */
export interface ExchangeQuery {
  readonly botIds: readonly [BotId, BotId]
  readonly conversationIds: ReadonlyArray<ConversationId>
  /** "older": the newest `limit` before `from`; "newer": the oldest `limit` after it. */
  readonly direction: "older" | "newer"
  /** Exclusive bound; absent = from the newest ("older") / the oldest ("newer") message. */
  readonly from?: EntryPosition | undefined
  readonly limit: number
}

/** Messages oldest first; `more` when the scan has more beyond them in its direction. */
export interface ExchangeSlice {
  readonly entries: ReadonlyArray<TranscriptEntry>
  readonly more: boolean
}

// ============================================================================ bots & sections

/**
 * The bot's ONE native harness session (decision "One mind per bot"): every conversation of the
 * bot (its DM, each group, routine runs, bot-to-bot DMs) runs its turns in this session.
 */
export const BotSessionRecord = Schema.Struct({
  botId: BotIdSchema,
  /** Harness kind that owns `nativeSessionId`; a different driver must not resume it. */
  driver: HarnessKindNameSchema,
  nativeSessionId: Schema.String,
  /** `RenderedInstructions.hash` the session was opened with (reopen when it changes). */
  instructionsHash: Schema.optional(Schema.String),
  /**
   * Last entry this session has seen, per conversation (group turns render only the entries after
   * it, §4.3.2). Gone with the record on New session.
   */
  seen: Schema.optional(Schema.Record(Schema.String, EntryIdSchema)),
  /** The conversation of the session's latest turn (turn texts tag a change of conversation). */
  lastConversationId: Schema.optional(ConversationIdSchema),
  updatedAt: MillisSchema,
})
export type BotSessionRecord = typeof BotSessionRecord.Type


export class BotRepo extends Context.Service<BotRepo, {
  readonly get: (id: BotId) => Effect.Effect<Option.Option<Bot>, RepoError>
  /** All bots, ordered by `createdAt` ascending. */
  readonly list: Effect.Effect<ReadonlyArray<Bot>, RepoError>
  readonly upsert: (bot: Bot) => Effect.Effect<void, RepoError>
  /** Returns false when the bot did not exist. Also deletes its native session record. */
  readonly delete: (id: BotId) => Effect.Effect<boolean, RepoError>

  /** The bot's single native harness session ("one mind per bot"), if one was bound. */
  readonly getSession: (botId: BotId) => Effect.Effect<Option.Option<BotSessionRecord>, RepoError>
  /** Insert or replace the bot's session record. */
  readonly setSession: (record: BotSessionRecord) => Effect.Effect<void, RepoError>
  /** Forgets the bot's session (New session, harness/account/host change, resume failure). */
  readonly clearSession: (botId: BotId) => Effect.Effect<void, RepoError>
}>()("openbot/core/BotRepo") {}

export class SectionRepo extends Context.Service<SectionRepo, {
  /** Ordered by `order` ascending, then id. */
  readonly list: Effect.Effect<ReadonlyArray<Section>, RepoError>
  readonly get: (id: SectionId) => Effect.Effect<Option.Option<Section>, RepoError>
  readonly upsert: (section: Section) => Effect.Effect<void, RepoError>
  readonly delete: (id: SectionId) => Effect.Effect<boolean, RepoError>
}>()("openbot/core/SectionRepo") {}

// ============================================================================ conversations


export interface ConversationFilter {
  readonly kind?: ConversationKind | undefined
  /** Conversations where this bot is a member (direct owner, group member, routine-run owner). */
  readonly botId?: BotId | undefined
  /** Default true. */
  readonly includeHidden?: boolean | undefined
}

export class ConversationRepo extends Context.Service<ConversationRepo, {
  readonly get: (id: ConversationId) => Effect.Effect<Option.Option<Conversation>, RepoError>
  /** Ordered by `lastActivityAt` descending. */
  readonly list: (filter?: ConversationFilter) => Effect.Effect<ReadonlyArray<Conversation>, RepoError>
  /** Members are part of the entity (`botId` / `memberBotIds`); upsert maintains the member index. */
  readonly upsert: (conversation: Conversation) => Effect.Effect<void, RepoError>
  /** Deletes the conversation record and its member index. */
  readonly delete: (id: ConversationId) => Effect.Effect<boolean, RepoError>
  /** Member bot ids (direct: `[botId]`, group: `memberBotIds`, routine-run: `[botId]`). */
  readonly members: (id: ConversationId) => Effect.Effect<ReadonlyArray<BotId>, RepoError>
}>()("openbot/core/ConversationRepo") {}

// ============================================================================ transcript entries

export interface EntryPageQuery {
  readonly conversationId: ConversationId
  /** Opaque cursor from a previous page (`beforeCursor`); omitted = the tail. */
  readonly before?: string | undefined
  readonly limit: number
}

export interface EntryPageAfterQuery {
  readonly conversationId: ConversationId
  /** Opaque cursor `"<createdAt>:<id>"`: entries strictly after this position. */
  readonly after: string
  readonly limit: number
}

/** A page of entries after a position, oldest first. */
export interface EntryPageAfter {
  readonly entries: ReadonlyArray<TranscriptEntry>
  readonly hasMoreAfter: boolean
  /** Cursor of the page's last entry when more follow; `null` otherwise. */
  readonly afterCursor: string | null
}

export class EntryRepo extends Context.Service<EntryRepo, {
  readonly get: (id: EntryId) => Effect.Effect<Option.Option<TranscriptEntry>, RepoError>
  /**
   * Revision guard: written iff no entry with this id exists or `entry.revision` is strictly greater
   * than the stored revision. Entries are ordered by `(createdAt, id)`; `createdAt` never changes.
   */
  readonly upsert: (entry: KnownTranscriptEntry) => Effect.Effect<UpsertOutcome<TranscriptEntry>, RepoError>
  /** Removes an entry (`entry.removed`). */
  readonly remove: (id: EntryId) => Effect.Effect<boolean, RepoError>
  /** The `limit` entries before `before` (or the newest `limit`), returned oldest first. */
  readonly page: (query: EntryPageQuery) => Effect.Effect<EntryPage, RepoError>
  /**
   * The `limit` entries after `after` (a cursor from `page` / `pageAfter`, or `encodeEntryCursor` of
   * an entry), oldest first; `hasMoreAfter` when more follow. Mirrors `page` (`conversations.around`).
   */
  readonly pageAfter: (query: EntryPageAfterQuery) => Effect.Effect<EntryPageAfter, RepoError>
  /** Bot-to-bot messages between two Bots, next to a position (`conversations.exchange`). */
  readonly listExchange: (query: ExchangeQuery) => Effect.Effect<ExchangeSlice, RepoError>
  /**
   * Entries strictly after `afterEntryId` in `(createdAt, id)` order, oldest first, at most `limit`.
   * `afterEntryId` undefined or unknown → from the start. Used for "messages a bot has not seen".
   */
  readonly listAfter: (
    conversationId: ConversationId,
    afterEntryId: EntryId | undefined,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<TranscriptEntry>, RepoError>
  /** Idempotent sends (`messages.send` / `messages.lookupSend`). */
  readonly findByClientNonce: (
    conversationId: ConversationId,
    clientNonce: string,
  ) => Effect.Effect<Option.Option<TranscriptEntry>, RepoError>
  /** Entry previously ingested for a harness item (`harnessRef.nativeId`), to keep ids stable on resume. */
  readonly findByNativeId: (
    conversationId: ConversationId,
    nativeId: string,
  ) => Effect.Effect<Option.Option<TranscriptEntry>, RepoError>
  /** All entries of a turn, oldest first (finalize streaming items on turn end). */
  readonly listByTurn: (turnId: TurnId) => Effect.Effect<ReadonlyArray<TranscriptEntry>, RepoError>
}>()("openbot/core/EntryRepo") {}

// ============================================================================ message search

/** Whose search: the owner sees every chat; a bot only what it may read (enforced by the repository). */
export type SearchScope = { readonly kind: "owner" } | { readonly kind: "bot"; readonly botId: BotId }

/**
 * What a search looks at. In a bot's scope (Lekë's decisions for v1):
 * - entries of the chats it is a member of NOW (its DM, its groups with their whole history, its
 *   routine-run chats); a group it left is closed to it;
 * - the bot-to-bot messages it sent or was sent, which live in the other bot's DM (`message` entries
 *   only; nothing else of the owner's chats with other bots);
 * - tool steps only its own; tasks only its own.
 * In every scope: voice calls' work and tasks started in a chat that no longer exists are left out.
 */
export interface SearchFilter {
  readonly scope: SearchScope
  readonly kinds: ReadonlyArray<SearchKind>
  readonly conversationIds?: ReadonlyArray<ConversationId> | undefined
  /** Chats the bot is in, or written by it. */
  readonly botIds?: ReadonlyArray<BotId> | undefined
  readonly senders?: ReadonlyArray<SearchSender> | undefined
  /** Inclusive bounds on `createdAt`. */
  readonly from?: number | undefined
  readonly to?: number | undefined
}

export interface SearchRepoQuery extends SearchFilter {
  readonly match: SearchMatch
  readonly sort: SearchSort
  /** Keyset position after which the page starts (from a previous page's `next`). */
  readonly after?: SearchCursor | undefined
  readonly limit: number
}

export interface SearchRepoHit {
  readonly doc: SearchDoc
  /** Snippet with `SNIPPET_OPEN` / `SNIPPET_CLOSE` around matched words. */
  readonly snippet: string
  /** Relevance order key (lower = better); 0 for the time sorts. */
  readonly rank: number
  /** Task hits: the bot's first message in the task's chat at or after the doc's time (its report). */
  readonly jumpEntryId?: EntryId | undefined
}

export interface SearchRepoPage {
  readonly hits: ReadonlyArray<SearchRepoHit>
  /** Where the next page starts; undefined on the last page. */
  readonly next: SearchCursor | undefined
  /** Matches in total, counted up to `SEARCH_TOTAL_CAP`. */
  readonly total: number
}

export interface SearchPositionsQuery extends SearchFilter {
  readonly conversationId: ConversationId
  /** Words to match; or `substring`: a plain case-insensitive substring (queries without words). */
  readonly match?: SearchMatch | undefined
  readonly substring?: string | undefined
  readonly limit: number
}

export interface SearchIndexReport {
  /** The index was rebuilt from scratch (first boot after the upgrade, or a new `SEARCH_TEXT_VERSION`). */
  readonly rebuilt: boolean
  /** Entries and tasks looked at (each gets its doc, or none when nothing of it is searchable). */
  readonly indexed: number
  readonly ms: number
}

export class SearchRepo extends Context.Service<SearchRepo, {
  /** One page of matches, ordered by `sort` (relevance: rank, then newest first). */
  readonly query: (query: SearchRepoQuery) => Effect.Effect<SearchRepoPage, RepoError>
  /** The newest `limit` matching entries of one chat, oldest first; `more` when older ones were left out. */
  readonly positions: (query: SearchPositionsQuery) => Effect.Effect<{
    readonly hits: ReadonlyArray<{ readonly entryId: EntryId; readonly createdAt: Millis }>
    readonly more: boolean
  }, RepoError>
  /**
   * Builds the index from what is stored (boot, in the background): a full rebuild when the stored
   * text version differs from `SEARCH_TEXT_VERSION`, otherwise only entries and tasks it lacks
   * (written by an older release). Writes keep it up to date on their own.
   */
  readonly ensure: Effect.Effect<SearchIndexReport, RepoError>
  /** A rebuild is pending or running: results may be incomplete. */
  readonly indexing: Effect.Effect<boolean>
}>()("openbot/core/SearchRepo") {}

// ============================================================================ runtime requests

export interface RequestFilter {
  readonly conversationId?: ConversationId | undefined
  readonly botId?: BotId | undefined
  readonly turnId?: TurnId | undefined
  readonly statuses?: ReadonlyArray<RuntimeRequestStatus> | undefined
}

export class RequestRepo extends Context.Service<RequestRepo, {
  readonly get: (id: RequestId) => Effect.Effect<Option.Option<RuntimeRequest>, RepoError>
  readonly upsert: (request: RuntimeRequest) => Effect.Effect<void, RepoError>
  /** Ordered by `createdAt` ascending. */
  readonly list: (filter?: RequestFilter) => Effect.Effect<ReadonlyArray<RuntimeRequest>, RepoError>
  /** Idempotency for tool-raised requests: keyed on `(botId, source.nativeRequestId)`. */
  readonly findByNativeId: (botId: BotId, nativeRequestId: string) => Effect.Effect<Option.Option<RuntimeRequest>, RepoError>
  /** Deletes every request of a conversation (conversation deleted). */
  readonly deleteByConversation: (conversationId: ConversationId) => Effect.Effect<void, RepoError>
}>()("openbot/core/RequestRepo") {}

// ============================================================================ turns

export class TurnRepo extends Context.Service<TurnRepo, {
  readonly get: (id: TurnId) => Effect.Effect<Option.Option<Turn>, RepoError>
  readonly upsert: (turn: Turn) => Effect.Effect<void, RepoError>
  /** The most recent `limit` turns of a conversation, returned oldest first. */
  readonly listByConversation: (conversationId: ConversationId, limit: number) => Effect.Effect<ReadonlyArray<Turn>, RepoError>
  /** Turns whose status is queued | running | waiting, oldest first. */
  readonly listActive: Effect.Effect<ReadonlyArray<Turn>, RepoError>
  /** Deletes every turn of a conversation (conversation deleted). */
  readonly deleteByConversation: (conversationId: ConversationId) => Effect.Effect<void, RepoError>
}>()("openbot/core/TurnRepo") {}

// ============================================================================ background tasks (D5.7)

export interface TaskFilter {
  readonly botId?: BotId | undefined
  /** The conversation the tasks were started from. */
  readonly conversationId?: ConversationId | undefined
  readonly statuses?: ReadonlyArray<TaskStatus> | undefined
  /** Newest first, at most this many (default: all). */
  readonly limit?: number | undefined
}

export class TaskRepo extends Context.Service<TaskRepo, {
  readonly get: (id: TaskId) => Effect.Effect<Option.Option<Task>, RepoError>
  readonly upsert: (task: Task) => Effect.Effect<void, RepoError>
  /** Ordered by `createdAt` DESCENDING (newest first), then id descending. */
  readonly list: (filter?: TaskFilter) => Effect.Effect<ReadonlyArray<Task>, RepoError>
  /** Deletes the task and its steps; false when it did not exist. */
  readonly delete: (id: TaskId) => Effect.Effect<boolean, RepoError>
  /**
   * Inserts or replaces one step (a transcript entry of the task's own session, keyed by entry id).
   * Steps never belong to a conversation's transcript: they are not chat bubbles.
   */
  readonly putStep: (taskId: TaskId, step: KnownTranscriptEntry) => Effect.Effect<void, RepoError>
  /** The task's steps in `(createdAt, id)` order. */
  readonly steps: (taskId: TaskId) => Effect.Effect<ReadonlyArray<TranscriptEntry>, RepoError>
}>()("openbot/core/TaskRepo") {}

// ============================================================================ routines

export class RoutineRepo extends Context.Service<RoutineRepo, {
  readonly get: (id: RoutineId) => Effect.Effect<Option.Option<Routine>, RepoError>
  /** Ordered by `createdAt` ascending. */
  readonly list: (filter?: { readonly botId?: BotId | undefined }) => Effect.Effect<ReadonlyArray<Routine>, RepoError>
  readonly upsert: (routine: Routine) => Effect.Effect<void, RepoError>
  /** Also deletes its runs. */
  readonly delete: (id: RoutineId) => Effect.Effect<boolean, RepoError>
  /** Insert or replace a run; keeps only the newest `ROUTINE_RUNS_KEPT` (20) runs per routine. */
  readonly upsertRun: (run: RoutineRun) => Effect.Effect<void, RepoError>
  readonly getRun: (id: RoutineRunId) => Effect.Effect<Option.Option<RoutineRun>, RepoError>
  /** Newest first. */
  readonly listRuns: (routineId: RoutineId) => Effect.Effect<ReadonlyArray<RoutineRun>, RepoError>
}>()("openbot/core/RoutineRepo") {}

// ============================================================================ nodes

/** Stored node (brain side). Live status is NOT stored; `NodeDirectory` derives it. */
export const NodeRecord = Schema.Struct({
  id: NodeIdSchema,
  label: Schema.String,
  kind: Schema.Literals(["local", "remote"]),
  /** Ed25519 public key as encoded by node-protocol auth. Absent for the local node. */
  publicKey: Schema.optional(Schema.String),
  /** Declared at the last `node.hello`. */
  declaredCapabilities: Schema.Array(Schema.String),
  /** Approved by the owner (Settings › Computers). Effective = declared ∩ approved. */
  approvedCapabilities: Schema.Array(Schema.String),
  platform: Schema.String,
  hostname: Schema.String,
  roots: Schema.Array(Schema.String),
  version: Schema.optional(Schema.String),
  createdAt: MillisSchema,
  lastSeenAt: Schema.optional(MillisSchema),
  /** Set by `nodes.revoke`; revoked nodes are rejected with close code 4401. */
  revokedAt: Schema.optional(MillisSchema),
})
export type NodeRecord = typeof NodeRecord.Type

export const PairingCodeRecord = Schema.Struct({
  code: Schema.String,
  createdAt: MillisSchema,
  expiresAt: MillisSchema,
})
export type PairingCodeRecord = typeof PairingCodeRecord.Type

export class NodeRepo extends Context.Service<NodeRepo, {
  readonly get: (id: NodeId) => Effect.Effect<Option.Option<NodeRecord>, RepoError>
  /** Ordered by `createdAt` ascending; includes revoked nodes. */
  readonly list: Effect.Effect<ReadonlyArray<NodeRecord>, RepoError>
  readonly findByPublicKey: (publicKey: string) => Effect.Effect<Option.Option<NodeRecord>, RepoError>
  readonly upsert: (node: NodeRecord) => Effect.Effect<void, RepoError>
  readonly delete: (id: NodeId) => Effect.Effect<boolean, RepoError>
  readonly putPairingCode: (record: PairingCodeRecord) => Effect.Effect<void, RepoError>
  /**
   * Single use: returns the code and deletes it when it exists and `now < expiresAt`; otherwise
   * returns none (an expired code is deleted too).
   */
  readonly consumePairingCode: (code: string, now: Millis) => Effect.Effect<Option.Option<PairingCodeRecord>, RepoError>
}>()("openbot/core/NodeRepo") {}

// ============================================================================ approval rules

export class ApprovalRuleRepo extends Context.Service<ApprovalRuleRepo, {
  readonly get: (id: ApprovalRuleId) => Effect.Effect<Option.Option<ApprovalRule>, RepoError>
  /**
   * Ordered by `createdAt` ascending. `botId` given → that bot's rules AND global rules (no botId);
   * omitted → every rule.
   */
  readonly list: (filter?: { readonly botId?: BotId | undefined }) => Effect.Effect<ReadonlyArray<ApprovalRule>, RepoError>
  readonly upsert: (rule: ApprovalRule) => Effect.Effect<void, RepoError>
  readonly delete: (id: ApprovalRuleId) => Effect.Effect<boolean, RepoError>
}>()("openbot/core/ApprovalRuleRepo") {}

// ============================================================================ settings (typed key/values)

/**
 * Raw JSON key/values; `SettingsService` owns the typed view and defaults.
 *
 * Storage convention (shared by SettingsService and LiveHub's roster snapshot): ONE KEY PER
 * `Settings` FIELD (`theme`, `accent`, `showSteps`, …) holding the field's encoded JSON value; an
 * absent key means "default". Use `readSettings` / `settingsFromEntries` / `settingsToEntries`.
 * Keys outside `Settings` are free for other brain-internal values (prefix them, e.g. `brain.*`).
 */
export class SettingsRepo extends Context.Service<SettingsRepo, {
  readonly get: (key: string) => Effect.Effect<Option.Option<unknown>, RepoError>
  readonly getAll: Effect.Effect<ReadonlyMap<string, unknown>, RepoError>
  /** `value` must be JSON-serializable. */
  readonly set: (key: string, value: unknown) => Effect.Effect<void, RepoError>
  readonly remove: (key: string) => Effect.Effect<void, RepoError>
}>()("openbot/core/SettingsRepo") {}

/** The `SettingsRepo` keys that make up `Settings` (one per field). */
export const SETTINGS_KEYS: ReadonlyArray<keyof Settings> = Object.keys(SettingsSchema.fields) as Array<keyof Settings>

const decodeSettings = Schema.decodeUnknownResult(SettingsSchema)
const encodeSettings = Schema.encodeSync(SettingsSchema)

/**
 * Typed settings from raw key/values: decoding defaults fill absent keys; a stored value that no
 * longer decodes (written by another build) is ignored, falling back to its default.
 */
export const settingsFromEntries = (entries: ReadonlyMap<string, unknown>): Settings => {
  const raw: Record<string, unknown> = {}
  for (const key of SETTINGS_KEYS) if (entries.has(key)) raw[key] = entries.get(key)
  const all = decodeSettings(raw)
  if (Result.isSuccess(all)) return all.success
  const valid: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (Result.isSuccess(decodeSettings({ [key]: value }))) valid[key] = value
  }
  const partial = decodeSettings(valid)
  return Result.isSuccess(partial) ? partial.success : DEFAULT_SETTINGS
}

/**
 * Encoded key/values for `settings` (every field; optional fields that are absent map to
 * `undefined`, meaning "remove the key").
 */
export const settingsToEntries = (settings: Settings): ReadonlyArray<readonly [key: keyof Settings, value: unknown]> => {
  const encoded = encodeSettings(settings) as Record<string, unknown>
  return SETTINGS_KEYS.map((key) => [key, encoded[key]] as const)
}

/** Reads the typed `Settings` from `SettingsRepo` (see the storage convention above). */
export const readSettings: Effect.Effect<Settings, RepoError, SettingsRepo> = Effect.flatMap(
  SettingsRepo,
  (repo) => Effect.map(repo.getAll, settingsFromEntries),
)

/** Writes every `Settings` field (removing absent optional keys). */
export const writeSettings = (settings: Settings): Effect.Effect<void, RepoError, SettingsRepo> =>
  Effect.flatMap(SettingsRepo, (repo) =>
    Effect.forEach(
      settingsToEntries(settings),
      ([key, value]) => (value === undefined ? repo.remove(key) : repo.set(key, value)),
      { discard: true },
    ))

// ============================================================================ usage

export const UsageRecord = Schema.Struct({
  botId: BotIdSchema,
  conversationId: Schema.optional(ConversationIdSchema),
  turnId: Schema.optional(TurnIdSchema),
  harness: Schema.optional(HarnessKindNameSchema),
  model: Schema.optional(Schema.String),
  at: MillisSchema,
  usage: UsageSchema,
})
export type UsageRecord = typeof UsageRecord.Type

export interface UsageTotals {
  readonly botId: BotId
  readonly usage: Usage
  /** Number of usage records aggregated. */
  readonly records: number
  /** Number of distinct `turnId`s among them (records without a turn are not counted). */
  readonly turnCount: number
  /** Latest `at` among them. */
  readonly lastAt: Millis
}

export class UsageRepo extends Context.Service<UsageRepo, {
  readonly record: (record: UsageRecord) => Effect.Effect<void, RepoError>
  /** Sum per bot of records with `at >= sinceMs` (all when omitted). Ordered by botId. */
  readonly totalsByBot: (sinceMs?: Millis) => Effect.Effect<ReadonlyArray<UsageTotals>, RepoError>
  readonly list: (filter?: {
    readonly botId?: BotId | undefined
    readonly sinceMs?: Millis | undefined
  }) => Effect.Effect<ReadonlyArray<UsageRecord>, RepoError>
}>()("openbot/core/UsageRepo") {}

// ============================================================================ replica log (resume)

/** Replica keys: `conversation:<id>` or `roster`. */
export type ReplicaKey = `conversation:${string}` | "roster"
export const rosterReplicaKey: ReplicaKey = "roster"
export const conversationReplicaKey = (id: ConversationId): ReplicaKey => `conversation:${id}`

/** Encodable (server-side) change of either replica; persisted as JSON by `ReplicaLog`. */
export const ReplicaChange = Schema.Union([
  Schema.Struct({ replica: Schema.Literal("conversation"), change: KnownConversationChangeSchema }),
  Schema.Struct({ replica: Schema.Literal("roster"), change: KnownRosterChangeSchema }),
])
export type ReplicaChange =
  | { readonly replica: "conversation"; readonly change: KnownConversationChange }
  | { readonly replica: "roster"; readonly change: KnownRosterChange }

export interface ReplicaRecord {
  readonly replicaKey: ReplicaKey
  readonly epoch: string
  readonly sequence: number
  readonly change: ReplicaChange
}

/** Number of changes kept per replica for cursor resume (D4.3). */
export const REPLICA_LOG_WINDOW = 256

export class ReplicaLog extends Context.Service<ReplicaLog, {
  /** Current `{epoch, sequence}`; none for a replica never written. */
  readonly head: (replicaKey: ReplicaKey) => Effect.Effect<Option.Option<StreamCursor>, RepoError>
  /**
   * Appends a change. `record.epoch` must equal the head epoch and `record.sequence` must be
   * `head.sequence + 1` (or the replica is new). Keeps the newest `REPLICA_LOG_WINDOW` records.
   */
  readonly append: (record: ReplicaRecord) => Effect.Effect<void, RepoError>
  /**
   * Records with `sequence > afterSequence` in the current epoch, ascending. None when the epoch
   * differs or the gap is no longer covered by the window (caller sends a snapshot).
   */
  readonly readAfter: (
    replicaKey: ReplicaKey,
    cursor: StreamCursor,
  ) => Effect.Effect<Option.Option<ReadonlyArray<ReplicaRecord>>, RepoError>
  /** Starts a new epoch at sequence 0 and drops the window. */
  readonly reset: (replicaKey: ReplicaKey, epoch: string) => Effect.Effect<void, RepoError>
  /** Forgets a replica entirely (head and window; conversation deleted). */
  readonly drop: (replicaKey: ReplicaKey) => Effect.Effect<void, RepoError>
}>()("openbot/core/ReplicaLog") {}

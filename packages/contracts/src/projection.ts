// Pure client projections of the replica streams (architecture §4.1 projection.ts, D4.3), plus the
// small pure helpers the server-side LiveHub shares (resume decision, live coalescing).
// No Effect, no mutation of inputs: the same code backs atoms on the client and tests on the server.
// Ported from vendor/scratch/contracts/src/projection.ts (ClientReplica -> immutable reducer).
import type { BotId, ConversationId, EntryId, NodeId, RequestId, SectionId, TaskId, TurnId } from "./base.ts"
import type {
  Bot,
  BotActivity,
  Conversation,
  ConversationSummary,
  NodeSummary,
  Notification,
  Section,
  SignInRequest,
} from "./domain.ts"
import type { RuntimeRequest } from "./runtime-request.ts"
import type { Settings } from "./settings.ts"
import type { Task } from "./task.ts"
import type {
  ConversationChange,
  ConversationStreamItem,
  KnownConversationChange,
  RosterChange,
  RosterStreamItem,
  StreamCursor,
  TranscriptPage,
} from "./stream.ts"
import type { TranscriptEntry, Turn } from "./transcript.ts"

// ---------------------------------------------------------------------------- shared constants & helpers
/** Largest gap replayed from the change log before falling back to a snapshot (D4.3). */
export const MAX_REPLAY_GAP = 256
/** Tail window sent in a conversation snapshot (architecture §4.3.6). */
export const SNAPSHOT_TAIL_ENTRIES = 100

/**
 * LiveHub's resume decision for `subscribe({after})`. `oldestBuffered` is the sequence of the oldest
 * change still in the replay buffer (pass `head.sequence + 1` when the buffer is empty).
 * Replay only when the epoch matches, the cursor is not ahead of the head, the gap is at most
 * {@link MAX_REPLAY_GAP}, and every missed change is still buffered.
 */
export const resumePlan = (
  after: StreamCursor | undefined,
  head: StreamCursor,
  oldestBuffered: number,
): "replay" | "snapshot" => {
  if (!after || after.epoch !== head.epoch) return "snapshot"
  if (after.sequence > head.sequence) return "snapshot"
  if (head.sequence - after.sequence > MAX_REPLAY_GAP) return "snapshot"
  if (after.sequence < head.sequence && after.sequence + 1 < oldestBuffered) return "snapshot"
  return "replay"
}

/** Transcript order: createdAt, then id (ids are ULIDs, so ties keep allocation order). */
export const compareEntries = (
  a: { readonly createdAt: number; readonly id: string },
  b: { readonly createdAt: number; readonly id: string },
): number => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Upsert rule shared by server and client: an older revision never replaces a newer one. */
export const shouldReplaceEntry = (prev: TranscriptEntry | undefined, next: TranscriptEntry): boolean =>
  !prev || prev.revision <= next.revision

const isStreamingUpsert = (entry: TranscriptEntry): boolean =>
  ((entry.kind === "message" || entry.kind === "reasoning") && entry.streaming) ||
  (entry.kind === "tool-call" && (entry.status === "pending" || entry.status === "running"))

/**
 * Live coalescing (t3code ThreadLiveEventCoalescer): within one flush window keep only the last
 * upsert per streaming entry. Terminal upserts and every other change are never dropped.
 */
export const coalesce = (changes: ReadonlyArray<KnownConversationChange>): KnownConversationChange[] => {
  const out: Array<KnownConversationChange | undefined> = []
  const lastStreamingAt = new Map<EntryId, number>()
  for (const c of changes) {
    if (c.type === "entry.upserted") {
      const at = lastStreamingAt.get(c.entry.id)
      if (at !== undefined) out[at] = undefined // superseded in-flight update
      if (isStreamingUpsert(c.entry)) lastStreamingAt.set(c.entry.id, out.length)
      else lastStreamingAt.delete(c.entry.id)
    }
    out.push(c)
  }
  return out.filter((c): c is KnownConversationChange => c !== undefined)
}

const follows = (cursor: StreamCursor | undefined, next: StreamCursor): boolean =>
  cursor === undefined || (next.epoch === cursor.epoch && next.sequence === cursor.sequence + 1)

const withSet = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> => new Map(map).set(key, value)
const withDeleted = <K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> => {
  if (!map.has(key)) return map
  const next = new Map(map)
  next.delete(key)
  return next
}
const byKey = <K, V>(values: ReadonlyArray<V>, key: (v: V) => K): ReadonlyMap<K, V> =>
  new Map(values.map((v) => [key(v), v] as const))

// ---------------------------------------------------------------------------- conversation projection
export interface ConversationState {
  readonly conversation: Conversation | undefined
  /** Last applied cursor; resubscribe with `after: cursor` after a disconnect or a gap. */
  readonly cursor: StreamCursor | undefined
  /** True between `synchronized` and the next snapshot/reset. */
  readonly synchronized: boolean
  /** A change arrived out of order: it was NOT applied. Resubscribe with `after: cursor`. */
  readonly gap: boolean
  readonly entries: ReadonlyMap<EntryId, TranscriptEntry>
  readonly requests: ReadonlyMap<RequestId, RuntimeRequest>
  readonly turns: ReadonlyMap<TurnId, Turn>
  readonly hasMoreBefore: boolean
  readonly beforeCursor: string | null
  /** Unknown changes/items from a newer server that were skipped (the cursor still advanced). */
  readonly skippedUnknown: number
}

export const emptyConversationState: ConversationState = {
  conversation: undefined,
  cursor: undefined,
  synchronized: false,
  gap: false,
  entries: new Map(),
  requests: new Map(),
  turns: new Map(),
  hasMoreBefore: false,
  beforeCursor: null,
  skippedUnknown: 0,
}

/** Apply one change (no cursor bookkeeping). Used by the stream reducer and by server-side replicas. */
export const applyConversationChange = (state: ConversationState, change: ConversationChange): ConversationState => {
  switch (change.type) {
    case "entry.upserted":
      return shouldReplaceEntry(state.entries.get(change.entry.id), change.entry)
        ? { ...state, entries: withSet(state.entries, change.entry.id, change.entry) }
        : state
    case "entry.removed":
      return { ...state, entries: withDeleted(state.entries, change.entryId) }
    case "request.upserted":
      return { ...state, requests: withSet(state.requests, change.request.id, change.request) }
    case "turn.upserted":
      return { ...state, turns: withSet(state.turns, change.turn.id, change.turn) }
    case "conversation.updated":
      return { ...state, conversation: change.conversation }
    case "unknown":
      return { ...state, skippedUnknown: state.skippedUnknown + 1 }
  }
}

/** The client reducer for `conversations.subscribe`. */
export const applyConversationStreamItem = (
  state: ConversationState,
  item: ConversationStreamItem,
): ConversationState => {
  switch (item.kind) {
    case "snapshot":
      return {
        conversation: item.conversation,
        cursor: item.cursor,
        synchronized: false,
        gap: false,
        entries: byKey(item.entries, (e) => e.id),
        requests: byKey(item.requests, (r) => r.id),
        turns: byKey(item.turns, (t) => t.id),
        hasMoreBefore: item.hasMoreBefore,
        beforeCursor: item.beforeCursor,
        skippedUnknown: state.skippedUnknown,
      }
    case "change":
      if (!follows(state.cursor, item.cursor)) return state.gap ? state : { ...state, gap: true, synchronized: false }
      return { ...applyConversationChange(state, item.change), cursor: item.cursor, gap: false }
    case "synchronized":
      return { ...state, synchronized: true, cursor: state.cursor ?? item.cursor }
    case "reset":
      return { ...emptyConversationState, conversation: state.conversation, skippedUnknown: state.skippedUnknown }
    case "unknown":
      return {
        ...state,
        skippedUnknown: state.skippedUnknown + 1,
        ...(item.cursor && follows(state.cursor, item.cursor) ? { cursor: item.cursor } : {}),
      }
  }
}

/** Merge an older page from `conversations.history` (keeps the higher revision per entry). */
export const prependHistory = (state: ConversationState, page: TranscriptPage): ConversationState => {
  const entries = new Map(state.entries)
  for (const e of page.entries) if (shouldReplaceEntry(entries.get(e.id), e)) entries.set(e.id, e)
  return { ...state, entries, hasMoreBefore: page.hasMoreBefore, beforeCursor: page.beforeCursor }
}

/** Entries in transcript order. */
export const transcriptOf = (state: Pick<ConversationState, "entries">): TranscriptEntry[] =>
  [...state.entries.values()].sort(compareEntries)

/** Pending requests, oldest first. */
export const pendingRequestsOf = (state: Pick<ConversationState, "requests">): RuntimeRequest[] =>
  [...state.requests.values()].filter((r) => r.status === "pending").sort((a, b) => a.createdAt - b.createdAt)

// ---------------------------------------------------------------------------- roster projection
/** How many recent notifications the roster projection keeps. */
export const ROSTER_NOTIFICATIONS_KEPT = 50

export interface RosterState {
  readonly cursor: StreamCursor | undefined
  readonly synchronized: boolean
  readonly gap: boolean
  readonly bots: ReadonlyMap<BotId, Bot>
  readonly conversations: ReadonlyMap<ConversationId, ConversationSummary>
  readonly activities: ReadonlyMap<BotId, BotActivity>
  readonly nodes: ReadonlyMap<NodeId, NodeSummary>
  readonly sections: ReadonlyMap<SectionId, Section>
  readonly settings: Settings | undefined
  /** Background tasks (D5.7): the active ones plus recently finished ones. */
  readonly tasks: ReadonlyMap<TaskId, Task>
  /** Most recent first. */
  readonly notifications: ReadonlyArray<Notification>
  /** Browsers waiting to be allowed to sign in, by code (`signInRequestsOf` drops the expired ones). */
  readonly signIns: ReadonlyMap<string, SignInRequest>
  readonly skippedUnknown: number
}

/** Tasks kept by the roster reducer (the oldest finished ones are dropped first). */
export const ROSTER_TASKS_KEPT = 200

const withTask = (tasks: ReadonlyMap<TaskId, Task>, task: Task): ReadonlyMap<TaskId, Task> => {
  const next = new Map(tasks).set(task.id, task)
  if (next.size <= ROSTER_TASKS_KEPT) return next
  const finished = [...next.values()]
    .filter((t) => t.status !== "queued" && t.status !== "running")
    .sort((a, b) => (a.endedAt ?? a.updatedAt) - (b.endedAt ?? b.updatedAt))
  for (const t of finished) {
    if (next.size <= ROSTER_TASKS_KEPT) break
    next.delete(t.id)
  }
  return next
}

export const emptyRosterState: RosterState = {
  cursor: undefined,
  synchronized: false,
  gap: false,
  bots: new Map(),
  conversations: new Map(),
  activities: new Map(),
  nodes: new Map(),
  sections: new Map(),
  settings: undefined,
  tasks: new Map(),
  notifications: [],
  signIns: new Map(),
  skippedUnknown: 0,
}

export const applyRosterChange = (state: RosterState, change: RosterChange): RosterState => {
  switch (change.type) {
    case "bot.upserted":
      return { ...state, bots: withSet(state.bots, change.bot.id, change.bot) }
    case "bot.removed": {
      const gone = [...state.tasks.values()].filter((t) => t.botId === change.botId)
      let tasks = state.tasks
      for (const t of gone) tasks = withDeleted(tasks, t.id)
      return {
        ...state,
        bots: withDeleted(state.bots, change.botId),
        activities: withDeleted(state.activities, change.botId),
        tasks,
      }
    }
    case "conversation.upserted":
      return { ...state, conversations: withSet(state.conversations, change.conversation.id, change.conversation) }
    case "conversation.removed":
      return { ...state, conversations: withDeleted(state.conversations, change.conversationId) }
    case "activity.updated":
      return { ...state, activities: withSet(state.activities, change.activity.botId, change.activity) }
    case "node.upserted":
      return { ...state, nodes: withSet(state.nodes, change.node.id, change.node) }
    case "node.removed":
      return { ...state, nodes: withDeleted(state.nodes, change.nodeId) }
    case "section.upserted":
      return { ...state, sections: withSet(state.sections, change.section.id, change.section) }
    case "section.removed":
      return { ...state, sections: withDeleted(state.sections, change.sectionId) }
    case "settings.updated":
      return { ...state, settings: change.settings }
    case "notification":
      return {
        ...state,
        notifications: [change.notification, ...state.notifications].slice(0, ROSTER_NOTIFICATIONS_KEPT),
      }
    case "task.upserted":
      return { ...state, tasks: withTask(state.tasks, change.task) }
    case "task.removed":
      return { ...state, tasks: withDeleted(state.tasks, change.taskId) }
    case "sign-in.requested":
      return { ...state, signIns: withSet(state.signIns, change.request.code, change.request) }
    case "sign-in.ended":
      return { ...state, signIns: withDeleted(state.signIns, change.code) }
    case "away.changed":
      return state
    case "unknown":
      return { ...state, skippedUnknown: state.skippedUnknown + 1 }
  }
}

/** The client reducer for `roster.subscribe`. */
export const applyRosterStreamItem = (state: RosterState, item: RosterStreamItem): RosterState => {
  switch (item.kind) {
    case "snapshot":
      return {
        cursor: item.cursor,
        synchronized: false,
        gap: false,
        bots: byKey(item.bots, (b) => b.id),
        conversations: byKey(item.conversations, (c) => c.id),
        activities: byKey(item.activities, (a) => a.botId),
        nodes: byKey(item.nodes, (n) => n.id),
        sections: byKey(item.sections, (s) => s.id),
        settings: item.settings,
        tasks: byKey(item.tasks ?? [], (t) => t.id),
        notifications: state.notifications,
        signIns: byKey(item.signIns ?? [], (r) => r.code),
        skippedUnknown: state.skippedUnknown,
      }
    case "change":
      if (!follows(state.cursor, item.cursor)) return state.gap ? state : { ...state, gap: true, synchronized: false }
      return { ...applyRosterChange(state, item.change), cursor: item.cursor, gap: false }
    case "synchronized":
      return { ...state, synchronized: true, cursor: state.cursor ?? item.cursor }
    case "unknown":
      return {
        ...state,
        skippedUnknown: state.skippedUnknown + 1,
        ...(item.cursor && follows(state.cursor, item.cursor) ? { cursor: item.cursor } : {}),
      }
  }
}

/** Browsers still waiting to be allowed to sign in, oldest first. */
export const signInRequestsOf = (state: Pick<RosterState, "signIns">, now: number): SignInRequest[] =>
  [...state.signIns.values()].filter((r) => r.expiresAt > now).sort((a, b) => a.at - b.at)

/** A bot's queued and running tasks, oldest first. */
export const activeTasksOf = (state: Pick<RosterState, "tasks">, botId: BotId): Task[] =>
  [...state.tasks.values()]
    .filter((t) => t.botId === botId && (t.status === "queued" || t.status === "running"))
    .sort((a, b) => a.createdAt - b.createdAt)

/** Sections in display order. */
export const sectionsOf = (state: Pick<RosterState, "sections">): Section[] =>
  [...state.sections.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

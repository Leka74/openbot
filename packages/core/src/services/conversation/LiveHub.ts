/**
 * LiveHub (architecture §4.3.6, D4.3): ordered replicas for every conversation and for the roster.
 *
 * - Every change is committed to its repository by the caller first, then appended here:
 *   `sequence++` → `ReplicaLog.append` (durable window of 256) → `PubSub` (live subscribers).
 * - `subscribe*({after})`: subscribe to the PubSub FIRST, then read the head. A matching epoch with a
 *   gap ≤ 256 that the log still covers is replayed from `ReplicaLog`; anything else gets a snapshot
 *   (conversation: tail window + pending/referenced requests + recent turns). Then `synchronized`,
 *   then the live tail filtered to `sequence > last sent`.
 * - `resetConversation` starts a new epoch; live subscribers get `reset`, a fresh snapshot and
 *   `synchronized`.
 * - Activities are in memory only (roster snapshot + `activity.updated`).
 * - `NodeDirectory.changes` is forwarded to the roster for the lifetime of the layer.
 */
import type {
  BotActivity,
  BotId,
  ConversationId,
  KnownConversationChange,
  KnownConversationStreamItem,
  KnownRosterChange,
  KnownRosterStreamItem,
  NotFound,
  RequestId,
  StreamCursor,
} from "@openbot/contracts"
import { MAX_REPLAY_GAP, SNAPSHOT_TAIL_ENTRIES } from "@openbot/contracts"
import { Effect, Layer, Option, PubSub, Semaphore, Stream } from "effect"
import { IdGen } from "../../ports/IdGen.ts"
import { NodeDirectory } from "../../ports/NodeDirectory.ts"
import {
  BotRepo,
  ConversationRepo,
  conversationReplicaKey,
  EntryRepo,
  readSettings,
  type ReplicaChange,
  type ReplicaKey,
  ReplicaLog,
  type ReplicaRecord,
  RequestRepo,
  rosterReplicaKey,
  SectionRepo,
  SettingsRepo,
  TaskRepo,
  TurnRepo,
} from "../../ports/repos.ts"
import { LiveHub } from "../../ports/services.ts"
import { rosterTasks } from "./BackgroundTasks.ts"
import { summarize, visiblePage } from "./internal/summary.ts"
import { cardRequestId, orDie, required } from "./internal/util.ts"

type ResetReason = "new-session" | "rollback" | "rebuild"

/** What travels on the hub's PubSub (one bus for every replica; subscribers filter by key). */
type HubItem =
  | { readonly key: ReplicaKey; readonly kind: "change"; readonly cursor: StreamCursor; readonly change: ReplicaChange }
  | { readonly key: ReplicaKey; readonly kind: "reset"; readonly epoch: string; readonly reason: ResetReason }

/** Most recent turns included in a conversation snapshot. */
const SNAPSHOT_TURNS = 20
/** Upper bound for a client-requested `tailLimit`. */
const MAX_TAIL_LIMIT = 500

const sameActivity = (a: BotActivity | undefined, b: BotActivity): boolean =>
  a !== undefined && a.state === b.state && a.label === b.label && a.toolKind === b.toolKind &&
  a.conversationId === b.conversationId

export const LiveHubLive: Layer.Layer<
  LiveHub,
  never,
  | ReplicaLog
  | ConversationRepo
  | EntryRepo
  | RequestRepo
  | TurnRepo
  | BotRepo
  | SectionRepo
  | SettingsRepo
  | TaskRepo
  | NodeDirectory
  | IdGen
> = Layer.effect(
  LiveHub,
  Effect.gen(function*() {
    const log = yield* ReplicaLog
    const conversations = yield* ConversationRepo
    const requests = yield* RequestRepo
    const turns = yield* TurnRepo
    const bots = yield* BotRepo
    const sections = yield* SectionRepo
    const taskRepo = yield* TaskRepo
    const directory = yield* NodeDirectory
    const ids = yield* IdGen
    const repos = yield* Effect.context<EntryRepo | RequestRepo | SettingsRepo | TurnRepo>()

    const lock = yield* Semaphore.make(1)
    const heads = new Map<ReplicaKey, StreamCursor>()
    const activities = new Map<BotId, BotActivity>()
    const pubsub = yield* PubSub.unbounded<HubItem>()
    yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub))

    // ------------------------------------------------------------------ heads (call under `lock`)

    const initialEpoch = (key: ReplicaKey): Effect.Effect<string> =>
      key === rosterReplicaKey
        ? ids.next("epc")
        : Effect.gen(function*() {
          const id = key.slice("conversation:".length) as ConversationId
          const conversation = yield* orDie(conversations.get(id))
          return Option.isSome(conversation) ? conversation.value.epoch : yield* ids.next("epc")
        })

    const headUnlocked = (key: ReplicaKey): Effect.Effect<StreamCursor> =>
      Effect.gen(function*() {
        const cached = heads.get(key)
        if (cached !== undefined) return cached
        const stored = yield* orDie(log.head(key))
        const head: StreamCursor = Option.isSome(stored) ? stored.value : { epoch: yield* initialEpoch(key), sequence: 0 }
        heads.set(key, head)
        return head
      })

    const head = (key: ReplicaKey) => lock.withPermits(1)(headUnlocked(key))

    const resetUnlocked = (key: ReplicaKey, reason: ResetReason): Effect.Effect<string> =>
      Effect.gen(function*() {
        const epoch = yield* ids.next("epc")
        yield* log.reset(key, epoch).pipe(
          Effect.catchCause((cause) => Effect.logError("LiveHub: ReplicaLog.reset failed", cause)),
        )
        heads.set(key, { epoch, sequence: 0 })
        yield* PubSub.publish(pubsub, { key, kind: "reset", epoch, reason })
        return epoch
      })

    /** sequence++ → ReplicaLog → PubSub, serialized so the bus order is the sequence order. */
    const append = (key: ReplicaKey, change: ReplicaChange): Effect.Effect<StreamCursor> =>
      lock.withPermits(1)(
        Effect.gen(function*() {
          const current = yield* headUnlocked(key)
          const cursor: StreamCursor = { epoch: current.epoch, sequence: current.sequence + 1 }
          const record: ReplicaRecord = { replicaKey: key, epoch: cursor.epoch, sequence: cursor.sequence, change }
          const appended = yield* log.append(record).pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logError(`LiveHub: ReplicaLog.append failed for ${key}; rebuilding the replica`, cause).pipe(
                Effect.as(false),
              )
            ),
          )
          if (!appended) {
            // The change is committed in its repository; a new epoch makes every client re-snapshot.
            const epoch = yield* resetUnlocked(key, "rebuild")
            return { epoch, sequence: 0 }
          }
          heads.set(key, cursor)
          yield* PubSub.publish(pubsub, { key, kind: "change", cursor, change })
          return cursor
        }),
      )

    const publishRoster = (change: KnownRosterChange) => append(rosterReplicaKey, { replica: "roster", change })

    // ------------------------------------------------------------------ snapshots

    const conversationSnapshot = (
      conversationId: ConversationId,
      cursor: StreamCursor,
      tailLimit: number | undefined,
    ) =>
      Effect.gen(function*() {
        const conversation = yield* required(conversations.get(conversationId), "conversation", conversationId)
        const limit = Math.min(Math.max(1, Math.floor(tailLimit ?? SNAPSHOT_TAIL_ENTRIES)), MAX_TAIL_LIMIT)
        const page = yield* orDie(Effect.provide(visiblePage({ conversationId, limit }), repos))
        const window = page.entries.filter((e) => e.kind !== "unknown")
        const referenced = new Set<RequestId>()
        for (const entry of window) {
          if (entry.kind !== "card") continue
          const id = cardRequestId(entry.card)
          if (id !== undefined) referenced.add(id)
        }
        const allRequests = yield* orDie(requests.list({ conversationId }))
        const recentTurns = yield* orDie(turns.listByConversation(conversationId, SNAPSHOT_TURNS))
        const item: KnownConversationStreamItem = {
          kind: "snapshot",
          cursor,
          conversation: { ...conversation, epoch: cursor.epoch },
          entries: window,
          requests: allRequests.filter((r) => r.status === "pending" || referenced.has(r.id)),
          turns: recentTurns,
          hasMoreBefore: page.hasMoreBefore,
          beforeCursor: page.beforeCursor,
        }
        return item
      })

    const rosterSnapshot = (cursor: StreamCursor) =>
      Effect.gen(function*() {
        const allBots = yield* orDie(bots.list)
        const botIds = new Set(allBots.map((b) => b.id))
        const allConversations = yield* orDie(conversations.list())
        const summaries = yield* Effect.forEach(allConversations, (c) => Effect.provide(summarize(c), repos))
        const nodes = yield* directory.list
        const allSections = yield* orDie(sections.list)
        const settings = yield* Effect.provide(orDie(readSettings), repos)
        const tasks = (yield* orDie(rosterTasks(taskRepo))).filter((t) => botIds.has(t.botId))
        const item: KnownRosterStreamItem = {
          kind: "snapshot",
          cursor,
          bots: allBots,
          conversations: summaries,
          activities: [...activities.values()].filter((a) => botIds.has(a.botId)),
          nodes,
          sections: allSections,
          settings,
          tasks,
        }
        return item
      })

    // ------------------------------------------------------------------ resume

    /** Replayable records after `after`, or none (→ snapshot). */
    const replayFor = (key: ReplicaKey, after: StreamCursor | undefined, current: StreamCursor) =>
      Effect.gen(function*() {
        if (after === undefined || after.epoch !== current.epoch) return Option.none<ReadonlyArray<ReplicaRecord>>()
        if (after.sequence > current.sequence || current.sequence - after.sequence > MAX_REPLAY_GAP) {
          return Option.none<ReadonlyArray<ReplicaRecord>>()
        }
        return yield* orDie(log.readAfter(key, after))
      })

    /**
     * The common subscribe skeleton: catch-up items (replay or snapshot) + `synchronized`, then the
     * live tail. `onLive` maps one bus item to the items to emit, given the last sent cursor.
     */
    const subscribe = <Item, E>(options: {
      readonly key: ReplicaKey
      readonly after: StreamCursor | undefined
      readonly preflight: Effect.Effect<void, E>
      readonly snapshot: (cursor: StreamCursor) => Effect.Effect<Item, E>
      readonly toChange: (record: { readonly cursor: StreamCursor; readonly change: ReplicaChange }) => Item | undefined
      readonly synchronized: (cursor: StreamCursor) => Item
      readonly onReset: (epoch: string, reason: ResetReason) => ReadonlyArray<Item>
    }): Stream.Stream<Item, E> =>
      Stream.unwrap(
        Effect.gen(function*() {
          // Subscribe BEFORE reading the head: nothing published after the head read can be missed.
          const subscription = yield* PubSub.subscribe(pubsub)
          yield* options.preflight
          const current = yield* head(options.key)
          let last = current
          const initial: Array<Item> = []
          const replay = yield* replayFor(options.key, options.after, current)
          if (Option.isSome(replay)) {
            for (const record of replay.value) {
              const cursor = { epoch: record.epoch, sequence: record.sequence }
              const item = options.toChange({ cursor, change: record.change })
              if (item !== undefined) initial.push(item)
              if (record.sequence > last.sequence) last = cursor
            }
          } else {
            initial.push(yield* options.snapshot(current))
          }
          initial.push(options.synchronized(last))

          const onItem = (item: HubItem): Effect.Effect<ReadonlyArray<Item>, E> => {
            if (item.key !== options.key) return Effect.succeed([])
            if (item.kind === "change") {
              if (item.cursor.epoch !== last.epoch || item.cursor.sequence <= last.sequence) return Effect.succeed([])
              last = item.cursor
              const mapped = options.toChange(item)
              return Effect.succeed(mapped === undefined ? [] : [mapped])
            }
            return Effect.gen(function*() {
              const fresh = yield* head(options.key)
              last = fresh
              const snapshot = yield* options.snapshot(fresh)
              return [...options.onReset(item.epoch, item.reason), snapshot, options.synchronized(fresh)]
            })
          }
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.flatMap((item) => Stream.fromIterableEffect(onItem(item))),
          )
          return Stream.concat(Stream.fromIterable(initial), live)
        }),
      )

    return LiveHub.of({
      publishConversation: (conversationId, change: KnownConversationChange) =>
        append(conversationReplicaKey(conversationId), { replica: "conversation", change }),

      publishRoster,

      subscribeConversation: ({ after, conversationId, tailLimit }) =>
        subscribe<KnownConversationStreamItem, NotFound>({
          key: conversationReplicaKey(conversationId),
          after,
          preflight: Effect.asVoid(required(conversations.get(conversationId), "conversation", conversationId)),
          snapshot: (cursor) => conversationSnapshot(conversationId, cursor, tailLimit),
          toChange: ({ change, cursor }) => (change.replica === "conversation" ? { kind: "change", cursor, change: change.change } : undefined),
          synchronized: (cursor) => ({ kind: "synchronized", cursor }),
          onReset: (epoch, reason) => [{ kind: "reset", epoch, reason }],
        }),

      subscribeRoster: ({ after }) =>
        subscribe<KnownRosterStreamItem, never>({
          key: rosterReplicaKey,
          after,
          preflight: Effect.void,
          snapshot: rosterSnapshot,
          toChange: ({ change, cursor }) => (change.replica === "roster" ? { kind: "change", cursor, change: change.change } : undefined),
          synchronized: (cursor) => ({ kind: "synchronized", cursor }),
          // The roster stream has no `reset` item: a fresh snapshot replaces the client state.
          onReset: () => [],
        }),

      resetConversation: (conversationId, reason) =>
        lock.withPermits(1)(resetUnlocked(conversationReplicaKey(conversationId), reason)),

      activities: Effect.sync(() => [...activities.values()]),

      setActivity: (activity) =>
        Effect.gen(function*() {
          if (sameActivity(activities.get(activity.botId), activity)) return
          activities.set(activity.botId, activity)
          yield* publishRoster({ type: "activity.updated", activity })
        }),
    })
  }).pipe(
    // Forward node list changes into the roster for the lifetime of the layer (D: §8.6).
    Effect.tap((hub) =>
      Effect.gen(function*() {
        const directory = yield* NodeDirectory
        yield* Effect.forkScoped(
          Stream.runForEach(directory.changes, (change) => Effect.asVoid(hub.publishRoster(change))),
          { startImmediately: true },
        )
      })
    ),
  ),
)

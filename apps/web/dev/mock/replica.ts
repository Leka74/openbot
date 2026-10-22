// DEV MOCK ONLY: in-memory replicas that follow LiveHub's rules (architecture §4.3.6): a sequence
// per replica, a ring buffer of the last 256 changes, `resumePlan` for replay vs snapshot, commit
// before publish, and "subscribe to the live tail before reading the head".
import { Effect, PubSub, Stream } from "effect"
import {
  applyConversationChange,
  applyRosterChange,
  compareEntries,
  type Conversation,
  type ConversationState,
  DEFAULT_SETTINGS,
  emptyConversationState,
  emptyRosterState,
  type KnownConversationChange,
  type KnownConversationStreamItem,
  type KnownRosterChange,
  type KnownRosterStreamItem,
  type KnownTranscriptEntry,
  MAX_REPLAY_GAP,
  type RosterState,
  resumePlan,
  type RuntimeRequest,
  type StreamCursor,
  type Turn,
} from "@openbot/contracts"
import { snapshotTail } from "./search.ts"

type ConversationChangeItem = Extract<KnownConversationStreamItem, { kind: "change" }>
type RosterChangeItem = Extract<KnownRosterStreamItem, { kind: "change" }>

class Replica<State, Change, Item extends { readonly cursor: StreamCursor }> {
  sequence = 0
  readonly log: Item[] = []
  readonly pubsub = Effect.runSync(PubSub.unbounded<Item>())
  constructor(
    public epoch: string,
    public state: State,
    private readonly reduce: (s: State, c: Change) => State,
    private readonly item: (cursor: StreamCursor, c: Change) => Item,
  ) {}
  get head(): StreamCursor {
    return { epoch: this.epoch, sequence: this.sequence }
  }
  get oldestBuffered(): number {
    return this.log[0]?.cursor.sequence ?? this.sequence + 1
  }
  apply(change: Change): Item {
    this.state = this.reduce(this.state, change)
    const item = this.item({ epoch: this.epoch, sequence: ++this.sequence }, change)
    this.log.push(item)
    if (this.log.length > MAX_REPLAY_GAP) this.log.shift()
    PubSub.publishUnsafe(this.pubsub, item)
    return item
  }
}

export class ConversationReplica extends Replica<ConversationState, KnownConversationChange, ConversationChangeItem> {
  constructor(conversation: Conversation) {
    super(conversation.epoch, { ...emptyConversationState, conversation }, applyConversationChange, (cursor, change): ConversationChangeItem => ({ kind: "change", cursor, change }))
  }
  get conversation(): Conversation {
    return this.state.conversation as Conversation
  }
  get entries(): KnownTranscriptEntry[] {
    return [...this.state.entries.values()].sort(compareEntries) as KnownTranscriptEntry[]
  }
  get requests(): RuntimeRequest[] {
    return [...this.state.requests.values()]
  }
  get turns(): Turn[] {
    return [...this.state.turns.values()]
  }
  /** The newest entries only (older ones page in with `conversations.history`), like LiveHub. */
  snapshot(): Extract<KnownConversationStreamItem, { kind: "snapshot" }> {
    const tail = snapshotTail(this.entries)
    return {
      kind: "snapshot",
      cursor: this.head,
      conversation: this.conversation,
      entries: tail.entries as KnownTranscriptEntry[],
      requests: this.requests,
      turns: this.turns,
      hasMoreBefore: tail.hasMoreBefore,
      beforeCursor: tail.beforeCursor,
    }
  }
}

export class RosterReplica extends Replica<RosterState, KnownRosterChange, RosterChangeItem> {
  constructor() {
    super("r1", { ...emptyRosterState, settings: DEFAULT_SETTINGS }, applyRosterChange, (cursor, change): RosterChangeItem => ({ kind: "change", cursor, change }))
  }
  snapshot(): Extract<KnownRosterStreamItem, { kind: "snapshot" }> {
    const s = this.state
    return {
      kind: "snapshot",
      cursor: this.head,
      bots: [...s.bots.values()],
      conversations: [...s.conversations.values()],
      activities: [...s.activities.values()],
      nodes: [...s.nodes.values()],
      sections: [...s.sections.values()],
      settings: s.settings ?? DEFAULT_SETTINGS,
    } as Extract<KnownRosterStreamItem, { kind: "snapshot" }>
  }
}

/** Replay-or-snapshot, then live. */
export const subscribeTo = <Item extends { readonly kind: string; readonly cursor?: StreamCursor }>(
  replica: Replica<any, any, any>,
  after: StreamCursor | undefined,
  snapshot: () => Item,
): Stream.Stream<Item> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const sub = yield* PubSub.subscribe(replica.pubsub)
      const head = replica.head
      const plan = resumePlan(after, head, replica.oldestBuffered)
      const backlog: Item[] = plan === "replay" ? (replica.log.filter((i: { cursor: StreamCursor }) => i.cursor.sequence > after!.sequence) as Item[]) : [snapshot()]
      const synchronized = { kind: "synchronized", cursor: head } as unknown as Item
      const live = Stream.fromSubscription(sub).pipe(Stream.filter((i: Item) => (i.cursor?.sequence ?? 0) > head.sequence))
      return Stream.concat(Stream.fromIterable([...backlog, synchronized]), live as Stream.Stream<Item>)
    }),
  )

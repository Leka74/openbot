// TEST HELPER ONLY: an in-process brain that serves `OpenBotRpcs` over a real Bun WebSocket
// (`RpcServer.layerHttp` + `BunHttpServer`, RpcSerialization.layerJson), with fake handlers and
// in-memory replicas that follow LiveHub's rules (architecture §4.3.6): sequence per replica, ring
// buffer of the last 256 changes, `resumePlan` for replay vs snapshot, write before publish, and
// "subscribe to the live tail before reading the head". Plus a WebSocket proxy that can drop every
// connection and refuse new ones, to simulate network loss without restarting the brain.
import { BunHttpServer } from "@effect/platform-bun"
import { Effect, Layer, ManagedRuntime, PubSub, Stream } from "effect"
import {
  MAIN_PROFILE_ID,
  applyConversationChange,
  applyRosterChange,
  type Attachment,
  type AttachmentId,
  type Bot,
  type BotId,
  compareEntries,
  type Conversation,
  type ConversationId,
  type ConversationState,
  DEFAULT_SETTINGS,
  emptyConversationState,
  emptyRosterState,
  type EntryId,
  Internal,
  InvalidInput,
  type KnownConversationChange,
  type KnownConversationStreamItem,
  type KnownRosterChange,
  type KnownRosterStreamItem,
  type KnownTranscriptEntry,
  MAX_REPLAY_GAP,
  NotFound,
  OpenBotRpcs,
  type RosterState,
  resumePlan,
  type SendInput,
  type SendResult,
  type Settings,
  type StreamCursor,
  type TurnId,
  type UserId,
} from "@openbot/contracts"
import { HttpRouter, HttpServer } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"

// ---------------------------------------------------------------------------- fixtures
export const conversationFixture = (id: string, botId: string, epoch = "e1"): Conversation => ({
  id: id as ConversationId,
  kind: "direct",
  botId: botId as BotId,
  title: "Scout",
  createdAt: 0,
  lastActivityAt: 0,
  unreadCount: 0,
  hiddenFromSidebar: false,
  epoch,
})

export const botFixture = (id: string, name: string, conversationId: string): Bot => ({
  id: id as BotId,
  ownerProfileId: MAIN_PROFILE_ID,
  name,
  avatar: { shape: "blob", color: "blue" },
  harness: { kind: "fake" },
  hostNodeId: "node_local" as Bot["hostNodeId"],
  boundNodeIds: [],
  instructions: "",
  directConversationId: conversationId as ConversationId,
  pinned: false,
  hidden: false,
  notify: "all",
  autonomy: "workspace",
  projectFolders: [],
  skills: [],
  createdAt: 0,
  updatedAt: 0,
})

export const messageFixture = (
  conversationId: string,
  id: string,
  createdAt: number,
  text: string,
  options: { revision?: number; role?: "user" | "bot"; clientNonce?: string } = {},
): KnownTranscriptEntry => ({
  id: id as EntryId,
  conversationId: conversationId as ConversationId,
  revision: options.revision ?? 0,
  createdAt,
  updatedAt: createdAt,
  author:
    options.role === "user"
      ? { kind: "user", userId: "usr_owner" as UserId }
      : { kind: "bot", botId: "bot_1" as BotId },
  kind: "message",
  role: options.role ?? "bot",
  text,
  attachments: [],
  streaming: false,
  ...(options.clientNonce !== undefined ? { clientNonce: options.clientNonce, delivery: "accepted" as const } : {}),
})

// ---------------------------------------------------------------------------- replicas
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
  /** Commit, then publish (LiveHub order). */
  apply(change: Change): Item {
    this.state = this.reduce(this.state, change)
    const item = this.item({ epoch: this.epoch, sequence: ++this.sequence }, change)
    this.log.push(item)
    if (this.log.length > MAX_REPLAY_GAP) this.log.shift()
    PubSub.publishUnsafe(this.pubsub, item)
    return item
  }
}

class ConversationReplica extends Replica<ConversationState, KnownConversationChange, ConversationChangeItem> {
  constructor(conversation: Conversation) {
    super(
      conversation.epoch,
      { ...emptyConversationState, conversation },
      applyConversationChange,
      (cursor, change): ConversationChangeItem => ({ kind: "change", cursor, change }),
    )
  }
  snapshot(): Extract<KnownConversationStreamItem, { kind: "snapshot" }> {
    const all = [...this.state.entries.values()].sort(compareEntries) as KnownTranscriptEntry[]
    return {
      kind: "snapshot",
      cursor: this.head,
      conversation: this.state.conversation as Conversation,
      entries: all,
      requests: [],
      turns: [],
      hasMoreBefore: false,
      beforeCursor: null,
    }
  }
}

class RosterReplica extends Replica<RosterState, KnownRosterChange, RosterChangeItem> {
  constructor() {
    super(
      "r1",
      { ...emptyRosterState, settings: DEFAULT_SETTINGS },
      applyRosterChange,
      (cursor, change): RosterChangeItem => ({ kind: "change", cursor, change }),
    )
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
    }
  }
}

/** Replay-or-snapshot, then live: subscribe to the tail BEFORE reading the head (no gap possible). */
const subscribeTo = <Item extends { readonly kind: string; readonly cursor?: StreamCursor }>(
  replica: Replica<any, any, any>,
  after: StreamCursor | undefined,
  snapshot: () => Item,
  onPlan: (plan: "replay" | "snapshot") => void,
): Stream.Stream<Item> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const sub = yield* PubSub.subscribe(replica.pubsub)
      const head = replica.head
      const plan = resumePlan(after, head, replica.oldestBuffered)
      onPlan(plan)
      const backlog: Item[] =
        plan === "replay"
          ? (replica.log.filter((i: { cursor: StreamCursor }) => i.cursor.sequence > after!.sequence) as Item[])
          : [snapshot()]
      const synchronized = { kind: "synchronized", cursor: head } as unknown as Item
      const live = Stream.fromSubscription(sub).pipe(
        Stream.filter((i: Item) => (i.cursor?.sequence ?? 0) > head.sequence),
      )
      return Stream.concat(Stream.fromIterable([...backlog, synchronized]), live as Stream.Stream<Item>)
    }),
  )

// ---------------------------------------------------------------------------- the fake brain
export interface SubscribeLog {
  readonly rpc: "roster.subscribe" | "conversations.subscribe"
  readonly after: StreamCursor | undefined
  readonly plan: "replay" | "snapshot"
}

export class FakeBrain {
  readonly roster = new RosterReplica()
  readonly conversations = new Map<string, ConversationReplica>()
  readonly subscribes: SubscribeLog[] = []
  readonly calls: Array<{ readonly tag: string; readonly payload: unknown }> = []
  readonly sends = new Map<string, SendResult>()
  readonly uploads: Array<{ readonly name: string; readonly mime: string; readonly bytes: Uint8Array }> = []
  settings: Settings = DEFAULT_SETTINGS
  private nextId = 0
  /** Set to fail the next `messages.send` with Internal (once). */
  failNextSend = false

  addConversation(conversation: Conversation): ConversationReplica {
    const replica = new ConversationReplica(conversation)
    this.conversations.set(conversation.id, replica)
    return replica
  }

  conversation(id: string): ConversationReplica {
    const r = this.conversations.get(id)
    if (!r) throw new Error(`no conversation ${id}`)
    return r
  }

  private id(prefix: string): string {
    return `${prefix}_${String(++this.nextId).padStart(4, "0")}`
  }

  private send(input: SendInput): Effect.Effect<SendResult, NotFound | Internal> {
    return Effect.suspend((): Effect.Effect<SendResult, NotFound | Internal> => {
      const replica = this.conversations.get(input.conversationId)
      if (!replica) return Effect.fail(new NotFound({ entity: "conversation", id: input.conversationId }))
      const prior = this.sends.get(input.clientNonce)
      if (prior) return Effect.succeed({ ...prior, disposition: "duplicate" as const })
      if (this.failNextSend) {
        this.failNextSend = false
        return Effect.fail(new Internal({ message: "boom" }))
      }
      const entryId = this.id("ent") as EntryId
      replica.apply({
        type: "entry.upserted",
        entry: messageFixture(input.conversationId, entryId, 1_000_000 + this.nextId, input.text, {
          role: "user",
          clientNonce: input.clientNonce,
        }),
      })
      const result: SendResult = { entryId, turnIds: [this.id("trn") as TurnId], disposition: "started" }
      this.sends.set(input.clientNonce, result)
      return Effect.succeed(result)
    })
  }

  handlers(): Record<string, (payload: any) => unknown> {
    const record = (tag: string, payload: unknown) => this.calls.push({ tag, payload })
    const handlers: Record<string, (payload: any) => unknown> = {
      "roster.subscribe": ({ after }: { after?: StreamCursor }) => {
        record("roster.subscribe", { after })
        return subscribeTo<KnownRosterStreamItem>(
          this.roster,
          after,
          () => this.roster.snapshot(),
          (plan) => this.subscribes.push({ rpc: "roster.subscribe", after, plan }),
        )
      },
      "conversations.subscribe": ({ conversationId, after }: { conversationId: string; after?: StreamCursor }) => {
        record("conversations.subscribe", { conversationId, after })
        const replica = this.conversations.get(conversationId)
        if (!replica) return Stream.fail(new NotFound({ entity: "conversation", id: conversationId }))
        return subscribeTo<KnownConversationStreamItem>(
          replica,
          after,
          () => replica.snapshot(),
          (plan) => this.subscribes.push({ rpc: "conversations.subscribe", after, plan }),
        )
      },
      "messages.send": (input: SendInput) => {
        record("messages.send", input)
        return this.send(input)
      },
      "settings.get": () => {
        record("settings.get", undefined)
        return Effect.succeed(this.settings)
      },
      "settings.update": ({ patch }: { patch: Partial<Settings> }) => {
        record("settings.update", { patch })
        return Effect.sync(() => {
          this.settings = { ...this.settings, ...patch } as Settings
          this.roster.apply({ type: "settings.updated", settings: this.settings })
          return this.settings
        })
      },
      "attachments.upload": ({ name, mime, bytesBase64 }: { name: string; mime: string; bytesBase64: string }) => {
        record("attachments.upload", { name, mime })
        const bytes = Uint8Array.from(Buffer.from(bytesBase64, "base64"))
        if (bytes.byteLength === 0) return Effect.fail(new InvalidInput({ message: "empty" }))
        this.uploads.push({ name, mime, bytes })
        const id = this.id("att") as AttachmentId
        const attachment: Attachment = { id, name, mime, byteSize: bytes.byteLength, url: `/api/attachments/${id}` }
        return Effect.succeed(attachment)
      },
    }
    for (const tag of OpenBotRpcs.requests.keys()) {
      if (!(tag in handlers)) {
        handlers[tag] = (payload: unknown) => {
          record(tag, payload)
          return Effect.fail(new Internal({ message: `${tag} not implemented in the fake brain` }))
        }
      }
    }
    return handlers
  }
}

// ---------------------------------------------------------------------------- server + proxy
export interface RunningBrain {
  readonly url: string
  readonly port: number
  readonly stop: () => Promise<void>
}

export const startBrain = async (brain: FakeBrain): Promise<RunningBrain> => {
  const Handlers = OpenBotRpcs.toLayer(brain.handlers() as any)
  const RpcLive = RpcServer.layerHttp({
    group: OpenBotRpcs,
    path: "/rpc",
    protocol: "websocket",
    disableFatalDefects: true,
  }).pipe(Layer.provide(Handlers), Layer.provide(RpcSerialization.layerJson))
  const ServerLive = HttpRouter.serve(RpcLive, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(BunHttpServer.layer({ port: 0, hostname: "127.0.0.1", idleTimeout: 0 })),
  )
  const runtime = ManagedRuntime.make(ServerLive as Layer.Layer<HttpServer.HttpServer, unknown>)
  const server = await runtime.runPromise(HttpServer.HttpServer)
  const address = server.address as { readonly _tag: string; readonly port: number }
  return {
    port: address.port,
    url: `ws://127.0.0.1:${address.port}/rpc`,
    stop: async () => {
      await Promise.race([runtime.dispose(), Bun.sleep(1000)])
    },
  }
}

interface ProxyData {
  upstream: WebSocket | undefined
  pending: Array<string | ArrayBuffer>
}

/** A WebSocket proxy in front of the brain that can cut every link and refuse new ones. */
export class FlakyProxy {
  private readonly server: ReturnType<typeof Bun.serve<ProxyData>>
  private readonly sockets = new Set<Bun.ServerWebSocket<ProxyData>>()
  online = true
  connects = 0

  constructor(upstreamUrl: string) {
    this.server = Bun.serve<ProxyData>({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, server) => {
        if (!this.online) return new Response("offline", { status: 503 })
        if (server.upgrade(req, { data: { upstream: undefined, pending: [] } })) return undefined
        return new Response("upgrade required", { status: 426 })
      },
      websocket: {
        open: (ws) => {
          this.connects++
          this.sockets.add(ws)
          const upstream = new WebSocket(upstreamUrl)
          upstream.binaryType = "arraybuffer"
          ws.data.upstream = upstream
          upstream.onopen = () => {
            for (const m of ws.data.pending) upstream.send(m)
            ws.data.pending = []
          }
          upstream.onmessage = (e) => {
            if (ws.readyState === 1)
              ws.send(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer))
          }
          upstream.onclose = () => {
            if (ws.readyState === 1) ws.close(4001, "upstream closed")
          }
        },
        message: (ws, message) => {
          const up = ws.data.upstream
          const data = typeof message === "string" ? message : (new Uint8Array(message).slice().buffer as ArrayBuffer)
          if (up && up.readyState === 1) up.send(data)
          else ws.data.pending.push(data)
        },
        close: (ws) => {
          this.sockets.delete(ws)
          ws.data.upstream?.close()
        },
      },
    })
  }

  get url(): string {
    return `ws://127.0.0.1:${this.server.port}/rpc`
  }

  /** Cut every open link (the client sees an abnormal close) and keep refusing new ones until `restore`. */
  cut(): void {
    this.online = false
    for (const ws of this.sockets) {
      ws.data.upstream?.close()
      ws.close(4000, "link cut")
    }
    this.sockets.clear()
  }

  restore(): void {
    this.online = true
  }

  stop(): void {
    this.cut()
    this.server.stop(true)
  }
}

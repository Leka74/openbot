import { describe, expect, test } from "bun:test"
import type {
  ConversationId,
  KnownConversationStreamItem,
  KnownRosterStreamItem,
  StreamCursor,
} from "@openbot/contracts"
import { MAX_REPLAY_GAP } from "@openbot/contracts"
import { Effect, Layer, Stream } from "effect"
import { BotRepo, ConversationRepo, LiveHub } from "../../src/ports/index.ts"
import { LiveHubLive } from "../../src/services/conversation/index.ts"
import {
  makeBot,
  botId,
  conversationId,
  makeDirectConversation,
  makeTurn,
  NodeDirectoryFake,
  remoteNodeSummary,
  runTest,
  TestPorts,
  turnId,
} from "../../src/testing/index.ts"
import { collect, eventually } from "./helpers.ts"

const CONV = conversationId("cnv_live")
const layer = () => LiveHubLive.pipe(Layer.provideMerge(TestPorts()))

const seedConversation = Effect.flatMap(ConversationRepo, (repo) =>
  Effect.orDie(repo.upsert(makeDirectConversation({ id: CONV, botId: botId("bot_live"), epoch: "epc_initial" }))),
)

/** Publishes `n` turn changes; returns the last cursor. */
const publishTurns = (conversation: ConversationId, n: number) =>
  Effect.gen(function* () {
    const hub = yield* LiveHub
    let last: StreamCursor | undefined
    for (let i = 1; i <= n; i++) {
      last = yield* hub.publishConversation(conversation, {
        type: "turn.upserted",
        turn: makeTurn({ id: turnId(`trn_${i}`), conversationId: conversation }),
      })
    }
    return last!
  })

const firstItems = (input: { readonly after?: StreamCursor; readonly tailLimit?: number }, n: number) =>
  Effect.flatMap(LiveHub, (hub) =>
    Stream.runCollect(hub.subscribeConversation({ conversationId: CONV, ...input }).pipe(Stream.take(n))),
  )

const kinds = (items: ReadonlyArray<KnownConversationStreamItem>) => items.map((i) => i.kind)

describe("LiveHub conversation resume", () => {
  test("a fresh subscriber gets snapshot + synchronized; the epoch comes from the conversation", async () => {
    const items = await runTest(
      Effect.gen(function* () {
        yield* seedConversation
        yield* publishTurns(CONV, 3)
        return yield* firstItems({}, 2)
      }),
      layer(),
    )
    expect(kinds(items)).toEqual(["snapshot", "synchronized"])
    const snapshot = items[0]!
    if (snapshot.kind !== "snapshot") throw new Error("expected a snapshot")
    expect(snapshot.cursor).toEqual({ epoch: "epc_initial", sequence: 3 })
    expect(snapshot.conversation.epoch).toBe("epc_initial")
    expect(snapshot.entries).toEqual([])
    expect(items[1]).toEqual({ kind: "synchronized", cursor: { epoch: "epc_initial", sequence: 3 } })
  })

  test("a gap of at most 256 is replayed from the log (no snapshot)", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seedConversation
        const head = yield* publishTurns(CONV, 300)
        const small = yield* firstItems({ after: { epoch: head.epoch, sequence: 290 } }, 11)
        const exact = yield* firstItems(
          { after: { epoch: head.epoch, sequence: 300 - MAX_REPLAY_GAP } },
          MAX_REPLAY_GAP + 1,
        )
        const upToDate = yield* firstItems({ after: head }, 1)
        return { small, exact, upToDate }
      }),
      layer(),
    )
    expect(kinds(out.small)).toEqual([...Array(10).fill("change"), "synchronized"])
    expect(out.small.flatMap((i) => (i.kind === "change" ? [i.cursor.sequence] : []))).toEqual(
      Array.from({ length: 10 }, (_, i) => 291 + i),
    )
    expect(out.exact[0]).toMatchObject({ kind: "change", cursor: { sequence: 300 - MAX_REPLAY_GAP + 1 } })
    expect(out.exact.at(-1)).toMatchObject({ kind: "synchronized", cursor: { sequence: 300 } })
    expect(kinds(out.upToDate)).toEqual(["synchronized"])
  })

  test("a gap over 256, a stale epoch or a cursor ahead of the head gets a snapshot", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seedConversation
        const head = yield* publishTurns(CONV, 300)
        return {
          tooFar: yield* firstItems(
            { after: { epoch: head.epoch, sequence: 300 - MAX_REPLAY_GAP - 1 }, tailLimit: 5 },
            2,
          ),
          staleEpoch: yield* firstItems({ after: { epoch: "epc_other", sequence: 299 } }, 2),
          ahead: yield* firstItems({ after: { epoch: head.epoch, sequence: 301 } }, 2),
        }
      }),
      layer(),
    )
    for (const items of [out.tooFar, out.staleEpoch, out.ahead]) {
      expect(kinds(items)).toEqual(["snapshot", "synchronized"])
      expect(items[0]!.kind === "snapshot" && items[0]!.cursor.sequence).toBe(300)
    }
  })

  test("resetConversation: live subscribers get reset + snapshot + synchronized; old cursors re-snapshot", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const hub = yield* LiveHub
        yield* seedConversation
        const before = yield* publishTurns(CONV, 2)
        const live = yield* collect(hub.subscribeConversation({ conversationId: CONV }))
        yield* eventually(
          Effect.map(live.items, (items) => items.length === 2),
          "initial snapshot",
        )
        yield* publishTurns(CONV, 1)
        const epoch = yield* hub.resetConversation(CONV, "new-session")
        yield* eventually(
          Effect.map(live.items, (items) => items.length === 6),
          "reset items",
        )
        const after = yield* hub.publishConversation(CONV, {
          type: "turn.upserted",
          turn: makeTurn({ id: turnId("trn_after"), conversationId: CONV }),
        })
        yield* eventually(
          Effect.map(live.items, (items) => items.length === 7),
          "post-reset change",
        )
        const resumed = yield* firstItems({ after: before }, 2)
        return {
          epoch,
          before,
          after,
          live: (yield* live.items) as ReadonlyArray<KnownConversationStreamItem>,
          resumed,
        }
      }),
      layer(),
    )
    expect(out.epoch).not.toBe(out.before.epoch)
    expect(out.after).toEqual({ epoch: out.epoch, sequence: 1 })
    expect(kinds(out.live)).toEqual([
      "snapshot",
      "synchronized",
      "change",
      "reset",
      "snapshot",
      "synchronized",
      "change",
    ])
    expect(out.live[3]).toEqual({ kind: "reset", epoch: out.epoch, reason: "new-session" })
    expect(out.live[4]!.kind === "snapshot" && out.live[4]!.cursor).toEqual({ epoch: out.epoch, sequence: 0 })
    expect(out.live[6]!.kind === "change" && out.live[6]!.cursor).toEqual({ epoch: out.epoch, sequence: 1 })
    expect(kinds(out.resumed)).toEqual(["snapshot", "synchronized"])
    expect(out.resumed[0]!.kind === "snapshot" && out.resumed[0]!.cursor.epoch).toBe(out.epoch)
  })

  test("subscribing to an unknown conversation fails with NotFound", async () => {
    const error = await runTest(
      Effect.flatMap(LiveHub, (hub) =>
        Effect.flip(Stream.runCollect(hub.subscribeConversation({ conversationId: conversationId("cnv_nope") }))),
      ),
      layer(),
    )
    expect(error._tag).toBe("NotFound")
  })
})

describe("LiveHub roster", () => {
  test("activities are deduplicated, snapshotted and node changes are forwarded", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const hub = yield* LiveHub
        const nodes = yield* NodeDirectoryFake
        const live = yield* collect(hub.subscribeRoster({}))
        yield* eventually(
          Effect.map(live.items, (items) => items.length === 2),
          "roster snapshot",
        )
        yield* (yield* BotRepo).upsert(makeBot({ id: botId("bot_x") }))
        const activity = { botId: botId("bot_x"), state: "thinking" as const, since: 1 }
        yield* hub.setActivity(activity)
        yield* hub.setActivity({ ...activity, since: 2 })
        yield* nodes.upsert(remoteNodeSummary("nod_far"))
        yield* eventually(
          Effect.map(live.items, (items) => items.length === 4),
          "roster changes",
        )
        const snapshot = yield* Stream.runCollect(hub.subscribeRoster({}).pipe(Stream.take(1)))
        return {
          live: (yield* live.items) as ReadonlyArray<KnownRosterStreamItem>,
          snapshot: snapshot[0]!,
          activities: yield* hub.activities,
        }
      }),
      layer(),
    )
    expect(out.live.map((i) => (i.kind === "change" ? i.change.type : i.kind))).toEqual([
      "snapshot",
      "synchronized",
      "activity.updated",
      "node.upserted",
    ])
    expect(out.activities).toHaveLength(1)
    // Activities of unknown bots are not part of a snapshot (bots are filtered against BotRepo).
    expect(out.snapshot.kind === "snapshot" && out.snapshot.nodes.map((n): string => n.id)).toEqual([
      "node_local",
      "nod_far",
    ])
  })
})

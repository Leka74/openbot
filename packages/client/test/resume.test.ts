// Unit tests for the resumable replica loop, backoff, key mapping and the command table (no network).
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Stream } from "effect"
import {
  applyConversationStreamItem,
  type ConversationState,
  type ConversationStreamItem,
  emptyConversationState,
  type EntryId,
  OpenBotRpcs,
  type StreamCursor,
} from "@openbot/contracts"
import {
  backoffDelayMs,
  type CommandTag,
  commands,
  COMMAND_INVALIDATES,
  isRetryableSubscribeError,
  Keys,
  keysForConversationChange,
  makeReplicaHolder,
  replicaStream,
  updateReplica,
} from "../src/index.ts"
import { conversationFixture, messageFixture } from "./support/fakeBrain.ts"

const conv = conversationFixture("cnv_1", "bot_1")
const snapshot = (sequence: number, texts: string[]): ConversationStreamItem => ({
  kind: "snapshot",
  cursor: { epoch: "e1", sequence },
  conversation: conv,
  entries: texts.map((t, i) => messageFixture("cnv_1", `ent_${i}`, i, t)),
  requests: [],
  turns: [],
  hasMoreBefore: false,
  beforeCursor: null,
})
const change = (sequence: number, id: string, text: string): ConversationStreamItem => ({
  kind: "change",
  cursor: { epoch: "e1", sequence },
  change: { type: "entry.upserted", entry: messageFixture("cnv_1", id, 100 + sequence, text) },
})
const synced = (sequence: number): ConversationStreamItem => ({
  kind: "synchronized",
  cursor: { epoch: "e1", sequence },
})

class Transport {
  readonly _tag = "Transport"
}
class Fatal {
  readonly _tag = "Fatal"
}

const spec = (
  holder: ReturnType<typeof makeReplicaHolder<ConversationState>>,
  attempts: Array<(after: StreamCursor | undefined) => Stream.Stream<ConversationStreamItem, Transport | Fatal>>,
  log: Array<StreamCursor | undefined>,
) => ({
  holder,
  open: (after: StreamCursor | undefined) => {
    log.push(after)
    const next = attempts.shift()
    return next ? next(after) : Stream.never
  },
  reduce: applyConversationStreamItem,
  cursor: (s: ConversationState) => s.cursor,
  hasGap: (s: ConversationState) => s.gap,
  markStale: (s: ConversationState) => ({ ...s, synchronized: false }),
  isRetryable: (e: Transport | Fatal) => e instanceof Transport,
  backoff: { initialMs: 1, maxMs: 4, factor: 2, jitter: false },
})

/** Collects emitted states until `until` holds (or the stream ends/fails). */
const collect = (stream: Stream.Stream<ConversationState, unknown>, until: (s: ConversationState) => boolean) =>
  Effect.runPromiseExit(stream.pipe(Stream.takeUntil(until), Stream.runCollect, Effect.timeout("2 seconds")))

describe("replicaStream", () => {
  test("transport failure → stale state, resubscribe from the cursor, replay continues", async () => {
    const holder = makeReplicaHolder(emptyConversationState)
    const log: Array<StreamCursor | undefined> = []
    const s = replicaStream(
      spec(
        holder,
        [
          () =>
            Stream.fromIterable([snapshot(2, ["a", "b"]), synced(2), change(3, "ent_c", "c")]).pipe(
              Stream.concat(Stream.fail(new Transport())),
            ),
          () => Stream.fromIterable([change(4, "ent_d", "d"), synced(4)]).pipe(Stream.concat(Stream.never)),
        ],
        log,
      ),
    )
    const exit = await collect(s, (st) => st.synchronized && st.cursor?.sequence === 4)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(log).toEqual([undefined, { epoch: "e1", sequence: 3 }])
    if (Exit.isSuccess(exit)) {
      const states = [...exit.value]
      expect(states.some((st) => st.cursor?.sequence === 3 && !st.synchronized)).toBe(true) // marked stale
      expect(states.at(-1)!.entries.size).toBe(4)
    }
  })

  test("an out-of-order change (gap) restarts the subscription from the last applied cursor", async () => {
    const holder = makeReplicaHolder(emptyConversationState)
    const log: Array<StreamCursor | undefined> = []
    const s = replicaStream(
      spec(
        holder,
        [
          () =>
            Stream.fromIterable([snapshot(1, ["a"]), synced(1), change(3, "ent_x", "skipped one")]).pipe(
              Stream.concat(Stream.never),
            ),
          () =>
            Stream.fromIterable([change(2, "ent_b", "b"), change(3, "ent_c", "c"), synced(3)]).pipe(
              Stream.concat(Stream.never),
            ),
        ],
        log,
      ),
    )
    const exit = await collect(s, (st) => st.synchronized && st.cursor?.sequence === 3)
    expect(log).toEqual([undefined, { epoch: "e1", sequence: 1 }])
    expect(Exit.isSuccess(exit) && [...exit.value].at(-1)!.entries.has("ent_x" as EntryId)).toBe(false)
  })

  test("a non-retryable error ends the stream with that error", async () => {
    const holder = makeReplicaHolder(emptyConversationState)
    const s = replicaStream(spec(holder, [() => Stream.fail(new Fatal())], []))
    const exit = await Effect.runPromiseExit(Stream.runDrain(s))
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("Fatal")
  })

  test("a cached holder emits immediately and resumes; local updates reach the running stream", async () => {
    const holder = makeReplicaHolder(applyConversationStreamItem(emptyConversationState, snapshot(5, ["a"])))
    const log: Array<StreamCursor | undefined> = []
    const s = replicaStream(spec(holder, [() => Stream.make(synced(5)).pipe(Stream.concat(Stream.never))], log))
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Stream.runCollect(Stream.takeUntil(s, (st) => st.hasMoreBefore)).pipe(
          Effect.forkChild({ startImmediately: true }),
        )
        yield* Effect.sleep(20)
        updateReplica(holder, (st) => ({ ...st, hasMoreBefore: true }))
        return yield* Fiber.join(fiber)
      }),
    )
    expect(log).toEqual([{ epoch: "e1", sequence: 5 }])
    const states = [...result]
    expect(states[0]!.cursor?.sequence).toBe(5)
    expect(states[0]!.entries.size).toBe(1)
    expect(states.at(-1)!.hasMoreBefore).toBe(true)
  })
})

describe("helpers", () => {
  test("backoff grows, caps and jitters within ±20%", () => {
    const b = { initialMs: 250, maxMs: 10_000, factor: 2, jitter: false }
    expect([0, 1, 2, 3, 10].map((n) => backoffDelayMs(b, n))).toEqual([0, 250, 500, 1000, 10_000])
    const j = { ...b, jitter: true }
    expect(backoffDelayMs(j, 3, () => 0)).toBe(800)
    expect(backoffDelayMs(j, 3, () => 1)).toBe(1200)
    expect(backoffDelayMs(j, 20, () => 1)).toBe(10_000)
  })

  test("retry classification", () => {
    expect(isRetryableSubscribeError({ _tag: "Internal", message: "x" })).toBe(true)
    expect(isRetryableSubscribeError({ _tag: "NotFound", entity: "conversation", id: "c" })).toBe(false)
  })

  test("live events invalidate the right query keys", () => {
    const event = (e: object) =>
      keysForConversationChange({
        type: "entry.upserted",
        entry: { ...messageFixture("cnv_1", "ent_e", 1, ""), kind: "event", event: e } as any,
      })
    expect(event({ type: "routine-run", routineId: "r", routineName: "n", runId: "x", status: "succeeded" })).toEqual([
      Keys.routines,
    ])
    expect(event({ type: "memory-updated", botId: "bot_1", action: "remembered" })).toContain(Keys.memory)
    expect(event({ type: "joined", botId: "bot_1", name: "n" })).toEqual([])
  })

  test("there is one command atom per unary RPC", () => {
    const unary = [...OpenBotRpcs.requests.keys()]
      .filter((t) => t !== "roster.subscribe" && t !== "conversations.subscribe" && t !== "profiles.subscribe")
      .sort()
    expect(Object.keys(commands).sort()).toEqual(unary)
    for (const tag of Object.keys(COMMAND_INVALIDATES)) expect(unary).toContain(tag as CommandTag)
  })
})

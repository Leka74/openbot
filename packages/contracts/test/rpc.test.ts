// OpenBotRpcs: the v1 procedure list (architecture §4.1.1), and a real serialization round trip
// (RpcServer -> JSON over HTTP on Bun.serve -> RpcClient). RpcTest would skip serialization, which
// is exactly where the forward-compatible schemas could break (domain-contract.md §F.4.3).
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import { RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc"
import {
  applyConversationStreamItem,
  applyRosterStreamItem,
  type BotId,
  type ConversationId,
  ConversationsSubscribe,
  DEFAULT_SETTINGS,
  emptyConversationState,
  emptyRosterState,
  NotFound,
  OpenBotRpcs,
  type OpenBotRpcTag,
  type RequestId,
  RequestNotPending,
  RequestsRespond,
  RosterSubscribe,
  transcriptOf,
} from "../src/index.ts"
import { reduceClaude } from "./support/reduce/claude.ts"
import { readFixture } from "./support/reduce/kit.ts"
import { ServerReplica } from "./support/server-replica.ts"

const V1_RPCS = [
  "session.info",
  "roster.subscribe",
  "bots.create",
  "bots.update",
  "bots.delete",
  "bots.get",
  "bots.readContext",
  "bots.newSession",
  "bots.compact",
  "sections.list",
  "sections.create",
  "sections.rename",
  "sections.delete",
  "sections.reorder",
  "sidebar.arrange",
  "conversations.subscribe",
  "conversations.history",
  "conversations.exchange",
  "conversations.around",
  "conversations.createGroup",
  "conversations.setMembers",
  "conversations.rename",
  "conversations.markRead",
  "conversations.setHidden",
  "conversations.delete",
  "messages.send",
  "messages.lookupSend",
  "messages.react",
  "turns.interrupt",
  "turns.retry",
  "attachments.upload",
  "requests.respond",
  "requests.listPending",
  "routines.list",
  "routines.create",
  "routines.update",
  "routines.setEnabled",
  "routines.delete",
  "routines.runNow",
  "routines.runs",
  "memory.get",
  "memory.putFact",
  "memory.deleteFact",
  "memory.setIndex",
  "skills.list",
  "skills.upsert",
  "skills.delete",
  "skills.assign",
  "skills.search",
  "skills.preview",
  "skills.install",
  "harnesses.status",
  "harnesses.models",
  "harnesses.profiles",
  "harnesses.addProfile",
  "harnesses.removeProfile",
  "harnesses.discover",
  "nodes.list",
  "nodes.createPairingCode",
  "nodes.rename",
  "nodes.revoke",
  "nodes.setCapabilities",
  "computer.status",
  "computer.ensure",
  "computer.lease",
  "computer.reset",
  "settings.get",
  "settings.update",
  "rules.list",
  "rules.upsert",
  "rules.delete",
  "search.query",
  "search.inConversation",
  "tasks.list",
  "tasks.get",
  "tasks.cancel",
  "slack.status",
  "slack.connect",
  "slack.disconnect",
  "slack.sendDraft",
  "slack.discardDraft",
  "cards.act",
  "stt.status",
  "stt.install",
  "stt.remove",
  "stt.open",
  "stt.append",
  "stt.finish",
  "stt.discard",
  "voice.status",
  "voice.install",
  "voice.remove",
  "voice.preview",
  "updates.status",
  "updates.check",
  "updates.install",
  "updates.rollback",
  "hark.status",
  "hark.connect",
  "hark.disconnect",
  "hark.test",
  "hark.setSends",
  "hark.setQuietAtComputer",
  "presence.active",
  "ntfy.status",
  "ntfy.connect",
  "ntfy.disconnect",
  "ntfy.test",
  "ntfy.setSends",
  "usage.byBot",
] as const satisfies ReadonlyArray<OpenBotRpcTag>

describe("OpenBotRpcs", () => {
  test("exposes exactly the v1 procedure list", () => {
    expect([...OpenBotRpcs.requests.keys()].sort()).toEqual([...V1_RPCS].sort())
    for (const cut of [
      "messages.feedback",
      "bots.setAvatarImage",
      "conversations.thread",
      "conversations.outline",
      "routines.webhookCredential",
    ]) {
      expect(OpenBotRpcs.requests.has(cut)).toBe(false)
    }
    expect([...OpenBotRpcs.requests.keys()].some((k) => k.startsWith("connectors."))).toBe(false)
  })

  test("the typed client compiles against the group", () => {
    // Type-level only: never executed. Breaks the typecheck if a payload or result shape drifts.
    const _usage = Effect.gen(function* () {
      const client = yield* RpcClient.make(OpenBotRpcs)
      const sent = yield* client["messages.send"]({
        conversationId: "cnv_1" as ConversationId,
        text: "hi",
        clientNonce: "n1",
        mode: "auto",
      })
      const _disposition: "started" | "queued" | "steered" | "duplicate" = sent.disposition
      const settings = yield* client["settings.update"]({ patch: { theme: "dark" } })
      const _theme: "system" | "dark" | "light" = settings.theme
      const bot = yield* client["bots.create"]({ name: "Scout", harness: { kind: "fake" }, clientNonce: "n2" })
      yield* client["bots.update"]({ botId: bot.id, patch: { sectionId: null, pinned: true } })
      return [_disposition, _theme] as const
    })
    expect(typeof _usage).toBe("object")
  })
})

class WireRpcs extends RpcGroup.make(ConversationsSubscribe, RosterSubscribe, RequestsRespond) {}

test("subscribe streams and typed errors survive the real JSON encode/decode path", async () => {
  const frames = await readFixture(`${import.meta.dir}/fixtures/claude-basic.jsonl`)
  const replica = new ServerReplica({
    id: "conv_fixture" as ConversationId,
    kind: "direct",
    botId: "bot_fixture" as BotId,
    title: "Fixture bot",
    createdAt: 0,
    lastActivityAt: 0,
    unreadCount: 0,
    hiddenFromSidebar: false,
    epoch: "ep1",
  })
  for (const ch of reduceClaude(frames).em.changes) replica.apply(ch)

  const Handlers = WireRpcs.toLayer({
    "conversations.subscribe": ({ conversationId, after }) =>
      conversationId === replica.state.conversation!.id
        ? Stream.fromIterable(replica.subscribe(after))
        : Stream.fail(new NotFound({ entity: "conversation", id: conversationId })),
    "roster.subscribe": () =>
      Stream.fromIterable([
        {
          kind: "snapshot",
          cursor: { epoch: "r1", sequence: 0 },
          bots: [],
          conversations: [],
          activities: [],
          nodes: [],
          sections: [],
          settings: DEFAULT_SETTINGS,
        },
        { kind: "synchronized", cursor: { epoch: "r1", sequence: 0 } },
      ] as const),
    "requests.respond": ({ requestId }) => {
      const r = replica.state.requests.get(requestId)
      if (!r) return Effect.fail(new NotFound({ entity: "request", id: requestId }))
      if (r.status !== "pending") return Effect.fail(new RequestNotPending({ requestId, status: r.status }))
      return Effect.succeed(r)
    },
  })

  const program = Effect.gen(function* () {
    const httpEffect = yield* RpcServer.toHttpEffect(WireRpcs, { disableTracing: true })
    const handler = HttpEffect.toWebHandler(httpEffect)
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => handler(req) })),
      (s) => Effect.promise(() => s.stop(true)),
    )
    const client = yield* RpcClient.make(WireRpcs, { disableTracing: true }).pipe(
      Effect.provide(
        RpcClient.layerProtocolHttp({ url: `http://127.0.0.1:${server.port}/rpc` }).pipe(
          Layer.provide(FetchHttpClient.layer),
        ),
      ),
    )
    const conversationId = "conv_fixture" as ConversationId
    const items = yield* client["conversations.subscribe"]({ conversationId }).pipe(Stream.runCollect)
    const resumed = yield* client["conversations.subscribe"]({
      conversationId,
      after: { epoch: "ep1", sequence: replica.sequence - 3 },
    }).pipe(Stream.runCollect)
    const roster = yield* client["roster.subscribe"]({}).pipe(Stream.runCollect)
    const missing = yield* Effect.flip(
      client["conversations.subscribe"]({ conversationId: "nope" as ConversationId }).pipe(Stream.runCollect),
    )
    const notPending = yield* Effect.flip(
      client["requests.respond"]({
        requestId: "req_001" as RequestId,
        response: { type: "decision", decision: "allow-once" },
      }),
    )
    return { items: [...items], resumed: [...resumed], roster: [...roster], missing, notPending }
  }).pipe(Effect.provide(Handlers), Effect.provide(RpcSerialization.layerJson), Effect.scoped)

  const out = await Effect.runPromise(program)
  expect(out.items.map((i) => i.kind)).toEqual(["snapshot", "synchronized"])
  const state = out.items.reduce(applyConversationStreamItem, emptyConversationState)
  expect(state.synchronized).toBe(true)
  expect(transcriptOf(state)).toEqual(transcriptOf(replica.state) as any)
  expect(out.resumed.map((i) => i.kind)).toEqual(["change", "change", "change", "synchronized"])
  const roster = out.roster.reduce(applyRosterStreamItem, emptyRosterState)
  expect(roster.synchronized && roster.settings?.showSteps).toBe(true)
  expect(out.missing._tag).toBe("NotFound")
  expect(out.notPending._tag).toBe("RequestNotPending")
}, 20_000)

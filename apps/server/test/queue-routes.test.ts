// The owner's queue through the brain (queue/live.ts): only with OPENBOT_QUEUE, only for the signed-in
// owner; the page and its API work on the active profile, and an approval waits out its undo grace.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  type BotId,
  type ConversationId,
  type ConversationState,
  isTerminalTurnStatus,
  MAIN_PROFILE_ID,
  transcriptOf,
} from "@openbot/contracts"
import { DecisionQueue, TurnRepo } from "@openbot/core"
import { Effect, Ref } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eventually, login, rpcClient, startServer, type TestServer, watchConversation } from "./helpers.ts"
import { UNDO_GRACE_MS } from "../src/queue/store.ts"

describe("queue routes", () => {
  let server: TestServer
  let plain: TestServer
  let cookie: string
  const queueDir = mkdtempSync(join(tmpdir(), "openbot-queue-test-"))
  beforeAll(async () => {
    server = await startServer({ server: { queue: { kind: "builtin", file: join(queueDir, "queue.sqlite") } } })
    plain = await startServer({ server: { queue: false } })
    cookie = await login(server.base, server.ownerToken)
  }, 30_000)
  afterAll(async () => {
    await server?.close()
    await plain?.close()
    rmSync(queueDir, { recursive: true, force: true })
  }, 30_000)

  const post = (path: string, body: unknown) =>
    fetch(`${server.base}${path}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  const getState = async () =>
    (await (await fetch(`${server.base}/queue/api/state`, { headers: { cookie } })).json()) as {
      items: Array<{ id: string; title: string; owner: string; area: string; botId: string }>
      pendingDelivery: number
    }

  test("no queue configured: nothing is registered, so the app shows no Queue button", async () => {
    const res = await fetch(`${plain.base}/queue/api/enabled`, {
      headers: { cookie: await login(plain.base, plain.ownerToken) },
    })
    expect(res.status).not.toBe(204)
  })

  test("signed-in owner only", async () => {
    expect((await fetch(`${server.base}/queue/api/enabled`)).status).toBe(401)
    expect((await fetch(`${server.base}/queue/api/enabled`, { headers: { cookie } })).status).toBe(204)
    expect((await fetch(`${server.base}/queue/api/state`)).status).toBe(401)
  })

  test("the page is served with its own CSP and can be framed by the app", async () => {
    const res = await fetch(`${server.base}/queue/`, { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'self'")
    expect(await res.text()).toContain('<script src="app.js"></script>')
    expect((await fetch(`${server.base}/queue/app.js`, { headers: { cookie } })).status).toBe(200)
    expect((await fetch(`${server.base}/queue/../package.json`, { headers: { cookie } })).status).not.toBe(200)
  })

  test("a Bot adds, the owner approves its recommended option, and undo takes it back before it reaches the Bot", async () => {
    const added = await server.run(
      Effect.gen(function* () {
        const queue = yield* DecisionQueue
        return yield* queue.add({
          profileId: MAIN_PROFILE_ID,
          botId: "bot_test" as BotId,
          botName: "Ada",
          conversationId: "cnv_test" as ConversationId,
          area: "Team",
          type: "decision",
          title: "Renew the domain",
          why: "It expires next week",
          options: ["One year", "Five years"],
          recommendedOption: 2,
          key: "domain",
        })
      }),
    )
    expect(added._tag).toBe("added")
    const state = (await (await fetch(`${server.base}/queue/api/state`, { headers: { cookie } })).json()) as {
      items: Array<{ id: string; title: string; recOption: number; owner: string }>
      openTotal: number
    }
    expect(state.openTotal).toBe(1)
    const item = state.items[0]!
    expect(item).toMatchObject({ title: "Renew the domain", recOption: 2, owner: "Ada" })

    expect((await post("/queue/api/decide", { id: item.id, action: "nope" })).status).toBe(400)
    const decided = await post("/queue/api/decide", { id: item.id, action: "approve", option: 2 })
    expect(await decided.json()).toEqual({ decided: 1 })
    const after = (await (await fetch(`${server.base}/queue/api/state`, { headers: { cookie } })).json()) as {
      openTotal: number
      pendingDelivery: number
    }
    expect(after).toMatchObject({ openTotal: 0, pendingDelivery: 1 })

    expect(await (await post("/queue/api/undo", {})).json()).toEqual({ item: item.id, count: 1 })
    const back = (await (await fetch(`${server.base}/queue/api/state`, { headers: { cookie } })).json()) as {
      openTotal: number
      pendingDelivery: number
    }
    expect(back).toMatchObject({ openTotal: 1, pendingDelivery: 0 })
  })

  test(
    "a Bot's add_to_queue lands in the queue, and the owner's approval comes back to it after the undo grace",
    () =>
      server.run(
        Effect.gen(function* () {
          const idle = (st: ConversationState) => [...st.turns.values()].every((t) => isTerminalTurnStatus(t.status))
          const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })
          const bot = yield* client["bots.create"]({
            name: "Nova",
            harness: { kind: "fake" },
            clientNonce: "queue-1",
            introduce: false,
          })
          const convo = yield* watchConversation(client, bot.directConversationId)
          yield* eventually(Ref.get(convo.state), (st) => st.synchronized, { label: "synchronized" })
          const args = {
            title: "Pick a launch date",
            why: "The venue needs an answer",
            options: ["Mon", "Tue"],
            recommended_option: 1,
            key: "launch",
          }
          yield* client["messages.send"]({
            conversationId: bot.directConversationId,
            text: `tool: add_to_queue ${JSON.stringify(args)}`,
            clientNonce: "queue-send-1",
          })
          const before = yield* eventually(Ref.get(convo.state), (st) => idle(st) && st.turns.size >= 1, {
            label: "tool turn",
          })
          const state = yield* Effect.promise(() => getState())
          const item = state.items.find((i) => i.title === "Pick a launch date")
          expect(item).toMatchObject({ owner: "Nova", area: "Unassigned", botId: bot.id })
          const decided = yield* Effect.promise(() =>
            post("/queue/api/decide", { id: item!.id, action: "approve", option: 1 }).then((r) => r.json()),
          )
          expect(decided).toEqual({ decided: 1 })
          const botReplies = (st: ConversationState) =>
            transcriptOf(st).filter((e) => e.kind === "message" && e.author.kind === "bot").length
          const turns = yield* TurnRepo
          const decisionTurn = yield* eventually(
            Effect.orDie(turns.listByConversation(bot.directConversationId, 10)),
            (ts) => ts.some((t) => t.trigger === "system" && t.status === "completed"),
            { label: "the Bot's turn on the decision", timeout: UNDO_GRACE_MS + 15_000 },
          )
          expect(decisionTurn.length).toBeGreaterThan(before.turns.size)
          // the Bot's answer to it is in the chat
          const fresh = yield* watchConversation(client, bot.directConversationId)
          yield* eventually(Ref.get(fresh.state), (st) => st.synchronized && botReplies(st) > botReplies(before), {
            label: "the Bot's reply",
          })
          expect((yield* Effect.promise(() => getState())).pendingDelivery).toBe(0)
        }),
      ),
    UNDO_GRACE_MS + 30_000,
  )
})

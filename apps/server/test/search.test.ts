// Message search end to end: what a chat says is found over `/rpc` (`search.query`,
// `search.inConversation`) and the chat opens around a hit (`conversations.around`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { isTerminalTurnStatus, transcriptOf } from "@openbot/contracts"
import { SearchRepo } from "@openbot/core"
import { Effect, Ref } from "effect"
import { eventually, login, type OpenBotClient, rpcClient, startServer, type TestServer, watchConversation } from "./helpers.ts"

let server: TestServer
let cookie: string

beforeAll(async () => {
  server = await startServer()
  cookie = await login(server.base, server.ownerToken)
}, 30_000)

afterAll(async () => {
  await server?.close()
}, 30_000)

const connect = (): Effect.Effect<OpenBotClient, never, import("effect").Scope.Scope> =>
  rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })

describe("message search over /rpc", () => {
  test("a reply is found, its chat opens around it, and Find lists every hit", async () => {
    await server.run(
      Effect.gen(function*() {
        const client = yield* connect()
        const bot = yield* client["bots.create"]({ name: "Finder", harness: { kind: "fake" }, clientNonce: "search-bot" })
        const convo = yield* watchConversation(client, bot.directConversationId)
        for (let i = 1; i <= 3; i++) {
          yield* client["messages.send"]({ conversationId: bot.directConversationId, text: `echo: albatross number ${i}`, clientNonce: `s-${i}` })
          yield* eventually(
            Ref.get(convo.state),
            (s) => [...s.turns.values()].filter((t) => t.trigger === "user" && isTerminalTurnStatus(t.status)).length === i,
            { label: `reply ${i}` },
          )
        }
        // the boot backfill has run
        yield* eventually(Effect.flatMap(SearchRepo, (repo) => repo.indexing), (indexing) => !indexing, { label: "index ready" })

        const page = yield* client["search.query"]({ query: "albatross number 2", limit: 10 })
        expect(page.terms).toEqual(["albatross", "number", "2"])
        // the owner's message and the bot's echo of it
        expect(page.hits.map((h) => h.author.kind).sort()).toEqual(["bot", "owner"])
        const hit = page.hits.find((h) => h.author.kind === "bot")!
        expect(hit.snippet).toContain("albatross number 2")
        expect(hit.highlights.length).toBeGreaterThan(0)

        const owner = yield* client["search.query"]({ query: "albatross", senders: ["owner"], sort: "oldest", limit: 2 })
        expect(owner.totalCapped).toBe(3)
        expect(owner.nextCursor).not.toBeNull()
        const rest = yield* client["search.query"]({ query: "albatross", senders: ["owner"], sort: "oldest", limit: 2, cursor: owner.nextCursor! })
        expect([...owner.hits, ...rest.hits].map((h) => h.snippet)).toEqual(
          [1, 2, 3].map((i) => `echo: albatross number ${i}`),
        )

        const entryId = hit.ref.kind === "entry" ? hit.ref.entryId : undefined
        const window = yield* client["conversations.around"]({ conversationId: bot.directConversationId, entryId: entryId!, limit: 3 })
        expect(window.entries.map((e) => e.id)).toContain(entryId!)
        expect(window.entries).toHaveLength(3)
        expect(window.turns.length).toBeGreaterThan(0)
        const tail = transcriptOf(yield* Ref.get(convo.state))
        expect(window.hasMoreAfter).toBe(window.entries[window.entries.length - 1]!.id !== tail[tail.length - 1]!.id)

        const find = yield* client["search.inConversation"]({ conversationId: bot.directConversationId, query: "albatross", limit: 100 })
        expect(find.hits).toHaveLength(6)
        expect(find.hits.map((h) => h.createdAt)).toEqual([...find.hits.map((h) => h.createdAt)].sort((a, b) => a - b))

        const refused = yield* Effect.flip(client["search.query"]({ query: "albatross", limit: 500 }))
        expect(refused._tag).toBe("InvalidInput")
      }),
    )
  }, 30_000)
})

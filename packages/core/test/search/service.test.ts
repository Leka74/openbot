/**
 * SearchService (`search.query`, `search.inConversation`, bots' search) and
 * `ConversationService.around` over the in-memory repositories.
 */
import type { ConversationId, EntryId, KnownTranscriptEntry } from "@openbot/contracts"
import { OWNER_USER_ID } from "@openbot/contracts"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { BotRepo, ConversationRepo, EntryRepo, RequestRepo, TaskRepo, TurnRepo } from "../../src/ports/repos.ts"
import { ConversationService, SearchService } from "../../src/ports/services.ts"
import { ConversationServiceLive, LiveHubLive } from "../../src/services/conversation/index.ts"
import { SearchServiceLive } from "../../src/services/search/index.ts"
import {
  makeBot,
  botId,
  conversationId,
  entryId,
  makeCardEntry,
  makeDirectConversation,
  makeGroupConversation,
  makeMessageEntry,
  makeRequest,
  makeTask,
  makeTurn,
  requestId,
  runTest,
  taskId,
  TestPorts,
  turnId,
} from "../../src/testing/index.ts"

const layer = Layer.mergeAll(SearchServiceLive, ConversationServiceLive).pipe(
  Layer.provideMerge(LiveHubLive),
  Layer.provideMerge(TestPorts()),
)

const A = botId("bot_a")
const B = botId("bot_b")
const dmA = conversationId("cnv_a")
const dmB = conversationId("cnv_b")

const seed = Effect.gen(function* () {
  const bots = yield* BotRepo
  for (const id of [A, B]) yield* bots.upsert(makeBot({ id }))
  const conversations = yield* ConversationRepo
  yield* conversations.upsert(makeDirectConversation({ id: dmA, botId: A }))
  yield* conversations.upsert(makeDirectConversation({ id: dmB, botId: B }))
})

const put = (entry: KnownTranscriptEntry) => Effect.flatMap(EntryRepo, (repo) => repo.upsert(entry))
const message = (
  id: string,
  conversation: ConversationId,
  createdAt: number,
  text: string,
  from: "owner" | typeof A = "owner",
) =>
  put(
    makeMessageEntry({
      id: entryId(id),
      conversationId: conversation,
      createdAt,
      text,
      role: from === "owner" ? "user" : "bot",
      author: from === "owner" ? { kind: "user", userId: OWNER_USER_ID } : { kind: "bot", botId: from },
    }),
  )

describe("SearchService", () => {
  test("hits carry the contract's author, snippet highlights and the words looked for", () =>
    runTest(
      Effect.gen(function* () {
        yield* seed
        yield* message("ent_1", dmA, 1, "Lekë wants the deploy after the migration")
        yield* message("ent_2", dmA, 2, "deploy is done", A)
        const search = yield* SearchService
        const page = yield* search.query({ query: "leke deploy", limit: 10 })
        expect(page.terms).toEqual(["leke", "deploy"])
        expect(page.totalCapped).toBe(1)
        expect(page.nextCursor).toBeNull()
        const hit = page.hits[0]!
        expect(hit.ref).toEqual({ kind: "entry", entryId: entryId("ent_1") })
        expect(hit.author).toEqual({ kind: "owner" })
        expect(hit.highlights.map((h) => hit.snippet.slice(h.start, h.end))).toEqual(["Lekë", "deploy"])
        const bots = yield* search.query({ query: "deploy ", senders: [A], limit: 10 })
        expect(bots.hits.map((h) => h.author)).toEqual([{ kind: "bot", botId: A }])
      }),
      layer,
    ))

  test("pages with the cursor it returns; bad input is refused", () =>
    runTest(
      Effect.gen(function* () {
        yield* seed
        for (let i = 1; i <= 5; i++) yield* message(`ent_${i}`, dmA, i, `kestrel ${i}`)
        const search = yield* SearchService
        const first = yield* search.query({ query: "kestrel", sort: "newest", limit: 2 })
        expect(first.hits.map((h) => h.createdAt)).toEqual([5, 4])
        expect(first.totalCapped).toBe(5)
        const second = yield* search.query({ query: "kestrel", sort: "newest", limit: 2, cursor: first.nextCursor! })
        expect(second.hits.map((h) => h.createdAt)).toEqual([3, 2])
        const refused = [
          yield* Effect.flip(search.query({ query: "kestrel", limit: 0 })),
          yield* Effect.flip(search.query({ query: "kestrel", limit: 51 })),
          yield* Effect.flip(search.query({ query: "x".repeat(201), limit: 5 })),
          yield* Effect.flip(search.query({ query: "kestrel", limit: 5, sort: "oldest", cursor: first.nextCursor! })),
          yield* Effect.flip(search.query({ query: "kestrel", limit: 5, from: 9, to: 1 })),
        ]
        expect(refused.map((e) => e._tag)).toEqual([
          "InvalidInput",
          "InvalidInput",
          "InvalidInput",
          "InvalidInput",
          "InvalidInput",
        ])
        expect((yield* search.query({ query: "!!!", limit: 5 })).hits).toEqual([])
        // a bot's page also says where it continues after each hit (for showing fewer)
        for (const sort of ["newest", "relevance"] as const) {
          const bot = yield* search.forBot(A, { query: "kestrel", sort, limit: 3 })
          expect(bot.hitCursors.length).toBe(3)
          expect(bot.hitCursors[2]).toBe(bot.nextCursor!)
          const rest = yield* search.forBot(A, { query: "kestrel", sort, limit: 5, cursor: bot.hitCursors[0]! })
          expect(rest.hits.length).toBe(4)
          expect(rest.hits.slice(0, 2).map((h) => h.ref)).toEqual(bot.hits.slice(1).map((h) => h.ref))
        }
      }),
      layer,
    ))

  test("a task hit opens its chat at the bot's report after the work ended", () =>
    runTest(
      Effect.gen(function* () {
        yield* seed
        const tasks = yield* TaskRepo
        yield* message("ent_before", dmA, 5, "starting", A)
        yield* tasks.upsert(
          makeTask({
            id: taskId("tsk_1"),
            botId: A,
            conversationId: dmA,
            title: "Falcon digest",
            createdAt: 4,
            endedAt: 10,
            result: "Three stories",
          }),
        )
        yield* message("ent_owner", dmA, 11, "thanks")
        yield* message("ent_report", dmA, 12, "Here is the digest", A)
        const page = yield* (yield* SearchService).query({ query: "falcon", limit: 5 })
        expect(page.hits[0]).toMatchObject({
          ref: { kind: "task", taskId: "tsk_1" },
          kind: "task",
          jumpEntryId: "ent_report",
          createdAt: 10,
        })
      }),
      layer,
    ))

  test("bots see only their scope", () =>
    runTest(
      Effect.gen(function* () {
        yield* seed
        yield* message("ent_1", dmA, 1, "osprey for Alpha")
        yield* message("ent_2", dmB, 2, "osprey for Beta")
        const search = yield* SearchService
        expect((yield* search.forBot(B, { query: "osprey", limit: 10 })).hits.map((h) => h.ref)).toEqual([
          { kind: "entry", entryId: entryId("ent_2") },
        ])
        expect(yield* search.canRead(B, dmB)).toBe(true)
        expect(yield* search.canRead(B, dmA)).toBe(false)
      }),
      layer,
    ))

  test("inConversation: every hit position, and a substring when words find nothing", () =>
    runTest(
      Effect.gen(function* () {
        yield* seed
        yield* message("ent_1", dmA, 1, "see config.yaml please")
        yield* message("ent_2", dmA, 2, "the parrot")
        yield* message("ent_3", dmA, 3, "parrots again")
        yield* message("ent_4", dmB, 4, "parrot elsewhere")
        const search = yield* SearchService
        const words = yield* search.inConversation({ conversationId: dmA, query: "parrot", limit: 100 })
        expect(words).toEqual({
          hits: [
            { entryId: entryId("ent_2"), createdAt: 2 as never },
            { entryId: entryId("ent_3"), createdAt: 3 as never },
          ],
          more: false,
          terms: ["parrot"],
        })
        const punctuation = yield* search.inConversation({ conversationId: dmA, query: ".yaml", limit: 100 })
        expect(punctuation.hits.map((h) => h.entryId)).toEqual([entryId("ent_1")])
        const midWord = yield* search.inConversation({ conversationId: dmA, query: "nfig.ya", limit: 100 })
        expect(midWord).toMatchObject({ hits: [{ entryId: "ent_1" }], terms: ["nfig.ya"] })
        const missing = yield* Effect.flip(
          search.inConversation({ conversationId: conversationId("cnv_nope"), query: "x", limit: 5 }),
        )
        expect(missing._tag).toBe("NotFound")
      }),
      layer,
    ))
})

describe("ConversationService.around", () => {
  const fill = (count: number) =>
    Effect.gen(function* () {
      yield* seed
      for (let i = 1; i <= count; i++) yield* message(`ent_${String(i).padStart(3, "0")}`, dmA, i * 10, `m${i}`)
    })
  const idsOf = (entries: ReadonlyArray<{ readonly id: string }>) => entries.map((e) => e.id)
  const at = (i: number) => entryId(`ent_${String(i).padStart(3, "0")}`) as EntryId

  test("a window around an entry, then pages before and after it", () =>
    runTest(
      Effect.gen(function* () {
        yield* fill(30)
        const conversations = yield* ConversationService
        const window = yield* conversations.around({ conversationId: dmA, entryId: at(15), limit: 5 })
        expect(idsOf(window.entries)).toEqual([at(13), at(14), at(15), at(16), at(17)])
        expect(window).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true, precedingTimestamp: 120 })
        const older = yield* conversations.around({ conversationId: dmA, beforeCursor: window.beforeCursor!, limit: 5 })
        expect(idsOf(older.entries)).toEqual([at(8), at(9), at(10), at(11), at(12)])
        expect(older.hasMoreAfter).toBe(true)
        const newer = yield* conversations.around({ conversationId: dmA, afterCursor: window.afterCursor!, limit: 20 })
        expect(idsOf(newer.entries)).toEqual(Array.from({ length: 13 }, (_, i) => at(18 + i)))
        expect(newer).toMatchObject({ hasMoreBefore: true, hasMoreAfter: false, afterCursor: null })
        const tail = yield* conversations.around({ conversationId: dmA, limit: 3 })
        expect(idsOf(tail.entries)).toEqual([at(28), at(29), at(30)])
        expect(tail.hasMoreAfter).toBe(false)
      }),
      layer,
    ))

  test("near an edge the other side gets the room", () =>
    runTest(
      Effect.gen(function* () {
        yield* fill(10)
        const conversations = yield* ConversationService
        const start = yield* conversations.around({ conversationId: dmA, entryId: at(2), limit: 5 })
        expect(idsOf(start.entries)).toEqual([at(1), at(2), at(3), at(4), at(5)])
        expect(start).toMatchObject({ hasMoreBefore: false, beforeCursor: null, hasMoreAfter: true })
        const end = yield* conversations.around({ conversationId: dmA, entryId: at(10), limit: 4 })
        expect(idsOf(end.entries)).toEqual([at(7), at(8), at(9), at(10)])
        expect(end).toMatchObject({ hasMoreAfter: false, afterCursor: null })
      }),
      layer,
    ))

  test("voice calls' work stays out; the window brings its turns and card requests", () =>
    runTest(
      Effect.gen(function* () {
        yield* seed
        const turns = yield* TurnRepo
        const requests = yield* RequestRepo
        yield* turns.upsert(makeTurn({ id: turnId("trn_chat"), conversationId: dmA, botId: A, status: "completed" }))
        yield* turns.upsert(
          makeTurn({ id: turnId("trn_voice"), conversationId: dmA, botId: A, status: "completed", voice: true }),
        )
        yield* requests.upsert(
          makeRequest({
            id: requestId("req_1"),
            conversationId: dmA,
            botId: A,
            cardEntryId: entryId("ent_card"),
            status: "approved" as never,
          }),
        )
        yield* message("ent_1", dmA, 1, "hello")
        yield* put(
          makeMessageEntry({
            id: entryId("ent_2"),
            conversationId: dmA,
            createdAt: 2,
            role: "bot",
            author: { kind: "bot", botId: A },
            text: "on it",
            turnId: turnId("trn_chat"),
          }),
        )
        yield* put(
          makeMessageEntry({
            id: entryId("ent_3"),
            conversationId: dmA,
            createdAt: 3,
            role: "bot",
            author: { kind: "bot", botId: A },
            text: "call work",
            turnId: turnId("trn_voice"),
          }),
        )
        yield* put(
          makeCardEntry({
            id: entryId("ent_card"),
            conversationId: dmA,
            createdAt: 4,
            turnId: turnId("trn_chat"),
            card: { type: "approval", requestId: requestId("req_1"), title: "Run" },
          }),
        )
        const window = yield* (yield* ConversationService).around({
          conversationId: dmA,
          entryId: entryId("ent_2"),
          limit: 10,
        })
        expect(idsOf(window.entries)).toEqual(["ent_1", "ent_2", "ent_card"])
        expect(window.turns.map((t) => t.id)).toEqual([turnId("trn_chat")])
        expect(window.requests.map((r) => r.id)).toEqual([requestId("req_1")])
      }),
      layer,
    ))

  test("refuses what it can't open", () =>
    runTest(
      Effect.gen(function* () {
        yield* fill(3)
        yield* message("ent_b", dmB, 1, "elsewhere")
        const conversations = yield* ConversationService
        const errors = [
          yield* Effect.flip(conversations.around({ conversationId: dmA, entryId: entryId("ent_b"), limit: 5 })),
          yield* Effect.flip(conversations.around({ conversationId: dmA, limit: 0 })),
          yield* Effect.flip(conversations.around({ conversationId: dmA, limit: 201 })),
          yield* Effect.flip(
            conversations.around({ conversationId: dmA, entryId: at(1), beforeCursor: "1:x", limit: 5 }),
          ),
          yield* Effect.flip(conversations.around({ conversationId: dmA, afterCursor: "nope", limit: 5 })),
          yield* Effect.flip(conversations.around({ conversationId: conversationId("cnv_nope"), limit: 5 })),
        ]
        expect(errors.map((e) => e._tag)).toEqual([
          "NotFound",
          "InvalidInput",
          "InvalidInput",
          "InvalidInput",
          "InvalidInput",
          "NotFound",
        ])
      }),
      layer,
    ))
})

describe("group membership in the service", () => {
  test("a group member reads earlier history; after leaving, nothing", () =>
    runTest(
      Effect.gen(function* () {
        yield* seed
        const conversations = yield* ConversationRepo
        const group = conversationId("cnv_g")
        yield* conversations.upsert(makeGroupConversation({ id: group, memberBotIds: [A, botId("bot_c")] }))
        yield* message("ent_g", group, 1, "condor history")
        const search = yield* SearchService
        expect((yield* search.forBot(B, { query: "condor", limit: 5 })).totalCapped).toBe(0)
        yield* conversations.upsert(makeGroupConversation({ id: group, memberBotIds: [A, B] }))
        expect((yield* search.forBot(B, { query: "condor", limit: 5 })).totalCapped).toBe(1)
        expect(yield* search.canRead(B, group)).toBe(true)
        yield* conversations.upsert(makeGroupConversation({ id: group, memberBotIds: [A, botId("bot_c")] }))
        expect((yield* search.forBot(B, { query: "condor", limit: 5 })).totalCapped).toBe(0)
        expect(yield* search.canRead(B, group)).toBe(false)
      }),
      layer,
    ))
})

/**
 * Message search contract suite: what every `SearchRepo` (with the `EntryRepo` / `TaskRepo` that
 * feed it) must do, run against the in-memory doubles here and against SQLite by
 * `@openbot/persistence`. Each case expects FRESH (empty) repositories.
 *
 * The access cases are the v1 rules Lekë decided: a bot never reads the owner's chats with other
 * bots; it reads a group's whole history, from before it joined, while it is a member; and nothing
 * of a group once it has left.
 */
import type { BotId, ConversationId, SearchKind, SearchSort } from "@openbot/contracts"
import { DEFAULT_SEARCH_KINDS, MAIN_PROFILE_ID, OWNER_USER_ID } from "@openbot/contracts"
import { Effect } from "effect"
import type { RepositoryPorts } from "../ports/Persistence.ts"
import {
  BotRepo,
  ConversationRepo,
  EntryRepo,
  type SearchFilter,
  SearchRepo,
  type SearchScope,
  TaskRepo,
  TurnRepo,
} from "../ports/repos.ts"
import { parseSearchQuery, type SearchCursor } from "../services/search/text.ts"
import {
  OTHER_PROFILE,
  makeBot,
  botId,
  conversationId,
  entryId,
  makeCardEntry,
  makeDirectConversation,
  makeEventEntry,
  makeGroupConversation,
  makeMessageEntry,
  makeTask,
  makeToolCallEntry,
  makeTurn,
  taskId,
  turnId,
} from "./builders.ts"
import { ContractViolation, type RepoContractCase } from "./repoContract.ts"

const fail = (message: string) => Effect.fail(new ContractViolation({ message }))
const sorted = (xs: ReadonlyArray<string>) => [...xs].sort()
const sameSet = (actual: ReadonlyArray<string>, expected: ReadonlyArray<string>, label: string) =>
  JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected))
    ? Effect.void
    : fail(`${label}: expected ${JSON.stringify(sorted(expected))}, got ${JSON.stringify(sorted(actual))}`)
const equal = (actual: unknown, expected: unknown, label: string) =>
  JSON.stringify(actual) === JSON.stringify(expected)
    ? Effect.void
    : fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
const ok = (condition: boolean, label: string) => (condition ? Effect.void : fail(label))

const ALL_KINDS: ReadonlyArray<SearchKind> = ["message", "card", "event", "notice", "tool-call", "task"]
const OWNER: SearchScope = { kind: "owner", profileId: MAIN_PROFILE_ID }
const asBot = (id: BotId): SearchScope => ({ kind: "bot", botId: id })

/** Every ref id that matches `words` in `scope` (all pages), plus the reported total. */
const find = (
  words: string,
  scope: SearchScope,
  filter?: Partial<Omit<SearchFilter, "scope">> & {
    readonly sort?: SearchSort
    readonly limit?: number
    readonly totalCap?: number
  },
) =>
  Effect.gen(function* () {
    const repo = yield* SearchRepo
    const match = parseSearchQuery(words)
    if (match === undefined) return yield* fail(`no words in ${words}`)
    const refs: Array<string> = []
    let after: SearchCursor | undefined
    let total = -1
    for (let pages = 0; pages < 100; pages++) {
      const page = yield* repo.query({
        scope,
        match,
        kinds: filter?.kinds ?? ALL_KINDS,
        conversationIds: filter?.conversationIds,
        botIds: filter?.botIds,
        senders: filter?.senders,
        exchangeWith: filter?.exchangeWith,
        from: filter?.from,
        to: filter?.to,
        sort: filter?.sort ?? "newest",
        after,
        limit: filter?.limit ?? 50,
        totalCap: filter?.totalCap,
      })
      if (total === -1) total = page.total
      refs.push(...page.hits.map((hit) => hit.doc.refId))
      if (page.next === undefined) break
      after = page.next
    }
    return { refs, total }
  })

const refsOf = (words: string, scope: SearchScope, filter?: Parameters<typeof find>[2]) =>
  Effect.map(find(words, scope, filter), (found) => found.refs)

const bot = (id: string) => ({ kind: "bot" as const, botId: botId(id) })
const owner = { kind: "user" as const, userId: OWNER_USER_ID }

/** A message entry: `from` "owner" or a bot id; `to` makes it a bot-to-bot message. */
const say = (id: string, conversation: ConversationId, createdAt: number, from: string, text: string, to?: string) =>
  Effect.flatMap(EntryRepo, (repo) =>
    repo.upsert(
      makeMessageEntry({
        id: entryId(id),
        conversationId: conversation,
        createdAt,
        role: from === "owner" ? "user" : "bot",
        author: from === "owner" ? owner : bot(from),
        text,
        ...(to === undefined ? {} : { toBotId: botId(to) }),
      }),
    ),
  )

const contractCase = (name: string, run: Effect.Effect<void, unknown, RepositoryPorts>): RepoContractCase => ({
  name,
  run,
})

// The team of the access cases: Alpha, Beta and Gamma with their DMs; a group of Alpha and Beta.
const A = botId("bot_alpha")
const B = botId("bot_beta")
const C = botId("bot_gamma")
const dmA = conversationId("cnv_dm_alpha")
const dmB = conversationId("cnv_dm_beta")
const dmC = conversationId("cnv_dm_gamma")
const group = conversationId("cnv_group_ab")

const seedTeam = Effect.gen(function* () {
  const bots = yield* BotRepo
  for (const id of [A, B, C]) yield* bots.upsert(makeBot({ id }))
  const conversations = yield* ConversationRepo
  yield* conversations.upsert(makeDirectConversation({ id: dmA, botId: A, title: "Alpha" }))
  yield* conversations.upsert(makeDirectConversation({ id: dmB, botId: B, title: "Beta" }))
  yield* conversations.upsert(makeDirectConversation({ id: dmC, botId: C, title: "Gamma" }))
})

export const searchContractCases: ReadonlyArray<RepoContractCase> = [
  contractCase(
    "SearchRepo: the owner finds the chats of one profile's Bots only",
    Effect.gen(function* () {
      yield* seedTeam
      const other = botId("bot_other")
      const dmOther = conversationId("cnv_dm_other")
      yield* (yield* BotRepo).upsert(makeBot({ id: other, ownerProfileId: OTHER_PROFILE }))
      yield* (yield* ConversationRepo).upsert(makeDirectConversation({ id: dmOther, botId: other, title: "Other" }))
      yield* say("ent_main", dmA, 10, "owner", "walrus in the main profile")
      yield* say("ent_other", dmOther, 11, "owner", "walrus in the other profile")
      const main = yield* find("walrus", OWNER)
      yield* sameSet(main.refs, ["ent_main"], "main profile")
      yield* equal(main.total, 1, "the count never includes another profile")
      yield* sameSet(
        yield* refsOf("walrus", { kind: "owner", profileId: OTHER_PROFILE }),
        ["ent_other"],
        "other profile",
      )
      yield* sameSet(
        yield* refsOf("walrus", OWNER, { conversationIds: [dmOther] }),
        [],
        "asking for another profile's chat directly",
      )
    }),
  ),
  contractCase(
    "SearchRepo: a bot never reads the owner's chats with other bots, only the messages it sent or got there",
    Effect.gen(function* () {
      yield* seedTeam
      // the owner's DM with Gamma
      yield* say("ent_c1", dmC, 10, "owner", "zebra: the private plan")
      yield* say("ent_c2", dmC, 11, C, "zebra noted, Lekë")
      yield* say("ent_c3", dmC, 12, B, "zebra from Beta to Gamma", C) // Beta's message_bot to Gamma
      yield* say("ent_c4", dmC, 13, C, "zebra from Gamma to Alpha's peer", A) // not Beta's
      yield* (yield* EntryRepo).upsert(
        makeCardEntry({
          id: entryId("ent_c5"),
          conversationId: dmC,
          createdAt: 14,
          author: bot(B),
          card: {
            type: "routine",
            action: "created",
            routineId: "rtn_1" as never,
            name: "zebra digest",
            triggerSummary: "daily",
          },
          state: { status: "info" },
        }),
      )
      // Beta's own DM: the owner, Beta, and Gamma's reply to Beta
      yield* say("ent_b1", dmB, 20, "owner", "zebra in Beta's DM")
      yield* say("ent_b2", dmB, 21, C, "zebra reply from Gamma to Beta", B)
      // the owner's DM with Alpha
      yield* say("ent_a1", dmA, 30, "owner", "zebra for Alpha only")

      const forBeta = yield* find("zebra", asBot(B))
      yield* sameSet(forBeta.refs, ["ent_c3", "ent_b1", "ent_b2"], "Beta's view")
      yield* equal(forBeta.total, 3, "the count never includes what Beta may not read")
      yield* sameSet(
        yield* refsOf("zebra", asBot(B), { conversationIds: [dmC] }),
        ["ent_c3"],
        "asking for Gamma's DM directly",
      )
      yield* sameSet(
        yield* refsOf("zebra", asBot(B), { exchangeWith: C }),
        ["ent_c3", "ent_b2"],
        "Beta's messages with Gamma, both ways",
      )
      yield* sameSet(yield* refsOf("zebra", asBot(B), { exchangeWith: A }), [], "nothing with Alpha")
      yield* sameSet(yield* refsOf("zebra", OWNER, { exchangeWith: C }), [], "an exchange is a bot's view")
      yield* sameSet(yield* refsOf("private plan", asBot(B)), [], "a phrase only in the owner's DM with Gamma")
      yield* sameSet(
        yield* refsOf("zebra", OWNER),
        ["ent_c1", "ent_c2", "ent_c3", "ent_c4", "ent_c5", "ent_b1", "ent_b2", "ent_a1"],
        "the owner sees every chat",
      )
    }),
  ),

  contractCase(
    "SearchRepo: a bot reads a group's whole history, from before it joined, while it is a member",
    Effect.gen(function* () {
      yield* seedTeam
      const conversations = yield* ConversationRepo
      yield* conversations.upsert(makeGroupConversation({ id: group, memberBotIds: [A, C], title: "Launch" }))
      yield* say("ent_g1", group, 10, "owner", "okapi plan before Beta joined")
      yield* say("ent_g2", group, 11, A, "okapi: Alpha agrees")
      yield* (yield* EntryRepo).upsert(
        makeEventEntry({
          id: entryId("ent_g3"),
          conversationId: group,
          createdAt: 12,
          event: { type: "member-added", botId: B, name: "Beta okapi" },
        }),
      )
      yield* sameSet(yield* refsOf("okapi", asBot(B)), [], "not a member yet")
      yield* conversations.upsert(makeGroupConversation({ id: group, memberBotIds: [A, B, C], title: "Launch" }))
      yield* say("ent_g4", group, 13, B, "okapi: Beta is here")
      yield* sameSet(
        yield* refsOf("okapi", asBot(B)),
        ["ent_g1", "ent_g2", "ent_g3", "ent_g4"],
        "member: earlier history too",
      )
    }),
  ),

  contractCase(
    "SearchRepo: a bot that leaves a group reads nothing of it, its own messages, steps and tasks included",
    Effect.gen(function* () {
      yield* seedTeam
      const conversations = yield* ConversationRepo
      const entries = yield* EntryRepo
      yield* conversations.upsert(makeGroupConversation({ id: group, memberBotIds: [A, B], title: "Launch" }))
      yield* say("ent_g1", group, 10, "owner", "ibex kickoff")
      yield* say("ent_g2", group, 11, B, "ibex: Beta's update")
      yield* entries.upsert(
        makeToolCallEntry({
          id: entryId("ent_g3"),
          conversationId: group,
          createdAt: 12,
          author: bot(B),
          name: "ibex_tool",
          status: "completed",
        }),
      )
      yield* say("ent_g4", group, 13, B, "ibex: to Alpha in the group", A)
      yield* (yield* TaskRepo).upsert(
        makeTask({ id: taskId("tsk_g"), botId: B, conversationId: group, title: "ibex research", createdAt: 14 }),
      )
      yield* (yield* TaskRepo).upsert(
        makeTask({ id: taskId("tsk_dm"), botId: B, conversationId: dmB, title: "ibex in its DM", createdAt: 15 }),
      )
      yield* sameSet(
        yield* refsOf("ibex", asBot(B)),
        ["ent_g1", "ent_g2", "ent_g3", "ent_g4", "tsk_g", "tsk_dm"],
        "while a member",
      )
      yield* conversations.upsert(makeGroupConversation({ id: group, memberBotIds: [A, C], title: "Launch" }))
      yield* sameSet(
        yield* refsOf("ibex", asBot(B)),
        ["tsk_dm"],
        "after leaving: nothing of the group, its own task there included",
      )
      yield* equal((yield* find("ibex", asBot(B))).total, 1, "nothing of the group counted")
      yield* sameSet(yield* refsOf("ibex", asBot(B), { conversationIds: [group] }), [], "asking for the group directly")
      yield* sameSet(
        yield* refsOf("ibex", asBot(C)),
        ["ent_g1", "ent_g2", "ent_g4"],
        "the new member reads it (but not Beta's steps)",
      )
    }),
  ),

  contractCase(
    "SearchRepo: tool steps and tasks are a bot's own; tasks of a deleted chat are gone for everyone",
    Effect.gen(function* () {
      yield* seedTeam
      const conversations = yield* ConversationRepo
      const entries = yield* EntryRepo
      const tasks = yield* TaskRepo
      yield* conversations.upsert(makeGroupConversation({ id: group, memberBotIds: [A, B], title: "Launch" }))
      yield* entries.upsert(
        makeToolCallEntry({
          id: entryId("ent_t1"),
          conversationId: group,
          createdAt: 1,
          author: bot(A),
          inputSummary: "lynx grep",
          status: "completed",
        }),
      )
      yield* entries.upsert(
        makeToolCallEntry({
          id: entryId("ent_t2"),
          conversationId: group,
          createdAt: 2,
          author: bot(B),
          inputSummary: "lynx ls",
          status: "completed",
        }),
      )
      yield* tasks.upsert(
        makeTask({ id: taskId("tsk_a"), botId: A, conversationId: group, title: "lynx report", createdAt: 3 }),
      )
      yield* tasks.upsert(
        makeTask({
          id: taskId("tsk_b"),
          botId: B,
          conversationId: dmB,
          title: "lynx digest",
          createdAt: 4,
          result: "done",
        }),
      )
      yield* tasks.upsert(
        makeTask({
          id: taskId("tsk_gone"),
          botId: B,
          conversationId: conversationId("cnv_deleted"),
          title: "lynx old group",
          createdAt: 5,
        }),
      )
      yield* sameSet(yield* refsOf("lynx", asBot(B)), ["ent_t2", "tsk_b"], "Beta: its own step and task")
      yield* sameSet(
        yield* refsOf("lynx", OWNER),
        ["ent_t1", "ent_t2", "tsk_a", "tsk_b"],
        "owner: no task of a deleted chat",
      )
      yield* sameSet(
        yield* refsOf("lynx", OWNER, { kinds: DEFAULT_SEARCH_KINDS }),
        ["tsk_a", "tsk_b"],
        "steps only when asked for",
      )
      // a task hit points at its bot's report: the bot's first message in that chat from the task's time on
      yield* say("ent_r0", dmB, 3, B, "before the work")
      yield* say("ent_r1", dmB, 6, "owner", "thanks")
      yield* say("ent_r2", dmB, 7, B, "here is the digest")
      yield* say("ent_r3", dmB, 8, B, "and more")
      const page = yield* (yield* SearchRepo).query({
        scope: OWNER,
        match: parseSearchQuery("digest ")!,
        kinds: ["task"],
        sort: "newest",
        limit: 5,
      })
      yield* equal(
        page.hits.map((hit) => [hit.doc.refId, hit.jumpEntryId ?? null]),
        [["tsk_b", "ent_r2"]],
        "the report of a task",
      )
    }),
  ),

  contractCase(
    "SearchRepo: docs follow writes (streaming, edits, removal, voice turns)",
    Effect.gen(function* () {
      yield* seedTeam
      const entries = yield* EntryRepo
      const tasks = yield* TaskRepo
      const turns = yield* TurnRepo
      yield* entries.upsert(
        makeMessageEntry({
          id: entryId("ent_s1"),
          conversationId: dmA,
          createdAt: 1,
          role: "bot",
          author: bot(A),
          text: "heron half",
          streaming: true,
        }),
      )
      yield* sameSet(yield* refsOf("heron", OWNER), [], "streaming text is not searchable yet")
      yield* entries.upsert(
        makeMessageEntry({
          id: entryId("ent_s1"),
          conversationId: dmA,
          createdAt: 1,
          revision: 1,
          role: "bot",
          author: bot(A),
          text: "heron done",
        }),
      )
      yield* sameSet(yield* refsOf("heron done", OWNER), ["ent_s1"], "final text")
      yield* entries.upsert(
        makeMessageEntry({
          id: entryId("ent_s1"),
          conversationId: dmA,
          createdAt: 1,
          revision: 2,
          role: "bot",
          author: bot(A),
          text: "egret instead",
        }),
      )
      yield* sameSet(yield* refsOf("heron", OWNER), [], "old text is gone")
      yield* sameSet(yield* refsOf("egret", OWNER), ["ent_s1"], "new text")
      yield* entries.remove(entryId("ent_s1"))
      yield* sameSet(yield* refsOf("egret", OWNER), [], "removed entry")
      yield* tasks.upsert(makeTask({ id: taskId("tsk_s"), botId: A, conversationId: dmA, title: "egret task" }))
      yield* tasks.delete(taskId("tsk_s"))
      yield* sameSet(yield* refsOf("egret", OWNER), [], "deleted task")

      // voice turns: written before or after their entries
      yield* turns.upsert(makeTurn({ id: turnId("trn_v1"), conversationId: dmA, botId: A, voice: true }))
      yield* entries.upsert(
        makeMessageEntry({
          id: entryId("ent_v1"),
          conversationId: dmA,
          createdAt: 5,
          role: "bot",
          author: bot(A),
          text: "puffin call work",
          turnId: turnId("trn_v1"),
        }),
      )
      yield* entries.upsert(
        makeMessageEntry({
          id: entryId("ent_v2"),
          conversationId: dmA,
          createdAt: 6,
          role: "bot",
          author: bot(A),
          text: "puffin later voice",
          turnId: turnId("trn_v2"),
        }),
      )
      yield* entries.upsert(
        makeMessageEntry({
          id: entryId("ent_v3"),
          conversationId: dmA,
          createdAt: 7,
          role: "bot",
          author: bot(A),
          text: "puffin in chat",
          turnId: turnId("trn_v3"),
        }),
      )
      yield* turns.upsert(makeTurn({ id: turnId("trn_v2"), conversationId: dmA, botId: A, voice: true }))
      yield* turns.upsert(makeTurn({ id: turnId("trn_v3"), conversationId: dmA, botId: A }))
      yield* sameSet(yield* refsOf("puffin", OWNER), ["ent_v3"], "voice calls' work is left out")
    }),
  ),

  contractCase(
    "SearchRepo: words, phrases, prefixes, exclusions and diacritics",
    Effect.gen(function* () {
      yield* seedTeam
      yield* say("ent_w1", dmA, 1, "owner", "Lekë approved the deploy plan")
      yield* say("ent_w2", dmA, 2, "owner", "deploy waits for the migration")
      yield* say("ent_w3", dmA, 3, "owner", "the plan deploy is different")
      yield* say("ent_w4", dmA, 4, "owner", "deployment notes (final)")
      yield* say("ent_w5", dmA, 5, "owner", "notes: or not, final and near")
      yield* sameSet(yield* refsOf("leke", OWNER), ["ent_w1"], "diacritics folded")
      yield* sameSet(yield* refsOf("LEKË", OWNER), ["ent_w1"], "case folded")
      yield* sameSet(yield* refsOf('"deploy plan" ', OWNER), ["ent_w1"], "exact phrase")
      yield* sameSet(yield* refsOf("plan deploy ", OWNER), ["ent_w1", "ent_w3"], "all words, any order")
      yield* sameSet(yield* refsOf("deploy -migration ", OWNER), ["ent_w1", "ent_w3"], "-word excludes")
      yield* sameSet(
        yield* refsOf("deploy", OWNER),
        ["ent_w1", "ent_w2", "ent_w3", "ent_w4"],
        "the last word is a prefix while typing",
      )
      yield* sameSet(yield* refsOf("deploy ", OWNER), ["ent_w1", "ent_w2", "ent_w3"], "a finished word is whole")
      yield* sameSet(
        yield* refsOf("notes OR NOT (final) NEAR:", OWNER),
        ["ent_w5"],
        "operators and punctuation are plain words",
      )
      yield* sameSet(yield* refsOf('notes* "final', OWNER), ["ent_w4", "ent_w5"], "stray quotes and stars")
    }),
  ),

  contractCase(
    "SearchRepo: sorts, keyset pages and counts",
    Effect.gen(function* () {
      yield* seedTeam
      for (let i = 1; i <= 23; i++) {
        // ties on createdAt in pairs; more "wren" in later ones ranks them higher
        yield* say(
          `ent_p${String(i).padStart(2, "0")}`,
          dmA,
          Math.ceil(i / 2),
          "owner",
          `${"wren ".repeat(1 + (i % 3))}message ${i}`,
        )
      }
      const all = Array.from({ length: 23 }, (_, i) => `ent_p${String(i + 1).padStart(2, "0")}`)
      for (const sort of ["relevance", "newest", "oldest"] as const) {
        const found = yield* find("wren", OWNER, { sort, limit: 4 })
        yield* equal(found.refs.length, 23, `${sort}: every hit once`)
        yield* sameSet(found.refs, all, `${sort}: the same hits`)
        yield* equal(found.total, 23, `${sort}: total`)
        yield* equal(
          (yield* find("wren", OWNER, { sort, limit: 4, totalCap: 10 })).total,
          10,
          `${sort}: total up to the cap`,
        )
        yield* equal(
          (yield* find("wren", OWNER, { sort, limit: 30, totalCap: 10 })).total,
          10,
          `${sort}: one page, up to the cap`,
        )
        yield* equal((yield* find("wren", OWNER, { sort, limit: 30 })).total, 23, `${sort}: one page holds every match`)
      }
      const newest = (yield* find("wren", OWNER, { sort: "newest", limit: 5 })).refs
      yield* equal(newest.slice(0, 3), ["ent_p23", "ent_p22", "ent_p21"], "newest first, ties by id")
      const oldest = (yield* find("wren", OWNER, { sort: "oldest", limit: 5 })).refs
      yield* equal(oldest.slice(0, 3), ["ent_p01", "ent_p02", "ent_p03"], "oldest first")
      const relevant = (yield* find("wren", OWNER, { sort: "relevance", limit: 5 })).refs
      yield* ok(
        ["ent_p02", "ent_p05", "ent_p08", "ent_p11", "ent_p14", "ent_p17", "ent_p20", "ent_p23"].includes(relevant[0]!),
        "the best match first",
      )
    }),
  ),

  contractCase(
    "SearchRepo: filters (chat, bot, sender, kind, time)",
    Effect.gen(function* () {
      yield* seedTeam
      const conversations = yield* ConversationRepo
      yield* conversations.upsert(makeGroupConversation({ id: group, memberBotIds: [A, B], title: "Launch" }))
      yield* say("ent_f1", dmA, 10, "owner", "otter one")
      yield* say("ent_f2", dmA, 20, A, "otter two")
      yield* say("ent_f3", group, 30, B, "otter three")
      yield* say("ent_f4", dmC, 40, B, "otter four", C)
      yield* (yield* EntryRepo).upsert(
        makeEventEntry({
          id: entryId("ent_f5"),
          conversationId: dmB,
          createdAt: 50,
          event: { type: "name-changed", to: "otter five" },
        }),
      )
      yield* sameSet(yield* refsOf("otter", OWNER, { conversationIds: [dmA] }), ["ent_f1", "ent_f2"], "one chat")
      yield* sameSet(
        yield* refsOf("otter", OWNER, { botIds: [B] }),
        ["ent_f3", "ent_f4", "ent_f5"],
        "a bot: its chats and what it wrote",
      )
      yield* sameSet(yield* refsOf("otter", OWNER, { senders: ["owner"] }), ["ent_f1"], "from the owner")
      yield* sameSet(
        yield* refsOf("otter", OWNER, { senders: ["system", A] }),
        ["ent_f2", "ent_f5"],
        "from system lines or a bot",
      )
      yield* sameSet(yield* refsOf("otter", OWNER, { kinds: ["event"] }), ["ent_f5"], "a kind")
      yield* sameSet(
        yield* refsOf("otter", OWNER, { from: 20, to: 40 }),
        ["ent_f2", "ent_f3", "ent_f4"],
        "inclusive time bounds",
      )
      yield* sameSet(yield* refsOf("otter", OWNER, { conversationIds: [] }), [], "no chat")
    }),
  ),

  contractCase(
    "SearchRepo: positions in one chat (newest first kept, returned oldest first), substring matches",
    Effect.gen(function* () {
      yield* seedTeam
      const repo = yield* SearchRepo
      for (let i = 1; i <= 6; i++) yield* say(`ent_q${i}`, dmA, i, "owner", `crane ${i} ::ok::`)
      yield* say("ent_qx", dmB, 3, "owner", "crane elsewhere ::ok::")
      const base = { scope: OWNER, conversationId: dmA, kinds: DEFAULT_SEARCH_KINDS }
      const found = yield* repo.positions({ ...base, match: parseSearchQuery("crane")!, limit: 4 })
      yield* equal(
        found.hits.map((hit) => hit.entryId),
        ["ent_q3", "ent_q4", "ent_q5", "ent_q6"],
        "the newest, oldest first",
      )
      yield* equal(found.more, true, "more")
      const substring = yield* repo.positions({ ...base, substring: "::OK", limit: 10 })
      yield* equal(
        substring.hits.map((hit) => hit.entryId),
        ["ent_q1", "ent_q2", "ent_q3", "ent_q4", "ent_q5", "ent_q6"],
        "substring, any case",
      )
      yield* equal(substring.more, false, "no more")
    }),
  ),

  contractCase(
    "EntryRepo: pageAfter (oldest first, mirrors page)",
    Effect.gen(function* () {
      const repo = yield* EntryRepo
      const cnv = conversationId("cnv_after")
      for (let i = 1; i <= 7; i++)
        yield* repo.upsert(makeMessageEntry({ id: entryId(`ent_${i}`), conversationId: cnv, createdAt: i * 10 }))
      yield* repo.upsert(
        makeMessageEntry({ id: entryId("ent_other"), conversationId: conversationId("cnv_x"), createdAt: 35 }),
      )
      const first = yield* repo.pageAfter({ conversationId: cnv, after: "20:ent_2", limit: 3 })
      yield* equal(
        first.entries.map((e) => e.id),
        ["ent_3", "ent_4", "ent_5"],
        "after a cursor",
      )
      yield* ok(first.hasMoreAfter && first.afterCursor !== null, "more after")
      const rest = yield* repo.pageAfter({ conversationId: cnv, after: first.afterCursor!, limit: 3 })
      yield* equal(
        rest.entries.map((e) => e.id),
        ["ent_6", "ent_7"],
        "the rest",
      )
      yield* ok(!rest.hasMoreAfter && rest.afterCursor === null, "no more after")
      const tail = yield* repo.page({ conversationId: cnv, limit: 2 })
      yield* equal(
        tail.entries.map((e) => e.id),
        ["ent_6", "ent_7"],
        "page and pageAfter agree",
      )
      const invalid = yield* Effect.exit(repo.pageAfter({ conversationId: cnv, after: "nope", limit: 3 }))
      yield* ok(invalid._tag === "Failure", "an invalid cursor fails")
    }),
  ),
]

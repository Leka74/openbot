// Message search's view models (search.ts, transcriptWindow.ts): the query the filters make, the
// results across pages, the Find bar's steps, term highlighting, and the chat window around a hit.
import { describe, expect, test } from "bun:test"
import type { BotId, ConversationId, ConversationState, EntryId, SearchHit, SearchPage, TranscriptEntry, TranscriptWindow, Turn, TurnId } from "@openbot/contracts"
import {
  appendPage,
  applyWindowPage,
  dateRangeOf,
  DEFAULT_SEARCH_TYPES,
  findLabel,
  findStart,
  findStep,
  highlightParts,
  joinsReplica,
  layoutTranscript,
  messagesAfter,
  newestOf,
  resultCount,
  searchFilters,
  searchQueryOf,
  termRanges,
  windowView,
} from "../src/index.ts"

const cid = "cnv_1" as ConversationId
const msg = (id: string, at: number, revision = 0, text = id): TranscriptEntry =>
  ({
    id: id as EntryId,
    conversationId: cid,
    revision,
    createdAt: at,
    updatedAt: at,
    author: { kind: "user", userId: "owner" },
    kind: "message",
    role: "user",
    text,
    attachments: [],
    streaming: false,
  }) as unknown as TranscriptEntry

describe("search filters → search.query", () => {
  const now = new Date(2026, 9, 23, 12, 0, 0).getTime()
  const groupIds = ["cnv_g1" as ConversationId, "cnv_g2" as ConversationId]

  test("defaults are left out: the brain's own apply (Steps off)", () => {
    expect(DEFAULT_SEARCH_TYPES).toEqual(["messages", "cards", "events", "tasks"])
    expect(searchQueryOf(searchFilters("  deploy  "), { now, groupIds })).toEqual({ query: "deploy" })
  })

  test("every filter", () => {
    const q = searchQueryOf(
      { q: "deploy", botIds: ["bot_a" as BotId], chat: "groups", sender: "owner", date: "7d", types: ["steps", "messages"], sort: "newest" },
      { now, groupIds },
    )
    expect(q).toEqual({
      query: "deploy",
      conversationIds: groupIds,
      botIds: ["bot_a" as BotId],
      senders: ["owner"],
      kinds: ["message", "tool-call"],
      from: now - 7 * 24 * 3600_000,
      sort: "newest",
    })
    expect(searchQueryOf({ ...searchFilters("x"), chat: cid, types: ["events"] }, { now, groupIds })).toEqual({ query: "x", conversationIds: [cid], kinds: ["event", "notice"] })
  })

  test("dates: recent spans and whole local days", () => {
    expect(dateRangeOf("any", now)).toEqual({})
    expect(dateRangeOf("24h", now)).toEqual({ from: now - 24 * 3600_000 })
    expect(dateRangeOf("30d", now)).toEqual({ from: now - 30 * 24 * 3600_000 })
    expect(dateRangeOf({ from: "2026-10-01", to: "2026-10-02" }, now)).toEqual({ from: new Date(2026, 9, 1).getTime(), to: new Date(2026, 9, 3).getTime() - 1 })
    expect(dateRangeOf({ to: "2026-10-02" }, now)).toEqual({ to: new Date(2026, 9, 3).getTime() - 1 })
    expect(dateRangeOf({ from: "2026-02-30" }, now)).toEqual({})
  })
})

const hit = (id: string, at = 1): SearchHit => ({
  ref: { kind: "entry", entryId: id as EntryId },
  conversationId: cid,
  kind: "message",
  author: { kind: "owner" },
  createdAt: at,
  snippet: id,
  highlights: [],
})
const searchPage = (ids: ReadonlyArray<string>, nextCursor: string | null, extra: Partial<SearchPage> = {}): SearchPage => ({ hits: ids.map((id) => hit(id)), nextCursor, totalCapped: 5, terms: ["deploy"], ...extra })

describe("search results", () => {
  test("pages append, repeats dropped, the last cursor wins", () => {
    let r = appendPage(undefined, searchPage(["a", "b"], "c1", { indexing: true }))
    expect([r.hits.map((h) => h.snippet), r.nextCursor, r.indexing]).toEqual([["a", "b"], "c1", true])
    r = appendPage(r, searchPage(["b", "c"], null))
    expect([r.hits.map((h) => h.snippet), r.nextCursor, r.indexing, r.terms]).toEqual([["a", "b", "c"], null, false, ["deploy"]])
  })

  test("counts", () => {
    expect(resultCount(1, 1000)).toBe("1 result")
    expect(resultCount(24, 1000)).toBe("24 results")
    expect(resultCount(1000, 1000)).toBe("1,000+ results")
  })

  test("snippet highlights: clamped, sorted, overlaps merged", () => {
    expect(highlightParts("ship the deploy now", [{ start: 9, end: 15 }])).toEqual([
      { text: "ship the ", mark: false },
      { text: "deploy", mark: true },
      { text: " now", mark: false },
    ])
    expect(highlightParts("abcdef", [{ start: 4, end: 99 }, { start: 0, end: 2 }, { start: 1, end: 3 }])).toEqual([
      { text: "ab", mark: true },
      { text: "c", mark: true },
      { text: "d", mark: false },
      { text: "ef", mark: true },
    ])
    expect(highlightParts("", [])).toEqual([{ text: "", mark: false }])
  })
})

describe("find bar", () => {
  test("starts at the newest, steps wrap", () => {
    let p = findStart(["e1", "e2", "e3"])
    expect([p.index, findLabel(p, false)]).toEqual([2, "3 of 3"])
    p = findStep(p, "newer")
    expect(p.index).toBe(0)
    p = findStep(p, "older")
    expect(p.index).toBe(2)
    p = findStep(findStep(p, "older"), "older")
    expect(findLabel(p, true)).toBe("1 of 3+")
    expect(findLabel(findStart([]), false)).toBe("No results")
    expect(findStep(findStart([]), "older").index).toBe(-1)
  })
})

describe("term ranges", () => {
  test("word starts, any case, diacritics folded, offsets in the original", () => {
    expect(termRanges("Deploy the deployment; redeploy", ["deploy"])).toEqual([
      { start: 0, end: 6 },
      { start: 11, end: 17 },
    ])
    expect(termRanges("Café CAFE cafe", ["cafe"])).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 9 },
      { start: 10, end: 14 },
    ])
    // a decomposed é is two code units in the original: the range covers both
    expect(termRanges("Café!", ["cafe"])).toEqual([{ start: 0, end: 5 }])
    expect(termRanges("emoji 😀 deploy", ["deploy"])).toEqual([{ start: 9, end: 15 }])
  })

  test("overlapping terms merge; none or empty match nothing", () => {
    expect(termRanges("pull request", ["pull", "pull request", "req"])).toEqual([{ start: 0, end: 12 }])
    expect(termRanges("anything", [])).toEqual([])
    expect(termRanges("anything", [""])).toEqual([])
  })
})

const turn = (id: string, status: Turn["status"] = "completed"): Turn => ({ id: id as TurnId, conversationId: cid, botId: "bot_a" as BotId, status, trigger: "user", startedAt: 0 })
const win = (entries: ReadonlyArray<TranscriptEntry>, before: string | null, after: string | null, turns: ReadonlyArray<Turn> = []): TranscriptWindow => ({
  entries,
  hasMoreBefore: before !== null,
  hasMoreAfter: after !== null,
  beforeCursor: before,
  afterCursor: after,
  turns,
  requests: [],
})
const replica = (entries: ReadonlyArray<TranscriptEntry>, turns: ReadonlyArray<Turn> = []): Pick<ConversationState, "entries" | "turns" | "requests"> => ({
  entries: new Map(entries.map((e) => [e.id, e])),
  turns: new Map(turns.map((t) => [t.id, t])),
  requests: new Map(),
})
const ids = (entries: ReadonlyArray<TranscriptEntry>) => entries.map((e) => e.id as string)

describe("chat window", () => {
  test("pages: the first starts it, older / newer extend their side and move only its cursor", () => {
    let w = applyWindowPage(undefined, win([msg("e5", 5), msg("e6", 6)], "b5", "a6", [turn("t1")]), "first")
    expect([ids(w.entries), w.beforeCursor, w.afterCursor, w.turns.size]).toEqual([["e5", "e6"], "b5", "a6", 1])
    w = applyWindowPage(w, win([msg("e3", 3), msg("e4", 4)], null, "x"), "older")
    expect([ids(w.entries), w.beforeCursor, w.afterCursor]).toEqual([["e3", "e4", "e5", "e6"], null, "a6"])
    w = applyWindowPage(w, win([msg("e6", 6, 1), msg("e7", 7)], "y", null, [turn("t1", "failed"), turn("t2")]), "newer")
    expect([ids(w.entries), w.beforeCursor, w.afterCursor, w.entries[3]!.revision, w.turns.get("t1" as TurnId)?.status, w.turns.size]).toEqual([
      ["e3", "e4", "e5", "e6", "e7"],
      null,
      null,
      1,
      "failed",
      2,
    ])
  })

  test("a cursor of a page that says nothing more is dropped", () => {
    const w = applyWindowPage(undefined, { ...win([msg("e1", 1)], null, null), beforeCursor: "stale", afterCursor: "stale" }, "first")
    expect([w.beforeCursor, w.afterCursor]).toEqual([null, null])
  })

  test("joins the replica only once it reaches the newest entry", () => {
    expect(joinsReplica(applyWindowPage(undefined, win([msg("e2", 2)], "b", "a"), "first"))).toBe(false)
    expect(joinsReplica(applyWindowPage(undefined, win([msg("e2", 2)], "b", null), "first"))).toBe(true)
    // touching the replica's oldest entry is not enough: newer pages bring the rest
    expect(joinsReplica(applyWindowPage(undefined, win([msg("e7", 7), msg("e8", 8)], "b", "a"), "first"))).toBe(false)
  })

  test("a reaction to an old window entry patches it in place and leaves the gap to the tail open", () => {
    const w = applyWindowPage(undefined, win([msg("e2", 2), msg("e3", 3)], "b", "a"), "first")
    // the reaction arrives live: the replica now holds e2 next to its own tail (e8, e9)
    const live = replica([msg("e2", 2, 2, "reacted"), msg("e8", 8), msg("e9", 9)])
    const v = windowView(w, live)
    expect([v.joined, ids(v.entries), (v.entries[0] as { text: string }).text]).toEqual([false, ["e2", "e3"], "reacted"])
    // the window's last entry too
    expect(windowView(w, replica([msg("e3", 3, 2, "reacted"), msg("e8", 8)])).joined).toBe(false)
  })

  test("view: the replica's turns at once, its entries only once joined (newer revisions win)", () => {
    const w = applyWindowPage(undefined, win([msg("e2", 2), msg("e3", 3)], "b", "a"), "first")
    const live = replica([msg("e8", 8), msg("e9", 9)], [turn("t9", "running")])
    const v = windowView(w, live)
    expect([v.joined, ids(v.entries), v.turns.has("t9" as TurnId)]).toEqual([false, ["e2", "e3"], true])
    const joined = windowView(applyWindowPage(w, win([msg("e4", 4)], "x", null), "newer"), replica([msg("e1", 1, 2, "older edit"), msg("e3", 3, 2, "edited"), msg("e8", 8), msg("e9", 9)]))
    // e1 is older than the window: its own older page brings it, not the replica
    expect([joined.joined, ids(joined.entries), (joined.entries[1] as { text: string }).text]).toEqual([true, ["e2", "e3", "e4", "e8", "e9"], "edited"])
  })

  test("new messages since a mark", () => {
    const live = replica([msg("e8", 8), msg("e9", 9)])
    const mark = newestOf(live.entries)
    expect(mark?.id as string).toBe("e9")
    expect(messagesAfter(live.entries, mark)).toBe(0)
    expect(messagesAfter(replica([msg("e8", 8), msg("e9", 9), msg("e10", 10)]).entries, mark)).toBe(1)
  })
})

describe("revealed steps", () => {
  test("a turn's steps show for a hit even with steps hidden", () => {
    const tool = {
      id: "tc1" as EntryId,
      conversationId: cid,
      revision: 0,
      createdAt: 2,
      updatedAt: 2,
      author: { kind: "bot", botId: "bot_a" as BotId },
      kind: "tool-call",
      turnId: "t1" as TurnId,
      toolCallId: "call1",
      name: "Bash",
      toolKind: "shell",
      status: "completed",
      input: "ls",
    } as unknown as TranscriptEntry
    const entries = [msg("e1", 1), tool]
    const turns = [turn("t1")]
    expect(layoutTranscript({ entries, turns, showSteps: false }).some((r) => r.type === "steps")).toBe(false)
    expect(layoutTranscript({ entries, turns, showSteps: false, revealSteps: new Set(["t1" as TurnId]) }).some((r) => r.type === "steps")).toBe(true)
  })
})

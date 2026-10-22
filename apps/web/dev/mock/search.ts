// DEV MOCK ONLY: message search over the in-memory chats, close enough to the brain's index for the
// UI: words, "exact phrases" and -excluded words, case and diacritics folded, the last word also a
// prefix; snippets with highlight ranges; relevance / newest / oldest; offset cursors. Also the
// chat windows around an entry (`conversations.around`) and history pages.
import {
  compareEntries,
  DEFAULT_SEARCH_KINDS,
  type KnownTranscriptEntry,
  type RuntimeRequest,
  type SearchHit,
  type SearchKind,
  type SearchPage,
  type SearchPositions,
  type SearchSender,
  SEARCH_TOTAL_CAP,
  type TranscriptWindow,
  type Turn,
} from "@openbot/contracts"

const fold = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()

export interface ParsedQuery {
  /** Words and phrases that must all occur (folded). */
  readonly must: ReadonlyArray<string>
  readonly not: ReadonlyArray<string>
  /** The last bare word, also matched as a prefix. */
  readonly prefix: string | undefined
}

export const parseQuery = (query: string): ParsedQuery => {
  const must: string[] = []
  const not: string[] = []
  let prefix: string | undefined
  for (const m of query.matchAll(/(-?)"([^"]+)"|(-?)(\S+)/g)) {
    const neg = (m[1] ?? m[3]) === "-"
    const text = fold((m[2] ?? m[4] ?? "").replace(/[^\p{L}\p{N}\s'-]/gu, " ").trim())
    if (text === "") continue
    if (neg) not.push(text)
    else {
      must.push(text)
      prefix = m[2] === undefined ? text : undefined
    }
  }
  return { must, not, prefix }
}

const WORD = /[\p{L}\p{N}]/u
/** Word-start occurrences of `term` in folded `text`; a whole word unless `prefix`. */
const occurrences = (text: string, term: string, prefix: boolean): number[] => {
  const out: number[] = []
  let from = 0
  for (;;) {
    const at = text.indexOf(term, from)
    if (at < 0) return out
    from = at + 1
    if (at > 0 && WORD.test(text[at - 1]!)) continue
    const after = text[at + term.length]
    if (!prefix && after !== undefined && WORD.test(after)) continue
    out.push(at)
  }
}

/** What the index holds for an entry (undefined: not searchable). */
export const textOf = (e: KnownTranscriptEntry): { readonly kind: SearchKind; readonly text: string } | undefined => {
  switch (e.kind) {
    case "message":
      return { kind: "message", text: [e.text, ...e.attachments.map((a) => a.name)].join("\n") }
    case "card": {
      const c = e.card as { title?: string; summary?: string; command?: string; text?: string; question?: string; prompt?: string }
      return { kind: "card", text: [c.title, c.summary, c.question, c.command, c.text, c.prompt].filter(Boolean).join("\n") }
    }
    case "notice":
      return { kind: "notice", text: e.text }
    case "tool-call":
      return { kind: "tool-call", text: [e.inputSummary, e.command?.command, e.output?.text, e.error].filter(Boolean).join("\n") }
    case "event": {
      const ev = e.event as { type: string; summary?: string; task?: string; title?: string; routineName?: string; to?: string; name?: string }
      if (ev.type === "session-changed" || ev.type === "auto-decided") return undefined
      const text = [ev.summary, ev.task, ev.title, ev.routineName, ev.to, ev.name].filter(Boolean).join("\n")
      return text === "" ? undefined : { kind: "event", text }
    }
    default:
      return undefined
  }
}

interface Match {
  readonly entry: KnownTranscriptEntry
  readonly kind: SearchKind
  readonly text: string
  readonly score: number
  /** Matched ranges in `text` (folding keeps lengths for the mock's texts). */
  readonly ranges: ReadonlyArray<{ readonly start: number; readonly end: number }>
}

const matchEntry = (entry: KnownTranscriptEntry, q: ParsedQuery): Match | undefined => {
  const doc = textOf(entry)
  if (doc === undefined || doc.text === "") return undefined
  const text = fold(doc.text)
  if (text.length !== doc.text.length) return undefined
  const ranges: Array<{ start: number; end: number }> = []
  for (const term of q.must) {
    const at = occurrences(text, term, term === q.prefix)
    if (at.length === 0) return undefined
    for (const a of at) ranges.push({ start: a, end: term === q.prefix ? a + term.length + (text.slice(a + term.length).match(/^[\p{L}\p{N}]*/u)?.[0].length ?? 0) : a + term.length })
  }
  for (const term of q.not) if (occurrences(text, term, false).length > 0) return undefined
  return { entry, kind: doc.kind, text: doc.text, score: ranges.length, ranges: ranges.sort((a, b) => a.start - b.start) }
}

/** ~140 characters around the first match, `…` where cut, ranges moved into it. */
const snippetOf = (m: Match): Pick<SearchHit, "snippet" | "highlights"> => {
  const flat = m.text.replace(/\s+/g, " ")
  // whitespace runs collapse: map the ranges through the same collapse
  const map: number[] = []
  let j = 0
  for (let i = 0; i < m.text.length; i++) {
    map.push(j)
    if (!(/\s/.test(m.text[i]!) && i > 0 && /\s/.test(m.text[i - 1]!))) j++
  }
  map.push(j)
  const ranges = m.ranges.map((r) => ({ start: map[r.start]!, end: map[r.end]! }))
  const first = ranges[0]?.start ?? 0
  const start = Math.max(0, first - 50)
  const end = Math.min(flat.length, start + 140)
  const lead = start > 0 ? "…" : ""
  const snippet = `${lead}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`
  const highlights = ranges.filter((r) => r.start >= start && r.end <= end).map((r) => ({ start: r.start - start + lead.length, end: r.end - start + lead.length }))
  return { snippet, highlights }
}

export interface SearchSource {
  readonly conversations: ReadonlyArray<{
    readonly id: string
    readonly kind: string
    readonly memberBotIds: ReadonlyArray<string>
    readonly entries: ReadonlyArray<KnownTranscriptEntry>
    readonly turns: ReadonlyMap<string, Turn>
  }>
}

const visible = (e: KnownTranscriptEntry, turns: ReadonlyMap<string, Turn>) => e.turnId === undefined || turns.get(e.turnId)?.voice !== true

export const search = (
  source: SearchSource,
  input: {
    readonly query: string
    readonly conversationIds?: ReadonlyArray<string>
    readonly botIds?: ReadonlyArray<string>
    readonly senders?: ReadonlyArray<SearchSender>
    readonly kinds?: ReadonlyArray<SearchKind>
    readonly from?: number
    readonly to?: number
    readonly sort?: "relevance" | "newest" | "oldest"
    readonly cursor?: string
    readonly limit: number
  },
): SearchPage => {
  const q = parseQuery(input.query)
  const kinds = new Set(input.kinds ?? DEFAULT_SEARCH_KINDS)
  const terms = [...q.must.flatMap((t) => t.split(/\s+/))]
  if (q.must.length === 0) return { hits: [], nextCursor: null, totalCapped: 0, terms }
  const matches: Match[] = []
  for (const c of source.conversations) {
    if (input.conversationIds && !input.conversationIds.includes(c.id)) continue
    for (const e of c.entries) {
      if (!visible(e, c.turns)) continue
      if (input.botIds && input.botIds.length > 0) {
        const author = e.author.kind === "bot" ? e.author.botId : undefined
        if (!input.botIds.some((b) => c.memberBotIds.includes(b) || b === author)) continue
      }
      if (input.senders && input.senders.length > 0) {
        const who = e.author.kind === "user" ? "owner" : e.author.kind === "bot" ? e.author.botId : "system"
        if (!input.senders.includes(who as SearchSender)) continue
      }
      if (input.from !== undefined && e.createdAt < input.from) continue
      if (input.to !== undefined && e.createdAt > input.to) continue
      const m = matchEntry(e, q)
      if (m && kinds.has(m.kind)) matches.push(m)
    }
  }
  const sort = input.sort ?? "relevance"
  matches.sort((a, b) =>
    sort === "oldest" ? compareEntries(a.entry, b.entry) : sort === "newest" ? compareEntries(b.entry, a.entry) : b.score - a.score || compareEntries(b.entry, a.entry),
  )
  const offset = Number(input.cursor ?? 0) || 0
  const page = matches.slice(offset, offset + Math.min(input.limit, 50))
  const hits: SearchHit[] = page.map((m) => ({
    ref: { kind: "entry", entryId: m.entry.id },
    conversationId: m.entry.conversationId,
    kind: m.kind,
    author: m.entry.author.kind === "user" ? { kind: "owner" } : m.entry.author.kind === "bot" ? { kind: "bot", botId: m.entry.author.botId } : { kind: "system" },
    ...(m.entry.kind === "message" && m.entry.toBotId !== undefined ? { toBotId: m.entry.toBotId } : {}),
    ...(m.entry.turnId !== undefined ? { turnId: m.entry.turnId } : {}),
    createdAt: m.entry.createdAt,
    ...snippetOf(m),
  }))
  const next = offset + page.length
  return { hits, nextCursor: next < matches.length ? String(next) : null, totalCapped: Math.min(matches.length, SEARCH_TOTAL_CAP), terms }
}

export const positions = (
  conversation: SearchSource["conversations"][number],
  input: { readonly query: string; readonly kinds?: ReadonlyArray<SearchKind>; readonly limit: number },
): SearchPositions => {
  const q = parseQuery(input.query)
  const kinds = new Set(input.kinds ?? DEFAULT_SEARCH_KINDS)
  const hits = conversation.entries
    .filter((e) => visible(e, conversation.turns))
    .map((e) => matchEntry(e, q))
    .filter((m): m is Match => m !== undefined && kinds.has(m.kind))
    .map((m) => ({ entryId: m.entry.id, createdAt: m.entry.createdAt }))
  const kept = hits.slice(Math.max(0, hits.length - input.limit))
  return { hits: kept, more: kept.length < hits.length, terms: q.must.flatMap((t) => t.split(/\s+/)) }
}

// ------------------------------------------------------------------------------------ windows

const cursorOf = (e: { readonly createdAt: number; readonly id: string }) => `${e.createdAt}:${e.id}`
const positionOf = (c: string) => ({ createdAt: Number(c.slice(0, c.indexOf(":"))), id: c.slice(c.indexOf(":") + 1) })

/** Entries the chat shows, oldest first (voice-call work left out, like the brain's pages). */
const shown = (entries: ReadonlyArray<KnownTranscriptEntry>, turns: ReadonlyMap<string, Turn>) => [...entries].filter((e) => visible(e, turns)).sort(compareEntries)

const windowOf = (
  all: ReadonlyArray<KnownTranscriptEntry>,
  start: number,
  end: number,
  turns: ReadonlyMap<string, Turn>,
  requests: ReadonlyArray<RuntimeRequest>,
): TranscriptWindow => {
  const entries = all.slice(start, end)
  const turnIds = new Set(entries.flatMap((e) => (e.turnId ? [e.turnId as string] : [])))
  const cardIds = new Set(entries.filter((e) => e.kind === "card").map((e) => e.id as string))
  return {
    entries,
    hasMoreBefore: start > 0,
    hasMoreAfter: end < all.length,
    beforeCursor: start > 0 && entries[0] ? cursorOf(entries[0]) : null,
    afterCursor: end < all.length && entries.length > 0 ? cursorOf(entries[entries.length - 1]!) : null,
    ...(start > 0 ? { precedingTimestamp: all[start - 1]!.createdAt } : {}),
    turns: [...turns.values()].filter((t) => turnIds.has(t.id)),
    requests: requests.filter((r) => cardIds.has(r.cardEntryId)),
  }
}

export const around = (
  conversation: { readonly entries: ReadonlyArray<KnownTranscriptEntry>; readonly turns: ReadonlyMap<string, Turn>; readonly requests: ReadonlyArray<RuntimeRequest> },
  input: { readonly entryId?: string; readonly beforeCursor?: string; readonly afterCursor?: string; readonly limit: number },
): TranscriptWindow | undefined => {
  const all = shown(conversation.entries, conversation.turns)
  const limit = Math.max(1, Math.min(input.limit, 200))
  const count = (c: string, inclusive: boolean) => all.filter((e) => compareEntries(e, positionOf(c)) < (inclusive ? 1 : 0)).length
  let start: number
  let end: number
  if (input.beforeCursor) {
    end = count(input.beforeCursor, false)
    start = Math.max(0, end - limit)
  } else if (input.afterCursor) {
    start = count(input.afterCursor, true)
    end = Math.min(all.length, start + limit)
  } else if (input.entryId) {
    const i = all.findIndex((e) => e.id === input.entryId)
    if (i < 0) return undefined
    start = Math.max(0, i - Math.floor(limit / 2))
    end = Math.min(all.length, start + limit)
    start = Math.max(0, end - limit)
  } else {
    end = all.length
    start = Math.max(0, end - limit)
  }
  return windowOf(all, start, end, conversation.turns, conversation.requests)
}

/** `conversations.history`: the page before a cursor. */
export const historyBefore = (conversation: { readonly entries: ReadonlyArray<KnownTranscriptEntry>; readonly turns: ReadonlyMap<string, Turn> }, beforeCursor: string, limit: number) => {
  const all = shown(conversation.entries, conversation.turns)
  const end = all.filter((e) => compareEntries(e, positionOf(beforeCursor)) < 0).length
  const start = Math.max(0, end - limit)
  const entries = all.slice(start, end)
  return { entries, hasMoreBefore: start > 0, beforeCursor: start > 0 && entries[0] ? cursorOf(entries[0]) : null }
}

/** The newest `n` entries of a snapshot and the cursor before them (like the brain's LiveHub). */
export const SNAPSHOT_ENTRIES = 100
export const snapshotTail = (entries: ReadonlyArray<KnownTranscriptEntry>) => {
  const sorted = [...entries].sort(compareEntries)
  const start = Math.max(0, sorted.length - SNAPSHOT_ENTRIES)
  const kept = sorted.slice(start)
  return { entries: kept, hasMoreBefore: start > 0, beforeCursor: start > 0 && kept[0] ? cursorOf(kept[0]) : null }
}

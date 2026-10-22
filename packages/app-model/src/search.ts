// Message search's view models (pure, unit-tested): the owner's search filters and the
// `search.query` payload they make, the results list across pages, the Find bar's position among a
// chat's hits, and the client-side term matching that highlights hits in the chat (the same folding
// the brain's index uses: case-insensitive, diacritics removed).
import { type BotId, type ConversationId, DEFAULT_SEARCH_KINDS, type SearchHit, type SearchKind, type SearchPage, type SearchSender } from "@openbot/contracts"

// ------------------------------------------------------------------------------------- filters

/** The Search view's Type filter; each stands for one or more `SearchKind`s. */
export type SearchType = "messages" | "cards" | "events" | "tasks" | "steps"
export const SEARCH_TYPES: ReadonlyArray<SearchType> = ["messages", "cards", "events", "tasks", "steps"]
const KINDS_OF: Readonly<Record<SearchType, ReadonlyArray<SearchKind>>> = {
  messages: ["message"],
  cards: ["card"],
  events: ["event", "notice"],
  tasks: ["task"],
  steps: ["tool-call"],
}
/** Everything but tool steps (`DEFAULT_SEARCH_KINDS`); "Steps" is off until the owner turns it on. */
export const DEFAULT_SEARCH_TYPES: ReadonlyArray<SearchType> = SEARCH_TYPES.filter((t) => KINDS_OF[t].every((k) => DEFAULT_SEARCH_KINDS.includes(k)))

/** Any time, the last 24 h / 7 / 30 days, or a range of local days (`YYYY-MM-DD`, both inclusive). */
export type SearchDate = "any" | "24h" | "7d" | "30d" | { readonly from?: string | undefined; readonly to?: string | undefined }

/** The owner's search: what the Search view shows and the URL keeps (`#/search?…`). */
export interface SearchFilters {
  readonly q: string
  /** Chats each Bot is in, plus what it wrote anywhere (its bot-to-bot messages). */
  readonly botIds: ReadonlyArray<BotId>
  /** One chat, or every group chat. */
  readonly chat?: ConversationId | "groups" | undefined
  readonly sender?: SearchSender | undefined
  readonly date: SearchDate
  readonly types: ReadonlyArray<SearchType>
  readonly sort: "relevance" | "newest"
}

export const searchFilters = (q = ""): SearchFilters => ({ q, botIds: [], date: "any", types: DEFAULT_SEARCH_TYPES, sort: "relevance" })

/** Same types, in `SEARCH_TYPES` order, without repeats. */
export const normalizeTypes = (types: ReadonlyArray<SearchType>): ReadonlyArray<SearchType> => SEARCH_TYPES.filter((t) => types.includes(t))

export const isDefaultTypes = (types: ReadonlyArray<SearchType>): boolean => {
  const n = normalizeTypes(types)
  return n.length === DEFAULT_SEARCH_TYPES.length && n.every((t, i) => t === DEFAULT_SEARCH_TYPES[i])
}

const DAY = 24 * 60 * 60 * 1000
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** Local midnight of a `YYYY-MM-DD` day; undefined when it isn't one. */
export const dayStart = (day: string): number | undefined => {
  const m = ISO_DAY.exec(day)
  if (!m) return undefined
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d.getTime() : undefined
}

/** The local day of `at` as `YYYY-MM-DD`. */
export const dayOf = (at: number): string => {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/** `createdAt` bounds (inclusive) of a date filter at `now`. */
export const dateRangeOf = (date: SearchDate, now: number): { readonly from?: number; readonly to?: number } => {
  switch (date) {
    case "any":
      return {}
    case "24h":
      return { from: now - DAY }
    case "7d":
      return { from: now - 7 * DAY }
    case "30d":
      return { from: now - 30 * DAY }
    default: {
      const from = date.from === undefined ? undefined : dayStart(date.from)
      const end = date.to === undefined ? undefined : dayStart(date.to)
      // the end day is whole: up to the last millisecond before the next local midnight
      const to = end === undefined ? undefined : new Date(new Date(end).setDate(new Date(end).getDate() + 1)).getTime() - 1
      return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) }
    }
  }
}

/** `search.query`'s payload, without the page (`cursor`, `limit`). */
export interface SearchQueryInput {
  readonly query: string
  readonly conversationIds?: ReadonlyArray<ConversationId>
  readonly botIds?: ReadonlyArray<BotId>
  readonly senders?: ReadonlyArray<SearchSender>
  readonly kinds?: ReadonlyArray<SearchKind>
  readonly from?: number
  readonly to?: number
  readonly sort?: "relevance" | "newest"
}

/**
 * The query the filters make. `groupIds`: the group chats ("Group chats" searches those);
 * defaults are left out so the brain's own defaults apply.
 */
export const searchQueryOf = (filters: SearchFilters, context: { readonly now: number; readonly groupIds: ReadonlyArray<ConversationId> }): SearchQueryInput => {
  const range = dateRangeOf(filters.date, context.now)
  const conversationIds = filters.chat === undefined ? undefined : filters.chat === "groups" ? context.groupIds : [filters.chat]
  return {
    query: filters.q.trim(),
    ...(conversationIds === undefined ? {} : { conversationIds }),
    ...(filters.botIds.length > 0 ? { botIds: filters.botIds } : {}),
    ...(filters.sender === undefined ? {} : { senders: [filters.sender] }),
    ...(isDefaultTypes(filters.types) ? {} : { kinds: normalizeTypes(filters.types).flatMap((t) => KINDS_OF[t]) }),
    ...range,
    ...(filters.sort === "relevance" ? {} : { sort: filters.sort }),
  }
}

/** Search needs at least this many characters (the palette's Messages section, the Search view). */
export const SEARCH_MIN_CHARS = 2

export const isSearchable = (q: string): boolean => q.trim().length >= SEARCH_MIN_CHARS

/** Where a hit opens: its entry, a task's report (when the brain found one); undefined = the chat. */
export const hitEntryId = (hit: SearchHit): string | undefined => (hit.ref.kind === "entry" ? hit.ref.entryId : hit.jumpEntryId)

/** A stable key per hit (entries and tasks have separate id spaces). */
export const hitKey = (hit: SearchHit): string => (hit.ref.kind === "entry" ? `e:${hit.ref.entryId}` : `t:${hit.ref.taskId}`)

// ------------------------------------------------------------------------------------- results

/** The results so far: the first page, then the pages after it (`nextCursor`). */
export interface SearchResults {
  readonly hits: ReadonlyArray<SearchHit>
  readonly nextCursor: string | null
  readonly totalCapped: number
  readonly terms: ReadonlyArray<string>
  readonly indexing: boolean
}

/** The results after a page arrives: the first starts them, a later one appends (repeats dropped). */
export const appendPage = (results: SearchResults | undefined, page: SearchPage): SearchResults => {
  if (results === undefined) {
    return { hits: page.hits, nextCursor: page.nextCursor, totalCapped: page.totalCapped, terms: page.terms, indexing: page.indexing === true }
  }
  const seen = new Set(results.hits.map(hitKey))
  return {
    hits: [...results.hits, ...page.hits.filter((h) => !seen.has(hitKey(h)))],
    nextCursor: page.nextCursor,
    totalCapped: Math.max(results.totalCapped, page.totalCapped),
    terms: results.terms,
    indexing: results.indexing && page.indexing === true,
  }
}

/** "1 result", "24 results", "1,000+ results" (the brain counts up to `cap`). */
export const resultCount = (total: number, cap: number): string =>
  `${total >= cap ? `${cap.toLocaleString("en-US")}+` : total.toLocaleString("en-US")} ${total === 1 ? "result" : "results"}`

/** A snippet cut into plain and highlighted parts (ranges in UTF-16 units, clamped, overlaps merged). */
export const highlightParts = (text: string, ranges: ReadonlyArray<{ readonly start: number; readonly end: number }>): ReadonlyArray<{ readonly text: string; readonly mark: boolean }> => {
  const sorted = ranges
    .map((r) => ({ start: Math.max(0, Math.min(r.start, text.length)), end: Math.max(0, Math.min(r.end, text.length)) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start)
  const parts: Array<{ text: string; mark: boolean }> = []
  let at = 0
  for (const r of sorted) {
    const start = Math.max(r.start, at)
    if (r.end <= start) continue
    if (start > at) parts.push({ text: text.slice(at, start), mark: false })
    parts.push({ text: text.slice(start, r.end), mark: true })
    at = r.end
  }
  if (at < text.length || parts.length === 0) parts.push({ text: text.slice(at), mark: false })
  return parts
}

// ------------------------------------------------------------------------------------ find bar

/** The Find bar: a chat's hits (oldest first) and the one on screen. */
export interface FindPosition {
  readonly hits: ReadonlyArray<string>
  /** Index into `hits`; -1 when there are none. */
  readonly index: number
}

/** New hits start at the newest. */
export const findStart = (hits: ReadonlyArray<string>): FindPosition => ({ hits, index: hits.length - 1 })

/** One step: "older" goes up the chat, "newer" down; both wrap around. */
export const findStep = (position: FindPosition, direction: "older" | "newer"): FindPosition => {
  const n = position.hits.length
  if (n === 0) return position
  const index = direction === "older" ? (position.index - 1 + n) % n : (position.index + 1) % n
  return { ...position, index }
}

/** "3 of 17" ("1,000+" when the brain left older hits out). */
export const findLabel = (position: FindPosition, more: boolean): string => {
  const n = position.hits.length
  if (n === 0) return "No results"
  const total = more ? `${n.toLocaleString("en-US")}+` : n.toLocaleString("en-US")
  return `${(position.index + 1).toLocaleString("en-US")} of ${total}`
}

// ------------------------------------------------------------------------------ term matching

/** A character as the index compares it: lower case, without diacritics (may be empty or longer). */
const foldChar = (ch: string): string => ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()

/** `text` folded, with each folded unit's offset in the original. */
export const foldWithMap = (text: string): { readonly folded: string; readonly map: ReadonlyArray<number> } => {
  let folded = ""
  const map: number[] = []
  let i = 0
  for (const ch of text) {
    const f = foldChar(ch)
    folded += f
    for (let k = 0; k < f.length; k++) map.push(i)
    i += ch.length
  }
  map.push(i)
  return { folded, map }
}

export const fold = (text: string): string => foldWithMap(text).folded

const WORD = /[\p{L}\p{N}]/u

/**
 * Where the search terms occur in `text`, as `[start, end)` ranges of the original: a term matches
 * at the start of a word (the index matches words and prefixes), case- and diacritic-insensitively.
 */
export const termRanges = (text: string, terms: ReadonlyArray<string>): ReadonlyArray<{ readonly start: number; readonly end: number }> => {
  const wanted = [...new Set(terms.map(fold).filter((t) => t.length > 0))]
  if (wanted.length === 0 || text.length === 0) return []
  const { folded, map } = foldWithMap(text)
  const found: Array<{ start: number; end: number }> = []
  for (const term of wanted) {
    let from = 0
    for (;;) {
      const at = folded.indexOf(term, from)
      if (at < 0) break
      from = at + 1
      if (at > 0 && WORD.test(folded[at - 1]!) && WORD.test(term[0]!)) continue
      found.push({ start: map[at]!, end: map[at + term.length]! })
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: Array<{ start: number; end: number }> = []
  for (const r of found) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else merged.push({ ...r })
  }
  return merged
}

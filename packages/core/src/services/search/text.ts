/**
 * Message search, the pure part: what text of an entry or a task is searchable (`searchDocOfEntry`,
 * `searchDocOfTask`), how the owner's or a bot's words become a query (`parseSearchQuery`,
 * `toFtsQuery`), and snippets with highlight ranges. Shared by the SQLite index (FTS5,
 * `unicode61 remove_diacritics 2`) and the in-memory double, so both index the same text.
 *
 * Bump `SEARCH_TEXT_VERSION` whenever the derivation changes: the brain then rebuilds the index in
 * the background at its next boot.
 */
import type {
  BotId,
  ConversationId,
  KnownTranscriptEntry,
  SearchHighlight,
  SearchKind,
  SearchSort,
  Task,
  TranscriptEntry,
  TurnId,
} from "@openbot/contracts"

export const SEARCH_TEXT_VERSION = 1

/** Caps on indexed text (characters). Tool output is mostly noise past its start. */
export const SEARCH_TEXT_MAX_CHARS = 32_000
export const SEARCH_TOOL_OUTPUT_MAX_CHARS = 2_000

/** One searchable item: an entry of a chat, or a task's brief and result. */
export interface SearchDoc {
  readonly source: "entry" | "task"
  /** Entry id or task id. */
  readonly refId: string
  readonly conversationId: ConversationId
  readonly turnId?: TurnId | undefined
  readonly kind: SearchKind
  readonly authorKind: "user" | "bot" | "system"
  readonly authorBotId?: BotId | undefined
  /** Bot-to-bot messages (`message_bot`): the recipient. */
  readonly toBotId?: BotId | undefined
  readonly createdAt: number
  readonly text: string
}

const joinText = (parts: ReadonlyArray<string | undefined>): string =>
  parts
    .filter((part): part is string => part !== undefined && part.trim() !== "")
    .join(" \n ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SEARCH_TEXT_MAX_CHARS)

const names = (files: ReadonlyArray<{ readonly name: string }> | undefined): string | undefined =>
  files === undefined || files.length === 0 ? undefined : files.map((file) => file.name).join(" ")

/** The searchable text of an entry; undefined when it has none (reasoning, housekeeping, streaming). */
export const searchTextOfEntry = (entry: KnownTranscriptEntry): string | undefined => {
  switch (entry.kind) {
    case "message":
      return entry.streaming ? undefined : joinText([entry.text, names(entry.attachments)])
    case "reasoning":
      return undefined
    case "notice":
      return joinText([entry.text])
    case "tool-call":
      return joinText([
        entry.title,
        entry.name,
        entry.inputSummary,
        entry.command?.command,
        entry.fileChanges?.map((change) => change.path).join(" "),
        entry.output?.text?.slice(0, SEARCH_TOOL_OUTPUT_MAX_CHARS),
        entry.error?.slice(0, SEARCH_TOOL_OUTPUT_MAX_CHARS),
      ])
    case "card": {
      const card = entry.card
      switch (card.type) {
        case "approval":
          return joinText([card.taskTitle, card.title, card.summary, card.command, card.paths?.join(" ")])
        case "question":
          return joinText([
            card.taskTitle,
            card.title,
            ...card.questions.flatMap((q) => [q.header, q.prompt, ...q.options.map((option) => option.label)]),
          ])
        case "form":
          return joinText([card.title, card.description, ...card.fields.map((field) => field.label)])
        case "secret-request":
          return joinText([card.label, card.description])
        case "handoff":
          return joinText([card.instruction])
        case "routine":
          return joinText([card.name, card.triggerSummary, card.prompt])
        case "slack-draft":
          return joinText([card.to, card.threadLabel, card.text, names(card.files)])
        default:
          return undefined
      }
    }
    case "event": {
      const event = entry.event
      switch (event.type) {
        case "name-changed":
          return joinText([event.to])
        case "joined":
        case "member-added":
        case "member-removed":
          return joinText([event.name])
        case "posted-to-group":
          return joinText([event.title])
        case "handoff":
          return joinText([event.toName, event.task])
        case "routine-changed":
        case "routine-run":
          return joinText([event.routineName])
        case "memory-updated":
          return joinText([event.title])
        case "skill-saved":
          return joinText([event.name])
        case "voice-call":
          return joinText(event.lines.map((line) => line.text))
        // auto-decided (an audit line), messaged-bot (the message itself is indexed in the
        // recipient's chat) and the rest carry nothing worth finding.
        default:
          return undefined
      }
    }
  }
}

/** The search doc of an entry, or undefined when nothing of it is searchable (yet). */
export const searchDocOfEntry = (entry: TranscriptEntry): SearchDoc | undefined => {
  if (entry.kind === "unknown") return undefined
  const text = searchTextOfEntry(entry)
  if (text === undefined || text === "") return undefined
  return {
    source: "entry",
    refId: entry.id,
    conversationId: entry.conversationId,
    turnId: entry.turnId,
    kind: entry.kind as SearchKind,
    authorKind: entry.author.kind,
    authorBotId: entry.author.kind === "bot" ? entry.author.botId : undefined,
    toBotId: entry.kind === "message" ? entry.toBotId : undefined,
    createdAt: entry.createdAt,
    text,
  }
}

/** A task's title, brief and result (or why it failed), dated when it ended. */
export const searchDocOfTask = (task: Task): SearchDoc | undefined => {
  const text = joinText([task.title, task.brief, task.result ?? task.error])
  if (text === "") return undefined
  return {
    source: "task",
    refId: task.id,
    conversationId: task.conversationId,
    kind: "task",
    authorKind: "bot",
    authorBotId: task.botId,
    createdAt: task.endedAt ?? task.createdAt,
    text,
  }
}

/** Whether a stored entry is still being written (its searchable text is not final yet). */
export const isStreamingEntry = (entry: TranscriptEntry): boolean =>
  (entry.kind === "message" || entry.kind === "reasoning") && entry.streaming

// ============================================================================ words

/** Lower case without diacritics, like the index's tokenizer ("Lekë" → "leke"). */
export const foldText = (text: string): string => text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase()

const TOKEN = /[\p{L}\p{N}\p{M}]+/gu

/** The index's tokens of `text`, with their ranges in `text`. */
export const tokenSpans = (text: string): Array<{ readonly token: string; readonly start: number; readonly end: number }> => {
  const spans: Array<{ token: string; start: number; end: number }> = []
  for (const match of text.matchAll(TOKEN)) {
    const token = foldText(match[0])
    if (token !== "") spans.push({ token, start: match.index, end: match.index + match[0].length })
  }
  return spans
}

export const tokenize = (text: string): Array<string> => tokenSpans(text).map((span) => span.token)

// ============================================================================ queries

/** A word or an exact phrase (folded tokens in order); `prefix`: its last token may be cut short. */
export interface SearchTerm {
  readonly tokens: ReadonlyArray<string>
  readonly prefix: boolean
}

/** A parsed query: every `include` term must match and no `exclude` term may. */
export interface SearchMatch {
  readonly include: ReadonlyArray<SearchTerm>
  readonly exclude: ReadonlyArray<SearchTerm>
  /** The folded words looked for (highlighting). */
  readonly terms: ReadonlyArray<string>
}

const MAX_TERMS = 16
const MAX_TOKEN_CHARS = 64
const PART = /(-?)"([^"]*)"?|(-?)([^\s"]+)/g

/**
 * The owner's (or a bot's) words → a query. Words and "quoted phrases" must all match, `-word`
 * excludes, and the last word also matches as a prefix while it is being typed (no trailing space).
 * Never raw FTS syntax: operators, column filters and punctuation are plain text. Undefined when
 * nothing is left to look for.
 */
export const parseSearchQuery = (input: string): SearchMatch | undefined => {
  const include: Array<SearchTerm> = []
  const exclude: Array<SearchTerm> = []
  let lastBare: { readonly term: SearchTerm; readonly end: number } | undefined
  for (const part of input.matchAll(PART)) {
    if (include.length + exclude.length >= MAX_TERMS) break
    const quoted = part[2] !== undefined
    const negated = (quoted ? part[1] : part[3]) === "-"
    const tokens = tokenize(quoted ? part[2]! : part[4]!).map((token) => token.slice(0, MAX_TOKEN_CHARS))
    if (tokens.length === 0) continue
    const term: SearchTerm = { tokens, prefix: false }
    if (negated) exclude.push(term)
    else {
      include.push(term)
      lastBare = quoted ? undefined : { term, end: part.index + part[0].length }
    }
  }
  if (include.length === 0) return undefined
  const last = include[include.length - 1]!
  // A one-letter prefix would match nearly every word: it stays a whole word.
  const typing = lastBare !== undefined && lastBare.term === last && lastBare.end === input.trimEnd().length && !/\s$/.test(input)
  if (typing && last.tokens[last.tokens.length - 1]!.length > 1) {
    include[include.length - 1] = { ...last, prefix: true }
  }
  const terms = [...new Set(include.flatMap((term) => term.tokens))]
  return { include, exclude, terms }
}

const ftsTerm = (term: SearchTerm): string => `"${term.tokens.join(" ")}"${term.prefix ? "*" : ""}`

/** The FTS5 MATCH expression of a parsed query (tokens are letters and digits only: nothing to escape). */
export const toFtsQuery = (match: SearchMatch): string => {
  const include = match.include.map(ftsTerm).join(" AND ")
  return match.exclude.reduce((query, term) => `${query} NOT ${ftsTerm(term)}`, `(${include})`)
}

// ============================================================================ matching (in-memory index)

const termAt = (tokens: ReadonlyArray<string>, at: number, term: SearchTerm): boolean =>
  term.tokens.every((token, i) => {
    const candidate = tokens[at + i]
    if (candidate === undefined) return false
    return term.prefix && i === term.tokens.length - 1 ? candidate.startsWith(token) : candidate === token
  })

/** Token positions where `term` starts in `tokens`. */
export const termPositions = (tokens: ReadonlyArray<string>, term: SearchTerm): Array<number> => {
  const positions: Array<number> = []
  for (let at = 0; at < tokens.length; at++) if (termAt(tokens, at, term)) positions.push(at)
  return positions
}

// ============================================================================ snippets

/** Highlight sentinels in snippets from the index (FTS5 `snippet()` start / end marks). */
export const SNIPPET_OPEN = "\u0002"
export const SNIPPET_CLOSE = "\u0003"
export const SNIPPET_ELLIPSIS = "…"
/** Tokens per snippet. */
export const SNIPPET_TOKENS = 24

/** A snippet with sentinels → plain text and highlight ranges. */
export const parseSnippet = (raw: string): { readonly snippet: string; readonly highlights: ReadonlyArray<SearchHighlight> } => {
  let snippet = ""
  const highlights: Array<SearchHighlight> = []
  let open: number | undefined
  for (const char of raw) {
    if (char === SNIPPET_OPEN) open = snippet.length
    else if (char === SNIPPET_CLOSE) {
      if (open !== undefined && snippet.length > open) highlights.push({ start: open, end: snippet.length })
      open = undefined
    } else snippet += char
  }
  return { snippet, highlights }
}

/** Texts longer than this are only tokenized around the first occurrence of a looked-for word. */
const SNIPPET_SCAN_CHARS = 2_000

const snippetOf = (text: string, match: SearchMatch | undefined, cutBefore: boolean, cutAfter: boolean): string | undefined => {
  const spans = tokenSpans(text)
  const tokens = spans.map((span) => span.token)
  const marked = new Set<number>()
  for (const term of match?.include ?? []) {
    for (const at of termPositions(tokens, term)) for (let i = 0; i < term.tokens.length; i++) marked.add(at + i)
  }
  if (marked.size === 0 && (cutBefore || cutAfter)) return undefined
  if (spans.length === 0) return text.slice(0, 200)
  const first = marked.size === 0 ? 0 : Math.min(...marked)
  const start = Math.max(0, Math.min(first - 2, spans.length - SNIPPET_TOKENS))
  const end = Math.min(spans.length, start + SNIPPET_TOKENS)
  let out = start > 0 || cutBefore ? SNIPPET_ELLIPSIS : ""
  let cursor = start > 0 ? spans[start]!.start : 0
  for (let i = start; i < end; i++) {
    const span = spans[i]!
    out += text.slice(cursor, span.start)
    out += marked.has(i) ? `${SNIPPET_OPEN}${text.slice(span.start, span.end)}${SNIPPET_CLOSE}` : text.slice(span.start, span.end)
    cursor = span.end
  }
  out += end < spans.length ? SNIPPET_ELLIPSIS : `${text.slice(cursor)}${cutAfter ? SNIPPET_ELLIPSIS : ""}`
  return out
}

/**
 * A snippet of `text` around its first match: up to `SNIPPET_TOKENS` tokens with the matched ones
 * marked by the sentinels (the index's tokens, so it highlights what the index matched).
 */
export const makeSnippet = (text: string, match: SearchMatch | undefined): string => {
  if (text.length > SNIPPET_SCAN_CHARS && match !== undefined) {
    const folded = foldText(text)
    // positions carry over only when folding kept the length
    if (folded.length === text.length) {
      const found = match.include.map((term) => folded.indexOf(term.tokens[0]!)).filter((at) => at >= 0)
      if (found.length > 0) {
        const at = Math.min(...found)
        const start = Math.max(0, at - 400)
        const end = Math.min(text.length, at + 1_200)
        const near = snippetOf(text.slice(start, end), match, start > 0, end < text.length)
        if (near !== undefined) return near
      }
    }
  }
  return snippetOf(text, match, false, false)!
}

/**
 * A substring snippet (queries without words, e.g. punctuation): the text around the first
 * case-insensitive occurrence, marked.
 */
export const makeSubstringSnippet = (text: string, needle: string): string => {
  const at = text.toLowerCase().indexOf(needle.toLowerCase())
  if (at < 0 || needle === "") return text.slice(0, 200)
  const start = Math.max(0, at - 60)
  const end = Math.min(text.length, at + needle.length + 100)
  return `${start > 0 ? SNIPPET_ELLIPSIS : ""}${text.slice(start, at)}${SNIPPET_OPEN}${text.slice(at, at + needle.length)}${SNIPPET_CLOSE}${
    text.slice(at + needle.length, end)
  }${end < text.length ? SNIPPET_ELLIPSIS : ""}`
}

// ============================================================================ cursors

/** Where a page of results ends, in the result order of its sort (keyset paging). */
export type SearchCursor =
  | { readonly sort: "relevance"; readonly rank: number; readonly createdAt: number; readonly refId: string }
  | { readonly sort: "newest" | "oldest"; readonly createdAt: number; readonly refId: string }

export const encodeSearchCursor = (cursor: SearchCursor): string =>
  cursor.sort === "relevance"
    ? `r:${cursor.rank}:${cursor.createdAt}:${cursor.refId}`
    : `${cursor.sort === "newest" ? "n" : "o"}:${cursor.createdAt}:${cursor.refId}`

/** Undefined when `text` is not a cursor of `sort`. */
export const decodeSearchCursor = (text: string, sort: SearchSort): SearchCursor | undefined => {
  const parts = text.split(":")
  if (sort === "relevance") {
    if (parts.length !== 4 || parts[0] !== "r") return undefined
    const rank = Number(parts[1])
    const createdAt = Number(parts[2])
    const refId = parts[3]!
    return Number.isFinite(rank) && Number.isInteger(createdAt) && refId !== "" ? { sort, rank, createdAt, refId } : undefined
  }
  if (parts.length !== 3 || parts[0] !== (sort === "newest" ? "n" : "o")) return undefined
  const createdAt = Number(parts[1])
  const refId = parts[2]!
  return Number.isInteger(createdAt) && refId !== "" ? { sort, createdAt, refId } : undefined
}

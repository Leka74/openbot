// Message search: what the owner's search returns (`search.query`, `search.inConversation`). The
// brain keeps a full-text index of what was said in every chat (message text and attachment names,
// cards, event lines, notices, tool steps, and background work's brief and result); bots search
// the part of it they may read with their own tools. Background work started in a chat that was
// deleted is never found.
import { Schema } from "effect"
import { BotId, ConversationId, EntryId, Millis, NonNegativeInt, TaskId, TurnId } from "./base.ts"

/** What a hit is: transcript items by kind, plus the brief and result of background work. */
export const SearchKind = Schema.Literals(["message", "card", "event", "notice", "tool-call", "task"])
export type SearchKind = typeof SearchKind.Type

/** The default kinds of the owner's search: everything but tool steps (the "Steps" filter adds them). */
export const DEFAULT_SEARCH_KINDS: ReadonlyArray<SearchKind> = ["message", "card", "event", "notice", "task"]

/** Who wrote a hit. */
export const SearchAuthor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("owner") }),
  Schema.Struct({ kind: Schema.Literal("bot"), botId: BotId }),
  Schema.Struct({ kind: Schema.Literal("system") }),
])
export type SearchAuthor = typeof SearchAuthor.Type

/** The author filter: the owner, system lines, or a Bot (by id). */
export const SearchSender = Schema.Union([Schema.Literals(["owner", "system"]), BotId])
export type SearchSender = typeof SearchSender.Type

export const SearchSort = Schema.Literals(["relevance", "newest", "oldest"])
export type SearchSort = typeof SearchSort.Type

export const SearchHitRef = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("entry"), entryId: EntryId }),
  /** Background work's brief and result; it was started from `conversationId`. */
  Schema.Struct({ kind: Schema.Literal("task"), taskId: TaskId }),
])
export type SearchHitRef = typeof SearchHitRef.Type

/** A highlighted range of a snippet, in UTF-16 code units: `[start, end)`. */
export const SearchHighlight = Schema.Struct({ start: NonNegativeInt, end: NonNegativeInt })
export type SearchHighlight = typeof SearchHighlight.Type

export const SearchHit = Schema.Struct({
  ref: SearchHitRef,
  conversationId: ConversationId,
  kind: SearchKind,
  author: SearchAuthor,
  /** Bot-to-bot messages: the Bot it was sent to. */
  toBotId: Schema.optionalKey(BotId),
  /** The turn a bot's item belongs to (a tool step opens its turn's steps). */
  turnId: Schema.optionalKey(TurnId),
  createdAt: Millis,
  /**
   * Task hits: where to open the chat — the Bot's first message after the work ended (its report),
   * resolved by the brain. Absent when there is none (yet).
   */
  jumpEntryId: Schema.optionalKey(EntryId),
  /** Plain text around the match (`…` where it was cut). */
  snippet: Schema.String,
  highlights: Schema.Array(SearchHighlight),
})
export type SearchHit = typeof SearchHit.Type

export const SearchPage = Schema.Struct({
  hits: Schema.Array(SearchHit),
  /** Opaque; pass as `cursor` for the next page. Null on the last page. */
  nextCursor: Schema.NullOr(Schema.String),
  /** Matches in total, counted up to `SEARCH_TOTAL_CAP` ("1,000+"). */
  totalCapped: NonNegativeInt,
  /** The words the query looked for, for highlighting in the chat (folded: lower case, no diacritics). */
  terms: Schema.Array(Schema.String),
  /** The index is still being built (after an upgrade): results may be incomplete. */
  indexing: Schema.optionalKey(Schema.Boolean),
})
export type SearchPage = typeof SearchPage.Type

/** Every hit in one chat, oldest first (the Find bar steps through them). */
export const SearchPositions = Schema.Struct({
  hits: Schema.Array(Schema.Struct({ entryId: EntryId, createdAt: Millis })),
  /** More hits than `limit`: the oldest ones were left out. */
  more: Schema.Boolean,
  terms: Schema.Array(Schema.String),
  indexing: Schema.optionalKey(Schema.Boolean),
})
export type SearchPositions = typeof SearchPositions.Type

/** Limits. */
export const SEARCH_QUERY_MAX_CHARS = 200
export const SEARCH_PAGE_MAX = 50
export const SEARCH_POSITIONS_MAX = 1_000
export const SEARCH_TOTAL_CAP = 1_000

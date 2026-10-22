/**
 * SearchService: message search over `SearchRepo` for the owner (`search.query`,
 * `search.inConversation`) and for bots (`search_messages`; the repository enforces what a bot may
 * read). Validates input, turns words into a query (`parseSearchQuery`; never raw FTS syntax), and
 * maps repository hits to the contract (`SearchHit`).
 */
import type { BotId, ConversationId, EntryId, SearchHit, SearchPage, SearchPositions, TaskId } from "@openbot/contracts"
import {
  DEFAULT_SEARCH_KINDS,
  InvalidInput,
  NotFound,
  SEARCH_PAGE_MAX,
  SEARCH_POSITIONS_MAX,
  SEARCH_QUERY_MAX_CHARS,
} from "@openbot/contracts"
import { Effect, Layer, Option } from "effect"
import { ConversationRepo, type SearchRepoHit, SearchRepo, type SearchScope } from "../../ports/repos.ts"
import { type SearchInput, SearchService } from "../../ports/services.ts"
import { compact, orDie } from "../conversation/internal/util.ts"
import { decodeSearchCursor, encodeSearchCursor, parseSearchQuery, parseSnippet } from "./text.ts"

const invalid = (message: string) => new InvalidInput({ message })

export const SearchServiceLive: Layer.Layer<SearchService, never, SearchRepo | ConversationRepo> = Layer.effect(
  SearchService,
  Effect.gen(function*() {
    const repo = yield* SearchRepo
    const conversations = yield* ConversationRepo

    const checkQuery = (query: string) =>
      query.length > SEARCH_QUERY_MAX_CHARS
        ? Effect.fail(invalid(`A search is at most ${SEARCH_QUERY_MAX_CHARS} characters.`))
        : Effect.void

    const toHit = (hit: SearchRepoHit): SearchHit => {
      const { doc } = hit
      const { snippet, highlights } = parseSnippet(hit.snippet)
      return compact<SearchHit>({
        ref: doc.source === "task" ? { kind: "task", taskId: doc.refId as TaskId } : { kind: "entry", entryId: doc.refId as EntryId },
        conversationId: doc.conversationId,
        kind: doc.kind,
        author: doc.authorKind === "user"
          ? { kind: "owner" }
          : doc.authorKind === "bot" && doc.authorBotId !== undefined
          ? { kind: "bot", botId: doc.authorBotId }
          : { kind: "system" },
        toBotId: doc.toBotId,
        turnId: doc.turnId,
        createdAt: doc.createdAt as SearchHit["createdAt"],
        jumpEntryId: hit.jumpEntryId,
        snippet,
        highlights,
        })
    }

    const search = Effect.fn("SearchService.search")(function*(scope: SearchScope, input: SearchInput) {
      yield* checkQuery(input.query)
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > SEARCH_PAGE_MAX) {
        return yield* invalid(`limit must be between 1 and ${SEARCH_PAGE_MAX}.`)
      }
      if (input.from !== undefined && input.to !== undefined && input.from > input.to) {
        return yield* invalid("from must not be after to.")
      }
      const sort = input.sort ?? "relevance"
      const after = input.cursor === undefined ? undefined : decodeSearchCursor(input.cursor, sort)
      if (input.cursor !== undefined && after === undefined) return yield* invalid(`Invalid cursor: ${input.cursor}`)
      const indexing = yield* repo.indexing
      const match = parseSearchQuery(input.query)
      if (match === undefined) {
        return compact<SearchPage>({ hits: [], nextCursor: null, totalCapped: 0, terms: [], indexing: indexing || undefined })
      }
      const page = yield* orDie(repo.query({
        scope,
        match,
        kinds: input.kinds ?? DEFAULT_SEARCH_KINDS,
        conversationIds: input.conversationIds,
        botIds: input.botIds,
        senders: input.senders,
        from: input.from,
        to: input.to,
        sort,
        after,
        limit: input.limit,
      }))
      return compact<SearchPage>({
        hits: page.hits.map(toHit),
        nextCursor: page.next === undefined ? null : encodeSearchCursor(page.next),
        totalCapped: page.total,
        terms: match.terms,
        indexing: indexing || undefined,
      })
    })

    return SearchService.of({
      query: (input) => search({ kind: "owner" }, input),
      forBot: (botId, input) => search({ kind: "bot", botId }, input),

      inConversation: Effect.fn("SearchService.inConversation")(function*(input) {
        yield* checkQuery(input.query)
        if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > SEARCH_POSITIONS_MAX) {
          return yield* invalid(`limit must be between 1 and ${SEARCH_POSITIONS_MAX}.`)
        }
        if (Option.isNone(yield* orDie(conversations.get(input.conversationId)))) {
          return yield* new NotFound({ entity: "conversation", id: input.conversationId })
        }
        const indexing = (yield* repo.indexing) || undefined
        const base = {
          scope: { kind: "owner" } as const,
          conversationId: input.conversationId,
          kinds: input.kinds ?? DEFAULT_SEARCH_KINDS,
          limit: input.limit,
        }
        const match = parseSearchQuery(input.query)
        if (match !== undefined) {
          const found = yield* orDie(repo.positions({ ...base, match }))
          if (found.hits.length > 0) return compact<SearchPositions>({ ...found, terms: match.terms, indexing })
        }
        // No words (punctuation), or words that match no whole word: a plain substring.
        const substring = input.query.trim()
        if (substring === "") return compact<SearchPositions>({ hits: [], more: false, terms: [], indexing })
        const found = yield* orDie(repo.positions({ ...base, substring }))
        return compact<SearchPositions>({ ...found, terms: [substring.toLowerCase()], indexing })
      }),

      canRead: (botId: BotId, conversationId: ConversationId) =>
        orDie(conversations.members(conversationId)).pipe(Effect.map((members) => members.includes(botId))),
    })
  }),
)

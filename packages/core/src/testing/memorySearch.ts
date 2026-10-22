/**
 * The in-memory `SearchRepo`: the search docs of the in-memory `EntryRepo` and `TaskRepo` (they
 * share one `MemorySearchIndex`, as the SQLite repositories share the database) matched word by word
 * with the same tokens as the SQLite index. Ranks are a plain match count, not bm25: callers may rely
 * on relevance putting better matches first, not on exact ranks.
 */
import type { BotId, ConversationId, EntryId, Millis, TranscriptEntry } from "@openbot/contracts"
import { SEARCH_TOTAL_CAP, type Task } from "@openbot/contracts"
import { Effect, Option } from "effect"
import { ConversationRepo, type SearchFilter, SearchRepo, type SearchRepoHit, TurnRepo } from "../ports/repos.ts"
import {
  isStreamingEntry,
  makeSnippet,
  type SearchCursor,
  type SearchDoc,
  type SearchMatch,
  searchDocOfEntry,
  searchDocOfTask,
  termPositions,
  tokenize,
} from "../services/search/text.ts"

export interface MemorySearchIndex {
  readonly docs: Map<string, SearchDoc>
}

export const makeMemorySearchIndex = (): MemorySearchIndex => ({ docs: new Map() })

/** Called by the in-memory `EntryRepo` after a write (streaming revisions leave the doc as it is). */
export const indexMemoryEntry = (index: MemorySearchIndex, entry: TranscriptEntry): void => {
  if (isStreamingEntry(entry)) return
  const doc = searchDocOfEntry(entry)
  if (doc === undefined) index.docs.delete(entry.id)
  else index.docs.set(entry.id, doc)
}

export const indexMemoryTask = (index: MemorySearchIndex, task: Task): void => {
  const doc = searchDocOfTask(task)
  if (doc === undefined) index.docs.delete(task.id)
  else index.docs.set(task.id, doc)
}

const matches = (tokens: ReadonlyArray<string>, match: SearchMatch): number => {
  let count = 0
  for (const term of match.include) {
    const hits = termPositions(tokens, term).length
    if (hits === 0) return 0
    count += hits
  }
  for (const term of match.exclude) if (termPositions(tokens, term).length > 0) return 0
  return count
}

const byRefDesc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0)

export const makeMemorySearchRepo = (index: MemorySearchIndex) =>
  Effect.gen(function*() {
    const conversations = yield* ConversationRepo
    const turns = yield* TurnRepo

    /** The docs a filter lets through (scope, chat, bot, sender, time, kind), before matching words. */
    const candidates = (filter: SearchFilter) =>
      Effect.gen(function*() {
        const all = yield* Effect.orDie(conversations.list())
        const existing = new Map(all.map((c) => [c.id as string, c]))
        const membersOf = (conversationId: ConversationId): ReadonlyArray<BotId> => {
          const c = existing.get(conversationId)
          if (c === undefined) return []
          return c.kind === "group" ? c.memberBotIds : [c.botId]
        }
        const voice = new Map<string, boolean>()
        const hidden = (doc: SearchDoc) =>
          Effect.gen(function*() {
            if (doc.turnId === undefined) return false
            if (!voice.has(doc.turnId)) {
              const turn = yield* Effect.orDie(turns.get(doc.turnId))
              voice.set(doc.turnId, Option.isSome(turn) && turn.value.voice === true)
            }
            return voice.get(doc.turnId) === true
          })
        const visible = (doc: SearchDoc): boolean => {
          if (doc.source === "task" && !existing.has(doc.conversationId)) return false
          if (filter.scope.kind === "owner") return true
          const bot = filter.scope.botId
          if (doc.source === "task") return doc.authorBotId === bot && membersOf(doc.conversationId).includes(bot)
          if (doc.kind === "tool-call" && doc.authorBotId !== bot) return false
          if (membersOf(doc.conversationId).includes(bot)) return true
          return doc.kind === "message" && (doc.authorBotId === bot || doc.toBotId === bot) &&
            existing.get(doc.conversationId)?.kind === "direct"
        }
        const kept: Array<SearchDoc> = []
        for (const doc of index.docs.values()) {
          if (!filter.kinds.includes(doc.kind)) continue
          if (!visible(doc)) continue
          if (filter.conversationIds !== undefined && !filter.conversationIds.includes(doc.conversationId)) continue
          if (
            filter.botIds !== undefined &&
            !filter.botIds.some((bot) => membersOf(doc.conversationId).includes(bot) || doc.authorBotId === bot)
          ) continue
          if (
            filter.senders !== undefined &&
            !filter.senders.some((sender) =>
              sender === "owner" ? doc.authorKind === "user" : sender === "system" ? doc.authorKind === "system" : doc.authorBotId === sender
            )
          ) continue
          if (filter.exchangeWith !== undefined) {
            const me = filter.scope.kind === "bot" ? filter.scope.botId : undefined
            const peer = filter.exchangeWith
            if (
              me === undefined || doc.kind !== "message" ||
              !((doc.authorBotId === me && doc.toBotId === peer) || (doc.authorBotId === peer && doc.toBotId === me))
            ) continue
          }
          if (filter.from !== undefined && doc.createdAt < filter.from) continue
          if (filter.to !== undefined && doc.createdAt > filter.to) continue
          if (yield* hidden(doc)) continue
          kept.push(doc)
        }
        return kept
      })

    return SearchRepo.of({
      query: (query) =>
        Effect.gen(function*() {
          const scored: Array<SearchRepoHit> = []
          for (const doc of yield* candidates(query)) {
            const count = matches(tokenize(doc.text), query.match)
            if (count > 0) scored.push({ doc, rank: query.sort === "relevance" ? -count : 0, snippet: "" })
          }
          const compare = (a: { rank: number; createdAt: number; refId: string }, b: typeof a): number =>
            query.sort === "relevance"
              ? a.rank - b.rank || b.createdAt - a.createdAt || byRefDesc(a.refId, b.refId)
              : query.sort === "newest"
              ? b.createdAt - a.createdAt || byRefDesc(a.refId, b.refId)
              : a.createdAt - b.createdAt || -byRefDesc(a.refId, b.refId)
          const key = (hit: SearchRepoHit) => ({ rank: hit.rank, createdAt: hit.doc.createdAt, refId: hit.doc.refId })
          scored.sort((a, b) => compare(key(a), key(b)))
          const after = query.after
          const rest = after === undefined
            ? scored
            : scored.filter((hit) => compare(key(hit), { rank: after.sort === "relevance" ? after.rank : 0, createdAt: after.createdAt, refId: after.refId }) > 0)
          const size = Math.max(0, Math.floor(query.limit))
          const reportOf = (task: SearchDoc): EntryId | undefined => {
            const reports = [...index.docs.values()]
              .filter((doc) =>
                doc.source === "entry" && doc.kind === "message" && doc.conversationId === task.conversationId &&
                doc.authorBotId === task.authorBotId && doc.createdAt >= task.createdAt
              )
              .sort((a, b) => a.createdAt - b.createdAt || -byRefDesc(a.refId, b.refId))
            return reports[0]?.refId as EntryId | undefined
          }
          const page = rest.slice(0, size).map((hit) => {
            const jumpEntryId = hit.doc.source === "task" ? reportOf(hit.doc) : undefined
            return { ...hit, snippet: makeSnippet(hit.doc.text, query.match), ...(jumpEntryId === undefined ? {} : { jumpEntryId }) }
          })
          const last = page[page.length - 1]
          const next: SearchCursor | undefined = rest.length > size && last !== undefined
            ? query.sort === "relevance"
              ? { sort: "relevance", rank: last.rank, createdAt: last.doc.createdAt, refId: last.doc.refId }
              : { sort: query.sort, createdAt: last.doc.createdAt, refId: last.doc.refId }
            : undefined
          return { hits: page, next, total: Math.min(scored.length, query.totalCap ?? SEARCH_TOTAL_CAP) }
        }),

      positions: (query) =>
        Effect.gen(function*() {
          const found = (yield* candidates({ ...query, conversationIds: [query.conversationId] }))
            .filter((doc) => doc.source === "entry")
            .filter((doc) =>
              query.match !== undefined
                ? matches(tokenize(doc.text), query.match) > 0
                : query.substring !== undefined && query.substring !== "" &&
                  doc.text.toLowerCase().includes(query.substring.toLowerCase())
            )
            .sort((a, b) => a.createdAt - b.createdAt || -byRefDesc(a.refId, b.refId))
          const size = Math.max(0, Math.floor(query.limit))
          const kept = found.slice(Math.max(0, found.length - size))
          return {
            hits: kept.map((doc) => ({ entryId: doc.refId as EntryId, createdAt: doc.createdAt as Millis })),
            more: found.length > kept.length,
          }
        }),

      ensure: Effect.succeed({ rebuilt: false, indexed: 0, ms: 0 }),
      indexing: Effect.succeed(false),
    })
  })

// Message search reads: the first page of a search (`search.query`) and a chat's hit positions for
// the Find bar (`search.inConversation`). Each distinct query is its own atom (keyed by its payload),
// so a slow answer to an older query never shows for a newer one, and dropping an old query's atom
// interrupts its request. Debounce typing in the UI. Later pages and chat windows around a hit
// (`conversations.around`) are paged with `commandAtom` instances by the views that hold them.
import type { ConversationId, SearchKind } from "@openbot/contracts"
import { Atom, AsyncResult } from "effect/reactivity"
import type { CommandPayload } from "./commands.ts"
import { OpenBotClient } from "./rpc.ts"

/** Hits per `search.query` page in the Search view (the palette asks for fewer). */
export const SEARCH_PAGE_SIZE = 30
/** Positions per `search.inConversation` call (the brain's maximum). */
export const FIND_LIMIT = 1_000

const searchFamily = Atom.family((key: string) => OpenBotClient.query("search.query", JSON.parse(key) as CommandPayload<"search.query">))

/** The first page of a search. Two payloads with the same fields in the same order share an atom. */
export const searchFirstPageAtom = (payload: CommandPayload<"search.query">) => searchFamily(JSON.stringify(payload))

const positionsFamily = Atom.family((key: string) => OpenBotClient.query("search.inConversation", JSON.parse(key) as CommandPayload<"search.inConversation">))

/** Every hit of `query` in one chat, oldest first (the Find bar). */
export const searchPositionsAtom = (conversationId: ConversationId, query: string, kinds?: ReadonlyArray<SearchKind>) =>
  positionsFamily(JSON.stringify({ conversationId, query, ...(kinds === undefined ? {} : { kinds }), limit: FIND_LIMIT }))

/** Stands in for a search while there is nothing to search yet (an empty query): never loads. */
export const searchIdleAtom: Atom.Atom<AsyncResult.AsyncResult<never, never>> = Atom.make(AsyncResult.initial<never, never>()).pipe(Atom.withLabel("openbot/search/idle"))

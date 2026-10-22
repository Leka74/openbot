// The app's hash routes (pure; unit-tested in test/route.test.ts):
// - `#/c/<conversationId>`: a chat; `#/c/<conversationId>/e/<entryId>`: that chat at one entry
//   (a search hit; the link stays while the chat is away from its newest messages);
// - `#/new`: the new-chat view;
// - `#/search?q=…&bot=…&chat=…&from=…&date=…&type=…&sort=…`: the Search view, its filters in the
//   URL so reload and Back restore them (defaults are left out);
// - anything else (`#/`, settings, computer and device pages read at boot) is "other".
import type { BotId, ConversationId, EntryId, SearchSender } from "@openbot/contracts"
import { DEFAULT_SEARCH_TYPES, isDefaultTypes, normalizeTypes, SEARCH_TYPES, type SearchDate, type SearchFilters, type SearchType } from "@openbot/app-model"

export type Route =
  | { readonly kind: "chat"; readonly conversationId: ConversationId; readonly entryId?: EntryId | undefined }
  | { readonly kind: "new" }
  | { readonly kind: "search"; readonly filters: SearchFilters }
  | { readonly kind: "other" }

const ID = /^[^/?#]+$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const RECENT: ReadonlyArray<SearchDate> = ["24h", "7d", "30d"]

const decode = (s: string): string | undefined => {
  try {
    return decodeURIComponent(s)
  } catch {
    return undefined
  }
}

/** Comma-separated values of every `key` (`bot=a,b` and `bot=a&bot=b` both work). */
const list = (params: URLSearchParams, key: string): ReadonlyArray<string> =>
  params
    .getAll(key)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0)

const parseDate = (value: string | null): SearchDate => {
  if (value === null || value === "" || value === "any") return "any"
  if ((RECENT as ReadonlyArray<string>).includes(value)) return value as SearchDate
  // a custom range: `2026-10-01~2026-10-15`, `2026-10-01~` or `~2026-10-15`
  const [from = "", to = ""] = value.split("~")
  const range = { ...(DAY.test(from) ? { from } : {}), ...(DAY.test(to) ? { to } : {}) }
  return range.from === undefined && range.to === undefined ? "any" : range
}

const formatDate = (date: SearchDate): string | undefined =>
  typeof date === "string" ? (date === "any" ? undefined : date) : date.from === undefined && date.to === undefined ? undefined : `${date.from ?? ""}~${date.to ?? ""}`

export const parseSearch = (query: string): SearchFilters => {
  const params = new URLSearchParams(query)
  const chat = params.get("chat")?.trim()
  const from = params.get("from")?.trim()
  const types = list(params, "type").filter((t): t is SearchType => (SEARCH_TYPES as ReadonlyArray<string>).includes(t))
  return {
    q: params.get("q") ?? "",
    botIds: [...new Set(list(params, "bot"))].map((id) => id as BotId),
    ...(chat ? { chat: chat as ConversationId | "groups" } : {}),
    ...(from ? { sender: (from === "me" ? "owner" : from) as SearchSender } : {}),
    date: parseDate(params.get("date")),
    types: types.length > 0 ? normalizeTypes(types) : DEFAULT_SEARCH_TYPES,
    sort: params.get("sort") === "newest" ? "newest" : "relevance",
  }
}

export const searchHash = (filters: SearchFilters): string => {
  const params = new URLSearchParams()
  if (filters.q !== "") params.set("q", filters.q)
  if (filters.botIds.length > 0) params.set("bot", filters.botIds.join(","))
  if (filters.chat !== undefined) params.set("chat", filters.chat)
  if (filters.sender !== undefined) params.set("from", filters.sender === "owner" ? "me" : filters.sender)
  const date = formatDate(filters.date)
  if (date !== undefined) params.set("date", date)
  if (!isDefaultTypes(filters.types)) params.set("type", normalizeTypes(filters.types).join(","))
  if (filters.sort !== "relevance") params.set("sort", filters.sort)
  const query = params.toString().replace(/%2C/g, ",").replace(/%7E/gi, "~")
  return query === "" ? "#/search" : `#/search?${query}`
}

export const parseRoute = (hash: string): Route => {
  const chat = /^#\/c\/([^/?#]+)(?:\/e\/([^/?#]+))?/.exec(hash)
  if (chat) {
    const conversationId = decode(chat[1]!)
    const entryId = chat[2] === undefined ? undefined : decode(chat[2])
    if (conversationId === undefined || !ID.test(conversationId)) return { kind: "other" }
    return { kind: "chat", conversationId: conversationId as ConversationId, ...(entryId !== undefined && ID.test(entryId) ? { entryId: entryId as EntryId } : {}) }
  }
  if (/^#\/new\b/.test(hash)) return { kind: "new" }
  const search = /^#\/search\/?(?:\?(.*))?$/.exec(hash)
  if (search) return { kind: "search", filters: parseSearch(search[1] ?? "") }
  return { kind: "other" }
}

export const chatHash = (conversationId: ConversationId, entryId?: EntryId | string | undefined): string =>
  `#/c/${encodeURIComponent(conversationId)}${entryId === undefined ? "" : `/e/${encodeURIComponent(entryId)}`}`

export const routeHash = (route: Route): string => {
  switch (route.kind) {
    case "chat":
      return chatHash(route.conversationId, route.entryId)
    case "new":
      return "#/new"
    case "search":
      return searchHash(route.filters)
    case "other":
      return "#/"
  }
}

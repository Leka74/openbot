// Unit tests for the hash routes (app/route.ts): chats, a chat at one entry, the Search view with
// its filters, and the round trip back to a hash.
import { describe, expect, test } from "bun:test"
import type { BotId, ConversationId, EntryId } from "@openbot/contracts"
import { DEFAULT_SEARCH_TYPES, searchFilters, type SearchFilters } from "@openbot/app-model"
import { chatHash, parseRoute, parseSearch, routeHash, searchHash } from "../src/app/route.ts"

const cnv = "cnv_01ABC" as ConversationId
const ent = "ent_01XYZ" as EntryId

describe("chat routes", () => {
  test("a chat, and a chat at one entry", () => {
    expect(parseRoute("#/c/cnv_01ABC")).toEqual({ kind: "chat", conversationId: cnv })
    expect(parseRoute("#/c/cnv_01ABC/e/ent_01XYZ")).toEqual({ kind: "chat", conversationId: cnv, entryId: ent })
    expect(parseRoute("#/c/cnv_01ABC/e/ent_01XYZ/")).toEqual({ kind: "chat", conversationId: cnv, entryId: ent })
    expect(parseRoute("#/c/cnv_01ABC/")).toEqual({ kind: "chat", conversationId: cnv })
  })

  test("ids are percent-decoded; anything after the chat that isn't an entry is ignored", () => {
    expect(parseRoute("#/c/cnv%5Fa/e/ent%5Fb")).toEqual({ kind: "chat", conversationId: "cnv_a" as ConversationId, entryId: "ent_b" as EntryId })
    expect(parseRoute("#/c/cnv_01ABC/x/y")).toEqual({ kind: "chat", conversationId: cnv })
    expect(parseRoute("#/c/cnv_01ABC/e/")).toEqual({ kind: "chat", conversationId: cnv })
    expect(parseRoute("#/c/cnv_01ABC?x=1")).toEqual({ kind: "chat", conversationId: cnv })
  })

  test("malformed ids are not a chat (or not an entry)", () => {
    expect(parseRoute("#/c/%E0%A4%A")).toEqual({ kind: "other" })
    expect(parseRoute("#/c/a%2Fb")).toEqual({ kind: "other" })
    expect(parseRoute("#/c/cnv_01ABC/e/%E0%A4%A")).toEqual({ kind: "chat", conversationId: cnv })
    expect(parseRoute("#/c/")).toEqual({ kind: "other" })
  })

  test("hashes round-trip", () => {
    expect(chatHash(cnv)).toBe("#/c/cnv_01ABC")
    expect(chatHash(cnv, ent)).toBe("#/c/cnv_01ABC/e/ent_01XYZ")
    for (const hash of ["#/c/cnv_01ABC", "#/c/cnv_01ABC/e/ent_01XYZ", "#/new"]) expect(routeHash(parseRoute(hash))).toBe(hash)
  })
})

describe("other routes", () => {
  test("new chat, home and the boot-time pages", () => {
    expect(parseRoute("#/new")).toEqual({ kind: "new" })
    for (const hash of ["", "#", "#/", "#/settings/general", "#/computer/bot_1", "#/connect-device?code=ABCD", "#/searching", "#/quick-send"]) {
      expect(parseRoute(hash)).toEqual({ kind: "other" })
    }
  })
})

describe("search routes", () => {
  test("no query: an empty search with the default filters", () => {
    expect(parseRoute("#/search")).toEqual({ kind: "search", filters: searchFilters() })
    expect(parseRoute("#/search?")).toEqual({ kind: "search", filters: searchFilters() })
    expect(parseRoute("#/search/")).toEqual({ kind: "search", filters: searchFilters() })
    expect(searchHash(searchFilters())).toBe("#/search")
  })

  test("every filter", () => {
    const filters = parseSearch("q=deploy+%22the+migration%22&bot=bot_a,bot_b&bot=bot_c&chat=cnv_1&from=me&date=7d&type=steps,messages&sort=newest")
    expect(filters).toEqual({
      q: 'deploy "the migration"',
      botIds: ["bot_a" as BotId, "bot_b" as BotId, "bot_c" as BotId],
      chat: "cnv_1" as ConversationId,
      sender: "owner",
      date: "7d",
      types: ["messages", "steps"],
      sort: "newest",
    })
    expect(parseSearch("chat=groups&from=system").chat).toBe("groups")
    expect(parseSearch("from=bot_a").sender).toBe("bot_a" as BotId)
  })

  test("custom date ranges", () => {
    expect(parseSearch("date=2026-10-01~2026-10-15").date).toEqual({ from: "2026-10-01", to: "2026-10-15" })
    expect(parseSearch("date=2026-10-01~").date).toEqual({ from: "2026-10-01" })
    expect(parseSearch("date=~2026-10-15").date).toEqual({ to: "2026-10-15" })
    expect(parseSearch("date=yesterday").date).toBe("any")
    expect(parseSearch("date=~").date).toBe("any")
  })

  test("unknown or empty values fall back to the defaults", () => {
    const filters = parseSearch("q=&bot=&bot=bot_a,,bot_a&type=nope&sort=oldest&chat=&from=")
    expect(filters).toEqual({ ...searchFilters(), botIds: ["bot_a" as BotId] })
    expect(parseSearch("type=nope,cards").types).toEqual(["cards"])
    expect(DEFAULT_SEARCH_TYPES).not.toContain("steps")
  })

  test("hashes leave defaults out and round-trip", () => {
    const filters: SearchFilters = {
      q: "deploy & ship #1",
      botIds: ["bot_a" as BotId, "bot_b" as BotId],
      chat: "groups",
      sender: "owner",
      date: { from: "2026-10-01", to: "2026-10-15" },
      types: ["steps", "messages"],
      sort: "newest",
    }
    const hash = searchHash(filters)
    expect(hash).toBe("#/search?q=deploy+%26+ship+%231&bot=bot_a,bot_b&chat=groups&from=me&date=2026-10-01~2026-10-15&type=messages,steps&sort=newest")
    expect(parseRoute(hash)).toEqual({ kind: "search", filters: { ...filters, types: ["messages", "steps"] } })
    expect(searchHash({ ...searchFilters("hi"), types: [...DEFAULT_SEARCH_TYPES].reverse() })).toBe("#/search?q=hi")
    expect(routeHash({ kind: "search", filters: searchFilters("a b") })).toBe("#/search?q=a+b")
  })
})

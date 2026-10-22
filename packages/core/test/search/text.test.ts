import type { KnownTranscriptEntry } from "@openbot/contracts"
import { describe, expect, test } from "bun:test"
import {
  decodeSearchCursor,
  encodeSearchCursor,
  foldText,
  makeSnippet,
  parseSearchQuery,
  parseSnippet,
  SEARCH_TOOL_OUTPUT_MAX_CHARS,
  searchDocOfEntry,
  searchDocOfTask,
  toFtsQuery,
} from "../../src/services/search/text.ts"
import {
  botId,
  makeCardEntry,
  makeEventEntry,
  makeMessageEntry,
  makeTask,
  makeToolCallEntry,
  requestId,
  routineId,
  routineRunId,
  turnId,
} from "../../src/testing/index.ts"

const textOf = (entry: KnownTranscriptEntry) => searchDocOfEntry(entry)?.text

describe("searchable text", () => {
  test("messages: text and attachment names; nothing while streaming", () => {
    const message = makeMessageEntry({
      text: "Here is   the\nreport",
      attachments: [{ id: "att_1" as never, name: "report.pdf", mime: "application/pdf", byteSize: 3, url: "/a" }],
    })
    expect(textOf(message)).toBe("Here is the report report.pdf")
    expect(searchDocOfEntry({ ...message, streaming: true })).toBeUndefined()
    expect(searchDocOfEntry({ ...message, text: "", attachments: [] })).toBeUndefined()
  })

  test("a bot-to-bot message keeps its author and recipient", () => {
    const doc = searchDocOfEntry(makeMessageEntry({
      role: "bot",
      author: { kind: "bot", botId: botId("bot_a") },
      toBotId: botId("bot_b"),
      turnId: turnId("trn_1"),
      text: "hi",
    }))
    expect(doc).toMatchObject({ source: "entry", kind: "message", authorKind: "bot", authorBotId: "bot_a", toBotId: "bot_b", turnId: "trn_1" })
  })

  test("cards: what the owner reads on them", () => {
    expect(textOf(makeCardEntry({
      card: { type: "approval", requestId: requestId("req_1"), title: "Run a command", command: "rm -rf build", paths: ["/srv/app"], taskTitle: "Cleanup" },
    }))).toBe("Cleanup Run a command rm -rf build /srv/app")
    expect(textOf(makeCardEntry({
      card: {
        type: "question",
        requestId: requestId("req_2"),
        title: "Pick one",
        questions: [{ id: "q1", header: "Size", prompt: "Which size?", options: [{ label: "Small" }, { label: "Large" }], multiSelect: false, allowFreeText: false }],
      },
    }))).toBe("Pick one Size Which size? Small Large")
    expect(textOf(makeCardEntry({
      card: { type: "slack-draft", team: "SEEN", channelId: "C1", to: "#eng", text: "Deploy is out", files: [{ id: "att_2" as never, name: "demo.mp4", mime: "video/mp4", url: "/b" }] },
    }))).toBe("#eng Deploy is out demo.mp4")
    expect(textOf(makeCardEntry({
      card: { type: "routine", action: "created", routineId: routineId("rtn_1"), name: "Daily brief", triggerSummary: "Every day at 9", prompt: "Summarize the news" },
      state: { status: "info" },
    }))).toBe("Daily brief Every day at 9 Summarize the news")
  })

  test("events: the lines worth finding; audit and housekeeping lines have none", () => {
    expect(textOf(makeEventEntry({ event: { type: "handoff", fromBotId: botId("bot_a"), toBotId: botId("bot_b"), toName: "Beta", task: "Write the release notes" } })))
      .toBe("Beta Write the release notes")
    expect(textOf(makeEventEntry({ event: { type: "routine-run", routineId: routineId("rtn_1"), routineName: "Daily brief", runId: routineRunId("run_1"), status: "succeeded" } })))
      .toBe("Daily brief")
    expect(textOf(makeEventEntry({ event: { type: "voice-call", botId: botId("bot_a"), durationMs: 1, lines: [{ who: "you", text: "call me back" }, { who: "bot", text: "will do" }] } })))
      .toBe("call me back will do")
    expect(searchDocOfEntry(makeEventEntry({ event: { type: "auto-decided", decision: "allowed", summary: "ls" } }))).toBeUndefined()
    expect(searchDocOfEntry(makeEventEntry({
      event: { type: "messaged-bot", toBotId: botId("bot_b"), toName: "Beta", conversationId: "cnv_b" as never },
    }))).toBeUndefined()
  })

  test("tool steps: name, summary, command, paths and the start of the output", () => {
    const output = "x".repeat(SEARCH_TOOL_OUTPUT_MAX_CHARS + 500)
    const doc = searchDocOfEntry(makeToolCallEntry({
      name: "Bash",
      title: "Run tests",
      inputSummary: "bun test",
      command: { command: "bun test packages/core" },
      fileChanges: [{ path: "src/a.ts", kind: "update" }],
      output: { text: output, images: [{ mime: "image/png", url: "data:..." }] },
      status: "completed",
    }))
    expect(doc?.kind).toBe("tool-call")
    expect(doc?.text.startsWith("Run tests Bash bun test bun test packages/core src/a.ts ")).toBe(true)
    expect(doc?.text.length).toBe("Run tests Bash bun test bun test packages/core src/a.ts ".length + SEARCH_TOOL_OUTPUT_MAX_CHARS)
  })

  test("reasoning is never indexed", () => {
    expect(searchDocOfEntry({
      id: "ent_r" as never,
      conversationId: "cnv_1" as never,
      revision: 0,
      createdAt: 0,
      updatedAt: 0,
      author: { kind: "bot", botId: botId("bot_a") },
      kind: "reasoning",
      text: "thinking hard",
      streaming: false,
      source: "thinking",
    })).toBeUndefined()
  })

  test("tasks: title, brief and result (or why it failed), dated when they ended", () => {
    expect(searchDocOfTask(makeTask({ title: "Digest", brief: "Read HN", result: "Three stories", createdAt: 5, endedAt: 9 })))
      .toMatchObject({ source: "task", kind: "task", authorBotId: "bot_test", createdAt: 9, text: "Digest Read HN Three stories" })
    expect(searchDocOfTask(makeTask({ title: "Digest", brief: "Read HN", error: "offline" }))?.text).toBe("Digest Read HN offline")
  })
})

describe("queries", () => {
  test("words, phrases, exclusions and the typed prefix", () => {
    expect(parseSearchQuery("deploy plan")).toEqual({
      include: [{ tokens: ["deploy"], prefix: false }, { tokens: ["plan"], prefix: true }],
      exclude: [],
      terms: ["deploy", "plan"],
    })
    expect(toFtsQuery(parseSearchQuery("\"Pull Request\" -draft Lekë")!)).toBe("(\"pull request\" AND \"leke\"*) NOT \"draft\"")
    expect(toFtsQuery(parseSearchQuery("deploy ")!)).toBe("(\"deploy\")")
    expect(toFtsQuery(parseSearchQuery("foo-bar")!)).toBe("(\"foo bar\"*)")
    expect(parseSearchQuery("\"unfinished phrase")?.include).toEqual([{ tokens: ["unfinished", "phrase"], prefix: false }])
  })

  test("nothing to look for", () => {
    for (const input of ["", "   ", "-only", "!!! ??", "\"\"", "-\"x y\"", "🙂", "*", ":"]) expect(parseSearchQuery(input)).toBeUndefined()
  })

  test("any input becomes a query of quoted letters and digits only", () => {
    const nasty = ["a\"b", "NEAR(a b, 2)", "col:val", "a AND (b OR c)", "x*y^z", "'; DROP TABLE entries; --", "ü\u0000ÿ", "\u{1F600}abc", "a".repeat(10_000)]
    for (const input of nasty) {
      const match = parseSearchQuery(input)
      if (match === undefined) continue
      const fts = toFtsQuery(match)
      // between the quotes only letters, digits and spaces
      for (const quoted of fts.matchAll(/"([^"]*)"/g)) expect(quoted[1]).toMatch(/^[\p{L}\p{N} ]+$/u)
      expect(fts.replace(/"[^"]*"\*?/g, "")).toMatch(/^[() ANDOT]*$/)
    }
  })

  test("folding", () => {
    expect(foldText("Lekë ÇAJ Straße")).toBe("leke caj straße")
  })
})

describe("snippets and cursors", () => {
  test("sentinels become highlight ranges", () => {
    expect(parseSnippet("…we \u0002deploy\u0003 after the \u0002migration\u0003…")).toEqual({
      snippet: "…we deploy after the migration…",
      highlights: [{ start: 4, end: 10 }, { start: 21, end: 30 }],
    })
  })

  test("in-memory snippets mark the matched words in the original text", () => {
    const raw = makeSnippet("Lekë said: the deploy waits.", parseSearchQuery("leke deploy")!)
    expect(parseSnippet(raw)).toEqual({ snippet: "Lekë said: the deploy waits.", highlights: [{ start: 0, end: 4 }, { start: 15, end: 21 }] })
  })

  test("cursors round-trip and are checked against the sort", () => {
    const cursor = { sort: "relevance", rank: -1.234567890123, createdAt: 5, refId: "ent_1" } as const
    expect(decodeSearchCursor(encodeSearchCursor(cursor), "relevance")).toEqual(cursor)
    expect(decodeSearchCursor(encodeSearchCursor({ sort: "newest", createdAt: 5, refId: "tsk_1" }), "newest")).toEqual({ sort: "newest", createdAt: 5, refId: "tsk_1" })
    expect(decodeSearchCursor(encodeSearchCursor(cursor), "newest")).toBeUndefined()
    expect(decodeSearchCursor("garbage", "oldest")).toBeUndefined()
  })
})

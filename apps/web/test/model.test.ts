// Unit tests for the pure view models: transcript layout, markdown parsing, sidebar model.
import { describe, expect, test } from "bun:test"
import {
  type BotId,
  type ConversationId,
  type ConversationSummary,
  emptyRosterState,
  type EntryId,
  type KnownTranscriptEntry,
  type RosterState,
  type SectionId,
  type Task,
  type TaskId,
  type Turn,
  type TurnId,
  type UserId,
} from "@openbot/contracts"
import { type EventEntry, exchangeBetween, failedTurnOf, layoutTranscript, positionIn, unreadBoundaryOf } from "../src/chat/grouping.ts"
import { stepItems } from "../src/chat/Steps.tsx"
import { parseBlocks, safeHref } from "../src/chat/Markdown.tsx"
import { buildSidebar, HANDLING } from "../src/sidebar/model.ts"
import { busyElsewhere, chatStatuses, handlingHere } from "../src/chat/busy.ts"
import { activityPhrase } from "../src/chat/activity.ts"
import { formatElapsed, mergeTasks, taskTiming } from "../src/details/TasksTab.tsx"

const conv = "cnv_1" as ConversationId
const MIN = 60_000
let n = 0
const base = (at: number, author: KnownTranscriptEntry["author"], turnId?: string) => ({
  id: `ent_${String(++n).padStart(4, "0")}` as EntryId,
  conversationId: conv,
  revision: 0,
  createdAt: at,
  updatedAt: at,
  author,
  ...(turnId ? { turnId: turnId as TurnId } : {}),
})
const user = { kind: "user", userId: "user_owner" as UserId } as const
const bot = (id = "bot_a") => ({ kind: "bot", botId: id as BotId }) as const
const msg = (at: number, author: KnownTranscriptEntry["author"], text: string, turnId?: string): KnownTranscriptEntry => ({
  ...base(at, author, turnId),
  kind: "message",
  role: author.kind === "user" ? "user" : "bot",
  text,
  attachments: [],
  streaming: false,
})
const tool = (at: number, turnId: string, status: "completed" | "failed" = "completed"): KnownTranscriptEntry => ({
  ...base(at, bot(), turnId),
  kind: "tool-call",
  toolCallId: `call_${n}`,
  name: "Bash",
  toolKind: "shell",
  status,
  input: {},
  startedAt: at,
})
const turn = (id: string, status: Turn["status"], startedAt = 0): Turn => ({ id: id as TurnId, conversationId: conv, botId: "bot_a" as BotId, status, trigger: "user", startedAt })

describe("layoutTranscript", () => {
  test("groups consecutive messages by author and inserts timestamps on 15 minute gaps", () => {
    const t0 = 1_000_000_000
    const entries = [msg(t0, user, "a"), msg(t0 + 1000, user, "b"), msg(t0 + 2000, bot(), "c"), msg(t0 + 3000, bot("bot_b"), "d"), msg(t0 + 20 * MIN, user, "e")]
    const rows = layoutTranscript({ entries, turns: [], showSteps: false })
    expect(rows.map((r) => r.type)).toEqual(["timestamp", "group", "group", "group", "timestamp", "group"])
    const first = rows[1]
    expect(first?.type === "group" && first.items.length).toBe(2)
  })

  test("places the NEW divider before the first bot entry after the boundary", () => {
    const t0 = 2_000_000_000
    const entries = [msg(t0, user, "hi"), msg(t0 + 1000, bot(), "new one")]
    const rows = layoutTranscript({ entries, turns: [], showSteps: false, unreadBoundaryAt: t0 + 500 })
    expect(rows.map((r) => r.type)).toEqual(["timestamp", "group", "new-divider", "group"])
  })

  test("the boundary is inclusive: it is the first unread entry's createdAt (as the brain sets it)", () => {
    const t0 = 2_100_000_000
    const entries = [msg(t0, user, "hi"), msg(t0 + 1000, bot(), "unread reply")]
    const rows = layoutTranscript({ entries, turns: [], showSteps: false, unreadBoundaryAt: t0 + 1000 })
    expect(rows.map((r) => r.type)).toEqual(["timestamp", "group", "new-divider", "group"])
  })

  test("unreadBoundaryOf waits for a synchronized replica (a cached one is stale)", () => {
    const conversation = { unreadCount: 2, unreadBoundaryAt: 42 } as never
    expect(unreadBoundaryOf({ conversation: undefined, synchronized: true } as never)).toBeNull()
    expect(unreadBoundaryOf({ conversation, synchronized: false })).toBeNull()
    expect(unreadBoundaryOf({ conversation, synchronized: true })).toBe(42)
    expect(unreadBoundaryOf({ conversation: { unreadCount: 0, unreadBoundaryAt: 42 } as never, synchronized: true })).toBeUndefined()
  })

  test("bot-to-bot messages collapse into one exchange row per run and counterpart, never bubbles", () => {
    const t0 = 2_200_000_000
    const to = (e: KnownTranscriptEntry, toBotId: string) => ({ ...e, toBotId: toBotId as BotId }) as KnownTranscriptEntry
    const entries = [
      msg(t0, user, "hi"),
      to(msg(t0 + 1, bot("bot_b"), "note 1"), "bot_a"),
      to(msg(t0 + 2, bot("bot_b"), "note 2"), "bot_a"),
      msg(t0 + 3, bot("bot_a"), "my reply to you"),
      to(msg(t0 + 4, bot("bot_c"), "from c"), "bot_a"),
    ]
    const rows = layoutTranscript({ entries, turns: [], showSteps: false })
    expect(rows.map((r) => r.type)).toEqual(["timestamp", "group", "exchange", "group", "exchange"])
    const first = rows[2]
    expect(first?.type === "exchange" && [first.peerBotId, first.ownerBotId, first.entries.length]).toEqual(["bot_b", "bot_a", 2])
    const groups = rows.filter((r) => r.type === "group")
    expect(groups.flatMap((g) => (g.type === "group" ? g.items.map((i) => (i.kind === "entry" ? i.entry.text : "")) : []))).toEqual(["hi", "my reply to you"])
  })

  test("exchangeBetween merges both directions from both direct conversations, in order", () => {
    const t0 = 2_300_000_000
    const to = (e: KnownTranscriptEntry, toBotId: string) => ({ ...e, toBotId: toBotId as BotId }) as KnownTranscriptEntry
    const inA = [to(msg(t0 + 2, bot("bot_b"), "b→a"), "bot_a"), msg(t0 + 3, bot("bot_a"), "a to user"), to(msg(t0 + 4, bot("bot_c"), "c→a"), "bot_a")]
    const inB = [to(msg(t0 + 1, bot("bot_a"), "a→b"), "bot_b"), to(msg(t0 + 5, bot("bot_a"), "a→b again"), "bot_b")]
    expect(exchangeBetween("bot_a", "bot_b", [inA, inB, inA]).map((e) => e.text)).toEqual(["a→b", "b→a", "a→b again"])
  })

  test("hides tool calls and adds a steps disclosure under finished turns only", () => {
    const t0 = 3_000_000_000
    const entries = [msg(t0, user, "go"), tool(t0 + 100, "trn_1"), tool(t0 + 200, "trn_1", "failed"), msg(t0 + 300, bot(), "done", "trn_1"), tool(t0 + 400, "trn_2"), msg(t0 + 500, bot(), "working", "trn_2")]
    const rows = layoutTranscript({ entries, turns: [turn("trn_1", "completed"), turn("trn_2", "running")], showSteps: true })
    const steps = rows.filter((r) => r.type === "steps")
    expect(steps.length).toBe(1)
    expect(steps[0]?.type === "steps" && steps[0].steps.length).toBe(2)
    expect(steps[0]?.type === "steps" && steps[0].failed).toBe(true)
    expect(rows.some((r) => r.type === "group" && r.items.some((i) => i.kind === "entry" && i.entry.kind !== "message"))).toBe(false)
    expect(layoutTranscript({ entries, turns: [turn("trn_1", "completed")], showSteps: false }).some((r) => r.type === "steps")).toBe(false)
  })

  test("an ask_user / request_approval call is not a step: its card shows it (a failed one still is)", () => {
    const t0 = 1_000_000
    const ask = (at: number, status: "completed" | "failed"): KnownTranscriptEntry => ({
      ...tool(at, "trn_1", status),
      name: "mcp__openbot__ask_user",
      toolKind: "mcp",
      mcp: { server: "openbot", tool: "ask_user" },
    } as KnownTranscriptEntry)
    const greeting = msg(t0, bot(), "Hi! Glad to be on board.", "trn_1")
    const only = layoutTranscript({ entries: [greeting, ask(t0 + 1, "completed")], turns: [turn("trn_1", "completed")], showSteps: true })
    expect(only.some((r) => r.type === "steps")).toBe(false)
    const failed = layoutTranscript({ entries: [greeting, ask(t0 + 1, "failed")], turns: [turn("trn_1", "completed")], showSteps: true })
    expect(failed.filter((r) => r.type === "steps")).toHaveLength(1)
  })

  test("auto-decided (allowed) events fold into their turn's steps: no line, no timestamp, groups stay whole", () => {
    const t0 = 3_500_000_000
    const decided = (at: number, turnId: string | undefined, decision: "allowed" | "denied", toolKey?: string): KnownTranscriptEntry => ({
      ...base(at, { kind: "system" }, turnId),
      kind: "event",
      event: { type: "auto-decided", decision, summary: `Run thing ${at}`, toolName: "Bash", autonomy: "workspace", ...(toolKey ? { toolKey } : {}) },
    })
    const t1 = tool(t0 + 100, "trn_1")
    const callId = t1.kind === "tool-call" ? t1.toolCallId : ""
    const entries = [
      msg(t0, user, "go"),
      msg(t0 + 50, bot(), "on it", "trn_1"),
      decided(t0 + 90, "trn_1", "allowed", callId),
      t1,
      // 20 minutes later: still no timestamp from the hidden event, the bubble group continues
      decided(t0 + 20 * MIN, "trn_1", "allowed"),
      msg(t0 + 20 * MIN + 10, bot(), "done", "trn_1"),
      decided(t0 + 20 * MIN + 20, "trn_1", "denied"),
      decided(t0 + 20 * MIN + 30, undefined, "allowed"),
    ]
    const rows = layoutTranscript({ entries, turns: [turn("trn_1", "completed")], showSteps: true })
    expect(rows.map((r) => r.type)).toEqual(["timestamp", "group", "group", "timestamp", "group", "event", "steps"])
    const events = rows.filter((r) => r.type === "event")
    expect(events.map((r) => r.type === "event" && r.entry.event.type === "auto-decided" && r.entry.event.decision)).toEqual(["denied"])
    const steps = rows.find((r) => r.type === "steps")!
    expect(steps.type === "steps" && steps.decisions.length).toBe(2)
    // the badge goes on the gated tool call; the other decision is a row of its own, in time order
    const items = steps.type === "steps" ? stepItems(steps.steps, steps.decisions as ReadonlyArray<EventEntry>) : []
    expect(items.map((i) => i.kind)).toEqual(["step", "decision"])
    expect(items[0]?.kind === "step" && items[0].decision?.autonomy).toBe("workspace")
    // steps hidden in Settings: nothing at all
    expect(layoutTranscript({ entries, turns: [turn("trn_1", "completed")], showSteps: false }).map((r) => r.type)).toEqual(["timestamp", "group", "group", "timestamp", "group", "event"])
  })

  test("compaction lines show only when the owner asks for them (Settings › Show compactions)", () => {
    const t0 = 3_600_000_000
    const entries: Array<KnownTranscriptEntry> = [
      msg(t0, user, "hi"),
      { ...base(t0 + 1, { kind: "system" }), kind: "event", event: { type: "session-changed", action: "compacted", botId: "bot_a" as BotId } },
      msg(t0 + 2, bot(), "hello"),
    ]
    expect(layoutTranscript({ entries, turns: [], showSteps: true }).map((r) => r.type)).toEqual(["timestamp", "group", "group"])
    expect(layoutTranscript({ entries, turns: [], showSteps: true, showCompactions: true }).map((r) => r.type)).toEqual(["timestamp", "group", "event", "group"])
  })

  test("a turn with only auto-decisions still gets a steps disclosure", () => {
    const t0 = 3_600_000_000
    const entries: Array<KnownTranscriptEntry> = [
      msg(t0, user, "go"),
      { ...base(t0 + 1, { kind: "system" }, "trn_9"), kind: "event", event: { type: "auto-decided", decision: "allowed", summary: "Write a.ts", ruleId: "rul_1" as never } },
      msg(t0 + 2, bot(), "done", "trn_9"),
    ]
    const rows = layoutTranscript({ entries, turns: [{ ...turn("trn_9", "completed") }], showSteps: true })
    expect(rows.map((r) => r.type)).toEqual(["timestamp", "group", "group", "steps"])
  })

  test("direct chats label replies to another Bot's message \"to @Sender\" (and split them from replies to the owner)", () => {
    const t0 = 3_700_000_000
    const fromB: KnownTranscriptEntry = { ...msg(t0 + 100, bot("bot_b"), "please review"), toBotId: "bot_a" as BotId } as KnownTranscriptEntry
    const entries = [
      msg(t0, user, "hi"),
      msg(t0 + 10, bot(), "hello owner", "trn_u"),
      fromB,
      msg(t0 + 200, bot(), "reviewed!", "trn_b"),
      msg(t0 + 210, bot(), "all good", "trn_b"),
      msg(t0 + 300, bot(), "late reply", "trn_c"),
    ]
    const turns: Array<Turn> = [
      turn("trn_u", "completed"),
      { ...turn("trn_b", "completed", t0 + 150), trigger: "bot", inputEntryId: fromB.id },
      // a bot-triggered turn whose input entry is not loaded: the newest bot-to-bot message before it
      { ...turn("trn_c", "completed", t0 + 250), trigger: "bot" },
    ]
    const rows = layoutTranscript({ entries, turns, showSteps: false, direct: true })
    const groups = rows.filter((r) => r.type === "group")
    expect(groups.map((g) => (g.type === "group" ? [g.side, g.addressee ?? null, g.items.length] : []))).toEqual([
      ["user", null, 1],
      ["bot", null, 1],
      ["bot", null, 3],
    ])
    expect(rows.some((r) => r.type === "exchange")).toBe(true)
    // groups never label (and owner-triggered turns stay unlabelled)
    const plain = layoutTranscript({ entries, turns, showSteps: false })
    expect(plain.filter((r) => r.type === "group").every((g) => g.type === "group" && g.addressee === undefined)).toBe(true)
  })

  test("appends optimistic sends to the user group", () => {
    const t0 = 4_000_000_000
    const rows = layoutTranscript({ entries: [msg(t0, user, "a")], turns: [], showSteps: false, pending: [{ clientNonce: "n1", text: "b", createdAt: t0 + 10, status: "sending" }] })
    const g = rows[1]
    expect(g?.type === "group" && g.items.map((i) => i.kind)).toEqual(["entry", "pending"])
  })

  test("unknown entries become placeholders", () => {
    const unknown = { ...base(5_000_000_000, bot()), kind: "unknown", originalTag: "hologram" } as never
    expect(layoutTranscript({ entries: [unknown], turns: [], showSteps: false }).map((r) => r.type)).toEqual(["timestamp", "unknown"])
  })

  test("bubble positions and the failed-turn tray", () => {
    expect([0, 1, 2].map((i) => positionIn(i, 3))).toEqual(["first", "middle", "last"])
    expect(positionIn(0, 1, true)).toBe("first")
    expect(failedTurnOf([turn("a", "completed", 1), turn("b", "failed", 2)])?.id).toBe("b" as TurnId)
    expect(failedTurnOf([turn("a", "failed", 1), turn("b", "completed", 2)])).toBeUndefined()
  })
})

describe("markdown", () => {
  test("parses paragraphs, lists, code and quotes", () => {
    const blocks = parseBlocks("Hello **there**\nsecond line\n\n- one\n- two\n\n```ts\nconst x = 1\n```\n> quoted\n\n1. a\n2. b")
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "list", "code", "quote", "list"])
    expect(blocks[0]).toEqual({ kind: "paragraph", text: "Hello **there**\nsecond line" })
    expect(blocks[2]).toEqual({ kind: "code", lang: "ts", text: "const x = 1" })
    expect(blocks[4]?.kind === "list" && blocks[4].ordered).toBe(true)
  })
  test("only allows safe link targets", () => {
    // The whitelist itself is tested in `packages/app-model/test/links.test.ts`; these six pin
    // that the web renderer still goes through it.
    expect(safeHref("https://example.com")).toBe("https://example.com")
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c")
    expect(safeHref("/api/attachments/att_1")).toBe("/api/attachments/att_1")
    expect(safeHref("javascript:alert(1)")).toBeUndefined()
    expect(safeHref("//evil.example")).toBeUndefined()
    expect(safeHref("data:text/html,x")).toBeUndefined()
  })
})

describe("sidebar model", () => {
  const mkBot = (id: string, name: string, extra: Record<string, unknown> = {}) =>
    ({ id, name, avatar: { shape: "blob", color: "blue" }, harness: { kind: "fake" }, hostNodeId: "node_local", boundNodeIds: [], instructions: "", directConversationId: `cnv_${id}`, pinned: false, hidden: false, notify: "all", createdAt: 0, updatedAt: 0, ...extra }) as never
  const summary = (id: string, extra: Partial<ConversationSummary> = {}): ConversationSummary => ({ id: id as ConversationId, kind: "direct", title: id, botIds: [], lastActivityAt: 0, unreadCount: 0, pendingRequestCount: 0, hiddenFromSidebar: false, ...extra })
  test("pins, sections, groups, unassigned and hidden", () => {
    const state: RosterState = {
      ...emptyRosterState,
      bots: new Map([
        ["a", mkBot("a", "Alpha", { pinned: true })],
        ["b", mkBot("b", "Beta", { sectionId: "sec_1" })],
        ["c", mkBot("c", "Gamma")],
        ["d", mkBot("d", "Delta", { hidden: true })],
      ]) as never,
      sections: new Map([["sec_1" as SectionId, { id: "sec_1" as SectionId, name: "Revenue", order: 1 }]]),
      conversations: new Map([
        ["cnv_b" as ConversationId, summary("cnv_b", { unreadCount: 2 })],
        ["cnv_c" as ConversationId, summary("cnv_c", { pendingRequestCount: 1 })],
        ["cnv_g" as ConversationId, summary("cnv_g", { kind: "group", title: "Crew", botIds: ["a", "b"] as never })],
      ]),
    }
    const model = buildSidebar(state)
    expect(model.pinned.map((p) => p.bot.name)).toEqual(["Alpha"])
    expect(model.sections.map((s) => s.name)).toEqual(["Revenue", "Group chats", "Unassigned"])
    const revenue = model.sections[0]!.items[0]!
    expect(revenue.kind === "bot" && revenue.unread && revenue.status).toBe("unread")
    const gamma = model.sections[2]!.items[0]!
    expect(gamma.kind === "bot" && gamma.status).toBe("attention")
    expect(gamma.preview).toBe("Waiting for you")
    expect(model.hidden.items.map((i) => (i.kind === "bot" ? i.bot.name : ""))).toEqual(["Delta"])
  })
  test("dragged chats keep their place; undragged ones come first by recent activity; groups join sections", () => {
    const state: RosterState = {
      ...emptyRosterState,
      bots: new Map([
        ["a", mkBot("a", "Alpha", { sectionId: "sec_1", sidebarOrder: 1 })],
        ["b", mkBot("b", "Beta", { sectionId: "sec_1", sidebarOrder: 0 })],
        ["c", mkBot("c", "Gamma", { sectionId: "sec_1" })],
        ["p", mkBot("p", "Pin1", { pinned: true, sidebarOrder: 1, createdAt: 1 })],
        ["q", mkBot("q", "Pin2", { pinned: true, sidebarOrder: 0, createdAt: 2 })],
      ]) as never,
      sections: new Map([["sec_1" as SectionId, { id: "sec_1" as SectionId, name: "Revenue", order: 1 }]]),
      conversations: new Map([
        ["cnv_a" as ConversationId, summary("cnv_a", { lastActivityAt: 50 })],
        ["cnv_c" as ConversationId, summary("cnv_c", { lastActivityAt: 10 })],
        ["cnv_g" as ConversationId, summary("cnv_g", { kind: "group", title: "Crew", botIds: ["a"] as never, sectionId: "sec_1" as SectionId, sidebarOrder: 2 })],
      ]),
    }
    const model = buildSidebar(state)
    expect(model.pinned.map((p) => p.bot.name)).toEqual(["Pin2", "Pin1"])
    const revenue = model.sections.find((s) => s.id === "sec_1")!
    expect(revenue.items.map((i) => (i.kind === "bot" ? i.bot.name : i.summary.title))).toEqual(["Gamma", "Beta", "Alpha", "Crew"])
    // Group chats stays (empty) while a group chat exists: somewhere to drag it back to
    expect(model.sections.find((s) => s.id === "groups")?.items).toEqual([])
  })
  test("one mind: a bot working in a group says where in its DM row", () => {
    const state: RosterState = {
      ...emptyRosterState,
      bots: new Map([["b", mkBot("b", "Beta")]]) as never,
      conversations: new Map([
        ["cnv_b" as ConversationId, summary("cnv_b", { preview: "hello" })],
        ["cnv_g" as ConversationId, summary("cnv_g", { kind: "group", title: "secret project", botIds: ["b"] as never })],
      ]),
      activities: new Map([["b" as BotId, { botId: "b" as BotId, conversationId: "cnv_g" as ConversationId, state: "working", since: 1 }]]),
    }
    const item = buildSidebar(state).sections.flatMap((s) => s.items).find((i) => i.kind === "bot")!
    expect(item.status).toBe("working")
    expect(item.preview).toBe("Busy in “secret project”") // the same words as the DM's status line
  })
  test("the open conversation never shows as unread (no dot flicker while the chat marks it read)", () => {
    const state: RosterState = {
      ...emptyRosterState,
      bots: new Map([["b", mkBot("b", "Beta")]]) as never,
      conversations: new Map([
        ["cnv_b" as ConversationId, summary("cnv_b", { unreadCount: 2 })],
        ["cnv_g" as ConversationId, summary("cnv_g", { kind: "group", title: "Crew", botIds: ["b"] as never, unreadCount: 1 })],
      ]),
    }
    const unreadOf = (open: string | null) =>
      buildSidebar(state, open).sections.flatMap((s) => s.items).map((i) => `${i.key}:${i.unread}:${i.status}`)
    expect(unreadOf(null)).toEqual(["cnv_g:true:unread", "b:true:unread"])
    expect(unreadOf("cnv_b")).toEqual(["cnv_g:true:unread", "b:false:idle"])
    expect(unreadOf("cnv_g")).toEqual(["cnv_g:false:idle", "b:true:unread"])
  })
})

describe("busy elsewhere (one mind per bot)", () => {
  const dm = "cnv_dm" as ConversationId
  const group = "cnv_group" as ConversationId
  const bot = "bot_a" as BotId
  const conversations = new Map<ConversationId, ConversationSummary>([
    [group, { id: group, kind: "group", title: "secret project", botIds: [bot], lastActivityAt: 0, unreadCount: 0, pendingRequestCount: 0, hiddenFromSidebar: false }],
  ])
  const turn = (status: Turn["status"]): Turn => ({ id: "trn_1" as TurnId, conversationId: dm, botId: bot, status, trigger: "user", startedAt: 1 })
  const busy = new Map([[bot, { botId: bot, conversationId: group, state: "working" as const, since: 1 }]])

  test("a bot working in another conversation, with the owner's message queued here", () => {
    expect(busyElsewhere({ conversationId: dm, botIds: [bot], activities: busy, turns: [turn("queued")], conversations })).toEqual([
      { botId: bot, conversationId: group, where: "“secret project”", queued: true },
    ])
    expect(busyElsewhere({ conversationId: dm, botIds: [bot], activities: busy, turns: [], conversations })[0]?.queued).toBe(false)
  })

  test("not when it works here, is idle, or runs a turn here", () => {
    expect(busyElsewhere({ conversationId: group, botIds: [bot], activities: busy, turns: [], conversations })).toEqual([])
    const idle = new Map([[bot, { botId: bot, conversationId: group, state: "idle" as const, since: 1 }]])
    expect(busyElsewhere({ conversationId: dm, botIds: [bot], activities: idle, turns: [], conversations })).toEqual([])
    expect(busyElsewhere({ conversationId: dm, botIds: [bot], activities: busy, turns: [turn("running")], conversations })).toEqual([])
  })
})

describe("background work (D5.7): Handling…", () => {
  const dm = "cnv_dm" as ConversationId
  const group = "cnv_group" as ConversationId
  const task = (id: string, botId: string, conversationId: ConversationId, status: Task["status"]): Task => ({
    id: id as TaskId,
    botId: botId as BotId,
    conversationId,
    title: `work ${id}`,
    brief: "b",
    status,
    createdAt: 1,
    updatedAt: 1,
  })
  const tasks = (...list: Array<Task>) => new Map(list.map((t) => [t.id, t] as const))

  test("the status line lists members with queued or running work started in THIS conversation", () => {
    const all = tasks(task("t1", "bot_a", dm, "running"), task("t2", "bot_b", group, "queued"), task("t3", "bot_c", group, "succeeded"))
    expect(handlingHere({ conversationId: dm, botIds: ["bot_a" as BotId], tasks: all })).toEqual(["bot_a" as BotId])
    expect(handlingHere({ conversationId: group, botIds: ["bot_a", "bot_b", "bot_c"] as Array<BotId>, tasks: all })).toEqual(["bot_b" as BotId])
    expect(handlingHere({ conversationId: dm, botIds: ["bot_a" as BotId], tasks: undefined })).toEqual([])
  })

  test("an otherwise idle bot's sidebar row says Handling… (no titles, no counts)", () => {
    const mkBot = (id: string, name: string) =>
      ({ id, name, avatar: { shape: "blob", color: "blue" }, harness: { kind: "fake" }, hostNodeId: "node_local", boundNodeIds: [], instructions: "", directConversationId: `cnv_${id}`, pinned: false, hidden: false, notify: "all", createdAt: 0, updatedAt: 0 }) as never
    const state: RosterState = {
      ...emptyRosterState,
      bots: new Map([["b", mkBot("b", "Beta")]]) as never,
      conversations: new Map([["cnv_b" as ConversationId, { id: "cnv_b" as ConversationId, kind: "direct", title: "Beta", botIds: ["b" as BotId], lastActivityAt: 0, unreadCount: 0, pendingRequestCount: 0, hiddenFromSidebar: false, preview: "Sure — I'll get back to you." }]]),
      tasks: tasks(task("t1", "b", "cnv_b" as ConversationId, "running"), task("t2", "b", "cnv_b" as ConversationId, "queued")),
    }
    const item = buildSidebar(state).sections.flatMap((s) => s.items).find((i) => i.kind === "bot")!
    expect(item.preview).toBe(HANDLING)
    expect(item.status).toBe("working")
    // busy in a conversation wins; finished work does not count
    const busy = { ...state, activities: new Map([["b" as BotId, { botId: "b" as BotId, conversationId: "cnv_b" as ConversationId, state: "working" as const, label: "Typing…", since: 1 }]]) }
    expect(buildSidebar(busy).sections.flatMap((s) => s.items).find((i) => i.kind === "bot")!.preview).toBe("Typing…")
    const done = { ...state, tasks: tasks(task("t1", "b", "cnv_b" as ConversationId, "succeeded")) }
    expect(buildSidebar(done).sections.flatMap((s) => s.items).find((i) => i.kind === "bot")!.preview).toBe("Sure — I'll get back to you.")
  })

  test("Tasks tab helpers: merge prefers the fresher copy; timing lines", () => {
    const old = { ...task("t1", "b", dm, "running"), updatedAt: 1 }
    const fresh = { ...old, progress: "Reading", updatedAt: 5 }
    expect(mergeTasks([old], [fresh])[0]).toBe(fresh)
    expect(mergeTasks([fresh], [old])[0]).toBe(fresh)
    const now = 1_000_000
    expect(taskTiming({ ...old, startedAt: now - 125_000 }, now)).toBe("Running 2 min")
    expect(taskTiming({ ...old, status: "queued" }, now)).toBe("Waiting to start")
    expect(taskTiming({ ...old, status: "succeeded", startedAt: now - 200_000, endedAt: now - 80_000 }, now)).toBe("Finished 1 min ago · took 2 min")
    expect(formatElapsed(3_700_000)).toBe("1 h 1 min")
  })
})

describe("the chat's ONE status line per bot (busy.ts chatStatuses)", () => {
  const dm = "cnv_dm" as ConversationId
  const group = "cnv_group" as ConversationId
  const bot = "bot_a" as BotId
  const conversations = new Map<ConversationId, ConversationSummary>([
    [group, { id: group, kind: "group", title: "secret project", botIds: [bot], lastActivityAt: 0, unreadCount: 0, pendingRequestCount: 0, hiddenFromSidebar: false }],
  ])
  const turn = (status: Turn["status"], conversationId = dm): Turn => ({ id: "trn_1" as TurnId, conversationId, botId: bot, status, trigger: "user", startedAt: 1 })
  const activity = (conversationId: ConversationId, state: "working" | "idle" = "working") => new Map([[bot, { botId: bot, conversationId, state, since: 1 }]])
  const work = (conversationId: ConversationId, status: Task["status"] = "running"): Map<TaskId, Task> =>
    new Map([["t1" as TaskId, { id: "t1" as TaskId, botId: bot, conversationId, title: "film", brief: "b", status, createdAt: 1, updatedAt: 1 }]])
  const statuses = (input: { activities?: ReturnType<typeof activity>; turns?: ReadonlyArray<Turn>; tasks?: Map<TaskId, Task> }) =>
    chatStatuses({ conversationId: dm, botIds: [bot], activities: input.activities ?? new Map(), turns: input.turns ?? [], conversations, tasks: input.tasks })
      .map((st) => (st.kind === "elsewhere" ? `elsewhere${st.queued ? "+queued" : ""}` : st.kind))

  test("its turn here wins over its background work: one line, never two", () => {
    expect(statuses({ activities: activity(dm), turns: [turn("running")], tasks: work(dm) })).toEqual(["turn"])
    expect(statuses({ turns: [turn("waiting")], tasks: work(dm) })).toEqual(["turn"])
  })

  test("otherwise Handling… while work started here runs; nothing once it is over", () => {
    expect(statuses({ tasks: work(dm) })).toEqual(["handling"])
    expect(statuses({ tasks: work(dm, "queued") })).toEqual(["handling"])
    expect(statuses({ tasks: work(dm, "succeeded") })).toEqual([])
    expect(statuses({ tasks: work(group) })).toEqual([]) // started elsewhere: that chat's line
    expect(statuses({})).toEqual([])
  })

  test("busy elsewhere lives in the same line: a queued message here first, then Handling…, then Busy in …", () => {
    expect(statuses({ activities: activity(group), turns: [turn("queued")], tasks: work(dm) })).toEqual(["elsewhere+queued"])
    expect(statuses({ activities: activity(group), tasks: work(dm) })).toEqual(["handling"])
    expect(statuses({ activities: activity(group) })).toEqual(["elsewhere"])
    expect(statuses({ activities: activity(group, "idle"), tasks: work(dm) })).toEqual(["handling"])
  })

  test("another bot writing into this conversation gets its own line", () => {
    const other = "bot_b" as BotId
    const out = chatStatuses({
      conversationId: dm,
      botIds: [bot],
      activities: new Map([[other, { botId: other, conversationId: dm, state: "working" as const, since: 1 }]]),
      turns: [],
      conversations,
      tasks: work(dm),
    })
    expect(out.map((st) => `${st.kind}:${st.botId}`)).toEqual([`turn:${other}`, `handling:${bot}`])
  })

  test("the sidebar row says the same as the DM's line", () => {
    const mkBot = (id: string, name: string) =>
      ({ id, name, avatar: { shape: "blob", color: "blue" }, harness: { kind: "fake" }, hostNodeId: "node_local", boundNodeIds: [], instructions: "", directConversationId: dm, pinned: false, hidden: false, notify: "all", createdAt: 0, updatedAt: 0 }) as never
    const base: RosterState = {
      ...emptyRosterState,
      bots: new Map([[bot, mkBot(bot, "Beta")]]) as never,
      conversations: new Map([...conversations, [dm, { id: dm, kind: "direct", title: "Beta", botIds: [bot], lastActivityAt: 0, unreadCount: 0, pendingRequestCount: 0, hiddenFromSidebar: false, preview: "ok" }]]),
    }
    const preview = (extra: Partial<RosterState>) => buildSidebar({ ...base, ...extra }).sections.flatMap((x) => x.items).find((i) => i.kind === "bot")!.preview
    expect(preview({ activities: activity(group), tasks: work(dm) })).toBe(HANDLING)
    expect(preview({ activities: activity(group), tasks: work(group) })).toBe("Busy in “secret project”")
    expect(preview({ activities: activity(group) })).toBe("Busy in “secret project”")
    expect(preview({ tasks: work(group) })).toBe(HANDLING) // otherwise idle: work started anywhere
    expect(preview({ activities: activity(dm), tasks: work(dm) })).toBe("ok") // its turn in the DM wins
  })
})

describe("activity phrases are human (D6.4)", () => {
  test("no 'Bot', no tool kind words, whatever the tool kind", () => {
    for (const toolKind of ["shell", "file-read", "file-write", "file-edit", "search", "web", "mcp", "subagent", "question", "browser", "computer", "other"]) {
      const phrase = activityPhrase({ activity: { botId: "b" as BotId, state: "working", toolKind, since: 1 }, turn: undefined, streaming: false })
      expect(phrase).not.toMatch(/\b(bot|subagent|agent|task|session|tool|mcp|worker)\b/i)
    }
  })
})

describe("a background task's updates among its steps", () => {
  test("slot in by time", () => {
    const at = (t: number) => ({ conversationId: conv, revision: 0, createdAt: t, updatedAt: t, author: { kind: "bot" as const, botId: "b" as BotId } })
    const tool = (id: string, t: number) => ({ ...at(t), id: id as EntryId, kind: "tool-call" as const, toolCallId: id, name: "Bash", toolKind: "shell" as const, status: "completed" as const, input: {}, startedAt: t })
    const update = (id: string, t: number) => ({ ...at(t), id: id as EntryId, kind: "message" as const, role: "user" as const, text: "center the globe", attachments: [], streaming: false })
    const items = stepItems([tool("a", 1), tool("b", 5)], [], [update("u", 3)])
    expect(items.map((i) => (i.kind === "step" ? i.step.id : i.kind === "update" ? `update:${i.entry.id}` : "decision"))).toEqual(["a", "update:u", "b"])
    expect(stepItems([tool("a", 1)], [], [update("u", 9)]).at(-1)?.kind).toBe("update")
  })
})

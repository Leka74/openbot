// Schema round-trips (encode -> JSON -> decode) and forward-compatibility rules.
import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import {
  ApprovalRule,
  ApprovalRuleInput,
  applySettingsPatch,
  Bot,
  BotCreateInput,
  BotMemory,
  BotPatch,
  Card,
  AvatarColors,
  AvatarShapes,
  Conversation,
  ConversationChange,
  ConversationStreamItem,
  DEFAULT_BOT_AUTONOMY,
  DEFAULT_SETTINGS,
  defaultBotAvatar,
  fnv1a32,
  HarnessKindName,
  isKnownHarnessKind,
  KnownConversationEvent,
  KnownRosterStreamItem,
  KnownTranscriptEntry,
  MemoryFactId,
  memoryFactIdFromTitle,
  minAutonomy,
  normalizeProjectFolder,
  NodeSummary,
  projectFolderProblem,
  Routine,
  RoutineRun,
  RoutineTriggerInput,
  RosterStreamItem,
  RuntimeRequest,
  RuntimeResponseInput,
  SearchPage,
  SearchPositions,
  Settings,
  SettingsPatch,
  SkillName,
  TranscriptEntry,
  TranscriptWindow,
  Turn,
} from "../src/index.ts"

/** encode -> JSON text -> decode must give back the same value. */
const roundTrip = <S extends Schema.Codec<any, any, never, never>>(schema: S, value: S["Type"]) => {
  const json = Schema.fromJsonString(schema as Schema.Codec<S["Type"], S["Encoded"], never, never>)
  const text = Schema.encodeSync(json)(value)
  expect(Schema.decodeUnknownSync(json)(text)).toEqual(value)
  return JSON.parse(text)
}
const decodes = (schema: Schema.Codec<any, any, never, never>, raw: unknown) => Result.isSuccess(Schema.decodeUnknownResult(schema)(raw))

const base = {
  id: "ent_1",
  conversationId: "cnv_1",
  revision: 0,
  createdAt: 1,
  updatedAt: 1,
  author: { kind: "bot", botId: "bot_1" },
}

const bot: Bot = Schema.decodeUnknownSync(Bot)({
  id: "bot_1",
  name: "Scout",
  label: "Research",
  avatar: { shape: "blob", color: "cyan" },
  harness: { kind: "claude", model: "claude-haiku", effort: "low" },
  hostNodeId: "node_local",
  boundNodeIds: ["nod_2"],
  instructions: "You research things.",
  directConversationId: "cnv_1",
  sectionId: "sec_1",
  pinned: true,
  hidden: false,
  notify: "all",
  createdAt: 1,
  updatedAt: 2,
})

describe("domain", () => {
  test("Bot round-trips; unknown harness kinds are kept", () => {
    roundTrip(Bot, bot)
    const future = Schema.decodeUnknownSync(Bot)({ ...bot, harness: { kind: "pi-agent" } })
    expect(future.harness.kind).toBe("pi-agent")
    expect(isKnownHarnessKind(future.harness.kind)).toBe(false)
    expect(isKnownHarnessKind("fake")).toBe(true)
    expect(decodes(HarnessKindName, "")).toBe(false)
    expect(decodes(Bot, { ...bot, name: "" })).toBe(false)
    expect(decodes(Bot, { ...bot, name: "x".repeat(65) })).toBe(false)
    // rows written before a field existed decode with defaults
    const { hostNodeId: _h, boundNodeIds: _b, pinned: _p, hidden: _x, notify: _n, ...minimal } = Schema.encodeSync(Bot)(bot)
    const old = Schema.decodeUnknownSync(Bot)(minimal)
    expect([old.hostNodeId, old.boundNodeIds, old.pinned, old.hidden, old.notify]).toEqual(["node_local" as any, [], false, false, "all"])
  })

  test("Bot projectFolders: stored bots without it decode as []; the patch takes a list", () => {
    const { projectFolders: _p, ...stored } = Schema.encodeSync(Bot)(bot)
    expect(Schema.decodeUnknownSync(Bot)(stored).projectFolders).toEqual([])
    expect(roundTrip(Bot, { ...bot, projectFolders: ["~/projects/snip"] }).projectFolders).toEqual(["~/projects/snip"])
    expect(decodes(BotPatch, { projectFolders: ["/srv/app"] })).toBe(true)
    expect(decodes(BotPatch, { projectFolders: "/srv/app" })).toBe(false)
  })

  test("Bot autonomy: stored bots without it decode as \"workspace\"; create/patch accept it", () => {
    const { autonomy: _a, ...stored } = Schema.encodeSync(Bot)(bot)
    expect(Schema.decodeUnknownSync(Bot)(stored).autonomy).toBe("workspace")
    expect(DEFAULT_BOT_AUTONOMY).toBe("workspace")
    for (const autonomy of ["ask", "workspace", "full"] as const) {
      expect(roundTrip(Bot, { ...bot, autonomy }).autonomy).toBe(autonomy)
      expect(decodes(BotPatch, { autonomy })).toBe(true)
      expect(decodes(BotCreateInput, { name: "A", harness: { kind: "fake" }, clientNonce: "n", autonomy })).toBe(true)
    }
    expect(decodes(Bot, { ...bot, autonomy: "yolo" })).toBe(false)
    expect(decodes(BotPatch, { autonomy: "yolo" })).toBe(false)
    expect(decodes(BotCreateInput, { name: "A", harness: { kind: "fake" }, clientNonce: "n" })).toBe(true)
  })

  test("Conversation kinds round-trip", () => {
    const common = { id: "cnv_1", title: "t", createdAt: 1, lastActivityAt: 2, unreadCount: 0, hiddenFromSidebar: false, epoch: "e1" }
    for (const raw of [
      { ...common, kind: "direct", botId: "bot_1" },
      { ...common, kind: "group", memberBotIds: ["bot_1", "bot_2"], leadBotId: "bot_2", namedBy: "user" },
      { ...common, kind: "routine-run", botId: "bot_1", routineId: "rtn_1", runId: "run_1", triggerSummary: "Every day at 9" },
    ]) {
      expect(roundTrip(Conversation, Schema.decodeUnknownSync(Conversation)(raw))).toEqual(raw)
    }
  })

  test("Conversation sessions (context ring) round-trip", () => {
    const raw = {
      id: "cnv_1", title: "t", createdAt: 1, lastActivityAt: 2, unreadCount: 0, hiddenFromSidebar: false, epoch: "e1",
      kind: "group", memberBotIds: ["bot_1", "bot_2"], namedBy: "app",
      sessions: [
        { botId: "bot_1", active: true, contextUsage: { usedTokens: 12_000, windowTokens: 200_000 }, updatedAt: 3 },
        { botId: "bot_2", active: false, updatedAt: 4 },
      ],
    }
    expect(roundTrip(Conversation, Schema.decodeUnknownSync(Conversation)(raw))).toEqual(raw)
  })

  test("defaultBotAvatar is a deterministic FNV-1a pick from the shapes and colors", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5)
    expect(fnv1a32("a")).toBe(0xe40c292c)
    const avatar = defaultBotAvatar("bot_01J0000000000000000000000")
    expect(defaultBotAvatar("bot_01J0000000000000000000000")).toEqual(avatar)
    const h = fnv1a32("bot_01J0000000000000000000000")
    expect(avatar).toEqual({ shape: AvatarShapes[h % 13]!, color: AvatarColors[Math.floor(h / 13) % 11]! })
    const seen = new Set(Array.from({ length: 200 }, (_, i) => defaultBotAvatar(`bot_${i}`).shape))
    expect(seen.size).toBe(AvatarShapes.length)
  })

  test("routine triggers: cron needs a timezone, interval >= 5 minutes, webhook is decode-only", () => {
    expect(decodes(RoutineTriggerInput, { type: "cron", schedule: "0 9 * * 1-5", timezone: "Europe/Berlin" })).toBe(true)
    expect(decodes(RoutineTriggerInput, { type: "cron", schedule: "0 9 * * 1-5" })).toBe(false)
    expect(decodes(RoutineTriggerInput, { type: "interval", everyMinutes: 5 })).toBe(true)
    expect(decodes(RoutineTriggerInput, { type: "interval", everyMinutes: 4 })).toBe(false)
    expect(decodes(RoutineTriggerInput, { type: "once", at: 1_800_000_000_000 })).toBe(true)
    expect(decodes(RoutineTriggerInput, { type: "manual" })).toBe(true)
    expect(decodes(RoutineTriggerInput, { type: "webhook" })).toBe(false)
    const routine = Schema.decodeUnknownSync(Routine)({
      id: "rtn_1",
      botId: "bot_1",
      name: "Daily brief",
      prompt: "Summarize my inbox",
      trigger: { type: "webhook" },
      enabled: false,
      output: "direct",
      createdAt: 1,
      updatedAt: 1,
    })
    roundTrip(Routine, routine)
    roundTrip(RoutineRun, Schema.decodeUnknownSync(RoutineRun)({ id: "run_1", routineId: "rtn_1", firedBy: "manual", startedAt: 1, status: "running", conversationId: "cnv_1" }))
  })

  test("NodeSummary round-trips", () => {
    roundTrip(
      NodeSummary,
      Schema.decodeUnknownSync(NodeSummary)({
        id: "node_local",
        label: "This computer",
        kind: "local",
        status: "online",
        capabilities: ["fs@1", "shell@1"],
        declaredCapabilities: ["fs@1", "shell@1", "browser@1"],
        platform: "linux",
        hostname: "brain",
        roots: ["/home/me/openbot"],
        createdAt: 1,
      }),
    )
  })
})

describe("transcript", () => {
  test("known entry round-trips", () => {
    const raw = { ...base, kind: "message", role: "bot", text: "hi", attachments: [], streaming: false }
    const decoded = Schema.decodeUnknownSync(TranscriptEntry)(raw)
    expect(decoded.kind).toBe("message")
    expect(Schema.encodeSync(KnownTranscriptEntry)(decoded as any)).toEqual(raw as any)
  })

  test("unknown entry kind decodes to the unknown member and keeps base fields", () => {
    const decoded = Schema.decodeUnknownSync(TranscriptEntry)({ ...base, kind: "voice-call", call: { callId: "c" } })
    expect(decoded).toEqual({ ...base, kind: "unknown", originalTag: "voice-call" } as any)
    // encoding an unknown member is forbidden (servers never send it)
    expect(Result.isFailure(Schema.encodeUnknownResult(TranscriptEntry)(decoded))).toBe(true)
  })

  test("a KNOWN kind with a broken payload still fails", () => {
    expect(decodes(TranscriptEntry, { ...base, kind: "message", role: "bot" })).toBe(false)
  })

  test("old clients drop unknown optional fields on known kinds", () => {
    const decoded = Schema.decodeUnknownSync(TranscriptEntry)({ ...base, kind: "notice", level: "info", code: "compacted", text: "Compacted", future: 1 })
    expect("future" in decoded).toBe(false)
  })

  test("every event type round-trips; unknown event types are tolerated", () => {
    const events = [
      { type: "name-changed", to: "Team" },
      { type: "joined", botId: "bot_1", name: "Scout" },
      { type: "member-added", botId: "bot_2", name: "Ada" },
      { type: "member-removed", botId: "bot_2", name: "Ada" },
      { type: "bot-exchange", peerBotIds: ["bot_2"], messageCount: 2 },
      { type: "messaged-bot", toBotId: "bot_2", toName: "Ada", conversationId: "cnv_2", entryId: "ent_9", urgency: "urgent" },
      { type: "posted-to-group", conversationId: "cnv_3", title: "Launch" },
      { type: "handoff", fromBotId: "bot_1", toBotId: "bot_2", toName: "Ada", task: "Ship it" },
      { type: "hop-limit", hops: 8 },
      { type: "routine-changed", action: "created", routineId: "rtn_1", routineName: "Daily" },
      { type: "routine-run", routineId: "rtn_1", routineName: "Daily", runId: "run_1", status: "succeeded" },
      { type: "memory-updated", botId: "bot_1", action: "remembered", title: "Likes tea" },
      { type: "skill-saved", name: "triage" },
      { type: "auto-decided", decision: "allowed", summary: "git status", toolName: "Bash", ruleId: "rul_1" },
      { type: "request-elsewhere", botId: "bot_1", requestId: "req_1", conversationId: "cnv_1" },
      { type: "session-changed", botId: "bot_1", action: "new-session" },
      { type: "voice-call", botId: "bot_1", durationMs: 31_000, lines: [{ who: "you", text: "Yo, what's up?" }, { who: "bot", text: "Not much." }] },
    ]
    for (const event of events) {
      const entry = Schema.decodeUnknownSync(KnownTranscriptEntry)({ ...base, kind: "event", event })
      expect(roundTrip(KnownTranscriptEntry, entry).event).toEqual(event)
    }
    expect(events.length).toBe(KnownConversationEvent.members.length)
    const byAutonomy = { type: "auto-decided", decision: "allowed", summary: "Write hello.ts", toolName: "Write", autonomy: "workspace", toolKey: "toolu_1" }
    expect(roundTrip(KnownTranscriptEntry, Schema.decodeUnknownSync(KnownTranscriptEntry)({ ...base, kind: "event", event: byAutonomy })).event).toEqual(byAutonomy)
    const future = Schema.decodeUnknownSync(TranscriptEntry)({ ...base, kind: "event", event: { type: "team-shared", x: 1 } }) as any
    expect(future.event).toEqual({ type: "unknown", originalTag: "team-shared" })
  })

  test("Turn round-trips", () => {
    roundTrip(
      Turn,
      Schema.decodeUnknownSync(Turn)({
        id: "trn_1",
        conversationId: "cnv_1",
        botId: "bot_1",
        status: "failed",
        trigger: "routine",
        startedAt: 1,
        endedAt: 2,
        usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.01 },
        failure: { code: "harness-crashed", message: "boom", retryable: true },
      }),
    )
  })

  test("unknown card type / change type / stream kind are tolerated", () => {
    expect((Schema.decodeUnknownSync(Card)({ type: "calendar-event", event: {} }) as any).originalTag).toBe("calendar-event")
    expect((Schema.decodeUnknownSync(ConversationChange)({ type: "reaction.added", x: 1 }) as any).type).toBe("unknown")
    const item = Schema.decodeUnknownSync(ConversationStreamItem)({ kind: "presence", cursor: { epoch: "e", sequence: 3 } }) as any
    expect(item).toEqual({ kind: "unknown", originalTag: "presence", cursor: { epoch: "e", sequence: 3 } })
    expect((Schema.decodeUnknownSync(RosterStreamItem)({ kind: "change", cursor: { epoch: "e", sequence: 1 }, change: { type: "plan.updated" } }) as any).change.type).toBe("unknown")
  })

  test("cards round-trip, including informational routine cards", () => {
    const cards = [
      { type: "approval", requestId: "req_1", requestKind: "command-approval", title: "Run this?", command: "rm -rf build", suggestedRule: { surface: "shell", match: { commandPrefix: "rm -rf build" } } },
      { type: "question", requestId: "req_2", questions: [{ id: "q1", prompt: "Color?", options: [{ label: "Blue" }], multiSelect: false, allowFreeText: true }] },
      { type: "form", requestId: "req_3", title: "Details", fields: [{ key: "k", label: "K", type: "string", required: true }] },
      { type: "secret-request", requestId: "req_4", label: "API key", envVar: "API_KEY" },
      { type: "handoff", requestId: "req_5", nodeId: "node_local", instruction: "Log in for me" },
      { type: "routine", action: "created", routineId: "rtn_1", name: "Daily", triggerSummary: "Every day at 9:00 AM" },
    ]
    for (const card of cards) {
      const entry = Schema.decodeUnknownSync(KnownTranscriptEntry)({ ...base, kind: "card", card, state: { status: card.type === "routine" ? "info" : "pending" } })
      expect(roundTrip(KnownTranscriptEntry, entry).card).toEqual(card)
    }
  })
})

describe("runtime requests", () => {
  test("RuntimeRequest round-trips; secret inputs carry the value but stored responses never do", () => {
    const request = Schema.decodeUnknownSync(RuntimeRequest)({
      id: "req_1",
      conversationId: "cnv_1",
      botId: "bot_1",
      turnId: "trn_1",
      cardEntryId: "ent_2",
      kind: "command-approval",
      status: "expired",
      statusReason: "timeout",
      title: "Run this command?",
      subject: { command: "make", cwd: "/w", nodeId: "node_local" },
      responseCapability: { type: "decision", options: [{ id: "allow-once" }, { id: "allow-always" }, { id: "deny" }], allowMessage: true },
      suggestedRule: { surface: "shell", match: { commandPrefix: "make" } },
      source: { origin: "codex", method: "item/commandExecution/requestApproval", nativeRequestId: "7" },
      blocking: true,
      createdAt: 1,
      expiresAt: 600_001,
    })
    roundTrip(RuntimeRequest, request)
    expect(decodes(RuntimeResponseInput, { type: "secret", value: "s3cret" })).toBe(true)
    expect(decodes(RuntimeResponseInput, { type: "decision", decision: "allow-session", message: "ok" })).toBe(true)
    expect(decodes(RuntimeResponseInput, { type: "decision", decision: "allow-once", scope: "project-folder" })).toBe(true)
    expect(decodes(RuntimeResponseInput, { type: "decision", decision: "allow-once", scope: "everywhere" })).toBe(false)
    expect(decodes(RuntimeRequest, { ...Schema.encodeSync(RuntimeRequest)(request), status: "resolved", response: { type: "secret", value: "leak" } })).toBe(false)
  })
})

describe("policy, settings, memory, skills", () => {
  test("ApprovalRule round-trips", () => {
    roundTrip(ApprovalRule, Schema.decodeUnknownSync(ApprovalRule)({ id: "rul_1", botId: "bot_1", surface: "shell", match: { commandPrefix: "git " }, action: "allow", origin: "always-allow", createdAt: 1 }))
    expect(decodes(ApprovalRuleInput, { surface: "file-edit", match: {}, action: "ask" })).toBe(true)
    expect(decodes(ApprovalRuleInput, { surface: "files", match: {}, action: "ask" })).toBe(false)
  })

  test("Settings: missing keys decode to defaults; patches apply and clear", () => {
    expect(Schema.decodeUnknownSync(Settings)({})).toEqual(DEFAULT_SETTINGS)
    expect(Schema.decodeUnknownSync(Settings)({ theme: "dark" }).theme).toBe("dark")
    roundTrip(Settings, { ...DEFAULT_SETTINGS, defaultHarness: "codex", ownerName: "Leke" })
    const patch = Schema.decodeUnknownSync(SettingsPatch)({ showSteps: false, defaultHarness: "codex", approvalExpiryMinutes: 30 })
    const next = applySettingsPatch(DEFAULT_SETTINGS, patch)
    expect(next).toEqual({ ...DEFAULT_SETTINGS, showSteps: false, defaultHarness: "codex", approvalExpiryMinutes: 30 })
    expect("defaultHarness" in applySettingsPatch(next, { defaultHarness: null })).toBe(false)
    expect(decodes(SettingsPatch, { approvalExpiryMinutes: 0 })).toBe(false)
  })

  test("Settings: shared project folders and the default autonomy decode with defaults and patch", () => {
    const decoded = Schema.decodeUnknownSync(Settings)({ theme: "dark" })
    expect(decoded.sharedProjectFolders).toEqual([])
    expect(decoded.defaultAutonomy).toBe("workspace")
    roundTrip(Settings, { ...DEFAULT_SETTINGS, sharedProjectFolders: ["~/projects", "/srv/code"], defaultAutonomy: "ask" })
    const next = applySettingsPatch(DEFAULT_SETTINGS, { sharedProjectFolders: ["~/projects"], defaultAutonomy: "full" })
    expect(next).toMatchObject({ sharedProjectFolders: ["~/projects"], defaultAutonomy: "full" })
    expect(decodes(SettingsPatch, { defaultAutonomy: "yolo" })).toBe(false)
    expect(decodes(SettingsPatch, { sharedProjectFolders: [""] })).toBe(false)
    expect(decodes(SettingsPatch, { sharedProjectFolders: Array.from({ length: 33 }, (_, i) => `/p/${i}`) })).toBe(false)
  })

  test("project folder helpers: normalize, refuse roots / whole homes / `..`, minAutonomy", () => {
    expect(normalizeProjectFolder(" /home/me/projects// ")).toBe("/home/me/projects")
    expect(normalizeProjectFolder("~/projects/./snip/")).toBe("~/projects/snip")
    expect(normalizeProjectFolder("C:\\code\\x\\")).toBe("C:\\code\\x")
    for (const ok of ["/home/me/projects", "~/projects", "/srv", "C:\\code"]) expect(projectFolderProblem(ok)).toBeUndefined()
    for (const bad of ["", "/", "~", "~/", "~other/x", "/home", "/home/me", "/Users/me", "relative/x", "/opt/a/../b", "C:\\"]) {
      expect(projectFolderProblem(bad)).toBeDefined()
    }
    expect(minAutonomy("full", "workspace")).toBe("workspace")
    expect(minAutonomy("workspace", "ask")).toBe("ask")
    expect(minAutonomy("full", "full")).toBe("full")
  })

  test("memory facts and skills use slug names", () => {
    expect(memoryFactIdFromTitle("Prefers dark mode!")).toBe("prefers-dark-mode" as MemoryFactId)
    expect(memoryFactIdFromTitle("  Über Café ☕ ")).toBe("uber-cafe" as MemoryFactId)
    expect(memoryFactIdFromTitle("!!!")).toBe("fact" as MemoryFactId)
    expect(memoryFactIdFromTitle("x".repeat(100)).length).toBe(64)
    expect(decodes(MemoryFactId, memoryFactIdFromTitle("a ".repeat(40)))).toBe(true)
    expect(decodes(MemoryFactId, "../etc/passwd")).toBe(false)
    expect(decodes(SkillName, "triage-inbox")).toBe(true)
    expect(decodes(SkillName, "Triage Inbox")).toBe(false)
    roundTrip(BotMemory, Schema.decodeUnknownSync(BotMemory)({ index: "- [Tea](likes-tea.md)", facts: [{ id: "likes-tea", title: "Tea", body: "Green", updatedAt: 1 }] }))
  })
})

describe("roster stream", () => {
  test("snapshot with sections and settings round-trips", () => {
    const item = Schema.decodeUnknownSync(KnownRosterStreamItem)({
      kind: "snapshot",
      cursor: { epoch: "r1", sequence: 0 },
      bots: [Schema.encodeSync(Bot)(bot)],
      conversations: [],
      activities: [{ botId: "bot_1", state: "working", label: "Searching the web", toolKind: "web", since: 1 }],
      nodes: [],
      sections: [{ id: "sec_1", name: "Research", order: 1 }],
      settings: {},
    })
    roundTrip(KnownRosterStreamItem, item)
  })
})

describe("search", () => {
  test("a page of hits round-trips (entry, bot-to-bot and task hits)", () => {
    const page = Schema.decodeUnknownSync(SearchPage)({
      hits: [
        { ref: { kind: "entry", entryId: "ent_1" }, conversationId: "cnv_1", kind: "message", author: { kind: "owner" }, createdAt: 5, snippet: "the deploy waits", highlights: [{ start: 4, end: 10 }] },
        { ref: { kind: "entry", entryId: "ent_2" }, conversationId: "cnv_2", kind: "message", author: { kind: "bot", botId: "bot_1" }, toBotId: "bot_2", turnId: "trn_1", createdAt: 6, snippet: "ok", highlights: [] },
        { ref: { kind: "task", taskId: "tsk_1" }, conversationId: "cnv_1", kind: "task", author: { kind: "bot", botId: "bot_1" }, jumpEntryId: "ent_9", createdAt: 7, snippet: "report", highlights: [] },
      ],
      nextCursor: "r:-1.5:7:tsk_1",
      totalCapped: 3,
      terms: ["deploy"],
      indexing: true,
    })
    roundTrip(SearchPage, page)
    expect(decodes(SearchPage, { hits: [], nextCursor: null, totalCapped: 0 })).toBe(false) // terms are required
  })

  test("positions and a transcript window round-trip", () => {
    roundTrip(SearchPositions, Schema.decodeUnknownSync(SearchPositions)({ hits: [{ entryId: "ent_1", createdAt: 1 }], more: false, terms: ["leke"] }))
    const window = Schema.decodeUnknownSync(TranscriptWindow)({
      entries: [{ ...base, kind: "message", role: "bot", text: "hi", attachments: [], streaming: false, turnId: "trn_1" }],
      hasMoreBefore: true,
      hasMoreAfter: false,
      beforeCursor: "1:ent_1",
      afterCursor: null,
      turns: [{ id: "trn_1", conversationId: "cnv_1", botId: "bot_1", status: "completed", trigger: "user", startedAt: 1 }],
      requests: [],
    })
    roundTrip(TranscriptWindow, window)
  })
})

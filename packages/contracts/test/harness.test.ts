// Normalized harness events / requests / status (architecture §3.1).
import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import {
  DEFAULT_HARNESS_PROFILE_ID,
  describeAccount,
  HarnessEvent,
  HarnessItem,
  HarnessProfile,
  HarnessQuota,
  HarnessRequest,
  HarnessRequestResolution,
  HarnessStatus,
  isAnswersResolution,
  ModelInfo,
  normalizeProfileId,
  profileIdOf,
  quotaLevel,
  quotaWarnings,
  quotaWindowApplies,
  type BotId,
  type TurnId,
} from "../src/index.ts"

const json = <A, I>(schema: Schema.Codec<A, I, never, never>) => {
  const codec = Schema.fromJsonString(schema)
  return { encode: Schema.encodeSync(codec), decode: Schema.decodeUnknownSync(codec) }
}

const turnId = "trn_1" as TurnId

describe("HarnessEvent", () => {
  const events: ReadonlyArray<HarnessEvent> = [
    { _tag: "SessionBound", nativeSessionId: "sess-1" },
    { _tag: "TurnStarted", turnId },
    {
      _tag: "ItemUpserted",
      turnId,
      key: "msg_1:0",
      item: { _tag: "Message", role: "bot", text: "Hel", streaming: true },
    },
    {
      _tag: "ItemUpserted",
      turnId,
      key: "msg_1:0",
      item: { _tag: "Message", role: "bot", text: "Hello", streaming: false, phase: "final", aborted: false },
    },
    {
      _tag: "ItemUpserted",
      turnId,
      key: "msg_1:1",
      item: { _tag: "Reasoning", text: "thinking", streaming: false, source: "summary" },
    },
    {
      _tag: "ItemUpserted",
      turnId,
      key: "toolu_1",
      item: {
        _tag: "ToolCall",
        toolName: "mcp__openbot__shell",
        title: "Run ls",
        kind: "shell",
        status: "completed",
        inputSummary: "ls -la",
        outputPreview: "total 0",
        nodeId: "nod_2" as any,
        input: { command: "ls -la", node: "nod_2" },
        output: { text: "total 0" },
        command: { command: "ls -la", exitCode: 0 },
        mcp: { server: "openbot", tool: "shell" },
      },
    },
    {
      _tag: "ItemUpserted",
      turnId,
      key: "notice-1",
      item: { _tag: "Notice", level: "warning", text: "Retrying…", code: "retrying" },
    },
    { _tag: "Activity", label: "Searching the web", toolKind: "web" },
    { _tag: "Usage", usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 5 } },
    { _tag: "ContextUsage", usedTokens: 1000, windowTokens: 200_000 },
    { _tag: "TurnCompleted", turnId, stopReason: "end_turn" },
    { _tag: "TurnFailed", turnId, error: { code: "usage-limit", message: "Limit reached", retryable: false } },
    { _tag: "TurnInterrupted", turnId },
    { _tag: "SessionClosed", reason: "process exited" },
  ]

  test("every event round-trips through JSON", () => {
    const { encode, decode } = json(HarnessEvent)
    for (const e of events) expect(decode(encode(e))).toEqual(e)
    const tags = new Set(events.map((e) => e._tag))
    expect(tags.size).toBe(HarnessEvent.members.length)
  })

  test("tagged-union helpers work for consumers", () => {
    expect(HarnessEvent.guards.TurnCompleted(events[10]!)).toBe(true)
    const label = HarnessItem.match(
      { _tag: "Notice", level: "info", text: "x" },
      {
        Message: () => "message",
        Reasoning: () => "reasoning",
        ToolCall: () => "tool",
        Notice: (n) => `notice:${n.level}`,
      },
    )
    expect(label).toBe("notice:info")
  })

  test("malformed events are rejected", () => {
    expect(Result.isFailure(Schema.decodeUnknownResult(HarnessEvent)({ _tag: "TurnStarted" }))).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(HarnessEvent)({
          _tag: "ItemUpserted",
          turnId,
          key: "k",
          item: { _tag: "ToolCall", toolName: "x" },
        }),
      ),
    ).toBe(true)
  })
})

describe("HarnessRequest / resolution / status", () => {
  test("approval and question requests round-trip", () => {
    const { encode, decode } = json(HarnessRequest)
    const requests: ReadonlyArray<HarnessRequest> = [
      {
        kind: "command-approval",
        toolName: "Bash",
        title: "Run this command?",
        detail: "touch marker && echo ok",
        command: "touch marker && echo ok",
        cwd: "/w",
        nativeRequestId: "req-1",
        toolKey: "toolu_1",
        suggestions: [{ decision: "allow-session", label: "Allow for this chat", native: [{ type: "addRules" }] }],
      },
      {
        kind: "file-approval",
        toolName: "Write",
        title: "Write file?",
        detail: "denied.txt",
        paths: ["/w/denied.txt"],
        diff: "+hi",
      },
      { kind: "mcp-approval", toolName: "remember", title: "Allow openbot?", detail: "", server: "openbot" },
      {
        kind: "question",
        questions: [
          {
            id: "q1",
            prompt: "Color?",
            options: [{ label: "Blue" }, { label: "Red" }],
            multiSelect: false,
            allowFreeText: true,
          },
        ],
      },
    ]
    for (const r of requests) expect(decode(encode(r))).toEqual(r)
  })

  test("resolutions: decisions vs answers", () => {
    const { encode, decode } = json(HarnessRequestResolution)
    const decision: HarnessRequestResolution = { decision: "deny", message: "Blocked by your rules" }
    const answers: HarnessRequestResolution = { answers: { q1: "Blue", q2: ["A", "B"] } }
    expect(decode(encode(decision))).toEqual(decision)
    expect(decode(encode(answers))).toEqual(answers)
    expect(isAnswersResolution(answers)).toBe(true)
    expect(isAnswersResolution(decision)).toBe(false)
  })

  test("HarnessStatus and ModelInfo round-trip", () => {
    const status = Schema.decodeUnknownSync(HarnessStatus)({
      kind: "codex",
      displayName: "Codex",
      installed: true,
      version: "0.162.1",
      auth: { state: "signed-in", label: "me@example.com" },
      problems: [],
      capabilities: {
        resume: true,
        steer: true,
        interrupt: true,
        approvals: "interactive",
        questions: true,
        compact: true,
        contextUsage: true,
        images: true,
        remotePlacements: ["codex-environment", "brain-mcp-hands"],
      },
    })
    expect(json(HarnessStatus).decode(json(HarnessStatus).encode(status))).toEqual(status)
    const model = Schema.decodeUnknownSync(ModelInfo)({
      id: "gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      default: true,
      efforts: ["low", "high"],
    })
    expect(json(ModelInfo).decode(json(ModelInfo).encode(model))).toEqual(model)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(HarnessStatus)({
          kind: "codex",
          installed: true,
          auth: { state: "maybe" },
          problems: [],
        }),
      ),
    ).toBe(true)
  })
})

describe("harness accounts (profiles)", () => {
  test('normalizeProfileId / profileIdOf: absent, empty and "default" are the default account', () => {
    expect(normalizeProfileId(undefined)).toBeUndefined()
    expect(normalizeProfileId("")).toBeUndefined()
    expect(normalizeProfileId(DEFAULT_HARNESS_PROFILE_ID)).toBeUndefined()
    expect(normalizeProfileId("hpf_1")).toBe("hpf_1")
    expect(profileIdOf({})).toBe("default")
    expect(profileIdOf({ profileId: "hpf_1" })).toBe("hpf_1")
  })

  test("describeAccount", () => {
    expect(describeAccount(undefined)).toBeUndefined()
    expect(describeAccount({ email: "a@b.c", plan: "team" })).toBe("a@b.c (team)")
    expect(describeAccount({ organization: "Org" })).toBe("Org")
    expect(describeAccount({ plan: "max" })).toBe("max")
  })

  test("a per-account status and a profile round-trip; old statuses (no profile) still decode", () => {
    const status = Schema.decodeUnknownSync(HarnessStatus)({
      kind: "claude",
      installed: true,
      auth: { state: "signed-in", label: "a@b.c (team)" },
      problems: [],
      profileId: "hpf_1",
      profileLabel: "Work",
      configDir: "/home/u/.claude-2",
      account: { email: "a@b.c", plan: "team" },
    })
    expect(json(HarnessStatus).decode(json(HarnessStatus).encode(status))).toEqual(status)
    expect(
      Schema.decodeUnknownSync(HarnessStatus)({
        kind: "claude",
        installed: true,
        auth: { state: "unknown" },
        problems: [],
      }).profileId,
    ).toBeUndefined()
    const profile = Schema.decodeUnknownSync(HarnessProfile)({
      id: "hpf_1",
      kind: "claude",
      label: "Work",
      configDir: "/home/u/.claude-2",
      createdAt: 1,
    })
    expect(json(HarnessProfile).decode(json(HarnessProfile).encode(profile))).toEqual(profile)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(HarnessProfile)({ id: "", kind: "claude", label: "x", createdAt: 1 }),
      ),
    ).toBe(true)
  })
})

describe("plan limits", () => {
  const NOW = 1_000_000

  test("quotaLevel: near from 80%, out from 100%, ok again once the window has reset", () => {
    expect(quotaLevel({ usedPercent: 79.9 }, NOW)).toBe("ok")
    expect(quotaLevel({ usedPercent: 80 }, NOW)).toBe("near")
    expect(quotaLevel({ usedPercent: 100, resetsAt: NOW + 1 }, NOW)).toBe("out")
    expect(quotaLevel({ usedPercent: 104 }, NOW)).toBe("out")
    expect(quotaLevel({ usedPercent: 100, resetsAt: NOW }, NOW)).toBe("ok")
  })

  test("quotaWindowApplies: a model window only limits the Bots that name its family", () => {
    expect(quotaWindowApplies({ kind: "session" }, undefined)).toBe(true)
    expect(quotaWindowApplies({ kind: "week" }, "claude-opus-5-5")).toBe(true)
    expect(quotaWindowApplies({ kind: "week-model", model: "Opus" }, "claude-opus-5-5")).toBe(true)
    expect(quotaWindowApplies({ kind: "week-model", model: "Opus" }, "claude-sonnet-5-5")).toBe(false)
    // the harness default model is not guessed
    expect(quotaWindowApplies({ kind: "week-model", model: "Opus" }, undefined)).toBe(false)
  })

  test("quotaWarnings: used-up windows first, each with the Bots it limits", () => {
    const [a, b] = ["bot_a" as BotId, "bot_b" as BotId]
    const models: Record<string, string | undefined> = { bot_a: "claude-opus-5-5", bot_b: undefined }
    const warnings = quotaWarnings(
      {
        botIds: [a, b],
        windows: [
          { kind: "session", usedPercent: 12, resetsAt: NOW + 10 },
          { kind: "week", usedPercent: 86, resetsAt: NOW + 20 },
          { kind: "week-model", model: "Opus", usedPercent: 100, resetsAt: NOW + 20 },
        ],
      },
      (id) => models[id],
      NOW,
    )
    expect(warnings.map((w) => [w.level, w.window.kind, w.botIds])).toEqual([
      ["out", "week-model", [a]],
      ["near", "week", [a, b]],
    ])
    expect(quotaWarnings({ botIds: [a], windows: [] }, () => undefined, NOW)).toEqual([])
  })

  test("HarnessQuota round-trips", () => {
    const quota = Schema.decodeUnknownSync(HarnessQuota)({
      kind: "claude",
      profileId: "default",
      profileLabel: "Default",
      windows: [
        { kind: "session", usedPercent: 100, resetsAt: 5 },
        { kind: "week-model", model: "Opus", usedPercent: 3.5 },
      ],
      account: { email: "a@b.c", plan: "team" },
      extraUsage: false,
      checkedAt: 4,
      botIds: ["bot_a"],
      otherProfileBots: 1,
      limitHits: [{ botId: "bot_a", at: 3, message: "You've hit your session limit" }],
    })
    expect(json(HarnessQuota).decode(json(HarnessQuota).encode(quota))).toEqual(quota)
  })
})

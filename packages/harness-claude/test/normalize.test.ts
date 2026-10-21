import { describe, expect, test } from "bun:test"
import { HarnessEvent, type HarnessEventOf, type HarnessItem, type TurnId } from "@openbot/contracts"
import { Schema } from "effect"
import { join } from "node:path"
import { ClaudeEventPipeline } from "../src/normalize.ts"
import { CONTRACT_FIXTURES, type FixtureFrame, LOCAL_FIXTURES, loadJsonl, turnId } from "./support.ts"

const decodeEvent = Schema.decodeUnknownSync(HarnessEvent)

/** Replays a contracts fixture (`{seq, source, payload}`) through the pipeline. */
const replayBasic = async () => {
  const frames = await loadJsonl<FixtureFrame>(join(CONTRACT_FIXTURES, "claude-basic.jsonl"))
  const pipeline = new ClaudeEventPipeline()
  const events: Array<HarnessEvent> = []
  for (const frame of frames) {
    const p = frame.payload
    if (frame.source === "openbot.control") {
      if (p.action === "send") events.push(...pipeline.send(turnId(p.turnIndex as number), `uuid-${String(p.turnIndex)}`))
      if (p.action === "interrupt") pipeline.requestInterrupt()
    } else if (frame.source === "claude.canUseTool.response") {
      const result = p.result as { behavior: "allow" | "deny"; message?: string }
      pipeline.noteDecision(p.toolUseID as string, result.behavior, result.message)
    } else if (frame.source === "claude.sdk.message") {
      const out = pipeline.message(p)
      expect(out.settled).toEqual([])
      events.push(...out.events)
    }
  }
  return { events, pipeline }
}

/** Final item per key (last upsert wins), with the turn it belongs to. */
const finalItems = (events: ReadonlyArray<HarnessEvent>) => {
  const items = new Map<string, { turnId: TurnId; item: HarnessItem }>()
  for (const e of events) if (e._tag === "ItemUpserted") items.set(e.key, { turnId: e.turnId, item: e.item })
  return items
}

const ofTag = <T extends HarnessEvent["_tag"]>(events: ReadonlyArray<HarnessEvent>, tag: T) =>
  events.filter((e): e is HarnessEventOf<T> => e._tag === tag)

describe("ClaudeEventPipeline × claude-basic.jsonl", () => {
  test("every event is a valid contracts.HarnessEvent", async () => {
    const { events } = await replayBasic()
    expect(events.length).toBeGreaterThan(20)
    for (const e of events) expect(() => decodeEvent(e)).not.toThrow()
  })

  test("binds the session once and runs six turns (five completed, one interrupted)", async () => {
    const { events, pipeline } = await replayBasic()
    const bound = ofTag(events, "SessionBound")
    expect(bound.map((e) => e.nativeSessionId)).toEqual(["1b9ad6b2-b9f4-45e1-9c5a-54c4d57a8aa4"])
    expect(pipeline.nativeSessionId).toBe("1b9ad6b2-b9f4-45e1-9c5a-54c4d57a8aa4")
    expect(ofTag(events, "TurnStarted").map((e) => e.turnId)).toEqual([0, 1, 2, 3, 4, 5].map(turnId))
    expect(ofTag(events, "TurnCompleted").map((e) => e.turnId)).toEqual([0, 1, 2, 3, 5].map(turnId))
    expect(ofTag(events, "TurnCompleted")[0]!.stopReason).toBe("completed")
    expect(ofTag(events, "TurnInterrupted").map((e) => e.turnId)).toEqual([turnId(4)])
    expect(ofTag(events, "TurnFailed")).toEqual([])
    expect(pipeline.busy).toBe(false)
  })

  test("turn ordering: items arrive between their TurnStarted and terminal event", async () => {
    const { events } = await replayBasic()
    let open: TurnId | undefined
    for (const e of events) {
      if (e._tag === "TurnStarted") open = e.turnId
      if (e._tag === "ItemUpserted") expect(e.turnId).toBe(open!)
      if (e._tag === "TurnCompleted" || e._tag === "TurnInterrupted") {
        expect(e.turnId).toBe(open!)
        open = undefined
      }
    }
  })

  test("thinking and text of one API message get distinct keys (block index, not content index)", async () => {
    const { events } = await replayBasic()
    const items = finalItems(events)
    expect(items.get("msg_fake_001:0")).toEqual({
      turnId: turnId(0),
      item: { _tag: "Reasoning", text: "The user greets me. I should greet back.", streaming: false, source: "thinking" },
    })
    expect(items.get("msg_fake_001:1")).toEqual({
      turnId: turnId(0),
      item: { _tag: "Message", role: "bot", text: "Hello from the scripted Claude.", streaming: false },
    })
    // streamed deltas came first
    const streamed = events.find((e) => e._tag === "ItemUpserted" && e.key === "msg_fake_001:1" && e.item._tag === "Message" && e.item.streaming)
    expect(streamed).toBeDefined()
  })

  test("Bash approval → completed shell tool with output", async () => {
    const { events } = await replayBasic()
    const bash = finalItems(events).get("toolu_fake_002_1")!
    expect(bash.turnId).toBe(turnId(1))
    expect(bash.item).toMatchObject({
      _tag: "ToolCall",
      toolName: "Bash",
      kind: "shell",
      status: "completed",
      title: "Create a marker file",
      inputSummary: "touch marker.txt && echo openbot-fixture",
      outputPreview: "openbot-fixture",
      command: { command: "touch marker.txt && echo openbot-fixture" },
    })
    expect(finalItems(events).get("msg_fake_002:0")!.item).toMatchObject({ _tag: "Message", text: "Running it now." })
    expect(finalItems(events).get("msg_fake_003:0")!.item).toMatchObject({ text: "The command printed openbot-fixture." })
  })

  test("denied Write → declined tool with the deny message", async () => {
    const { events } = await replayBasic()
    const write = finalItems(events).get("toolu_fake_004_0")!
    expect(write.item).toMatchObject({
      _tag: "ToolCall",
      toolName: "Write",
      kind: "file-write",
      status: "declined",
      error: "The user denied this action.",
      fileChanges: [{ path: "<CWD>/denied.txt", kind: "update" }],
    })
  })

  test("AskUserQuestion → completed question tool", async () => {
    const { events } = await replayBasic()
    const ask = finalItems(events).get("toolu_fake_006_0")!
    expect(ask.item).toMatchObject({ _tag: "ToolCall", toolName: "AskUserQuestion", kind: "question", status: "completed" })
    expect((ask.item as { outputPreview?: string }).outputPreview).toContain("Blue")
  })

  test("interrupt → aborted partial text and TurnInterrupted", async () => {
    const { events } = await replayBasic()
    expect(finalItems(events).get("msg_fake_008:0")!.item).toEqual({
      _tag: "Message",
      role: "bot",
      text: "Once upon a time there was a lighthouse ",
      streaming: false,
      aborted: true,
    })
    expect(finalItems(events).get("msg_fake_009:0")!.item).toMatchObject({ text: "Still here after the interrupt." })
  })

  test("nothing is left streaming and every tool is terminal", async () => {
    const { events } = await replayBasic()
    for (const { item } of finalItems(events).values()) {
      if (item._tag === "Message" || item._tag === "Reasoning") expect(item.streaming).toBe(false)
      if (item._tag === "ToolCall") expect(["completed", "failed", "declined"]).toContain(item.status)
    }
  })

  test("usage per turn from the cumulative cost; context window from modelUsage", async () => {
    const { events } = await replayBasic()
    const usage = ofTag(events, "Usage")
    expect(usage[0]).toMatchObject({ turnId: turnId(0), usage: { inputTokens: 10, outputTokens: 5 } })
    expect(usage[0]!.usage.costUsd).toBeCloseTo(0.0000035, 10)
    expect(usage[1]!.usage.costUsd).toBeCloseTo(0.000007, 10) // 0.0000105 - 0.0000035
    expect(ofTag(events, "ContextUsage")[0]).toEqual({ _tag: "ContextUsage", usedTokens: 15, windowTokens: 1_000_000 })
  })

  test("activity labels drive the activity row", async () => {
    const { events } = await replayBasic()
    const labels = ofTag(events, "Activity").map((e) => e.label)
    expect(labels).toContain("Thinking…")
    expect(labels).toContain("Typing…")
    expect(ofTag(events, "Activity").find((e) => e.toolKind === "shell")?.label).toBe("Running a command")
  })

  test("a resumed session only sets the cost baseline on its first result", async () => {
    const pipeline = new ClaudeEventPipeline({ resumed: true, sessionId: "s" })
    pipeline.send(turnId(1), "u1")
    const first = pipeline.message({ type: "result", subtype: "success", total_cost_usd: 5, usage: { input_tokens: 3, output_tokens: 1 } })
    expect(ofTag(first.events, "Usage")[0]!.usage.costUsd).toBeUndefined()
    pipeline.send(turnId(2), "u2")
    const second = pipeline.message({ type: "result", subtype: "success", total_cost_usd: 5.5, usage: { input_tokens: 3, output_tokens: 1 } })
    expect(ofTag(second.events, "Usage")[0]!.usage.costUsd).toBeCloseTo(0.5)
  })
})

describe("ClaudeEventPipeline × live recordings", () => {
  test("MCP tool turn, image turn and interrupted thinking turn (messages.jsonl)", async () => {
    const lines = await loadJsonl<{ phase: string; m: Record<string, unknown> }>(join(LOCAL_FIXTURES, "claude-live-messages.jsonl"))
    const pipeline = new ClaudeEventPipeline()
    const events: Array<HarnessEvent> = []
    // The client uuid each turn was sent with, as the CLI echoes it (turn2 was sent without one).
    const sentUuid = (phase: string) =>
      lines.find((l) => l.phase === phase && typeof l.m.user_message_uuid === "string")?.m.user_message_uuid as
        | string
        | undefined
    expect(sentUuid("turn1")).toBe("fbfac1eb-ba8f-4b6f-934a-c2f0eee8294a")
    expect(sentUuid("turn2")).toBeUndefined()
    let turn = 0
    let phase = ""
    for (const line of lines) {
      if (line.phase.startsWith("turn") && line.phase !== phase) {
        phase = line.phase
        events.push(...pipeline.send(turnId(++turn), sentUuid(phase) ?? `u${turn}`))
        if (line.phase === "turn3") pipeline.requestInterrupt()
      }
      if (line.phase === "canUseTool" || line.phase === "interrupt-response") continue
      events.push(...pipeline.message(line.m).events)
    }
    for (const e of events) expect(() => decodeEvent(e)).not.toThrow()
    const items = finalItems(events)
    expect(items.get("toolu_019bk7qGv6htPqcbyxk1tFxS")!.item).toMatchObject({
      _tag: "ToolCall",
      toolName: "mcp__openbot__ping",
      kind: "mcp",
      mcp: { server: "openbot", tool: "ping" },
      status: "completed",
      outputPreview: "PONG:HELLO",
    })
    expect(ofTag(events, "TurnCompleted").map((e) => e.turnId)).toEqual([turnId(1), turnId(2)])
    expect(ofTag(events, "TurnInterrupted").map((e) => e.turnId)).toEqual([turnId(3)])
    const texts = [...items.values()].filter((v) => v.item._tag === "Message").map((v) => v.item as { text: string; aborted?: boolean })
    expect(texts.map((t) => t.text)).toContain("Red")
    expect(texts.find((t) => t.aborted)?.text.startsWith("1\n2\n3")).toBe(true)
    // omitted thinking display (empty thinking text, no deltas) produces no reasoning item
    expect([...items.values()].some((v) => v.item._tag === "Reasoning")).toBe(false)
  })

  test("subagent frames: the Agent tool is a subagent call; child text has no home", async () => {
    const frames = await loadJsonl<Record<string, unknown>>(join(LOCAL_FIXTURES, "claude-live-subagent.jsonl"))
    const pipeline = new ClaudeEventPipeline()
    const events: Array<HarnessEvent> = [...pipeline.send(turnId(1), "u1")]
    for (const frame of frames) events.push(...pipeline.message(frame).events)
    for (const e of events) expect(() => decodeEvent(e)).not.toThrow()
    const items = finalItems(events)
    const agent = [...items.values()].find((v) => v.item._tag === "ToolCall" && v.item.toolName === "Agent")
    expect(agent?.item).toMatchObject({ kind: "subagent", status: "completed", title: "Reply with KIWI" })
    const messages = [...items.values()].filter((v) => v.item._tag === "Message")
    expect(messages.length).toBe(1) // only the parent's final reply
    expect(ofTag(events, "TurnCompleted")).toHaveLength(1)
  })
})

describe("ClaudeEventPipeline turn bookkeeping", () => {
  test("queued sends start in order; coalesced sends end with the same result", () => {
    const pipeline = new ClaudeEventPipeline({ sessionId: "s" })
    expect(pipeline.send(turnId(1), "a")).toEqual([{ _tag: "TurnStarted", turnId: turnId(1) }])
    expect(pipeline.send(turnId(2), "b")).toEqual([])
    expect(pipeline.send(turnId(3), "c")).toEqual([])
    const first = pipeline.message({ type: "result", subtype: "success", terminal_reason: "completed" }).events
    expect(first.map((e) => e._tag)).toEqual(["TurnCompleted", "TurnStarted"])
    const coalesced = pipeline.message({ type: "result", subtype: "success", user_message_uuids: ["b", "c"] }).events
    expect(coalesced.map((e) => `${e._tag}:${"turnId" in e ? e.turnId : ""}`)).toEqual([
      `TurnCompleted:${turnId(2)}`,
      `TurnStarted:${turnId(3)}`,
      `TurnCompleted:${turnId(3)}`,
    ])
    expect(pipeline.busy).toBe(false)
  })

  test("steer folds only into the running turn it names, and not while it is being interrupted", () => {
    const pipeline = new ClaudeEventPipeline({ sessionId: "s" })
    expect(pipeline.steer(turnId(1), "x")).toBe(false) // nothing running
    pipeline.send(turnId(1), "a")
    expect(pipeline.steer(turnId(2), "x")).toBe(false) // another turn
    expect(pipeline.steer(turnId(1), "b")).toBe(true)
    expect(pipeline.activeTurnId).toBe(turnId(1))
    pipeline.requestInterrupt()
    expect(pipeline.canSteer(turnId(1))).toBe(false)
    expect(pipeline.busy).toBe(true)
  })

  test("a folded steer ends with the turn's result", () => {
    const pipeline = new ClaudeEventPipeline({ sessionId: "s" })
    pipeline.send(turnId(1), "a")
    pipeline.steer(turnId(1), "b")
    const out = pipeline.message({ type: "result", subtype: "success", user_message_uuid: "b", user_message_uuids: ["a", "b"] })
    expect(ofTag(out.events, "TurnCompleted").map((e) => e.turnId)).toEqual([turnId(1)])
    expect(pipeline.busy).toBe(false)
  })

  test("a steer the CLI did not fold in keeps the turn open until its own result", () => {
    const pipeline = new ClaudeEventPipeline({ sessionId: "s" })
    pipeline.send(turnId(1), "a")
    pipeline.steer(turnId(1), "b")
    const first = pipeline.message({
      type: "result",
      subtype: "success",
      user_message_uuids: ["a"],
      usage: { input_tokens: 10, output_tokens: 2 },
    })
    expect(first.events.map((e) => e._tag)).toEqual(["Usage"])
    expect(pipeline.activeTurnId).toBe(turnId(1))
    // the CLI answers the steered input as its next turn: items stay in turn 1
    pipeline.message({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "m2" } } })
    pipeline.message({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text" } } })
    const delta = pipeline.message({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "also done" } },
    })
    expect(ofTag(delta.events, "ItemUpserted")[0]).toMatchObject({ turnId: turnId(1), key: "m2:0" })
    const second = pipeline.message({ type: "result", subtype: "success", user_message_uuids: ["b"] })
    expect(ofTag(second.events, "TurnCompleted").map((e) => e.turnId)).toEqual([turnId(1)])
    expect(pipeline.busy).toBe(false)
  })

  test("after an interrupt request a pending steer does not keep the turn open", () => {
    const pipeline = new ClaudeEventPipeline({ sessionId: "s" })
    pipeline.send(turnId(1), "a")
    pipeline.steer(turnId(1), "b")
    pipeline.requestInterrupt()
    // the CLI finished before the interrupt landed
    const out = pipeline.message({ type: "result", subtype: "success", user_message_uuids: ["a"] })
    expect(ofTag(out.events, "TurnCompleted").map((e) => e.turnId)).toEqual([turnId(1)])
    expect(pipeline.busy).toBe(false)
  })

  test("without uuid echoes (older CLIs) a result ends the turn as before", () => {
    const pipeline = new ClaudeEventPipeline({ sessionId: "s" })
    pipeline.send(turnId(1), "a")
    pipeline.steer(turnId(1), "b")
    expect(ofTag(pipeline.message({ type: "result", subtype: "success" }).events, "TurnCompleted")).toHaveLength(1)
  })

  test("a result for a turn OpenBot did not start ends nothing", () => {
    const pipeline = new ClaudeEventPipeline({ sessionId: "s" })
    pipeline.send(turnId(1), "a")
    pipeline.steer(turnId(1), "b")
    pipeline.requestInterrupt()
    // interrupted before folding "b": the turn ends; "b" still runs as a CLI turn of its own
    const interrupted = pipeline.message({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_streaming",
      user_message_uuids: ["a"],
    })
    expect(ofTag(interrupted.events, "TurnInterrupted").map((e) => e.turnId)).toEqual([turnId(1)])
    pipeline.send(turnId(2), "c")
    const stray = pipeline.message({ type: "result", subtype: "success", user_message_uuids: ["b"], usage: { input_tokens: 4, output_tokens: 1 } })
    expect(stray.events.map((e) => e._tag)).toEqual(["Usage"])
    expect(pipeline.activeTurnId).toBe(turnId(2))
    const own = pipeline.message({ type: "result", subtype: "success", user_message_uuids: ["c"] })
    expect(ofTag(own.events, "TurnCompleted").map((e) => e.turnId)).toEqual([turnId(2)])
  })

  test("commands occupy the FIFO without turn events and settle on their result", () => {
    const pipeline = new ClaudeEventPipeline({ sessionId: "s" })
    expect(pipeline.command("c1", "c1")).toEqual([])
    const out = pipeline.message({ type: "result", subtype: "success" })
    expect(out.events.filter((e) => e._tag.startsWith("Turn"))).toEqual([])
    expect(out.settled).toEqual([{ id: "c1", ok: true }])
  })

  test("error results map to TurnFailed with a classified code", () => {
    const pipeline = new ClaudeEventPipeline({ sessionId: "s" })
    pipeline.send(turnId(1), "a")
    pipeline.message({ type: "assistant", parent_tool_use_id: null, error: "rate_limit", message: { id: "m", content: [] } })
    const out = pipeline.message({ type: "result", subtype: "success", is_error: true, result: "You've hit your limit · resets 5pm" })
    expect(ofTag(out.events, "TurnFailed")[0]!.error).toEqual({ code: "usage-limit", message: "You've hit your limit · resets 5pm", retryable: false })
    pipeline.send(turnId(2), "b")
    const max = pipeline.message({ type: "result", subtype: "error_max_turns", is_error: true, errors: ["max turns"] })
    expect(ofTag(max.events, "TurnFailed")[0]!.error.code).toBe("max-turns")
  })

  test("a signed-out CLI's error message is the turn's failure, not something the bot said", () => {
    const pipeline = new ClaudeEventPipeline({ sessionId: "s" })
    pipeline.send(turnId(1), "a")
    const said = pipeline.message({
      type: "assistant",
      parent_tool_use_id: null,
      error: "authentication_failed",
      message: { id: "m", content: [{ type: "text", text: "Failed to authenticate: OAuth session expired and could not be refreshed" }] },
    })
    expect(said.events.filter((e) => e._tag === "ItemUpserted")).toEqual([])
    const out = pipeline.message({ type: "result", subtype: "success", is_error: true, result: "Failed to authenticate: OAuth session expired and could not be refreshed" })
    expect(ofTag(out.events, "TurnFailed")[0]!.error).toEqual({
      code: "auth",
      message: "Failed to authenticate: OAuth session expired and could not be refreshed",
      retryable: false,
    })
  })

  test("unexpected close fails accepted turns; deliberate close interrupts them", () => {
    const a = new ClaudeEventPipeline({ sessionId: "s" })
    a.send(turnId(1), "a")
    a.message({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "m1" } } })
    a.message({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text" } } })
    a.message({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "par" } } })
    a.send(turnId(2), "b")
    const failed = a.close("crashed", true)
    expect(failed.events.map((e) => e._tag)).toEqual(["ItemUpserted", "TurnFailed", "TurnStarted", "TurnFailed", "SessionClosed"])
    expect(failed.events[0]).toMatchObject({ item: { _tag: "Message", text: "par", streaming: false } })
    const b = new ClaudeEventPipeline({ sessionId: "s" })
    b.send(turnId(1), "a")
    expect(b.close("closed", false).events.map((e) => e._tag)).toEqual(["TurnInterrupted", "SessionClosed"])
  })

  test("compact boundary yields a notice and a context update", () => {
    const pipeline = new ClaudeEventPipeline({ sessionId: "s" })
    pipeline.send(turnId(1), "a")
    pipeline.message({ type: "result", subtype: "success", modelUsage: { m: { contextWindow: 200000 } } })
    pipeline.send(turnId(2), "b")
    const out = pipeline.message({
      type: "system",
      subtype: "compact_boundary",
      uuid: "cb1",
      compact_metadata: { trigger: "manual", pre_tokens: 50000, post_tokens: 4000 },
    })
    expect(out.events).toEqual([
      { _tag: "ContextUsage", usedTokens: 4000, windowTokens: 200000 },
      {
        _tag: "ItemUpserted",
        turnId: turnId(2),
        key: "compact:cb1",
        item: { _tag: "Notice", level: "info", code: "compacted", text: "Context compacted (50,000 → 4,000 tokens)" },
      },
    ])
  })

  test("unknown frame types are ignored", () => {
    const pipeline = new ClaudeEventPipeline({ sessionId: "s" })
    pipeline.send(turnId(1), "a")
    expect(pipeline.message({ type: "brand_new_frame", x: 1 }).events).toEqual([])
    expect(pipeline.message(null).events).toEqual([])
    expect(pipeline.message({ type: "rate_limit_event" }).events).toEqual([])
  })
})

describe("ClaudeEventPipeline × host node attribution", () => {
  const toolFrame = (id: string, name: string, input: Record<string, unknown>) => ({
    type: "assistant",
    session_id: "s",
    uuid: `u-${id}`,
    parent_tool_use_id: null,
    message: { id: `m-${id}`, content: [{ type: "tool_use", id, name, input }] },
  })
  const toolItem = (events: ReadonlyArray<HarnessEvent>, key: string) =>
    events.flatMap((e) => (e._tag === "ItemUpserted" && e.key === key && e.item._tag === "ToolCall" ? [e.item] : [])).at(-1)

  test("gateway node tools without `node` run on the host node (B1 on a remote node)", () => {
    const pipeline = new ClaudeEventPipeline({ sessionId: "s", hostNodeId: "nod_remote" as never })
    const events = [
      ...pipeline.send(turnId(1), "u1"),
      ...pipeline.message(toolFrame("t1", "mcp__openbot__write_file", { path: "a.txt", content: "x" })).events,
      ...pipeline.message(toolFrame("t2", "mcp__openbot__shell", { command: "ls", node: "nod_other" })).events,
      ...pipeline.message(toolFrame("t3", "mcp__openbot__list_bots", {})).events,
      ...pipeline.message(toolFrame("t4", "Bash", { command: "ls" })).events,
    ]
    expect(toolItem(events, "t1")?.nodeId).toBe("nod_remote" as never)
    expect(toolItem(events, "t2")?.nodeId).toBe("nod_other" as never)
    expect(toolItem(events, "t3")?.nodeId).toBeUndefined()
    expect(toolItem(events, "t4")?.nodeId).toBeUndefined()
  })
})

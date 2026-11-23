import { describe, expect, test } from "bun:test"
import type { BotId, ConversationId, Millis, Task, TaskId, Turn, TurnId } from "@openbot/contracts"
import { computeOverview } from "../../src/services/automation/UsageService.ts"
import type { UsageRecord } from "../../src/ports/repos.ts"

const HOUR = 3_600_000
const A = "bot_a" as BotId
const B = "bot_b" as BotId
const C = "cnv_1" as ConversationId
const t0 = 1_000 * HOUR

const turn = (id: string, botId: BotId, startedAt: number, status: Turn["status"], ms?: number): Turn =>
  ({
    id: id as TurnId,
    conversationId: C,
    botId,
    status,
    trigger: "user",
    startedAt: startedAt as Millis,
    ...(ms === undefined ? {} : { endedAt: (startedAt + ms) as Millis }),
  }) as Turn

const task = (id: string, botId: BotId, createdAt: number, status: Task["status"]): Task =>
  ({
    id: id as TaskId,
    botId,
    conversationId: C,
    title: id,
    brief: "",
    status,
    createdAt,
    updatedAt: createdAt,
  }) as unknown as Task

const use = (botId: BotId, at: number, costUsd: number, model = "m1"): UsageRecord => ({
  botId,
  at: at as Millis,
  harness: "claude",
  model,
  usage: { inputTokens: 100, outputTokens: 50, costUsd },
})

describe("computeOverview", () => {
  const overview = computeOverview({
    sinceMs: t0 as Millis,
    bucketMs: HOUR,
    nowMs: t0 + 3 * HOUR,
    usage: [use(A, t0 + 10, 1), use(A, t0 + HOUR + 5, 2, "m2"), use(B, t0 + 2 * HOUR, 0.5), use(B, t0 - 1, 99)],
    turns: [
      turn("t1", A, t0 + 1, "completed", 10_000),
      turn("t2", A, t0 + HOUR, "failed", 30_000),
      turn("t3", B, t0 + 2 * HOUR, "interrupted", 20_000),
      turn("t4", B, t0 + 2 * HOUR + 1, "running"),
      turn("old", A, t0 - HOUR, "failed", 1),
    ],
    tasks: [task("k1", A, t0 + 5, "succeeded"), task("k2", B, t0 + 2 * HOUR, "failed")],
  })

  test("buckets everything that started in the window, ignoring older rows", () => {
    expect(overview.buckets.map((b) => b.at)).toEqual([t0, t0 + HOUR, t0 + 2 * HOUR])
    expect(overview.buckets.map((b) => b.turns)).toEqual([1, 1, 2])
    expect(overview.buckets.map((b) => b.turnsFailed)).toEqual([0, 1, 0])
    expect(overview.buckets.map((b) => b.tasks)).toEqual([1, 0, 1])
    expect(overview.buckets.map((b) => b.tasksFailed)).toEqual([0, 0, 1])
    expect(overview.buckets.map((b) => b.costUsd)).toEqual([1, 2, 0.5])
    expect(overview.buckets.every((b) => b.tokens === 150)).toBe(true)
  })

  test("per bot, sorted by spend, with the median turn time", () => {
    expect(overview.byBot.map((r) => r.botId)).toEqual([A, B])
    const a = overview.byBot[0]!
    expect([a.turns, a.turnsFailed, a.tasks, a.costUsd]).toEqual([2, 1, 1, 3])
    expect(a.turnP50Ms).toBe(30_000)
    expect(overview.byBot[1]!.tasksFailed).toBe(1)
  })

  test("per model and overall percentiles; interrupted is not a failure", () => {
    expect(overview.byModel.map((m) => [m.model, m.costUsd, m.records])).toEqual([
      ["m2", 2, 1],
      ["m1", 1.5, 2],
    ])
    expect(overview.turnP50Ms).toBe(20_000)
    expect(overview.turnP90Ms).toBe(30_000)
  })
})

// Plan limits (`runQuota`): the SDK's usage answer parsed into windows, and every way the read can
// come back without one. No CLI is started: a fake `query()` answers.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { parseUsage, runQuota } from "../src/quota.ts"
import type { ClaudeQueryFunction, ClaudeQueryHandle, ClaudeQueryParams } from "../src/sdk.ts"

const INIT = {
  models: [],
  account: { email: "owner@example.com", subscriptionType: "team", apiProvider: "firstParty" },
  claude_code_version: "2.1.300",
}

const USAGE = {
  subscription_type: "team",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 32, resets_at: "2026-11-26T10:20:00.000Z" },
    seven_day: { utilization: 73.4, resets_at: "2026-11-27T18:00:00.000Z" },
    seven_day_opus: { utilization: 11, resets_at: "2026-11-27T18:00:00.000Z" },
    seven_day_sonnet: null,
    model_scoped: [
      { display_name: "Fable", utilization: 100, resets_at: "2026-11-27T18:00:00.000Z" },
      { display_name: "Opus", utilization: 12, resets_at: null },
      { display_name: "", utilization: 5 },
    ],
    extra_usage: { is_enabled: false, monthly_limit: null },
  },
  // unknown fields are ignored
  limits: [{ anything: true }],
}

/** A fake `query()`: records options and close, answers the init and (when given) the usage request. */
const usageQuery = (init: () => Promise<unknown>, usage?: (options: unknown) => Promise<unknown>) => {
  const calls: Array<{ options: Readonly<Record<string, unknown>>; closed: boolean; asked: Array<unknown> }> = []
  const query: ClaudeQueryFunction = (params: ClaudeQueryParams) => {
    const call = { options: params.options, closed: false, asked: [] as Array<unknown> }
    calls.push(call)
    const handle: ClaudeQueryHandle = {
      next: () => new Promise(() => {}),
      interrupt: async () => ({}),
      close: () => {
        call.closed = true
      },
      setMcpServers: async () => ({}),
      initializationResult: init,
      getContextUsage: async () => ({}),
      ...(usage !== undefined
        ? {
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (options: unknown) => {
              call.asked.push(options)
              return usage(options)
            },
          }
        : {}),
    }
    return handle
  }
  return { query, calls }
}

const input = (query: ClaudeQueryFunction) => ({ query, env: {}, executable: undefined, cwd: "/tmp", timeoutMs: 2_000 })

describe("parseUsage", () => {
  test("session, week and one window per model family (the server's rows win over the older fields)", () => {
    const parsed = parseUsage(USAGE)
    expect(parsed.windows).toEqual([
      { kind: "session", usedPercent: 32, resetsAt: Date.parse("2026-11-26T10:20:00.000Z") },
      { kind: "week", usedPercent: 73.4, resetsAt: Date.parse("2026-11-27T18:00:00.000Z") },
      { kind: "week-model", model: "Fable", usedPercent: 100, resetsAt: Date.parse("2026-11-27T18:00:00.000Z") },
      { kind: "week-model", model: "Opus", usedPercent: 12 },
    ])
    expect(parsed.extraUsage).toBe(false)
    expect(parsed.problem).toBeUndefined()
  })

  test("the older per-model fields alone still give model windows", () => {
    const parsed = parseUsage({
      rate_limits: { seven_day_sonnet: { utilization: 40, resets_at: "2026-11-27T18:00:00.000Z" } },
    })
    expect(parsed.windows).toEqual([
      { kind: "week-model", model: "Sonnet", usedPercent: 40, resetsAt: Date.parse("2026-11-27T18:00:00.000Z") },
    ])
  })

  test("no plan limits: API key or cloud logins, empty and malformed answers", () => {
    expect(parseUsage({ rate_limits_available: false, rate_limits: null })).toEqual({
      windows: [],
      extraUsage: undefined,
      problem: "This login has no plan limits (API key or cloud provider).",
    })
    expect(parseUsage(undefined).problem).toBe("Claude did not report plan limits.")
    expect(parseUsage({ rate_limits: { five_hour: { utilization: "a lot" } } }).problem).toBe(
      "Claude reported no plan limits for this account.",
    )
  })
})

describe("runQuota", () => {
  test("asks the idle query for its usage (no prompt, no transcript scan) and closes it", async () => {
    const fake = usageQuery(
      async () => INIT,
      async () => USAGE,
    )
    const report = await Effect.runPromise(runQuota(input(fake.query)))
    expect(report.windows.map((w) => [w.kind, w.model, w.usedPercent])).toEqual([
      ["session", undefined, 32],
      ["week", undefined, 73.4],
      ["week-model", "Fable", 100],
      ["week-model", "Opus", 12],
    ])
    expect(report.account).toEqual({ email: "owner@example.com", plan: "team" })
    expect(report.extraUsage).toBe(false)
    expect(report.problem).toBeUndefined()
    expect(report.checkedAt).toBeGreaterThan(0)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]!.asked).toEqual([{ skipBehaviors: true }])
    expect(fake.calls[0]!.closed).toBe(true)
  })

  test("signed out: no usage request", async () => {
    const fake = usageQuery(
      async () => ({ ...INIT, account: { tokenSource: "none", apiKeySource: "none" } }),
      async () => USAGE,
    )
    const report = await Effect.runPromise(runQuota(input(fake.query)))
    expect(report).toMatchObject({ windows: [], problem: "Claude is not signed in." })
    expect(fake.calls[0]!.asked).toEqual([])
    expect(fake.calls[0]!.closed).toBe(true)
  })

  test("an SDK without the request, a failing request and a failing start all become a problem", async () => {
    const old = await Effect.runPromise(runQuota(input(usageQuery(async () => INIT).query)))
    expect(old).toMatchObject({ windows: [], problem: "This Claude Code version does not report plan limits." })

    const failing = usageQuery(
      async () => INIT,
      async () => {
        throw new Error("usage request failed\nat somewhere")
      },
    )
    const failed = await Effect.runPromise(runQuota(input(failing.query)))
    expect(failed.windows).toEqual([])
    expect(failed.problem).toBe("Claude could not report this account's plan limits: usage request failed")
    expect(failing.calls[0]!.closed).toBe(true)

    const dead = await Effect.runPromise(
      runQuota(
        input(
          usageQuery(async () => {
            throw new Error("spawn claude ENOENT")
          }).query,
        ),
      ),
    )
    expect(dead.problem).toContain("ENOENT")
  })
})

/**
 * An account's plan limits (session and weekly windows), read the way Claude Code's own `/usage`
 * reads them: the SDK's `get_usage` control request on an idle `query()` (no prompt, no model call).
 * The CLI asks claude.ai with the login of its config dir; OpenBot never sees a credential.
 *
 * The SDK marks the request experimental (its method name says so), so the answer is parsed as
 * `unknown`: fields this file does not know are ignored and a missing method or a failed request
 * becomes a `problem`, never an error.
 */
import type { HarnessQuotaReport, HarnessQuotaWindow } from "@openbot/contracts"
import { Clock, Effect } from "effect"
import { type IdleQueryInput, parseInitialization, withIdleQuery } from "./probe.ts"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export interface ParsedUsage {
  readonly windows: ReadonlyArray<HarnessQuotaWindow>
  readonly extraUsage: boolean | undefined
  readonly problem: string | undefined
}

const window = (
  kind: HarnessQuotaWindow["kind"],
  raw: unknown,
  model?: string | undefined,
): ReadonlyArray<HarnessQuotaWindow> => {
  if (!isRecord(raw) || typeof raw.utilization !== "number" || !Number.isFinite(raw.utilization)) return []
  const resetsAt = typeof raw.resets_at === "string" ? Date.parse(raw.resets_at) : Number.NaN
  return [
    {
      kind,
      ...(model !== undefined ? { model } : {}),
      usedPercent: Math.max(0, raw.utilization),
      ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
    },
  ]
}

/** Parses `SDKControlGetUsageResponse` (only its plan rate limits). */
export const parseUsage = (usage: unknown): ParsedUsage => {
  const u = isRecord(usage) ? usage : {}
  const limits = u.rate_limits
  if (!isRecord(limits)) {
    return {
      windows: [],
      extraUsage: undefined,
      problem:
        u.rate_limits_available === false
          ? "This login has no plan limits (API key or cloud provider)."
          : "Claude did not report plan limits.",
    }
  }
  const scoped = Array.isArray(limits.model_scoped) ? limits.model_scoped : []
  const models = [
    ...scoped.flatMap((entry) =>
      isRecord(entry) && typeof entry.display_name === "string" && entry.display_name.trim() !== ""
        ? window("week-model", entry, entry.display_name.trim())
        : [],
    ),
    ...window("week-model", limits.seven_day_opus, "Opus"),
    ...window("week-model", limits.seven_day_sonnet, "Sonnet"),
  ]
  const seen = new Set<string>()
  const windows = [
    ...window("session", limits.five_hour),
    ...window("week", limits.seven_day),
    // `model_scoped` first: the server's own rows win over the older per-model fields
    ...models.filter((w) => {
      const key = (w.model ?? "").toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
  ]
  const extra = limits.extra_usage
  return {
    windows,
    extraUsage: isRecord(extra) && typeof extra.is_enabled === "boolean" ? extra.is_enabled : undefined,
    problem: windows.length === 0 ? "Claude reported no plan limits for this account." : undefined,
  }
}

const describeQuotaError = (cause: unknown): string => {
  const message = (cause instanceof Error ? cause.message : String(cause)).split("\n")[0] ?? ""
  return `Claude could not report this account's plan limits: ${message}`
}

/** Never fails; never calls the model. */
export const runQuota = (input: IdleQueryInput): Effect.Effect<HarnessQuotaReport> =>
  Effect.gen(function* () {
    type Read =
      | { readonly signedOut: true }
      | { readonly unsupported: true }
      | { readonly usage: unknown; readonly init: unknown }
    const outcome = yield* withIdleQuery<Read>(input, async (handle, init) => {
      if (parseInitialization(init).auth.state === "signed-out") return { signedOut: true }
      const read = handle.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
      if (read === undefined) return { unsupported: true }
      // skipBehaviors: only the plan limits, without the scan of the last week's local transcripts
      return { usage: await read.call(handle, { skipBehaviors: true }), init }
    })
    const checkedAt = yield* Clock.currentTimeMillis
    if ("error" in outcome) return { windows: [], problem: describeQuotaError(outcome.error), checkedAt }
    const read = outcome.value
    if ("signedOut" in read) return { windows: [], problem: "Claude is not signed in.", checkedAt }
    if ("unsupported" in read)
      return { windows: [], problem: "This Claude Code version does not report plan limits.", checkedAt }
    const parsed = parseUsage(read.usage)
    const account = parseInitialization(read.init).account
    return {
      windows: parsed.windows,
      ...(account !== undefined ? { account } : {}),
      ...(parsed.extraUsage !== undefined ? { extraUsage: parsed.extraUsage } : {}),
      ...(parsed.problem !== undefined ? { problem: parsed.problem } : {}),
      checkedAt,
    }
  })

// Settings › Usage, "Plan limits": per harness account, how much of its session and weekly limits is
// used and when each resets (`harnesses.quota`: what the account's own harness reports), with the
// Bots that run on the account and a warning naming the Bots a used-up or nearly used-up limit stops.
import { botsAtom, harnessQuotaAtom } from "@openbot/client"
import type { Bot, BotId, HarnessQuota, HarnessQuotaWindow, QuotaWarning } from "@openbot/contracts"
import { DEFAULT_HARNESS_PROFILE_ID, describeAccount, quotaLevel, quotaWarnings } from "@openbot/contracts"
import { Avatar, PillButton, StatusPill, type StatusTone, cn } from "@openbot/ui"
import { RefreshCw } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import {
  ErrorLine,
  HarnessTile,
  LoadingLine,
  formatAgo,
  formatWhen,
  harnessName,
  useCommand,
  useQuery,
  useRosterValue,
} from "../details/kit.tsx"
import { GroupLabel, RowDivider, SettingsCard } from "./layout.tsx"

type Level = ReturnType<typeof quotaLevel>

const LEVEL_TONE: Record<Level, StatusTone> = { ok: "success", near: "warn", out: "danger" }
const LEVEL_BAR: Record<Level, string> = { ok: "bg-accent", near: "bg-warn", out: "bg-danger" }
const LEVEL_TEXT: Record<Level, string> = { ok: "text-fg-secondary", near: "text-warn-fg", out: "text-danger-fg" }

/** "Session", "Week", "Week · Opus". */
export const windowLabel = (window: Pick<HarnessQuotaWindow, "kind" | "model">): string =>
  window.kind === "session" ? "Session" : window.kind === "week" ? "Week" : `Week · ${window.model ?? "one model"}`

/** "today at 3:20 PM", "Nov 27 at 6:00 PM" (mid-sentence form of `formatWhen`). */
const when = (ms: number, now: number): string =>
  formatWhen(ms, now).replace(/^(Today|Tomorrow|Yesterday)/, (day) => day.toLowerCase())

/** "Ada", "Ada and Bo", "Ada, Bo and Cy". */
const names = (list: ReadonlyArray<string>): string =>
  list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`

/** "Session limit reached: Ada and Bo are stopped until today at 3:20 PM." */
export const warningText = (
  warning: QuotaWarning,
  botName: (id: BotId) => string,
  now: number,
  extraUsage = false,
): string => {
  const { window, level } = warning
  const limit =
    window.kind === "session"
      ? "Session limit"
      : window.kind === "week"
        ? "Weekly limit"
        : `Weekly ${window.model ?? "model"} limit`
  const who = names(warning.botIds.map(botName))
  const many = warning.botIds.length > 1
  const reset = window.resetsAt === undefined ? undefined : when(window.resetsAt, now)
  if (level === "out") {
    const head = `${limit} reached`
    if (extraUsage)
      return `${head}: ${who === "" ? "the account" : who} ${many ? "continue" : "continues"} on paid extra usage${reset ? ` until it resets ${reset}` : ""}.`
    if (who === "") return `${head}${reset ? `, resets ${reset}` : ""}.`
    return `${head}: ${who} ${many ? "are" : "is"} stopped${reset ? ` until ${reset}` : ""}.`
  }
  const head = `${limit} at ${Math.round(window.usedPercent)}%`
  if (who === "") return `${head}${reset ? `, resets ${reset}` : ""}.`
  return `${head}: ${who} will stop when it runs out${reset ? ` (resets ${reset})` : ""}.`
}

/** The account as the page names it: "leka@example.com (team)", else its label. */
const accountTitle = (quota: HarnessQuota): string =>
  describeAccount(quota.account) ??
  (quota.profileId === DEFAULT_HARNESS_PROFILE_ID || quota.profileLabel === "Default"
    ? "Default account"
    : quota.profileLabel)

/** The owner-given label when it adds something to the account's name. */
const accountNick = (quota: HarnessQuota): string | undefined => {
  const title = accountTitle(quota)
  const label = quota.profileLabel
  if (quota.profileId === DEFAULT_HARNESS_PROFILE_ID || label === "Default" || label === title) return undefined
  return quota.account?.email !== undefined && label.includes(quota.account.email) ? undefined : label
}

function WindowRow({ window, now }: { readonly window: HarnessQuotaWindow; readonly now: number }): ReactNode {
  const level = quotaLevel(window, now)
  const reset = window.resetsAt !== undefined && window.resetsAt <= now
  const percent = reset ? 0 : Math.round(window.usedPercent)
  return (
    <div
      className="grid grid-cols-[110px_minmax(0,1fr)_44px_170px] items-center gap-3 px-4 py-1.5 text-sm max-sm:grid-cols-[minmax(0,1fr)_44px] max-sm:gap-x-2 max-sm:gap-y-1"
      data-testid="quota-window"
      data-level={level}
    >
      <span className="truncate text-fg">{windowLabel(window)}</span>
      <span
        role="progressbar"
        aria-label={`${windowLabel(window)} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, percent)}
        className="h-1.5 overflow-hidden rounded-full bg-secondary max-sm:order-3 max-sm:col-span-2"
      >
        <span
          className={cn("block h-full rounded-full", LEVEL_BAR[level])}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </span>
      <span className={cn("text-end tabular-nums", LEVEL_TEXT[level])}>{percent}%</span>
      <span className="truncate text-end text-xs text-fg-tertiary max-sm:order-4 max-sm:col-span-2 max-sm:text-start">
        {window.resetsAt === undefined ? "" : reset ? "Has reset" : `Resets ${when(window.resetsAt, now)}`}
      </span>
    </div>
  )
}

function AccountCard({
  quota,
  bots,
  now,
}: {
  readonly quota: HarnessQuota
  readonly bots: ReadonlyArray<Bot>
  readonly now: number
}): ReactNode {
  const byId = new Map(bots.map((b) => [b.id, b] as const))
  const botName = (id: BotId) => byId.get(id)?.name ?? "A Bot"
  const warnings = quotaWarnings(quota, (id) => byId.get(id)?.harness.model, now)
  const level: Level = warnings.some((w) => w.level === "out") ? "out" : warnings.length > 0 ? "near" : "ok"
  const mine = quota.botIds.flatMap((id) => byId.get(id) ?? [])
  const nick = accountNick(quota)
  return (
    <SettingsCard testId="quota-account">
      <div className="flex min-h-11 items-center gap-3 px-4 py-2">
        <HarnessTile kind={quota.kind} size={24} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-base text-fg">
            {harnessName(quota.kind)} · {accountTitle(quota)}
          </span>
          {nick && <span className="truncate text-xs text-fg-tertiary">{nick}</span>}
        </span>
        {quota.windows.length > 0 && (
          <StatusPill tone={LEVEL_TONE[level]} dot={level === "ok"} className="h-[22px] shrink-0 text-xs">
            {level === "out" ? "Limit reached" : level === "near" ? "Near limit" : "Within limits"}
          </StatusPill>
        )}
      </div>
      {quota.windows.length > 0 ? (
        quota.windows.map((w) => <WindowRow key={`${w.kind}/${w.model ?? ""}`} window={w} now={now} />)
      ) : (
        <p className="px-4 pb-2 text-sm text-fg-tertiary">{quota.problem ?? "No plan limits reported."}</p>
      )}
      {(warnings.length > 0 || quota.limitHits.length > 0) && (
        <div className="flex flex-col gap-1 px-4 pt-1.5 pb-2 text-sm" data-testid="quota-warnings">
          {warnings.map((w) => (
            <p
              key={`${w.window.kind}/${w.window.model ?? ""}`}
              role={w.level === "out" ? "alert" : undefined}
              className={LEVEL_TEXT[w.level]}
            >
              {warningText(w, botName, now, quota.extraUsage === true)}
            </p>
          ))}
          {quota.limitHits.map((hit) => (
            <p key={hit.botId} className="text-fg-secondary">
              {botName(hit.botId)}'s last turn stopped on a limit {formatAgo(hit.at, now)}: “{hit.message}”
            </p>
          ))}
        </div>
      )}
      <RowDivider />
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm text-fg-secondary">
        {mine.length === 0 ? (
          <span className="text-fg-tertiary">No Bots on this account.</span>
        ) : (
          mine.map((b) => (
            <span key={b.id} className="flex min-w-0 items-center gap-1.5" data-testid="quota-bot">
              <Avatar shape={b.avatar.shape} color={b.avatar.color} size={16} />
              <span className="truncate">{b.name}</span>
            </span>
          ))
        )}
        {quota.otherProfileBots > 0 && (
          <span className="text-fg-tertiary">
            + {quota.otherProfileBots} in {quota.otherProfileBots === 1 ? "another profile" : "other profiles"}
          </span>
        )}
      </div>
    </SettingsCard>
  )
}

export function PlanLimits(): ReactNode {
  const quotas = useQuery(harnessQuotaAtom)
  const recheck = useCommand("harnesses.quota")
  const bots = useRosterValue<ReadonlyArray<Bot>>(botsAtom, [])
  // re-read the clock so a window that resets while the page is open stops warning
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  // an account nobody uses and that reports nothing (Demo, a harness that is not installed) says nothing
  const shown = (quotas.value ?? []).filter(
    (q) => q.windows.length > 0 || q.botIds.length > 0 || q.otherProfileBots > 0,
  )
  const checkedAt = shown.reduce<number | undefined>(
    (oldest, q) => (q.windows.length === 0 ? oldest : Math.min(oldest ?? q.checkedAt, q.checkedAt)),
    undefined,
  )
  return (
    <>
      <GroupLabel
        trailing={
          <>
            {checkedAt !== undefined && (
              <span className="text-xs text-fg-tertiary max-sm:hidden">Checked {formatAgo(checkedAt, now)}</span>
            )}
            <PillButton
              size="xs"
              variant="secondary"
              leadingIcon={RefreshCw}
              loading={recheck.pending || (quotas.waiting && !quotas.loading)}
              onClick={() => void recheck.run({ refresh: true })}
            >
              Check again
            </PillButton>
          </>
        }
      >
        Plan limits
      </GroupLabel>
      {quotas.loading ? (
        <LoadingLine>Asking each account…</LoadingLine>
      ) : quotas.error && !quotas.value ? (
        <ErrorLine onRetry={quotas.refresh}>Couldn't read the plan limits: {quotas.error}</ErrorLine>
      ) : shown.length === 0 ? (
        <SettingsCard>
          <p className="px-4 py-4 text-center text-sm text-fg-secondary">No account reports plan limits.</p>
        </SettingsCard>
      ) : (
        <div className="flex flex-col gap-3" data-testid="plan-limits">
          {shown.map((q) => (
            <AccountCard key={`${q.kind}/${q.profileId}`} quota={q} bots={bots} now={now} />
          ))}
        </div>
      )}
      {recheck.error && <ErrorLine>{recheck.error}</ErrorLine>}
    </>
  )
}

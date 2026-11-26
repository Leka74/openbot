// Settings › Usage (grok-bot-ui-activity.md F.10.5, OpenBot version): tokens, turns and estimated
// cost per Bot over a period (usage.byBot), sorted by spend; the harness column names the account a
// Bot bills when it is not the harness's default one. Above the table: each account's plan limits
// (PlanLimits.tsx).
import { botsAtom, harnessProfilesAtom, sessionInfoAtom, usageAtom } from "@openbot/client"
import type { Bot } from "@openbot/contracts"
import { normalizeProfileId } from "@openbot/contracts"
import { Avatar, Icon, SegmentedTabs, cn } from "@openbot/ui"
import { type ReactNode, useState } from "react"
import {
  ErrorLine,
  LoadingLine,
  formatTokens,
  formatUsd,
  harnessGlyph,
  harnessName,
  useQuery,
  useRosterValue,
} from "../details/kit.tsx"
import { GroupLabel, PageHeader, SettingsCard } from "./layout.tsx"
import { PlanLimits } from "./PlanLimits.tsx"
import { UpdatesCard } from "./Updates.tsx"

type Period = "7d" | "30d" | "all"

/** Table columns: Bot · Harness · Turns · Tokens · Cost; on phones the harness goes under the Bot's name. */
const COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_130px_70px_90px_80px] items-center gap-3 max-sm:grid-cols-[minmax(0,1fr)_40px_52px_60px] max-sm:gap-2"
const DAY = 86_400_000

/** Start of the period, rounded down to the hour so the query family key stays stable. 0 = all time. */
const periodStart = (period: Period, now: number): number =>
  period === "all" ? 0 : Math.floor((now - (period === "7d" ? 7 : 30) * DAY) / 3_600_000) * 3_600_000

export function UsagePage(): ReactNode {
  const [period, setPeriodState] = useState<Period>("7d")
  const [since, setSince] = useState(() => periodStart("7d", Date.now()))
  const setPeriod = (p: Period) => {
    setPeriodState(p)
    setSince(periodStart(p, Date.now()))
  }
  const usage = useQuery(usageAtom(since))
  const bots = useRosterValue<ReadonlyArray<Bot>>(botsAtom, [])
  // which account (harness profile) each bot bills; profiles are cheap (no probe)
  const profiles = useQuery(harnessProfilesAtom)
  const harnessWithAccount = (bot: Bot): string => {
    const profileId = normalizeProfileId(bot.harness.profileId)
    const profile = profileId === undefined ? undefined : profiles.value?.find((p) => p.id === profileId)
    return profileId === undefined
      ? harnessName(bot.harness.kind)
      : `${harnessName(bot.harness.kind)} · ${profile?.label ?? "removed account"}`
  }
  const rows = [...(usage.value ?? [])]
    .map((u) => ({ ...u, bot: bots.find((b) => b.id === u.botId), tokens: u.usage.inputTokens + u.usage.outputTokens }))
    .sort((a, b) => (b.usage.costUsd ?? 0) - (a.usage.costUsd ?? 0) || b.tokens - a.tokens)
  const total = rows.reduce(
    (acc, r) => ({
      tokens: acc.tokens + r.tokens,
      cost: acc.cost + (r.usage.costUsd ?? 0),
      turns: acc.turns + r.turnCount,
    }),
    { tokens: 0, cost: 0, turns: 0 },
  )

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Usage"
        actions={
          <SegmentedTabs<Period>
            variant="track"
            size="sm"
            label="Period"
            value={period}
            onValueChange={setPeriod}
            tabs={[
              { value: "7d", label: "7 days" },
              { value: "30d", label: "30 days" },
              { value: "all", label: "All time" },
            ]}
          />
        }
      />
      <div className="mt-6 grid grid-cols-3 gap-3 max-sm:gap-2">
        {[
          ["Estimated cost", formatUsd(total.cost), "Est. cost"],
          ["Tokens", formatTokens(total.tokens)],
          ["Turns", String(total.turns)],
        ].map(([label, value, short]) => (
          <div
            key={label}
            className="flex min-w-0 flex-col gap-1 rounded-3xl bg-elevated px-4 py-3 hairline border-line-tertiary max-sm:px-3"
          >
            <span className="truncate text-sm text-fg-secondary">
              {short === undefined ? (
                label
              ) : (
                <>
                  <span className="max-sm:hidden">{label}</span>
                  <span className="sm:hidden">{short}</span>
                </>
              )}
            </span>
            <span className="truncate text-2xl text-fg tabular-nums max-sm:text-xl">{value}</span>
          </div>
        ))}
      </div>
      <PlanLimits />
      <GroupLabel>Bots</GroupLabel>
      <SettingsCard testId="usage-table">
        <div className={cn(COLUMNS, "border-b-[0.5px] border-line-tertiary px-4 py-2 text-xs text-fg-secondary")}>
          <span>Bot</span>
          <span className="max-sm:hidden">Harness</span>
          <span className="text-end">Turns</span>
          <span className="text-end">Tokens</span>
          <span className="text-end">Cost</span>
        </div>
        {usage.loading ? (
          <LoadingLine />
        ) : usage.error && !usage.value ? (
          <ErrorLine onRetry={usage.refresh}>{usage.error}</ErrorLine>
        ) : rows.length === 0 ? (
          <p className="px-4 py-5 text-center text-sm text-fg-secondary">No usage in this period.</p>
        ) : (
          rows.map((r) => (
            <div key={r.botId} className={cn(COLUMNS, "min-h-11 px-4 py-1.5 text-sm")} data-testid="usage-row">
              <span className="flex min-w-0 items-center gap-2 text-fg">
                {r.bot ? (
                  <Avatar shape={r.bot.avatar.shape} color={r.bot.avatar.color} size={20} />
                ) : (
                  <Avatar ghost size={20} />
                )}
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{r.bot?.name ?? "Deleted Bot"}</span>
                  {r.bot && (
                    <span className="truncate text-xs text-fg-tertiary sm:hidden">{harnessWithAccount(r.bot)}</span>
                  )}
                </span>
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-fg-secondary max-sm:hidden">
                {r.bot && <Icon icon={harnessGlyph(r.bot.harness.kind)} size="xs" />}
                <span className="truncate" title={r.bot ? harnessWithAccount(r.bot) : undefined}>
                  {r.bot ? harnessWithAccount(r.bot) : "—"}
                </span>
              </span>
              <span className="text-end text-fg-secondary tabular-nums">{r.turnCount}</span>
              <span
                className="text-end text-fg-secondary tabular-nums"
                title={`${r.usage.inputTokens} in · ${r.usage.outputTokens} out`}
              >
                {formatTokens(r.tokens)}
              </span>
              <span className="text-end text-fg tabular-nums">
                {r.usage.costUsd !== undefined ? formatUsd(r.usage.costUsd) : "—"}
              </span>
            </div>
          ))
        )}
      </SettingsCard>
      <p className="mt-3 px-1 text-2xs text-fg-quaternary">
        Costs for subscription logins are estimates at API prices. Your provider bills you, not OpenBot.
      </p>
    </div>
  )
}

export function AboutPage(): ReactNode {
  const info = useQuery(sessionInfoAtom)
  return (
    <div className="flex flex-col">
      <PageHeader title="About" />
      <GroupLabel>Updates</GroupLabel>
      <UpdatesCard />
      <GroupLabel>OpenBot</GroupLabel>
      <SettingsCard>
        {info.loading ? (
          <LoadingLine />
        ) : (
          [
            ["Owner", info.value?.ownerName ?? "—"],
            ["Data folder", info.value?.dataDir ?? "—"],
          ].map(([k, v]) => (
            <div key={k} className="flex min-h-11 items-center gap-4 px-4 py-2">
              <span className="w-32 shrink-0 text-base text-fg">{k}</span>
              <span className="min-w-0 flex-1 truncate text-end font-mono text-xs text-fg-secondary select-all">
                {v}
              </span>
            </div>
          ))
        )}
      </SettingsCard>
      <p className="mt-3 px-1 text-2xs text-fg-quaternary">
        OpenBot is open source (MIT) and self-hosted. Every change that passes its checks on GitHub becomes a release;
        this page installs them.
      </p>
    </div>
  )
}

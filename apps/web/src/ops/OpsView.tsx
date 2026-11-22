// The Ops view (`#/ops`): the whole harness on one dense, dark console — who is working on what,
// what runs in the background, what waits on the owner, what it costs — in the style of an operations
// console (Blueprint dark). Live parts come from the roster replica; history from `stats.overview`;
// routines, pending requests and harness status are polled (they have no live feed).
import { harnessStatusAtom, pendingRequestsQueryAtom, routinesAtom, statsAtom } from "@openbot/client"
import type {
  Bot,
  BotActivity,
  BotId,
  ConversationId,
  HarnessStatus,
  NodeSummary,
  Notification,
  Routine,
  RuntimeRequest,
  StatsBucket,
  StatsOverview,
  Task,
} from "@openbot/contracts"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { useRoster } from "../app/data.ts"
import { formatTokens, formatUsd, harnessName, useQuery } from "../details/kit.tsx"
import { OpsMap } from "./OpsMap.tsx"

export interface OpsViewProps {
  readonly onClose: () => void
  readonly onOpenChat: (conversationId: ConversationId) => void
}

type Period = "24h" | "7d" | "30d"
const HOUR = 3_600_000
const DAY = 24 * HOUR
const PERIODS: Record<Period, { readonly bucketMs: number; readonly buckets: number; readonly label: string }> = {
  "24h": { bucketMs: HOUR, buckets: 24, label: "24H" },
  "7d": { bucketMs: 6 * HOUR, buckets: 28, label: "7D" },
  "30d": { bucketMs: DAY, buckets: 30, label: "30D" },
}
type OpsTab = "console" | "map"
const TAB_KEY = "openbot.ops.tab"
const readTab = (): OpsTab => {
  try {
    return localStorage.getItem(TAB_KEY) === "map" ? "map" : "console"
  } catch {
    return "console"
  }
}
const STATS_POLL_MS = 30_000
const LIST_POLL_MS = 15_000

type State = BotActivity["state"]
const STATE_ORDER: ReadonlyArray<State> = ["error", "waiting", "working", "thinking", "idle", "offline"]
const STATE_TONE: Record<State, Tone> = {
  error: "danger",
  waiting: "warning",
  working: "primary",
  thinking: "violet",
  idle: "none",
  offline: "muted",
}
type Tone = "primary" | "success" | "warning" | "danger" | "violet" | "none" | "muted"

// ============================================================================ helpers

const useNow = (ms: number): number => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

const usePoll = (refresh: () => void, ms: number) => {
  const ref = useRef(refresh)
  useEffect(() => {
    ref.current = refresh
  }, [refresh])
  useEffect(() => {
    const id = setInterval(() => ref.current(), ms)
    return () => clearInterval(id)
  }, [ms])
}

const pad = (n: number) => String(n).padStart(2, "0")
const clock = (ms: number, utc = false) => {
  const d = new Date(ms)
  return utc
    ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
    : `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 0:42 · 12:05 · 3h 10m · 2d 4h */
const span = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 3600) return `${Math.floor(s / 60)}:${pad(s % 60)}`
  const h = Math.floor(s / 3600)
  if (h < 48) return `${h}h ${pad(Math.floor((s % 3600) / 60))}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const pct = (part: number, whole: number) => (whole === 0 ? 0 : (part / whole) * 100)

const bucketLabel = (at: number, period: Period) => {
  const d = new Date(at)
  if (period === "24h") return `${pad(d.getHours())}:00`
  if (period === "7d") return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${pad(d.getHours())}h`
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

const triggerText = (r: Routine): string => {
  const t = r.trigger
  if (t.type === "cron") return t.schedule
  if (t.type === "interval") return `every ${t.everyMinutes}m`
  return t.type
}

// ============================================================================ primitives

function Tag({
  tone = "none",
  children,
  minimal,
}: {
  readonly tone?: Tone
  readonly children: ReactNode
  readonly minimal?: boolean
}) {
  return <span className={`ops-tag ops-tone-${tone}${minimal ? " ops-tag-minimal" : ""}`}>{children}</span>
}

function Dot({ tone, pulse }: { readonly tone: Tone; readonly pulse?: boolean }) {
  return <span className={`ops-dot ops-tone-${tone}${pulse ? " ops-pulse" : ""}`} aria-hidden />
}

function Panel({
  title,
  meta,
  className,
  children,
}: {
  readonly title: string
  readonly meta?: ReactNode
  readonly className?: string
  readonly children: ReactNode
}) {
  return (
    <section className={`ops-panel ${className ?? ""}`}>
      <header className="ops-panel-head">
        <h2>{title}</h2>
        {meta !== undefined && <div className="ops-panel-meta">{meta}</div>}
      </header>
      <div className="ops-panel-body">{children}</div>
    </section>
  )
}

function Empty({ children }: { readonly children: ReactNode }) {
  return <div className="ops-empty">{children}</div>
}

function Spark({ values, tone = "primary" }: { readonly values: ReadonlyArray<number>; readonly tone?: Tone }) {
  if (values.length < 2) return <svg className="ops-spark" aria-hidden />
  const max = Math.max(...values, 1e-9)
  const step = 100 / (values.length - 1)
  const pts = values.map((v, i) => `${(i * step).toFixed(2)},${(28 - (v / max) * 26).toFixed(2)}`).join(" ")
  return (
    <svg className={`ops-spark ops-stroke-${tone}`} viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden>
      <polyline points={`0,30 ${pts} 100,30`} className="ops-spark-fill" />
      <polyline points={pts} className="ops-spark-line" />
    </svg>
  )
}

/** A thin progress bar; `value` undefined = indeterminate (a task with no known end). */
function Progress({ value, tone = "primary" }: { readonly value?: number | undefined; readonly tone?: Tone }) {
  return (
    <div className={`ops-progress ops-tone-${tone}${value === undefined ? " ops-progress-indeterminate" : ""}`}>
      <div style={value === undefined ? undefined : { width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}

function Kpi({
  label,
  value,
  sub,
  tone,
  spark,
}: {
  readonly label: string
  readonly value: ReactNode
  readonly sub?: ReactNode
  readonly tone?: Tone
  readonly spark?: ReadonlyArray<number>
}) {
  return (
    <div className="ops-kpi">
      <div className="ops-kpi-label">{label}</div>
      <div className={`ops-kpi-value ops-text-${tone ?? "none"}`}>{value}</div>
      <div className="ops-kpi-foot">
        <span className="ops-kpi-sub">{sub}</span>
        {spark && <Spark values={spark} tone={tone === undefined || tone === "none" ? "primary" : tone} />}
      </div>
    </div>
  )
}

// ============================================================================ throughput chart

function Throughput({ stats, period }: { readonly stats: StatsOverview | undefined; readonly period: Period }) {
  const [hover, setHover] = useState<number | undefined>(undefined)
  const buckets = stats?.buckets ?? []
  if (buckets.length === 0) return <Empty>No activity recorded in this period.</Empty>
  const maxTurns = Math.max(1, ...buckets.map((b) => b.turns + b.tasks))
  const maxCost = Math.max(1e-9, ...buckets.map((b) => b.costUsd))
  const w = 100 / buckets.length
  const costLine = buckets
    .map((b, i) => `${(i * w + w / 2).toFixed(3)},${(100 - (b.costUsd / maxCost) * 92).toFixed(3)}`)
    .join(" ")
  const h: StatsBucket | undefined = hover === undefined ? undefined : buckets[hover]
  const ticks = [0, Math.floor(buckets.length / 3), Math.floor((2 * buckets.length) / 3), buckets.length - 1]
  return (
    <div className="ops-chart">
      <div className="ops-chart-axis-y">
        <span>{maxTurns}</span>
        <span>{Math.round(maxTurns / 2)}</span>
        <span>0</span>
      </div>
      <div
        className="ops-chart-plot"
        onMouseLeave={() => setHover(undefined)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setHover(
            Math.max(0, Math.min(buckets.length - 1, Math.floor(((e.clientX - r.left) / r.width) * buckets.length))),
          )
        }}
      >
        <div className="ops-chart-grid" aria-hidden>
          <i />
          <i />
          <i />
          <i />
        </div>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Turns, tasks and cost over time">
          {buckets.map((b, i) => {
            const ok = b.turns - b.turnsFailed
            const hOk = (ok / maxTurns) * 100
            const hFail = (b.turnsFailed / maxTurns) * 100
            const hTask = (b.tasks / maxTurns) * 100
            const x = i * w + w * 0.14
            const bw = w * 0.72
            return (
              <g key={b.at} className={hover === i ? "ops-bar-hover" : undefined}>
                <rect x={x} y={100 - hOk} width={bw} height={hOk} className="ops-fill-primary" />
                <rect x={x} y={100 - hOk - hFail} width={bw} height={hFail} className="ops-fill-danger" />
                <rect x={x} y={100 - hOk - hFail - hTask} width={bw} height={hTask} className="ops-fill-violet" />
              </g>
            )
          })}
          <polyline points={costLine} className="ops-cost-line" vectorEffect="non-scaling-stroke" />
          {hover !== undefined && (
            <line
              x1={hover * w + w / 2}
              x2={hover * w + w / 2}
              y1={0}
              y2={100}
              className="ops-crosshair"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {h !== undefined && hover !== undefined && (
          <div
            className={`ops-tooltip ${hover > buckets.length / 2 ? "ops-tooltip-left" : ""}`}
            style={{ left: `${hover * w + w / 2}%` }}
          >
            <div className="ops-tooltip-title">{bucketLabel(h.at, period)}</div>
            <div>
              <Dot tone="primary" /> turns <b>{h.turns}</b>
            </div>
            <div>
              <Dot tone="danger" /> failed <b>{h.turnsFailed}</b>
            </div>
            <div>
              <Dot tone="violet" /> tasks <b>{h.tasks}</b>
              {h.tasksFailed > 0 && <span className="ops-text-danger"> ({h.tasksFailed} failed)</span>}
            </div>
            <div>
              <Dot tone="warning" /> cost <b>{formatUsd(h.costUsd)}</b>
            </div>
            <div>
              <Dot tone="muted" /> tokens <b>{formatTokens(h.tokens)}</b>
            </div>
          </div>
        )}
      </div>
      <div className="ops-chart-axis-x">
        {ticks.map((i) => (
          <span key={i} style={{ left: `${(i * w + w / 2).toFixed(2)}%` }}>
            {bucketLabel(buckets[i]!.at, period)}
          </span>
        ))}
      </div>
      <div className="ops-legend">
        <span>
          <Dot tone="primary" /> Turns
        </span>
        <span>
          <Dot tone="danger" /> Failed
        </span>
        <span>
          <Dot tone="violet" /> Tasks
        </span>
        <span>
          <i className="ops-legend-line" /> Cost (own scale, peak {formatUsd(maxCost)})
        </span>
      </div>
    </div>
  )
}

// ============================================================================ the view

export function OpsView({ onClose, onOpenChat }: OpsViewProps): ReactNode {
  const roster = useRoster()
  const now = useNow(1000)
  const [period, setPeriod] = useState<Period>("24h")
  const [view, setViewState] = useState<OpsTab>(readTab)
  const setView = (tab: OpsTab) => {
    setViewState(tab)
    try {
      localStorage.setItem(TAB_KEY, tab)
    } catch {
      // private window: the tab is just not remembered
    }
  }
  const { bucketMs, buckets: bucketCount } = PERIODS[period]
  // the last bucket is the current one; the key only changes at a bucket boundary
  const since = Math.floor(now / bucketMs) * bucketMs - (bucketCount - 1) * bucketMs
  const stats = useQuery(statsAtom(`${since}:${bucketMs}`))
  const routines = useQuery(routinesAtom("*"))
  const requests = useQuery(pendingRequestsQueryAtom("*"))
  const harnesses = useQuery(harnessStatusAtom)
  usePoll(stats.refresh, STATS_POLL_MS)
  usePoll(routines.refresh, LIST_POLL_MS)
  usePoll(requests.refresh, LIST_POLL_MS)

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", on)
    return () => window.removeEventListener("keydown", on)
  }, [onClose])

  const { state } = roster
  const bots = roster.bots.filter((b) => !b.hidden)
  const activityOf = (id: BotId): BotActivity | undefined => state.activities.get(id)
  const stateOf = (id: BotId): State => activityOf(id)?.state ?? "idle"
  const sectionName = (id: Bot["sectionId"]) => (id === undefined ? "—" : (state.sections.get(id)?.name ?? "—"))
  const botName = (id: BotId | undefined) => (id === undefined ? "—" : (state.bots.get(id)?.name ?? "removed bot"))

  /** The Bot's own chat (most recent direct conversation). */
  const directChat = useMemo(() => {
    const map = new Map<BotId, { id: ConversationId; at: number }>()
    for (const c of state.conversations.values()) {
      if (c.kind !== "direct" || c.botIds.length !== 1) continue
      const botId = c.botIds[0]!
      const prev = map.get(botId)
      if (prev === undefined || c.lastActivityAt > prev.at) map.set(botId, { id: c.id, at: c.lastActivityAt })
    }
    return map
  }, [state.conversations])

  const counts = useMemo(() => {
    const c: Record<State, number> = { error: 0, waiting: 0, working: 0, thinking: 0, idle: 0, offline: 0 }
    for (const b of bots) c[stateOf(b.id)] += 1
    return c
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bots, state.activities])
  const busy = counts.working + counts.thinking + counts.waiting

  const tasks = [...state.tasks.values()]
  const running = tasks
    .filter((t) => t.status === "running")
    .sort((a, b) => (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt))
  const queued = tasks.filter((t) => t.status === "queued").sort((a, b) => a.createdAt - b.createdAt)
  const finished = tasks
    .filter((t) => t.status !== "running" && t.status !== "queued")
    .sort((a, b) => (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt))
    .slice(0, 6)
  const activeTasksOf = (id: BotId) =>
    tasks.filter((t) => t.botId === id && (t.status === "running" || t.status === "queued")).length

  const nodes: ReadonlyArray<NodeSummary> = [...state.nodes.values()]
  const nodesOnline = nodes.filter((n) => n.status === "online").length
  const pending: ReadonlyArray<RuntimeRequest> = (requests.value ?? []).filter((r) => r.status === "pending")
  const pendingLive = [...state.conversations.values()].reduce((n, c) => n + c.pendingRequestCount, 0)
  const pendingCount = Math.max(pending.length, pendingLive)

  const s = stats.value
  const totals = (s?.buckets ?? []).reduce(
    (acc, b) => ({
      turns: acc.turns + b.turns,
      failed: acc.failed + b.turnsFailed,
      tasks: acc.tasks + b.tasks,
      cost: acc.cost + b.costUsd,
      tokens: acc.tokens + b.tokens,
    }),
    { turns: 0, failed: 0, tasks: 0, cost: 0, tokens: 0 },
  )
  const failRate = pct(totals.failed, totals.turns)
  const statsByBot = new Map((s?.byBot ?? []).map((r) => [r.botId, r]))
  const maxBotCost = Math.max(1e-9, ...(s?.byBot ?? []).map((r) => r.costUsd))

  const botRows = [...bots].sort(
    (a, b) =>
      STATE_ORDER.indexOf(stateOf(a.id)) - STATE_ORDER.indexOf(stateOf(b.id)) ||
      (statsByBot.get(b.id)?.costUsd ?? 0) - (statsByBot.get(a.id)?.costUsd ?? 0) ||
      a.name.localeCompare(b.name),
  )

  const routineRows = [...(routines.value ?? [])].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity),
  )
  const routinesRunning = routineRows.filter((r) => r.lastRunStatus === "running").length

  const harnessRows: ReadonlyArray<HarnessStatus> = harnesses.value ?? []
  const events: ReadonlyArray<Notification> = [...state.notifications].sort((a, b) => b.at - a.at).slice(0, 40)
  const models = s?.byModel ?? []
  const maxModelCost = Math.max(1e-9, ...models.map((m) => m.costUsd))

  const open = (id: ConversationId | undefined) => {
    if (id !== undefined) onOpenChat(id)
  }

  return (
    <div className="ops-root" role="dialog" aria-label="Ops">
      {/* ------------------------------------------------------------ navbar */}
      <nav className="ops-navbar">
        <div className="ops-brand">
          <span className="ops-brand-mark" aria-hidden />
          <span>OPENBOT</span>
          <span className="ops-sep">/</span>
          <span className="ops-brand-sub">OPS</span>
        </div>
        <div className="ops-segmented ops-tabs" role="tablist" aria-label="View">
          {(["console", "map"] as const).map((tab) => (
            <button key={tab} role="tab" aria-selected={tab === view} onClick={() => setView(tab)}>
              {tab === "console" ? "▤ CONSOLE" : "◎ MAP"}
            </button>
          ))}
        </div>
        <div className="ops-nav-mid">
          <span className={`ops-live ${roster.loaded ? "" : "ops-live-off"}`}>
            <Dot tone={roster.loaded ? "success" : "danger"} pulse={roster.loaded} />
            {roster.loaded ? "LIVE" : "CONNECTING"}
          </span>
          <span className="ops-clock">
            {clock(now)} <small>LOCAL</small>
          </span>
          <span className="ops-clock">
            {clock(now, true)} <small>UTC</small>
          </span>
        </div>
        <div className="ops-nav-right">
          <div className="ops-segmented" role="tablist" aria-label="Period">
            {(Object.keys(PERIODS) as Period[]).map((p) => (
              <button key={p} role="tab" aria-selected={p === period} onClick={() => setPeriod(p)}>
                {PERIODS[p].label}
              </button>
            ))}
          </div>
          <button
            className="ops-button"
            onClick={() => {
              stats.refresh()
              routines.refresh()
              requests.refresh()
              harnesses.refresh()
            }}
            title="Refresh now"
          >
            ↻ <span className={stats.waiting ? "ops-text-primary" : ""}>{stats.waiting ? "SYNCING" : "REFRESH"}</span>
          </button>
          <button className="ops-button ops-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
            ✕
          </button>
        </div>
      </nav>

      {view === "map" ? (
        <OpsMap
          bots={bots}
          sections={[...state.sections.values()]}
          activityOf={activityOf}
          tasks={tasks}
          pending={pending}
          routines={routineRows}
          groups={[...state.conversations.values()].filter((c) => c.kind === "group")}
          statsByBot={statsByBot}
          chatOf={(id) => directChat.get(id)?.id}
          now={now}
          onOpenChat={onOpenChat}
        />
      ) : (
        <div className="ops-scroll">
          {/* ------------------------------------------------------------ KPIs */}
          <div className="ops-kpis">
            <Kpi
              label="Bots active"
              value={
                <>
                  {busy}
                  <small>/{bots.length}</small>
                </>
              }
              tone={busy > 0 ? "primary" : "none"}
              sub={`${counts.working} working · ${counts.thinking} thinking`}
            />
            <Kpi
              label="Needs you"
              value={pendingCount + counts.error}
              tone={pendingCount + counts.error > 0 ? "warning" : "none"}
              sub={`${pendingCount} approvals · ${counts.error} errors`}
            />
            <Kpi
              label="Background tasks"
              value={running.length}
              tone={running.length > 0 ? "violet" : "none"}
              sub={`${queued.length} queued · ${totals.tasks} in ${PERIODS[period].label}`}
              spark={s?.buckets.map((b) => b.tasks)}
            />
            <Kpi
              label={`Turns · ${PERIODS[period].label}`}
              value={totals.turns.toLocaleString()}
              sub={
                <>
                  p50 {s?.turnP50Ms === undefined ? "—" : span(s.turnP50Ms)} · p90{" "}
                  {s?.turnP90Ms === undefined ? "—" : span(s.turnP90Ms)}
                </>
              }
              spark={s?.buckets.map((b) => b.turns)}
            />
            <Kpi
              label="Failure rate"
              value={`${failRate.toFixed(1)}%`}
              tone={failRate >= 10 ? "danger" : failRate >= 3 ? "warning" : "success"}
              sub={`${totals.failed} failed turns`}
              spark={s?.buckets.map((b) => b.turnsFailed)}
            />
            <Kpi
              label={`Spend · ${PERIODS[period].label}`}
              value={formatUsd(totals.cost)}
              tone="warning"
              sub={`${formatTokens(totals.tokens)} tokens`}
              spark={s?.buckets.map((b) => b.costUsd)}
            />
            <Kpi
              label="Computers"
              value={
                <>
                  {nodesOnline}
                  <small>/{nodes.length}</small>
                </>
              }
              tone={nodes.length > 0 && nodesOnline < nodes.length ? "warning" : "success"}
              sub={`${routineRows.filter((r) => r.enabled).length} routines on · ${routinesRunning} running`}
            />
          </div>

          <div className="ops-grid">
            {/* ------------------------------------------------------------ throughput */}
            <Panel
              title="Throughput"
              className="ops-span-8"
              meta={
                <>
                  {stats.error !== undefined && <Tag tone="danger">{stats.error}</Tag>}
                  <span>
                    {PERIODS[period].label} · {bucketMs >= DAY ? "1D" : `${bucketMs / HOUR}H`} BUCKETS
                  </span>
                </>
              }
            >
              {stats.loading ? <Empty>Loading…</Empty> : <Throughput stats={s} period={period} />}
            </Panel>

            {/* ------------------------------------------------------------ fleet */}
            <Panel title="Fleet status" className="ops-span-4" meta={<span>{bots.length} BOTS</span>}>
              <div className="ops-stack">
                {STATE_ORDER.map((st) => (
                  <div
                    key={st}
                    className={`ops-fill-${STATE_TONE[st]}`}
                    style={{ flexGrow: counts[st] }}
                    title={`${st}: ${counts[st]}`}
                  />
                ))}
              </div>
              <div className="ops-fleet-legend">
                {STATE_ORDER.map((st) => (
                  <div key={st} className={counts[st] === 0 ? "ops-dim" : undefined}>
                    <Dot tone={STATE_TONE[st]} pulse={st === "working" && counts[st] > 0} />
                    <span>{st.toUpperCase()}</span>
                    <b>{counts[st]}</b>
                  </div>
                ))}
              </div>
              <div className="ops-subhead">SECTIONS</div>
              <div className="ops-sections">
                {[...state.sections.values()]
                  .sort((a, b) => a.order - b.order)
                  .map((sec) => {
                    const members = bots.filter((b) => b.sectionId === sec.id)
                    const active = members.filter((b) => stateOf(b.id) !== "idle" && stateOf(b.id) !== "offline").length
                    return (
                      <div key={sec.id} className="ops-section-row">
                        <span className="ops-ellipsis">{sec.name}</span>
                        <Progress value={pct(active, members.length)} tone={active > 0 ? "primary" : "muted"} />
                        <span className="ops-mono ops-right">
                          {active}/{members.length}
                        </span>
                      </div>
                    )
                  })}
              </div>
            </Panel>

            {/* ------------------------------------------------------------ bots */}
            <Panel title="Bots" className="ops-span-8 ops-tall" meta={<span>CLICK A ROW TO OPEN ITS CHAT</span>}>
              <div className="ops-table-wrap">
                <table className="ops-table">
                  <thead>
                    <tr>
                      <th>STATUS</th>
                      <th>BOT</th>
                      <th>SECTION</th>
                      <th>HARNESS · MODEL</th>
                      <th>CURRENT</th>
                      <th className="ops-right">FOR</th>
                      <th className="ops-right">TASKS</th>
                      <th className="ops-right">TURNS</th>
                      <th className="ops-right">FAIL</th>
                      <th className="ops-right">P50</th>
                      <th className="ops-right">SPEND</th>
                    </tr>
                  </thead>
                  <tbody>
                    {botRows.map((bot) => {
                      const act = activityOf(bot.id)
                      const st = stateOf(bot.id)
                      const row = statsByBot.get(bot.id)
                      const chat = directChat.get(bot.id)?.id ?? act?.conversationId
                      const t = activeTasksOf(bot.id)
                      return (
                        <tr
                          key={bot.id}
                          className={chat === undefined ? undefined : "ops-clickable"}
                          onClick={() => open(chat)}
                        >
                          <td>
                            <Tag tone={STATE_TONE[st]} minimal={st === "idle"}>
                              {st.toUpperCase()}
                            </Tag>
                          </td>
                          <td className="ops-strong ops-ellipsis">{bot.label ?? bot.name}</td>
                          <td className="ops-muted ops-ellipsis">{sectionName(bot.sectionId)}</td>
                          <td className="ops-mono ops-muted ops-ellipsis">
                            {harnessName(bot.harness.kind)}
                            {bot.harness.model ? ` · ${bot.harness.model}` : ""}
                          </td>
                          <td className="ops-ellipsis ops-current">
                            {st === "idle" ? <span className="ops-dim">—</span> : (act?.label ?? st)}
                          </td>
                          <td className="ops-mono ops-right">{act && st !== "idle" ? span(now - act.since) : ""}</td>
                          <td className="ops-mono ops-right">
                            {t > 0 ? <span className="ops-text-violet">{t}</span> : <span className="ops-dim">0</span>}
                          </td>
                          <td className="ops-mono ops-right">{row?.turns ?? 0}</td>
                          <td
                            className={`ops-mono ops-right ${row && row.turnsFailed > 0 ? "ops-text-danger" : "ops-dim"}`}
                          >
                            {row?.turnsFailed ?? 0}
                          </td>
                          <td className="ops-mono ops-right ops-muted">
                            {row?.turnP50Ms === undefined ? "—" : span(row.turnP50Ms)}
                          </td>
                          <td className="ops-mono ops-right ops-spend">
                            <span
                              className="ops-spend-bar"
                              style={{ width: `${pct(row?.costUsd ?? 0, maxBotCost)}%` }}
                            />
                            <span>{formatUsd(row?.costUsd ?? 0)}</span>
                          </td>
                        </tr>
                      )
                    })}
                    {botRows.length === 0 && (
                      <tr>
                        <td colSpan={11}>
                          <Empty>{roster.loaded ? "No bots yet." : "Connecting to the brain…"}</Empty>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>

            {/* ------------------------------------------------------------ tasks */}
            <Panel
              title="Task pipeline"
              className="ops-span-4 ops-tall"
              meta={
                <>
                  <Tag tone="violet">{running.length} RUNNING</Tag>
                  <Tag tone="none">{queued.length} QUEUED</Tag>
                </>
              }
            >
              <div className="ops-list">
                {[...running, ...queued].map((t) => (
                  <TaskRow key={t.id} task={t} now={now} bot={botName(t.botId)} onOpen={() => open(t.conversationId)} />
                ))}
                {running.length + queued.length === 0 && <Empty>Nothing running in the background.</Empty>}
                {finished.length > 0 && <div className="ops-subhead">RECENTLY FINISHED</div>}
                {finished.map((t) => (
                  <TaskRow key={t.id} task={t} now={now} bot={botName(t.botId)} onOpen={() => open(t.conversationId)} />
                ))}
              </div>
            </Panel>

            {/* ------------------------------------------------------------ approvals */}
            <Panel
              title="Waiting on you"
              className="ops-span-4"
              meta={
                pendingCount > 0 ? <Tag tone="warning">{pendingCount} PENDING</Tag> : <Tag tone="success">CLEAR</Tag>
              }
            >
              <div className="ops-list">
                {pending.map((r) => (
                  <button key={r.id} className="ops-item" onClick={() => open(r.conversationId)}>
                    <div className="ops-item-top">
                      <Tag tone={r.blocking ? "warning" : "none"}>{r.kind.replace("-", " ").toUpperCase()}</Tag>
                      <span className="ops-muted ops-ellipsis">{botName(r.botId)}</span>
                      <span className="ops-mono ops-dim ops-push">{span(now - r.createdAt)} ago</span>
                    </div>
                    <div className="ops-item-title ops-ellipsis">{r.title}</div>
                    {r.expiresAt !== undefined && (
                      <Progress value={pct(now - r.createdAt, r.expiresAt - r.createdAt)} tone="warning" />
                    )}
                  </button>
                ))}
                {pending.length === 0 && <Empty>No approvals or questions waiting.</Empty>}
              </div>
            </Panel>

            {/* ------------------------------------------------------------ routines */}
            <Panel
              title="Routines"
              className="ops-span-4"
              meta={<span>{routineRows.filter((r) => r.enabled).length} ENABLED</span>}
            >
              <div className="ops-list">
                {routineRows.slice(0, 12).map((r) => {
                  const prog =
                    r.enabled && r.lastRunAt !== undefined && r.nextRunAt !== undefined && r.nextRunAt > r.lastRunAt
                      ? pct(now - r.lastRunAt, r.nextRunAt - r.lastRunAt)
                      : undefined
                  const tone: Tone =
                    r.lastRunStatus === "failed"
                      ? "danger"
                      : r.lastRunStatus === "running"
                        ? "primary"
                        : r.lastRunStatus === "succeeded"
                          ? "success"
                          : "none"
                  return (
                    <div key={r.id} className={`ops-routine ${r.enabled ? "" : "ops-dim"}`}>
                      <div className="ops-item-top">
                        <Dot tone={tone} pulse={r.lastRunStatus === "running"} />
                        <span className="ops-strong ops-ellipsis">{r.name}</span>
                        <span className="ops-mono ops-dim ops-push">
                          {!r.enabled
                            ? "OFF"
                            : r.lastRunStatus === "running"
                              ? "RUNNING"
                              : r.nextRunAt !== undefined
                                ? `in ${span(r.nextRunAt - now)}`
                                : "—"}
                        </span>
                      </div>
                      <div className="ops-item-sub">
                        <span className="ops-ellipsis">{botName(r.botId)}</span>
                        <span className="ops-mono">{triggerText(r)}</span>
                      </div>
                      {prog !== undefined && <Progress value={prog} tone={tone === "none" ? "muted" : tone} />}
                    </div>
                  )
                })}
                {routineRows.length === 0 && <Empty>{routines.loading ? "Loading…" : "No routines."}</Empty>}
              </div>
            </Panel>

            {/* ------------------------------------------------------------ infrastructure */}
            <Panel title="Infrastructure" className="ops-span-4">
              <div className="ops-subhead ops-subhead-first">COMPUTERS</div>
              {nodes.map((n) => (
                <div key={n.id} className="ops-kv">
                  <Dot tone={n.status === "online" ? "success" : n.status === "degraded" ? "warning" : "danger"} />
                  <span className="ops-strong ops-ellipsis">{n.label}</span>
                  <span className="ops-muted ops-ellipsis">{n.platform}</span>
                  <span className="ops-mono ops-dim ops-push">{n.version ?? ""}</span>
                </div>
              ))}
              {nodes.length === 0 && <Empty>No computers.</Empty>}
              <div className="ops-subhead">HARNESSES</div>
              {harnessRows.map((h) => {
                const ok = h.installed && h.auth.state === "signed-in" && h.problems.length === 0
                return (
                  <div key={`${h.kind}:${h.profileId ?? ""}`} className="ops-kv" title={h.problems.join("\n")}>
                    <Dot
                      tone={
                        !h.installed ? "muted" : ok ? "success" : h.auth.state === "signed-out" ? "danger" : "warning"
                      }
                    />
                    <span className="ops-strong ops-ellipsis">
                      {harnessName(h.kind, h)}
                      {h.profileLabel ? ` · ${h.profileLabel}` : ""}
                    </span>
                    <span className="ops-muted ops-ellipsis">
                      {!h.installed
                        ? "not installed"
                        : h.auth.state === "signed-in"
                          ? (h.account?.plan ?? "signed in")
                          : h.auth.state}
                    </span>
                    <span className="ops-mono ops-dim ops-push">
                      {h.problems.length > 0 ? (
                        <span className="ops-text-warning">{h.problems.length} issue(s)</span>
                      ) : (
                        (h.version ?? "")
                      )}
                    </span>
                  </div>
                )
              })}
              {harnessRows.length === 0 && <Empty>{harnesses.loading ? "Checking…" : "No harnesses."}</Empty>}
            </Panel>

            {/* ------------------------------------------------------------ spend by model */}
            <Panel title="Spend by model" className="ops-span-4" meta={<span>{PERIODS[period].label}</span>}>
              {models.map((m) => (
                <div key={`${m.harness ?? ""}/${m.model}`} className="ops-model">
                  <div className="ops-item-top">
                    <span className="ops-mono ops-ellipsis">{m.model}</span>
                    <span className="ops-dim">{m.harness ? harnessName(m.harness) : ""}</span>
                    <span className="ops-mono ops-push">{formatUsd(m.costUsd)}</span>
                  </div>
                  <Progress value={pct(m.costUsd, maxModelCost)} tone="warning" />
                  <div className="ops-item-sub">
                    <span>{formatTokens(m.tokens)} tokens</span>
                    <span className="ops-mono">{pct(m.costUsd, totals.cost).toFixed(0)}%</span>
                  </div>
                </div>
              ))}
              {models.length === 0 && <Empty>No usage recorded in this period.</Empty>}
            </Panel>

            {/* ------------------------------------------------------------ event log */}
            <Panel title="Event log" className="ops-span-8" meta={<span>LAST {events.length}</span>}>
              <div className="ops-log">
                {events.map((e) => (
                  <button key={e.id} className="ops-log-row" onClick={() => open(e.conversationId)}>
                    <span className="ops-dim">{clock(e.at)}</span>
                    <span className={`ops-log-kind ops-text-${eventTone(e.kind)}`}>{e.kind.toUpperCase()}</span>
                    <span className="ops-muted ops-ellipsis">{botName(e.botId)}</span>
                    <span className="ops-ellipsis">
                      {e.title}
                      {e.body ? <span className="ops-dim"> — {e.body}</span> : null}
                    </span>
                  </button>
                ))}
                {events.length === 0 && <Empty>No events yet.</Empty>}
              </div>
            </Panel>
          </div>
        </div>
      )}
    </div>
  )
}

const eventTone = (kind: Notification["kind"]): Tone =>
  kind === "error"
    ? "danger"
    : kind === "waiting" || kind === "sign-in"
      ? "warning"
      : kind === "finished"
        ? "success"
        : kind === "routine"
          ? "violet"
          : "primary"

function TaskRow({
  task: t,
  now,
  bot,
  onOpen,
}: {
  readonly task: Task
  readonly now: number
  readonly bot: string
  readonly onOpen: () => void
}) {
  const tone: Tone =
    t.status === "running"
      ? t.waiting
        ? "warning"
        : "violet"
      : t.status === "queued"
        ? "none"
        : t.status === "succeeded"
          ? "success"
          : t.status === "failed"
            ? "danger"
            : "muted"
  const live = t.status === "running" || t.status === "queued"
  const elapsed = live ? now - (t.startedAt ?? t.createdAt) : (t.endedAt ?? t.updatedAt) - (t.startedAt ?? t.createdAt)
  return (
    <button className="ops-item" onClick={onOpen}>
      <div className="ops-item-top">
        <Tag tone={tone} minimal={!live}>
          {t.status === "running" && t.waiting ? "WAITING" : t.status.toUpperCase()}
        </Tag>
        <span className="ops-strong ops-ellipsis">{t.title}</span>
        <span className="ops-mono ops-dim ops-push">{span(elapsed)}</span>
      </div>
      <div className="ops-item-sub">
        <span className="ops-ellipsis">{bot}</span>
        <span className="ops-mono">
          {t.stepCount ?? 0} steps
          {t.usage?.costUsd !== undefined ? ` · ${formatUsd(t.usage.costUsd)}` : ""}
        </span>
      </div>
      {live && (
        <>
          {t.progress && <div className="ops-item-progress ops-ellipsis">{t.progress}</div>}
          {t.status === "running" && <Progress tone={tone} />}
        </>
      )}
      {t.status === "failed" && t.error && (
        <div className="ops-item-progress ops-text-danger ops-ellipsis">{t.error}</div>
      )}
    </button>
  )
}

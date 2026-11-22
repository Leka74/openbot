// The Ops view's Map: the harness as a live mind map you can walk around. The brain sits in the
// middle, sections ring it, Bots ring their sections, and each Bot's live work branches off it
// (running and queued tasks, what waits on the owner, routines). Group chats are chords between
// their Bots. Drag to pan, wheel / pinch to zoom, click to inspect, double-click to fly to a node;
// arrows pan, + / - zoom, 0 fits everything. A minimap shows where you are.
import type {
  Bot,
  BotActivity,
  BotId,
  ConversationId,
  ConversationSummary,
  Routine,
  RuntimeRequest,
  Section,
  StatsByBot,
  Task,
} from "@openbot/contracts"
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { formatUsd, harnessName } from "../details/kit.tsx"

type Tone = "primary" | "success" | "warning" | "danger" | "violet" | "none" | "muted"
type State = BotActivity["state"]

export interface OpsMapProps {
  readonly bots: ReadonlyArray<Bot>
  readonly sections: ReadonlyArray<Section>
  readonly activityOf: (id: BotId) => BotActivity | undefined
  readonly tasks: ReadonlyArray<Task>
  readonly pending: ReadonlyArray<RuntimeRequest>
  readonly routines: ReadonlyArray<Routine>
  readonly groups: ReadonlyArray<ConversationSummary>
  readonly statsByBot: ReadonlyMap<BotId, StatsByBot>
  readonly chatOf: (id: BotId) => ConversationId | undefined
  readonly now: number
  readonly onOpenChat: (id: ConversationId) => void
}

const STATE_TONE: Record<State, Tone> = {
  error: "danger",
  waiting: "warning",
  working: "primary",
  thinking: "violet",
  idle: "none",
  offline: "muted",
}
const LIVE: ReadonlySet<State> = new Set(["working", "thinking", "waiting"])
const MAX_LEAVES = 6
const RECENT_FAIL_MS = 15 * 60_000
const GROUP_HOT_MS = 3 * 60_000

// ============================================================================ graph model

type NodeKind = "root" | "section" | "bot" | "task" | "request" | "routine" | "more"
interface MapNode {
  readonly id: string
  readonly kind: NodeKind
  readonly x: number
  readonly y: number
  readonly angle: number
  readonly label: string
  readonly sub?: string | undefined
  readonly tone: Tone
  readonly live: boolean
  readonly botId?: BotId | undefined
  readonly conversationId?: ConversationId | undefined
  readonly detail: ReadonlyArray<readonly [string, string]>
}
interface MapEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly tone: Tone
  readonly live: boolean
  readonly kind: "tree" | "leaf" | "group"
}

const polar = (r: number, a: number) => ({ x: Math.cos(a) * r, y: Math.sin(a) * r })
const pad = (n: number) => String(n).padStart(2, "0")
const span = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 3600) return `${Math.floor(s / 60)}:${pad(s % 60)}`
  const h = Math.floor(s / 3600)
  return h < 48 ? `${h}h ${pad(Math.floor((s % 3600) / 60))}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?"

function buildGraph(p: OpsMapProps): { nodes: ReadonlyArray<MapNode>; edges: ReadonlyArray<MapEdge> } {
  const nodes: MapNode[] = []
  const edges: MapEdge[] = []
  const stateOf = (id: BotId): State => p.activityOf(id)?.state ?? "idle"

  // sections in order, then the Bots without one
  const buckets: Array<{ id: string; name: string; bots: Bot[] }> = [...p.sections]
    .sort((a, b) => a.order - b.order)
    .map((s) => ({ id: `sec:${s.id}`, name: s.name, bots: p.bots.filter((b) => b.sectionId === s.id) }))
    .filter((s) => s.bots.length > 0)
  const known = new Set(p.sections.map((s) => s.id))
  const loose = p.bots.filter((b) => b.sectionId === undefined || !known.has(b.sectionId))
  if (loose.length > 0) buckets.push({ id: "sec:none", name: "Unassigned", bots: loose })

  const total = Math.max(1, p.bots.length)
  const rBot = Math.max(420, (total * 150) / (2 * Math.PI))
  const rSection = rBot * 0.48
  const rLeaf = rBot + 170

  const liveBots = p.bots.filter((b) => LIVE.has(stateOf(b.id))).length
  nodes.push({
    id: "root",
    kind: "root",
    x: 0,
    y: 0,
    angle: 0,
    label: "OPENBOT",
    sub: `${liveBots} live · ${p.bots.length} bots`,
    tone: liveBots > 0 ? "primary" : "none",
    live: liveBots > 0,
    detail: [
      ["Bots", String(p.bots.length)],
      ["Live now", String(liveBots)],
      ["Tasks running", String(p.tasks.filter((t) => t.status === "running").length)],
      ["Waiting on you", String(p.pending.length)],
    ],
  })

  let cursor = -Math.PI / 2
  for (const bucket of buckets) {
    const sweep = (bucket.bots.length / total) * 2 * Math.PI
    const mid = cursor + sweep / 2
    const sp = polar(rSection, mid)
    const liveHere = bucket.bots.filter((b) => LIVE.has(stateOf(b.id))).length
    nodes.push({
      id: bucket.id,
      kind: "section",
      ...sp,
      angle: mid,
      label: bucket.name.toUpperCase(),
      sub: `${liveHere}/${bucket.bots.length} live`,
      tone: liveHere > 0 ? "primary" : "none",
      live: liveHere > 0,
      detail: [
        ["Bots", String(bucket.bots.length)],
        ["Live now", String(liveHere)],
      ],
    })
    edges.push({
      id: `e:root:${bucket.id}`,
      from: "root",
      to: bucket.id,
      tone: liveHere > 0 ? "primary" : "none",
      live: liveHere > 0,
      kind: "tree",
    })

    const bots = [...bucket.bots].sort((a, b) => a.name.localeCompare(b.name))
    bots.forEach((bot, i) => {
      const a = cursor + (sweep * (i + 0.5)) / bots.length
      const bp = polar(rBot, a)
      const act = p.activityOf(bot.id)
      const st = stateOf(bot.id)
      const live = LIVE.has(st)
      const stats = p.statsByBot.get(bot.id)
      const botNodeId = `bot:${bot.id}`
      nodes.push({
        id: botNodeId,
        kind: "bot",
        ...bp,
        angle: a,
        label: bot.label ?? bot.name,
        sub: live || st === "error" ? (act?.label ?? st) : undefined,
        tone: STATE_TONE[st],
        live,
        botId: bot.id,
        conversationId: p.chatOf(bot.id) ?? act?.conversationId,
        detail: [
          ["Status", st.toUpperCase()],
          ...(act?.label ? ([["Doing", act.label]] as const) : []),
          ...(act && st !== "idle" ? ([["For", span(p.now - act.since)]] as const) : []),
          ["Harness", `${harnessName(bot.harness.kind)}${bot.harness.model ? ` · ${bot.harness.model}` : ""}`],
          ...(stats
            ? ([
                ["Turns", `${stats.turns}${stats.turnsFailed > 0 ? ` (${stats.turnsFailed} failed)` : ""}`],
                ["Spend", formatUsd(stats.costUsd)],
              ] as const)
            : []),
        ],
      })
      edges.push({
        id: `e:${bucket.id}:${botNodeId}`,
        from: bucket.id,
        to: botNodeId,
        tone: STATE_TONE[st],
        live,
        kind: "tree",
      })

      // this Bot's live work, fanned out beyond it
      type Leaf = Omit<MapNode, "x" | "y" | "angle">
      const leaves: Leaf[] = []
      for (const t of p.tasks) {
        if (t.botId !== bot.id) continue
        const active = t.status === "running" || t.status === "queued"
        const recentFail = t.status === "failed" && p.now - (t.endedAt ?? t.updatedAt) < RECENT_FAIL_MS
        if (!active && !recentFail) continue
        leaves.push({
          id: `task:${t.id}`,
          kind: "task",
          label: t.title,
          sub:
            t.status === "running"
              ? `${t.waiting ? "waiting" : "running"} · ${span(p.now - (t.startedAt ?? t.createdAt))}`
              : t.status,
          tone: t.status === "failed" ? "danger" : t.status === "queued" ? "none" : t.waiting ? "warning" : "violet",
          live: t.status === "running",
          botId: bot.id,
          conversationId: t.conversationId,
          detail: [
            ["Task", t.title],
            ["Status", t.status.toUpperCase()],
            ["Steps", String(t.stepCount ?? 0)],
            ...(t.progress ? ([["Now", t.progress]] as const) : []),
            ...(t.error ? ([["Error", t.error]] as const) : []),
          ],
        })
      }
      for (const r of p.pending) {
        if (r.botId !== bot.id) continue
        leaves.push({
          id: `req:${r.id}`,
          kind: "request",
          label: r.title,
          sub: `${r.kind.replace("-", " ")} · ${span(p.now - r.createdAt)}`,
          tone: "warning",
          live: true,
          botId: bot.id,
          conversationId: r.conversationId,
          detail: [
            ["Waiting on you", r.title],
            ["Kind", r.kind],
            ["Asked", `${span(p.now - r.createdAt)} ago`],
          ],
        })
      }
      for (const r of p.routines) {
        if (r.botId !== bot.id || !r.enabled) continue
        const running = r.lastRunStatus === "running"
        leaves.push({
          id: `rtn:${r.id}`,
          kind: "routine",
          label: r.name,
          sub: running ? "running" : r.nextRunAt !== undefined ? `in ${span(r.nextRunAt - p.now)}` : "routine",
          tone: running ? "primary" : r.lastRunStatus === "failed" ? "danger" : "muted",
          live: running,
          botId: bot.id,
          detail: [
            ["Routine", r.name],
            ["Last run", r.lastRunStatus ?? "never"],
            ...(r.nextRunAt !== undefined ? ([["Next", `in ${span(r.nextRunAt - p.now)}`]] as const) : []),
          ],
        })
      }
      const shown = leaves.slice(0, MAX_LEAVES)
      if (leaves.length > MAX_LEAVES)
        shown.push({
          id: `more:${bot.id}`,
          kind: "more",
          label: `+${leaves.length - MAX_LEAVES} more`,
          tone: "none",
          live: false,
          botId: bot.id,
          detail: [["Not shown", String(leaves.length - MAX_LEAVES)]],
        })
      const step = Math.min(0.09, ((sweep / bots.length) * 0.8) / Math.max(1, shown.length))
      shown.forEach((leaf, j) => {
        const la = a + (j - (shown.length - 1) / 2) * step
        const lr = rLeaf + (j % 2) * 70
        nodes.push({ ...leaf, ...polar(lr, la), angle: la })
        edges.push({
          id: `e:${botNodeId}:${leaf.id}`,
          from: botNodeId,
          to: leaf.id,
          tone: leaf.tone,
          live: leaf.live,
          kind: "leaf",
        })
      })
    })
    cursor += sweep
  }

  // group chats: chords between their Bots
  const present = new Set(p.bots.map((b) => b.id))
  for (const g of p.groups) {
    const members = g.botIds.filter((id) => present.has(id))
    const hot = p.now - g.lastActivityAt < GROUP_HOT_MS
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++)
        edges.push({
          id: `g:${g.id}:${members[i]}:${members[j]}`,
          from: `bot:${members[i]}`,
          to: `bot:${members[j]}`,
          tone: hot ? "primary" : "none",
          live: hot,
          kind: "group",
        })
  }
  return { nodes, edges }
}

// ============================================================================ camera

interface Camera {
  readonly x: number
  readonly y: number
  readonly k: number
}
const MIN_K = 0.15
const MAX_K = 3
const clampK = (k: number) => Math.max(MIN_K, Math.min(MAX_K, k))

const boundsOf = (nodes: ReadonlyArray<MapNode>) => {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x)
    maxY = Math.max(maxY, n.y)
  }
  return nodes.length === 0
    ? { minX: -1, minY: -1, maxX: 1, maxY: 1 }
    : { minX: minX - 140, minY: minY - 90, maxX: maxX + 140, maxY: maxY + 90 }
}

// ============================================================================ the map

export function OpsMap(props: OpsMapProps): ReactNode {
  const { nodes, edges } = useMemo(() => buildGraph(props), [props])
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const wrap = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 1200, h: 800 })
  const [cam, setCam] = useState<Camera>({ x: 600, y: 400, k: 0.6 })
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [hovered, setHovered] = useState<string | undefined>(undefined)
  const [grabbing, setGrabbing] = useState(false)
  const userMoved = useRef(false)
  const anim = useRef<number | undefined>(undefined)

  useEffect(() => {
    const el = wrap.current
    if (el === null) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e!.contentRect.width, h: e!.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const flyTo = useCallback((target: Camera) => {
    userMoved.current = true
    if (anim.current !== undefined) cancelAnimationFrame(anim.current)
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    setCam((from) => {
      if (reduce) return target
      const start = performance.now()
      const dur = 650
      const tick = (t: number) => {
        const u = Math.min(1, (t - start) / dur)
        const e = u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2
        setCam({
          x: from.x + (target.x - from.x) * e,
          y: from.y + (target.y - from.y) * e,
          k: from.k + (target.k - from.k) * e,
        })
        if (u < 1) anim.current = requestAnimationFrame(tick)
      }
      anim.current = requestAnimationFrame(tick)
      return from
    })
  }, [])

  const fitCamera = useCallback((): Camera => {
    const b = boundsOf(nodes)
    const k = clampK(Math.min(size.w / (b.maxX - b.minX), size.h / (b.maxY - b.minY)))
    return { k, x: size.w / 2 - ((b.minX + b.maxX) / 2) * k, y: size.h / 2 - ((b.minY + b.maxY) / 2) * k }
  }, [nodes, size])

  const focusOn = useCallback(
    (id: string, k = 1.25) => {
      const n = byId.get(id)
      if (n === undefined) return
      flyTo({ k, x: size.w / 2 - n.x * k - (selected ? 150 : 0), y: size.h / 2 - n.y * k })
    },
    [byId, flyTo, size, selected],
  )

  // fit everything until the owner moves the camera (queries arrive after the roster and add nodes)
  useEffect(() => {
    if (userMoved.current || nodes.length <= 1 || size.w < 50) return
    setCam(fitCamera())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length, size])

  // wheel / trackpad: zoom around the pointer (pinch arrives as ctrl+wheel); plain two-finger scroll pans
  useEffect(() => {
    const el = wrap.current
    if (el === null) return
    const on = (e: WheelEvent) => {
      e.preventDefault()
      userMoved.current = true
      if (anim.current !== undefined) cancelAnimationFrame(anim.current)
      const r = el.getBoundingClientRect()
      const px = e.clientX - r.left
      const py = e.clientY - r.top
      const zoom = e.ctrlKey || e.deltaMode === 1 || (Math.abs(e.deltaY) > 40 && e.deltaX === 0)
      setCam((c) => {
        if (!zoom) return { ...c, x: c.x - e.deltaX, y: c.y - e.deltaY }
        const k = clampK(c.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)))
        return { k, x: px - ((px - c.x) / c.k) * k, y: py - ((py - c.y) / c.k) * k }
      })
    }
    el.addEventListener("wheel", on, { passive: false })
    return () => el.removeEventListener("wheel", on)
  }, [])

  // keyboard: arrows pan, + / - zoom, 0 fits, Esc clears the selection first
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.("input,textarea,[contenteditable]")) return
      const stepPx = e.shiftKey ? 240 : 80
      const pan = { ArrowLeft: [stepPx, 0], ArrowRight: [-stepPx, 0], ArrowUp: [0, stepPx], ArrowDown: [0, -stepPx] }[
        e.key
      ]
      if (pan) {
        e.preventDefault()
        userMoved.current = true
        setCam((c) => ({ ...c, x: c.x + pan[0]!, y: c.y + pan[1]! }))
      } else if (e.key === "+" || e.key === "=" || e.key === "-") {
        const f = e.key === "-" ? 1 / 1.25 : 1.25
        setCam((c) => {
          const k = clampK(c.k * f)
          return { k, x: size.w / 2 - ((size.w / 2 - c.x) / c.k) * k, y: size.h / 2 - ((size.h / 2 - c.y) / c.k) * k }
        })
      } else if (e.key === "0") flyTo(fitCamera())
      else if (e.key === "Escape" && selected !== undefined) {
        e.stopImmediatePropagation()
        setSelected(undefined)
      }
    }
    window.addEventListener("keydown", on, true)
    return () => window.removeEventListener("keydown", on, true)
  }, [size, flyTo, fitCamera, selected])

  // drag to pan (pointer capture, so it keeps panning outside the map)
  // the node under the press is read before capture: captured pointer events target the <svg>
  const drag = useRef<
    { x: number; y: number; cx: number; cy: number; moved: boolean; node: string | undefined } | undefined
  >(undefined)
  const lastTap = useRef<{ node: string | undefined; at: number }>({ node: undefined, at: 0 })
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    if (anim.current !== undefined) cancelAnimationFrame(anim.current)
    const node = (e.target as Element).closest?.("[data-node]")?.getAttribute("data-node") ?? undefined
    drag.current = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false, node }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (d === undefined) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) {
      d.moved = true
      userMoved.current = true
      setGrabbing(true)
    }
    if (d.moved) setCam((c) => ({ ...c, x: d.cx + dx, y: d.cy + dy }))
  }
  const onPointerUp = () => {
    const d = drag.current
    drag.current = undefined
    setGrabbing(false)
    if (d === undefined || d.moved) return
    const now = performance.now()
    const double = lastTap.current.node === d.node && now - lastTap.current.at < 350
    lastTap.current = { node: d.node, at: double ? 0 : now }
    if (!double) return setSelected(d.node)
    // double: fly to the node, or fit everything from empty space
    if (d.node !== undefined) focusOn(d.node, Math.max(cam.k * 1.6, 1.1))
    else flyTo(fitCamera())
  }

  const sel = selected === undefined ? undefined : byId.get(selected)
  // what the selection touches stays bright; the rest dims
  const near = useMemo(() => {
    const focus = selected ?? hovered
    if (focus === undefined) return undefined
    const set = new Set([focus])
    for (const e of edges) {
      if (e.from === focus) set.add(e.to)
      if (e.to === focus) set.add(e.from)
    }
    return set
  }, [selected, hovered, edges])

  const links =
    sel === undefined
      ? []
      : edges
          .filter((e) => e.from === sel.id || e.to === sel.id)
          .map((e) => byId.get(e.from === sel.id ? e.to : e.from))
          .filter((n): n is MapNode => n !== undefined && n.kind !== "section")
  const detail = cam.k >= 0.5
  const b = boundsOf(nodes)
  const mmW = 180
  const mmScale = mmW / (b.maxX - b.minX)
  const mmH = (b.maxY - b.minY) * mmScale

  return (
    <div className="ops-map" ref={wrap}>
      <svg
        className={`ops-map-svg${grabbing ? " ops-map-grabbing" : ""}`}
        width={size.w}
        height={size.h}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="application"
        aria-label="Harness map: drag to pan, scroll to zoom, click a node for details"
      >
        <defs>
          <pattern
            id="ops-map-grid"
            width={40}
            height={40}
            patternUnits="userSpaceOnUse"
            patternTransform={`translate(${cam.x} ${cam.y}) scale(${cam.k})`}
          >
            <path d="M 40 0 L 0 0 0 40" className="ops-map-gridline" />
          </pattern>
          <radialGradient id="ops-map-glow">
            <stop offset="0%" stopColor="var(--ops-primary)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--ops-primary)" stopOpacity={0} />
          </radialGradient>
        </defs>
        <rect width={size.w} height={size.h} fill="url(#ops-map-grid)" />
        <g transform={`translate(${cam.x} ${cam.y}) scale(${cam.k})`}>
          {/* orbit rings */}
          {[
            ...new Set(
              nodes
                .filter((n) => n.kind === "section" || n.kind === "bot")
                .map((n) => Math.round(Math.hypot(n.x, n.y))),
            ),
          ].map((r) => (
            <circle key={r} r={r} className="ops-map-orbit" />
          ))}
          {/* edges */}
          {edges.map((e) => {
            const a = byId.get(e.from)
            const z = byId.get(e.to)
            if (a === undefined || z === undefined) return null
            const d =
              e.kind === "group"
                ? `M ${a.x} ${a.y} Q ${(a.x + z.x) * 0.3} ${(a.y + z.y) * 0.3} ${z.x} ${z.y}`
                : `M ${a.x} ${a.y} L ${z.x} ${z.y}`
            const dim = near !== undefined && !(near.has(e.from) && near.has(e.to))
            return (
              <g
                key={e.id}
                className={`ops-map-edge ops-map-edge-${e.kind} ops-tone-${e.tone}${e.live ? " ops-map-live" : ""}${dim ? " ops-map-dim" : ""}`}
              >
                <path d={d} />
                {e.live && e.kind !== "group" && (
                  <circle r={e.kind === "leaf" ? 3 : 4} className="ops-map-particle">
                    <animateMotion dur={e.kind === "leaf" ? "1.6s" : "2.4s"} repeatCount="indefinite" path={d} />
                  </circle>
                )}
              </g>
            )
          })}
          {/* nodes */}
          {nodes.map((n) => (
            <NodeView
              key={n.id}
              node={n}
              detail={detail}
              selected={n.id === selected}
              dim={near !== undefined && !near.has(n.id)}
              onHover={setHovered}
            />
          ))}
        </g>
      </svg>

      {/* controls */}
      <div className="ops-map-controls">
        <button
          className="ops-button"
          onClick={() =>
            setCam((c) => ({
              ...c,
              k: clampK(c.k * 1.25),
              x: size.w / 2 - ((size.w / 2 - c.x) / c.k) * clampK(c.k * 1.25),
              y: size.h / 2 - ((size.h / 2 - c.y) / c.k) * clampK(c.k * 1.25),
            }))
          }
          title="Zoom in (+)"
        >
          +
        </button>
        <button
          className="ops-button"
          onClick={() =>
            setCam((c) => ({
              ...c,
              k: clampK(c.k / 1.25),
              x: size.w / 2 - ((size.w / 2 - c.x) / c.k) * clampK(c.k / 1.25),
              y: size.h / 2 - ((size.h / 2 - c.y) / c.k) * clampK(c.k / 1.25),
            }))
          }
          title="Zoom out (-)"
        >
          −
        </button>
        <button className="ops-button" onClick={() => flyTo(fitCamera())} title="Fit everything (0)">
          FIT
        </button>
        <span className="ops-map-zoom">{Math.round(cam.k * 100)}%</span>
      </div>
      <div className="ops-map-legend">
        <span>
          <i className="ops-dot ops-tone-primary" /> working
        </span>
        <span>
          <i className="ops-dot ops-tone-violet" /> thinking / task
        </span>
        <span>
          <i className="ops-dot ops-tone-warning" /> waiting on you
        </span>
        <span>
          <i className="ops-dot ops-tone-danger" /> error
        </span>
        <span>
          <i className="ops-map-legend-chord" /> group chat
        </span>
        <span className="ops-dim">drag · scroll · dbl-click · 0 fits</span>
      </div>

      {/* minimap: click to go there */}
      <svg
        className="ops-map-mini"
        width={mmW}
        height={mmH}
        onPointerDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          const wx = b.minX + (e.clientX - r.left) / mmScale
          const wy = b.minY + (e.clientY - r.top) / mmScale
          flyTo({ ...cam, x: size.w / 2 - wx * cam.k, y: size.h / 2 - wy * cam.k })
        }}
        aria-label="Minimap"
        overflow="hidden"
      >
        {edges
          .filter((e) => e.kind === "tree")
          .map((e) => {
            const a = byId.get(e.from)
            const z = byId.get(e.to)
            return a && z ? (
              <line
                key={e.id}
                x1={(a.x - b.minX) * mmScale}
                y1={(a.y - b.minY) * mmScale}
                x2={(z.x - b.minX) * mmScale}
                y2={(z.y - b.minY) * mmScale}
                className="ops-map-mini-edge"
              />
            ) : null
          })}
        {nodes.map((n) => (
          <circle
            key={n.id}
            cx={(n.x - b.minX) * mmScale}
            cy={(n.y - b.minY) * mmScale}
            r={n.kind === "root" ? 3.5 : n.kind === "bot" ? 2.4 : 1.5}
            className={`ops-map-mini-node ops-tone-${n.tone}`}
          />
        ))}
        <rect
          x={(-cam.x / cam.k - b.minX) * mmScale}
          y={(-cam.y / cam.k - b.minY) * mmScale}
          width={(size.w / cam.k) * mmScale}
          height={(size.h / cam.k) * mmScale}
          className="ops-map-mini-view"
        />
      </svg>

      {/* inspector */}
      {sel !== undefined && (
        <aside className="ops-map-inspector">
          <header>
            <span className={`ops-tag ops-tone-${sel.tone}`}>{sel.kind.toUpperCase()}</span>
            <button className="ops-button ops-close" onClick={() => setSelected(undefined)} aria-label="Close details">
              ✕
            </button>
          </header>
          <h3>{sel.label}</h3>
          {sel.sub && <p className="ops-muted">{sel.sub}</p>}
          <dl>
            {sel.detail.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <div className="ops-map-actions">
            <button className="ops-button" onClick={() => focusOn(sel.id, Math.max(cam.k, 1.25))}>
              ◎ FOCUS
            </button>
            {sel.conversationId !== undefined && (
              <button className="ops-button ops-button-primary" onClick={() => props.onOpenChat(sel.conversationId!)}>
                OPEN CHAT →
              </button>
            )}
          </div>
          {sel.kind === "bot" && links.length > 0 && (
            <>
              <div className="ops-subhead">CONNECTED</div>
              <div className="ops-map-links">
                {links.map((n) => (
                  <button key={n.id} className="ops-map-link" onClick={() => setSelected(n.id)}>
                    <i className={`ops-dot ops-tone-${n.tone}`} />
                    <span className="ops-ellipsis">{n.label}</span>
                    <span className="ops-dim">{n.kind}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </aside>
      )}
    </div>
  )
}

function NodeView({
  node: n,
  detail,
  selected,
  dim,
  onHover,
}: {
  readonly node: MapNode
  readonly detail: boolean
  readonly selected: boolean
  readonly dim: boolean
  readonly onHover: (id: string | undefined) => void
}): ReactNode {
  // labels sit on the outside of the ring
  const outward = Math.cos(n.angle) >= 0 ? "start" : "end"
  const cls = `ops-map-node ops-map-${n.kind} ops-tone-${n.tone}${n.live ? " ops-map-live" : ""}${selected ? " ops-map-selected" : ""}${dim ? " ops-map-dim" : ""}`
  const common = {
    "data-node": n.id,
    className: cls,
    transform: `translate(${n.x} ${n.y})`,
    onPointerEnter: () => onHover(n.id),
    onPointerLeave: () => onHover(undefined),
  }
  switch (n.kind) {
    case "root":
      return (
        <g {...common}>
          <circle r={130} fill="url(#ops-map-glow)" className="ops-map-halo" />
          <rect x={-26} y={-26} width={52} height={52} transform="rotate(45)" className="ops-map-root-shape" />
          <rect x={-12} y={-12} width={24} height={24} transform="rotate(45)" className="ops-map-root-core" />
          <text y={58} className="ops-map-title" textAnchor="middle">
            {n.label}
          </text>
          <text y={76} className="ops-map-sub" textAnchor="middle">
            {n.sub}
          </text>
        </g>
      )
    case "section": {
      const w = Math.max(90, n.label.length * 8.2 + 28)
      return (
        <g {...common}>
          <rect x={-w / 2} y={-15} width={w} height={30} rx={2} className="ops-map-chip" />
          <text y={4} textAnchor="middle" className="ops-map-chip-text">
            {n.label}
          </text>
          {detail && (
            <text y={32} textAnchor="middle" className="ops-map-sub">
              {n.sub}
            </text>
          )}
        </g>
      )
    }
    case "bot": {
      const dx = Math.cos(n.angle) * 40
      const dy = Math.sin(n.angle) * 40
      return (
        <g {...common}>
          {n.live && <circle r={34} className="ops-map-ripple" />}
          <circle r={26} className="ops-map-bot-ring" />
          {n.live && <circle r={31} className="ops-map-spin" />}
          <circle r={21} className="ops-map-bot-core" />
          <text y={5} textAnchor="middle" className="ops-map-initials">
            {initials(n.label)}
          </text>
          <text x={dx} y={dy + 4} textAnchor={outward} className="ops-map-title">
            {n.label}
          </text>
          {detail && n.sub && (
            <g transform={`translate(${dx} ${dy + 12})`}>
              <text y={10} textAnchor={outward} className="ops-map-activity">
                {n.sub.length > 34 ? `${n.sub.slice(0, 33)}…` : n.sub}
              </text>
            </g>
          )}
        </g>
      )
    }
    default: {
      const label = n.label.length > 30 ? `${n.label.slice(0, 29)}…` : n.label
      const glyph = n.kind === "task" ? "▣" : n.kind === "request" ? "◆" : n.kind === "routine" ? "◷" : "⋯"
      const dx = Math.cos(n.angle) * 16
      return (
        <g {...common}>
          <circle r={11} className="ops-map-leaf" />
          <text y={4} textAnchor="middle" className="ops-map-glyph">
            {glyph}
          </text>
          {detail && (
            <>
              <text x={dx} y={-1} textAnchor={outward} className="ops-map-leaf-title">
                {label}
              </text>
              {n.sub && (
                <text x={dx} y={13} textAnchor={outward} className="ops-map-sub">
                  {n.sub}
                </text>
              )}
            </>
          )}
        </g>
      )
    }
  }
}

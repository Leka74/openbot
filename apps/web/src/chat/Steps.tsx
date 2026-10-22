// "N steps ›" disclosure under a finished turn (OpenBot original on Grok's Full-conversation outline
// tokens, grok-bot-ui-activity.md F.5 / F.10.0 item 2): 22 px text button; expanded = an elevated
// sheet of 28 px outline rows (12 px icon, 12/18 medium label, tertiary preview, 10 px chevron);
// a row expands to mono 11/16.5 detail, 30 px indent, at most 12 lines then "Show more".
// Requests allowed without asking ("auto-decided" events: a rule or the bot's autonomy) are folded in
// here instead of transcript lines: a tiny "auto-allowed" badge on the tool call they gated
// (`event.toolKey` = `toolCallId`), else a row of their own. A background task's updates (D5.7
// `update_task`: changes passed on while it runs) are rows of their own too ("Update", by time).
import { Brain, ChevronDown, ChevronRight, CircleX, FilePen, FileText, Globe, LoaderCircle, MessageSquarePlus, Monitor, Plug, Search, ShieldCheck, SquareTerminal, Users, Wrench } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import { Icon, cn } from "@openbot/ui"
import type { EventEntry, MessageEntry, ReasoningEntry, ToolCallEntry } from "./grouping.ts"

type Decision = Extract<EventEntry["event"], { type: "auto-decided" }>

const decisionOf = (entry: EventEntry): Decision | undefined => (entry.event.type === "auto-decided" ? entry.event : undefined)

/** "rule", "workspace", "full auto": who allowed it. */
const allowedBy = (d: Decision): string => (d.autonomy === "full" ? "full auto" : d.autonomy === "workspace" ? "workspace" : "rule")

const allowedTitle = (d: Decision): string =>
  d.autonomy === "full" ? "Allowed without asking (Full auto)" : d.autonomy === "workspace" ? "Allowed without asking: it stays in the Bot's workspace or project folders" : "Allowed by your rules"

export function AutoBadge({ decision }: { readonly decision: Decision }): ReactNode {
  return (
    <span
      data-testid="auto-badge"
      title={allowedTitle(decision)}
      className="inline-flex h-4 shrink-0 items-center gap-0.5 rounded-full bg-secondary px-1.5 text-2xs leading-4 text-fg-tertiary"
    >
      <ShieldCheck size={9} aria-hidden />
      auto-allowed · {allowedBy(decision)}
    </span>
  )
}

const toolLabel = (t: ToolCallEntry): string => {
  switch (t.toolKind) {
    case "shell":
      return "Shell"
    case "file-read":
      return "Read"
    case "file-write":
      return "Write"
    case "file-edit":
      return "Edit"
    case "search":
      return "Search"
    case "web":
      return "Web"
    case "mcp":
      return t.mcp ? t.mcp.server : "MCP"
    case "subagent":
      return "Subagent"
    case "question":
      return "Question"
    case "browser":
      return "Browser"
    case "computer":
      return "Computer"
    default:
      return t.title ?? t.name.replace(/^mcp__[^_]+__/, "").replace(/ToolCall$/, "")
  }
}

const toolIcon = (t: ToolCallEntry) => {
  if (t.status === "pending" || t.status === "running" || t.status === "awaiting-approval") return LoaderCircle
  if (t.status === "failed" || t.status === "declined") return CircleX
  switch (t.toolKind) {
    case "shell":
      return SquareTerminal
    case "file-read":
      return FileText
    case "file-write":
    case "file-edit":
      return FilePen
    case "search":
      return Search
    case "web":
      return Globe
    case "mcp":
      return Plug
    case "subagent":
      return Users
    case "browser":
    case "computer":
      return Monitor
    default:
      return Wrench
  }
}

const firstLine = (s: string | undefined) => (s ?? "").split("\n").find((l) => l.trim().length > 0)?.trim() ?? ""

const preview = (step: ToolCallEntry | ReasoningEntry): string => {
  if (step.kind === "reasoning") return firstLine(step.text)
  return firstLine(step.inputSummary ?? step.command?.command ?? step.fileChanges?.map((f) => f.path).join(", ") ?? step.title ?? (typeof step.input === "string" ? step.input : ""))
}

const detail = (step: ToolCallEntry | ReasoningEntry): string => {
  if (step.kind === "reasoning") return step.text
  const parts: string[] = []
  if (step.command) parts.push(`$ ${step.command.command}${step.command.cwd ? `   (in ${step.command.cwd})` : ""}`)
  else if (step.inputSummary) parts.push(step.inputSummary)
  else if (step.input !== undefined && step.input !== null) {
    try {
      parts.push(JSON.stringify(step.input, null, 2))
    } catch {
      parts.push(String(step.input))
    }
  }
  if (step.fileChanges) for (const f of step.fileChanges) parts.push(`${f.kind} ${f.path}${f.diff ? `\n${f.diff}` : ""}`)
  if (step.output?.text) parts.push(step.output.text)
  if (step.error) parts.push(`Error: ${step.error}`)
  if (step.command?.exitCode !== undefined) parts.push(`exit ${step.command.exitCode}`)
  return parts.join("\n\n")
}

function DecisionRow({ entry, decision }: { readonly entry: EventEntry; readonly decision: Decision }): ReactNode {
  return (
    <div className="flex h-7 w-full items-center gap-2 rounded-lg px-2" data-decision={entry.id} data-entry={entry.id}>
      <Icon icon={ShieldCheck} size="xs" glyph={12} className="text-fg-tertiary" />
      <span className="shrink-0 text-xs leading-[18px] font-medium text-fg">{decision.toolName ?? "Request"}</span>
      <span className="min-w-0 flex-1 truncate text-xs leading-[18px] text-fg-tertiary">{decision.summary}</span>
      <AutoBadge decision={decision} />
    </div>
  )
}

function StepRow({ step, decision }: { readonly step: ToolCallEntry | ReasoningEntry; readonly decision?: Decision | undefined }): ReactNode {
  const [open, setOpen] = useState(false)
  const [more, setMore] = useState(false)
  const failed = step.kind === "tool-call" && (step.status === "failed" || step.status === "declined")
  const running = step.kind === "tool-call" && (step.status === "pending" || step.status === "running")
  const stepIcon = step.kind === "reasoning" ? Brain : toolIcon(step)
  const text = detail(step)
  const lines = text.split("\n")
  const clipped = !more && lines.length > 12
  return (
    <div className={cn("rounded-lg", open && "bg-hover")} data-entry={step.id}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-full items-center gap-2 rounded-lg px-2 text-start transition-colors duration-100 hover:bg-hover"
      >
        <Icon
          icon={stepIcon}
          size="xs"
          glyph={12}
          className={cn(step.kind === "reasoning" ? "text-accent-fg" : failed ? "text-danger-fg" : "text-fg-tertiary", running && "animate-spin")}
        />
        <span className="shrink-0 text-xs leading-[18px] font-medium text-fg">{step.kind === "reasoning" ? "Thinking" : toolLabel(step)}</span>
        <span className="min-w-0 flex-1 truncate text-xs leading-[18px] text-fg-tertiary">{preview(step)}</span>
        {decision && <AutoBadge decision={decision} />}
        {open ? <ChevronDown size={10} className="shrink-0 text-fg-quaternary" aria-hidden /> : <ChevronRight size={10} className="shrink-0 text-fg-quaternary" aria-hidden />}
      </button>
      {open && text && (
        <div className="pe-2.5 pb-2.5 ps-[30px] pt-0.5">
          <pre className="font-mono text-[11px] leading-[16.5px] break-words whitespace-pre-wrap text-fg-secondary">{clipped ? lines.slice(0, 12).join("\n") : text}</pre>
          {clipped && (
            <button type="button" className="mt-1 text-xs text-fg-tertiary hover:text-fg" onClick={() => setMore(true)}>
              Show more
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** An update passed on to running work: "Update" + its text (expands when long). */
function UpdateRow({ entry }: { readonly entry: MessageEntry }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <div className={cn("rounded-lg", open && "bg-hover")} data-testid="task-update" data-entry={entry.id}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-full items-center gap-2 rounded-lg px-2 text-start transition-colors duration-100 hover:bg-hover"
      >
        <Icon icon={MessageSquarePlus} size="xs" glyph={12} className="text-accent-fg" />
        <span className="shrink-0 text-xs leading-[18px] font-medium text-fg">Update</span>
        <span className="min-w-0 flex-1 truncate text-xs leading-[18px] text-fg-tertiary">{firstLine(entry.text)}</span>
        {open ? <ChevronDown size={10} className="shrink-0 text-fg-quaternary" aria-hidden /> : <ChevronRight size={10} className="shrink-0 text-fg-quaternary" aria-hidden />}
      </button>
      {open && (
        <div className="pe-2.5 pb-2.5 ps-[30px] pt-0.5">
          <p className="text-xs leading-[18px] break-words whitespace-pre-wrap text-fg-secondary">{entry.text}</p>
        </div>
      )}
    </div>
  )
}

type Item =
  | { readonly kind: "step"; readonly step: ToolCallEntry | ReasoningEntry; readonly decision?: Decision | undefined }
  | { readonly kind: "decision"; readonly entry: EventEntry; readonly decision: Decision }
  | { readonly kind: "update"; readonly entry: MessageEntry }

/**
 * Steps in order, each tool call with the auto-decision that gated it; unmatched decisions and
 * updates (a background task's, D5.7) slot in by time.
 */
export const stepItems = (
  steps: ReadonlyArray<ToolCallEntry | ReasoningEntry>,
  decisions: ReadonlyArray<EventEntry>,
  updates: ReadonlyArray<MessageEntry> = [],
): ReadonlyArray<Item> => {
  const byKey = new Map<string, Decision>()
  const loose: Array<{ readonly entry: EventEntry; readonly decision: Decision }> = []
  const keys = new Set(steps.flatMap((s) => (s.kind === "tool-call" ? [s.toolCallId] : [])))
  for (const entry of decisions) {
    const d = decisionOf(entry)
    if (d === undefined) continue
    if (d.toolKey !== undefined && keys.has(d.toolKey) && !byKey.has(d.toolKey)) byKey.set(d.toolKey, d)
    else loose.push({ entry, decision: d })
  }
  const items: Array<Item> = []
  let next = 0
  for (const step of steps) {
    while (next < loose.length && loose[next]!.entry.createdAt <= step.createdAt) items.push({ kind: "decision", ...loose[next++]! })
    items.push({ kind: "step", step, ...(step.kind === "tool-call" && byKey.has(step.toolCallId) ? { decision: byKey.get(step.toolCallId) } : {}) })
  }
  while (next < loose.length) items.push({ kind: "decision", ...loose[next++]! })
  if (updates.length === 0) return items
  // updates by time among the rest (stable: an update made while a step ran follows that step)
  const out: Array<Item> = []
  const pending = [...updates].sort((a, b) => a.createdAt - b.createdAt)
  const at = (item: Item) => (item.kind === "step" ? item.step.createdAt : item.entry.createdAt)
  for (const item of items) {
    while (pending.length > 0 && pending[0]!.createdAt < at(item)) out.push({ kind: "update", entry: pending.shift()! })
    out.push(item)
  }
  for (const entry of pending) out.push({ kind: "update", entry })
  return out
}

/** The step rows themselves (a turn's "N steps" sheet, a background task's steps in the Tasks tab). */
export function StepList({
  steps,
  decisions = [],
  updates = [],
  className,
}: {
  readonly steps: ReadonlyArray<ToolCallEntry | ReasoningEntry>
  readonly decisions?: ReadonlyArray<EventEntry>
  /** A background task's updates (D5.7), shown by time among its steps. */
  readonly updates?: ReadonlyArray<MessageEntry>
  readonly className?: string
}): ReactNode {
  const items = stepItems(steps, decisions, updates)
  return (
    <div className={cn("flex flex-col gap-0.5 rounded-2xl border border-line-tertiary bg-elevated p-1", className)} data-step-list={items.length}>
      {items.map((item) =>
        item.kind === "step" ? (
          <StepRow key={item.step.id} step={item.step} decision={item.decision} />
        ) : item.kind === "update" ? (
          <UpdateRow key={item.entry.id} entry={item.entry} />
        ) : (
          <DecisionRow key={item.entry.id} entry={item.entry} decision={item.decision} />
        ),
      )}
    </div>
  )
}

export function StepsDisclosure({
  steps,
  decisions = [],
  failed,
  reveal,
}: {
  readonly steps: ReadonlyArray<ToolCallEntry | ReasoningEntry>
  readonly decisions?: ReadonlyArray<EventEntry>
  readonly failed: boolean
  /** Opens the sheet whenever it changes (a search hit on one of these steps). */
  readonly reveal?: number | undefined
}): ReactNode {
  const [open, setOpen] = useState(reveal !== undefined)
  useEffect(() => {
    if (reveal !== undefined) setOpen(true)
  }, [reveal])
  const items = stepItems(steps, decisions)
  const n = items.length
  const auto = items.filter((i) => i.kind === "decision" || (i.kind === "step" && i.decision !== undefined)).length
  return (
    <div className="flex flex-col items-start py-0.5" data-steps={n} data-auto={auto}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-[22px] items-center gap-1 rounded-[11px] px-2 text-xs text-fg-tertiary transition-colors duration-100 hover:bg-hover hover:text-fg-secondary"
      >
        {failed && <span className="size-1.5 rounded-full bg-danger" aria-label="A step failed" />}
        {n} {n === 1 ? "step" : "steps"}
        <ChevronRight size={12} className={cn("transition-transform duration-200", open && "rotate-90")} aria-hidden />
      </button>
      <div className="ob-accordion w-full max-w-[min(80%,560px)]" {...(open ? { "data-open": "" } : {})}>
        <div>
          <StepList steps={steps} decisions={decisions} className="mt-1" />
        </div>
      </div>
    </div>
  )
}

// Shared building blocks for the W2.3 screens (details pane, settings, dialogs, onboarding, computer):
// RPC command/query hooks with error text, section/sheet layout pieces in Grok's details-pane tokens
// (grok-bot-ui-activity.md F.9 / F.10.1-B), harness metadata, and small formatting helpers.
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { type CommandPayload, type CommandSuccess, type CommandTag, commandAtom } from "@openbot/client"
import type { HarnessStatus, NodeSummary, RoutineTrigger } from "@openbot/contracts"
import { DEFAULT_HARNESS_PROFILE_ID, describeAccount, profileIdOf } from "@openbot/contracts"
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  Icon,
  IconButton,
  PillButton,
  Spinner,
  StatusPill,
  type StatusTone,
  cn,
} from "@openbot/ui"
import { Asterisk, Braces, Check, Copy, Cpu, FlaskConical, type LucideIcon, SquareTerminal } from "lucide-react"
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AsyncResult, type Atom } from "effect/reactivity"
import { Cause } from "effect"

// ------------------------------------------------------------------------------------------ ui workaround

/**
 * STOPGAP for a @openbot/ui bug (report to W1.11): `Popover` measures its panel in a layout effect that
 * runs before `Portal` has mounted the panel (Portal attaches in a passive effect), so every Popover /
 * Menu / Select panel stays `visibility: hidden` until the window resizes or scrolls. When such a panel
 * is attached to <body>, nudge a `resize` so `useAnchoredPosition` measures it. Harmless once fixed.
 */
const installPopoverNudge = () => {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return
  const w = window as unknown as { __openbotPopoverNudge?: boolean }
  if (w.__openbotPopoverNudge) return
  w.__openbotPopoverNudge = true
  const start = () =>
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes) {
          if (n instanceof HTMLElement && n.style.position === "fixed" && n.style.visibility === "hidden") {
            requestAnimationFrame(() => window.dispatchEvent(new Event("resize")))
            return
          }
        }
    }).observe(document.body, { childList: true })
  if (document.body) start()
  else document.addEventListener("DOMContentLoaded", start, { once: true })
}
installPopoverNudge()

// ------------------------------------------------------------------------------------------ errors

/** Human text for an RPC failure (contract errors carry `message` / `reason`; NotFound carries entity + id). */
export const errorText = (e: unknown): string => {
  if (typeof e === "string") return e
  if (typeof e === "object" && e !== null) {
    const r = e as Record<string, unknown>
    // Before `message`: RpcClientError's message is Effect's raw "SocketReadError: An error occurred during Read".
    if (r["_tag"] === "RpcClientError")
      return "Lost the connection to OpenBot. It reconnects on its own; try again in a moment."
    if (typeof r["message"] === "string" && r["message"].length > 0) return r["message"]
    if (typeof r["reason"] === "string" && r["reason"].length > 0) return r["reason"]
    if (r["_tag"] === "NotFound") return `That ${String(r["entity"] ?? "item")} no longer exists`
    if (typeof r["_tag"] === "string") return r["_tag"]
  }
  return "Something went wrong"
}

// ------------------------------------------------------------------------------------------ RPC hooks

export type Outcome<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: string }

export interface CommandHandle<T extends CommandTag> {
  /** Runs the RPC; never rejects. On failure `error` is also set on the handle. */
  readonly run: (payload: CommandPayload<T>) => Promise<Outcome<CommandSuccess<T>>>
  readonly pending: boolean
  readonly error: string | undefined
  readonly clearError: () => void
}

/**
 * One command RPC with pending/error state. `key` picks an independent single-flight instance
 * (`commandAtom(tag, key)`), so e.g. saving the name never interrupts saving the instructions.
 * `describe` words some errors itself (undefined: `errorText`).
 */
export function useCommand<T extends CommandTag>(
  tag: T,
  key = "",
  describe?: (e: unknown) => string | undefined,
): CommandHandle<T> {
  const atom = useMemo(() => commandAtom(tag, key), [tag, key])
  const set = useAtomSet(atom as never, { mode: "promise" } as never) as unknown as (
    payload: CommandPayload<T>,
  ) => Promise<CommandSuccess<T>>
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const run = useCallback(
    async (payload: CommandPayload<T>): Promise<Outcome<CommandSuccess<T>>> => {
      setPending(true)
      setError(undefined)
      try {
        const value = await set(payload)
        return { ok: true, value: value as CommandSuccess<T> }
      } catch (e) {
        const error = describe?.(e) ?? errorText(e)
        if (alive.current) setError(error)
        return { ok: false, error }
      } finally {
        if (alive.current) setPending(false)
      }
    },
    [set, describe],
  )
  const clearError = useCallback(() => setError(undefined), [])
  return { run, pending, error, clearError }
}

export interface QueryState<A> {
  readonly value: A | undefined
  /** No value yet and no failure (first load). */
  readonly loading: boolean
  /** A refetch is in flight. */
  readonly waiting: boolean
  readonly error: string | undefined
  readonly refresh: () => void
}

/** Read an `AsyncResult` atom (query atoms from @openbot/client) as plain loading / value / error. */
export function useQuery<A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>): QueryState<A> {
  const result = useAtomValue(atom)
  const refresh = useAtomRefresh(atom)
  return useMemo(() => fromResult(result, refresh), [result, refresh])
}

export const fromResult = <A, E>(
  result: AsyncResult.AsyncResult<A, E>,
  refresh: () => void = () => {},
): QueryState<A> => {
  if (AsyncResult.isSuccess(result))
    return { value: result.value, loading: false, waiting: result.waiting, error: undefined, refresh }
  if (AsyncResult.isFailure(result)) {
    const prev = result.previousSuccess
    return {
      value: prev._tag === "Some" ? prev.value.value : undefined,
      loading: false,
      waiting: result.waiting,
      error: errorText(Cause.squash(result.cause)),
      refresh,
    }
  }
  return { value: undefined, loading: true, waiting: true, error: undefined, refresh }
}

/** Value of a roster-derived `AsyncResult` atom, or `fallback` until the first snapshot. */
export function useRosterValue<A>(atom: Atom.Atom<AsyncResult.AsyncResult<A, unknown>>, fallback: A): A {
  const result = useAtomValue(atom)
  return AsyncResult.isSuccess(result)
    ? result.value
    : AsyncResult.isFailure(result) && result.previousSuccess._tag === "Some"
      ? result.previousSuccess.value.value
      : fallback
}

/** A fresh idempotency key (`clientNonce`). */
export const newNonce = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

// ------------------------------------------------------------------------------------------ layout

/** "Brain", "Routines", … : 13/18 secondary, inline padding 12 (F.9). */
export function SectionLabel({
  children,
  trailing,
  className,
}: {
  readonly children: ReactNode
  readonly trailing?: ReactNode
  readonly className?: string
}): ReactNode {
  return (
    <div className={cn("flex min-h-7 items-center gap-2 px-3", className)}>
      <h3 className="min-w-0 flex-1 truncate text-sm font-normal text-fg-secondary">{children}</h3>
      {trailing}
    </div>
  )
}

/** Details-pane section: label + content, 10 px gap. */
export function Section({
  title,
  trailing,
  children,
  className,
  id,
}: {
  readonly title: ReactNode
  readonly trailing?: ReactNode
  readonly children: ReactNode
  readonly className?: string
  readonly id?: string
}): ReactNode {
  return (
    <section id={id} className={cn("flex flex-col gap-2.5", className)}>
      <SectionLabel trailing={trailing}>{title}</SectionLabel>
      {children}
    </section>
  )
}

/** White sheet, radius 12, 0.5 px border, padding 4 (F.9 routines / F.10.1-B brain). */
export function SectionSheet({
  children,
  className,
}: {
  readonly children: ReactNode
  readonly className?: string
}): ReactNode {
  return (
    <div className={cn("flex flex-col gap-px rounded-2xl bg-elevated p-1 hairline border-line-tertiary", className)}>
      {children}
    </div>
  )
}

/** 40 px row inside a SectionSheet: label left, control right. */
export function SheetLine({
  label,
  children,
  className,
  hint,
}: {
  readonly label: ReactNode
  readonly children?: ReactNode
  readonly className?: string
  readonly hint?: ReactNode
}): ReactNode {
  return (
    <div
      className={cn(
        "flex min-h-10 items-center gap-2 rounded-lg px-2 py-1.5 transition-colors duration-100 hover:bg-hover",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-fg">{label}</span>
        {hint && <span className="truncate text-xs text-fg-tertiary">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

/** Centered 13 px secondary empty-state copy (Grok "Routines are recurring tasks…"). */
export function EmptyNote({
  children,
  className,
}: {
  readonly children: ReactNode
  readonly className?: string
}): ReactNode {
  return <p className={cn("px-4 py-3 text-center text-sm text-fg-secondary", className)}>{children}</p>
}

/** Inline error line (Grok settings-section error pattern) with an optional Retry. */
export function ErrorLine({
  children,
  onRetry,
  className,
}: {
  readonly children: ReactNode
  readonly onRetry?: () => void
  readonly className?: string
}): ReactNode {
  return (
    <div role="alert" className={cn("flex items-center gap-2 px-3 py-1.5 text-sm text-danger-fg", className)}>
      <span className="min-w-0 flex-1">{children}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 text-sm text-fg-secondary underline-offset-2 hover:text-fg hover:underline"
        >
          Retry
        </button>
      )}
    </div>
  )
}

export function LoadingLine({
  children = "Loading…",
  className,
}: {
  readonly children?: ReactNode
  readonly className?: string
}): ReactNode {
  return (
    <div className={cn("flex items-center justify-center gap-2 px-3 py-3 text-sm text-fg-tertiary", className)}>
      <Spinner size={14} />
      {children}
    </div>
  )
}

/** Mono command block with a copy button (Settings › Harnesses sign-in, pairing command). */
export function CommandBlock({
  command,
  className,
}: {
  readonly command: string
  readonly className?: string
}): ReactNode {
  return (
    <div
      className={cn(
        "flex min-h-9 items-center gap-2 rounded-lg bg-quaternary py-1.5 ps-3 pe-1.5 hairline border-line-quaternary",
        className,
      )}
    >
      <code className="min-w-0 flex-1 font-mono text-xs [overflow-wrap:anywhere] text-fg select-all">{command}</code>
      <CopyButton text={command} label="Copy command" />
    </div>
  )
}

export function CopyButton({
  text,
  label = "Copy",
  size = 24,
}: {
  readonly text: string
  readonly label?: string
  readonly size?: 20 | 24 | 28
}): ReactNode {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <IconButton
      icon={copied ? Check : Copy}
      label={copied ? "Copied" : label}
      size={size}
      iconSize="sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }}
    />
  )
}

/** Small confirm dialog (520 wide, F.10.1 "Switch to Codex?" pattern). */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger = false,
  pending = false,
  error,
  onConfirm,
  onCancel,
}: {
  readonly open: boolean
  readonly title: ReactNode
  readonly body?: ReactNode
  readonly confirmLabel: string
  readonly danger?: boolean
  readonly pending?: boolean
  readonly error?: string | undefined
  readonly onConfirm: () => void
  readonly onCancel: () => void
}): ReactNode {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onCancel()}
      width={440}
      label={typeof title === "string" ? title : "Confirm"}
    >
      <DialogHeader title={title} description={body} />
      {error && <ErrorLine className="px-4">{error}</ErrorLine>}
      <DialogFooter>
        <PillButton variant="secondary" size="card" onClick={onCancel}>
          Cancel
        </PillButton>
        <PillButton
          variant={danger ? "danger" : "primary"}
          size="card"
          loading={pending}
          onClick={onConfirm}
          data-autofocus
        >
          {confirmLabel}
        </PillButton>
      </DialogFooter>
    </Dialog>
  )
}

// ------------------------------------------------------------------------------------------ harnesses

const HARNESS_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", fake: "Demo" }
const HARNESS_GLYPHS: Record<string, LucideIcon> = {
  claude: Asterisk,
  codex: SquareTerminal,
  opencode: Braces,
  fake: FlaskConical,
}

/**
 * Display name for a harness kind. The fake harness is labelled "Demo" (offline, no credentials).
 * Claude is "Claude", never "Claude Code" (Agent SDK branding rules, policy-and-licensing.md A2).
 */
export const harnessName = (kind: string, status?: Pick<HarnessStatus, "displayName">): string =>
  kind === "fake" ? "Demo" : (HARNESS_NAMES[kind] ?? status?.displayName ?? kind)

export const harnessGlyph = (kind: string): LucideIcon => HARNESS_GLYPHS[kind] ?? Cpu

/** CLI command a user runs on the brain machine to sign a harness in (no SDK login API, F.10.2). */
export const SIGN_IN_COMMANDS: Record<string, string> = {
  claude: "claude auth login",
  codex: "codex login",
  opencode: "opencode auth login",
}
export const INSTALL_HINTS: Record<string, string> = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  opencode: "curl -fsSL https://opencode.ai/install | bash",
}

/** Ready = installed and signed in (fake is always ready). */
export const harnessReady = (s: HarnessStatus | undefined): boolean =>
  s !== undefined && (s.kind === "fake" || (s.installed && s.auth.state === "signed-in"))

export const harnessState = (s: HarnessStatus | undefined): { readonly tone: StatusTone; readonly label: string } => {
  if (!s) return { tone: "neutral", label: "Unknown" }
  if (s.kind === "fake") return { tone: "success", label: "Always available" }
  if (!s.installed) return { tone: "neutral", label: "Not installed" }
  if (s.problems.length > 0 && s.auth.state !== "signed-in") return { tone: "danger", label: "Error" }
  if (s.auth.state === "signed-in") return { tone: "success", label: "Signed in" }
  if (s.auth.state === "signed-out") return { tone: "warn", label: "Sign in needed" }
  return { tone: "neutral", label: "Status unknown" }
}

export function HarnessStatusPill({ status }: { readonly status: HarnessStatus | undefined }): ReactNode {
  const s = harnessState(status)
  return (
    <StatusPill tone={s.tone} dot={s.tone === "success"} className="h-[22px] text-xs">
      {s.label}
    </StatusPill>
  )
}

/** 32 px tile with the harness glyph (Settings › Harnesses header, harness picker). */
export function HarnessTile({ kind, size = 32 }: { readonly kind: string; readonly size?: 24 | 32 }): ReactNode {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center bg-secondary text-icon",
        size === 32 ? "size-8 rounded-lg" : "size-6 rounded-md",
      )}
    >
      <Icon icon={harnessGlyph(kind)} size={size === 32 ? "md" : "sm"} />
    </span>
  )
}

// ------------------------------------------------------------------------------------------ harness accounts

/** Display order of harness kinds. */
export const HARNESS_ORDER: ReadonlyArray<string> = ["claude", "codex", "opencode", "fake"]
const kindRank = (kind: string) => (HARNESS_ORDER.includes(kind) ? HARNESS_ORDER.indexOf(kind) : HARNESS_ORDER.length)

/** The account (profile) id of a status; old brains omit it (= the default account). */
export const statusProfileId = (s: Pick<HarnessStatus, "profileId">): string =>
  s.profileId ?? DEFAULT_HARNESS_PROFILE_ID

/** The status of a bot's harness + account. */
export const statusFor = (
  statuses: ReadonlyArray<HarnessStatus> | undefined,
  harness: { readonly kind: string; readonly profileId?: string | undefined },
): HarnessStatus | undefined =>
  statuses?.find((s) => s.kind === harness.kind && statusProfileId(s) === profileIdOf(harness))

/** "leka@example.com (team)" from the probe, else the account's label ("Default" for the default). */
export const accountName = (s: HarnessStatus | undefined): string => {
  if (!s) return "Unknown account"
  return (
    describeAccount(s.account) ??
    s.auth.label ??
    (s.profileLabel && s.profileLabel !== "Default" ? s.profileLabel : "Default account")
  )
}

/** The owner-given label of an added account when it says something the account name doesn't. */
export const accountNickname = (s: HarnessStatus | undefined): string | undefined => {
  const label = s?.profileLabel
  if (!s || !label || label === "Default" || statusProfileId(s) === DEFAULT_HARNESS_PROFILE_ID) return undefined
  const name = accountName(s)
  // auto-added accounts are labelled with their email: don't say it twice
  if (s.account?.email !== undefined && label.includes(s.account.email)) return undefined
  return name === label || name.startsWith(label) || label.startsWith(name) ? undefined : label
}

/** An account in a picker: "Work (leka@example.com (team))" or just the account name. */
export const accountChoiceLabel = (s: HarnessStatus): string => {
  const nick = accountNickname(s)
  return nick ? `${nick} (${accountName(s)})` : accountName(s)
}

/** "Claude · leka@example.com (team)"; just "Claude" when `single` (the only account of the kind). */
export const harnessAccountName = (s: HarnessStatus, single = false): string => {
  const base = harnessName(s.kind, s)
  if (single || s.kind === "fake") return base
  return `${base} · ${accountChoiceLabel(s)}`
}

/** Statuses grouped per kind, in display order (default account first within a kind). */
export const groupStatuses = (
  statuses: ReadonlyArray<HarnessStatus>,
): ReadonlyArray<{ readonly kind: string; readonly accounts: ReadonlyArray<HarnessStatus> }> => {
  const kinds = [...new Set(statuses.map((s) => s.kind))].sort(
    (a, b) => kindRank(a) - kindRank(b) || a.localeCompare(b),
  )
  return kinds.map((kind) => ({ kind, accounts: statuses.filter((s) => s.kind === kind) }))
}

/** Sign-in command for an account: the CLI pointed at the account's own config dir. */
export const signInCommand = (s: HarnessStatus): string | undefined => {
  const base = SIGN_IN_COMMANDS[s.kind]
  if (!base || statusProfileId(s) === DEFAULT_HARNESS_PROFILE_ID || !s.configDir) return base
  if (s.kind === "claude") return `CLAUDE_CONFIG_DIR=${s.configDir} ${base}`
  if (s.kind === "codex") return `CODEX_HOME=${s.configDir} ${base}`
  return base
}

// ------------------------------------------------------------------------------------------ nodes

export const nodeDisplayName = (node: Pick<NodeSummary, "kind" | "label"> | undefined, fallbackId?: string): string =>
  node ? (node.kind === "local" ? `${node.label} (this server)` : node.label) : (fallbackId ?? "Unknown computer")

export const nodeTone = (node: Pick<NodeSummary, "status"> | undefined): StatusTone =>
  node?.status === "online" ? "success" : node?.status === "degraded" ? "warn" : "neutral"

export function StatusDot({ tone, className }: { readonly tone: StatusTone; readonly className?: string }): ReactNode {
  const color: Record<StatusTone, string> = {
    success: "bg-success",
    warn: "bg-warn",
    danger: "bg-danger",
    accent: "bg-accent",
    neutral: "bg-icon-tertiary",
  }
  return <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", color[tone], className)} />
}

/** Human capability names (`fs@1` → "Files"). */
export const CAPABILITY_INFO: Record<string, { readonly title: string; readonly description: string }> = {
  fs: { title: "Files", description: "Read and write files inside the computer's allowed folders" },
  shell: { title: "Shell", description: "Run commands" },
  pty: { title: "Terminal", description: "Interactive terminal in the Bot's workspace" },
  tunnel: { title: "Network tunnels", description: "Forward ports between the brain and this computer" },
  browser: { title: "Browser", description: "A Chromium window per Bot, with live view and take-over" },
  desktop: {
    title: "Full desktop",
    description: "Each Bot gets its own screen to work on; watch it live and take over",
  },
  screen: {
    title: "This Mac's screen",
    description: "Bots use the Mac's own screen, one at a time and only while you're away from it; watch and take over",
  },
  "codex.exec-server": { title: "Codex tools", description: "Run Codex's native tools here" },
  "claude.cli": { title: "Claude CLI", description: "Run the claude CLI here with this computer's own login" },
  "opencode.serve": { title: "OpenCode server", description: "Run OpenCode here" },
}

export const capabilityName = (cap: string): string => cap.replace(/@\d+$/, "")
export const capabilityInfo = (cap: string) =>
  CAPABILITY_INFO[capabilityName(cap)] ?? { title: capabilityName(cap), description: cap }

// ------------------------------------------------------------------------------------------ time

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })

/** "Today at 9:04 AM", "Yesterday at …", "Mar 4 at …". */
export const formatWhen = (ms: number, now = Date.now()): string => {
  const d = new Date(ms)
  const today = new Date(now)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const day = 86_400_000
  const prefix =
    ms >= startOfToday && ms < startOfToday + day
      ? "Today"
      : ms >= startOfToday - day && ms < startOfToday
        ? "Yesterday"
        : ms >= startOfToday + day && ms < startOfToday + 2 * day
          ? "Tomorrow"
          : dateFmt.format(d)
  return `${prefix} at ${timeFmt.format(d)}`
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export const formatAgo = (ms: number, now = Date.now()): string => {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

const clock = (h: number, m: number): string => {
  const d = new Date(2000, 0, 1, h, m)
  return timeFmt.format(d)
}

/** Best-effort English for common 5-field cron expressions; falls back to the raw expression. */
export const describeCron = (schedule: string): string => {
  const parts = schedule.trim().split(/\s+/)
  if (parts.length !== 5) return schedule
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string]
  const isNum = (s: string) => /^\d+$/.test(s)
  if (min.startsWith("*/") && hour === "*" && dom === "*" && mon === "*" && dow === "*")
    return `Every ${min.slice(2)} minutes`
  if (isNum(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*")
    return `Every hour at :${min.padStart(2, "0")}`
  if (!isNum(min) || !isNum(hour) || mon !== "*") return schedule
  const at = clock(Number(hour), Number(min))
  if (dom === "*" && dow === "*") return `Every day at ${at}`
  if (dom === "*" && (dow === "1-5" || dow === "MON-FRI")) return `On weekdays at ${at}`
  if (dom === "*" && (dow === "0,6" || dow === "6,0" || dow === "SAT,SUN")) return `On weekends at ${at}`
  if (dom === "*" && isNum(dow)) return `Every ${WEEKDAYS[Number(dow) % 7]} at ${at}`
  if (isNum(dom) && dow === "*") return `Monthly on day ${dom} at ${at}`
  return schedule
}

export const describeTrigger = (trigger: RoutineTrigger): string => {
  switch (trigger.type) {
    case "cron":
      return describeCron(trigger.schedule)
    case "interval":
      return trigger.everyMinutes % 60 === 0
        ? `Every ${trigger.everyMinutes / 60 === 1 ? "hour" : `${trigger.everyMinutes / 60} hours`}`
        : `Every ${trigger.everyMinutes} minutes`
    case "once":
      return `Once, ${formatWhen(trigger.at)}`
    case "manual":
      return "Only when run by hand"
    case "slack": {
      const where =
        trigger.channel === undefined || trigger.channel.trim() === "" ? "" : ` in ${trigger.channel.trim()}`
      switch (trigger.on) {
        case "dm":
          return `When someone messages you on Slack${where}`
        case "mention":
          return `When you're mentioned on Slack${where}`
        case "phrase":
          return `When a Slack message says “${(trigger.phrase ?? "").trim()}”${where}`
        case "message":
          return `Every Slack message${where}`
      }
    }
    case "webhook":
      return "On webhook"
  }
}

/** Compact token counts: 950, 12.4k, 1.3M. */
export const formatTokens = (n: number): string =>
  n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1_000_000).toFixed(1)}M`

export const formatUsd = (n: number): string => (n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`)

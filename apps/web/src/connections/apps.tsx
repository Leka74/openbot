// The apps a Bot can be connected to (Connect apps, D3.4). Only apps that work are listed; each one
// has a logo, a category, a one-line description and a status read from the brain. Adding an app:
// its connector on the brain, an entry here, and its page in ConnectAppsDialog's `AppPage`.
import { harkStatusAtom, ntfyStatusAtom, slackStatusAtom } from "@openbot/client"
import type { HarkStatus, NtfyStatus, SlackStatus } from "@openbot/contracts"
import { cn } from "@openbot/ui"
import { Bell, BellRing } from "lucide-react"
import { type ComponentType, type ReactNode, useEffect } from "react"
import { useQuery } from "../details/kit.tsx"

export type AppId = "slack" | "hark" | "ntfy"

export const CATEGORIES = ["Communication", "Notifications"] as const
export type AppCategory = (typeof CATEGORIES)[number]

export interface ConnectApp {
  readonly id: AppId
  readonly name: string
  readonly category: AppCategory
  readonly description: string
  /** Extra words search matches. */
  readonly keywords: ReadonlyArray<string>
  readonly Logo: ComponentType<{ readonly className?: string }>
}

/** Slack's mark (four colored pairs of rounded bars). */
export function SlackLogo({ className }: { readonly className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="#E01E5A"
        d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z"
      />
      <path
        fill="#36C5F0"
        d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z"
      />
      <path
        fill="#2EB67D"
        d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z"
      />
      <path
        fill="#ECB22E"
        d="M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"
      />
    </svg>
  )
}

/** Hark has no published mark here: a bell. */
export function HarkLogo({ className }: { readonly className?: string }): ReactNode {
  return <BellRing className={className} color="#1d1d1f" strokeWidth={2.2} aria-hidden="true" />
}

/** ntfy has no published mark here: a bell. */
export function NtfyLogo({ className }: { readonly className?: string }): ReactNode {
  return <Bell className={className} color="#2f8f83" strokeWidth={2.2} aria-hidden="true" />
}

export const APPS: ReadonlyArray<ConnectApp> = [
  {
    id: "slack",
    name: "Slack",
    category: "Communication",
    description: "Read and search your Slack, draft messages you send, start routines on new messages.",
    keywords: ["chat", "messages", "dm", "channels", "workspace"],
    Logo: SlackLogo,
  },
  {
    id: "hark",
    name: "Hark",
    category: "Notifications",
    description: "Your Bots' notifications on your iPhone, through the Hark app.",
    keywords: ["iphone", "push", "notifications", "phone", "alerts"],
    Logo: HarkLogo,
  },
  {
    id: "ntfy",
    name: "ntfy",
    category: "Notifications",
    description: "Your Bots' notifications on any phone, Android or iPhone, through the ntfy app.",
    keywords: ["android", "iphone", "push", "notifications", "phone", "alerts"],
    Logo: NtfyLogo,
  },
]

export const appById = (id: AppId): ConnectApp => APPS.find((app) => app.id === id)!

/** An app's logo on a white rounded tile (Grok's app tile). */
export function AppTile({
  app,
  size = 40,
  className,
}: {
  readonly app: ConnectApp
  readonly size?: number
  readonly className?: string
}): ReactNode {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[22%] bg-white hairline border-line-tertiary",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <app.Logo className="size-[56%]" />
    </span>
  )
}

/** The connected apps' logos, overlapping (the "N connected" button, the sidebar pill). */
export function StackedLogos({
  apps,
  size = 22,
}: {
  readonly apps: ReadonlyArray<ConnectApp>
  readonly size?: number
}): ReactNode {
  if (apps.length === 0) return null
  return (
    <span className="inline-flex items-center">
      {apps.slice(0, 4).map((app, i) => (
        <AppTile key={app.id} app={app} size={size} className={cn("ring-2 ring-chrome", i > 0 && "-ms-1.5")} />
      ))}
    </span>
  )
}

/** connected: working; attention: connected but something needs the owner; off: not connected. */
export interface AppStatus {
  readonly state: "connected" | "attention" | "off"
  /** One line for the manage view, e.g. "Seen · live messages on". */
  readonly summary?: string | undefined
  readonly loading: boolean
}

const slackStatusOf = (status: SlackStatus | undefined, loading: boolean): AppStatus => {
  if (status === undefined || !status.connected) return { state: "off", loading }
  const live =
    status.events === "live"
      ? "live messages on"
      : status.events === "connecting"
        ? "connecting live messages"
        : status.events === "off"
          ? "live messages off"
          : "live messages not working"
  const outdated = status.missingScopes !== undefined && status.missingScopes.length > 0
  return {
    state: status.events === "failed" || outdated ? "attention" : "connected",
    summary: [status.team, outdated ? "the app needs an update" : live]
      .filter((part) => part !== undefined)
      .join(" · "),
    loading,
  }
}

const harkStatusOf = (status: HarkStatus | undefined, loading: boolean): AppStatus => {
  if (status === undefined || !status.connected) return { state: "off", loading }
  return {
    state: status.problem === undefined ? "connected" : "attention",
    summary: status.problem ?? (status.sends === "all" ? "Every notification" : "When a Bot needs you"),
    loading,
  }
}

const ntfyStatusOf = (status: NtfyStatus | undefined, loading: boolean): AppStatus => {
  if (status === undefined || !status.connected) return { state: "off", loading }
  return {
    state: status.problem === undefined ? "connected" : "attention",
    summary: status.problem ?? (status.sends === "all" ? "Every notification" : "When a Bot needs you"),
    loading,
  }
}

/** Every app's status; `poll` refreshes them every few seconds (while the Connect apps window is open). */
export const useAppStatuses = (options?: {
  readonly poll?: boolean
}): ReadonlyMap<AppId, AppStatus> & { readonly refresh: () => void } => {
  const slack = useQuery(slackStatusAtom)
  const hark = useQuery(harkStatusAtom)
  const ntfy = useQuery(ntfyStatusAtom)
  const refreshSlack = slack.refresh
  const refreshHark = hark.refresh
  const refreshNtfy = ntfy.refresh
  const poll = options?.poll === true
  useEffect(() => {
    if (!poll) return
    const t = setInterval(() => {
      refreshSlack()
      refreshHark()
      refreshNtfy()
    }, 5_000)
    return () => clearInterval(t)
  }, [poll, refreshSlack, refreshHark, refreshNtfy])
  const map = new Map<AppId, AppStatus>([
    ["slack", slackStatusOf(slack.value, slack.loading)],
    ["hark", harkStatusOf(hark.value, hark.loading)],
    ["ntfy", ntfyStatusOf(ntfy.value, ntfy.loading)],
  ])
  return Object.assign(map, {
    refresh: () => {
      refreshSlack()
      refreshHark()
      refreshNtfy()
    },
  })
}

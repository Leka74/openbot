// Connect Apps (D3.4; grok-bot-ui.md §4.12): the apps Bots can use. Three views in one 800×702
// window (full screen on a phone):
// - browse: "N connected ›", search, category chips, one section per category, rows with
//   Connect / ✓ Connected;
// - manage ("N connected ›"): the connected apps, Connected or Fix when one needs the owner;
// - an app's own page (connect, status, disconnect) under "‹ Connect Apps".
import { Dialog, Icon, IconButton, PillButton, cn } from "@openbot/ui"
import { Check, ChevronLeft, ChevronRight, Search, X } from "lucide-react"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { useIsPhone } from "../app/layout.ts"
import type { ConnectAppsView } from "../app/uiState.ts"
import {
  type AppCategory,
  type AppId,
  type AppStatus,
  APPS,
  AppTile,
  appById,
  CATEGORIES,
  type ConnectApp,
  StackedLogos,
  useAppStatuses,
} from "./apps.tsx"
import { HarkApp } from "./HarkApp.tsx"
import { NtfyApp } from "./NtfyApp.tsx"
import { SlackApp } from "./SlackApp.tsx"

export interface ConnectAppsDialogProps {
  readonly open: boolean
  readonly view: ConnectAppsView
  readonly onClose: () => void
}

type View =
  | { readonly kind: "browse" }
  | { readonly kind: "manage" }
  | { readonly kind: "app"; readonly id: AppId; readonly from: "browse" | "manage" }

const known = (view: ConnectAppsView): View =>
  view.kind === "app" && APPS.some((a) => a.id === view.id)
    ? { kind: "app", id: view.id as AppId, from: "browse" }
    : view.kind === "manage"
      ? view
      : { kind: "browse" }

export function ConnectAppsDialog({ open, view: requested, onClose }: ConnectAppsDialogProps): ReactNode {
  const phone = useIsPhone()
  // the window remounts for each `show` (App keys it on the requested view)
  const [view, setView] = useState<View>(() => known(requested))
  const statuses = useAppStatuses({ poll: open })
  const connected = APPS.filter((app) => statuses.get(app.id)?.state !== "off")
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [view])
  const openApp = (id: AppId, from: "browse" | "manage") => setView({ kind: "app", id, from })

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={800}
      height={702}
      label="Connect apps"
      className={cn("bg-chrome", phone && "ob-phone-full")}
    >
      <div className="relative flex min-h-0 flex-1 flex-col" data-testid="connect-apps">
        <IconButton
          icon={X}
          label="Close"
          size={phone ? 36 : 28}
          className="absolute top-4 right-4 z-10"
          onClick={onClose}
        />
        <div
          ref={scrollRef}
          className={cn("min-h-0 flex-1 overflow-y-auto pb-12 scrollbar-thin", phone ? "px-4 pt-4" : "px-10 pt-6")}
        >
          {view.kind === "browse" && (
            <Browse
              statuses={statuses}
              connected={connected}
              onOpen={(id) => openApp(id, "browse")}
              onManage={() => setView({ kind: "manage" })}
            />
          )}
          {view.kind === "manage" && (
            <Manage
              statuses={statuses}
              connected={connected}
              onBack={() => setView({ kind: "browse" })}
              onOpen={(id) => openApp(id, "manage")}
            />
          )}
          {view.kind === "app" && (
            <AppView
              app={appById(view.id)}
              status={statuses.get(view.id)}
              onBack={() => setView({ kind: view.from })}
            />
          )}
        </div>
      </div>
    </Dialog>
  )
}

/** "‹ Connect Apps" */
function BackPill({ onBack }: { readonly onBack: () => void }): ReactNode {
  return (
    <button
      type="button"
      onClick={onBack}
      data-testid="connect-apps-back"
      className="-ms-2 inline-flex h-8 w-fit items-center gap-0.5 rounded-full bg-elevated ps-1.5 pe-3 text-base text-fg hairline border-line-tertiary transition-colors hover:bg-elevated-hover"
    >
      <Icon icon={ChevronLeft} size="md" />
      Connect Apps
    </button>
  )
}

// ------------------------------------------------------------------------------------------ browse

function Browse({
  statuses,
  connected,
  onOpen,
  onManage,
}: {
  readonly statuses: ReadonlyMap<AppId, AppStatus>
  readonly connected: ReadonlyArray<ConnectApp>
  readonly onOpen: (id: AppId) => void
  readonly onManage: () => void
}): ReactNode {
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState<AppCategory | "all">("all")
  const q = query.trim().toLowerCase()
  const shown = useMemo(
    () =>
      APPS.filter(
        (app) =>
          (category === "all" || app.category === category) &&
          (q === "" ||
            [app.name, app.description, app.category, ...app.keywords].some((t) => t.toLowerCase().includes(q))),
      ),
    [q, category],
  )
  const sections = CATEGORIES.map((c) => ({ category: c, apps: shown.filter((a) => a.category === c) })).filter(
    (s) => s.apps.length > 0,
  )
  return (
    <div className="flex flex-col gap-5">
      <div className="flex min-h-8 items-center gap-3 pe-10">
        <h2 className="min-w-0 flex-1 text-xl font-medium text-fg">Connect Apps</h2>
        <button
          type="button"
          onClick={onManage}
          data-testid="connected-count"
          className="inline-flex h-8 items-center gap-2 rounded-full px-2 text-base text-fg-secondary transition-colors hover:bg-hover hover:text-fg"
        >
          <StackedLogos apps={connected} />
          {connected.length} connected
          <Icon icon={ChevronRight} size="md" />
        </button>
      </div>
      <label className="flex h-11 items-center gap-2.5 rounded-full bg-elevated px-4 hairline border-line-tertiary focus-within:border-line-secondary">
        <Icon icon={Search} size="lg" className="text-icon-secondary" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search apps"
          aria-label="Search apps"
          className="min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-tertiary"
          data-autofocus
        />
      </label>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Categories">
        {(["all", ...CATEGORIES] as const).map((c) => (
          <PillButton
            key={c}
            role="tab"
            aria-selected={category === c}
            size="md"
            variant={category === c ? "primary" : "secondary"}
            onClick={() => setCategory(c)}
          >
            {c === "all" ? "All" : c}
          </PillButton>
        ))}
      </div>
      {sections.length === 0 ? (
        <p className="py-8 text-center text-base text-fg-secondary">No app matches “{query.trim()}”.</p>
      ) : (
        sections.map((section) => (
          <section key={section.category} className="flex flex-col gap-2">
            <h3 className="text-base text-fg-secondary">{section.category}</h3>
            <div className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
              {section.apps.map((app) => (
                <AppRow key={app.id} app={app} status={statuses.get(app.id)} onOpen={() => onOpen(app.id)} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}

function AppRow({
  app,
  status,
  onOpen,
}: {
  readonly app: ConnectApp
  readonly status: AppStatus | undefined
  readonly onOpen: () => void
}): ReactNode {
  const state = status?.state ?? "off"
  return (
    <div className="flex items-center gap-3 rounded-2xl py-2.5" data-testid={`app-${app.id}`}>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-start">
        <AppTile app={app} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-lg text-fg">{app.name}</span>
          <span className="truncate text-base text-fg-secondary">{app.description}</span>
        </span>
      </button>
      {state === "off" ? (
        <PillButton variant="secondary" size="md" onClick={onOpen}>
          Connect
        </PillButton>
      ) : state === "attention" ? (
        <PillButton variant="secondary" size="md" onClick={onOpen}>
          Fix
        </PillButton>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex h-8 items-center gap-1 rounded-full px-2 text-base text-fg-secondary transition-colors hover:bg-hover"
        >
          <Icon icon={Check} size="md" className="text-success-fg" />
          Connected
        </button>
      )}
    </div>
  )
}

// ------------------------------------------------------------------------------------------ manage

function Manage({
  statuses,
  connected,
  onBack,
  onOpen,
}: {
  readonly statuses: ReadonlyMap<AppId, AppStatus>
  readonly connected: ReadonlyArray<ConnectApp>
  readonly onBack: () => void
  readonly onOpen: (id: AppId) => void
}): ReactNode {
  return (
    <div className="flex flex-col gap-6">
      <BackPill onBack={onBack} />
      <h2 className="text-xl font-medium text-fg">Manage connections</h2>
      <section className="flex flex-col gap-2">
        <h3 className="text-base text-fg-secondary">Connected</h3>
        {connected.length === 0 ? (
          <p className="text-base text-fg-secondary">No apps connected yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-x-10 gap-y-2 sm:grid-cols-2">
            {connected.map((app) => {
              const status = statuses.get(app.id)
              return (
                <div key={app.id} className="flex items-center gap-3 py-2" data-testid={`connected-${app.id}`}>
                  <button
                    type="button"
                    onClick={() => onOpen(app.id)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-start"
                  >
                    <AppTile app={app} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-lg text-fg">{app.name}</span>
                      {status?.summary !== undefined && (
                        <span className="truncate text-base text-fg-secondary">{status.summary}</span>
                      )}
                    </span>
                  </button>
                  {status?.state === "attention" ? (
                    <PillButton variant="secondary" size="md" onClick={() => onOpen(app.id)}>
                      Fix
                    </PillButton>
                  ) : (
                    <button type="button" onClick={() => onOpen(app.id)} className="text-base text-success-fg">
                      Connected
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

// --------------------------------------------------------------------------------------- app page

function AppView({
  app,
  status,
  onBack,
}: {
  readonly app: ConnectApp
  readonly status: AppStatus | undefined
  readonly onBack: () => void
}): ReactNode {
  return (
    <div className="flex flex-col">
      <BackPill onBack={onBack} />
      <div className="mt-6 flex items-center gap-4 pe-10">
        <AppTile app={app} size={56} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-xl font-medium text-fg">{app.name}</h2>
          <p className="text-sm text-fg-secondary">{app.description}</p>
        </div>
        {status?.state === "connected" && (
          <span className="inline-flex items-center gap-1 text-base text-success-fg">
            <Icon icon={Check} size="md" />
            Connected
          </span>
        )}
      </div>
      <AppPage id={app.id} />
    </div>
  )
}

function AppPage({ id }: { readonly id: AppId }): ReactNode {
  switch (id) {
    case "slack":
      return <SlackApp />
    case "hark":
      return <HarkApp />
    case "ntfy":
      return <NtfyApp />
  }
}

// Settings dialog (grok-bot-ui.md §4.11; F.10.2/F.10.3): 900×702, bg-chrome, ~200 px left nav with a
// hairline, content column with a round × at the top right. Phone: a full-screen sheet whose nav is
// an iOS-style list that drills down into each page (‹ Settings back, browser Back too).
import { Dialog, Icon, IconButton, cn } from "@openbot/ui"
import {
  ChartNoAxesColumn,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Info,
  type LucideIcon,
  Monitor,
  Settings,
  ShieldCheck,
  Sparkles,
  UsersRound,
  X,
} from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { useIsPhone } from "../app/layout.ts"
import { useBackDismiss } from "../app/nav.ts"
import type { SettingsDialogProps, SettingsPage } from "../contracts.ts"
import { ComputersPage } from "./ComputersPage.tsx"
import { GeneralPage } from "./GeneralPage.tsx"
import { HarnessesPage } from "./HarnessesPage.tsx"
import { PermissionsPage } from "./PermissionsPage.tsx"
import { ProfilesPage } from "./ProfilesPage.tsx"
import { SkillsPage } from "./SkillsPage.tsx"
import { AboutPage, UsagePage } from "./UsagePage.tsx"

const NAV: ReadonlyArray<{ readonly id: SettingsPage; readonly label: string; readonly icon: LucideIcon }> = [
  { id: "general", label: "General", icon: Settings },
  { id: "profiles", label: "Profiles", icon: UsersRound },
  { id: "harnesses", label: "Harnesses", icon: Cpu },
  { id: "computers", label: "Computers", icon: Monitor },
  { id: "permissions", label: "Permissions", icon: ShieldCheck },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "usage", label: "Usage", icon: ChartNoAxesColumn },
  { id: "updates", label: "About", icon: Info },
]

const known = (p: string | undefined): SettingsPage => (NAV.some((n) => n.id === p) ? (p as SettingsPage) : "general")
/** Phone: "Settings" (= general) opens the list; a specific page (Computers, Permissions…) opens on it. */
const phoneStart = (p: string | undefined): SettingsPage | null =>
  p === undefined || known(p) === "general" ? null : known(p)

function PageBody({ page }: { readonly page: SettingsPage }): ReactNode {
  return (
    <>
      {page === "general" && <GeneralPage />}
      {page === "profiles" && <ProfilesPage />}
      {page === "harnesses" && <HarnessesPage />}
      {page === "computers" && <ComputersPage />}
      {page === "permissions" && <PermissionsPage />}
      {page === "skills" && <SkillsPage />}
      {page === "usage" && <UsagePage />}
      {page === "updates" && <AboutPage />}
    </>
  )
}

export function SettingsDialog({ open, initialPage, onClose }: SettingsDialogProps): ReactNode {
  const phone = useIsPhone()
  const [page, setPage] = useState<SettingsPage>(known(initialPage))
  const [phonePage, setPhonePage] = useState<SettingsPage | null>(phoneStart(initialPage))
  // every time the dialog opens (or is re-targeted), honor the requested page
  const [requested, setRequested] = useState({ open, initialPage })
  if (requested.open !== open || requested.initialPage !== initialPage) {
    setRequested({ open, initialPage })
    if (open) {
      setPage(known(initialPage))
      setPhonePage(phoneStart(initialPage))
    }
  }
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [page, phonePage])
  // Phone drill-down: an open page owns a history entry (Back returns to the list).
  useBackDismiss(phone && open && phonePage !== null, () => setPhonePage(null), "settings-page")

  if (phone) {
    const current = phonePage === null ? undefined : NAV.find((n) => n.id === phonePage)
    return (
      <Dialog
        open={open}
        onOpenChange={(o) => !o && onClose()}
        width={900}
        height={702}
        label="Settings"
        className="ob-phone-full bg-chrome"
      >
        <div className="flex min-h-0 flex-1 flex-col" data-testid="settings-dialog">
          <div className="relative flex h-14 shrink-0 items-center justify-center px-2">
            {current ? (
              <button
                type="button"
                onClick={() => setPhonePage(null)}
                data-testid="settings-back"
                className="absolute start-1 inline-flex h-11 items-center gap-0.5 rounded-full ps-1.5 pe-3 text-[16px] text-fg active:bg-hover"
              >
                <Icon icon={ChevronLeft} size="xl" />
                Settings
              </button>
            ) : (
              <h2 className="text-xl font-medium text-fg">Settings</h2>
            )}
            <IconButton
              icon={X}
              label="Close settings"
              size={36}
              variant="secondary"
              className="absolute end-3"
              onClick={onClose}
            />
          </div>
          {current ? (
            <div
              ref={scrollRef}
              key={current.id}
              className="min-h-0 flex-1 animate-push-in overflow-y-auto px-4 pt-1 pb-12 scrollbar-thin"
              data-testid={`settings-page-${current.id}`}
            >
              <PageBody page={current.id} />
            </div>
          ) : (
            <nav aria-label="Settings" className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-8">
              <div className="flex flex-col overflow-hidden rounded-3xl bg-elevated hairline border-line-tertiary">
                {NAV.map((n, i) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => setPhonePage(n.id)}
                    data-testid={`settings-nav-${n.id}`}
                    className={cn(
                      "flex min-h-[52px] items-center gap-3 px-4 text-start text-[16px] text-fg transition-colors active:bg-hover",
                      i > 0 && "border-t-[0.5px] border-line-tertiary",
                    )}
                  >
                    <Icon icon={n.icon} size="lg" className="text-icon-secondary" />
                    <span className="min-w-0 flex-1 truncate">{n.label}</span>
                    <Icon icon={ChevronRight} size="md" className="text-icon-tertiary" />
                  </button>
                ))}
              </div>
            </nav>
          )}
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={900}
      height={702}
      label="Settings"
      className="bg-chrome"
    >
      <div className="flex min-h-0 flex-1" data-testid="settings-dialog">
        <nav
          aria-label="Settings"
          className="flex w-[200px] shrink-0 flex-col gap-0.5 border-e-[0.5px] border-line-tertiary p-3"
        >
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => setPage(n.id)}
              aria-current={page === n.id ? "page" : undefined}
              data-testid={`settings-nav-${n.id}`}
              className={cn(
                "flex h-8 items-center gap-2 rounded-lg px-2 text-base text-fg transition-colors hover:bg-hover",
                page === n.id && "bg-active hover:bg-active",
              )}
            >
              <Icon icon={n.icon} size="lg" className="text-icon-secondary" />
              {n.label}
            </button>
          ))}
        </nav>
        <div className="relative min-w-0 flex-1">
          <IconButton
            icon={X}
            label="Close settings"
            size={28}
            className="absolute top-4 right-4 z-10"
            onClick={onClose}
          />
          <div
            ref={scrollRef}
            className="h-full overflow-y-auto px-10 pt-6 pb-12 scrollbar-thin"
            data-testid={`settings-page-${page}`}
          >
            <PageBody page={page} />
          </div>
        </div>
      </div>
    </Dialog>
  )
}

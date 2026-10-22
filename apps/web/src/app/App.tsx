// The app: theme sync, routing (selected conversation ↔ #/c/<id>; on a phone also Home ⇄ chat with
// real history entries, uiState.ts / nav.ts), keyboard shortcuts, the shell, the palettes and the
// W2.3 mounts (details pane, computer view, settings, new bot / group forms, onboarding).
import { WifiOff } from "lucide-react"
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from "react"
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import type { BotId } from "@openbot/contracts"
import { connectionAtom, reconnectAtom } from "@openbot/client"
import { Dialog, DialogHeader, Icon, PillButton } from "@openbot/ui"
import { ChatView } from "../chat/ChatView.tsx"
import { NewChatView } from "../chat/NewChat.tsx"
import { SearchPalette } from "../palette/SearchPalette.tsx"
import { SearchView } from "../search/SearchView.tsx"
import { Sidebar } from "../sidebar/Sidebar.tsx"
import { AppShell } from "./AppShell.tsx"
import { ConnectDeviceDialog } from "./ConnectDevice.tsx"
import { useRoster, useSessionInfo, valueOr } from "./data.ts"
import { PaneLoading } from "./fallbacks.tsx"
import { ComputerView, DetailsPane, NewBotForm, NewGroupForm, Onboarding, SettingsDialog } from "./lazy.tsx"
import { isPhoneNow, useLayoutMode, useVisualViewport } from "./layout.ts"
import { useBackDismiss } from "./nav.ts"
import { useSystemNotifications } from "./notifications.ts"
import { parseRoute } from "./route.ts"

import { CallBar } from "../voice/CallBar.tsx"
const ConnectAppsDialog = lazy(() => import("../connections/ConnectAppsDialog.tsx").then((m) => ({ default: m.ConnectAppsDialog })))
import {
  findBarAtom,
  isNewChatHash,
  previousConversationAtom,
  useComputerView,
  useDetailsPane,
  useDialogs,
  usePhoneNav,
  useResolvedTheme,
  useSelection,
  useConnectApps,
  useSettingsDialog,
} from "./uiState.ts"

const COMPACT_KEY = "openbot.sidebar.compact"

/** Browser chrome / status bar tint per theme (the chrome token; index.html has the first-paint value). */
const THEME_COLOR = { dark: "#121212", light: "#fcfcfc" } as const

const useThemeSync = () => {
  const theme = useResolvedTheme()
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      meta.content = THEME_COLOR[theme]
      meta.removeAttribute("media")
    }
    try {
      localStorage.setItem("openbot.theme", theme)
    } catch {}
  }, [theme])
}

function ConnectionBanner(): ReactNode {
  const conn = useAtomValue(connectionAtom)
  const reconnect = useAtomSet(reconnectAtom)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (conn.status !== "offline") return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [conn.status])
  if (conn.status !== "offline" || conn.attempt < 2) return null
  const secs = conn.nextRetryAt ? Math.max(0, Math.ceil((conn.nextRetryAt - now) / 1000)) : 0
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(12px+env(safe-area-inset-top))] z-[3500] flex justify-center">
      <div role="status" className="pointer-events-auto flex animate-rise-in items-center gap-2 rounded-full bg-elevated py-1 ps-3 pe-1 text-sm text-fg hairline border-line-secondary shadow-popover">
        <Icon icon={WifiOff} size="sm" className="text-warn-fg" />
        {secs > 0 ? `Offline. Reconnecting in ${secs}s` : "Reconnecting…"}
        <PillButton size="xs" onClick={() => reconnect(undefined)}>
          Retry now
        </PillButton>
      </div>
    </div>
  )
}

export function App(): ReactNode {
  useThemeSync()
  useVisualViewport()
  const mode = useLayoutMode()
  const phone = mode === "phone"
  const roster = useRoster()
  const info = useSessionInfo()
  const { conversationId, select, search, openSearch, closeSearch } = useSelection()
  const [findBar, setFindBar] = useAtom(findBarAtom)
  const nav = usePhoneNav()
  const details = useDetailsPane()
  const settings = useSettingsDialog()
  const connectApps = useConnectApps()
  const computer = useComputerView()
  const dialogs = useDialogs()
  /** The desktop app's code waiting to be allowed (`#/connect-device?code=…`). */
  const [connectCode, setConnectCode] = useState<string | undefined>()
  useSystemNotifications()
  const [compact, setCompactState] = useState(() => {
    try {
      return localStorage.getItem(COMPACT_KEY) === "1"
    } catch {
      return false
    }
  })
  const setCompact = useCallback((c: boolean) => {
    setCompactState(c)
    try {
      localStorage.setItem(COMPACT_KEY, c ? "1" : "0")
    } catch {}
  }, [])
  const [onboarding, setOnboarding] = useState<"no" | "show" | "done">("no")
  const previous = useAtomValue(previousConversationAtom)
  const pendingBot = useRef<BotId | null>(null)

  // First load: open the most recent conversation unless the URL picked one. A phone starts on Home;
  // a deep link to a chat gets a Home entry under it so Back / swipe-back land on Home.
  // The iPhone app opens pages of this app in a web view: `#/settings/<page>` and
  // `#/computer/<botId>[?control=1]`; the desktop app `#/connect-device?code=…` in the browser
  // (read before the boot below resets the hash on a phone).
  const embedHash = useRef(typeof location === "undefined" ? "" : location.hash)
  useEffect(() => {
    if (!roster.loaded || embedHash.current === "") return
    const hash = embedHash.current
    embedHash.current = ""
    // The desktop app's "Allow this computer" (apps/desktop: it shows the same code).
    const device = /^#\/connect-device\?code=([A-Za-z0-9-]{4,16})/.exec(hash)
    if (device) {
      history.replaceState(null, "", "#/")
      return setConnectCode(device[1]!.toUpperCase())
    }
    const page = /^#\/settings(?:\/([a-z]+))?/.exec(hash)
    if (page) return settings.show((page[1] ?? "general") as Parameters<typeof settings.show>[0])
    const screen = /^#\/computer\/([^/?#]+)(\?control=1)?/.exec(hash)
    if (screen) computer.open(decodeURIComponent(screen[1]!) as BotId, { takeControl: screen[2] !== undefined })
  }, [roster.loaded, settings, computer])

  const booted = useRef(false)
  useEffect(() => {
    if (booted.current || !roster.loaded) return
    booted.current = true
    const deepLink = (conversationId !== null && roster.state.conversations.has(conversationId)) || isNewChatHash() || search !== null
    if (isPhoneNow()) {
      if (deepLink && !nav.home) {
        const hash = location.hash
        history.replaceState(null, "", "#/")
        history.pushState({ ob: "chat" }, "", hash)
      } else if (!nav.home) {
        nav.setHome(true)
        history.replaceState(null, "", "#/")
      }
      return
    }
    if (deepLink) return
    const firstPinned = roster.bots.find((b) => b.pinned && !b.hidden)
    const recent = [...roster.state.conversations.values()].filter((c) => !c.hiddenFromSidebar).sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]
    const target = firstPinned?.directConversationId ?? recent?.id
    if (target) select(target)
  }, [roster.loaded, roster.bots, roster.state.conversations, conversationId, select, nav, search])

  // A Bot created before its roster upsert arrived: open its chat as soon as it shows up.
  useEffect(() => {
    const id = pendingBot.current
    const bot = id ? roster.botById(id) : undefined
    if (bot) {
      pendingBot.current = null
      select(bot.directConversationId)
    }
  }, [roster, select])

  // A removed conversation (deleted bot or group) falls back to the previous conversation, else the
  // most recent one, else the new-chat view.
  useEffect(() => {
    if (roster.loaded && conversationId && booted.current && !roster.state.conversations.has(conversationId)) {
      const t = setTimeout(() => {
        if (isPhoneNow()) {
          if (!nav.home) nav.back()
          return
        }
        const recent = [...roster.state.conversations.values()]
          .filter((c) => !c.hiddenFromSidebar)
          .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]
        const back = previous !== null && previous !== conversationId && roster.state.conversations.has(previous) ? previous : recent?.id
        select(back ?? null)
      }, 600)
      return () => clearTimeout(t)
    }
    return undefined
  }, [roster.loaded, roster.state.conversations, conversationId, select, previous, nav])

  // Back/forward and manual hash edits. On a phone, a hash that is not a chat screen is Home.
  useEffect(() => {
    const on = () => {
      const route = parseRoute(location.hash)
      if (route.kind === "chat") return select(route.conversationId, { entryId: route.entryId, openExchange: true })
      if (route.kind === "search") return openSearch(route.filters)
      if (isPhoneNow() && route.kind !== "new") return nav.setHome(true)
      select(null)
    }
    window.addEventListener("hashchange", on)
    return () => window.removeEventListener("hashchange", on)
  }, [select, openSearch, nav])

  // Keyboard shortcuts: Cmd/Ctrl+K search, Cmd/Ctrl+F find in the open chat, Cmd/Ctrl+N new chat,
  // Cmd/Ctrl+B compact sidebar, Cmd/Ctrl+, settings, Esc closes the top-most surface (dialogs handle
  // their own Esc first).
  const chatOnScreen = conversationId !== null && search === null && !(phone && nav.home)
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (mod && !e.shiftKey && !e.altKey && key === "f") {
        // Only while a chat is the main view and nothing covers it; elsewhere the browser finds.
        if (!chatOnScreen || conversationId === null || dialogs.dialog || settings.open || connectApps.open || computer.botId || document.querySelector('[role="dialog"]')) return
        e.preventDefault()
        setFindBar({ conversationId, nonce: (findBar?.nonce ?? 0) + 1 })
      } else if (mod && !e.shiftKey && !e.altKey && key === "k") {
        e.preventDefault()
        if (dialogs.dialog?.kind === "search") dialogs.hide()
        else dialogs.show({ kind: "search" })
      } else if (mod && !e.shiftKey && !e.altKey && key === "n") {
        e.preventDefault()
        dialogs.hide()
        select(null)
      } else if (mod && !e.shiftKey && !e.altKey && key === "b") {
        e.preventDefault()
        setCompact(!compact)
      } else if (mod && key === ",") {
        e.preventDefault()
        settings.show()
      } else if (e.key === "Escape" && !e.defaultPrevented) {
        if (dialogs.dialog || settings.open) return
        if (computer.botId) computer.close()
        else if (findBar !== null && findBar.conversationId === conversationId && chatOnScreen) setFindBar(null)
        else if (search !== null) closeSearch()
        else if (details.open) details.hide()
        else if (conversationId === null && previous) select(previous)
      }
    }
    window.addEventListener("keydown", on)
    return () => window.removeEventListener("keydown", on)
  }, [dialogs, select, setCompact, compact, settings, computer, details, conversationId, previous, chatOnScreen, connectApps.open, findBar, setFindBar, search, closeSearch])

  // Phone sheets own a history entry: Back / swipe-back closes them (nav.ts).
  const dialog = dialogs.dialog
  useBackDismiss(details.open && conversationId !== null && !nav.home, details.hide, "details")
  useBackDismiss(dialog !== null, dialogs.hide, "dialog")
  useBackDismiss(settings.open, settings.hide, "settings")

  const summary = conversationId ? roster.state.conversations.get(conversationId) : undefined
  // A group's pane shows the group, unless a member bot was asked for (its "Handling…" line → Tasks).
  const detailsBotId = details.botId !== undefined && summary?.botIds.includes(details.botId)
    ? details.botId
    : summary && summary.kind !== "group" ? (summary.botIds[0] as BotId | undefined) : undefined

  // Onboarding is sticky: once shown it stays until onDone, even after it creates the first Bot.
  const firstRun = valueOr(info, undefined)?.firstRun === true
  const needsOnboarding = roster.loaded && firstRun && roster.bots.length === 0
  if (needsOnboarding && onboarding === "no") setOnboarding("show")
  if (onboarding === "show") {
    return (
      <Suspense fallback={<PaneLoading />}>
        <Onboarding
          onDone={(botId) => {
            setOnboarding("done")
            // The Bot created in onboarding: open its DM (now, or once its roster upsert arrives).
            const bot = botId ? roster.botById(botId) : undefined
            if (bot) return select(bot.directConversationId)
            if (botId) {
              pendingBot.current = botId
              return
            }
            const recent = [...roster.state.conversations.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]
            if (recent) select(recent.id)
          }}
        />
      </Suspense>
    )
  }

  const newChatClose = phone ? nav.back : previous ? () => select(previous) : undefined
  return (
    <>
      <AppShell
        compact={compact}
        onCompactChange={setCompact}
        home={nav.home}
        onCloseDetails={details.hide}
        sidebar={({ compact: c, toggleCompact }) => (
          <Sidebar compact={c} onToggleCompact={toggleCompact} onSearch={() => dialogs.show({ kind: "search" })} onNewChat={() => select(null)} />
        )}
        chat={
          <>
            {search !== null ? (
              <SearchView filters={search} onClose={phone ? nav.back : closeSearch} />
            ) : conversationId ? (
              <ChatView key={conversationId} conversationId={conversationId} />
            ) : (
              <NewChatView onClose={newChatClose} />
            )}
            <CallBar />
          </>
        }
        details={
          details.open && conversationId && search === null ? (
            <Suspense fallback={<PaneLoading />}>
              <DetailsPane key={conversationId} {...(detailsBotId ? { botId: detailsBotId } : {})} conversationId={conversationId} tab={details.tab} onClose={details.hide} />
            </Suspense>
          ) : null
        }
        overlay={
          computer.botId ? (
            <Suspense fallback={<PaneLoading className="bg-[rgba(20,20,20,.95)]" />}>
              <ComputerView key={computer.botId} botId={computer.botId} onClose={computer.close} />
            </Suspense>
          ) : undefined
        }
      />
      {connectCode !== undefined && <ConnectDeviceDialog code={connectCode} onClose={() => setConnectCode(undefined)} />}
      <SearchPalette open={dialog?.kind === "search"} onOpenChange={(o) => (o ? dialogs.show({ kind: "search" }) : dialogs.hide())} onToggleCompact={() => setCompact(!compact)} />
      <Dialog open={dialog?.kind === "new-bot"} onOpenChange={(o) => !o && dialogs.hide()} width={480} label="New Bot" className="ob-phone-full">
        <DialogHeader title="New Bot" onClose={dialogs.hide} />
        {dialog?.kind === "new-bot" && (
          <Suspense fallback={<PaneLoading className="h-40" />}>
            <NewBotForm
              {...(dialog.name ? { initialName: dialog.name } : {})}
              onCancel={dialogs.hide}
              onCreated={(botId) => {
                dialogs.hide()
                const bot = roster.botById(botId)
                if (bot) select(bot.directConversationId)
                else pendingBot.current = botId
              }}
            />
          </Suspense>
        )}
      </Dialog>
      <Dialog open={dialog?.kind === "new-group"} onOpenChange={(o) => !o && dialogs.hide()} width={480} label="New group chat" className="ob-phone-full">
        <DialogHeader title="New group chat" onClose={dialogs.hide} />
        {dialog?.kind === "new-group" && (
          <Suspense fallback={<PaneLoading className="h-40" />}>
            <NewGroupForm
              {...(dialog.botIds ? { initialBotIds: dialog.botIds } : {})}
              onCancel={dialogs.hide}
              onCreated={(id) => {
                dialogs.hide()
                select(id)
              }}
            />
          </Suspense>
        )}
      </Dialog>
      {settings.open && (
        <Suspense fallback={null}>
          <SettingsDialog open={settings.open} initialPage={settings.page} onClose={settings.hide} />
        </Suspense>
      )}
      {connectApps.open && (
        <Suspense fallback={null}>
          <ConnectAppsDialog key={JSON.stringify(connectApps.view)} open view={connectApps.view} onClose={connectApps.hide} />
        </Suspense>
      )}
      <ConnectionBanner />
    </>
  )
}

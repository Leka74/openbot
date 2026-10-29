// System notifications for what the brain notifies (roster `notification` changes: a Bot finished,
// needs you, wrote to you, a routine ran, something failed), and the desktop app's unread badge.
//
// In the desktop app (apps/desktop) they are on unless turned off and become the computer's own
// notifications; in a browser they are opt-in (Settings › General) and need the browser's permission.
// A notification for the chat you are looking at is not shown; clicking one opens its chat. It carries
// the Bot's avatar as its icon (botIcon.ts).
import { useAtomSet } from "@effect/atom-react"
import { commands } from "@openbot/client"
import type { ConversationId, Notification as RosterNotification } from "@openbot/contracts"
import { useEffect, useRef, useSyncExternalStore } from "react"
import { botIconUrl } from "./botIcon.ts"
import { useRoster } from "./data.ts"
import { useSelection } from "./uiState.ts"

/** `window.openbotDesktop`, set by the desktop app's preload (apps/desktop/src/preload.ts). */
export interface DesktopBridge {
  readonly version: string
  readonly platform: string
  readonly setBadgeCount: (count: number) => void
  readonly focus: () => void
  readonly signOut: () => void
  // updates (desktopUpdate.ts); absent in copies of the app from before updates existed
  readonly build?: string
  readonly updateState?: () => Promise<unknown>
  readonly onUpdate?: (listener: (state: unknown) => void) => () => void
  readonly checkForUpdates?: () => Promise<unknown>
  readonly installUpdate?: () => void
  /** Whether the owner is using this computer ("active" | "idle" | "locked" | "unknown"); absent in older copies. */
  readonly idleState?: () => Promise<string>
  /** The quick send panel's controls (apps/desktop/src/quickSend.ts); absent in older copies. */
  readonly quickSend?: {
    readonly prefill: () => Promise<unknown>
    readonly onPrefill: (listener: (prefill: unknown) => void) => () => void
    readonly resize: (height: number) => void
    readonly close: () => void
    readonly screenshot: () => Promise<unknown>
    readonly info: () => Promise<unknown>
    readonly installShortcut: () => Promise<unknown>
  }
}

/** What the desktop app's quick send panel opens with (apps/desktop/src/quickSend.ts). */
export interface QuickSendPrefill {
  readonly id: number
  readonly link?: { readonly url: string; readonly title?: string; readonly from?: string }
  readonly text?: string
  readonly clipboard?: { readonly text?: string; readonly image?: string }
  readonly to?: string
}

export const desktopApp = (): DesktopBridge | undefined =>
  (globalThis as { openbotDesktop?: DesktopBridge }).openbotDesktop

const KEY = "openbot.notifications"
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((listener) => listener())

export const notificationsSupported = (): boolean => typeof Notification !== "undefined"

export const notificationsEnabled = (): boolean => {
  if (!notificationsSupported()) return false
  const pref = localStorage.getItem(KEY)
  if (desktopApp() !== undefined) return pref !== "off"
  return pref === "on" && Notification.permission === "granted"
}

/** Turns them on (asking the browser's permission first) or off; the result is what took effect. */
export const setNotificationsEnabled = async (on: boolean): Promise<boolean> => {
  if (on && desktopApp() === undefined && Notification.permission !== "granted") {
    if ((await Notification.requestPermission()) !== "granted") on = false
  }
  localStorage.setItem(KEY, on ? "on" : "off")
  changed()
  return on
}

export const useNotificationsEnabled = (): boolean =>
  useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }, notificationsEnabled)

/** How often the desktop app tells the brain the owner is using this computer (presence.ts on the brain). */
const PRESENCE_EVERY_MS = 30_000

/**
 * Mounted once (App): in the desktop app with notifications on, tells the brain every 30 s while the
 * owner is using this computer, so Hark does not push the same notifications to their phone.
 */
export function useDesktopPresence(): void {
  const report = useAtomSet(commands["presence.active"])
  useEffect(() => {
    const idleState = desktopApp()?.idleState
    if (idleState === undefined) return
    const tick = () => {
      if (!notificationsEnabled()) return
      void idleState()
        .then((state) => {
          if (state === "active") report(undefined as never)
        })
        .catch(() => {})
    }
    tick()
    const timer = setInterval(tick, PRESENCE_EVERY_MS)
    return () => clearInterval(timer)
  }, [report])
}

/** A Bot that needs you stays on screen until dismissed (not on macOS: there only the Alerts style does that). */
export const notificationOptions = (n: RosterNotification, icon: string | undefined): NotificationOptions => ({
  body: n.body,
  tag: n.conversationId ?? n.id,
  requireInteraction: n.kind === "waiting",
  ...(icon === undefined ? {} : { icon }),
})

const onScreen = new Set<Notification>()

/** Closes the notifications this page put on screen (switching profiles, profiles.ts). */
export const closeShownNotifications = (): void => onScreen.forEach((shown) => shown.close())

/** Mounted once (App): shows new notifications and keeps the desktop app's badge current. */
export function useSystemNotifications(): void {
  const roster = useRoster()
  const { conversationId, select } = useSelection()
  const seen = useRef<Set<string> | undefined>(undefined)
  const view = useRef<{
    readonly conversationId: ConversationId | null
    readonly select: (id: ConversationId) => void
  }>({ conversationId, select })
  useEffect(() => {
    view.current = { conversationId, select }
  }, [conversationId, select])

  const notifications = roster.state.notifications
  useEffect(() => {
    if (!roster.loaded) return
    // What the roster already held when this page opened was notified before.
    if (seen.current === undefined) {
      seen.current = new Set(notifications.map((n) => n.id))
      return
    }
    for (const n of [...notifications].reverse()) {
      if (seen.current.has(n.id)) continue
      seen.current.add(n.id)
      if (!notificationsEnabled()) continue
      const looking =
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        n.conversationId !== undefined &&
        n.conversationId === view.current.conversationId
      if (looking) continue
      const bot = n.botId === undefined ? undefined : roster.botById(n.botId)
      void (bot === undefined ? Promise.resolve(undefined) : botIconUrl(bot.avatar)).then((icon) => {
        const shown = new Notification(n.title, notificationOptions(n, icon))
        onScreen.add(shown)
        shown.onclose = () => onScreen.delete(shown)
        shown.onclick = () => {
          desktopApp()?.focus()
          window.focus()
          if (n.conversationId !== undefined) view.current.select(n.conversationId)
          shown.close()
        }
      })
    }
  }, [notifications, roster])

  const unread = [...roster.state.conversations.values()].filter(
    (c) => !c.hiddenFromSidebar && c.unreadCount > 0,
  ).length
  useEffect(() => {
    desktopApp()?.setBadgeCount(unread)
  }, [unread])
}

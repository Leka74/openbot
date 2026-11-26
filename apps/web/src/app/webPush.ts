// "Push to this device" (Settings › General): the brain's Web Push (apps/server/src/webPush.ts), shown by
// the service worker it serves at /sw.js, so notifications arrive with OpenBot closed, also on an iPhone
// with OpenBot on its Home Screen. The brain keeps a subscription while the session that made it is
// signed in, so each start sends it again (signing in anew keeps it coming).
import { useSyncExternalStore } from "react"

/** iOS has Web Push only in an app added to the Home Screen; a Safari tab has no `PushManager`. */
export type PushSupport = "supported" | "home-screen" | "unsupported"

export const pushSupport = (): PushSupport => {
  if (typeof PushManager !== "undefined" && "serviceWorker" in navigator) return "supported"
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ? "home-screen" : "unsupported"
}

let subscribed = false
const listeners = new Set<() => void>()
const setSubscribed = (on: boolean) => {
  subscribed = on
  listeners.forEach((listener) => listener())
}

/** Whether this browser gets the brain's pushes (then it shows no notifications of its own). */
export const pushSubscribed = (): boolean => subscribed

const subscription = async () =>
  (await navigator.serviceWorker.getRegistration("/"))?.pushManager.getSubscription() ?? null

const send = async (method: "POST" | "DELETE", body: unknown) => {
  const res = await fetch("/api/push/subscription", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`OpenBot answered ${res.status}.`)
}

/** Reads this browser's subscription and gives it to the brain again. */
export const refreshPush = async (): Promise<void> => {
  const current = await subscription()
  setSubscribed(current !== null)
  if (current !== null) await send("POST", current.toJSON())
}

/** Turns push on (asking the permission first: iOS asks only from a tap); false when it was refused. */
export const enablePush = async (): Promise<boolean> => {
  if ((await Notification.requestPermission()) !== "granted") return false
  await navigator.serviceWorker.register("/sw.js")
  const registration = await navigator.serviceWorker.ready
  const key = await fetch("/api/push/key")
  if (!key.ok) throw new Error(`OpenBot answered ${key.status}.`)
  const { publicKey } = (await key.json()) as { readonly publicKey: string }
  const created = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    ),
  })
  await send("POST", created.toJSON())
  setSubscribed(true)
  return true
}

export const disablePush = async (): Promise<void> => {
  const current = await subscription()
  if (current !== null) {
    await send("DELETE", { endpoint: current.endpoint })
    await current.unsubscribe()
  }
  setSubscribed(false)
}

export const usePushSubscribed = (): boolean =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    pushSubscribed,
    pushSubscribed,
  )

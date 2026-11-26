// "Notifications on this device" (Settings › General) with push (app/webPush.ts): the row's states (no
// push in this browser: in-page, an iPhone outside the Home Screen, off, on, on with only the in-page
// ones), and a subscription the browser already has is given to the brain again when OpenBot starts.
import { afterEach, describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { notificationsEnabled } from "../src/app/notifications.ts"
import { pushSubscribed, pushSupport, refreshPush } from "../src/app/webPush.ts"
import { NotificationsRow } from "../src/settings/DesktopApp.tsx"

const original = { navigator: globalThis.navigator, fetch: globalThis.fetch, localStorage: globalThis.localStorage }

const browser = (options: {
  readonly userAgent: string
  readonly push: boolean
  readonly subscription?: { readonly endpoint: string } | null
}) => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: options.userAgent,
      ...(options.push && {
        serviceWorker: {
          getRegistration: async () => ({
            pushManager: {
              getSubscription: async () =>
                options.subscription == null
                  ? null
                  : {
                      ...options.subscription,
                      toJSON: () => ({ ...options.subscription, keys: { p256dh: "BCVx", auth: "BTBZ" } }),
                    },
            },
          }),
        },
      }),
    },
  })
  if (options.push) Object.assign(globalThis, { PushManager: class {} })
  else delete (globalThis as { PushManager?: unknown }).PushManager
}

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1"
const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36"

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: original.navigator })
  globalThis.fetch = original.fetch
  delete (globalThis as { PushManager?: unknown }).PushManager
  delete (globalThis as { Notification?: unknown }).Notification
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original.localStorage })
})

describe("Notifications on this device, with push", () => {
  test("an iPhone outside the Home Screen is told to add OpenBot there", () => {
    browser({ userAgent: IPHONE, push: false })
    expect(pushSupport()).toBe("home-screen")
    const html = renderToStaticMarkup(<NotificationsRow />)
    expect(html).toContain("add OpenBot to your Home Screen first")
    expect(html).toContain("even when OpenBot is closed")
    expect(html).toMatch(/role="switch"[^>]* disabled=""/)
  })

  test("a browser without push has the in-page notifications", () => {
    browser({ userAgent: CHROME, push: false })
    expect(pushSupport()).toBe("unsupported")
    const html = renderToStaticMarkup(<NotificationsRow />)
    expect(html).toContain("while OpenBot is open in this browser")
    expect(html).not.toContain("even when OpenBot is closed")
  })

  test("off, then on once the browser's subscription is given to the brain again", async () => {
    const posted: Array<{ method: string; body: unknown }> = []
    globalThis.fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        posted.push({ method: String(init?.method), body: JSON.parse(String(init?.body)) })
        return new Response(null, { status: 204 })
      },
      { preconnect: original.fetch.preconnect },
    )
    browser({ userAgent: IPHONE, push: true, subscription: null })
    expect(pushSupport()).toBe("supported")
    await refreshPush()
    expect(pushSubscribed()).toBe(false)
    expect(posted).toEqual([])
    const off = renderToStaticMarkup(<NotificationsRow />)
    expect(off).toContain('aria-checked="false"')
    expect(off).toContain("even when OpenBot is closed")
    expect(off).not.toMatch(/role="switch"[^>]* disabled=""/)

    browser({ userAgent: IPHONE, push: true, subscription: { endpoint: "https://web.push.apple.com/abc" } })
    await refreshPush()
    expect(pushSubscribed()).toBe(true)
    expect(posted).toEqual([
      { method: "POST", body: { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "BCVx", auth: "BTBZ" } } },
    ])
    const html = renderToStaticMarkup(<NotificationsRow />)
    expect(html).toContain('aria-checked="true"')
    expect(html).not.toContain("Home Screen first")
  })

  test("not subscribed, it reads on while the in-page notifications are on (subscribing failed)", async () => {
    browser({ userAgent: CHROME, push: true, subscription: null })
    await refreshPush()
    Object.assign(globalThis, { Notification: { permission: "granted" } })
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: (key: string) => (key === "openbot.notifications" ? "on" : null) },
    })
    expect(pushSubscribed()).toBe(false)
    expect(notificationsEnabled()).toBe(true)
    expect(renderToStaticMarkup(<NotificationsRow />)).toContain('aria-checked="true"')
  })
})

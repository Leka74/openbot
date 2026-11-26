// Settings › General › Apps: the desktop app (built for your computer by this OpenBot,
// `/desktop/download/<target>`, or installed from a terminal with `/desktop/install.sh`) and
// notifications on this device.
import { PillButton, Switch } from "@openbot/ui"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { type DesktopUpdateState, updateReady, useDesktopUpdate } from "../app/desktopUpdate.ts"
import {
  desktopApp,
  notificationsSupported,
  pushHere,
  setNotificationsEnabled,
  useNotificationsEnabled,
} from "../app/notifications.ts"
import { disablePush, enablePush, pushSupport, usePushSubscribed } from "../app/webPush.ts"
import { CommandBlock } from "../details/kit.tsx"
import { SettingsRow } from "./layout.tsx"

type Target = "darwin-arm64" | "darwin-x64" | "win32-x64" | "linux-x64" | "linux-arm64"

const TARGETS: ReadonlyArray<{ readonly id: Target; readonly label: string }> = [
  { id: "darwin-arm64", label: "macOS (Apple silicon)" },
  { id: "darwin-x64", label: "macOS (Intel)" },
  { id: "win32-x64", label: "Windows" },
  { id: "linux-x64", label: "Linux" },
  { id: "linux-arm64", label: "Linux (ARM)" },
]

/** Best guess from the browser (Safari reports every Mac as Intel: Apple silicon is the likely one). */
const guessTarget = (): Target => {
  const ua = navigator.userAgent
  if (/Mac/.test(ua)) return "darwin-arm64"
  if (/Windows/.test(ua)) return "win32-x64"
  return /aarch64|arm64/i.test(ua) ? "linux-arm64" : "linux-x64"
}

const href = (target: Target) => `/desktop/download/${target}`

const checkResult = (state: DesktopUpdateState | undefined): string => {
  if (state === undefined) return ""
  if (updateReady(state)) return "A new version is ready: restart with the button in the sidebar."
  if (state.status === "downloading") return "A new version is downloading."
  if (state.status === "error") return `Couldn't check for updates: ${state.message}`
  return "OpenBot is up to date."
}

/** In the desktop app: its version, and a check for updates (it also checks by itself). */
function RunningApp({ version }: { readonly version: string }): ReactNode {
  const update = useDesktopUpdate()
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<string | undefined>()
  const check = async () => {
    setChecking(true)
    setResult(checkResult(await update.check()))
    setChecking(false)
  }
  return (
    <SettingsRow
      title="Desktop app"
      description={
        update.supported
          ? `Version ${version}. It updates itself from this OpenBot, and keeps running when you close its window so notifications keep coming.`
          : `Version ${version}. Install it once more (below) to get automatic updates from now on.`
      }
      wide
      control={
        update.supported ? (
          <PillButton
            variant="secondary"
            size="md"
            loading={checking}
            onClick={() => void check()}
            data-testid="desktop-check-updates"
          >
            Check for updates
          </PillButton>
        ) : undefined
      }
    >
      {result && <p className="pt-2 text-sm text-fg-secondary">{result}</p>}
      {!update.supported && desktopApp()?.platform !== "win32" && (
        <div className="pt-2">
          <CommandBlock command={`curl -fsSL ${location.origin}/desktop/install.sh | sh`} />
        </div>
      )}
    </SettingsRow>
  )
}

export function DesktopAppRow(): ReactNode {
  const running = desktopApp()
  if (running !== undefined) return <RunningApp version={running.version} />
  return <DownloadApp />
}

function DownloadApp(): ReactNode {
  const [target] = useState(guessTarget)
  const primary = TARGETS.find((t) => t.id === target)!
  const others = TARGETS.filter((t) => t.id !== target)
  const unix = !target.startsWith("win32")
  return (
    <SettingsRow
      title="Desktop app"
      description="OpenBot in its own window, with notifications on your computer. It keeps running when you close the window, and updates itself."
      wide
      control={
        // an attachment: the page stays where it is
        <PillButton
          variant="secondary"
          size="md"
          onClick={() => window.location.assign(href(target))}
          data-testid="desktop-download"
        >
          Download for {primary.label}
        </PillButton>
      }
    >
      <div className="flex flex-col gap-2 pt-2 text-sm text-fg-secondary">
        <span>
          Also for{" "}
          {others.map((t, i) => (
            <span key={t.id}>
              <a className="text-fg underline-offset-2 hover:underline" href={href(t.id)} download>
                {t.label}
              </a>
              {i < others.length - 1 ? ", " : ""}
            </span>
          ))}
          . The first download for a computer takes about a minute to prepare.
        </span>
        {unix && (
          <>
            <span>
              Or install it from a terminal
              {target.startsWith("darwin") ? " (on a Mac this skips the security prompt below)" : ""}:
            </span>
            <CommandBlock command={`curl -fsSL ${location.origin}/desktop/install.sh | sh`} />
          </>
        )}
        {target.startsWith("darwin") && (
          <span>
            Downloaded with the browser, macOS asks once before the first start: open System Settings › Privacy &amp;
            Security and click Open Anyway next to OpenBot.
          </span>
        )}
      </div>
    </SettingsRow>
  )
}

/** A bookmark that opens quick send for the page it is clicked on (`#/quick-send?url=…` in a popup). */
export const bookmarkletCode = (origin: string): string =>
  `javascript:(()=>{const q=new URLSearchParams({url:location.href,title:document.title});const s=String(getSelection()||'').trim();if(s)q.set('text',s);open(${JSON.stringify(`${origin}/#/quick-send?`)}+q,'openbot-quick-send','popup,width=660,height=460')})()`

const MANUAL_SHORTCUT = [
  "Open Shortcuts and make a new Shortcut named Send to OpenBot.",
  "In its details (ⓘ), turn on Show in Share Sheet and Use as Quick Action › Services Menu; receive Text and URLs.",
  "Add URL Encode (input: Shortcut Input), then Open URLs with openbot://send?text= followed by the URL Encoded Text.",
]

/** Quick send: the shortcut and the Share menu in the desktop app, the bookmarklet everywhere. */
export function QuickSendRow(): ReactNode {
  const bridge = desktopApp()?.quickSend
  const [info, setInfo] = useState<
    { readonly shortcut: string; readonly registered: boolean; readonly platform: string } | undefined
  >()
  const [shortcut, setShortcut] = useState<
    { readonly state: "idle" | "busy" | "done" } | { readonly state: "error"; readonly message: string }
  >({ state: "idle" })
  const bookmarklet = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    void bridge?.info().then((i) => setInfo(i as typeof info))
  }, [bridge])
  useEffect(() => {
    // set here: React refuses `javascript:` links in JSX
    bookmarklet.current?.setAttribute("href", bookmarkletCode(location.origin))
  }, [])
  const addToShareMenu = async () => {
    setShortcut({ state: "busy" })
    const result = (await bridge?.installShortcut()) as { ok?: boolean; error?: string } | undefined
    setShortcut(
      result?.ok ? { state: "done" } : { state: "error", message: result?.error ?? "Shortcuts did not take it." },
    )
  }
  const mac = info?.platform === "darwin"
  return (
    <SettingsRow
      title="Quick send"
      description={
        bridge === undefined
          ? "Send the page you're on to a Bot from any browser: drag the button below to your bookmarks bar, then click it on a page (select text first to send that too)."
          : `Press ${info?.shortcut ?? "the shortcut"} anywhere to send what you're looking at to a Bot: the page open in your browser, something you just copied, or a screenshot.${mac ? " OpenBot asks once to read each browser's page." : ""}`
      }
      wide
      control={
        mac ? (
          <PillButton
            variant="secondary"
            size="md"
            loading={shortcut.state === "busy"}
            onClick={() => void addToShareMenu()}
            data-testid="quick-send-share-menu"
          >
            Add to the Share menu
          </PillButton>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-2 pt-2 text-sm text-fg-secondary">
        {shortcut.state === "done" && (
          <span>
            Click Add Shortcut in the window that opened. Then use Share › Send to OpenBot, or select text and
            right-click › Services › Send to OpenBot.
          </span>
        )}
        {shortcut.state === "error" && (
          <span className="flex flex-col gap-1">
            <span>Shortcuts didn't take it ({shortcut.message}). It takes a minute by hand:</span>
            {MANUAL_SHORTCUT.map((step, i) => (
              <span key={step}>
                {i + 1}. {step}
              </span>
            ))}
          </span>
        )}
        {bridge !== undefined && info !== undefined && (info.platform === "linux" || !info.registered) && (
          <span>
            {info.registered ? "Or bind" : "Your desktop didn't let OpenBot add the shortcut: bind"} a key to{" "}
            <code className="font-mono text-fg">openbot-desktop --quick-send</code>
            {info.platform === "linux" ? (
              <>
                {" "}
                (Hyprland:{" "}
                <code className="font-mono text-fg">bind = SUPER ALT, O, exec, openbot-desktop --quick-send</code>)
              </>
            ) : null}
            .
          </span>
        )}
        {bridge !== undefined && (
          <span>
            Raycast, Alfred and other tools can open <code className="font-mono text-fg">openbot://send?text=…</code>{" "}
            (also <code className="font-mono text-fg">url</code>, <code className="font-mono text-fg">to</code>).
          </span>
        )}
        <span className="flex flex-wrap items-center gap-2">
          {bridge !== undefined && <span>In any browser:</span>}
          <a
            ref={bookmarklet}
            className="inline-flex items-center rounded-full bg-elevated-hover px-3 py-1 font-medium text-fg"
            onClick={(e) => e.preventDefault()}
            draggable
            data-testid="quick-send-bookmarklet"
          >
            Send to OpenBot
          </a>
          <span>drag it to your bookmarks bar.</span>
        </span>
      </div>
    </SettingsRow>
  )
}

const BLOCKED =
  "This browser blocked notifications for OpenBot. Allow them in its site settings, then turn this on again."

/** In the desktop app its own notifications; in a browser that has push the brain's pushes; otherwise in-page. */
export function NotificationsRow(): ReactNode {
  if (desktopApp() === undefined && pushSupport() !== "unsupported") return <PushRow />
  return <InPageRow />
}

function InPageRow(): ReactNode {
  const enabled = useNotificationsEnabled()
  const [denied, setDenied] = useState(false)
  const inApp = desktopApp() !== undefined
  const supported = notificationsSupported()
  return (
    <SettingsRow
      title="Notifications on this device"
      description={
        inApp
          ? "Show your Bots' updates as notifications on this computer: when they finish, need you or write to you."
          : "Show your Bots' updates as notifications while OpenBot is open in this browser. The desktop app shows them even when its window is closed."
      }
      control={
        <Switch
          checked={enabled}
          disabled={!supported}
          onCheckedChange={(on) => void setNotificationsEnabled(on).then((took) => setDenied(on && !took))}
          label="Notifications on this device"
        />
      }
    >
      {denied && <p className="pt-2 text-sm text-warn-fg">{BLOCKED}</p>}
      {desktopApp()?.platform === "darwin" && (
        <div className="flex flex-wrap items-center gap-2 pt-2 text-sm text-fg-secondary">
          <span>macOS hides them after a few seconds. Choose Alerts in System Settings to keep them on screen.</span>
          {/* the desktop app opens other links with the system (main.ts setWindowOpenHandler) */}
          <PillButton
            variant="secondary"
            size="md"
            onClick={() => window.open("x-apple.systempreferences:com.apple.preference.notifications")}
            data-testid="notifications-system-settings"
          >
            Open System Settings
          </PillButton>
        </div>
      )}
    </SettingsRow>
  )
}

/** The brain's pushes (webPush.ts); an iPhone has them only in OpenBot added to its Home Screen. */
function PushRow(): ReactNode {
  const on = usePushSubscribed()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const toggle = (next: boolean) => {
    setBusy(true)
    setProblem(undefined)
    void (next ? enablePush() : disablePush().then(() => true))
      .then((took) => {
        if (!took) setProblem(BLOCKED)
      })
      .catch((error: unknown) =>
        setProblem(
          `Couldn't turn them ${next ? "on" : "off"}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .finally(() => setBusy(false))
  }
  return (
    <SettingsRow
      title="Notifications on this device"
      description="Get your Bots' updates here even when OpenBot is closed: when they finish, need you or write to you. None arrive while you're using the desktop app."
      control={
        <Switch
          checked={on}
          disabled={!pushHere() || busy}
          onCheckedChange={toggle}
          label="Notifications on this device"
        />
      }
    >
      {!pushHere() && (
        <p className="pt-2 text-sm text-fg-secondary" data-testid="push-home-screen">
          On iPhone, add OpenBot to your Home Screen first: tap Share, then Add to Home Screen, and open it from there.
        </p>
      )}
      {problem !== undefined && <p className="pt-2 text-sm text-warn-fg">{problem}</p>}
    </SettingsRow>
  )
}

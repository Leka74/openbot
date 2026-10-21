/**
 * OpenBot desktop app (Electron main process): the owner's OpenBot in its own window, with the
 * computer's own notifications and a dock / taskbar badge.
 *
 * - The brain that built this copy baked its address into `openbot.json` (apps/server/src/desktop.ts),
 *   so there is nothing to set up.
 * - Connecting: the first start asks the brain for a device code and opens the owner's browser on
 *   OpenBot's "Allow this computer" page (`/#/connect-device?code=…`); once allowed, the app gets a
 *   session of its own (an app code traded at `/api/auth/app-login`, kept in the OS keychain when
 *   there is one). Every start trades that session for a one-time web code that signs the window in
 *   (`/api/auth/login?code=…`), so the window's cookie never expires while the app is used.
 * - Closing the window keeps the app running (tray on Linux and Windows, dock on macOS) so
 *   notifications keep arriving; Quit ends it.
 * - The page is the web app itself (always the brain's current version); links to other sites open
 *   in the browser.
 * - The app itself updates from the brain (update.ts): checked at start, every few hours and on
 *   wake; a new build downloads in the background and the web app offers "Restart to update".
 * - Quick send (quickSend.ts): ⌥⌘O / Ctrl+Alt+O, `openbot://send?…` links and `--quick-send` open a
 *   small panel to send the page in the browser, a copy or a screenshot to a Bot.
 */
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, safeStorage, session, shell, Tray } from "electron"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { permits } from "./permissions.ts"
import { makeQuickSend, prefillOfLink } from "./quickSend.ts"
import { makeUpdater, type UpdateState } from "./update.ts"

interface Baked {
  /** `https://host[:port]` of the brain that built this copy. */
  readonly origin: string
  readonly version: string
  /** The build's id (`/desktop/latest` names the current one: a different one is an update). */
  readonly build?: string
}

/** The app's own folder (`__dirname` would be fixed to the source folder by the bundler). */
const appDir = app.getAppPath()
const baked = JSON.parse(readFileSync(join(appDir, "openbot.json"), "utf8")) as Baked
const origin = baked.origin.replace(/\/+$/, "")
const host = new URL(origin).host
const isMac = process.platform === "darwin"

app.setName("OpenBot")
if (process.platform === "win32") app.setAppUserModelId("com.leka74.openbot.desktop")
if (!app.requestSingleInstanceLock()) app.quit()

let win: BrowserWindow | undefined
let tray: Tray | undefined
let quitting = false
/** The window shows the signed-in web app (quick send needs its session). */
let signedIn = false

// ---------------------------------------------------------------------------- the app's session

const sessionFile = () => join(app.getPath("userData"), "session")

const loadSession = (): string | undefined => {
  try {
    const raw = readFileSync(sessionFile())
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString("utf8")
  } catch {
    return undefined
  }
}

const saveSession = (token: string) => {
  mkdirSync(app.getPath("userData"), { recursive: true })
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token) : Buffer.from(token, "utf8")
  writeFileSync(sessionFile(), data, { mode: 0o600 })
}

const forgetSession = () => rmSync(sessionFile(), { force: true })

const post = async (path: string, body?: unknown, token?: string) => {
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

/** Signs the window in with the app's session (a one-time web code): false when the session is gone. */
const openApp = async (token: string, page = "#/"): Promise<boolean> => {
  const minted = await post("/api/auth/web-code", undefined, token)
  if (minted.status === 401 || minted.status === 403) return false
  if (typeof minted.body.code !== "string") throw new Error(`OpenBot answered ${minted.status}`)
  await win?.loadURL(`${origin}/api/auth/login?code=${encodeURIComponent(minted.body.code)}&next=${encodeURIComponent(page)}`)
  signedIn = true
  quick?.warm()
  return true
}

const showConnect = (params: Record<string, string>) =>
  win?.loadFile(join(appDir, "connect.html"), { query: { host, ...params } })

let connecting: AbortController | undefined

/** Device flow: a code on screen, "Allow this computer" in the owner's browser, then a session. */
const connect = async () => {
  connecting?.abort()
  const run = new AbortController()
  connecting = run
  const started = await post("/api/auth/device/start")
  const { deviceCode, userCode, expiresInSeconds } = started.body
  if (typeof deviceCode !== "string" || typeof userCode !== "string") throw new Error(`OpenBot answered ${started.status}`)
  const approve = `${origin}/#/connect-device?code=${encodeURIComponent(userCode)}`
  await showConnect({ code: userCode, approve })
  void shell.openExternal(approve)
  const deadline = Date.now() + (typeof expiresInSeconds === "number" ? expiresInSeconds : 600) * 1000
  while (!run.signal.aborted && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 2000))
    if (run.signal.aborted) return
    const polled = await post("/api/auth/device/poll", { deviceCode }).catch(() => undefined)
    if (polled === undefined || polled.body.status === "pending") continue
    if (typeof polled.body.code !== "string") break
    const login = await post("/api/auth/app-login", { code: polled.body.code })
    if (typeof login.body.sessionToken !== "string") break
    saveSession(login.body.sessionToken)
    await openApp(login.body.sessionToken)
    return
  }
  if (!run.signal.aborted) await showConnect({ expired: "1" })
}

const start = async () => {
  try {
    const token = loadSession()
    if (token !== undefined && (await openApp(token))) return
    forgetSession()
    await connect()
  } catch {
    await showConnect({ offline: "1" })
  }
}

// ---------------------------------------------------------------------------- window and tray

const iconPath = join(appDir, "icon.png")
const stateFile = () => join(app.getPath("userData"), "window.json")

const readBounds = (): Partial<Electron.Rectangle> => {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8")) as Partial<Electron.Rectangle>
  } catch {
    return {}
  }
}

const show = () => {
  if (win === undefined || win.isDestroyed()) createWindow()
  if (win?.isMinimized()) win.restore()
  win?.show()
  win?.focus()
}

const createWindow = () => {
  const bounds = readBounds()
  win = new BrowserWindow({
    width: bounds.width ?? 1280,
    height: bounds.height ?? 840,
    ...(bounds.x === undefined || bounds.y === undefined ? {} : { x: bounds.x, y: bounds.y }),
    // the web app's desktop layout (narrower is its phone layout)
    minWidth: 768,
    minHeight: 480,
    title: "OpenBot",
    icon: iconPath,
    backgroundColor: "#111111",
    autoHideMenuBar: true,
    // macOS: no title bar; the window's buttons float over the sidebar's header, in line with its
    // icons (the web app keeps that corner clear and makes its top strip move the window)
    ...(isMac ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 23 } } : {}),
    show: false,
    webPreferences: { preload: join(appDir, "preload.js"), contextIsolation: true, sandbox: true, spellcheck: true },
  })
  win.once("ready-to-show", () => win?.show())
  const contents = win.webContents
  // Other sites open in the browser; OpenBot's own pages (attachments, a bot's screen) in a window.
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`${origin}/`)) return { action: "allow" }
    void shell.openExternal(url)
    return { action: "deny" }
  })
  contents.on("will-navigate", (event, url) => {
    if (url.startsWith(`${origin}/`) || url.startsWith("file://")) return
    event.preventDefault()
    void shell.openExternal(url)
  })
  win.on("close", (event) => {
    if (win !== undefined && !win.isDestroyed()) {
      writeFileSync(stateFile(), JSON.stringify(win.getNormalBounds()))
    }
    if (quitting) return
    // Keep running for notifications; the tray / dock brings the window back.
    event.preventDefault()
    win?.hide()
  })
}

/** The microphone for voice input and little else, and only for OpenBot's own pages (permissions.ts). */
const limitPermissions = () => {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const media = "mediaTypes" in details ? details : undefined
    callback(permits(origin, { permission, from: media?.securityOrigin ?? details.requestingUrl, mediaTypes: media?.mediaTypes }))
  })
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
    permits(origin, { permission, from: requestingOrigin, mediaTypes: details.mediaType === undefined ? undefined : [details.mediaType] }))
}

const createTray = () => {
  if (isMac) return
  const image = nativeImage.createFromPath(join(appDir, "tray.png"))
  tray = new Tray(image)
  tray.setToolTip("OpenBot")
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open OpenBot", click: show },
    { label: "Check for Updates", click: () => void checkFromMenu() },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]))
  tray.on("click", show)
}

// ---------------------------------------------------------------------------- updates (update.ts)

const updater = makeUpdater({
  origin,
  build: baked.build,
  workDir: join(app.getPath("userData"), "update"),
  onChange: (state: UpdateState) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("openbot:update", state)
  },
  quit: () => {
    quitting = true
    app.quit()
  },
  openExternal: (url) => void shell.openExternal(url),
})

/** "Check for Updates" from a menu: says what it found, and offers the restart. */
const checkFromMenu = async () => {
  const state = await updater.check()
  if (state.status === "ready" || state.status === "manual") {
    const { response } = await dialog.showMessageBox({
      message: "A new version of OpenBot is ready.",
      detail: state.status === "ready" ? "Restart OpenBot to use it." : "Download it and replace this copy of OpenBot.",
      buttons: [state.status === "ready" ? "Restart to Update" : "Download", "Later"],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) await updater.install()
  } else if (state.status === "error") {
    await dialog.showMessageBox({ message: "Couldn't check for updates.", detail: state.message })
  } else {
    await dialog.showMessageBox({ message: "OpenBot is up to date." })
  }
}

const UPDATE_EVERY_MS = 4 * 60 * 60 * 1000

// ---------------------------------------------------------------------------- the page's bridge (preload.ts)

ipcMain.on("openbot:info", (event) => {
  event.returnValue = { version: baked.version, build: baked.build ?? "", origin }
})
ipcMain.handle("openbot:update-state", () => updater.state())
ipcMain.handle("openbot:check-updates", () => updater.check())
ipcMain.on("openbot:install-update", () => void updater.install())
ipcMain.on("openbot:badge", (_event, count: unknown) => {
  const n = typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
  app.setBadgeCount(n)
  tray?.setToolTip(n > 0 ? `OpenBot · ${n} unread` : "OpenBot")
})
ipcMain.on("openbot:focus", show)
ipcMain.on("openbot:connect", () => void connect().catch(() => showConnect({ offline: "1" })))
ipcMain.on("openbot:retry", () => void start())
ipcMain.on("openbot:open-approval", (_event, url: unknown) => {
  if (typeof url === "string" && url.startsWith(`${origin}/`)) void shell.openExternal(url)
})
ipcMain.on("openbot:sign-out", () => {
  signedIn = false
  forgetSession()
  void win?.webContents.session.clearStorageData({ storages: ["cookies"] }).then(() => connect())
})

// ---------------------------------------------------------------------------- quick send (quickSend.ts)

let quick: ReturnType<typeof makeQuickSend> | undefined
/** Links and flags that arrive before the app is ready. */
const early: Array<ReadonlyArray<string>> = []

/** `--quick-send` or an `openbot://send?…` link among the arguments: true when one was handled. */
const handleArgs = (argv: ReadonlyArray<string>): boolean => {
  if (quick === undefined) {
    early.push(argv)
    return true
  }
  const link = argv.find((a) => a.startsWith("openbot://"))
  const prefill = link === undefined ? undefined : prefillOfLink(link)
  if (prefill !== undefined) {
    void quick.open(prefill)
    return true
  }
  if (argv.includes("--quick-send")) {
    void quick.open()
    return true
  }
  return link !== undefined
}

if (process.defaultApp) app.setAsDefaultProtocolClient("openbot", process.execPath, [process.argv[1] ?? "."])
else app.setAsDefaultProtocolClient("openbot")

// ---------------------------------------------------------------------------- lifecycle

app.on("second-instance", (_event, argv) => {
  if (!handleArgs(argv)) show()
})
app.on("open-url", (event, url) => {
  event.preventDefault()
  if (!handleArgs([url])) show()
})
app.on("activate", show)
app.on("will-quit", () => globalShortcut.unregisterAll())
app.on("before-quit", () => {
  quitting = true
})

void app.whenReady().then(() => {
  Menu.setApplicationMenu(
    isMac
      ? Menu.buildFromTemplate([
        {
          label: app.name,
          submenu: [
            { role: "about" },
            { label: "Check for Updates…", click: () => void checkFromMenu() },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" },
      ])
      : null,
  )
  limitPermissions()
  createWindow()
  createTray()
  quick = makeQuickSend({ origin, preload: join(appDir, "preload.js"), canOpen: () => signedIn, fallback: show })
  quick.registerShortcut()
  void start().then(() => {
    for (const argv of [process.argv, ...early.splice(0)]) handleArgs(argv)
  })
  setTimeout(() => void updater.check(), 15_000)
  setInterval(() => void updater.check(), UPDATE_EVERY_MS)
  powerMonitor.on("resume", () => void updater.check())
})

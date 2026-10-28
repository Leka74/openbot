// DesktopManager (capability desktop@1, D1.7; remote-computer-control.md §0, §3, §4.1, §5, §7):
// a screen per bot. `ensure(botId)` starts, once (concurrent calls share the start), a virtual X
// display for the bot: Xvfb at 1920×1200 on the first free display from :100 (cookie auth, no TCP),
// a private session bus, a background, a window manager (xfwm4, or openbox), a dock (plank) with a
// browser / terminal / file manager / editor, and two loopback x11vnc servers: control and
// view-only. Every child runs in its own process group with a clean environment (DISPLAY=:N, no
// WAYLAND_DISPLAY) and carries an `OPENBOT_DESKTOP` marker, so `stop` (and the node's shutdown, and
// the next start after a crash) kills everything that ran on the screen.
//
// `act` runs Anthropic computer-use actions with xdotool and takes screenshots with ImageMagick
// `import`: external programs only, never FFI (the local node runs inside the brain).
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FiberSet from "effect/FiberSet"
import * as Layer from "effect/Layer"
import * as Semaphore from "effect/Semaphore"
import { createHash, randomBytes } from "node:crypto"
import * as path from "node:path"
import {
  DesktopUnavailable,
  LeaseHeld,
  type BrowserImage,
  type ComputerAction,
  type ComputerResult,
  type DesktopInfo,
  type DesktopSupport,
} from "@openbot/node-protocol"
import { browserArgs, freeDebugPort, onScreenBrowserConfig } from "../browser/launch.ts"
import { imageSize } from "../browser/image.ts"
import { NodeConfig, type NodeConfigShape } from "../config.ts"
import { LeaseBook, makeLeaseBook, type LeaseBookShape } from "../lease.ts"
import { importArgs, parseMouseLocation, planAction, type ActionPlan } from "./actions.ts"
import { makeGeometry, toApi, type ScreenGeometry, type ZoomRect } from "./geometry.ts"
import { detectDesktopPrograms, windowManagerOrder, type DetectedPrograms, type WindowManagerKind } from "./programs.ts"
import {
  backgroundArgs,
  desktopFiles,
  sessionEnv,
  sessionLayout,
  x11vncArgs,
  xvfbArgs,
  type DesktopApp,
  type SessionLayout,
} from "./session.ts"
import {
  displayLockPath,
  displaySocketPath,
  liveDesktopSystem,
  pickDisplay,
  xauthFile,
  type ChildHandle,
  type DesktopSystem,
} from "./system.ts"

/** What the bot's browser needs to run on the bot's screen. */
export interface DesktopScreen {
  readonly display: string
  /** environment of programs on the screen (DISPLAY, XAUTHORITY, session bus, marker, …) */
  readonly env: Readonly<Record<string, string>>
  /** the bot's own persistent browser profile */
  readonly profileDir: string
  readonly width: number
  readonly height: number
  /** working directory for programs (the bot's workspace when the node has one) */
  readonly cwd: string
  readonly logDir: string
  /** the DevTools port reserved for this screen's browser (the dock launcher uses it too) */
  readonly debugPort?: number | undefined
}

export type VncMode = "view" | "control"

export interface DesktopManagerShape {
  /** desktops can be started here (programs found, enabled, Linux-like) */
  readonly offered: boolean
  /** `node.hello.desktop` */
  readonly support: DesktopSupport
  readonly geometry: ScreenGeometry
  readonly ensure: (botId: string) => Effect.Effect<DesktopInfo, DesktopUnavailable>
  /** Stops the bot's desktop and everything on it (its browser is closed gracefully first). */
  readonly stop: (botId: string) => Effect.Effect<void>
  /** One computer-use action (starts the desktop when needed); refused while the user holds the lease. */
  readonly act: (botId: string, action: ComputerAction) => Effect.Effect<ComputerResult, DesktopUnavailable | LeaseHeld>
  /** Loopback port of the bot's VNC server (starting the desktop when needed). */
  readonly vncPort: (botId: string, mode: VncMode) => Effect.Effect<number, DesktopUnavailable>
  /** The bot's screen for its browser (starting the desktop when needed). */
  readonly screen: (botId: string) => Effect.Effect<DesktopScreen, DesktopUnavailable>
  /** Runs before a desktop's processes are killed (BrowserManager closes the bot's browser gracefully). */
  /**
   * Releases every modifier key on the bot's screen (no-op without one). Run when control changes
   * hands and when a control stream ends: a key-up lost on the way (a reconnect, a shortcut the
   * viewer's own desktop swallowed) would otherwise leave Alt or Ctrl held, and every key becomes a
   * shortcut.
   */
  readonly releaseKeys: (botId: string) => Effect.Effect<void>
  readonly onStop: (hook: (botId: string) => Effect.Effect<void>) => void
  /** Called after a bot's desktop (re)started, outside the bot's lock. */
  readonly onStart: (hook: (info: DesktopInfo) => Effect.Effect<void>) => void
  readonly running: () => ReadonlyArray<DesktopInfo>
  /** Stops every desktop (also runs when the layer's scope closes). */
  readonly shutdown: Effect.Effect<void>
}

export class DesktopManager extends Context.Service<DesktopManager, DesktopManagerShape>()(
  "openbot/node-daemon/DesktopManager",
) {}

export interface DesktopTimeouts {
  /** Xvfb socket + first client */
  readonly display: number
  /** x11vnc reports its port */
  readonly vnc: number
  /** a window manager must still run after this long */
  readonly windowManager: number
  /** session bus socket */
  readonly bus: number
  /** one xdotool / import run */
  readonly exec: number
}

export const DEFAULT_DESKTOP_TIMEOUTS: DesktopTimeouts = {
  display: 10_000,
  vnc: 10_000,
  windowManager: 800,
  bus: 3_000,
  exec: 15_000,
}

export interface DesktopManagerOptions {
  readonly system?: DesktopSystem | undefined
  /** programs (detected on `desktop.path` + PATH when undefined) */
  readonly detected?: DetectedPrograms | undefined
  readonly leases?: LeaseBookShape | undefined
  readonly timeouts?: Partial<DesktopTimeouts> | undefined
}

interface Child {
  readonly role: string
  readonly handle: ChildHandle
}

interface Desktop {
  readonly botId: string
  readonly display: number
  readonly marker: string
  readonly layout: SessionLayout
  readonly cwd: string
  env: Record<string, string>
  readonly children: Array<Child>
  readonly xvfb: ChildHandle
  wm: { readonly kind: WindowManagerKind; readonly handle: ChildHandle } | undefined
  dock: ChildHandle | undefined
  readonly vnc: Partial<Record<VncMode, { readonly port: number; readonly handle: ChildHandle }>>
  readonly openboxRc: string
  readonly actLock: Semaphore.Semaphore
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

/** Every modifier a viewer or a bot can hold (`releaseKeys`). */
const MODIFIER_KEYS = [
  "Shift_L",
  "Shift_R",
  "Control_L",
  "Control_R",
  "Alt_L",
  "Alt_R",
  "Super_L",
  "Super_R",
  "Meta_L",
  "Meta_R",
  "ISO_Level3_Shift",
] as const

const unavailable = (message: string, missing?: ReadonlyArray<string>) =>
  new DesktopUnavailable({ message, ...(missing && missing.length > 0 ? { missing: [...missing] } : {}) })

const running = (c: ChildHandle) => c.exitCode === null && c.signalCode === null

/** Last lines of a log file, for error messages. */
const logTail = (sys: DesktopSystem, file: string, lines = 4): string => {
  const text = sys.readText(file) ?? ""
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/keysym|Symbol map|Using last definition|Errors from xkbcomp|^>/.test(l))
    .slice(-lines)
    .join(" | ")
}

/** A stable id for this node's data dir: orphans of a previous run of the same node carry it in their marker. */
export const desktopNodeKey = (dataDir: string): string =>
  createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 12)

/** Where a bot's desktop programs start: its workspace root when the node has one, else HOME. */
const workspaceFor = (config: NodeConfigShape, sys: DesktopSystem, botId: string): string => {
  for (const r of config.roots) {
    if (r.mode !== "rw" || r.path.includes("*")) continue
    const p = r.path.replaceAll("{botId}", botId)
    if (sys.exists(p)) return p
  }
  return process.env.HOME ?? config.dataDir
}

/** The dock's apps: the bot's browser (same command line as the node's), a terminal, files, an editor. */
export const desktopApps = (input: {
  readonly config: NodeConfigShape
  readonly programs: DetectedPrograms["programs"]
  readonly profileDir: string
  readonly cwd: string
  /** the dock browser's DevTools port (fixed, see `DEBUG_PORT_RANGE`) */
  readonly debugPort?: number | undefined
}): ReadonlyArray<DesktopApp> => {
  const { config, programs } = input
  const apps: Array<DesktopApp> = []
  const exe = config.browser.enabled ? config.browser.executable : undefined
  if (exe) {
    const bc = onScreenBrowserConfig(config.browser, {
      profileDir: input.profileDir,
      width: config.desktop.width,
      height: config.desktop.height,
    })
    // without the trailing about:blank: a dock click opens a normal new window
    const args = browserArgs({ ...bc, debugPort: input.debugPort }, false).filter((a) => a !== "about:blank")
    apps.push({
      id: "browser",
      name: "Web Browser",
      icon: path.basename(exe).includes("chrome") ? "google-chrome" : "chromium",
      argv: [exe, ...args],
    })
  }
  if (programs.terminal) {
    apps.push({
      id: "terminal",
      name: "Terminal",
      icon: "utilities-terminal",
      argv:
        programs.terminal.kind === "xfce4-terminal"
          ? [programs.terminal.path, "--disable-server", "--maximize", `--working-directory=${input.cwd}`]
          : [programs.terminal.path, "-maximized", "-fa", "Monospace", "-fs", "11"],
    })
  }
  if (programs.fileManager)
    apps.push({ id: "files", name: "Files", icon: "system-file-manager", argv: [programs.fileManager, input.cwd] })
  if (programs.editor)
    apps.push({ id: "editor", name: "Text Editor", icon: "accessories-text-editor", argv: [programs.editor] })
  return apps
}

/** The system's default openbox rc.xml (next to a rootless install, or in XDG_CONFIG_DIRS). */
const openboxTemplate = (
  sys: DesktopSystem,
  openboxPath: string | undefined,
  env: Readonly<Record<string, string>>,
): string | undefined => {
  const candidates = [
    ...(openboxPath ? [path.join(path.dirname(openboxPath), "..", "..", "etc", "xdg", "openbox", "rc.xml")] : []),
    ...(env.XDG_CONFIG_DIRS ?? "/etc/xdg").split(":").map((d) => path.join(d, "openbox", "rc.xml")),
    "/etc/xdg/openbox/rc.xml",
  ]
  for (const c of candidates) {
    const text = sys.readText(c)
    if (text && text.includes("<openbox_config")) return text
  }
  return undefined
}

export const makeDesktopManager = (config: NodeConfigShape, options?: DesktopManagerOptions) =>
  Effect.gen(function* () {
    const sys = options?.system ?? liveDesktopSystem()
    const timeouts: DesktopTimeouts = { ...DEFAULT_DESKTOP_TIMEOUTS, ...options?.timeouts }
    const dc = config.desktop
    const searchPath = [...dc.path, process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"].join(":")
    const detect = () => detectDesktopPrograms((name) => Bun.which(name, { PATH: searchPath }) ?? undefined)
    const detected = options?.detected ?? (dc.enabled ? detect() : { programs: { windowManagers: [] }, missing: [] })
    let programs = detected.programs
    // programs installed since the node started (the dock, a terminal…) are used by the next new desktop
    const refreshPrograms = () => {
      if (options?.detected !== undefined || !dc.enabled) return
      const fresh = detect()
      if (fresh.missing.length === 0) programs = fresh.programs
    }
    const offered = dc.enabled && detected.missing.length === 0
    const support: DesktopSupport = {
      missing: dc.enabled ? [...detected.missing] : [],
      width: dc.width,
      height: dc.height,
    }
    const geometry = makeGeometry(dc.width, dc.height, dc.apiWidth)
    const leases = options?.leases ?? makeLeaseBook()
    const nodeKey = desktopNodeKey(config.dataDir)
    const desktops = new Map<string, Desktop>()
    const botLocks = new Map<string, Semaphore.Semaphore>()
    const allocLock = Semaphore.makeUnsafe(1)
    const stopHooks: Array<(botId: string) => Effect.Effect<void>> = []
    // each dock's browser launcher gets its own fixed DevTools port (no two docks share one)
    const dockPorts = new Map<string, number>()
    const reserveDockPort = (botId: string): number => {
      const port = freeDebugPort(new Set([...dockPorts].filter(([id]) => id !== botId).map(([, p]) => p)))
      dockPorts.set(botId, port)
      return port
    }
    const startHooks: Array<(info: DesktopInfo) => Effect.Effect<void>> = []
    let closed = false

    const botLock = (botId: string) => {
      let l = botLocks.get(botId)
      if (!l) botLocks.set(botId, (l = Semaphore.makeUnsafe(1)))
      return l
    }

    /** SIGTERM everything carrying the marker prefix, then SIGKILL what is left. */
    const sweep = (prefix: string) =>
      Effect.gen(function* () {
        if (sys.killMarked(prefix, "SIGTERM").length === 0) return
        yield* Effect.sleep(300)
        sys.killMarked(prefix, "SIGKILL")
      })

    // orphans of a previous run of this node (its brain / daemon was SIGKILLed): their X servers would
    // otherwise keep display numbers and the bots' browser profiles locked
    if (offered) yield* sweep(`${nodeKey}/`)

    const waitUntil = (what: string, timeoutMs: number, probe: () => boolean, child?: ChildHandle, log?: string) =>
      Effect.gen(function* () {
        const end = Date.now() + timeoutMs
        while (true) {
          if (probe()) return
          if (child && !running(child)) {
            const tail = log ? logTail(sys, log) : ""
            return yield* unavailable(
              `${what} exited (code ${child.exitCode ?? child.signalCode})${tail ? `: ${tail}` : ""}`,
            )
          }
          if (Date.now() > end)
            return yield* unavailable(`${what} did not start within ${Math.round(timeoutMs / 1000)} s`)
          yield* Effect.sleep(25)
        }
      })

    const exec = (env: Readonly<Record<string, string>>, argv: ReadonlyArray<string>, timeoutMs = timeouts.exec) =>
      Effect.tryPromise({
        try: () => sys.exec(argv, { env, timeoutMs }),
        catch: (e) =>
          unavailable(`could not run ${path.basename(argv[0] ?? "")}: ${e instanceof Error ? e.message : String(e)}`),
      }).pipe(
        Effect.flatMap((r) =>
          r.code === 0 && !r.timedOut
            ? Effect.succeed(r)
            : Effect.fail(
                unavailable(
                  `${path.basename(argv[0] ?? "")} ${r.timedOut ? "timed out" : `failed (exit ${r.code})`}${r.stderr ? `: ${r.stderr.slice(0, 300)}` : ""}`,
                ),
              ),
        ),
      )

    const spawn = (
      d: { readonly children: Array<Child> },
      role: string,
      argv: ReadonlyArray<string>,
      opts: Parameters<DesktopSystem["spawn"]>[1],
    ) =>
      Effect.try({
        try: () => {
          const handle = sys.spawn(argv, opts)
          d.children.push({ role, handle })
          return handle
        },
        catch: (e) =>
          unavailable(
            `could not start ${path.basename(argv[0] ?? role)}: ${e instanceof Error ? e.message : String(e)}`,
          ),
      })

    const terminate = (c: ChildHandle, graceMs: number) =>
      Effect.gen(function* () {
        if (running(c)) {
          sys.kill(c.pid, "SIGTERM")
          yield* Effect.promise(() => c.exited).pipe(Effect.timeoutOption(graceMs))
        }
        // leftovers of the group (a child's own children)
        sys.kill(c.pid, "SIGKILL")
      })

    /** Kill a (possibly partial) desktop: its children (reverse start order), then anything marked, then its runtime files. */
    const killAll = (d: {
      readonly children: Array<Child>
      readonly marker: string
      readonly display?: number | undefined
      readonly run?: string | undefined
    }) =>
      Effect.gen(function* () {
        yield* Effect.forEach([...d.children].reverse(), (c) => terminate(c.handle, 1000), {
          concurrency: "unbounded",
          discard: true,
        })
        yield* sweep(d.marker)
        if (d.display !== undefined) {
          // a KILLed Xvfb leaves its lock file and socket behind
          const lock = displayLockPath(d.display)
          const pid = Number((sys.readText(lock) ?? "").trim())
          if (sys.exists(lock) && (!(pid > 0) || !sys.pidAlive(pid))) {
            sys.remove(lock)
            sys.remove(displaySocketPath(d.display))
          }
        }
        if (d.run) sys.remove(d.run)
      })

    // ------------------------------------------------------------ start
    const baseEnvFor = (
      d: { readonly display: number; readonly layout: SessionLayout; readonly marker: string },
      botId: string,
      wm?: WindowManagerKind,
      bus?: string,
    ) =>
      sessionEnv({
        display: d.display,
        layout: d.layout,
        path: dc.path,
        extra: dc.env,
        marker: d.marker,
        botId,
        nodeId: config.nodeId,
        busAddress: bus,
        windowManager: wm,
      })

    /** Xvfb on the first free display (serialized; a lost race moves on to the next number). */
    const startX = (
      botId: string,
      partial: { children: Array<Child>; display?: number; run?: string },
      marker: string,
    ) =>
      allocLock.withPermits(1)(
        Effect.gen(function* () {
          const reserved = new Set<number>([...desktops.values()].map((d) => d.display))
          for (let attempt = 0; attempt < 5; attempt++) {
            const display = pickDisplay(sys, dc.displayBase, reserved)
            if (display === undefined) return yield* unavailable(`no free X display from :${dc.displayBase}`)
            reserved.add(display)
            const layout = sessionLayout({ dataDir: config.dataDir, botId, display, tmpdir: sys.tmpdir, uid: sys.uid })
            yield* Effect.try({
              try: () => {
                sys.mkdir(path.dirname(layout.run), 0o700)
                sys.remove(layout.run)
                sys.mkdir(layout.run, 0o700)
                for (const dir of [
                  layout.logs,
                  layout.config,
                  layout.data,
                  layout.cache,
                  layout.state,
                  layout.browserProfile,
                ])
                  sys.mkdir(dir, 0o700)
                sys.writeFile(layout.xauthority, xauthFile(new Uint8Array(randomBytes(16))), 0o600)
              },
              catch: (e) =>
                unavailable(`cannot prepare the desktop's files: ${e instanceof Error ? e.message : String(e)}`),
            })
            partial.display = display
            partial.run = layout.run
            const env = baseEnvFor({ display, layout, marker }, botId)
            const log = path.join(layout.logs, "xvfb.log")
            const xvfb = yield* spawn(
              partial,
              "xvfb",
              xvfbArgs({
                xvfb: programs.xvfb!,
                display,
                width: dc.width,
                height: dc.height,
                xauthority: layout.xauthority,
              }),
              {
                env,
                logFile: log,
              },
            )
            const started = yield* waitUntil(
              "Xvfb",
              timeouts.display,
              () => sys.exists(displaySocketPath(display)),
              xvfb,
              log,
            ).pipe(Effect.result)
            if (started._tag === "Failure") {
              const already = /already active|server is already/i.test(sys.readText(log) ?? "")
              yield* terminate(xvfb, 500)
              const i = partial.children.findIndex((c) => c.handle === xvfb)
              if (i >= 0) partial.children.splice(i, 1)
              if (already) {
                sys.remove(layout.run)
                continue
              }
              return yield* started.failure
            }
            // the server answers (and the cookie works) before anyone else connects
            const end = Date.now() + timeouts.display
            while (true) {
              const probe = yield* exec(env, [programs.xdotool!, "getdisplaygeometry"], 5_000).pipe(Effect.result)
              if (probe._tag === "Success") break
              if (!running(xvfb) || Date.now() > end) {
                return yield* unavailable(`the X server on :${display} does not answer: ${probe.failure.message}`)
              }
              yield* Effect.sleep(50)
            }
            return { display, layout, xvfb }
          }
          return yield* unavailable("no free X display (every candidate was taken while starting)")
        }),
      )

    const startVnc = (d: Desktop, mode: VncMode) =>
      Effect.gen(function* () {
        let last: DesktopUnavailable | undefined
        for (let attempt = 0; attempt < 3; attempt++) {
          const port = yield* Effect.tryPromise({
            try: () => sys.freePort(),
            catch: () => unavailable("no free loopback port"),
          })
          const log = path.join(d.layout.logs, `x11vnc-${mode}.log`)
          const handle = yield* spawn(
            d,
            `vnc-${mode}`,
            x11vncArgs({
              x11vnc: programs.x11vnc!,
              display: d.display,
              xauthority: d.layout.xauthority,
              port,
              viewOnly: mode === "view",
            }),
            { env: d.env, logFile: log, captureStdout: true, cwd: d.cwd },
          )
          const ok = yield* waitUntil(
            `x11vnc (${mode})`,
            timeouts.vnc,
            () => new RegExp(`PORT=${port}\\b`).test(handle.output()),
            handle,
            log,
          ).pipe(Effect.result)
          if (ok._tag === "Success") {
            d.vnc[mode] = { port, handle }
            return port
          }
          last = ok.failure
          yield* terminate(handle, 300)
        }
        return yield* last ?? unavailable(`x11vnc (${mode}) did not start`)
      })

    const startWindowManager = (
      d: Desktop,
      candidates: ReadonlyArray<{ readonly kind: WindowManagerKind; readonly path: string }>,
    ) =>
      Effect.gen(function* () {
        const failures: Array<string> = []
        for (const wm of candidates) {
          const env = { ...d.env, XDG_CURRENT_DESKTOP: wm.kind === "openbox" ? "OPENBOX" : "XFCE" }
          const log = path.join(d.layout.logs, `${wm.kind}.log`)
          const argv =
            wm.kind === "xfwm4"
              ? [wm.path, "--compositor=off", "--sm-client-disable"]
              : [wm.path, "--config-file", d.openboxRc]
          const handle = yield* spawn(d, `wm-${wm.kind}`, argv, { env, logFile: log, cwd: d.cwd })
          yield* Effect.sleep(timeouts.windowManager)
          if (running(handle)) {
            d.wm = { kind: wm.kind, handle }
            d.env = env
            return
          }
          failures.push(`${wm.kind}: ${logTail(sys, log, 2) || `exit ${handle.exitCode ?? handle.signalCode}`}`)
        }
        return yield* unavailable(`no window manager could start (${failures.join("; ")})`)
      })

    /** Waits (best effort, a few seconds) until the dock's window is on screen. */
    const dockShown = (d: Desktop) =>
      Effect.gen(function* () {
        if (!programs.xdotool) return
        for (let i = 0; i < 40; i++) {
          const found = yield* exec(
            d.env,
            [programs.xdotool, "search", "--onlyvisible", "--classname", "plank"],
            2_000,
          ).pipe(Effect.result)
          if (found._tag === "Success") return
          yield* Effect.sleep(100)
        }
      })

    // the bot's first screenshot must already show the dock (it is how it opens apps)
    const startDock = (d: Desktop) =>
      programs.dock
        ? spawn(d, "dock", [programs.dock], {
            env: d.env,
            logFile: path.join(d.layout.logs, "plank.log"),
            cwd: d.cwd,
          }).pipe(
            Effect.tap((h) => Effect.sync(() => void (d.dock = h))),
            Effect.andThen(dockShown(d)),
            Effect.ignore,
          )
        : Effect.void

    const start = (botId: string): Effect.Effect<Desktop, DesktopUnavailable> => {
      const marker = `${nodeKey}/${botId}/`
      const partial: { children: Array<Child>; marker: string; display?: number; run?: string } = {
        children: [],
        marker,
      }
      return Effect.gen(function* () {
        refreshPrograms()
        const { display, layout, xvfb } = yield* startX(botId, partial, marker)
        const cwd = workspaceFor(config, sys, botId)
        // a private session bus: apps must never reach the owner's (an already-running terminal or
        // file manager would open the window on the owner's own screen)
        let bus: string | undefined
        if (programs.dbus) {
          const log = path.join(layout.logs, "dbus.log")
          const h = yield* spawn(
            partial,
            "dbus",
            [programs.dbus, "--session", "--nofork", "--nopidfile", `--address=unix:path=${layout.bus}`],
            {
              env: baseEnvFor({ display, layout, marker }, botId),
              logFile: log,
            },
          )
          const up = yield* waitUntil("dbus-daemon", timeouts.bus, () => sys.exists(layout.bus), h, log).pipe(
            Effect.result,
          )
          if (up._tag === "Success") bus = `unix:path=${layout.bus}`
        }
        const order = windowManagerOrder(programs)
        const env = baseEnvFor({ display, layout, marker }, botId, order[0]?.kind, bus)
        const files = desktopFiles({
          layout,
          apps: desktopApps({
            config,
            programs,
            profileDir: layout.browserProfile,
            cwd,
            debugPort: reserveDockPort(botId),
          }),
          openboxTemplate: openboxTemplate(sys, programs.windowManagers.find((w) => w.kind === "openbox")?.path, env),
        })
        yield* Effect.try({
          try: () => {
            for (const f of files.files) {
              sys.mkdir(path.dirname(f.path), 0o700)
              sys.writeFile(f.path, f.content, 0o600)
            }
          },
          catch: (e) =>
            unavailable(`cannot write the desktop's settings: ${e instanceof Error ? e.message : String(e)}`),
        })
        const d: Desktop = {
          botId,
          display,
          marker,
          layout,
          cwd,
          env,
          children: partial.children,
          xvfb,
          wm: undefined,
          dock: undefined,
          vnc: {},
          openboxRc: files.openboxRcPath,
          actLock: Semaphore.makeUnsafe(1),
        }
        if (programs.background) {
          yield* exec(env, backgroundArgs(programs.background, display, dc.width, dc.height), 10_000).pipe(
            Effect.ignore,
          )
        }
        yield* startWindowManager(d, order)
        yield* startDock(d)
        yield* Effect.all([startVnc(d, "control"), startVnc(d, "view")], { concurrency: 2, discard: true })
        return d
      }).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : killAll(partial))))
    }

    /** Restart what died on a living desktop (VNC servers, window manager, dock). */
    const heal = (d: Desktop) =>
      Effect.gen(function* () {
        for (const mode of ["control", "view"] as const) {
          const v = d.vnc[mode]
          if (!v || !running(v.handle)) {
            delete d.vnc[mode]
            yield* startVnc(d, mode)
          }
        }
        if (!d.wm || !running(d.wm.handle)) {
          const order = windowManagerOrder(programs)
          yield* startWindowManager(
            d,
            d.wm
              ? [...order.filter((w) => w.kind === d.wm!.kind), ...order.filter((w) => w.kind !== d.wm!.kind)]
              : order,
          )
        }
        if (programs.dock && (!d.dock || !running(d.dock))) yield* startDock(d)
      })

    const teardown = (d: Desktop) =>
      Effect.gen(function* () {
        if (desktops.get(d.botId) === d) desktops.delete(d.botId)
        dockPorts.delete(d.botId)
        yield* killAll({ children: d.children, marker: d.marker, display: d.display, run: d.layout.run })
      })

    /**
     * The stop hooks (the bot's browser closes gracefully, so its cookies are saved). They run
     * outside the bot's lock: a hook may wait for the browser, which may be waiting for the desktop.
     */
    const runStopHooks = (botId: string) =>
      Effect.forEach(stopHooks, (hook) => hook(botId).pipe(Effect.timeoutOption(10_000), Effect.ignore), {
        discard: true,
      })

    /** The bot's running desktop, started or repaired as needed. */
    const desktopFor = (botId: string): Effect.Effect<Desktop, DesktopUnavailable> =>
      Effect.gen(function* () {
        if (!SAFE_ID.test(botId)) return yield* unavailable("invalid bot id")
        if (!offered) {
          return yield* dc.enabled
            ? unavailable(
                `This computer cannot run desktops: ${detected.missing.join(", ")} not installed.`,
                detected.missing,
              )
            : unavailable("Desktops are turned off on this computer.")
        }
        const result = yield* botLock(botId).withPermits(1)(
          Effect.gen(function* () {
            if (closed) return yield* unavailable("the node is shutting down")
            const existing = desktops.get(botId)
            if (existing) {
              if (running(existing.xvfb)) {
                yield* heal(existing)
                return { d: existing, fresh: false }
              }
              // the X server died: everything on the screen went with it
              yield* teardown(existing)
            }
            const d = yield* start(botId)
            desktops.set(botId, d)
            return { d, fresh: true }
          }),
        )
        if (result.fresh) {
          yield* Effect.forEach(
            startHooks,
            (hook) => hook(info(result.d)).pipe(Effect.timeoutOption(5_000), Effect.ignore),
            { discard: true },
          )
        }
        return result.d
      })

    const info = (d: Desktop): DesktopInfo => ({
      botId: d.botId,
      display: `:${d.display}`,
      width: dc.width,
      height: dc.height,
    })

    // ------------------------------------------------------------ computer actions
    const leaseHeld = (botId: string) =>
      new LeaseHeld({
        botId,
        holder: "user",
        reason: "The user is controlling this screen. Wait until they hand it back.",
      })
    const checkLease = (botId: string) =>
      Effect.suspend(() =>
        leases && leases.get(botId).holder === "user" ? Effect.fail(leaseHeld(botId)) : Effect.void,
      )

    const screenshot = (d: Desktop, zoom?: ZoomRect): Effect.Effect<BrowserImage, DesktopUnavailable> =>
      Effect.gen(function* () {
        const out = zoom
          ? { width: zoom.outWidth, height: zoom.outHeight, exact: false, crop: zoom }
          : { width: geometry.apiWidth, height: geometry.apiHeight, exact: true, crop: undefined }
        const r = yield* exec(d.env, [
          ...programs.screenshot!,
          ...importArgs({ display: `:${d.display}`, ...out, format: dc.imageFormat, quality: dc.imageQuality }),
        ])
        if (r.stdout.length === 0) return yield* unavailable("the screenshot was empty")
        const size = imageSize(r.stdout)
        return {
          mimeType: size?.mime ?? `image/${dc.imageFormat}`,
          data: Buffer.from(r.stdout).toString("base64"),
          width: size?.width ?? out.width,
          height: size?.height ?? out.height,
        }
      })

    const runPlan = (d: Desktop, plan: ActionPlan): Effect.Effect<ComputerResult, DesktopUnavailable | LeaseHeld> =>
      Effect.gen(function* () {
        const xdotool = (args: ReadonlyArray<string>) => exec(d.env, [programs.xdotool!, ...args])
        const steps = Effect.forEach(
          plan.steps,
          (step) =>
            Effect.andThen(
              checkLease(d.botId),
              step._tag === "sleep" ? Effect.sleep(step.ms) : Effect.asVoid(xdotool(step.args)),
            ),
          { discard: true },
        )
        if (plan.hold.length > 0) {
          yield* xdotool(["keydown", ...plan.hold])
          yield* steps.pipe(Effect.ensuring(Effect.ignore(xdotool(["keyup", ...[...plan.hold].reverse()]))))
        } else {
          yield* steps
        }
        if (plan.cursor) {
          const r = yield* xdotool(["getmouselocation", "--shell"])
          const p = parseMouseLocation(new TextDecoder().decode(r.stdout))
          if (!p) return yield* unavailable("cannot read the mouse position")
          const a = toApi(geometry, p.x, p.y)
          return { text: `X=${a.x}, Y=${a.y}` }
        }
        if (plan.image === "none") return { text: plan.text }
        if (plan.image === "after" && dc.settleMs > 0) yield* Effect.sleep(dc.settleMs)
        const image = yield* screenshot(d, typeof plan.image === "object" ? plan.image.zoom : undefined)
        return { text: plan.text, image }
      })

    const act = (botId: string, action: ComputerAction) =>
      Effect.gen(function* () {
        yield* checkLease(botId)
        const plan = planAction(geometry, action)
        if (typeof plan === "string") return { text: `ERROR: ${plan}` } satisfies ComputerResult
        const d = yield* desktopFor(botId)
        return yield* d.actLock.withPermits(1)(Effect.andThen(checkLease(botId), runPlan(d, plan)))
      })

    // ------------------------------------------------------------ lifecycle
    const stop = (botId: string) =>
      Effect.gen(function* () {
        if (!desktops.has(botId)) return
        yield* runStopHooks(botId)
        yield* botLock(botId).withPermits(1)(
          Effect.suspend(() => {
            const d = desktops.get(botId)
            return d ? teardown(d) : Effect.void
          }),
        )
      })

    const shutdown = Effect.gen(function* () {
      closed = true
      yield* Effect.forEach([...desktops.keys()], stop, { concurrency: "unbounded", discard: true })
    })

    yield* Effect.addFinalizer(() => shutdown)

    const releaseKeys = (botId: string) =>
      Effect.suspend(() => {
        const d = desktops.get(botId)
        if (d === undefined || !programs.xdotool) return Effect.void
        return exec(d.env, [programs.xdotool, "keyup", ...MODIFIER_KEYS], 5_000).pipe(Effect.ignore)
      })

    // whoever gets the screen next starts with no key held (lease changes come from `lease.set`)
    if (leases !== undefined) {
      const runFork = yield* FiberSet.makeRuntime<never>()
      leases.subscribe((state) => {
        try {
          runFork(releaseKeys(state.botId))
        } catch {
          // shutting down
        }
      })
    }

    return {
      offered,
      support,
      geometry,
      ensure: (botId) => Effect.map(desktopFor(botId), info),
      stop,
      act,
      vncPort: (botId, mode) =>
        Effect.gen(function* () {
          const d = yield* desktopFor(botId)
          const v = d.vnc[mode]
          if (!v) return yield* unavailable(`the ${mode} VNC server is not running`)
          return v.port
        }),
      screen: (botId) =>
        Effect.map(desktopFor(botId), (d) => ({
          display: `:${d.display}`,
          env: d.env,
          profileDir: d.layout.browserProfile,
          width: dc.width,
          height: dc.height,
          cwd: d.cwd,
          logDir: d.layout.logs,
          debugPort: dockPorts.get(botId),
        })),
      releaseKeys,
      onStop: (hook) => void stopHooks.push(hook),
      onStart: (hook) => void startHooks.push(hook),
      running: () => [...desktops.values()].map(info),
      shutdown,
    } satisfies DesktopManagerShape
  })

export const DesktopManagerLive: Layer.Layer<DesktopManager, never, NodeConfig | LeaseBook> = Layer.effect(
  DesktopManager,
  Effect.gen(function* () {
    const config = yield* NodeConfig
    const leases = yield* LeaseBook
    return DesktopManager.of(yield* makeDesktopManager(config, { leases }))
  }),
)

/**
 * The desktop app (apps/desktop, Electron) as a download from this brain, built for the owner's
 * computer on first request and cached under `<data>/desktop-builds`:
 *
 * 1. Electron's release zip for the target, from GitHub, checked against the SHA-256 Electron
 *    publishes in its npm package (`electron/checksums.json`).
 * 2. The app (main + preload bundled by Bun for Node, the connect page, icons), with this brain's
 *    address baked in (`openbot.json`): the app has nothing to set up.
 * 3. Renamed to OpenBot (executable on Linux / Windows; bundle name, id and icon on macOS), and on
 *    macOS signed ad hoc (Apple Silicon runs nothing unsigned): with `codesign` on a Mac brain, else
 *    `rcodesign` (apple-codesign, fetched and checked the same way).
 * 4. Packed as the platform expects: `.zip` with `OpenBot.app` (macOS), `.tar.gz` (Linux), `.zip`
 *    (Windows).
 *
 * `/desktop/latest` names the build this brain serves; the app checks it and updates itself.
 * `/desktop/install.sh` installs it from a terminal on macOS or Linux (`curl … | sh`): no browser
 * download, so macOS does not hold the app back as downloaded from the internet, and on Linux it adds
 * the launcher entry and icon.
 */
import { BrainNodesConfig } from "@openbot/brain-nodes"
import { DataDir } from "@openbot/core"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { createHash } from "node:crypto"
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { arch, platform } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const DESKTOP_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"] as const
export type DesktopTarget = (typeof DESKTOP_TARGETS)[number]
export const isDesktopTarget = (s: string): s is DesktopTarget => (DESKTOP_TARGETS as ReadonlyArray<string>).includes(s)

/** The file the owner downloads. */
export const desktopFileName = (target: DesktopTarget): string => {
  const [os, cpu] = target.split("-") as [string, string]
  if (os === "darwin") return `OpenBot-macOS-${cpu}.zip`
  if (os === "win32") return `OpenBot-Windows-${cpu}.zip`
  return `OpenBot-Linux-${cpu}.tar.gz`
}

const APP_DIR = fileURLToPath(new URL("../../desktop", import.meta.url))
const RCODESIGN_VERSION = "0.29.0"
const BUNDLE_ID = "com.leka74.openbot.desktop"
const MAC_USAGE_DESCRIPTIONS = {
  NSAppleEventsUsageDescription: "OpenBot reads the page open in your browser when you send it to a Bot.",
  NSMicrophoneUsageDescription: "OpenBot listens while you dictate a message to a Bot.",
} as const

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex")

const run = async (cmd: ReadonlyArray<string>, cwd?: string) => {
  const proc = Bun.spawn([...cmd], { cwd, stdout: "pipe", stderr: "pipe" })
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  if (code !== 0) throw new Error(`${cmd[0]} failed: ${(err || out).trim().split("\n").slice(-3).join(" ")}`)
  return out
}

/** Downloads `url` to `file` unless it is there, checking its SHA-256. */
const download = async (url: string, file: string, expected: string) => {
  if (await Bun.file(file).exists()) return
  await mkdir(path.dirname(file), { recursive: true })
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const actual = sha256(bytes)
  if (actual !== expected.toLowerCase()) throw new Error(`checksum mismatch for ${path.basename(file)}`)
  const temp = `${file}.${process.pid}.tmp`
  await Bun.write(temp, bytes)
  await rename(temp, file)
}

const desktopPackage = async () =>
  JSON.parse(await readFile(path.join(APP_DIR, "package.json"), "utf8")) as {
    readonly version: string
    readonly devDependencies: { readonly electron: string }
  }

/** Electron's release zip for the target (cached). */
const electronZip = async (cacheDir: string, version: string, target: DesktopTarget) => {
  const name = `electron-v${version}-${target}.zip`
  const checksums = JSON.parse(await readFile(path.join(APP_DIR, "node_modules/electron/checksums.json"), "utf8")) as Record<string, string>
  const expected = checksums[name]
  if (expected === undefined) throw new Error(`no checksum for ${name}`)
  const file = path.join(cacheDir, "electron", name)
  await download(`https://github.com/electron/electron/releases/download/v${version}/${name}`, file, expected)
  return file
}

/** How to sign a macOS bundle ad hoc on this brain. */
const macSigner = async (cacheDir: string): Promise<(app: string) => Promise<void>> => {
  if (platform() === "darwin") return async (app) => void (await run(["codesign", "--force", "--deep", "--sign", "-", app]))
  const cpu = arch() === "arm64" ? "aarch64" : "x86_64"
  const name = `apple-codesign-${RCODESIGN_VERSION}-${cpu}-unknown-linux-musl`
  const base = `https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F${RCODESIGN_VERSION}`
  const archive = path.join(cacheDir, "tools", `${name}.tar.gz`)
  const binary = path.join(cacheDir, "tools", name, "rcodesign")
  if (!(await Bun.file(binary).exists())) {
    const expected = (await (await fetch(`${base}/${name}.tar.gz.sha256`)).text()).trim().split(/\s+/)[0] ?? ""
    await download(`${base}/${name}.tar.gz`, archive, expected)
    await run(["tar", "-xzf", archive, "-C", path.dirname(archive)])
  }
  return async (app) => void (await run([binary, "sign", app]))
}

/** The app's files (bundled main and preload, page, icons, the brain's address, its build id). */
const stageApp = async (into: string, origin: string, version: string, build: string) => {
  await mkdir(into, { recursive: true })
  const built = await Bun.build({
    entrypoints: [path.join(APP_DIR, "src/main.ts"), path.join(APP_DIR, "src/preload.ts")],
    target: "node",
    format: "cjs",
    external: ["electron"],
    outdir: into,
  })
  if (!built.success) throw new Error(`bundling the desktop app failed: ${built.logs.map(String).join(" ")}`)
  await cp(path.join(APP_DIR, "src/connect.html"), path.join(into, "connect.html"))
  for (const icon of ["icon.png", "tray.png", "tray@2x.png"]) await cp(path.join(APP_DIR, "assets", icon), path.join(into, icon))
  await writeFile(path.join(into, "openbot.json"), JSON.stringify({ origin, version, build }))
  await writeFile(
    path.join(into, "package.json"),
    JSON.stringify({ name: "openbot", productName: "OpenBot", version, main: "main.js", desktopName: "openbot.desktop" }),
  )
}

const setPlistString = (plist: string, key: string, value: string) => {
  const entry = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`)
  return entry.test(plist) ? plist.replace(entry, `$1${value}$2`) : plist.replace(/<dict>/, `<dict>\n\t<key>${key}</key>\n\t<string>${value}</string>`)
}

/** A hash of what goes into a build: a different app, Electron or address is a different file. */
const buildKey = async (origin: string, electron: string): Promise<string> => {
  const files = (await Promise.all(["src", "assets"].map(async (dir) => (await readdir(path.join(APP_DIR, dir))).map((f) => `${dir}/${f}`))))
    .flat()
    .sort()
  const parts = await Promise.all(files.map(async (f) => Buffer.concat([Buffer.from(`${f}\n`), await readFile(path.join(APP_DIR, f))])))
  return sha256(Buffer.concat([...parts, Buffer.from(`${origin}\n${electron}\n${JSON.stringify(MAC_USAGE_DESCRIPTIONS)}`)])).slice(0, 12)
}

/** The build this brain serves now (`/desktop/latest`): the app compares it with its own to update. */
export const latestDesktopBuild = async (origin: string): Promise<{ readonly build: string; readonly version: string }> => {
  const pkg = await desktopPackage()
  return { build: await buildKey(origin, pkg.devDependencies.electron.replace(/^[\^~]/, "")), version: pkg.version }
}

const buildTarget = async (cacheDir: string, origin: string, target: DesktopTarget): Promise<string> => {
  const pkg = await desktopPackage()
  const electron = pkg.devDependencies.electron.replace(/^[\^~]/, "")
  const key = await buildKey(origin, electron)
  const out = path.join(cacheDir, "out", `${key}-${desktopFileName(target)}`)
  if (await Bun.file(out).exists()) return out
  const zip = await electronZip(cacheDir, electron, target)
  const stage = path.join(cacheDir, `stage-${target}-${process.pid}-${Date.now().toString(36)}`)
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })
  try {
    if (target.startsWith("darwin")) {
      await run(["unzip", "-q", zip, "-d", stage])
      const bundle = path.join(stage, "Electron.app")
      const resources = path.join(bundle, "Contents/Resources")
      await stageApp(path.join(resources, "app"), origin, pkg.version, key)
      await rm(path.join(resources, "default_app.asar"), { force: true })
      await cp(path.join(APP_DIR, "assets/icon.icns"), path.join(resources, "electron.icns"))
      const plistPath = path.join(bundle, "Contents/Info.plist")
      let plist = await readFile(plistPath, "utf8")
      plist = setPlistString(plist, "CFBundleName", "OpenBot")
      plist = setPlistString(plist, "CFBundleDisplayName", "OpenBot")
      plist = setPlistString(plist, "CFBundleIdentifier", BUNDLE_ID)
      plist = setPlistString(plist, "CFBundleShortVersionString", pkg.version)
      for (const [usageKey, description] of Object.entries(MAC_USAGE_DESCRIPTIONS)) plist = setPlistString(plist, usageKey, description)
      if (!plist.includes("CFBundleURLSchemes")) {
        plist = plist.replace(
          /<dict>/,
          "<dict>\n\t<key>CFBundleURLTypes</key>\n\t<array><dict><key>CFBundleURLName</key><string>OpenBot</string><key>CFBundleURLSchemes</key><array><string>openbot</string></array></dict></array>",
        )
      }
      await writeFile(plistPath, plist)
      const app = path.join(stage, "OpenBot.app")
      await rename(bundle, app)
      await (await macSigner(cacheDir))(app)
      await run(["zip", "-qry", `${out}.tmp`, "OpenBot.app"], stage)
    } else {
      const root = path.join(stage, "OpenBot")
      await mkdir(root)
      await run(["unzip", "-q", zip, "-d", root])
      const resources = path.join(root, "resources")
      await stageApp(path.join(resources, "app"), origin, pkg.version, key)
      await rm(path.join(resources, "default_app.asar"), { force: true })
      if (target.startsWith("win32")) {
        await rename(path.join(root, "electron.exe"), path.join(root, "OpenBot.exe"))
        await run(["zip", "-qr", `${out}.tmp`, "OpenBot"], stage)
      } else {
        await rename(path.join(root, "electron"), path.join(root, "openbot"))
        await run(["tar", "-czf", `${out}.tmp`, "OpenBot"], stage)
      }
    }
    await rename(`${out}.tmp`, out)
    // older builds of this target (another app version or address) are not served any more
    for (const name of await readdir(path.dirname(out))) {
      if (name.endsWith(desktopFileName(target)) && name !== path.basename(out)) await rm(path.join(path.dirname(out), name), { force: true })
    }
    return out
  } finally {
    await rm(stage, { recursive: true, force: true })
    await rm(`${out}.tmp`, { force: true })
  }
}

/** Builds per target once per brain process (concurrent requests share a build; failures retry). */
export const makeDesktopBuilds = (input: { readonly cacheDir: string }) => {
  const builds = new Map<string, Promise<string>>()
  return {
    get: (target: DesktopTarget, origin: string): Promise<string> => {
      const id = `${target} ${origin}`
      const existing = builds.get(id)
      if (existing) return existing
      const started = mkdir(path.join(input.cacheDir, "out"), { recursive: true }).then(() => buildTarget(input.cacheDir, origin, target))
      builds.set(id, started)
      started.catch(() => builds.delete(id))
      return started
    },
  }
}

const shQuote = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`

/** `curl -fsSL <origin>/desktop/install.sh | sh`: macOS → ~/Applications, Linux → ~/.local. */
export const desktopInstallScript = (origin: string): string => `#!/bin/sh
# Installs the OpenBot desktop app from ${origin}
set -eu
ORIGIN=${shQuote(origin)}
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=darwin-arm64 ;;
  Darwin-x86_64) TARGET=darwin-x64 ;;
  Linux-x86_64) TARGET=linux-x64 ;;
  Linux-aarch64|Linux-arm64) TARGET=linux-arm64 ;;
  *) echo "OpenBot: this computer ($(uname -s) $(uname -m)) is not supported; download the app from Settings instead." >&2; exit 1 ;;
esac
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "Downloading OpenBot (the first download for a computer takes a minute to prepare)…"
curl -fSL --progress-bar "$ORIGIN/desktop/download/$TARGET" -o "$TMP/package"
case "$TARGET" in
  darwin-*)
    osascript -e 'quit app "OpenBot"' >/dev/null 2>&1 || true
    mkdir -p "$HOME/Applications"
    ditto -x -k "$TMP/package" "$TMP/app"
    rm -rf "$HOME/Applications/OpenBot.app"
    mv "$TMP/app/OpenBot.app" "$HOME/Applications/OpenBot.app"
    xattr -cr "$HOME/Applications/OpenBot.app" 2>/dev/null || true
    codesign --force --deep --sign - "$HOME/Applications/OpenBot.app" >/dev/null 2>&1 || true
    open "$HOME/Applications/OpenBot.app"
    echo "OpenBot is in ~/Applications and open."
    ;;
  linux-*)
    DEST="$HOME/.local/share/openbot-desktop"
    pkill -f "$DEST/openbot" >/dev/null 2>&1 || true
    rm -rf "$DEST"
    mkdir -p "$DEST" "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/512x512/apps"
    tar -xzf "$TMP/package" -C "$DEST" --strip-components=1
    FLAGS=""
    # Electron's sandbox needs unprivileged user namespaces; some distributions turn them off.
    if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ] || [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" = 0 ]; then FLAGS="--no-sandbox"; fi
    printf '#!/bin/sh\\nexec "%s/openbot" %s "$@"\\n' "$DEST" "$FLAGS" > "$HOME/.local/bin/openbot-desktop"
    chmod +x "$HOME/.local/bin/openbot-desktop"
    cp "$DEST/resources/app/icon.png" "$HOME/.local/share/icons/hicolor/512x512/apps/openbot.png"
    cat > "$HOME/.local/share/applications/openbot.desktop" <<DESKTOP
[Desktop Entry]
Name=OpenBot
Comment=Your Bots
Exec=$HOME/.local/bin/openbot-desktop %U
Icon=openbot
Type=Application
Categories=Network;Chat;
StartupWMClass=OpenBot
MimeType=x-scheme-handler/openbot;
DESKTOP
    update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
    xdg-mime default openbot.desktop x-scheme-handler/openbot >/dev/null 2>&1 || true
    nohup "$HOME/.local/bin/openbot-desktop" >/dev/null 2>&1 &
    echo "OpenBot is installed (in your app launcher, or run openbot-desktop) and open."
    echo "Quick send: Ctrl+Alt+O, or bind a key to: openbot-desktop --quick-send"
    ;;
esac
`

/** `/desktop/install.sh` and `/desktop/download/:target` (public, like the node's: nothing secret is in them). */
export const DesktopRoutes: Layer.Layer<never, never, HttpRouter.HttpRouter | BrainNodesConfig | DataDir> = Layer.effectDiscard(
  Effect.gen(function*() {
    const router = yield* HttpRouter.HttpRouter
    const config = yield* BrainNodesConfig
    const dataDir = yield* DataDir
    const builds = makeDesktopBuilds({ cacheDir: path.join(dataDir.root, "desktop-builds") })
    yield* router.add(
      "GET",
      "/desktop/install.sh",
      Effect.map(config.brainOrigin, (origin) =>
        HttpServerResponse.text(desktopInstallScript(origin), {
          contentType: "text/x-shellscript; charset=utf-8",
          headers: { "cache-control": "no-store" },
        })),
    )
    const latest = new Map<string, Promise<{ readonly build: string; readonly version: string }>>()
    yield* router.add(
      "GET",
      "/desktop/latest",
      Effect.gen(function*() {
        const origin = yield* config.brainOrigin
        // the release's files never change while it runs: computed once per address
        let found = latest.get(origin)
        if (found === undefined) {
          found = latestDesktopBuild(origin)
          latest.set(origin, found)
          found.catch(() => latest.delete(origin))
        }
        const result = yield* Effect.result(Effect.tryPromise(() => found))
        if (result._tag === "Failure") return HttpServerResponse.text("unknown", { status: 500 })
        return HttpServerResponse.text(JSON.stringify(result.success), { contentType: "application/json", headers: { "cache-control": "no-store" } })
      }),
    )
    yield* router.add(
      "GET",
      "/desktop/download/:target",
      Effect.gen(function*() {
        const target = (yield* HttpRouter.params)["target"] ?? ""
        if (!isDesktopTarget(target)) {
          return HttpServerResponse.text(`unknown target "${target}" (one of ${DESKTOP_TARGETS.join(", ")})`, { status: 404 })
        }
        const origin = yield* config.brainOrigin
        const built = yield* Effect.result(Effect.tryPromise(() => builds.get(target, origin)))
        if (built._tag === "Failure") {
          yield* Effect.logWarning("could not build the desktop app", { target, cause: built.failure })
          return HttpServerResponse.text("OpenBot could not prepare the app for that computer. Check its log.", { status: 500 })
        }
        const file = Bun.file(built.success)
        return HttpServerResponse.raw(file, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename="${desktopFileName(target)}"`,
            "content-length": String(file.size),
            "cache-control": "no-store",
          },
        })
      }),
    )
  }),
)

/**
 * Installing the node daemon on another computer from this brain (public listener, no login: the
 * binary is the open-source daemon and carries no secret; the pairing code is the secret).
 *
 *   GET /node/install.sh            a POSIX sh installer for this brain's origin
 *   GET /node/download/:target      `openbot-node` for linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64
 *
 * The pairing dialog shows `curl -fsSL <origin>/node/install.sh | sh -s -- <code>`: the script picks the
 * binary for the machine, puts it in `~/.local/bin`, pairs with the code, installs the programs bot
 * desktops use on Linux (`desktopSetupSh`), and keeps `openbot-node run` going as a user service
 * (systemd on Linux, launchd on macOS; else in the background).
 *
 * Binaries are compiled from this brain's own source (`bun build --compile`, cross-compiled per
 * target) on first request after each start, so a node always speaks the brain's protocol. They are
 * cached in `<data>/node-builds`.
 */
import { DataDir } from "@openbot/core"
import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { mkdir, rename, rm } from "node:fs/promises"
import * as path from "node:path"
import { BrainNodesConfig } from "./config.ts"

export const INSTALL_TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const
export type InstallTarget = (typeof INSTALL_TARGETS)[number]

const isTarget = (s: string): s is InstallTarget => (INSTALL_TARGETS as ReadonlyArray<string>).includes(s)

/** The one-liner the pairing dialog shows. */
export const installCommand = (origin: string, code: string): string =>
  `curl -fsSL ${origin}/node/install.sh | sh -s -- ${code}`

/** Single-quoted for sh. */
const shQuote = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`

/**
 * `setup_desktop`, a POSIX sh function: on Linux, installs what bot desktops use (packages/node-daemon
 * desktop/programs.ts: Xvfb, x11vnc, xdotool, xfwm4, ImageMagick, and the dock, D-Bus, terminal, file
 * manager, editor and xsetroot) with apt-get or pacman, when any is missing. As root directly, else
 * through sudo when it can ask (a terminal) or needn't; otherwise, or with another package manager, it
 * prints the command. Never fatal; `OPENBOT_DESKTOP=0` skips it. Package managers read /dev/null, not
 * stdin: under `curl … | sh` stdin is the rest of the script.
 */
export const desktopSetupSh = `setup_desktop() {
  [ "$(uname -s)" = Linux ] || return 0
  [ "\${OPENBOT_DESKTOP:-1}" = 0 ] && return 0
  missing=""
  for p in Xvfb x11vnc xdotool xfwm4 import plank dbus-daemon xfce4-terminal thunar mousepad xsetroot; do
    command -v "$p" >/dev/null 2>&1 || missing="$missing $p"
  done
  [ -n "$missing" ] || return 0
  if command -v apt-get >/dev/null 2>&1; then
    update="apt-get update -qq"
    install="apt-get install -y -qq --no-install-recommends xvfb x11vnc xdotool xfwm4 imagemagick plank dbus xfce4-terminal thunar mousepad x11-xserver-utils"
  elif command -v pacman >/dev/null 2>&1; then
    update=""
    install="pacman -S --needed --noconfirm xorg-server-xvfb x11vnc xdotool xfwm4 imagemagick plank dbus xfce4-terminal thunar mousepad xorg-xsetroot"
  else
    echo "For bot desktops, install these with your package manager:$missing"
    return 0
  fi
  if [ "$(id -u)" = 0 ]; then
    as=""
  elif command -v sudo >/dev/null 2>&1 && { sudo -n true </dev/null 2>/dev/null || (: </dev/tty) 2>/dev/null; }; then
    as="sudo"
  else
    echo "For bot desktops, run: sudo $install"
    return 0
  fi
  echo "Installing the programs bot desktops use (missing:$missing)..."
  if [ -n "$as" ] && ! sudo -n true </dev/null 2>/dev/null; then echo "sudo asks for your password to install them."; fi
  if { [ -z "$update" ] || $as $update </dev/null; } && $as $install </dev/null; then
    echo "Installed the programs for bot desktops."
  else
    echo "Could not install them. For bot desktops, run: sudo $install"
  fi
}`

/**
 * The installer for `origin`. Arguments: the pairing code (optional: without it the binary is only
 * installed or updated). `OPENBOT_NODE_BIN_DIR` changes where it goes; `OPENBOT_NODE_SERVICE=0` skips
 * the service (pair, then run `openbot-node run` yourself); `OPENBOT_DESKTOP=0` leaves out the desktop
 * programs.
 */
export const installScript = (origin: string): string => `#!/bin/sh
# OpenBot node installer, from your OpenBot at ${origin}
# Usage: curl -fsSL ${origin}/node/install.sh | sh -s -- <pairing code>
set -eu

ORIGIN=${shQuote(origin)}
CODE="\${1:-}"
BIN_DIR="\${OPENBOT_NODE_BIN_DIR:-$HOME/.local/bin}"
BIN="$BIN_DIR/openbot-node"

fail() { echo "openbot-node: $*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "$(uname -s) is not supported yet (Linux and macOS are)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "$(uname -m) processors are not supported yet" ;;
esac

echo "Downloading the OpenBot node for $os-$arch..."
mkdir -p "$BIN_DIR"
tmp="$BIN_DIR/.openbot-node.$$"
trap 'rm -f "$tmp"' EXIT
if command -v curl >/dev/null 2>&1; then
  curl -fSL --progress-bar "$ORIGIN/node/download/$os-$arch" -o "$tmp" || fail "the download failed"
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$tmp" "$ORIGIN/node/download/$os-$arch" || fail "the download failed"
else
  fail "needs curl or wget"
fi
chmod +x "$tmp"
# Apple Silicon only runs signed binaries: sign it for this machine
if [ "$os" = darwin ] && command -v codesign >/dev/null 2>&1; then codesign --force -s - "$tmp" >/dev/null 2>&1 || true; fi
mv -f "$tmp" "$BIN"
trap - EXIT
echo "Installed $BIN"

if [ -n "$CODE" ]; then
  "$BIN" pair "$ORIGIN" "$CODE" --force
fi

# the node finds them when it starts, below
${desktopSetupSh}
setup_desktop

if [ "\${OPENBOT_NODE_SERVICE:-1}" = 0 ]; then
  echo "Start it with: $BIN run"
  exit 0
fi

if [ "$os" = linux ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  unit="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/openbot-node.service"
  mkdir -p "$(dirname "$unit")"
  cat >"$unit" <<UNIT
[Unit]
Description=OpenBot node
After=network-online.target

[Service]
ExecStart="$BIN" run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable openbot-node.service >/dev/null 2>&1
  systemctl --user restart openbot-node.service
  echo "Running as a user service: systemctl --user status openbot-node"
  echo "To keep it running while you are logged out: loginctl enable-linger \${USER:-$(id -un)}"
elif [ "$os" = darwin ]; then
  plist="$HOME/Library/LaunchAgents/ai.openbot.node.plist"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.openbot.node</string>
  <key>ProgramArguments</key><array><string>$BIN</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/openbot-node.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/openbot-node.log</string>
</dict>
</plist>
PLIST
  launchctl unload "$plist" >/dev/null 2>&1 || true
  launchctl load -w "$plist"
  echo "Running in the background (log: ~/Library/Logs/openbot-node.log)"
  echo "For your Bots to use this Mac's screen, macOS now asks to let openbot-node record the screen"
  echo "and control the computer: allow both (or later in System Settings > Privacy & Security)."
else
  log="\${XDG_STATE_HOME:-$HOME/.local/state}/openbot-node.log"
  mkdir -p "$(dirname "$log")"
  nohup "$BIN" run >>"$log" 2>&1 &
  echo "Running in the background until this computer restarts (log: $log)"
fi
echo "Done: it shows up in OpenBot under Settings > Computers."
`

/**
 * Compiles the node for a target once per brain process (concurrent requests share the build).
 * `entry` is apps/node's `src/main.ts`; `bun` is the Bun executable (the brain's own).
 */
export const makeNodeBuilds = (input: { readonly entry: string; readonly outDir: string; readonly bun?: string }) => {
  const builds = new Map<InstallTarget, Promise<string>>()
  const build = async (target: InstallTarget): Promise<string> => {
    await mkdir(input.outDir, { recursive: true })
    const out = path.join(input.outDir, `openbot-node-${target}`)
    const tmp = `${out}.${process.pid}.tmp`
    const proc = Bun.spawn(
      [
        input.bun ?? process.execPath,
        "build",
        "--compile",
        "--minify",
        `--target=bun-${target}`,
        input.entry,
        "--outfile",
        tmp,
      ],
      { stdout: "ignore", stderr: "pipe", cwd: path.dirname(input.entry) },
    )
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    if (code !== 0) {
      await rm(tmp, { force: true })
      throw new Error(stderr.trim().split("\n").slice(-3).join(" ") || `bun build exited with ${code}`)
    }
    await rename(tmp, out)
    return out
  }
  return {
    /** The binary's path; a failed build is retried by the next request. */
    get: (target: InstallTarget): Promise<string> => {
      const existing = builds.get(target)
      if (existing) return existing
      const started = build(target)
      builds.set(target, started)
      started.catch(() => builds.delete(target))
      return started
    },
  }
}

/** `/node/install.sh` and `/node/download/:target`, when the brain can build the node (`nodeInstall`). */
export const addInstallRoutes = (router: HttpRouter.HttpRouter) =>
  Effect.gen(function* () {
    const config = yield* BrainNodesConfig
    const dataDir = yield* DataDir
    const install = config.nodeInstall
    if (install === undefined) return
    const builds = makeNodeBuilds({ entry: install.entry, outDir: path.join(dataDir.root, "node-builds") })
    yield* router.add(
      "GET",
      "/node/install.sh",
      Effect.map(config.brainOrigin, (origin) =>
        HttpServerResponse.text(installScript(origin), {
          contentType: "text/x-shellscript; charset=utf-8",
          headers: { "cache-control": "no-store" },
        }),
      ),
    )
    yield* router.add(
      "GET",
      "/node/download/:target",
      Effect.gen(function* () {
        const target = (yield* HttpRouter.params)["target"] ?? ""
        if (!isTarget(target)) {
          return HttpServerResponse.text(`unknown target "${target}" (one of ${INSTALL_TARGETS.join(", ")})`, {
            status: 404,
          })
        }
        const built = yield* Effect.result(Effect.tryPromise(() => builds.get(target)))
        if (built._tag === "Failure") {
          yield* Effect.logWarning("could not build the node", { target, cause: built.failure })
          return HttpServerResponse.text("This OpenBot could not build the node for that computer. Check its log.", {
            status: 500,
          })
        }
        const file = Bun.file(built.success)
        return HttpServerResponse.raw(file, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename="openbot-node"`,
            "content-length": String(file.size),
            "cache-control": "no-store",
          },
        })
      }),
    )
  })

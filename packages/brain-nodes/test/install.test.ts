// Installing the node from the brain (NodeInstall): the pairing code comes with the installer
// one-liner, /node/install.sh is a valid sh script for the brain's origin, and /node/download/:target
// compiles the node entry (here a tiny stand-in) for that platform. Without `nodeInstall` none of it.
// Its `setup_desktop` installs the desktop programs with stand-in package managers.
import { afterAll, describe, expect, test } from "bun:test"
import { NodeAdmin } from "@openbot/core"
import { Effect, Layer } from "effect"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { desktopSetupSh, installScript } from "../src/index.ts"
import { BRAIN_ORIGIN, brainStack, run, startServer, tempDir } from "./helpers.ts"

const dir = tempDir()
afterAll(() => dir.cleanup())

const entry = join(dir.path, "tiny-node.ts")
writeFileSync(entry, `console.log("tiny-node " + process.argv.slice(2).join(" "))\n`)

const hostTarget = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`

const shCheck = (script: string) => {
  const file = join(dir.path, "install.sh")
  writeFileSync(file, script)
  return Bun.spawnSync(["sh", "-n", file], { stderr: "pipe" })
}

describe("node install", () => {
  test(
    "the pairing code comes with the installer one-liner; install.sh and the binary are served",
    () =>
      run(
        Effect.gen(function* () {
          const server = yield* startServer
          const admin = yield* NodeAdmin
          const code = yield* admin.createPairingCode
          expect(code.command).toBe(`curl -fsSL ${BRAIN_ORIGIN}/node/install.sh | sh -s -- ${code.code}`)

          const script = yield* Effect.promise(() =>
            fetch(`${server.http}/node/install.sh`).then(async (r) => ({ status: r.status, text: await r.text() })),
          )
          expect(script.status).toBe(200)
          expect(script.text).toContain(`ORIGIN='${BRAIN_ORIGIN}'`)
          expect(shCheck(script.text).exitCode).toBe(0)

          const unknown = yield* Effect.promise(() => fetch(`${server.http}/node/download/windows-x64`))
          expect(unknown.status).toBe(404)

          // two at once share one build
          const [a, b] = yield* Effect.promise(() =>
            Promise.all([
              fetch(`${server.http}/node/download/${hostTarget}`),
              fetch(`${server.http}/node/download/${hostTarget}`),
            ]),
          )
          expect([a.status, b.status]).toEqual([200, 200])
          const bin = join(dir.path, "openbot-node")
          writeFileSync(bin, new Uint8Array(yield* Effect.promise(() => a.arrayBuffer())))
          yield* Effect.promise(() => b.arrayBuffer())
          chmodSync(bin, 0o755)
          expect(Bun.spawnSync([bin, "version"]).stdout.toString().trim()).toBe("tiny-node version")
        }).pipe(Effect.provide(Layer.fresh(brainStack({ dataRoot: dir.path, nodeInstall: { entry } })))),
      ),
    120_000,
  )

  test(
    "without a node entry: the plain pair command and no installer",
    () =>
      run(
        Effect.gen(function* () {
          const server = yield* startServer
          const code = yield* (yield* NodeAdmin).createPairingCode
          expect(code.command).toBe(`openbot-node pair ${BRAIN_ORIGIN} ${code.code}`)
          expect((yield* Effect.promise(() => fetch(`${server.http}/node/install.sh`))).status).toBe(404)
        }).pipe(Effect.provide(Layer.fresh(brainStack({ dataRoot: dir.path })))),
      ),
    20_000,
  )

  test("install.sh quotes an origin with a quote in it", () => {
    const script = installScript("https://o'brien.example")
    expect(script).toContain(`ORIGIN='https://o'"'"'brien.example'`)
    expect(shCheck(script).exitCode).toBe(0)
  })
})

/**
 * Runs `setup_desktop` as `curl … | sh` would (the script on stdin, then a line after it) with only
 * stand-in programs on PATH: `id -u` prints `uid`, each of `have` exists, each of `tools` logs its
 * arguments (and reads stdin, as a package manager asking a question might).
 */
const setupDesktop = (input: { uid: number; have?: ReadonlyArray<string>; tools: ReadonlyArray<string> }) => {
  const bin = mkdtempSync(join(dir.path, "bin-"))
  const log = join(bin, "calls.log")
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  stub("uname", "echo Linux")
  stub("id", `echo ${input.uid}`)
  for (const name of input.have ?? []) stub(name, "true")
  for (const name of input.tools) stub(name, `echo "${name} $*" >>${log}; /bin/cat >/dev/null`)
  const out = Bun.spawnSync(["/bin/sh", "-s"], {
    stdin: new TextEncoder().encode(`${desktopSetupSh}\nsetup_desktop\necho after\n`),
    env: { PATH: bin },
    stdout: "pipe",
    stderr: "pipe",
  })
  const calls = Bun.spawnSync(["/bin/cat", log], { stdout: "pipe", stderr: "ignore" }).stdout.toString()
  return { out: out.stdout.toString(), calls: calls.trim().split("\n").filter(Boolean) }
}

const DESKTOP = ["Xvfb", "x11vnc", "xdotool", "xfwm4", "import", "plank", "dbus-daemon"]
const APPS = ["xfce4-terminal", "thunar", "mousepad", "xsetroot"]

describe("desktop programs (install.sh)", () => {
  test("as root with apt: installs them all, and the rest of the script still runs", () => {
    const { out, calls } = setupDesktop({ uid: 0, have: DESKTOP, tools: ["apt-get"] })
    expect(out).toContain("missing: xfce4-terminal thunar mousepad xsetroot")
    expect(calls).toEqual([
      "apt-get update -qq",
      expect.stringMatching(/^apt-get install -y -qq --no-install-recommends xvfb .*plank .*x11-xserver-utils$/),
    ])
    expect(out).toContain("Installed the programs for bot desktops.")
    expect(out.trim().endsWith("after")).toBe(true)
  })

  test("with pacman, through sudo that needs no password", () => {
    const { calls } = setupDesktop({ uid: 1000, tools: ["pacman", "sudo"] })
    expect(calls).toEqual([
      "sudo -n true",
      "sudo -n true",
      expect.stringMatching(/^sudo pacman -S --needed --noconfirm xorg-server-xvfb .*plank .*xorg-xsetroot$/),
    ])
  })

  test("everything there: nothing to do", () => {
    const { out, calls } = setupDesktop({ uid: 0, have: [...DESKTOP, ...APPS], tools: ["apt-get"] })
    expect(calls).toEqual([])
    expect(out.trim()).toBe("after")
  })

  test("not root and no sudo: says what to run", () => {
    const { out, calls } = setupDesktop({ uid: 1000, tools: ["apt-get"] })
    expect(calls).toEqual([])
    expect(out).toContain("For bot desktops, run: sudo apt-get install")
  })
})

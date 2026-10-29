// E2E (W3.1): computers. (1) The browser computer view on the local node: computer.ensure → the
// bot's browser (navigated through the gateway's `browser` tool) streams screencast frames into
// ComputerView → Take control → I'm done; the Terminal tab echoes. (2) Settings › Computers: create a
// pairing code, run the dialog's installer one-liner (the brain builds the node binary; own HOME, no
// service) and the installed binary → it shows online → approve its capabilities → a bot runs a
// shell command there. Fake harness only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Browser } from "playwright-core"
import type { Bot } from "@openbot/contracts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AppPage,
  type Brain,
  childEnv,
  connectRpc,
  eventually,
  hasChromium,
  launchBrowser,
  openApp,
  type Rpc,
  send,
  startBrain,
  waitIdle,
} from "./brain.ts"

const PAGE =
  "data:text/html,<body style='background:%23d43f3a;color:white;font:48px sans-serif'><h1>OpenBot e2e</h1></body>"

describe.skipIf(!hasChromium)("e2e: computers", () => {
  let brain: Brain
  let browser: Browser
  let rpc: Rpc
  let app: AppPage
  let bot: Bot
  const nodeHome = mkdtempSync(join(tmpdir(), "openbot-e2e-node-"))
  const nodeRoot = mkdtempSync(join(tmpdir(), "openbot-e2e-node-root-"))
  let daemon: ReturnType<typeof Bun.spawn> | undefined
  let daemonLog = ""

  beforeAll(async () => {
    brain = await startBrain()
    browser = await launchBrowser()
    rpc = await connectRpc(brain)
    bot = await rpc.call((c) => c["bots.create"]({ name: "Otto", harness: { kind: "fake" }, clientNonce: "e2e-otto" }))
    app = await openApp(browser, brain, { theme: "dark", route: `#/c/${bot.directConversationId}` })
    await app.page.getByRole("textbox", { name: "Message Otto" }).waitFor()
  }, 60_000)

  afterAll(async () => {
    if (daemon) {
      daemon.kill("SIGTERM")
      await Promise.race([daemon.exited, Bun.sleep(5000)])
      if (daemon.exitCode === null) daemon.kill("SIGKILL")
    }
    await app?.context.close()
    await rpc?.close()
    await browser?.close()
    await brain?.stop()
    rmSync(nodeHome, { recursive: true, force: true })
    rmSync(nodeRoot, { recursive: true, force: true })
  }, 60_000)

  test("the local node's browser streams into ComputerView; Take control → I'm done", async () => {
    const { page } = app
    const local = (await rpc.call((c) => c["nodes.list"]())).find((n) => n.kind === "local")
    expect(local?.status).toBe("online")
    expect(local?.capabilities.some((c) => c.startsWith("browser"))).toBe(true)
    // the bot opens its browser through the gateway's browser tool
    await send(page, "Otto", `tool: browser {"action": "navigate", "url": "${PAGE}"}`)
    await page.getByTestId("transcript").getByText("I called browser", { exact: false }).waitFor({ timeout: 30_000 })
    await waitIdle(page)
    const ensured = await rpc.call((c) => c["computer.ensure"]({ botId: bot.id }))
    void ensured
    await page.getByRole("button", { name: "View conversation details" }).click()
    const pane = page.getByTestId("details-pane")
    await pane.getByRole("tab", { name: "Computer" }).click()
    const thumb = pane.getByTestId("screen-thumbnail")
    await thumb.waitFor()
    await eventually(
      () => thumb.getByTestId("screen-empty").count(),
      (n) => n === 0,
      { label: "a live thumbnail", timeout: 20_000 },
    )
    await app.shot("e2e-40-computer-thumbnail")
    const wsLog: Array<string> = []
    page.on("console", (m) => {
      if (m.text().startsWith("WSX")) wsLog.push(m.text())
    })
    await page.evaluate(() => {
      const Orig = window.WebSocket
      const t0 = Date.now()
      let n = 0
      const Traced = function (url: string | URL, protocols?: string | Array<string>) {
        const ws = new Orig(url, protocols)
        const id = ++n
        if (String(url).includes("/ws/computer")) {
          let frames = 0
          console.log("WSX", Date.now() - t0, id, "new", String(url).slice(-40))
          ws.addEventListener("open", () => console.log("WSX", Date.now() - t0, id, "open"))
          ws.addEventListener("message", (e) =>
            typeof e.data === "string"
              ? console.log("WSX", Date.now() - t0, id, e.data)
              : ++frames <= 3 && console.log("WSX", Date.now() - t0, id, "frame"),
          )
          ws.addEventListener("close", (e) => console.log("WSX", Date.now() - t0, id, "close", e.code, e.reason))
        }
        return ws
      } as unknown as typeof WebSocket
      Object.assign(Traced, { prototype: Orig.prototype, CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
      window.WebSocket = Traced
    })
    await thumb.click()
    const view = page.getByTestId("computer-view")
    await view.waitFor()
    const take = view.getByRole("button", { name: "Take control" })
    await eventually(
      () => take.isEnabled(),
      (on) => on,
      { label: "a live screencast", timeout: 20_000 },
    ).catch(async (e: unknown) => {
      await app.shot("zz-computer-fail")
      throw new Error(`${String(e)}\nsockets:\n${wsLog.join("\n")}\nbrain log:\n${brain.log().slice(-6000)}`)
    })
    // frames are drawn: the canvas holds the page's red background
    const pixel = await eventually(
      () =>
        page.evaluate(() => {
          const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="computer-view"] canvas')
          if (!canvas || canvas.width === 0) return [0, 0, 0, 0]
          const ctx = canvas.getContext("2d")
          return ctx
            ? Array.from(ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height * 0.8), 1, 1).data)
            : [0, 0, 0, 0]
        }),
      (p) => p[0]! > 150 && p[1]! < 120 && p[2]! < 120,
      { label: "a red frame on the canvas", timeout: 20_000 },
    )
    expect(pixel[3]).toBe(255)
    await app.shot("e2e-41-computer-view")
    await take.click()
    const pill = view.getByTestId("control-pill")
    await pill.getByText("You're in control").waitFor()
    expect((await rpc.call((c) => c["computer.status"]({ botId: bot.id }))).controller).toBe("user")
    await app.shot("e2e-42-computer-control")
    await pill.getByRole("button", { name: "I'm done" }).click()
    await pill.getByText("Watching").waitFor()
    expect((await rpc.call((c) => c["computer.status"]({ botId: bot.id }))).controller).toBe("bot")
    expect(app.errors).toEqual([])
  }, 90_000)

  test("the Terminal tab echoes", async () => {
    const { page } = app
    const view = page.getByTestId("computer-view")
    await view.getByTestId("computer-tab-terminal").click()
    const host = view.getByTestId("terminal-host")
    await host.waitFor()
    await page.waitForTimeout(800)
    await host.click()
    await page.keyboard.type("echo e2e-$((40+2))-ok\n", { delay: 10 })
    await eventually(
      () => host.innerText(),
      (t) => t.includes("e2e-42-ok"),
      { label: "the echoed output", timeout: 15_000 },
    )
    await app.shot("e2e-43-terminal")
    await view.getByRole("button", { name: "Exit fullscreen" }).click()
    await view.waitFor({ state: "detached" })
    expect(app.errors).toEqual([])
  }, 60_000)

  test("Settings › Computers: install, pair and run a second node with the dialog's one-liner, approve it, run a command there", async () => {
    const { page } = app
    await page.getByRole("button", { name: "Account" }).click()
    await page.getByRole("menuitem", { name: "Computers" }).click()
    const settings = page.getByTestId("settings-dialog")
    await settings.waitFor()
    await page.getByTestId("pair-computer").click()
    const codeBox = page.getByTestId("pairing-code")
    await eventually(
      () => codeBox.innerText(),
      (t) => /\S{4,}/.test(t.trim()),
      { label: "a pairing code" },
    )
    const code = (await codeBox.innerText()).trim()
    const command = (
      await page.getByRole("dialog", { name: "Pair a computer" }).locator("code").first().innerText()
    ).trim()
    expect(command).toBe(`curl -fsSL ${brain.base}/node/install.sh | sh -s -- ${code}`)
    await app.shot("e2e-44-pairing-code")

    // the one-liner, as the owner would paste it on the other computer (no service: the test runs it;
    // no desktop programs: with apt and sudo that needs no password, as on CI, it would install them).
    // Not spawnSync: a blocked event loop misses the RPC socket's pings and it closes on a ping timeout.
    const env = childEnv({
      HOME: nodeHome,
      XDG_DATA_HOME: join(nodeHome, "data"),
      OPENBOT_NODE_BIN_DIR: join(nodeHome, "bin"),
      OPENBOT_NODE_SERVICE: "0",
      OPENBOT_DESKTOP: "0",
    })
    const install = Bun.spawn(["sh", "-c", command], { env, stdout: "pipe", stderr: "pipe" })
    const [exitCode, stdout, stderr] = await Promise.all([
      install.exited,
      new Response(install.stdout).text(),
      new Response(install.stderr).text(),
    ])
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain("Paired")
    const installed = join(nodeHome, "bin", "openbot-node")
    daemon = Bun.spawn([installed, "run", "--root", nodeRoot, "--no-browser"], { env, stdout: "pipe", stderr: "pipe" })
    void (async () => {
      const d = new TextDecoder()
      for await (const c of daemon!.stderr as ReadableStream<Uint8Array>) daemonLog += d.decode(c)
    })()
    void (async () => {
      const d = new TextDecoder()
      for await (const c of daemon!.stdout as ReadableStream<Uint8Array>) daemonLog += d.decode(c)
    })()

    // the pairing dialog turns into "Approve <node>?"
    const dialog = page.getByRole("dialog", { name: "Pair a computer" })
    await dialog
      .getByText(/^Approve .+\?$/)
      .waitFor({ timeout: 30_000 })
      .catch((e: unknown) => {
        throw new Error(`${String(e)}\nnode log:\n${daemonLog}`)
      })
    await app.shot("e2e-45-approve-node")
    await dialog.getByRole("button", { name: "Approve" }).click()
    await dialog.waitFor({ state: "detached" })
    const remote = await eventually(
      () => rpc.call((c) => c["nodes.list"]()).then((l) => l.find((n) => n.kind === "remote")),
      (n) => n !== undefined && n.status === "online" && n.capabilities.length > 0,
      { label: "the remote node online with capabilities" },
    )
    expect(remote!.capabilities.some((c) => c.startsWith("shell"))).toBe(true)
    const row = settings.getByTestId("node-row").filter({ hasText: remote!.label }).filter({ hasNotText: "Brain" })
    await row.getByText("Online").waitFor()
    await row.waitFor()
    await app.shot("e2e-46-node-online")
    await page.keyboard.press("Escape")
    await settings.waitFor({ state: "detached" })

    // move Otto onto the paired node (details › Brain › Runs on): remote placement B1 gives it the
    // gateway's node tools aimed at that node
    const pane = page.getByTestId("details-pane")
    if ((await pane.count()) === 0) await page.getByRole("button", { name: "View conversation details" }).click()
    await pane.getByRole("tab", { name: "Details" }).click()
    await pane.getByRole("button", { name: "Runs on" }).click()
    await page.getByRole("menu", { name: "Runs on" }).getByText(remote!.label, { exact: true }).click()
    await eventually(
      () => rpc.call((c) => c["bots.get"]({ botId: bot.id })),
      (b) => b.hostNodeId === remote!.id,
      { label: "Otto on the paired node" },
    )
    await app.shot("e2e-47-runs-on-node")
    // a bot runs a command on the paired node (gateway node tool → approval → node daemon)
    await send(page, "Otto", `tool: shell {"command": "echo hello-from-$((6*7)) in $PWD"}`)
    const card = page.locator('[data-card="approval"][data-status="pending"]')
    await card.waitFor({ timeout: 20_000 }).catch(async (e: unknown) => {
      throw new Error(`${String(e)}\ntranscript:\n${(await page.getByTestId("transcript").innerText()).slice(-1500)}`)
    })
    await app.shot("e2e-48-remote-shell-approval")
    await card.getByRole("button", { name: "Allow once" }).click()
    await page
      .getByTestId("transcript")
      .getByText("hello-from-42", { exact: false })
      .first()
      .waitFor({ timeout: 20_000 })
    await waitIdle(page)
    await app.shot("e2e-49-remote-shell-result")
    // it ran inside the node's root (the bot's workspace there), not on the brain's data dir
    const text = await page.getByTestId("transcript").innerText()
    expect(text).toContain(nodeRoot)
    expect(app.errors).toEqual([])
  }, 120_000)
})

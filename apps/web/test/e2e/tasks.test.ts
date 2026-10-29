// E2E: background work (D5.7) against the real brain with the Demo (fake) harness. The bot starts
// work with `bg:` (start_task through the real MCP gateway) and answers at once; the owner chats
// meanwhile and gets immediate replies; the chat's ONE status line (the activity row's look) says
// "Handling…" while the bot is otherwise idle and the turn's phrase while it answers, and the sidebar
// row agrees; the Tasks tab lists the work with its steps; Stop cancels only that work; a change
// passed on with `upd:` (update_task) reaches running work and shows among its steps; the bot
// reports results. Desktop and phone. Screenshots: e2e/screenshots/e2e-5x-*.png.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Browser, BrowserContext, Page } from "playwright-core"
import type { Bot } from "@openbot/contracts"
import {
  type AppPage,
  type Brain,
  connectRpc,
  eventually,
  hasChromium,
  launchBrowser,
  openApp,
  type Rpc,
  send,
  shotsDir,
  startBrain,
  waitIdle,
} from "./brain.ts"

describe.skipIf(!hasChromium)("e2e: background work", () => {
  let brain: Brain
  let browser: Browser
  let rpc: Rpc
  let app: AppPage
  let nova: Bot

  beforeAll(async () => {
    brain = await startBrain()
    browser = await launchBrowser()
    rpc = await connectRpc(brain)
    nova = await rpc.call((c) =>
      c["bots.create"]({ name: "Nova", harness: { kind: "fake" }, clientNonce: "e2e-tasks-nova" }),
    )
    app = await openApp(browser, brain, {
      theme: "dark",
      route: `#/c/${encodeURIComponent(nova.directConversationId)}`,
    })
    await app.page.getByRole("textbox", { name: "Message Nova" }).waitFor()
  }, 60_000)

  afterAll(async () => {
    await app?.context.close()
    await rpc?.close()
    await browser?.close()
    await brain?.stop()
  })

  test("the bot hands work off and answers at once; Handling… shows; the owner chats meanwhile", async () => {
    const { page } = app
    const transcript = page.getByTestId("transcript")
    await send(page, "Nova", "bg: 8 HN digest")
    await transcript.getByText("Sure — I'll get back to you about HN digest.", { exact: true }).waitFor()
    const handling = page.getByTestId("handling")
    await handling.waitFor()
    expect((await handling.innerText()).trim()).toBe("Handling…")
    await waitIdle(page)
    // the sidebar row of the (otherwise idle) bot says Handling… too
    await page.locator(`[data-row="${nova.id}"]`).getByText("Handling…", { exact: true }).waitFor()
    await app.shot("e2e-50-handling")

    // the owner talks to the bot meanwhile: an immediate answer
    const t0 = Date.now()
    await send(page, "Nova", "echo: still here while you work")
    await transcript.getByText("still here while you work", { exact: true }).last().waitFor()
    expect(Date.now() - t0).toBeLessThan(5_000)
    const [task] = await rpc.call((c) => c["tasks.list"]({ botId: nova.id }))
    expect(task).toMatchObject({ title: "HN digest", status: "running" })
    await handling.waitFor()
    // the work's steps are not chat bubbles
    expect(await transcript.getByText("Working on HN digest", { exact: false }).count()).toBe(0)
    expect(app.errors).toEqual([])
  }, 60_000)

  test("one status line: the turn's phrase while the bot answers, Handling… again after", async () => {
    const { page } = app
    const transcript = page.getByTestId("transcript")
    const lines = transcript.locator('[role="status"][data-status]')
    await send(page, "Nova", "slow: one careful word at a time while the digest runs in the meantime")
    await transcript.locator('[data-status="turn"]').waitFor()
    // never two lines (and never a second style) for the same bot
    expect(await lines.count()).toBe(1)
    expect(await page.getByTestId("handling").count()).toBe(0)
    await app.shot("e2e-50b-one-status-turn")
    await waitIdle(page)
    await page.getByTestId("handling").waitFor()
    expect(await lines.count()).toBe(1)
    // the same look as the activity row: the bot's avatar and the shimmering phrase
    expect(await page.getByTestId("handling").locator(".shimmer-text").innerText()).toBe("Handling…")
    expect(app.errors).toEqual([])
  }, 60_000)

  test("Handling… opens the Tasks tab: the running work with its steps", async () => {
    const { page } = app
    await page.getByTestId("handling").getByRole("button").first().click()
    const pane = page.getByTestId("details-pane")
    await pane.getByTestId("tasks-tab").waitFor()
    expect(await pane.getByRole("tab", { name: "Tasks" }).getAttribute("aria-selected")).toBe("true")
    const row = pane.getByTestId("task-row").filter({ hasText: "HN digest" })
    await row.waitFor()
    expect(await row.getAttribute("data-status")).toBe("running")
    await row.getByText("in your chat", { exact: false }).waitFor()
    await row.getByTestId("task-toggle").click()
    await row.getByTestId("task-detail").locator("[data-step-list]").waitFor()
    await app.shot("e2e-51-tasks-tab")
    expect(app.errors).toEqual([])
  }, 60_000)

  test("the result is reported by the bot; the work shows as done with its result", async () => {
    const { page } = app
    const transcript = page.getByTestId("transcript")
    await transcript
      .getByText("Update on HN digest: Here is HN digest: everything checked out after 8s of work.", { exact: true })
      .waitFor({ timeout: 30_000 })
    await page.getByTestId("handling").waitFor({ state: "detached" })
    const row = page.getByTestId("details-pane").getByTestId("task-row").filter({ hasText: "HN digest" })
    await eventually(
      () => row.getAttribute("data-status"),
      (s) => s === "succeeded",
      { label: "succeeded row" },
    )
    await row.getByTestId("task-result").getByText("everything checked out", { exact: false }).waitFor()
    await waitIdle(page)
    await app.shot("e2e-52-task-done")
    expect(app.errors).toEqual([])
  }, 60_000)

  test("Stop cancels only that work; the bot is told and says so", async () => {
    const { page } = app
    const transcript = page.getByTestId("transcript")
    await send(page, "Nova", "bg: 60 slow one")
    await transcript.getByText("Sure — I'll get back to you about slow one.", { exact: true }).waitFor()
    await send(page, "Nova", "bg: 60 other one")
    await transcript.getByText("Sure — I'll get back to you about other one.", { exact: true }).waitFor()
    const pane = page.getByTestId("details-pane")
    const slow = pane.getByTestId("task-row").filter({ hasText: "slow one" })
    await eventually(
      () => slow.getAttribute("data-status"),
      (s) => s === "running",
      { label: "slow running" },
    )
    await app.shot("e2e-53-two-running")
    await slow.getByTestId("task-stop").click()
    await eventually(
      () => slow.getAttribute("data-status"),
      (s) => s === "cancelled",
      { label: "slow stopped" },
    )
    await transcript
      .getByText("Update on slow one: The owner stopped it before it finished.", { exact: false })
      .waitFor()
    const tasks = await rpc.call((c) => c["tasks.list"]({ botId: nova.id }))
    expect(tasks.find((t) => t.title === "other one")?.status).toBe("running")
    expect(tasks.find((t) => t.title === "slow one")).toMatchObject({ status: "cancelled", stoppedBy: "owner" })
    // still handling the other one
    await page.getByTestId("handling").waitFor()
    await waitIdle(page)
    await app.shot("e2e-54-stopped")
    await pane.getByTestId("task-row").filter({ hasText: "other one" }).getByTestId("task-stop").click()
    await page.getByTestId("handling").waitFor({ state: "detached" })
    expect(app.errors).toEqual([])
  }, 90_000)

  test("a change for running work reaches it; the Tasks tab shows the update among its steps", async () => {
    const { page } = app
    const transcript = page.getByTestId("transcript")
    await send(page, "Nova", "bg: 8 film")
    await transcript.getByText("Sure — I'll get back to you about film.", { exact: true }).waitFor()
    await waitIdle(page)
    await send(page, "Nova", "upd: film | center the globe")
    await transcript.getByText("Got it — I'm working that into film.", { exact: true }).waitFor()
    await page.getByTestId("handling").getByRole("button").first().click()
    const row = page.getByTestId("details-pane").getByTestId("task-row").filter({ hasText: "film" })
    await row.waitFor()
    if ((await row.getByTestId("task-detail").count()) === 0) await row.getByTestId("task-toggle").click()
    const update = row.getByTestId("task-detail").getByTestId("task-update")
    await update.getByText("center the globe", { exact: true }).waitFor()
    await waitIdle(page)
    await app.shot("e2e-57-task-update")
    // the running work took the change: its result has it, and the bot reports it
    await transcript
      .getByText("Update on film: Here is film, now with your update (center the globe): everything checked out.", {
        exact: true,
      })
      .waitFor({ timeout: 30_000 })
    await eventually(
      () => row.getAttribute("data-status"),
      (st) => st === "succeeded",
      { label: "film done" },
    )
    const tasks = await rpc.call((c) => c["tasks.list"]({ botId: nova.id }))
    expect(tasks.filter((t) => t.title === "film")).toHaveLength(1) // not started over
    expect(app.errors).toEqual([])
  }, 60_000)
})

describe.skipIf(!hasChromium)("e2e: background work on a phone", () => {
  let brain: Brain
  let browser: Browser
  let rpc: Rpc
  let context: BrowserContext
  let page: Page
  const errors: Array<string> = []

  beforeAll(async () => {
    brain = await startBrain()
    browser = await launchBrowser()
    rpc = await connectRpc(brain)
    const bot = await rpc.call((c) =>
      c["bots.create"]({ name: "Pico", harness: { kind: "fake" }, clientNonce: "e2e-tasks-pico" }),
    )
    context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      colorScheme: "dark",
    })
    page = await context.newPage()
    page.setDefaultTimeout(15_000)
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
    await page.goto(brain.loginUrl)
    await page.goto(`${brain.base}/#/c/${encodeURIComponent(bot.directConversationId)}`)
    await page.getByRole("textbox", { name: "Message Pico" }).waitFor()
  }, 60_000)

  afterAll(async () => {
    await context?.close()
    await rpc?.close()
    await browser?.close()
    await brain?.stop()
  })

  test("Handling… above the composer opens the Tasks page", async () => {
    const box = page.getByRole("textbox", { name: "Message Pico" })
    await box.fill("bg: 30 phone digest")
    await page.getByRole("button", { name: "Send" }).click()
    await page
      .getByTestId("transcript")
      .getByText("Sure — I'll get back to you about phone digest.", { exact: true })
      .waitFor()
    await page.getByTestId("handling").waitFor()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${shotsDir}/e2e-55-phone-handling.png` })
    await page.getByTestId("handling").getByRole("button").first().tap()
    const pane = page.getByTestId("details-pane")
    await pane.getByTestId("tasks-tab").waitFor()
    const row = pane.getByTestId("task-row").filter({ hasText: "phone digest" })
    await row.waitFor()
    // the pane slides in: its width settles at full screen once the animation ends
    await eventually(
      async () => (await pane.boundingBox())?.width,
      (width) => width === 393,
      { label: "the pane at full width" },
    )
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${shotsDir}/e2e-56-phone-tasks.png` })
    await row.getByTestId("task-stop").tap()
    await eventually(
      () => row.getAttribute("data-status"),
      (s) => s === "cancelled",
      { label: "stopped" },
    )
    expect(errors).toEqual([])
  }, 60_000)
})

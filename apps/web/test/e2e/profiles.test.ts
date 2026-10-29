// E2E: profiles. Settings › Profiles creates, renames, switches and deletes; every open page follows a
// switch (one made on another device too) and leaves nothing of the profile it left on screen; its
// drafts come back with it. Coming back shows "While you were away": what the profile held back, what
// needs you first. Real brain, fake harness.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Browser, Page } from "playwright-core"
import type { ConversationId } from "@openbot/contracts"
import {
  type AppPage,
  type Brain,
  connectRpc,
  eventually,
  hasChromium,
  launchBrowser,
  openApp,
  type Rpc,
  startBrain,
} from "./brain.ts"

describe.skipIf(!hasChromium)("e2e: profiles", () => {
  let brain: Brain
  let browser: Browser
  let rpc: Rpc
  let laptop: AppPage
  let phone: AppPage
  let ottoDm: ConversationId
  let adaDm: ConversationId

  beforeAll(async () => {
    brain = await startBrain({ harnesses: "fake" })
    rpc = await connectRpc(brain)
    const create = (name: string) =>
      rpc.call((c) =>
        c["bots.create"]({ name, harness: { kind: "fake" }, clientNonce: `e2e-profiles-${name}`, introduce: false }),
      )
    ottoDm = (await create("Otto")).directConversationId as ConversationId
    adaDm = (await create("Ada")).directConversationId as ConversationId
    browser = await launchBrowser()
    laptop = await openApp(browser, brain, { route: `#/c/${encodeURIComponent(ottoDm)}` })
    phone = await openApp(browser, brain, { route: `#/c/${encodeURIComponent(adaDm)}` })
  }, 60_000)

  afterAll(async () => {
    await laptop?.context.close()
    await phone?.context.close()
    await rpc?.close()
    await browser?.close()
    await brain?.stop()
  })

  /** Marks the page that runs now: a reload drops the mark. */
  const mark = (page: Page) => page.evaluate(() => Object.assign(window, { marked: true }))
  const reloaded = (page: Page) => page.waitForFunction(() => !("marked" in window), undefined, { timeout: 15_000 })
  const sidebarHas = (page: Page, name: string) => page.getByRole("navigation").getByText(name, { exact: true })
  const accountMenu = async (page: Page) => {
    await page.getByRole("button", { name: "Account" }).click()
    return page.getByRole("menu", { name: "Account" })
  }
  const newChatBox = async (page: Page) => {
    await page.keyboard.press("Control+n")
    const box = page.getByRole("textbox", { name: "Message Bot" })
    await box.waitFor()
    return box
  }

  test("create and rename a profile, then switch to it: every page shows it, with nothing of Main", async () => {
    const { page } = laptop
    await page.getByRole("textbox", { name: "Message Otto" }).fill("half a thought")
    await (await newChatBox(page)).fill("a new idea")
    await sidebarHas(phone.page, "Otto").waitFor()

    await (await accountMenu(page)).getByRole("menuitem", { name: "Manage profiles…" }).click()
    const list = page.getByTestId("profiles-list")
    await page.getByRole("button", { name: "New profile" }).click()
    await list.getByRole("textbox", { name: "Name" }).fill("Demo")
    await list.getByRole("button", { name: "Create" }).click()
    const demo = list.getByTestId("profile-row").filter({ hasText: "Demo" })
    await demo.waitFor()
    await demo.getByRole("button", { name: "Demo actions" }).click()
    await page.getByRole("menuitem", { name: "Rename" }).click()
    await list.getByRole("textbox", { name: "Profile name" }).fill("Stage demo")
    await page.keyboard.press("Enter")
    const stage = list.getByTestId("profile-row").filter({ hasText: "Stage demo" })
    await stage.waitFor()
    await laptop.shot("e2e-90-profiles")

    // Main keeps working while the demo runs: Otto asks something after a moment, Ada finishes later
    const send = (conversationId: ConversationId, text: string) =>
      rpc.call((c) => c["messages.send"]({ conversationId, text, clientNonce: `e2e-profiles-${text}` }))
    await send(ottoDm, "work: 2 Prep\nask: Ship it? | Yes | No")
    await send(adaDm, "work: 4 Report")

    await Promise.all([mark(page), mark(phone.page)])
    await stage.getByRole("button", { name: "Switch" }).click()
    for (const app of [laptop, phone]) {
      await reloaded(app.page)
      await app.page.getByRole("button", { name: "Account" }).waitFor()
      expect(await sidebarHas(app.page, "Otto").count()).toBe(0)
      expect(await sidebarHas(app.page, "Ada").count()).toBe(0)
    }
    const menu = await accountMenu(page)
    expect(await menu.getByRole("menuitemradio", { name: "Stage demo" }).getAttribute("aria-checked")).toBe("true")
    await laptop.shot("e2e-91-profile-switched")
    await page.keyboard.press("Escape")
    expect(await (await newChatBox(page)).inputValue()).toBe("")
  }, 60_000)

  test("back to Main: While you were away lists what needs you first, and Main's drafts are back", async () => {
    const { page } = laptop
    // nothing of Main shows while the demo is on, so give Ada's 4 s report time to land
    await page.waitForTimeout(5_000)
    await mark(page)
    await (await accountMenu(page)).getByRole("menuitemradio", { name: "Main" }).click()
    await reloaded(page)

    const away = page.getByRole("dialog", { name: "While you were away" })
    await away.waitFor()
    const groups = away.getByTestId("away-group")
    expect(await groups.allTextContents()).toEqual([
      expect.stringMatching(/^Otto\s*Needs you.*Ship it\?/),
      expect.stringContaining("Ada"),
    ])
    await laptop.shot("e2e-92-while-you-were-away")

    await groups.first().getByRole("button").first().click()
    await away.waitFor({ state: "detached" })
    await page.getByRole("textbox", { name: "Message Otto" }).waitFor()
    expect(await page.getByRole("textbox", { name: "Message Otto" }).inputValue()).toBe("half a thought")
    expect(await (await newChatBox(page)).inputValue()).toBe("a new idea")
    await eventually(
      () => rpc.call((c) => c["profiles.away"]()),
      (summary) => summary.items.length === 0,
      { label: "the held notifications cleared" },
    )
  }, 60_000)

  test("delete: never Main or the active profile; another one goes after a confirm", async () => {
    const { page } = laptop
    await (await accountMenu(page)).getByRole("menuitem", { name: "Manage profiles…" }).click()
    const list = page.getByTestId("profiles-list")
    const row = (name: string) => list.getByTestId("profile-row").filter({ hasText: name })
    const mainActions = row("Main").getByRole("button", { name: "Main actions" })
    await mainActions.click()
    expect(await page.getByRole("menuitem", { name: "Delete" }).isDisabled()).toBe(true)
    await mainActions.click()

    await row("Stage demo").getByRole("button", { name: "Stage demo actions" }).click()
    await page.getByRole("menuitem", { name: "Delete" }).click()
    const confirm = page.getByRole("dialog", { name: "Delete Stage demo?" })
    await laptop.shot("e2e-93-delete-profile")
    await confirm.getByRole("button", { name: "Delete" }).click()
    await row("Stage demo").waitFor({ state: "detached" })
    expect((await rpc.call((c) => c["profiles.list"]())).profiles.map((p) => p.name)).toEqual(["Main"])
    expect(laptop.errors).toEqual([])
    expect(phone.errors).toEqual([])
  }, 60_000)
})

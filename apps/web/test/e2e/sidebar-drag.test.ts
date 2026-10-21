// E2E: dragging chats in the sidebar (real brain, Chromium): into a section, reordered inside it,
// onto the pins, a group chat into a section and back out to Group chats. Screenshots: e2e-9x-*.png.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Bot, SectionId } from "@openbot/contracts"
import type { Browser, Locator, Page } from "playwright-core"
import { type AppPage, type Brain, connectRpc, eventually, hasChromium, launchBrowser, openApp, type Rpc, startBrain } from "./brain.ts"

/** A drag with the mouse, step by step (the pins' drop area only appears once a drag started). */
const drag = async (page: Page, from: Locator, to: () => Locator, where: "top" | "bottom" | "center" = "center") => {
  const a = (await from.boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 4, a.y + a.height / 2 + 4, { steps: 4 })
  const target = to()
  await target.waitFor()
  const b = (await target.boundingBox())!
  const y = where === "top" ? b.y + 4 : where === "bottom" ? b.y + b.height - 4 : b.y + b.height / 2
  await page.mouse.move(b.x + b.width / 2, y, { steps: 8 })
  await page.mouse.up()
}

describe.skipIf(!hasChromium)("e2e: dragging chats in the sidebar", () => {
  let brain: Brain
  let browser: Browser
  let rpc: Rpc
  let app: AppPage
  let ada: Bot
  let bob: Bot
  let cy: Bot
  let work: SectionId

  beforeAll(async () => {
    brain = await startBrain()
    browser = await launchBrowser()
    rpc = await connectRpc(brain)
    ada = await rpc.call((c) => c["bots.create"]({ name: "Ada", harness: { kind: "fake" }, clientNonce: "drag-ada", introduce: false }))
    bob = await rpc.call((c) => c["bots.create"]({ name: "Bob", harness: { kind: "fake" }, clientNonce: "drag-bob", introduce: false }))
    cy = await rpc.call((c) => c["bots.create"]({ name: "Cy", harness: { kind: "fake" }, clientNonce: "drag-cy", introduce: false }))
    work = (await rpc.call((c) => c["sections.create"]({ name: "Work" }))).id
    app = await openApp(browser, brain, { theme: "dark", route: `#/c/${ada.directConversationId}` })
    await app.page.locator(`[data-section="${work}"]`).waitFor()
  }, 60_000)

  afterAll(async () => {
    await app?.context.close()
    await rpc?.close()
    await browser?.close()
    await brain?.stop()
  })

  const botOf = (id: Bot["id"]) => rpc.call((c) => c["bots.get"]({ botId: id }))
  const rowsIn = (page: Page, section: string) => page.locator(`[data-section="${section}"] [data-row]`).evaluateAll((els) => els.map((e) => e.getAttribute("data-row")))

  test("into a section, reordered there, and onto the pins", async () => {
    const { page } = app
    const section = () => page.locator(`[data-section="${work}"]`)
    await drag(page, page.locator(`[data-row="${ada.id}"]`), section)
    await eventually(() => botOf(ada.id), (b) => b.sectionId === work, { label: "Ada in Work" })
    await drag(page, page.locator(`[data-row="${bob.id}"]`), () => page.locator(`[data-row="${ada.id}"]`), "bottom")
    await eventually(() => rowsIn(page, work), (rows) => rows.join() === [ada.id, bob.id].join(), { label: "Ada, Bob" })
    await app.shot("e2e-90-sidebar-section")
    // Bob above Ada
    await drag(page, page.locator(`[data-row="${bob.id}"]`), () => page.locator(`[data-row="${ada.id}"]`), "top")
    await eventually(() => rowsIn(page, work), (rows) => rows.join() === [bob.id, ada.id].join(), { label: "Bob, Ada" })
    expect(await botOf(bob.id)).toMatchObject({ sectionId: work, sidebarOrder: 0 })
    // the pins: their drop area appears once the drag starts
    await drag(page, page.locator(`[data-row="${cy.id}"]`), () => page.getByText("Drag here to pin"))
    await eventually(() => botOf(cy.id), (b) => b.pinned, { label: "Cy pinned" })
    await page.locator(`[aria-label="Pinned Bots"] [data-bot="${cy.id}"]`).waitFor()
    await app.shot("e2e-91-sidebar-pinned")
    expect(app.errors).toEqual([])
  }, 60_000)

  test("a group chat goes into a section and back to Group chats", async () => {
    const { page } = app
    const group = await rpc.call((c) => c["conversations.createGroup"]({ title: "Crew", memberBotIds: [ada.id, bob.id] }))
    const row = () => page.locator(`[data-row="${group.id}"]`)
    await row().waitFor()
    await drag(page, row(), () => page.locator(`[data-section="${work}"]`))
    await eventually(() => rowsIn(page, work), (rows) => rows.includes(group.id), { label: "Crew in Work" })
    // Group chats stays as a place to drag it back to
    await drag(page, row(), () => page.locator(`[data-section="groups"]`))
    await eventually(() => rowsIn(page, "groups"), (rows) => rows.includes(group.id), { label: "Crew back in Group chats" })
    expect(app.errors).toEqual([])
  }, 60_000)
})

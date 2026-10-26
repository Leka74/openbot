// E2E: the `/skill` command in the message box (D5.5) against the real brain with the Demo (fake)
// harness: typing `/` offers the Bot's skills (an argument hint beside the one that has it), Enter
// completes it, and exactly a real command is colored; the message goes out as typed. Screenshots:
// e2e/screenshots/e2e-skills-command-*.png.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Browser } from "playwright-core"
import type { Bot, SkillName } from "@openbot/contracts"
import {
  type AppPage,
  type Brain,
  connectRpc,
  hasChromium,
  launchBrowser,
  openApp,
  type Rpc,
  startBrain,
} from "./brain.ts"

describe.skipIf(!hasChromium)("e2e: /skill command", () => {
  let brain: Brain
  let browser: Browser
  let rpc: Rpc
  let nova: Bot
  let app: AppPage

  beforeAll(async () => {
    brain = await startBrain()
    browser = await launchBrowser()
    rpc = await connectRpc(brain)
    nova = await rpc.call((c) =>
      c["bots.create"]({ name: "Nova", harness: { kind: "fake" }, clientNonce: "e2e-skills-nova", introduce: false }),
    )
    const name = (n: string) => n as SkillName
    await rpc.call((c) =>
      c["skills.upsert"]({
        name: name("grill-me"),
        description: "A relentless interview to sharpen a plan.",
        body: "Ask hard questions.",
        disableModelInvocation: true,
      }),
    )
    await rpc.call((c) =>
      c["skills.upsert"]({ name: name("weekly-report"), description: "The Friday status report.", body: "Collect." }),
    )
    await rpc.call((c) => c["skills.assign"]({ name: name("grill-me"), botIds: [nova.id] }))
    await rpc.call((c) => c["skills.assign"]({ name: name("weekly-report"), botIds: [nova.id] }))
    app = await openApp(browser, brain, { theme: "dark", route: `#/c/${nova.directConversationId}` })
  }, 60_000)

  afterAll(async () => {
    await app?.context.close()
    await rpc?.close()
    await browser?.close()
    await brain?.stop()
  })

  test("typing / offers the Bot's skills, filters them and completes one", async () => {
    const box = app.page.getByRole("textbox", { name: "Message Nova" })
    await box.click()
    await box.pressSequentially("/")
    const menu = app.page.getByRole("menu", { name: "Use a skill" })
    await menu.getByText("/grill-me").waitFor()
    await menu.getByText("/weekly-report").waitFor()
    await app.shot("e2e-skills-command-1-menu")
    await box.pressSequentially("gri")
    await menu.getByText("/grill-me").waitFor()
    expect(await menu.getByText("/weekly-report").count()).toBe(0)
    await box.press("Enter")
    expect(await box.inputValue()).toBe("/grill-me ")
    await app.page.getByTestId("composer-command").waitFor()
  })

  test("a real command is colored, text after it is not; an unknown one is plain", async () => {
    const { page } = app
    const box = page.getByRole("textbox", { name: "Message Nova" })
    await box.pressSequentially("my launch plan")
    const colored = page.getByTestId("composer-command")
    expect(await colored.locator("span").first().textContent()).toBe("/grill-me")
    // the colored layer sits exactly over the textarea
    const [layer, field] = await Promise.all([colored.boundingBox(), box.boundingBox()])
    expect(Math.abs(layer!.x - field!.x)).toBeLessThan(1)
    expect(Math.abs(layer!.y - field!.y)).toBeLessThan(1)
    expect(Math.abs(layer!.width - field!.width)).toBeLessThan(1)
    await app.shot("e2e-skills-command-2-colored")

    await box.fill("/not-a-skill my launch plan")
    expect(await page.getByTestId("composer-command").count()).toBe(0)
    await box.fill("please /grill-me")
    expect(await page.getByTestId("composer-command").count()).toBe(0)
  })

  test("the message goes out as typed", async () => {
    const { page } = app
    const box = page.getByRole("textbox", { name: "Message Nova" })
    await box.fill("/grill-me my launch plan")
    await box.press("Enter")
    await page.getByTestId("transcript").getByText("/grill-me my launch plan").waitFor()
    expect(await box.inputValue()).toBe("")
    expect(app.errors).toEqual([])
  })
})

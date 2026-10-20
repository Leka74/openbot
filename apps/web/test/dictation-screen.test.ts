import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { chromium, type Browser } from "playwright-core"
import { chromiumPath, openPage, startMock, type RunningMock } from "./shoot.ts"

const FAKE_MICROPHONE = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]

describe.skipIf(!existsSync(chromiumPath))("dictation in the composer against the dev mock", () => {
  let mock: RunningMock
  let browser: Browser
  beforeAll(async () => {
    mock = await startMock(0, ["--fast"])
    browser = await chromium.launch({ executablePath: chromiumPath, args: FAKE_MICROPHONE })
  }, 30_000)
  afterAll(async () => {
    await browser?.close()
    await mock?.stop()
  })

  test(
    "shows the transcript in the draft while you speak and finalizes it on stop",
    async () => {
      const { page, errors } = await openPage(browser, mock.url, "dark", "#/c/cnv_expense")
      await page.context().grantPermissions(["microphone"])
      const box = page.getByRole("textbox", { name: "Message Expense Clerk" })
      await box.fill("Hey,")
      await page.getByRole("button", { name: "Dictate" }).click()
      await page.getByTestId("dictation-recording").waitFor()
      await page.waitForFunction(
        (expected) => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Expense Clerk"]')?.value === expected,
        "Hey, Check the staging deploy",
      )
      await page.waitForTimeout(1200)
      await expect(page.getByTestId("dictation-recording").innerText()).resolves.toContain("0:01")
      await page.getByRole("button", { name: "Stop dictation" }).click()
      await page.waitForFunction(
        (expected) => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Expense Clerk"]')?.value === expected,
        "Hey, Check the staging deploy and tell me if it is green.",
      )
      await page.getByRole("button", { name: "Dictate" }).waitFor()
      expect(errors).toEqual([])
    },
    30_000,
  )

  test(
    "Escape cancels a recording and restores the draft",
    async () => {
      const { page, errors } = await openPage(browser, mock.url, "dark", "#/c/cnv_expense")
      await page.context().grantPermissions(["microphone"])
      const box = page.getByRole("textbox", { name: "Message Expense Clerk" })
      await box.fill("keep me")
      await page.getByRole("button", { name: "Dictate" }).click()
      await page.getByTestId("dictation-recording").waitFor()
      await page.waitForFunction(
        () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Expense Clerk"]')?.value.includes("staging") === true,
      )
      await page.keyboard.press("Escape")
      await page.getByRole("button", { name: "Dictate" }).waitFor()
      expect(await box.inputValue()).toBe("keep me")
      expect(errors).toEqual([])
    },
    30_000,
  )
})

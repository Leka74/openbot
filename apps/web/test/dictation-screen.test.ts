import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import type { SttStatus } from "@openbot/contracts"
import { chromium, type Browser, type Page } from "playwright-core"
import { chromiumPath, openPage, type RunningMock, startMock } from "./shoot.ts"

const FAKE_MICROPHONE = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
const EXPENSE_BOX = 'textarea[aria-label="Message Expense Clerk"]'
const LIVE = "Check the staging deploy"
const FINAL = "Check the staging deploy and tell me if it is green."

const draftIs = (page: Page, expected: string) =>
  page.waitForFunction(({ selector, value }) => document.querySelector<HTMLTextAreaElement>(selector)?.value === value, { selector: EXPENSE_BOX, value: expected })

const mockStt = async (mock: RunningMock): Promise<{ readonly status: SttStatus; readonly discards: number }> =>
  (await fetch(`${mock.url}/api/mock/stt`)).json() as Promise<{ readonly status: SttStatus; readonly discards: number }>

const setMockStt = async (mock: RunningMock, state: { readonly failsAppend: boolean; readonly resetToReady?: boolean }) => {
  await fetch(`${mock.url}/api/mock/stt?failsAppend=${state.failsAppend ? 1 : 0}&resetToReady=${state.resetToReady ? 1 : 0}`, { method: "POST" })
}

const trackMicrophoneTracks = (page: Page) =>
  page.evaluate(() => {
    const tracks: Array<MediaStreamTrack> = []
    const requestMicrophone = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await requestMicrophone(constraints)
      tracks.push(...stream.getTracks())
      return stream
    }
    Object.assign(window, { dictationTracks: tracks })
  })

const microphoneReleased = (page: Page) =>
  page.waitForFunction(() => {
    const tracks = (window as unknown as { readonly dictationTracks: ReadonlyArray<MediaStreamTrack> }).dictationTracks
    return tracks.length > 0 && tracks.every((track) => track.readyState === "ended")
  })

const openExpenseChat = async (browser: Browser, url: string) => {
  const opened = await openPage(browser, url, "dark", "#/c/cnv_expense")
  await opened.page.context().grantPermissions(["microphone"])
  await trackMicrophoneTracks(opened.page)
  return { ...opened, box: opened.page.getByRole("textbox", { name: "Message Expense Clerk" }) }
}

describe.skipIf(!existsSync(chromiumPath))("dictation against the dev mock", () => {
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
  beforeEach(() => setMockStt(mock, { failsAppend: false, resetToReady: true }))

  test("shows the transcript while you speak, finalizes it on stop and leaves the caret after it", async () => {
    const { page, errors, box } = await openExpenseChat(browser, mock.url)
    await box.fill("Hey,")
    await page.getByRole("button", { name: "Dictate" }).click()
    await page.getByTestId("dictation-recording").waitFor()
    await draftIs(page, `Hey, ${LIVE}`)
    await page.waitForTimeout(1200)
    await expect(page.getByTestId("dictation-recording").innerText()).resolves.toContain("0:01")
    await page.getByRole("button", { name: "Stop dictation" }).click()
    await draftIs(page, `Hey, ${FINAL}`)
    await page.getByRole("button", { name: "Dictate" }).waitFor()
    await page.waitForFunction((selector) => {
      const textarea = document.querySelector<HTMLTextAreaElement>(selector)
      return textarea !== null && document.activeElement === textarea && textarea.selectionStart === textarea.value.length
    }, EXPENSE_BOX)
    expect(errors).toEqual([])
  }, 30_000)

  test("Escape cancels a recording and restores the draft", async () => {
    const { page, errors, box } = await openExpenseChat(browser, mock.url)
    await box.fill("keep me")
    await page.getByRole("button", { name: "Dictate" }).click()
    await draftIs(page, `keep me ${LIVE}`)
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "Dictate" }).waitFor()
    expect(await box.inputValue()).toBe("keep me")
    await microphoneReleased(page)
    expect(errors).toEqual([])
  }, 30_000)

  test("Enter does not send a half-dictated message", async () => {
    const { page, errors, box } = await openExpenseChat(browser, mock.url)
    await box.fill("Draft")
    await page.getByRole("button", { name: "Dictate" }).click()
    await draftIs(page, `Draft ${LIVE}`)
    await box.press("Enter")
    await page.waitForTimeout(400)
    expect(await page.getByTestId("transcript").getByText(`Draft ${LIVE}`, { exact: true }).count()).toBe(0)
    await page.getByRole("button", { name: "Stop dictation" }).click()
    await draftIs(page, `Draft ${FINAL}`)
    expect(errors).toEqual([])
  }, 30_000)

  test("a transcription failure stops the microphone, keeps what was heard, says so, discards the dictation and allows another", async () => {
    const { page, box } = await openExpenseChat(browser, mock.url)
    await box.fill("Before")
    const discardsBefore = (await mockStt(mock)).discards
    await page.getByRole("button", { name: "Dictate" }).click()
    await draftIs(page, `Before ${LIVE}`)
    await setMockStt(mock, { failsAppend: true })
    await page.getByText("Voice input could not transcribe", { exact: false }).waitFor()
    await page.getByRole("button", { name: "Dictate" }).waitFor()
    await microphoneReleased(page)
    expect(await box.inputValue()).toBe(`Before ${LIVE}`)
    expect((await mockStt(mock)).discards).toBe(discardsBefore + 1)
    await setMockStt(mock, { failsAppend: false })
    await page.getByRole("button", { name: "Dictate" }).click()
    await draftIs(page, `Before ${LIVE} ${LIVE}`)
    await page.getByRole("button", { name: "Stop dictation" }).click()
    await draftIs(page, `Before ${LIVE} ${FINAL}`)
  }, 30_000)

  test("switching conversation mid-dictation stops it and leaves both drafts as they were", async () => {
    const { page, errors, box } = await openExpenseChat(browser, mock.url)
    await box.fill("expense draft")
    await page.getByRole("button", { name: "Dictate" }).click()
    await draftIs(page, `expense draft ${LIVE}`)
    await page.evaluate(() => {
      location.hash = "#/c/cnv_travel"
    })
    await microphoneReleased(page)
    expect(await page.locator("textarea").first().inputValue()).toBe("")
    await page.evaluate(() => {
      location.hash = "#/c/cnv_expense"
    })
    await draftIs(page, "expense draft")
    await page.getByRole("button", { name: "Dictate" }).waitFor()
    expect(errors).toEqual([])
  }, 30_000)

  test("Dictate appears when installation finishes after leaving Settings", async () => {
    const { page, errors } = await openExpenseChat(browser, mock.url)
    try {
      await page.getByRole("button", { name: "Account" }).click()
      await page.getByRole("menuitem", { name: "Computers" }).click()
      await page.getByTestId("settings-nav-general").click()
      const voice = page.getByTestId("settings-voice")
      await voice.getByRole("button", { name: "Turn off" }).click()
      await voice.getByRole("button", { name: "Turn on" }).click()
      await voice.getByText("Downloading Parakeet", { exact: false }).waitFor()
      await page.getByRole("button", { name: "Close settings" }).click()
      await voice.waitFor({ state: "detached" })
      expect((await mockStt(mock)).status.state).toBe("installing")
      expect(await page.getByRole("button", { name: "Dictate", exact: true }).count()).toBe(0)

      await setMockStt(mock, { failsAppend: false, resetToReady: true })
      await page.getByRole("button", { name: "Dictate", exact: true }).waitFor({ timeout: 5000 })
      expect(await page.getByRole("dialog", { name: "Settings", exact: true }).count()).toBe(0)
      expect(errors).toEqual([])
    } finally {
      await page.context().close()
    }
  }, 30_000)

  test("Settings turns voice input off and on, showing the download as it progresses", async () => {
    const { page, errors } = await openPage(browser, mock.url, "dark", "#/c/cnv_expense")
    await page.getByRole("button", { name: "Account" }).click()
    await page.getByRole("menuitem", { name: "Computers" }).click()
    await page.getByTestId("settings-nav-general").click()
    const voice = page.getByTestId("settings-voice")
    await voice.getByRole("button", { name: "Turn off" }).click()
    await voice.getByText("downloads about 500 MB once", { exact: false }).waitFor()
    await voice.getByRole("button", { name: "Turn on" }).click()
    await voice.getByText("Downloading Parakeet", { exact: false }).waitFor()
    await voice.getByRole("button", { name: "Turn off" }).waitFor({ timeout: 10_000 })
    expect((await mockStt(mock)).status.state).toBe("ready")
    expect(errors).toEqual([])
  }, 30_000)
})

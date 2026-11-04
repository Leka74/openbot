// A page in the background stops watching a bot's desktop immediately (an unwatched screen can go
// to sleep, D1.7) and watches again when it shows. Against the dev mock, with Playwright's clock.
// Skipped without Chromium.
import { afterAll, beforeAll, test } from "bun:test"
import { existsSync } from "node:fs"
import { type Browser, chromium, type Page } from "playwright-core"
import { startWebBMock, type WebBMock } from "./web-b-mock.ts"

const chromiumPath = process.env.OPENBOT_CHROMIUM ?? "/usr/bin/chromium"
const enabled = existsSync(chromiumPath)

let mock: WebBMock | undefined
let browser: Browser | undefined

beforeAll(async () => {
  if (!enabled) return
  mock = await startWebBMock()
  browser = await chromium.launch({ executablePath: chromiumPath })
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await mock?.stop()
})

const viewers = async (): Promise<number> =>
  ((await (await fetch(`${mock!.url}/api/mock/desktop`)).json()) as { viewers: number }).viewers

const until = async (what: string, ok: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await ok()) return
    await Bun.sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

const setVisibility = (page: Page, state: "hidden" | "visible") =>
  page.evaluate((s) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s })
    document.dispatchEvent(new Event("visibilitychange"))
  }, state)

test.skipIf(!enabled)(
  "a hidden page lets go of the desktop immediately and watches again when it shows",
  async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(mock!.url)
    await page.getByText("Chief of Staff", { exact: true }).first().click({ timeout: 20_000 })
    await page.getByRole("button", { name: "View conversation details" }).click()
    const pane = page.getByTestId("details-pane")
    await pane.getByRole("tab", { name: "Computer" }).click()
    await until("the thumbnail to watch", async () => (await viewers()) === 1)

    // Passive video closes immediately instead of spending another minute decoding.
    await setVisibility(page, "hidden")
    await until("the viewer to close", async () => (await viewers()) === 0)

    await setVisibility(page, "visible")
    await until("the viewer to come back", async () => (await viewers()) === 1)
    await page.close()
  },
  60_000,
)

// Message search in the real app against the dev mock (dev/mock/search.ts searches its chats): the
// Cmd+K Messages section, the Search view and its filters in the URL, opening a chat at an old
// message (a window around it, "Jump to latest"), the Find bar (Cmd/Ctrl+F, ↑/↓, Esc), a bot-to-bot
// hit opening its exchange, a hit on a tool step showing its steps, and the phone layout.
// Screenshots: test/screenshots/search-*.png. Skipped without Chromium (OPENBOT_CHROMIUM).
import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { type Browser, chromium, type Page } from "playwright-core"
import { startWebBMock, type WebBMock } from "./web-b-mock.ts"

const chromiumPath = process.env.OPENBOT_CHROMIUM ?? "/usr/bin/chromium"
const shots = new URL("./screenshots", import.meta.url).pathname
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

const open = async (hash: string, options: { readonly width?: number; readonly height?: number; readonly theme?: "light" | "dark" } = {}): Promise<{ page: Page; errors: string[] }> => {
  const errors: string[] = []
  const page = await browser!.newPage({ viewport: { width: options.width ?? 1440, height: options.height ?? 900 }, colorScheme: options.theme ?? "light" })
  page.on("pageerror", (e) => errors.push(e.message))
  await page.addInitScript((t) => localStorage.setItem("openbot.theme", t), options.theme ?? "light")
  await page.goto(`${mock!.url}/${hash}`)
  return { page, errors }
}

const transcript = (page: Page) => page.getByTestId("transcript")

/** Polls `read` until it equals (or matches) `expected`; fails with the last value after `timeout`. */
const eventually = async <A>(read: () => Promise<A>, expected: A | RegExp, timeout = 10_000): Promise<void> => {
  const deadline = Date.now() + timeout
  let last: A | undefined
  for (;;) {
    last = await read()
    if (expected instanceof RegExp ? typeof last === "string" && expected.test(last) : Bun.deepEquals(last, expected)) return
    if (Date.now() > deadline) break
    await Bun.sleep(100)
  }
  expect(last).toEqual(expected as A)
}

test.skipIf(!enabled)(
  "Cmd+K shows message hits and opens the Search view; filters live in the URL",
  async () => {
    const { page, errors } = await open("#/c/cnv_chief")
    await transcript(page).locator(".ob-msg").first().waitFor({ timeout: 20_000 })
    await page.keyboard.press("Control+k")
    await page.getByRole("combobox").fill("visa")
    await page.getByRole("option").filter({ hasText: "Travel Desk" }).first().waitFor({ timeout: 10_000 })
    expect(await page.getByRole("option").filter({ hasText: "Booked" }).count()).toBeGreaterThan(0)
    await page.screenshot({ path: join(shots, "search-palette.png") })

    await page.getByRole("option", { name: /See all results for “visa”/ }).click()
    await page.getByTestId("search-view").waitFor()
    await eventually(() => page.evaluate(() => location.hash), "#/search?q=visa")
    await eventually(() => page.getByTestId("search-count").textContent(), "12 results")

    // Type: Steps on (tool calls) — the passport scan step is found only then
    await page.getByTestId("search-input").fill("passport")
    await eventually(() => page.getByTestId("search-hit").count(), 0)
    await page.getByTestId("filter-type").click()
    await page.getByRole("menuitemcheckbox", { name: /Steps/ }).click()
    await page.keyboard.press("Escape")
    await eventually(() => page.evaluate(() => location.hash), "#/search?q=passport&type=messages,cards,events,tasks,steps")
    await page.getByTestId("search-hit").first().waitFor()
    expect(await page.getByTestId("search-hit").first().textContent()).toContain("Step")
    await page.screenshot({ path: join(shots, "search-view-steps.png") })

    // reload keeps the filters
    await page.reload()
    await page.getByTestId("search-hit").first().waitFor({ timeout: 15_000 })
    expect(await page.getByTestId("filter-type").getAttribute("data-active")).toBe("true")
    expect(await page.getByTestId("search-input").inputValue()).toBe("passport")
    expect(errors).toEqual([])
    await page.close()
  },
  60_000,
)

test.skipIf(!enabled)(
  "a link to an old message opens the chat around it; Jump to latest returns to the newest",
  async () => {
    const { page, errors } = await open("#/search?q=zurich+visa&sort=newest")
    const oldest = page.getByTestId("search-hit").filter({ hasText: "Trip 4" })
    await oldest.waitFor({ timeout: 20_000 })
    await page.screenshot({ path: join(shots, "search-view.png") })
    await oldest.click()
    await eventually(() => transcript(page).getAttribute("data-window"), "open")
    const hash = await page.evaluate(() => location.hash)
    expect(hash).toMatch(/^#\/c\/cnv_travel\/e\/ent_/)
    const target = transcript(page).locator(`[data-entry="${hash.split("/e/")[1]}"]`)
    await target.waitFor()
    expect(await target.textContent()).toContain("Trip 4: book Zürich")
    // centered in the view, lit up, the words highlighted
    const box = await target.boundingBox()
    expect(box!.y).toBeGreaterThan(80)
    expect(box!.y + box!.height).toBeLessThan(820)
    expect(await page.locator("[data-flash]").count()).toBe(1)
    expect(await page.evaluate(() => (CSS as unknown as { highlights: Map<string, unknown> }).highlights.has("ob-find-current"))).toBe(true)
    await page.getByTestId("jump-to-latest").waitFor()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(shots, "search-deep-link.png") })

    // reload: the link opens the same place
    await page.reload()
    await eventually(() => transcript(page).getAttribute("data-window"), "open", 20_000)
    await transcript(page).locator(`[data-entry="${hash.split("/e/")[1]}"]`).waitFor()

    await page.getByTestId("jump-to-latest").click()
    await eventually(() => transcript(page).getAttribute("data-window"), null)
    await eventually(() => page.evaluate(() => location.hash), "#/c/cnv_travel")
    await eventually(() => transcript(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80), true)
    expect(errors).toEqual([])
    await page.close()
  },
  60_000,
)

test.skipIf(!enabled)(
  "the Find bar steps through a chat's hits, into older parts of the chat, and closes with Esc",
  async () => {
    const { page, errors } = await open("#/c/cnv_travel")
    await transcript(page).locator(".ob-msg").first().waitFor({ timeout: 20_000 })
    await page.keyboard.press("Control+f")
    const input = page.getByTestId("find-input")
    await input.waitFor()
    expect(await input.evaluate((el) => el === document.activeElement)).toBe(true)
    await input.fill("visa")
    const count = page.getByTestId("find-count")
    await eventually(() => count.textContent(), "12 of 12")
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(shots, "search-find.png") })
    await page.keyboard.press("Enter")
    await eventually(() => count.textContent(), "11 of 12")
    await page.getByTestId("find-newer").click()
    await eventually(() => count.textContent(), "12 of 12")
    await page.getByTestId("find-newer").click()
    // wraps to the oldest hit: a window of the chat around it
    await eventually(() => count.textContent(), "1 of 12")
    await eventually(() => transcript(page).getAttribute("data-window"), "open")
    await page.keyboard.press("Escape")
    await page.getByTestId("find-bar").waitFor({ state: "detached" })
    expect(await page.evaluate(() => (CSS as unknown as { highlights: Map<string, unknown> }).highlights.size)).toBe(0)
    // Esc closed the Find bar only (nothing else)
    expect(await page.evaluate(() => location.hash)).toBe("#/c/cnv_travel")

    // not over a dialog: Cmd/Ctrl+F is left to the browser
    await page.keyboard.press("Control+k")
    await page.getByRole("combobox").waitFor()
    await page.keyboard.press("Control+f")
    expect(await page.getByTestId("find-bar").count()).toBe(0)
    expect(errors).toEqual([])
    await page.close()
  },
  60_000,
)

test.skipIf(!enabled)(
  "a bot-to-bot hit opens its exchange; a hit on a tool step shows its steps even when steps are hidden",
  async () => {
    const { page, errors } = await open("#/search?q=wonka&chat=cnv_scout")
    const hit = page.getByTestId("search-hit").first()
    await hit.waitFor({ timeout: 20_000 })
    expect(await hit.textContent()).toContain("Sales Outreach to Research Scout")
    await hit.click()
    await page.getByTestId("exchange-title").waitFor({ timeout: 10_000 })
    await eventually(() => page.locator("[data-exchange-item][data-target]").count(), 1)
    expect(await page.locator("[data-exchange-item][data-target]").textContent()).toContain("Wonka")
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(shots, "search-exchange.png") })
    await page.keyboard.press("Escape")

    // hide steps, then open a tool step's hit
    await page.keyboard.press("Control+k")
    await page.getByRole("combobox").fill("hide steps")
    await page.getByRole("option", { name: /Hide steps under replies/ }).click()
    await page.goto(`${mock!.url}/#/search?q=passport&type=steps`)
    await page.getByTestId("search-hit").first().click({ timeout: 20_000 })
    const steps = transcript(page).locator("[data-turn]")
    await steps.waitFor({ timeout: 10_000 })
    expect(await steps.count()).toBe(1)
    expect(await steps.locator('button[aria-expanded="true"]').count()).toBeGreaterThan(0)
    expect(await steps.textContent()).toContain("passport-scan.pdf")
    // put the setting back for the other tests
    await page.keyboard.press("Control+k")
    await page.getByRole("combobox").fill("show steps")
    await page.getByRole("option", { name: /Show steps under replies/ }).click()
    expect(errors).toEqual([])
    await page.close()
  },
  60_000,
)

for (const theme of ["light", "dark"] as const) {
  test.skipIf(!enabled)(
    `phone: the Search view is its own screen with Back, the Find bar spans the width (${theme})`,
    async () => {
      const { page, errors } = await open("#/search?q=visa", { width: 390, height: 844, theme })
      await page.getByTestId("search-hit").first().waitFor({ timeout: 20_000 })
      await page.getByTestId("search-back").waitFor()
      await page.screenshot({ path: join(shots, `search-phone-view-${theme}.png`) })
      await page.getByTestId("search-hit").first().click()
      await transcript(page).locator("[data-flash]").first().waitFor({ timeout: 10_000 })
      await page.keyboard.press("Control+f")
      await page.getByTestId("find-input").fill("booked")
      await eventually(() => page.getByTestId("find-count").textContent(), /of/)
      const bar = await page.getByTestId("find-bar").boundingBox()
      expect(bar!.width).toBeGreaterThan(390 - 2 * 12 - 2)
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(shots, `search-phone-find-${theme}.png`) })
      // Back from the chat returns Home; the search entry is behind it
      expect(errors).toEqual([])
      await page.close()
    },
    60_000,
  )
}

test.skipIf(!enabled)(
  "dark: palette, Search view and a deep link",
  async () => {
    const { page, errors } = await open("#/c/cnv_chief", { theme: "dark" })
    await transcript(page).locator(".ob-msg").first().waitFor({ timeout: 20_000 })
    await page.keyboard.press("Control+k")
    await page.getByRole("combobox").fill("hook")
    await page.getByRole("option").filter({ hasText: "Hook" }).first().waitFor({ timeout: 10_000 })
    await page.screenshot({ path: join(shots, "search-palette-dark.png") })
    await page.keyboard.press("Escape")
    await page.goto(`${mock!.url}/#/search?q=visa`)
    await page.getByTestId("search-hit").first().waitFor({ timeout: 20_000 })
    await page.screenshot({ path: join(shots, "search-view-dark.png") })
    await page.getByTestId("search-hit").last().click()
    await page.getByTestId("jump-to-latest").waitFor({ timeout: 10_000 })
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(shots, "search-deep-link-dark.png") })
    expect(errors).toEqual([])
    await page.close()
  },
  60_000,
)

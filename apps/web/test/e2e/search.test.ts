// E2E: message search against the real brain (its index, `search.query`, `search.inConversation`
// and `conversations.around`) with the Demo (fake) harness. A long chat is written through the
// brain (more than the newest page a chat opens with), plus a tool step and a bot-to-bot message.
// Then: the Cmd+K Messages section and "See all results"; the Search view, its filters in the URL
// (Steps off until asked for) and a reload; opening a chat at an old message (a window of the chat
// around it, lit up and highlighted, "Jump to latest"); the Find bar (Cmd/Ctrl+F, ↑/↓ into older
// parts of the chat, Esc); a bot-to-bot hit opening its exchange; a tool step's hit showing its
// steps while steps are hidden; the phone layout. Screenshots: e2e/screenshots/e2e-search-*.png.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Browser, Page } from "playwright-core"
import type { Bot, ConversationId, EntryId } from "@openbot/contracts"
import { type AppPage, type Brain, connectRpc, eventually, hasChromium, launchBrowser, openApp, type Rpc, startBrain } from "./brain.ts"

const CITIES = ["Berlin", "Tokyo", "Austin", "Zürich", "Nairobi", "Montréal", "Seoul", "Porto", "Reykjavík", "Lima", "Oslo", "Kraków"]
/** Trips written to Nova's chat; every tenth (from the fourth) mentions a visa. */
const TRIPS = 140
const VISA_TRIPS = Array.from({ length: TRIPS }, (_, i) => i).filter((i) => i % 10 === 3).length

describe.skipIf(!hasChromium)("e2e: message search", () => {
  let brain: Brain
  let browser: Browser
  let rpc: Rpc
  let nova: Bot
  let scout: Bot
  const apps: Array<AppPage> = []

  const idle = (conversationId: ConversationId) =>
    eventually(
      () => rpc.conversation(conversationId),
      (s) => [...s.turns.values()].every((t) => t.status === "completed" || t.status === "failed" || t.status === "interrupted"),
      { timeout: 60_000, label: "the chat to be idle" },
    )
  let nonce = 0
  const say = (conversationId: ConversationId, text: string) => rpc.call((c) => c["messages.send"]({ conversationId, text, clientNonce: `e2e-search-${++nonce}` }))

  const open = async (route: string, options: { readonly theme?: "light" | "dark"; readonly phone?: boolean } = {}): Promise<AppPage> => {
    const app = await openApp(browser, brain, {
      theme: options.theme ?? "light",
      route,
      ...(options.phone ? { context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } } : {}),
    })
    apps.push(app)
    return app
  }
  const transcript = (page: Page) => page.getByTestId("transcript")
  const text = (page: Page, testId: string) => page.getByTestId(testId).textContent()

  beforeAll(async () => {
    brain = await startBrain()
    browser = await launchBrowser()
    rpc = await connectRpc(brain)
    nova = await rpc.call((c) => c["bots.create"]({ name: "Nova", harness: { kind: "fake" }, clientNonce: "e2e-search-nova" }))
    scout = await rpc.call((c) => c["bots.create"]({ name: "Scout", harness: { kind: "fake" }, clientNonce: "e2e-search-scout" }))
    const dm = nova.directConversationId
    // an old tool step (its own turn) and an old bot-to-bot message
    await say(dm, `tool: remember ${JSON.stringify({ title: "Passport scan", body: "Passport valid until 2031-04-02" })}`)
    await idle(dm)
    await say(dm, `tool: message_bot ${JSON.stringify({ to: "Scout", text: "Wonka hook: a new factory tour app in beta" })}`)
    await idle(dm)
    for (let i = 0; i < TRIPS; i++) {
      const city = CITIES[i % CITIES.length]!
      const visa = i % 10 === 3
      await say(dm, `echo: Trip ${i + 1}: book ${city} for the ${visa ? "partner summit; check the visa rules" : "quarterly review"}, back by Friday.`)
    }
    await idle(dm)
  }, 240_000)

  afterAll(async () => {
    for (const app of apps) await app.context.close()
    await rpc?.close()
    await browser?.close()
    await brain?.stop()
  })

  test("Cmd+K: message hits under the roster, and See all results opens the Search view", async () => {
    const app = await open(`#/c/${nova.directConversationId}`)
    const { page } = app
    await transcript(page).locator(".ob-msg").first().waitFor()
    await page.keyboard.press("Control+k")
    await page.getByRole("combobox").fill("visa")
    await page.getByRole("option").filter({ hasText: "partner summit" }).first().waitFor()
    await app.shot("e2e-search-palette")
    await page.getByRole("option", { name: /See all results for “visa”/ }).click()
    await page.getByTestId("search-view").waitFor()
    await eventually(() => page.evaluate(() => location.hash), (h) => h === "#/search?q=visa")
    // the owner's messages and Nova's echoes of them
    await eventually(() => text(page, "search-count"), (t) => t === `${VISA_TRIPS * 2} results`)
    await app.shot("e2e-search-view")
    expect(app.errors).toEqual([])
  }, 60_000)

  test("filters live in the URL; tool steps only with the Steps type; a reload keeps them", async () => {
    const app = await open("#/search?q=passport")
    const { page } = app
    await page.getByTestId("search-count").waitFor()
    const before = await page.getByTestId("search-hit").allTextContents()
    expect(before.some((t) => t.includes("Step"))).toBe(false)
    await page.getByTestId("filter-type").click()
    await page.getByRole("menuitemcheckbox", { name: /Steps/ }).click()
    await page.keyboard.press("Escape")
    // Esc closed the menu only
    await page.getByTestId("search-view").waitFor()
    await eventually(() => page.evaluate(() => location.hash), (h) => h === "#/search?q=passport&type=messages,cards,events,tasks,steps")
    await eventually(() => page.getByTestId("search-hit").allTextContents(), (all) => all.some((t) => t.includes("Step")))
    await app.shot("e2e-search-view-steps")
    await page.getByTestId("sort-newest").click()
    await eventually(() => page.evaluate(() => location.hash), (h) => h.endsWith("&sort=newest"))
    await page.reload()
    await page.getByTestId("search-hit").first().waitFor()
    expect(await page.getByTestId("filter-type").getAttribute("data-active")).toBe("true")
    expect(await page.getByTestId("sort-newest").getAttribute("aria-checked")).toBe("true")
    expect(await page.getByTestId("search-input").inputValue()).toBe("passport")
    expect(app.errors).toEqual([])
  }, 60_000)

  test("a hit on an old message opens the chat around it; reload keeps it; Jump to latest returns", async () => {
    const app = await open("#/search?q=zurich+visa&sort=newest")
    const { page } = app
    const oldest = page.getByTestId("search-hit").filter({ hasText: "Trip 4:" }).first()
    await oldest.waitFor()
    await oldest.click()
    await eventually(() => transcript(page).getAttribute("data-window"), (w) => w === "open")
    const hash = await page.evaluate(() => location.hash)
    expect(hash).toStartWith(`#/c/${nova.directConversationId}/e/`)
    const entryId = hash.split("/e/")[1]!
    const target = transcript(page).locator(`[data-entry="${entryId}"]`)
    await target.waitFor()
    expect(await target.textContent()).toContain("Trip 4: book Zürich")
    const box = await target.boundingBox()
    expect(box!.y).toBeGreaterThan(60)
    expect(box!.y + box!.height).toBeLessThan(840)
    expect(await page.locator("[data-flash]").count()).toBe(1)
    expect(await page.evaluate(() => (CSS as unknown as { highlights: Map<string, unknown> }).highlights.has("ob-find-current"))).toBe(true)
    await page.getByTestId("jump-to-latest").waitFor()
    await app.shot("e2e-search-deep-link")

    // a reaction to it shows in place; the unloaded part up to the newest stays a gap
    await rpc.call((c) => c["messages.react"]({ conversationId: nova.directConversationId, entryId: entryId as EntryId, emoji: "👍" }))
    await eventually(() => target.textContent(), (t) => t?.includes("👍") === true, { label: "the reaction" })
    expect(await transcript(page).getAttribute("data-window")).toBe("open")
    expect(await page.getByTestId("jump-to-latest").count()).toBe(1)
    expect(await transcript(page).locator(".ob-msg").filter({ hasText: `Trip ${TRIPS}:` }).count()).toBe(0)

    // scrolling pages in older and newer parts of the window
    const count = () => transcript(page).locator(".ob-msg").count()
    const loaded = await count()
    await transcript(page).evaluate((el) => (el.scrollTop = el.scrollHeight))
    await eventually(count, (n) => n > loaded, { label: "a newer page" })

    await page.reload()
    await eventually(() => transcript(page).getAttribute("data-window"), (w) => w === "open", { label: "the window after a reload" })
    await transcript(page).locator(`[data-entry="${entryId}"]`).waitFor()

    await page.getByTestId("jump-to-latest").click()
    await eventually(() => transcript(page).getAttribute("data-window"), (w) => w === null)
    await eventually(() => page.evaluate(() => location.hash), (h) => h === `#/c/${nova.directConversationId}`)
    await eventually(() => transcript(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), (d) => d < 80)
    expect(app.errors).toEqual([])
  }, 60_000)

  test("the Find bar: Cmd/Ctrl+F, the newest hit first, ↑/↓ into older parts of the chat, Esc", async () => {
    const app = await open(`#/c/${nova.directConversationId}`)
    const { page } = app
    await transcript(page).locator(".ob-msg").first().waitFor()
    await page.keyboard.press("Control+f")
    const input = page.getByTestId("find-input")
    await input.waitFor()
    expect(await input.evaluate((el) => el === document.activeElement)).toBe(true)
    await input.fill("visa")
    const total = VISA_TRIPS * 2
    await eventually(() => text(page, "find-count"), (t) => t === `${total} of ${total}`)
    await eventually(() => page.evaluate(() => (CSS as unknown as { highlights: Map<string, { size: number }> }).highlights.get("ob-find")?.size ?? 0), (n) => n > 0)
    await app.shot("e2e-search-find")
    await page.keyboard.press("Enter")
    await eventually(() => text(page, "find-count"), (t) => t === `${total - 1} of ${total}`)
    await page.getByTestId("find-newer").click()
    await page.getByTestId("find-newer").click()
    // wrapped to the oldest: a window of the chat around it
    await eventually(() => text(page, "find-count"), (t) => t === `1 of ${total}`)
    await eventually(() => transcript(page).getAttribute("data-window"), (w) => w === "open")
    await transcript(page).locator("[data-flash]").filter({ hasText: "Trip 4:" }).waitFor()
    await page.keyboard.press("Escape")
    await page.getByTestId("find-bar").waitFor({ state: "detached" })
    await eventually(() => page.evaluate(() => (CSS as unknown as { highlights: Map<string, unknown> }).highlights.size), (n) => n === 0, { label: "the highlights to go" })

    // a dialog on top: Cmd/Ctrl+F is the browser's
    await page.keyboard.press("Control+k")
    await page.getByRole("combobox").waitFor()
    await page.keyboard.press("Control+f")
    expect(await page.getByTestId("find-bar").count()).toBe(0)
    expect(app.errors).toEqual([])
  }, 60_000)

  test("a bot-to-bot hit opens its exchange; a tool step's hit shows its steps while steps are hidden", async () => {
    const app = await open(`#/search?q=wonka&chat=${scout.directConversationId}`)
    const { page } = app
    const hit = page.getByTestId("search-hit").first()
    await hit.waitFor()
    // once, without Scout's chat named before it
    expect(await hit.textContent()).toContain("Nova to Scout")
    expect(await hit.textContent()).not.toMatch(/Scout\s*·/)
    await hit.click()
    await page.getByTestId("exchange-title").waitFor()
    await eventually(() => page.locator("[data-exchange-item][data-target]").count(), (n) => n === 1)
    expect(await page.locator("[data-exchange-item][data-target]").textContent()).toContain("Wonka")
    // its words marked as in the chat
    const marked = await eventually(
      () => page.evaluate(() => [...((CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights.get("ob-find-exchange-current") ?? [])].map((r) => r.toString())),
      (all) => all.length > 0,
    )
    expect(marked).toEqual(["Wonka"])
    await app.shot("e2e-search-exchange")
    await page.keyboard.press("Escape")

    await rpc.call((c) => c["settings.update"]({ patch: { showSteps: false } }))
    try {
      await page.goto(`${brain.base}/#/search?q=passport&type=steps`)
      await page.getByTestId("search-hit").filter({ hasText: "Step" }).first().click()
      const steps = transcript(page).locator("[data-turn]")
      await steps.waitFor()
      expect(await steps.count()).toBe(1)
      expect(await steps.locator('button[aria-expanded="true"]').count()).toBeGreaterThan(0)
      await transcript(page).locator("[data-turn] [data-flash]").waitFor()
    } finally {
      await rpc.call((c) => c["settings.update"]({ patch: { showSteps: true } }))
    }
    expect(app.errors).toEqual([])
  }, 60_000)

  for (const theme of ["light", "dark"] as const) {
    test(`phone (${theme}): the Search view is a screen of its own; the Find bar spans the width`, async () => {
      const app = await open("#/search?q=visa", { phone: true, theme })
      const { page } = app
      await page.getByTestId("search-hit").first().waitFor()
      await page.getByTestId("search-back").waitFor()
      await app.shot(`e2e-search-phone-view-${theme}`)
      await page.getByTestId("search-hit").first().click()
      await transcript(page).locator("[data-flash]").first().waitFor()
      await page.keyboard.press("Control+f")
      await page.getByTestId("find-input").fill("visa")
      await eventually(() => text(page, "find-count"), (t) => / of /.test(t ?? ""))
      const bar = await page.getByTestId("find-bar").boundingBox()
      expect(bar!.width).toBeGreaterThan(390 - 2 * 12 - 2)
      await app.shot(`e2e-search-phone-find-${theme}`)
      expect(app.errors).toEqual([])
    }, 60_000)
  }

  test("dark: palette, Search view and a chat opened at an old message", async () => {
    const app = await open(`#/c/${nova.directConversationId}`, { theme: "dark" })
    const { page } = app
    await transcript(page).locator(".ob-msg").first().waitFor()
    await page.keyboard.press("Control+k")
    await page.getByRole("combobox").fill("zurich")
    await page.getByRole("option").filter({ hasText: "Zürich" }).first().waitFor()
    await app.shot("e2e-search-palette-dark")
    await page.keyboard.press("Escape")
    await page.goto(`${brain.base}/#/search?q=visa&sort=newest`)
    await page.getByTestId("search-hit").first().waitFor()
    await app.shot("e2e-search-view-dark")
    await page.getByTestId("search-hit").last().click()
    await page.getByTestId("jump-to-latest").waitFor()
    await app.shot("e2e-search-deep-link-dark")
    expect(app.errors).toEqual([])
  }, 60_000)
})

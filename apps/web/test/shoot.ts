/**
 * Screenshots + smoke flow for the web app against the dev mock server (apps/web/dev/mock-server.ts),
 * in Chromium via playwright-core at 1440x900 DPR 2, dark and light.
 *
 *   bun apps/web/test/shoot.ts [scene...]      → apps/web/test/screenshots/<scene>-<theme>.png
 *
 * Env: OPENBOT_CHROMIUM (default /usr/bin/chromium).
 */
import { chromium, type Browser, type Page } from "playwright-core"
import { join } from "node:path"

export const chromiumPath = process.env.OPENBOT_CHROMIUM ?? "/usr/bin/chromium"
export const screenshotDir = new URL("./screenshots", import.meta.url).pathname
const mockEntry = new URL("../dev/mock-server.ts", import.meta.url).pathname
const webDir = new URL("..", import.meta.url).pathname

export interface RunningMock {
  readonly url: string
  readonly stop: () => Promise<void>
}

/** Starts the mock server as a child process (cwd apps/web so its bunfig loads Tailwind). */
export const startMock = async (port = 0, extra: ReadonlyArray<string> = []): Promise<RunningMock> => {
  const p = port || 43000 + Math.floor(Math.random() * 2000)
  const child = Bun.spawn([process.execPath, mockEntry, "--port", String(p), ...extra], {
    cwd: webDir,
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, OPENBOT_MOCK_CHILD: "1" },
  })
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value)
    const m = /OPENBOT_MOCK_URL=(\S+)/.exec(buf)
    if (m) {
      reader.releaseLock()
      void child.stdout.pipeTo(new WritableStream()).catch(() => {})
      return {
        url: m[1]!,
        stop: async () => {
          child.kill("SIGTERM")
          await Promise.race([child.exited, Bun.sleep(2000)])
          if (child.exitCode === null) child.kill("SIGKILL")
        },
      }
    }
  }
  child.kill("SIGKILL")
  throw new Error(`mock server did not start: ${buf}`)
}

export interface Shot {
  readonly name: string
  /** Hash route (conversation) to open first. */
  readonly route?: string
  readonly act?: (page: Page) => Promise<void>
}

const mod = process.platform === "darwin" ? "Meta" : "Control"

export const SCENES: ReadonlyArray<Shot> = [
  { name: "01-chat", route: "#/c/cnv_chief" },
  {
    name: "02-chat-hover",
    route: "#/c/cnv_chief",
    act: async (page) => {
      await page.locator(".ob-msg[data-entry]", { hasText: "Booked: marina house" }).first().hover()
    },
  },
  {
    name: "03-details",
    route: "#/c/cnv_chief",
    act: async (page) => void (await page.getByRole("button", { name: "View conversation details" }).click()),
  },
  {
    name: "12-account-menu",
    route: "#/c/cnv_chief",
    act: async (page) => void (await page.getByRole("button", { name: "Account" }).click()),
  },
  {
    name: "13-bot-context-menu",
    route: "#/c/cnv_chief",
    act: async (page) => void (await page.locator('[data-row="bot_scout"]').click({ button: "right" })),
  },
  {
    name: "14-react-popover",
    route: "#/c/cnv_chief",
    act: async (page) => {
      const msg = page.locator(".ob-msg[data-entry]", { hasText: "Booked: marina house" }).first()
      await msg.locator("[data-side]").hover()
      await msg.getByRole("button", { name: "React" }).click()
    },
  },
  {
    name: "10-new-chat",
    route: "#/new",
    act: async (page) => void (await page.waitForSelector('[aria-label="New chat"]')),
  },
  {
    name: "10b-new-chat-typed",
    route: "#/new",
    act: async (page) => {
      await page.getByRole("combobox", { name: "To" }).fill("Res")
    },
  },
  { name: "11-search", route: "#/c/cnv_chief", act: async (page) => void (await page.keyboard.press(`${mod}+k`)) },
  {
    name: "19-mention",
    route: "#/c/cnv_chief",
    act: async (page) => {
      const box = page.getByRole("textbox", { name: "Message Chief of Staff" })
      await box.click()
      await box.pressSequentially("Can you ask @", { delay: 10 })
    },
  },
  {
    name: "20-typed",
    route: "#/c/cnv_chief",
    act: async (page) => {
      await page
        .getByRole("textbox", { name: "Message Chief of Staff" })
        .fill("Can you ask Research Scout to draft the board update for Friday")
    },
  },
  { name: "21-compact", route: "#/c/cnv_chief", act: async (page) => void (await page.keyboard.press(`${mod}+b`)) },
  {
    name: "22-plus-menu",
    route: "#/c/cnv_chief",
    act: async (page) => void (await page.getByRole("button", { name: "Composer actions" }).click()),
  },
  {
    name: "23-hidden-bots",
    route: "#/c/cnv_chief",
    act: async (page) => void (await page.getByRole("button", { name: /Hidden Bots/ }).click()),
  },
  {
    name: "30-steps",
    route: "#/c/cnv_release",
    act: async (page) => {
      const steps = page.getByRole("button", { name: /5 steps/ })
      await steps.click()
      await page
        .getByRole("button", { name: /npm run build/ })
        .first()
        .click()
    },
  },
  { name: "31-working", route: "#/c/cnv_inbox" },
  { name: "36-error-tray", route: "#/c/cnv_data" },
  { name: "40-group", route: "#/c/cnv_launch" },
  { name: "41-forms", route: "#/c/cnv_travel" },
  { name: "42-scout", route: "#/c/cnv_scout" },
  {
    name: "43-exchange",
    route: "#/c/cnv_sales",
    act: async (page) => {
      // the middle "3 messages with Research Scout" run: the dialog opens there, lit up
      await page
        .getByTestId("transcript")
        .locator('button[data-exchange="bot_scout"]')
        .filter({ hasText: "3 messages with" })
        .nth(1)
        .click()
      await page.getByRole("dialog").locator("[data-exchange-item][data-target]").first().waitFor()
    },
  },
  { name: "50-settings", route: "#/c/cnv_chief", act: async (page) => void (await openComputers(page)) },
  // plan limits per harness account above the per-Bot table
  {
    name: "51-settings-usage",
    route: "#/c/cnv_chief",
    act: async (page) => {
      await openComputers(page)
      await page.getByTestId("settings-nav-usage").click()
      await page.getByTestId("quota-account").first().waitFor()
    },
  },
  // skills (D5.5): the library, the editor, the skills.sh import, a Bot's Library tab
  { name: "60-skills", route: "#/c/cnv_chief", act: async (page) => void (await openSkills(page)) },
  {
    name: "61-skill-editor",
    route: "#/c/cnv_chief",
    act: async (page) => {
      await openSkills(page)
      await page.getByTestId("skill-row").filter({ hasText: "pdf" }).click()
      await page.getByTestId("skill-files").waitFor()
    },
  },
  {
    name: "62-skill-new",
    route: "#/c/cnv_chief",
    act: async (page) => {
      await openSkills(page)
      await page.getByTestId("new-skill").click()
      await page.getByTestId("skill-name").fill("Standup Notes")
    },
  },
  {
    name: "63-skills-search",
    route: "#/c/cnv_chief",
    act: async (page) => {
      await openSkills(page)
      await page.getByTestId("import-skill").click()
      await page.getByTestId("skills-sh-search").fill("skills")
      await page.getByTestId("skills-sh-result").first().waitFor()
    },
  },
  {
    name: "64-skills-preview",
    route: "#/c/cnv_chief",
    act: async (page) => {
      await openSkills(page)
      await page.getByTestId("import-skill").click()
      await page.getByTestId("skills-sh-search").fill("pdf")
      await page.getByTestId("skills-sh-result").first().click()
      await page.getByTestId("skill-preview-body").waitFor()
    },
  },
  {
    name: "65-library",
    route: "#/c/cnv_chief",
    act: async (page) => {
      await page.getByRole("button", { name: "View conversation details" }).click()
      await page.getByRole("tab", { name: "Library" }).click()
      await page.getByTestId("details-tab-library").getByTestId("skill-row").first().waitFor()
    },
  },
  {
    name: "66-library-add",
    route: "#/c/cnv_scout",
    act: async (page) => {
      await page.getByRole("button", { name: "View conversation details" }).click()
      await page.getByRole("tab", { name: "Library" }).click()
      await page.getByTestId("add-skill").click()
    },
  },
]

/** The full-desktop view's picture is live (noVNC connected to the mock's fake RFB desktop). */
export const desktopLive = async (page: Page, interactive = false) => {
  await page
    .locator(
      `[data-testid="computer-view"] [data-testid="desktop-screen"][data-live]${interactive ? "[data-interactive]" : ""}`,
    )
    .waitFor({ timeout: 10_000 })
  await page.waitForTimeout(400)
}

/** Details › Computer of the open chat's Bot. */
export const computerTab = async (page: Page) => {
  await page.getByRole("button", { name: "View conversation details" }).click()
  await page.getByRole("tab", { name: "Computer" }).click()
  await page.getByTestId("screen-thumbnail").waitFor()
}

/** Full-desktop computer view (D1.7): Watching / in control / asleep / unreachable, the hand-off card, Details › Computer. */
export const COMPUTER_SCENES: ReadonlyArray<Shot> = [
  {
    name: "70-computer-watching",
    route: "#/c/cnv_chief",
    act: async (page) => {
      await computerTab(page)
      await page.getByTestId("screen-thumbnail").click()
      await desktopLive(page)
    },
  },
  {
    name: "72-takeover-card",
    route: "#/c/cnv_scout",
    act: async (page) => {
      const card = page.locator('[data-card="handoff"][data-status="pending"]')
      await card.scrollIntoViewIfNeeded()
      await card.getByRole("button", { name: "Take over" }).waitFor()
      await card.locator('[data-testid="desktop-screen"][data-live]').waitFor({ timeout: 10_000 })
    },
  },
  {
    name: "71-computer-control",
    route: "#/c/cnv_scout",
    act: async (page) => {
      await page.locator('[data-card="handoff"]').getByRole("button", { name: "Take over" }).click()
      await desktopLive(page, true)
      const box = (await page.getByTestId("computer-view").getByTestId("desktop-screen").boundingBox())!
      // the password field of the fake sign-in page, then type
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.52)
      await page.keyboard.type("correct horse")
      await page.waitForTimeout(400)
    },
  },
  {
    // after 71 the owner still holds Scout's screen (the view was left open): the card offers I'm done
    name: "72b-takeover-in-control",
    route: "#/c/cnv_scout",
    act: async (page) => {
      const card = page.locator('[data-card="handoff"][data-status="pending"]')
      await card.scrollIntoViewIfNeeded()
      await card.getByRole("button", { name: "I'm done" }).waitFor({ timeout: 10_000 })
      await card.locator('[data-testid="desktop-screen"][data-live]').waitFor({ timeout: 10_000 })
    },
  },
  {
    name: "73-takeover-done",
    route: "#/c/cnv_release",
    act: async (page) => {
      const card = page.locator('[data-card="handoff"][data-status="resolved"]')
      await card.scrollIntoViewIfNeeded()
      await page.evaluate(() => document.querySelector('[data-card="handoff"]')?.scrollIntoView({ block: "center" }))
    },
  },
  {
    name: "74-details-computer",
    route: "#/c/cnv_chief",
    act: async (page) => {
      await computerTab(page)
      await page
        .getByTestId("screen-thumbnail")
        .locator('[data-testid="desktop-screen"][data-live]')
        .waitFor({ timeout: 10_000 })
    },
  },
  { name: "75-details-missing", route: "#/c/cnv_expense", act: async (page) => void (await computerTab(page)) },
  {
    name: "76-reset-confirm",
    route: "#/c/cnv_chief",
    act: async (page) => {
      await computerTab(page)
      await page.getByTestId("reset-computer").click()
      await page.getByRole("dialog", { name: /Reset Chief of Staff's computer/ }).waitFor()
    },
  },
  {
    name: "77-computer-asleep",
    route: "#/c/cnv_travel",
    act: async (page) => {
      await computerTab(page)
      await page.getByTestId("screen-thumbnail").click()
      await page.getByTestId("computer-view").getByTestId("screen-message").waitFor()
    },
  },
  {
    name: "78-computer-unreachable",
    // the mock closes Data Analyst's screen with 1011 + a reason, like the brain when it can't start it
    route: "#/c/cnv_data",
    act: async (page) => {
      await computerTab(page)
      await page.getByTestId("screen-thumbnail").click()
      await page.locator('[data-testid="computer-view"] [data-notice="unplug"]').waitFor({ timeout: 10_000 })
    },
  },
  {
    name: "79-settings-computers",
    route: "#/c/cnv_chief",
    act: async (page) => {
      await openComputers(page)
      await page
        .getByTestId("node-row")
        .filter({ hasText: "vps-1" })
        .getByRole("button", { name: "Show details" })
        .click()
      await page.getByTestId("desktop-setup").waitFor()
    },
  },
]

/** Settings › Computers (from the account menu). */
export const openComputers = async (page: Page) => {
  await page.getByRole("button", { name: "Account" }).click()
  await page.getByRole("menuitem", { name: "Computers" }).click()
}

/** Settings › Skills (Settings › Computers, then the nav). */
const openSkills = async (page: Page) => {
  await openComputers(page)
  await page.getByTestId("settings-nav-skills").click()
  await page.getByTestId("skills-library").getByTestId("skill-row").first().waitFor()
}

export const openPage = async (
  browser: Browser,
  url: string,
  theme: "dark" | "light",
  route = "#/",
): Promise<{ page: Page; errors: string[] }> => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: theme,
  })
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`)
  })
  await page.goto(`${url}/${route}`)
  await page.waitForSelector('nav[aria-label="Bots"] [data-row], nav[aria-label="Bots"] [data-bot]', {
    timeout: 15_000,
  })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)
  return { page, errors }
}

export const takeScreens = async (
  options: { readonly only?: ReadonlyArray<string>; readonly themes?: ReadonlyArray<"dark" | "light"> } = {},
) => {
  const files: string[] = []
  const errors: string[] = []
  const browser = await chromium.launch({ executablePath: chromiumPath })
  try {
    for (const theme of options.themes ?? (["dark", "light"] as const)) {
      const mock = await startMock()
      try {
        for (const shot of [...SCENES, ...COMPUTER_SCENES]) {
          if (options.only && options.only.length > 0 && !options.only.some((o) => shot.name.includes(o))) continue
          const { page, errors: errs } = await openPage(browser, mock.url, theme, shot.route)
          if (shot.route?.startsWith("#/c/"))
            await page
              .waitForSelector(
                `[data-conversation="${shot.route.slice(4)}"] [data-entry], [data-conversation="${shot.route.slice(4)}"] [role="separator"]`,
                { timeout: 10_000 },
              )
              .catch(() => {})
          await page.waitForTimeout(300)
          if (shot.act)
            await shot
              .act(page)
              .catch((e: unknown) => errors.push(`${shot.name}/${theme}: act failed: ${String(e).split("\n")[0]}`))
          await page.waitForTimeout(450)
          const file = join(screenshotDir, `${shot.name}-${theme}.png`)
          await page.screenshot({ path: file })
          files.push(file)
          errors.push(...errs.map((e) => `${shot.name}/${theme}: ${e}`))
          await page.context().close()
        }
      } finally {
        await mock.stop()
      }
    }
  } finally {
    await browser.close()
  }
  return { files, errors }
}

if (import.meta.main) {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("--"))
  const themes = process.argv.includes("--dark")
    ? (["dark"] as const)
    : process.argv.includes("--light")
      ? (["light"] as const)
      : undefined
  const res = await takeScreens({ only, ...(themes ? { themes } : {}) })
  for (const f of res.files) console.log(f)
  for (const e of res.errors) console.error("ERROR", e)
}

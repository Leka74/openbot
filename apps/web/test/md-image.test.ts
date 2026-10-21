// An inline image that failed once does not stay failed when its source changes: the new source
// gets its own try. Real Chromium (the failure comes from the <img>'s error event); image requests
// are answered by Playwright. Skipped without Chromium.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Browser, chromium } from "playwright-core"

const chromiumPath = process.env.OPENBOT_CHROMIUM ?? "/usr/bin/chromium"
const enabled = existsSync(chromiumPath)
const entry = new URL("./md-image-harness.tsx", import.meta.url).pathname

/** A 1×1 transparent PNG. */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0))

let work = ""
let script = ""
let browser: Browser | undefined

beforeAll(async () => {
  if (!enabled) return
  work = await mkdtemp(join(tmpdir(), "openbot-md-image-"))
  const built = await Bun.build({ entrypoints: [entry], outdir: work, target: "browser", define: { "process.env.NODE_ENV": JSON.stringify("development") } })
  if (!built.success) throw new AggregateError(built.logs, "harness build failed")
  script = await built.outputs[0]!.text()
  browser = await chromium.launch({ executablePath: chromiumPath })
}, 60_000)

afterAll(async () => {
  await browser?.close()
  if (work) await rm(work, { recursive: true, force: true })
})

test.skipIf(!enabled)("a failed image retries when its source changes", async () => {
  const page = await browser!.newPage()
  try {
    await page.route("https://images.test/**", (route) =>
      route.request().url().endsWith("/ok.png")
        ? route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(PNG) })
        : route.fulfill({ status: 404, body: "" }),
    )
    await page.route("https://harness.test/", (route) =>
      route.fulfill({ contentType: "text/html", body: `<!doctype html><div id="root"></div><script type="module">${script.replaceAll("</script", "<\\/script")}</script>` }),
    )
    await page.goto("https://harness.test/")
    await page.waitForFunction(() => typeof window.setMarkdown === "function")
    await page.evaluate(() => window.setMarkdown("![shot](https://images.test/broken.png)"))
    await page.locator(".ob-md-img-fallback").waitFor({ timeout: 10_000 })
    expect(await page.locator("img.ob-md-img").count()).toBe(0)

    await page.evaluate(() => window.setMarkdown("![shot](https://images.test/ok.png)"))
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>("img.ob-md-img")
      return img !== null && img.complete && img.naturalWidth === 1
    }, null, { timeout: 10_000 })
    expect(await page.locator(".ob-md-img-fallback").count()).toBe(0)
    expect(await page.locator("img.ob-md-img").getAttribute("src")).toBe("https://images.test/ok.png")
  } finally {
    await page.close()
  }
}, 60_000)

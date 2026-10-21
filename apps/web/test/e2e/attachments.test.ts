// E2E: a bot sends files with `send_file` (fake harness `tool: send_file {...}` through the REAL
// gateway, local node transfer and attachment store) and the chat renders them Grok-like: an image
// thumbnail that opens a lightbox, an inline video (metadata over HTTP ranges, first frame as
// poster), audio, a PDF card with Open, and a file card with Download. Desktop and phone layouts.
// Real brain, fake harness only. Screenshots: e2e/screenshots/e2e-attachments-*.png.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Browser, Route } from "playwright-core"
import type { Bot } from "@openbot/contracts"
import { createHash } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import { type AppPage, type Brain, connectRpc, hasChromium, launchBrowser, openApp, type Rpc, send, shotsDir, startBrain, waitIdle } from "./brain.ts"

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** A real RGB PNG with a diagonal gradient (so the thumbnail and lightbox show something). */
const makePng = (width: number, height: number): Uint8Array => {
  const raw = new Uint8Array((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = Math.round((x / width) * 255)
      raw[row + 2 + x * 3] = Math.round((y / height) * 255)
      raw[row + 3 + x * 3] = 160
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, data.length)
    out.set(new TextEncoder().encode(type), 4)
    out.set(data, 8)
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
    return out
  }
  const ihdr = new Uint8Array(13)
  new DataView(ihdr.buffer).setUint32(0, width)
  new DataView(ihdr.buffer).setUint32(4, height)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    png.set(p, at)
    at += p.length
  }
  return png
}

const ffmpeg = Bun.which("ffmpeg")

/** 2 MiB + 1 byte: one past the in-place preview ceiling (`MAX_PREVIEW_BYTES` in app-model). */
const OVER_PREVIEW_LIMIT = 2 * 1024 * 1024 + 1

/** Byte-for-byte sensitive fixture: leading spaces, a run of blank lines, trailing spaces, a tab
 * and no final newline. The preview's <pre> must show exactly this. */
const BLANK_SPACE = "  indented first line\n\n\nthird line   \n\tfourth line has a tab"

/** The one fixture the delete test removes from the store; the sentinel must never reach the DOM. */
const DOOMED_BODY = "Doomed body — unique-sentinel-doomed-9f2c never reaches the error dialog."

/** The one mention both the fixture and the chat-bubble echo carry, so one source string can be
 * compared in both renderings. */
const PREVIEW_MENTION = "@Reel pickup"

const PREVIEW_FIXTURES: Record<string, string> = {
  "notes.md": [
    "# Weekly notes",
    "",
    "| item | owner |",
    "|---|---|",
    "| renderer | web |",
    "",
    "- [ ] ship the preview",
    "- [x] write the plan",
    "",
    "---",
    "",
    "Last paragraph stays plain.",
    "",
    // The chat bubble renders `@Bot` as an avatar + coloured span; the preview must do the same,
    // so the fixture has to contain a mention that the roster actually resolves.
    PREVIEW_MENTION,
  ].join("\n"),
  "plain.txt": "Plain text never runs through the markdown renderer.\nSecond line.",
  "blank-space.txt": BLANK_SPACE,
  "data.json": '{"kind":"json","note":"code branch"}',
  "sample.py": "def hello():\n    return 1\n",
  "page.html": "<h1>never previewed</h1>",
  // Kept separate from the other fixtures so the delete test owns its own file to remove: removing
  // a shared fixture would break every later test that opens it.
  "doomed.md": ["# doomed", "", DOOMED_BODY].join("\n"),
}

/** A short real video (ffmpeg test pattern) when ffmpeg is installed, else MP4-looking bytes. */
const makeMedia = (dir: string): { readonly video: boolean; readonly audio: boolean } => {
  let video = false
  let audio = false
  if (ffmpeg !== null) {
    const v = Bun.spawnSync([ffmpeg, "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(dir, "cache-demo.mp4")])
    video = v.exitCode === 0
    const a = Bun.spawnSync([ffmpeg, "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", join(dir, "beep.wav")])
    audio = a.exitCode === 0
  }
  if (!video) {
    const bytes = new Uint8Array(4096)
    bytes.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
    writeFileSync(join(dir, "cache-demo.mp4"), bytes)
  }
  if (!audio) writeFileSync(join(dir, "beep.wav"), new TextEncoder().encode("RIFF$\u0000\u0000\u0000WAVEfmt "))
  return { video, audio }
}

describe.skipIf(!hasChromium)("e2e: files a bot sends", () => {
  let brain: Brain
  let browser: Browser
  let rpc: Rpc
  let app: AppPage
  let bot: Bot
  let media: { readonly video: boolean; readonly audio: boolean }
  let previewFiles: Array<string>

  beforeAll(async () => {
    brain = await startBrain()
    browser = await launchBrowser()
    rpc = await connectRpc(brain)
    bot = await rpc.call((c) => c["bots.create"]({ name: "Reel", harness: { kind: "fake" }, clientNonce: "e2e-attachments" }))
    // what the bot "rendered" in its workspace on the local node
    const out = join(brain.dataDir, "bots", bot.id, "workspace", "output")
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, "cover.png"), makePng(960, 540))
    media = makeMedia(out)
    writeFileSync(join(out, "report.pdf"), "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n")
    writeFileSync(join(out, "site.zip"), new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]))
    for (const [name, body] of Object.entries(PREVIEW_FIXTURES)) writeFileSync(join(out, name), body)
    writeFileSync(join(out, "huge.md"), "# huge\n" + "x".repeat(OVER_PREVIEW_LIMIT))
    previewFiles = [...Object.keys(PREVIEW_FIXTURES), "huge.md"].map((name) => `output/${name}`)

    // The app and both fixture messages are created here rather than in the first `test`: every
    // test below reads them, and `-t "<one preview test>"` must run on its own instead of failing
    // on an `app` that only the first test would have assigned.
    app = await openApp(browser, brain, { theme: "dark", route: `#/c/${bot.directConversationId}` })
    const transcript = app.page.getByTestId("transcript")
    await send(
      app.page,
      "Reel",
      `tool: send_file {"paths":["output/cover.png","output/cache-demo.mp4","output/beep.wav","output/report.pdf","output/site.zip"],"caption":"Rendered: cover, demo and sources"}`,
    )
    await transcript.getByText("Rendered: cover, demo and sources", { exact: true }).waitFor({ timeout: 30_000 })
    await waitIdle(app.page, 30_000)
    await send(app.page, "Reel", `tool: send_file {"paths":${JSON.stringify(previewFiles)},"caption":"Preview fixtures"}`)
    await transcript.getByText("Preview fixtures", { exact: true }).waitFor({ timeout: 30_000 })
    await waitIdle(app.page, 30_000)
    // The same mention the `notes.md` fixture ends with, rendered the other way (chat bubble), so
    // the two renderings of one source string can be compared.
    await send(app.page, "Reel", `echo: ${PREVIEW_MENTION}`)
    await transcript.locator(".ob-mention").first().waitFor({ timeout: 30_000 })
    await waitIdle(app.page, 30_000)
  }, 150_000)

  afterAll(async () => {
    await app?.context.close()
    await rpc?.close()
    await browser?.close()
    await brain?.stop()
  })

  test("image, video, audio, PDF and file cards render in the bot's message; the image opens a lightbox", async () => {
    const { page } = app
    const transcript = page.getByTestId("transcript")
    // The media message is the first of the two setup messages, so its attachments block is `first`
    // (the preview fixtures arrive in a second message, whose block would be `last`).
    const files = transcript.getByTestId("attachments").first()
    await files.locator('[data-attachment="image"] img').waitFor({ timeout: 20_000 })
    await waitIdle(page, 20_000)
    await transcript.getByText("Rendered: cover, demo and sources", { exact: true }).waitFor()

    // the image loaded through the cookie-authenticated route
    const image = files.locator('[data-attachment="image"] img')
    await page.waitForFunction((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0, await image.elementHandle())
    expect(await image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(960)
    const imageBox = (await files.locator('[data-attachment="image"]').boundingBox())!
    expect(imageBox.width).toBeLessThanOrEqual(361)
    expect(Math.round(imageBox.height)).toBe(Math.round((imageBox.width * 540) / 960))

    // inline video: controls, metadata only, plays inline (iOS), first frame as poster
    const video = files.locator('[data-attachment="video"] video')
    expect(await video.getAttribute("preload")).toBe("metadata")
    expect(await video.getAttribute("playsinline")).not.toBeNull()
    expect(await video.getAttribute("controls")).not.toBeNull()
    expect(await video.getAttribute("src")).toMatch(/^\/api\/attachments\/[\w-]+#t=0\.1$/)
    if (media.video) {
      await page.waitForFunction((el) => (el as HTMLVideoElement).readyState >= 1, await video.elementHandle(), { timeout: 15_000 })
      expect(await video.evaluate((el) => Math.round((el as HTMLVideoElement).duration))).toBe(2)
    }
    expect(await files.locator('[data-attachment="audio"] audio').getAttribute("controls")).not.toBeNull()

    // PDF: Open in a new tab + Download; other files: a card with Download
    const pdf = files.locator('[data-attachment="pdf"]')
    await pdf.getByText("report.pdf").waitFor()
    expect(await pdf.getByRole("link", { name: "Open" }).getAttribute("target")).toBe("_blank")
    const zip = files.locator('[data-attachment="file"]')
    await zip.getByText("site.zip").waitFor()
    await zip.getByText("ZIP · 22 bytes").waitFor()
    const download = zip.getByRole("link", { name: "Download site.zip" })
    expect(await download.getAttribute("href")).toMatch(/^\/api\/attachments\/[\w-]+\?download=1$/)
    expect(await download.getAttribute("download")).toBe("site.zip")
    await app.shot("e2e-attachments-01-desktop")

    // lightbox
    await files.locator('[data-attachment="image"]').click()
    const lightbox = page.getByTestId("lightbox")
    await lightbox.waitFor()
    await lightbox.getByText("cover.png").waitFor()
    expect(await lightbox.getByRole("link", { name: "Download cover.png" }).getAttribute("href")).toContain("?download=1")
    await app.shot("e2e-attachments-02-lightbox")
    await page.keyboard.press("Escape")
    await lightbox.waitFor({ state: "detached" })
    expect(app.errors).toEqual([])
  }, 90_000)

  test("phone: media fits the message column (≤ 85 % of the screen) and the video plays inline", async () => {
    const context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      colorScheme: "dark",
    })
    try {
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      await page.goto(brain.loginUrl)
      await page.goto(`${brain.base}/#/c/${bot.directConversationId}`)
      // Same as the desktop test: the media message's block is the first of the two.
      const files = page.getByTestId("attachments").first()
      await files.locator('[data-attachment="video"] video').waitFor()
      await files.locator('[data-attachment="video"]').scrollIntoViewIfNeeded()
      for (const kind of ["image", "video", "audio", "pdf", "file"]) {
        const box = (await files.locator(`[data-attachment="${kind}"]`).boundingBox())!
        expect(box.width).toBeLessThanOrEqual(393 * 0.85 + 1)
        expect(box.x).toBeGreaterThanOrEqual(0)
      }
      expect(await files.locator("video").getAttribute("playsinline")).not.toBeNull()
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(shotsDir, "e2e-attachments-03-phone.png") })
    } finally {
      await context.close()
    }
  }, 60_000)

  // ------------------------------------------------------------------ in-place preview (D3/D4/D6)

  const preview = () => app.page.getByTestId("file-preview")
  /** A file card's preview button only (the tool-call disclosure also contains the file names). */
  const card = (name: string) => app.page.locator('button[title="Preview"]').filter({ hasText: name })
  /** Waits for the preview to reach `state` (the state is on the DOM, so no copy matching is needed). */
  const waitState = (state: string) =>
    app.page.waitForFunction((s) => document.querySelector('[data-testid="file-preview"]')?.getAttribute("data-preview-state") === s, state)

  const openPreview = async (name: string): Promise<void> => {
    // A previous failure must not leave its dialog on screen blocking this click.
    if (await preview().isVisible().catch(() => false)) {
      await app.page.keyboard.press("Escape")
      await preview().waitFor({ state: "detached" })
    }
    await card(name).click()
    await preview().waitFor()
  }

  const closeWithEscape = async (): Promise<void> => {
    await app.page.keyboard.press("Escape")
    await preview().waitFor({ state: "detached" })
  }

  /** The restore runs one macrotask after the dialog unmounts, so read focus only once it settles. */
  const waitFocusSettled = async (): Promise<void> => {
    await app.page.waitForFunction(() => document.activeElement?.getAttribute("data-attachment-id") != null)
  }
  const activeId = () => app.page.evaluate(() => document.activeElement?.getAttribute("data-attachment-id") ?? null)

  test("preview fixtures arrive as a second bot message", async () => {
    // The setup in `beforeAll` sent them; this asserts they really reached the transcript with
    // preview entry points, so a failure here localises to the fixtures rather than the preview.
    await app.page.getByTestId("transcript").getByText("Preview fixtures", { exact: true }).waitFor()
    expect(await app.page.getByTestId("transcript").locator('button[title="Preview"]').count()).toBeGreaterThan(0)
  }, 60_000)

  test("markdown preview renders rich text, not source, and never downloads", async () => {
    const downloads: Array<string> = []
    app.page.on("download", (d) => downloads.push(d.suggestedFilename()))
    await openPreview("notes.md")
    await waitState("ready")

    // Rendered markdown: table and task list are elements, and the source markers are gone.
    await preview().locator("table").waitFor()
    await preview().locator('li[data-task="done"]').waitFor()
    await preview().locator('li[data-task="todo"]').waitFor()
    await preview().locator("hr.ob-md-hr").waitFor()
    const text = (await preview().textContent()) ?? ""
    expect(text).not.toContain("| item | owner |")
    expect(text).not.toContain("- [ ]")
    expect(text).toContain("ship the preview")
    expect(text).toContain("Last paragraph stays plain.")
    expect(downloads).toEqual([])

    // One source string must render the same way in the bubble and in the dialog. The preview
    // gets `bots` from the roster, so the mention becomes the same avatar + coloured span the
    // chat bubble shows instead of falling back to plain text.
    const inDialog = preview().locator(".ob-mention")
    expect(await inDialog.count()).toBe(1)
    // The bot bubble that echoed the identical line — `data-side` pins it, since the user message
    // that triggered the echo also carries an `.ob-mention` and `last()` alone would not say which
    // one it picked. The rendered text drops the `@` (the regex consumes it), hence `pickup`.
    const inChat = app.page.getByTestId("transcript").locator('[data-side="bot"]').filter({ hasText: "pickup" }).locator(".ob-mention").last()
    expect(await inChat.count()).toBe(1)
    expect((await inDialog.textContent())?.trim()).toBe("Reel")
    // `outerHTML`, not `innerHTML`: the theme colour sits in the span's own `style`, and the avatar
    // shape is a data attribute on its child — the whole element has to match, not just its inside.
    // The avatar's expression is random, so it is the one thing normalised away.
    const shape = (html: string) => html.replace(/ data-expression="[a-z]+"/g, "")
    expect(shape(await inDialog.evaluate((el) => el.outerHTML))).toBe(shape(await inChat.evaluate((el) => el.outerHTML)))
    await app.shot("e2e-attachments-04-preview-markdown")
    await closeWithEscape()
  }, 60_000)

  test("text and code previews stay verbatim in <pre>, with no markdown elements", async () => {
    for (const name of ["plain.txt", "data.json"] as const) {
      await openPreview(name)
      await waitState("ready")
      const pre = preview().locator("pre.ob-md-preview-code")
      await pre.waitFor()
      expect(await pre.locator("code").textContent()).toBe(PREVIEW_FIXTURES[name]!)
      // The dialog header's own <h2> is not a rendered markdown heading; only the body matters.
      for (const tag of ["table", "ul", "ol", "blockquote"]) expect(await preview().locator(tag).count()).toBe(0)
      expect(await preview().locator('.ob-md h1, .ob-md h2').count()).toBe(0)
      await closeWithEscape()
    }
  }, 90_000)

  test("leading spaces, blank runs, trailing spaces and tabs survive byte for byte", async () => {
    await openPreview("blank-space.txt")
    await waitState("ready")
    const pre = preview().locator("pre.ob-md-preview-code")
    expect(await pre.textContent()).toBe(BLANK_SPACE)
    expect(await pre.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("pre-wrap")
    await closeWithEscape()
  }, 60_000)

  test("D4: the bytes the preview fetched, the download bytes and the rendered text are the same bytes", async () => {
    // Capture what the DIALOG itself fetches — not a separate request the test makes. Comparing two
    // test-issued requests would say nothing about whether the preview shows the download's bytes;
    // intercepting reads the real response body the component consumes.
    let previewBytes: Uint8Array | undefined
    const capture = async (route: Route) => {
      const response = await route.fetch()
      previewBytes = new Uint8Array(await response.body())
      await route.fulfill({ response })
    }
    await app.page.route("**/api/attachments/**", capture)
    try {
      await openPreview("blank-space.txt")
      await waitState("ready")
    } finally {
      await app.page.unroute("**/api/attachments/**", capture)
    }
    expect(previewBytes).toBeDefined()

    // The Download link's own href, fetched through the app's context (its cookie), so this is the
    // destination a user's click actually reaches.
    const href = await preview().getByRole("link", { name: /Download/ }).getAttribute("href")
    expect(href).toContain("?download=1")
    const downloadResponse = await app.page.request.get(new URL(href!, brain.base).toString())
    expect(downloadResponse.status()).toBe(200)
    expect(downloadResponse.headers()["content-disposition"]).toStartWith("attachment;")
    const downloadBytes = new Uint8Array(await downloadResponse.body())

    const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
    expect(sha(previewBytes!)).toBe(sha(downloadBytes))
    // Both equal the fixture, so "identical to each other" cannot pass by both being wrong.
    const source = new TextDecoder().decode(downloadBytes)
    expect(source).toBe(BLANK_SPACE)

    // The dialog's rendered text is exactly those bytes — no trimming, no re-encoding. `textContent`
    // and not `innerText`: `innerText` collapses whitespace and would hide the very loss this checks.
    expect(await preview().locator("pre.ob-md-preview-code").textContent()).toBe(source)
    await closeWithEscape()
  }, 60_000)

  test("html gets no preview entry point at all", async () => {
    await app.page.getByTestId("transcript").getByText("page.html").first().waitFor()
    expect(await card("page.html").count()).toBe(0)
  }, 60_000)

  test("Esc, backdrop and the Close button each return focus to the card that opened it", async () => {
    // The contract is "the card that opened it", not "some text containing the name": compare the
    // focused element's own `data-attachment-id` with the card's.
    const assertFocusOn = async (name: string) => {
      await waitFocusSettled()
      const expected = await card(name).getAttribute("data-attachment-id")
      expect(expected).not.toBeNull()
      expect(await activeId()).toBe(expected)
    }

    await openPreview("notes.md")
    await waitState("ready")
    await closeWithEscape()
    await assertFocusOn("notes.md")

    await openPreview("plain.txt")
    await waitState("ready")
    // A real click, as a user makes: the scrim's mousedown default action resets focus to <body>,
    // so the restore has to outlive it. Wait for focus to settle before asserting.
    await app.page.locator("div.fixed.inset-0.bg-scrim").click({ position: { x: 4, y: 4 } })
    await preview().waitFor({ state: "detached" })
    await assertFocusOn("plain.txt")

    await openPreview("data.json")
    await preview().getByRole("button", { name: "Close" }).click()
    await preview().waitFor({ state: "detached" })
    await assertFocusOn("data.json")
    await app.shot("e2e-attachments-05-focus-return")
    expect(app.errors).toEqual([])
  }, 90_000)

  test("a click that does not focus the button still returns focus to its card on close", async () => {
    // Safari and Firefox on macOS do not focus a <button> on click, so when the dialog opens the
    // active element is the composer — and the dialog's own restore would put focus back there.
    // A programmatic `el.click()` reproduces that: the click fires, focus does not move.
    await app.page.getByRole("textbox", { name: "Message Reel" }).focus()
    const expected = await card("notes.md").getAttribute("data-attachment-id")
    await card("notes.md").evaluate((el) => (el as HTMLButtonElement).click())
    await preview().waitFor()
    await waitState("ready")
    await closeWithEscape()
    await waitFocusSettled()
    expect(await activeId()).toBe(expected)
  }, 60_000)

  test("two attachments in a row leave no residue from the first", async () => {
    await openPreview("notes.md")
    await waitState("ready")
    expect(await preview().textContent()).toContain("ship the preview")
    await closeWithEscape()

    await openPreview("data.json")
    await waitState("ready")
    const text = (await preview().textContent()) ?? ""
    expect(text).not.toContain("ship the preview")
    expect(text).not.toContain("Weekly notes")
    expect(text).not.toContain("too large")
    await closeWithEscape()
  }, 90_000)

  test("a file over the ceiling opens too-large and never requests the bytes", async () => {
    const requested: Array<string> = []
    const onRequest = (request: { url: () => string }) => {
      if (request.url().includes("/api/attachments/")) requested.push(request.url())
    }
    app.page.on("request", onRequest)
    try {
      await openPreview("huge.md")
      await waitState("too-large")
      await preview().getByText(/too large/i).waitFor()
      expect(requested).toEqual([])
      await app.shot("e2e-attachments-06-too-large")
    } finally {
      app.page.off("request", onRequest)
      await closeWithEscape()
    }
  }, 60_000)

  test("without the session cookie the preview errors and shows no file content", async () => {
    await openPreview("notes.md")
    await waitState("ready")
    await closeWithEscape()

    const sentinel = PREVIEW_FIXTURES["notes.md"]!.slice(0, 40)
    // The context is shared by every test in this file, so the session that gets cleared here has
    // to come back in `finally` — otherwise every later test runs unauthenticated (401).
    const session = await app.context.cookies()
    await app.context.clearCookies()
    // Attachment responses are `cache-control: immutable`, so the same URL would be answered from
    // the browser cache without ever reaching the server. A unique query makes this a real request.
    await app.page.route("**/api/attachments/**", (route) => {
      const url = new URL(route.request().url())
      url.searchParams.set("e2e-unauthorized", "1")
      return route.continue({ url: url.toString() })
    })
    try {
      await card("notes.md").click()
      await preview().waitFor()
      await waitState("error")
      const text = (await preview().textContent()) ?? ""
      expect(text).not.toContain(sentinel)
      expect(text).toContain("Couldn't load")
      await preview().getByRole("button", { name: "Close" }).click()
      await preview().waitFor({ state: "detached" })
      await app.shot("e2e-attachments-07-unauthorized")
    } finally {
      await app.page.unroute("**/api/attachments/**")
      await app.context.addCookies(session)
    }
  }, 60_000)

  test("D6: an attachment deleted from the store opens in the error state, names the cause, and leaks no body", async () => {
    const id = await card("doomed.md").getAttribute("data-attachment-id")
    expect(id).not.toBeNull()
    // The route streams the store's own copy (`<dataDir>/attachments/<id>`), not the file the bot
    // wrote in its workspace — removing the workspace file would leave the preview working.
    rmSync(join(brain.dataDir, "attachments", id!))
    // `cache-control: immutable` means a URL already fetched once would be answered from the
    // browser cache; this file was never opened before now, so the first request really reaches
    // the route and gets the 404.
    await openPreview("doomed.md")
    await waitState("error")
    const text = (await preview().textContent()) ?? ""
    expect(text).toContain("Couldn't load this file")
    expect(text).toContain("deleted")
    // Distinguishable from "too large", and the bytes never reached the DOM.
    expect(text).not.toContain("too large")
    expect(text).not.toContain(DOOMED_BODY)
    const sentinel = DOOMED_BODY.slice(0, 24)
    expect(text).not.toContain(sentinel)
    // The Download fallback stays offered.
    expect(await preview().locator('a[download="doomed.md"]').count()).toBe(1)
    await closeWithEscape()
    // Closing leaves the chat usable, not stuck on the failure.
    const box = app.page.getByRole("textbox", { name: "Message Reel" })
    await box.fill("still works after the deleted attachment")
    await box.press("Enter")
    await app.page.getByTestId("transcript").getByText("still works after the deleted attachment").waitFor({ timeout: 15_000 })
  }, 90_000)

  test("closing while the preview is still loading cancels the in-flight request", async () => {
    // Closing must cancel the request, not merely stop the setState. It cannot be proven from the
    // UI: `alive` already stops the setState, so even without an abort nothing visible would go
    // wrong. The falsifiable half is the network layer — the request must die.
    const failed: Array<{ url: string; error: string }> = []
    const onFailed = (request: { url: () => string; failure: () => { errorText?: string } | null }) => {
      if (request.url().includes("/api/attachments/")) failed.push({ url: request.url(), error: request.failure()?.errorText ?? "(none)" })
    }
    app.page.on("requestfailed", onFailed)
    // Hold the response so the dialog stays in `loading` for as long as the test needs.
    let held: Route | undefined
    const handler = async (route: Route) => {
      held = route
    }
    await app.page.route("**/api/attachments/**", handler)
    try {
      await openPreview("notes.md")
      await waitState("loading")
      await closeWithEscape()
      // The AbortController fires as the effect cleans up; give the browser a moment to report it.
      const deadline = Date.now() + 5_000
      while (failed.length === 0 && Date.now() < deadline) await Bun.sleep(50)
      // Exactly one: `abort()` must not turn into a retry loop, and the same fetch must not be
      // reported twice. Without `controller.abort()` the held request stays pending and this is 0.
      expect(failed.length).toBe(1)
      expect(failed[0]!.error).toContain("ERR_ABORTED")
      // UI side (secondary — it cannot fail on its own): no dialog comes back, chat still works.
      await Bun.sleep(300)
      expect(await preview().count()).toBe(0)
      const box = app.page.getByRole("textbox", { name: "Message Reel" })
      await box.fill("usable after closing mid-load")
      await box.press("Enter")
      await app.page.getByTestId("transcript").getByText("usable after closing mid-load").waitFor({ timeout: 15_000 })
    } finally {
      app.page.off("requestfailed", onFailed)
      await app.page.unroute("**/api/attachments/**", handler)
      // `alive = false` makes the component ignore whatever arrives; release the held route so the
      // browser context can close instead of waiting on a pending request.
      try {
        await held?.abort()
      } catch {
        // already gone with the dialog
      }
    }
  }, 90_000)

  test("D4: an inline image that cannot load falls back to visible text (with alt and with an empty alt)", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    try {
      await page.goto(brain.loginUrl)
      await page.goto(`${brain.base}/#/c/${bot.directConversationId}`)
      await send(page, "Reel", "echo: ![broken](/api/attachments/does-not-exist) and ![](/api/attachments/does-not-exist)")
      const transcript = page.getByTestId("transcript")
      const fallbacks = transcript.locator(".ob-md-img-fallback")
      // Both images must reach their failure state before counting: the first one appears while the
      // second is still loading.
      await page.waitForFunction(() => document.querySelectorAll(".ob-md-img-fallback").length === 2, null, { timeout: 20_000 })
      await page.waitForFunction(() => document.querySelectorAll("img.ob-md-img").length === 0, null, { timeout: 20_000 })

      expect(await fallbacks.count()).toBe(2)
      // The <img> is gone on both, and each fallback is actually visible — not merely present.
      expect(await transcript.locator("img.ob-md-img").count()).toBe(0)
      const alt = fallbacks.nth(0)
      const empty = fallbacks.nth(1)
      expect((await alt.textContent())?.trim()).toBe("broken")
      expect((await empty.textContent())?.trim()).toBe("/api/attachments/does-not-exist")
      for (const box of [await alt.boundingBox(), await empty.boundingBox()]) {
        expect(box).not.toBeNull()
        expect(box!.width).toBeGreaterThan(0)
        expect(box!.height).toBeGreaterThan(0)
      }
      // The dashed frame is what makes the fallback read as a placeholder rather than as body copy.
      expect(await alt.evaluate((el) => getComputedStyle(el).borderStyle)).toBe("dashed")
      await page.screenshot({ path: join(shotsDir, "e2e-attachments-08-img-fallback.png") })
    } finally {
      await context.close()
    }
  }, 90_000)
})

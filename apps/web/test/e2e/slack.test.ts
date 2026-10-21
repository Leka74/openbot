// E2E: Slack (D3.4) against the real brain and a fake Slack (OPENBOT_SLACK_API_URL). Connect apps
// (the sidebar pill) lists Slack; its page connects with pasted tokens and shows live messages on,
// and the window then counts it as connected (manage view); a Bot's draft shows as a "Slack message"
// card that the owner edits and sends (the fake Slack receives it as the owner, mentions resolved);
// a draft with a video previews it and uploads it with the message; an app from an older manifest
// (no files:write) gets an update notice; the routine editor offers a Slack trigger, and a Slack DM
// starts that routine. Screenshots: e2e-8x-*.png.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Bot } from "@openbot/contracts"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Browser } from "playwright-core"
import {
  ALL_SCOPES,
  FAKE_APP_TOKEN,
  FAKE_USER_TOKEN,
  type FakeSlack,
  messageEnvelope,
  SCOPES_WITHOUT_FILES,
  startFakeSlack,
} from "../../../server/test/fixtures/fakeSlack.ts"
import { type AppPage, type Brain, connectRpc, eventually, hasChromium, launchBrowser, openApp, type Rpc, send, startBrain, waitIdle } from "./brain.ts"

describe.skipIf(!hasChromium)("e2e: Slack", () => {
  let slack: FakeSlack
  let brain: Brain
  let browser: Browser
  let rpc: Rpc
  let app: AppPage
  let otto: Bot

  beforeAll(async () => {
    slack = startFakeSlack()
    brain = await startBrain({ env: { OPENBOT_SLACK_API_URL: slack.url } })
    browser = await launchBrowser()
    rpc = await connectRpc(brain)
    otto = await rpc.call((c) => c["bots.create"]({ name: "Otto", harness: { kind: "fake" }, clientNonce: "e2e-slack-otto", introduce: false }))
    app = await openApp(browser, brain, { theme: "dark", route: `#/c/${otto.directConversationId}` })
    await app.page.getByRole("textbox", { name: "Message Otto" }).waitFor()
  }, 60_000)

  afterAll(async () => {
    await app?.context.close()
    await rpc?.close()
    await browser?.close()
    await brain?.stop()
    slack?.stop()
  })

  test("Connect apps › Slack: paste the tokens and connect", async () => {
    const { page } = app
    await page.getByTestId("connect-apps-pill").click()
    const window = page.getByTestId("connect-apps")
    await window.getByText("0 connected").waitFor()
    await app.shot("e2e-80-connect-apps")
    await window.getByTestId("app-slack").getByRole("button", { name: "Connect" }).click()
    const steps = page.getByTestId("slack-connect")
    await steps.waitFor()
    await app.shot("e2e-81-slack-connect")
    await steps.getByRole("textbox", { name: "User OAuth Token" }).fill("xoxp-wrong")
    await page.getByTestId("slack-connect-button").click()
    await steps.getByText("Slack didn't accept that User OAuth Token.").waitFor()
    await steps.getByRole("textbox", { name: "User OAuth Token" }).fill(FAKE_USER_TOKEN)
    await steps.getByRole("textbox", { name: "App-level token" }).fill(FAKE_APP_TOKEN)
    await page.getByTestId("slack-connect-button").click()
    const connected = page.getByTestId("slack-connected")
    await connected.getByText("Acme", { exact: true }).waitFor()
    await connected.getByText("As Owner · acme.slack.com").waitFor()
    await connected.getByText("On", { exact: true }).waitFor()
    await app.shot("e2e-85-slack-connected")
    expect(await rpc.call((c) => c["slack.status"]())).toMatchObject({ connected: true, team: "Acme", events: "live" })
    // back in the catalog Slack is connected; "1 connected ›" lists it
    await page.getByTestId("connect-apps-back").click()
    await window.getByTestId("app-slack").getByText("Connected").waitFor()
    await window.getByTestId("connected-count").click()
    await window.getByTestId("connected-slack").getByText("Acme · live messages on").waitFor()
    await app.shot("e2e-86-connect-apps-manage")
    // Hark sits under Notifications
    await page.getByTestId("connect-apps-back").click()
    await window.getByTestId("app-hark").getByRole("button", { name: "Connect" }).click()
    await page.getByTestId("hark-connect").waitFor()
    await app.shot("e2e-87-hark-connect")
    await window.getByRole("button", { name: "Close" }).click()
    await window.waitFor({ state: "detached" })
    expect(app.errors).toEqual([])
  }, 60_000)

  test("a Bot's draft: edit it and send it as yourself", async () => {
    const { page } = app
    await send(page, "Otto", 'tool: slack_draft {"to":"#general","text":"The deploy is fixed.","thread":"1729340000.000100"}')
    const card = page.locator('[data-card="slack-draft"]')
    await card.waitFor()
    await waitIdle(page)
    await card.getByText("Ready to send").waitFor()
    await card.getByText("Alice Smith: Can someone look at the deploy?").waitFor()
    const box = card.getByRole("textbox", { name: "Message" })
    expect(await box.inputValue()).toBe("The deploy is fixed.")
    await box.fill("The deploy is fixed, thanks @Alice Smith!")
    await card.scrollIntoViewIfNeeded()
    await app.shot("e2e-82-slack-draft")
    await card.getByRole("button", { name: "Send message" }).click()
    await card.getByText("Sent", { exact: true }).waitFor()
    await card.getByRole("link", { name: "Open in Slack" }).waitFor()
    expect(slack.posted).toEqual([{ channel: "C_GENERAL", text: "The deploy is fixed, thanks <@U_ALICE>!", thread_ts: "1729340000.000100" }])
    await app.shot("e2e-83-slack-sent")
    expect(app.errors).toEqual([])
  }, 60_000)

  test("a draft with a video: previewed on the card, uploaded with the message", async () => {
    const { page } = app
    const workspace = join(brain.dataDir, "bots", otto.id, "workspace", "output")
    mkdirSync(workspace, { recursive: true })
    const video = new Uint8Array(50_000)
    video.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
    writeFileSync(join(workspace, "teaser.mp4"), video)
    await send(page, "Otto", 'tool: slack_draft {"to":"#general","text":"","files":["output/teaser.mp4"]}')
    const card = page.locator('[data-card="slack-draft"][data-status="pending"]')
    await card.waitFor()
    await waitIdle(page)
    await card.locator("video").waitFor()
    await card.getByRole("textbox", { name: "Message" }).fill("Teaser for the launch")
    await card.scrollIntoViewIfNeeded()
    await app.shot("e2e-88-slack-draft-file")
    await card.getByRole("button", { name: "Send message" }).click()
    const sent = page.locator('[data-card="slack-draft"][data-status="resolved"]').last()
    await sent.getByRole("link", { name: "Open in Slack" }).waitFor()
    expect(slack.uploads.at(-1)).toMatchObject({ filename: "teaser.mp4", length: 50_000, bytes: 50_000 })
    expect(slack.shared.at(-1)).toMatchObject({ channel_id: "C_GENERAL", initial_comment: "Teaser for the launch" })
    expect(app.errors).toEqual([])
  }, 60_000)

  test("an app without files:write: Connect apps › Slack says to update it", async () => {
    const { page } = app
    slack.setScopes(SCOPES_WITHOUT_FILES)
    await rpc.call((c) => c["slack.connect"]({}))
    await page.getByTestId("connect-apps-pill").click()
    const window = page.getByTestId("connect-apps")
    await window.getByTestId("connected-count").click()
    await window.getByTestId("connected-slack").getByText("Acme · the app needs an update").waitFor()
    await window.getByTestId("connected-slack").getByRole("button", { name: "Fix" }).click()
    const update = page.getByTestId("slack-update")
    await update.getByText("Bots can't attach files to Slack messages yet").waitFor()
    await app.shot("e2e-89-slack-update")
    // updated in Slack: Check again clears it
    slack.setScopes(ALL_SCOPES)
    await update.getByRole("button", { name: "Check again" }).click()
    await update.waitFor({ state: "detached" })
    await window.getByRole("button", { name: "Close" }).click()
    await window.waitFor({ state: "detached" })
    expect(app.errors).toEqual([])
  }, 60_000)

  test("a routine on Slack DMs runs when someone writes", async () => {
    const { page } = app
    await page.getByRole("button", { name: "View conversation details" }).click()
    const pane = page.getByTestId("details-pane")
    await pane.getByTestId("new-routine").click()
    const dialog = page.getByRole("dialog")
    await dialog.getByTestId("routine-name").fill("Slack replies")
    await dialog.getByRole("textbox", { name: "Instruction" }).fill("echo: Someone wrote on Slack")
    await dialog.getByRole("tab", { name: "Slack" }).click()
    await dialog.getByText("reads the message with your instruction", { exact: false }).waitFor()
    await app.shot("e2e-84-slack-routine")
    await dialog.getByTestId("save-routine").click()
    await dialog.waitFor({ state: "detached" })
    await pane.getByTestId("routine-row").filter({ hasText: "When someone messages you on Slack" }).waitFor()
    const [routine] = await rpc.call((c) => c["routines.list"]({ botId: otto.id }))
    expect(routine?.trigger).toEqual({ type: "slack", on: "dm" })

    slack.push(messageEnvelope({ channel: "D_ALICE", channel_type: "im", user: "U_ALICE", text: "got a minute?" }))
    const runs = await eventually(
      () => rpc.call((c) => c["routines.runs"]({ routineId: routine!.id })),
      (r) => r.length > 0 && r[0]!.status !== "running",
      { label: "a Slack-started run", timeout: 30_000 },
    )
    expect(runs[0]).toMatchObject({ firedBy: "event", status: "succeeded" })
    await page.getByTestId("transcript").getByText("Someone wrote on Slack", { exact: true }).waitFor()
    expect(app.errors).toEqual([])
  }, 60_000)
})

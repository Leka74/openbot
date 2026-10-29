// A data dir from before profiles boots with everything in the main profile, in place: its Slack,
// Hark, ntfy, skills and attachments are still connected and readable, byte for byte, and a new
// profile starts with none of them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { MAIN_PROFILE_ID } from "@openbot/contracts"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startFakeSlack } from "./fixtures/fakeSlack.ts"
import { login, rpcClient, startServer, type TestServer } from "./helpers.ts"

const legacyFiles = (dir: string) => {
  const files: Record<string, string> = {
    "slack.json": JSON.stringify({
      version: 1,
      userToken: "xoxp-good",
      team: "Acme",
      teamUrl: "https://acme.slack.com/",
      userId: "U_OWNER",
      userName: "Owner",
    }),
    "hark.json": JSON.stringify({ version: 1, sends: "needs-you", token: "whk_legacy" }),
    "ntfy.json": JSON.stringify({ version: 1, sends: "all", server: "https://ntfy.example.com", topic: "legacy" }),
    "skills-lib/skills/legacy/SKILL.md": "---\nname: legacy\ndescription: Use when testing.\n---\n\nLegacy steps.\n",
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return files
}

describe("a data dir from before profiles", () => {
  const slack = startFakeSlack()
  const dataDir = mkdtempSync(join(tmpdir(), "openbot-legacy-"))
  const files = legacyFiles(dataDir)
  let server: TestServer
  let cookie: string
  beforeAll(async () => {
    server = await startServer({ dataDir, config: { slackApiUrl: slack.url } })
    cookie = await login(server.base, server.ownerToken)
  }, 30_000)
  afterAll(async () => {
    await server?.close()
    slack.stop()
  }, 30_000)

  test("keeps its connections and skills in the main profile; a new profile has none", () =>
    server.run(
      Effect.gen(function* () {
        const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })
        expect((yield* client["profiles.list"]()).activeId).toBe(MAIN_PROFILE_ID)
        expect(yield* client["slack.status"]()).toMatchObject({ connected: true, team: "Acme" })
        expect(yield* client["hark.status"]()).toMatchObject({ connected: true, sends: "needs-you" })
        expect(yield* client["ntfy.status"]()).toMatchObject({ connected: true, topic: "legacy" })
        expect((yield* client["skills.list"]()).map((s) => [s.name, s.body.trim()])).toEqual([
          ["legacy", "Legacy steps."],
        ])
        const upload = yield* client["attachments.upload"]({
          name: "main.txt",
          mime: "text/plain",
          bytesBase64: Buffer.from("main bytes").toString("base64"),
        })

        const demo = yield* client["profiles.create"]({ name: "Demo" })
        yield* client["profiles.switch"]({ profileId: demo.id })
        expect((yield* client["slack.status"]()).connected).toBe(false)
        expect((yield* client["hark.status"]()).connected).toBe(false)
        expect((yield* client["ntfy.status"]()).connected).toBe(false)
        expect(yield* client["skills.list"]()).toEqual([])

        yield* client["profiles.switch"]({ profileId: MAIN_PROFILE_ID })
        expect((yield* client["slack.status"]()).connected).toBe(true)
        const back = yield* Effect.promise(() =>
          fetch(`${server.base}${upload.url}`, { headers: { cookie, origin: server.base } }),
        )
        expect(yield* Effect.promise(() => back.text())).toBe("main bytes")
        expect(readFileSync(join(dataDir, "attachments", upload.id), "utf8")).toBe("main bytes")
        for (const [path, text] of Object.entries(files)) expect(readFileSync(join(dataDir, path), "utf8")).toBe(text)
      }),
    ))
})

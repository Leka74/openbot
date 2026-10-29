import { describe, expect, test } from "bun:test"
import { MAIN_PROFILE_ID, type OwnerProfileId } from "@openbot/contracts"
import { Effect } from "effect"
import { DataDir, joinPath, makeDataDir } from "../../src/ports/index.ts"

describe("DataDir", () => {
  test("derives every location from the root", () => {
    const dir = makeDataDir("/data/openbot/")
    expect(dir.root).toBe("/data/openbot")
    expect(dir.database).toBe("/data/openbot/openbot.sqlite")
    expect(dir.botDir("bot_1")).toBe("/data/openbot/bots/bot_1")
    expect(dir.memoryDir("bot_1")).toBe("/data/openbot/bots/bot_1/memory")
    expect(dir.workspaceDir("bot_1")).toBe("/data/openbot/bots/bot_1/workspace")
    expect(dir.codexHome).toBe("/data/openbot/codex-home")
    expect(dir.brainIdentity).toBe("/data/openbot/brain-identity.json")
    expect(dir.opencodeConfig).toBe("/data/openbot/opencode-config")
    expect(dir.localNode).toBe("/data/openbot/local-node")
  })

  test("the main profile keeps the paths from before profiles; the others live in profiles/<id>", () => {
    const dir = makeDataDir("/data/openbot")
    expect(dir.profile(MAIN_PROFILE_ID)).toEqual({
      root: "/data/openbot",
      skillsLib: "/data/openbot/skills-lib",
      attachments: "/data/openbot/attachments",
      slack: "/data/openbot/slack.json",
      hark: "/data/openbot/hark.json",
      ntfy: "/data/openbot/ntfy.json",
    })
    expect(dir.profile("prf_demo" as OwnerProfileId)).toEqual({
      root: "/data/openbot/profiles/prf_demo",
      skillsLib: "/data/openbot/profiles/prf_demo/skills-lib",
      attachments: "/data/openbot/profiles/prf_demo/attachments",
      slack: "/data/openbot/profiles/prf_demo/slack.json",
      hark: "/data/openbot/profiles/prf_demo/hark.json",
      ntfy: "/data/openbot/profiles/prf_demo/ntfy.json",
    })
    expect(dir.profile("../../etc" as OwnerProfileId).root).toBe("/data/openbot/profiles/______etc")
  })

  test("joinPath collapses separators", () => {
    expect(joinPath("/a/", "/b//", "c")).toBe("/a/b/c")
    expect(joinPath("/")).toBe("/")
  })

  test("layer provides the service", async () => {
    const root = await Effect.runPromise(Effect.map(DataDir, (d) => d.root).pipe(Effect.provide(DataDir.layer("/x"))))
    expect(root).toBe("/x")
  })
})

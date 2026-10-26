import { describe, expect, test } from "bun:test"
import type { BotId, SkillName } from "@openbot/contracts"
import { Effect, Exit, Layer } from "effect"
import { botActor, BotService, SkillService, SkillStore, userActor } from "../../src/ports/index.ts"
import { SkillServiceLive } from "../../src/services/automation/index.ts"
import { importedSkillName, safeSkillPath } from "../../src/services/automation/SkillService.ts"
import { makeClaims, runTest, SkillDirectoryFake } from "../../src/testing/index.ts"
import { appLayer, createBot, eventsOf, send, settled, TestDriver, transcript } from "./helpers.ts"

const failsWith = (exit: Exit.Exit<unknown, unknown>, tag: string) =>
  Exit.isFailure(exit) && JSON.stringify(exit.cause).includes(tag)

const skillMd = (name: string, description: string, body = "Do the thing.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`

const downloads = {
  "acme/skills/release-notes": {
    hash: "h1",
    files: [
      { path: "SKILL.md", contents: skillMd("Release Notes", "Use when writing release notes.") },
      { path: "scripts/collect.sh", contents: "git log --oneline\n" },
    ],
  },
  "acme/skills/escape": {
    files: [
      { path: "SKILL.md", contents: skillMd("escape", "x") },
      { path: "../evil.sh", contents: "rm -rf /" },
    ],
  },
  "acme/skills/empty": { files: [{ path: "README.md", contents: "no skill here" }] },
}

const layer = () =>
  SkillServiceLive.pipe(
    Layer.provide(
      SkillDirectoryFake.layer({
        results: [
          { id: "acme/skills/release-notes", name: "release-notes", repo: "acme/skills", installs: 12 },
          // hosted outside GitHub: not installable through skills.sh, so never offered
          { id: "notes.example.com/release-notes", name: "release-notes", repo: "notes.example.com", installs: 3 },
        ],
        downloads,
      }),
    ),
    Layer.provideMerge(appLayer()),
  )

const name = (n: string) => n as SkillName
/** Plain strings, for comparing branded names. */
const plain = (names: ReadonlyArray<SkillName>): Array<string> => [...names]

describe("SkillService (D5.5)", () => {
  test("owner skills: CRUD, validation, assign to exactly some Bots, delete takes it from every Bot", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const skills = yield* SkillService
        const bots = yield* BotService
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const saved = yield* skills.upsert(userActor, {
          name: name("weekly-report"),
          description: "  Use for the Friday report ",
          body: "1. Collect",
        })
        const badName = yield* Effect.exit(
          skills.upsert(userActor, { name: name("Bad Name"), description: "d", body: "b" }),
        )
        const noDescription = yield* Effect.exit(
          skills.upsert(userActor, { name: name("x"), description: " ", body: "b" }),
        )
        yield* skills.assign(saved.name, [ada.id, bob.id])
        const both = [plain((yield* bots.get(ada.id)).skills), plain((yield* bots.get(bob.id)).skills)]
        yield* skills.assign(saved.name, [bob.id])
        const onlyBob = [plain((yield* bots.get(ada.id)).skills), plain((yield* bots.get(bob.id)).skills)]
        const unknownSkill = yield* Effect.exit(skills.assign(name("nope"), [ada.id]))
        const unknownBot = yield* Effect.exit(skills.assign(saved.name, ["bot_missing" as BotId]))
        const patchUnknown = yield* Effect.exit(bots.update(ada.id, { skills: [name("nope")] }))
        yield* skills.delete(saved.name)
        const afterDelete = plain((yield* bots.get(bob.id)).skills)
        const gone = yield* Effect.exit(skills.get(saved.name))
        return {
          saved,
          badName,
          noDescription,
          both,
          onlyBob,
          unknownSkill,
          unknownBot,
          patchUnknown,
          afterDelete,
          gone,
        }
      }),
      layer(),
    )
    expect(out.saved).toMatchObject({ name: "weekly-report", description: "Use for the Friday report" })
    expect(failsWith(out.badName, "InvalidInput")).toBe(true)
    expect(failsWith(out.noDescription, "InvalidInput")).toBe(true)
    expect(out.both).toEqual([["weekly-report"], ["weekly-report"]])
    expect(out.onlyBob).toEqual([[], ["weekly-report"]])
    expect(failsWith(out.unknownSkill, "NotFound")).toBe(true)
    expect(failsWith(out.unknownBot, "NotFound")).toBe(true)
    expect(failsWith(out.patchUnknown, "InvalidInput")).toBe(true)
    expect(out.afterDelete).toEqual([])
    expect(failsWith(out.gone, "NotFound")).toBe(true)
  })

  test("owner-only skills: the owner turns the Bot's own use on or off; saving without the setting keeps it", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const skills = yield* SkillService
        const base = { name: name("grill-me"), description: "An interview.", body: "Ask." }
        const created = yield* skills.upsert(userActor, { ...base, disableModelInvocation: true })
        const edited = yield* skills.upsert(userActor, { ...base, body: "Ask more." })
        const cleared = yield* skills.upsert(userActor, { ...base, disableModelInvocation: false })
        return [created, edited, cleared].map((s) => s.disableModelInvocation)
      }),
      layer(),
    )
    expect(out).toEqual([true, true, undefined])
  })

  test("save_skill: the Bot gets its new skill and a skill-saved event; it may update its own, never someone else's", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const skills = yield* SkillService
        const bots = yield* BotService
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const asAda = botActor({ claims: makeClaims({ botId: ada.id, conversationId: ada.directConversationId }) })
        const asBob = botActor({ claims: makeClaims({ botId: bob.id, conversationId: bob.directConversationId }) })
        yield* skills.upsert(asAda, { name: name("triage"), description: "Use when triaging bugs.", body: "v1" })
        const updated = yield* skills.upsert(asAda, {
          name: name("triage"),
          description: "Use when triaging bugs.",
          body: "v2",
        })
        const bobTakesOver = yield* Effect.exit(
          skills.upsert(asBob, { name: name("triage"), description: "mine now", body: "v3" }),
        )
        return {
          ada: plain((yield* bots.get(ada.id)).skills),
          bob: plain((yield* bots.get(bob.id)).skills),
          updated,
          bobTakesOver,
          events: eventsOf(yield* transcript(ada.directConversationId)).filter((e) => e.type === "skill-saved"),
        }
      }),
      layer(),
    )
    expect(out.ada).toEqual(["triage"])
    expect(out.bob).toEqual([])
    expect(out.updated.body).toBe("v2")
    expect(failsWith(out.bobTakesOver, "InvalidInput")).toBe(true)
    expect(out.events).toEqual([
      { type: "skill-saved", name: "triage" },
      { type: "skill-saved", name: "triage" },
    ])
  })

  test("skills.sh: search, preview (nothing written), install with its files and source; unsafe or empty skills are refused", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const skills = yield* SkillService
        const bots = yield* BotService
        const store = yield* SkillStore
        const ada = yield* createBot("Ada")
        const found = yield* skills.search("release")
        const emptyQuery = yield* Effect.exit(skills.search("  "))
        const preview = yield* skills.preview("acme/skills/release-notes")
        const afterPreview = yield* store.list
        const installed = yield* skills.install("acme/skills/release-notes", [ada.id])
        const again = yield* skills.preview("acme/skills/release-notes")
        return {
          found,
          emptyQuery,
          preview,
          afterPreview,
          installed,
          again,
          ada: plain((yield* bots.get(ada.id)).skills),
          escape: yield* Effect.exit(skills.install("acme/skills/escape", [])),
          empty: yield* Effect.exit(skills.preview("acme/skills/empty")),
          unknown: yield* Effect.exit(skills.preview("acme/skills/missing")),
          badId: yield* Effect.exit(skills.preview("not an id")),
        }
      }),
      layer(),
    )
    expect(out.found.map((r) => r.id)).toEqual(["acme/skills/release-notes"])
    expect(failsWith(out.emptyQuery, "InvalidInput")).toBe(true)
    expect(out.preview).toMatchObject({
      name: "release-notes",
      description: "Use when writing release notes.",
      replaces: false,
      files: [{ path: "SKILL.md" }, { path: "scripts/collect.sh", bytes: 18 }],
    })
    expect(out.afterPreview).toEqual([])
    expect(out.installed).toMatchObject({
      name: "release-notes",
      source: { kind: "skills.sh", id: "acme/skills/release-notes", hash: "h1" },
      files: ["scripts/collect.sh"],
    })
    expect(out.again.replaces).toBe(true)
    expect(out.ada).toEqual(["release-notes"])
    expect(failsWith(out.escape, "InvalidInput")).toBe(true)
    expect(failsWith(out.empty, "InvalidInput")).toBe(true)
    expect(failsWith(out.unknown, "NotFound")).toBe(true)
    expect(failsWith(out.badId, "InvalidInput")).toBe(true)
  })

  test("a change to a Bot's skills reopens its session on the next turn (resuming it)", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const skills = yield* SkillService
        const driver = yield* TestDriver
        const ada = yield* createBot("Ada")
        yield* send(ada.directConversationId, "first")
        yield* settled(ada.directConversationId)
        yield* skills.upsert(userActor, { name: name("triage"), description: "Use when triaging bugs.", body: "v1" })
        yield* skills.assign(name("triage"), [ada.id])
        yield* send(ada.directConversationId, "second")
        yield* settled(ada.directConversationId, 2)
        return (yield* driver.opened).map((o) => ({ skills: plain(o.bot.skills), resume: o.nativeSessionId }))
      }),
      layer(),
    )
    expect(out).toEqual([
      { skills: [], resume: undefined },
      { skills: ["triage"], resume: "native-1" },
    ])
  })

  test("imported names and paths", () => {
    expect(importedSkillName("Release Notes", "x")).toBe(name("release-notes"))
    expect(importedSkillName(undefined, "find-skills")).toBe(name("find-skills"))
    expect(importedSkillName("!!!", "ok_name")).toBe(name("ok_name"))
    expect(safeSkillPath("./scripts/a.sh")).toBe("scripts/a.sh")
    expect(safeSkillPath("../a")).toBeUndefined()
    expect(safeSkillPath("/etc/passwd")).toBeUndefined()
    expect(safeSkillPath("a//b")).toBeUndefined()
  })
})

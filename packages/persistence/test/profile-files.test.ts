import { afterAll, describe, expect, test } from "bun:test"
import { MAIN_PROFILE_ID, type Millis, OwnerProfileId, type SkillName } from "@openbot/contracts"
import { AttachmentStore, inProfile, ProfileDirs, SkillStore } from "@openbot/core"
import { Effect, Exit } from "effect"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupTempDirs, run, tempDataDir, testPersistence } from "./helpers.ts"

afterAll(cleanupTempDirs)

const demo = OwnerProfileId.make("prf_demo")
const skill = (body: string) => ({
  name: "deploy" as SkillName,
  description: "Use when deploying.",
  body,
  updatedAt: 1 as Millis,
})

describe("profile files", () => {
  test("a skill of the same name and an upload stay in their own profile's folders", async () => {
    const dir = await tempDataDir()
    const out = await run(
      Effect.gen(function* () {
        const skills = yield* SkillStore
        const attachments = yield* AttachmentStore
        yield* skills.put(skill("main steps"))
        yield* skills.put(skill("demo steps")).pipe(inProfile(demo))
        const upload = { name: "notes.txt", mime: "text/plain", bytes: new TextEncoder().encode("demo notes") }
        return {
          main: yield* skills.list,
          demo: yield* skills.list.pipe(inProfile(demo)),
          record: yield* attachments.put(upload).pipe(inProfile(demo)),
        }
      }),
      testPersistence(dir),
    )
    expect(out.main.map((s) => s.body)).toEqual(["main steps"])
    expect(out.demo.map((s) => s.body)).toEqual(["demo steps"])
    expect(readFileSync(join(dir, "skills-lib", "skills", "deploy", "SKILL.md"), "utf8")).toContain("main steps")
    expect(readFileSync(join(dir, "profiles", demo, "skills-lib", "skills", "deploy", "SKILL.md"), "utf8")).toContain(
      "demo steps",
    )
    expect(existsSync(join(dir, "profiles", demo, "skills-lib", ".claude-plugin", "plugin.json"))).toBe(true)
    expect(out.record.ownerProfileId).toBe(demo)
    expect(out.record.path).toBe(join(dir, "profiles", demo, "attachments", out.record.id))
    expect(readdirSync(join(dir, "attachments"))).toEqual([])
  })

  test("ensure makes a profile's folders; retire moves them aside and never touches the main profile", async () => {
    const dir = await tempDataDir()
    const out = await run(
      Effect.gen(function* () {
        const dirs = yield* ProfileDirs
        yield* dirs.ensure(demo)
        yield* dirs.ensure(demo)
        const ensured = readdirSync(join(dir, "profiles", demo)).sort()
        yield* dirs.retire(demo)
        yield* dirs.retire(OwnerProfileId.make("prf_never_made"))
        return { ensured, main: yield* Effect.exit(dirs.retire(MAIN_PROFILE_ID)) }
      }),
      testPersistence(dir),
    )
    expect(out.ensured).toEqual(["attachments", "skills-lib"])
    expect(existsSync(join(dir, "profiles", demo))).toBe(false)
    const [aside] = readdirSync(join(dir, "profiles"))
    expect(aside).toStartWith(`.deleted-${demo}-`)
    expect(existsSync(join(dir, "profiles", aside!, "skills-lib", ".claude-plugin", "plugin.json"))).toBe(true)
    expect(Exit.isFailure(out.main)).toBe(true)
    expect(existsSync(join(dir, "skills-lib"))).toBe(true)
    expect(existsSync(join(dir, "attachments"))).toBe(true)
  })

  test("a forgotten profile's skills library is not opened again, so a late write can't bring its folder back", async () => {
    const dir = await tempDataDir()
    const out = await run(
      Effect.gen(function* () {
        const skills = yield* SkillStore
        yield* skills.put(skill("demo steps")).pipe(inProfile(demo))
        yield* skills.forget(demo)
        yield* (yield* ProfileDirs).retire(demo)
        return {
          late: yield* Effect.exit(skills.put(skill("late steps")).pipe(inProfile(demo))),
          main: yield* Effect.exit(skills.put(skill("main steps"))),
        }
      }),
      testPersistence(dir),
    )
    expect(Exit.isFailure(out.late)).toBe(true)
    expect(Exit.isSuccess(out.main)).toBe(true)
    expect(existsSync(join(dir, "profiles", demo))).toBe(false)
  })
})

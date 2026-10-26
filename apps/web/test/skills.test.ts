// Unit tests for the skills view helpers (details/skills.ts): names checked like the brain's
// `SkillName`, skills.sh formatting, which Bots have a skill.
import { describe, expect, test } from "bun:test"
import { type Bot, type BotId, type SkillName, SkillName as SkillNameSchema } from "@openbot/contracts"
import { Schema } from "effect"
import {
  botsWithSkill,
  formatBytes,
  formatInstalls,
  isSkillName,
  loseText,
  missingSkillDependencies,
  sameBots,
  siblingSkillId,
  skillNameError,
  skillsOfBot,
  skillsShErrorText,
  skillsShUrl,
  toSkillName,
} from "../src/details/skills.ts"

const isBrainSkillName = Schema.is(SkillNameSchema)

describe("skill names", () => {
  test("toSkillName makes the slug the brain accepts", () => {
    expect(toSkillName("Weekly Report")).toBe("weekly-report")
    expect(toSkillName("  release_checklist  ")).toBe("release_checklist")
    expect(toSkillName("PDF → text!")).toBe("pdf-text")
    expect(toSkillName("--draft--")).toBe("draft")
    expect(toSkillName("_private")).toBe("private")
    expect(toSkillName("Ünïcode")).toBe("n-code")
    expect(toSkillName("!!!")).toBe("")
    expect(toSkillName("a".repeat(80))).toHaveLength(64)
    // truncation never leaves a trailing dash
    expect(toSkillName(`${"a".repeat(63)} b`)).toBe("a".repeat(63))
  })

  test("isSkillName agrees with the contract's SkillName", () => {
    for (const name of [
      "pdf",
      "weekly-report",
      "a_b",
      "x1",
      "0day",
      "a".repeat(64),
      "",
      "-a",
      "_a",
      "A",
      "a b",
      "a.b",
      "a".repeat(65),
      "é",
    ]) {
      expect(isSkillName(name)).toBe(isBrainSkillName(name))
    }
    // whatever toSkillName produces from non-empty input is valid (or empty)
    for (const input of ["Hello World", "x", "  --  ", "Ünïcode", "a/b/c", "1 2 3"]) {
      const name = toSkillName(input)
      expect(name === "" || isBrainSkillName(name)).toBe(true)
    }
  })

  test("skillNameError: nothing typed, unusable, taken", () => {
    const library = [{ name: "pdf" as SkillName }]
    expect(skillNameError("", library)).toBeUndefined()
    expect(skillNameError("   ", library)).toBeUndefined()
    expect(skillNameError("weekly report", library)).toBeUndefined()
    expect(skillNameError("!!!", library)).toBe("Use letters or digits.")
    expect(skillNameError("PDF", library)).toBe("There's already a skill named “pdf”.")
  })
})

describe("skills.sh formatting", () => {
  test("formatInstalls", () => {
    expect(formatInstalls(0)).toBe("0 installs")
    expect(formatInstalls(1)).toBe("1 install")
    expect(formatInstalls(999)).toBe("999 installs")
    expect(formatInstalls(1_000)).toBe("1K installs")
    expect(formatInstalls(1_234)).toBe("1.2K installs")
    expect(formatInstalls(48_213)).toBe("48.2K installs")
    expect(formatInstalls(999_999)).toBe("1M installs")
    expect(formatInstalls(2_340_000)).toBe("2.3M installs")
  })

  test("formatBytes", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(812)).toBe("812 B")
    expect(formatBytes(4_300)).toBe("4.2 KB")
    expect(formatBytes(16_340)).toBe("16 KB")
    expect(formatBytes(1_400_000)).toBe("1.3 MB")
  })

  test("skillsShUrl", () => {
    expect(skillsShUrl("anthropics/skills/pdf")).toBe("https://skills.sh/anthropics/skills/pdf")
    expect(skillsShUrl("a b/c/d?e")).toBe("https://skills.sh/a%20b/c/d%3Fe")
  })

  test("skillsShErrorText: Unavailable and NotFound in plain words, others left to errorText", () => {
    expect(skillsShErrorText({ _tag: "Unavailable", message: "skills.sh did not answer (search): fetch failed" })).toBe(
      "skills.sh didn't answer — try again.",
    )
    expect(skillsShErrorText({ _tag: "NotFound", entity: "skill", id: "a/b/c" })).toBe(
      "skills.sh doesn't have this skill any more.",
    )
    expect(skillsShErrorText({ _tag: "InvalidInput", message: "nope" })).toBeUndefined()
    expect(skillsShErrorText("boom")).toBeUndefined()
  })
})

describe("skills that need another skill", () => {
  const library = [{ name: "grill-me" as SkillName }, { name: "release-notes" as SkillName }]
  test("missingSkillDependencies: the skills its instructions send the Bot to that the library lacks", () => {
    const grillMe = { name: "grill-me" as SkillName, body: 'Call the Skill tool with "grilling".' }
    expect(missingSkillDependencies(grillMe, library)).toEqual(["grilling"])
    expect(missingSkillDependencies(grillMe, [...library, { name: "grilling" as SkillName }])).toEqual([])
    // curly quotes, other wording, the same skill twice, a skill naming itself
    expect(
      missingSkillDependencies(
        { name: "a" as SkillName, body: "Use the Skill tool for “Grilling”, then the skill tool on 'grilling' again." },
        library,
      ),
    ).toEqual(["grilling"])
    expect(missingSkillDependencies({ name: "a" as SkillName, body: 'Skill tool with "a"' }, library)).toEqual([])
    expect(
      missingSkillDependencies({ name: "a" as SkillName, body: "Plain steps. Use /grilling later." }, library),
    ).toEqual([])
  })

  test("siblingSkillId: the same repository on skills.sh", () => {
    expect(siblingSkillId("mattpocock/skills/grill-me", "grilling")).toBe("mattpocock/skills/grilling")
    expect(siblingSkillId("broken", "grilling")).toBeUndefined()
  })
})

describe("who has a skill", () => {
  const bot = (id: string, name: string, skills: ReadonlyArray<string>) =>
    ({ id: id as BotId, name, skills: skills as ReadonlyArray<SkillName> }) as unknown as Bot
  const ava = bot("bot_a", "Ava", ["pdf", "triage"])
  const ben = bot("bot_b", "Ben", ["triage"])
  const cy = bot("bot_c", "Cy", [])

  test("botsWithSkill", () => {
    expect(botsWithSkill([ava, ben, cy], "triage").map((b) => b.name)).toEqual(["Ava", "Ben"])
    expect(botsWithSkill([ava, ben, cy], "nope")).toEqual([])
  })

  test("skillsOfBot joins the library and keeps names it doesn't list yet", () => {
    const library = [
      { name: "triage" as SkillName, description: "Use when triaging", body: "…", updatedAt: 1 },
      { name: "pdf" as SkillName, description: "Use for PDFs", body: "…", updatedAt: 1 },
    ]
    expect(skillsOfBot(ava, library).map((s) => [s.name, s.description])).toEqual([
      ["pdf", "Use for PDFs"],
      ["triage", "Use when triaging"],
    ])
    expect(
      skillsOfBot(bot("bot_d", "Di", ["zeta", "pdf"]), library.slice(0, 1)).map((s) => [s.name, s.description]),
    ).toEqual([
      ["pdf", ""],
      ["zeta", ""],
    ])
  })

  test("loseText says who loses a deleted skill", () => {
    expect(loseText([])).toBe("No Bot has it.")
    expect(loseText([ava])).toBe("Ava will lose it.")
    expect(loseText([ava, ben, cy])).toBe("3 Bots will lose it.")
  })

  test("sameBots ignores order", () => {
    const [a, b, c] = ["bot_a", "bot_b", "bot_c"] as Array<BotId>
    expect(sameBots([a!, b!], [b!, a!])).toBe(true)
    expect(sameBots([a!], [a!, c!])).toBe(false)
    expect(sameBots([], [])).toBe(true)
  })
})

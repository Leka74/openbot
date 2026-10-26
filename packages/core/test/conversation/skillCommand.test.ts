// The owner's `/skill` command (D5.5): only a leading `/name` of a skill the Bot has is a command.
import { describe, expect, test } from "bun:test"
import { parseSkillCommand, renderSkillCommand } from "../../src/services/conversation/skillCommand.ts"

const skills = ["grill-me", "grilling", "research_2"]

describe("skill commands", () => {
  test("a leading /name of one of the Bot's skills, with what follows it", () => {
    expect(parseSkillCommand("/grill-me my launch plan", skills)).toEqual({ name: "grill-me", rest: "my launch plan" })
    expect(parseSkillCommand("  /grilling\n\nthe API design\nsecond line", skills)).toEqual({
      name: "grilling",
      rest: "the API design\nsecond line",
    })
    expect(parseSkillCommand("/research_2", skills)).toEqual({ name: "research_2", rest: "" })
  })

  test("anything else is an ordinary message", () => {
    expect(parseSkillCommand("/unknown-skill do it", skills)).toBeUndefined()
    expect(parseSkillCommand("/grill", skills)).toBeUndefined()
    expect(parseSkillCommand("/grill-me-more x", skills)).toBeUndefined()
    expect(parseSkillCommand("please /grill-me", skills)).toBeUndefined()
    expect(parseSkillCommand("/home/user/file.txt", skills)).toBeUndefined()
    expect(parseSkillCommand("/grill-me", [])).toBeUndefined()
  })

  test("the Bot reads an explicit instruction that names the skill and the request", () => {
    const text = renderSkillCommand({ name: "grill-me", rest: "my launch plan" })
    expect(text).toContain('"grill-me" skill')
    expect(text).toContain("Their request: my launch plan")
    expect(text).not.toContain("/grill-me my launch plan")
    expect(renderSkillCommand({ name: "grill-me", rest: "" })).toContain("They gave no details")
  })
})

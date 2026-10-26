// The owner's `/skill` command (D5.5) through the conversation: the chat keeps what was typed, the Bot
// reads an instruction for a skill it has, and any other `/…` message reaches it as it is.
import { describe, expect, test } from "bun:test"
import type { SkillName } from "@openbot/contracts"
import { Effect, Layer } from "effect"
import { SkillService, userActor } from "../../src/ports/index.ts"
import { SkillServiceLive } from "../../src/services/automation/index.ts"
import { runTest, SkillDirectoryFake } from "../../src/testing/index.ts"
import { appLayer, createBot, messagesOf, send, settled, TestDriver, transcript } from "./helpers.ts"

const layer = () =>
  SkillServiceLive.pipe(
    Layer.provide(SkillDirectoryFake.layer({ results: [], downloads: {} })),
    Layer.provideMerge(appLayer()),
  )

describe("/skill commands (D5.5)", () => {
  test("a skill the Bot has reaches it as an instruction; the chat shows what the owner typed", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const skills = yield* SkillService
        const ada = yield* createBot("Ada")
        yield* skills.upsert(userActor, {
          name: "weekly-report" as SkillName,
          description: "Use for the Friday report",
          body: "1. Collect",
        })
        yield* skills.assign("weekly-report" as SkillName, [ada.id])
        yield* send(ada.directConversationId, "/weekly-report for the platform team")
        yield* settled(ada.directConversationId)
        yield* send(ada.directConversationId, "/not-a-skill for the platform team")
        yield* settled(ada.directConversationId, 2)
        return {
          inputs: (yield* driver.turns).map((t) => t.input.text),
          shown: messagesOf(yield* transcript(ada.directConversationId))
            .filter((m) => m.role === "user")
            .map((m) => m.text),
        }
      }),
      layer(),
    )
    expect(out.inputs[0]).toContain('The owner started your "weekly-report" skill')
    expect(out.inputs[0]).toContain("Their request: for the platform team")
    expect(out.inputs[1]).toBe("/not-a-skill for the platform team")
    expect(out.shown).toEqual(["/weekly-report for the platform team", "/not-a-skill for the platform team"])
  })
})

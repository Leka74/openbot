// The screen lines of the OpenBot instructions (D1.7): `computer` with a desktop, `request_takeover`
// with any screen (desktop or browser window).
import { describe, expect, test } from "bun:test"
import { LOCAL_NODE_ID } from "@openbot/contracts"
import type { PlacementSummary, Toolset } from "../../src/ports/Placement.ts"
import { Effect } from "effect"
import { ConversationService, InstructionRenderer } from "../../src/ports/index.ts"
import { assembleInstructions, renderBase, renderGroups } from "../../src/services/conversation/InstructionRenderer.ts"
import { botId, conversationId, makeBot, makeGroupConversation, runTest } from "../../src/testing/index.ts"
import { appLayer, createBot } from "./helpers.ts"

const placement = (toolsets: ReadonlyArray<Toolset>, sharedScreen = false): PlacementSummary => ({
  mode: "native-local",
  hostNodeId: LOCAL_NODE_ID,
  workspacePath: "/work",
  toolsets,
  ...(sharedScreen ? { sharedScreen } : {}),
  promptAppend: "",
})

describe("InstructionRenderer: screen tools", () => {
  const bot = makeBot({ name: "Scout" })

  test("no screen: neither computer nor request_takeover", () => {
    const text = renderBase(bot, placement(["bot"]))
    expect(text).not.toContain("`computer`")
    expect(text).not.toContain("request_takeover")
  })

  test("browser only: request_takeover, no computer", () => {
    const text = renderBase(bot, placement(["bot", "browser"]))
    expect(text).toContain("`browser` drives your own browser window")
    expect(text).toContain("call `request_takeover`")
    expect(text).not.toContain("`computer`")
  })

  test("desktop: your own screen, screenshot first, browser for web pages, request_takeover for logins", () => {
    const text = renderBase(bot, placement(["bot", "browser", "computer"]))
    expect(text).toContain("You have your own screen, with a browser, a terminal, files and an editor")
    expect(text).toContain("take a screenshot first")
    expect(text).toContain("Prefer `browser` for web pages")
    expect(text).toContain("For a login, a password, a 2FA code, a CAPTCHA")
    expect(text).toContain("finish your turn and wait for it")
  })

  test("a Mac's own screen: shared with the owner, leave their work alone, wait when it is in use", () => {
    const text = renderBase(bot, placement(["bot", "browser", "computer"], true))
    expect(text).toContain("Your screen is your owner's own Mac screen")
    expect(text).toContain("leave the owner's windows and work as they are")
    expect(text).toContain("take a screenshot first")
    expect(text).not.toContain("You have your own screen")
    expect(text).toContain("call `request_takeover`")
  })
})

describe("InstructionRenderer: looking back", () => {
  const bot = makeBot({ name: "Scout" })

  test("while bots may search their chats: look up exact detail instead of relying on recollection", () => {
    const text = renderBase(bot, placement(["bot"]))
    expect(text).toContain("`search_messages` and `read_conversation` look back through your conversations")
    expect(text).toContain("instead of relying on recollection")
    expect(renderBase(bot, placement(["bot"]), false)).not.toContain("search_messages")
  })
})

describe("InstructionRenderer: groups", () => {
  const lead = makeBot({ id: botId("bot_lead"), name: "Engineering Lead" })
  const claude = makeBot({ id: botId("bot_claude"), name: "Claude Engineer" })
  const codex = makeBot({ id: botId("bot_codex"), name: "Codex Engineer" })
  const team = [lead, claude, codex]
  const group = makeGroupConversation({
    id: conversationId("cnv_render"),
    title: "improve video render speed",
    memberBotIds: [lead.id, claude.id, codex.id],
    leadBotId: lead.id,
  })

  test("each group the bot is in: title, id for post_to_group, the other members and who leads", () => {
    expect(renderGroups(claude, [group], team)).toBe(
      '- "improve video render speed" (id cnv_render): with @Engineering Lead (lead), @Codex Engineer',
    )
    expect(renderGroups(lead, [group], team)).toBe(
      '- "improve video render speed" (id cnv_render): with @Claude Engineer, @Codex Engineer; you lead it',
    )
  })

  test("a \"Your groups\" section only when there are groups; the rule keeps group work in the group", () => {
    const sections = { base: renderBase(lead, placement(["bot"])), persona: "", team: "", memoryIndex: "", placement: "" }
    expect(assembleInstructions(sections).text).not.toContain("## Your groups")
    const text = assembleInstructions({ ...sections, groups: renderGroups(lead, [group], team) }).text
    expect(text).toContain('## Your groups\n- "improve video render speed" (id cnv_render)')
    expect(text).toContain("Work that belongs to one of your groups (under \"Your groups\") is coordinated in that group, wherever the request reaches you")
    expect(text).toContain("For anything none of your groups is about, `message_bot`")
  })

  test("the rendered instructions list the bot's live groups", async () => {
    const text = await runTest(
      Effect.gen(function*() {
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        yield* (yield* ConversationService).createGroup({ title: "launch", memberBotIds: [ada.id, bob.id], leadBotId: ada.id })
        return (yield* (yield* InstructionRenderer).render({ bot: ada, placement: placement(["bot"]) })).text
      }),
      appLayer(),
    )
    expect(text).toMatch(/## Your groups\n- "launch" \(id cnv_\w+\): with @Bob; you lead it/)
  })
})

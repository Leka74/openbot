import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdirSync, readdirSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { callTool, connectBot, connectOwner, startProfiles } from "./profile-isolation-helpers.ts"

let fixture: Awaited<ReturnType<typeof startProfiles>>
beforeEach(async () => {
  fixture = await startProfiles()
}, 30_000)
afterEach(async () => {
  await fixture?.server.close()
}, 30_000)

describe("MCP tools use the calling bot's profile while another profile is active", () => {
  for (const tool of ["list_bots", "list_skills", "list_routines", "recall_memory"] as const) {
    test(
      tool,
      () =>
        fixture.server.run(
          Effect.gen(function* () {
            const owner = yield* connectOwner(fixture.server, fixture.cookie)
            const [a, b] = fixture.profiles
            for (const [own, foreign] of [
              [a, b],
              [b, a],
            ] as const) {
              yield* owner["profiles.switch"]({ profileId: foreign.profileId })
              const bot = yield* connectBot(own.bot)
              const result = yield* callTool(bot, tool)
              expect(result.isError).toBe(false)
              expect(result.text.toLowerCase()).toContain(own.marker.toLowerCase())
              expect(result.text.toLowerCase()).not.toContain(foreign.marker.toLowerCase())
            }
          }),
        ),
      30_000,
    )
  }

  test(
    "search_messages finds its own history and hides the active profile's history",
    () =>
      fixture.server.run(
        Effect.gen(function* () {
          const owner = yield* connectOwner(fixture.server, fixture.cookie)
          const [a, b] = fixture.profiles
          for (const [own, foreign] of [
            [a, b],
            [b, a],
          ] as const) {
            yield* owner["profiles.switch"]({ profileId: foreign.profileId })
            const bot = yield* connectBot(own.bot)
            const found = yield* callTool(bot, "search_messages", { query: own.marker })
            expect(found.isError).toBe(false)
            expect(found.text).toContain("private transcript")
            const hidden = yield* callTool(bot, "search_messages", { query: foreign.marker })
            expect(hidden.text).toContain("Nothing in your conversations matches")
            expect(hidden.text).not.toContain("private transcript")
            expect(
              (yield* callTool(bot, "search_messages", {
                query: foreign.marker,
                conversation: foreign.bot.directConversationId,
              })).isError,
            ).toBe(true)
          }
        }),
      ),
    30_000,
  )

  test(
    "the active profile's botSearch setting does not change another profile's MCP tools",
    () =>
      fixture.server.run(
        Effect.gen(function* () {
          const owner = yield* connectOwner(fixture.server, fixture.cookie)
          const [a, b] = fixture.profiles
          yield* owner["profiles.switch"]({ profileId: b.profileId })
          yield* owner["settings.update"]({ patch: { botSearch: false } })
          const aClient = yield* connectBot(a.bot)
          const bClient = yield* connectBot(b.bot)
          const aTools = yield* Effect.promise(() => aClient.listTools())
          const bTools = yield* Effect.promise(() => bClient.listTools())
          expect(aTools.tools.map((tool) => tool.name)).toContain("search_messages")
          expect(bTools.tools.map((tool) => tool.name)).not.toContain("search_messages")
          const result = yield* callTool(aClient, "search_messages", { query: a.marker })
          expect(result.isError).toBe(false)
          expect(result.text).toContain("private transcript")
        }),
      ),
    30_000,
  )

  test(
    "read_conversation rejects foreign chat and entry anchors in every direction",
    () =>
      fixture.server.run(
        Effect.gen(function* () {
          const owner = yield* connectOwner(fixture.server, fixture.cookie)
          const [a, b] = fixture.profiles
          for (const [own, foreign] of [
            [a, b],
            [b, a],
          ] as const) {
            yield* owner["profiles.switch"]({ profileId: foreign.profileId })
            const bot = yield* connectBot(own.bot)
            const ownHistory = yield* callTool(bot, "read_conversation", { conversation: "owner" })
            expect(ownHistory.isError).toBe(false)
            expect(ownHistory.text).toContain(`${own.marker} private transcript`)
            for (const args of [
              { conversation: foreign.bot.directConversationId },
              { around: foreign.entry.id },
              { before: foreign.entry.id },
              { after: foreign.entry.id },
            ]) {
              const hidden = yield* callTool(bot, "read_conversation", args)
              expect(hidden.isError).toBe(true)
              expect(hidden.text).not.toContain(`${foreign.marker} private transcript`)
            }
          }
        }),
      ),
    30_000,
  )

  for (const tool of ["message_bot", "handoff_task"] as const) {
    test(
      `${tool} rejects a foreign recipient by name and id`,
      () =>
        fixture.server.run(
          Effect.gen(function* () {
            const owner = yield* connectOwner(fixture.server, fixture.cookie)
            const [a, b] = fixture.profiles
            for (const [own, foreign] of [
              [a, b],
              [b, a],
            ] as const) {
              yield* owner["profiles.switch"]({ profileId: foreign.profileId })
              const bot = yield* connectBot(own.bot)
              for (const to of [foreign.bot.name, foreign.bot.id]) {
                const result = yield* callTool(bot, tool, { to, text: "intruder", task: "intruder" })
                expect(result.isError).toBe(true)
                expect(result.text).toStartWith("ERROR:")
              }
              const page = yield* owner["conversations.around"]({
                conversationId: foreign.bot.directConversationId,
                limit: 50,
              })
              expect(JSON.stringify(page)).not.toContain("intruder")
            }
          }),
        ),
      30_000,
    )
  }

  test(
    "send_file to the owner lands in the sender's profile and its attachment is hidden from the active profile",
    () =>
      fixture.server.run(
        Effect.gen(function* () {
          const owner = yield* connectOwner(fixture.server, fixture.cookie)
          const [a, b] = fixture.profiles
          for (const [own, foreign] of [
            [a, b],
            [b, a],
          ] as const) {
            const workspace = join(fixture.server.dataDir, "bots", own.bot.id, "workspace")
            mkdirSync(workspace, { recursive: true })
            writeFileSync(join(workspace, "report.txt"), `${own.marker} file contents`)
            yield* owner["profiles.switch"]({ profileId: foreign.profileId })
            const bot = yield* connectBot(own.bot)
            const sent = yield* callTool(bot, "send_file", {
              path: "report.txt",
              caption: `${own.marker} file delivery`,
            })
            expect(sent.isError).toBe(false)
            yield* owner["profiles.switch"]({ profileId: own.profileId })
            const page = yield* owner["conversations.around"]({
              conversationId: own.bot.directConversationId,
              limit: 50,
            })
            const message = page.entries.find(
              (entry) => entry.kind === "message" && entry.text === `${own.marker} file delivery`,
            )
            expect(message?.kind).toBe("message")
            if (message?.kind !== "message") return
            expect(message.attachments).toHaveLength(1)
            const attachment = message.attachments[0]!
            const ownResponse = yield* Effect.promise(() =>
              fetch(`${fixture.server.base}${attachment.url}`, { headers: { cookie: fixture.cookie } }),
            )
            expect(yield* Effect.promise(() => ownResponse.text())).toBe(`${own.marker} file contents`)
            yield* owner["profiles.switch"]({ profileId: foreign.profileId })
            const response = yield* Effect.promise(() =>
              fetch(`${fixture.server.base}${attachment.url}`, { headers: { cookie: fixture.cookie } }),
            )
            yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve())
            expect(response.status).toBe(404)
            const foreignPage = yield* owner["conversations.around"]({
              conversationId: foreign.bot.directConversationId,
              limit: 50,
            })
            expect(JSON.stringify(foreignPage)).not.toContain(`${own.marker} file delivery`)
          }
        }),
      ),
    30_000,
  )

  test(
    "send_file cannot deliver an attachment into another profile's bot inbox",
    () =>
      fixture.server.run(
        Effect.gen(function* () {
          const [own, foreign] = fixture.profiles
          const workspace = join(fixture.server.dataDir, "bots", own.bot.id, "workspace")
          mkdirSync(workspace, { recursive: true })
          writeFileSync(join(workspace, "private.txt"), "private file")
          const bot = yield* connectBot(own.bot)
          for (const to of [foreign.bot.id, foreign.bot.name]) {
            expect((yield* callTool(bot, "send_file", { path: "private.txt", to })).isError).toBe(true)
          }
          const inbox = join(fixture.server.dataDir, "bots", foreign.bot.id, "workspace", "inbox")
          const files = existsSync(inbox) ? readdirSync(inbox, { recursive: true, encoding: "utf8" }) : []
          expect(files.some((file) => file.endsWith("private.txt"))).toBe(false)
        }),
      ),
    30_000,
  )
})

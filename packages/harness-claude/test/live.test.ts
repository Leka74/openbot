/**
 * Live smoke test against the real Claude Code CLI. Gated by `OPENBOT_LIVE_CLAUDE=1`; uses the
 * user's existing login (the `claude` on PATH when present, else the SDK's bundled CLI, D2.1),
 * model `haiku`, one short turn with built-ins off (≈$0.001 API-equivalent) plus a free probe and a
 * zero-turn open/close. Sessions created here are deleted afterwards.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { deleteSession } from "@anthropic-ai/claude-agent-sdk"
import type { HarnessEvent, SkillName } from "@openbot/contracts"
import { makeDataDir } from "@openbot/core"
import { Effect } from "effect"
import { mkdirSync, realpathSync, rmdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { makeClaudeDriver } from "../src/Driver.ts"
import { collect, has, makeSessionInput, tempDir, turnId } from "./support.ts"

const live = process.env.OPENBOT_LIVE_CLAUDE === "1"

/** Real (symlink-free) temp root: the CLI keys transcripts by the resolved cwd. */
const liveRoot = () => realpathSync(tempDir())

const created: Array<{ readonly sessionId: string; readonly dir: string }> = []

/** The CLI's per-cwd transcript directory (`<config>/projects/<cwd, non-alphanumerics → '-'>`). */
const projectDir = (cwd: string) =>
  join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"))

afterAll(async () => {
  for (const { sessionId, dir } of created) {
    await deleteSession(sessionId, { dir }).catch(() => {
      // never persisted (no turn ran)
    })
    try {
      rmdirSync(projectDir(dir)) // only when empty
    } catch {
      // absent or still holds other sessions
    }
  }
})

describe.skipIf(!live)("live Claude (OPENBOT_LIVE_CLAUDE=1)", () => {
  test("probe reports install, version and auth without a model call", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* makeClaudeDriver({}, { dataDir: makeDataDir(liveRoot()) })
        return yield* driver.probe
      }),
    )
    expect(status.installed).toBe(true)
    expect(status.version).toBeDefined()
    expect(status.auth.state).not.toBe("signed-out")
  }, 60_000)

  test("open a real session with the full options, read context usage, close (no model call)", async () => {
    const root = liveRoot()
    const ledger: Array<string> = []
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* makeClaudeDriver(
            {},
            {
              dataDir: makeDataDir(root),
              ledger: {
                record: (pid) => Effect.sync(() => void ledger.push(`+${pid}`)),
                remove: (pid) => Effect.sync(() => void ledger.push(`-${pid}`)),
              },
            },
          )
          const input = makeSessionInput(join(root, "ws"), () => Effect.never, { mcp: [] })
          const session = yield* driver.openSession(input)
          const collector = yield* collect(session.events)
          const usage = yield* session.contextUsage
          const sessionId = yield* session.nativeSessionId
          if (sessionId) created.push({ sessionId, dir: input.placement.harnessCwd })
          return { usage, events: collector.events }
        }),
      ),
    )
    expect(result.usage?.windowTokens).toBeGreaterThan(0)
    expect(result.events[0]!._tag).toBe("SessionBound")
    // the release waited for the CLI to exit: recorded, then removed
    expect(ledger).toHaveLength(2)
    expect(ledger[0]!.startsWith("+")).toBe(true)
    expect(ledger[1]).toBe(`-${ledger[0]!.slice(1)}`)
  }, 60_000)

  test("one haiku turn", async () => {
    const root = liveRoot()
    const events: Array<HarnessEvent> = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* makeClaudeDriver({}, { dataDir: makeDataDir(root) })
          const base = makeSessionInput(join(root, "ws"), () => Effect.succeed({ decision: "deny" as const }), {
            mcp: [],
            model: "haiku",
          })
          const input = { ...base, placement: { ...base.placement, disableBuiltinTools: true } }
          const session = yield* driver.openSession(input)
          const sessionId = yield* session.nativeSessionId
          if (sessionId) created.push({ sessionId, dir: input.placement.harnessCwd })
          const collector = yield* collect(session.events)
          yield* session.startTurn({
            turnId: turnId(1),
            text: "Reply with exactly the word PONG and nothing else.",
            attachments: [],
          })
          for (let i = 0; i < 1800; i++) {
            if (
              collector.events.some(
                (e) => e._tag === "TurnCompleted" || e._tag === "TurnFailed" || e._tag === "SessionClosed",
              )
            )
              break
            yield* Effect.sleep(50)
          }
          return [...collector.events]
        }),
      ),
    )
    const failure = events.find((e) => e._tag === "TurnFailed" || e._tag === "SessionClosed")
    expect(failure && failure._tag === "TurnFailed" ? failure.error : undefined).toBeUndefined()
    expect(has("TurnCompleted")(events)).toBe(true)
    const text = events
      .flatMap((e) =>
        e._tag === "ItemUpserted" && e.item._tag === "Message" && !e.item.streaming ? [e.item.text] : [],
      )
      .join("")
    expect(text).toContain("PONG")
    expect(events[0]!._tag).toBe("SessionBound")
    expect(has("Usage")(events)).toBe(true)
    expect(has("ContextUsage")(events)).toBe(true)
  }, 120_000)

  test("the owner's command starts a disable-model-invocation skill (one haiku turn)", async () => {
    const root = liveRoot()
    const dataDir = makeDataDir(root)
    const library = join(root, "skills-lib")
    mkdirSync(join(library, "skills", "say-code"), { recursive: true })
    writeFileSync(
      join(library, "skills", "say-code", "SKILL.md"),
      "---\nname: say-code\ndescription: Says a code.\ndisable-model-invocation: true\n---\n\nReply with exactly CODE-$ARGUMENTS and nothing else.\n",
    )
    const events: Array<HarnessEvent> = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* makeClaudeDriver({}, { dataDir })
          const base = makeSessionInput(join(root, "ws"), () => Effect.succeed({ decision: "deny" as const }), {
            mcp: [],
            model: "haiku",
          })
          const input = {
            ...base,
            bot: { ...base.bot, skills: ["say-code" as SkillName] },
            ownerOnlySkills: ["say-code" as SkillName],
            placement: { ...base.placement, disableBuiltinTools: true },
          }
          const session = yield* driver.openSession(input)
          const sessionId = yield* session.nativeSessionId
          if (sessionId) created.push({ sessionId, dir: input.placement.harnessCwd })
          const collector = yield* collect(session.events)
          yield* session.startTurn({
            turnId: turnId(1),
            text: 'The owner started your "say-code" skill (they typed /say-code).',
            attachments: [],
            skillCommand: { name: "say-code", args: "ZEBRA" },
          })
          for (let i = 0; i < 1800; i++) {
            if (collector.events.some((e) => e._tag === "TurnCompleted" || e._tag === "TurnFailed")) break
            yield* Effect.sleep(50)
          }
          return [...collector.events]
        }),
      ),
    )
    const text = events
      .flatMap((e) =>
        e._tag === "ItemUpserted" && e.item._tag === "Message" && !e.item.streaming ? [e.item.text] : [],
      )
      .join("")
    expect(text).toContain("CODE-ZEBRA")
  }, 120_000)
})

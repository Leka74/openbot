import {
  type BotId,
  type ConversationId,
  MAIN_PROFILE_ID,
  type MemoryFactId,
  type Millis,
  type SkillName,
  type TurnId,
} from "@openbot/contracts"
import { AttachmentStore, CarryoverStore, inProfile, MemoryStore, SkillStore } from "@openbot/core"
import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Exit, Option, Schema, Stream } from "effect"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseFrontmatter, pluginManifest, renderFrontmatter } from "../src/index.ts"
import { cleanupTempDirs, run, tempDataDir, testPersistence } from "./helpers.ts"

afterAll(cleanupTempDirs)

const bot = "bot_mem" as BotId

describe("MemoryStore files (Claude auto-memory format)", () => {
  test("writes MEMORY.md and one frontmatter file per fact, and reads them back exactly", async () => {
    const dir = await tempDataDir()
    const fact = {
      id: "dark-mode" as MemoryFactId,
      title: "Prefers dark mode: always",
      description: "UI preference",
      body: "The owner prefers dark mode.\n\n- even at noon\n",
      updatedAt: 1_760_000_000_123 as Millis,
    }
    const read = await run(
      Effect.gen(function* () {
        const store = yield* MemoryStore
        yield* store.writeIndex(bot, "- [Dark mode](dark-mode.md) — UI preference\n")
        yield* store.putFact(bot, fact)
        return {
          index: yield* store.readIndex(bot),
          fact: yield* store.getFact(bot, fact.id),
          all: yield* store.listFacts(bot),
        }
      }),
      testPersistence(dir),
    )
    expect(read.index).toBe("- [Dark mode](dark-mode.md) — UI preference\n")
    expect(Option.getOrThrow(read.fact)).toEqual(fact)
    expect(read.all).toEqual([fact])

    const memoryDir = join(dir, "bots", bot, "memory")
    expect((await readdir(memoryDir)).sort()).toEqual(["MEMORY.md", "dark-mode.md"])
    const text = await readFile(join(memoryDir, "dark-mode.md"), "utf8")
    expect(text).toBe(
      [
        "---",
        'name: "Prefers dark mode: always"',
        "description: UI preference",
        "metadata:",
        "  modified: 2025-10-09T08:53:20.123Z",
        "---",
        "",
        "The owner prefers dark mode.\n\n- even at noon\n",
      ].join("\n"),
    )
  })

  test("tolerates files written by Claude: keeps unknown keys, ignores non-fact files", async () => {
    const dir = await tempDataDir()
    const memoryDir = join(dir, "bots", bot, "memory")
    await mkdir(memoryDir, { recursive: true })
    await writeFile(
      join(memoryDir, "project-goal.md"),
      '---\nname: project-goal\ndescription: "OpenBot = Grok Bot clone"\nmetadata:\n  node_type: memory\n  type: project\n  modified: 2026-10-14T21:01:15.498Z\n---\n\nBuild it.\n',
    )
    await writeFile(join(memoryDir, "Notes With Spaces.md"), "ignored")
    await writeFile(join(memoryDir, "no-frontmatter.md"), "just text")
    const facts = await run(
      Effect.gen(function* () {
        const store = yield* MemoryStore
        const before = yield* store.listFacts(bot)
        const goal = before.find((f) => f.id === "project-goal")!
        yield* store.putFact(bot, { ...goal, body: "Build it well.\n", updatedAt: 1 as Millis })
        return before
      }),
      testPersistence(dir),
    )
    expect(facts.map((f) => [f.id, f.title, f.description, f.updatedAt])).toEqual([
      ["no-frontmatter", "no-frontmatter", undefined, expect.any(Number)],
      ["project-goal", "project-goal", "OpenBot = Grok Bot clone", Date.parse("2026-10-14T21:01:15.498Z")],
    ])
    const rewritten = await readFile(join(memoryDir, "project-goal.md"), "utf8")
    expect(rewritten).toContain("  node_type: memory\n  type: project\n  modified: 1970-01-01T00:00:00.001Z\n")
    expect(rewritten.endsWith("---\n\nBuild it well.\n")).toBe(true)
  })

  test("rejects bot ids that would escape the data dir", async () => {
    const dir = await tempDataDir()
    const exit = await run(
      Effect.exit(Effect.flatMap(MemoryStore, (store) => store.writeIndex("../../etc" as BotId, "x"))),
      testPersistence(dir),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("SkillStore files (Claude plugin layout)", () => {
  test("keeps plugin.json and writes skills/<name>/SKILL.md with frontmatter", async () => {
    const dir = await tempDataDir()
    const skill = {
      name: "triage" as SkillName,
      description: "Use when triaging GitHub issues: label, dedupe, assign",
      body: "# Triage\n\n1. Read the issue.\n",
      updatedAt: 42 as Millis,
    }
    const [listed, root] = await run(
      Effect.gen(function* () {
        const store = yield* SkillStore
        yield* store.put(skill)
        return [yield* store.list, yield* store.dir(skill.name)] as const
      }),
      testPersistence(dir),
    )
    expect(listed).toEqual([skill])
    expect(root).toBe(join(dir, "skills-lib", "skills", "triage"))
    expect(JSON.parse(await readFile(join(dir, "skills-lib", ".claude-plugin", "plugin.json"), "utf8"))).toEqual(
      pluginManifest,
    )
    const text = await readFile(join(dir, "skills-lib", "skills", "triage", "SKILL.md"), "utf8")
    expect(
      text.startsWith('---\nname: triage\ndescription: "Use when triaging GitHub issues: label, dedupe, assign"\n'),
    ).toBe(true)
  })
})

describe("SkillStore invocation settings", () => {
  test("reads disable-model-invocation and argument-hint; saving writes the flag as given", async () => {
    const dir = await tempDataDir()
    const file = join(dir, "skills-lib", "skills", "grill-me", "SKILL.md")
    await mkdir(join(dir, "skills-lib", "skills", "grill-me"), { recursive: true })
    // as skills.sh writes it: the flag quoted, a hint, an unrelated key
    await writeFile(
      file,
      '---\nname: grill-me\ndescription: An interview.\ndisable-model-invocation: "true"\nargument-hint: <topic>\nallowed-tools: Read\n---\n\nBody.\n',
    )
    const name = "grill-me" as SkillName
    const save = (flag: boolean | undefined) =>
      Effect.gen(function* () {
        const store = yield* SkillStore
        yield* store.put({
          name,
          description: "An interview.",
          body: "Body.",
          updatedAt: 1 as Millis,
          ...(flag === undefined ? {} : { disableModelInvocation: flag }),
        })
        return Option.getOrThrow(yield* store.get(name))
      })
    const states = await run(
      Effect.gen(function* () {
        const read = Option.getOrThrow(yield* Effect.flatMap(SkillStore, (store) => store.get(name)))
        const set = yield* save(true)
        const cleared = yield* save(undefined)
        return { read, set, cleared }
      }),
      testPersistence(dir),
    )
    expect(states.read).toMatchObject({ disableModelInvocation: true, argumentHint: "<topic>" })
    expect(states.set).toMatchObject({ disableModelInvocation: true, argumentHint: "<topic>" })
    expect(states.cleared.disableModelInvocation).toBeUndefined()
    expect(states.cleared.argumentHint).toBe("<topic>")
    // the file keeps the keys this app doesn't manage
    expect(await readFile(file, "utf8")).toContain("allowed-tools: Read")
  })

  test("disable-model-invocation is on for the values Claude takes as true, in any case", async () => {
    const dir = await tempDataDir()
    const values = ["true", "True", "YES", "on", "1", "'yes'", "false", "no", "off", "0", "maybe"]
    for (const [i, value] of values.entries()) {
      await mkdir(join(dir, "skills-lib", "skills", `s${i}`), { recursive: true })
      await writeFile(
        join(dir, "skills-lib", "skills", `s${i}`, "SKILL.md"),
        `---\nname: s${i}\ndescription: x\ndisable-model-invocation: ${value}\n---\n\nBody.\n`,
      )
    }
    const read = await run(
      Effect.flatMap(SkillStore, (store) =>
        Effect.forEach(values.keys(), (i) => store.get(`s${i}` as SkillName).pipe(Effect.map(Option.getOrThrow))),
      ),
      testPersistence(dir),
    )
    expect(read.map((skill) => skill.disableModelInvocation === true)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
    ])
  })
})

describe("SkillStore imports (skills.sh)", () => {
  test("a description continued on indented lines (plain multi-line YAML) is read as one line", async () => {
    const dir = await tempDataDir()
    const given = [
      "---",
      "name: vercel-composition-patterns",
      "description:",
      "  React composition patterns that scale. Use when refactoring components with",
      "  boolean prop proliferation.",
      "license: MIT",
      "allowed-tools:",
      "  - Read",
      "metadata:",
      "  author: vercel",
      "---",
      "# React Composition Patterns",
      "",
    ].join("\n")
    const parsed = await run(
      Effect.map(SkillStore, (store) => store.parse(given)),
      testPersistence(dir),
    )
    expect(parsed).toEqual({
      name: "vercel-composition-patterns",
      description:
        "React composition patterns that scale. Use when refactoring components with boolean prop proliferation.",
      body: "# React Composition Patterns\n",
    })
    // lists and maps keep their shape
    const front = parseFrontmatter(given)
    expect(front.fields.get("allowed-tools")).toEqual({ kind: "raw", lines: ["  - Read"] })
    expect(front.fields.get("metadata")).toMatchObject({ kind: "map" })
  })

  test("install replaces the folder, keeps extra files and frontmatter keys, records the source; put keeps both", async () => {
    const dir = await tempDataDir()
    const given = [
      "---",
      "name: Release Notes",
      "description: >",
      "  Use when writing",
      "  release notes.",
      "license: MIT",
      "---",
      "# Notes",
      "",
    ].join("\n")
    const out = await run(
      Effect.gen(function* () {
        const store = yield* SkillStore
        const parsed = store.parse(given)
        const skill = {
          name: "release-notes" as SkillName,
          description: parsed.description ?? "",
          body: parsed.body,
          updatedAt: 7 as Millis,
          source: { kind: "skills.sh" as const, id: "acme/skills/release-notes", hash: "h1" },
        }
        yield* store.put({ ...skill, source: undefined } as never) // a stale same-named skill
        yield* store.install(skill, [
          { path: "SKILL.md", contents: given },
          { path: "scripts/collect.sh", contents: "git log\n" },
        ])
        const installed = Option.getOrThrow(yield* store.get(skill.name))
        yield* store.put({ name: skill.name, description: "Edited.", body: "v2", updatedAt: 8 as Millis })
        return {
          parsed,
          installed,
          edited: Option.getOrThrow(yield* store.get(skill.name)),
          dir: yield* store.dir(skill.name),
        }
      }),
      testPersistence(dir),
    )
    expect(out.parsed).toEqual({
      name: "Release Notes",
      description: "Use when writing release notes.",
      body: "# Notes\n",
    })
    expect(out.installed).toMatchObject({
      name: "release-notes",
      description: "Use when writing release notes.",
      source: { kind: "skills.sh", id: "acme/skills/release-notes", hash: "h1" },
      files: ["scripts/collect.sh"],
    })
    expect(out.edited).toMatchObject({
      description: "Edited.",
      body: "v2",
      source: { id: "acme/skills/release-notes" },
      files: ["scripts/collect.sh"],
    })
    expect(out.dir).toBe(join(dir, "skills-lib", "skills", "release-notes"))
    const text = await readFile(join(out.dir, "SKILL.md"), "utf8")
    expect(text).toContain("license: MIT")
    expect(text).toContain("  source: skills.sh:acme/skills/release-notes\n")
    expect(await readFile(join(out.dir, "scripts", "collect.sh"), "utf8")).toBe("git log\n")
  })
})

describe("AttachmentStore files", () => {
  test("stores bytes at <data>/attachments/<id>", async () => {
    const dir = await tempDataDir()
    const record = await run(
      Effect.flatMap(AttachmentStore, (store) =>
        store.put({ name: "a.png", mime: "image/png", bytes: new Uint8Array([1, 2, 3]) }),
      ),
      testPersistence(dir),
    )
    expect(record.path).toBe(join(dir, "attachments", record.id))
    expect([...(await readFile(record.path))]).toEqual([1, 2, 3])
    // Metadata survives a reopen.
    const again = await run(
      Effect.flatMap(AttachmentStore, (store) => store.get(record.id)),
      testPersistence(dir),
    )
    expect(Option.getOrThrow(again)).toEqual(record)
    await run(
      Effect.flatMap(AttachmentStore, (store) => store.delete(record.id)),
      testPersistence(dir),
    )
    expect(existsSync(record.path)).toBe(false)
  })

  test("putStream writes chunks as they arrive; a failed stream leaves nothing behind", async () => {
    const dir = await tempDataDir()
    const chunks = Array.from({ length: 5 }, (_, i) => new Uint8Array(300_000).fill(i + 1))
    const record = await run(
      Effect.flatMap(AttachmentStore, (store) =>
        store.putStream({
          name: "clip.mp4",
          mime: "video/mp4",
          chunks: Stream.fromIterable(chunks),
          width: 1920,
          height: 1080,
        }),
      ),
      testPersistence(dir),
    )
    expect(record).toMatchObject({
      name: "clip.mp4",
      mime: "video/mp4",
      byteSize: 1_500_000,
      width: 1920,
      height: 1080,
    })
    const bytes = await readFile(record.path)
    expect(bytes.byteLength).toBe(1_500_000)
    expect(bytes[0]).toBe(1)
    expect(bytes[1_499_999]).toBe(5)
    const again = await run(
      Effect.flatMap(AttachmentStore, (store) => store.get(record.id)),
      testPersistence(dir),
    )
    expect(Option.getOrThrow(again)).toEqual(record)

    class Broken extends Schema.TaggedError<Broken>()("Broken", {}) {}
    const failed = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.flatMap(AttachmentStore, (store) =>
          store.putStream({
            name: "x.bin",
            mime: "application/octet-stream",
            chunks: Stream.concat(Stream.fromIterable(chunks), Stream.fail(new Broken())),
          }),
        ).pipe(inProfile(MAIN_PROFILE_ID), Effect.provide(testPersistence(dir))),
      ),
    )
    expect(Exit.isFailure(failed)).toBe(true)
    expect((await readdir(join(dir, "attachments"))).sort()).toEqual([record.id])
  })
})

describe("frontmatter", () => {
  test("round-trips scalars, nested maps and raw blocks", () => {
    const text =
      '---\nname: x\nallowed-tools:\n  - Read\n  - Grep\nmetadata:\n  a: "1"\n---\n\nbody\n---\nnot a fence\n'
    const parsed = parseFrontmatter(text)
    expect(parsed.body).toBe("body\n---\nnot a fence\n")
    expect(parsed.fields.get("allowed-tools")).toEqual({ kind: "raw", lines: ["  - Read", "  - Grep"] })
    expect(renderFrontmatter(parsed)).toBe(
      '---\nname: x\nallowed-tools:\n  - Read\n  - Grep\nmetadata:\n  a: "1"\n---\n\nbody\n---\nnot a fence\n',
    )
  })

  test("text without a fence is all body", () => {
    expect(parseFrontmatter("# hi\n").body).toBe("# hi\n")
    expect(parseFrontmatter("---\nunterminated").body).toBe("---\nunterminated")
  })
})

describe("CarryoverStore (carryover.json)", () => {
  test("saves add up, take reads and clears, an unreadable file is ignored", async () => {
    const dir = await tempDataDir()
    const cut = (n: number) => ({
      botId: `bot_${n}` as BotId,
      conversationId: `cnv_${n}` as ConversationId,
      turnId: `trn_${n}` as TurnId,
    })
    const out = await run(
      Effect.gen(function* () {
        const store = yield* CarryoverStore
        yield* store.save({ deliveries: [], cutOff: [cut(1)] })
        yield* store.save({ deliveries: [], cutOff: [cut(2)] })
        const onDisk = existsSync(join(dir, "carryover.json"))
        const first = yield* store.take
        const second = yield* store.take
        yield* Effect.promise(() => writeFile(join(dir, "carryover.json"), "{not json"))
        const unreadable = yield* store.take
        return { onDisk, first, second, unreadable, left: existsSync(join(dir, "carryover.json")) }
      }),
      testPersistence(dir),
    )
    expect(out.onDisk).toBe(true)
    expect(out.first).toEqual({ deliveries: [], cutOff: [cut(1), cut(2)] })
    expect(out.second).toEqual({ deliveries: [], cutOff: [] })
    expect(out.unreadable).toEqual({ deliveries: [], cutOff: [] })
    expect(out.left).toBe(false)
  })

  test("concurrent saves all land", async () => {
    const dir = await tempDataDir()
    const cut = (n: number) => ({
      botId: `bot_${n}` as BotId,
      conversationId: `cnv_${n}` as ConversationId,
      turnId: `trn_${n}` as TurnId,
    })
    const taken = await run(
      Effect.gen(function* () {
        const store = yield* CarryoverStore
        yield* Effect.forEach([1, 2, 3, 4, 5, 6, 7, 8], (n) => store.save({ deliveries: [], cutOff: [cut(n)] }), {
          concurrency: "unbounded",
        })
        return yield* store.take
      }),
      testPersistence(dir),
    )
    expect(taken.cutOff).toHaveLength(8)
  })
})

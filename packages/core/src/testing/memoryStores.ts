/**
 * In-memory doubles of the file stores (`MemoryStore`, `SkillStore`, `AttachmentStore`).
 */
import type { AttachmentId, BotId, MemoryFact, MemoryFactId, Skill, SkillName } from "@openbot/contracts"
import { Clock, Effect, Layer, Option, Stream } from "effect"
import { joinPath } from "../ports/DataDir.ts"
import { RepoError } from "../ports/errors.ts"
import { IdGen } from "../ports/IdGen.ts"
import {
  type AttachmentRecord,
  AttachmentStore,
  CarryoverStore,
  EMPTY_CARRYOVER,
  MemoryStore,
  mergeCarryover,
  type ParsedSkillFile,
  SkillStore,
} from "../ports/stores.ts"

const byKey =
  <A>(key: (a: A) => string) =>
  (a: A, b: A) => {
    const x = key(a)
    const y = key(b)
    return x < y ? -1 : x > y ? 1 : 0
  }

export const makeMemoryMemoryStore = () =>
  Effect.sync(() => {
    const indexes = new Map<BotId, string>()
    const facts = new Map<BotId, Map<MemoryFactId, MemoryFact>>()
    const factsOf = (botId: BotId) => {
      let map = facts.get(botId)
      if (map === undefined) {
        map = new Map()
        facts.set(botId, map)
      }
      return map
    }
    return MemoryStore.of({
      readIndex: (botId) => Effect.sync(() => indexes.get(botId) ?? ""),
      writeIndex: (botId, index) => Effect.sync(() => void indexes.set(botId, index)),
      listFacts: (botId) => Effect.sync(() => [...factsOf(botId).values()].sort(byKey((f) => f.id))),
      getFact: (botId, factId) => Effect.sync(() => Option.fromNullishOr(factsOf(botId).get(factId))),
      putFact: (botId, fact) => Effect.sync(() => void factsOf(botId).set(fact.id, fact)),
      deleteFact: (botId, factId) => Effect.sync(() => factsOf(botId).delete(factId)),
      deleteAll: (botId) =>
        Effect.sync(() => {
          indexes.delete(botId)
          facts.delete(botId)
        }),
    })
  })

/** A SKILL.md read with one-line `name:` / `description:` fields (enough for test fixtures). */
const parseSkillFile = (text: string): ParsedSkillFile => {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (match === null) return { body: text }
  const field = (key: string) =>
    new RegExp(`^${key}:\\s*(.*)$`, "m")
      .exec(match[1]!)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, "")
  return { name: field("name"), description: field("description"), body: match[2]! }
}

export const makeMemorySkillStore = (root = "/openbot-test/skills-lib") =>
  Effect.sync(() => {
    const skills = new Map<SkillName, Skill>()
    return SkillStore.of({
      list: Effect.sync(() => [...skills.values()].sort(byKey((s) => s.name))),
      get: (name) => Effect.sync(() => Option.fromNullishOr(skills.get(name))),
      // like the file store: an existing skill keeps its source and other files
      put: (skill) =>
        Effect.sync(() => {
          const existing = skills.get(skill.name)
          // `disableModelInvocation` absent keeps the file's own setting; false removes it
          const ownerOnly = skill.disableModelInvocation ?? existing?.disableModelInvocation
          const { disableModelInvocation: _given, ...rest } = skill
          skills.set(skill.name, {
            ...rest,
            ...(ownerOnly === true ? { disableModelInvocation: true } : {}),
            ...(existing?.source === undefined ? {} : { source: existing.source }),
            ...(existing?.files === undefined ? {} : { files: existing.files }),
          })
        }),
      install: (skill, files) =>
        Effect.sync(() => {
          const others = files
            .map((file) => file.path)
            .filter((path) => path !== "SKILL.md")
            .sort()
          skills.set(skill.name, { ...skill, ...(others.length === 0 ? {} : { files: others }) })
        }),
      parse: parseSkillFile,
      delete: (name) => Effect.sync(() => skills.delete(name)),
      root,
      dir: (name) => joinPath(root, "skills", name),
    })
  })

/** Requires `IdGen` for attachment ids; paths are virtual (`<root>/<id>`). */
export const makeMemoryAttachmentStore = (root = "/openbot-test/attachments") =>
  Effect.gen(function* () {
    const ids = yield* IdGen
    const records = new Map<AttachmentId, AttachmentRecord>()
    const bytes = new Map<AttachmentId, Uint8Array>()
    return AttachmentStore.of({
      put: (input) =>
        Effect.gen(function* () {
          const id = yield* ids.attachmentId
          const createdAt = yield* Clock.currentTimeMillis
          const record: AttachmentRecord = {
            id,
            name: input.name,
            mime: input.mime,
            byteSize: input.bytes.byteLength,
            path: joinPath(root, id),
            createdAt,
          }
          records.set(id, record)
          bytes.set(id, input.bytes.slice())
          return record
        }),
      putStream: (input) =>
        Effect.gen(function* () {
          const parts = yield* Stream.runCollect(input.chunks)
          const size = parts.reduce((n, part) => n + part.byteLength, 0)
          const data = new Uint8Array(size)
          let at = 0
          for (const part of parts) {
            data.set(part, at)
            at += part.byteLength
          }
          const id = yield* ids.attachmentId
          const createdAt = yield* Clock.currentTimeMillis
          const record: AttachmentRecord = {
            id,
            name: input.name,
            mime: input.mime,
            byteSize: size,
            path: joinPath(root, id),
            createdAt,
            ...(input.width === undefined ? {} : { width: input.width }),
            ...(input.height === undefined ? {} : { height: input.height }),
          }
          records.set(id, record)
          bytes.set(id, data)
          return record
        }),
      get: (id) => Effect.sync(() => Option.fromNullishOr(records.get(id))),
      read: (id) =>
        Effect.sync(() => {
          const data = bytes.get(id)
          return data === undefined ? Option.none() : Option.some(data.slice())
        }),
      stream: (id) =>
        Stream.unwrap(
          Effect.suspend(() => {
            const data = bytes.get(id)
            if (data === undefined)
              return Effect.fail(new RepoError({ op: "AttachmentStore.stream", message: `No attachment ${id}` }))
            const slices: Array<Uint8Array> = []
            for (let at = 0; at < data.byteLength; at += 65_536) slices.push(data.slice(at, at + 65_536))
            return Effect.succeed(Stream.fromIterable(slices))
          }),
        ),
      delete: (id) =>
        Effect.sync(() => {
          bytes.delete(id)
          return records.delete(id)
        }),
    })
  })

export const MemoryMemoryStore = Layer.effect(MemoryStore, makeMemoryMemoryStore())
export const MemorySkillStore = (root?: string) => Layer.effect(SkillStore, makeMemorySkillStore(root))
export const MemoryAttachmentStore = (root?: string): Layer.Layer<AttachmentStore, never, IdGen> =>
  Layer.effect(AttachmentStore, makeMemoryAttachmentStore(root))

/** `CarryoverStore` in memory. */
export const MemoryCarryoverStore = Layer.sync(CarryoverStore, () => {
  let saved = EMPTY_CARRYOVER
  return CarryoverStore.of({
    save: (carryover) => Effect.sync(() => void (saved = mergeCarryover(saved, carryover))),
    take: Effect.sync(() => {
      const taken = saved
      saved = EMPTY_CARRYOVER
      return taken
    }),
  })
})

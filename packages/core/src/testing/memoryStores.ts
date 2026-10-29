/**
 * In-memory doubles of the file stores (`MemoryStore`, `SkillStore`, `AttachmentStore`).
 */
import type {
  AttachmentId,
  BotId,
  MemoryFact,
  MemoryFactId,
  OwnerProfileId,
  Skill,
  SkillName,
} from "@openbot/contracts"
import { InvalidInput, MAIN_PROFILE_ID } from "@openbot/contracts"
import { Clock, Effect, Layer, Option, Stream } from "effect"
import { joinPath, makeDataDir } from "../ports/DataDir.ts"
import { RepoError } from "../ports/errors.ts"
import { IdGen } from "../ports/IdGen.ts"
import { ProfileDirs } from "../ports/ProfileDirs.ts"
import { currentProfileId } from "../ports/Profiles.ts"
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

export const makeMemorySkillStore = (dataRoot = "/openbot-test") =>
  Effect.sync(() => {
    const dirs = makeDataDir(dataRoot)
    const libraries = new Map<OwnerProfileId, Map<SkillName, Skill>>()
    const library = Effect.map(currentProfileId, (id) => {
      const found = libraries.get(id)
      if (found !== undefined) return found
      const created = new Map<SkillName, Skill>()
      libraries.set(id, created)
      return created
    })
    return SkillStore.of({
      list: Effect.map(library, (skills) => [...skills.values()].sort(byKey((s) => s.name))),
      get: (name) => Effect.map(library, (skills) => Option.fromNullishOr(skills.get(name))),
      // like the file store: an existing skill keeps its source and other files
      put: (skill) =>
        Effect.map(library, (skills) => {
          const existing = skills.get(skill.name)
          skills.set(skill.name, {
            ...skill,
            ...(existing?.source === undefined ? {} : { source: existing.source }),
            ...(existing?.files === undefined ? {} : { files: existing.files }),
          })
        }),
      install: (skill, files) =>
        Effect.map(library, (skills) => {
          const others = files
            .map((file) => file.path)
            .filter((path) => path !== "SKILL.md")
            .sort()
          skills.set(skill.name, { ...skill, ...(others.length === 0 ? {} : { files: others }) })
        }),
      parse: parseSkillFile,
      delete: (name) => Effect.map(library, (skills) => skills.delete(name)),
      dir: (name) => Effect.map(currentProfileId, (id) => joinPath(dirs.profile(id).skillsLib, "skills", name)),
      forget: (id) => Effect.sync(() => void libraries.delete(id)),
    })
  })

/** Requires `IdGen` for attachment ids; paths are virtual (`<profile attachments>/<id>`). */
export const makeMemoryAttachmentStore = (dataRoot = "/openbot-test") =>
  Effect.gen(function* () {
    const dirs = makeDataDir(dataRoot)
    const ids = yield* IdGen
    const records = new Map<AttachmentId, AttachmentRecord>()
    const bytes = new Map<AttachmentId, Uint8Array>()
    return AttachmentStore.of({
      put: (input) =>
        Effect.gen(function* () {
          const id = yield* ids.attachmentId
          const createdAt = yield* Clock.currentTimeMillis
          const profileId = yield* currentProfileId
          const record: AttachmentRecord = {
            id,
            ownerProfileId: profileId,
            name: input.name,
            mime: input.mime,
            byteSize: input.bytes.byteLength,
            path: joinPath(dirs.profile(profileId).attachments, id),
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
          const profileId = yield* currentProfileId
          const record: AttachmentRecord = {
            id,
            ownerProfileId: profileId,
            name: input.name,
            mime: input.mime,
            byteSize: size,
            path: joinPath(dirs.profile(profileId).attachments, id),
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
export const MemorySkillStore = (dataRoot?: string) => Layer.effect(SkillStore, makeMemorySkillStore(dataRoot))
export const MemoryAttachmentStore = (dataRoot?: string): Layer.Layer<AttachmentStore, never, IdGen> =>
  Layer.effect(AttachmentStore, makeMemoryAttachmentStore(dataRoot))

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

/** Records which profiles got their folders and which were moved aside. */
export const makeMemoryProfileDirs = () => {
  const ensured = new Set<OwnerProfileId>()
  const retired = new Set<OwnerProfileId>()
  return {
    ensured,
    retired,
    dirs: ProfileDirs.of({
      ensure: (id) => Effect.sync(() => void ensured.add(id)),
      retire: (id) =>
        id === MAIN_PROFILE_ID
          ? Effect.fail(new InvalidInput({ message: "The main profile's files stay where they are." }))
          : Effect.sync(() => void retired.add(id)),
    }),
  }
}
export const MemoryProfileDirs = Layer.sync(ProfileDirs, () => makeMemoryProfileDirs().dirs)

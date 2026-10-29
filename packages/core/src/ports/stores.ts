/**
 * File-backed stores (architecture §3.2, D5.4, D5.5). Implemented by `@openbot/persistence` with
 * atomic writes under `DataDir`; in-memory doubles live in `@openbot/core/testing`.
 */
import type { BotId, MemoryFact, MemoryFactId, Skill, SkillName } from "@openbot/contracts"
import { AttachmentId, Millis, OwnerProfileId } from "@openbot/contracts"
import { Context, Effect, Option, Schema, type Stream } from "effect"
import type { RepoError } from "./errors.ts"
import type { CurrentProfile } from "./Profiles.ts"
import type { Carryover } from "./services.ts"

/**
 * Per-bot memory in Claude auto-memory format: `<data>/bots/<id>/memory/MEMORY.md` (the index)
 * plus one markdown file per fact (`<factId>.md`). Claude reads/writes the directory natively, so
 * implementations must tolerate files they did not write.
 */
export class MemoryStore extends Context.Service<
  MemoryStore,
  {
    /** `MEMORY.md` contents; "" when absent. */
    readonly readIndex: (botId: BotId) => Effect.Effect<string, RepoError>
    readonly writeIndex: (botId: BotId, index: string) => Effect.Effect<void, RepoError>
    /** Every fact file, ordered by id. */
    readonly listFacts: (botId: BotId) => Effect.Effect<ReadonlyArray<MemoryFact>, RepoError>
    readonly getFact: (botId: BotId, factId: MemoryFactId) => Effect.Effect<Option.Option<MemoryFact>, RepoError>
    /** Insert or replace by `fact.id`. Does NOT touch the index (MemoryService maintains it). */
    readonly putFact: (botId: BotId, fact: MemoryFact) => Effect.Effect<void, RepoError>
    readonly deleteFact: (botId: BotId, factId: MemoryFactId) => Effect.Effect<boolean, RepoError>
    /** Removes the bot's whole memory directory (bot deleted). */
    readonly deleteAll: (botId: BotId) => Effect.Effect<void, RepoError>
  }
>()("openbot/core/MemoryStore") {}

/** One file of a skill's folder, path relative to it (`SKILL.md`, `scripts/run.sh`). */
export interface SkillFile {
  readonly path: string
  readonly contents: string
}

/** The parts of a SKILL.md OpenBot reads (frontmatter `name` / `description`, the body). */
export interface ParsedSkillFile {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly body: string
}

/**
 * The current profile's skills library at `DataDir.profile(id).skillsLib` in Claude plugin layout
 * (`.claude-plugin/plugin.json` + `skills/<name>/SKILL.md`). v1 has no per-bot subsets.
 */
export class SkillStore extends Context.Service<
  SkillStore,
  {
    /** Ordered by name. Each skill lists its other files (`files`) and its `source` when imported. */
    readonly list: Effect.Effect<ReadonlyArray<Skill>, RepoError, CurrentProfile>
    readonly get: (name: SkillName) => Effect.Effect<Option.Option<Skill>, RepoError, CurrentProfile>
    /**
     * Insert or replace the SKILL.md of `skill.name` (other files and unknown frontmatter are kept;
     * `skill.source` is recorded when given, `disable-model-invocation` written as given); keeps
     * `plugin.json` present.
     */
    readonly put: (skill: Skill) => Effect.Effect<void, RepoError, CurrentProfile>
    /**
     * Replaces the skill's whole folder with `files` (an imported skill). Its SKILL.md is the given
     * one's frontmatter (unknown keys kept) with `skill`'s name, description, body and source.
     * Paths are already validated (relative, inside the folder).
     */
    readonly install: (skill: Skill, files: ReadonlyArray<SkillFile>) => Effect.Effect<void, RepoError, CurrentProfile>
    /** Reads a SKILL.md (imported skills) the way the library does. */
    readonly parse: (text: string) => ParsedSkillFile
    readonly delete: (name: SkillName) => Effect.Effect<boolean, RepoError, CurrentProfile>
    /** Absolute folder of one skill, `<library>/skills/<name>`. */
    readonly dir: (name: SkillName) => Effect.Effect<string, never, CurrentProfile>
    /** Drops a deleted profile's library; from then on its reads and writes fail. */
    readonly forget: (profileId: OwnerProfileId) => Effect.Effect<void>
  }
>()("openbot/core/SkillStore") {}

export const AttachmentRecord = Schema.Struct({
  id: AttachmentId,
  /** The owner's profile it was stored in. */
  ownerProfileId: OwnerProfileId,
  name: Schema.String,
  mime: Schema.String,
  byteSize: Schema.Number,
  /** Absolute path on the brain (`<attachments>/<id>`), handed to harnesses as `TurnAttachment.path`. */
  path: Schema.String,
  createdAt: Millis,
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
})
export type AttachmentRecord = typeof AttachmentRecord.Type

export interface AttachmentInput {
  readonly name: string
  readonly mime: string
  readonly bytes: Uint8Array
}

/** A streamed attachment (bot-sent files of up to hundreds of MB): bytes arrive in chunks. */
export interface AttachmentStreamInput<E> {
  readonly name: string
  readonly mime: string
  readonly chunks: Stream.Stream<Uint8Array, E>
  /** Image dimensions when known (sniffed from the file header). */
  readonly width?: number | undefined
  readonly height?: number | undefined
}

/**
 * Uploaded files at `<attachments>/<id>` plus their metadata. New files go to the current profile's
 * folder (`DataDir.profile(id).attachments`); a stored one is found by its id wherever it is.
 */
export class AttachmentStore extends Context.Service<
  AttachmentStore,
  {
    /** Allocates an id, writes the bytes and the metadata. */
    readonly put: (input: AttachmentInput) => Effect.Effect<AttachmentRecord, RepoError, CurrentProfile>
    /**
     * Like `put`, writing the chunks as they arrive (never the whole file in memory). Nothing is
     * stored when the stream fails (its error is passed through) or the effect is interrupted.
     */
    readonly putStream: <E>(
      input: AttachmentStreamInput<E>,
    ) => Effect.Effect<AttachmentRecord, RepoError | E, CurrentProfile>
    readonly get: (id: AttachmentId) => Effect.Effect<Option.Option<AttachmentRecord>, RepoError>
    readonly read: (id: AttachmentId) => Effect.Effect<Option.Option<Uint8Array>, RepoError>
    /** The bytes as a stream (never the whole file in memory); fails with `RepoError` when missing. */
    readonly stream: (id: AttachmentId) => Stream.Stream<Uint8Array, RepoError>
    readonly delete: (id: AttachmentId) => Effect.Effect<boolean, RepoError>
  }
>()("openbot/core/AttachmentStore") {}

/**
 * What a stopping brain hands to the next boot (`Orchestrator.handOff` / `resume`):
 * `<data>/carryover.json`.
 */
export class CarryoverStore extends Context.Service<
  CarryoverStore,
  {
    /** Adds to what is saved (a boot that never got to `take` keeps its part). */
    readonly save: (carryover: Carryover) => Effect.Effect<void, RepoError>
    /** What is saved, cleared on read (empty when nothing is). */
    readonly take: Effect.Effect<Carryover, RepoError>
  }
>()("openbot/core/CarryoverStore") {}

export const EMPTY_CARRYOVER: Carryover = { deliveries: [], cutOff: [] }

export const mergeCarryover = (a: Carryover, b: Carryover): Carryover => ({
  deliveries: [...a.deliveries, ...b.deliveries],
  cutOff: [...a.cutOff, ...b.cutOff],
})

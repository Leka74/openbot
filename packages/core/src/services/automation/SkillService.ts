/**
 * SkillService (D5.5, architecture §4.3): the skills library over `SkillStore`
 * (`<data>/skills-lib/skills/<name>/SKILL.md`) and which Bots have which skill (`Bot.skills`, set
 * through BotService so the roster and the Bots' sessions follow).
 *
 * - A Bot saving a skill (`save_skill`) gets it, and a `skill-saved` event lands in the conversation
 *   it works in. It may replace only a skill it has: someone else's skill keeps its author's text.
 * - Deleting a skill removes it from every Bot.
 * - skills.sh import (`SkillDirectory`): search, preview (download + read, nothing written), install
 *   (the whole folder, paths and sizes checked, recorded with its source).
 */
import type { Bot, BotId, Skill, SkillInput, SkillName, SkillPreview } from "@openbot/contracts"
import { InvalidInput, NotFound, SkillName as SkillNameSchema } from "@openbot/contracts"
import { Clock, Effect, Layer, Option, Schema } from "effect"
import { BotRepo } from "../../ports/repos.ts"
import { type Actor, BotService, ConversationService, SkillService } from "../../ports/services.ts"
import { SkillDirectory } from "../../ports/SkillDirectory.ts"
import { type SkillFile, SkillStore } from "../../ports/stores.ts"
import { utf8Length } from "./text.ts"

export const SKILL_LIMITS = {
  descriptionChars: 1024,
  bodyBytes: 256 * 1024,
  /** An imported skill's folder. */
  importFiles: 200,
  importBytes: 5 * 1024 * 1024,
} as const

const isSkillName = Schema.is(SkillNameSchema)

/** A skills.sh id: `owner/repo/skill`. */
const SKILLS_SH_ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:-]+$/

/** The library name of an imported skill: its frontmatter name, else its skills.sh skill id, as a slug. */
export const importedSkillName = (frontmatterName: string | undefined, skillId: string): SkillName | undefined => {
  for (const raw of [frontmatterName, skillId]) {
    if (raw === undefined) continue
    const slug = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[-_]+|-+$/g, "")
      .slice(0, 64)
    if (isSkillName(slug)) return slug
  }
  return undefined
}

/** A path inside a skill's folder: relative, without `.`/`..` segments or backslashes; else undefined. */
export const safeSkillPath = (path: string): string | undefined => {
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return undefined
  const parts = path.replace(/^(\.\/)+/, "").split("/")
  if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined
  return parts.join("/")
}

export const makeSkillService = Effect.gen(function* () {
  const store = yield* SkillStore
  const conversations = yield* ConversationService
  const botService = yield* BotService
  const bots = yield* BotRepo
  const directory = yield* SkillDirectory

  const validate = (input: SkillInput) => {
    if (!isSkillName(input.name)) {
      return Effect.fail(
        new InvalidInput({
          message: `Invalid skill name "${input.name}" (use a lower-case slug like "weekly-report").`,
        }),
      )
    }
    const description = input.description.trim()
    if (description.length === 0) {
      return Effect.fail(new InvalidInput({ message: "A skill needs a description of when to use it." }))
    }
    if ([...description].length > SKILL_LIMITS.descriptionChars) {
      return Effect.fail(
        new InvalidInput({ message: `The description is too long (max ${SKILL_LIMITS.descriptionChars} characters).` }),
      )
    }
    if (input.body.trim().length === 0)
      return Effect.fail(new InvalidInput({ message: "A skill needs instructions (body)." }))
    if (utf8Length(input.body) > SKILL_LIMITS.bodyBytes) {
      return Effect.fail(
        new InvalidInput({ message: `The skill is too long (max ${SKILL_LIMITS.bodyBytes / 1024} KB).` }),
      )
    }
    return Effect.succeed(description)
  }

  const get = (name: SkillName) =>
    store.get(name).pipe(
      Effect.orDie,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new NotFound({ entity: "skill", id: name })),
          onSome: Effect.succeed,
        }),
      ),
    )

  /** Replaces a Bot's skills (BotService publishes it; the Bot's next turn reopens its session). */
  const setSkills = (bot: Bot, skills: ReadonlyArray<SkillName>) =>
    botService.update(bot.id, { skills: [...skills] }).pipe(
      Effect.asVoid,
      Effect.catchTag("Conflict", (error) => Effect.die(error)),
    )

  const allBots = Effect.orDie(bots.list)

  const upsert = (actor: Actor, input: SkillInput) =>
    Effect.gen(function* () {
      const description = yield* validate(input)
      const existing = yield* store.get(input.name).pipe(Effect.orDie)
      let author: Bot | undefined
      if (actor.kind === "bot") {
        author = Option.getOrUndefined(yield* Effect.orDie(bots.get(actor.tool.claims.botId)))
        if (Option.isSome(existing) && author?.skills.includes(input.name) !== true) {
          return yield* new InvalidInput({
            message: `A skill named "${input.name}" already exists and is not one of yours. Save yours under another name, or ask for that one with enable_skill.`,
          })
        }
      }
      // the store keeps an imported skill's source (frontmatter metadata) and its other files
      yield* store
        .put({
          name: input.name,
          description,
          body: input.body,
          updatedAt: yield* Clock.currentTimeMillis,
          ...(input.disableModelInvocation === undefined
            ? {}
            : { disableModelInvocation: input.disableModelInvocation }),
        })
        .pipe(Effect.orDie)
      if (author !== undefined && actor.kind === "bot") {
        if (!author.skills.includes(input.name))
          yield* setSkills(author, [...author.skills, input.name]).pipe(Effect.orDie)
        yield* conversations
          .appendEvent({
            conversationId: actor.tool.claims.conversationId,
            author: { kind: "bot", botId: actor.tool.claims.botId },
            event: { type: "skill-saved", name: input.name },
          })
          .pipe(
            Effect.asVoid,
            Effect.catch((error) => Effect.logWarning("SkillService: skill-saved event not written", error)),
          )
      }
      return yield* get(input.name).pipe(Effect.orDie)
    })

  const remove = (name: SkillName) =>
    Effect.gen(function* () {
      const deleted = yield* store.delete(name).pipe(Effect.orDie)
      if (!deleted) return yield* new NotFound({ entity: "skill", id: name })
      for (const bot of yield* allBots) {
        if (bot.skills.includes(name))
          yield* setSkills(
            bot,
            bot.skills.filter((n) => n !== name),
          ).pipe(Effect.orDie)
      }
    })

  const assign = (name: SkillName, botIds: ReadonlyArray<BotId>) =>
    Effect.gen(function* () {
      yield* get(name)
      const all = yield* allBots
      const wanted = new Set(botIds)
      for (const id of wanted) {
        if (!all.some((bot) => bot.id === id)) return yield* new NotFound({ entity: "bot", id })
      }
      for (const bot of all) {
        const has = bot.skills.includes(name)
        if (wanted.has(bot.id) && !has) yield* setSkills(bot, [...bot.skills, name])
        else if (!wanted.has(bot.id) && has)
          yield* setSkills(
            bot,
            bot.skills.filter((n) => n !== name),
          )
      }
    })

  /** Downloads a skills.sh skill and checks it: safe paths, limits, a SKILL.md with a description. */
  const fetchSkill = (rawId: string) =>
    Effect.gen(function* () {
      const id = rawId.trim()
      if (!SKILLS_SH_ID.test(id)) {
        return yield* new InvalidInput({ message: `"${rawId}" is not a skills.sh skill (expected owner/repo/skill).` })
      }
      const download = yield* directory.download(id)
      if (download.files.length > SKILL_LIMITS.importFiles) {
        return yield* new InvalidInput({ message: `This skill has too many files (max ${SKILL_LIMITS.importFiles}).` })
      }
      const files: Array<SkillFile> = []
      let bytes = 0
      for (const file of download.files) {
        const path = safeSkillPath(file.path)
        if (path === undefined)
          return yield* new InvalidInput({ message: `This skill has a file outside its folder: ${file.path}` })
        bytes += utf8Length(file.contents)
        files.push({ path, contents: file.contents })
      }
      if (bytes > SKILL_LIMITS.importBytes) {
        return yield* new InvalidInput({
          message: `This skill is too big (max ${SKILL_LIMITS.importBytes / 1024 / 1024} MB).`,
        })
      }
      const skillFile = files.find((file) => file.path === "SKILL.md")
      if (skillFile === undefined) return yield* new InvalidInput({ message: "This skill has no SKILL.md." })
      const parsed = store.parse(skillFile.contents)
      const name = importedSkillName(parsed.name, id.split("/")[2] ?? "")
      if (name === undefined)
        return yield* new InvalidInput({ message: `This skill's name cannot be used here: ${parsed.name ?? id}` })
      const description = yield* validate({ name, description: parsed.description ?? "", body: parsed.body })
      return { id, name, description, body: parsed.body, files, hash: download.hash }
    })

  const preview = (id: string) =>
    Effect.gen(function* () {
      const fetched = yield* fetchSkill(id)
      const existing = yield* store.get(fetched.name).pipe(Effect.orDie)
      const result: SkillPreview = {
        id: fetched.id,
        name: fetched.name,
        description: fetched.description,
        body: fetched.body,
        files: fetched.files.map((file) => ({ path: file.path, bytes: utf8Length(file.contents) })),
        replaces: Option.isSome(existing),
      }
      return result
    })

  const install = (id: string, botIds: ReadonlyArray<BotId>) =>
    Effect.gen(function* () {
      const all = yield* allBots
      for (const botId of botIds) {
        if (!all.some((bot) => bot.id === botId)) return yield* new NotFound({ entity: "bot", id: botId })
      }
      const fetched = yield* fetchSkill(id)
      const skill: Skill = {
        name: fetched.name,
        description: fetched.description,
        body: fetched.body,
        updatedAt: yield* Clock.currentTimeMillis,
        source: { kind: "skills.sh", id: fetched.id, ...(fetched.hash === undefined ? {} : { hash: fetched.hash }) },
      }
      yield* store.install(skill, fetched.files).pipe(Effect.orDie)
      for (const bot of all) {
        if (botIds.includes(bot.id) && !bot.skills.includes(skill.name))
          yield* setSkills(bot, [...bot.skills, skill.name])
      }
      return yield* get(skill.name).pipe(Effect.orDie)
    })

  return SkillService.of({
    list: store.list.pipe(Effect.orDie),
    get,
    upsert,
    delete: remove,
    assign,
    search: (query) =>
      query.trim() === ""
        ? Effect.fail(new InvalidInput({ message: "Type something to search for." }))
        : // skills hosted outside GitHub (`site/skill`) cannot be downloaded through skills.sh
          directory.search(query.trim()).pipe(Effect.map((found) => found.filter((hit) => SKILLS_SH_ID.test(hit.id)))),
    preview,
    install,
  })
})

export const SkillServiceLive: Layer.Layer<
  SkillService,
  never,
  SkillStore | ConversationService | BotService | BotRepo | SkillDirectory
> = Layer.effect(SkillService, makeSkillService)

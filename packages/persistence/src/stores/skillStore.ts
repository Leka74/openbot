/**
 * `SkillStore` on disk (D5.5): one library at `<data>/skills-lib` in Claude plugin layout, mounted
 * per harness:
 *
 * ```
 * skills-lib/.claude-plugin/plugin.json
 * skills-lib/skills/<name>/SKILL.md      Agent Skills frontmatter (name, description, metadata.modified) + body
 * skills-lib/skills/<name>/…             other files (scripts, references), e.g. of an imported skill
 * ```
 *
 * The directory name is authoritative for the skill name. Unknown frontmatter keys (for example
 * `allowed-tools`, `disable-model-invocation`) and any other files in a skill directory are kept.
 * An imported skill records where it came from in `metadata.source` (`skills.sh:<owner/repo/skill>`)
 * and `metadata.source-hash`.
 */
import type { Millis, Skill, SkillName, SkillSource } from "@openbot/contracts"
import { type DataDirShape, joinPath, RepoError, SkillStore } from "@openbot/core"
import { Effect, Option } from "effect"
import { listDirectory, modifiedAt, readTextFile, removePath, writeFileAtomic } from "./files.ts"
import {
  formatTimestamp,
  metadataValue,
  parseFrontmatter,
  parseTimestamp,
  renderFrontmatter,
  scalar,
  updateFrontmatter,
} from "./frontmatter.ts"

const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const SKILL_FILE = "SKILL.md"
const SKILLS_SH = "skills.sh:"

const sourceOf = (frontmatter: ReturnType<typeof parseFrontmatter>): SkillSource | undefined => {
  const source = metadataValue(frontmatter, "source")
  if (source === undefined || !source.startsWith(SKILLS_SH)) return undefined
  const hash = metadataValue(frontmatter, "source-hash")
  return { kind: "skills.sh", id: source.slice(SKILLS_SH.length), ...(hash === undefined ? {} : { hash }) }
}

const metadataOf = (skill: Skill): ReadonlyArray<readonly [string, string]> => [
  ["modified", formatTimestamp(skill.updatedAt)],
  ...(skill.source === undefined
    ? []
    : [
        ["source", `${SKILLS_SH}${skill.source.id}`] as const,
        ...(skill.source.hash === undefined ? [] : [["source-hash", skill.source.hash] as const]),
      ]),
]
export const PLUGIN_MANIFEST = joinPath(".claude-plugin", "plugin.json")

export const pluginManifest = {
  name: "openbot-skills",
  description: "Skills library shared by OpenBot bots",
  version: "1.0.0",
}

export const makeFileSkillStore = (dataDir: DataDirShape) =>
  Effect.gen(function* () {
    const root = dataDir.skillsLib
    const skillsDir = joinPath(root, "skills")
    const manifestPath = joinPath(root, PLUGIN_MANIFEST)

    const ensureManifest = (op: string) =>
      Effect.gen(function* () {
        if ((yield* readTextFile(op, manifestPath)) === undefined) {
          yield* writeFileAtomic(op, manifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`)
        }
      })

    const skillFile = (op: string, name: SkillName) =>
      SKILL_NAME.test(name)
        ? Effect.succeed(joinPath(skillsDir, name, SKILL_FILE))
        : Effect.fail(new RepoError({ op, message: `Invalid skill name: ${JSON.stringify(name)}` }))

    /** Relative paths of every file under `dir` (sorted), SKILL.md excepted at the top. */
    const otherFiles = (op: string, dir: string, prefix = ""): Effect.Effect<ReadonlyArray<string>, RepoError> =>
      Effect.gen(function* () {
        const found: Array<string> = []
        for (const entry of yield* listDirectory(op, joinPath(dir, prefix))) {
          const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`
          if (entry.isDirectory) found.push(...(yield* otherFiles(op, dir, path)))
          else if (path !== SKILL_FILE) found.push(path)
        }
        return found.sort()
      })

    const readSkill = (op: string, name: SkillName): Effect.Effect<Option.Option<Skill>, RepoError> =>
      Effect.gen(function* () {
        const path = yield* skillFile(op, name)
        const text = yield* readTextFile(op, path)
        if (text === undefined) return Option.none()
        const frontmatter = parseFrontmatter(text)
        const updatedAt = parseTimestamp(metadataValue(frontmatter, "modified")) ?? (yield* modifiedAt(op, path)) ?? 0
        const source = sourceOf(frontmatter)
        const files = yield* otherFiles(op, joinPath(skillsDir, name))
        const argumentHint = scalar(frontmatter, "argument-hint")?.trim()
        return Option.some<Skill>({
          name,
          description: scalar(frontmatter, "description") ?? "",
          body: frontmatter.body,
          updatedAt: updatedAt as Millis,
          ...(source === undefined ? {} : { source }),
          ...(files.length === 0 ? {} : { files }),
          ...(scalar(frontmatter, "disable-model-invocation") === "true" ? { disableModelInvocation: true } : {}),
          ...(argumentHint === undefined || argumentHint === "" ? {} : { argumentHint }),
        })
      })

    // The library is mounted even when empty, so the manifest exists from the start.
    yield* ensureManifest("SkillStore.init")

    return SkillStore.of({
      root,
      list: Effect.gen(function* () {
        const names = (yield* listDirectory("SkillStore.list", skillsDir))
          .filter((e) => e.isDirectory && SKILL_NAME.test(e.name))
          .map((e) => e.name)
          .sort()
        const skills: Array<Skill> = []
        for (const name of names) {
          const skill = yield* readSkill("SkillStore.list", name as SkillName)
          if (Option.isSome(skill)) skills.push(skill.value)
        }
        return skills
      }),
      get: (name) => (SKILL_NAME.test(name) ? readSkill("SkillStore.get", name) : Effect.succeed(Option.none())),
      put: (skill) =>
        Effect.gen(function* () {
          const path = yield* skillFile("SkillStore.put", skill.name)
          yield* ensureManifest("SkillStore.put")
          const existing = yield* readTextFile("SkillStore.put", path)
          const frontmatter = updateFrontmatter(existing === undefined ? undefined : parseFrontmatter(existing), {
            scalars: [
              ["name", skill.name],
              ["description", skill.description],
              // absent: the file's own setting stays
              ...(skill.disableModelInvocation === undefined
                ? []
                : [["disable-model-invocation", skill.disableModelInvocation ? "true" : undefined] as const]),
            ],
            metadata: metadataOf(skill),
            body: skill.body,
          })
          yield* writeFileAtomic("SkillStore.put", path, renderFrontmatter(frontmatter))
        }),
      install: (skill, files) =>
        Effect.gen(function* () {
          const path = yield* skillFile("SkillStore.install", skill.name)
          yield* ensureManifest("SkillStore.install")
          yield* removePath("SkillStore.install", joinPath(skillsDir, skill.name))
          for (const file of files) {
            if (file.path === SKILL_FILE) continue
            yield* writeFileAtomic("SkillStore.install", joinPath(skillsDir, skill.name, file.path), file.contents)
          }
          const given = files.find((file) => file.path === SKILL_FILE)
          const frontmatter = updateFrontmatter(given === undefined ? undefined : parseFrontmatter(given.contents), {
            scalars: [
              ["name", skill.name],
              ["description", skill.description],
            ],
            metadata: metadataOf(skill),
            body: skill.body,
          })
          yield* writeFileAtomic("SkillStore.install", path, renderFrontmatter(frontmatter))
        }),
      parse: (text) => {
        const frontmatter = parseFrontmatter(text)
        return {
          name: scalar(frontmatter, "name"),
          description: scalar(frontmatter, "description"),
          body: frontmatter.body,
        }
      },
      dir: (name) => joinPath(skillsDir, name),
      delete: (name) =>
        SKILL_NAME.test(name) ? removePath("SkillStore.delete", joinPath(skillsDir, name)) : Effect.succeed(false),
    })
  })

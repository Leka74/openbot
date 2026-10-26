// Skills (D5.5): one library at `<data>/skills-lib` in Claude plugin layout
// (`.claude-plugin/plugin.json` + `skills/<name>/SKILL.md`); each Bot sees only the skills turned on
// for it (`Bot.skills`). Skills are written here (by the owner or a Bot) or imported from skills.sh.
import { Schema } from "effect"
import { Millis, Slug } from "./base.ts"

/** Directory name under `skills/`; lower-case slug. */
export const SkillName = Slug.pipe(Schema.brand("SkillName"))
export type SkillName = typeof SkillName.Type

/** Where an imported skill came from (absent: written here, by the owner or a Bot). */
export const SkillSource = Schema.Struct({
  kind: Schema.Literal("skills.sh"),
  /** skills.sh id, `owner/repo/skill`. */
  id: Schema.String,
  /** Hash of the snapshot it was installed from. */
  hash: Schema.optionalKey(Schema.String),
})
export type SkillSource = typeof SkillSource.Type

export const Skill = Schema.Struct({
  name: SkillName,
  /** Frontmatter `description`: when the harness should use the skill. */
  description: Schema.String,
  /** SKILL.md body (markdown, without frontmatter). */
  body: Schema.String,
  updatedAt: Millis,
  source: Schema.optionalKey(SkillSource),
  /** Other files in the skill's folder (scripts, references), relative paths. */
  files: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Frontmatter `disable-model-invocation`: the Bot starts the skill only when the owner types `/name`. */
  disableModelInvocation: Schema.optionalKey(Schema.Boolean),
  /** Frontmatter `argument-hint` (`<topic>`): what to type after `/name`. */
  argumentHint: Schema.optionalKey(Schema.String),
})
export type Skill = typeof Skill.Type

export const SkillInput = Schema.Struct({
  name: SkillName,
  description: Schema.String,
  body: Schema.String,
  /** Absent: left as it is. */
  disableModelInvocation: Schema.optionalKey(Schema.Boolean),
})
export type SkillInput = typeof SkillInput.Type

/** A skills.sh search hit (`/api/search`). */
export const SkillSearchResult = Schema.Struct({
  /** `owner/repo/skill`. */
  id: Schema.String,
  name: Schema.String,
  /** The GitHub repo, `owner/repo`. */
  repo: Schema.String,
  installs: Schema.Number,
})
export type SkillSearchResult = typeof SkillSearchResult.Type

/** A skill fetched from skills.sh before installing: what the owner reviews. */
export const SkillPreview = Schema.Struct({
  id: Schema.String,
  /** The library name it installs as (from its frontmatter, else the skills.sh skill id). */
  name: Schema.String,
  description: Schema.String,
  body: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String, bytes: Schema.Number })),
  /** A library skill with this name exists already (installing replaces it). */
  replaces: Schema.Boolean,
})
export type SkillPreview = typeof SkillPreview.Type

// Skills (D5.5) view helpers shared by Details › Library and Settings › Skills: skill names checked
// like the brain checks them (`SkillName`), skills.sh formatting, which Bots have a skill. Pure, except
// `useDebouncedValue`.
import type { Bot, BotId, Skill, SkillName } from "@openbot/contracts"
import { useEffect, useState } from "react"

export const SKILL_NAME_MAX = 64
/** The brain's `SkillName` (contracts `Slug`). */
const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** The skill name for what the owner typed: lower case, other characters become "-", trimmed, ≤ 64. */
export const toSkillName = (input: string): string =>
  input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, SKILL_NAME_MAX)
    .replace(/-+$/, "")

export const isSkillName = (name: string): name is SkillName => SKILL_NAME.test(name)

/** Why the typed name can't be saved as a new skill (undefined: it can, or nothing is typed yet). */
export const skillNameError = (input: string, library: ReadonlyArray<Pick<Skill, "name">>): string | undefined => {
  if (input.trim() === "") return undefined
  const name = toSkillName(input)
  if (!isSkillName(name)) return "Use letters or digits."
  if (library.some((s) => s.name === name)) return `There's already a skill named “${name}”.`
  return undefined
}

/** `Call the Skill tool with "grilling"`: how a skill sends the Bot to another one. */
const SKILL_TOOL_REFERENCE = /\bskill tool (?:with|for|on)\s+(?:the\s+)?["'`“‘]([a-z0-9][a-z0-9_-]{0,63})["'`”’]/gi

/** The skills this skill's instructions send the Bot to that the library doesn't have. */
export const missingSkillDependencies = (
  skill: Pick<Skill, "name" | "body">,
  library: ReadonlyArray<Pick<Skill, "name">>,
): ReadonlyArray<string> => {
  const wanted = new Set<string>()
  for (const match of skill.body.matchAll(SKILL_TOOL_REFERENCE)) wanted.add(match[1]!.toLowerCase())
  return [...wanted].filter((name) => name !== skill.name && !library.some((s) => s.name === name))
}

/** The skills.sh id of the skill `name` in the repository `sourceId` (`owner/repo/skill`) came from. */
export const siblingSkillId = (sourceId: string, name: string): string | undefined => {
  const [owner, repo] = sourceId.split("/")
  return owner !== undefined && owner !== "" && repo !== undefined && repo !== ""
    ? `${owner}/${repo}/${name}`
    : undefined
}

/** "48.2K installs", "1 install". */
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })
export const formatInstalls = (n: number): string =>
  `${compact.format(Math.max(0, Math.round(n)))} ${Math.round(n) === 1 ? "install" : "installs"}`

/** "812 B", "4.2 KB", "1.3 MB". */
export const formatBytes = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`

/** The skill's page on skills.sh (`owner/repo/skill`). */
export const skillsShUrl = (id: string): string =>
  `https://skills.sh/${id.split("/").map(encodeURIComponent).join("/")}`

/** The Bots that have a skill, by name. */
export const botsWithSkill = (bots: ReadonlyArray<Bot>, name: string): ReadonlyArray<Bot> =>
  bots.filter((b) => b.skills.includes(name as SkillName))

/** A Bot's skills with their library entries; a name the library doesn't list (yet) keeps a bare row. */
export const skillsOfBot = (
  bot: Pick<Bot, "skills">,
  library: ReadonlyArray<Skill>,
): ReadonlyArray<Pick<Skill, "name" | "description"> & Partial<Skill>> =>
  bot.skills
    .map((name) => library.find((s) => s.name === name) ?? { name, description: "" })
    .sort((a, b) => a.name.localeCompare(b.name))

/** What deleting a skill does to the Bots that have it (the delete confirm). */
export const loseText = (bots: ReadonlyArray<Pick<Bot, "name">>): string =>
  bots.length === 0
    ? "No Bot has it."
    : bots.length === 1
      ? `${bots[0]!.name} will lose it.`
      : `${bots.length} Bots will lose it.`

/** Same members, any order. */
export const sameBots = (a: ReadonlyArray<BotId>, b: ReadonlyArray<BotId>): boolean =>
  a.length === b.length && a.every((id) => b.includes(id))

/** Human text for a failed skills.sh call; undefined for other errors (use `errorText`). */
export const skillsShErrorText = (e: unknown): string | undefined => {
  const tag = typeof e === "object" && e !== null ? (e as { readonly _tag?: unknown })._tag : undefined
  if (tag === "Unavailable") return "skills.sh didn't answer — try again."
  if (tag === "NotFound") return "skills.sh doesn't have this skill any more."
  return undefined
}

/** `value`, once it stopped changing for `ms` (search fields). */
export function useDebouncedValue<A>(value: A, ms: number): A {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return settled
}

/**
 * The owner's `/skill-name` command (D5.5): a message that starts with `/` and the name of one of the
 * Bot's skills asks the Bot to use that skill. The chat keeps what the owner typed; the Bot reads an
 * explicit instruction, so it works on every harness and for skills that say they are not for the
 * model to start on its own (`disable-model-invocation`). Anything else, a `/path` or a skill the Bot
 * doesn't have, is an ordinary message.
 */
const COMMAND = /^\/([a-z0-9][a-z0-9_-]{0,63})(?=\s|$)[ \t]*([\s\S]*)$/

export interface SkillCommand {
  readonly name: string
  /** What the owner wrote after the command (may be empty). */
  readonly rest: string
}

export const parseSkillCommand = (text: string, skills: ReadonlyArray<string>): SkillCommand | undefined => {
  const match = COMMAND.exec(text.trimStart())
  if (match === null || !skills.includes(match[1]!)) return undefined
  return { name: match[1]!, rest: match[2]!.trim() }
}

/** The message as the Bot reads it. */
export const renderSkillCommand = (command: SkillCommand): string =>
  [
    `The owner started your "${command.name}" skill (they typed /${command.name}). Use it for this request: open it with your Skill tool or read its SKILL.md and follow it. This is the owner asking for it by name, so it applies even if the skill says it is not for you to start on your own.`,
    command.rest === ""
      ? "They gave no details: start the skill, and ask for what it needs."
      : `Their request: ${command.rest}`,
  ].join("\n")

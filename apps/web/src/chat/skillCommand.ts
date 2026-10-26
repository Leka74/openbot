// The owner's `/skill` command in the message box (D5.5): the brain treats a message that starts with
// `/` and the name of one of the Bot's skills as a request to use it; the box colors exactly that.

/** How much of the message is a `/skill` command of one of the Bot's skills (0: none). */
export const skillCommandLength = (
  text: string,
  skills: ReadonlyArray<{ readonly name: string }> | undefined,
): number => {
  const match = /^\/([a-z0-9][a-z0-9_-]{0,63})(?=\s|$)/.exec(text)
  return match !== null && skills?.some((s) => s.name === match[1]) === true ? match[0].length : 0
}

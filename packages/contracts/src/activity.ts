// Owner-visible activity phrases (docs/decisions.md D6.4; the D5.7 product rule "bots talk like
// people"). The activity row above the composer and the sidebar say what a bot is doing in human
// words: never a tool name and never plumbing ("task", "subagent", "session", "worker", "bot",
// "tool"). The harness adapters share these phrases so every harness reads the same.

/**
 * The one generic phrase: the bot thinks, or does something for itself the owner does not need to
 * follow (its memory, routines, sections and skills, starting or checking its parallel work,
 * reactions, native helpers, tools without a phrase of their own).
 */
export const THINKING_ACTIVITY = "Thinking…"

/** Writing to a teammate or posting in a group (`message_bot`, `handoff_task`, `post_to_group`). */
export const MESSAGING_ACTIVITY = "Sending a message"

/** A tool of an MCP server other than OpenBot's own (the web's phrase for the `mcp` tool kind). */
export const CONNECTED_APP_ACTIVITY = "Working in a connected app"

const OPENBOT_TOOL_ACTIVITY: Readonly<Record<string, string>> = {
  message_bot: MESSAGING_ACTIVITY,
  handoff_task: MESSAGING_ACTIVITY,
  post_to_group: MESSAGING_ACTIVITY,
  send_file: "Sending a file",
  search_messages: "Looking back through messages",
  read_conversation: "Looking back through messages",
  ask_user: "Asking you a question",
  request_approval: "Asking for your approval",
  request_takeover: "Needs you on its screen",
  browser: "Using the browser",
  computer: "Using the computer",
}

/**
 * The activity phrase of one of OpenBot's own gateway tools (MCP server `openbot`). Adapters keep
 * their own phrases for the computer tools (`shell` → "Running a command", `read_file` → "Reading
 * files"…) and use this for the rest: messaging, files and questions read as such; everything else
 * is bookkeeping and reads as `THINKING_ACTIVITY`.
 */
export const openBotToolActivity = (tool: string): string => OPENBOT_TOOL_ACTIVITY[tool] ?? THINKING_ACTIVITY

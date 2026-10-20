// Reactivity keys shared by query atoms (refetch) and command atoms / live streams (invalidate).
// The roster and conversation replicas are live; these keys cover the request/response reads that
// have no live feed (interfaces.md §9 "Routine changes": refetch on routine events).
import type { ConversationChange, RosterChange } from "@openbot/contracts"

export const Keys = {
  session: "session",
  botContext: "bot-context",
  routines: "routines",
  memory: "memory",
  skills: "skills",
  rules: "rules",
  harnesses: "harnesses",
  usage: "usage",
  computer: "computer",
  requests: "requests",
  nodes: "nodes",
  sections: "sections",
  settings: "settings",
  /** Background tasks (D5.7): their list and details refetch when the roster carries a task change. */
  tasks: "tasks",
  /** The Slack connection (D3.4). */
  slack: "slack",
  stt: "stt",
} as const
export type ReactivityKey = (typeof Keys)[keyof typeof Keys]

/** Keys to invalidate when a live conversation change arrives (events and cards that imply other data changed). */
export const keysForConversationChange = (change: ConversationChange): ReadonlyArray<ReactivityKey> => {
  switch (change.type) {
    case "request.upserted":
      return [Keys.requests]
    case "entry.upserted": {
      const entry = change.entry
      if (entry.kind === "event") {
        switch (entry.event.type) {
          case "routine-changed":
          case "routine-run":
            return [Keys.routines]
          case "memory-updated":
            return [Keys.memory, Keys.botContext]
          case "skill-saved":
            return [Keys.skills]
          case "auto-decided":
            return [Keys.rules]
          case "session-changed":
            return [Keys.botContext, Keys.usage]
          default:
            return []
        }
      }
      if (entry.kind === "card" && entry.card.type === "routine") return [Keys.routines]
      return []
    }
    default:
      return []
  }
}

/** Keys to invalidate when a live roster change arrives. */
export const keysForRosterChange = (change: RosterChange): ReadonlyArray<ReactivityKey> => {
  switch (change.type) {
    case "bot.upserted":
    case "bot.removed":
      // a Bot saving a skill (save_skill) changes the library too
      return [Keys.botContext, Keys.session, Keys.skills]
    case "node.upserted":
    case "node.removed":
      return [Keys.nodes, Keys.computer]
    case "section.upserted":
    case "section.removed":
      return [Keys.sections]
    case "settings.updated":
      return [Keys.settings]
    case "task.upserted":
    case "task.removed":
      return [Keys.tasks]
    default:
      return []
  }
}

// Request/response reads that have no live feed. Each refetches when a command (commands.ts) or a live
// event (keys.ts) invalidates its reactivity key. Families are keyed by primitives so the same
// arguments always return the same atom.
import type { BotId, ConversationId, HarnessKindName, RoutineId, TaskId } from "@openbot/contracts"
import { Atom } from "effect/reactivity"
import { Keys } from "./keys.ts"
import { OpenBotClient } from "./rpc.ts"

/** `{ownerName, version, dataDir, firstRun}`; `firstRun` drives onboarding. */
export const sessionInfoAtom = OpenBotClient.query("session.info", undefined, { reactivityKeys: [Keys.session] })

/** Install / version / auth status of every registered harness, one per (kind, account) (D2.6). */
export const harnessStatusAtom = OpenBotClient.query("harnesses.status", undefined, { reactivityKeys: [Keys.harnesses] })

const SEP = "\u0000"
const modelsFamily = Atom.family((key: string) => {
  const [kind = "", profileId] = key.split(SEP)
  return OpenBotClient.query("harnesses.models", profileId ? { kind, profileId } : { kind }, { reactivityKeys: [Keys.harnesses] })
})

/** Models of a harness; `profileId` absent / `"default"` = the harness's default account. */
export const harnessModelsAtom = (kind: HarnessKindName, profileId?: string | undefined) =>
  modelsFamily(profileId === undefined || profileId === "" || profileId === "default" ? kind : `${kind}${SEP}${profileId}`)

/** Harness accounts (profiles): each harness's default first, then the ones the owner added. */
export const harnessProfilesAtom = OpenBotClient.query("harnesses.profiles", {}, { reactivityKeys: [Keys.harnesses] })

/** Config dirs on the brain machine that look like logins of `kind` and are not accounts yet. */
export const harnessDiscoverAtom = Atom.family((kind: HarnessKindName) => OpenBotClient.query("harnesses.discover", { kind }, { reactivityKeys: [Keys.harnesses] }))

/**
 * Settings straight from `settings.get`. The roster also carries settings live (`settingsAtom` in
 * roster.ts); prefer that one in UI code.
 */
export const settingsQueryAtom = OpenBotClient.query("settings.get", undefined, { reactivityKeys: [Keys.settings] })

/** The Slack connection (D3.4): workspace, who the owner is there, and whether live messages arrive. */
export const slackStatusAtom = OpenBotClient.query("slack.status", undefined, { reactivityKeys: [Keys.slack] })

export const sttStatusAtom = OpenBotClient.query("stt.status", undefined, { reactivityKeys: [Keys.stt] })

/** Hark (D3.5): whether the owner's iPhone gets OpenBot's notifications, and which. */
export const harkStatusAtom = OpenBotClient.query("hark.status", undefined, { reactivityKeys: [Keys.hark] })

/** Rendered instructions + memory for the details pane. */
export const botContextAtom = Atom.family((botId: BotId) => OpenBotClient.query("bots.readContext", { botId }, { reactivityKeys: [Keys.botContext] }))

export const memoryAtom = Atom.family((botId: BotId) => OpenBotClient.query("memory.get", { botId }, { reactivityKeys: [Keys.memory] }))

/** Routines of one bot (or all routines with `"*"`). */
export const routinesAtom = Atom.family((botId: BotId | "*") =>
  OpenBotClient.query("routines.list", botId === "*" ? {} : { botId }, { reactivityKeys: [Keys.routines] }),
)

/** The last runs of a routine, most recent first. */
export const routineRunsAtom = Atom.family((routineId: RoutineId) => OpenBotClient.query("routines.runs", { routineId }, { reactivityKeys: [Keys.routines] }))

/** The skills library (D5.5). Which Bots have which skill is live in the roster (`Bot.skills`). */
export const skillsAtom = OpenBotClient.query("skills.list", undefined, { reactivityKeys: [Keys.skills] })

/**
 * skills.sh search hits for one query. Debounce typing in the UI and read the atom of the latest
 * query: every query is its own atom, so a slow answer to an older query never shows for a newer one
 * (and unmounting an old query's atom interrupts its request).
 */
export const skillSearchAtom = Atom.family((query: string) => OpenBotClient.query("skills.search", { query }))

/** A skills.sh skill as it would install (downloaded by the brain; nothing is written). */
export const skillPreviewAtom = Atom.family((id: string) => OpenBotClient.query("skills.preview", { id }))

/** Approval rules (Settings › Permissions), optionally for one bot (`"*"` = all). */
export const rulesAtom = Atom.family((botId: BotId | "*") => OpenBotClient.query("rules.list", botId === "*" ? {} : { botId }, { reactivityKeys: [Keys.rules] }))

/** Usage per bot (Settings › Usage); `sinceMs` 0 = all time. */
export const usageAtom = Atom.family((sinceMs: number) =>
  OpenBotClient.query("usage.byBot", sinceMs > 0 ? { sinceMs } : {}, { reactivityKeys: [Keys.usage] }),
)

/** The bot's live-view status (Details › Computer). */
export const computerStatusAtom = Atom.family((botId: BotId) => OpenBotClient.query("computer.status", { botId }, { reactivityKeys: [Keys.computer] }))

/** Pending requests across all conversations (`"*"`) or one conversation. */
export const pendingRequestsQueryAtom = Atom.family((conversationId: ConversationId | "*") =>
  OpenBotClient.query("requests.listPending", conversationId === "*" ? {} : { conversationId }, { reactivityKeys: [Keys.requests] }),
)

export const sectionsQueryAtom = OpenBotClient.query("sections.list", undefined, { reactivityKeys: [Keys.sections] })
export const nodesQueryAtom = OpenBotClient.query("nodes.list", undefined, { reactivityKeys: [Keys.nodes] })

/** A bot's background tasks (D5.7), newest first; refetched on every roster task change. */
export const tasksQueryAtom = Atom.family((botId: BotId) => OpenBotClient.query("tasks.list", { botId }, { reactivityKeys: [Keys.tasks] }))

/** One task with its steps (the Tasks tab's expanded row); refetched on every roster task change. */
export const taskDetailAtom = Atom.family((taskId: TaskId) => OpenBotClient.query("tasks.get", { taskId }, { reactivityKeys: [Keys.tasks] }))

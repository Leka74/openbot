// Approval rules (D5.6, architecture §4.1 policy.ts, §4.3.4). Rules live on the brain; nodes
// enforce their own ceiling on top. Evaluation order is owned by core's ApprovalService:
// bot deny > bot ask > bot allow > global deny > global ask > global allow > default (ask).
import { Effect, Schema } from "effect"
import { ApprovalRuleId, BotId, MAIN_PROFILE_ID, Millis, OwnerProfileId } from "./base.ts"

/**
 * What a request touches (rule surfaces). `skills`: a Bot changing which skills a Bot has; its
 * autonomy never decides that (only a rule or the owner).
 */
export const ApprovalSurface = Schema.Literals([
  "shell",
  "file-edit",
  "file-read",
  "mcp",
  "browser",
  "computer",
  "network",
  "skills",
  "other",
])
export type ApprovalSurface = typeof ApprovalSurface.Type

export const ApprovalAction = Schema.Literals(["ask", "allow", "deny"])
export type ApprovalAction = typeof ApprovalAction.Type

/** All present fields must match; an empty match covers the whole surface. */
export const ApprovalRuleMatch = Schema.Struct({
  /** Exact tool name as the harness saw it (`Bash`, `exec_command`, `mcp__openbot__shell`). */
  toolName: Schema.optionalKey(Schema.String),
  /** Shell command prefix, compared on whitespace-normalized text (`git status`). */
  commandPrefix: Schema.optionalKey(Schema.String),
  /** Absolute path prefix for file surfaces. */
  pathPrefix: Schema.optionalKey(Schema.String),
})
export type ApprovalRuleMatch = typeof ApprovalRuleMatch.Type

export const ApprovalRule = Schema.Struct({
  id: ApprovalRuleId,
  ownerProfileId: OwnerProfileId.pipe(Schema.withDecodingDefaultKey(Effect.succeed(MAIN_PROFILE_ID))),
  /** Absent = global rule (applies to every bot). */
  botId: Schema.optionalKey(BotId),
  surface: ApprovalSurface,
  match: ApprovalRuleMatch,
  action: ApprovalAction,
  /** Optional natural-language description shown in Settings › Permissions. */
  note: Schema.optionalKey(Schema.String),
  /** How the rule came to be: written in Settings, or saved from an "Always allow" answer. */
  origin: Schema.optionalKey(Schema.Literals(["user", "always-allow"])),
  createdAt: Millis,
})
export type ApprovalRule = typeof ApprovalRule.Type

/** `rules.upsert` input: the server allocates `id` and `createdAt` when `id` is absent. */
export const ApprovalRuleInput = Schema.Struct({
  id: Schema.optionalKey(ApprovalRuleId),
  botId: Schema.optionalKey(BotId),
  surface: ApprovalSurface,
  match: ApprovalRuleMatch,
  action: ApprovalAction,
  note: Schema.optionalKey(Schema.String),
})
export type ApprovalRuleInput = typeof ApprovalRuleInput.Type

/** A rule the UI can offer to save from an approval card ("Always allow", "Always allow next time"). */
export const SuggestedRule = Schema.Struct({ surface: ApprovalSurface, match: ApprovalRuleMatch })
export type SuggestedRule = typeof SuggestedRule.Type

/**
 * Per-bot autonomy (Grok "Allow automatically"), applied by ApprovalService AFTER the user's rules
 * (a matching deny / ask / allow rule always wins):
 * - `ask`: every harness approval without a rule asks the user (cards);
 * - `workspace`: approvals whose effects stay inside the bot's own workspace are allowed
 *   (file paths inside it, commands run inside it that reference nothing outside and are not on the
 *   risky-command list); anything else asks;
 * - `full`: every harness approval is allowed.
 * Nodes still enforce their own ceiling on top. Bots cannot change autonomy (owner-only).
 */
export const BotAutonomy = Schema.Literals(["ask", "workspace", "full"])
export type BotAutonomy = typeof BotAutonomy.Type
/** New bots, and stored bots from before autonomy existed. */
export const DEFAULT_BOT_AUTONOMY: BotAutonomy = "workspace"

/**
 * A project folder (Settings "Shared project folders", `Bot.projectFolders`): an absolute path on the
 * bot's host computer (`/home/me/projects`, `~/projects`, `C:\\code`) that counts as workspace for
 * autonomy "workspace" and as a root of the local computer's node tools. Never `/` or `~` itself.
 */
export const ProjectFolder = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))
export type ProjectFolder = typeof ProjectFolder.Type
/** At most this many folders per list (shared, or per bot). */
export const MAX_PROJECT_FOLDERS = 32
export const ProjectFolders = Schema.Array(ProjectFolder).check(Schema.isMaxLength(MAX_PROJECT_FOLDERS))

/** The less autonomous of two levels (`ask` < `workspace` < `full`). */
export const minAutonomy = (a: BotAutonomy, b: BotAutonomy): BotAutonomy => {
  const rank = { ask: 0, workspace: 1, full: 2 } as const
  return rank[a] <= rank[b] ? a : b
}

/**
 * Canonical spelling of a project folder: trimmed, `\\` kept for Windows drives, duplicate and
 * trailing separators and `.` segments dropped (`..` is refused by `projectFolderProblem`).
 */
export const normalizeProjectFolder = (raw: string): string => {
  const trimmed = raw.trim()
  if (trimmed === "") return ""
  const windows = /^[A-Za-z]:[\\/]/.test(trimmed)
  const sep = windows ? "\\" : "/"
  const parts = trimmed.split(windows ? /[\\/]+/ : /\/+/).filter((p, i) => i === 0 || (p !== "" && p !== "."))
  const head = parts[0] ?? ""
  const rest = parts.slice(1)
  if (head === "") return `/${rest.join("/")}`
  return rest.length === 0 ? head + (windows ? sep : "") : [head, ...rest].join(sep)
}

/**
 * Why `folder` cannot be a project folder (undefined = fine): it must be absolute (`/x`, `~/x`,
 * `C:\\x`), at least one level below `/` and two below `~` or a drive (never the whole home or disk),
 * without `..` segments.
 */
export const projectFolderProblem = (raw: string): string | undefined => {
  const folder = normalizeProjectFolder(raw)
  if (folder.length === 0) return "Enter a folder path."
  if (folder.includes("\0")) return "The folder path contains a NUL byte."
  const windows = /^[A-Za-z]:[\\/]/.test(folder)
  const segments = folder.split(windows ? /[\\/]+/ : "/").filter((s) => s !== "")
  if (segments.includes("..")) return "Use a folder path without “..”."
  if (folder.startsWith("~")) {
    if (folder !== "~" && !folder.startsWith("~/")) return "Use ~/… or an absolute path."
    return segments.length < 2 ? "Pick a folder inside your home folder, not all of it." : undefined
  }
  if (windows) return segments.length < 2 ? "Pick a folder, not a whole drive." : undefined
  if (!folder.startsWith("/")) return "Use an absolute path (/…) or ~/…."
  if (segments.length < 1) return "Pick a folder, not the whole computer."
  if (segments.length < 3 && (segments[0] === "home" || segments[0] === "Users")) {
    return segments.length === 2
      ? "Pick a folder inside a home folder, not all of it."
      : "Pick a folder, not every home folder."
  }
  return undefined
}

/**
 * Normalized, de-duplicated project folders, or the first problem (`"<folder>: <why>"`). Used by
 * `bots.update` / `settings.update` (and the UI before sending).
 */
export const cleanProjectFolders = (
  raw: ReadonlyArray<string>,
): { readonly folders: ReadonlyArray<string> } | { readonly problem: string } => {
  const folders: Array<string> = []
  for (const entry of raw) {
    const problem = projectFolderProblem(entry)
    if (problem !== undefined) return { problem: `${entry.trim() || "(empty)"}: ${problem}` }
    const folder = normalizeProjectFolder(entry)
    if (!folders.includes(folder)) folders.push(folder)
  }
  return { folders }
}

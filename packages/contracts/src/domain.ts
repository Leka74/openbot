// Bots, activity, sections, conversations, routines, nodes and pairing (architecture §4.1).
// Ported from vendor/scratch/contracts/src/domain.ts and extended for v1.
import { Effect, Schema } from "effect"
import {
  BotId,
  ContextUsage,
  ConversationId,
  HarnessKindName,
  LOCAL_NODE_ID,
  Millis,
  NodeId,
  NonEmptyString,
  NonNegativeInt,
  NotificationId,
  RoutineId,
  RoutineRunId,
  SectionId,
  TurnId,
} from "./base.ts"
import { BotAutonomy, DEFAULT_BOT_AUTONOMY, ProjectFolders } from "./policy.ts"
import { SkillName } from "./skills.ts"

// ---------------------------------------------------------------------------- Bot
/** Avatar colors (D6.3, Grok's 11-color picker; OpenBot ships its own SVG art). */
export const AvatarColors = ["black", "brown", "red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta", "gray"] as const
export type AvatarColor = (typeof AvatarColors)[number]
/** Avatar shapes offered by the picker (D6.3). Stored as open strings so new shapes never break old data. */
export const AvatarShapes = ["blob", "cloud", "square", "sparkle", "clover", "heart", "flower", "teardrop", "tablet", "wedge", "house", "star", "hex"] as const
export type AvatarShape = (typeof AvatarShapes)[number]

export const BotAvatar = Schema.Struct({
  shape: NonEmptyString,
  color: NonEmptyString,
})
export type BotAvatar = typeof BotAvatar.Type

/** 32-bit FNV-1a over the UTF-16 code units of `text` (unsigned). */
export const fnv1a32 = (text: string): number => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Deterministic default avatar for a bot id (D6.3): `h = fnv1a32(id)`, shape = `AvatarShapes[h % 13]`,
 * color = `AvatarColors[floor(h / 13) % 11]`. BotService stores it at creation; `@openbot/ui` mirrors
 * the same rule (same order of shapes and colors) for previews.
 */
export const defaultBotAvatar = (id: string): { readonly shape: AvatarShape; readonly color: AvatarColor } => {
  const hash = fnv1a32(id)
  return {
    shape: AvatarShapes[hash % AvatarShapes.length]!,
    color: AvatarColors[Math.floor(hash / AvatarShapes.length) % AvatarColors.length]!,
  }
}

export const BotHarness = Schema.Struct({
  /** claude | codex | opencode | fake; unknown kinds are kept (see `HarnessKindName`). */
  kind: HarnessKindName,
  /** Harness-native model id, e.g. "claude-sonnet-…", "gpt-5.6-luna", "opencode/mimo-v2.6-flash-free". Absent = harness default. */
  model: Schema.optionalKey(Schema.String),
  /** Harness-native reasoning effort ("low" | "medium" | "high" | …). Absent = harness default. */
  effort: Schema.optionalKey(Schema.String),
  /**
   * Harness account (`HarnessProfile.id`) = login/config home the harness runs with. Absent = the
   * harness's default profile (its usual login); `"default"` is normalized away by BotService.
   */
  profileId: Schema.optionalKey(Schema.String),
})
export type BotHarness = typeof BotHarness.Type

export const BotNotify = Schema.Literals(["all", "mentions", "none"])
export type BotNotify = typeof BotNotify.Type

export const Bot = Schema.Struct({
  id: BotId,
  name: NonEmptyString.check(Schema.isMaxLength(64)),
  /** Short role chip under the name ("Research", "Infra"); Grok "Add a label". */
  label: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  avatar: BotAvatar,
  harness: BotHarness,
  /** The session's host node (D1.5): where native tools run. Defaults to `LOCAL_NODE_ID` (colocated). */
  hostNodeId: NodeId.pipe(Schema.withDecodingDefaultKey(Effect.succeed(LOCAL_NODE_ID))),
  /** Other nodes this bot may reach through the gateway node tools (`node` parameter). */
  boundNodeIds: Schema.Array(NodeId).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** The bot's persona / instructions, user-editable (D0.4). */
  instructions: Schema.String,
  /** The 1:1 conversation with the owner (Grok "main" session). */
  directConversationId: ConversationId,
  /** Sidebar section; absent = "Unassigned". */
  sectionId: Schema.optionalKey(SectionId),
  pinned: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  /** Where the owner dragged it among its section's (or the pins') chats; absent = by recent activity. */
  sidebarOrder: Schema.optionalKey(Schema.Number),
  /** "Hide from sidebar" (Hidden Bots section). */
  hidden: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  notify: BotNotify.pipe(Schema.withDecodingDefaultKey(Effect.succeed("all" as const))),
  /** What the bot may do without asking when no rule decides (`BotAutonomy`). Owner-only. */
  autonomy: BotAutonomy.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_BOT_AUTONOMY))),
  /**
   * "Project folders" (Details › Brain): folders on the host computer this bot may treat as its
   * workspace, on top of its own workspace and Settings' shared project folders. Owner-only (bot tools
   * cannot change them); "Allow in ‹folder›" on an approval card adds one.
   */
  projectFolders: ProjectFolders.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /**
   * The library skills this Bot can use (D5.5); the others are invisible to it. The owner sets them;
   * a Bot asks with an approval card (`enable_skill`), except for skills it saves itself.
   */
  skills: Schema.Array(SkillName).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  createdAt: Millis,
  updatedAt: Millis,
})
export type Bot = typeof Bot.Type

export const BotActivityState = Schema.Literals(["idle", "thinking", "working", "waiting", "error", "offline"])
export type BotActivityState = typeof BotActivityState.Type

/** Live presence: the activity row ("Searching the web"), sidebar "Typing…", status dots. */
export const BotActivity = Schema.Struct({
  botId: BotId,
  conversationId: Schema.optionalKey(ConversationId),
  state: BotActivityState,
  /** Human phrase for the shimmering activity row, e.g. "Searching the web", "Typing…", "Waiting for you: …". */
  label: Schema.optionalKey(Schema.String),
  /** Tool kind behind the current label (drives the activity icon). Open string; see `ToolKind`. */
  toolKind: Schema.optionalKey(Schema.String),
  since: Millis,
})
export type BotActivity = typeof BotActivity.Type

// ---------------------------------------------------------------------------- Sections
export const Section = Schema.Struct({
  id: SectionId,
  name: NonEmptyString.check(Schema.isMaxLength(64)),
  /** Ascending sort key. */
  order: Schema.Number,
})
export type Section = typeof Section.Type

// ---------------------------------------------------------------------------- Conversation
export const ConversationKind = Schema.Literals(["direct", "group", "routine-run"])
export type ConversationKind = typeof ConversationKind.Type

/**
 * A bot's native session inside a conversation (one per member bot). Drives the composer's context
 * ring and Compact / New session (D0.4, D6.5). Maintained by core (TurnIngest / newSession) and
 * published with `conversation.updated`.
 */
export const ConversationSession = Schema.Struct({
  botId: BotId,
  /** A native session exists (false after New session until the next turn opens one). */
  active: Schema.Boolean,
  /** Latest context-window usage reported by the harness; absent until reported. */
  contextUsage: Schema.optionalKey(ContextUsage),
  updatedAt: Millis,
})
export type ConversationSession = typeof ConversationSession.Type

const ConversationBase = {
  id: ConversationId,
  title: Schema.String,
  createdAt: Millis,
  lastActivityAt: Millis,
  unreadCount: NonNegativeInt,
  /** Server-side unread boundary (Grok `unreadBoundaryAt`) so all clients draw the same NEW divider. */
  unreadBoundaryAt: Schema.optionalKey(Millis),
  hiddenFromSidebar: Schema.Boolean,
  /** Replica epoch: changes on new session / rebuild (Grok `ordered.epoch`). */
  epoch: NonEmptyString,
  /** Per-bot native session state (context ring). Absent = no session opened yet. */
  sessions: Schema.optionalKey(Schema.Array(ConversationSession)),
}

export const DirectConversation = Schema.Struct({ ...ConversationBase, kind: Schema.Literal("direct"), botId: BotId })
export const GroupConversation = Schema.Struct({
  ...ConversationBase,
  kind: Schema.Literal("group"),
  /** 2–6 bots (D5.1). */
  memberBotIds: Schema.Array(BotId),
  /** The router's default responder; absent = the first member. */
  leadBotId: Schema.optionalKey(BotId),
  namedBy: Schema.Literals(["user", "app"]),
  /** The owner's sidebar section for it; absent = "Group chats". */
  sectionId: Schema.optionalKey(SectionId),
  /** See `Bot.sidebarOrder`. */
  sidebarOrder: Schema.optionalKey(Schema.Number),
})
export const RoutineRunConversation = Schema.Struct({
  ...ConversationBase,
  kind: Schema.Literal("routine-run"),
  botId: BotId,
  routineId: RoutineId,
  runId: RoutineRunId,
  triggerSummary: Schema.String,
})
export const Conversation = Schema.Union([DirectConversation, GroupConversation, RoutineRunConversation])
export type Conversation = typeof Conversation.Type

export const MIN_GROUP_BOTS = 2
export const MAX_GROUP_BOTS = 6

/** Sidebar row (denormalized; t3code ThreadShell / Grok roster row). */
export const ConversationSummary = Schema.Struct({
  id: ConversationId,
  kind: ConversationKind,
  title: Schema.String,
  botIds: Schema.Array(BotId),
  lastActivityAt: Millis,
  /** Last message text, "Typing…", "Waiting for you: …". */
  preview: Schema.optionalKey(Schema.String),
  unreadCount: NonNegativeInt,
  pendingRequestCount: NonNegativeInt,
  hiddenFromSidebar: Schema.Boolean,
  /** A group chat's sidebar section and place (see `GroupConversation`). */
  sectionId: Schema.optionalKey(SectionId),
  sidebarOrder: Schema.optionalKey(Schema.Number),
})
export type ConversationSummary = typeof ConversationSummary.Type

// ---------------------------------------------------------------------------- Routines (D5.3)
export const MIN_ROUTINE_INTERVAL_MINUTES = 5
/** Routine runs kept per routine (D5.3). */
export const ROUTINE_RUNS_KEPT = 20

export const CronTrigger = Schema.Struct({
  type: Schema.Literal("cron"),
  /** 5-field cron expression, parsed with effect `Cron`. */
  schedule: NonEmptyString,
  /** IANA timezone, e.g. "Europe/Berlin". */
  timezone: NonEmptyString,
})
export const IntervalTrigger = Schema.Struct({
  type: Schema.Literal("interval"),
  everyMinutes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(MIN_ROUTINE_INTERVAL_MINUTES)),
})
export const OnceTrigger = Schema.Struct({ type: Schema.Literal("once"), at: Millis })
export const ManualTrigger = Schema.Struct({ type: Schema.Literal("manual") })
/** Later (webhooks are not in v1). Decoded so stored data survives; rejected as input. */
export const WebhookTrigger = Schema.Struct({ type: Schema.Literal("webhook") })
/**
 * A Slack message the owner can see (D3.4, needs Slack connected with live events):
 * - `dm`: someone writes to them directly (a DM or a group DM);
 * - `mention`: someone @mentions them;
 * - `phrase`: a message contains `phrase` (any case);
 * - `message`: any message (needs `channel`).
 * `channel` ("#name" or an id) limits it to one channel. Messages close together arrive as one run.
 */
export const SlackTrigger = Schema.Struct({
  type: Schema.Literal("slack"),
  on: Schema.Literals(["dm", "mention", "phrase", "message"]),
  phrase: Schema.optionalKey(Schema.String),
  channel: Schema.optionalKey(Schema.String),
})
export type SlackTrigger = typeof SlackTrigger.Type

/** Triggers a client may create or update in v1. */
export const RoutineTriggerInput = Schema.Union([CronTrigger, IntervalTrigger, OnceTrigger, ManualTrigger, SlackTrigger])
export type RoutineTriggerInput = typeof RoutineTriggerInput.Type
/** Triggers as stored and shown (input triggers plus decode-only `webhook`). */
export const RoutineTrigger = Schema.Union([CronTrigger, IntervalTrigger, OnceTrigger, ManualTrigger, SlackTrigger, WebhookTrigger])
export type RoutineTrigger = typeof RoutineTrigger.Type

export const RoutineOutput = Schema.Literals(["direct", "own-conversation"])
export type RoutineOutput = typeof RoutineOutput.Type

export const RoutineRunStatus = Schema.Literals(["running", "succeeded", "failed", "interrupted", "skipped"])
export type RoutineRunStatus = typeof RoutineRunStatus.Type

export const Routine = Schema.Struct({
  id: RoutineId,
  botId: BotId,
  name: NonEmptyString,
  /** The instruction delivered to the bot on each run. */
  prompt: Schema.String,
  trigger: RoutineTrigger,
  /** Active (true) / Paused (false). */
  enabled: Schema.Boolean,
  /** Where runs post: the bot's direct conversation or a fresh routine-run conversation. */
  output: RoutineOutput,
  createdAt: Millis,
  updatedAt: Millis,
  lastRunAt: Schema.optionalKey(Millis),
  lastRunStatus: Schema.optionalKey(RoutineRunStatus),
  nextRunAt: Schema.optionalKey(Millis),
})
export type Routine = typeof Routine.Type

export const RoutineRun = Schema.Struct({
  id: RoutineRunId,
  routineId: RoutineId,
  /** What fired it: the schedule, the user ("Test run" / runNow), the boot-time catch-up, or an event (a Slack message). */
  firedBy: Schema.Literals(["schedule", "manual", "catch-up", "event"]),
  startedAt: Millis,
  finishedAt: Schema.optionalKey(Millis),
  status: RoutineRunStatus,
  conversationId: ConversationId,
  turnId: Schema.optionalKey(TurnId),
  /** The last bot message, truncated. */
  summary: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
})
export type RoutineRun = typeof RoutineRun.Type

// ---------------------------------------------------------------------------- Nodes (hands)
/** Versioned capability names advertised by nodes (`fs@1`, `browser@1`, …). Open strings. */
export const NodeCapabilities = {
  fs: "fs@1",
  shell: "shell@1",
  pty: "pty@1",
  tunnel: "tunnel@1",
  browser: "browser@1",
  desktop: "desktop@1",
  screen: "screen@1",
  codexExecServer: "codex.exec-server@1",
  claudeCli: "claude.cli@1",
  opencodeServe: "opencode.serve@1",
} as const

export const NodeStatus = Schema.Literals(["online", "offline", "degraded"])
export type NodeStatus = typeof NodeStatus.Type

export const NodeSummary = Schema.Struct({
  id: NodeId,
  label: NonEmptyString,
  kind: Schema.Literals(["local", "remote"]),
  status: NodeStatus,
  /** Effective capabilities: declared by the node AND approved by the owner. */
  capabilities: Schema.Array(Schema.String),
  /** Everything the node declared at its last `node.hello`, approved or not (Settings › Computers). */
  declaredCapabilities: Schema.Array(Schema.String),
  /** `process.platform`-style OS name: "linux", "darwin", "win32". */
  platform: Schema.String,
  hostname: Schema.String,
  /** Allowed filesystem roots on the node (absolute paths on the node). */
  roots: Schema.Array(Schema.String),
  /** node-daemon version, when known. */
  version: Schema.optionalKey(Schema.String),
  /** Programs the node lacks for per-bot desktops (D1.7), while online; absent when it has them all. */
  desktopMissing: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Permissions a Mac still needs before its Bots can use its screen (`screen@1`), while online. */
  screenMissing: Schema.optionalKey(Schema.Array(Schema.String)),
  lastSeenAt: Schema.optionalKey(Millis),
  createdAt: Millis,
})
export type NodeSummary = typeof NodeSummary.Type

/** One-time pairing code (D1.3): 8 characters, single use, 10-minute TTL. */
export const Pairing = Schema.Struct({ code: NonEmptyString, expiresAt: Millis })
export type Pairing = typeof Pairing.Type
export const PairingCode = Schema.Struct({
  code: NonEmptyString,
  expiresAt: Millis,
  /** Ready-to-paste command, e.g. `openbot-node pair https://brain.example ABCD-1234`. */
  command: Schema.String,
})
export type PairingCode = typeof PairingCode.Type

// ---------------------------------------------------------------------------- Notifications (web-only in v1)
export const NotificationKind = Schema.Literals(["finished", "waiting", "message", "routine", "error"])
export type NotificationKind = typeof NotificationKind.Type

/** Web notification published through the roster (architecture §3.5 `Notifier`). */
export const Notification = Schema.Struct({
  id: NotificationId,
  kind: NotificationKind,
  botId: Schema.optionalKey(BotId),
  conversationId: Schema.optionalKey(ConversationId),
  title: Schema.String,
  body: Schema.String,
  at: Millis,
})
export type Notification = typeof Notification.Type

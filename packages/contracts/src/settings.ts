// Owner settings (architecture §4.1 settings.ts). Every key has a decoding default so settings
// written by an older build (missing new keys) still decode.
import { Effect, Schema } from "effect"
import { BotId, HarnessKindName } from "./base.ts"
import { BotAutonomy, DEFAULT_BOT_AUTONOMY, ProjectFolders } from "./policy.ts"
import { DEFAULT_APPROVAL_EXPIRY_MINUTES } from "./runtime-request.ts"

export const ThemePreference = Schema.Literals(["system", "dark", "light"])
export type ThemePreference = typeof ThemePreference.Type
/** User bubble color: the bot's color, or black (Grok Settings › Appearance › Accent). */
export const AccentPreference = Schema.Literals(["bot", "black"])
export type AccentPreference = typeof AccentPreference.Type

export const Settings = Schema.Struct({
  theme: ThemePreference.pipe(Schema.withDecodingDefaultKey(Effect.succeed("system" as const))),
  accent: AccentPreference.pipe(Schema.withDecodingDefaultKey(Effect.succeed("bot" as const))),
  /** The collapsed "N steps ›" disclosure under finished turns (D6.4). */
  showSteps: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  /** "Compacted context" lines in chats (a Bot compacting its context); hidden by default. */
  showCompactions: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  /** Global switch for bot-to-bot tools (D5.2 kill switch). */
  botMessaging: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  /** Compact a Bot's large context when it goes idle, while the prompt cache is still warm. */
  compactIdleBots: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  /** Bots can search and read back their own chats (`search_messages`, `read_conversation`). */
  botSearch: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  /** Preselected harness in New Bot. */
  defaultHarness: Schema.optionalKey(HarnessKindName),
  /** Unattended approvals expire after this many minutes (D5.6). */
  approvalExpiryMinutes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_APPROVAL_EXPIRY_MINUTES)),
  ),
  /** Owner display name (`session.info.ownerName`). */
  ownerName: Schema.optionalKey(Schema.String),
  /**
   * "Shared project folders" (Settings › Permissions): folders every bot may treat as its workspace
   * (autonomy "workspace", the local computer's node tools), on top of each bot's own
   * `projectFolders`. Owner-only; bot tools cannot change them.
   */
  sharedProjectFolders: ProjectFolders.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** Autonomy of new bots (New Bot preselection; `create_bot` caps it at its caller's). */
  defaultAutonomy: BotAutonomy.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_BOT_AUTONOMY))),
  /** Where Slack's "Send to OpenBot" puts a message (D3.4); absent: the Bot chatted with last. */
  slackSendTo: Schema.optionalKey(BotId),
  /** The owner's own Slack messages that mention @OpenBot go there too, like Send to OpenBot (D3.4). */
  slackMentions: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
})
export type Settings = typeof Settings.Type

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  accent: "bot",
  showSteps: true,
  showCompactions: false,
  botMessaging: true,
  compactIdleBots: true,
  botSearch: true,
  approvalExpiryMinutes: DEFAULT_APPROVAL_EXPIRY_MINUTES,
  sharedProjectFolders: [],
  defaultAutonomy: DEFAULT_BOT_AUTONOMY,
  slackMentions: true,
}

/** `settings.update` input: any subset of keys. */
export const SettingsPatch = Schema.Struct({
  theme: Schema.optionalKey(ThemePreference),
  accent: Schema.optionalKey(AccentPreference),
  showSteps: Schema.optionalKey(Schema.Boolean),
  showCompactions: Schema.optionalKey(Schema.Boolean),
  botMessaging: Schema.optionalKey(Schema.Boolean),
  compactIdleBots: Schema.optionalKey(Schema.Boolean),
  botSearch: Schema.optionalKey(Schema.Boolean),
  /** `null` clears the default. */
  defaultHarness: Schema.optionalKey(Schema.NullOr(HarnessKindName)),
  approvalExpiryMinutes: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
  ownerName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sharedProjectFolders: Schema.optionalKey(ProjectFolders),
  defaultAutonomy: Schema.optionalKey(BotAutonomy),
  /** `null`: the Bot chatted with last. */
  slackSendTo: Schema.optionalKey(Schema.NullOr(BotId)),
  slackMentions: Schema.optionalKey(Schema.Boolean),
})
export type SettingsPatch = typeof SettingsPatch.Type

/** Pure patch application, shared by SettingsService and optimistic client updates. */
export const applySettingsPatch = (settings: Settings, patch: SettingsPatch): Settings => {
  const next: { -readonly [K in keyof Settings]: Settings[K] } = { ...settings }
  if (patch.theme !== undefined) next.theme = patch.theme
  if (patch.accent !== undefined) next.accent = patch.accent
  if (patch.showSteps !== undefined) next.showSteps = patch.showSteps
  if (patch.showCompactions !== undefined) next.showCompactions = patch.showCompactions
  if (patch.botMessaging !== undefined) next.botMessaging = patch.botMessaging
  if (patch.compactIdleBots !== undefined) next.compactIdleBots = patch.compactIdleBots
  if (patch.botSearch !== undefined) next.botSearch = patch.botSearch
  if (patch.approvalExpiryMinutes !== undefined) next.approvalExpiryMinutes = patch.approvalExpiryMinutes
  if (patch.sharedProjectFolders !== undefined) next.sharedProjectFolders = patch.sharedProjectFolders
  if (patch.defaultAutonomy !== undefined) next.defaultAutonomy = patch.defaultAutonomy
  if (patch.slackMentions !== undefined) next.slackMentions = patch.slackMentions
  if (patch.defaultHarness === null) delete next.defaultHarness
  else if (patch.defaultHarness !== undefined) next.defaultHarness = patch.defaultHarness
  if (patch.ownerName === null) delete next.ownerName
  else if (patch.ownerName !== undefined) next.ownerName = patch.ownerName
  if (patch.slackSendTo === null) delete next.slackSendTo
  else if (patch.slackSendTo !== undefined) next.slackSendTo = patch.slackSendTo
  return next
}

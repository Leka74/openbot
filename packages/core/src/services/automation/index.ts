/**
 * Automation services (architecture §4.3; work package W1.3). Implements the tags in
 * `../../ports/services.ts`; apps/server composes these layers (docs/interfaces.md §2):
 *
 *   SettingsServiceLive     Layer<SettingsService, never, SettingsRepo | ApprovalRuleRepo | BotRepo | LiveHub | IdGen>
 *   UsageServiceLive        Layer<UsageService, never, UsageRepo>
 *   MemoryServiceLive       Layer<MemoryService, never, MemoryStore | BotRepo | ConversationService>
 *   SkillServiceLive        Layer<SkillService, never, SkillStore | ConversationService>
 *   ApprovalServiceLive     Layer<ApprovalService, never, ConversationService | SettingsService | Notifier |
 *                                 RequestRepo | ApprovalRuleRepo | BotRepo | IdGen>
 *   RoutineSchedulerLive    Layer<RoutineScheduler, never, Orchestrator | ConversationService | RoutineRepo | BotRepo | EntryRepo | IdGen>
 *                                 (optional SlackConnector: Slack-triggered routines)
 *   SlackServiceLive        Layer<SlackService, never, ConversationService | EntryRepo | BotRepo | Notifier | AttachmentStore> (optional SlackConnector)
 *   SlackShortcutsLive      Layer<never, never, Orchestrator | SettingsService | BotRepo | ConversationService>
 *                                 (Slack's "Send to OpenBot" clicks; optional SlackConnector)
 *
 * RoutineSchedulerLive starts its scheduler fiber in the layer scope. Requirements only name tags
 * from LOWER layers (services.ts header). `@openbot/core` re-exports this barrel.
 */
export { SettingsServiceLive } from "./SettingsService.ts"
export { UsageServiceLive } from "./UsageService.ts"
export { MEMORY_LIMITS, MemoryServiceLive } from "./MemoryService.ts"
export { SKILL_LIMITS, SkillServiceLive } from "./SkillService.ts"
export { ASK_LIMITS, ApprovalServiceLive, BLOCKED_BY_RULES, EXPIRED_MESSAGE } from "./ApprovalService.ts"
export { MAX_SCHEDULER_SLEEP_MS, ROUTINE_LIMITS, RoutineSchedulerLive } from "./RoutineScheduler.ts"
export { SlackShortcutsLive, slackShortcutText } from "./SlackShortcuts.ts"
export {
  describeSlackPlace,
  SLACK_DRAFT_MAX_CHARS,
  SlackServiceLive,
  slackEventsText,
  slackTriggerMatches,
} from "./SlackService.ts"
export {
  CATCH_UP_WINDOW_MS,
  describeTrigger,
  nextRunAfter,
  parseCron,
  validateTrigger,
} from "./schedule.ts"
export {
  AUTONOMY_LABELS,
  type AutonomyDecision,
  commandRisk,
  evaluateAutonomy,
  isInsideRoots,
  isInsideWorkspace,
  offerableFolder,
  outsideWorkDir,
} from "./autonomy.ts"
export { indexLine as memoryIndexLine, removeIndexLine, upsertIndexLine } from "./memoryIndex.ts"
export {
  commandMatches,
  describeRule,
  evaluateRules,
  pathMatches,
  type PolicyDecision,
  type PolicySubject,
  ruleMatches,
  suggestCommandPrefix,
  suggestRule,
  surfaceOf,
} from "./policy.ts"

/**
 * Conversation services (architecture §4.3; work package W1.2). Implements the tags in
 * `../../ports/services.ts` (plus the `Notifier` port); apps/server composes these layers
 * (docs/interfaces.md §2):
 *
 *   LiveHubLive              Layer<LiveHub, never, ReplicaLog | ConversationRepo | EntryRepo | RequestRepo |
 *                                  TurnRepo | BotRepo | SectionRepo | SettingsRepo | NodeDirectory | IdGen>
 *   ConversationServiceLive  Layer<ConversationService, never, LiveHub | ConversationRepo | EntryRepo |
 *                                  RequestRepo | BotRepo | SettingsRepo | IdGen>
 *   NotifierLive             Layer<Notifier, never, LiveHub | BotRepo | IdGen>
 *   AttachmentServiceLive    Layer<AttachmentService, never, AttachmentStore>
 *   InstructionRendererLive  Layer<InstructionRenderer, never, MemoryService | BotRepo | SettingsService>
 *   BackgroundTasksLive      Layer<BackgroundTasks, never, LiveHub | ApprovalService | InstructionRenderer |
 *                                  UsageService | HarnessRegistry | PlacementService | McpBindingIssuer | IdGen |
 *                                  BotRepo | ConversationRepo | EntryRepo | TaskRepo>   (D5.7, layer 5b)
 *   OrchestratorLive         Layer<Orchestrator, never, LiveHub | ConversationService | ApprovalService | BackgroundTasks |
 *                                  InstructionRenderer | SettingsService | UsageService | Notifier |
 *                                  HarnessRegistry | PlacementService | McpBindingIssuer | IdGen | BotRepo |
 *                                  ConversationRepo | EntryRepo | RequestRepo | TurnRepo | AttachmentStore>
 *   MessagingLive            Layer<Messaging, never, Orchestrator | ConversationService | SettingsService |
 *                                  BotRepo | EntryRepo | IdGen | NodeFiles | AttachmentStore>
 *   BotServiceLive           Layer<BotService, never, Orchestrator | RoutineScheduler | ApprovalService |
 *                                  MemoryService | InstructionRenderer | ConversationService | LiveHub |
 *                                  HarnessRegistry | NodeDirectory | DataDir | IdGen | BotRepo | SectionRepo |
 *                                  ConversationRepo | EntryRepo | RequestRepo | SettingsRepo | MemoryStore |
 *                                  McpTokenRepo>
 *
 * The OrchestratorLive layer forks a fiber that drains `ApprovalService.asyncAnswers`, and stops every
 * runner (closing harness sessions) when its scope closes. ConversationService, Orchestrator and
 * BotService share one internal conversation-record store (built once per layer graph through layer
 * memoization), so compose them in ONE layer graph.
 *
 * Internal modules (BotRunner, TurnIngest, GroupRouter, internal/*) are not exported.
 * Requirements only name tags from LOWER layers (services.ts header). `@openbot/core` re-exports
 * this barrel.
 */
export { LiveHubLive } from "./LiveHub.ts"
export { ConversationServiceLive, groupTitleFor, MAX_AROUND_LIMIT, MAX_HISTORY_LIMIT } from "./ConversationService.ts"
export { NotifierLive } from "./Notifier.ts"
export { AttachmentServiceLive, MAX_ATTACHMENT_BYTES, storeAttachmentStream, toAttachment } from "./AttachmentService.ts"
export { detectMime, extensionOf, formatBytes, imageDimensions, sniffMime } from "./files.ts"
export { InstructionRendererLive } from "./InstructionRenderer.ts"
export {
  BackgroundTasksLive,
  type BackgroundTasksOptions,
  DEFAULT_BACKGROUND_TASKS_OPTIONS,
  makeBackgroundTasksLayer,
  type ContextMessage,
  renderTaskSection,
  renderTaskTurn,
  renderTaskUpdate,
  rosterTasks,
  TASK_CONTEXT_BYTES,
  TASK_CONTEXT_MESSAGES,
  taskResultText,
  type TaskUpdateDelivery,
} from "./BackgroundTasks.ts"
export { makeOrchestratorLayer, MAX_MESSAGE_ATTACHMENTS, MAX_MESSAGE_CHARS, OrchestratorLive } from "./Orchestrator.ts"
export { DEFAULT_RUNNER_OPTIONS, type RunnerOptions } from "./BotRunner.ts"
export { describeSendFailure, HOP_LIMIT_MESSAGE, MAX_BOT_MESSAGE_CHARS, MESSAGING_DISABLED, MessagingLive } from "./Messaging.ts"
export { BotServiceLive, MAX_BOT_NAME_LENGTH, MAX_SECTION_NAME_LENGTH } from "./BotService.ts"

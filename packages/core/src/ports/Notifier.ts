/**
 * `Notifier` port (architecture §3.5): OS/web notifications. The implementation publishes a roster
 * `notification` change (contracts `Notification`) to connected clients; the brain's Hark, ntfy and
 * Web Push follow the roster and push it to phones.
 */
import type { BotId, ConversationId, Notification, NotificationKind } from "@openbot/contracts"
import { Context, Effect } from "effect"

export interface NotificationInput {
  readonly kind: NotificationKind
  readonly botId?: BotId | undefined
  readonly conversationId?: ConversationId | undefined
  readonly title: string
  readonly body: string
}

export class Notifier extends Context.Service<
  Notifier,
  {
    /** Allocates id/at, honors the bot's `notify` preference (all | mentions | none), publishes. */
    readonly notify: (input: NotificationInput) => Effect.Effect<Notification | undefined>
  }
>()("openbot/core/Notifier") {}

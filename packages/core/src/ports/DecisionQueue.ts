/**
 * `DecisionQueue` port: the owner's queue of what Bots need from them (decisions, reviews, FYIs),
 * ranked, for the owner to burn down to zero. Bots add items with the `add_to_queue` tool; the owner's
 * decision comes back to the Bot as a `queue-decision` delivery in the conversation it added the item
 * from. Implemented in the server (opt-in), faked in tests. Not in the context = no queue (the tool
 * isn't offered).
 */
import type { BotId, ConversationId } from "@openbot/contracts"
import { Context, type Effect } from "effect"

export type DecisionQueueItemType = "decision" | "review" | "fyi"

export interface DecisionQueueItemInput {
  readonly type: DecisionQueueItemType
  readonly title: string
  /** Why it needs the owner now. */
  readonly why: string
  readonly recommendation?: string | undefined
  readonly options?: ReadonlyArray<string> | undefined
  /** 1-based index into `options`. */
  readonly recommendedOption?: number | undefined
  readonly evidence?: ReadonlyArray<{ readonly text: string; readonly url?: string | undefined }> | undefined
  /** `YYYY-MM-DD`. */
  readonly due?: string | undefined
  readonly stakes?: 1 | 2 | 3 | undefined
  readonly blocking?: boolean | undefined
  /** Stable key: adding again with it updates the same item. */
  readonly key?: string | undefined
}

export type DecisionQueueAddResult =
  | { readonly _tag: "added"; readonly id: string }
  | { readonly _tag: "updated"; readonly id: string; readonly revision: number }
  /** Same content as before; `closed` says how the owner closed it, when they did. */
  | { readonly _tag: "unchanged"; readonly id: string; readonly closed?: string | undefined }
  /** Caught by one of the owner's "not this kind" rules. */
  | { readonly _tag: "filtered"; readonly id: string; readonly rule: { readonly id: number; readonly label: string } }

export class DecisionQueueRefused extends Error {}

export class DecisionQueue extends Context.Service<
  DecisionQueue,
  {
    readonly add: (
      input: DecisionQueueItemInput & {
        readonly profileId: string
        readonly botId: BotId
        readonly botName: string
        readonly conversationId: ConversationId
        /** The split it shows in (e.g. the Bot's sidebar section). */
        readonly area: string
      },
    ) => Effect.Effect<DecisionQueueAddResult, DecisionQueueRefused>
  }
>()("openbot/core/DecisionQueue") {}

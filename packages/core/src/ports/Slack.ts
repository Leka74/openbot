/**
 * `SlackConnector` port (D3.4): the owner's Slack through their own Slack app: a user token (what
 * they can see; messages go out as them) and, optionally, Socket Mode for messages as they arrive.
 * Implemented in the server over the Slack Web API, faked in tests. Not in the context = no Slack.
 *
 * Text is readable: mentions as `@Name`, channel links as `#name`, links as `label (url)`.
 */
import type { Attachment, Conflict, EntryId, InvalidInput, NotFound, SlackConnectInput, SlackStatus, Unavailable } from "@openbot/contracts"
import { Context, type Effect, type Stream } from "effect"
import type { ToolContext } from "./services.ts"

export interface SlackConversation {
  readonly id: string
  readonly kind: "channel" | "private" | "dm" | "group-dm"
  /** "#general", "Alice Smith" (a DM), "Alice, Bob" (a group DM). */
  readonly label: string
  readonly topic?: string | undefined
}

export interface SlackMessage {
  readonly channelId: string
  readonly ts: string
  /** The thread it belongs to (its parent's `ts`); a parent has `threadTs === ts`. */
  readonly threadTs?: string | undefined
  readonly replyCount?: number | undefined
  readonly userId?: string | undefined
  /** Who wrote it: a person's name, an app's name, or "someone". */
  readonly author: string
  readonly text: string
  /** Names of attached files. */
  readonly files?: ReadonlyArray<string> | undefined
  readonly permalink: string
}

export interface SlackPerson {
  readonly id: string
  readonly name: string
  readonly handle?: string | undefined
  readonly title?: string | undefined
}

/** A message the owner can see, as it arrives. The owner's own messages are not events. */
export interface SlackEvent {
  readonly conversation: SlackConversation
  readonly message: SlackMessage
  /** The owner is @mentioned in it. */
  readonly mentionsOwner: boolean
}

/**
 * The owner clicked "Send to OpenBot" on a message in Slack (the message shortcut). Clicks by
 * anyone else are answered in Slack and never reach here.
 */
export interface SlackShortcut {
  readonly conversation: SlackConversation
  readonly message: SlackMessage
  /** A note only the owner sees in Slack, under the message ("Sent to …"). */
  readonly reply: (text: string) => Effect.Effect<void>
}

export interface SlackTarget {
  readonly conversation: SlackConversation
  /** Set when answering in a thread: the thread's first message. */
  readonly thread?: SlackMessage | undefined
}

export class SlackConnector extends Context.Service<SlackConnector, {
  readonly status: Effect.Effect<SlackStatus>
  /** Every status change (connect, disconnect, live events up or down). */
  readonly changes: Stream.Stream<SlackStatus>
  /** Checks the tokens with Slack, saves them and starts listening. */
  readonly connect: (input: SlackConnectInput) => Effect.Effect<SlackStatus, InvalidInput | Unavailable>
  /** Forgets the tokens and stops listening. */
  readonly disconnect: Effect.Effect<void>
  /** Slack search syntax (`from:@alice in:#general after:2026-10-01 …`); newest first. */
  readonly search: (input: { readonly query: string; readonly limit: number }) => Effect.Effect<
    { readonly total: number; readonly messages: ReadonlyArray<SlackMessage & { readonly where: string }> },
    InvalidInput | Unavailable
  >
  /**
   * A conversation's latest messages (oldest first), or a thread's. `conversation`: an id, `#name`,
   * a person (`@handle` or name: your DM with them) or a message link (its thread).
   */
  readonly read: (input: {
    readonly conversation: string
    readonly thread?: string | undefined
    readonly limit: number
    /** Only messages before this `ts` (paging back). */
    readonly before?: string | undefined
  }) => Effect.Effect<
    { readonly conversation: SlackConversation; readonly messages: ReadonlyArray<SlackMessage>; readonly more: boolean },
    InvalidInput | Unavailable
  >
  /** Channels the owner is in and people whose name matches. */
  readonly find: (query: string) => Effect.Effect<
    { readonly conversations: ReadonlyArray<SlackConversation>; readonly people: ReadonlyArray<SlackPerson> },
    Unavailable
  >
  /** Where a message to `to` (same forms as `read`) goes, and the thread for `thread` (a `ts` or a link). */
  readonly resolve: (input: { readonly to: string; readonly thread?: string | undefined }) => Effect.Effect<SlackTarget, InvalidInput | Unavailable>
  /**
   * Posts as the owner. `text` may use `@Name` for people; they are turned into Slack mentions.
   * With `files` (on the brain's disk) they are uploaded and `text` is their comment (it may be
   * empty); Slack posts that message a moment later, so there is no `ts` and the link is the
   * conversation's (or the thread's).
   */
  readonly send: (input: {
    readonly channelId: string
    readonly text: string
    readonly threadTs?: string | undefined
    readonly files?: ReadonlyArray<{ readonly name: string; readonly path: string; readonly byteSize: number }> | undefined
  }) => Effect.Effect<{ readonly ts?: string | undefined; readonly permalink: string }, InvalidInput | Unavailable>
  /** Messages as they arrive (while live). */
  readonly events: Stream.Stream<SlackEvent>
  /** The owner's "Send to OpenBot" clicks (while live). */
  readonly shortcuts: Stream.Stream<SlackShortcut>
}>()("openbot/core/SlackConnector") {}

/**
 * Slack drafts (D3.4): a Bot's `slack_draft` posts an editable "Slack message" card; nothing reaches
 * Slack until the owner presses Send (it goes out as them) — or it is discarded. Drafts never expire.
 */
export class SlackService extends Context.Service<SlackService, {
  /** Posts the draft card in the conversation the Bot works in. Same tool call id → the same draft. */
  readonly draft: (ctx: ToolContext, input: {
    readonly to: string
    readonly text: string
    readonly thread?: string | undefined
    /** Files already in OpenBot (`Messaging.importFiles`), sent with the message. */
    readonly files?: ReadonlyArray<Attachment> | undefined
  }) => Effect.Effect<{ readonly entryId: EntryId; readonly to: string; readonly inThread: boolean }, InvalidInput | Unavailable>
  /** Sends a pending draft as the owner, with their edits (`text`). */
  readonly send: (input: { readonly entryId: EntryId; readonly text: string }) => Effect.Effect<
    void,
    NotFound | InvalidInput | Conflict | Unavailable
  >
  readonly discard: (entryId: EntryId) => Effect.Effect<void, NotFound | Conflict>
}>()("openbot/core/SlackService") {}

/**
 * Messaging (architecture §4.3.2, §4.3.3, D5.2): the bot-to-bot tools.
 *
 * - `message_bot`: a bot-authored message (`toBotId`) in the RECIPIENT's direct conversation, a
 *   "Messaged @Recipient" event in the sender's current conversation, and a `bot-message` delivery
 *   (`urgent` wakes the recipient now; `background` waits for its next turn).
 *   When the sender works in a GROUP the recipient is also a member of, the message stays in that
 *   group: during the sender's group turn nothing is posted separately — the recipient is noted and
 *   woken by the sender's reply (which addresses it; no near-identical double posts), or the text is
 *   posted for it (`@Recipient …`) when the turn ends without a reply. Outside a running turn it is
 *   posted in the group and delivered like an @mention: the team keeps one shared context.
 * - `post_to_group`: a bot-authored message in a group the sender belongs to; mentioned members
 *   (or everyone with `@everyone`) get a `bot-message` delivery.
 * - `handoff_task`: like `message_bot` (always urgent, same group rule), with a `handoff` event
 *   instead of "Messaged @Recipient" (no event in the group case: the post itself shows it).
 *
 * Every hop extends the sender's current causal chain (`Orchestrator.currentChain`). A chain longer
 * than `MAX_BOT_HOPS` is refused with a model-readable `InvalidInput` and a "Stopped: too many
 * hand-offs" event. `settings.botMessaging = false` (the global kill switch) refuses every tool.
 * Tools are idempotent on the harness tool-call id (`ToolContext.callId`, D3.3).
 */
import type { Attachment, Bot, BotId, Conversation, ConversationId, EntryId, KnownConversationEvent, KnownTranscriptEntry, NodeId } from "@openbot/contracts"
import type { Invocation } from "@openbot/node-protocol"
import { HarnessUnavailable, InvalidInput, NotFound } from "@openbot/contracts"
import { Effect, Layer, Option } from "effect"
import { CoreIdPrefix, IdGen } from "../../ports/IdGen.ts"
import { NodeFiles } from "../../ports/NodeFiles.ts"
import { BotRepo, EntryRepo } from "../../ports/repos.ts"
import { AttachmentStore } from "../../ports/stores.ts"
import {
  type CausalChain,
  ConversationService,
  type DeliveryUrgency,
  MAX_BOT_HOPS,
  type MessageBotResult,
  Messaging,
  Orchestrator,
  SendFileLimits,
  type SendFilesResult,
  type SentFile,
  SettingsService,
  type ToolContext,
} from "../../ports/services.ts"
import { storeAttachmentStream } from "./AttachmentService.ts"
import { detectMime, formatBytes, imageDimensions } from "./files.ts"
import { routeBotMessage } from "./GroupRouter.ts"
import { describeFileFailure } from "./internal/inbox.ts"
import { compact, conversationBotIds, findBotByRef, orDie, required } from "./internal/util.ts"

/** Longest text a bot may send through these tools (characters). */
export const MAX_BOT_MESSAGE_CHARS = 16_000
/** Tool results remembered for idempotent retries (per tool call id). */
const IDEMPOTENCY_KEPT = 1_000

export const MESSAGING_DISABLED = "Bot-to-bot messaging is turned off in Settings."

/** One emoji grapheme (a flag, a ZWJ sequence or a skin-toned emoji count as one). */
export const isSingleEmoji = (text: string): boolean => {
  if (text === "" || text.length > 32) return false
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)]
  return graphemes.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}]/u.test(text)
}
export const HOP_LIMIT_MESSAGE =
  `Stopped: too many hand-offs (more than ${MAX_BOT_HOPS} bot-to-bot hops in this chain). Do not message other Bots again for this request; finish your turn.`

/** Model-readable reason a file could not be sent (node, transfer or validation failure). */
export const describeSendFailure = describeFileFailure

export const MessagingLive: Layer.Layer<
  Messaging,
  never,
  Orchestrator | ConversationService | SettingsService | BotRepo | EntryRepo | IdGen | NodeFiles | AttachmentStore
> = Layer.effect(
  Messaging,
  Effect.gen(function*() {
    const orchestrator = yield* Orchestrator
    const conversations = yield* ConversationService
    const settings = yield* SettingsService
    const bots = yield* BotRepo
    const entries = yield* EntryRepo
    const ids = yield* IdGen
    const nodeFiles = yield* NodeFiles
    const attachmentStore = yield* AttachmentStore
    const sendLimits = yield* SendFileLimits

    // ------------------------------------------------------------------ idempotency

    const done = new Map<string, unknown>()
    const remember = <A>(key: string | undefined, value: A): A => {
      if (key === undefined) return value
      done.set(key, value)
      if (done.size > IDEMPOTENCY_KEPT) done.delete(done.keys().next().value!)
      return value
    }
    const idempotencyKey = (tool: string, ctx: ToolContext) =>
      ctx.callId === undefined ? undefined : `${tool}:${ctx.claims.botId}:${ctx.callId}`

    // ------------------------------------------------------------------ guards

    const ensureEnabled = Effect.flatMap(settings.get, (s) =>
      s.botMessaging ? Effect.void : Effect.fail(new InvalidInput({ message: MESSAGING_DISABLED })))

    const senderOf = (ctx: ToolContext) => required(bots.get(ctx.claims.botId), "bot", ctx.claims.botId)

    const resolveBot = (ref: string) =>
      Effect.flatMap(orDie(bots.list), (all) => {
        const bot = findBotByRef(all, ref)
        return bot === undefined ? Effect.fail(new NotFound({ entity: "bot", id: ref.trim() })) : Effect.succeed(bot)
      })

    const validText = (text: string, what: string) => {
      const trimmed = text.trim()
      if (trimmed === "") return Effect.fail(new InvalidInput({ message: `The ${what} cannot be empty.` }))
      if (trimmed.length > MAX_BOT_MESSAGE_CHARS) {
        return Effect.fail(new InvalidInput({ message: `The ${what} is longer than ${MAX_BOT_MESSAGE_CHARS} characters.` }))
      }
      return Effect.succeed(trimmed)
    }

    /**
     * The chain for the next hop: the sender's current turn chain + 1, or a new chain rooted at
     * `deliveryId`. Over the limit: a hop-limit event in `eventConversationId`, then `InvalidInput`.
     */
    const nextChain = (ctx: ToolContext, deliveryId: string, eventConversationId: ConversationId) =>
      Effect.gen(function*() {
        // A background task is not part of the bot's running turn (D5.7): its messages start a chain.
        const current = ctx.taskId !== undefined ? Option.none<CausalChain>() : yield* orchestrator.currentChain(ctx.claims.botId)
        const chain: CausalChain = Option.isSome(current)
          ? { rootId: current.value.rootId, hops: current.value.hops + 1 }
          : { rootId: deliveryId, hops: 1 }
        if (chain.hops > MAX_BOT_HOPS) {
          yield* Effect.ignore(conversations.appendEvent({
            conversationId: eventConversationId,
            event: { type: "hop-limit", hops: chain.hops - 1 },
          }))
          return yield* new InvalidInput({ message: HOP_LIMIT_MESSAGE })
        }
        return chain
      })

    const unavailable = (bot: Bot, error: NotFound | HarnessUnavailable, where = `@${bot.name}'s chat`) =>
      new InvalidInput({
        message: error._tag === "HarnessUnavailable"
          ? `Your message was saved in ${where}, but @${bot.name} cannot run right now: ${error.message}`
          : `@${bot.name} cannot receive messages right now.`,
      })

    // ------------------------------------------------------------------ direct (message_bot, handoff_task)

    /** The group the sender works in when the recipient is a fellow member (else undefined). */
    const sharedGroup = (ctx: ToolContext, sender: Bot, recipient: Bot) =>
      Effect.map(Effect.option(conversations.get(ctx.claims.conversationId)), (found) =>
        Option.isSome(found) && found.value.kind === "group" && found.value.memberBotIds.includes(sender.id) &&
          found.value.memberBotIds.includes(recipient.id)
          ? found.value
          : undefined)

    /** `@Recipient text`, unless the text already opens with that mention. */
    const addressed = (recipient: Bot, text: string) =>
      text.toLowerCase().startsWith(`@${recipient.name.toLowerCase()}`) ? text : `@${recipient.name} ${text}`

    const sendToBot = (
      tool: "message_bot" | "handoff_task",
      ctx: ToolContext,
      input: {
        readonly to: string
        readonly text: string
        readonly urgency: DeliveryUrgency
        readonly event: (recipient: Bot, sender: Bot, entryId: EntryId) => KnownConversationEvent
      },
    ) =>
      Effect.gen(function*() {
        const key = idempotencyKey(tool, ctx)
        if (key !== undefined && done.has(key)) return done.get(key) as MessageBotResult
        yield* ensureEnabled
        const sender = yield* senderOf(ctx)
        const recipient = yield* resolveBot(input.to)
        if (recipient.id === sender.id) {
          return yield* new InvalidInput({ message: "You cannot message yourself. Use list_bots to find another Bot." })
        }
        const deliveryId = yield* ids.next(CoreIdPrefix.delivery)
        const causalChain = yield* nextChain(ctx, deliveryId, ctx.claims.conversationId)
        const group = yield* sharedGroup(ctx, sender, recipient)
        if (group !== undefined) {
          const text = addressed(recipient, input.text)
          // From a group turn: the reply addresses the member (no duplicate post, D5.2). A background
          // task has no reply in the group: it posts.
          const noted = ctx.taskId === undefined && (yield* orchestrator.noteGroupAddress({
            botId: sender.id,
            conversationId: group.id,
            recipientBotId: recipient.id,
            text,
            causalChain,
          }))
          if (noted) {
            return remember(key, {
              recipientBotId: recipient.id,
              conversationId: group.id,
              deliveryId,
              postedInGroup: true,
              noted: true,
            } satisfies MessageBotResult)
          }
          const posted = yield* conversations.appendEntry({
            kind: "message",
            conversationId: group.id,
            author: { kind: "bot", botId: sender.id },
            role: "bot",
            text,
            attachments: [],
            streaming: false,
            addressedBotIds: [recipient.id],
          })
          yield* orchestrator.deliver({
            id: deliveryId,
            conversationId: group.id,
            botId: recipient.id,
            kind: "bot-message",
            text,
            fromBotId: sender.id,
            sourceEntryId: posted.id,
            causalChain,
            urgency: input.urgency,
          }).pipe(Effect.mapError((error) => unavailable(recipient, error, "the group chat")))
          return remember(key, {
            recipientBotId: recipient.id,
            conversationId: group.id,
            entryId: posted.id,
            deliveryId,
            postedInGroup: true,
          } satisfies MessageBotResult)
        }
        const entry = yield* conversations.appendEntry({
          kind: "message",
          conversationId: recipient.directConversationId,
          author: { kind: "bot", botId: sender.id },
          role: "bot",
          text: input.text,
          attachments: [],
          streaming: false,
          toBotId: recipient.id,
        })
        const senderTurn = ctx.taskId !== undefined ? Option.none() : yield* orchestrator.activeTurn(sender.id)
        yield* Effect.ignore(conversations.appendEvent({
          conversationId: ctx.claims.conversationId,
          author: { kind: "bot", botId: sender.id },
          event: input.event(recipient, sender, entry.id),
          turnId: Option.isSome(senderTurn) ? senderTurn.value.id : undefined,
        }))
        yield* orchestrator.deliver({
          id: deliveryId,
          conversationId: recipient.directConversationId,
          botId: recipient.id,
          kind: "bot-message",
          text: input.text,
          fromBotId: sender.id,
          sourceEntryId: entry.id,
          causalChain,
          urgency: input.urgency,
        }).pipe(Effect.mapError((error) => unavailable(recipient, error)))
        const result: MessageBotResult = {
          recipientBotId: recipient.id,
          conversationId: recipient.directConversationId,
          entryId: entry.id,
          deliveryId,
        }
        return remember(key, result)
      })

    const messageBot = Effect.fn("Messaging.messageBot")(function*(
      ctx: ToolContext,
      input: { readonly to: string; readonly text: string; readonly urgency: DeliveryUrgency },
    ) {
      const text = yield* validText(input.text, "message")
      return yield* sendToBot("message_bot", ctx, {
        to: input.to,
        text,
        urgency: input.urgency,
        event: (recipient, _sender, entryId) => ({
          type: "messaged-bot",
          toBotId: recipient.id,
          toName: recipient.name,
          conversationId: recipient.directConversationId,
          entryId,
          urgency: input.urgency,
        }),
      })
    })

    const handoffTask = Effect.fn("Messaging.handoffTask")(function*(
      ctx: ToolContext,
      input: { readonly to: string; readonly task: string; readonly context?: string | undefined },
    ) {
      const task = yield* validText(input.task, "task")
      const context = input.context?.trim() ?? ""
      const text = context === "" ? `Task handed off to you:\n${task}` : `Task handed off to you:\n${task}\n\nContext:\n${context}`
      if (text.length > MAX_BOT_MESSAGE_CHARS) {
        return yield* new InvalidInput({ message: `The task and context are longer than ${MAX_BOT_MESSAGE_CHARS} characters.` })
      }
      return yield* sendToBot("handoff_task", ctx, {
        to: input.to,
        text,
        urgency: "urgent",
        event: (recipient, sender) => ({
          type: "handoff",
          fromBotId: sender.id,
          toBotId: recipient.id,
          toName: recipient.name,
          task,
          conversationId: recipient.directConversationId,
        }),
      })
    })

    // ------------------------------------------------------------------ groups (post_to_group)

    const postToGroup = Effect.fn("Messaging.postToGroup")(function*(
      ctx: ToolContext,
      input: { readonly conversationId?: ConversationId | undefined; readonly text: string },
    ) {
      const key = idempotencyKey("post_to_group", ctx)
      if (key !== undefined && done.has(key)) {
        return done.get(key) as { readonly conversationId: ConversationId; readonly entryId: EntryId }
      }
      yield* ensureEnabled
      const text = yield* validText(input.text, "post")
      const sender = yield* senderOf(ctx)
      const conversationId = input.conversationId ?? ctx.claims.conversationId
      const conversation = yield* conversations.get(conversationId)
      if (conversation.kind !== "group") {
        return yield* new InvalidInput({
          message: input.conversationId === undefined
            ? "This conversation is not a group chat. Pass the conversationId of a group you are in."
            : "That conversation is not a group chat.",
        })
      }
      if (!conversation.memberBotIds.includes(sender.id)) {
        return yield* new InvalidInput({ message: `You are not a member of the group "${conversation.title}".` })
      }
      const members = (yield* Effect.forEach(conversation.memberBotIds, (id) => orDie(bots.get(id))))
        .flatMap((b): Array<Bot> => (Option.isSome(b) ? [b.value] : []))
      const targets: ReadonlyArray<BotId> = routeBotMessage({ group: conversation, members, text, senderBotId: sender.id })
      const rootId = yield* ids.next(CoreIdPrefix.delivery)
      const chain = targets.length > 0 ? yield* nextChain(ctx, rootId, conversation.id) : undefined
      const entry = yield* conversations.appendEntry(compact({
        kind: "message" as const,
        conversationId: conversation.id,
        author: { kind: "bot" as const, botId: sender.id },
        role: "bot" as const,
        text,
        attachments: [],
        streaming: false,
        addressedBotIds: targets.length > 0 ? targets : undefined,
      }))
      if (conversation.id !== ctx.claims.conversationId) {
        yield* Effect.ignore(conversations.appendEvent({
          conversationId: ctx.claims.conversationId,
          author: { kind: "bot", botId: sender.id },
          event: { type: "posted-to-group", conversationId: conversation.id, title: conversation.title, entryId: entry.id },
        }))
      }
      for (const target of targets) {
        yield* orchestrator.deliver({
          conversationId: conversation.id,
          botId: target,
          kind: "bot-message",
          text,
          fromBotId: sender.id,
          sourceEntryId: entry.id,
          causalChain: chain,
          urgency: "urgent",
        }).pipe(
          Effect.catch((error) => Effect.logWarning(`Messaging: post_to_group delivery to ${target} failed`, error)),
        )
      }
      return remember(key, { conversationId: conversation.id, entryId: entry.id })
    })

    // ------------------------------------------------------------------ reactions (react)

    const react = Effect.fn("Messaging.react")(function*(
      ctx: ToolContext,
      input: { readonly emoji: string; readonly messageId?: EntryId | undefined },
    ) {
      const emoji = input.emoji.trim()
      if (!isSingleEmoji(emoji)) {
        return yield* new InvalidInput({ message: "react needs exactly one emoji, e.g. \"👍\"." })
      }
      const sender = yield* senderOf(ctx)
      let target: KnownTranscriptEntry | undefined
      if (input.messageId !== undefined) {
        const found = yield* orDie(entries.get(input.messageId))
        if (Option.isNone(found) || found.value.kind !== "message") {
          return yield* new NotFound({ entity: "message", id: input.messageId })
        }
        const conversation = yield* conversations.get(found.value.conversationId)
        const members = conversation.kind === "group" ? conversation.memberBotIds : [conversation.botId]
        if (!members.includes(sender.id)) return yield* new NotFound({ entity: "message", id: input.messageId })
        target = found.value
      } else {
        // The message that triggered this turn: the newest one from someone else here.
        const tail = yield* orDie(entries.page({ conversationId: ctx.claims.conversationId, limit: 50 }))
        target = [...tail.entries].reverse().find((e): e is KnownTranscriptEntry =>
          e.kind === "message" && !(e.author.kind === "bot" && e.author.botId === sender.id)
        )
        if (target === undefined) return yield* new InvalidInput({ message: "There is no message to react to here." })
      }
      const by = { kind: "bot" as const, botId: sender.id }
      yield* conversations.updateEntry(target.id, (entry) => {
        if (entry.kind !== "message") return entry
        const reactions = entry.reactions ?? []
        if (reactions.some((r) => r.emoji === emoji && r.by.kind === "bot" && r.by.botId === sender.id)) return entry
        return { ...entry, reactions: [...reactions, { emoji, by }] }
      })
      return { conversationId: target.conversationId, entryId: target.id, emoji }
    })

    // ------------------------------------------------------------------ files (send_file)

    /** Where `send_file` posts: the current conversation, a group, or a bot's DM (`to`). */
    type FileDestination =
      | { readonly kind: "current"; readonly conversationId: ConversationId }
      | { readonly kind: "group"; readonly conversationId: ConversationId; readonly group: Extract<Conversation, { kind: "group" }>; readonly recipient?: Bot | undefined }
      | { readonly kind: "direct"; readonly conversationId: ConversationId; readonly recipient: Bot }

    const fileDestination = (ctx: ToolContext, sender: Bot, to: string | undefined) =>
      Effect.gen(function*() {
        const ref = to?.trim() ?? ""
        if (ref === "") {
          const conversationId = ctx.claims.conversationId
          const conversation = yield* conversations.get(conversationId)
          if (!conversationBotIds(conversation).includes(sender.id)) {
            return yield* new InvalidInput({ message: "You can only send files into a conversation you are part of." })
          }
          return { kind: "current", conversationId } satisfies FileDestination as FileDestination
        }
        // a group chat (by conversation id) the sender is in
        const asConversation = yield* Effect.option(conversations.get(ref as ConversationId))
        if (Option.isSome(asConversation)) {
          const group = asConversation.value
          if (group.kind !== "group" || !group.memberBotIds.includes(sender.id)) {
            return yield* new InvalidInput({ message: "`to` must be a Bot or a group chat you are a member of." })
          }
          return { kind: "group", conversationId: group.id, group } satisfies FileDestination as FileDestination
        }
        yield* ensureEnabled
        const recipient = yield* resolveBot(ref)
        if (recipient.id === sender.id) {
          return yield* new InvalidInput({ message: "You cannot send files to yourself. Leave out `to` to send them to the owner." })
        }
        // in a group turn with the recipient: the files stay in the group (D5.2)
        const group = yield* sharedGroup(ctx, sender, recipient)
        if (group !== undefined) return { kind: "group", conversationId: group.id, group, recipient } satisfies FileDestination as FileDestination
        return { kind: "direct", conversationId: recipient.directConversationId, recipient } satisfies FileDestination as FileDestination
      })

    /** One file from a node into the attachment store (streamed; the node's path policy applies). */
    const importOne = (
      input: { readonly nodeId: NodeId; readonly inv: Invocation; readonly cwd?: string | undefined; readonly progress?: ((message: string) => Effect.Effect<void>) | undefined },
      path: string,
      count: number,
    ) =>
      Effect.scoped(Effect.gen(function*() {
        const download = yield* nodeFiles.download({
          nodeId: input.nodeId,
          inv: input.inv,
          path,
          cwd: input.cwd,
          maxBytes: sendLimits.maxFileBytes,
        })
        const mime = detectMime(download.name, download.head)
        const size = imageDimensions(mime, download.head)
        if (input.progress !== undefined) yield* input.progress(`Sending ${download.name} (${formatBytes(download.size)})…`)
        const attachment: Attachment = yield* storeAttachmentStream(attachmentStore, {
          name: download.name,
          mime,
          chunks: download.chunks,
          width: size?.width,
          height: size?.height,
        })
        return { attachment, path: download.path } satisfies SentFile
      })).pipe(
        Effect.mapError((error) =>
          new InvalidInput({
            message: count === 1
              ? `Could not send ${path}: ${describeSendFailure(error)}`
              : `Could not send ${path}: ${describeSendFailure(error)}. Nothing was sent; fix it (or leave it out) and try again.`,
          })
        ),
      )

    const importFiles = Effect.fn("Messaging.importFiles")(function*(input: Parameters<Messaging["Service"]["importFiles"]>[0]) {
      const paths = [...new Set(input.paths.map((p) => p.trim()).filter((p) => p.length > 0))]
      if (paths.length === 0) return []
      if (paths.length > sendLimits.maxFiles) {
        return yield* new InvalidInput({ message: `At most ${sendLimits.maxFiles} files at once; archive the rest (zip/tar) first.` })
      }
      const stored: Array<Attachment> = []
      return yield* Effect.forEach(paths, (path) =>
        importOne(input, path, paths.length).pipe(
          Effect.map((file) => file.attachment),
          Effect.tap((attachment) => Effect.sync(() => stored.push(attachment))),
        )).pipe(
          // a later file failed: drop the ones already stored
          Effect.tapError(() => Effect.forEach(stored, (a) => Effect.ignore(attachmentStore.delete(a.id)), { discard: true })),
        )
    })

    const sendFiles = Effect.fn("Messaging.sendFiles")(function*(
      ctx: ToolContext,
      input: Parameters<Messaging["Service"]["sendFiles"]>[1],
    ) {
      const key = idempotencyKey("send_file", ctx)
      if (key !== undefined && done.has(key)) return { ...(done.get(key) as SendFilesResult), replayed: true }
      const sender = yield* senderOf(ctx)
      const destination = yield* fileDestination(ctx, sender, input.to)
      const conversationId = destination.conversationId
      // Durable idempotency (a retried call after the MCP session was re-created): the posted entry.
      const nonce = ctx.callId === undefined ? undefined : `send_file:${sender.id}:${ctx.callId}`
      if (nonce !== undefined) {
        const posted = yield* orDie(entries.findByClientNonce(conversationId, nonce))
        if (Option.isSome(posted) && posted.value.kind === "message") {
          return compact({
            conversationId,
            entryId: posted.value.id,
            files: posted.value.attachments.map((attachment) => ({ attachment, path: attachment.name })),
            destination: destination.kind,
            recipientBotId: destination.kind === "current" ? undefined : destination.recipient?.id,
            replayed: true,
          }) satisfies SendFilesResult
        }
      }
      const paths = [...new Set(input.paths.map((p) => p.trim()).filter((p) => p.length > 0))]
      if (paths.length === 0) return yield* new InvalidInput({ message: "Pass `path` (or `paths`): the file(s) to send." })
      if (paths.length > sendLimits.maxFiles) {
        return yield* new InvalidInput({
          message: `send_file sends at most ${sendLimits.maxFiles} files per call; send the rest in another call or archive them (zip/tar) first.`,
        })
      }
      const caption = input.caption?.trim() ?? ""
      if (caption.length > MAX_BOT_MESSAGE_CHARS) {
        return yield* new InvalidInput({ message: `The caption is longer than ${MAX_BOT_MESSAGE_CHARS} characters.` })
      }
      // deliveries to other bots extend the causal chain (hop limit), checked before any transfer
      const deliveryId = yield* ids.next(CoreIdPrefix.delivery)
      const members = destination.kind === "group" && destination.recipient === undefined
        ? (yield* Effect.forEach(destination.group.memberBotIds, (id) => orDie(bots.get(id))))
          .flatMap((b): Array<Bot> => (Option.isSome(b) ? [b.value] : []))
        : []
      const targets: ReadonlyArray<BotId> = destination.kind === "current"
        ? []
        : destination.kind === "direct" || destination.recipient !== undefined
        ? [destination.recipient!.id]
        : routeBotMessage({ group: destination.group, members, text: caption, senderBotId: sender.id })
      const chain = targets.length > 0 ? yield* nextChain(ctx, deliveryId, ctx.claims.conversationId) : undefined

      const sendOne = (path: string) => importOne(input, path, paths.length)

      const sent: Array<SentFile> = []
      const stored = yield* Effect.forEach(paths, (path) => Effect.tap(sendOne(path), (file) => Effect.sync(() => sent.push(file)))).pipe(
        // a later file failed (or the call was cancelled): drop the files already stored
        Effect.onError(() =>
          Effect.forEach(sent, (file) => Effect.ignore(attachmentStore.delete(file.attachment.id)), { discard: true })
        ),
      )
      const attachments = stored.map((file) => file.attachment)
      const entry = yield* conversations.appendEntry(compact({
        kind: "message" as const,
        conversationId,
        author: { kind: "bot" as const, botId: sender.id },
        role: "bot" as const,
        text: caption,
        attachments,
        streaming: false,
        clientNonce: nonce,
        // part of the sender's turn only where that turn is
        turnId: conversationId === ctx.claims.conversationId ? ctx.turnId : undefined,
        toBotId: destination.kind === "direct" ? destination.recipient.id : undefined,
        addressedBotIds: destination.kind === "group" && targets.length > 0 ? targets : undefined,
      }))
      if (destination.kind === "direct") {
        const senderTurn = ctx.taskId !== undefined ? Option.none() : yield* orchestrator.activeTurn(sender.id)
        yield* Effect.ignore(conversations.appendEvent({
          conversationId: ctx.claims.conversationId,
          author: { kind: "bot", botId: sender.id },
          event: {
            type: "messaged-bot",
            toBotId: destination.recipient.id,
            toName: destination.recipient.name,
            conversationId: destination.recipient.directConversationId,
            entryId: entry.id,
            urgency: "background",
          },
          turnId: Option.isSome(senderTurn) ? senderTurn.value.id : undefined,
        }))
      } else if (destination.kind === "group" && conversationId !== ctx.claims.conversationId) {
        yield* Effect.ignore(conversations.appendEvent({
          conversationId: ctx.claims.conversationId,
          author: { kind: "bot", botId: sender.id },
          event: { type: "posted-to-group", conversationId, title: destination.group.title, entryId: entry.id },
        }))
      }
      // the recipients read the caption and get the files copied into their workspace (BotRunner)
      const deliveryText = caption !== "" ? caption : `Sent you ${attachments.length === 1 ? attachments[0]!.name : `${attachments.length} files`}.`
      for (const [i, target] of targets.entries()) {
        yield* orchestrator.deliver({
          ...(i === 0 ? { id: deliveryId } : {}),
          conversationId,
          botId: target,
          kind: "bot-message",
          text: deliveryText,
          attachmentIds: attachments.map((a) => a.id),
          fromBotId: sender.id,
          sourceEntryId: entry.id,
          causalChain: chain,
          urgency: "background",
        }).pipe(
          Effect.catch((error) => Effect.logWarning(`Messaging: send_file delivery to ${target} failed`, error)),
        )
      }
      return remember(key, compact({
        conversationId,
        entryId: entry.id,
        files: stored,
        destination: destination.kind,
        recipientBotId: destination.kind === "current" ? undefined : destination.recipient?.id,
      }) satisfies SendFilesResult)
    })

    return Messaging.of({ messageBot, postToGroup, handoffTask, react, sendFiles, importFiles })
  }),
)

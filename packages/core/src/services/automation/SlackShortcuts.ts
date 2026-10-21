/**
 * Slack's "Send to OpenBot" (D3.4): the owner's click on a message in Slack posts it into a Bot's
 * chat as the owner's own message (where it came from, who wrote it, the start of it, its link) and
 * wakes the Bot, which reads the thread with its Slack tools. Slack shows the owner "Sent to ‹Bot›".
 * The Bot: Settings `slackSendTo`, else the one the owner chatted with last.
 */
import type { Bot } from "@openbot/contracts"
import { Clock, Effect, Layer, Option, Stream } from "effect"
import { BotRepo } from "../../ports/repos.ts"
import { ConversationService, Orchestrator, SettingsService } from "../../ports/services.ts"
import { SlackConnector, type SlackShortcut } from "../../ports/Slack.ts"
import { describeSlackPlace } from "./SlackService.ts"
import { truncate } from "./text.ts"

/** What the Bot's chat shows (as the owner's message). */
export const slackShortcutText = (shortcut: Pick<SlackShortcut, "conversation" | "message">): string => {
  const { conversation, message } = shortcut
  const text = message.text.trim()
  const quote = text === "" ? [] : truncate(text, 600).split("\n").map((line) => `> ${line}`)
  const files = message.files === undefined || message.files.length === 0 ? [] : [`> [files: ${message.files.join(", ")}]`]
  return [`From Slack, ${describeSlackPlace(conversation)} (${message.author}):`, ...quote, ...files, message.permalink].join("\n")
}

const whyNot = (error: { readonly _tag: string }): string => {
  const message = (error as { readonly message?: unknown }).message
  return typeof message === "string" && message !== "" ? message : error._tag
}

export const SlackShortcutsLive: Layer.Layer<never, never, Orchestrator | SettingsService | BotRepo | ConversationService> = Layer.effectDiscard(
  Effect.gen(function*() {
    const slack = Option.getOrUndefined(yield* Effect.serviceOption(SlackConnector))
    if (slack === undefined) return
    const orchestrator = yield* Orchestrator
    const settings = yield* SettingsService
    const bots = yield* BotRepo
    const conversations = yield* ConversationService

    /** The chosen Bot, else the one whose chat with the owner moved last. */
    const recipient = Effect.gen(function*() {
      const { slackSendTo } = yield* settings.get
      if (slackSendTo !== undefined) {
        const chosen = yield* bots.get(slackSendTo).pipe(Effect.orDie)
        if (Option.isSome(chosen)) return chosen.value
      }
      const recent = (yield* conversations.summaries)
        .filter((c) => c.kind === "direct" && c.botIds.length > 0)
        .toSorted((a, b) => b.lastActivityAt - a.lastActivityAt)
      for (const chat of recent) {
        const bot = yield* bots.get(chat.botIds[0]!).pipe(Effect.orDie)
        if (Option.isSome(bot)) return bot.value
      }
      return undefined as Bot | undefined
    })

    const forward = (shortcut: SlackShortcut) =>
      Effect.gen(function*() {
        const bot = yield* recipient
        if (bot === undefined) return yield* shortcut.reply("There's no Bot in OpenBot yet: create one first.")
        const now = yield* Clock.currentTimeMillis
        yield* orchestrator.send({
          conversationId: bot.directConversationId,
          text: slackShortcutText(shortcut),
          clientNonce: `slack-${shortcut.message.channelId}-${shortcut.message.ts}-${now}`,
        })
        yield* shortcut.reply(`Sent to ${bot.name} in OpenBot.`)
      }).pipe(
        Effect.catch((error) => shortcut.reply(`Couldn't send it to OpenBot (${whyNot(error)}).`)),
        Effect.catchDefect((defect) =>
          Effect.logError("SlackShortcuts: not forwarded", defect).pipe(Effect.andThen(shortcut.reply("Couldn't send it to OpenBot.")))
        ),
      )

    yield* slack.shortcuts.pipe(
      Stream.runForEach(forward),
      Effect.catchCause((cause) => Effect.logWarning("SlackShortcuts: clicks ended", cause)),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
)

/**
 * Notifier (architecture §3.5): web notifications in v1. Honors the bot's `notify` preference and
 * publishes a roster `notification` change.
 *
 * Preference rules: `all` → every kind; `mentions` → only what needs the owner (`waiting`, `error`);
 * `none` → nothing (returns `undefined`).
 *
 * A Bot's notification while its profile isn't the active one is held for that profile's "While you
 * were away" list instead, so neither the apps nor the pushes show it. A switch waits for the publish or
 * hold, so a notification sent while the owner switches still reaches one of the two. Notifications
 * without a Bot (sign-in requests, updates) belong to the whole brain and are always published.
 */
import type { Notification, NotificationKind } from "@openbot/contracts"
import { Clock, Effect, Layer, Option } from "effect"
import { IdGen } from "../../ports/IdGen.ts"
import { Notifier } from "../../ports/Notifier.ts"
import { HeldNotificationRepo, OwnerProfiles } from "../../ports/Profiles.ts"
import { BotRepo } from "../../ports/repos.ts"
import { LiveHub } from "../../ports/services.ts"
import { compact, orDie } from "./internal/util.ts"

const MENTION_KINDS: ReadonlyArray<NotificationKind> = ["waiting", "error"]

/** Held notifications kept per profile; older ones are dropped and counted. */
export const HELD_KEPT = 500

export const NotifierLive: Layer.Layer<
  Notifier,
  never,
  LiveHub | BotRepo | IdGen | OwnerProfiles | HeldNotificationRepo
> = Layer.effect(
  Notifier,
  Effect.gen(function* () {
    const hub = yield* LiveHub
    const bots = yield* BotRepo
    const ids = yield* IdGen
    const profiles = yield* OwnerProfiles
    const held = yield* HeldNotificationRepo
    return Notifier.of({
      notify: Effect.fn("Notifier.notify")(function* (input) {
        const bot = input.botId === undefined ? Option.none() : yield* orDie(bots.get(input.botId))
        if (Option.isSome(bot)) {
          if (bot.value.notify === "none") return undefined
          if (bot.value.notify === "mentions" && !MENTION_KINDS.includes(input.kind)) return undefined
        }
        const notification: Notification = compact({
          id: yield* ids.notificationId,
          kind: input.kind,
          botId: input.botId,
          conversationId: input.conversationId,
          title: input.title,
          body: input.body,
          at: yield* Clock.currentTimeMillis,
        })
        if (Option.isNone(bot)) {
          yield* hub.publishRoster({ type: "notification", notification })
          return notification
        }
        yield* profiles.withActive((activeId) =>
          bot.value.ownerProfileId === activeId
            ? hub.publishRoster({ type: "notification", notification })
            : orDie(
                held.hold(
                  bot.value.ownerProfileId,
                  { notification, needsYou: MENTION_KINDS.includes(input.kind), botName: bot.value.name },
                  HELD_KEPT,
                ),
              ),
        )
        return notification
      }),
    })
  }),
)

/** Which profile a piece of background work belongs to: the profile of the Bot it runs for. */
import type { BotId, Conversation, OwnerProfileId } from "@openbot/contracts"
import { Effect, Option } from "effect"
import { inProfile } from "../../ports/Profiles.ts"
import { BotRepo } from "../../ports/repos.ts"

export const profileOfBot = (botId: BotId): Effect.Effect<OwnerProfileId, never, BotRepo> =>
  Effect.flatMap(BotRepo, (bots) =>
    Effect.flatMap(Effect.orDie(bots.get(botId)), (bot) =>
      Option.isSome(bot) ? Effect.succeed(bot.value.ownerProfileId) : Effect.die(new Error(`Bot ${botId} is gone`)),
    ),
  )

/** Runs `effect` in the profile of `botId`. */
export const inBotProfile =
  (botId: BotId) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(profileOfBot(botId), (profileId) => inProfile(profileId)(effect))

/** A chat belongs to the profile of its Bots (a group never mixes profiles). */
export const hasMemberIn = (conversation: Conversation, botIds: ReadonlySet<BotId>): boolean =>
  conversation.kind === "group"
    ? conversation.memberBotIds.some((id) => botIds.has(id))
    : botIds.has(conversation.botId)

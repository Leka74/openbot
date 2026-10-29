/**
 * ProfileRemoval: every Bot of the profile stops first (nothing of it runs or answers while its data
 * goes), then its data goes through the same paths as deleting it by hand would, then its folders move
 * aside and the profile is forgotten. Once started it runs to the end; what fails leaves the profile
 * listed, and deleting it again picks up where it stopped.
 */
import { type OwnerProfileId } from "@openbot/contracts"
import { Effect, Layer } from "effect"
import { HarnessRegistry } from "../../ports/Harness.ts"
import { ProfileDirs } from "../../ports/ProfileDirs.ts"
import { inProfile, OwnerProfiles, ProfileRemoval, ProfileStorage } from "../../ports/Profiles.ts"
import { ApprovalRuleRepo, BotRepo, ConversationRepo, SectionRepo } from "../../ports/repos.ts"
import { BotService, LiveHub, Orchestrator, SettingsService } from "../../ports/services.ts"
import { SlackConnector } from "../../ports/Slack.ts"
import { SkillStore } from "../../ports/stores.ts"
import { hasMemberIn } from "./lookup.ts"

export const ProfileRemovalLive: Layer.Layer<
  ProfileRemoval,
  never,
  | OwnerProfiles
  | BotService
  | Orchestrator
  | SettingsService
  | LiveHub
  | BotRepo
  | ConversationRepo
  | SectionRepo
  | ApprovalRuleRepo
  | ProfileStorage
  | ProfileDirs
  | SkillStore
  | SlackConnector
  | HarnessRegistry
> = Layer.effect(
  ProfileRemoval,
  Effect.gen(function* () {
    const profiles = yield* OwnerProfiles
    const botService = yield* BotService
    const orchestrator = yield* Orchestrator
    const settingsService = yield* SettingsService
    const hub = yield* LiveHub
    const bots = yield* BotRepo
    const conversations = yield* ConversationRepo
    const sections = yield* SectionRepo
    const rules = yield* ApprovalRuleRepo
    const storage = yield* ProfileStorage
    const dirs = yield* ProfileDirs
    const skills = yield* SkillStore
    const slack = yield* SlackConnector
    const harnesses = yield* HarnessRegistry

    const purge = (id: OwnerProfileId) =>
      Effect.gen(function* () {
        const members = yield* Effect.orDie(bots.listIn(id))
        const memberIds = new Set(members.map((bot) => bot.id))
        for (const bot of members) yield* inProfile(id)(Effect.orDie(botService.halt(bot.id)))
        const groups = (yield* Effect.orDie(conversations.list({ kind: "group" }))).filter((c) =>
          hasMemberIn(c, memberIds),
        )
        for (const group of groups) yield* Effect.orDie(orchestrator.deleteConversation(group.id))
        for (const bot of members) yield* inProfile(id)(Effect.orDie(botService.delete(bot.id)))
        for (const section of yield* Effect.orDie(sections.list(id))) yield* Effect.orDie(sections.delete(section.id))
        for (const rule of yield* Effect.orDie(rules.list({ profileId: id })))
          yield* Effect.orDie(rules.delete(rule.id))
        yield* Effect.orDie(
          storage.purge(id, { botIds: [...memberIds], conversationIds: groups.map((group) => group.id) }),
        )
        yield* settingsService.forgetProfile(id)
        yield* slack.forget(id)
        yield* skills.forget(id)
        yield* harnesses.forgetOwnerProfile(id)
        yield* Effect.orDie(dirs.retire(id))
      })

    return ProfileRemoval.of({
      remove: (id) => Effect.uninterruptible(Effect.andThen(profiles.remove(id, purge(id)), hub.dropRoster(id))),
    })
  }),
)

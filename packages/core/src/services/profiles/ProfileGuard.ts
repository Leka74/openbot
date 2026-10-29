/**
 * ProfileGuard: what the owner names in a request must belong to the profile it works in. The RPC
 * edge checks every payload: each id under a known key (`botId`, `conversationId`, `entryId`, …, at
 * any depth) is looked up, and one of another profile (or of none) fails the request with `NotFound`,
 * as if it did not exist.
 */
import type {
  ApprovalRuleId,
  AttachmentId,
  BotId,
  ConversationId,
  EntryId,
  OwnerProfileId,
  RequestId,
  RoutineId,
  SectionId,
  TaskId,
  TurnId,
} from "@openbot/contracts"
import { NotFound } from "@openbot/contracts"
import { Context, Effect, Layer, Option } from "effect"
import { currentProfileId, type CurrentProfile } from "../../ports/Profiles.ts"
import {
  ApprovalRuleRepo,
  BotRepo,
  ConversationRepo,
  EntryRepo,
  RequestRepo,
  RoutineRepo,
  SectionRepo,
  TaskRepo,
  TurnRepo,
} from "../../ports/repos.ts"
import type { RepoError } from "../../ports/errors.ts"
import { AttachmentStore } from "../../ports/stores.ts"

type Entity =
  "bot" | "conversation" | "section" | "routine" | "task" | "request" | "entry" | "turn" | "rule" | "attachment"

const ID_KEYS: Readonly<Record<string, Entity>> = {
  botId: "bot",
  botIds: "bot",
  peerBotId: "bot",
  leadBotId: "bot",
  memberBotIds: "bot",
  conversationId: "conversation",
  conversationIds: "conversation",
  sectionId: "section",
  sectionIds: "section",
  routineId: "routine",
  taskId: "task",
  requestId: "request",
  entryId: "entry",
  turnId: "turn",
  ruleId: "rule",
  attachmentId: "attachment",
  attachmentIds: "attachment",
}

/** Every `[entity, id]` under a known key, at any depth. */
export const namedIds = (payload: unknown): ReadonlyArray<readonly [Entity, string]> => {
  const found: Array<readonly [Entity, string]> = []
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const [key, field] of Object.entries(value)) {
      const entity = ID_KEYS[key]
      if (entity === undefined) visit(field)
      else if (typeof field === "string") found.push([entity, field])
      else if (Array.isArray(field)) for (const id of field) if (typeof id === "string") found.push([entity, id])
    }
  }
  visit(payload)
  return found
}

export class ProfileGuard extends Context.Service<
  ProfileGuard,
  { readonly check: (payload: unknown) => Effect.Effect<void, NotFound, CurrentProfile> }
>()("openbot/core/ProfileGuard") {}

export const ProfileGuardLive: Layer.Layer<
  ProfileGuard,
  never,
  | BotRepo
  | ConversationRepo
  | SectionRepo
  | RoutineRepo
  | TaskRepo
  | RequestRepo
  | EntryRepo
  | TurnRepo
  | ApprovalRuleRepo
  | AttachmentStore
> = Layer.effect(
  ProfileGuard,
  Effect.gen(function* () {
    const bots = yield* BotRepo
    const conversations = yield* ConversationRepo
    const sections = yield* SectionRepo
    const routines = yield* RoutineRepo
    const tasks = yield* TaskRepo
    const requests = yield* RequestRepo
    const entries = yield* EntryRepo
    const turns = yield* TurnRepo
    const rules = yield* ApprovalRuleRepo
    const attachments = yield* AttachmentStore

    type Owner = Effect.Effect<Option.Option<OwnerProfileId>>
    const via = <A>(lookup: Effect.Effect<Option.Option<A>, RepoError>, next: (found: A) => Owner): Owner =>
      Effect.flatMap(Effect.orDie(lookup), (found) =>
        Option.isSome(found) ? next(found.value) : Effect.succeed(Option.none()),
      )
    const ofBot = (id: BotId): Owner => via(bots.get(id), (bot) => Effect.succeedSome(bot.ownerProfileId))
    const ofConversation = (id: ConversationId): Owner =>
      Effect.flatMap(Effect.orDie(conversations.members(id)), (members) =>
        members[0] === undefined ? Effect.succeedNone : ofBot(members[0]),
      )

    const ownerOf = (entity: Entity, id: string): Owner => {
      switch (entity) {
        case "bot":
          return ofBot(id as BotId)
        case "conversation":
          return ofConversation(id as ConversationId)
        case "section":
          return via(sections.get(id as SectionId), (section) => Effect.succeedSome(section.ownerProfileId))
        case "routine":
          return via(routines.get(id as RoutineId), (routine) => ofBot(routine.botId))
        case "task":
          return via(tasks.get(id as TaskId), (task) => ofBot(task.botId))
        case "request":
          return via(requests.get(id as RequestId), (request) => ofBot(request.botId))
        case "entry":
          return via(entries.get(id as EntryId), (entry) => ofConversation(entry.conversationId))
        case "turn":
          return via(turns.get(id as TurnId), (turn) => ofConversation(turn.conversationId))
        case "rule":
          return via(rules.get(id as ApprovalRuleId), (rule) => Effect.succeedSome(rule.ownerProfileId))
        case "attachment":
          return via(attachments.get(id as AttachmentId), (record) => Effect.succeedSome(record.ownerProfileId))
      }
    }

    return ProfileGuard.of({
      check: (payload) =>
        Effect.gen(function* () {
          const named = namedIds(payload)
          if (named.length === 0) return
          const profileId = yield* currentProfileId
          for (const [entity, id] of named) {
            const owner = yield* ownerOf(entity, id)
            if (Option.isNone(owner) || owner.value !== profileId) return yield* new NotFound({ entity, id })
          }
        }),
    })
  }),
)

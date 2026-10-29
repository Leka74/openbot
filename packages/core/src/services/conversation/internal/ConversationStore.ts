/**
 * Internal conversation-record store shared by ConversationService, the Orchestrator (TurnIngest,
 * context ring, new session) and BotService. NOT exported from the package.
 *
 * It owns the two read-modify-write locks of the conversation services:
 * - `update`: Conversation records (lastActivityAt, unread, sessions, epoch, members, title);
 * - `withEntryLock`: transcript entry read-modify-writes (`ConversationService.updateEntry`).
 *
 * Every service layer of this WP provides it from the same layer VALUE (`ConversationStoreLive`), so
 * Effect's layer memoization builds it once per app layer and the locks are shared.
 */
import type { Conversation, ConversationId, EntryId } from "@openbot/contracts"
import { Context, Effect, Layer, Option, Semaphore } from "effect"
import {
  BotRepo,
  ConversationRepo,
  conversationReplicaKey,
  EntryRepo,
  ReplicaLog,
  RequestRepo,
  TurnRepo,
} from "../../../ports/repos.ts"
import { LiveHub } from "../../../ports/services.ts"
import { summarize } from "./summary.ts"
import { compact, orDie, required } from "./util.ts"
import type { NotFound } from "@openbot/contracts"

export class ConversationStore extends Context.Service<
  ConversationStore,
  {
    readonly get: (id: ConversationId) => Effect.Effect<Conversation, NotFound>
    /** Persists a new conversation and publishes it (conversation replica + roster). */
    readonly create: (conversation: Conversation) => Effect.Effect<Conversation>
    /**
     * Locked read-modify-write. Unchanged results are not written. Publishes `conversation.updated`
     * and the roster summary.
     */
    readonly update: (
      id: ConversationId,
      f: (current: Conversation) => Conversation,
    ) => Effect.Effect<Conversation, NotFound>
    /** Re-publishes the roster row when it changed (preview, pending request count, …). */
    readonly publishSummary: (id: ConversationId) => Effect.Effect<void>
    /**
     * Deletes a conversation with its entries, turns, requests and replica log; publishes roster
     * `conversation.removed`.
     */
    readonly remove: (id: ConversationId) => Effect.Effect<void>
    /** Serializes transcript entry read-modify-writes. */
    readonly withEntryLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  }
>()("openbot/core/internal/ConversationStore") {}

const stable = (value: unknown): string => JSON.stringify(value)

export const ConversationStoreLive: Layer.Layer<
  ConversationStore,
  never,
  LiveHub | ConversationRepo | EntryRepo | RequestRepo | TurnRepo | ReplicaLog | BotRepo
> = Layer.effect(
  ConversationStore,
  Effect.gen(function* () {
    const hub = yield* LiveHub
    const conversations = yield* ConversationRepo
    const bots = yield* BotRepo
    const entries = yield* EntryRepo
    const requests = yield* RequestRepo
    const turns = yield* TurnRepo
    const replicas = yield* ReplicaLog
    const repos = yield* Effect.context<EntryRepo | RequestRepo | TurnRepo>()
    const lock = yield* Semaphore.make(1)
    const entryLock = yield* Semaphore.make(1)
    const published = new Map<ConversationId, string>()

    const publishSummaryOf = (conversation: Conversation) =>
      Effect.gen(function* () {
        const summary = yield* Effect.provide(summarize(conversation), repos)
        const key = stable(summary)
        if (published.get(conversation.id) === key) return
        published.set(conversation.id, key)
        yield* hub.publishRoster({ type: "conversation.upserted", conversation: summary })
      })

    const get = (id: ConversationId) => required(conversations.get(id), "conversation", id)

    return ConversationStore.of({
      get,
      create: (conversation) =>
        Effect.gen(function* () {
          const value = compact(conversation)
          yield* orDie(conversations.upsert(value))
          yield* hub.publishConversation(value.id, { type: "conversation.updated", conversation: value })
          yield* publishSummaryOf(value)
          return value
        }),
      update: (id, f) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* get(id)
            const next = compact(f(current))
            if (stable(next) === stable(current)) return current
            yield* orDie(conversations.upsert(next))
            yield* hub.publishConversation(id, { type: "conversation.updated", conversation: next })
            yield* publishSummaryOf(next)
            return next
          }),
        ),
      publishSummary: (id) =>
        Effect.flatMap(orDie(conversations.get(id)), (found) =>
          Option.isSome(found) ? publishSummaryOf(found.value) : Effect.void,
        ),
      remove: (id) =>
        Effect.gen(function* () {
          const [member] = yield* orDie(conversations.members(id))
          // Entries first (paged from the tail), then turns, requests, the replica log and the record.
          for (;;) {
            const page = yield* orDie(entries.page({ conversationId: id, limit: 500 }))
            if (page.entries.length === 0) break
            yield* Effect.forEach(page.entries, (e) => orDie(entries.remove(e.id as EntryId)), { discard: true })
          }
          yield* orDie(turns.deleteByConversation(id))
          yield* orDie(requests.deleteByConversation(id))
          yield* orDie(replicas.drop(conversationReplicaKey(id)))
          const removed = yield* orDie(conversations.delete(id))
          published.delete(id)
          if (removed && member !== undefined) {
            const owner = yield* orDie(bots.get(member))
            if (Option.isSome(owner)) {
              yield* hub.publishRoster({ type: "conversation.removed", conversationId: id }, owner.value.ownerProfileId)
            }
          }
        }),
      withEntryLock: (effect) => entryLock.withPermits(1)(effect),
    })
  }),
)

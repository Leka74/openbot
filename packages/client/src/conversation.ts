// Conversation replicas: `conversations.subscribe` with resume + the contracts reducer, one atom per
// conversation (architecture §4.10). The state cell outlives the subscription for 5 idle minutes, so
// navigating back resumes from the cursor (replay) instead of re-downloading a snapshot
// (t3code-architecture.md §4.3).
import { Effect, Stream } from "effect"
import { presentationIntervalMs } from "./presentation.ts"
import {
  applyConversationStreamItem,
  type ConversationId,
  type ConversationState,
  emptyConversationState,
  pendingRequestsOf,
  prependHistory,
  type RuntimeRequest,
  type TranscriptEntry,
  transcriptOf,
  type Turn,
} from "@openbot/contracts"
import { AsyncResult, Atom, AtomRegistry, Reactivity } from "effect/reactivity"
import { clientConfigAtom } from "./config.ts"
import { keysForConversationChange } from "./keys.ts"
import { outboxAtom } from "./outbox.ts"
import { isRetryableSubscribeError, waitForRetry } from "./replica.ts"
import { makeReplicaHolder, type ReplicaHolder, replicaStream, updateReplica } from "./resume.ts"
import { OpenBotClient } from "./rpc.ts"

/** How long a conversation's state and cursor are kept after its last subscriber unmounts. */
export const CONVERSATION_CACHE_TTL = "5 minutes"
/** Entries per `conversations.history` page. */
export const HISTORY_PAGE_SIZE = 50

export const conversationHolderAtom = Atom.family((conversationId: ConversationId) =>
  Atom.make(() => makeReplicaHolder<ConversationState>(emptyConversationState)).pipe(
    Atom.setIdleTTL(CONVERSATION_CACHE_TTL),
    Atom.withLabel(`openbot/conversationHolder/${conversationId}`),
  ),
)

/**
 * Live conversation state: `{conversation, entries, requests, turns, synchronized, cursor, …}`
 * (`ConversationState` from contracts). Fails with `NotFound` when the conversation is gone.
 */
export const conversationAtom = Atom.family((conversationId: ConversationId) =>
  OpenBotClient.runtime
    .atom((get) => {
      const holder: ReplicaHolder<ConversationState> = get(conversationHolderAtom(conversationId))
      const backoff = get(clientConfigAtom).resubscribe
      return Stream.unwrap(
        Effect.gen(function* () {
          const client = yield* OpenBotClient
          const registry = yield* AtomRegistry.AtomRegistry
          const reactivity = yield* Reactivity.Reactivity
          return replicaStream({
            publishIntervalMs: presentationIntervalMs,
            holder,
            open: (after) => client("conversations.subscribe", after ? { conversationId, after } : { conversationId }),
            reduce: applyConversationStreamItem,
            cursor: (s) => s.cursor,
            hasGap: (s) => s.gap,
            markStale: (s) => (s.synchronized ? { ...s, synchronized: false } : s),
            isRetryable: isRetryableSubscribeError,
            backoff,
            wait: waitForRetry(registry),
            onItem: (item) => {
              if (item.kind !== "change") return Effect.void
              const change = item.change
              // A delivered message settles its optimistic outbox item (matched by clientNonce).
              if (
                change.type === "entry.upserted" &&
                change.entry.kind === "message" &&
                change.entry.clientNonce !== undefined
              ) {
                const nonce = change.entry.clientNonce
                const outbox = outboxAtom(conversationId)
                if (registry.get(outbox).some((o) => o.clientNonce === nonce)) {
                  registry.update(outbox, (items) => items.filter((o) => o.clientNonce !== nonce))
                }
              }
              const keys = keysForConversationChange(change)
              return keys.length > 0 ? reactivity.invalidate(keys) : Effect.void
            },
          })
        }),
      )
    })
    .pipe(Atom.withLabel(`openbot/conversation/${conversationId}`)),
)

const mapConversation = <A>(conversationId: ConversationId, f: (state: ConversationState) => A) =>
  Atom.make((get) => AsyncResult.map(get(conversationAtom(conversationId)), f))

/** Entries in transcript order. */
export const transcriptAtom = Atom.family((conversationId: ConversationId) =>
  mapConversation(conversationId, (s): ReadonlyArray<TranscriptEntry> => transcriptOf(s)),
)
/** Pending runtime requests (approval / question cards awaiting the owner), oldest first. */
export const pendingRequestsAtom = Atom.family((conversationId: ConversationId) =>
  mapConversation(conversationId, (s): ReadonlyArray<RuntimeRequest> => pendingRequestsOf(s)),
)
/** Turns that are queued, running or waiting (drives the activity row and the stop button). */
export const activeTurnsAtom = Atom.family((conversationId: ConversationId) =>
  mapConversation(conversationId, (s): ReadonlyArray<Turn> =>
    [...s.turns.values()]
      .filter((t) => t.status === "queued" || t.status === "running" || t.status === "waiting")
      .sort((a, b) => a.startedAt - b.startedAt),
  ),
)

/**
 * Loads the next older page (`conversations.history`) into the cached replica. Succeeds with the
 * number of entries added (0 when there is nothing older).
 */
export const loadOlderAtom = OpenBotClient.runtime.fn((conversationId: ConversationId, get) =>
  Effect.gen(function* () {
    const holder = get(conversationHolderAtom(conversationId))
    const { beforeCursor, hasMoreBefore } = holder.state
    if (!hasMoreBefore || beforeCursor === null) return 0
    const client = yield* OpenBotClient
    const page = yield* client("conversations.history", {
      conversationId,
      beforeCursor,
      limit: HISTORY_PAGE_SIZE,
    })
    const before = holder.state.entries.size
    const next = updateReplica(holder, (s) => prependHistory(s, page))
    return next.entries.size - before
  }),
)

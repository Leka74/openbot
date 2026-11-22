// Roster replica (sidebar): `roster.subscribe` with resume + the contracts reducer (D4.3,
// architecture §4.10). Value: `AsyncResult<RosterState>` — bots, conversations, activities, nodes,
// sections, settings and recent notifications. `state.synchronized` is false while catching up or
// reconnecting; `AsyncResult.waiting` is always true for a live stream, so use `synchronized`.
import { Effect, Stream } from "effect"
import { presentationIntervalMs } from "./presentation.ts"
import {
  activeTasksOf,
  applyRosterStreamItem,
  type Bot,
  type BotActivity,
  type BotId,
  type ConversationId,
  type ConversationSummary,
  DEFAULT_SETTINGS,
  emptyRosterState,
  type NodeSummary,
  type Notification,
  type RosterState,
  type Section,
  sectionsOf,
  type Settings,
  type Task,
} from "@openbot/contracts"
import { AsyncResult, Atom, AtomRegistry, Reactivity } from "effect/reactivity"
import { clientConfigAtom } from "./config.ts"
import { keysForRosterChange } from "./keys.ts"
import { isRetryableSubscribeError, waitForRetry } from "./replica.ts"
import { makeReplicaHolder, replicaStream } from "./resume.ts"
import { OpenBotClient } from "./rpc.ts"

/** The roster's state cell; lives as long as the registry so a rebuilt runtime resumes from its cursor. */
export const rosterHolderAtom = Atom.make(() => makeReplicaHolder<RosterState>(emptyRosterState)).pipe(
  Atom.keepAlive,
  Atom.withLabel("openbot/rosterHolder"),
)

export const rosterAtom = OpenBotClient.runtime
  .atom((get) => {
    const holder = get(rosterHolderAtom)
    const backoff = get(clientConfigAtom).resubscribe
    return Stream.unwrap(
      Effect.gen(function* () {
        const client = yield* OpenBotClient
        const registry = yield* AtomRegistry.AtomRegistry
        const reactivity = yield* Reactivity.Reactivity
        return replicaStream({
          publishIntervalMs: presentationIntervalMs,
          holder,
          open: (after) => client("roster.subscribe", after ? { after } : {}),
          reduce: applyRosterStreamItem,
          cursor: (s) => s.cursor,
          hasGap: (s) => s.gap,
          markStale: (s) => (s.synchronized ? { ...s, synchronized: false } : s),
          isRetryable: isRetryableSubscribeError,
          backoff,
          wait: waitForRetry(registry),
          onItem: (item) => {
            if (item.kind !== "change") return Effect.void
            const keys = keysForRosterChange(item.change)
            return keys.length > 0 ? reactivity.invalidate(keys) : Effect.void
          },
        })
      }),
    )
  })
  .pipe(Atom.keepAlive, Atom.withLabel("openbot/roster"))

const mapRoster = <A>(f: (state: RosterState) => A) => Atom.make((get) => AsyncResult.map(get(rosterAtom), f))

const byName = (a: { readonly name: string }, b: { readonly name: string }) => a.name.localeCompare(b.name)

/** All bots, by name. */
export const botsAtom = mapRoster((s): ReadonlyArray<Bot> => [...s.bots.values()].sort(byName))
export const botAtom = Atom.family((botId: BotId) => mapRoster((s): Bot | undefined => s.bots.get(botId)))
export const activityAtom = Atom.family((botId: BotId) =>
  mapRoster((s): BotActivity | undefined => s.activities.get(botId)),
)
/** Sidebar conversation rows, most recent activity first. */
export const conversationSummariesAtom = mapRoster((s): ReadonlyArray<ConversationSummary> =>
  [...s.conversations.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt),
)
export const conversationSummaryAtom = Atom.family((conversationId: ConversationId) =>
  mapRoster((s): ConversationSummary | undefined => s.conversations.get(conversationId)),
)
export const nodesAtom = mapRoster((s): ReadonlyArray<NodeSummary> =>
  [...s.nodes.values()].sort((a, b) =>
    a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === "local" ? -1 : 1,
  ),
)
export const sectionsAtom = mapRoster((s): ReadonlyArray<Section> => sectionsOf(s))
/** Settings ride on the roster (`settings.updated`); defaults until the first snapshot. */
export const settingsAtom = Atom.make((get): Settings => {
  const roster = get(rosterAtom)
  return AsyncResult.isSuccess(roster) ? (roster.value.settings ?? DEFAULT_SETTINGS) : DEFAULT_SETTINGS
})
/** Most recent first (kept by the reducer, not part of snapshots). */
export const notificationsAtom = mapRoster((s): ReadonlyArray<Notification> => s.notifications)
/** Background tasks on the roster (D5.7): active ones plus recently finished ones, any bot. */
export const rosterTasksAtom = mapRoster((s): ReadonlyArray<Task> => [...s.tasks.values()])
/** A bot's queued and running tasks, oldest first ("Handling…"). */
export const activeTasksAtom = Atom.family((botId: BotId) =>
  mapRoster((s): ReadonlyArray<Task> => activeTasksOf(s, botId)),
)

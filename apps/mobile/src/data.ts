// Small hooks over the shared client's atoms (the web app's app/data.ts, for React Native).
import { useAtomValue } from "@effect/atom-react"
import { rosterAtom } from "@openbot/client"
import { type Bot, type BotId, emptyRosterState, type RosterState } from "@openbot/contracts"
import { Exit } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useCallback, useMemo } from "react"

export const valueOr = <A, E>(result: AsyncResult.AsyncResult<A, E>, fallback: A): A =>
  AsyncResult.isSuccess(result) ? result.value : fallback

export interface RosterView {
  readonly state: RosterState
  /** the first snapshot arrived */
  readonly loaded: boolean
  readonly botById: (id: BotId | string | undefined) => Bot | undefined
}

/** The live roster: bots, conversations, activities, sections, nodes, settings. */
export const useRoster = (): RosterView => {
  const result = useAtomValue(rosterAtom)
  const state = valueOr(result, emptyRosterState)
  const loaded = AsyncResult.isSuccess(result) && state.cursor !== undefined
  const bots = state.bots
  const botById = useCallback(
    (id: BotId | string | undefined) => (id === undefined ? undefined : bots.get(id as BotId)),
    [bots],
  )
  return useMemo(() => ({ state, loaded, botById }), [state, loaded, botById])
}

export const failureText = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return ""
  const failure = exit.cause.reasons.find((r) => r._tag === "Fail") as
    { readonly error?: { _tag?: string; message?: string; status?: string } } | undefined
  const e = failure?.error
  if (e?._tag === "RequestNotPending") return `This request is already ${e.status ?? "closed"}.`
  if (e?._tag === "AlreadyAnswered") return "This card was already answered."
  return e?.message || "Couldn't reach OpenBot. Check your connection and try again."
}

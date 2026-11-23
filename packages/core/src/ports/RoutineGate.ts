/**
 * `RoutineGate` port: a cheap check the owner puts in front of a routine, so a scheduled run that
 * would find nothing to do costs no bot turn. Implemented in the server (an executable file per
 * routine, see `RoutineScheduler`), faked in tests. Not in the context = no gates.
 */
import type { RoutineId } from "@openbot/contracts"
import { Context, type Effect } from "effect"

export type RoutineGateResult =
  /** No gate for this routine: it runs. */
  | { readonly _tag: "none" }
  /** The gate passed: the routine runs, its output (trimmed, possibly empty) follows the prompt. */
  | { readonly _tag: "pass"; readonly output: string }
  /** The gate found nothing to do: the run is skipped. */
  | { readonly _tag: "skip" }
  /** The gate broke (other exit code, timeout, could not start): the routine runs anyway. */
  | { readonly _tag: "error"; readonly message: string }

export class RoutineGate extends Context.Service<
  RoutineGate,
  {
    /** Never fails. */
    readonly check: (routineId: RoutineId) => Effect.Effect<RoutineGateResult>
  }
>()("openbot/core/RoutineGate") {}

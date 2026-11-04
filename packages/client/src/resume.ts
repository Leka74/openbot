// Resumable replica streams (D4.3, recovery-matrix.md §5 / F10).
//
// In-flight RPC streams never survive a disconnect (effect4-platform.md §4.6), so resubscribing is
// the application's job. `replicaStream` keeps the replica state in a `ReplicaHolder` (which can
// outlive the stream, so remounting a conversation resumes instead of re-snapshotting) and loops:
//   subscribe({after: cursor}) → reduce every item → on failure: mark stale, wait, resubscribe.
// - Transport errors wait for the next successful connect OR the backoff, whichever is first.
// - A gap detected by the reducer (an out-of-order change) resubscribes from the cursor at once.
// - A stream that ends resubscribes (the brain closed it, e.g. on shutdown).
// - Non-retryable errors (e.g. `NotFound`) end the stream with that error.
// The emitted value is always the whole state (sliding buffer of 1: consumers only need the latest).
import { Cause, Effect, Exit, Queue, Stream } from "effect"
import type { StreamCursor } from "@openbot/contracts"
import { backoffDelayMs, type Backoff } from "./config.ts"

/** Mutable cell holding a replica's state across subscriptions (and across mounts when cached). */
export interface ReplicaHolder<S> {
  state: S
  /** Set while a stream is running: pushes a locally changed state (e.g. a history page) to it. */
  emit: ((state: S) => void) | undefined
}

export const makeReplicaHolder = <S>(initial: S): ReplicaHolder<S> => ({ state: initial, emit: undefined })

/** Apply a local update (history page, optimistic tweak) and push it to the running stream, if any. */
export const updateReplica = <S>(holder: ReplicaHolder<S>, f: (state: S) => S): S => {
  holder.state = f(holder.state)
  holder.emit?.(holder.state)
  return holder.state
}

export interface ReplicaSpec<S, I, E> {
  readonly holder: ReplicaHolder<S>
  /** Opens one subscription attempt from `after` (undefined = fresh snapshot). */
  readonly open: (after: StreamCursor | undefined) => Stream.Stream<I, E>
  readonly reduce: (state: S, item: I) => S
  readonly cursor: (state: S) => StreamCursor | undefined
  /** True when the reducer refused an out-of-order change; the attempt is restarted from the cursor. */
  readonly hasGap: (state: S) => boolean
  /** The state to show while (re)connecting: e.g. `synchronized: false`. */
  readonly markStale: (state: S) => S
  readonly isRetryable: (error: E) => boolean
  readonly backoff: Backoff
  /**
   * Waits before the next attempt. Receives the backoff delay; the default sleeps. The atoms race the
   * sleep with "the socket reconnected" so resubscription happens right after a reconnect.
   */
  readonly wait?: ((delayMs: number) => Effect.Effect<void>) | undefined
  /** Side effects per applied item (e.g. reactivity invalidation). Must not fail. */
  readonly onItem?: ((item: I, state: S) => Effect.Effect<void>) | undefined
  /** Coalesce presentation only; every item still reduces state and runs onItem. */
  readonly publishIntervalMs?: (() => number) | undefined
  /** Observability hook, called before every subscription attempt. */
  readonly onSubscribe?: ((after: StreamCursor | undefined) => void) | undefined
}

class Resubscribe {
  readonly _tag = "Resubscribe"
}
const resubscribe = new Resubscribe()

export const replicaStream = <S, I, E>(spec: ReplicaSpec<S, I, E>): Stream.Stream<S, E> =>
  Stream.callback<S, E>(
    (queue) =>
      Effect.gen(function* () {
        const { holder } = spec
        let pending: S | undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        let lastPublished = -Infinity
        const publish = (state: S) => {
          lastPublished = Date.now()
          Queue.offerUnsafe(queue, state)
        }
        const offer = (state: S) => {
          const interval = Math.max(0, spec.publishIntervalMs?.() ?? 0)
          const remaining = interval - (Date.now() - lastPublished)
          if (remaining <= 0) {
            clearTimeout(timer)
            timer = undefined
            pending = undefined
            publish(state)
          } else {
            pending = state
            if (timer === undefined) timer = setTimeout(() => {
              timer = undefined
              const next = pending
              pending = undefined
              if (next !== undefined) publish(next)
            }, remaining)
          }
        }
        holder.emit = offer
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            clearTimeout(timer)
            pending = undefined
            if (holder.emit === offer) holder.emit = undefined
            holder.state = spec.markStale(holder.state)
          }),
        )
        // A cached replica (remount) renders immediately while it catches up.
        if (spec.cursor(holder.state) !== undefined) offer(holder.state)

        const wait = spec.wait ?? ((ms: number) => Effect.sleep(ms))
        let failures = 0
        while (true) {
          let progressed = false
          const after = spec.cursor(holder.state)
          spec.onSubscribe?.(after)
          const exit = yield* Stream.runForEach(
            Stream.suspend(() => spec.open(after)),
            (item): Effect.Effect<void, Resubscribe> => {
              const next = spec.reduce(holder.state, item)
              holder.state = next
              if (spec.hasGap(next)) return Effect.fail(resubscribe)
              progressed = true
              offer(next)
              return spec.onItem ? spec.onItem(item, next) : Effect.void
            },
          ).pipe(Effect.exit)

          if (progressed) failures = 0
          if (Exit.isSuccess(exit)) {
            // The brain ended the stream: resubscribe (immediately if it was healthy).
            failures++
            if (failures > 1) yield* wait(backoffDelayMs(spec.backoff, failures - 1))
            continue
          }
          const error = Cause.findErrorOption(exit.cause)
          if (error._tag === "None") return yield* Effect.failCause(exit.cause as Cause.Cause<never>)
          if (error.value instanceof Resubscribe) {
            failures++
            if (failures > 1) yield* wait(backoffDelayMs(spec.backoff, failures - 1))
            continue
          }
          const failure = error.value as E
          holder.state = spec.markStale(holder.state)
          offer(holder.state)
          if (!spec.isRetryable(failure)) return yield* Effect.fail(failure)
          failures++
          yield* wait(backoffDelayMs(spec.backoff, failures))
        }
      }),
    { bufferSize: 1, strategy: "sliding" },
  )

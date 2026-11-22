// TEST HELPER ONLY: a registry pointed at a test brain, plus `waitFor` over atom values.
import { Effect, Exit } from "effect"
import { type Atom, AtomRegistry, type AsyncResult } from "effect/reactivity"
import { type ClientConfig, clientConfigAtom, defaultClientConfig } from "../../src/index.ts"

export const testConfig = (url: string, overrides?: Partial<ClientConfig>): ClientConfig =>
  defaultClientConfig({
    url,
    pingInterval: "1 second",
    pingTimeout: "1 second",
    openTimeout: "2 seconds",
    reconnect: { initialMs: 40, maxMs: 200, factor: 2, jitter: false },
    resubscribe: { initialMs: 40, maxMs: 200, factor: 2, jitter: false },
    ...overrides,
  })

export const makeRegistry = (url: string, overrides?: Partial<ClientConfig>): AtomRegistry.AtomRegistry =>
  AtomRegistry.make({ initialValues: [[clientConfigAtom, testConfig(url, overrides)]] })

/** Resolves with the first value of `atom` that satisfies `predicate` (the atom stays mounted meanwhile). */
export const waitFor = <A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
  predicate: (a: A) => boolean,
  timeoutMs = 5000,
): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    let last: A | undefined
    let done = false
    let unsubscribe: (() => void) | undefined
    const finish = (f: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      queueMicrotask(() => unsubscribe?.())
      f()
    }
    const check = (a: A) => {
      last = a
      if (predicate(a)) finish(() => resolve(a))
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error(`waitFor timed out; last value: ${describe(last)}`))),
      timeoutMs,
    )
    unsubscribe = registry.subscribe(atom, check, { immediate: true })
  })

const describe = (value: unknown): string => {
  try {
    return (
      JSON.stringify(value, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v))?.slice(0, 600) ?? String(value)
    )
  } catch {
    return String(value)
  }
}

/** The success value of an AsyncResult (or undefined). */
export const valueOf = <A, E>(result: AsyncResult.AsyncResult<A, E>): A | undefined =>
  result._tag === "Success" ? result.value : undefined

/** Runs a fn atom once and awaits its exit. */
export const runFn = <W, A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Writable<AsyncResult.AsyncResult<A, E>, W>,
  value: W,
): Promise<Exit.Exit<A, E>> => {
  registry.set(atom, value)
  return Effect.runPromiseExit(AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }))
}

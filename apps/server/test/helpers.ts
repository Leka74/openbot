// Hermetic test wiring for the brain: a temp data dir, port 0, the fake harness only, a local node
// without a browser; plus an Effect RPC client over the real `/rpc` WebSocket (session cookie).
import * as BunSocket from "@effect/platform-bun/BunSocket"
import {
  applyConversationStreamItem,
  type ConversationState,
  type ConversationStreamItem,
  emptyConversationState,
  OpenBotRpcs,
} from "@openbot/contracts"
import type { ConversationId } from "@openbot/contracts"
import { FakeHarnessLive } from "@openbot/harness-fake"
import { Context, Effect, Exit, Fiber, Layer, Ref, Scope, Stream } from "effect"
import { RpcClient, type RpcClientError, RpcSerialization } from "effect/rpc"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  InternalListener,
  PublicListener,
  type ServerConfigShape,
  ServerLive,
  type ServerOptions,
  WebAuth,
} from "../src/index.ts"

export type ServerServices = Layer.Success<ReturnType<typeof ServerLive>>

export interface TestServer {
  readonly dataDir: string
  readonly config: ServerConfigShape
  readonly context: Context.Context<ServerServices>
  /** `http://127.0.0.1:<port>` */
  readonly base: string
  /** `ws://127.0.0.1:<port>` */
  readonly wsBase: string
  /** The internal listener (`/mcp`, `/relay`). */
  readonly internalBase: string
  readonly ownerToken: string
  /** Runs an effect with every brain service provided, in a fresh scope. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, ServerServices | Scope.Scope>) => Promise<A>
  /** Shuts the brain down (graceful) and deletes the data dir unless `keepData`. */
  readonly close: (options?: { readonly keepData?: boolean }) => Promise<void>
}

export const TEST_LOCAL_NODE = {
  node: { browser: { enabled: false }, detectBinaries: false, forwardAudit: false },
} as const

export const testConfig = (dataDir: string, overrides?: Partial<ServerConfigShape>): ServerConfigShape => ({
  dataDir,
  port: 0,
  host: "127.0.0.1",
  publicOrigins: [],
  localNode: true,
  dev: false,
  harnesses: ["fake"],
  claudePath: undefined,
  ...overrides,
})

export const startServer = async (options?: {
  readonly dataDir?: string
  readonly config?: Partial<ServerConfigShape>
  readonly server?: ServerOptions
}): Promise<TestServer> => {
  const dataDir = options?.dataDir ?? mkdtempSync(join(tmpdir(), "openbot-server-test-"))
  const config = testConfig(dataDir, options?.config)
  const scope = Effect.runSync(Scope.make())
  const context = await Effect.runPromise(
    Layer.buildWithScope(
      ServerLive(config, {
        quiet: true,
        drivers: FakeHarnessLive,
        localNode: TEST_LOCAL_NODE,
        // no GitHub from tests
        updates: { schedule: false, fetch: async () => new Response("offline", { status: 503 }) },
        // background bot messages wake their recipient quickly (production: 45 s)
        runner: { botWakeDebounce: "50 millis" },
        ...options?.server,
      }),
      scope,
    ),
  )
  const listener = Context.get(context, PublicListener)
  return {
    dataDir,
    config,
    context,
    base: listener.selfBase,
    wsBase: listener.selfBase.replace(/^http/, "ws"),
    internalBase: Context.get(context, InternalListener).baseUrl,
    ownerToken: Context.get(context, WebAuth).ownerToken,
    run: (effect) => Effect.runPromise(Effect.scoped(Effect.provideContext(effect, context))),
    close: async (closeOptions) => {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      if (closeOptions?.keepData !== true) rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** Exchanges the owner token for a session cookie (`openbot_session=…`). */
export const login = async (base: string, token: string): Promise<string> => {
  const res = await fetch(`${base}/api/auth/login?token=${encodeURIComponent(token)}`, { redirect: "manual" })
  if (res.status !== 302) throw new Error(`login failed: ${res.status}`)
  const cookie = res.headers.get("set-cookie")
  if (cookie === null) throw new Error("login set no cookie")
  return cookie.split(";")[0]!
}

/**
 * Status code of a WebSocket upgrade attempt (101 on success). Uses a plain HTTP request with
 * upgrade headers so refusals (401/403) are observable.
 */
export const upgradeStatus = async (url: string, headers: Record<string, string>): Promise<number> => {
  const res = await fetch(url, {
    headers: {
      ...headers,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    },
  })
  await res.body?.cancel().catch(() => undefined)
  return res.status
}

export type OpenBotClient = RpcClient.FromGroup<typeof OpenBotRpcs, RpcClientError.RpcClientError>

/** An `OpenBotRpcs` client over `/rpc` with the given handshake headers (cookie, origin). Scoped. */
export const rpcClient = (url: string, headers: Record<string, string>) =>
  Effect.gen(function* () {
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
        Layer.provide(BunSocket.layerWebSocket(url, { headers, openTimeout: 5_000 })),
        Layer.provide(RpcSerialization.layerJson),
      ),
    )
    return yield* RpcClient.make(OpenBotRpcs).pipe(Effect.provideContext(protocol))
  })

/** A live conversation replica: subscribes and folds every item with the contract reducer. */
export const watchConversation = (client: OpenBotClient, conversationId: ConversationId) =>
  Effect.gen(function* () {
    const state = yield* Ref.make<ConversationState>(emptyConversationState)
    const items = yield* Ref.make<ReadonlyArray<ConversationStreamItem>>([])
    const fiber = yield* client["conversations.subscribe"]({ conversationId }).pipe(
      Stream.runForEach((item) =>
        Ref.update(state, (s) => applyConversationStreamItem(s, item)).pipe(
          Effect.andThen(Ref.update(items, (all) => [...all, item])),
        ),
      ),
      Effect.forkScoped,
    )
    return { state, items, fiber }
  })

/** Polls `read` until `predicate` holds (or fails after `timeout`). */
export const eventually = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  predicate: (a: A) => boolean,
  options?: { readonly timeout?: number; readonly label?: string },
): Effect.Effect<A, E | Error, R> =>
  Effect.gen(function* () {
    const deadline = Date.now() + (options?.timeout ?? 10_000)
    let last: A | undefined
    while (Date.now() < deadline) {
      last = yield* read
      if (predicate(last)) return last
      yield* Effect.sleep("25 millis")
    }
    return yield* Effect.fail(
      new Error(
        `timed out waiting for ${options?.label ?? "condition"}; last value: ${JSON.stringify(last)?.slice(0, 2000)}`,
      ),
    )
  })

export const interruptQuietly = (fiber: Fiber.Fiber<unknown, unknown>) => Fiber.interrupt(fiber)

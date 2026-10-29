/**
 * `LocalNode` (architecture §4.8, D1.1): the brain machine as a node. It runs the same `NodeRpcs`
 * handlers as a remote node daemon (`@openbot/node-daemon` `NodeHandlersLive`), in-process, with no
 * socket. It is registered as `node_local` (kind `local`) and is on by default.
 *
 * The handlers need two node-side seams (`@openbot/node-protocol` links.ts), provided here in-process:
 *   - `BrainLink`: `node.requestApproval` → `ApprovalService.evaluateNode({nodeId: node_local})`,
 *     `node.openStream` / `node.event` → the same brain-side handlers remote nodes reach over the wire;
 *   - `StreamDialer`: data streams (pty, screencast, …) claim their ticket from the `StreamBroker` and
 *     get one end of an in-memory socket pair.
 *
 * The brain's `NodeClient` for the local node is `RpcTest.makeClient(NodeRpcs)` (no serialization).
 * The `node.hello` gate belongs to remote connections, so the local node is described by calling the
 * handlers' `node.hello` once (falling back to `describe` when the handlers refuse the in-process call).
 */
import { LOCAL_NODE_ID } from "@openbot/contracts"
import { ApprovalService, BotRepo, DataDir, type DataDirShape, InternalAddress, joinPath } from "@openbot/core"
import { type NodeConfigInput, NodeHandlersLive } from "@openbot/node-daemon"
import {
  BrainLink,
  Capabilities,
  type NodeHello,
  type NodeRoot,
  NodeRpcs,
  PROTOCOL_VERSION,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  signHello,
  StreamDialer,
} from "@openbot/node-protocol"
import { Effect, Layer, Option } from "effect"
import { RpcTest } from "effect/rpc"
import type { Rpc, RpcGroup } from "effect/rpc"
import { arch as osArch, hostname as osHostname } from "node:os"
import { BrainSide } from "./BrainHandlers.ts"
import { projectFolderRoots } from "./HostPaths.ts"
import { BrainIdentity, BrainNodesConfig } from "./config.ts"
import { NodeRegistry } from "./NodeRegistry.ts"
import { StreamBroker } from "./StreamBroker.ts"

/** The `NodeRpcs` handler services (what `NodeRpcs.toLayer(...)` provides). */
export type NodeRpcHandlers = Rpc.ToHandler<RpcGroup.Rpcs<typeof NodeRpcs>>

export interface LocalNodeOptions<E, R> {
  /**
   * `NodeRpcs` handlers, typically `NodeHandlersLive(config)` from `@openbot/node-daemon`. They may
   * require `BrainLink` and `StreamDialer`; LocalNodeLive provides both in-process.
   */
  readonly handlers: Layer.Layer<NodeRpcHandlers, E, R>
  /** Used when the handlers' `node.hello` refuses the in-process call (fields override defaults). */
  readonly describe?: Partial<Omit<NodeHello, "nodeId">> | undefined
}

/** The in-process seams the local node's handlers need. */
export const localNodeLinks = Effect.gen(function* () {
  const { handlers } = yield* BrainSide
  const broker = yield* StreamBroker
  const brainLink = BrainLink.of({
    requestApproval: (request) => handlers.requestApproval(LOCAL_NODE_ID, request),
    openStream: (input) => handlers.openStream(LOCAL_NODE_ID, input),
    event: (type, data) => handlers.event(LOCAL_NODE_ID, type, data),
  })
  const dialer = StreamDialer.of({ dial: ({ kind, ticket }) => broker.dialLocal(ticket, kind) })
  return Layer.merge(Layer.succeed(BrainLink, brainLink), Layer.succeed(StreamDialer, dialer))
})

const fallbackHello = (describe: LocalNodeOptions<never, never>["describe"], version: string): NodeHello => ({
  nodeId: LOCAL_NODE_ID,
  version: describe?.version ?? version,
  hostname: describe?.hostname ?? osHostname(),
  platform: describe?.platform ?? process.platform,
  arch: describe?.arch ?? osArch(),
  protocol: describe?.protocol ?? PROTOCOL_VERSION,
  roots: describe?.roots ?? [],
  capabilities: describe?.capabilities ?? [Capabilities.fs, Capabilities.shell, Capabilities.pty],
  tunnels: describe?.tunnels ?? [],
  policy: describe?.policy ?? { ceiling: "always", remoteManaged: false },
  brainVerified: true,
})

/**
 * Registers the in-process local node (`node_local`) while the layer is alive. A no-op when the
 * local node is disabled by config. Top-level: needs `ApprovalService` (via `BrainSide`).
 */
export const LocalNodeLive = <E, R>(
  options: LocalNodeOptions<E, R>,
): Layer.Layer<
  never,
  E,
  | Exclude<R, BrainLink | StreamDialer>
  | BrainNodesConfig
  | BrainIdentity
  | NodeRegistry
  | StreamBroker
  | ApprovalService
  | BotRepo
  | InternalAddress
> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* BrainNodesConfig
      if (!config.localNode.enabled) return
      const identity = yield* BrainIdentity
      const registry = yield* NodeRegistry
      const links = yield* localNodeLinks
      const handlerContext = yield* Layer.build(Layer.provide(options.handlers, links))
      const client = yield* RpcTest.makeClient(NodeRpcs).pipe(Effect.provide(handlerContext))

      // describe the node through its own `node.hello` (signed like a remote hello, nonce "local")
      const origin = yield* config.brainOrigin
      const brainSig = yield* Effect.orDie(
        signHello({ brainPrivateKey: identity.privateKey, nodeId: LOCAL_NODE_ID, nonce: "local", brainOrigin: origin }),
      )
      const described = yield* client["node.hello"]({
        protocol: { min: MIN_SUPPORTED_PROTOCOL_VERSION, max: PROTOCOL_VERSION },
        brainVersion: config.brainVersion,
        brainSig,
      }).pipe(Effect.timeout("5 seconds"), Effect.option)
      const hello: NodeHello = Option.match(described, {
        onNone: () => fallbackHello(options.describe, config.brainVersion),
        onSome: (h) => ({ ...h, nodeId: LOCAL_NODE_ID, brainVerified: true }),
      })

      yield* Effect.orDie(registry.attach({ nodeId: LOCAL_NODE_ID, hello, client, close: () => Effect.void }))
    }),
  ).pipe(Layer.provide(BrainSide.layer))

// ============================================================================ node-daemon wiring

export interface LocalNodeDaemonOptions {
  /** Roots beyond the per-bot workspaces (`--root`), e.g. `~/code`. */
  readonly roots?: ReadonlyArray<NodeRoot | string> | undefined
  /** Other node-daemon settings: policy ceiling, browser, binaries, limits, deny globs, … */
  readonly node?: Omit<NodeConfigInput, "nodeId" | "dataDir" | "roots"> | undefined
  readonly describe?: LocalNodeOptions<never, never>["describe"]
}

/**
 * node-daemon configuration of the local node (D1.1, §4.8): node id `node_local`, state under
 * `DataDir.localNode`, and the roots `<data>/bots/{botId}/workspace` (each bot reaches only its own
 * workspace) plus any configured extra roots, plus per bot its project folders (`extraRoots`, from
 * `projectFolderRoots`: its profile's shared ∪ the bot's own).
 */
export const localNodeConfig = (
  dataDir: DataDirShape,
  options?: LocalNodeDaemonOptions,
  extraRoots?: (botId: string) => ReadonlyArray<string>,
): NodeConfigInput => ({
  ...options?.node,
  nodeId: LOCAL_NODE_ID,
  dataDir: dataDir.localNode,
  roots: [
    { id: "workspace", path: joinPath(dataDir.root, "bots", "{botId}", "workspace"), mode: "rw" },
    ...(options?.roots ?? []),
  ],
  ...(extraRoots === undefined ? {} : { extraRoots }),
})

/**
 * `LocalNodeLive` running `@openbot/node-daemon`'s `NodeHandlersLive` with `localNodeConfig`. This is
 * what the server composes by default (unless `--no-local-node`, which `BrainNodesConfig` reflects).
 */
export const LocalNodeDaemonLive = (
  options?: LocalNodeDaemonOptions,
): Layer.Layer<
  never,
  never,
  DataDir | BrainNodesConfig | BrainIdentity | NodeRegistry | StreamBroker | ApprovalService | BotRepo | InternalAddress
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const dataDir = yield* DataDir
      // Project folders become roots of the local node only (when a LiveHub is around to track them).
      const extraRoots = yield* projectFolderRoots
      return LocalNodeLive({
        handlers: NodeHandlersLive(localNodeConfig(dataDir, options, extraRoots)),
        describe: options?.describe,
      })
    }),
  )

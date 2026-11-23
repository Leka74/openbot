// `OpenBotClient`: one AtomRpc service = one WebSocket to `/rpc` shared by every atom
// (D4.3, effect4-platform.md §8). Effect RPC with `RpcSerialization.layerJson`; same origin, so the
// HttpOnly session cookie authenticates the upgrade (D4.4). Non-cookie clients put their `wsTicket`
// in `clientConfigAtom.url`, or (React Native, Bun) their session in `clientConfigAtom.headers`.
import { Layer } from "effect"
import type { WebSocketConstructorOptions } from "effect/socket/Socket"
import { OpenBotRpcs } from "@openbot/contracts"
import { AtomRpc } from "effect/reactivity"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { clientConfigAtom } from "./config.ts"
import { connectionHooksLayer, nextProtocolOwner, reconnectSchedule, reconnectSignalAtom } from "./connection.ts"

export class OpenBotClient extends AtomRpc.Service<OpenBotClient>()("@openbot/client/OpenBotClient", {
  group: OpenBotRpcs,
  protocol: (get) => {
    const config = get(clientConfigAtom)
    // Read so that `reconnectAtom` (bumping the signal) rebuilds the protocol with a fresh socket.
    get(reconnectSignalAtom)
    const registry = get.registry
    const owner = nextProtocolOwner()
    return RpcClient.layerProtocolSocket({
      pingInterval: config.pingInterval,
      pingTimeout: config.pingTimeout,
      // Fail calls fast while offline (t3code style); the protocol keeps reconnecting on its own
      // schedule and replica streams re-subscribe after the next connect.
      retryTransientErrors: false,
      retryPolicy: reconnectSchedule(registry, config.reconnect, owner),
    }).pipe(
      Layer.provide(
        Socket.layerWebSocket(config.url, {
          openTimeout: config.openTimeout,
          ...(config.headers ? { headers: config.headers } : {}),
        }),
      ),
      Layer.provide(config.headers ? layerWebSocketConstructorWithHeaders : Socket.layerWebSocketConstructorGlobal),
      Layer.provide(RpcSerialization.layerJson),
      Layer.provide(connectionHooksLayer(registry, owner)),
    )
  },
}) {}

/**
 * `globalThis.WebSocket` with handshake headers: React Native takes them as a third argument
 * (`new WebSocket(url, protocols, { headers })`), Bun in its options object.
 */
const layerWebSocketConstructorWithHeaders = Layer.succeed(Socket.WebSocketConstructor)((
  url,
  options?: WebSocketConstructorOptions,
) => {
  const opts = typeof options === "object" && !Array.isArray(options) ? options : { protocols: options }
  const Ctor = globalThis.WebSocket as unknown as new (...args: Array<unknown>) => globalThis.WebSocket
  const reactNative = (globalThis as { navigator?: { product?: string } }).navigator?.product === "ReactNative"
  return reactNative
    ? new Ctor(url, opts.protocols, { headers: opts.headers })
    : new Ctor(url, { headers: opts.headers, protocols: opts.protocols })
})

/** The flattened client type: `client("bots.create", payload)`. */
export type OpenBotRpcClient = typeof OpenBotClient.Service

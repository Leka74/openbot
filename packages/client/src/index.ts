// @openbot/client: the web client runtime (architecture §4.10). One `OpenBotClient` AtomRpc service
// over one `/rpc` WebSocket; live roster and conversation replicas with cursor resume; a connection
// supervisor; command atoms for every unary RPC; optimistic sends; attachment upload. No UI.
export * from "./config.ts"
export {
  type ConnectionState,
  type ConnectionStatus,
  initialConnectionState,
} from "./connection.ts"
export * from "./rpc.ts"
export * from "./supervisor.ts"
export * from "./keys.ts"
export * from "./resume.ts"
export * from "./roster.ts"
export * from "./conversation.ts"
export * from "./outbox.ts"
export * from "./commands.ts"
export * from "./queries.ts"
export * from "./search.ts"
export * from "./attachments.ts"
export { isRetryableSubscribeError } from "./replica.ts"

/**
 * @openbot/gateway — the OpenBot MCP gateway (architecture §4.6, D3).
 *
 * - `McpGateway` / `McpGatewayLive`: HTTP handler for `/mcp/:botId` on the internal listener.
 * - `McpBindingIssuerLive`: per-run bearer tokens (hashed in `McpTokenRepo`) → `McpBinding`.
 * - Toolkits: `BotToolkit`, `SearchToolkit` (a bot's own past conversations), `NodeToolkit`, `BrowserToolkit`, `ComputerToolkit` (`computer`,
 *   `request_takeover`), `SlackToolkit` (while Slack is connected) and the result/param helpers they use.
 */
export * from "./McpGateway.ts"
export * from "./McpBindingIssuer.ts"
export * from "./results.ts"
export * from "./tool.ts"
export * as Params from "./params.ts"
export { findUnsafeSchemaKeywords } from "./params.ts"
export { BotToolkit, type BotToolkitServices, describeNode } from "./toolkits/bot.ts"
export { describeTask, formatSpan, notInTask, TaskToolkit, type TaskToolkitServices } from "./toolkits/tasks.ts"
export { neutralizeQuoted, parseWhen, searchTime, SearchToolkit, type SearchToolkitServices } from "./toolkits/search.ts"
export {
  allowedNodeIds,
  approve,
  fitToResult,
  NodeToolkit,
  type NodeTarget,
  type NodeToolkitServices,
  resolveNodePath,
  resolveTarget,
  spillToNode,
} from "./toolkits/node.ts"
export { BrowserToolkit, type BrowserToolkitServices, toBrowserAction } from "./toolkits/browser.ts"
export { formatSlackMessage, SlackToolkit, slackTime } from "./toolkits/slack.ts"
export {
  ComputerToolkit,
  type ComputerToolkitServices,
  hasScreen,
  OWNER_HAS_SCREEN,
  toComputerAction,
} from "./toolkits/computer.ts"

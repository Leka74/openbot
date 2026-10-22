/**
 * Tool definitions shared by the toolkits (architecture §4.6): `{name, description, inputSchema
 * (JSON schema, no tuples), annotations, handler(args, ctx) → Effect<ToolResult>}`.
 */
import type { NodeSummary } from "@openbot/contracts"
import type { McpClaims, Toolset, ToolContext } from "@openbot/core"
import type { Effect } from "effect"
import type { ParamsSpec } from "./params.ts"
import type { ToolResult } from "./results.ts"

/** MCP tool annotations (only Codex reads them; R10: `readOnlyHint` on side-effect-free tools). */
export interface ToolAnnotations {
  readonly title?: string
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
  readonly idempotentHint?: boolean
  readonly openWorldHint?: boolean
}

/** Per-call context handed to tool handlers. */
export interface ToolCallContext {
  /** Verified token claims + harness tool-call id (`ToolContext` of core services). */
  readonly tool: ToolContext
  readonly claims: McpClaims
  /** MCP session id (for logs). */
  readonly sessionId: string | undefined
  /**
   * Reports progress to the client (`notifications/progress`) when it sent a progress token.
   * Throttled; never fails. The gateway also sends a heartbeat every ≤ 5 s on its own.
   */
  readonly progress: (message: string) => Effect.Effect<void>
}

/** What decides whether a tool is offered in a session (computed once at `initialize`, R6). */
export interface ToolAvailability {
  readonly claims: McpClaims
  /** Effective capabilities of the host node (empty when it is offline at session start). */
  readonly hostNode: NodeSummary | undefined
  /** The owner's Slack is connected (D3.4). */
  readonly slack?: boolean | undefined
  /** Settings › "Bots can search their chats" (default on). */
  readonly botSearch?: boolean | undefined
}

export interface ToolDef<A, R> {
  readonly name: string
  /** The claims toolset that unlocks this tool. */
  readonly toolset: Toolset
  /** R7: ≤ 4,000 chars, key sentence first. */
  readonly description: string
  readonly params: ParamsSpec<A>
  readonly annotations?: ToolAnnotations | undefined
  /** Extra gating beyond the toolset (e.g. a node capability). Default: always offered. */
  readonly available?: ((input: ToolAvailability) => boolean) | undefined
  /**
   * Whether repeated calls with the same harness call id may be answered from the per-session
   * idempotency cache (default true). Read-only tools may opt out.
   */
  readonly idempotent?: boolean | undefined
  readonly handler: (args: A, ctx: ToolCallContext) => Effect.Effect<ToolResult, unknown, R>
}

/** A tool with its argument type erased (what toolkits are lists of). */
export interface AnyTool<R = any> {
  readonly name: string
  readonly toolset: Toolset
  readonly description: string
  readonly params: ParamsSpec<unknown>
  readonly annotations?: ToolAnnotations | undefined
  readonly available?: ((input: ToolAvailability) => boolean) | undefined
  readonly idempotent?: boolean | undefined
  readonly handler: (args: unknown, ctx: ToolCallContext) => Effect.Effect<ToolResult, unknown, R>
}

/** Defines a tool, keeping the handler's argument type tied to its params. */
export const defineTool = <A, R>(def: ToolDef<A, R>): AnyTool<R> => def as unknown as AnyTool<R>

/** R7: descriptions are capped at 4,000 characters (Claude cuts at 4,096). */
export const MAX_DESCRIPTION_CHARS = 4_000

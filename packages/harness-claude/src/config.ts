/**
 * Per-bot Claude query options: the clean-room recipe (harness-context-isolation.md §2-3, D2.1)
 * plus placement (D1.5) and approvals.
 *
 * - `settingSources: []`, `strictMcpConfig: true` and a `settings` overlay that turns off user
 *   hooks, claude.ai connectors and synced skills/plugins, and Claude's commit/PR attribution (a
 *   teammate's commits carry no "Co-Authored-By: Claude" / "Generated with Claude Code"; the owner's
 *   own `attribution` setting never reaches a bot). `HOME` is never changed. The default
 *   account keeps the brain's `CLAUDE_CONFIG_DIR` (the user's login keeps working); an account the
 *   owner added points `CLAUDE_CONFIG_DIR` at that account's own config dir (profile.ts).
 * - Memory: native auto-memory off (default; OpenBot renders the index into the instructions), or
 *   pointed at the bot's memory directory (D2.1/D5.4 opt-in).
 * - The OpenBot skills library is mounted as a local plugin when it exists (D5.5).
 * - Built-ins that overlap OpenBot features are disallowed; `brain-mcp-hands` turns every built-in
 *   off (`tools: []`).
 * - `permissionMode: "default"` is explicit (never `auto`, never bypass) and `canUseTool` bridges
 *   approvals. Gateway tools are pre-approved (`mcp__openbot__*`): the gateway asks itself.
 * - Tool output is capped (`TOOL_OUTPUT_CAPS`) unless the brain's environment sets the caps itself.
 * - MCP servers are NOT passed here: `Options.mcpServers` would put headers on argv. They are
 *   registered with `setMcpServers` after start (see `mcpServersConfig`).
 */
import type { McpBinding, OpenSessionInput } from "@openbot/core"
import type { SdkOptions } from "./sdk.ts"

/** Claude built-ins that duplicate OpenBot features (D2.1; sdk-claude.md §10.1, §16.4). */
export const DISALLOWED_NATIVE_TOOLS: ReadonlyArray<string> = [
  "SendMessage",
  "ListAgents",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "PushNotification",
  // unused by bots, and their descriptions are a large part of the fixed prompt (Workflow ~2.5k tokens)
  "Workflow",
  "ReportFindings",
]

/**
 * Defaults for Claude's tool output caps (characters of Bash output, tokens of an MCP result): a
 * large output stays in the context for the rest of the session. The brain's environment wins.
 */
export const TOOL_OUTPUT_CAPS: Readonly<Record<string, string>> = {
  BASH_MAX_OUTPUT_LENGTH: "20000",
  MAX_MCP_OUTPUT_TOKENS: "15000",
}

/** OpenBot gateway tools are approved by the gateway itself (interfaces §8.3, mcp-conformance R10). */
export const PREAPPROVED_TOOLS: ReadonlyArray<string> = ["mcp__openbot__*"]

/** Default per-call MCP timeout: also raises Claude's 300 s HTTP idle limit (mcp-conformance §timeouts). */
export const DEFAULT_MCP_TIMEOUT_MS = 30 * 60 * 1000

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"])

export type Env = Readonly<Record<string, string | undefined>>

/**
 * Builds the CLI environment (sdk-claude.md §8, §21.3 rule 7). `Options.env` REPLACES the child
 * environment, so start from the host's. Variables injected by a parent Claude Code process
 * (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, session/IDE hooks …) are dropped so a dev brain started
 * from inside Claude Code does not confuse the child; credential/backend choices the user made
 * (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_*`, `ANTHROPIC_*`) and `CLAUDE_CONFIG_DIR` are kept.
 */
export const cleanEnv = (
  base: Env,
  extra: Readonly<Record<string, string>> = {},
  clientApp = "openbot/0.0.0",
): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (key === "CLAUDECODE") continue
    if (
      key.startsWith("CLAUDE_CODE_") &&
      key !== "CLAUDE_CODE_OAUTH_TOKEN" &&
      !key.startsWith("CLAUDE_CODE_USE_") &&
      key !== "CLAUDE_CODE_GIT_BASH_PATH"
    )
      continue
    if (key === "CLAUDE_AGENT_SDK_VERSION" || key === "CLAUDE_AGENT_SDK_CLIENT_APP") continue
    env[key] = value
  }
  return {
    ...env,
    ...extra,
    CLAUDE_AGENT_SDK_CLIENT_APP: clientApp,
    // claude.ai connectors are also removed by strictMcpConfig; harmless belt and braces.
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  }
}

export interface QueryOptionsInput {
  readonly session: Pick<OpenSessionInput, "bot" | "placement" | "instructions" | "model" | "effort">
  /** New session id (first open) — mutually exclusive with `resume`. */
  readonly sessionId?: string | undefined
  /** Native session id to resume. */
  readonly resume?: string | undefined
  readonly env: Record<string, string | undefined>
  /** `pathToClaudeCodeExecutable`; undefined = the SDK's bundled CLI. */
  readonly executable?: string | undefined
  /** Bot memory directory for native auto-memory; undefined = auto-memory off. */
  readonly memoryDirectory?: string | undefined
  /** Skills library root (Claude plugin layout) when it exists. */
  readonly skillsLibrary?: string | undefined
  /** Extra readable roots (attachments). */
  readonly additionalDirectories?: ReadonlyArray<string> | undefined
  readonly abortController?: AbortController | undefined
  readonly canUseTool?: SdkOptions["canUseTool"]
  readonly spawnClaudeCodeProcess?: SdkOptions["spawnClaudeCodeProcess"]
  readonly stderr?: ((data: string) => void) | undefined
}

/** The per-bot isolation recipe as SDK `Options` (no `mcpServers`: see `mcpServersConfig`). */
export const buildQueryOptions = (input: QueryOptionsInput): SdkOptions => {
  const { bot, placement, instructions, model, effort } = input.session
  const settings: NonNullable<Exclude<SdkOptions["settings"], string>> = {
    disableAllHooks: true,
    disableClaudeAiConnectors: true,
    syncClaudeAiSkills: false,
    syncClaudeAiPlugins: false,
    // object form: older CLIs (a configured `executable`) reject `attribution: false`
    attribution: { commit: "", pr: "", sessionUrl: false },
    ...(input.memoryDirectory !== undefined
      ? { autoMemoryEnabled: true, autoMemoryDirectory: input.memoryDirectory }
      : { autoMemoryEnabled: false }),
  }
  const options: SdkOptions = {
    cwd: placement.harnessCwd,
    env: input.env,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: instructions.text,
      // Persona/memory/placement edits must apply on resume (§4.3.7), not stay frozen in the snapshot.
      snapshot: false,
    },
    settingSources: [],
    strictMcpConfig: true,
    settings,
    permissionMode: "default",
    includePartialMessages: true,
    allowedTools: [...PREAPPROVED_TOOLS],
    disallowedTools: [...DISALLOWED_NATIVE_TOOLS],
    ...(placement.disableBuiltinTools ? { tools: [] } : {}),
    ...(input.resume !== undefined ? { resume: input.resume } : {}),
    ...(input.resume === undefined && input.sessionId !== undefined
      ? { sessionId: input.sessionId, title: `OpenBot · ${bot.name}` }
      : {}),
    ...(model !== undefined && model.length > 0 ? { model } : {}),
    ...(effort !== undefined && EFFORTS.has(effort) ? { effort: effort as NonNullable<SdkOptions["effort"]> } : {}),
    ...(input.skillsLibrary !== undefined
      ? { plugins: [{ type: "local", path: input.skillsLibrary, skipMcpDiscovery: true }] }
      : {}),
    ...(input.additionalDirectories && input.additionalDirectories.length > 0
      ? { additionalDirectories: [...input.additionalDirectories] }
      : {}),
    ...(input.executable !== undefined ? { pathToClaudeCodeExecutable: input.executable } : {}),
    ...(input.abortController ? { abortController: input.abortController } : {}),
    ...(input.canUseTool ? { canUseTool: input.canUseTool } : {}),
    ...(input.spawnClaudeCodeProcess ? { spawnClaudeCodeProcess: input.spawnClaudeCodeProcess } : {}),
    ...(input.stderr ? { stderr: input.stderr } : {}),
  }
  return options
}

/**
 * MCP servers for `q.setMcpServers` (stdin control channel — tokens never reach argv, §7).
 * `alwaysLoad` keeps OpenBot tools out of tool search (mcp-conformance R9).
 */
export const mcpServersConfig = (
  bindings: ReadonlyArray<McpBinding>,
  timeoutMs: number = DEFAULT_MCP_TIMEOUT_MS,
): Record<string, Record<string, unknown>> => {
  const servers: Record<string, Record<string, unknown>> = {}
  for (const binding of bindings) {
    servers[binding.name] = {
      type: "http",
      url: binding.url,
      headers: { ...binding.headers },
      alwaysLoad: true,
      timeout: timeoutMs,
    }
  }
  return servers
}

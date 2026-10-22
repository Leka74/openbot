/**
 * The OpenBot MCP gateway (D3.1, architecture §4.6): one Streamable HTTP MCP endpoint per bot,
 * `/mcp/:botId` on the INTERNAL listener, served with `@modelcontextprotocol/sdk` 1.32.1
 * (`WebStandardStreamableHTTPServerTransport`, low-level `Server`).
 *
 * - **Auth.** `Authorization: Bearer <token>` → sha256 → `McpTokenRepo` claims (revoked/expired →
 *   401). A path `botId` that does not match the claims → 403. Cookies are never accepted. A 401
 *   never points the client at OAuth (agents cannot sign in; t3code `McpHttpServer.ts`).
 * - **Sessions.** Stateful: one `Server` + transport per MCP session, bound to the token that
 *   initialized it (another token presenting the session id → 403). Unknown session id → 404, so the
 *   client re-initializes (e.g. after a brain restart). GET (standalone SSE) → 405.
 * - **Current conversation.** A bot has ONE harness session (and one token) for all of its
 *   conversations (D5.0). Per tool call the claims' `conversationId` / `sessionKey` are replaced by
 *   those of the bot's running turn (`Orchestrator.activeTurn`), else the token's home conversation
 *   (the bot's DM): replies, cards, events and `post_to_group` defaults follow the turn. A
 *   background task's token (`claims.taskId`, D5.7) keeps the task's origin conversation and passes
 *   `ToolContext.taskId`; the task tools and the ask-the-owner tools are not offered to it.
 * - **Tools.** The list is fixed per session at `initialize` from the token's `toolsets` (R6).
 *   Results follow R1–R4 (`results.ts`): content only, never `structuredContent`, `ERROR:` text,
 *   ≤ ~10 KB.
 * - **Long calls.** With a client `progressToken`, a progress notification goes out at least every
 *   `progressIntervalMs` (default 4 s, ≤ 5 s per R8) for the whole call. `extra.signal` interrupts
 *   the handler. The server must run `Bun.serve({ idleTimeout: 0 })`.
 * - **Idempotency.** A per-session LRU keyed by `(tool, harness call id)` replays the result of a
 *   repeated call; without a call id, an identical call that arrives while the first is still
 *   running joins it (`(tool, args hash)`).
 *
 * The service exposes `handle(Request) → Promise<Response>`; apps/server mounts it at `/mcp/:botId`.
 */
import type { BotId, NodeSummary } from "@openbot/contracts"
import {
  type McpClaims,
  type McpTokenRecord,
  McpTokenRepo,
  NodeDirectory,
  Orchestrator,
  sessionKeyOf,
  SettingsService,
  SlackConnector,
  type ToolContext,
} from "@openbot/core"
import { randomToken, sha256Hex } from "@openbot/node-protocol"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js"
import { Cause, Clock, Context, Deferred, Effect, Exit, Layer, Option, type Scope } from "effect"
import { bearerTokenOf, hashMcpToken } from "./McpBindingIssuer.ts"
import { errorResult, MAX_RESULT_TEXT_BYTES, renderToolError, toWireResult, type WireToolResult } from "./results.ts"
import { type AnyTool, MAX_DESCRIPTION_CHARS, type ToolCallContext } from "./tool.ts"
import { BotToolkit, type BotToolkitServices } from "./toolkits/bot.ts"
import { BrowserToolkit } from "./toolkits/browser.ts"
import { ComputerToolkit } from "./toolkits/computer.ts"
import { NodeToolkit, type NodeToolkitServices } from "./toolkits/node.ts"
import { SearchToolkit, type SearchToolkitServices } from "./toolkits/search.ts"
import { SlackToolkit } from "./toolkits/slack.ts"
import { TaskToolkit, type TaskToolkitServices } from "./toolkits/tasks.ts"

// ============================================================================ service

export interface McpGatewayShape {
  /** Handles one HTTP request to `/mcp/:botId` (any method). Never rejects. */
  readonly handle: (request: Request) => Promise<Response>
  /** Number of live MCP sessions (tests, diagnostics). */
  readonly sessionCount: Effect.Effect<number>
  /** Closes MCP sessions (all, or one bot's); clients re-initialize on their next request. Returns the count. */
  readonly closeSessions: (filter?: { readonly botId?: BotId | undefined }) => Effect.Effect<number>
}

export class McpGateway extends Context.Service<McpGateway, McpGatewayShape>()("openbot/gateway/McpGateway") {}

/** Every service the default toolkits need. */
export type GatewayToolServices = BotToolkitServices | NodeToolkitServices | TaskToolkitServices | SearchToolkitServices

/** The default toolkits: bot, task, search, node, browser, screen (`computer`, `request_takeover`) and Slack tools. */
export const DefaultToolkits: ReadonlyArray<AnyTool<GatewayToolServices>> = [
  ...BotToolkit,
  ...TaskToolkit,
  ...SearchToolkit,
  ...NodeToolkit,
  ...BrowserToolkit,
  ...ComputerToolkit,
  ...SlackToolkit,
]

export interface McpGatewayOptions<R = GatewayToolServices> {
  /** Tools offered by the gateway (filtered per session by the token's toolsets). Default: all toolkits. */
  readonly tools?: ReadonlyArray<AnyTool<R>> | undefined
  /** Heartbeat progress interval while a call runs (default 4,000 ms; R8 requires ≤ 5 s). */
  readonly progressIntervalMs?: number | undefined
  /** Minimum gap between tool-reported progress notifications (default 1,000 ms). */
  readonly progressMinGapMs?: number | undefined
  /** Max live MCP sessions; the least recently used is closed beyond it (default 256). */
  readonly maxSessions?: number | undefined
  /** Sessions idle longer than this are closed (default 24 h). */
  readonly sessionIdleMs?: number | undefined
  /** Results remembered per session for idempotent replays (default 128). */
  readonly idempotencyCapacity?: number | undefined
  /** Cap on the text of one result (default 10,000 bytes). */
  readonly maxResultBytes?: number | undefined
  readonly serverName?: string | undefined
  readonly serverVersion?: string | undefined
  /** MCP `instructions` sent at initialize. */
  readonly instructions?: string | undefined
}

const DEFAULT_INSTRUCTIONS =
  "OpenBot tools: talk to your team (message_bot, post_to_group, handoff_task, list_bots), ask the user (ask_user, request_approval, notify_user — these never block: end your turn and the answer arrives as a new message), keep memory (remember, forget, recall_memory), schedule routines, save skills, and work on your computers (shell, files, browser, your screen with `computer`; `node` picks a computer from list_nodes; `request_takeover` hands your screen to the owner for logins and codes). Results starting with ERROR: are failures."

// ============================================================================ helpers

const json = (status: number, body: unknown, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  })

const unauthorized = (presentedToken: boolean): Response =>
  json(
    401,
    { error: "invalid_token", message: "A valid OpenBot MCP token is required." },
    { "www-authenticate": presentedToken ? "Bearer error=\"invalid_token\"" : "Bearer" },
  )

const sessionNotFound = (): Response =>
  json(404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null })

const methodNotAllowed = (): Response =>
  json(405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, { allow: "POST, DELETE" })

/** `/mcp/<botId>` (optionally behind a prefix); undefined when the path does not match. */
export const botIdFromPath = (pathname: string): string | undefined => {
  const match = /\/mcp\/([^/]+)\/?$/.exec(pathname)
  if (match === null) return undefined
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return undefined
  }
}

/** The harness tool-call id from `tools/call` `_meta` (mcp-conformance.md §3 / R11). */
export const callIdOf = (meta: Record<string, unknown> | undefined): string | undefined => {
  if (meta === undefined) return undefined
  for (const key of ["claudecode/toolUseId", "callId", "openbot/callId"]) {
    const value = meta[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

/** Small LRU of in-flight / finished call results, keyed per session. */
class ResultCache {
  private readonly entries = new Map<string, Deferred.Deferred<WireToolResult>>()
  constructor(private readonly capacity: number) {}
  get(key: string): Deferred.Deferred<WireToolResult> | undefined {
    const found = this.entries.get(key)
    if (found !== undefined) {
      this.entries.delete(key)
      this.entries.set(key, found)
    }
    return found
  }
  set(key: string, value: Deferred.Deferred<WireToolResult>): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
  delete(key: string, value: Deferred.Deferred<WireToolResult>): void {
    if (this.entries.get(key) === value) this.entries.delete(key)
  }
}

interface GatewaySession {
  id: string | undefined
  readonly tokenHash: string
  readonly claims: McpClaims
  readonly tools: ReadonlyMap<string, AnyTool<any>>
  readonly server: Server
  readonly transport: WebStandardStreamableHTTPServerTransport
  readonly cache: ResultCache
  lastUsedAt: number
}

interface Authenticated {
  readonly hash: string
  readonly record: Option.Option<McpTokenRecord>
}

// ============================================================================ implementation

/**
 * Builds the gateway. The returned service runs tool handlers with the context captured here, so the
 * layer requires every service the tools need (plus `McpTokenRepo` and `NodeDirectory`).
 */
export const makeMcpGateway = <R = GatewayToolServices>(
  options?: McpGatewayOptions<R>,
): Effect.Effect<McpGatewayShape, never, R | McpTokenRepo | NodeDirectory | Orchestrator | Scope.Scope> =>
  Effect.gen(function*() {
    const tools = (options?.tools ?? DefaultToolkits) as ReadonlyArray<AnyTool<R>>
    const progressIntervalMs = Math.max(10, options?.progressIntervalMs ?? 4_000)
    const progressMinGapMs = Math.max(0, options?.progressMinGapMs ?? 1_000)
    const maxSessions = Math.max(1, options?.maxSessions ?? 256)
    const sessionIdleMs = options?.sessionIdleMs ?? 24 * 60 * 60 * 1000
    const idempotencyCapacity = Math.max(1, options?.idempotencyCapacity ?? 128)
    const maxResultBytes = options?.maxResultBytes ?? MAX_RESULT_TEXT_BYTES
    const serverInfo = { name: options?.serverName ?? "openbot", version: options?.serverVersion ?? "1.0.0" }
    const instructions = options?.instructions ?? DEFAULT_INSTRUCTIONS

    const context = yield* Effect.context<R | McpTokenRepo | NodeDirectory>()
    const run = Effect.runPromiseWith(context)
    const repo = yield* McpTokenRepo
    const directory = yield* NodeDirectory
    const orchestrator = yield* Orchestrator

    /**
     * The claims of one call: the conversation of the bot's running turn, else the token's home. A
     * background task's token (`claims.taskId`, D5.7) keeps its origin conversation: the task is not
     * part of the bot's running turn.
     */
    const currentContext = (claims: McpClaims, callId: string | undefined): Effect.Effect<ToolContext> =>
      claims.taskId !== undefined ? Effect.succeed<ToolContext>({ claims, callId, taskId: claims.taskId }) : orchestrator.activeTurn(claims.botId).pipe(
        Effect.map(Option.match({
          onNone: (): ToolContext => ({ claims, callId }),
          onSome: (turn): ToolContext => ({
            claims: turn.conversationId === claims.conversationId
              ? claims
              : { ...claims, conversationId: turn.conversationId, sessionKey: sessionKeyOf(claims.botId, turn.conversationId) },
            callId,
            turnId: turn.id,
          }),
        })),
        Effect.catchCause(() => Effect.succeed<ToolContext>({ claims, callId })),
      )
    const sessions = new Map<string, GatewaySession>()

    const closeSession = (session: GatewaySession): Promise<void> => {
      if (session.id !== undefined) sessions.delete(session.id)
      return Promise.allSettled([session.transport.close(), session.server.close()]).then(() => undefined)
    }

    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Promise.allSettled([...sessions.values()].map(closeSession))).pipe(Effect.asVoid)
    )

    // ---------------------------------------------------------------- auth

    const authenticate = (token: string): Effect.Effect<Authenticated> =>
      Effect.gen(function*() {
        const hash = yield* hashMcpToken(token)
        const found = yield* repo.lookup(hash).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("McpGateway: token lookup failed", cause).pipe(Effect.as(Option.none<McpTokenRecord>()))
          ),
        )
        const now = yield* Clock.currentTimeMillis
        const valid = Option.filter(found, (r) => !r.revoked && (r.expiresAt === undefined || r.expiresAt > now))
        return { hash, record: valid }
      })

    // ---------------------------------------------------------------- tool calls

    const makeProgress = (
      progressToken: string | number | undefined,
      send: (message: string | undefined) => Promise<void>,
    ) => {
      let counter = 0
      let lastSentAt = 0
      const emit = (message: string | undefined) =>
        Effect.suspend(() => {
          counter += 1
          lastSentAt = Date.now()
          const promise = send(message)
          return Effect.promise(() => promise.catch(() => undefined))
        })
      return {
        enabled: progressToken !== undefined,
        current: () => counter,
        heartbeat: progressToken === undefined ? Effect.void : emit(undefined),
        report: (message: string): Effect.Effect<void> =>
          progressToken === undefined
            ? Effect.void
            : Effect.suspend(() => (Date.now() - lastSentAt >= progressMinGapMs ? emit(message) : Effect.void)),
      }
    }

    const runTool = (
      session: GatewaySession,
      tool: AnyTool<R>,
      args: unknown,
      ctx: ToolCallContext,
    ): Effect.Effect<WireToolResult, never, R> =>
      tool.handler(args, ctx).pipe(
        Effect.catch((error) => Effect.succeed(errorResult(renderToolError(error)))),
        Effect.catchDefect((defect) =>
          Effect.logError(`McpGateway: tool ${tool.name} died (bot ${session.claims.botId})`, defect).pipe(
            Effect.as(errorResult("Internal error")),
          )
        ),
        Effect.map((result) => toWireResult(result, maxResultBytes)),
      )

    const callTool = (
      session: GatewaySession,
      params: { readonly name: string; readonly arguments?: Record<string, unknown> | undefined; readonly _meta?: Record<string, unknown> | undefined },
      sendProgress: (progressToken: string | number, progress: number, message: string | undefined) => Promise<void>,
    ): Effect.Effect<WireToolResult, never, R> =>
      Effect.gen(function*() {
        const tool = session.tools.get(params.name)
        if (tool === undefined) {
          return toWireResult(
            errorResult(`Unknown tool "${params.name}". Available tools: ${[...session.tools.keys()].join(", ")}.`),
          )
        }
        const decoded = tool.params.decode(params.arguments ?? {})
        if (!decoded.ok) return toWireResult(errorResult(`Invalid arguments for ${tool.name}: ${decoded.error}.`))

        const rawToken = params._meta?.progressToken
        const progressToken = typeof rawToken === "string" || typeof rawToken === "number" ? rawToken : undefined
        const progress = makeProgress(progressToken, (message) =>
          progressToken === undefined ? Promise.resolve() : sendProgress(progressToken, progress.current(), message))
        const callId = callIdOf(params._meta)
        const toolContext = yield* currentContext(session.claims, callId)
        const ctx: ToolCallContext = {
          tool: toolContext,
          claims: toolContext.claims,
          sessionId: session.id,
          progress: progress.report,
        }

        const work = Effect.scoped(
          Effect.gen(function*() {
            if (progress.enabled) {
              yield* Effect.forkScoped(Effect.forever(Effect.sleep(progressIntervalMs).pipe(Effect.andThen(progress.heartbeat))))
            }
            return yield* runTool(session, tool, decoded.value, ctx)
          }),
        )

        if (tool.idempotent === false) return yield* work

        // Idempotency (D3.3): replay by harness call id; join identical in-flight calls otherwise.
        const key = callId !== undefined
          ? `call:${tool.name}:${callId}`
          : `args:${tool.name}:${yield* sha256Hex(stableJson(decoded.value))}`
        const existing = session.cache.get(key)
        if (existing !== undefined) {
          const heartbeat = progress.enabled
            ? Effect.forkScoped(Effect.forever(Effect.sleep(progressIntervalMs).pipe(Effect.andThen(progress.heartbeat))))
            : Effect.void
          return yield* Effect.scoped(heartbeat.pipe(Effect.andThen(Deferred.await(existing))))
        }
        const deferred = yield* Deferred.make<WireToolResult>()
        session.cache.set(key, deferred)
        return yield* work.pipe(
          Effect.onExit((exit) =>
            Effect.suspend(() => {
              if (Exit.isSuccess(exit)) {
                if (callId === undefined) session.cache.delete(key, deferred)
                return Deferred.succeed(deferred, exit.value)
              }
              session.cache.delete(key, deferred)
              return Deferred.succeed(deferred, toWireResult(errorResult("The original call was cancelled; call the tool again.")))
            })
          ),
        )
      })

    // ---------------------------------------------------------------- sessions

    const toolListFor = (
      claims: McpClaims,
      hostNode: NodeSummary | undefined,
      slack: boolean,
      botSearch: boolean,
    ): ReadonlyMap<string, AnyTool<R>> => {
      const map = new Map<string, AnyTool<R>>()
      for (const tool of tools) {
        if (!claims.toolsets.includes(tool.toolset)) continue
        if (tool.available !== undefined && !tool.available({ claims, hostNode, slack, botSearch })) continue
        if (!map.has(tool.name)) map.set(tool.name, tool)
      }
      return map
    }

    const wireTool = (tool: AnyTool<R>): Tool => ({
      name: tool.name,
      description: tool.description.length > MAX_DESCRIPTION_CHARS
        ? `${tool.description.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
        : tool.description,
      inputSchema: tool.params.inputSchema as Tool["inputSchema"],
      ...(tool.annotations === undefined ? {} : { annotations: { ...tool.annotations } }),
      // R9: never deferred behind Claude's tool search.
      _meta: { "anthropic/alwaysLoad": true },
    })

    const createSession = async (auth: { readonly hash: string; readonly claims: McpClaims }): Promise<GatewaySession> => {
      const hostNode = await run(
        directory.get(auth.claims.hostNodeId).pipe(Effect.option, Effect.map(Option.getOrUndefined)),
      )
      const slack = await run(
        Effect.serviceOption(SlackConnector).pipe(
          Effect.flatMap(Option.match({
            onNone: () => Effect.succeed(false),
            onSome: (connector) => connector.status.pipe(Effect.map((status) => status.connected)),
          })),
        ),
      )
      const botSearch = await run(
        Effect.serviceOption(SettingsService).pipe(
          Effect.flatMap(Option.match({
            onNone: () => Effect.succeed(true),
            onSome: (settings) => settings.get.pipe(Effect.map((s) => s.botSearch)),
          })),
        ),
      )
      const sessionTools = toolListFor(auth.claims, hostNode, slack, botSearch)
      const server = new Server(serverInfo, { capabilities: { tools: {} }, instructions })
      const session: GatewaySession = {
        id: undefined,
        tokenHash: auth.hash,
        claims: auth.claims,
        tools: sessionTools,
        server,
        transport: new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomToken(18),
          onsessioninitialized: (id) => {
            session.id = id
            sessions.set(id, session)
          },
          onsessionclosed: (id) => {
            sessions.delete(id)
          },
        }),
        cache: new ResultCache(idempotencyCapacity),
        lastUsedAt: Date.now(),
      }
      session.transport.onclose = () => {
        if (session.id !== undefined && sessions.get(session.id) === session) sessions.delete(session.id)
      }
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [...sessionTools.values()].map(wireTool),
      }))
      server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        session.lastUsedAt = Date.now()
        const sendProgress = (progressToken: string | number, progress: number, message: string | undefined) =>
          extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress, ...(message === undefined ? {} : { message }) },
          })
        try {
          return await run(callTool(session, request.params, sendProgress), { signal: extra.signal })
        } catch {
          return toWireResult(errorResult("The call was cancelled."))
        }
      })
      await server.connect(session.transport)
      return session
    }

    const evictSessions = async (now: number): Promise<void> => {
      const stale = [...sessions.values()].filter((s) => now - s.lastUsedAt > sessionIdleMs)
      await Promise.allSettled(stale.map(closeSession))
      if (sessions.size >= maxSessions) {
        const byAge = [...sessions.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)
        await Promise.allSettled(byAge.slice(0, sessions.size - maxSessions + 1).map(closeSession))
      }
    }

    // ---------------------------------------------------------------- HTTP

    const handleUnsafe = async (request: Request): Promise<Response> => {
      const url = new URL(request.url)
      const pathBotId = botIdFromPath(url.pathname)
      if (pathBotId === undefined) return json(404, { error: "not_found" })
      if (request.method !== "POST" && request.method !== "DELETE") return methodNotAllowed()

      const token = bearerTokenOf(request)
      const sessionId = request.headers.get("mcp-session-id") ?? undefined
      if (token === undefined) return unauthorized(false)
      const auth = await run(authenticate(token))
      if (Option.isNone(auth.record)) {
        // A dead token also ends the sessions it opened.
        const owned = [...sessions.values()].filter((s) => s.tokenHash === auth.hash)
        await Promise.allSettled(owned.map(closeSession))
        await run(Effect.logWarning("McpGateway: rejected a request with an unknown, revoked or expired token"))
        return unauthorized(true)
      }
      const claims = auth.record.value.claims
      if (claims.botId !== pathBotId) {
        return json(403, { error: "forbidden", message: "This token does not belong to this bot." })
      }
      const authInfo: AuthInfo = { token: "redacted", clientId: claims.botId, scopes: ["openbot"], extra: { sessionKey: claims.sessionKey } }

      if (sessionId !== undefined) {
        const session = sessions.get(sessionId)
        if (session === undefined) return sessionNotFound()
        if (session.tokenHash !== auth.hash) {
          return json(403, { error: "forbidden", message: "This MCP session belongs to another token." })
        }
        session.lastUsedAt = Date.now()
        return session.transport.handleRequest(request, { authInfo })
      }

      if (request.method !== "POST") {
        return json(400, { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: Mcp-Session-Id header is required" }, id: null })
      }
      await evictSessions(Date.now())
      const session = await createSession({ hash: auth.hash, claims })
      return session.transport.handleRequest(request, { authInfo })
    }

    const handle = (request: Request): Promise<Response> =>
      handleUnsafe(request).catch((error: unknown) =>
        run(Effect.logError("McpGateway: request failed", Cause.die(error))).then(
          () => json(500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }),
          () => json(500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }),
        )
      )

    return {
      handle,
      sessionCount: Effect.sync(() => sessions.size),
      closeSessions: (filter) =>
        Effect.promise(async () => {
          const matching = [...sessions.values()].filter((s) => filter?.botId === undefined || s.claims.botId === filter.botId)
          await Promise.allSettled(matching.map(closeSession))
          return matching.length
        }),
    } satisfies McpGatewayShape
  })

/** The gateway with custom options (tools, intervals, limits). */
export const McpGatewayLayer = <R = GatewayToolServices>(
  options?: McpGatewayOptions<R>,
): Layer.Layer<McpGateway, never, R | McpTokenRepo | NodeDirectory | Orchestrator> =>
  Layer.effect(McpGateway, Effect.map(makeMcpGateway(options), McpGateway.of))

/** `McpGateway` with the default toolkits (interfaces §2.1). Mounted by apps/server at `/mcp/:botId`. */
export const McpGatewayLive: Layer.Layer<McpGateway, never, GatewayToolServices | McpTokenRepo | NodeDirectory> =
  McpGatewayLayer()

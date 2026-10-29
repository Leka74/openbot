/**
 * Test support: an in-memory fake `codex app-server` speaking the real wire format over a
 * `CodexTransport`, fixtures, session inputs and an event collector.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HarnessEvent, HarnessRequest, HarnessRequestResolution, TurnId } from "@openbot/contracts"
import { LOCAL_NODE_ID } from "@openbot/contracts"
import type { OpenSessionInput, ResolvedPlacement } from "@openbot/core"
import { makeBot } from "@openbot/core/testing"
import { type Cause, Effect, Queue, type Scope, Sink, Stream } from "effect"
import type { AppServerLauncher, LaunchSpec } from "../src/appServer.ts"
import { CodexNormalizer } from "../src/normalize.ts"
import type { CodexTransport } from "../src/protocol.ts"
import { type MappedRequest, mapServerRequest } from "../src/requests.ts"

const tempDirs: Array<string> = []
process.on("exit", () => {
  // Removes links (e.g. a linked auth.json), never their targets.
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** A fresh temp directory, removed when the test process exits. */
export const tempDir = (prefix = "openbot-codex-"): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
export const turnId = (n: number) => `trn_${String(n).padStart(6, "0")}` as TurnId

// ---------------------------------------------------------------------------- fixtures

export interface FixtureFrame {
  readonly seq: number
  readonly source: "codex.rpc.out" | "codex.rpc.in" | "openbot.control"
  readonly payload: Record<string, unknown>
}

export const loadFixture = (name: string): ReadonlyArray<FixtureFrame> =>
  readFileSync(join(import.meta.dir, "fixtures", name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as FixtureFrame)

// ---------------------------------------------------------------------------- fake app-server

type Json = Record<string, unknown>
export type HandlerResult = unknown | { readonly __error: { readonly code: number; readonly message: string } }
export type Handler = (params: Json, server: FakeAppServer) => HandlerResult | Promise<HandlerResult>

export const rpcError = (code: number, message: string) => ({ __error: { code, message } })

const encoder = new TextEncoder()
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * A scripted app-server. `handlers` answer client requests (async allowed); `notify`/`request`
 * drive the server side. Every client message is recorded in `received`.
 */
export class FakeAppServer {
  readonly received: Array<Json> = []
  readonly handlers: Record<string, Handler>
  private readonly toClient: Queue.Queue<Uint8Array, Cause.Done>
  private readonly waiting = new Map<string, (message: Json) => void>()
  private nextServerId = 0
  private nextThread = 0
  private nextTurn = 0
  private closed = false
  /** Id of the last server → client request. */
  lastServerRequestId = -1
  /** The running native turn (set by the scripted `turn/start` handler). */
  active: { readonly threadId: string; readonly turn: string } | undefined

  constructor(toClient: Queue.Queue<Uint8Array, Cause.Done>, handlers: Record<string, Handler> = {}) {
    this.toClient = toClient
    this.handlers = { ...defaultHandlers(), ...handlers }
  }

  /** The launcher's scope closed it (the process was stopped). */
  get stopped(): boolean {
    return this.closed
  }

  static make = (handlers: Record<string, Handler> = {}) =>
    Effect.map(Queue.unbounded<Uint8Array, Cause.Done>(), (queue) => new FakeAppServer(queue, handlers))

  readonly transport: CodexTransport = {
    incoming: Stream.suspend(() => Stream.fromQueue(this.toClient)),
    outgoing: Sink.forEach((line: string) => Effect.sync(() => this.onLine(line))),
    terminationReason: Effect.succeed("fake app-server exited"),
  }

  newThreadId = () => `thr-${++this.nextThread}`
  newTurnId = () => `turn-${++this.nextTurn}`

  sendRaw(line: string) {
    if (!this.closed) Queue.offerUnsafe(this.toClient, encoder.encode(line))
  }
  send(message: Json) {
    this.sendRaw(`${JSON.stringify(message)}\n`)
  }
  notify(method: string, params: Json) {
    this.send({ method, params })
  }
  /** Server → client request; resolves with the client's `{result}` or `{error}` message. */
  request(method: string, params: Json): Promise<Json> {
    const id = this.nextServerId++
    this.lastServerRequestId = id
    return new Promise((resolve) => {
      this.waiting.set(String(id), resolve)
      this.send({ id, method, params })
    })
  }
  /** Simulates the process dying (stdout ends). */
  close() {
    this.closed = true
    Queue.endUnsafe(this.toClient)
  }

  /** Client requests of `method`, in order. */
  requests(method: string): ReadonlyArray<Json> {
    return this.received.filter((m) => m.method === method && m.id !== undefined).map((m) => (m.params ?? {}) as Json)
  }

  private onLine(raw: string) {
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue
      const message = JSON.parse(line) as Json
      this.received.push(message)
      const method = message.method
      if (typeof method === "string") {
        if (message.id === undefined) continue // client notification (initialized)
        const handler = this.handlers[method]
        const id = message.id
        if (!handler) {
          this.send({ id, error: { code: -32601, message: `unknown method ${method}` } })
          continue
        }
        void Promise.resolve()
          .then(() => handler(isRecord(message.params) ? message.params : {}, this))
          .then(
            (result) => {
              if (isRecord(result) && isRecord(result.__error)) this.send({ id, error: result.__error })
              else this.send({ id, result: result ?? {} })
            },
            (error) => this.send({ id, error: { code: -32603, message: String(error) } }),
          )
        continue
      }
      const key = String(message.id)
      const resolve = this.waiting.get(key)
      if (resolve) {
        this.waiting.delete(key)
        resolve(message)
      }
    }
  }
}

const defaultHandlers = (): Record<string, Handler> => ({
  initialize: () => ({
    userAgent: "openbot/0.162.1 (Test OS; x86_64) test (openbot; 0.0.0)",
    codexHome: "/tmp/codex-home",
    platformFamily: "unix",
    platformOs: "linux",
  }),
  "account/read": () => ({
    account: { type: "chatgpt", email: "ada@example.com", planType: "plus" },
    requiresOpenaiAuth: true,
  }),
  "model/list": () => ({
    data: [
      {
        id: "gpt-test",
        model: "gpt-test",
        displayName: "GPT Test",
        hidden: false,
        isDefault: true,
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "" },
          { reasoningEffort: "high", description: "" },
        ],
      },
      {
        id: "gpt-hidden",
        model: "gpt-hidden",
        displayName: "Hidden",
        hidden: true,
        isDefault: false,
        supportedReasoningEfforts: [],
      },
    ],
    nextCursor: null,
  }),
  "thread/start": (params, server) => {
    const id = server.newThreadId()
    const environments = Array.isArray(params.environments)
      ? params.environments
      : [{ environmentId: "local", cwd: params.cwd }]
    queueMicrotask(() => server.notify("thread/started", { thread: { id } }))
    return {
      thread: { id, environments, cwd: params.cwd, status: { type: "idle" } },
      model: params.model ?? "gpt-test",
    }
  },
  "thread/resume": (params) => ({ thread: { id: params.threadId, environments: [] } }),
  "thread/unsubscribe": () => ({ status: "unsubscribed" }),
  "environment/add": () => ({}),
  "skills/list": () => ({ data: [] }),
  "skills/extraRoots/set": () => ({}),
})

/** A launcher that starts a fresh fake per launch and records the launch specs. */
export const fakeLauncher = (
  make: () => Effect.Effect<FakeAppServer>,
): { readonly launcher: AppServerLauncher; readonly launches: Array<{ spec: LaunchSpec; server: FakeAppServer }> } => {
  const launches: Array<{ spec: LaunchSpec; server: FakeAppServer }> = []
  const launcher: AppServerLauncher = (spec) =>
    Effect.gen(function* () {
      const server = yield* make()
      launches.push({ spec, server })
      yield* Effect.addFinalizer(() => Effect.sync(() => server.close()))
      return { transport: server.transport, pid: undefined }
    })
  return { launcher, launches }
}

// ---------------------------------------------------------------------------- turn scripts

/** Emits a typical completed text turn on `threadId`/`turn`. */
export const emitTextTurn = (server: FakeAppServer, threadId: string, turn: string, text: string, itemId = "msg_1") => {
  server.notify("turn/started", { threadId, turn: { id: turn, status: "inProgress" } })
  server.notify("item/started", {
    threadId,
    turnId: turn,
    item: { type: "agentMessage", id: itemId, text: "", phase: null },
  })
  server.notify("item/agentMessage/delta", { threadId, turnId: turn, itemId, delta: text })
  server.notify("item/completed", {
    threadId,
    turnId: turn,
    item: { type: "agentMessage", id: itemId, text, phase: "final_answer" },
  })
  server.notify("thread/tokenUsage/updated", {
    threadId,
    turnId: turn,
    tokenUsage: {
      total: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
      last: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
      modelContextWindow: 1000,
    },
  })
  server.notify("turn/completed", { threadId, turn: { id: turn, status: "completed", error: null } })
}

// ---------------------------------------------------------------------------- session inputs

export const makePlacement = (cwd: string, overrides: Partial<ResolvedPlacement> = {}): ResolvedPlacement => ({
  mode: "native-local",
  hostNodeId: LOCAL_NODE_ID,
  workspacePath: cwd,
  harnessCwd: cwd,
  env: {},
  disableBuiltinTools: false,
  toolsets: ["bot"],
  promptAppend: "Your tools run on this computer.",
  release: Effect.void,
  ...overrides,
})

export const makeSessionInput = (
  cwd: string,
  onRequest: (request: HarnessRequest) => Effect.Effect<HarnessRequestResolution>,
  overrides: Partial<OpenSessionInput> = {},
): OpenSessionInput => {
  const bot = makeBot({ harness: { kind: "codex" } })
  return {
    bot,
    conversationId: bot.directConversationId,
    sessionKey: `${bot.id}:${bot.directConversationId}`,
    nativeSessionId: undefined,
    placement: makePlacement(cwd),
    instructions: {
      text: "You are Scout, an OpenBot.",
      sections: { base: "You are Scout, an OpenBot.", persona: "", team: "", memoryIndex: "", placement: "" },
      hash: "h1",
    },
    mcp: [
      {
        name: "openbot",
        url: "http://127.0.0.1:4555/mcp/bot_test",
        headers: { authorization: "Bearer secret-token-xyz" },
      },
    ],
    model: "gpt-test",
    effort: "low",
    onRequest,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------- event collection

export interface Collector {
  readonly events: Array<HarnessEvent>
  readonly waitFor: (predicate: (events: ReadonlyArray<HarnessEvent>) => boolean, label?: string) => Effect.Effect<void>
}

export const collect = (events: Stream.Stream<HarnessEvent>) =>
  Effect.gen(function* () {
    const seen: Array<HarnessEvent> = []
    yield* Stream.runForEach(events, (e) => Effect.sync(() => void seen.push(e))).pipe(
      Effect.forkScoped({ startImmediately: true }),
    )
    const collector: Collector = {
      events: seen,
      waitFor: (predicate, label) =>
        waitUntil(
          () => predicate(seen),
          label,
          () => seen.map((e) => e._tag).join(","),
        ),
    }
    return collector
  })

/** Polls `condition` every 5 ms (up to `ms`). */
export const waitUntil = (condition: () => boolean, label = "condition", detail?: () => string, ms = 3000) =>
  Effect.gen(function* () {
    for (let i = 0; i < ms / 5; i++) {
      if (condition()) return
      yield* Effect.sleep(5)
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}${detail ? `; ${detail()}` : ""}`))
  })

export const has =
  (tag: HarnessEvent["_tag"], predicate: (e: HarnessEvent) => boolean = () => true) =>
  (events: ReadonlyArray<HarnessEvent>) =>
    events.some((e) => e._tag === tag && predicate(e))

export const ofTag = <T extends HarnessEvent["_tag"]>(events: ReadonlyArray<HarnessEvent>, tag: T) =>
  events.filter((e): e is Extract<HarnessEvent, { _tag: T }> => e._tag === tag)

/** Runs a scoped test program. */
export const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect))

// ---------------------------------------------------------------------------- fixture replay

export interface ReplayedRequest {
  readonly seq: number
  readonly id: string | number
  readonly method: string
  readonly params: Record<string, unknown>
  readonly mapped: MappedRequest
  /** What the recorder answered (`codex.rpc.out` response with the same id). */
  recorded?: unknown
}

export interface Replay {
  readonly events: ReadonlyArray<HarnessEvent>
  readonly requests: ReadonlyArray<ReplayedRequest>
  readonly turns: ReadonlyArray<TurnId>
  readonly normalizer: CodexNormalizer
}

/**
 * Replays a recorded session the way `Session.ts` drives the normalizer: `expectTurn` before each
 * `turn/start`, `bindTurn` on its response, `handle` for every notification, `mapServerRequest`
 * for every server request (with the normalizer state at that moment).
 */
export const replayFixture = (frames: ReadonlyArray<FixtureFrame>): Replay => {
  const normalizer = new CodexNormalizer({ hostNodeId: LOCAL_NODE_ID })
  const events: Array<HarnessEvent> = []
  const requests: Array<ReplayedRequest> = []
  const turns: Array<TurnId> = []
  const turnStarts = new Map<string, TurnId>()
  let current: TurnId | undefined
  for (const frame of frames) {
    const p = frame.payload
    if (frame.source === "openbot.control") {
      if (p.action === "send") {
        current = turnId(turns.length + 1)
        turns.push(current)
        normalizer.expectTurn(current)
      }
      continue
    }
    const method = typeof p.method === "string" ? p.method : undefined
    const params = isRecord(p.params) ? p.params : {}
    if (frame.source === "codex.rpc.out") {
      if (method === "turn/start" && current) turnStarts.set(String(p.id), current)
      if (!method) {
        const request = requests.find((r) => String(r.id) === String(p.id) && r.recorded === undefined)
        if (request) request.recorded = p.result ?? p.error
      }
      continue
    }
    if (!method) {
      const owner = turnStarts.get(String(p.id))
      const result = isRecord(p.result) ? p.result : {}
      const native = isRecord(result.turn) && typeof result.turn.id === "string" ? result.turn.id : undefined
      if (owner && native) events.push(...normalizer.bindTurn(native, owner))
      continue
    }
    if (p.id !== undefined) {
      const id = p.id as string | number
      requests.push({
        seq: frame.seq,
        id,
        method,
        params,
        mapped: mapServerRequest(id, method, params, { normalizer, nodeIdForEnvironment: () => LOCAL_NODE_ID }),
      })
      continue
    }
    events.push(...normalizer.handle(method, params))
  }
  return { events, requests, turns, normalizer }
}

// ---------------------------------------------------------------------------- scripted turns

export interface TurnContext {
  readonly server: FakeAppServer
  readonly threadId: string
  readonly turn: string
  readonly params: Record<string, unknown>
}

/** `turn/start` handler: answers with a new native turn id, then runs `script` for the input text. */
export const scriptedTurnStart =
  (script: (text: string, ctx: TurnContext) => void | Promise<void>): Handler =>
  (params, server) => {
    const turn = server.newTurnId()
    const threadId = String(params.threadId)
    const input = Array.isArray(params.input) ? params.input : []
    const first = input[0]
    const text = isRecord(first) && typeof first.text === "string" ? first.text : ""
    server.active = { threadId, turn }
    setTimeout(() => void script(text, { server, threadId, turn, params }), 1)
    return { turn: { id: turn, status: "inProgress", items: [] } }
  }

/** `turn/interrupt` handler: ends the turn as interrupted. */
export const interruptHandler: Handler = (params, server) => {
  setTimeout(() => {
    server.notify("turn/completed", {
      threadId: params.threadId,
      turn: { id: params.turnId, status: "interrupted", error: null },
    })
    server.active = undefined
  }, 1)
  return {}
}

/** `thread/compact/start` handler: runs an internal compaction turn. */
export const compactHandler: Handler = (params, server) => {
  const threadId = String(params.threadId)
  const turn = server.newTurnId()
  setTimeout(() => {
    server.notify("turn/started", { threadId, turn: { id: turn, status: "inProgress" } })
    server.notify("item/completed", { threadId, turnId: turn, item: { type: "contextCompaction", id: "cc" } })
    server.notify("thread/tokenUsage/updated", {
      threadId,
      turnId: turn,
      tokenUsage: {
        total: {
          totalTokens: 500,
          inputTokens: 400,
          cachedInputTokens: 0,
          outputTokens: 100,
          reasoningOutputTokens: 0,
        },
        last: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0 },
        modelContextWindow: 1000,
      },
    })
    server.notify("turn/completed", { threadId, turn: { id: turn, status: "completed", error: null } })
  }, 1)
  return {}
}

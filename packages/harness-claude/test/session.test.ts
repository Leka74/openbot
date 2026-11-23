import { describe, expect, test } from "bun:test"
import type { HarnessEvent, HarnessRequest, HarnessRequestResolution } from "@openbot/contracts"
import { type HarnessSession, HarnessRegistry, makeDataDir, type OpenSessionInput, ProcessLedger } from "@openbot/core"
import { TestPorts } from "@openbot/core/testing"
import { Effect, Exit, Layer, Scope } from "effect"
import type { ChildProcess } from "node:child_process"
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { type ClaudeHarnessConfig, ClaudeHarnessLive, makeClaudeDriver } from "../src/Driver.ts"
import type { ClaudeQueryFunction } from "../src/sdk.ts"
import { type SessionDeps, TASK_BASH_DEFAULT_TIMEOUT_MS, TASK_BASH_MAX_TIMEOUT_MS } from "../src/Session.ts"
import { supportsProcessGroups } from "../src/spawn.ts"
import {
  cliFrames,
  collect,
  type Collector,
  echo,
  type FakeQuery,
  fakeQueryFactory,
  type FakeQueryOptions,
  frames,
  has,
  makePlacement,
  makeSessionInput,
  nextMsgId,
  replyText,
  type Script,
  tempDir,
  turnId,
} from "./support.ts"

const SESSION_ID = "11111111-2222-3333-4444-555555555555"

/** Default script: echoes text turns; special prompts drive approvals, questions, interrupts, crashes. */
const script: Script = async (fake, input) => {
  const text = input.text
  if (input.priority === "next" || input.priority === "now") return // folded into the running turn by the CLI
  if (text === "/compact") {
    fake.emit(frames.status("compacting"))
    fake.emit({
      type: "system",
      subtype: "compact_boundary",
      uuid: "cb",
      compact_metadata: { trigger: "manual", pre_tokens: 9000, post_tokens: 900 },
    })
    fake.emit(frames.result({ result: "" }))
    return
  }
  if (text === "run" || text === "ask" || text === "bgrun") {
    const id = nextMsgId()
    const toolUseId = text === "run" ? "toolu_run" : text === "bgrun" ? "toolu_bg" : "toolu_ask"
    const name = text === "ask" ? "AskUserQuestion" : "Bash"
    const toolInput =
      text === "bgrun"
        ? { command: "render.sh --full", description: "Render the film", run_in_background: true, timeout: 600000 }
        : text === "run"
          ? { command: "touch x && echo done", description: "Touch x" }
          : {
              questions: [
                {
                  question: "Which color?",
                  header: "Color",
                  options: [{ label: "Blue" }, { label: "Orange" }],
                  multiSelect: false,
                },
              ],
            }
    fake.emit(frames.init())
    fake.emit(frames.messageStart(id))
    fake.emit(frames.blockStart(id, 0, { type: "tool_use", id: toolUseId, name, input: {} }))
    fake.emit(frames.assistant(id, { type: "tool_use", id: toolUseId, name, input: toolInput }))
    const controller = new AbortController()
    fake.onInterrupt(() => controller.abort())
    const result = await fake.canUseTool(name, toolInput, {
      signal: controller.signal,
      toolUseID: toolUseId,
      requestId: `req_${toolUseId}`,
      suggestions: [{ type: "addRules", rules: [{ toolName: name }], behavior: "allow", destination: "localSettings" }],
    })
    ;(fake as unknown as { permission: unknown }).permission = result
    if (fake.closed) return
    if (result.behavior === "allow") fake.emit(frames.toolResult(toolUseId, "done"))
    else fake.emit(frames.toolResult(toolUseId, result.message, true))
    const id2 = nextMsgId()
    fake.emit(frames.assistant(id2, { type: "text", text: "after tool" }))
    fake.emit(frames.result())
    return
  }
  if (text === "slow") {
    const id = nextMsgId()
    fake.emit(frames.init())
    fake.emit(frames.messageStart(id))
    fake.emit(frames.blockStart(id, 0, { type: "text", text: "" }))
    fake.emit(frames.textDelta(id, 0, "partial"))
    fake.onInterrupt(() => {
      fake.emit(frames.assistant(id, { type: "text", text: "partial" }, { aborted: true }))
      fake.emit({
        type: "user",
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
      })
      fake.emit(
        frames.result({
          subtype: "error_during_execution",
          is_error: true,
          terminal_reason: "aborted_streaming",
          stop_reason: null,
        }),
      )
    })
    return
  }
  if (text === "late") {
    // The CLI finishes the turn before folding in the steer, then answers it as its next turn.
    const id = nextMsgId()
    fake.emit(frames.init())
    fake.emit(frames.messageStart(id))
    fake.emit(frames.blockStart(id, 0, { type: "text", text: "" }))
    fake.emit(frames.textDelta(id, 0, "first part"))
    while (!fake.received.some((r) => r.priority === "next")) await Bun.sleep(2)
    const steered = fake.received.find((r) => r.priority === "next")!
    fake.emit(frames.assistant(id, { type: "text", text: "first part" }))
    fake.emit(frames.result(echo(input.uuid)))
    replyText(fake, `echo:${steered.text}`, steered.uuid)
    return
  }
  if (text === "preempted") {
    // A CLI that preempts the running step for queued input: an aborted result that consumed
    // nothing, then the steered input answered as its next turn.
    const id = nextMsgId()
    fake.emit(frames.init())
    fake.emit(frames.messageStart(id))
    fake.emit(frames.blockStart(id, 0, { type: "text", text: "" }))
    fake.emit(frames.textDelta(id, 0, "working"))
    while (!fake.received.some((r) => r.priority === "next")) await Bun.sleep(2)
    const steered = fake.received.find((r) => r.priority === "next")!
    fake.emit(frames.assistant(id, { type: "text", text: "working" }, { aborted: true }))
    fake.emit(
      frames.result({
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_streaming",
        stop_reason: null,
      }),
    )
    replyText(fake, `echo:${steered.text}`, input.uuid, steered.uuid)
    return
  }
  if (text === "crash") {
    fake.emit(frames.init())
    fake.frames.end(new Error("Claude Code process exited with code 1"))
    return
  }
  replyText(fake, `echo:${text}`, input.uuid)
}

interface Env {
  readonly driver: Effect.Success<ReturnType<typeof makeClaudeDriver>>
  readonly input: OpenSessionInput
  readonly root: string
  readonly requests: Array<HarnessRequest>
  readonly fake: () => FakeQuery
}

interface Harness extends Env {
  readonly session: HarnessSession
  readonly collector: Collector
}

const makeEnv = (
  options: {
    readonly resolve?: (request: HarnessRequest) => Effect.Effect<HarnessRequestResolution>
    readonly input?: Partial<OpenSessionInput>
    readonly config?: Partial<ClaudeHarnessConfig>
    readonly fake?: FakeQueryOptions
    readonly ledger?: SessionDeps["ledger"]
    /** Replaces the default fake-CLI script. */
    readonly script?: Script
  } = {},
) =>
  Effect.gen(function* () {
    const root = tempDir()
    const cwd = join(root, "bots", "bot_test", "workspace")
    const { query, state } = fakeQueryFactory(options.script ?? script, SESSION_ID, options.fake)
    let uuid = 0
    const driver = yield* makeClaudeDriver(
      {
        query,
        executable: "bundled",
        newUuid: () => `uuid-${++uuid}`,
        env: { PATH: "/usr/bin", CLAUDECODE: "1", HOME: "/home/x" },
        ...options.config,
      },
      { dataDir: makeDataDir(root), ledger: options.ledger },
    )
    const requests: Array<HarnessRequest> = []
    const resolve = options.resolve ?? (() => Effect.succeed<HarnessRequestResolution>({ decision: "allow-once" }))
    const input = makeSessionInput(
      cwd,
      (request) => {
        requests.push(request)
        return resolve(request)
      },
      options.input,
    )
    return { driver, input, requests, root, fake: () => state.last! } satisfies Env
  })

/** Opens a session and collects its events, both in the ambient scope. */
const setup = (options: Parameters<typeof makeEnv>[0] = {}) =>
  Effect.gen(function* () {
    const env = yield* makeEnv(options)
    const session = yield* env.driver.openSession(env.input)
    const collector = yield* collect(session.events)
    return { ...env, session, collector } satisfies Harness
  })

const waitUntil = (condition: () => boolean, label = "condition") =>
  Effect.gen(function* () {
    for (let i = 0; i < 400; i++) {
      if (condition()) return
      yield* Effect.sleep(5)
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`))
  })

const permissionOf = (fake: FakeQuery) => (fake as unknown as { permission?: Record<string, unknown> }).permission

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

const tags = (events: ReadonlyArray<HarnessEvent>) => events.map((e) => e._tag)

describe("Claude session (fake query)", () => {
  test("open: clean-room options, no MCP on argv, setMcpServers with headers, SessionBound first", () =>
    run(
      Effect.gen(function* () {
        const h = yield* setup()
        const fake = h.fake()
        const options = fake.options
        expect(options).toMatchObject({
          cwd: h.input.placement.harnessCwd,
          settingSources: [],
          strictMcpConfig: true,
          permissionMode: "default",
          includePartialMessages: true,
          sessionId: "uuid-1",
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: "You are Scout, an OpenBot.",
            snapshot: false,
          },
          allowedTools: ["mcp__openbot__*"],
          model: "haiku",
          settings: {
            autoMemoryEnabled: false,
            disableAllHooks: true,
            disableClaudeAiConnectors: true,
            syncClaudeAiSkills: false,
            syncClaudeAiPlugins: false,
            attribution: { commit: "", pr: "", sessionUrl: false },
          },
          additionalDirectories: [join(h.root, "attachments")],
        })
        expect((options.settings as Record<string, unknown>).autoMemoryDirectory).toBeUndefined()
        expect(options.plugins).toBeUndefined() // no skills library yet
        expect(options.disallowedTools).toEqual(
          expect.arrayContaining([
            "SendMessage",
            "CronCreate",
            "ScheduleWakeup",
            "RemoteTrigger",
            "PushNotification",
            "Workflow",
            "ReportFindings",
          ]),
        )
        expect(options.tools).toBeUndefined()
        expect(options.resume).toBeUndefined()
        expect(options.mcpServers).toBeUndefined()
        expect(options.pathToClaudeCodeExecutable).toBeUndefined()
        // env hygiene: the parent Claude Code marker is dropped, the client app is set
        const env = options.env as Record<string, string>
        expect(env.CLAUDECODE).toBeUndefined()
        expect(env.HOME).toBe("/home/x")
        expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toStartWith("openbot/")
        // tool output caps (the brain's own values would win)
        expect(env.BASH_MAX_OUTPUT_LENGTH).toBe("20000")
        expect(env.MAX_MCP_OUTPUT_TOKENS).toBe("15000")
        // tokens never reach the CLI command line: only setMcpServers (stdin) carries them
        const argvVisible = JSON.stringify({ ...options, canUseTool: undefined, abortController: undefined })
        expect(argvVisible).not.toContain("secret-token-xyz")
        expect(fake.mcpCalls).toEqual([
          {
            openbot: {
              type: "http",
              url: "http://127.0.0.1:4555/mcp/bot_test",
              headers: { authorization: "Bearer secret-token-xyz" },
              alwaysLoad: true,
              timeout: 1_800_000,
            },
          },
        ])
        yield* h.collector.waitFor(has("SessionBound"))
        expect(h.collector.events[0]).toEqual({ _tag: "SessionBound", nativeSessionId: "uuid-1" })
        expect(yield* h.session.nativeSessionId).toBe("uuid-1")
      }),
    ))

  test("multi-turn through the streaming input queue", () =>
    run(
      Effect.gen(function* () {
        const h = yield* setup()
        yield* h.session.startTurn({ turnId: turnId(1), text: "hello", attachments: [] })
        yield* h.collector.waitFor(
          has("TurnCompleted", (e) => e._tag === "TurnCompleted" && e.turnId === turnId(1)),
          "turn 1",
        )
        yield* h.session.startTurn({ turnId: turnId(2), text: "again", attachments: [] })
        yield* h.collector.waitFor(
          has("TurnCompleted", (e) => e._tag === "TurnCompleted" && e.turnId === turnId(2)),
          "turn 2",
        )
        const fake = h.fake()
        expect(fake.received.map((r) => r.text)).toEqual(["hello", "again"])
        expect(fake.received.map((r) => r.uuid)).toEqual(["uuid-2", "uuid-3"])
        expect(h.collector.events.filter((e) => e._tag === "SessionBound")).toHaveLength(1)
        const finals = h.collector.events.filter(
          (e) => e._tag === "ItemUpserted" && e.item._tag === "Message" && !e.item.streaming,
        )
        expect(
          finals.map((e) =>
            e._tag === "ItemUpserted" && e.item._tag === "Message" ? `${e.turnId}:${e.item.text}` : "",
          ),
        ).toEqual([`${turnId(1)}:echo:hello`, `${turnId(2)}:echo:again`])
        expect(tags(h.collector.events).filter((t) => t.startsWith("Turn"))).toEqual([
          "TurnStarted",
          "TurnCompleted",
          "TurnStarted",
          "TurnCompleted",
        ])
        expect(h.collector.events.some((e) => e._tag === "Usage")).toBe(true)
        expect(yield* h.session.contextUsage).toEqual({ usedTokens: 1234, windowTokens: 200_000 })
      }),
    ))

  test("canUseTool → onRequest: command approval allowed", () =>
    run(
      Effect.gen(function* () {
        const h = yield* setup()
        yield* h.session.startTurn({ turnId: turnId(1), text: "run", attachments: [] })
        yield* h.collector.waitFor(has("TurnCompleted"), "turn")
        expect(h.requests).toHaveLength(1)
        expect(h.requests[0]).toMatchObject({
          kind: "command-approval",
          toolName: "Bash",
          command: "touch x && echo done",
          toolKey: "toolu_run",
          nativeRequestId: "req_toolu_run",
          cwd: h.input.placement.harnessCwd,
        })
        const permission = permissionOf(h.fake())!
        expect(permission).toMatchObject({ behavior: "allow", updatedInput: { command: "touch x && echo done" } })
        const tool = h.collector.events.filter((e) => e._tag === "ItemUpserted" && e.key === "toolu_run").at(-1)
        expect(tool).toMatchObject({ item: { status: "completed", kind: "shell", outputPreview: "done" } })
      }),
    ))

  test("background work: a backgrounded Bash call runs in the foreground with a long timeout; the main session is untouched", () =>
    run(
      Effect.gen(function* () {
        const task = yield* setup({ input: { purpose: "task" } })
        yield* task.session.startTurn({ turnId: turnId(1), text: "bgrun", attachments: [] })
        yield* task.collector.waitFor(has("TurnCompleted"), "task turn")
        expect(permissionOf(task.fake())).toMatchObject({
          behavior: "allow",
          updatedInput: { command: "render.sh --full", run_in_background: false, timeout: TASK_BASH_MAX_TIMEOUT_MS },
        })
        const env = task.fake().options.env as Record<string, string>
        expect(env.BASH_MAX_TIMEOUT_MS).toBe(String(TASK_BASH_MAX_TIMEOUT_MS))
        expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe(String(TASK_BASH_DEFAULT_TIMEOUT_MS))

        const main = yield* setup()
        yield* main.session.startTurn({ turnId: turnId(2), text: "bgrun", attachments: [] })
        yield* main.collector.waitFor(has("TurnCompleted"), "main turn")
        expect(permissionOf(main.fake())).toMatchObject({
          behavior: "allow",
          updatedInput: { run_in_background: true, timeout: 600000 },
        })
        expect((main.fake().options.env as Record<string, string>).BASH_MAX_TIMEOUT_MS).toBeUndefined()
      }),
    ))

  test("canUseTool → onRequest: deny → declined tool; allow-session → session-scoped rules", () =>
    run(
      Effect.gen(function* () {
        const decisions: Array<HarnessRequestResolution> = [
          { decision: "deny", message: "Not now" },
          { decision: "allow-session" },
        ]
        const h = yield* setup({ resolve: () => Effect.succeed(decisions.shift()!) })
        yield* h.session.startTurn({ turnId: turnId(1), text: "run", attachments: [] })
        yield* h.collector.waitFor(has("TurnCompleted"), "turn 1")
        const declined = h.collector.events.filter((e) => e._tag === "ItemUpserted" && e.key === "toolu_run").at(-1)
        expect(declined).toMatchObject({ item: { status: "declined", error: "Not now" } })
        yield* h.session.startTurn({ turnId: turnId(2), text: "run", attachments: [] })
        yield* h.collector.waitFor(
          has("TurnCompleted", (e) => e._tag === "TurnCompleted" && e.turnId === turnId(2)),
          "turn 2",
        )
        const permission = permissionOf(h.fake())!
        expect(permission).toMatchObject({
          behavior: "allow",
          updatedPermissions: [
            { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" },
          ],
        })
      }),
    ))

  test("AskUserQuestion answers flow back through updatedInput.answers", () =>
    run(
      Effect.gen(function* () {
        const h = yield* setup({ resolve: () => Effect.succeed({ answers: { q0: "Blue" } }) })
        yield* h.session.startTurn({ turnId: turnId(1), text: "ask", attachments: [] })
        yield* h.collector.waitFor(has("TurnCompleted"), "turn")
        expect(h.requests[0]).toMatchObject({
          kind: "question",
          questions: [
            {
              id: "q0",
              prompt: "Which color?",
              options: [{ label: "Blue" }, { label: "Orange" }],
              allowFreeText: true,
            },
          ],
        })
        const permission = permissionOf(h.fake())!
        expect(permission).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Which color?": "Blue" } } })
        expect((permission.updatedInput as Record<string, unknown>).questions).toBeDefined()
      }),
    ))

  test("interrupt: q.interrupt() → aborted text and TurnInterrupted; the session stays usable", () =>
    run(
      Effect.gen(function* () {
        const h = yield* setup()
        yield* h.session.startTurn({ turnId: turnId(1), text: "slow", attachments: [] })
        yield* h.collector.waitFor(
          (es) => es.some((e) => e._tag === "ItemUpserted" && e.item._tag === "Message"),
          "partial text",
        )
        yield* h.session.interrupt
        yield* h.collector.waitFor(has("TurnInterrupted"), "interrupted")
        expect(h.fake().interrupts).toBe(1)
        const last = h.collector.events.filter((e) => e._tag === "ItemUpserted" && e.item._tag === "Message").at(-1)
        expect(last).toMatchObject({ item: { text: "partial", streaming: false, aborted: true } })
        yield* h.session.startTurn({ turnId: turnId(2), text: "still there?", attachments: [] })
        yield* h.collector.waitFor(
          has("TurnCompleted", (e) => e._tag === "TurnCompleted" && e.turnId === turnId(2)),
          "turn 2",
        )
        // interrupting while idle is a no-op
        yield* h.session.interrupt
        expect(h.fake().interrupts).toBe(1)
      }),
    ))

  test("interrupt during a pending approval cancels the onRequest fiber", () =>
    run(
      Effect.gen(function* () {
        const h = yield* setup({ resolve: () => Effect.never })
        yield* h.session.startTurn({ turnId: turnId(1), text: "run", attachments: [] })
        yield* waitUntil(() => h.requests.length === 1, "approval request")
        yield* h.session.interrupt
        yield* waitUntil(() => permissionOf(h.fake()) !== undefined, "permission answer")
        expect(permissionOf(h.fake())).toMatchObject({ behavior: "deny" })
      }),
    ))

  test("close (scope): answers pending approvals, interrupts accepted turns, ends events, closes the query", () =>
    run(
      Effect.gen(function* () {
        const env = yield* makeEnv({ resolve: () => Effect.never })
        const sessionScope = yield* Scope.make()
        const session = yield* env.driver.openSession(env.input).pipe(Scope.provide(sessionScope))
        const collector = yield* collect(session.events)
        yield* session.startTurn({ turnId: turnId(1), text: "run", attachments: [] })
        yield* waitUntil(() => env.requests.length === 1, "approval request")
        yield* Scope.close(sessionScope, Exit.void)
        yield* collector.done
        expect(tags(collector.events).slice(-2)).toEqual(["TurnInterrupted", "SessionClosed"])
        expect(collector.events.at(-1)).toEqual({ _tag: "SessionClosed", reason: "closed" })
        expect(env.fake().closed).toBe(true)
        yield* waitUntil(() => permissionOf(env.fake()) !== undefined, "permission answer")
        expect(permissionOf(env.fake())).toMatchObject({ behavior: "deny" })
        // the tool item was finalized as failed (interrupted)
        const tool = collector.events.filter((e) => e._tag === "ItemUpserted" && e.key === "toolu_run").at(-1)
        expect(tool).toMatchObject({ item: { status: "failed", error: "Interrupted" } })
        const exit = yield* Effect.exit(session.startTurn({ turnId: turnId(2), text: "x", attachments: [] }))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(JSON.stringify(exit)).toContain("closed")
      }),
    ))

  test("unexpected CLI exit → TurnFailed(closed, retryable) + SessionClosed", () =>
    run(
      Effect.gen(function* () {
        const h = yield* setup()
        yield* h.session.startTurn({ turnId: turnId(1), text: "crash", attachments: [] })
        yield* h.collector.waitFor(has("SessionClosed"), "closed")
        const failed = h.collector.events.find((e) => e._tag === "TurnFailed")
        expect(failed).toMatchObject({ turnId: turnId(1), error: { code: "closed", retryable: true } })
        expect(failed && failed._tag === "TurnFailed" && failed.error.message).toContain("exited with code 1")
        const exit = yield* Effect.exit(h.session.startTurn({ turnId: turnId(2), text: "x", attachments: [] }))
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    ))

  test("resume: reopens with `resume` (no new sessionId) and re-registers MCP", () =>
    run(
      Effect.gen(function* () {
        const h = yield* setup({ input: { nativeSessionId: "abc-native" } })
        expect(h.fake().options.resume).toBe("abc-native")
        expect(h.fake().options.sessionId).toBeUndefined()
        expect(h.fake().mcpCalls).toHaveLength(1)
        yield* h.collector.waitFor(has("SessionBound"))
        expect(h.collector.events[0]).toEqual({ _tag: "SessionBound", nativeSessionId: "abc-native" })
      }),
    ))

  test("brain-mcp-hands placement disables every built-in tool", () =>
    run(
      Effect.gen(function* () {
        const cwd = tempDir()
        const h = yield* setup({
          input: {
            placement: makePlacement(cwd, {
              mode: "brain-mcp-hands",
              disableBuiltinTools: true,
              env: { OPENBOT_NODE: "nod_1" },
            }),
          },
        })
        expect(h.fake().options.tools).toEqual([])
        expect((h.fake().options.env as Record<string, string>).OPENBOT_NODE).toBe("nod_1")
      }),
    ))

  test("the brain's own tool output caps win over the defaults", () =>
    run(
      Effect.gen(function* () {
        const h = yield* setup({
          config: { env: { PATH: "/usr/bin", HOME: "/home/x", BASH_MAX_OUTPUT_LENGTH: "50000" } },
        })
        const env = h.fake().options.env as Record<string, string>
        expect(env.BASH_MAX_OUTPUT_LENGTH).toBe("50000")
        expect(env.MAX_MCP_OUTPUT_TOKENS).toBe("15000")
      }),
    ))

  test("steer pushes priority 'next' (never 'now', which preempts the turn) into the running turn", () =>
    run(
      Effect.gen(function* () {
        const h = yield* setup()
        yield* h.session.startTurn({ turnId: turnId(1), text: "slow", attachments: [] })
        yield* h.collector.waitFor(has("TurnStarted"))
        yield* Effect.sleep(10)
        yield* h.session.steer({ turnId: turnId(1), text: "also this", attachments: [] })
        yield* Effect.sleep(10)
        const fake = h.fake()
        expect(fake.received.map((r) => [r.text, r.priority])).toEqual([
          ["slow", undefined],
          ["also this", "next"],
        ])
        yield* h.session.interrupt
        yield* h.collector.waitFor(has("TurnInterrupted"))
      }),
    ))

  test("compact sends /compact and resolves on its result; compaction updates context", () =>
    run(
      Effect.gen(function* () {
        const h = yield* setup()
        yield* h.session.startTurn({ turnId: turnId(1), text: "hello", attachments: [] })
        yield* h.collector.waitFor(has("TurnCompleted"))
        yield* h.session.compact
        expect(h.fake().received.at(-1)?.text).toBe("/compact")
        yield* h.collector.waitFor(
          has("ContextUsage", (e) => e._tag === "ContextUsage" && e.usedTokens === 900),
          "compaction context",
        )
        expect(h.collector.events.filter((e) => e._tag === "TurnStarted")).toHaveLength(1)
        expect(h.collector.events.filter((e) => e._tag === "ItemUpserted" && e.item._tag === "Notice")).toEqual([])
      }),
    ))

  test("image attachments are inlined before the text and referenced by path", () =>
    run(
      Effect.gen(function* () {
        const dir = tempDir()
        const png = join(dir, "red.png")
        yield* Effect.promise(() => Bun.write(png, new Uint8Array([137, 80, 78, 71, 1, 2, 3])))
        const h = yield* setup()
        yield* h.session.startTurn({
          turnId: turnId(1),
          text: "what color?",
          attachments: [
            { path: png, mime: "image/png", name: "red.png" },
            { path: join(dir, "a.pdf"), mime: "application/pdf", name: "a.pdf" },
          ],
        })
        yield* h.collector.waitFor(has("TurnCompleted"))
        const content = h.fake().received[0]!.content as Array<Record<string, unknown>>
        expect(content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } })
        expect(content[1]).toMatchObject({ type: "text" })
        expect(String(content[1]!.text)).toContain(png)
        expect(String(content[1]!.text)).toContain("a.pdf")
      }),
    ))
  test("steer without a running turn (or for another turn) fails turn-rejected and pushes nothing", () =>
    run(
      Effect.gen(function* () {
        const h = yield* setup()
        const idle = yield* Effect.exit(h.session.steer({ turnId: turnId(1), text: "hey", attachments: [] }))
        expect(JSON.stringify(idle)).toContain("turn-rejected")
        yield* h.session.startTurn({ turnId: turnId(2), text: "slow", attachments: [] })
        yield* h.collector.waitFor(has("TurnStarted"))
        const other = yield* Effect.exit(h.session.steer({ turnId: turnId(9), text: "hey", attachments: [] }))
        expect(JSON.stringify(other)).toContain("turn-rejected")
        yield* h.session.interrupt
        const stopping = yield* Effect.exit(h.session.steer({ turnId: turnId(2), text: "hey", attachments: [] }))
        expect(JSON.stringify(stopping)).toContain("turn-rejected")
        yield* h.collector.waitFor(has("TurnInterrupted"))
        expect(h.fake().received.map((r) => r.text)).toEqual(["slow"])
      }),
    ))

  test("a steer the CLI answers as its next turn stays in the same OpenBot turn", () =>
    run(
      Effect.gen(function* () {
        const h = yield* setup()
        yield* h.session.startTurn({ turnId: turnId(1), text: "late", attachments: [] })
        yield* h.collector.waitFor(
          (es) => es.some((e) => e._tag === "ItemUpserted" && e.item._tag === "Message"),
          "first part",
        )
        yield* h.session.steer({ turnId: turnId(1), text: "and this", attachments: [] })
        yield* h.collector.waitFor(has("TurnCompleted"), "turn")
        yield* Effect.sleep(20)
        const turnEvents = h.collector.events.filter((e) => e._tag === "TurnStarted" || e._tag === "TurnCompleted")
        expect(turnEvents).toEqual([
          { _tag: "TurnStarted", turnId: turnId(1) },
          expect.objectContaining({ _tag: "TurnCompleted", turnId: turnId(1) }),
        ])
        const finals = h.collector.events.flatMap((e) =>
          e._tag === "ItemUpserted" && e.item._tag === "Message" && !e.item.streaming
            ? [`${e.turnId}:${e.item.text}`]
            : [],
        )
        expect(finals).toEqual([`${turnId(1)}:first part`, `${turnId(1)}:echo:and this`])
        // the answer to the steer was fully streamed before the turn completed
        const completedAt = h.collector.events.findIndex((e) => e._tag === "TurnCompleted")
        const steerAnswerAt = h.collector.events.findIndex(
          (e) =>
            e._tag === "ItemUpserted" &&
            e.item._tag === "Message" &&
            e.item.text === "echo:and this" &&
            !e.item.streaming,
        )
        expect(steerAnswerAt).toBeLessThan(completedAt)
        expect(h.collector.events.filter((e) => e._tag === "Usage")).toHaveLength(2)
      }),
    ))

  test("a CLI preemption for steered input (aborted_*, no OpenBot interrupt) keeps the OpenBot turn open; the steer is answered in it", () =>
    run(
      Effect.gen(function* () {
        const h = yield* setup()
        yield* h.session.startTurn({ turnId: turnId(1), text: "preempted", attachments: [] })
        yield* h.collector.waitFor(
          (es) => es.some((e) => e._tag === "ItemUpserted" && e.item._tag === "Message"),
          "first part",
        )
        yield* h.session.steer({ turnId: turnId(1), text: "from a teammate", attachments: [] })
        yield* h.collector.waitFor(has("TurnCompleted"), "turn")
        yield* Effect.sleep(20)
        expect(h.collector.events.some((e) => e._tag === "TurnInterrupted")).toBe(false)
        const finals = h.collector.events.flatMap((e) =>
          e._tag === "ItemUpserted" && e.item._tag === "Message" && !e.item.streaming
            ? [`${e.turnId}:${e.item.text}`]
            : [],
        )
        expect(finals).toContain(`${turnId(1)}:echo:from a teammate`)
      }),
    ))

  test("slash-leading turn text is delivered verbatim (client_composed), other text is not", () =>
    run(
      Effect.gen(function* () {
        const h = yield* setup()
        yield* h.session.startTurn({ turnId: turnId(1), text: "/clear everything please", attachments: [] })
        yield* h.collector.waitFor(has("TurnCompleted"))
        yield* h.session.startTurn({ turnId: turnId(2), text: "normal", attachments: [] })
        yield* h.collector.waitFor(has("TurnCompleted", (e) => e._tag === "TurnCompleted" && e.turnId === turnId(2)))
        yield* h.session.compact
        const raw = h.fake().raw
        expect(raw[0]).toMatchObject({ client_composed: true, message: { content: "/clear everything please" } })
        expect(raw[1]!.client_composed).toBeUndefined()
        expect(raw[2]).toMatchObject({ message: { content: "/compact" } })
        expect(raw[2]!.client_composed).toBeUndefined() // OpenBot's own command is dispatched
      }),
    ))

  test("the owner's skill command is sent as the CLI's plugin skill command (owner-only skills start too)", () =>
    run(
      Effect.gen(function* () {
        const h = yield* setup()
        yield* h.session.startTurn({
          turnId: turnId(1),
          text: 'The owner started your "grill-me" skill …',
          attachments: [],
          skillCommand: { name: "grill-me", args: "[DM with the owner]\nmy launch plan" },
        })
        yield* h.collector.waitFor(has("TurnCompleted"))
        yield* h.session.startTurn({
          turnId: turnId(2),
          text: 'The owner started your "grill-me" skill …',
          attachments: [],
          skillCommand: { name: "grill-me", args: "" },
        })
        yield* h.collector.waitFor(has("TurnCompleted", (e) => e._tag === "TurnCompleted" && e.turnId === turnId(2)))
        const raw = h.fake().raw
        expect(raw[0]).toMatchObject({
          message: { content: "/openbot-skills:grill-me [DM with the owner]\nmy launch plan" },
        })
        expect(raw[0]!.client_composed).toBeUndefined()
        expect(raw[1]).toMatchObject({ message: { content: "/openbot-skills:grill-me" } })
      }),
    ))

  test("setMcpServers rejection fails the open (open-failed, no token in the error) and closes the CLI at once", () =>
    run(
      Effect.gen(function* () {
        const env = yield* makeEnv({
          fake: {
            setMcpServers: () => Promise.reject(new Error("bad config: Authorization: Bearer secret-token-xyz")),
          },
        })
        const exit = yield* Effect.exit(env.driver.openSession(env.input))
        expect(Exit.isFailure(exit)).toBe(true)
        const text = JSON.stringify(exit)
        expect(text).toContain("open-failed")
        expect(text).not.toContain("secret-token-xyz")
        // closed before the caller's scope ends
        expect(env.fake().closed).toBe(true)
      }),
    ))

  test("a CLI that cannot start is reported as not-installed", () =>
    run(
      Effect.gen(function* () {
        const env = yield* makeEnv({
          fake: {
            setMcpServers: () =>
              Promise.reject(new Error("Claude Code native binary not found at /x/claude. Please ensure …")),
          },
          config: { executable: "/x/claude" },
        })
        const exit = yield* Effect.exit(env.driver.openSession(env.input))
        expect(JSON.stringify(exit)).toContain('"code":"not-installed"')
        expect(JSON.stringify(exit)).toContain("Claude Code is not installed at /x/claude.")
        expect(env.fake().options.pathToClaudeCodeExecutable).toBe("/x/claude")
      }),
    ))

  test("setMcpServers that never answers times out as open-failed", () =>
    run(
      Effect.gen(function* () {
        const env = yield* makeEnv({
          fake: { setMcpServers: () => new Promise(() => {}) },
          config: { mcpRegistrationTimeoutMs: 30 },
        })
        const exit = yield* Effect.exit(env.driver.openSession(env.input))
        expect(JSON.stringify(exit)).toContain("did not answer the MCP server registration")
        expect(env.fake().closed).toBe(true)
      }),
    ))

  test("native memory (opt-in) points autoMemoryDirectory at the bot's memory directory and creates it", () =>
    run(
      Effect.gen(function* () {
        const h = yield* setup({ config: { memory: "native" } })
        const settings = h.fake().options.settings as Record<string, unknown>
        expect(settings.autoMemoryEnabled).toBe(true)
        const dir = settings.autoMemoryDirectory as string
        expect(dir).toBe(join(h.root, "bots", h.input.bot.id, "memory"))
        expect(existsSync(dir)).toBe(true)
      }),
    ))

  test("a Bot's skills (only those, still in the library) are mounted as its own plugin of library symlinks", () =>
    run(
      Effect.gen(function* () {
        const env0 = yield* makeEnv()
        const lib = join(env0.root, "skills-lib")
        for (const name of ["triage", "release-notes", "other"]) {
          yield* Effect.promise(() =>
            Bun.write(join(lib, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`),
          )
        }
        const input = {
          ...env0.input,
          bot: { ...env0.input.bot, skills: ["triage", "release-notes", "deleted"] as never },
        }
        yield* env0.driver.openSession(input)
        const plugins = env0.fake().options.plugins as ReadonlyArray<{ path: string }>
        expect(plugins).toHaveLength(1)
        const dir = plugins[0]!.path
        expect(dir.startsWith(join(env0.root, "bots", env0.input.bot.id, "skills-plugin"))).toBe(true)
        expect(JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")).name).toBe("openbot-skills")
        expect(readdirSync(join(dir, "skills")).sort()).toEqual(["release-notes", "triage"])
        expect(realpathSync(join(dir, "skills", "triage"))).toBe(realpathSync(join(lib, "skills", "triage")))
        // a Bot without skills mounts nothing
        const env1 = yield* makeEnv()
        yield* env1.driver.openSession(env1.input)
        expect(env1.fake().options.plugins).toBeUndefined()
      }),
    ))
})

// ---------------------------------------------------------------------------- CLI-initiated turns

const LIVE_TEXT = "Render failed i think. U gotta do it again"

/**
 * The live 2026-10-17 sequence (CLI 2.1.300 transcript c4b636cf…, resumed after a brain restart):
 * the CLI first runs the task notification of a background shell of its previous process as a
 * transcript-only turn (its result: no model call, no echo, `origin: task-notification`), then the
 * owner's message; "Hello?", sent meanwhile, is folded in mid-turn; the answer comes last.
 * `lifecycle` places the CLI's `queued` receipt for the owner's message before or after the
 * notification's result (or omits all receipts); `origin: false` drops the result's origin.
 */
const liveSequence =
  (options: { readonly origin: boolean; readonly lifecycle: "before" | "after" | "none" }): Script =>
  async (fake, input) => {
    if (input.priority === "next") return
    const receipt = (uuid: string, state: "queued" | "started" | "completed") => {
      if (options.lifecycle !== "none") fake.emit(cliFrames.lifecycle(uuid, state))
    }
    if (options.lifecycle === "before") receipt(input.uuid, "queued")
    fake.emit(frames.init())
    fake.emit(cliFrames.notificationResult(options.origin ? {} : { origin: undefined }))
    if (options.lifecycle === "after") receipt(input.uuid, "queued")
    receipt(input.uuid, "started")
    fake.emit(frames.init())
    fake.emit(cliFrames.requesting(input.uuid))
    const id = nextMsgId()
    fake.emit({ ...frames.messageStart(id), ...echo(input.uuid) })
    fake.emit(frames.blockStart(id, 0, { type: "tool_use", id: "toolu_ls", name: "Bash", input: {} }))
    fake.emit({
      ...frames.assistant(id, { type: "tool_use", id: "toolu_ls", name: "Bash", input: { command: "ls -la renders" } }),
      ...echo(input.uuid),
    })
    fake.emit(frames.toolResult("toolu_ls", "half-1.mp4 half-2.mp4 (still growing)"))
    while (!fake.received.some((r) => r.priority === "next")) await Bun.sleep(2)
    const steered = fake.received.find((r) => r.priority === "next")!
    receipt(steered.uuid, "queued")
    receipt(steered.uuid, "started") // absorbed mid-turn
    fake.emit(cliFrames.requesting(input.uuid, steered.uuid))
    const id2 = nextMsgId()
    fake.emit(frames.messageStart(id2))
    fake.emit(frames.blockStart(id2, 0, { type: "text", text: "" }))
    fake.emit(frames.textDelta(id2, 0, "The render hasn't failed."))
    fake.emit(frames.assistant(id2, { type: "text", text: "The render hasn't failed." }))
    fake.emit(frames.result(echo(input.uuid, steered.uuid)))
    receipt(input.uuid, "completed")
    receipt(steered.uuid, "completed")
  }

const turnEventsOf = (events: ReadonlyArray<HarnessEvent>) =>
  events.filter(
    (e) =>
      e._tag === "TurnStarted" || e._tag === "TurnCompleted" || e._tag === "TurnFailed" || e._tag === "TurnInterrupted",
  )

const finalTexts = (events: ReadonlyArray<HarnessEvent>) =>
  events.flatMap((e) =>
    e._tag === "ItemUpserted" && e.item._tag === "Message" && !e.item.streaming ? [`${e.turnId}:${e.item.text}`] : [],
  )

const harnessStart = (events: ReadonlyArray<HarnessEvent>, nth = 0) =>
  events.filter(
    (e): e is Extract<HarnessEvent, { _tag: "TurnStarted" }> => e._tag === "TurnStarted" && e.initiator === "harness",
  )[nth]

describe("Claude session: turns the CLI starts on its own (task notifications)", () => {
  test.each([
    ["receipt before the notification's result", { origin: true, lifecycle: "before" as const }],
    ["receipt after the notification's result", { origin: true, lifecycle: "after" as const }],
    ["no receipts", { origin: true, lifecycle: "none" as const }],
    ["no origin on the result, receipt before it", { origin: false, lifecycle: "before" as const }],
  ])(
    "live 2026-10-17: a transcript-only notification turn before the owner's message ends nothing; the answer lands in the owner's turn (%s)",
    (_label, options) =>
      run(
        Effect.gen(function* () {
          const h = yield* setup({
            input: { nativeSessionId: "c4b636cf-a326-487b-aa6d-6bf94f22d44c" },
            script: liveSequence(options),
          })
          yield* h.session.startTurn({ turnId: turnId(1), text: LIVE_TEXT, attachments: [] })
          yield* h.collector.waitFor(
            has(
              "ItemUpserted",
              (e) =>
                e._tag === "ItemUpserted" &&
                e.key === "toolu_ls" &&
                e.item._tag === "ToolCall" &&
                e.item.status === "completed",
            ),
            "tool result",
          )
          // The notification's result came first: it ended nothing.
          expect(turnEventsOf(h.collector.events)).toEqual([{ _tag: "TurnStarted", turnId: turnId(1) }])
          yield* h.session.steer({ turnId: turnId(1), text: "Hello?", attachments: [] })
          yield* h.collector.waitFor(has("TurnCompleted"), "turn")
          yield* Effect.sleep(20)
          expect(turnEventsOf(h.collector.events)).toEqual([
            { _tag: "TurnStarted", turnId: turnId(1) },
            { _tag: "TurnCompleted", turnId: turnId(1), stopReason: "completed" },
          ])
          expect(finalTexts(h.collector.events)).toEqual([`${turnId(1)}:The render hasn't failed.`])
          // Nothing of the CLI's own turn was surfaced, and the answer was complete before the turn ended.
          expect(harnessStart(h.collector.events)).toBeUndefined()
          const completedAt = h.collector.events.findIndex((e) => e._tag === "TurnCompleted")
          const answerAt = h.collector.events.findIndex(
            (e) =>
              e._tag === "ItemUpserted" &&
              e.item._tag === "Message" &&
              !e.item.streaming &&
              e.item.text === "The render hasn't failed.",
          )
          expect(answerAt).toBeLessThan(completedAt)
        }),
      ),
  )

  test("a notification answered while idle surfaces as a harness-initiated turn; a transcript-only one emits nothing", () =>
    run(
      Effect.gen(function* () {
        const h = yield* setup()
        yield* h.session.startTurn({ turnId: turnId(1), text: "start the render", attachments: [] })
        yield* h.collector.waitFor(has("TurnCompleted"), "turn 1")
        const fake = h.fake()
        const before = h.collector.events.length
        fake.emit(frames.init())
        fake.emit(cliFrames.notificationResult()) // the model was not asked: nothing to show
        cliFrames.notificationReply(fake, "The render finished: film.mp4")
        yield* h.collector.waitFor((es) => es.filter((e) => e._tag === "TurnCompleted").length === 2, "harness turn")
        const after = h.collector.events.slice(before)
        const started = harnessStart(after)!
        expect(started).toEqual({
          _tag: "TurnStarted",
          turnId: expect.stringMatching(/^cli-uuid-\d+$/),
          initiator: "harness",
        })
        expect(after[0]).toEqual(started) // its first event: nothing before it
        expect(turnEventsOf(after)).toEqual([
          started,
          { _tag: "TurnCompleted", turnId: started.turnId, stopReason: "completed" },
        ])
        expect(finalTexts(after)).toEqual([`${started.turnId}:The render finished: film.mp4`])
        expect(after.every((e) => !("turnId" in e) || e.turnId === started.turnId)).toBe(true)
        expect(after.some((e) => e._tag === "Usage" && e.turnId === started.turnId)).toBe(true)
        // OpenBot's turns go on as usual afterwards.
        yield* h.session.startTurn({ turnId: turnId(2), text: "again", attachments: [] })
        yield* h.collector.waitFor(
          has("TurnCompleted", (e) => e._tag === "TurnCompleted" && e.turnId === turnId(2)),
          "turn 2",
        )
        expect(finalTexts(h.collector.events).at(-1)).toBe(`${turnId(2)}:echo:again`)
      }),
    ))

  test("a notification the CLI answers while OpenBot's turn waits for it: its output goes to that turn, its result ends nothing", () =>
    run(
      Effect.gen(function* () {
        const h = yield* setup({ script: (fake, input) => (input.text === "manual" ? undefined : script(fake, input)) })
        yield* h.session.startTurn({ turnId: turnId(1), text: "manual", attachments: [] })
        const fake = h.fake()
        yield* waitUntil(() => fake.received.length === 1, "send")
        const uuid = fake.received[0]!.uuid
        fake.emit(cliFrames.lifecycle(uuid, "queued")) // the CLI is busy with its own turn
        cliFrames.notificationReply(fake, "A background command finished.")
        yield* h.collector.waitFor((es) => finalTexts(es).length === 1, "notification answer")
        yield* Effect.sleep(20)
        expect(turnEventsOf(h.collector.events)).toEqual([{ _tag: "TurnStarted", turnId: turnId(1) }])
        // Then the owner's message runs.
        fake.emit(cliFrames.lifecycle(uuid, "started"))
        replyText(fake, "echo:manual", uuid)
        yield* h.collector.waitFor(has("TurnCompleted"), "turn")
        yield* Effect.sleep(20)
        expect(turnEventsOf(h.collector.events)).toEqual([
          { _tag: "TurnStarted", turnId: turnId(1) },
          { _tag: "TurnCompleted", turnId: turnId(1), stopReason: "completed" },
        ])
        expect(finalTexts(h.collector.events)).toEqual([
          `${turnId(1)}:A background command finished.`,
          `${turnId(1)}:echo:manual`,
        ])
        expect(h.collector.events.filter((e) => e._tag === "Usage").map((e) => e._tag === "Usage" && e.turnId)).toEqual(
          [turnId(1), turnId(1)],
        )
      }),
    ))

  test("a harness-initiated turn takes steered input (answered in it, never twice) and can be interrupted", () =>
    run(
      Effect.gen(function* () {
        const h = yield* setup()
        yield* h.session.startTurn({ turnId: turnId(1), text: "hello", attachments: [] })
        yield* h.collector.waitFor(has("TurnCompleted"), "turn 1")
        const fake = h.fake()
        // The CLI answers its notification…
        const id = nextMsgId()
        fake.emit(frames.init())
        fake.emit(cliFrames.requesting())
        fake.emit(frames.messageStart(id))
        fake.emit(frames.blockStart(id, 0, { type: "text", text: "" }))
        fake.emit(frames.textDelta(id, 0, "Render finished."))
        yield* h.collector.waitFor((es) => harnessStart(es) !== undefined, "harness turn")
        const harness = harnessStart(h.collector.events)!.turnId
        // …the owner writes meanwhile (core steers into the running harness turn)…
        yield* h.session.steer({ turnId: harness, text: "which file?", attachments: [] })
        yield* waitUntil(() => fake.received.some((r) => r.priority === "next"), "steer pushed")
        const steered = fake.received.find((r) => r.priority === "next")!
        fake.emit(frames.assistant(id, { type: "text", text: "Render finished." }))
        fake.emit(frames.result({ origin: { kind: "task-notification" } })) // the steer was not folded in
        yield* Effect.sleep(20)
        expect(turnEventsOf(h.collector.events).filter((e) => e.turnId === harness)).toHaveLength(1) // still open
        // …and the CLI answers the steer as its next turn: in the harness turn.
        fake.emit(cliFrames.lifecycle(steered.uuid, "started"))
        replyText(fake, "film.mp4", steered.uuid)
        yield* h.collector.waitFor(
          has("TurnCompleted", (e) => e._tag === "TurnCompleted" && e.turnId === harness),
          "harness turn end",
        )
        expect(finalTexts(h.collector.events).filter((t) => t.startsWith(harness))).toEqual([
          `${harness}:Render finished.`,
          `${harness}:film.mp4`,
        ])
        expect(harnessStart(h.collector.events, 1)).toBeUndefined()

        // Another notification turn, stopped by the owner.
        const id2 = nextMsgId()
        fake.emit(frames.init())
        fake.emit(frames.messageStart(id2))
        fake.emit(frames.blockStart(id2, 0, { type: "text", text: "" }))
        fake.emit(frames.textDelta(id2, 0, "Checking the"))
        yield* h.collector.waitFor((es) => harnessStart(es, 1) !== undefined, "second harness turn")
        const second = harnessStart(h.collector.events, 1)!.turnId
        yield* h.session.interrupt
        expect(fake.interrupts).toBe(1)
        fake.emit(frames.assistant(id2, { type: "text", text: "Checking the" }, { aborted: true }))
        fake.emit(
          frames.result({
            subtype: "error_during_execution",
            is_error: true,
            terminal_reason: "aborted_streaming",
            stop_reason: null,
            origin: { kind: "task-notification" },
          }),
        )
        yield* h.collector.waitFor(
          has("TurnInterrupted", (e) => e._tag === "TurnInterrupted" && e.turnId === second),
          "interrupted",
        )
      }),
    ))

  test("queued input the CLI drops without running it ends the turn (retryable) instead of hanging", () =>
    run(
      Effect.gen(function* () {
        const h = yield* setup({
          script: (fake, input) => {
            if (input.text !== "setup fails") return script(fake, input)
            fake.emit(cliFrames.lifecycle(input.uuid, "queued"))
            fake.emit(frames.init())
            // The turn could not be set up: an error result without echo, then the receipt.
            fake.emit(
              frames.result({
                subtype: "error_during_execution",
                is_error: true,
                num_turns: 0,
                terminal_reason: "turn_setup_failed",
                stop_reason: null,
                errors: ["queryParams builder failed: boom"],
              }),
            )
            fake.emit(cliFrames.lifecycle(input.uuid, "cancelled"))
          },
        })
        yield* h.session.startTurn({ turnId: turnId(1), text: "setup fails", attachments: [] })
        yield* h.collector.waitFor(has("TurnFailed"), "failed")
        yield* Effect.sleep(10)
        // With the CLI's own error text (the skipped result's), retryable.
        expect(turnEventsOf(h.collector.events)).toEqual([
          { _tag: "TurnStarted", turnId: turnId(1) },
          {
            _tag: "TurnFailed",
            turnId: turnId(1),
            error: { code: "turn-failed", message: "queryParams builder failed: boom", retryable: true },
          },
        ])
        yield* h.session.startTurn({ turnId: turnId(2), text: "again", attachments: [] })
        yield* h.collector.waitFor(
          has("TurnCompleted", (e) => e._tag === "TurnCompleted" && e.turnId === turnId(2)),
          "turn 2",
        )
      }),
    ))
})

/** A fake `query` that really spawns a "CLI" through `options.spawnClaudeCodeProcess`, like the SDK. */
const spawningQuery = (cliScript: string) => {
  const state: { child?: ChildProcess; closed: boolean } = { closed: false }
  const query: ClaudeQueryFunction = (params) => {
    const options = params.options as Record<string, unknown>
    const spawnCli = options.spawnClaudeCodeProcess as (o: Record<string, unknown>) => ChildProcess
    const forwarded = new AbortController()
    state.child = spawnCli({
      command: "sh",
      args: ["-c", cliScript],
      env: options.env,
      cwd: options.cwd,
      signal: forwarded.signal,
    })
    let finish: (r: IteratorResult<unknown, void>) => void = () => {}
    const done = new Promise<IteratorResult<unknown, void>>((resolve) => {
      finish = resolve
    })
    return {
      next: () => done,
      return: async () => ({ value: undefined, done: true as const }),
      interrupt: async () => ({}),
      close: () => {
        state.closed = true
        state.child?.stdin?.end() // the SDK's graceful close: stdin EOF
        finish({ value: undefined, done: true })
      },
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
      initializationResult: async () => ({}),
      getContextUsage: async () => ({}),
    }
  }
  return { query, state }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const groupAlive = (pgid: number): boolean => alive(-pgid)

describe.skipIf(!supportsProcessGroups)("Claude session process lifetime (process group + ProcessLedger)", () => {
  const openWith = (cliScript: string, closeTimeoutMs = 2000) =>
    Effect.gen(function* () {
      const ledger: Array<string> = []
      const { query, state } = spawningQuery(cliScript)
      const root = tempDir()
      const driver = yield* makeClaudeDriver(
        { query, executable: "bundled", closeTimeoutMs, env: { PATH: process.env.PATH ?? "/usr/bin" } },
        {
          dataDir: makeDataDir(root),
          ledger: {
            record: (pid, label) => Effect.sync(() => void ledger.push(`+${pid}:${label}`)),
            remove: (pid) => Effect.sync(() => void ledger.push(`-${pid}`)),
          },
        },
      )
      const input = makeSessionInput(join(root, "ws"), () => Effect.never, { mcp: [] })
      const scope = yield* Scope.make()
      yield* driver.openSession(input).pipe(Scope.provide(scope))
      const pid = state.child!.pid!
      return { ledger, pid, scope, input, state }
    })

  test("records the CLI pid; close waits for its graceful exit, kills the group and removes the record", () =>
    run(
      Effect.gen(function* () {
        const { ledger, pid, scope, input } = yield* openWith("sleep 30 & read line; exit 0")
        yield* waitUntil(() => ledger.length === 1, "ledger record")
        expect(ledger).toEqual([`+${pid}:${input.sessionKey}`])
        expect(alive(pid)).toBe(true)
        yield* Scope.close(scope, Exit.void)
        // the release waited: the record is gone and the whole group (the backgrounded sleep too) is dead
        expect(ledger).toEqual([`+${pid}:${input.sessionKey}`, `-${pid}`])
        expect(alive(pid)).toBe(false)
        yield* waitUntil(() => !groupAlive(pid), "process group gone") // SIGKILLed members are reaped asynchronously
      }),
    ))

  test("ClaudeHarnessLive records the CLI in core's ProcessLedger (kind claude, pgid = pid) and removes it on close", () =>
    run(
      Effect.gen(function* () {
        const { query, state } = spawningQuery("read line; exit 0")
        const layer = ClaudeHarnessLive({
          query,
          executable: "bundled",
          env: { PATH: process.env.PATH ?? "/usr/bin" },
        }).pipe(Layer.provideMerge(TestPorts({ dataRoot: tempDir() })))
        yield* Effect.gen(function* () {
          const driver = yield* (yield* HarnessRegistry).get("claude")
          const ledger = yield* ProcessLedger
          const input = makeSessionInput(join(tempDir(), "ws"), () => Effect.never, { mcp: [] })
          const scope = yield* Scope.make()
          yield* driver.openSession(input).pipe(Scope.provide(scope))
          const pid = state.child!.pid!
          let records = yield* ledger.list
          for (let i = 0; i < 200 && records.length === 0; i++) {
            yield* Effect.sleep(5)
            records = yield* ledger.list
          }
          expect(records).toEqual([
            expect.objectContaining({ pid, pgid: pid, kind: "claude", label: input.sessionKey }),
          ])
          yield* Scope.close(scope, Exit.void)
          expect(yield* ledger.list).toEqual([])
        }).pipe(Effect.provide(layer))
      }),
    ))

  test("a CLI that ignores stdin EOF is SIGKILLed with its group after the close timeout", () =>
    run(
      Effect.gen(function* () {
        const { ledger, pid, scope } = yield* openWith("trap '' TERM; sleep 30", 100)
        yield* waitUntil(() => ledger.length === 1, "ledger record")
        const started = Date.now()
        yield* Scope.close(scope, Exit.void)
        expect(Date.now() - started).toBeLessThan(1500)
        expect(ledger.at(-1)).toBe(`-${pid}`)
        yield* waitUntil(() => !groupAlive(pid), "process group gone")
      }),
    ))
})

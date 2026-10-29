import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  type HarnessRequest,
  type HarnessRequestResolution,
  MAIN_PROFILE_ID,
  type NodeId,
  OwnerProfileId,
  type SkillName,
} from "@openbot/contracts"
import { HarnessError, makeDataDir } from "@openbot/core"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { type CodexHarnessConfig, makeCodexDriver } from "../src/Driver.ts"
import { mcpHandsBaseInstructions } from "../src/config.ts"
import {
  collect,
  compactHandler,
  emitTextTurn,
  FakeAppServer,
  fakeLauncher,
  type Handler,
  has,
  interruptHandler,
  makePlacement,
  makeSessionInput,
  ofTag,
  rpcError,
  run,
  scriptedTurnStart,
  tempDir,
  type TurnContext,
  turnId,
  waitUntil,
} from "./support.ts"

const REMOTE = "nod_remote1" as NodeId

/** The default turn script, keyed by the first word of the input. */
const script = async (text: string, { server, threadId, turn }: TurnContext) => {
  const word = text.split(/\s+/)[0]
  if (word === "hello") return emitTextTurn(server, threadId, turn, "Hi there.")
  if (word === "slow") {
    server.notify("turn/started", { threadId, turn: { id: turn, status: "inProgress" } })
    server.notify("item/started", { threadId, turnId: turn, item: { type: "agentMessage", id: "m-slow", text: "" } })
    server.notify("item/agentMessage/delta", { threadId, turnId: turn, itemId: "m-slow", delta: "partial" })
    return // ends on turn/interrupt
  }
  if (word === "run" || word === "withdraw") {
    server.notify("turn/started", { threadId, turn: { id: turn, status: "inProgress" } })
    const item = {
      type: "commandExecution",
      id: "exec-1",
      command: "/usr/bin/bash -lc 'touch x'",
      cwd: "/w",
      status: "inProgress",
    }
    server.notify("item/started", { threadId, turnId: turn, item })
    const response = server.request("item/commandExecution/requestApproval", {
      threadId,
      turnId: turn,
      itemId: "exec-1",
      environmentId: text.includes("remote") ? REMOTE : "local",
      command: "/usr/bin/bash -lc 'touch x'",
      cwd: "/w",
      reason: "Make x",
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
    })
    const requestId = server.lastServerRequestId
    if (word === "withdraw") {
      // Codex withdraws the request (e.g. the turn ended) before anyone answered.
      setTimeout(() => {
        server.notify("serverRequest/resolved", { threadId, requestId })
        server.notify("turn/completed", { threadId, turn: { id: turn, status: "completed", error: null } })
      }, 20)
      return
    }
    const reply = await response
    const decision = (reply.result as { decision?: string } | undefined)?.decision
    server.notify("serverRequest/resolved", { threadId, requestId })
    server.notify("item/completed", {
      threadId,
      turnId: turn,
      item: {
        ...item,
        status: decision === "accept" || decision === "acceptForSession" ? "completed" : "declined",
        exitCode: 0,
        aggregatedOutput: "",
      },
    })
    return emitTextTurn(server, threadId, turn, `decision=${decision}`, "msg-after")
  }
  if (word === "ask") {
    server.notify("turn/started", { threadId, turn: { id: turn, status: "inProgress" } })
    const reply = await server.request("item/tool/requestUserInput", {
      threadId,
      turnId: turn,
      itemId: "call_1",
      questions: [
        {
          id: "color",
          header: "Color",
          question: "Which color?",
          isOther: false,
          isSecret: false,
          options: [{ label: "Blue", description: "Calm" }],
        },
      ],
    })
    return emitTextTurn(server, threadId, turn, JSON.stringify(reply.result), "msg-answer")
  }
  if (word === "time") {
    server.notify("turn/started", { threadId, turn: { id: turn, status: "inProgress" } })
    const reply = await server.request("currentTime/read", { threadId })
    return emitTextTurn(server, threadId, turn, JSON.stringify(reply.result), "msg-time")
  }
}

const handlers: Record<string, Handler> = {
  "turn/start": scriptedTurnStart(script),
  "turn/interrupt": interruptHandler,
  "turn/steer": (params) => ({ turnId: params.expectedTurnId }),
  "thread/compact/start": compactHandler,
}

const setup = (extra: Record<string, Handler> = {}, config: Partial<CodexHarnessConfig> = {}) =>
  Effect.gen(function* () {
    const root = tempDir()
    const fake = fakeLauncher(() => FakeAppServer.make({ ...handlers, ...extra }))
    const driver = yield* makeCodexDriver(
      {
        binaryPath: process.execPath,
        linkUserAuth: false,
        launcher: fake.launcher,
        requestTimeout: "2 seconds",
        ...config,
      },
      { dataDir: makeDataDir(root) },
    )
    const server = () => {
      const last = fake.launches.at(-1)
      if (!last) throw new Error("no app-server launched")
      return last.server
    }
    return { driver, root, launches: fake.launches, server, workspace: join(root, "bots", "bot", "workspace") }
  })

const allow =
  (decision: "allow-once" | "deny" = "allow-once") =>
  (): Effect.Effect<HarnessRequestResolution> =>
    Effect.succeed({ decision })

const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) return undefined
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  return reason && "error" in reason ? reason.error : undefined
}

describe("Codex session: thread setup", () => {
  test("native-local: one app-server for OpenBot's CODEX_HOME; thread/start with explicit local environment", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ctx = yield* setup()
        const session = yield* ctx.driver.openSession(makeSessionInput(ctx.workspace, allow()))
        const events = yield* collect(session.events)
        yield* events.waitFor(has("SessionBound"))
        return { ctx, events: events.events, threadId: yield* session.nativeSessionId }
      }),
    )
    const { ctx, events } = result
    expect(ctx.launches.length).toBe(1)
    const spec = ctx.launches[0]!.spec
    expect(spec.args).toEqual(["app-server"])
    expect(spec.codexHome).toBe(join(ctx.root, "codex-home"))
    // No token on argv, a hermetic profile on disk.
    expect(JSON.stringify(spec.args)).not.toContain("secret-token")
    expect(readFileSync(join(ctx.root, "codex-home", "config.toml"), "utf8")).toContain("plugins = false")
    expect(existsSync(ctx.workspace)).toBe(true)

    const server = ctx.launches[0]!.server
    const init = server.received.find((m) => m.method === "initialize")
    expect(init?.params).toMatchObject({ clientInfo: { name: "openbot" }, capabilities: { experimentalApi: true } })
    const [start] = server.requests("thread/start")
    expect(start).toEqual({
      model: "gpt-test",
      cwd: ctx.workspace,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      config: {
        features: {
          apps: false,
          plugins: false,
          memories: false,
          code_mode: { direct_only_tool_namespaces: ["mcp__openbot"] },
        },
        mcp_servers: {
          openbot: {
            url: "http://127.0.0.1:4555/mcp/bot_test",
            http_headers: { authorization: "Bearer secret-token-xyz" },
            default_tools_approval_mode: "approve",
            required: true,
            startup_timeout_sec: 30,
            tool_timeout_sec: 900,
          },
        },
        model_reasoning_effort: "low",
      },
      developerInstructions: "You are Scout, an OpenBot.",
      environments: [{ environmentId: "local", cwd: ctx.workspace }],
      ephemeral: false,
      serviceName: "openbot",
    })
    expect(events[0]).toEqual({ _tag: "SessionBound", nativeSessionId: "thr-1" })
    expect(result.threadId).toBe("thr-1")
  })

  test("codex-environment: environment/add first, then the node environment on the thread and every turn", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ctx = yield* setup()
        const placement = makePlacement(ctx.workspace, {
          mode: "codex-environment",
          hostNodeId: REMOTE,
          workspacePath: "/home/u/openbot/workspaces/bot",
          harnessCwd: ctx.workspace,
          codexEnvironment: {
            environmentId: REMOTE,
            execServerUrl: `ws://127.0.0.1:9999/relay/${REMOTE}/codex.exec-server`,
            authBearerToken: "relay-token",
            cwd: "/home/u/openbot/workspaces/bot",
          },
        })
        const requests: Array<HarnessRequest> = []
        const session = yield* ctx.driver.openSession(
          makeSessionInput(
            ctx.workspace,
            (request) => {
              requests.push(request)
              return Effect.succeed({ decision: "allow-once" as const })
            },
            { placement },
          ),
        )
        const events = yield* collect(session.events)
        yield* session.startTurn({ turnId: turnId(1), text: "run remote", attachments: [] })
        yield* events.waitFor(has("TurnCompleted"))
        return { server: ctx.server(), requests, events: events.events }
      }),
    )
    const methods = result.server.received
      .filter((m) => m.id !== undefined && typeof m.method === "string")
      .map((m) => m.method)
    expect(methods.indexOf("environment/add")).toBeLessThan(methods.indexOf("thread/start"))
    expect(result.server.requests("environment/add")[0]).toEqual({
      environmentId: REMOTE,
      execServerUrl: `ws://127.0.0.1:9999/relay/${REMOTE}/codex.exec-server`,
      authBearerToken: "relay-token",
      connectTimeoutMs: 10_000,
    })
    const env = [{ environmentId: REMOTE, cwd: "/home/u/openbot/workspaces/bot" }]
    expect(result.server.requests("thread/start")[0]?.environments).toEqual(env)
    expect(result.server.requests("turn/start")[0]?.environments).toEqual(env)
    // The command approval names the node it runs on.
    expect(result.requests[0]).toMatchObject({ kind: "command-approval", command: "touch x", nodeId: REMOTE })
  })

  test("brain-mcp-hands: no environments, Codex's base prompt replaced by the node tools", async () => {
    const server = await run(
      Effect.gen(function* () {
        const ctx = yield* setup()
        const placement = makePlacement(ctx.workspace, {
          mode: "brain-mcp-hands",
          hostNodeId: REMOTE,
          workspacePath: "/home/u/openbot/workspaces/bot",
          disableBuiltinTools: true,
          toolsets: ["bot", "node"],
        })
        const session = yield* ctx.driver.openSession(makeSessionInput(ctx.workspace, allow(), { placement }))
        yield* session.startTurn({ turnId: turnId(1), text: "hello", attachments: [] })
        return { server: ctx.server(), placement }
      }),
    )
    const [start] = server.server.requests("thread/start")
    expect(start?.environments).toEqual([])
    expect(start?.sandbox).toBe("read-only")
    expect(start?.baseInstructions).toBe(mcpHandsBaseInstructions(server.placement))
    expect(String(start?.baseInstructions)).toContain("/home/u/openbot/workspaces/bot")
    expect(server.server.requests("turn/start")[0]?.environments).toEqual([])
  })

  test("G3 guard: a thread with environments OpenBot did not select is refused", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const ctx = yield* setup({
          "thread/start": () => ({
            thread: {
              id: "thr-leak",
              environments: [
                { environmentId: "local", cwd: "/w" },
                { environmentId: "nod_other", cwd: "/w" },
              ],
            },
          }),
        })
        const opened = yield* Effect.exit(
          Effect.scoped(ctx.driver.openSession(makeSessionInput(ctx.workspace, allow()))),
        )
        return { exit: opened, unsubscribed: ctx.server().requests("thread/unsubscribe") }
      }),
    )
    expect(failureOf(exit.exit)).toMatchObject({ code: "open-failed", message: expect.stringContaining("nod_other") })
    expect(exit.unsubscribed).toEqual([{ threadId: "thr-leak" }])
  })

  test("resume: thread/resume re-sends instructions and config; environments come back on the next turn/start", async () => {
    const server = await run(
      Effect.gen(function* () {
        const ctx = yield* setup()
        const session = yield* ctx.driver.openSession(
          makeSessionInput(ctx.workspace, allow(), { nativeSessionId: "thr-old" }),
        )
        const events = yield* collect(session.events)
        yield* session.startTurn({ turnId: turnId(1), text: "hello", attachments: [] })
        yield* events.waitFor(has("TurnCompleted"))
        expect(events.events[0]).toEqual({ _tag: "SessionBound", nativeSessionId: "thr-old" })
        return ctx.server()
      }),
    )
    expect(server.requests("thread/start")).toEqual([])
    const [resume] = server.requests("thread/resume")
    expect(resume).toMatchObject({
      threadId: "thr-old",
      developerInstructions: "You are Scout, an OpenBot.",
      approvalPolicy: "on-request",
      excludeTurns: true,
      config: { mcp_servers: { openbot: { http_headers: { authorization: "Bearer secret-token-xyz" } } } },
    })
    expect(resume).not.toHaveProperty("environments")
    expect(server.requests("turn/start")[0]?.environments).toEqual([
      { environmentId: "local", cwd: expect.any(String) },
    ])
  })

  test("a failed resume is an open-failed error (the runner then starts a fresh thread)", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const ctx = yield* setup({ "thread/resume": () => rpcError(-32600, "thread not found: thr-gone") })
        return yield* Effect.exit(
          Effect.scoped(
            ctx.driver.openSession(makeSessionInput(ctx.workspace, allow(), { nativeSessionId: "thr-gone" })),
          ),
        )
      }),
    )
    expect(failureOf(exit)).toMatchObject({
      _tag: "HarnessError",
      code: "open-failed",
      message: expect.stringContaining("thread not found"),
    })
  })

  test("skills: the OpenBot library is mounted once; other skills, library skills the Bot lacks and owner-only ones are disabled per thread", async () => {
    const result = await run(
      Effect.gen(function* () {
        let library = ""
        const ctx = yield* setup({
          "skills/list": () => ({
            data: [
              {
                cwd: "/w",
                skills: [
                  { name: "omarchy", path: "/home/u/.agents/skills/omarchy/SKILL.md" },
                  { name: "openbot:notes", path: `${library}/notes/SKILL.md` },
                  { name: "repo-skill", path: "/w/.agents/skills/repo/SKILL.md" },
                ],
              },
            ],
          }),
        })
        library = join(ctx.root, "skills-lib", "skills")
        mkdirSync(library, { recursive: true })
        // The library is looked up when a session opens (`<data>/skills-lib/skills`).
        const withNotes = makeSessionInput(ctx.workspace, allow())
        const notes = { ...withNotes.bot, skills: ["notes" as SkillName] }
        yield* ctx.driver.openSession({ ...withNotes, bot: notes })
        yield* ctx.driver.openSession(makeSessionInput(ctx.workspace, allow()))
        yield* ctx.driver.openSession({ ...withNotes, bot: notes, ownerOnlySkills: ["notes" as SkillName] })
        return { server: ctx.server(), library }
      }),
    )
    expect(result.server.requests("skills/extraRoots/set")).toEqual([{ extraRoots: [result.library] }])
    const starts = result.server.requests("thread/start")
    expect(starts.length).toBe(3)
    const host = [
      { path: "/home/u/.agents/skills/omarchy/SKILL.md", enabled: false },
      { path: "/w/.agents/skills/repo/SKILL.md", enabled: false },
    ]
    expect((starts[0]!.config as Record<string, unknown>)["skills.config"]).toEqual(host)
    const notesOff = [host[0], { path: `${result.library}/notes/SKILL.md`, enabled: false }, host[1]]
    expect((starts[1]!.config as Record<string, unknown>)["skills.config"]).toEqual(notesOff)
    expect((starts[2]!.config as Record<string, unknown>)["skills.config"]).toEqual(notesOff)
  })

  test("skills: each profile has its own app-server with only its library, also a profile made after the first started", async () => {
    const result = await run(
      Effect.gen(function* () {
        // like Codex: a server lists the skills of the roots it was given
        const ctx = yield* setup({
          "skills/list": (_params, server) => ({
            data: [
              {
                cwd: "/w",
                skills: server
                  .requests("skills/extraRoots/set")
                  .flatMap((params) => (params as { extraRoots: ReadonlyArray<string> }).extraRoots)
                  .map((root) => ({ name: "deploy", path: `${root}/deploy/SKILL.md` })),
              },
            ],
          }),
        })
        const roots = {
          main: join(ctx.root, "skills-lib", "skills"),
          demo: join(ctx.root, "profiles", "prf_demo", "skills-lib", "skills"),
        }
        mkdirSync(roots.main, { recursive: true })
        const input = makeSessionInput(ctx.workspace, allow())
        const skills = ["deploy" as SkillName]
        yield* ctx.driver.openSession({ ...input, bot: { ...input.bot, skills } })
        mkdirSync(roots.demo, { recursive: true })
        const demo = { ...input.bot, skills, ownerProfileId: OwnerProfileId.make("prf_demo") }
        yield* ctx.driver.openSession({ ...input, bot: demo })
        yield* ctx.driver.openSession({ ...input, bot: { ...input.bot, skills } })
        return { servers: ctx.launches.map((launch) => launch.server), roots }
      }),
    )
    const [main, demo] = result.servers
    expect(result.servers.length).toBe(2)
    expect(main!.requests("skills/extraRoots/set")).toEqual([{ extraRoots: [result.roots.main] }])
    expect(demo!.requests("skills/extraRoots/set")).toEqual([{ extraRoots: [result.roots.demo] }])
    expect(main!.requests("thread/start").length).toBe(2)
    expect(demo!.requests("thread/start").length).toBe(1)
    // neither server lists the other profile's "deploy": no skill to disable, nothing to mix up
    for (const start of [...main!.requests("thread/start"), ...demo!.requests("thread/start")]) {
      expect((start.config as Record<string, unknown>)["skills.config"]).toBeUndefined()
    }
  })
})

describe("Codex: forgetting an owner profile", () => {
  test("stops the deleted profile's app-server, never the main one's; a later session starts a fresh one", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ctx = yield* setup()
        const input = makeSessionInput(ctx.workspace, allow())
        const demo = OwnerProfileId.make("prf_demo")
        yield* ctx.driver.openSession(input)
        yield* ctx.driver.openSession({ ...input, bot: { ...input.bot, ownerProfileId: demo } })
        yield* ctx.driver.forgetOwnerProfile!(demo)
        yield* ctx.driver.forgetOwnerProfile!(MAIN_PROFILE_ID)
        const stopped = ctx.launches.map((launch) => launch.server.stopped)
        yield* ctx.driver.openSession(input)
        yield* ctx.driver.openSession({ ...input, bot: { ...input.bot, ownerProfileId: demo } })
        return { stopped, launches: ctx.launches.length }
      }),
    )
    expect(result.stopped).toEqual([false, true])
    expect(result.launches).toBe(3)
  })
})

describe("Codex session: turns", () => {
  test("a text turn: accepted on the turn/start response, streamed, usage and context, completed", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ctx = yield* setup()
        const session = yield* ctx.driver.openSession(makeSessionInput(ctx.workspace, allow()))
        const events = yield* collect(session.events)
        yield* session.startTurn({
          turnId: turnId(1),
          text: "hello there",
          attachments: [
            { path: "/data/attachments/a1", mime: "image/png", name: "shot.png" },
            { path: "/data/attachments/a2", mime: "application/pdf", name: "spec.pdf" },
          ],
        })
        yield* events.waitFor(has("TurnCompleted"))
        return { events: events.events, server: ctx.server(), context: yield* session.contextUsage }
      }),
    )
    const [start] = result.server.requests("turn/start")
    expect(start).toEqual({
      threadId: "thr-1",
      input: [
        {
          type: "text",
          text: "hello there\n\nAttached files (readable on the brain):\n- spec.pdf (application/pdf): /data/attachments/a2",
          text_elements: [],
        },
        { type: "localImage", path: "/data/attachments/a1" },
      ],
      environments: [{ environmentId: "local", cwd: expect.any(String) }],
      model: "gpt-test",
      effort: "low",
      summary: "auto",
    })
    const tags = result.events.map((e) => e._tag)
    expect(tags[0]).toBe("SessionBound")
    expect(tags[1]).toBe("TurnStarted")
    expect(tags.at(-1)).toBe("TurnCompleted")
    const final = ofTag(result.events, "ItemUpserted").at(-1)
    expect(final?.item).toEqual({ _tag: "Message", role: "bot", text: "Hi there.", streaming: false, phase: "final" })
    expect(ofTag(result.events, "Usage")).toEqual([
      { _tag: "Usage", usage: { inputTokens: 10, outputTokens: 5 }, turnId: turnId(1) },
    ])
    expect(result.context).toEqual({ usedTokens: 15, windowTokens: 1000 })
  })

  test("turn/start errors: turn-rejected; a thread the server lost is closed", async () => {
    const result = await run(
      Effect.gen(function* () {
        let calls = 0
        const ctx = yield* setup({
          "turn/start": () =>
            ++calls === 1 ? rpcError(-32602, "invalid input") : rpcError(-32600, "thread not loaded: thr-1"),
        })
        const session = yield* ctx.driver.openSession(makeSessionInput(ctx.workspace, allow()))
        const first = yield* Effect.exit(session.startTurn({ turnId: turnId(1), text: "x", attachments: [] }))
        const second = yield* Effect.exit(session.startTurn({ turnId: turnId(2), text: "x", attachments: [] }))
        return { first, second }
      }),
    )
    expect(failureOf(result.first)).toMatchObject({
      code: "turn-rejected",
      message: expect.stringContaining("invalid input"),
    })
    expect(failureOf(result.second)).toMatchObject({ code: "closed" })
  })

  test("steer goes into the running native turn; without one it is rejected", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ctx = yield* setup()
        const session = yield* ctx.driver.openSession(makeSessionInput(ctx.workspace, allow()))
        const events = yield* collect(session.events)
        const idle = yield* Effect.exit(session.steer({ turnId: turnId(1), text: "too early", attachments: [] }))
        yield* session.startTurn({ turnId: turnId(1), text: "slow", attachments: [] })
        yield* session.steer({ turnId: turnId(1), text: "also this", attachments: [] })
        yield* session.interrupt
        yield* events.waitFor(has("TurnInterrupted"))
        return { idle, server: ctx.server() }
      }),
    )
    expect(failureOf(result.idle)).toMatchObject({ code: "turn-rejected" })
    expect(result.server.requests("turn/steer")).toEqual([
      {
        threadId: "thr-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "also this", text_elements: [] }],
      },
    ])
  })

  test("interrupt: turn/interrupt with the native id; the partial text ends aborted", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ctx = yield* setup()
        const session = yield* ctx.driver.openSession(makeSessionInput(ctx.workspace, allow()))
        const events = yield* collect(session.events)
        yield* session.startTurn({ turnId: turnId(1), text: "slow", attachments: [] })
        yield* events.waitFor(has("ItemUpserted"))
        yield* session.interrupt
        yield* events.waitFor(has("TurnInterrupted"))
        // The next turn works normally.
        yield* session.startTurn({ turnId: turnId(2), text: "hello", attachments: [] })
        yield* events.waitFor(has("TurnCompleted"))
        return { events: events.events, server: ctx.server() }
      }),
    )
    expect(result.server.requests("turn/interrupt")).toEqual([{ threadId: "thr-1", turnId: "turn-1" }])
    const message = ofTag(result.events, "ItemUpserted")
      .filter((e) => e.turnId === turnId(1))
      .at(-1)
    expect(message?.item).toEqual({ _tag: "Message", role: "bot", text: "partial", streaming: false, aborted: true })
    expect(ofTag(result.events, "TurnCompleted").map((e) => e.turnId)).toEqual([turnId(2)])
  })

  test("an interrupt asked before turn/start answered is sent once the native id is known", async () => {
    const result = await run(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const slowStart = scriptedTurnStart(script)
        const ctx = yield* setup({
          "turn/start": async (params, server) => {
            await Effect.runPromise(Deferred.await(gate))
            return slowStart(params, server)
          },
        })
        const session = yield* ctx.driver.openSession(makeSessionInput(ctx.workspace, allow()))
        const events = yield* collect(session.events)
        const starting = yield* Effect.forkChild(
          session.startTurn({ turnId: turnId(1), text: "slow", attachments: [] }),
          {
            startImmediately: true,
          },
        )
        yield* waitUntil(() => ctx.server().requests("turn/start").length === 1)
        yield* session.interrupt
        expect(ctx.server().requests("turn/interrupt")).toEqual([])
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(starting)
        yield* events.waitFor(has("TurnInterrupted"))
        return ctx.server()
      }),
    )
    expect(result.requests("turn/interrupt")).toEqual([{ threadId: "thr-1", turnId: "turn-1" }])
  })

  test("compact waits for the compaction turn and refreshes the context meter", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ctx = yield* setup()
        const session = yield* ctx.driver.openSession(makeSessionInput(ctx.workspace, allow()))
        const events = yield* collect(session.events)
        yield* session.startTurn({ turnId: turnId(1), text: "hello", attachments: [] })
        yield* events.waitFor(has("TurnCompleted"))
        yield* session.compact
        return { context: yield* session.contextUsage, events: events.events, server: ctx.server() }
      }),
    )
    expect(result.server.requests("thread/compact/start")).toEqual([{ threadId: "thr-1" }])
    expect(result.context).toEqual({ usedTokens: 120, windowTokens: 1000 })
    // The internal compaction turn shows no items and no extra turn events.
    expect(ofTag(result.events, "TurnStarted").length).toBe(1)
    expect(ofTag(result.events, "TurnCompleted").length).toBe(1)
  })
})

describe("Codex session: server requests", () => {
  test("approval round trip: onRequest decides, Codex gets the native decision", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ctx = yield* setup()
        const asked: Array<HarnessRequest> = []
        let next: HarnessRequestResolution = { decision: "allow-once" }
        const session = yield* ctx.driver.openSession(
          makeSessionInput(ctx.workspace, (request) =>
            Effect.sync(() => {
              asked.push(request)
              return next
            }),
          ),
        )
        const events = yield* collect(session.events)
        yield* session.startTurn({ turnId: turnId(1), text: "run", attachments: [] })
        yield* events.waitFor((e) => ofTag(e, "TurnCompleted").length === 1)
        next = { decision: "deny" }
        yield* session.startTurn({ turnId: turnId(2), text: "run", attachments: [] })
        yield* events.waitFor((e) => ofTag(e, "TurnCompleted").length === 2)
        return { asked, events: events.events, server: ctx.server() }
      }),
    )
    expect(result.asked.length).toBe(2)
    expect(result.asked[0]).toMatchObject({
      kind: "command-approval",
      toolName: "exec_command",
      command: "touch x",
      detail: "Make x",
      toolKey: "turn-1:exec-1",
      nodeId: "node_local",
      suggestions: [{ decision: "allow-session" }, { decision: "cancel" }],
    })
    const replies = result.server.received.filter((m) => m.method === undefined && m.result !== undefined)
    expect(replies.map((m) => m.result)).toEqual([{ decision: "accept" }, { decision: "decline" }])
    const tools = ofTag(result.events, "ItemUpserted").filter((e) => e.item._tag === "ToolCall")
    expect(tools.filter((e) => e.turnId === turnId(1)).at(-1)?.item).toMatchObject({ status: "completed" })
    expect(tools.filter((e) => e.turnId === turnId(2)).at(-1)?.item).toMatchObject({ status: "declined" })
  })

  test("a withdrawn request (serverRequest/resolved) cancels the waiting onRequest and is never answered", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ctx = yield* setup()
        let interrupted = false
        const session = yield* ctx.driver.openSession(
          makeSessionInput(ctx.workspace, () =>
            Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true)))),
          ),
        )
        const events = yield* collect(session.events)
        yield* session.startTurn({ turnId: turnId(1), text: "withdraw", attachments: [] })
        yield* events.waitFor(has("TurnCompleted"))
        yield* waitUntil(() => interrupted, "onRequest interrupted")
        return { server: ctx.server() }
      }),
    )
    const replies = result.server.received.filter((m) => m.method === undefined)
    expect(replies).toEqual([])
  })

  test("question round trip (item/tool/requestUserInput)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ctx = yield* setup()
        const asked: Array<HarnessRequest> = []
        const session = yield* ctx.driver.openSession(
          makeSessionInput(ctx.workspace, (request) =>
            Effect.sync(() => {
              asked.push(request)
              return { answers: { color: "Blue" } }
            }),
          ),
        )
        const events = yield* collect(session.events)
        yield* session.startTurn({ turnId: turnId(1), text: "ask", attachments: [] })
        yield* events.waitFor(has("TurnCompleted"))
        return { asked, events: events.events }
      }),
    )
    expect(result.asked[0]).toMatchObject({ kind: "question", questions: [{ id: "color", prompt: "Which color?" }] })
    const final = ofTag(result.events, "ItemUpserted").at(-1)?.item
    expect(final).toMatchObject({ text: JSON.stringify({ answers: { color: { answers: ["Blue"] } } }) })
  })

  test("currentTime/read is answered without asking anyone", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ctx = yield* setup()
        const asked: Array<HarnessRequest> = []
        const session = yield* ctx.driver.openSession(
          makeSessionInput(ctx.workspace, (request) =>
            Effect.sync(() => {
              asked.push(request)
              return { decision: "deny" as const }
            }),
          ),
        )
        const events = yield* collect(session.events)
        yield* session.startTurn({ turnId: turnId(1), text: "time", attachments: [] })
        yield* events.waitFor(has("TurnCompleted"))
        return { asked, events: events.events }
      }),
    )
    expect(result.asked).toEqual([])
    const final = ofTag(result.events, "ItemUpserted").at(-1)?.item
    expect(final?._tag === "Message" && JSON.parse(final.text).currentTimeAt).toBeGreaterThan(1_600_000_000)
  })
})

describe("Codex session: lifecycle", () => {
  test("app-server death: the running turn fails as closed, SessionClosed, then a new app-server serves the next session", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ctx = yield* setup()
        const scope = yield* Scope.make()
        const session = yield* ctx.driver
          .openSession(makeSessionInput(ctx.workspace, allow()))
          .pipe(Scope.provide(scope))
        const events = yield* collect(session.events)
        yield* session.startTurn({ turnId: turnId(1), text: "slow", attachments: [] })
        yield* events.waitFor(has("ItemUpserted"))
        ctx.server().close()
        yield* events.waitFor(has("SessionClosed"))
        const after = yield* Effect.exit(session.startTurn({ turnId: turnId(2), text: "hello", attachments: [] }))
        yield* Scope.close(scope, Exit.void)
        // The runner reopens: a fresh process, resuming the same thread.
        const reopened = yield* ctx.driver.openSession(
          makeSessionInput(ctx.workspace, allow(), { nativeSessionId: "thr-1" }),
        )
        const events2 = yield* collect(reopened.events)
        yield* reopened.startTurn({ turnId: turnId(3), text: "hello", attachments: [] })
        yield* events2.waitFor(has("TurnCompleted"))
        return { events: events.events, after, launches: ctx.launches.length }
      }),
    )
    const failed = ofTag(result.events, "TurnFailed")[0]
    expect(failed).toMatchObject({ turnId: turnId(1), error: { code: "closed", retryable: true } })
    expect(ofTag(result.events, "SessionClosed")[0]?.reason).toContain("fake app-server exited")
    expect(result.events.at(-1)?._tag).toBe("SessionClosed")
    expect(failureOf(result.after)).toBeInstanceOf(HarnessError)
    expect(failureOf(result.after)).toMatchObject({ code: "closed" })
    expect(result.launches).toBe(2)
  })

  test("closing the session declines pending approvals, interrupts the turn and unsubscribes", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ctx = yield* setup()
        const scope = yield* Scope.make()
        let asked = false
        const session = yield* ctx.driver
          .openSession(
            makeSessionInput(ctx.workspace, () =>
              Effect.sync(() => void (asked = true)).pipe(Effect.andThen(Effect.never)),
            ),
          )
          .pipe(Scope.provide(scope))
        const events = yield* collect(session.events)
        yield* session.startTurn({ turnId: turnId(1), text: "run", attachments: [] })
        yield* waitUntil(() => asked, "approval asked")
        yield* Scope.close(scope, Exit.void)
        yield* events.waitFor(has("SessionClosed"))
        yield* waitUntil(() => ctx.server().requests("thread/unsubscribe").length === 1, "unsubscribe")
        return { events: events.events, server: ctx.server() }
      }),
    )
    const replies = result.server.received.filter((m) => m.method === undefined)
    expect(replies.map((m) => m.result)).toEqual([{ decision: "decline" }])
    expect(result.server.requests("turn/interrupt")).toEqual([{ threadId: "thr-1", turnId: "turn-1" }])
    expect(ofTag(result.events, "TurnInterrupted").map((e) => e.turnId)).toEqual([turnId(1)])
    expect(result.events.at(-1)).toEqual({ _tag: "SessionClosed", reason: "closed" })
  })

  test("Codex closing the thread declines its pending approvals", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ctx = yield* setup()
        let asked = false
        const session = yield* ctx.driver.openSession(
          makeSessionInput(ctx.workspace, () =>
            Effect.sync(() => void (asked = true)).pipe(Effect.andThen(Effect.never)),
          ),
        )
        const events = yield* collect(session.events)
        yield* session.startTurn({ turnId: turnId(1), text: "run", attachments: [] })
        yield* waitUntil(() => asked, "approval asked")
        ctx.server().notify("thread/closed", { threadId: "thr-1" })
        yield* events.waitFor(has("SessionClosed"))
        yield* waitUntil(() => ctx.server().received.some((m) => m.method === undefined), "approval answered")
        return { server: ctx.server() }
      }),
    )
    const replies = result.server.received.filter((m) => m.method === undefined)
    expect(replies.map((m) => m.result)).toEqual([{ decision: "decline" }])
  })

  test("a thread Codex unloaded while no session held it resumes cleanly (the stale thread/closed is not replayed)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ctx = yield* setup()
        const first = yield* Scope.make()
        const idle = yield* ctx.driver.openSession(makeSessionInput(ctx.workspace, allow())).pipe(Scope.provide(first))
        const threadId = ((yield* collect(idle.events)).events[0] as { nativeSessionId: string }).nativeSessionId
        yield* Scope.close(first, Exit.void)
        yield* waitUntil(() => ctx.server().requests("thread/unsubscribe").length === 1, "unsubscribe")
        // Codex unloads the unsubscribed thread a while later and says so to the connection.
        ctx.server().notify("thread/closed", { threadId })
        yield* Effect.sleep("20 millis")
        const resumed = yield* ctx.driver.openSession(
          makeSessionInput(ctx.workspace, allow(), { nativeSessionId: threadId }),
        )
        const events = yield* collect(resumed.events)
        const started = yield* Effect.exit(resumed.startTurn({ turnId: turnId(1), text: "hello", attachments: [] }))
        if (Exit.isSuccess(started)) yield* events.waitFor(has("TurnCompleted"))
        return { started, events: events.events }
      }),
    )
    expect(failureOf(result.started)).toBeUndefined()
    expect(ofTag(result.events, "SessionClosed")).toEqual([])
    expect(ofTag(result.events, "TurnCompleted").map((e) => e.turnId)).toEqual([turnId(1)])
  })

  test("two sessions share one app-server; events are routed by thread", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ctx = yield* setup()
        const a = yield* ctx.driver.openSession(makeSessionInput(ctx.workspace, allow()))
        const b = yield* ctx.driver.openSession(makeSessionInput(ctx.workspace, allow()))
        const ea = yield* collect(a.events)
        const eb = yield* collect(b.events)
        yield* a.startTurn({ turnId: turnId(1), text: "hello", attachments: [] })
        yield* b.startTurn({ turnId: turnId(2), text: "hello", attachments: [] })
        yield* ea.waitFor(has("TurnCompleted"))
        yield* eb.waitFor(has("TurnCompleted"))
        return { a: ea.events, b: eb.events, launches: ctx.launches.length }
      }),
    )
    expect(result.launches).toBe(1)
    expect(ofTag(result.a, "SessionBound")[0]?.nativeSessionId).toBe("thr-1")
    expect(ofTag(result.b, "SessionBound")[0]?.nativeSessionId).toBe("thr-2")
    expect(result.a.filter((e) => "turnId" in e).every((e) => (e as { turnId?: string }).turnId === turnId(1))).toBe(
      true,
    )
    expect(result.b.filter((e) => "turnId" in e).every((e) => (e as { turnId?: string }).turnId === turnId(2))).toBe(
      true,
    )
  })
})

describe("Codex driver", () => {
  test("probe: version, login label, no problems; models are cached from the probe", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ctx = yield* setup()
        const status = yield* ctx.driver.probe
        const models = yield* ctx.driver.listModels
        return { status, models, launches: ctx.launches }
      }),
    )
    expect(result.status).toMatchObject({
      kind: "codex",
      displayName: "Codex",
      installed: true,
      version: "0.162.1",
      auth: { state: "signed-in", label: "ada@example.com (ChatGPT plus)" },
      problems: [],
    })
    expect(result.models).toEqual([{ id: "gpt-test", label: "GPT Test", default: true, efforts: ["low", "high"] }])
    // The probe used a short-lived app-server; listModels hit the cache.
    expect(result.launches.length).toBe(1)
    expect(result.launches[0]!.server.requests("model/list").length).toBe(1)
  })

  test("probe without a binary reports not installed (no process started)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const ctx = yield* setup({}, { binaryPath: "/nonexistent/codex" })
        const status = yield* ctx.driver.probe
        const models = yield* Effect.exit(ctx.driver.listModels)
        const open = yield* Effect.exit(Effect.scoped(ctx.driver.openSession(makeSessionInput(ctx.workspace, allow()))))
        return { status, models, open, launches: ctx.launches.length }
      }),
    )
    expect(result.status).toMatchObject({ installed: false, auth: { state: "unknown" } })
    expect(result.status.problems[0]).toContain("not installed")
    expect(failureOf(result.models)).toMatchObject({ code: "not-installed" })
    expect(failureOf(result.open)).toMatchObject({ code: "not-installed" })
    expect(result.launches).toBe(0)
  })

  test("probe reports a signed-out profile and a version mismatch", async () => {
    const status = await run(
      Effect.gen(function* () {
        const ctx = yield* setup({
          initialize: () => ({
            userAgent: "openbot/0.150.0 (x)",
            codexHome: "/c",
            platformFamily: "unix",
            platformOs: "linux",
          }),
          "account/read": () => ({ account: null, requiresOpenaiAuth: true }),
        })
        return yield* ctx.driver.probe
      }),
    )
    expect(status.auth).toEqual({ state: "signed-out" })
    expect(status.version).toBe("0.150.0")
    expect(status.problems).toEqual([
      "Codex 0.150.0 is older than the tested 0.162.1; some features may not work.",
      "Codex is not signed in. Run `codex login` in a terminal (OpenBot shares that login), then check again.",
    ])
  })
})

import type { HarnessEvent, HarnessRequest, HarnessRequestResolution, SkillName, TurnId } from "@openbot/contracts"
import { LOCAL_NODE_ID, MAIN_PROFILE_ID, OwnerProfileId } from "@openbot/contracts"
import {
  DataDir,
  type HarnessDriver,
  HarnessRegistry,
  type HarnessSession,
  type McpBinding,
  type OpenSessionInput,
  type RenderedInstructions,
  type ResolvedPlacement,
  sessionKeyOf,
} from "@openbot/core"
import { botId, conversationId, makeBot } from "@openbot/core/testing"
import { afterAll, describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Scope, Stream } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mcpServerName } from "../src/config.ts"
import { OpenCodeHarnessLive, makeOpenCodeDriver } from "../src/Driver.ts"
import { makeHost } from "../src/hub.ts"
import type { SessionOptions } from "../src/Session.ts"
import { FakeOpenCode, scriptCompaction, scriptText } from "./fakeOpenCode.ts"

const root = mkdtempSync(join(tmpdir(), "openbot-oc-test-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const workspace = (name: string) => join(root, "ws", name)

const placement = (dir: string, overrides: Partial<ResolvedPlacement> = {}): ResolvedPlacement => ({
  mode: "native-local",
  hostNodeId: LOCAL_NODE_ID,
  workspacePath: dir,
  harnessCwd: dir,
  env: {},
  disableBuiltinTools: false,
  toolsets: ["bot"],
  promptAppend: "Your tools run on this computer.",
  release: Effect.void,
  ...overrides,
})

const instructions: RenderedInstructions = {
  text: "base\n\nBe nice.",
  sections: {
    base: "You are Scout, an OpenBot.",
    persona: "Be nice.",
    team: "",
    memoryIndex: "",
    placement: "Your tools run here.",
  },
  hash: "h1",
}

const binding = (token: string): McpBinding => ({
  name: "openbot",
  url: "http://127.0.0.1:9/mcp/bot_a",
  headers: { authorization: `Bearer ${token}` },
})

type OnRequest = (request: HarnessRequest) => Effect.Effect<HarnessRequestResolution>

const sessionInput = (opts: {
  readonly bot?: string
  readonly conversation?: string
  readonly dir?: string
  readonly nativeSessionId?: string
  readonly onRequest?: OnRequest
  readonly placement?: Partial<ResolvedPlacement>
  readonly model?: string
}): OpenSessionInput => {
  const bot = makeBot({ id: botId(opts.bot ?? "bot_a"), name: "Scout", harness: { kind: "opencode" } })
  const conv = conversationId(opts.conversation ?? "cnv_1")
  const dir = opts.dir ?? workspace(bot.id)
  return {
    bot,
    conversationId: conv,
    sessionKey: sessionKeyOf(bot.id, conv),
    nativeSessionId: opts.nativeSessionId,
    placement: placement(dir, opts.placement),
    instructions,
    mcp: [binding(`tok-${bot.id}-${conv}`)],
    model: opts.model,
    effort: undefined,
    onRequest: opts.onRequest ?? (() => Effect.succeed({ decision: "allow-once" })),
  }
}

/** Runs a scoped test body against a host over the fake. */
const withDriver = <A>(
  fake: FakeOpenCode,
  body: (driver: HarnessDriver) => Effect.Effect<A, unknown, Scope.Scope>,
  session: SessionOptions = {},
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* makeHost({ start: fake.start, silentTimeoutMs: 0, readyTimeoutMs: 2_000, modelRetries: 0 })
        const driver = makeOpenCodeDriver(host, {
          directory: root,
          binaryFound: true,
          session: {
            mcpConnectTimeoutMs: 2_000,
            interruptGraceMs: 100,
            mcpSettleMs: 0,
            busyWaitMs: 1_000,
            compactTimeoutMs: 2_000,
            ...session,
          },
        })
        return yield* body(driver)
      }),
    ) as Effect.Effect<A, unknown>,
  )

const collect = (session: HarnessSession) =>
  Effect.gen(function* () {
    const events: Array<HarnessEvent> = []
    yield* Effect.forkScoped(Stream.runForEach(session.events, (e) => Effect.sync(() => events.push(e))))
    return events
  })

const until = (predicate: () => boolean, timeoutMs = 2_000) =>
  Effect.promise(async () => {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("timed out")
      await Bun.sleep(5)
    }
  })

const tags = (events: ReadonlyArray<HarnessEvent>) => events.map((e) => e._tag)
const isTerminal = (e: HarnessEvent) =>
  e._tag === "TurnCompleted" || e._tag === "TurnFailed" || e._tag === "TurnInterrupted"
const turn = (id: string, text = "hi") => ({ turnId: id as TurnId, text, attachments: [] })

describe("OpenCode session (fake server)", () => {
  test("open: create, persona entries, per-session MCP with codemode:false, then SessionBound", async () => {
    const fake = new FakeOpenCode()
    await withDriver(fake, (driver) =>
      Effect.gen(function* () {
        const input = sessionInput({ model: "openai/gpt-test#high" })
        const session = yield* driver.openSession(input)
        const events = yield* collect(session)
        yield* until(() => events.length > 0)
        expect(events[0]).toEqual({ _tag: "SessionBound", nativeSessionId: "ses_fake_1" })
        expect(yield* session.nativeSessionId).toBe("ses_fake_1")

        const [create] = fake.callsOf("session.create")
        expect(create!.input.location).toEqual({ directory: input.placement.harnessCwd })
        expect(create!.input.model).toEqual({ providerID: "openai", id: "gpt-test", variant: "high" })
        expect(create!.input.metadata.openbot).toMatchObject({ botId: "bot_a", conversationId: "cnv_1" })
        const name = mcpServerName(input.sessionKey, "openbot")
        expect(create!.input.permissions).toContainEqual({ action: "openbot-*", resource: "*", effect: "deny" })
        expect(create!.input.permissions).toContainEqual({ action: `${name}_*`, resource: "*", effect: "allow" })
        expect(create!.input.permissions).toContainEqual({ action: "shell", resource: "*", effect: "ask" })
        // subagents run without the session's rules: never offered
        expect(create!.input.permissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" })
        expect(create!.input.permissions.some((r: any) => r.action === "read" && r.effect === "deny")).toBe(false)
        expect(create!.input.permissions.some((r: any) => r.action === "execute")).toBe(false)

        const entries = fake.sessions.get("ses_fake_1")!.entries
        expect(Object.fromEntries(entries)).toEqual({
          "openbot.base": "You are Scout, an OpenBot.",
          "openbot.persona": "Be nice.",
          "openbot.placement": "Your tools run here.",
        })

        const [add] = fake.callsOf("mcp.add")
        expect(add!.input).toEqual({
          server: name,
          location: { directory: input.placement.harnessCwd },
          config: {
            type: "remote",
            url: "http://127.0.0.1:9/mcp/bot_a",
            headers: { authorization: "Bearer tok-bot_a-cnv_1" },
            oauth: false,
            codemode: false,
          },
        })
        // waited for `connected` before handing out the session
        expect(fake.callsOf("mcp.list").length).toBeGreaterThanOrEqual(2)
      }),
    )
    // closing the scope removes the session's MCP server
    expect(fake.callsOf("mcp.remove")).toHaveLength(1)
  })

  test("B1 placement denies the built-in tools", async () => {
    const fake = new FakeOpenCode()
    await withDriver(fake, (driver) =>
      Effect.gen(function* () {
        yield* driver.openSession(sessionInput({ placement: { mode: "brain-mcp-hands", disableBuiltinTools: true } }))
        const rules = fake.callsOf("session.create")[0]!.input.permissions as ReadonlyArray<{
          action: string
          resource: string
          effect: string
        }>
        for (const action of ["shell", "read", "edit", "write", "glob", "grep", "execute", "subagent"]) {
          const last = rules.filter((r) => r.action === action).at(-1)
          expect(last).toEqual({ action, resource: "*", effect: "deny" })
        }
        // this session's OpenBot tools stay allowed (the last rule)
        expect(rules.at(-1)).toEqual({
          action: `${mcpServerName(sessionKeyOf(botId("bot_a"), conversationId("cnv_1")), "openbot")}_*`,
          resource: "*",
          effect: "allow",
        })
      }),
    )
  })

  test("skills: only the Bot's skills the model may start on its own are allowed (owner-only ones are not)", async () => {
    const fake = new FakeOpenCode()
    await withDriver(fake, (driver) =>
      Effect.gen(function* () {
        const input = sessionInput({})
        const grillMe = "grill-me" as SkillName
        const skills = [grillMe, "notes" as SkillName]
        yield* driver.openSession({ ...input, bot: { ...input.bot, skills }, ownerOnlySkills: [grillMe] })
        const rules = fake.callsOf("session.create")[0]!.input.permissions as ReadonlyArray<{
          action: string
          resource: string
          effect: string
        }>
        expect(rules.filter((r) => r.action === "skill")).toEqual([
          { action: "skill", resource: "*", effect: "deny" },
          { action: "skill", resource: "notes", effect: "allow" },
        ])
      }),
    )
  })

  test("subscribe-before-prompt barrier: nothing is created or prompted before server.connected", async () => {
    const fake = new FakeOpenCode()
    fake.autoConnect = false
    await withDriver(fake, (driver) =>
      Effect.gen(function* () {
        const opened = yield* Deferred.make<HarnessSession>()
        yield* Effect.forkScoped(
          Effect.flatMap(driver.openSession(sessionInput({})), (s) => Deferred.succeed(opened, s)),
        )
        yield* until(() => fake.servers.length === 1 && fake.server.channels.size === 1)
        yield* Effect.sleep(50)
        expect(fake.callsOf("session.create")).toHaveLength(0)
        expect(yield* Deferred.isDone(opened)).toBe(false)
        fake.server.emit("server.connected", {})
        const session = yield* Deferred.await(opened)
        const events = yield* collect(session)

        // Events emitted right after the prompt reply are not lost and follow TurnStarted.
        fake.onPrompt = (input, server) => scriptText(server, input.sessionID, "Hello!")
        yield* session.startTurn(turn("trn_1"))
        yield* until(() => events.some(isTerminal))
        expect(tags(events)[0]).toBe("SessionBound")
        expect(tags(events)[1]).toBe("TurnStarted")
        const message = events.filter((e) => e._tag === "ItemUpserted").at(-1)
        expect(message).toMatchObject({ turnId: "trn_1", item: { _tag: "Message", text: "Hello!", streaming: false } })
        expect(events.at(-1)).toEqual({ _tag: "TurnCompleted", turnId: "trn_1" as TurnId, stopReason: "succeeded" })
        expect(events.find((e) => e._tag === "Usage")).toMatchObject({ usage: { inputTokens: 1000, outputTokens: 10 } })
        expect(fake.callsOf("session.prompt")[0]!.input).toMatchObject({
          sessionID: "ses_fake_1",
          text: "hi",
          delivery: "queue",
        })
      }),
    )
  })

  test("interrupting a start that waits for server.connected stops the server", async () => {
    const fake = new FakeOpenCode()
    fake.autoConnect = false
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeHost({
            start: fake.start,
            silentTimeoutMs: 0,
            readyTimeoutMs: 2_000,
            modelRetries: 0,
          })
          const starting = yield* Effect.forkScoped(host.connection)
          yield* until(() => fake.servers.length === 1 && fake.server.channels.size === 1)
          yield* Fiber.interrupt(starting)
          yield* until(() => fake.server.dead)
        }),
      ),
    )
  })

  test("sessionID filtering: two sessions on one server only see their own events", async () => {
    const fake = new FakeOpenCode()
    await withDriver(fake, (driver) =>
      Effect.gen(function* () {
        const a = yield* driver.openSession(sessionInput({ conversation: "cnv_a" }))
        const b = yield* driver.openSession(sessionInput({ conversation: "cnv_b" }))
        expect(fake.servers).toHaveLength(1)
        // same workspace, different MCP server names (directory-scoped registry)
        const names = fake.callsOf("mcp.add").map((c) => c.input.server)
        expect(new Set(names).size).toBe(2)
        const ea = yield* collect(a)
        const eb = yield* collect(b)
        yield* a.startTurn(turn("trn_a"))
        yield* b.startTurn(turn("trn_b"))
        const server = fake.server
        server.emit("session.execution.started", { sessionID: "ses_fake_2" })
        server.emit("session.text.delta", {
          sessionID: "ses_fake_2",
          assistantMessageID: "m_b",
          ordinal: 0,
          delta: "from B",
        })
        server.emit("session.text.delta", {
          sessionID: "ses_fake_1",
          assistantMessageID: "m_a",
          ordinal: 0,
          delta: "from A",
        })
        server.emit("session.execution.succeeded", { sessionID: "ses_fake_2" })
        server.emit("session.text.delta", {
          sessionID: "ses_unrelated",
          assistantMessageID: "m_x",
          ordinal: 0,
          delta: "nope",
        })
        yield* until(() => eb.some(isTerminal) && ea.some((e) => e._tag === "ItemUpserted"))
        yield* Effect.sleep(20)
        const textOf = (events: ReadonlyArray<HarnessEvent>) =>
          events.flatMap((e) => (e._tag === "ItemUpserted" && e.item._tag === "Message" ? [e.item.text] : []))
        expect(textOf(ea)).toEqual(["from A"])
        expect(textOf(eb)).toEqual(["from B", "from B"])
        expect(ea.some(isTerminal)).toBe(false)
        expect(eb.at(-1)).toMatchObject({ _tag: "TurnCompleted", turnId: "trn_b" })
        // A starting a second turn while one is running is rejected
        const second = yield* Effect.flip(a.startTurn(turn("trn_a2")))
        expect(second.code).toBe("turn-rejected")
      }),
    )
  })

  test("permission round trip: allow-once, deny with message, allow-session grant; consumer never blocks", async () => {
    const fake = new FakeOpenCode()
    const requests: Array<HarnessRequest> = []
    const decisions: Array<Deferred.Deferred<HarnessRequestResolution>> = []
    const onRequest: OnRequest = (request) =>
      Effect.gen(function* () {
        const d = yield* Deferred.make<HarnessRequestResolution>()
        requests.push(request)
        decisions.push(d)
        return yield* Deferred.await(d)
      })
    await withDriver(fake, (driver) =>
      Effect.gen(function* () {
        const session = yield* driver.openSession(sessionInput({ onRequest }))
        const events = yield* collect(session)
        yield* session.startTurn(turn("trn_1"))
        const s = fake.server
        const sid = "ses_fake_1"
        s.emit("session.execution.started", { sessionID: sid })
        s.emit("session.tool.input.started", { sessionID: sid, assistantMessageID: "m1", id: "call_1", name: "shell" })
        s.emit("session.tool.called", {
          sessionID: sid,
          assistantMessageID: "m1",
          id: "call_1",
          input: { command: "rm -rf build", description: "Clean" },
          executed: false,
        })
        s.emit("permission.asked", {
          id: "per_1",
          sessionID: sid,
          action: "shell",
          resources: ["rm -rf build"],
          save: ["rm *"],
          source: { type: "tool", messageID: "m1", id: "call_1" },
        })
        yield* until(() => requests.length === 1)
        expect(requests[0]).toMatchObject({
          kind: "command-approval",
          surface: "shell",
          toolName: "shell",
          command: "rm -rf build",
          nativeRequestId: "per_1",
          toolKey: "oc:tool:m1:call_1",
        })
        // the consumer keeps going while the decision is pending
        s.emit("session.text.delta", { sessionID: sid, assistantMessageID: "m1", ordinal: 0, delta: "waiting…" })
        yield* until(() => events.some((e) => e._tag === "ItemUpserted" && e.item._tag === "Message"))

        yield* Deferred.succeed(decisions[0]!, { decision: "allow-once" })
        yield* until(() => fake.callsOf("permission.reply").length === 1)
        expect(fake.callsOf("permission.reply")[0]!.input).toEqual({
          sessionID: sid,
          requestID: "per_1",
          decision: "once",
        })

        // deny → reject WITH a message; the tool ends declined
        s.emit("session.tool.input.started", { sessionID: sid, assistantMessageID: "m1", id: "call_2", name: "write" })
        s.emit("session.tool.called", {
          sessionID: sid,
          assistantMessageID: "m1",
          id: "call_2",
          input: { path: "x.txt", content: "x" },
          executed: false,
        })
        s.emit("permission.asked", {
          id: "per_2",
          sessionID: sid,
          action: "edit",
          resources: ["x.txt"],
          save: ["*"],
          metadata: { files: [{ file: "x.txt", patch: "+x", status: "added" }] },
          source: { type: "tool", messageID: "m1", id: "call_2" },
        })
        yield* until(() => requests.length === 2)
        expect(requests[1]).toMatchObject({ kind: "file-approval", surface: "file-edit", paths: ["x.txt"], diff: "+x" })
        yield* Deferred.succeed(decisions[1]!, { decision: "deny", message: "Not now." })
        yield* until(() => fake.callsOf("permission.reply").length === 2)
        expect(fake.callsOf("permission.reply")[1]!.input).toEqual({
          sessionID: sid,
          requestID: "per_2",
          decision: "reject",
          message: "Not now.",
        })
        yield* until(() => fake.callsOf("permission.reply").length === 2)
        yield* Effect.sleep(10)
        s.emit("session.tool.failed", {
          sessionID: sid,
          assistantMessageID: "m1",
          id: "call_2",
          error: { type: "tool.execution", message: "Unable to write x.txt" },
          executed: false,
        })

        // allow-session → session rules get a grant, then `once`
        s.emit("permission.asked", { id: "per_3", sessionID: sid, action: "shell", resources: ["ls"], save: ["ls *"] })
        yield* until(() => requests.length === 3)
        yield* Deferred.succeed(decisions[2]!, { decision: "allow-session" })
        yield* until(() => fake.callsOf("permission.reply").length === 3)
        const update = fake.callsOf("session.update").at(-1)!
        expect(update.input.permissions).toContainEqual({ action: "shell", resource: "ls *", effect: "allow" })
        expect(fake.callsOf("permission.reply")[2]!.input.decision).toBe("once")

        // allow-always → OpenBot owns the durable rule: natively a session grant + `once`, never `always`
        expect(requests[2]!.kind === "question" ? [] : requests[2]!.suggestions?.map((x) => x.decision)).toEqual([
          "allow-session",
        ])
        s.emit("permission.asked", {
          id: "per_4",
          sessionID: sid,
          action: "edit",
          resources: ["src/a.ts"],
          save: ["src/*"],
        })
        yield* until(() => requests.length === 4)
        yield* Deferred.succeed(decisions[3]!, { decision: "allow-always" })
        yield* until(() => fake.callsOf("permission.reply").length === 4)
        expect(fake.callsOf("permission.reply")[3]!.input).toEqual({
          sessionID: sid,
          requestID: "per_4",
          decision: "once",
        })
        expect(fake.callsOf("session.update").at(-1)!.input.permissions).toContainEqual({
          action: "edit",
          resource: "src/*",
          effect: "allow",
        })

        s.emit("session.execution.succeeded", { sessionID: sid })
        yield* until(() => events.some(isTerminal))
        const write = events.filter((e) => e._tag === "ItemUpserted" && e.key === "oc:tool:m1:call_2").at(-1)
        expect(write).toMatchObject({ item: { status: "declined" } })
      }),
    )
  })

  test("cancel → reject without a message; a request answered elsewhere stops waiting", async () => {
    const fake = new FakeOpenCode()
    let interrupted = 0
    const onRequest: OnRequest = (request) =>
      request.nativeRequestId === "per_1"
        ? Effect.succeed({ decision: "cancel" })
        : Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => interrupted++)))
    await withDriver(fake, (driver) =>
      Effect.gen(function* () {
        const session = yield* driver.openSession(sessionInput({ onRequest }))
        yield* session.startTurn(turn("trn_1"))
        fake.server.emit("permission.asked", {
          id: "per_1",
          sessionID: "ses_fake_1",
          action: "shell",
          resources: ["x"],
        })
        yield* until(() => fake.callsOf("permission.reply").length === 1)
        expect(fake.callsOf("permission.reply")[0]!.input).toEqual({
          sessionID: "ses_fake_1",
          requestID: "per_1",
          decision: "reject",
        })
        fake.server.emit("permission.asked", {
          id: "per_2",
          sessionID: "ses_fake_1",
          action: "shell",
          resources: ["y"],
        })
        yield* Effect.sleep(20)
        fake.server.emit("permission.replied", { sessionID: "ses_fake_1", requestID: "per_2", reply: "once" })
        yield* until(() => interrupted === 1)
      }),
    )
  })

  test("question form round trip → form.reply with native values", async () => {
    const fake = new FakeOpenCode()
    const requests: Array<HarnessRequest> = []
    const onRequest: OnRequest = (request) => {
      requests.push(request)
      return Effect.succeed({ answers: { q0: "Blue", q1: ["A", "C"], q2: "yes" } })
    }
    await withDriver(fake, (driver) =>
      Effect.gen(function* () {
        const session = yield* driver.openSession(sessionInput({ onRequest }))
        yield* session.startTurn(turn("trn_1"))
        fake.server.emit("form.created", {
          form: {
            id: "frm_1",
            sessionID: "ses_fake_1",
            title: "Questions",
            metadata: { kind: "question", tool: { messageID: "m1", id: "call_4" } },
            fields: [
              {
                key: "q0",
                title: "Color",
                description: "Which color?",
                type: "string",
                options: [
                  { value: "blue", label: "Blue" },
                  { value: "orange", label: "Orange" },
                ],
                custom: true,
              },
              {
                key: "q1",
                title: "Pick",
                type: "multiselect",
                options: [
                  { value: "a", label: "A" },
                  { value: "b", label: "B" },
                  { value: "c", label: "C" },
                ],
              },
              { key: "q2", title: "Sure?", type: "boolean" },
            ],
          },
        })
        yield* until(() => fake.callsOf("form.reply").length === 1)
        expect(requests[0]).toMatchObject({
          kind: "question",
          nativeRequestId: "frm_1",
          toolKey: "oc:tool:m1:call_4",
          questions: [
            { id: "q0", header: "Color", prompt: "Which color?", multiSelect: false, allowFreeText: true },
            { id: "q1", multiSelect: true, allowFreeText: false },
            { id: "q2", options: [{ label: "Yes" }, { label: "No" }] },
          ],
        })
        expect(fake.callsOf("form.reply")[0]!.input).toEqual({
          sessionID: "ses_fake_1",
          formID: "frm_1",
          answer: { q0: "blue", q1: ["a", "c"], q2: true },
        })
      }),
    )
  })

  test("mcp.add is re-registered after a server restart; the running turn fails retryably", async () => {
    const fake = new FakeOpenCode()
    await withDriver(fake, (driver) =>
      Effect.gen(function* () {
        const input = sessionInput({})
        const session = yield* driver.openSession(input)
        const events = yield* collect(session)
        expect(fake.callsOf("mcp.add").map((c) => c.generation)).toEqual([1])
        yield* session.startTurn(turn("trn_1"))
        fake.server.emit("session.execution.started", { sessionID: "ses_fake_1" })

        fake.server.crash()
        yield* until(() => events.some(isTerminal))
        expect(events.at(-1)).toMatchObject({
          _tag: "TurnFailed",
          turnId: "trn_1",
          error: { code: "closed", retryable: true },
        })

        // The next turn restarts the server and re-adds the MCP server BEFORE prompting.
        fake.onPrompt = (p, server) => scriptText(server, p.sessionID, "back")
        yield* session.startTurn(turn("trn_2"))
        expect(fake.servers).toHaveLength(2)
        const adds = fake.callsOf("mcp.add")
        expect(adds.map((c) => c.generation)).toEqual([1, 2])
        expect(adds[1]!.input.server).toBe(mcpServerName(input.sessionKey, "openbot"))
        const order = fake.calls.filter((c) => c.generation === 2).map((c) => c.method)
        expect(order.indexOf("mcp.add")).toBeLessThan(order.indexOf("session.prompt"))
        expect(fake.callsOf("session.prompt").at(-1)!.input.sessionID).toBe("ses_fake_1")
        yield* until(() => events.filter(isTerminal).length === 2)
        expect(events.at(-1)).toMatchObject({ _tag: "TurnCompleted", turnId: "trn_2" })
        // a third turn on the same server does not re-add
        fake.onPrompt = (p, server) => scriptText(server, p.sessionID, "again")
        yield* session.startTurn(turn("trn_3"))
        expect(fake.callsOf("mcp.add")).toHaveLength(2)
      }),
    )
  })

  test("interrupt: native terminal → TurnInterrupted with aborted text", async () => {
    const fake = new FakeOpenCode()
    fake.onInterrupt = (sessionID, server) => {
      setTimeout(() => {
        server.emit("session.step.failed", {
          sessionID,
          assistantMessageID: "m1",
          error: { type: "aborted", message: "Step interrupted" },
        })
        server.emit("session.execution.interrupted", { sessionID, reason: "user" })
      }, 1)
      return true
    }
    await withDriver(fake, (driver) =>
      Effect.gen(function* () {
        const session = yield* driver.openSession(sessionInput({}))
        const events = yield* collect(session)
        yield* session.startTurn(turn("trn_1"))
        fake.server.emit("session.execution.started", { sessionID: "ses_fake_1" })
        fake.server.emit("session.text.delta", {
          sessionID: "ses_fake_1",
          assistantMessageID: "m1",
          ordinal: 0,
          delta: "wave 1, ",
        })
        yield* until(() => events.some((e) => e._tag === "ItemUpserted"))
        yield* session.interrupt
        yield* until(() => events.some(isTerminal))
        expect(fake.callsOf("session.interrupt")).toHaveLength(1)
        expect(events.at(-1)).toEqual({ _tag: "TurnInterrupted", turnId: "trn_1" as TurnId })
        const message = events.filter((e) => e._tag === "ItemUpserted").at(-1)
        expect(message).toMatchObject({ item: { _tag: "Message", text: "wave 1, ", aborted: true, streaming: false } })
        // after the grace period nothing else is emitted
        yield* Effect.sleep(150)
        expect(events.filter(isTerminal)).toHaveLength(1)
        // interrupt with no turn is a no-op
        yield* session.interrupt
        expect(fake.callsOf("session.interrupt")).toHaveLength(1)
      }),
    )
  })

  test("interrupt when nothing runs natively ends the turn locally", async () => {
    const fake = new FakeOpenCode()
    fake.onInterrupt = () => false
    await withDriver(fake, (driver) =>
      Effect.gen(function* () {
        const session = yield* driver.openSession(sessionInput({}))
        const events = yield* collect(session)
        yield* session.startTurn(turn("trn_1"))
        yield* session.interrupt
        yield* until(() => events.some(isTerminal))
        expect(events.at(-1)).toEqual({ _tag: "TurnInterrupted", turnId: "trn_1" as TurnId })
        // a late native terminal for that turn is ignored
        fake.server.emit("session.execution.interrupted", { sessionID: "ses_fake_1", reason: "user" })
        yield* Effect.sleep(20)
        expect(events.filter(isTerminal)).toHaveLength(1)
      }),
    )
  })

  test("steer uses delivery steer and needs a running turn; rejected prompts fail startTurn", async () => {
    const fake = new FakeOpenCode()
    await withDriver(fake, (driver) =>
      Effect.gen(function* () {
        const session = yield* driver.openSession(sessionInput({}))
        const events = yield* collect(session)
        const noTurn = yield* Effect.flip(session.steer(turn("trn_x")))
        expect(noTurn.code).toBe("turn-rejected")
        yield* session.startTurn(turn("trn_1"))
        yield* session.steer(turn("trn_1", "also this"))
        expect(fake.callsOf("session.prompt").at(-1)!.input).toMatchObject({ text: "also this", delivery: "steer" })
        scriptText(fake.server, "ses_fake_1", "done")
        yield* until(() => events.some(isTerminal))

        fake.rejectPrompt = "UnexpectedStatus: 400"
        const rejected = yield* Effect.flip(session.startTurn(turn("trn_2")))
        expect(rejected.code).toBe("turn-rejected")
        expect(events.some((e) => e._tag === "TurnStarted" && e.turnId === "trn_2")).toBe(false)
        fake.rejectPrompt = undefined
        fake.onPrompt = (p, server) => scriptText(server, p.sessionID, "ok")
        yield* session.startTurn(turn("trn_3"))
        yield* until(() => events.filter(isTerminal).length === 2)
      }),
    )
  })

  test("attachments become file:// URIs", async () => {
    const fake = new FakeOpenCode()
    await withDriver(fake, (driver) =>
      Effect.gen(function* () {
        const session = yield* driver.openSession(sessionInput({}))
        yield* session.startTurn({
          turnId: "trn_1" as TurnId,
          text: "look",
          attachments: [{ path: "/tmp/a b.png", mime: "image/png", name: "a b.png" }],
        })
        expect(fake.callsOf("session.prompt")[0]!.input.files).toEqual([
          { uri: "file:///tmp/a%20b.png", name: "a b.png" },
        ])
      }),
    )
  })

  test("resume: existing session is reused and updated; a missing one is recreated", async () => {
    const fake = new FakeOpenCode()
    await withDriver(fake, (driver) =>
      Effect.gen(function* () {
        yield* Effect.scoped(driver.openSession(sessionInput({})))
        expect(fake.callsOf("session.create")).toHaveLength(1)
        const resumed = yield* driver.openSession(
          sessionInput({ nativeSessionId: "ses_fake_1", model: "openai/gpt-test" }),
        )
        expect(yield* resumed.nativeSessionId).toBe("ses_fake_1")
        expect(fake.callsOf("session.create")).toHaveLength(1)
        expect(fake.callsOf("session.update").at(-1)!.input.sessionID).toBe("ses_fake_1")
        expect(fake.callsOf("session.switchModel").at(-1)!.input.model).toEqual({
          providerID: "openai",
          id: "gpt-test",
        })
        // persona unchanged → no new puts (3 from the first open)
        expect(fake.callsOf("instructions.entry.put")).toHaveLength(3)

        const fresh = yield* driver.openSession(sessionInput({ nativeSessionId: "ses_gone", conversation: "cnv_2" }))
        expect(yield* fresh.nativeSessionId).toBe("ses_fake_2")

        // bound to another directory (placement changed): its tools would be elsewhere → new session
        const moved = yield* driver.openSession(
          sessionInput({ nativeSessionId: "ses_fake_1", dir: workspace("elsewhere") }),
        )
        expect(yield* moved.nativeSessionId).toBe("ses_fake_3")
        expect(fake.callsOf("session.create").at(-1)!.input.location).toEqual({ directory: workspace("elsewhere") })
      }),
    )
  })

  test("compact waits for the compaction's busy period; context usage follows", async () => {
    const fake = new FakeOpenCode()
    await withDriver(fake, (driver) =>
      Effect.gen(function* () {
        yield* driver.listModels // fills the context-window cache
        const session = yield* driver.openSession(sessionInput({}))
        const events = yield* collect(session)
        expect(yield* session.contextUsage).toBeUndefined()
        fake.onPrompt = (p, server) => scriptText(server, p.sessionID, "ok", { tokens: 50_000 })
        yield* session.startTurn(turn("trn_1"))
        yield* until(() => events.some(isTerminal))
        expect(yield* session.contextUsage).toEqual({ usedTokens: 50_010, windowTokens: 200_000 })
        expect(events.find((e) => e._tag === "ContextUsage")).toEqual({
          _tag: "ContextUsage",
          usedTokens: 50_010,
          windowTokens: 200_000,
        })

        // The compaction runs as its own (slow) execution; compact returns only after its terminal.
        let terminalAt = 0
        fake.onCompact = (sessionID, server) =>
          setTimeout(() => {
            scriptCompaction(sessionID, server, { summary: "s".repeat(8_000) })
            terminalAt = Date.now()
          }, 60)
        yield* session.compact
        expect(fake.callsOf("session.compact")[0]!.input).toEqual({ sessionID: "ses_fake_1" })
        expect(terminalAt).toBeGreaterThan(0)
        // summary estimate (8000 chars / 4)
        expect(yield* session.contextUsage).toEqual({ usedTokens: 2_000, windowTokens: 200_000 })
        // the compaction produced no transcript events (no OpenBot turn)
        expect(events.filter(isTerminal)).toHaveLength(1)

        // A turn right after is ended only by its own execution.
        fake.onPrompt = (p, server) => setTimeout(() => scriptText(server, p.sessionID, "after"), 20)
        yield* session.startTurn(turn("trn_2"))
        yield* until(() => events.filter(isTerminal).length === 2)
        const message = events.filter((e) => e._tag === "ItemUpserted").at(-1)
        expect(message).toMatchObject({ turnId: "trn_2", item: { _tag: "Message", text: "after", streaming: false } })
      }),
    )
  })

  test("compaction failure is a retryable error; turns are refused while compacting", async () => {
    const fake = new FakeOpenCode()
    await withDriver(fake, (driver) =>
      Effect.gen(function* () {
        const session = yield* driver.openSession(sessionInput({}))
        fake.onCompact = (sessionID, server) =>
          setTimeout(() => scriptCompaction(sessionID, server, { fail: "did not fill in the template" }), 40)
        const compacting = yield* Effect.forkChild(Effect.flip(session.compact), { startImmediately: true })
        yield* until(() => fake.callsOf("session.compact").length === 1)
        const busy = yield* Effect.flip(session.startTurn(turn("trn_1")))
        expect(busy).toMatchObject({ code: "turn-rejected" })
        const error = yield* Fiber.join(compacting)
        expect(error).toMatchObject({ code: "other", retryable: true })
        expect(error.message).toContain("did not fill in the template")
        // the session is usable again
        fake.onPrompt = (p, server) => scriptText(server, p.sessionID, "ok")
        yield* session.startTurn(turn("trn_2"))
      }),
    )
  })

  test("a late native terminal after a local interrupt never ends the next turn", async () => {
    const fake = new FakeOpenCode()
    fake.onInterrupt = () => true // acknowledged, but the terminal comes late (after the grace period)
    await withDriver(fake, (driver) =>
      Effect.gen(function* () {
        const session = yield* driver.openSession(sessionInput({}))
        const events = yield* collect(session)
        yield* session.startTurn(turn("trn_1"))
        fake.server.emit("session.execution.started", { sessionID: "ses_fake_1" })
        yield* Effect.sleep(10)
        yield* session.interrupt
        yield* until(() => events.some(isTerminal))
        expect(events.filter(isTerminal)).toEqual([{ _tag: "TurnInterrupted", turnId: "trn_1" as TurnId }])

        // trn_2 waits for the native execution to settle before prompting
        fake.onPrompt = (p, server) => scriptText(server, p.sessionID, "fresh")
        const second = yield* Effect.forkChild(session.startTurn(turn("trn_2")), { startImmediately: true })
        yield* Effect.sleep(80)
        expect(fake.callsOf("session.prompt")).toHaveLength(1)
        const staleAt = Date.now()
        fake.server.emit("session.execution.interrupted", { sessionID: "ses_fake_1", reason: "user" })
        yield* Fiber.join(second)
        expect(fake.callsOf("session.prompt").at(-1)!.at).toBeGreaterThanOrEqual(staleAt)
        yield* until(() => events.filter(isTerminal).length === 2)
        expect(events.filter(isTerminal)).toEqual([
          { _tag: "TurnInterrupted", turnId: "trn_1" as TurnId },
          { _tag: "TurnCompleted", turnId: "trn_2" as TurnId, stopReason: "succeeded" },
        ])
      }),
    )
  })

  test("the first prompt waits for the tool registry to settle after mcp connected (G5)", async () => {
    const fake = new FakeOpenCode()
    await withDriver(
      fake,
      (driver) =>
        Effect.gen(function* () {
          const session = yield* driver.openSession(sessionInput({}))
          yield* session.startTurn(turn("trn_1"))
          const lastList = fake.callsOf("mcp.list").at(-1)!
          const prompt = fake.callsOf("session.prompt")[0]!
          expect(prompt.at - lastList.at).toBeGreaterThanOrEqual(75)
        }),
      { mcpSettleMs: 80 },
    )
  })

  test("probe = /api/info + model.list + integration.list (no model call)", async () => {
    const fake = new FakeOpenCode()
    await withDriver(fake, (driver) =>
      Effect.gen(function* () {
        const status = yield* driver.probe
        expect(status).toMatchObject({
          installed: true,
          version: "2.0.6",
          auth: { state: "signed-in", label: "OpenAI" },
          problems: [],
        })
        expect(fake.callsOf("server.info")).toHaveLength(0) // the fake transport is pre-verified
        expect(fake.callsOf("model.list")).toHaveLength(1)
        expect(fake.callsOf("integration.list")).toHaveLength(1)

        // no stored login, but a provider key in the environment
        fake.integrations = [{ id: "anthropic", name: "Anthropic", methods: [], connections: [] }]
        fake.models = [
          {
            id: "claude-x",
            providerID: "anthropic",
            name: "Claude X",
            variants: [],
            status: "active",
            enabled: true,
            limit: { context: 1 },
          },
        ]
        expect((yield* driver.probe).auth).toEqual({ state: "signed-in", label: "anthropic (from the environment)" })

        // free models only
        fake.models = [
          {
            id: "free",
            providerID: "opencode",
            name: "Free",
            variants: [],
            status: "active",
            enabled: true,
            limit: { context: 1 },
          },
        ]
        expect((yield* driver.probe).auth).toMatchObject({ state: "signed-out" })

        // nothing usable
        fake.models = [
          {
            id: "old",
            providerID: "opencode",
            name: "Old",
            variants: [],
            status: "deprecated",
            enabled: true,
            limit: { context: 1 },
          },
        ]
        const empty = yield* driver.probe
        expect(empty.problems[0]).toContain("no usable models")
        expect(fake.callsOf("session.prompt")).toHaveLength(0)
      }),
    )
  })

  test("listModels and probe (no model call)", async () => {
    const fake = new FakeOpenCode()
    await withDriver(fake, (driver) =>
      Effect.gen(function* () {
        const models = yield* driver.listModels
        expect(models).toEqual([
          { id: "openai/gpt-test", label: "GPT Test", efforts: ["low", "high"] },
          { id: "opencode/free", label: "Free", default: true },
        ])
        const status = yield* driver.probe
        expect(status).toMatchObject({
          kind: "opencode",
          displayName: "OpenCode",
          installed: true,
          version: "2.0.6",
          auth: { state: "signed-in", label: "OpenAI" },
          problems: [],
        })
        expect(fake.callsOf("session.prompt")).toHaveLength(0)
      }),
    )
  })
})

describe("OpenCodeHarnessLive", () => {
  test("registers the driver; probe reports a missing binary without failing", async () => {
    const fake = new FakeOpenCode()
    const dataRoot = join(root, "data")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* HarnessRegistry
        const driver = yield* registry.get("opencode")
        const status = yield* driver.probe
        return { kind: driver.kind, caps: driver.capabilities, status }
      }).pipe(
        Effect.provide(
          OpenCodeHarnessLive({ startTransport: () => fake.start, host: { silentTimeoutMs: 0 } }).pipe(
            Layer.provideMerge(HarnessRegistry.layer),
            Layer.provideMerge(DataDir.layer(dataRoot)),
          ),
        ),
      ),
    )
    expect(result.kind).toBe("opencode")
    expect(result.caps).toMatchObject({ approvals: "interactive", remotePlacements: ["brain-mcp-hands"] })
    expect(result.status).toMatchObject({ installed: true, version: "2.0.6" })
    // the layer stopped the server
    expect(fake.server.dead).toBe(true)

    const missing = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* (yield* HarnessRegistry).get("opencode")
        return yield* driver.probe
      }).pipe(
        Effect.provide(
          OpenCodeHarnessLive({ binary: "definitely-not-opencode-xyz" }).pipe(
            Layer.provideMerge(HarnessRegistry.layer),
            Layer.provideMerge(DataDir.layer(dataRoot)),
          ),
        ),
      ),
    )
    expect(missing).toMatchObject({ installed: false, auth: { state: "unknown" } })
    expect(missing.problems[0]).toContain("not found")
  })

  test("a profile's sessions run on its own server, which lists only that profile's skills", async () => {
    const fakes = { main: new FakeOpenCode(), demo: new FakeOpenCode() }
    const dataRoot = join(root, "data-profiles")
    const dirs = {
      main: join(dataRoot, "skills-lib", "skills"),
      demo: join(dataRoot, "profiles", "prf_demo", "skills-lib", "skills"),
    }
    const started: Array<ReadonlyArray<string>> = []
    const demo = sessionInput({ bot: "bot_demo" })
    await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* (yield* HarnessRegistry).get("opencode")
        yield* driver.openSession(sessionInput({ bot: "bot_main" }))
        yield* driver.openSession({ ...demo, bot: { ...demo.bot, ownerProfileId: OwnerProfileId.make("prf_demo") } })
        yield* driver.openSession(sessionInput({ bot: "bot_main_2" }))
      }).pipe(
        Effect.scoped,
        Effect.provide(
          OpenCodeHarnessLive({
            startTransport: (server) => {
              started.push(server.skillsDirs)
              return server.skillsDirs.includes(dirs.demo) ? fakes.demo.start : fakes.main.start
            },
            host: { silentTimeoutMs: 0, readyTimeoutMs: 2_000, modelRetries: 0 },
            session: { mcpConnectTimeoutMs: 2_000, mcpSettleMs: 0 },
          }).pipe(Layer.provideMerge(HarnessRegistry.layer), Layer.provideMerge(DataDir.layer(dataRoot))),
        ),
      ),
    )
    expect(started).toEqual([[dirs.main], [dirs.demo]])
    expect(fakes.main.callsOf("session.create").length).toBe(2)
    expect(fakes.demo.callsOf("session.create").length).toBe(1)
  })

  test("forgetting an owner profile stops its server, never the main one's", async () => {
    const fakes = { main: new FakeOpenCode(), demo: new FakeOpenCode() }
    const demoDir = join(root, "data-forget", "profiles", "prf_demo", "skills-lib", "skills")
    const demo = sessionInput({ bot: "bot_demo" })
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* HarnessRegistry
        const driver = yield* registry.get("opencode")
        yield* driver.openSession(sessionInput({ bot: "bot_main" }))
        yield* driver.openSession({ ...demo, bot: { ...demo.bot, ownerProfileId: OwnerProfileId.make("prf_demo") } })
        yield* registry.forgetOwnerProfile(OwnerProfileId.make("prf_demo"))
        yield* registry.forgetOwnerProfile(MAIN_PROFILE_ID)
        return { main: fakes.main.server.dead, demo: fakes.demo.server.dead }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          OpenCodeHarnessLive({
            startTransport: (server) => (server.skillsDirs.includes(demoDir) ? fakes.demo.start : fakes.main.start),
            host: { silentTimeoutMs: 0, readyTimeoutMs: 2_000, modelRetries: 0 },
            session: { mcpConnectTimeoutMs: 2_000, mcpSettleMs: 0 },
          }).pipe(
            Layer.provideMerge(HarnessRegistry.layer),
            Layer.provideMerge(DataDir.layer(join(root, "data-forget"))),
          ),
        ),
      ),
    )
    expect(out).toEqual({ main: false, demo: true })
  })
})

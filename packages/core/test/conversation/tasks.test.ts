/**
 * Background tasks (docs/decisions.md D5.7): a bot hands long work to a short-lived session of its
 * own and stays free to chat; the result comes back to its main session in the origin conversation.
 */
import { describe, expect, test } from "bun:test"
import type { ConversationId, KnownRosterStreamItem, Task, TaskId } from "@openbot/contracts"
import { MAX_TASK_RESTARTS } from "@openbot/contracts"
import { Deferred, Effect, Option } from "effect"
import {
  ApprovalService,
  CallPresence,
  BackgroundTasks,
  BootRecovery,
  BotRepo,
  BotService,
  ConversationService,
  LiveHub,
  Orchestrator,
  RequestRepo,
  TaskRepo,
} from "../../src/ports/index.ts"
import { McpBindingIssuerFake, runTest } from "../../src/testing/index.ts"
import {
  renderTaskTurn,
  TASK_CONTEXT_BYTES,
  TASK_CONTEXT_MESSAGES,
} from "../../src/services/conversation/BackgroundTasks.ts"
import {
  appLayer,
  turnsOf,
  collect,
  createBot,
  eventually,
  messagesOf,
  send,
  settled,
  TestDriver,
  transcript,
  type TurnHandle,
} from "./helpers.ts"

const tasksOf = (botId: Task["botId"]) => Effect.flatMap(BackgroundTasks, (t) => t.list({ botId }))

/** The brief part of a task's first turn (after the origin conversation's recent messages). */
const briefOf = (text: string) => {
  const at = text.lastIndexOf("[The brief]\n")
  return at < 0 ? text : text.slice(at + "[The brief]\n".length).split("\n\n[Update to this work]")[0]!
}
const taskById = (id: TaskId) =>
  Effect.map(
    Effect.flatMap(BackgroundTasks, (t) => t.get(id)),
    (d) => d.task,
  )
const statusOf = (id: TaskId) => Effect.map(taskById(id), (t) => t.status)

/**
 * The bot's behavior in BOTH kinds of session:
 * - main session, "start <title>": calls start_task (brief "work on <title>") and replies at once;
 * - main session, a `[Result of …]` turn: reports it;
 * - a task's own session: waits on the gate named in its brief, then answers with its result;
 * - anything else: a quick reply.
 */
const behavior =
  (
    tasks: BackgroundTasks["Service"],
    gates: Map<string, Deferred.Deferred<void>>,
    onTask?: (turn: TurnHandle) => Effect.Effect<void>,
  ) =>
  (turn: TurnHandle) =>
    Effect.gen(function* () {
      const text = turn.input.text
      if (turn.taskId !== undefined) {
        if (text.startsWith("[Update to this work]")) {
          // a later turn of the task's session: it applied the update and answers again
          yield* turn.say(`${turn.turnId}/m`, `Redone with: ${text.split("\n")[1]}`)
          yield* turn.complete("end_turn")
          return
        }
        const brief = briefOf(text)
        yield* turn.emit({ _tag: "Activity", label: "Reading the front page", toolKind: "web" })
        yield* turn.emit({
          _tag: "ItemUpserted",
          turnId: turn.turnId,
          key: `${turn.turnId}/tool`,
          item: {
            _tag: "ToolCall",
            toolName: "web_fetch",
            title: "Fetch",
            kind: "web",
            status: "running",
            inputSummary: "news.ycombinator.com",
          },
        })
        const gate = [...gates.entries()].find(([k]) => brief.includes(k))?.[1]
        if (gate !== undefined) yield* Deferred.await(gate)
        if (onTask !== undefined) yield* onTask(turn)
        const steered = turn.steered.map((t) => t.text.split("\n")[1]).join("; ")
        yield* turn.emit({
          _tag: "ItemUpserted",
          turnId: turn.turnId,
          key: `${turn.turnId}/tool`,
          item: {
            _tag: "ToolCall",
            toolName: "web_fetch",
            title: "Fetch",
            kind: "web",
            status: "completed",
            inputSummary: "news.ycombinator.com",
          },
        })
        yield* turn.say(`${turn.turnId}/m`, `Result for ${brief}${steered === "" ? "" : ` (with: ${steered})`}`)
        yield* turn.complete("end_turn")
        return
      }
      const start = /^(?:\[[^\n]*\]\n)?(?:\[@[^\]]+\]: )?start (.+)$/.exec(text)
      if (start !== null) {
        const title = start[1]!.trim()
        const task = yield* Effect.orDie(tasks.start(turn.tool, { title, brief: `work on ${title}` }))
        yield* turn.say(`${turn.turnId}/m`, `Sure (${task.status})`)
        yield* turn.complete("end_turn")
        return
      }
      if (text.includes("[Result of ")) {
        yield* turn.say(`${turn.turnId}/m`, `Report: ${text.split("\n").slice(-1)[0]}`)
        yield* turn.complete("end_turn")
        return
      }
      yield* turn.say(`${turn.turnId}/m`, `Quick answer to ${text}`)
      yield* turn.complete("end_turn")
    })

const makeGates = (...names: Array<string>) =>
  Effect.gen(function* () {
    const gates = new Map<string, Deferred.Deferred<void>>()
    for (const name of names) gates.set(name, yield* Deferred.make<void>())
    return gates
  })

describe("background tasks", () => {
  test("start_task returns at once; the task runs in its own session while the bot answers the owner; its result wakes the bot in the origin conversation", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const hub = yield* LiveHub
        const roster = yield* collect(hub.subscribeRoster({}))
        const ada = yield* createBot("Ada")
        const dm = ada.directConversationId
        const gates = yield* makeGates("HN digest")
        yield* driver.setBehavior(ada.id, behavior(yield* BackgroundTasks, gates))

        yield* send(dm, "start HN digest")
        yield* settled(dm, 1) // the starting turn ended normally
        const [task] = yield* tasksOf(ada.id)
        yield* eventually(
          Effect.map(statusOf(task!.id), (s) => s === "running"),
          "task running",
        )

        // the owner talks to the bot meanwhile: an immediate answer from the main session
        yield* send(dm, "how are you?")
        yield* settled(dm, 2)
        const meanwhile = messagesOf(yield* transcript(dm)).map((m) => m.text)
        const stillRunning = yield* statusOf(task!.id)

        yield* Deferred.succeed(gates.get("HN digest")!, undefined)
        yield* eventually(
          Effect.map(statusOf(task!.id), (s) => s === "succeeded"),
          "task done",
        )
        yield* settled(dm, 3) // the result's turn
        return {
          ada,
          task: yield* taskById(task!.id),
          detail: yield* (yield* BackgroundTasks).get(task!.id),
          meanwhile,
          stillRunning,
          opened: yield* driver.opened,
          handles: yield* driver.turns,
          dm: yield* transcript(dm),
          issued: yield* (yield* McpBindingIssuerFake).issued,
          roster: (yield* roster.items) as ReadonlyArray<KnownRosterStreamItem>,
        }
      }),
      appLayer(),
    )
    expect(out.meanwhile).toEqual(["start HN digest", "Sure (running)", "how are you?", "Quick answer to how are you?"])
    expect(out.stillRunning).toBe("running")
    // two sessions: the bot's main one and the task's own (unique key, task section in its instructions)
    expect(out.opened).toHaveLength(2)
    expect(out.opened[1]!.sessionKey).toBe(`${out.ada.id}:${out.task.id}`)
    expect(out.opened[1]!.nativeSessionId).toBeUndefined()
    expect(out.opened[1]!.instructions.text).toContain('You are doing one piece of work for yourself: "HN digest"')
    expect(out.opened[0]!.instructions.text).toContain("`start_task`")
    expect(out.opened[0]!.instructions.text).not.toContain("## Right now")
    // its token carries the task and keeps the origin conversation
    expect(out.issued.at(-1)).toMatchObject({
      claims: { taskId: out.task.id, conversationId: out.ada.directConversationId },
      revoked: true,
    })
    const taskTurn = out.handles.find((h) => h.taskId !== undefined)!
    // its first turn: the DM's recent messages (so the brief stays short), then the brief
    expect(taskTurn.input.text).toBe(
      "[Recent messages of your direct chat with the owner, where this work was started (oldest first, for context)]\n[Owner]: start HN digest\n\n[The brief]\nwork on HN digest",
    )
    expect(out.opened[1]!.instructions.text).toContain(
      "opens with the recent messages of the conversation the work was started from",
    )
    expect(out.opened[1]!.instructions.text).not.toContain("it is everything you know about this work")
    // the result came back to the main session in the DM, as content
    const report = out.handles.at(-1)!
    expect(report.taskId).toBeUndefined()
    expect(report.conversationId).toBe(out.ada.directConversationId)
    expect(report.input.text).toBe('[Result of "HN digest"]\nResult for work on HN digest')
    expect(out.task).toMatchObject({ status: "succeeded", result: "Result for work on HN digest", stepCount: 1 })
    // its steps are the task's, never chat bubbles
    expect(out.detail.steps.map((s) => s.kind)).toEqual(["tool-call", "message"])
    expect(out.dm.some((e) => e.turnId === taskTurn.turnId)).toBe(false)
    expect(messagesOf(out.dm).map((m) => m.text)).toEqual([
      "start HN digest",
      "Sure (running)",
      "how are you?",
      "Quick answer to how are you?",
      "Report: Result for work on HN digest",
    ])
    // the roster carried the task through queued → running → succeeded
    const statuses = out.roster.flatMap((i) =>
      i.kind === "change" && i.change.type === "task.upserted" ? [i.change.task.status] : [],
    )
    expect(statuses[0]).toBe("queued")
    expect(statuses).toContain("running")
    expect(statuses.at(-1)).toBe("succeeded")
  })

  test("work started on a voice call reports back on the call while it lasts, and to the chat after", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const orchestrator = yield* Orchestrator
        const presence = yield* CallPresence
        const ada = yield* createBot("Ada")
        const dm = ada.directConversationId
        const gates = yield* makeGates("inbox sweep", "calendar sweep")
        yield* driver.setBehavior(ada.id, behavior(yield* BackgroundTasks, gates))
        presence.enter(ada.id)
        // on the call: "start …" arrives as a voice delivery
        for (const title of ["inbox sweep", "calendar sweep"]) {
          const receipt = yield* orchestrator.deliver({
            conversationId: dm,
            botId: ada.id,
            kind: "user-message",
            text: `start ${title}`,
            urgency: "urgent",
            voice: true,
          })
          yield* orchestrator.awaitDelivery(receipt.deliveryId)
        }
        const [inbox, calendar] = [...(yield* tasksOf(ada.id))].sort((a, b) => a.title.localeCompare(b.title)).reverse()
        // the inbox finishes while the call is on: its report is a voice turn
        yield* Deferred.succeed(gates.get("inbox sweep")!, undefined)
        yield* eventually(
          Effect.map(statusOf(inbox!.id), (s) => s === "succeeded"),
          "inbox done",
        )
        yield* settled(dm, 3)
        // the owner hangs up; the calendar finishes after: a normal turn, in the chat
        presence.leave(ada.id)
        yield* Deferred.succeed(gates.get("calendar sweep")!, undefined)
        yield* eventually(
          Effect.map(statusOf(calendar!.id), (s) => s === "succeeded"),
          "calendar done",
        )
        yield* settled(dm, 4)
        return { turns: yield* turnsOf(dm), handles: yield* driver.turns }
      }),
      appLayer(),
    )
    const reports = out.handles.filter((h) => h.taskId === undefined && h.input.text.startsWith("[Result of "))
    const voiceOf = (text: string) =>
      out.turns.find((t) => t.id === reports.find((r) => r.input.text.includes(text))?.turnId)?.voice
    expect(voiceOf("inbox sweep")).toBe(true)
    expect(voiceOf("calendar sweep")).toBeUndefined()
  })

  test("cancel stops only that task; the owner's stop is reported, the bot's own is not", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const tasks = yield* BackgroundTasks
        const ada = yield* createBot("Ada")
        const dm = ada.directConversationId
        const gates = yield* makeGates("alpha", "beta", "gamma")
        yield* driver.setBehavior(ada.id, behavior(yield* BackgroundTasks, gates))
        yield* send(dm, "start alpha")
        yield* send(dm, "start beta")
        yield* send(dm, "start gamma")
        yield* settled(dm, 3)
        const list = yield* tasksOf(ada.id)
        const id = (title: string) => list.find((t) => t.title === title)!.id
        yield* eventually(
          Effect.map(tasksOf(ada.id), (ts) => ts.every((t) => t.status === "running")),
          "all running",
        )

        const stopped = yield* tasks.cancel(id("alpha"), "owner")
        yield* settled(dm, 4) // the owner's stop is reported to the bot
        const byBot = yield* tasks.cancel(id("beta"), "bot")
        const afterBot = (yield* transcript(dm)).length
        const others = yield* statusOf(id("gamma"))
        yield* Deferred.succeed(gates.get("gamma")!, undefined)
        yield* eventually(
          Effect.map(statusOf(id("gamma")), (s) => s === "succeeded"),
          "gamma done",
        )
        yield* settled(dm, 5)
        return { stopped, byBot, others, afterBot, handles: yield* driver.turns, dm: yield* transcript(dm) }
      }),
      appLayer(),
    )
    expect(out.stopped).toMatchObject({ status: "cancelled", stoppedBy: "owner" })
    expect(out.byBot).toMatchObject({ status: "cancelled", stoppedBy: "bot" })
    expect(out.others).toBe("running")
    const reports = out.handles.filter((h) => h.taskId === undefined && h.input.text.includes("[Result of"))
    expect(reports.map((h) => h.input.text.split("\n").slice(0, 2).join("\n"))).toEqual([
      '[Result of "alpha"]\nThe owner stopped it before it finished.',
      '[Result of "gamma"]\nResult for work on gamma',
    ])
  })

  test("at most maxPerBot run at once; more wait in line and start when one ends", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const ada = yield* createBot("Ada")
        const dm = ada.directConversationId
        const gates = yield* makeGates("one", "two", "three")
        yield* driver.setBehavior(ada.id, behavior(yield* BackgroundTasks, gates))
        for (const name of ["one", "two", "three"]) yield* send(dm, `start ${name}`)
        yield* settled(dm, 3)
        const byTitle = (title: string) => Effect.map(tasksOf(ada.id), (ts) => ts.find((t) => t.title === title)!)
        yield* eventually(
          Effect.map(byTitle("two"), (t) => t.status === "running"),
          "two running",
        )
        const before = [
          (yield* byTitle("one")).status,
          (yield* byTitle("two")).status,
          (yield* byTitle("three")).status,
        ]
        yield* Deferred.succeed(gates.get("one")!, undefined)
        yield* eventually(
          Effect.map(byTitle("three"), (t) => t.status === "running"),
          "three started",
        )
        const middle = [(yield* byTitle("one")).status, (yield* byTitle("two")).status]
        yield* Deferred.succeed(gates.get("two")!, undefined)
        yield* Deferred.succeed(gates.get("three")!, undefined)
        yield* eventually(
          Effect.map(tasksOf(ada.id), (ts) => ts.every((t) => t.status === "succeeded")),
          "all done",
        )
        return { before, middle, sessions: (yield* driver.opened).length }
      }),
      appLayer({ tasks: { maxPerBot: 2 } }),
    )
    expect(out.before).toEqual(["running", "running", "queued"])
    expect(out.middle).toEqual(["succeeded", "running"])
    expect(out.sessions).toBe(4) // main + one per task
  })

  test("a task's approval lands in its origin group, labelled with its title, and the answer goes back to the task", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const approvals = yield* ApprovalService
        const orchestrator = yield* Orchestrator
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        yield* (yield* BotService).update(ada.id, { autonomy: "ask" })
        const group = yield* (yield* ConversationService).createGroup({
          title: "launch",
          memberBotIds: [ada.id, bob.id],
          leadBotId: ada.id,
        })
        const answers: Array<unknown> = []
        yield* driver.setBehavior(
          ada.id,
          behavior(yield* BackgroundTasks, new Map(), (turn) =>
            Effect.gen(function* () {
              // a native request, then a gateway tool's (through the Orchestrator)
              answers.push(
                yield* turn.request({
                  kind: "command-approval",
                  toolName: "fake_shell",
                  title: "Run make deploy",
                  detail: "",
                  surface: "shell",
                  command: "make deploy",
                  cwd: "/srv/app",
                }),
              )
              answers.push(
                yield* orchestrator.approveToolCall(turn.tool, {
                  kind: "command-approval",
                  toolName: "shell",
                  title: "Run rm -rf build",
                  detail: "",
                  surface: "shell",
                  command: "rm -rf build",
                  cwd: "/srv/app",
                }),
              )
            }),
          ),
        )
        yield* send(group.id, "start deploy")
        yield* eventually(
          Effect.map(tasksOf(ada.id), (ts) => ts.length === 1),
          "started",
        )
        const [task] = yield* tasksOf(ada.id)
        const requests = yield* RequestRepo
        const pendingIn = (id: ConversationId) =>
          Effect.map(Effect.orDie(requests.list({ conversationId: id, statuses: ["pending"] })), (rs) => rs)
        yield* eventually(
          Effect.map(pendingIn(group.id), (rs) => rs.length === 1),
          "first card",
        )
        const first = (yield* pendingIn(group.id))[0]!
        const waiting = yield* taskById(task!.id)
        yield* approvals.respond({ requestId: first.id, response: { type: "decision", decision: "allow-once" } })
        yield* eventually(
          Effect.map(pendingIn(group.id), (rs) => rs.length === 1 && rs[0]!.id !== first.id),
          "second card",
        )
        const second = (yield* pendingIn(group.id))[0]!
        yield* approvals.respond({ requestId: second.id, response: { type: "decision", decision: "deny" } })
        yield* eventually(
          Effect.map(statusOf(task!.id), (s) => s === "succeeded"),
          "task done",
        )
        yield* settled(group.id, 2)
        const entries = yield* transcript(group.id)
        return {
          group,
          task: task!,
          first,
          second,
          waiting,
          answers,
          entries,
          dm: yield* transcript(ada.directConversationId),
          handles: yield* driver.turns,
        }
      }),
      appLayer({ approvals: "live" }),
    )
    expect(out.task.conversationId).toBe(out.group.id)
    expect(out.first).toMatchObject({ conversationId: out.group.id, taskId: out.task.id })
    expect(out.first.turnId).toBeUndefined()
    expect(out.waiting).toMatchObject({ waiting: true, progress: "Waiting for you: Run make deploy" })
    const cards = out.entries.flatMap((e) => (e.kind === "card" && e.card.type === "approval" ? [e.card] : []))
    expect(cards.map((c) => [c.title, c.taskTitle])).toEqual([
      ["Run make deploy", "deploy"],
      ["Run rm -rf build", "deploy"],
    ])
    expect(out.answers).toEqual([{ decision: "allow-once" }, { decision: "deny" }])
    // the task saw the group's recent messages
    expect(out.handles.find((h) => h.taskId !== undefined)!.input.text).toStartWith(
      '[Recent messages of the group chat "launch", where this work was started (oldest first, for context)]\n[Owner]: start deploy\n',
    )
    // the result is reported in the group (the origin), by the main session
    const report = out.handles.at(-1)!
    expect(report.conversationId).toBe(out.group.id)
    expect(report.input.text).toContain('[Result of "deploy"]')
    expect(out.dm.filter((e) => e.kind === "card")).toEqual([])
  })

  test("auto-allowed requests of a task become its steps, never conversation lines", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const ada = yield* createBot("Ada")
        yield* (yield* BotService).update(ada.id, { autonomy: "full" })
        yield* driver.setBehavior(
          ada.id,
          behavior(yield* BackgroundTasks, new Map(), (turn) =>
            Effect.asVoid(
              turn.request({
                kind: "command-approval",
                toolName: "fake_shell",
                title: "Run ls",
                detail: "",
                surface: "shell",
                command: "ls",
              }),
            ),
          ),
        )
        yield* send(ada.directConversationId, "start look")
        yield* eventually(
          Effect.map(tasksOf(ada.id), (ts) => ts.length === 1),
          "started",
        )
        const [task] = yield* tasksOf(ada.id)
        yield* eventually(
          Effect.map(statusOf(task!.id), (s) => s === "succeeded"),
          "done",
        )
        yield* settled(ada.directConversationId, 2)
        return {
          dm: yield* transcript(ada.directConversationId),
          steps: (yield* (yield* BackgroundTasks).get(task!.id)).steps,
        }
      }),
      appLayer({ approvals: "live" }),
    )
    expect(out.dm.filter((e) => e.kind === "event" && e.event.type === "auto-decided")).toEqual([])
    expect(out.steps.some((s) => s.kind === "event" && s.event.type === "auto-decided")).toBe(true)
  })

  /** A task left running by the previous run, then boot recovery and `recover`. */
  const afterRestart = (extra: Partial<Task>) =>
    runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const ada = yield* createBot("Ada")
        yield* driver.setBehavior(ada.id, behavior(yield* BackgroundTasks, new Map()))
        const repo = yield* TaskRepo
        yield* Effect.orDie(
          repo.upsert({
            id: "tsk_old" as TaskId,
            botId: ada.id,
            conversationId: ada.directConversationId,
            title: "Nightly audit",
            brief: "audit",
            status: "running",
            createdAt: 0,
            updatedAt: 0,
            startedAt: 0,
            ...extra,
          }),
        )
        const report = yield* Effect.orDie((yield* BootRecovery).run)
        yield* (yield* BackgroundTasks).recover(report)
        yield* settled(ada.directConversationId, 1)
        return {
          report,
          task: yield* taskById("tsk_old" as TaskId),
          handles: yield* driver.turns,
          opened: yield* driver.opened,
        }
      }),
      appLayer(),
    )

  test("hand-off: a running task is interrupted and stays running (untold) for the next boot to run again", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const ada = yield* createBot("Ada")
        const gates = yield* makeGates("long render")
        yield* driver.setBehavior(ada.id, behavior(yield* BackgroundTasks, gates))
        yield* send(ada.directConversationId, "start long render")
        yield* settled(ada.directConversationId, 1)
        yield* eventually(
          Effect.map(tasksOf(ada.id), (ts) => ts[0]?.status === "running"),
          "running",
        )
        const turnsBefore = (yield* driver.turns).filter((t) => t.taskId === undefined).length
        yield* (yield* Orchestrator).handOff
        // were it still running, it would finish now
        yield* Deferred.succeed(gates.get("long render")!, undefined)
        for (let i = 0; i < 200; i++) yield* Effect.yieldNow
        const [task] = yield* tasksOf(ada.id)
        const stored = yield* Effect.orDie((yield* TaskRepo).get(task!.id))
        return { stored, turnsBefore, turnsAfter: (yield* driver.turns).filter((t) => t.taskId === undefined).length }
      }),
      appLayer(),
    )
    expect(Option.getOrThrow(out.stored).status).toBe("running")
    expect(out.turnsAfter).toBe(out.turnsBefore)
  })

  test("a task a restart cut off runs again under its id, back in its own session", async () => {
    const out = await afterRestart({ nativeSessionId: "native-task-old" })
    expect(out.report.interruptedTasks.map((t) => t.id)).toEqual(["tsk_old" as TaskId])
    expect(out.task).toMatchObject({ status: "succeeded", restarts: 1 })
    expect(out.opened.find((o) => o.purpose === "task")?.nativeSessionId).toBe("native-task-old")
    const taskTurn = out.handles.find((h) => h.taskId === ("tsk_old" as TaskId))!
    expect(taskTurn.input.text).toStartWith("[This work was cut off before you finished")
    expect(out.handles.at(-1)!.input.text).toStartWith('[Result of "Nightly audit"]')
  })

  test("without a session to resume it starts over knowing that; too many restarts → reported unfinished", async () => {
    const fresh = await afterRestart({})
    const taskTurn = fresh.handles.find((h) => h.taskId === ("tsk_old" as TaskId))!
    expect(briefOf(taskTurn.input.text)).toStartWith("audit")
    expect(taskTurn.input.text).toContain("cut off by a restart. Some of it may already be done")
    expect(fresh.task.status).toBe("succeeded")

    const tooMany = await afterRestart({ restarts: MAX_TASK_RESTARTS })
    expect(tooMany.task).toMatchObject({ status: "failed", error: "interrupted by a restart" })
    expect(tooMany.task.awaitingRecovery).toBeUndefined()
    expect(tooMany.handles.at(-1)!.input.text).toBe(
      '[Result of "Nightly audit"]\nIt could not be finished: interrupted by a restart.',
    )
  })

  test("a brain stopped between boot recovery and `recover` does not lose the task: the next boot runs it", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const ada = yield* createBot("Ada")
        yield* driver.setBehavior(ada.id, behavior(yield* BackgroundTasks, new Map()))
        const repo = yield* TaskRepo
        yield* Effect.orDie(
          repo.upsert({
            id: "tsk_lost" as TaskId,
            botId: ada.id,
            conversationId: ada.directConversationId,
            title: "Train times search",
            brief: "search",
            status: "running",
            createdAt: 0,
            updatedAt: 0,
            startedAt: 0,
          }),
        )
        // boot A: recovery fails the task, then the brain is stopped before `recover` (no restart, no report)
        const first = yield* Effect.orDie((yield* BootRecovery).run)
        const afterFirst = Option.getOrThrow(yield* Effect.orDie(repo.get("tsk_lost" as TaskId)))
        // boot B: its recovery finds the task again although it is no longer running
        const second = yield* Effect.orDie((yield* BootRecovery).run)
        yield* (yield* BackgroundTasks).recover(second)
        yield* settled(ada.directConversationId, 1)
        // boot C: nothing is left over
        const third = yield* Effect.orDie((yield* BootRecovery).run)
        return {
          first,
          afterFirst,
          second,
          third,
          task: yield* taskById("tsk_lost" as TaskId),
          handles: yield* driver.turns,
        }
      }),
      appLayer(),
    )
    expect(out.first.interruptedTasks.map((t) => t.id)).toEqual(["tsk_lost" as TaskId])
    expect(out.afterFirst).toMatchObject({ status: "failed", awaitingRecovery: true })
    expect(out.second.interruptedTasks.map((t) => t.id)).toEqual(["tsk_lost" as TaskId])
    expect(out.task).toMatchObject({ status: "succeeded", restarts: 1 })
    expect(out.task.awaitingRecovery).toBeUndefined()
    expect(out.third.interruptedTasks).toEqual([])
    expect(out.handles.at(-1)!.input.text).toStartWith('[Result of "Train times search"]')
  })

  test("deleting a group stops the work started there (untold); deleting the bot stops and removes its tasks", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const gates = yield* makeGates("in group", "in dm")
        yield* driver.setBehavior(ada.id, behavior(yield* BackgroundTasks, gates))
        const group = yield* (yield* ConversationService).createGroup({
          title: "g",
          memberBotIds: [ada.id, bob.id],
          leadBotId: ada.id,
        })
        yield* send(group.id, "start in group")
        yield* send(ada.directConversationId, "start in dm")
        yield* settled(ada.directConversationId, 1)
        yield* settled(group.id, 1)
        const list = yield* tasksOf(ada.id)
        const id = (title: string) => list.find((t) => t.title === title)!.id
        yield* eventually(
          Effect.map(tasksOf(ada.id), (ts) => ts.length === 2 && ts.every((t) => t.status === "running")),
          "running",
        )
        yield* (yield* Orchestrator).deleteConversation(group.id)
        const groupTask = yield* taskById(id("in group"))
        const dmTask = yield* taskById(id("in dm"))
        const turnsBefore = (yield* driver.turns).length
        yield* (yield* BotService).delete(ada.id)
        const left = yield* Effect.orDie((yield* TaskRepo).list({ botId: ada.id }))
        return {
          groupTask,
          dmTask,
          turnsBefore,
          turnsAfter: (yield* driver.turns).length,
          left,
          bot: yield* Effect.orDie((yield* BotRepo).get(ada.id)),
        }
      }),
      appLayer(),
    )
    expect(out.groupTask).toMatchObject({ status: "cancelled", stoppedBy: "system" })
    expect(out.dmTask.status).toBe("running")
    expect(out.turnsAfter).toBe(out.turnsBefore) // nobody was told
    expect(out.left).toEqual([])
    expect(Option.isNone(out.bot)).toBe(true)
  })

  test("start_task refuses a task session and empty input", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const ada = yield* createBot("Ada")
        const tasks = yield* BackgroundTasks
        const ctx = {
          claims: {
            botId: ada.id,
            conversationId: ada.directConversationId,
            sessionKey: `${ada.id}:${ada.directConversationId}`,
            toolsets: ["bot" as const],
            hostNodeId: ada.hostNodeId,
            workspacePath: "/w",
            boundNodeIds: [],
          },
        }
        const fromTask = yield* Effect.flip(
          tasks.start({ ...ctx, taskId: "tsk_x" as TaskId }, { title: "a", brief: "b" }),
        )
        const empty = yield* Effect.flip(tasks.start(ctx, { title: " ", brief: "b" }))
        const again1 = yield* tasks.start({ ...ctx, callId: "call-1" }, { title: "a", brief: "b" })
        const again2 = yield* tasks.start({ ...ctx, callId: "call-1" }, { title: "a", brief: "b" })
        const found = yield* tasks.find(ada.id, '"A"')
        return { fromTask, empty, same: again1.id === again2.id, found: found.id === again1.id }
      }),
      appLayer(),
    )
    expect(out.fromTask._tag).toBe("InvalidInput")
    expect(out.empty._tag).toBe("InvalidInput")
    expect(out.same).toBe(true)
    expect(out.found).toBe(true)
  })
})

/** A tool context of the bot's main session in `conversationId` (what the gateway passes). */
const mainCtx = (bot: { readonly id: Task["botId"]; readonly hostNodeId: string }, conversationId: ConversationId) => ({
  claims: {
    botId: bot.id,
    conversationId,
    sessionKey: `${bot.id}:${conversationId}`,
    toolsets: ["bot" as const],
    hostNodeId: bot.hostNodeId as never,
    workspacePath: "/w",
    boundNodeIds: [],
  },
})

describe("a task sees its origin conversation", () => {
  test("its first turn opens with the recent messages (speakers, oldest first), then the short brief", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const ada = yield* createBot("Ada")
        const dm = ada.directConversationId
        yield* driver.setBehavior(ada.id, behavior(yield* BackgroundTasks, new Map()))
        yield* send(dm, "make a short film about the architecture")
        yield* settled(dm, 1)
        yield* send(dm, "use the orb version, dark background")
        yield* settled(dm, 2)
        yield* send(dm, "start film")
        yield* settled(dm, 3)
        const [task] = yield* tasksOf(ada.id)
        yield* eventually(
          Effect.map(statusOf(task!.id), (s) => s === "succeeded"),
          "done",
        )
        return { handles: yield* driver.turns, task: yield* taskById(task!.id) }
      }),
      appLayer(),
    )
    const first = out.handles.find((h) => h.taskId !== undefined)!.input.text
    expect(first).toBe(
      [
        "[Recent messages of your direct chat with the owner, where this work was started (oldest first, for context)]",
        "[Owner]: make a short film about the architecture",
        "[You]: Quick answer to make a short film about the architecture",
        "[Owner]: use the orb version, dark background",
        "[You]: Quick answer to use the orb version, dark background",
        "[Owner]: start film",
        "",
        "[The brief]",
        "work on film",
      ].join("\n"),
    )
    // the stored brief is the bot's own (the Tasks tab shows it); the context is only in the turn
    expect(out.task.brief).toBe("work on film")
    expect(out.task.result).toBe("Result for work on film")
  })

  test("the context keeps the newest messages within the limits; long ones are capped", () => {
    const messages = Array.from({ length: 45 }, (_, i) => ({
      speaker: i % 2 === 0 ? "Owner" : "You",
      text: `message ${i}`,
    }))
    const text = renderTaskTurn({ where: "your direct chat with the owner", messages, brief: "do it" })
    const lines = text.split("\n").filter((l) => l.startsWith("[Owner]") || l.startsWith("[You]"))
    expect(lines).toHaveLength(TASK_CONTEXT_MESSAGES)
    expect(lines[0]).toBe(`[You]: message ${45 - TASK_CONTEXT_MESSAGES}`)
    expect(lines.at(-1)).toBe("[Owner]: message 44")
    expect(text.endsWith("[The brief]\ndo it")).toBe(true)

    const long = renderTaskTurn({
      where: "x",
      messages: Array.from({ length: 10 }, (_, i) => ({ speaker: "@Bob", text: `${i}`.repeat(6_000) })),
      brief: "do it",
    })
    const kept = long.split("\n").filter((l) => l.startsWith("[@Bob]"))
    expect(kept.length).toBeGreaterThan(1)
    expect(kept.at(-1)!.startsWith("[@Bob]: 9999")).toBe(true)
    expect(kept.every((l) => l.endsWith("…") && l.length < 4_200)).toBe(true)
    expect(new TextEncoder().encode(kept.join("\n")).length).toBeLessThanOrEqual(TASK_CONTEXT_BYTES)
    // nothing to show: just the brief
    expect(renderTaskTurn({ where: "x", messages: [], brief: " do it " })).toBe("[The brief]\ndo it")
  })
})

describe("updates to running work (update_task)", () => {
  test("steered into the running turn when the driver can steer; one of its steps", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const tasks = yield* BackgroundTasks
        const ada = yield* createBot("Ada")
        const dm = ada.directConversationId
        const gates = yield* makeGates("film")
        yield* driver.setBehavior(ada.id, behavior(tasks, gates))
        yield* send(dm, "start film")
        yield* settled(dm, 1)
        const [task] = yield* tasksOf(ada.id)
        yield* eventually(
          Effect.map(driver.turns, (hs) => hs.some((h) => h.taskId === task!.id)),
          "task turn running",
        )
        const updated = yield* tasks.update(mainCtx(ada, dm), {
          taskId: task!.id,
          message: "The globe at the start is off screen; center it.",
        })
        yield* Deferred.succeed(gates.get("film")!, undefined)
        yield* eventually(
          Effect.map(statusOf(task!.id), (s) => s === "succeeded"),
          "done",
        )
        yield* settled(dm, 2)
        return {
          updated,
          handles: yield* driver.turns,
          task: yield* taskById(task!.id),
          steps: (yield* tasks.get(task!.id)).steps,
          steers: yield* driver.steers,
        }
      }),
      appLayer({ capabilities: { steer: true } }),
    )
    expect(out.updated.delivery).toBe("steered")
    const taskTurns = out.handles.filter((h) => h.taskId !== undefined)
    expect(taskTurns).toHaveLength(1)
    expect(taskTurns[0]!.steered.map((t) => t.text)).toEqual([
      "[Update to this work]\nThe globe at the start is off screen; center it.",
    ])
    expect(out.task).toMatchObject({
      status: "succeeded",
      result: "Result for work on film (with: The globe at the start is off screen; center it.)",
    })
    // the update is one of the work's steps (the Tasks tab shows it), never a chat bubble
    expect(
      out.steps
        .filter((s) => s.kind === "message" && s.role === "user")
        .map((s) => (s.kind === "message" ? s.text : "")),
    ).toEqual(["The globe at the start is off screen; center it."])
    // the result came back to the main session once
    expect(out.handles.filter((h) => h.taskId === undefined && h.input.text.includes("[Result of")).length).toBe(1)
  })

  test("without steering it waits for the turn to end; the work goes on with it and answers again", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const tasks = yield* BackgroundTasks
        const ada = yield* createBot("Ada")
        const dm = ada.directConversationId
        const gates = yield* makeGates("film")
        yield* driver.setBehavior(ada.id, behavior(tasks, gates))
        yield* send(dm, "start film")
        yield* settled(dm, 1)
        const [task] = yield* tasksOf(ada.id)
        yield* eventually(
          Effect.map(driver.turns, (hs) => hs.some((h) => h.taskId === task!.id)),
          "task turn running",
        )
        const updated = yield* tasks.update(mainCtx(ada, dm), { taskId: task!.id, message: "Center the globe." })
        const between = yield* statusOf(task!.id)
        yield* Deferred.succeed(gates.get("film")!, undefined)
        yield* eventually(
          Effect.map(statusOf(task!.id), (s) => s === "succeeded"),
          "done",
        )
        yield* settled(dm, 2)
        const after = yield* tasks.update(mainCtx(ada, dm), { taskId: task!.id, message: "One more thing." })
        return {
          updated,
          between,
          after,
          handles: yield* driver.turns,
          task: yield* taskById(task!.id),
          opened: yield* driver.opened,
        }
      }),
      appLayer(),
    )
    expect(out.updated.delivery).toBe("queued")
    expect(out.between).toBe("running")
    const taskTurns = out.handles.filter((h) => h.taskId !== undefined)
    expect(taskTurns).toHaveLength(2)
    expect(taskTurns[1]!.sessionKey).toBe(taskTurns[0]!.sessionKey) // the same session goes on
    expect(taskTurns[1]!.input.text).toStartWith("[Update to this work]\nCenter the globe.\n\n")
    expect(taskTurns[1]!.input.text).toContain("give your complete final answer again")
    expect(out.opened).toHaveLength(2) // main + the task's (no new session for the update)
    expect(out.task).toMatchObject({ status: "succeeded", result: "Redone with: Center the globe." })
    const reports = out.handles.filter((h) => h.taskId === undefined && h.input.text.includes("[Result of"))
    expect(reports.map((h) => h.input.text)).toEqual(['[Result of "film"]\nRedone with: Center the globe.'])
    // work that is over says so; nothing runs again
    expect(out.after.delivery).toBe("finished")
    expect(out.after.task.status).toBe("succeeded")
  })

  test("work still waiting to start takes the update in its first turn", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const tasks = yield* BackgroundTasks
        const ada = yield* createBot("Ada")
        const dm = ada.directConversationId
        const gates = yield* makeGates("one")
        yield* driver.setBehavior(ada.id, behavior(tasks, gates))
        yield* send(dm, "start one")
        yield* send(dm, "start two")
        yield* settled(dm, 2)
        const two = (yield* tasksOf(ada.id)).find((t) => t.title === "two")!
        const waiting = two.status
        const updated = yield* tasks.update(mainCtx(ada, dm), { taskId: two.id, message: "Mention the sidebar." })
        yield* Deferred.succeed(gates.get("one")!, undefined)
        yield* eventually(
          Effect.map(statusOf(two.id), (s) => s === "succeeded"),
          "two done",
        )
        return { waiting, updated, handles: yield* driver.turns }
      }),
      appLayer({ tasks: { maxPerBot: 1 } }),
    )
    expect(out.waiting).toBe("queued")
    expect(out.updated.delivery).toBe("queued")
    const turn = out.handles.find((h) => h.taskId !== undefined && h.input.text.includes("work on two"))!
    expect(turn.input.text).toEndWith("[The brief]\nwork on two\n\n[Update to this work]\nMention the sidebar.")
  })

  test("refuses a task session, an empty update and another bot's work", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const tasks = yield* BackgroundTasks
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const ctx = mainCtx(ada, ada.directConversationId)
        const task = yield* tasks.start(ctx, { title: "a", brief: "b" })
        const fromTask = yield* Effect.flip(
          tasks.update({ ...ctx, taskId: task.id }, { taskId: task.id, message: "x" }),
        )
        const empty = yield* Effect.flip(tasks.update(ctx, { taskId: task.id, message: "  " }))
        const foreign = yield* Effect.flip(
          tasks.update(mainCtx(bob, bob.directConversationId), { taskId: task.id, message: "x" }),
        )
        return { fromTask, empty, foreign }
      }),
      appLayer(),
    )
    expect(out.fromTask._tag).toBe("InvalidInput")
    expect(out.empty._tag).toBe("InvalidInput")
    expect(out.foreign._tag).toBe("NotFound")
  })
})

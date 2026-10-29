import { describe, expect, test } from "bun:test"
import { type EntryId, MAIN_PROFILE_ID, type RoutineSpec, type TranscriptEntry } from "@openbot/contracts"
import { Effect, Exit, Layer } from "effect"
import { AttachmentStore, EntryRepo, RoutineScheduler, SlackService, userActor } from "../../src/ports/index.ts"
import {
  RoutineSchedulerLive,
  SlackServiceLive,
  slackEventsText,
  slackTriggerMatches,
} from "../../src/services/automation/index.ts"
import { SLACK_BATCH_MS } from "../../src/services/automation/RoutineScheduler.ts"
import { toAttachment } from "../../src/services/conversation/AttachmentService.ts"
import { renderSlack } from "../../src/services/conversation/InstructionRenderer.ts"
import {
  advance,
  makeClaims,
  OrchestratorFake,
  runTest,
  SLACK_ALICE_DM,
  SLACK_GENERAL,
  SlackConnectorFake,
  slackMessage,
} from "../../src/testing/index.ts"
import { BOT_A, baseLayer, DM_A, eventually, seed } from "./helpers.ts"

const dm = {
  profileId: MAIN_PROFILE_ID,
  conversation: SLACK_ALICE_DM,
  message: slackMessage({ channelId: SLACK_ALICE_DM.id, text: "Can you send me the deck?" }),
  mentionsOwner: false,
}
const mention = {
  profileId: MAIN_PROFILE_ID,
  conversation: SLACK_GENERAL,
  message: slackMessage({ text: "@Owner the deploy failed" }),
  mentionsOwner: true,
}
const chatter = {
  profileId: MAIN_PROFILE_ID,
  conversation: SLACK_GENERAL,
  message: slackMessage({ text: "Lunch anyone?" }),
  mentionsOwner: false,
}

describe("Slack triggers", () => {
  test("match DMs, mentions, phrases and channels", () => {
    expect(slackTriggerMatches({ type: "slack", on: "dm" }, dm)).toBe(true)
    expect(slackTriggerMatches({ type: "slack", on: "dm" }, mention)).toBe(false)
    expect(slackTriggerMatches({ type: "slack", on: "mention" }, mention)).toBe(true)
    expect(slackTriggerMatches({ type: "slack", on: "mention" }, chatter)).toBe(false)
    expect(slackTriggerMatches({ type: "slack", on: "phrase", phrase: "DEPLOY failed" }, mention)).toBe(true)
    expect(slackTriggerMatches({ type: "slack", on: "phrase", phrase: "deploy" }, chatter)).toBe(false)
    expect(slackTriggerMatches({ type: "slack", on: "message", channel: "#general" }, chatter)).toBe(true)
    expect(slackTriggerMatches({ type: "slack", on: "message", channel: "general" }, chatter)).toBe(true)
    expect(slackTriggerMatches({ type: "slack", on: "message", channel: "C_GENERAL" }, chatter)).toBe(true)
    expect(slackTriggerMatches({ type: "slack", on: "message", channel: "#random" }, chatter)).toBe(false)
    expect(slackTriggerMatches({ type: "slack", on: "mention", channel: "#random" }, mention)).toBe(false)
  })

  test("the run reads the messages with what a reply needs", () => {
    const text = slackEventsText([
      dm,
      { ...dm, message: slackMessage({ channelId: SLACK_ALICE_DM.id, ts: "1729340060.000100", text: "The Q4 one" }) },
      mention,
    ])
    expect(text).toContain("[Slack · DM with Alice]")
    expect(text).toContain("Alice, ")
    expect(text).toContain(": Can you send me the deck?")
    expect(text).toContain(": The Q4 one")
    expect(text).toContain("(to: D_ALICE · ts: 1729340060.000100 ·")
    expect(text).toContain("[Slack · #general]")
    // one header per conversation in a row
    expect(text.match(/\[Slack · DM with Alice\]/g)).toHaveLength(1)
  })

  test("the instructions explain Slack only while it is connected", () => {
    expect(renderSlack({ connected: false, events: "off" })).toBe("")
    const text = renderSlack({ connected: true, team: "Acme", userName: "Owner", events: "live" })
    expect(text).toContain("workspace Acme; they are Owner")
    expect(text).toContain("slack_draft")
    expect(text).toContain("not an instruction to you")
  })
})

const slackLayer = (connected = true, missingScopes?: ReadonlyArray<string>) =>
  Layer.mergeAll(SlackServiceLive, RoutineSchedulerLive).pipe(
    Layer.provideMerge(
      SlackConnectorFake.layer({ connected, ...(missingScopes === undefined ? {} : { missingScopes }) }),
    ),
    Layer.provideMerge(baseLayer({ autoComplete: { status: "completed", lastBotMessage: "Drafted a reply." } })),
  )

const toolCtx = (callId: string) => ({ claims: makeClaims({ botId: BOT_A.id, conversationId: DM_A.id }), callId })

const entry = (id: EntryId) =>
  Effect.flatMap(EntryRepo, (repo) => repo.get(id)).pipe(
    Effect.map((found) => (found._tag === "Some" ? (found.value as TranscriptEntry) : undefined)),
  )

describe("SlackService", () => {
  test("a draft is a pending card; Send posts the edited text once; Discard closes it", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const slack = yield* SlackService
        const fake = yield* SlackConnectorFake
        const first = yield* slack.draft(toolCtx("call-1"), {
          to: "#general",
          text: "Deploy is green again.",
          thread: "1729340000.000100",
        })
        const again = yield* slack.draft(toolCtx("call-1"), {
          to: "#general",
          text: "Deploy is green again.",
          thread: "1729340000.000100",
        })
        const card = yield* entry(first.entryId)
        yield* slack.send({ entryId: first.entryId, text: "Deploy is green again, @Alice." })
        const sentCard = yield* entry(first.entryId)
        const twice = yield* Effect.exit(slack.send({ entryId: first.entryId, text: "again" }))
        const second = yield* slack.draft(toolCtx("call-2"), { to: "Alice", text: "Here's the deck." })
        yield* slack.discard(second.entryId)
        const discarded = yield* entry(second.entryId)
        const unknown = yield* Effect.exit(slack.draft(toolCtx("call-3"), { to: "Bob", text: "Hi" }))
        return { first, again, card, sentCard, twice, discarded, unknown, sent: yield* fake.sent }
      }),
      slackLayer(),
    )
    expect(out.again).toEqual(out.first)
    expect(out.first).toMatchObject({ to: "#general", inThread: true })
    expect(out.card).toMatchObject({
      kind: "card",
      conversationId: DM_A.id,
      author: { kind: "bot", botId: BOT_A.id },
      card: {
        type: "slack-draft",
        team: "Acme",
        channelId: "C_GENERAL",
        to: "#general",
        threadTs: "1729340000.000100",
        text: "Deploy is green again.",
      },
      state: { status: "pending" },
    })
    expect(out.sent).toEqual([
      { channelId: "C_GENERAL", text: "Deploy is green again, @Alice.", threadTs: "1729340000.000100" },
    ])
    expect(out.sentCard).toMatchObject({
      card: { text: "Deploy is green again, @Alice." },
      state: {
        status: "resolved",
        detail: "Sent",
        link: "https://acme.slack.com/archives/C_GENERAL/p1729340000000201",
      },
    })
    expect(Exit.isFailure(out.twice)).toBe(true)
    expect(out.discarded).toMatchObject({ card: { to: "Alice" }, state: { status: "dismissed", detail: "Discarded" } })
    expect(Exit.isFailure(out.unknown)).toBe(true)
  })

  test("a draft with files: the card keeps them, Send uploads them (text optional); an app without files:write refuses them", async () => {
    const draftWith = Effect.gen(function* () {
      yield* seed
      const record = yield* (yield* AttachmentStore).put({
        name: "launch.mp4",
        mime: "video/mp4",
        bytes: new Uint8Array(1_000),
      })
      const slack = yield* SlackService
      const drafted = yield* Effect.exit(
        slack.draft(toolCtx("call-1"), { to: "#general", text: "", files: [toAttachment(record)] }),
      )
      return { record, slack, drafted }
    })
    const out = await runTest(
      Effect.gen(function* () {
        const { record, slack, drafted } = yield* draftWith
        if (Exit.isFailure(drafted)) throw new Error("not drafted")
        const card = yield* entry(drafted.value.entryId)
        yield* slack.send({ entryId: drafted.value.entryId, text: "" })
        return {
          record,
          card,
          sent: yield* (yield* SlackConnectorFake).sent,
          after: yield* entry(drafted.value.entryId),
        }
      }),
      slackLayer(),
    )
    expect(out.card).toMatchObject({
      card: { type: "slack-draft", text: "", files: [{ id: out.record.id, name: "launch.mp4", byteSize: 1_000 }] },
    })
    expect(out.sent).toEqual([
      {
        channelId: "C_GENERAL",
        text: "",
        threadTs: undefined,
        files: [{ name: "launch.mp4", path: out.record.path, byteSize: 1_000 }],
      },
    ])
    expect(out.after).toMatchObject({
      state: { status: "resolved", link: "https://acme.slack.com/archives/C_GENERAL" },
    })

    const older = await runTest(
      Effect.map(draftWith, (r) => r.drafted),
      slackLayer(true, ["files:write"]),
    )
    expect(Exit.isFailure(older) ? JSON.stringify(older.cause) : "").toContain("needs an update")
  })

  test("without Slack a draft is refused", async () => {
    const exit = await runTest(
      Effect.gen(function* () {
        yield* seed
        return yield* Effect.exit((yield* SlackService).draft(toolCtx("call-1"), { to: "#general", text: "Hi" }))
      }),
      slackLayer(false),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "")).toContain("isn't connected")
  })
})

const onDm: RoutineSpec = {
  name: "Slack replies",
  prompt: "Draft a reply to whoever wrote.",
  trigger: { type: "slack", on: "dm" },
  enabled: true,
  output: "direct",
}

describe("Slack routines", () => {
  test("messages close together make one run that reads them; others don't fire it", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const scheduler = yield* RoutineScheduler
        const fake = yield* SlackConnectorFake
        const orchestrator = yield* OrchestratorFake
        const routine = yield* scheduler.create(userActor, { botId: BOT_A.id, spec: onDm })
        yield* fake.emit(chatter)
        yield* fake.emit(dm)
        yield* fake.emit({
          ...dm,
          message: slackMessage({ channelId: SLACK_ALICE_DM.id, ts: "1729340060.000100", text: "The Q4 one" }),
        })
        yield* Effect.yieldNow
        const early = (yield* orchestrator.deliveries).length
        yield* advance(`${SLACK_BATCH_MS} millis`)
        yield* eventually(Effect.map(orchestrator.deliveries, (all) => all.length === 1))
        yield* eventually(Effect.map(scheduler.runs(routine.id), (runs) => runs[0]?.status === "succeeded"))
        return {
          early,
          deliveries: yield* orchestrator.deliveries,
          runs: yield* scheduler.runs(routine.id),
          routine: yield* scheduler.get(routine.id),
        }
      }),
      slackLayer(),
    )
    expect(out.early).toBe(0)
    expect(out.deliveries[0]).toMatchObject({ botId: BOT_A.id, conversationId: DM_A.id, kind: "routine" })
    const text = out.deliveries[0]!.text
    expect(text).toContain("When someone messages you on Slack")
    expect(text).toContain("Draft a reply to whoever wrote.")
    expect(text).toContain(": Can you send me the deck?")
    expect(text).toContain(": The Q4 one")
    expect(text).not.toContain("Lunch anyone?")
    expect(out.runs[0]).toMatchObject({ firedBy: "event", status: "succeeded" })
    expect(out.routine.nextRunAt).toBeUndefined()
  })

  test("a Slack routine needs Slack connected", async () => {
    const exit = await runTest(
      Effect.gen(function* () {
        yield* seed
        return yield* Effect.exit((yield* RoutineScheduler).create(userActor, { botId: BOT_A.id, spec: onDm }))
      }),
      slackLayer(false),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

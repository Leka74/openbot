// The Slack connector (D3.4) against a fake Slack, and a Bot's draft end to end through the brain.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type TranscriptEntry, transcriptOf } from "@openbot/contracts"
import type { SlackEvent } from "@openbot/core"
import { Effect, Exit, Fiber, Ref, Scope, Stream } from "effect"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeSlackConnector, parseSlackLink } from "../src/slack/connector.ts"
import { readableText, slackText } from "../src/slack/text.ts"
import { ALL_SCOPES, FAKE_APP_TOKEN, FAKE_USER_TOKEN, type FakeSlack, messageEnvelope, SCOPES_WITHOUT_FILES, shortcutEnvelope, startFakeSlack } from "./fixtures/fakeSlack.ts"
import { eventually, login, rpcClient, startServer, type TestServer, watchConversation } from "./helpers.ts"

describe("Slack text", () => {
  const names = { user: (id: string) => ({ U1: "Alice Smith" } as Record<string, string>)[id], channel: (id: string) => ({ C1: "general" } as Record<string, string>)[id] }

  test("reads Slack markup the way people do", () => {
    expect(readableText("hi <@U1>, see <#C1> and <#C2|random>", names)).toBe("hi @Alice Smith, see #general and #random")
    expect(readableText("<https://x.com/a|the doc> <https://x.com/b> <mailto:a@b.c|a@b.c>", names)).toBe("the doc (https://x.com/a) https://x.com/b a@b.c")
    expect(readableText("<!here> <!channel> <!subteam^S1|@design> 1 &lt; 2 &amp;&amp; 3 &gt; 2", names)).toBe("@here @channel @design 1 < 2 && 3 > 2")
    expect(readableText("<@U9>", names)).toBe("@someone")
  })

  test("writes mentions of known people and escapes the rest", () => {
    const people = [{ id: "U1", names: ["Alice Smith", "alice"] }, { id: "U2", names: ["Bob", "bob"] }]
    expect(slackText("@Alice Smith and @bob: 1 < 2 & done", people)).toBe("<@U1> and <@U2>: 1 &lt; 2 &amp; done")
    expect(slackText("thanks @alice! cc @here", people)).toBe("thanks <@U1>! cc <!here>")
    expect(slackText("mail me at a@alice.com, @Carol", people)).toBe("mail me at a@alice.com, @Carol")
  })

  test("message links", () => {
    expect(parseSlackLink("https://acme.slack.com/archives/C123ABC/p1729340000123456")).toEqual({ channelId: "C123ABC", ts: "1729340000.123456" })
    expect(parseSlackLink("https://acme.slack.com/archives/C1/p1729340050000100?thread_ts=1729340000.000100&cid=C1")).toEqual({
      channelId: "C1",
      ts: "1729340050.000100",
      threadTs: "1729340000.000100",
    })
    expect(parseSlackLink("#general")).toBeUndefined()
  })
})

describe("SlackConnector", () => {
  let slack: FakeSlack
  let dir: string
  beforeAll(() => {
    slack = startFakeSlack()
    dir = mkdtempSync(join(tmpdir(), "openbot-slack-test-"))
  })
  afterAll(() => {
    slack.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  test("connects, reads, searches, finds, resolves, sends, hears live messages and forgets", async () => {
    const file = join(dir, "slack.json")
    const scope = Effect.runSync(Scope.make())
    const connector = await Effect.runPromise(Scope.provide(makeSlackConnector({ file, apiUrl: slack.url, reconnectMs: 50 }), scope))
    const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
    try {
      expect(await run(connector.status)).toEqual({ connected: false, events: "off" })
      const bot = await Effect.runPromiseExit(connector.connect({ userToken: "xoxb-nope" }))
      expect(Exit.isFailure(bot)).toBe(true)
      const wrong = await Effect.runPromiseExit(connector.connect({ userToken: "xoxp-wrong" }))
      expect(JSON.stringify(wrong)).toContain("didn't accept")

      const connected = await run(connector.connect({ userToken: FAKE_USER_TOKEN, appToken: FAKE_APP_TOKEN }))
      expect(connected).toMatchObject({ connected: true, team: "Acme", userId: "U_OWNER", userName: "Owner" })
      expect(statSync(file).mode & 0o777).toBe(0o600)
      for (let i = 0; i < 100 && (await run(connector.status)).events !== "live"; i++) await Bun.sleep(20)
      expect((await run(connector.status)).events).toBe("live")

      const general = await run(connector.read({ conversation: "#general", limit: 30 }))
      expect(general.conversation).toEqual({ id: "C_GENERAL", kind: "channel", label: "#general", topic: "Company news" })
      expect(general.more).toBe(true)
      expect(general.messages.map((m) => `${m.author}: ${m.text}`)).toEqual([
        "Bob: see the doc (https://x.com/doc) & #general",
        "Alice Smith: Ping @Owner, the deploy failed",
      ])
      expect(general.messages[0]).toMatchObject({ replyCount: 2, permalink: "https://acme.slack.com/archives/C_GENERAL/p1729340000000100" })

      const thread = await run(connector.read({ conversation: "https://acme.slack.com/archives/C_GENERAL/p1729340000000100", limit: 30 }))
      expect(thread.messages.map((m) => m.text)).toEqual(["Can someone look at the deploy?", "On it"])

      const alice = await run(connector.read({ conversation: "@alice", limit: 10 }))
      expect(alice.conversation).toEqual({ id: "D_ALICE", kind: "dm", label: "Alice Smith" })

      const found = await run(connector.search({ query: "deploy", limit: 20 }))
      expect(found.total).toBe(3)
      expect(found.messages[0]).toMatchObject({ where: "#general", author: "Alice Smith", text: "deploy is broken", threadTs: "1729340000.000100" })

      const people = await run(connector.find("ali"))
      expect(people.people).toEqual([{ id: "U_ALICE", name: "Alice Smith", handle: "alice", title: "Designer" }])
      const places = await run(connector.find("gen"))
      expect(places.conversations.map((c) => c.label)).toEqual(["#general"])

      const ambiguous = await Effect.runPromiseExit(connector.resolve({ to: "o" }))
      expect(JSON.stringify(ambiguous)).toContain("matches several people")
      const target = await run(connector.resolve({ to: "#general", thread: "1729340000.000100" }))
      expect(target.thread).toMatchObject({ author: "Alice Smith", text: "Can someone look at the deploy?" })

      const sent = await run(connector.send({ channelId: "C_GENERAL", text: "Fixed, thanks @Alice Smith & @Bob", threadTs: "1729340000.000100" }))
      expect(slack.posted.at(-1)).toEqual({ channel: "C_GENERAL", text: "Fixed, thanks <@U_ALICE> &amp; <@U_BOB>", thread_ts: "1729340000.000100" })
      expect(sent.permalink).toBe("https://acme.slack.com/archives/C_GENERAL/p1729340400000100?thread_ts=1729340000.000100&cid=C_GENERAL")

      // files: their bytes go to the URL Slack hands out, then one message carries them with the text as its comment
      const clip = join(dir, "clip.mp4")
      const notes = join(dir, "notes.txt")
      writeFileSync(clip, new Uint8Array(70_000))
      writeFileSync(notes, "hello")
      const withFiles = await run(connector.send({
        channelId: "C_GENERAL",
        text: "The render, @Bob",
        files: [{ name: "clip.mp4", path: clip, byteSize: 70_000 }, { name: "notes.txt", path: notes, byteSize: 5 }],
      }))
      expect(slack.uploads).toEqual([
        { fileId: "F_1", filename: "clip.mp4", length: 70_000, bytes: 70_000, authorized: true },
        { fileId: "F_2", filename: "notes.txt", length: 5, bytes: 5, authorized: true },
      ])
      expect(slack.shared).toEqual([{
        files: JSON.stringify([{ id: "F_1", title: "clip.mp4" }, { id: "F_2", title: "notes.txt" }]),
        channel_id: "C_GENERAL",
        initial_comment: "The render, <@U_BOB>",
      }])
      expect(withFiles).toEqual({ permalink: "https://acme.slack.com/archives/C_GENERAL" })
      // no text: just the file, in a thread
      await run(connector.send({ channelId: "C_GENERAL", text: "", threadTs: "1729340000.000100", files: [{ name: "notes.txt", path: notes, byteSize: 5 }] }))
      expect(slack.shared.at(-1)).toEqual({ files: JSON.stringify([{ id: "F_3", title: "notes.txt" }]), channel_id: "C_GENERAL", thread_ts: "1729340000.000100" })
      expect(slack.posted).toHaveLength(1)

      // live messages: others' messages arrive (acknowledged), the owner's own and edits do not
      const heard = await Effect.runPromise(Effect.forkDetach(connector.events.pipe(Stream.take(2), Stream.runCollect)))
      await Bun.sleep(20)
      const mine = messageEnvelope({ channel: "C_GENERAL", user: "U_OWNER", text: "my own" })
      const edit = messageEnvelope({ channel: "C_GENERAL", subtype: "message_changed" })
      const dm = messageEnvelope({ channel: "D_ALICE", channel_type: "im", user: "U_ALICE", text: "got a minute?" })
      const ping = messageEnvelope({ channel: "C_GENERAL", user: "U_BOB", text: "<@U_OWNER> review please" })
      for (const envelope of [mine, edit, dm, dm, ping]) slack.push(envelope)
      const events = [...(await Effect.runPromise(Fiber.join(heard)))] as Array<SlackEvent>
      expect(events.map((e) => [e.conversation.label, e.message.author, e.message.text, e.mentionsOwner])).toEqual([
        ["Alice Smith", "Alice Smith", "got a minute?", false],
        ["#general", "Bob", "@Owner review please", true],
      ])
      for (let i = 0; i < 100 && slack.acks.length < 5; i++) await Bun.sleep(10)
      expect(slack.acks).toEqual(expect.arrayContaining([mine.envelope_id, edit.envelope_id, dm.envelope_id, ping.envelope_id]))

      // Slack asks to reconnect: a new socket, still live
      slack.push({ type: "disconnect", reason: "refresh_requested" })
      await Bun.sleep(300)
      expect((await run(connector.status)).events).toBe("live")

      await run(connector.disconnect)
      expect(existsSync(file)).toBe(false)
      expect(await run(connector.status)).toEqual({ connected: false, events: "off" })
      const after = await Effect.runPromiseExit(connector.read({ conversation: "#general", limit: 5 }))
      expect(JSON.stringify(after)).toContain("isn't connected")
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  }, 30_000)

  test("an app from the older manifest connects without files:write; updating it in Slack shows without reconnecting", async () => {
    const older = startFakeSlack({ scopes: SCOPES_WITHOUT_FILES })
    const scope = Effect.runSync(Scope.make())
    const file = join(dir, "older.json")
    try {
      const connector = await Effect.runPromise(Scope.provide(makeSlackConnector({ file, apiUrl: older.url }), scope))
      expect(await Effect.runPromise(connector.connect({ userToken: FAKE_USER_TOKEN }))).toMatchObject({ connected: true, missingScopes: ["files:write"] })
      const tmp = join(dir, "older-upload")
      mkdirSync(tmp, { recursive: true })
      writeFileSync(join(tmp, "a.txt"), "a")
      const refused = await Effect.runPromiseExit(connector.send({ channelId: "C_GENERAL", text: "", files: [{ name: "a.txt", path: join(tmp, "a.txt"), byteSize: 1 }] }))
      expect(JSON.stringify(refused)).toContain('lacks the \\"files:write\\" permission')
      // the owner adds the scope and reinstalls: the next call carries it
      older.setScopes(ALL_SCOPES)
      await Effect.runPromise(connector.find("gen"))
      expect((await Effect.runPromise(connector.status)).missingScopes).toBeUndefined()
      // a brain started with the older token finds out at boot
      older.setScopes(SCOPES_WITHOUT_FILES)
      const scope2 = Effect.runSync(Scope.make())
      const booted = await Effect.runPromise(Scope.provide(makeSlackConnector({ file, apiUrl: older.url }), scope2))
      for (let i = 0; i < 100 && (await Effect.runPromise(booted.status)).missingScopes === undefined; i++) await Bun.sleep(10)
      expect((await Effect.runPromise(booted.status)).missingScopes).toEqual(["files:write"])
      await Effect.runPromise(Scope.close(scope2, Exit.void))
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      older.stop()
    }
  })

  test("a token without every scope is refused with what is missing", async () => {
    const partial = startFakeSlack({ scopes: "channels:history,users:read" })
    const scope = Effect.runSync(Scope.make())
    try {
      const connector = await Effect.runPromise(Scope.provide(makeSlackConnector({ file: join(dir, "partial.json"), apiUrl: partial.url }), scope))
      const exit = await Effect.runPromiseExit(connector.connect({ userToken: FAKE_USER_TOKEN }))
      expect(JSON.stringify(exit)).toContain("missing these permissions")
      expect(JSON.stringify(exit)).toContain("search:read")
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      partial.stop()
    }
  })
})

describe("Slack in the brain", () => {
  let slack: FakeSlack
  let server: TestServer
  let cookie: string
  beforeAll(async () => {
    slack = startFakeSlack()
    server = await startServer({ config: { slackApiUrl: slack.url } })
    cookie = await login(server.base, server.ownerToken)
  }, 30_000)
  afterAll(async () => {
    await server?.close()
    slack?.stop()
  }, 30_000)

  test("connect in Settings; a Bot drafts; the owner edits and sends it as themselves", () =>
    server.run(Effect.gen(function*() {
      const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })
      expect(yield* client["slack.status"]()).toEqual({ connected: false, events: "off" })
      const status = yield* client["slack.connect"]({ userToken: FAKE_USER_TOKEN })
      expect(status).toMatchObject({ connected: true, team: "Acme", userName: "Owner", events: "off" })

      const bot = yield* client["bots.create"]({ name: "Courier", harness: { kind: "fake" }, clientNonce: "slack-courier" })
      const context = yield* client["bots.readContext"]({ botId: bot.id })
      expect(context.instructions).toContain("## Slack")

      const convo = yield* watchConversation(client, bot.directConversationId)
      yield* eventually(Ref.get(convo.state), (s) => s.synchronized, { label: "synchronized" })
      yield* client["messages.send"]({
        conversationId: bot.directConversationId,
        text: `tool: slack_draft {"to":"#general","text":"The deploy is fixed.","thread":"1729340000.000100"}`,
        clientNonce: "slack-draft-1",
      })
      const drafted = yield* eventually(
        Ref.get(convo.state),
        (s) => transcriptOf(s).some((e) => e.kind === "card" && e.card.type === "slack-draft"),
        { label: "draft card", timeout: 20_000 },
      )
      const card = transcriptOf(drafted).find((e): e is Extract<TranscriptEntry, { kind: "card" }> => e.kind === "card" && e.card.type === "slack-draft")!
      expect(card.card).toMatchObject({ type: "slack-draft", team: "Acme", to: "#general", channelId: "C_GENERAL", threadLabel: "Alice Smith: Can someone look at the deploy?" })
      expect(card.state.status).toBe("pending")
      expect(slack.posted).toHaveLength(0)

      yield* client["slack.sendDraft"]({ entryId: card.id, text: "The deploy is fixed, @Alice Smith." })
      expect(slack.posted).toEqual([{ channel: "C_GENERAL", text: "The deploy is fixed, <@U_ALICE>.", thread_ts: "1729340000.000100" }])
      const sent = yield* eventually(
        Ref.get(convo.state),
        (s) => transcriptOf(s).some((e) => e.id === card.id && e.kind === "card" && e.state.status === "resolved"),
        { label: "sent card" },
      )
      expect(transcriptOf(sent).find((e) => e.id === card.id)).toMatchObject({
        card: { text: "The deploy is fixed, @Alice Smith." },
        state: { status: "resolved", detail: "Sent", link: expect.stringContaining("/archives/C_GENERAL/p1729340400000100") },
      })
      const again = yield* Effect.flip(client["slack.sendDraft"]({ entryId: card.id, text: "again" }))
      expect(again._tag).toBe("Conflict")

      yield* client["slack.disconnect"]()
      expect(yield* client["slack.status"]()).toEqual({ connected: false, events: "off" })
    })), 60_000)

  test("a draft with a file the Bot made: the card holds it, and it goes to Slack with the message", () =>
    server.run(Effect.gen(function*() {
      const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })
      yield* client["slack.connect"]({ userToken: FAKE_USER_TOKEN })
      const bot = yield* client["bots.create"]({ name: "Cutter", harness: { kind: "fake" }, clientNonce: "slack-cutter", introduce: false })
      const workspace = join(server.dataDir, "bots", bot.id, "workspace")
      mkdirSync(join(workspace, "output"), { recursive: true })
      const video = new Uint8Array(200_000)
      video.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
      writeFileSync(join(workspace, "output", "launch.mp4"), video)

      const convo = yield* watchConversation(client, bot.directConversationId)
      yield* eventually(Ref.get(convo.state), (s) => s.synchronized, { label: "synchronized" })
      yield* client["messages.send"]({
        conversationId: bot.directConversationId,
        text: `tool: slack_draft {"to":"#general","text":"","files":["output/launch.mp4"]}`,
        clientNonce: "slack-draft-file",
      })
      const drafted = yield* eventually(
        Ref.get(convo.state),
        (s) => transcriptOf(s).some((e) => e.kind === "card" && e.card.type === "slack-draft"),
        { label: "draft card", timeout: 20_000 },
      )
      const card = transcriptOf(drafted).find((e): e is Extract<TranscriptEntry, { kind: "card" }> => e.kind === "card" && e.card.type === "slack-draft")!
      expect(card.card).toMatchObject({ type: "slack-draft", to: "#general", text: "", files: [{ name: "launch.mp4", mime: "video/mp4", byteSize: 200_000 }] })

      yield* client["slack.sendDraft"]({ entryId: card.id, text: "Launch video" })
      expect(slack.uploads.at(-1)).toMatchObject({ filename: "launch.mp4", length: 200_000, bytes: 200_000 })
      expect(slack.shared.at(-1)).toMatchObject({ channel_id: "C_GENERAL", initial_comment: "Launch video" })
      yield* eventually(
        Ref.get(convo.state),
        (s) => transcriptOf(s).some((e) => e.id === card.id && e.kind === "card" && e.state.status === "resolved" && e.state.link === "https://acme.slack.com/archives/C_GENERAL"),
        { label: "sent card" },
      )
      yield* client["slack.disconnect"]()
    })), 60_000)

  test("Send to OpenBot: the owner's click puts the message in the chosen Bot's chat; anyone else's is refused", () =>
    server.run(Effect.gen(function*() {
      const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })
      yield* client["slack.connect"]({ userToken: FAKE_USER_TOKEN, appToken: FAKE_APP_TOKEN })
      yield* eventually(client["slack.status"](), (s) => s.events === "live", { label: "live messages" })
      expect(yield* client["slack.status"]()).toMatchObject({ appId: "A_OPENBOT" })
      const bot = yield* client["bots.create"]({ name: "Inbox", harness: { kind: "fake" }, clientNonce: "slack-inbox", introduce: false })
      yield* client["settings.update"]({ patch: { slackSendTo: bot.id } })
      const convo = yield* watchConversation(client, bot.directConversationId)
      yield* eventually(Ref.get(convo.state), (s) => s.synchronized, { label: "synchronized" })

      const thread = { ts: "1729340300.000100", thread_ts: "1729340000.000100", user: "U_BOB", text: "Rollback done, <@U_ALICE> can you confirm?" }
      slack.push(shortcutEnvelope({ by: "U_ALICE", channel: "C_GENERAL", message: thread, responseUrl: slack.responseUrl }))
      slack.push(shortcutEnvelope({ by: "U_OWNER", channel: "C_GENERAL", message: thread, responseUrl: slack.responseUrl }))
      const got = yield* eventually(
        Ref.get(convo.state),
        (s) => transcriptOf(s).some((e) => e.kind === "message" && e.role === "user"),
        { label: "the forwarded message", timeout: 20_000 },
      )
      const forwarded = transcriptOf(got).filter((e) => e.kind === "message" && e.role === "user")
      expect(forwarded).toHaveLength(1)
      expect(forwarded[0]).toMatchObject({
        text: "From Slack, #general (Bob):\n> Rollback done, @Alice Smith can you confirm?\nhttps://acme.slack.com/archives/C_GENERAL/p1729340300000100?thread_ts=1729340000.000100&cid=C_GENERAL",
      })
      yield* eventually(Effect.sync(() => slack.responses.length), (n) => n === 2, { label: "both replies" })
      expect(slack.responses).toEqual(expect.arrayContaining([
        { response_type: "ephemeral", text: "Send to OpenBot belongs to Owner's OpenBot." },
        { response_type: "ephemeral", text: "Sent to Inbox in OpenBot." },
      ]))
      yield* client["slack.disconnect"]()
    })), 60_000)
})

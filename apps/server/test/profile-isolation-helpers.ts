import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { LOCAL_NODE_ID, MAIN_PROFILE_ID, type Bot, type OwnerProfileId, SkillName } from "@openbot/contracts"
import { DataDir, inProfile, McpBindingIssuer, SearchRepo, sessionKeyOf, TaskRepo } from "@openbot/core"
import { makeTask, taskId } from "@openbot/core/testing"
import { Effect, Stream } from "effect"
import { eventually, login, type OpenBotClient, rpcClient, startServer, type TestServer } from "./helpers.ts"

export const connectOwner = (server: TestServer, cookie: string) =>
  rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })

const seedProfile = (client: OpenBotClient, profileId: OwnerProfileId, marker: string) =>
  Effect.gen(function* () {
    yield* client["profiles.switch"]({ profileId })
    const bot = yield* client["bots.create"]({
      name: marker,
      harness: { kind: "fake" },
      clientNonce: marker,
      introduce: false,
    })
    const section = yield* client["sections.create"]({ name: `${marker} section` })
    const skill = yield* client["skills.upsert"]({
      name: SkillName.make(marker.toLowerCase()),
      description: `${marker} skill`,
      body: `${marker} instructions`,
    })
    yield* client["skills.assign"]({ name: skill.name, botIds: [bot.id] })
    const fact = yield* client["memory.putFact"]({
      botId: bot.id,
      fact: { title: `${marker} fact`, body: `${marker} private memory` },
    })
    const routine = yield* client["routines.create"]({
      botId: bot.id,
      spec: {
        name: `${marker} routine`,
        prompt: `echo: ${marker} routine result`,
        trigger: { type: "manual" },
        enabled: true,
        output: "direct",
      },
    })
    const rule = yield* client["rules.upsert"]({
      rule: { surface: "shell", match: { commandPrefix: marker }, action: "deny", note: `${marker} rule` },
    })
    const attachment = yield* client["attachments.upload"]({
      name: `${marker}.txt`,
      mime: "text/plain",
      bytesBase64: Buffer.from(`${marker} private attachment`).toString("base64"),
    })
    yield* client["settings.update"]({ patch: { ownerName: `${marker} owner` } })
    yield* client["messages.send"]({
      conversationId: bot.directConversationId,
      text: `echo: ${marker} private transcript`,
      clientNonce: `${marker}-message`,
    })
    const snapshot = yield* eventually(
      client["conversations.around"]({ conversationId: bot.directConversationId, limit: 20 }),
      (page) =>
        page.entries.some((entry) => entry.kind === "message" && entry.author.kind === "bot" && !entry.streaming),
    )
    const ownerMessage = snapshot.entries.find((entry) => entry.kind === "message" && entry.author.kind === "user")!
    const task = makeTask({
      id: taskId(`tsk_${marker.toLowerCase()}`),
      botId: bot.id,
      conversationId: bot.directConversationId,
      title: `${marker} task`,
      status: "succeeded",
      result: `${marker} task result`,
    })
    yield* (yield* TaskRepo).upsert(task).pipe(inProfile(profileId))
    return { profileId, marker, bot, section, skill, fact, routine, rule, attachment, entry: ownerMessage, task }
  })

export type ProfileFixture = Effect.Success<ReturnType<typeof seedProfile>>

export const startProfiles = async (options?: Parameters<typeof startServer>[0]) => {
  const server = await startServer(options)
  try {
    const cookie = await login(server.base, server.ownerToken)
    const profiles = await server.run(
      Effect.gen(function* () {
        const client = yield* connectOwner(server, cookie)
        const a = yield* seedProfile(client, MAIN_PROFILE_ID, "Cobalt")
        const demo = yield* client["profiles.create"]({ name: "Demo" })
        const b = yield* seedProfile(client, demo.id, "Saffron")
        yield* eventually(
          Effect.flatMap(SearchRepo, (repo) => repo.indexing),
          (indexing) => !indexing,
        )
        return [a, b] as const
      }),
    )
    return { server, cookie, profiles }
  } catch (error) {
    await server.close()
    throw error
  }
}

export const connectBot = (bot: Bot) =>
  Effect.gen(function* () {
    const dataDir = yield* DataDir
    const binding = yield* (yield* McpBindingIssuer)
      .issue({
        botId: bot.id,
        conversationId: bot.directConversationId,
        sessionKey: sessionKeyOf(bot.id, bot.directConversationId),
        toolsets: ["bot"],
        hostNodeId: LOCAL_NODE_ID,
        workspacePath: dataDir.workspaceDir(bot.id),
        boundNodeIds: [],
      })
      .pipe(inProfile(bot.ownerProfileId))
    const client = new Client({ name: "profile-isolation-test", version: "1.0.0" })
    yield* Effect.acquireRelease(
      Effect.promise(() =>
        client.connect(
          new StreamableHTTPClientTransport(new URL(binding.url), { requestInit: { headers: binding.headers } }),
        ),
      ),
      () => Effect.promise(() => client.close()),
    )
    return client
  })

export const callTool = (client: Client, name: string, args: Record<string, unknown> = {}) =>
  Effect.promise(async () => {
    const result = await client.callTool({ name, arguments: args })
    const content = result.content as Array<{ type: string; text?: string }>
    return {
      isError: result.isError === true,
      text: content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n"),
    }
  })

export const rosterSnapshot = (client: OpenBotClient) =>
  client["roster.subscribe"]({}).pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map((items) => items[0]!),
  )

/**
 * Test harness: the real gateway + real `McpBindingIssuerLive` over core's in-memory ports and
 * service fakes, served by `Bun.serve` on an ephemeral port, driven by the MCP SDK `Client`.
 */
import type {
  Bot,
  BotId,
  ConversationId,
  EntryId,
  HarnessRequestResolution,
  NodeSummary,
  Settings,
} from "@openbot/contracts"
import {
  BotRepo,
  BotService,
  InternalAddress,
  type McpBinding,
  McpBindingIssuer,
  type McpClaims,
  Messaging,
  type NodeClient,
  NodeDirectory,
  RoutineScheduler,
  MessagingLive,
  SearchServiceLive,
  SkillService,
  UiCardService,
} from "@openbot/core"
import {
  ApprovalServiceFake,
  BackgroundTasksFake,
  ConversationServiceFake,
  LiveHubFake,
  localNodeSummary,
  makeBot,
  makeClaims,
  MemoryServiceFake,
  NodeDirectoryFake,
  NotifierFake,
  OrchestratorFake,
  remoteNodeSummary,
  SettingsServiceFake,
  TestPorts,
} from "@openbot/core/testing"
import { MAIN_PROFILE_ID, type NodeId, type Section, type SectionId } from "@openbot/contracts"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect"
import { McpBindingIssuerLive } from "../src/McpBindingIssuer.ts"
import { McpGateway, McpGatewayLayer, type GatewayToolServices } from "../src/McpGateway.ts"
import type { AnyTool } from "../src/tool.ts"

export const BOT_A = "bot_alpha" as BotId
export const BOT_B = "bot_beta" as BotId
export const REMOTE = "nod_remote" as NodeId

export const botA: Bot = makeBot({ id: BOT_A, name: "Alpha" })
export const botB: Bot = makeBot({ id: BOT_B, name: "Beta" })

export interface MessagingCall {
  readonly method: string
  readonly claims: McpClaims
  readonly callId: string | undefined
  readonly input: unknown
}

export interface Harness {
  readonly baseUrl: string
  readonly runtime: ManagedRuntime.ManagedRuntime<any, never>
  readonly run: <A, E>(effect: Effect.Effect<A, E, any>) => Promise<A>
  readonly messagingCalls: Array<MessagingCall>
  /** Mints a token (real issuer); `revoke` closes its scope. */
  readonly issue: (
    claims: Partial<McpClaims>,
  ) => Promise<{ readonly binding: McpBinding; readonly revoke: () => Promise<void> }>
  readonly connect: (binding: McpBinding) => Promise<Client>
  readonly close: () => Promise<void>
}

export interface HarnessOptions {
  readonly nodes?: ReadonlyArray<NodeSummary>
  /**
   * Use the real `MessagingLive` (over ConversationServiceFake, SettingsServiceFake and the
   * in-memory NodeFiles / AttachmentStore) instead of the recording mock.
   */
  readonly realMessaging?: boolean
  readonly toolApproval?: HarnessRequestResolution
  readonly tools?: ReadonlyArray<AnyTool<GatewayToolServices>>
  readonly progressIntervalMs?: number
  /** Settings (SettingsServiceFake) when messaging is mocked. */
  readonly settings?: Partial<Settings>
}

export const startHarness = async (options?: HarnessOptions): Promise<Harness> => {
  let gatewayHandle: ((request: Request) => Promise<Response>) | undefined
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: (request) =>
      gatewayHandle === undefined ? new Response("starting", { status: 503 }) : gatewayHandle(request),
  })
  const baseUrl = `http://127.0.0.1:${server.port}`

  const messagingCalls: Array<MessagingCall> = []
  const record = (method: string, ctx: { claims: McpClaims; callId?: string | undefined }, input: unknown) =>
    messagingCalls.push({ method, claims: ctx.claims, callId: ctx.callId, input })

  const bots = [botA, botB]
  const sections: Array<Section> = []
  const findBot = (ref: string) =>
    bots.find((b) => b.id === ref || b.name.toLowerCase() === ref.replace(/^@/, "").toLowerCase())

  const MessagingTest = Layer.mock(Messaging, {
    react: (ctx, input) =>
      Effect.sync(() => {
        record("react", ctx, input)
        return {
          conversationId: ctx.claims.conversationId,
          entryId: (input.messageId ?? "ent_trigger") as EntryId,
          emoji: input.emoji,
        }
      }),
    messageBot: (ctx, input) =>
      Effect.sync(() => {
        record("messageBot", ctx, input)
        const to = findBot(input.to) ?? botB
        return {
          recipientBotId: to.id,
          conversationId: to.directConversationId,
          entryId: "ent_1" as EntryId,
          deliveryId: `dlv_${messagingCalls.length}`,
        }
      }),
    postToGroup: (ctx, input) =>
      Effect.sync(() => {
        record("postToGroup", ctx, input)
        return { conversationId: (input.conversationId ?? "cnv_group") as ConversationId, entryId: "ent_2" as EntryId }
      }),
    handoffTask: (ctx, input) =>
      Effect.sync(() => {
        record("handoffTask", ctx, input)
        return {
          recipientBotId: BOT_B,
          conversationId: botB.directConversationId,
          entryId: "ent_3" as EntryId,
          deliveryId: "dlv_h",
        }
      }),
  })
  const BotServiceTest = Layer.mock(BotService, {
    list: Effect.succeed(bots),
    get: (id) => {
      const bot = bots.find((b) => b.id === id)
      return bot === undefined ? Effect.die(new Error(`no bot ${id}`)) : Effect.succeed(bot)
    },
    resolve: (ref) => {
      const bot = findBot(ref)
      return bot === undefined ? Effect.die(new Error(`no bot ${ref}`)) : Effect.succeed(bot)
    },
    listSections: Effect.sync(() => [...sections]),
    createSection: (name) =>
      Effect.sync(() => {
        const section: Section = {
          id: `sec_${sections.length + 1}` as SectionId,
          ownerProfileId: MAIN_PROFILE_ID,
          name,
          order: sections.length,
        }
        sections.push(section)
        record("createSection", { claims: undefined as never }, { name })
        return section
      }),
    renameSection: (id, name) =>
      Effect.sync(() => {
        const i = sections.findIndex((x) => x.id === id)
        sections[i] = { ...sections[i]!, name }
        record("renameSection", { claims: undefined as never }, { id, name })
        return sections[i]!
      }),
    deleteSection: (id) =>
      Effect.sync(() => {
        sections.splice(
          sections.findIndex((x) => x.id === id),
          1,
        )
        record("deleteSection", { claims: undefined as never }, { id })
      }),
    create: (input, options) =>
      Effect.sync(() => {
        record("createBot", { claims: undefined as never }, { ...input, ...options })
        return { ...botB, id: "bot_new" as typeof botB.id, name: input.name, harness: input.harness }
      }),
    update: (id, patch) =>
      Effect.sync(() => {
        record("updateBot", { claims: undefined as never }, { id, patch })
        const bot = bots.find((b) => b.id === id) ?? botB
        return { ...bot, ...(patch.name === undefined ? {} : { name: patch.name }) }
      }),
  })
  const UiCardServiceTest = Layer.mock(UiCardService, {
    show: (ctx, card) =>
      Effect.sync(() => {
        record("showUi", ctx, card)
        return { entryId: "ent_ui" as EntryId }
      }),
    update: (ctx, entryId, card) => Effect.sync(() => void record("updateUi", ctx, { entryId, card })),
  })
  const RoutineSchedulerTest = Layer.mock(RoutineScheduler, { list: () => Effect.succeed([]) })
  const SkillServiceTest = Layer.mock(SkillService, { list: Effect.succeed([]) })

  const ports = Layer.mergeAll(
    TestPorts({ nodes: options?.nodes ?? [localNodeSummary(), remoteNodeSummary(REMOTE)] }),
    InternalAddress.layer(baseUrl),
  )
  const orchestrator = OrchestratorFake.layer(
    options?.toolApproval === undefined ? undefined : { toolApproval: options.toolApproval },
  )
  const messaging =
    options?.realMessaging === true
      ? MessagingLive.pipe(
          Layer.provideMerge(Layer.mergeAll(orchestrator, ConversationServiceFake.layer, SettingsServiceFake.layer())),
          Layer.provideMerge(LiveHubFake.layer),
        )
      : Layer.merge(MessagingTest, orchestrator)
  // the real SearchService over the in-memory repositories (the search tools' access rules live there)
  const settings =
    options?.realMessaging === true ? Layer.empty : SettingsServiceFake.layer({ initial: options?.settings ?? {} })
  const services = Layer.mergeAll(
    ApprovalServiceFake.layer(),
    BackgroundTasksFake.layer(),
    MemoryServiceFake.layer,
    messaging,
    BotServiceTest,
    RoutineSchedulerTest,
    SkillServiceTest,
    UiCardServiceTest,
    SearchServiceLive,
    settings,
  ).pipe(Layer.provideMerge(ports))
  const issuer = McpBindingIssuerLive.pipe(Layer.provide(ports))
  const gateway = McpGatewayLayer({
    progressIntervalMs: options?.progressIntervalMs ?? 50,
    progressMinGapMs: 0,
    ...(options?.tools === undefined ? {} : { tools: options.tools }),
  }).pipe(Layer.provideMerge(services))
  const layer = Layer.mergeAll(gateway, issuer)
  const runtime = ManagedRuntime.make(layer)
  const run = <A, E>(effect: Effect.Effect<A, E, any>) => runtime.runPromise(effect as Effect.Effect<A, E, never>)

  const gw = await run(McpGateway)
  gatewayHandle = gw.handle
  // the bots exist in the repositories too (search reads them there)
  await run(Effect.flatMap(BotRepo, (repo) => Effect.forEach(bots, (bot) => repo.upsert(bot), { discard: true })))

  const clients: Array<Client> = []
  const scopes: Array<Scope.Closeable> = []

  return {
    baseUrl,
    runtime: runtime as ManagedRuntime.ManagedRuntime<any, never>,
    run,
    messagingCalls,
    issue: async (claims) => {
      const scope = await run(Scope.make())
      scopes.push(scope)
      const binding = await run(
        Effect.flatMap(McpBindingIssuer, (service) => service.issue(makeClaims({ botId: BOT_A, ...claims }))).pipe(
          Scope.provide(scope),
        ),
      )
      return { binding, revoke: () => run(Scope.close(scope, Exit.void)) }
    },
    connect: async (binding) => {
      const client = new Client({ name: "gateway-test", version: "1.0.0" })
      const transport = new StreamableHTTPClientTransport(new URL(binding.url), {
        requestInit: { headers: { ...binding.headers } },
      })
      await client.connect(transport)
      clients.push(client)
      return client
    },
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()))
      await Promise.allSettled(scopes.map((s) => run(Scope.close(s, Exit.void))))
      await runtime.dispose()
      server.stop(true)
    },
  }
}

/** Installs a fake node RPC client for `nodeId`. */
export const setNodeClient = (h: Harness, nodeId: NodeId, client: Partial<Record<string, unknown>>) =>
  h.run(Effect.flatMap(NodeDirectoryFake, (fake) => fake.setClient(nodeId, client as unknown as NodeClient)))

export const upsertNode = (h: Harness, node: NodeSummary) =>
  h.run(Effect.flatMap(NodeDirectoryFake, (fake) => fake.upsert(node)))

export const orchestratorCalls = (h: Harness) => h.run(Effect.flatMap(OrchestratorFake, (fake) => fake.calls))
export const toolRequests = (h: Harness) => h.run(Effect.flatMap(ApprovalServiceFake, (fake) => fake.toolRequests))
export const notifications = (h: Harness) => h.run(Effect.flatMap(NotifierFake, (fake) => fake.sent))
export const directory = (h: Harness) => h.run(NodeDirectory)

/** The text of every text block of a tool result. */
export const textOf = (result: unknown): string =>
  ((result as { content?: Array<{ type: string; text?: string }> }).content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n")

/**
 * Plain builders for contract entities with sensible defaults (tests only). Every builder takes
 * overrides; ids are plain strings cast to their brands.
 */
import type {
  OwnerProfileId,
  ApprovalRule,
  Bot,
  BotId,
  Conversation,
  ConversationId,
  EntryId,
  NodeId,
  RequestId,
  Routine,
  RoutineId,
  RoutineRun,
  RoutineRunId,
  RuntimeRequest,
  Section,
  SectionId,
  Task,
  TaskId,
  TranscriptEntryOf,
  Turn,
  TurnId,
} from "@openbot/contracts"
import { LOCAL_NODE_ID, MAIN_PROFILE_ID, OWNER_USER_ID } from "@openbot/contracts"
import { sessionKeyOf } from "../ports/Harness.ts"
import type { McpClaims } from "../ports/Mcp.ts"

type Mutable<A> = { -readonly [K in keyof A]: A[K] }

export const botId = (id: string) => id as BotId
export const conversationId = (id: string) => id as ConversationId
export const entryId = (id: string) => id as EntryId
export const turnId = (id: string) => id as TurnId
export const requestId = (id: string) => id as RequestId
export const routineId = (id: string) => id as RoutineId
export const routineRunId = (id: string) => id as RoutineRunId
export const nodeId = (id: string) => id as NodeId
export const sectionId = (id: string) => id as SectionId
export const taskId = (id: string) => id as TaskId

/** A profile next to the main one (isolation tests). */
export const OTHER_PROFILE = "prf_other" as OwnerProfileId

export const makeBot = (overrides?: Partial<Mutable<Bot>>): Bot => {
  const id = overrides?.id ?? botId("bot_test")
  return {
    id,
    ownerProfileId: MAIN_PROFILE_ID,
    name: "Scout",
    avatar: { shape: "blob", color: "blue" },
    harness: { kind: "fake" },
    hostNodeId: LOCAL_NODE_ID,
    boundNodeIds: [],
    instructions: "",
    directConversationId: conversationId(`cnv_${id}`),
    pinned: false,
    hidden: false,
    notify: "all",
    // Test bots ask for everything unless a test opts into autonomy (new bots default to "workspace").
    autonomy: "ask",
    projectFolders: [],
    skills: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

export const makeDirectConversation = (
  overrides?: Partial<Mutable<Extract<Conversation, { kind: "direct" }>>>,
): Extract<Conversation, { kind: "direct" }> => ({
  id: conversationId("cnv_test"),
  kind: "direct",
  botId: botId("bot_test"),
  title: "Scout",
  createdAt: 0,
  lastActivityAt: 0,
  unreadCount: 0,
  hiddenFromSidebar: false,
  epoch: "epc_1",
  ...overrides,
})

export const makeGroupConversation = (
  overrides?: Partial<Mutable<Extract<Conversation, { kind: "group" }>>>,
): Extract<Conversation, { kind: "group" }> => ({
  id: conversationId("cnv_group"),
  kind: "group",
  memberBotIds: [botId("bot_a"), botId("bot_b")],
  namedBy: "user",
  title: "Team",
  createdAt: 0,
  lastActivityAt: 0,
  unreadCount: 0,
  hiddenFromSidebar: false,
  epoch: "epc_1",
  ...overrides,
})

export const makeMessageEntry = (
  overrides?: Partial<Mutable<TranscriptEntryOf<"message">>>,
): TranscriptEntryOf<"message"> => ({
  id: entryId("ent_test"),
  conversationId: conversationId("cnv_test"),
  revision: 0,
  createdAt: 0,
  updatedAt: 0,
  author: { kind: "user", userId: OWNER_USER_ID },
  kind: "message",
  role: "user",
  text: "hello",
  attachments: [],
  streaming: false,
  ...overrides,
})

export const makeEventEntry = (
  overrides?: Partial<Mutable<TranscriptEntryOf<"event">>>,
): TranscriptEntryOf<"event"> => ({
  id: entryId("ent_event"),
  conversationId: conversationId("cnv_test"),
  revision: 0,
  createdAt: 0,
  updatedAt: 0,
  author: { kind: "system" },
  kind: "event",
  event: { type: "name-changed", to: "Renamed" },
  ...overrides,
})

export const makeToolCallEntry = (
  overrides?: Partial<Mutable<TranscriptEntryOf<"tool-call">>>,
): TranscriptEntryOf<"tool-call"> => ({
  id: entryId("ent_tool"),
  conversationId: conversationId("cnv_test"),
  revision: 0,
  createdAt: 0,
  updatedAt: 0,
  author: { kind: "bot", botId: botId("bot_test") },
  kind: "tool-call",
  toolCallId: "call_1",
  name: "Bash",
  toolKind: "shell",
  status: "running",
  input: { command: "ls" },
  startedAt: 0,
  ...overrides,
})

/** An approval card for `requestId` (pending). */
export const makeCardEntry = (overrides?: Partial<Mutable<TranscriptEntryOf<"card">>>): TranscriptEntryOf<"card"> => ({
  id: entryId("ent_card"),
  conversationId: conversationId("cnv_test"),
  revision: 0,
  createdAt: 0,
  updatedAt: 0,
  author: { kind: "bot", botId: botId("bot_test") },
  kind: "card",
  card: { type: "approval", requestId: requestId("req_test"), title: "Run a command", command: "ls" },
  state: { status: "pending" },
  ...overrides,
})

/** MCP token claims for a bot's direct conversation on the local node (toolsets: bot). */
export const makeClaims = (overrides?: Partial<Mutable<McpClaims>>): McpClaims => {
  const bot = overrides?.botId ?? botId("bot_test")
  const conversation = overrides?.conversationId ?? conversationId(`cnv_${bot}`)
  return {
    botId: bot,
    conversationId: conversation,
    sessionKey: sessionKeyOf(bot, conversation),
    toolsets: ["bot"],
    hostNodeId: LOCAL_NODE_ID,
    workspacePath: `/openbot-test/bots/${bot}/workspace`,
    boundNodeIds: [],
    ...overrides,
  }
}

export const makeTurn = (overrides?: Partial<Mutable<Turn>>): Turn => ({
  id: turnId("trn_test"),
  conversationId: conversationId("cnv_test"),
  botId: botId("bot_test"),
  status: "running",
  trigger: "user",
  startedAt: 0,
  ...overrides,
})

export const makeRequest = (overrides?: Partial<Mutable<RuntimeRequest>>): RuntimeRequest => ({
  id: requestId("req_test"),
  conversationId: conversationId("cnv_test"),
  botId: botId("bot_test"),
  cardEntryId: entryId("ent_card"),
  kind: "command-approval",
  status: "pending",
  title: "Run a command",
  subject: { command: "ls" },
  responseCapability: {
    type: "decision",
    options: [{ id: "allow-once" }, { id: "allow-always" }, { id: "deny" }],
    allowMessage: true,
  },
  source: { origin: "fake", method: "approve", nativeRequestId: "native-1" },
  blocking: true,
  createdAt: 0,
  ...overrides,
})

export const makeRoutine = (overrides?: Partial<Mutable<Routine>>): Routine => ({
  id: routineId("rtn_test"),
  botId: botId("bot_test"),
  name: "Daily brief",
  prompt: "Summarize the news",
  trigger: { type: "interval", everyMinutes: 60 },
  enabled: true,
  output: "direct",
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

export const makeRoutineRun = (overrides?: Partial<Mutable<RoutineRun>>): RoutineRun => ({
  id: routineRunId("run_test"),
  routineId: routineId("rtn_test"),
  firedBy: "schedule",
  startedAt: 0,
  status: "running",
  conversationId: conversationId("cnv_test"),
  ...overrides,
})

export const makeSection = (overrides?: Partial<Mutable<Section>>): Section => ({
  id: sectionId("sec_test"),
  ownerProfileId: MAIN_PROFILE_ID,
  name: "Research",
  order: 0,
  ...overrides,
})

export const makeRule = (overrides?: Partial<Mutable<ApprovalRule>>): ApprovalRule => ({
  id: "rul_test" as ApprovalRule["id"],
  ownerProfileId: MAIN_PROFILE_ID,
  surface: "shell",
  match: {},
  action: "ask",
  createdAt: 0,
  ...overrides,
})

export const makeTask = (overrides?: Partial<Mutable<Task>>): Task => ({
  id: taskId("tsk_test"),
  botId: botId("bot_test"),
  conversationId: conversationId("cnv_test"),
  title: "HN digest",
  brief: "Summarize the top Hacker News stories.",
  status: "queued",
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

// Pure projection reducers: resume decision, conversation reset/history, roster reducer.
import { describe, expect, test } from "bun:test"
import {
  MAIN_PROFILE_ID,
  activeTasksOf,
  applyConversationStreamItem,
  applyRosterStreamItem,
  type Bot,
  type BotId,
  type Conversation,
  type ConversationId,
  DEFAULT_SETTINGS,
  emptyConversationState,
  emptyRosterState,
  type EntryId,
  type KnownRosterStreamItem,
  type KnownTranscriptEntry,
  MAX_REPLAY_GAP,
  type NodeId,
  pendingRequestsOf,
  prependHistory,
  resumePlan,
  type RuntimeRequest,
  type SectionId,
  sectionsOf,
  type Task,
  type TaskId,
  transcriptOf,
} from "../src/index.ts"

const conversation: Conversation = {
  id: "cnv_1" as ConversationId,
  kind: "direct",
  botId: "bot_1" as BotId,
  title: "Scout",
  createdAt: 0,
  lastActivityAt: 0,
  unreadCount: 0,
  hiddenFromSidebar: false,
  epoch: "e1",
}
const msg = (id: string, createdAt: number, text: string, revision = 0): KnownTranscriptEntry => ({
  id: id as EntryId,
  conversationId: conversation.id,
  revision,
  createdAt,
  updatedAt: createdAt,
  author: { kind: "bot", botId: "bot_1" as BotId },
  kind: "message",
  role: "bot",
  text,
  attachments: [],
  streaming: false,
})

describe("resumePlan", () => {
  const head = { epoch: "e1", sequence: 1000 }
  test("replays only a small, fully buffered gap in the same epoch", () => {
    expect(resumePlan(undefined, head, 745)).toBe("snapshot")
    expect(resumePlan({ epoch: "e0", sequence: 999 }, head, 745)).toBe("snapshot")
    expect(resumePlan({ epoch: "e1", sequence: 1001 }, head, 745)).toBe("snapshot")
    expect(resumePlan({ epoch: "e1", sequence: 1000 }, head, 745)).toBe("replay")
    expect(resumePlan({ epoch: "e1", sequence: 1000 - MAX_REPLAY_GAP }, head, 745)).toBe("replay")
    expect(resumePlan({ epoch: "e1", sequence: 1000 - MAX_REPLAY_GAP - 1 }, head, 745)).toBe("snapshot")
    // buffer was trimmed (e.g. after a restart): missed changes are gone
    expect(resumePlan({ epoch: "e1", sequence: 900 }, head, 950)).toBe("snapshot")
    expect(resumePlan({ epoch: "e1", sequence: 949 }, head, 950)).toBe("replay")
    // empty buffer at head
    expect(resumePlan({ epoch: "e1", sequence: 1000 }, head, 1001)).toBe("replay")
  })
})

describe("conversation projection", () => {
  test("revision guard, removal, reset, history prepend, pending requests", () => {
    let s = applyConversationStreamItem(emptyConversationState, {
      kind: "snapshot",
      cursor: { epoch: "e1", sequence: 2 },
      conversation,
      entries: [msg("ent_3", 30, "three"), msg("ent_4", 40, "four")],
      requests: [],
      turns: [],
      hasMoreBefore: true,
      beforeCursor: "before:ent_3",
    })
    expect(s.synchronized).toBe(false)
    s = applyConversationStreamItem(s, { kind: "synchronized", cursor: { epoch: "e1", sequence: 2 } })
    expect(s.synchronized).toBe(true)

    // stale revision is ignored, newer wins
    s = applyConversationStreamItem(s, {
      kind: "change",
      cursor: { epoch: "e1", sequence: 3 },
      change: { type: "entry.upserted", entry: msg("ent_4", 40, "four v2", 2) },
    })
    s = applyConversationStreamItem(s, {
      kind: "change",
      cursor: { epoch: "e1", sequence: 4 },
      change: { type: "entry.upserted", entry: msg("ent_4", 40, "four v1", 1) },
    })
    expect(transcriptOf(s).map((e) => (e as any).text)).toEqual(["three", "four v2"])
    expect(s.cursor).toEqual({ epoch: "e1", sequence: 4 })

    // older history merges in order
    const before = s
    s = prependHistory(s, {
      entries: [msg("ent_1", 10, "one"), msg("ent_2", 20, "two")],
      hasMoreBefore: false,
      beforeCursor: null,
    })
    expect(transcriptOf(s).map((e) => (e as any).text)).toEqual(["one", "two", "three", "four v2"])
    expect(s.hasMoreBefore).toBe(false)
    expect(before.entries.size).toBe(2) // inputs are never mutated

    const request: RuntimeRequest = {
      id: "req_1" as any,
      conversationId: conversation.id,
      botId: "bot_1" as BotId,
      cardEntryId: "ent_5" as EntryId,
      kind: "question",
      status: "pending",
      title: "Q",
      subject: {},
      responseCapability: { type: "answers", questions: [] },
      source: { origin: "openbot", method: "ask_user", nativeRequestId: "call_1" },
      blocking: false,
      createdAt: 50,
    }
    s = applyConversationStreamItem(s, {
      kind: "change",
      cursor: { epoch: "e1", sequence: 5 },
      change: { type: "request.upserted", request },
    })
    expect(pendingRequestsOf(s).map((r) => r.id)).toEqual([request.id])
    s = applyConversationStreamItem(s, {
      kind: "change",
      cursor: { epoch: "e1", sequence: 6 },
      change: { type: "entry.removed", entryId: "ent_1" as EntryId, reason: "retracted" },
    })
    expect(s.entries.has("ent_1" as EntryId)).toBe(false)

    // unknown change from a newer server: skipped, cursor advances
    s = applyConversationStreamItem(s, {
      kind: "change",
      cursor: { epoch: "e1", sequence: 7 },
      change: { type: "unknown", originalTag: "plan.updated" } as any,
    })
    expect(s.cursor!.sequence).toBe(7)
    expect(s.skippedUnknown).toBe(1)

    // a change from another epoch is a gap
    const gapped = applyConversationStreamItem(s, {
      kind: "change",
      cursor: { epoch: "e2", sequence: 1 },
      change: { type: "entry.removed", entryId: "ent_3" as EntryId, reason: "deleted" },
    })
    expect(gapped.gap).toBe(true)
    expect(gapped.entries.has("ent_3" as EntryId)).toBe(true)

    // reset clears everything but keeps the conversation header
    s = applyConversationStreamItem(s, { kind: "reset", epoch: "e2", reason: "new-session" })
    expect(s.entries.size).toBe(0)
    expect(s.cursor).toBeUndefined()
    expect(s.conversation?.id).toBe(conversation.id)
  })
})

describe("roster projection", () => {
  const bot = (id: string, name: string): Bot => ({
    id: id as BotId,
    ownerProfileId: MAIN_PROFILE_ID,
    name,
    avatar: { shape: "blob", color: "blue" },
    harness: { kind: "fake" },
    hostNodeId: "node_local" as NodeId,
    boundNodeIds: [],
    instructions: "",
    directConversationId: `cnv_${id}` as ConversationId,
    pinned: false,
    hidden: false,
    notify: "all",
    autonomy: "workspace",
    projectFolders: [],
    skills: [],
    createdAt: 0,
    updatedAt: 0,
  })
  const at = (sequence: number) => ({ epoch: "r1", sequence })

  test("snapshot, changes, gap detection and resume", () => {
    const items: KnownRosterStreamItem[] = [
      {
        kind: "snapshot",
        cursor: at(0),
        bots: [bot("bot_1", "Scout")],
        conversations: [],
        activities: [],
        nodes: [],
        sections: [{ id: "sec_b" as SectionId, ownerProfileId: MAIN_PROFILE_ID, name: "B", order: 2 }],
        settings: DEFAULT_SETTINGS,
      },
      { kind: "synchronized", cursor: at(0) },
      { kind: "change", cursor: at(1), change: { type: "bot.upserted", bot: bot("bot_2", "Ada") } },
      {
        kind: "change",
        cursor: at(2),
        change: {
          type: "section.upserted",
          section: { id: "sec_a" as SectionId, ownerProfileId: MAIN_PROFILE_ID, name: "A", order: 1 },
        },
      },
      {
        kind: "change",
        cursor: at(3),
        change: {
          type: "activity.updated",
          activity: { botId: "bot_2" as BotId, state: "working", label: "Typing…", since: 5 },
        },
      },
      {
        kind: "change",
        cursor: at(4),
        change: { type: "settings.updated", settings: { ...DEFAULT_SETTINGS, theme: "dark" } },
      },
      {
        kind: "change",
        cursor: at(5),
        change: {
          type: "notification",
          notification: {
            id: "ntf_1" as any,
            kind: "waiting",
            botId: "bot_2" as BotId,
            title: "Ada",
            body: "Needs approval",
            at: 6,
          },
        },
      },
      { kind: "change", cursor: at(6), change: { type: "bot.removed", botId: "bot_2" as BotId } },
    ]
    const s = items.reduce(applyRosterStreamItem, emptyRosterState)
    expect([...s.bots.keys()]).toEqual(["bot_1" as BotId])
    expect(s.activities.size).toBe(0)
    expect(sectionsOf(s).map((x) => x.name)).toEqual(["A", "B"])
    expect(s.settings?.theme).toBe("dark")
    expect(s.notifications.map((n) => n.id)).toEqual(["ntf_1" as any])
    expect(s.cursor).toEqual(at(6))
    expect(s.synchronized).toBe(true)

    const gapped = applyRosterStreamItem(s, {
      kind: "change",
      cursor: at(8),
      change: { type: "bot.upserted", bot: bot("bot_3", "Max") },
    })
    expect(gapped.gap).toBe(true)
    expect(gapped.synchronized).toBe(false)
    expect(gapped.bots.has("bot_3" as BotId)).toBe(false)
    const healed = applyRosterStreamItem(gapped, {
      kind: "change",
      cursor: at(7),
      change: { type: "bot.upserted", bot: bot("bot_3", "Max") },
    })
    expect(healed.gap).toBe(false)
    expect(healed.bots.has("bot_3" as BotId)).toBe(true)
  })

  test("tasks: snapshot, upserts, active list, and a removed bot takes its tasks", () => {
    const task = (id: string, botId: string, status: Task["status"], createdAt: number): Task => ({
      id: id as TaskId,
      botId: botId as BotId,
      conversationId: `cnv_${botId}` as ConversationId,
      title: `Work ${id}`,
      brief: "do it",
      status,
      createdAt,
      updatedAt: createdAt,
    })
    const items: KnownRosterStreamItem[] = [
      {
        kind: "snapshot",
        cursor: at(0),
        bots: [bot("bot_1", "Scout"), bot("bot_2", "Ada")],
        conversations: [],
        activities: [],
        nodes: [],
        sections: [],
        settings: DEFAULT_SETTINGS,
        tasks: [task("tsk_1", "bot_1", "running", 1)],
      },
      { kind: "change", cursor: at(1), change: { type: "task.upserted", task: task("tsk_2", "bot_1", "queued", 2) } },
      { kind: "change", cursor: at(2), change: { type: "task.upserted", task: task("tsk_3", "bot_2", "running", 3) } },
      {
        kind: "change",
        cursor: at(3),
        change: { type: "task.upserted", task: { ...task("tsk_1", "bot_1", "succeeded", 1), result: "done" } },
      },
    ]
    const s = items.reduce(applyRosterStreamItem, emptyRosterState)
    expect(activeTasksOf(s, "bot_1" as BotId).map((t) => t.id)).toEqual(["tsk_2" as TaskId])
    expect(s.tasks.get("tsk_1" as TaskId)?.result).toBe("done")
    const removed = applyRosterStreamItem(s, {
      kind: "change",
      cursor: at(4),
      change: { type: "bot.removed", botId: "bot_1" as BotId },
    })
    expect([...removed.tasks.keys()]).toEqual(["tsk_3" as TaskId])
    // an older brain's snapshot has no tasks
    const { tasks: _drop, ...old } = items[0] as Extract<KnownRosterStreamItem, { kind: "snapshot" }>
    expect(applyRosterStreamItem(s, old).tasks.size).toBe(0)
  })
})

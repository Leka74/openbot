// Sidebar model (pure, unit-tested): pinned tiles, sections in order, group chats, Unassigned and
// Hidden Bots, each row with its summary, activity and derived status (grok-bot-ui.md §4.1).
import type { Bot, BotActivity, BotId, ConversationSummary, RosterState, SectionId } from "@openbot/contracts"
import { activeTasksOf } from "@openbot/contracts"
import { HANDLING, whereOf } from "./busy.ts"

export { HANDLING }

export type RowStatus = "working" | "attention" | "unread" | "idle"

export type SidebarItem =
  | {
      readonly kind: "bot"
      readonly key: string
      readonly bot: Bot
      readonly summary: ConversationSummary | undefined
      readonly activity: BotActivity | undefined
      readonly status: RowStatus
      readonly preview: string
      readonly unread: boolean
      /** The preview says "Handling…": its background work runs (D5.7). */
      readonly handling: boolean
    }
  | {
      readonly kind: "group"
      readonly key: string
      readonly summary: ConversationSummary
      readonly bots: ReadonlyArray<Bot>
      readonly status: RowStatus
      readonly preview: string
      readonly unread: boolean
    }

export interface SidebarSection {
  readonly id: SectionId | "groups" | "unassigned" | "hidden"
  readonly name: string
  readonly items: ReadonlyArray<SidebarItem>
}

export interface SidebarModel {
  readonly pinned: ReadonlyArray<SidebarItem & { kind: "bot" }>
  readonly sections: ReadonlyArray<SidebarSection>
  readonly hidden: SidebarSection
}

const working = (a: BotActivity | undefined) => a !== undefined && (a.state === "thinking" || a.state === "working")

/**
 * `open` is the conversation on screen: it never shows as unread (the chat marks it read a moment
 * later; without this the dot flickers on every reply).
 */
export const botItem = (
  bot: Bot,
  state: Pick<RosterState, "conversations" | "activities"> & { readonly tasks?: RosterState["tasks"] | undefined },
  open?: string | null,
): SidebarItem & { kind: "bot" } => {
  const summary = state.conversations.get(bot.directConversationId)
  const activity = state.activities.get(bot.id as BotId)
  const unread = (summary?.unreadCount ?? 0) > 0 && bot.directConversationId !== open
  const waiting = (summary?.pendingRequestCount ?? 0) > 0 || activity?.state === "waiting"
  const busy = working(activity)
  // The same order as the DM's status line (chat/busy.ts `chatStatuses`): its turn in the DM, else
  // background work started in the DM ("Handling…"), else busy in another conversation ("Busy in …",
  // one mind per bot, D5.0), else background work started anywhere else.
  const away = busy && activity?.conversationId !== undefined && activity.conversationId !== bot.directConversationId
  const active = state.tasks === undefined ? [] : activeTasksOf({ tasks: state.tasks }, bot.id)
  const handlingHere = active.some((t) => t.conversationId === bot.directConversationId)
  const handling = active.length > 0 && (away ? handlingHere : !busy)
  const status: RowStatus = waiting ? "attention" : busy || handling ? "working" : unread ? "unread" : "idle"
  const preview = waiting
    ? (activity?.state === "waiting" && activity.label ? activity.label : summary?.preview?.startsWith("Waiting") ? summary.preview : "Waiting for you")
    : handling
      ? HANDLING
      : away
      ? `Busy in ${whereOf(state.conversations.get(activity!.conversationId!))}`
      : busy && activity?.label === "Typing…"
      ? "Typing…"
      : (summary?.preview ?? (busy ? (activity?.label ?? "Working…") : ""))
  return { kind: "bot", key: bot.id, bot, summary, activity, status, preview, unread, handling }
}

/**
 * Chats the owner placed (dragged) keep their `sidebarOrder`; the rest come first, most recent first
 * (a new chat shows on top).
 */
const arranged = <T>(order: (t: T) => number | undefined, recency: (t: T) => number) => (a: T, b: T): number => {
  const oa = order(a)
  const ob = order(b)
  if (oa === undefined && ob === undefined) return recency(b) - recency(a)
  if (oa === undefined) return -1
  if (ob === undefined) return 1
  return oa - ob
}

export const buildSidebar = (
  state: Pick<RosterState, "bots" | "conversations" | "activities" | "sections"> & { readonly tasks?: RosterState["tasks"] | undefined },
  open?: string | null,
): SidebarModel => {
  const bots = [...state.bots.values()].sort((a, b) => a.name.localeCompare(b.name))
  const visible = bots.filter((b) => !b.hidden)
  const pinned = visible
    .filter((b) => b.pinned)
    .sort(arranged((b: Bot) => b.sidebarOrder, (b) => -b.createdAt))
    .map((b) => botItem(b, state, open))
  const sectionList = [...state.sections.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  const known = new Set<string>(sectionList.map((s) => s.id))
  const recency = (b: Bot) => state.conversations.get(b.directConversationId)?.lastActivityAt ?? b.updatedAt
  const rest = visible.filter((b) => !b.pinned)
  const groupItems: Array<SidebarItem & { kind: "group" }> = [...state.conversations.values()]
    .filter((c) => c.kind === "group" && !c.hiddenFromSidebar)
    .map((c) => {
      const members = c.botIds.map((id) => state.bots.get(id as BotId)).filter((b): b is Bot => b !== undefined)
      const busy = members.some((m) => {
        const a = state.activities.get(m.id)
        return working(a) && a?.conversationId === c.id
      })
      const unread = c.unreadCount > 0 && c.id !== open
      return {
        kind: "group" as const,
        key: c.id,
        summary: c,
        bots: members,
        status: c.pendingRequestCount > 0 ? "attention" : busy ? "working" : unread ? "unread" : "idle",
        preview: c.preview ?? members.map((m) => m.name).join(", "),
        unread,
      }
    })
  // a section holds Bots and group chats, in the owner's order
  const order = (item: SidebarItem) => (item.kind === "bot" ? item.bot.sidebarOrder : item.summary.sidebarOrder)
  const recent = (item: SidebarItem) => (item.kind === "bot" ? recency(item.bot) : item.summary.lastActivityAt)
  const place = (items: ReadonlyArray<SidebarItem>) => [...items].sort(arranged(order, recent))
  const sections: SidebarSection[] = sectionList.map((s) => ({
    id: s.id,
    name: s.name,
    items: place([
      ...rest.filter((b) => b.sectionId === s.id).map((b) => botItem(b, state, open)),
      ...groupItems.filter((g) => g.summary.sectionId === s.id),
    ]),
  }))
  const looseGroups = groupItems.filter((g) => g.summary.sectionId === undefined || !known.has(g.summary.sectionId))
  // kept (maybe empty) while any group chat exists: the place to drag one back out of a section
  if (groupItems.length > 0) sections.push({ id: "groups", name: "Group chats", items: place(looseGroups) })
  sections.push({
    id: "unassigned",
    name: "Unassigned",
    items: place(rest.filter((b) => b.sectionId === undefined || !known.has(b.sectionId)).map((b) => botItem(b, state, open))),
  })
  const hidden: SidebarSection = { id: "hidden", name: "Hidden Bots", items: bots.filter((b) => b.hidden).map((b) => botItem(b, state, open)) }
  return { pinned, sections, hidden }
}

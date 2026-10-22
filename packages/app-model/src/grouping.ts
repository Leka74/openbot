// Transcript layout model (pure, unit-tested): turns the ordered entries of a conversation into the
// rows the chat renders (grok-bot-ui.md §4.4, grok-bot-ui-activity.md F.0/F.10.0):
//   - timestamps when 15+ minutes pass between rows (and at the top),
//   - the NEW divider at the unread boundary,
//   - bubble groups: consecutive messages of the same author (user, or one bot),
//   - cards, event lines, notices and unknown-entry placeholders as their own rows,
//   - tool calls and reasoning never render as rows; they feed the "N steps" disclosure placed
//     under the last visible row of each finished turn (when steps are shown) — except successful
//     `ask_user` / `request_approval` calls, whose card already shows them,
//   - "auto-decided" events that ALLOWED something (a rule or the bot's autonomy) are folded into
//     their turn's steps as well (a badge on the gated tool call, else a row of their own): they never
//     render as lines, open no timestamp and never split a bubble group. Denials stay visible lines,
//   - in a direct conversation, bot replies to another Bot's message (a turn triggered by a
//     `message_bot` delivery) carry `addressee` (the sender) so the chat labels them "to @Sender".
import type { ConversationState, EntryId, RuntimeRequest, TranscriptEntry, TranscriptEntryOf, Turn, TurnId } from "@openbot/contracts"

export type MessageEntry = TranscriptEntryOf<"message">
export type ToolCallEntry = TranscriptEntryOf<"tool-call">

/** OpenBot tools whose card in the chat is their visible step (not repeated in "N steps"). */
const CARD_TOOLS = new Set(["ask_user", "request_approval"])
const shownAsCard = (entry: ToolCallEntry): boolean =>
  entry.mcp?.server === "openbot" && CARD_TOOLS.has(entry.mcp.tool) && entry.status !== "failed" && entry.status !== "declined"
export type ReasoningEntry = TranscriptEntryOf<"reasoning">
export type CardEntry = TranscriptEntryOf<"card">
export type EventEntry = TranscriptEntryOf<"event">
export type NoticeEntry = TranscriptEntryOf<"notice">
export type UnknownEntry = Extract<TranscriptEntry, { kind: "unknown" }>

/** A user bubble that is still in the client outbox (not yet echoed on the stream). */
export interface PendingMessage {
  readonly clientNonce: string
  readonly text: string
  readonly createdAt: number
  readonly status: "sending" | "sent" | "failed"
  readonly error?: string | undefined
}

export type BubbleItem =
  | { readonly kind: "entry"; readonly entry: MessageEntry }
  | { readonly kind: "pending"; readonly pending: PendingMessage }

export type Row =
  | { readonly type: "timestamp"; readonly key: string; readonly at: number }
  | { readonly type: "new-divider"; readonly key: string }
  | {
      readonly type: "group"
      readonly key: string
      readonly side: "user" | "bot"
      /** Bot id for bot groups (group chats show the speaker's name and avatar). */
      readonly botId?: string | undefined
      /**
       * Direct conversations: the Bot these replies answer (its message triggered the turn), so they
       * are labelled "to @Sender". Absent for replies to the owner.
       */
      readonly addressee?: string | undefined
      readonly items: ReadonlyArray<BubbleItem>
    }
  | { readonly type: "card"; readonly key: string; readonly entry: CardEntry }
  /**
   * A run of consecutive bot-to-bot messages (`toBotId`, written by message_bot / handoff_task) from
   * one counterpart, collapsed into "N messages with ‹Bot›" (Grok). `ownerBotId` is the recipient.
   */
  | { readonly type: "exchange"; readonly key: string; readonly peerBotId: string; readonly ownerBotId: string; readonly entries: ReadonlyArray<MessageEntry> }
  | { readonly type: "event"; readonly key: string; readonly entry: EventEntry }
  | { readonly type: "notice"; readonly key: string; readonly entry: NoticeEntry }
  | { readonly type: "unknown"; readonly key: string; readonly entry: UnknownEntry }
  | {
      readonly type: "steps"
      readonly key: string
      readonly turnId: TurnId
      readonly steps: ReadonlyArray<ToolCallEntry | ReasoningEntry>
      /** The turn's "auto-decided" (allowed) events, folded in from the transcript. */
      readonly decisions: ReadonlyArray<EventEntry>
      readonly failed: boolean
    }

export interface LayoutInput {
  readonly entries: ReadonlyArray<TranscriptEntry>
  readonly turns: ReadonlyMap<TurnId, Turn> | ReadonlyArray<Turn>
  readonly pending?: ReadonlyArray<PendingMessage>
  /** Entries created after this (and not by the user) are "new". Undefined = no divider. */
  readonly unreadBoundaryAt?: number | undefined
  readonly showSteps: boolean
  /** Turns whose steps show even when `showSteps` is off (a search hit on one of their tool steps). */
  readonly revealSteps?: ReadonlySet<TurnId> | undefined
  /** Show "Compacted context" lines (Settings `showCompactions`; default hidden). */
  readonly showCompactions?: boolean
  /** Gap that inserts a timestamp row (default 15 minutes). */
  readonly timestampGapMs?: number
  /** A bot's direct conversation: label replies to other Bots ("to @Sender", `addressee`). */
  readonly direct?: boolean
}

export const TIMESTAMP_GAP_MS = 15 * 60 * 1000

const isTerminal = (t: Turn | undefined) => t !== undefined && (t.status === "completed" || t.status === "failed" || t.status === "interrupted")

const sideOf = (entry: MessageEntry): "user" | "bot" => (entry.role === "user" || entry.author.kind === "user" ? "user" : "bot")
const botOf = (entry: TranscriptEntry): string | undefined => (entry.author.kind === "bot" ? entry.author.botId : undefined)

/** A directed bot-to-bot message (message_bot / handoff_task), shown collapsed, never as a bubble. */
export const isBotToBot = (entry: MessageEntry): boolean => entry.author.kind === "bot" && entry.toBotId !== undefined && entry.author.botId !== entry.toBotId

/**
 * Both directions of the traffic between bots `a` and `b`: b → a lives in a's direct conversation,
 * a → b in b's. Chronological; duplicates (same entry id) dropped.
 */
export const exchangeBetween = (
  a: string,
  b: string,
  sources: ReadonlyArray<ReadonlyArray<TranscriptEntry>>,
): ReadonlyArray<MessageEntry> => {
  const seen = new Set<string>()
  const out: Array<MessageEntry> = []
  for (const entries of sources) {
    for (const e of entries) {
      if (e.kind !== "message" || !isBotToBot(e) || seen.has(e.id)) continue
      const from = botOf(e)
      if ((from === a && e.toBotId === b) || (from === b && e.toBotId === a)) {
        seen.add(e.id)
        out.push(e)
      }
    }
  }
  return out.sort((x, y) => x.createdAt - y.createdAt)
}

/** An "auto-decided" event that allowed something: folded into its turn's steps, never a line. */
export const isFoldedDecision = (entry: TranscriptEntry): boolean =>
  entry.kind === "event" && entry.event.type === "auto-decided" && entry.event.decision === "allowed"

/**
 * The Bot a bot reply answers in a direct conversation: the author of the bot-to-bot message that
 * started its turn (`turn.inputEntryId`), else — for a turn triggered by a Bot whose message is not
 * loaded — the newest bot-to-bot message to the replying Bot before the turn started. Undefined for
 * replies to the owner (and anything unknown).
 */
export const replyAddressee = (
  entry: MessageEntry,
  turns: ReadonlyMap<TurnId, Turn>,
  byId: ReadonlyMap<string, TranscriptEntry>,
  earlier: ReadonlyArray<TranscriptEntry>,
): string | undefined => {
  const replier = botOf(entry)
  if (replier === undefined || entry.turnId === undefined || entry.toBotId !== undefined) return undefined
  const turn = turns.get(entry.turnId)
  if (turn === undefined) return undefined
  const input = turn.inputEntryId === undefined ? undefined : byId.get(turn.inputEntryId)
  if (input !== undefined) {
    const from = botOf(input)
    return input.kind === "message" && from !== undefined && from !== replier && input.toBotId === replier ? from : undefined
  }
  if (turn.trigger !== "bot") return undefined
  for (let i = earlier.length - 1; i >= 0; i--) {
    const e = earlier[i]!
    if (e.createdAt > turn.startedAt) continue
    if (e.kind === "message" && e.toBotId === replier && botOf(e) !== undefined && botOf(e) !== replier) return botOf(e)
  }
  return undefined
}

/** Build the transcript rows. Entries must already be in transcript order (`transcriptOf`). */
export const layoutTranscript = (input: LayoutInput): ReadonlyArray<Row> => {
  const gap = input.timestampGapMs ?? TIMESTAMP_GAP_MS
  const turns = input.turns instanceof Map ? input.turns : new Map((input.turns as ReadonlyArray<Turn>).map((t) => [t.id, t] as const))
  const rows: Row[] = []
  let lastAt: number | undefined
  let dividerPlaced = false
  // Per turn: collected steps and the index (in `rows`) after which to place the disclosure.
  const steps = new Map<TurnId, Array<ToolCallEntry | ReasoningEntry>>()
  const decisions = new Map<TurnId, Array<EventEntry>>()
  const anchor = new Map<TurnId, number>()

  const open = (): Extract<Row, { type: "group" }> | undefined => {
    const last = rows[rows.length - 1]
    return last?.type === "group" ? last : undefined
  }

  const beforeVisible = (entryKey: string, at: number, isNewCandidate: boolean) => {
    // Inclusive: the brain sets the boundary to the first unread entry's `createdAt` (core
    // ConversationService.bumpForEntry; `markRead(unread)` counts entries `>=` it too).
    if (!dividerPlaced && isNewCandidate && input.unreadBoundaryAt !== undefined && at >= input.unreadBoundaryAt) {
      rows.push({ type: "new-divider", key: `new:${entryKey}` })
      dividerPlaced = true
    }
    if (lastAt === undefined || at - lastAt >= gap) rows.push({ type: "timestamp", key: `ts:${entryKey}`, at })
    lastAt = at
  }

  const markTurn = (entry: TranscriptEntry) => {
    if (entry.turnId !== undefined) anchor.set(entry.turnId, rows.length - 1)
  }

  for (const entry of input.entries) {
    // work handed over on a voice call is told on the call, not shown here
    if (entry.turnId !== undefined && turns.get(entry.turnId)?.voice === true) continue
    if (isFoldedDecision(entry)) {
      // into the turn's steps (no row, no timestamp: bubble groups continue across it)
      if (entry.turnId !== undefined) {
        const list = decisions.get(entry.turnId) ?? []
        list.push(entry as EventEntry)
        decisions.set(entry.turnId, list)
        if (!anchor.has(entry.turnId)) anchor.set(entry.turnId, rows.length - 1)
      }
      continue
    }
    switch (entry.kind) {
      case "tool-call":
      case "reasoning": {
        if (entry.turnId === undefined || (entry.kind === "tool-call" && shownAsCard(entry))) break
        const list = steps.get(entry.turnId) ?? []
        list.push(entry)
        steps.set(entry.turnId, list)
        if (!anchor.has(entry.turnId)) anchor.set(entry.turnId, rows.length - 1)
        break
      }
      case "message": {
        if (isBotToBot(entry)) {
          const last = rows[rows.length - 1]
          const peer = botOf(entry)!
          if (last?.type === "exchange" && last.peerBotId === peer && last.ownerBotId === entry.toBotId) {
            ;(last.entries as MessageEntry[]).push(entry)
          } else {
            beforeVisible(entry.id, entry.createdAt, true)
            rows.push({ type: "exchange", key: `x:${entry.id}`, peerBotId: peer, ownerBotId: entry.toBotId!, entries: [entry] })
          }
          markTurn(entry)
          break
        }
        const side = sideOf(entry)
        const botId = side === "bot" ? botOf(entry) : undefined
        // No "to @Sender" label: with one mind per bot, a bot's plain reply in its DM is read by the owner
        // (it answers other bots with message_bot), so labelling bot-triggered replies was misleading.
        const addressee: string | undefined = undefined
        const tsBefore = rows.length
        beforeVisible(entry.id, entry.createdAt, side === "bot")
        const g = rows.length === tsBefore ? open() : undefined
        if (g && g.side === side && g.botId === botId && g.addressee === addressee) {
          ;(g.items as BubbleItem[]).push({ kind: "entry", entry })
        } else {
          rows.push({
            type: "group",
            key: `g:${entry.id}`,
            side,
            botId,
            ...(addressee === undefined ? {} : { addressee }),
            items: [{ kind: "entry", entry }],
          })
        }
        markTurn(entry)
        break
      }
      case "card":
        beforeVisible(entry.id, entry.createdAt, entry.author.kind !== "user")
        rows.push({ type: "card", key: entry.id, entry })
        markTurn(entry)
        break
      case "event":
        // a Bot compacting its context is housekeeping: shown only when the owner asked for it
        if (entry.event.type === "session-changed" && entry.event.action === "compacted" && input.showCompactions !== true) break
        beforeVisible(entry.id, entry.createdAt, false)
        rows.push({ type: "event", key: entry.id, entry })
        markTurn(entry)
        break
      case "notice":
        beforeVisible(entry.id, entry.createdAt, false)
        rows.push({ type: "notice", key: entry.id, entry })
        markTurn(entry)
        break
      default:
        beforeVisible(entry.id, entry.createdAt, false)
        rows.push({ type: "unknown", key: entry.id, entry: entry as UnknownEntry })
        break
    }
  }

  // Optimistic user bubbles after everything on the stream.
  for (const p of input.pending ?? []) {
    const tsBefore = rows.length
    beforeVisible(p.clientNonce, p.createdAt, false)
    const g = rows.length === tsBefore ? open() : undefined
    if (g && g.side === "user") (g.items as BubbleItem[]).push({ kind: "pending", pending: p })
    else rows.push({ type: "group", key: `p:${p.clientNonce}`, side: "user", items: [{ kind: "pending", pending: p }] })
  }

  const reveal = input.revealSteps
  if ((!input.showSteps && (reveal === undefined || reveal.size === 0)) || (steps.size === 0 && decisions.size === 0)) return rows

  // Insert the disclosures from the back so earlier indices stay valid.
  const turnIds = new Set<TurnId>([...steps.keys(), ...decisions.keys()])
  const inserts = [...turnIds]
    .filter((turnId) => (input.showSteps && isTerminal(turns.get(turnId))) || reveal?.has(turnId) === true)
    .map((turnId) => ({ at: anchor.get(turnId) ?? rows.length - 1, turnId, list: steps.get(turnId) ?? [], decided: decisions.get(turnId) ?? [] }))
    .sort((a, b) => b.at - a.at)
  for (const ins of inserts) {
    const failed = ins.list.some((s) => s.kind === "tool-call" && (s.status === "failed" || s.status === "declined"))
    const row: Row = { type: "steps", key: `steps:${ins.turnId}`, turnId: ins.turnId, steps: ins.list, decisions: ins.decided, failed }
    rows.splice(ins.at + 1, 0, row)
  }
  return rows
}

/** Bubble corner position of item `index` in a group, given whether a trailing grouped row follows. */
export const positionIn = (index: number, length: number, continued = false): "single" | "first" | "middle" | "last" => {
  const total = continued ? length + 1 : length
  if (total <= 1) return "single"
  if (index === 0) return "first"
  if (index === total - 1) return "last"
  return "middle"
}

/** Entry ids of every message in the rows (for reply lookups). */
export const messageIndex = (entries: ReadonlyArray<TranscriptEntry>): ReadonlyMap<EntryId, MessageEntry> => {
  const map = new Map<EntryId, MessageEntry>()
  for (const e of entries) if (e.kind === "message") map.set(e.id, e)
  return map
}

/** The newest terminal failed turn when it is the latest turn of the conversation (error tray). */
export const failedTurnOf = (turns: ReadonlyArray<Turn>): Turn | undefined => {
  const latest = [...turns].sort((a, b) => a.startedAt - b.startedAt).at(-1)
  return latest?.status === "failed" ? latest : undefined
}

/** Pending request for a card entry, if any. */
export const requestForCard = (entry: CardEntry, requests: ReadonlyMap<string, RuntimeRequest>): RuntimeRequest | undefined => {
  const card = entry.card as { readonly requestId?: string }
  return card.requestId !== undefined ? requests.get(card.requestId) : undefined
}

/**
 * The NEW-divider boundary to capture when a chat opens: `null` until the replica is synchronized (a
 * cached replica renders at once with a stale `conversation` while it catches up), else the
 * boundary when something is unread.
 */
export const unreadBoundaryOf = (state: Pick<ConversationState, "conversation" | "synchronized">): number | undefined | null => {
  if (!state.conversation || !state.synchronized) return null
  return state.conversation.unreadCount > 0 ? state.conversation.unreadBoundaryAt : undefined
}

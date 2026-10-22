// The chat column (grok-bot-ui.md §3, §4.3–4.6): floating header pill (→ details pane), the
// transcript (grouping, timestamps, NEW divider, event lines, cards, notices, steps), the activity
// row, the error tray and the composer. The user bubble takes the bot's color when
// settings.accent = "bot" (botTintStyle). On a phone the header becomes Grok iOS's floating glass
// row (back · name pill · computer), a long-press on a bubble opens its action sheet, and the
// transcript / composer respect the safe areas.
// Search (find.ts): the chat opens at a hit (`jumpTargetAtom`, `#/c/<id>/e/<entryId>`) or steps
// through the Find bar's hits. A hit the replica holds is scrolled to; an older one opens a window
// of the chat around it (`conversations.around`, paged near the edges) until "Jump to latest", and
// the window joins the live chat once it reaches it. Hits light up and their words are highlighted.
import { ArrowDown, ChevronLeft, type LucideIcon, Monitor, X } from "lucide-react"
import { Fragment, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Exit } from "effect"
import {
  DEFAULT_SEARCH_KINDS,
  DEFAULT_SETTINGS,
  emptyConversationState,
  transcriptOf,
  type Bot,
  type BotId,
  type ConversationId,
  type TranscriptEntry,
  type Turn,
  type TurnId,
} from "@openbot/contracts"
import { applyWindowPage, type ChatWindow, messagesAfter, newestOf, windowView } from "@openbot/app-model"
import { commandAtom, commands, conversationAtom, discardOutboxItemAtom, loadOlderAtom, outboxAtom, retrySendAtom, retryTurnAtom, sendMessageAtom, interruptTurnAtom, voiceStatusAtom } from "@openbot/client"
import { ActivityRow, Avatar, AvatarStack, HeaderPill, Icon, IconButton, NewDivider, PillButton, Spinner, Timestamp, botTintStyle, cn, useToast } from "@openbot/ui"
import { useRoster, valueOr } from "../app/data.ts"
import { formatTimestamp } from "../app/format.ts"
import { useLayoutMode } from "../app/layout.ts"
import { useLongPressWithin } from "../app/longPress.ts"
import { chatHash } from "../app/route.ts"
import { findBarAtom, jumpTargetAtom, useComputerView, useDetailsPane, usePhoneNav, useSelection, useSettingsDialog } from "../app/uiState.ts"
import { CardView, WarnIcon } from "../cards/index.ts"
import { describeFailure } from "../cards/useRespond.ts"
import { activityPhrase } from "./activity.ts"
import { type ChatStatus, chatStatuses, HANDLING } from "./busy.ts"
import { Composer, type ComposerSubmit } from "./Composer.tsx"
import { EventRow, ExchangeLine, NoticeRow, UnknownRow, type EventContext } from "./Events.tsx"
import { ExchangeDialog } from "./ExchangeDialog.tsx"
import { FindBar, type FindState } from "./FindBar.tsx"
import { centerIn, flash, rowOf, useTermHighlights } from "./find.ts"
import type { ExchangeTarget } from "./exchange.ts"
import { failedTurnOf, layoutTranscript, messageIndex, positionIn, requestForCard, unreadBoundaryOf, type MessageEntry, type PendingMessage, type Row } from "./grouping.ts"
import { AddresseeChip, MessageBubble, PendingBubble } from "./Message.tsx"
import { MessageSheet } from "./MessageSheet.tsx"
import { StepsDisclosure } from "./Steps.tsx"
import { useQuery } from "../details/kit.tsx"
import { useVoiceCall } from "../voice/CallBar.tsx"
import { startCall } from "../voice/voiceCall.ts"

const ACTIVE = new Set<Turn["status"]>(["queued", "running", "waiting"])

/** Entries per `conversations.around` page. */
const WINDOW_PAGE = 60
/** Load the window's next page when the view is this close to its edge (px). */
const EDGE = 240

/** The entry the chat is showing: a search hit (a link) or the Find bar's current hit. */
interface Target {
  readonly entryId: string
  /** Changes when the same entry is asked for again. */
  readonly nonce: number
  readonly terms: ReadonlyArray<string>
  /** A link (not the Find bar): the hit lights up and a bot-to-bot one opens its exchange. */
  readonly link: boolean
  readonly openExchange: boolean
}

/** The chat opened around an older entry: loading, loaded (`window`), or it failed. */
interface WindowState {
  readonly entryId: string
  readonly window: ChatWindow | undefined
  /** The replica's newest entry when it opened ("New messages" count from there). */
  readonly mark: TranscriptEntry | undefined
}

/** Grok iOS's round "liquid glass" header button (back, computer). */
function GlassButton({ icon, label, onClick, testId }: { readonly icon: LucideIcon; readonly label: string; readonly onClick: () => void; readonly testId?: string }): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      data-testid={testId}
      className="pointer-events-auto inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-elevated/90 text-icon backdrop-blur-xl hairline border-line-secondary shadow-inline transition-colors duration-[120ms] hover:bg-elevated-hover active:bg-elevated-hover"
    >
      <Icon icon={icon} size="xl" />
    </button>
  )
}


export function ChatView({ conversationId }: { readonly conversationId: ConversationId }): ReactNode {
  const roster = useRoster()
  const settingsDialog = useSettingsDialog()
  const result = useAtomValue(conversationAtom(conversationId))
  const state = valueOr(result, emptyConversationState)
  const outbox = useAtomValue(outboxAtom(conversationId))
  const send = useAtomSet(sendMessageAtom)
  const retry = useAtomSet(retrySendAtom)
  const discard = useAtomSet(discardOutboxItemAtom)
  const interrupt = useAtomSet(interruptTurnAtom)
  const markRead = useAtomSet(commands["conversations.markRead"])
  const loadOlder = useAtomSet(loadOlderAtom, { mode: "promiseExit" })
  const details = useDetailsPane()
  const { select, selectBot } = useSelection()
  const mode = useLayoutMode()
  const phone = mode === "phone"
  const nav = usePhoneNav()
  const computerView = useComputerView()
  const settings = roster.state.settings ?? DEFAULT_SETTINGS
  const summary = roster.state.conversations.get(conversationId)
  const conversation = state.conversation

  const botIds: ReadonlyArray<BotId> = conversation
    ? conversation.kind === "group"
      ? conversation.memberBotIds
      : [conversation.botId]
    : ((summary?.botIds ?? []) as ReadonlyArray<BotId>)
  const members = botIds.map((id) => roster.botById(id)).filter((b): b is Bot => b !== undefined)
  const isGroup = (conversation?.kind ?? summary?.kind) === "group"
  const voiceCalls = useQuery(voiceStatusAtom)
  const call = useVoiceCall()
  const primary = members[0]
  const title = isGroup ? (conversation?.title || summary?.title || members.map((m) => m.name).join(", ")) : (primary?.name ?? summary?.title ?? "")
  const tint = settings.accent === "bot" && !isGroup && primary ? botTintStyle(primary.avatar.color) : {}
  // Phone / tablet header: the monitor button when the Bot's computer has a screen or a terminal.
  const host = !isGroup && primary ? roster.state.nodes.get(primary.hostNodeId) : undefined
  const hasComputer = host !== undefined && host.capabilities.some((c) => /^(desktop|screen|browser|pty)@/.test(c))

  // ----------------------------------------------------------------------------- unread boundary
  // Captured once per opened conversation so the NEW divider stays put after we mark it read.
  // (Derived state set during render, guarded by the conversation id: React's documented pattern.)
  // Only from a synchronized replica: a cached one (remount) renders at once with its old
  // `conversation` while it catches up, and its boundary may be long gone. Marking read waits for the
  // capture so the divider is never lost.
  const [captured, setCaptured] = useState<{ readonly id: ConversationId; readonly at: number | undefined } | undefined>(undefined)
  if (captured?.id !== conversationId) {
    const at = unreadBoundaryOf(state)
    if (at !== null) setCaptured({ id: conversationId, at })
  }
  const boundary = captured?.id === conversationId ? captured.at : undefined
  const capturedHere = captured?.id === conversationId
  const unread = summary?.unreadCount ?? conversation?.unreadCount ?? 0
  useEffect(() => {
    if (capturedHere && unread > 0 && document.visibilityState === "visible") {
      const t = setTimeout(() => markRead({ conversationId }), 400)
      return () => clearTimeout(t)
    }
    return undefined
  }, [capturedHere, unread, conversationId, markRead])

  // ------------------------------------------------------------------------------ search
  const [jump, setJump] = useAtom(jumpTargetAtom)
  const [findBar, setFindBar] = useAtom(findBarAtom)
  const findOpen = findBar?.conversationId === conversationId
  const [find, setFind] = useState<FindState | undefined>(undefined)
  const [target, setTarget] = useState<Target | undefined>(undefined)
  const [win, setWin] = useState<WindowState | undefined>(undefined)
  const fetchWindow = useAtomSet(commandAtom("conversations.around", `chat-window:${conversationId}`), { mode: "promiseExit" })
  const view = win?.window ? windowView(win.window, state) : undefined
  const joined = view?.joined ?? false
  const inWindow = view !== undefined && !joined

  // a link to an entry of this chat (search, `#/c/<id>/e/<entryId>`)
  useEffect(() => {
    if (jump === null || jump.conversationId !== conversationId) return
    setTarget({ entryId: jump.entryId, nonce: jump.nonce, terms: jump.terms ?? [], link: true, openExchange: jump.openExchange === true })
    setJump(null)
  }, [jump, conversationId, setJump])
  // the Find bar's current hit
  useEffect(() => {
    if (find?.current !== undefined) setTarget({ entryId: find.current, nonce: -find.step, terms: find.terms, link: false, openExchange: false })
  }, [find?.current, find?.step, find?.terms])
  useEffect(() => {
    if (!findOpen) setFind(undefined)
  }, [findOpen])
  // the Find bar belongs to this visit of the chat
  useEffect(() => () => setFindBar((f) => (f?.conversationId === conversationId ? null : f)), [conversationId, setFindBar])

  // ----------------------------------------------------------------------------------- rows
  const stateEntries = state.entries
  const stateTurns = view?.turns ?? state.turns
  const replicaEntries = useMemo(() => transcriptOf({ entries: stateEntries }), [stateEntries])
  const entries = view?.entries ?? replicaEntries
  const requests = view?.requests ?? state.requests
  const nonces = useMemo(() => new Set(entries.flatMap((e) => (e.kind === "message" && e.clientNonce ? [e.clientNonce] : []))), [entries])
  const pending: ReadonlyArray<PendingMessage> = useMemo(
    () =>
      inWindow
        ? []
        : outbox
            .filter((o) => !nonces.has(o.clientNonce))
            .map((o) => ({ clientNonce: o.clientNonce, text: o.input.text, createdAt: o.createdAt, status: o.status, error: o.error })),
    [outbox, nonces, inWindow],
  )
  const turns = useMemo(() => [...state.turns.values()], [state.turns])
  const showSteps = settings.showSteps
  const showCompactions = settings.showCompactions
  // a hit on a tool step shows its turn's steps, even with steps hidden
  const targetEntry = target === undefined ? undefined : entries.find((e) => e.id === target.entryId)
  const revealTurn = targetEntry !== undefined && (targetEntry.kind === "tool-call" || targetEntry.kind === "reasoning" || targetEntry.kind === "event") ? targetEntry.turnId : undefined
  const revealSteps = useMemo(() => (revealTurn === undefined ? undefined : new Set<TurnId>([revealTurn])), [revealTurn])
  const rows = useMemo(
    () => layoutTranscript({ entries, turns: stateTurns, pending, unreadBoundaryAt: boundary, showSteps, revealSteps, showCompactions, direct: !isGroup }),
    [entries, stateTurns, pending, boundary, showSteps, revealSteps, showCompactions, isGroup],
  )
  const byId = useMemo(() => messageIndex(entries), [entries])

  // Touch: long-press a bubble → its action sheet (the hover toolbar's React / Reply / Copy).
  const [sheetEntry, setSheetEntry] = useState<MessageEntry | undefined>(undefined)
  const longPress = useLongPressWithin(
    (target) => {
      const id = target.closest(".ob-msg [data-side]")?.closest<HTMLElement>(".ob-msg[data-entry]")?.dataset.entry
      const entry = id ? byId.get(id as MessageEntry["id"]) : undefined
      return entry && !entry.streaming ? entry : undefined
    },
    (entry) => setSheetEntry(entry),
  )

  // ------------------------------------------------------------------------------- activity
  // work handed over on a voice call is told on the call: no status line, no Stop
  const activeTurns = turns.filter((t) => ACTIVE.has(t.status) && t.voice !== true).sort((a, b) => a.startedAt - b.startedAt)
  const onCallOnly = new Set(turns.filter((t) => ACTIVE.has(t.status) && t.voice === true && !activeTurns.some((a) => a.botId === t.botId)).map((t) => t.botId))
  // ONE status line per bot, in the activity row's look (busy.ts): its turn here, else "Busy in …"
  // (one mind per bot, D5.0) or "Handling…" (background work started here, D5.7).
  const statuses = chatStatuses({
    conversationId,
    botIds,
    activities: onCallOnly.size === 0 ? roster.state.activities : new Map([...roster.state.activities].filter(([botId]) => !onCallOnly.has(botId))),
    turns: activeTurns,
    conversations: roster.state.conversations,
    tasks: roster.state.tasks,
  })
  const workingBots: ReadonlyArray<string> = statuses.flatMap((st) => (st.kind === "turn" ? [st.botId] : []))
  const streamingBots = new Set(entries.filter((e) => e.kind === "message" && e.streaming && e.author.kind === "bot").map((e) => (e.author as { botId: string }).botId))
  const lastRow = rows[rows.length - 1]
  const lastGroupBot = lastRow?.type === "group" && lastRow.side === "bot" ? lastRow.botId : undefined

  // ----------------------------------------------------------------------------- error tray
  const failed = failedTurnOf(turns)
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const showTray = failed !== undefined && !dismissed.has(failed.id) && activeTurns.length === 0
  // Retry: the failed Bot tries again on what it was answering; nothing new is posted.
  const retryTurn = useAtomSet(retryTurnAtom, { mode: "promiseExit" })
  const { toast } = useToast()
  const retryFailed = async (turn: NonNullable<typeof failed>) => {
    setDismissed((s) => new Set(s).add(turn.id))
    const exit = await retryTurn({ conversationId, turnId: turn.id })
    if (Exit.isFailure(exit)) {
      setDismissed((s) => new Set([...s].filter((id) => id !== turn.id)))
      toast({ title: describeFailure(exit), tone: "danger" })
    }
  }

  // --------------------------------------------------------------------------------- scroll
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const loadingOlder = useRef(false)
  const prevHeight = useRef<number | null>(null)
  /** An entry to scroll to once it is on screen (the target, after its rows render). */
  const place = useRef<Target | undefined>(undefined)
  const windowCursors = win?.window ? { before: win.window.beforeCursor, after: joined ? null : win.window.afterCursor } : undefined
  const loadWindow = useCallback(
    (side: "older" | "newer", cursor: string) => {
      if (loadingOlder.current) return
      loadingOlder.current = true
      void fetchWindow({ conversationId, limit: WINDOW_PAGE, ...(side === "older" ? { beforeCursor: cursor } : { afterCursor: cursor }) }).then((exit) => {
        loadingOlder.current = false
        if (!Exit.isSuccess(exit)) return
        const el = scrollRef.current
        if (side === "older" && el) prevHeight.current = el.scrollHeight
        setWin((w) => (w?.window ? { ...w, window: applyWindowPage(w.window, exit.value, side) } : w))
      })
    },
    [fetchWindow, conversationId],
  )
  /** Back at the newest messages: a link to an entry (`/e/<id>`) becomes the chat's link again. */
  const dropEntryLink = useCallback(() => {
    if (typeof location !== "undefined" && location.hash.startsWith(`${chatHash(conversationId)}/e/`)) history.replaceState(history.state, "", chatHash(conversationId))
  }, [conversationId])
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const bottom = fromBottom < 80
    stick.current = bottom && windowCursors?.after == null
    setAtBottom(bottom)
    if (windowCursors !== undefined) {
      if (el.scrollTop < EDGE && windowCursors.before !== null) loadWindow("older", windowCursors.before)
      else if (fromBottom < EDGE && windowCursors.after !== null) loadWindow("newer", windowCursors.after)
      return
    }
    if (el.scrollTop < 160 && state.hasMoreBefore && !loadingOlder.current) {
      loadingOlder.current = true
      prevHeight.current = el.scrollHeight
      void loadOlder(conversationId).finally(() => {
        loadingOlder.current = false
      })
    }
  }, [state.hasMoreBefore, loadOlder, conversationId, windowCursors?.before, windowCursors?.after, loadWindow])
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (prevHeight.current !== null && !stick.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current
      prevHeight.current = null
      return
    }
    prevHeight.current = null
    if (stick.current) el.scrollTop = el.scrollHeight
  }, [rows, statuses.length, showTray])
  // too little to scroll (a short page) means no scroll to load older on: load it until there is
  useEffect(() => {
    const el = scrollRef.current
    if (el !== null && el.scrollHeight <= el.clientHeight) onScroll()
  }, [rows, onScroll])
  // (ChatView is keyed by conversation id in the shell, so per-conversation state starts fresh.)
  const scrollToBottom = () => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
    dropEntryLink()
  }
  /** Leaves the window for the live chat, at its newest message. */
  const jumpToLatest = () => {
    setWin(undefined)
    setTarget(undefined)
    place.current = undefined
    stick.current = true
    setAtBottom(true)
    dropEntryLink()
  }

  // The target: on screen when the replica (or the open window) has it, else a window around it.
  // (A layout effect, so the placement below sees it in the same commit.)
  const synchronized = conversation !== undefined && result._tag === "Success"
  useLayoutEffect(() => {
    if (target === undefined || !synchronized) return
    if (entries.some((e) => e.id === target.entryId)) {
      place.current = target
      return
    }
    let current = true
    const mark = newestOf(state.entries)
    setWin({ entryId: target.entryId, window: undefined, mark })
    void fetchWindow({ conversationId, entryId: target.entryId as TranscriptEntry["id"], limit: WINDOW_PAGE }).then((exit) => {
      if (!current) return
      if (Exit.isSuccess(exit)) {
        place.current = target
        setWin({ entryId: target.entryId, window: applyWindowPage(undefined, exit.value, "first"), mark })
      } else {
        setWin(undefined)
        toast({ title: "That message couldn't be opened. It may have been deleted.", tone: "danger" })
      }
    })
    return () => {
      current = false
    }
    // entries: only whether the target is in them when it changes (not on every new message)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, synchronized])

  // Scroll the target into view once its row is rendered: centered, lit up, its exchange opened.
  useLayoutEffect(() => {
    const t = place.current
    const el = scrollRef.current
    if (t === undefined || !el) return
    const found = rowOf(el, t.entryId)
    if (found === null) {
      // in the transcript but never shown as a row of its own (hidden kinds): stay where we are
      if (entries.some((e) => e.id === t.entryId) && rows.length > 0) place.current = undefined
      return
    }
    place.current = undefined
    stick.current = false
    centerIn(el, found.element)
    flash(found.element, t.link)
    if (t.link && t.openExchange && found.exchange) {
      const row = rows.find((r) => r.type === "exchange" && r.entries.some((e) => e.id === t.entryId))
      const entry = entries.find((e) => e.id === t.entryId)
      if (row?.type === "exchange" && entry) setExchange({ a: row.ownerBotId, b: row.peerBotId, target: { at: entry.createdAt, entryIds: [t.entryId] }, terms: t.terms })
    }
  }, [rows, entries, target, win])

  // The Find bar's hits (or a link's entry) with their words highlighted.
  const highlighted = useMemo(
    () => (find !== undefined ? { ids: find.hits, current: find.current, terms: find.terms } : target?.link && target.terms.length > 0 ? { ids: [target.entryId], current: target.entryId, terms: target.terms } : undefined),
    [find, target],
  )
  useTermHighlights(scrollRef, highlighted, rows)
  const newMessages = win?.window && !joined ? messagesAfter(state.entries, win.mark) : 0

  // ---------------------------------------------------------------------------------- send
  const [replyTo, setReplyTo] = useState<MessageEntry | undefined>()
  const onSubmit = (d: ComposerSubmit) => {
    if (win !== undefined) jumpToLatest()
    stick.current = true
    send({
      conversationId,
      text: d.text,
      ...(d.attachmentIds.length > 0 ? { attachmentIds: d.attachmentIds } : {}),
      ...(d.replyToId ? { replyToId: d.replyToId } : {}),
      ...(isGroup && d.addressedBotIds.length > 0 ? { addressedBotIds: d.addressedBotIds } : {}),
      ...(isGroup && d.addressEveryone ? { addressEveryone: true } : {}),
    })
    setReplyTo(undefined)
  }
  const [exchange, setExchange] = useState<{ readonly a: string; readonly b: string; readonly target: ExchangeTarget; readonly terms?: ReadonlyArray<string> } | undefined>(undefined)
  const authorName = (e: MessageEntry) => (e.author.kind === "bot" ? (roster.botById(e.author.botId)?.name ?? "Bot") : "you")

  const ctx: EventContext = {
    botById: roster.botById,
    openConversation: select,
    openBot: (id) => selectBot(id as BotId),
    openRoutines: () => details.show("details"),
    openExchange: (a, b, target) => setExchange({ a, b, target }),
  }
  const exchangeBots = exchange ? ([roster.botById(exchange.a), roster.botById(exchange.b)] as const) : undefined

  const session = primary ? conversation?.sessions?.find((s) => s.botId === primary.id && s.active) : undefined
  const contextUsage = !isGroup && primary && session?.contextUsage ? { botId: primary.id, botName: primary.name, usage: session.contextUsage } : undefined

  const renderRow = (row: Row, index: number): ReactNode => {
    switch (row.type) {
      case "timestamp":
        return <Timestamp key={row.key}>{formatTimestamp(row.at)}</Timestamp>
      case "new-divider":
        return <NewDivider key={row.key} className="my-1" />
      case "event":
        return (
          <div key={row.key} data-entry={row.entry.id}>
            <EventRow entry={row.entry} ctx={ctx} />
          </div>
        )
      case "exchange":
        return (
          <div key={row.key} data-entries={row.entries.map((e) => e.id).join(" ")}>
            <ExchangeLine ctx={ctx} peerBotId={row.peerBotId} ownerBotId={row.ownerBotId} entries={row.entries} />
          </div>
        )
      case "notice":
        return (
          <div key={row.key} data-entry={row.entry.id}>
            <NoticeRow entry={row.entry} />
          </div>
        )
      case "unknown":
        return (
          <div key={row.key} data-entry={row.entry.id}>
            <UnknownRow entry={row.entry} />
          </div>
        )
      case "steps":
        return (
          <div key={row.key} className={isGroup ? "ps-8" : undefined} data-turn={row.turnId}>
            <StepsDisclosure steps={row.steps} decisions={row.decisions} failed={row.failed} reveal={row.turnId === revealTurn ? target?.nonce : undefined} />
          </div>
        )
      case "card": {
        const author = row.entry.author.kind === "bot" ? roster.botById(row.entry.author.botId) : undefined
        return (
          <div key={row.key} className="flex flex-col items-start py-1" data-entry={row.entry.id}>
            {isGroup && author && <span className="mb-0.5 ps-3 text-xs text-fg-secondary">{author.name}</span>}
            <CardView card={row.entry.card} state={row.entry.state} request={requestForCard(row.entry, requests)} bot={author ?? primary} entryId={row.entry.id} />
          </div>
        )
      }
      case "group": {
        const continued = index === rows.length - 1 && row.side === "bot" && row.botId !== undefined && workingBots.includes(row.botId)
        const speaker = row.side === "bot" ? roster.botById(row.botId) : undefined
        const bubbles = row.items.map((it, i) => {
          const position = positionIn(i, row.items.length, continued)
          if (it.kind === "pending") {
            return (
              <PendingBubble
                key={it.pending.clientNonce}
                pending={it.pending}
                position={position}
                onResend={() => retry({ conversationId, clientNonce: it.pending.clientNonce })}
                onDelete={() => discard({ conversationId, clientNonce: it.pending.clientNonce })}
              />
            )
          }
          const e = it.entry
          return <MessageBubble key={e.id} entry={e} position={position} conversationId={conversationId} quoted={e.replyToId ? byId.get(e.replyToId) : undefined} onReply={setReplyTo} />
        })
        // Groups attribute every bot; a DM attributes messages from OTHER bots (message_bot, D5.2).
        const foreign = !isGroup && row.side === "bot" && row.botId !== undefined && primary !== undefined && row.botId !== primary.id
        if ((isGroup || foreign) && row.side === "bot") {
          return (
            <div key={row.key} className="flex flex-col py-1">
              <span className="mb-0.5 ps-[44px] text-xs text-fg-secondary">{speaker?.name ?? "Bot"}</span>
              <div className="flex items-end gap-2">
                <Avatar shape={speaker?.avatar.shape} color={speaker?.avatar.color} size={24} className="mb-1.5" />
                <div className="flex min-w-0 flex-1 flex-col gap-1" style={speaker && settings.accent === "bot" ? botTintStyle(speaker.avatar.color) : undefined}>
                  {bubbles}
                </div>
              </div>
            </div>
          )
        }
        return (
          <div key={row.key} className={cn("flex flex-col gap-1 py-1", row.side === "user" ? "items-end" : "items-start")}>
            {row.addressee !== undefined && <AddresseeChip bot={roster.botById(row.addressee)} onOpen={() => selectBot(row.addressee as BotId)} />}
            {bubbles}
          </div>
        )
      }
    }
  }

  /** One bot's status line: the activity row's look (avatar + shimmering phrase), one per bot. */
  const renderStatus = (status: ChatStatus): ReactNode => {
    const bot = roster.botById(status.botId)
    const named = (phrase: string) => (isGroup && bot ? `${phrase} · ${bot.name}` : phrase)
    const common = {
      className: cn(lastGroupBot === status.botId ? "mt-1" : "mt-2", isGroup && "ps-0"),
      avatar: <Avatar shape={bot?.avatar.shape} color={bot?.avatar.color} size={28} working expression="inspecting" eyeColor="var(--ob-chrome)" />,
      "data-bot": status.botId,
      "data-status": status.kind,
    }
    switch (status.kind) {
      case "turn": {
        const turn = activeTurns.find((t) => t.botId === status.botId)
        const phrase = activityPhrase({ activity: roster.state.activities.get(status.botId), turn, streaming: streamingBots.has(status.botId) })
        return <ActivityRow key={`status:${status.botId}`} {...common} label={named(phrase)} data-testid="activity" />
      }
      case "elsewhere": {
        const queued = status.queued ? " · your message is queued" : ""
        return (
          <ActivityRow
            key={`status:${status.botId}`}
            {...common}
            label={isGroup && bot ? `${bot.name} is busy in ${status.where}${queued}` : `Busy in ${status.where}${queued}`}
            onClick={() => select(status.conversationId)}
            title="Open that conversation"
            data-testid="busy-elsewhere"
          />
        )
      }
      case "handling":
        return (
          <ActivityRow
            key={`status:${status.botId}`}
            {...common}
            label={named(HANDLING)}
            onClick={() => details.show("tasks", status.botId)}
            title={bot ? `What ${bot.name} is working on` : "What's in progress"}
            data-testid="handling"
          />
        )
    }
  }

  const loading = result._tag === "Initial" || (!conversation && result._tag !== "Failure")
  const notFound = result._tag === "Failure"

  return (
    <main className="relative flex h-full min-w-0 flex-col bg-chrome" style={tint} aria-label={title || "Chat"} data-conversation={conversationId}>
      {mode === "desktop" ? (
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center px-16 pt-2.5">
        {title && (
          <HeaderPill
            className="pointer-events-auto"
            aria-label="View conversation details"
            aria-expanded={details.open}
            onClick={() => details.toggle()}
            avatar={
              isGroup ? (
                <AvatarStack size={24} outlineColor="var(--ob-elevated)" avatars={members.map((m) => ({ key: m.id, shape: m.avatar.shape, color: m.avatar.color }))} />
              ) : (
                <Avatar shape={primary?.avatar.shape} color={primary?.avatar.color} size={24} working={workingBots.length > 0} />
              )
            }
          >
            {title}
          </HeaderPill>
        )}
      </div>
      ) : (
        <div className="ob-chat-header pointer-events-none absolute inset-x-0 top-0 z-10 pt-[env(safe-area-inset-top)]" data-testid="chat-header">
          <div className="flex items-center gap-2 px-3 pt-2">
            <div className="flex w-11 shrink-0">{phone && <GlassButton icon={ChevronLeft} label="Back" onClick={nav.back} testId="chat-back" />}</div>
            <div className="flex min-w-0 flex-1 justify-center">
              {title && (
                <HeaderPill
                  className="pointer-events-auto h-11! bg-elevated/90! backdrop-blur-xl"
                  aria-label="View conversation details"
                  aria-expanded={details.open}
                  onClick={() => details.toggle()}
                  avatar={
                    isGroup ? (
                      <AvatarStack size={28} outlineColor="var(--ob-elevated)" avatars={members.map((m) => ({ key: m.id, shape: m.avatar.shape, color: m.avatar.color }))} />
                    ) : (
                      <Avatar shape={primary?.avatar.shape} color={primary?.avatar.color} size={28} working={workingBots.length > 0} />
                    )
                  }
                >
                  {title}
                </HeaderPill>
              )}
            </div>
            <div className="flex w-11 shrink-0 justify-end">
              {hasComputer && primary && <GlassButton icon={Monitor} label={`Open ${primary.name}'s computer`} onClick={() => computerView.open(primary.id)} testId="chat-computer" />}
            </div>
          </div>
        </div>
      )}
      {findOpen && findBar && (
        <FindBar
          conversationId={conversationId}
          focusNonce={findBar.nonce}
          kinds={showSteps ? [...DEFAULT_SEARCH_KINDS, "tool-call"] : undefined}
          layout={mode}
          onChange={setFind}
          onClose={() => setFindBar(null)}
        />
      )}
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin" data-testid="transcript" data-window={win !== undefined ? (joined ? "joined" : "open") : undefined} {...longPress}>
        <div
          className={cn(
            "mx-auto flex w-full max-w-[992px] flex-col pb-4",
            phone ? "px-3 pt-[calc(64px+env(safe-area-inset-top))]" : mode === "tablet" ? "px-4 pt-[calc(72px+env(safe-area-inset-top))]" : "px-4 pt-[72px]",
          )}
        >
          {findOpen && <div className="h-12 shrink-0" aria-hidden />}
          {(windowCursors !== undefined ? windowCursors.before !== null : state.hasMoreBefore) && (
            <div className="flex justify-center py-2 text-fg-tertiary">
              <Spinner size={14} />
            </div>
          )}
          {loading && (
            <div className="flex justify-center py-16 text-fg-tertiary">
              <Spinner size={18} label="Loading conversation" />
            </div>
          )}
          {notFound && <div className="py-16 text-center text-sm text-fg-secondary">This conversation is no longer available.</div>}
          {rows.map((row, i) => (
            <Fragment key={row.key}>{renderRow(row, i)}</Fragment>
          ))}
          {windowCursors?.after != null && (
            <div className="flex justify-center py-2 text-fg-tertiary">
              <Spinner size={14} />
            </div>
          )}
          {!inWindow && statuses.map((status) => renderStatus(status))}
        </div>
      </div>
      {win !== undefined && !joined ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-[84px] z-10 flex justify-center">
          <PillButton
            variant="secondary"
            size="sm"
            leadingIcon={ArrowDown}
            className="pointer-events-auto bg-elevated! shadow-popover hairline border-line-secondary"
            onClick={jumpToLatest}
            data-testid="jump-to-latest"
          >
            {newMessages > 0 ? `${newMessages} new ${newMessages === 1 ? "message" : "messages"}` : "Jump to latest"}
          </PillButton>
        </div>
      ) : (
        !atBottom && (
          <div className="pointer-events-none absolute inset-x-0 bottom-[84px] z-10 flex justify-center">
            <IconButton icon={ArrowDown} label="Scroll to bottom" variant="elevated" className="pointer-events-auto" onClick={win !== undefined ? jumpToLatest : scrollToBottom} />
          </div>
        )
      )}
      <div className={cn("mx-auto flex w-full max-w-[992px] flex-col gap-2", mode === "desktop" ? "px-4 pb-4" : "ob-composer-dock px-4 pb-[max(16px,env(safe-area-inset-bottom))]")}>
        {showTray && failed && (
          <div role="alert" className="ob-tray flex animate-rise-in items-start gap-2.5 rounded-4xl px-3 py-2.5" data-testid="error-tray">
            <WarnIcon className="mt-0.5" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-xs font-medium text-fg">{members.length === 1 ? "Bot failed to respond" : `${roster.botById(failed.botId)?.name ?? "A Bot"} failed to respond`}</span>
              <span className="text-sm text-fg-secondary">{failed.failure?.message ?? "Something went wrong while replying."}</span>
              <div className="mt-1.5 flex gap-2">
                {failed.failure?.code === "auth" && (
                  // the harness's login on the brain's computer expired: Settings › Harnesses shows how to sign in
                  <PillButton variant="primary" size="sm" onClick={() => settingsDialog.show("harnesses")}>
                    Sign in
                  </PillButton>
                )}
                <PillButton variant={failed.failure?.code === "auth" ? "secondary" : "primary"} size="sm" onClick={() => void retryFailed(failed)}>
                  Retry
                </PillButton>
              </div>
            </div>
            <IconButton icon={X} label="Dismiss" size={24} onClick={() => setDismissed((s) => new Set(s).add(failed.id))} />
          </div>
        )}
        <Composer
          draftKey={conversationId}
          placeholder={isGroup ? `Message ${title || "group"}` : `Message ${primary?.name ?? "Bot"}`}
          mentionable={isGroup ? members : roster.bots.filter((b) => !botIds.includes(b.id) && !b.hidden)}
          members={isGroup ? members : []}
          allowEveryone={isGroup}
          working={activeTurns.length > 0}
          onStop={() => interrupt({ conversationId })}
          onSubmit={onSubmit}
          replyTo={replyTo}
          replyAuthor={replyTo ? authorName(replyTo) : undefined}
          onCancelReply={() => setReplyTo(undefined)}
          context={contextUsage}
          autoFocus
          onCall={!isGroup && primary !== undefined && voiceCalls.value?.state === "ready" && call.botId !== primary.id ? () => void startCall(primary.id) : undefined}
        />
      </div>
      {sheetEntry && (
        <MessageSheet
          entry={sheetEntry}
          conversationId={conversationId}
          authorName={authorName(sheetEntry) === "you" ? "You" : authorName(sheetEntry)}
          onReply={setReplyTo}
          onClose={() => setSheetEntry(undefined)}
        />
      )}
      {exchange && exchangeBots?.[0] && exchangeBots[1] && (
        <ExchangeDialog a={exchangeBots[0]} b={exchangeBots[1]} target={exchange.target} terms={exchange.terms} onClose={() => setExchange(undefined)} onOpenConversation={select} />
      )}
    </main>
  )
}

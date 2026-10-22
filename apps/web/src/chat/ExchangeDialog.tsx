// The bot-to-bot exchange (Grok's "2 messages with ‹Bot›" line → the conversation between the
// agents): every message_bot / handoff_task message between bots A and B, both directions, in order.
// Paged from the brain (`conversations.exchange`, both direct conversations at once): it opens
// around the clicked line's message(s), which light up (a search hit's words marked as in the chat),
// and loads older / newer pages near the
// edges while scrolling (older ones keep the scroll position). Once the window reaches the newest
// message, new ones arrive live from the two direct-conversation replicas (B → A lives in A's DM,
// A → B in B's; the open chat's is already live, the other subscribes while this is open).
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { commandAtom, conversationAtom } from "@openbot/client"
import { type Bot, type ConversationId, emptyConversationState } from "@openbot/contracts"
import { Avatar, Bubble, Dialog, DialogBody, DialogFooter, DialogHeader, PillButton, Spinner } from "@openbot/ui"
import { Exit } from "effect"
import { ArrowLeftRight } from "lucide-react"
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { valueOr } from "../app/data.ts"
import { formatTimestamp } from "../app/format.ts"
import { Attachments } from "./Attachments.tsx"
import { useTermHighlights } from "./find.ts"
import { anchorIdIn, applyPage, type ExchangeTarget, type ExchangeWindow, targetIdsIn, withLive } from "./exchange.ts"
import { exchangeBetween } from "./grouping.ts"
import { Markdown } from "./Markdown.tsx"

/** Messages per `conversations.exchange` page. */
const PAGE = 30
/** Load the next page when the view is this close to an edge (px). */
const EDGE = 240
/** Space kept above the target when it does not fit centered (px). */
const INSET = 12
/** Its own highlights: the chat under the dialog keeps its own. */
const EXCHANGE_HIGHLIGHTS = { attribute: "data-exchange-item", name: "ob-find-exchange" }

export interface ExchangeDialogProps {
  /** The bot whose chat is open. */
  readonly a: Bot
  /** The other bot. */
  readonly b: Bot
  /** The message(s) the clicked line stands for; absent = open at the newest message. */
  readonly target?: ExchangeTarget | undefined
  /** A search hit's matched words, marked in the target message(s). */
  readonly terms?: ReadonlyArray<string> | undefined
  readonly onClose: () => void
  readonly onOpenConversation: (id: ConversationId) => void
}

export function ExchangeDialog({ a, b, target, terms, onClose, onOpenConversation }: ExchangeDialogProps): ReactNode {
  const ra = useAtomValue(conversationAtom(a.directConversationId))
  const rb = useAtomValue(conversationAtom(b.directConversationId))
  const sa = valueOr(ra, emptyConversationState)
  const sb = valueOr(rb, emptyConversationState)
  const live = useMemo(() => exchangeBetween(a.id, b.id, [[...sa.entries.values()], [...sb.entries.values()]]), [a.id, b.id, sa.entries, sb.entries])
  const fetchPage = useAtomSet(commandAtom("conversations.exchange", "exchange-dialog"), { mode: "promiseExit" })
  const bots = new Map([[a.id as string, a], [b.id as string, b]])

  // ------------------------------------------------------------------------------- paging
  const [win, setWin] = useState<ExchangeWindow | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const busy = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** scrollHeight before an older page was prepended (the layout effect keeps the view in place). */
  const prepended = useRef<number | null>(null)
  const placed = useRef(false)
  /** At the bottom of a window that reaches the newest message: follow live messages. */
  const stick = useRef(false)

  // The first page: around the target, else the newest messages.
  useEffect(() => {
    let current = true
    busy.current = true
    void fetchPage({ botId: a.id, peerBotId: b.id, limit: PAGE, ...(target ? { at: target.at } : {}) }).then((exit) => {
      if (!current) return
      busy.current = false
      if (Exit.isSuccess(exit)) setWin(applyPage(undefined, exit.value, "first"))
      else setFailed(true)
    })
    return () => {
      current = false
    }
  }, [fetchPage, a.id, b.id, target])

  const loadMore = useCallback(
    (side: "older" | "newer", cursor: string) => {
      if (busy.current) return
      busy.current = true
      void fetchPage({ botId: a.id, peerBotId: b.id, limit: PAGE, ...(side === "older" ? { before: cursor } : { after: cursor }) }).then((exit) => {
        busy.current = false
        if (!Exit.isSuccess(exit)) return
        if (side === "older" && scrollRef.current) prepended.current = scrollRef.current.scrollHeight
        setWin((w) => applyPage(w, exit.value, side))
      })
    },
    [fetchPage, a.id, b.id],
  )

  const items = useMemo(() => (win === undefined ? [] : withLive(win, live)), [win, live])
  const targetIds = useMemo(() => new Set(target ? targetIdsIn(items, target) : []), [items, target])
  const highlighted = useMemo(() => (terms && terms.length > 0 && targetIds.size > 0 ? { ids: [...targetIds], current: [...targetIds][0], terms } : undefined), [terms, targetIds])
  useTermHighlights(scrollRef, highlighted, items, EXCHANGE_HIGHLIGHTS)

  // ------------------------------------------------------------------------------ scroll
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || win === undefined) return
    if (!placed.current) {
      // Open at the clicked line's message(s): centered when they fit, else from their start.
      placed.current = true
      const marked = [...el.querySelectorAll<HTMLElement>("[data-exchange-item][data-target]")]
      const id = target ? anchorIdIn(items, target) : undefined
      const first = marked[0] ?? (id === undefined ? null : el.querySelector<HTMLElement>(`[data-exchange-item="${CSS.escape(id)}"]`))
      if (first) {
        const box = el.getBoundingClientRect().top
        const top = first.getBoundingClientRect().top - box
        const bottom = (marked[marked.length - 1] ?? first).getBoundingClientRect().bottom - box
        const room = el.clientHeight - (bottom - top)
        el.scrollTop += room > 2 * INSET ? top - room / 2 : top - INSET
      } else el.scrollTop = el.scrollHeight
    } else if (prepended.current !== null) {
      el.scrollTop += el.scrollHeight - prepended.current
    } else if (stick.current) el.scrollTop = el.scrollHeight
    prepended.current = null
    stick.current = win.afterCursor === null && el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }, [items, win, target])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el || win === undefined || !placed.current) return
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stick.current = win.afterCursor === null && fromBottom < 24
    if (el.scrollTop < EDGE && win.beforeCursor !== null) loadMore("older", win.beforeCursor)
    else if (fromBottom < EDGE && win.afterCursor !== null) loadMore("newer", win.afterCursor)
  }, [win, loadMore])
  // A window that does not fill the view (or opened near an edge) loads on without a scroll.
  useEffect(onScroll, [onScroll])

  const edgeSpinner = (
    <div className="flex justify-center py-1 text-fg-tertiary">
      <Spinner size={14} />
    </div>
  )

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width={560} label={`${a.name} and ${b.name}`} className="ob-phone-full">
      <DialogHeader
        title={
          <span className="flex min-w-0 items-center gap-2" data-testid="exchange-title">
            <Avatar shape={a.avatar.shape} color={a.avatar.color} size={22} className="shrink-0" />
            <span className="min-w-0 truncate">{a.name}</span>
            <ArrowLeftRight className="size-4 shrink-0 text-icon-tertiary" aria-label="and" />
            <Avatar shape={b.avatar.shape} color={b.avatar.color} size={22} className="shrink-0" />
            <span className="min-w-0 truncate">{b.name}</span>
          </span>
        }
        description={`Messages ${a.name} and ${b.name} sent each other`}
        onClose={onClose}
      />
      <DialogBody ref={scrollRef} onScroll={onScroll} className="max-h-[60vh] [overflow-anchor:none] max-md:max-h-none">
        <div className="flex flex-col gap-3" data-testid="exchange">
        {win?.beforeCursor != null && edgeSpinner}
        {win === undefined && !failed ? (
          <div className="flex justify-center py-8 text-fg-tertiary">
            <Spinner size={16} label="Loading" />
          </div>
        ) : failed ? (
          <p className="py-6 text-center text-sm text-fg-secondary">These messages couldn't be loaded. Try again in a moment.</p>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-fg-secondary">No messages between them yet.</p>
        ) : (
          items.map((e) => {
            const from = bots.get(e.author.kind === "bot" ? e.author.botId : "")
            const to = bots.get(e.toBotId ?? "")
            return (
              <div key={e.id} className="flex items-end gap-2" data-exchange-item={e.id} data-target={targetIds.has(e.id) || undefined}>
                <Avatar shape={from?.avatar.shape} color={from?.avatar.color} size={24} className="mb-1.5" />
                <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                  <span className="flex flex-wrap items-center gap-x-1.5 ps-3 text-xs whitespace-nowrap text-fg-secondary">
                    <span className="text-fg">{from?.name ?? "Bot"}</span>
                    <span>to {to?.name ?? "Bot"}</span>
                    <span aria-hidden>·</span>
                    <button
                      type="button"
                      className="hover:text-fg hover:underline"
                      title={`Open ${to?.name ?? "the"} chat at this message`}
                      onClick={() => {
                        if (to) onOpenConversation(to.directConversationId)
                        onClose()
                      }}
                    >
                      {formatTimestamp(e.createdAt)}
                    </button>
                  </span>
                  {e.attachments.length > 0 && <Attachments items={e.attachments} side="bot" />}
                  {e.text.trim() !== "" && (
                    <Bubble side="bot" className="max-w-full">
                      <Markdown text={e.text} />
                    </Bubble>
                  )}
                </div>
              </div>
            )
          })
        )}
        {win?.afterCursor != null && edgeSpinner}
        </div>
      </DialogBody>
      <DialogFooter>
        <PillButton variant="secondary" size="card" onClick={onClose}>
          Close
        </PillButton>
        <PillButton
          variant="primary"
          size="card"
          onClick={() => {
            onOpenConversation(b.directConversationId)
            onClose()
          }}
        >
          Open {b.name}'s chat
        </PillButton>
      </DialogFooter>
    </Dialog>
  )
}

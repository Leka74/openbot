// The Search view (`#/search?q=…`): searches every chat's messages from the chat column, with filter
// chips — Bot (several), Chat (one, or every group chat), From (you, a Bot, OpenBot), Date (24 h,
// 7 / 30 days or a range of days), Type (messages, cards, events, task results; tool steps only when
// asked for) — and Relevant / Newest. The filters live in the URL, so reload and Back keep them.
// Results are one flat list paged as it scrolls; a hit opens its chat at that message
// (`#/c/<id>/e/<entryId>`). On a phone it is a full screen of its own with a back button.
import { Calendar, Check, ChevronDown, ChevronLeft, MessageSquare, Search, SlidersHorizontal, User, Users, X } from "lucide-react"
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Exit } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type ConversationId, SEARCH_QUERY_MAX_CHARS, SEARCH_TOTAL_CAP, type SearchHit, type SearchSender } from "@openbot/contracts"
import {
  appendPage,
  dayOf,
  DEFAULT_SEARCH_TYPES,
  hitEntryId,
  hitKey,
  isDefaultTypes,
  isSearchable,
  normalizeTypes,
  resultCount,
  SEARCH_TYPES,
  searchQueryOf,
  type SearchDate,
  type SearchFilters,
  type SearchResults,
  type SearchType,
} from "@openbot/app-model"
import { commandAtom, SEARCH_PAGE_SIZE, searchFirstPageAtom, searchIdleAtom } from "@openbot/client"
import { Avatar, IconButton, Icon, Popover, Spinner, cn } from "@openbot/ui"
import { type RosterView, useRoster } from "../app/data.ts"
import { useLayoutMode } from "../app/layout.ts"
import { useSelection } from "../app/uiState.ts"
import { useDebouncedValue } from "../details/skills.ts"
import { chatLabel, HitLeading, HitMeta, Snippet } from "./hits.tsx"

const TYPE_LABEL: Readonly<Record<SearchType, string>> = { messages: "Messages", cards: "Cards", events: "Events", tasks: "Task results", steps: "Steps" }
const DATE_LABEL = { any: "Any time", "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days" } as const

const dateLabel = (date: SearchDate): string => {
  if (typeof date === "string") return DATE_LABEL[date]
  const day = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })
  if (date.from && date.to) return date.from === date.to ? day(date.from) : `${day(date.from)} – ${day(date.to)}`
  return date.from ? `Since ${day(date.from)}` : `Until ${day(date.to!)}`
}

/** A filter chip: its label, highlighted when set, opening a panel. */
function Chip({ label, active, icon, children, testId }: { readonly label: string; readonly active: boolean; readonly icon: typeof User; readonly children: (close: () => void) => ReactNode; readonly testId: string }): ReactNode {
  return (
    <Popover
      role="menu"
      label={label}
      align="start"
      className="rounded-2xl"
      trigger={(p) => (
        <button
          {...p}
          type="button"
          data-testid={testId}
          data-active={active || undefined}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full ps-2.5 pe-2 text-sm whitespace-nowrap transition-colors duration-100",
            active ? "bg-accent-soft text-accent-fg hover:bg-accent-soft-hover" : "bg-secondary text-fg hover:bg-secondary-hover",
          )}
        >
          <Icon icon={icon} size="sm" className={active ? "text-accent-fg" : "text-icon-secondary"} />
          {label}
          <ChevronDown size={14} aria-hidden className="opacity-70" />
        </button>
      )}
    >
      {(close) => <div className="flex max-h-[min(420px,70vh)] min-w-[220px] flex-col gap-px overflow-y-auto p-1.5 scrollbar-thin">{children(close)}</div>}
    </Popover>
  )
}

/** One row of a chip's panel; checked rows show a check. Multi-select rows keep the panel open. */
function Option({ children, checked, onSelect, leading }: { readonly children: ReactNode; readonly checked: boolean; readonly onSelect: () => void; readonly leading?: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onSelect}
      className="flex min-h-[30px] w-full items-center gap-2 rounded-md px-2 text-start text-sm text-fg transition-colors duration-100 hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
    >
      {leading}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {checked && <Check size={14} className="shrink-0 text-icon" aria-hidden />}
    </button>
  )
}

const Separator = () => <div role="separator" className="mx-2 my-1 h-0 border-t-[0.5px] border-line-secondary" />

function Filters({ roster, filters, onChange }: { readonly roster: RosterView; readonly filters: SearchFilters; readonly onChange: (f: SearchFilters) => void }): ReactNode {
  const bots = roster.bots.filter((b) => !b.hidden || filters.botIds.includes(b.id))
  const groups = [...roster.state.conversations.values()].filter((c) => c.kind === "group").sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  const botLabel =
    filters.botIds.length === 0 ? "Bot" : filters.botIds.length === 1 ? (roster.botById(filters.botIds[0])?.name ?? "1 Bot") : `${filters.botIds.length} Bots`
  const chatName = filters.chat === undefined ? "Chat" : filters.chat === "groups" ? "Group chats" : chatLabel(roster, { conversationId: filters.chat })
  const fromLabel =
    filters.sender === undefined ? "From" : filters.sender === "owner" ? "From you" : filters.sender === "system" ? "From OpenBot" : `From ${roster.botById(filters.sender)?.name ?? "a Bot"}`
  const types = normalizeTypes(filters.types)
  const typeLabel = isDefaultTypes(types) ? "Type" : types.length === 1 ? TYPE_LABEL[types[0]!] : types.length === SEARCH_TYPES.length ? "Everything" : `${types.length} types`
  const [range, setRange] = useState<{ from: string; to: string }>(() => (typeof filters.date === "object" ? { from: filters.date.from ?? "", to: filters.date.to ?? "" } : { from: "", to: "" }))
  const toggle = <A,>(list: ReadonlyArray<A>, x: A) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x])

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]" data-testid="search-filters">
      <Chip label={botLabel} active={filters.botIds.length > 0} icon={Users} testId="filter-bot">
        {() => (
          <>
            {filters.botIds.length > 0 && (
              <>
                <Option checked={false} onSelect={() => onChange({ ...filters, botIds: [] })}>
                  Any Bot
                </Option>
                <Separator />
              </>
            )}
            {bots.map((b) => (
              <Option key={b.id} checked={filters.botIds.includes(b.id)} onSelect={() => onChange({ ...filters, botIds: toggle(filters.botIds, b.id) })} leading={<Avatar shape={b.avatar.shape} color={b.avatar.color} size={18} />}>
                {b.name}
              </Option>
            ))}
          </>
        )}
      </Chip>
      <Chip label={chatName} active={filters.chat !== undefined} icon={MessageSquare} testId="filter-chat">
        {(close) => {
          const set = (chat: ConversationId | "groups" | undefined) => {
            const { chat: _, ...rest } = filters
            onChange(chat === undefined ? rest : { ...rest, chat })
            close()
          }
          return (
            <>
              <Option checked={filters.chat === undefined} onSelect={() => set(undefined)}>
                Every chat
              </Option>
              <Option checked={filters.chat === "groups"} onSelect={() => set("groups")}>
                Group chats
              </Option>
              <Separator />
              {roster.bots
                .filter((b) => !b.hidden)
                .map((b) => (
                  <Option key={b.id} checked={filters.chat === b.directConversationId} onSelect={() => set(b.directConversationId)} leading={<Avatar shape={b.avatar.shape} color={b.avatar.color} size={18} />}>
                    {b.name}
                  </Option>
                ))}
              {groups.length > 0 && <Separator />}
              {groups.map((g) => (
                <Option key={g.id} checked={filters.chat === g.id} onSelect={() => set(g.id)} leading={<Icon icon={Users} size="sm" className="text-icon-secondary" />}>
                  {g.title || chatLabel(roster, { conversationId: g.id })}
                </Option>
              ))}
            </>
          )
        }}
      </Chip>
      <Chip label={fromLabel} active={filters.sender !== undefined} icon={User} testId="filter-from">
        {(close) => {
          const set = (sender: SearchSender | undefined) => {
            const { sender: _, ...rest } = filters
            onChange(sender === undefined ? rest : { ...rest, sender })
            close()
          }
          return (
            <>
              <Option checked={filters.sender === undefined} onSelect={() => set(undefined)}>
                Anyone
              </Option>
              <Option checked={filters.sender === "owner"} onSelect={() => set("owner")}>
                You
              </Option>
              <Option checked={filters.sender === "system"} onSelect={() => set("system")}>
                OpenBot
              </Option>
              <Separator />
              {bots.map((b) => (
                <Option key={b.id} checked={filters.sender === b.id} onSelect={() => set(b.id)} leading={<Avatar shape={b.avatar.shape} color={b.avatar.color} size={18} />}>
                  {b.name}
                </Option>
              ))}
            </>
          )
        }}
      </Chip>
      <Chip label={filters.date === "any" ? "Date" : dateLabel(filters.date)} active={filters.date !== "any"} icon={Calendar} testId="filter-date">
        {(close) => (
          <>
            {(["any", "24h", "7d", "30d"] as const).map((d) => (
              <Option
                key={d}
                checked={filters.date === d}
                onSelect={() => {
                  onChange({ ...filters, date: d })
                  close()
                }}
              >
                {DATE_LABEL[d]}
              </Option>
            ))}
            <Separator />
            <div className="flex flex-col gap-1.5 px-2 py-1.5 text-xs text-fg-secondary">
              Between days
              <div className="flex items-center gap-1.5">
                <input
                  type="date"
                  aria-label="From day"
                  value={range.from}
                  max={range.to || dayOf(Date.now())}
                  onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
                  className="h-8 min-w-0 flex-1 rounded-md bg-secondary px-2 text-sm text-fg outline-none"
                />
                <span aria-hidden>–</span>
                <input
                  type="date"
                  aria-label="To day"
                  value={range.to}
                  min={range.from || undefined}
                  onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
                  className="h-8 min-w-0 flex-1 rounded-md bg-secondary px-2 text-sm text-fg outline-none"
                />
              </div>
              <button
                type="button"
                disabled={range.from === "" && range.to === ""}
                onClick={() => {
                  onChange({ ...filters, date: { ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}) } })
                  close()
                }}
                className="mt-0.5 h-8 rounded-full bg-primary text-sm text-fg-inverted hover:bg-primary-hover disabled:opacity-40"
              >
                Apply
              </button>
            </div>
          </>
        )}
      </Chip>
      <Chip label={typeLabel} active={!isDefaultTypes(types)} icon={SlidersHorizontal} testId="filter-type">
        {() => (
          <>
            {SEARCH_TYPES.map((t) => (
              <Option
                key={t}
                checked={types.includes(t)}
                onSelect={() => {
                  const next = toggle(types, t)
                  onChange({ ...filters, types: next.length === 0 ? DEFAULT_SEARCH_TYPES : normalizeTypes(next) })
                }}
              >
                {TYPE_LABEL[t]}
                {t === "steps" && <span className="ms-1.5 text-xs text-fg-tertiary">tool calls</span>}
              </Option>
            ))}
          </>
        )}
      </Chip>
      <div className="ms-auto flex shrink-0 items-center rounded-full bg-secondary p-0.5 text-sm" role="radiogroup" aria-label="Sort">
        {(["relevance", "newest"] as const).map((sort) => (
          <button
            key={sort}
            type="button"
            role="radio"
            aria-checked={filters.sort === sort}
            onClick={() => onChange({ ...filters, sort })}
            className={cn("h-7 rounded-full px-2.5 transition-colors duration-100", filters.sort === sort ? "bg-elevated text-fg shadow-control" : "text-fg-secondary hover:text-fg")}
            data-testid={`sort-${sort}`}
          >
            {sort === "relevance" ? "Relevant" : "Newest"}
          </button>
        ))}
      </div>
    </div>
  )
}

function HitRow({ roster, hit, onOpen }: { readonly roster: RosterView; readonly hit: SearchHit; readonly onOpen: (hit: SearchHit) => void }): ReactNode {
  return (
    <button
      type="button"
      onClick={() => onOpen(hit)}
      className="flex w-full items-start gap-3 rounded-2xl px-3 py-2.5 text-start transition-colors duration-100 hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
      data-testid="search-hit"
      data-hit={hitKey(hit)}
    >
      <span className="mt-0.5 shrink-0">
        <HitLeading roster={roster} hit={hit} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <HitMeta roster={roster} hit={hit} />
        <Snippet hit={hit} className="line-clamp-3 text-base break-words text-fg" />
      </span>
    </button>
  )
}

export function SearchView({ filters, onClose }: { readonly filters: SearchFilters; readonly onClose: () => void }): ReactNode {
  const roster = useRoster()
  const { select, openSearch } = useSelection()
  const mode = useLayoutMode()
  const phone = mode === "phone"
  const [text, setText] = useState(filters.q)
  // typing replaces the URL as it settles; picking filters does at once
  const settled = useDebouncedValue(text, 150)
  useEffect(() => {
    if (settled !== filters.q) openSearch({ ...filters, q: settled })
  }, [settled]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setText((t) => (t === filters.q ? t : filters.q)), [filters.q]) // eslint-disable-line react-hooks/exhaustive-deps

  const groupIds = useMemo(() => [...roster.state.conversations.values()].filter((c) => c.kind === "group").map((c) => c.id), [roster.state.conversations])
  // `now` is fixed per search, so a page's query stays the same while it is open
  const now = useMemo(() => Date.now(), [filters]) // eslint-disable-line react-hooks/exhaustive-deps
  const input = useMemo(() => ({ ...searchQueryOf(filters, { now, groupIds }), limit: SEARCH_PAGE_SIZE }), [filters, now, groupIds])
  const searchable = isSearchable(filters.q)
  const first = useAtomValue(searchable ? searchFirstPageAtom(input) : searchIdleAtom)
  const fetchMore = useAtomSet(commandAtom("search.query", "search-view"), { mode: "promiseExit" })

  // the first page, then the pages after it
  const [results, setResults] = useState<SearchResults | undefined>(undefined)
  const [moreFailed, setMoreFailed] = useState(false)
  useEffect(() => {
    setResults(AsyncResult.isSuccess(first) ? appendPage(undefined, first.value) : undefined)
    setMoreFailed(false)
  }, [first])
  const loading = useRef(false)
  const loadMore = useCallback(() => {
    if (loading.current || results?.nextCursor == null) return
    loading.current = true
    const cursor = results.nextCursor
    void fetchMore({ ...input, cursor }).then((exit) => {
      loading.current = false
      if (Exit.isSuccess(exit)) setResults((r) => (r?.nextCursor === cursor ? appendPage(r, exit.value) : r))
      else setMoreFailed(true)
    })
  }, [results, input, fetchMore])
  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinel.current
    if (!el || results?.nextCursor == null || moreFailed) return
    const io = new IntersectionObserver((seen) => seen.some((s) => s.isIntersecting) && loadMore(), { rootMargin: "400px" })
    io.observe(el)
    return () => io.disconnect()
  }, [results, loadMore, moreFailed])

  const open = (hit: SearchHit) => {
    const entryId = hitEntryId(hit)
    select(hit.conversationId, { entryId, terms: results?.terms ?? [], openExchange: true })
  }

  const busy = searchable && (AsyncResult.isInitial(first) || first.waiting || settled !== text)
  const failed = AsyncResult.isFailure(first)
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <main className="relative flex h-full min-w-0 flex-col bg-chrome" aria-label="Search" data-testid="search-view">
      <div className={cn("mx-auto flex w-full max-w-[992px] shrink-0 flex-col gap-2.5 px-4 pb-2.5", phone ? "pt-[calc(6px+env(safe-area-inset-top))]" : mode === "tablet" ? "pt-[calc(12px+env(safe-area-inset-top))]" : "pt-4")}>
        <div className="flex items-center gap-2">
          {phone && <IconButton icon={ChevronLeft} label="Back" size={44} className="-ms-2" onClick={onClose} data-testid="search-back" />}
          <div className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full bg-secondary ps-3.5 pe-1.5">
            <Icon icon={Search} size="md" className="shrink-0 text-icon-tertiary" />
            <input
              ref={inputRef}
              autoFocus={!phone || filters.q === ""}
              value={text}
              maxLength={SEARCH_QUERY_MAX_CHARS}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && text !== "") {
                  e.preventDefault()
                  setText("")
                }
              }}
              placeholder="Search messages"
              aria-label="Search messages"
              enterKeyHint="search"
              spellCheck={false}
              className={cn("min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-tertiary focus-visible:outline-none", phone ? "text-[17px]" : "text-lg")}
              data-testid="search-input"
            />
            {text !== "" && (
              <IconButton
                icon={X}
                label="Clear"
                size={28}
                onClick={() => {
                  setText("")
                  inputRef.current?.focus()
                }}
              />
            )}
          </div>
          {!phone && <IconButton icon={X} label="Close search" size={36} onClick={onClose} data-testid="search-close" />}
        </div>
        <Filters roster={roster} filters={filters} onChange={openSearch} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin" data-testid="search-results">
        <div className="mx-auto flex w-full max-w-[992px] flex-col px-2 pb-8">
          {!searchable ? (
            <p className="px-3 py-16 text-center text-sm text-fg-tertiary">Search every chat: words, or "an exact phrase"; -word leaves it out.</p>
          ) : failed && results === undefined ? (
            <p className="px-3 py-16 text-center text-sm text-fg-secondary">Search didn't work. Check the words and try again.</p>
          ) : results === undefined ? (
            <div className="flex justify-center py-16 text-fg-tertiary">
              <Spinner size={18} label="Searching" />
            </div>
          ) : (
            <>
              <div className="flex h-8 items-center gap-2 px-3 text-xs text-fg-tertiary" aria-live="polite" data-testid="search-count">
                {results.hits.length === 0 ? "No results" : resultCount(results.totalCapped, SEARCH_TOTAL_CAP)}
                {results.indexing && <span>· Still indexing; some results may be missing</span>}
                {busy && <Spinner size={12} label="Searching" />}
              </div>
              {results.hits.map((hit) => (
                <HitRow key={hitKey(hit)} roster={roster} hit={hit} onOpen={open} />
              ))}
              {results.nextCursor !== null && (
                <div ref={sentinel} className="flex justify-center py-4 text-fg-tertiary">
                  {moreFailed ? (
                    <button type="button" className="text-sm text-fg-secondary hover:text-fg" onClick={() => (setMoreFailed(false), loadMore())}>
                      Couldn't load more. Try again
                    </button>
                  ) : (
                    <Spinner size={14} label="Loading more" />
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  )
}

// In-chat Find (Cmd/Ctrl+F while a chat is the main view): a small bar under the header pill (a
// full-width one under the glass header on a phone or tablet) with the query, "3 of 17", ↑ (older) /
// ↓ (newer) and ×. It asks the brain for every hit in the chat (`search.inConversation`, oldest
// first), starts at the newest and reports the hit on screen and the matched terms; the chat jumps
// to it and highlights them. Enter / ↑ go to the older hit, Shift+Enter / ↓ to the newer one, Esc
// closes.
import { ChevronDown, ChevronUp, Search, X } from "lucide-react"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { useAtomValue } from "@effect/atom-react"
import type { ConversationId, SearchKind } from "@openbot/contracts"
import { findLabel, findStart, findStep, type FindPosition } from "@openbot/app-model"
import { searchIdleAtom, searchPositionsAtom } from "@openbot/client"
import { Icon, IconButton, Spinner, cn } from "@openbot/ui"
import { AsyncResult } from "effect/reactivity"
import { useDebouncedValue } from "../details/skills.ts"

/** What the chat shows for the Find bar: every hit, the one on screen and the words to highlight. */
export interface FindState {
  readonly hits: ReadonlyArray<string>
  readonly current: string | undefined
  /** Changes on every step, so stepping back to the same hit jumps again. */
  readonly step: number
  readonly terms: ReadonlyArray<string>
}

export interface FindBarProps {
  readonly conversationId: ConversationId
  /** Changes when Cmd/Ctrl+F is pressed again: focus and select the query. */
  readonly focusNonce: number
  /** Kinds to find (tool steps only when the chat shows them). */
  readonly kinds?: ReadonlyArray<SearchKind> | undefined
  readonly layout: "desktop" | "tablet" | "phone"
  readonly onChange: (state: FindState | undefined) => void
  readonly onClose: () => void
}

export function FindBar({ conversationId, focusNonce, kinds, layout, onChange, onClose }: FindBarProps): ReactNode {
  const [query, setQuery] = useState("")
  const settled = useDebouncedValue(query.trim(), 200)
  const atom = useMemo(() => (settled === "" ? searchIdleAtom : searchPositionsAtom(conversationId, settled, kinds)), [conversationId, settled, kinds])
  const result = useAtomValue(atom)
  const [position, setPosition] = useState<FindPosition>(() => findStart([]))
  const [step, setStep] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const value = AsyncResult.isSuccess(result) ? result.value : undefined
  const failed = AsyncResult.isFailure(result)
  const searching = settled !== query.trim() || (settled !== "" && (AsyncResult.isInitial(result) || result.waiting))

  // new hits: start at the newest
  useEffect(() => {
    setPosition(findStart(value === undefined ? [] : value.hits.map((h) => h.entryId)))
    setStep((s) => s + 1)
  }, [value])

  const report = useRef(onChange)
  report.current = onChange
  useEffect(() => {
    if (settled === "" || value === undefined) return report.current(undefined)
    report.current({ hits: position.hits, current: position.hits[position.index], step, terms: value.terms })
  }, [position, step, value, settled])
  useEffect(() => () => report.current(undefined), [])

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusNonce])

  const go = (direction: "older" | "newer") => {
    if (position.hits.length === 0) return
    setPosition((p) => findStep(p, direction))
    setStep((s) => s + 1)
  }

  const label = settled === "" ? "" : failed ? "Couldn't search" : value === undefined ? "" : findLabel(position, value.more)
  const phone = layout === "phone"
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 z-20 flex justify-center",
        layout === "desktop" ? "top-[58px] px-4" : "top-[calc(60px+env(safe-area-inset-top))] px-3",
      )}
    >
      <div
        role="search"
        aria-label="Find in chat"
        data-testid="find-bar"
        className={cn(
          "pointer-events-auto flex h-11 w-full animate-rise-in items-center gap-1 rounded-full bg-elevated ps-3.5 pe-1.5 hairline border-line-secondary shadow-popover",
          !phone && "max-w-[460px]",
        )}
      >
        <Icon icon={Search} size="sm" className="shrink-0 text-icon-tertiary" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault()
              e.stopPropagation()
              onClose()
            } else if (e.key === "Enter") {
              e.preventDefault()
              go(e.shiftKey ? "newer" : "older")
            } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault()
              go(e.key === "ArrowUp" ? "older" : "newer")
            }
          }}
          placeholder="Find in chat"
          aria-label="Find in chat"
          enterKeyHint="search"
          spellCheck={false}
          autoComplete="off"
          className={cn("min-w-0 flex-1 bg-transparent px-1.5 text-fg outline-none placeholder:text-fg-tertiary focus-visible:outline-none", phone ? "text-[16px]" : "text-base")}
          data-testid="find-input"
        />
        <span className="flex shrink-0 items-center px-1 text-xs whitespace-nowrap text-fg-tertiary tabular-nums" aria-live="polite" data-testid="find-count">
          {searching && settled !== "" ? <Spinner size={12} label="Searching" /> : label}
        </span>
        <IconButton icon={ChevronUp} label="Older match" size={phone ? 36 : 28} disabled={position.hits.length === 0} onClick={() => go("older")} data-testid="find-older" />
        <IconButton icon={ChevronDown} label="Newer match" size={phone ? 36 : 28} disabled={position.hits.length === 0} onClick={() => go("newer")} data-testid="find-newer" />
        <IconButton icon={X} label="Close" size={phone ? 36 : 28} onClick={onClose} data-testid="find-close" />
      </div>
    </div>
  )
}

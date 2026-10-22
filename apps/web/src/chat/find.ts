// The chat's side of search: finding a hit's row in the transcript, scrolling it to the middle,
// lighting it up, and highlighting the matched words in the hits on screen with the CSS Custom
// Highlight API (`::highlight(ob-find)`, app.css), so React's DOM is never touched. Engines without
// it only light up the row.
import { type RefObject, useEffect } from "react"
import { termRanges } from "@openbot/app-model"

/** Space kept above a row that does not fit centered (px). */
const INSET = 84

/**
 * The row that shows `entryId`: its own (`data-entry`) or the "N messages with" line holding it
 * (`data-entries`, `exchange: true`).
 */
export const rowOf = (root: HTMLElement, entryId: string): { readonly element: HTMLElement; readonly exchange: boolean } | null => {
  const id = CSS.escape(entryId)
  const own = root.querySelector<HTMLElement>(`[data-entry="${id}"]`)
  if (own) return { element: own, exchange: false }
  const line = root.querySelector<HTMLElement>(`[data-entries~="${id}"]`)
  return line ? { element: line, exchange: true } : null
}

/** Scrolls `scroller` so `element` sits in the middle (from its top when it is taller than the view). */
export const centerIn = (scroller: HTMLElement, element: HTMLElement): void => {
  const box = scroller.getBoundingClientRect()
  const rect = element.getBoundingClientRect()
  const top = rect.top - box.top
  const room = scroller.clientHeight - rect.height
  scroller.scrollTop += room > 2 * INSET ? top - room / 2 : top - INSET
}

const lit = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

/** Lights the row up once (a link) or briefly marks it (the Find bar's current hit). */
export const flash = (element: HTMLElement, strong: boolean): void => {
  // a bubble, or the "N messages with" chip, rather than the whole width of the row
  const target = element.matches(".ob-msg")
    ? (element.querySelector<HTMLElement>("[data-side]") ?? element)
    : element.matches("[data-entries]")
      ? (element.querySelector<HTMLElement>("[data-exchange]") ?? element)
      : element
  clearTimeout(lit.get(target))
  target.removeAttribute("data-flash")
  // restart the animation
  void target.offsetWidth
  target.setAttribute("data-flash", strong ? "strong" : "soft")
  lit.set(
    target,
    setTimeout(() => target.removeAttribute("data-flash"), 2600),
  )
}

export interface Highlighted {
  readonly ids: ReadonlyArray<string>
  readonly current: string | undefined
  readonly terms: ReadonlyArray<string>
}

type HighlightRegistry = Map<string, unknown>
type HighlightCtor = new (...ranges: Range[]) => unknown
const registry = (): { readonly highlights: HighlightRegistry; readonly Highlight: HighlightCtor } | undefined => {
  const highlights = (CSS as unknown as { highlights?: HighlightRegistry }).highlights
  const Highlight = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight
  return highlights && Highlight ? { highlights, Highlight } : undefined
}

/** Ranges of `terms` in the text under `element` (each text node on its own). */
const rangesIn = (element: HTMLElement, terms: ReadonlyArray<string>): Range[] => {
  const out: Range[] = []
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.nodeValue ?? ""
    if (text.trim() === "") continue
    for (const r of termRanges(text, terms)) {
      const range = document.createRange()
      range.setStart(node, r.start)
      range.setEnd(node, r.end)
      out.push(range)
    }
  }
  return out
}

/** Highlights `terms` in the hits under `root` (the current hit in its own color); redone on `deps`. */
export const useTermHighlights = (root: RefObject<HTMLElement | null>, highlighted: Highlighted | undefined, rows: unknown): void => {
  useEffect(() => {
    const reg = registry()
    const el = root.current
    if (!reg || !el || highlighted === undefined || highlighted.terms.length === 0) return
    const ids = new Set(highlighted.ids)
    const all: Range[] = []
    const current: Range[] = []
    for (const row of el.querySelectorAll<HTMLElement>("[data-entry]")) {
      const id = row.dataset.entry!
      if (!ids.has(id)) continue
      const ranges = rangesIn(row, highlighted.terms)
      ;(id === highlighted.current ? current : all).push(...ranges)
    }
    reg.highlights.set("ob-find", new reg.Highlight(...all))
    reg.highlights.set("ob-find-current", new reg.Highlight(...current))
    return () => {
      reg.highlights.delete("ob-find")
      reg.highlights.delete("ob-find-current")
    }
  }, [root, highlighted, rows])
}

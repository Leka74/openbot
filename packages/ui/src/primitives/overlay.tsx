import { Check, ChevronDown, type LucideIcon, X } from "lucide-react"
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  type UIEventHandler,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"
import { cn } from "../cn.ts"
import { Icon } from "../Icon.tsx"

// ------------------------------------------------------------------------------------------ Portal

/**
 * Renders children into document.body (renders nothing on the server). The target is resolved
 * synchronously so portal content mounts in the same commit as its owner — anchored panels
 * measure themselves in a layout effect and would otherwise measure a panel that doesn't exist yet.
 */
export function Portal({ children }: { readonly children: ReactNode }): ReactNode {
  const [target, setTarget] = useState<HTMLElement | null>(() => (typeof document === "undefined" ? null : document.body))
  useEffect(() => {
    if (target === null) setTarget(document.body)
  }, [target])
  return target ? createPortal(children, target) : null
}

// ------------------------------------------------------------------------------- Anchored position

export type Side = "top" | "bottom" | "left" | "right"
export type Align = "start" | "center" | "end"

export interface Rect {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
}

/**
 * Pure placement math: position a `panel` next to an `anchor` inside a `viewport`, flipping to the
 * opposite side when it would overflow and clamping into the viewport with an 8 px margin.
 */
export const placePanel = (
  anchor: Rect,
  panel: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  side: Side,
  align: Align,
  offset = 6,
): { top: number; left: number; side: Side } => {
  const margin = 8
  const fits = (s: Side) =>
    s === "bottom"
      ? anchor.top + anchor.height + offset + panel.height <= viewport.height - margin
      : s === "top"
        ? anchor.top - offset - panel.height >= margin
        : s === "right"
          ? anchor.left + anchor.width + offset + panel.width <= viewport.width - margin
          : anchor.left - offset - panel.width >= margin
  const opposite: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" }
  const s = fits(side) || !fits(opposite[side]) ? side : opposite[side]
  let top: number
  let left: number
  if (s === "top" || s === "bottom") {
    top = s === "bottom" ? anchor.top + anchor.height + offset : anchor.top - offset - panel.height
    left = align === "start" ? anchor.left : align === "end" ? anchor.left + anchor.width - panel.width : anchor.left + (anchor.width - panel.width) / 2
  } else {
    left = s === "right" ? anchor.left + anchor.width + offset : anchor.left - offset - panel.width
    top = align === "start" ? anchor.top : align === "end" ? anchor.top + anchor.height - panel.height : anchor.top + (anchor.height - panel.height) / 2
  }
  left = Math.max(margin, Math.min(left, viewport.width - margin - panel.width))
  top = Math.max(margin, Math.min(top, viewport.height - margin - panel.height))
  return { top: Math.round(top), left: Math.round(left), side: s }
}

const useAnchoredPosition = (
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  side: Side,
  align: Align,
  offset: number,
): CSSProperties => {
  const [pos, setPos] = useState<CSSProperties>({ position: "fixed", top: 0, left: 0, visibility: "hidden" })
  useLayoutEffect(() => {
    if (!open) return
    let frame = 0
    let observed: HTMLElement | null = null
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => update())
    const update = () => {
      const a = anchorRef.current
      const p = panelRef.current
      if (!a || !p) {
        // The panel may mount a frame later (lazy content, portal target); retry instead of staying hidden.
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(update)
        return
      }
      if (resize && observed !== p) {
        if (observed) resize.unobserve(observed)
        resize.observe(p)
        observed = p
      }
      const r = a.getBoundingClientRect()
      const placed = placePanel(
        { top: r.top, left: r.left, width: r.width, height: r.height },
        { width: p.offsetWidth, height: p.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        side,
        align,
        offset,
      )
      setPos({ position: "fixed", top: placed.top, left: placed.left })
    }
    update()
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, true)
    return () => {
      cancelAnimationFrame(frame)
      resize?.disconnect()
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update, true)
    }
  }, [open, side, align, offset, anchorRef, panelRef])
  return pos
}

/** Close on outside pointer-down and Escape. */
const useDismiss = (open: boolean, refs: ReadonlyArray<RefObject<HTMLElement | null>>, onDismiss: () => void) => {
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (refs.some((r) => r.current?.contains(t))) return
      onDismiss()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      // handled: the app's own Esc (close a pane, leave a view) leaves it alone
      e.preventDefault()
      onDismiss()
    }
    document.addEventListener("pointerdown", onDown, true)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("pointerdown", onDown, true)
      document.removeEventListener("keydown", onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onDismiss])
}

const useControllable = (open: boolean | undefined, defaultOpen: boolean, onOpenChange?: (open: boolean) => void) => {
  const [inner, setInner] = useState(defaultOpen)
  const value = open ?? inner
  const set = useCallback(
    (next: boolean) => {
      if (open === undefined) setInner(next)
      onOpenChange?.(next)
    },
    [open, onOpenChange],
  )
  return [value, set] as const
}

// ----------------------------------------------------------------------------------------- Popover

export interface TriggerProps {
  readonly ref: Ref<HTMLButtonElement>
  readonly onClick: () => void
  readonly "aria-haspopup": "menu" | "dialog" | "listbox"
  readonly "aria-expanded": boolean
  readonly "aria-controls"?: string
}

export interface PopoverProps {
  /** Render the anchor/trigger with the given props spread onto a button. */
  readonly trigger: (props: TriggerProps) => ReactNode
  readonly children: ReactNode | ((close: () => void) => ReactNode)
  readonly open?: boolean
  readonly defaultOpen?: boolean
  readonly onOpenChange?: (open: boolean) => void
  readonly side?: Side
  readonly align?: Align
  readonly offset?: number
  readonly className?: string
  readonly role?: "dialog" | "menu" | "listbox"
  readonly label?: string
}

const popoverSurface = "z-[4000] rounded-2xl bg-elevated hairline border-line-secondary shadow-popover animate-fade-in"

/** Anchored floating panel (portal, fixed position, flips/clamps to the viewport, outside-click + Esc close). */
export function Popover({
  trigger,
  children,
  open,
  defaultOpen = false,
  onOpenChange,
  side = "bottom",
  align = "start",
  offset = 6,
  className,
  role = "dialog",
  label,
}: PopoverProps): ReactNode {
  const [isOpen, setOpen] = useControllable(open, defaultOpen, onOpenChange)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const close = useCallback(() => {
    setOpen(false)
    anchorRef.current?.focus()
  }, [setOpen])
  useDismiss(isOpen, [anchorRef, panelRef], () => setOpen(false))
  const style = useAnchoredPosition(isOpen, anchorRef, panelRef, side, align, offset)
  return (
    <>
      {trigger({ ref: anchorRef, onClick: () => setOpen(!isOpen), "aria-haspopup": role, "aria-expanded": isOpen, ...(isOpen ? { "aria-controls": id } : {}) })}
      {isOpen && (
        <Portal>
          <div ref={panelRef} id={id} role={role} aria-label={label} style={style} className={cn(popoverSurface, className)}>
            {typeof children === "function" ? children(close) : children}
          </div>
        </Portal>
      )}
    </>
  )
}

// -------------------------------------------------------------------------------------------- Menu

const MenuContext = createContext<{ close: () => void } | null>(null)

/** Static menu surface (also used inside `Menu`): radius 12, 6 px padding, popover shadow. */
export function MenuPanel({ children, className, label }: { readonly children: ReactNode; readonly className?: string; readonly label?: string }): ReactNode {
  return (
    <div role="menu" aria-label={label} className={cn("flex min-w-[200px] flex-col gap-px rounded-2xl bg-elevated p-1.5 hairline border-line-secondary shadow-popover", className)}>
      {children}
    </div>
  )
}

export interface MenuItemProps {
  readonly children: ReactNode
  readonly icon?: LucideIcon
  /** Custom leading node (e.g. a 20 px avatar) instead of an icon. */
  readonly leading?: ReactNode
  /** Right side: shortcut, "Bot" tag, chevron… */
  readonly trailing?: ReactNode
  readonly onSelect?: () => void
  readonly disabled?: boolean
  readonly danger?: boolean
  /** Checked state for selectable items (renders a check at the end). */
  readonly checked?: boolean
  /** Keyboard-highlighted (for list-driven menus such as the mention picker). */
  readonly active?: boolean
  readonly className?: string
}

export function MenuItem({ children, icon, leading, trailing, onSelect, disabled, danger, checked, active, className }: MenuItemProps): ReactNode {
  const ctx = useContext(MenuContext)
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      disabled={disabled}
      data-active={active || undefined}
      onClick={() => {
        onSelect?.()
        ctx?.close()
      }}
      className={cn(
        "flex min-h-[30px] w-full items-center gap-2 rounded-md px-2 text-start text-sm transition-colors duration-100",
        "hover:bg-hover focus-visible:bg-hover focus-visible:outline-none data-[active]:bg-hover disabled:pointer-events-none disabled:opacity-40",
        danger ? "text-danger-fg" : "text-fg",
        className,
      )}
    >
      {leading ?? (icon ? <Icon icon={icon} size="md" className={danger ? "text-danger-fg" : "text-icon-secondary"} /> : null)}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing && <span className="shrink-0 text-xs text-fg-tertiary">{trailing}</span>}
      {checked && <Icon icon={Check} size="sm" className="text-icon" />}
    </button>
  )
}

export function MenuSeparator(): ReactNode {
  return <div role="separator" className="mx-2 my-1 h-0 border-t-[0.5px] border-line-secondary" />
}

export function MenuLabel({ children }: { readonly children: ReactNode }): ReactNode {
  return <div className="px-2 pt-1.5 pb-1 text-xs text-fg-tertiary">{children}</div>
}

const focusItem = (root: HTMLElement | null, dir: 1 | -1 | "first" | "last") => {
  if (!root) return
  const items = Array.from(root.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)'))
  if (items.length === 0) return
  const i = items.indexOf(document.activeElement as HTMLElement)
  const next = dir === "first" ? 0 : dir === "last" ? items.length - 1 : i < 0 ? (dir === 1 ? 0 : items.length - 1) : (i + dir + items.length) % items.length
  items[next]?.focus()
}

export interface MenuProps extends Omit<PopoverProps, "children" | "role"> {
  readonly children: ReactNode
  readonly panelClassName?: string
}

/** Dropdown/context menu with arrow-key navigation. Items close the menu on select. */
export function Menu({ children, panelClassName, label, ...popover }: MenuProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null)
  return (
    <Popover {...popover} role="menu" label={label} className="rounded-2xl">
      {(close) => (
        <MenuContext.Provider value={{ close }}>
          <div
            ref={(el) => {
              panelRef.current = el
              if (el) requestAnimationFrame(() => focusItem(el, "first"))
            }}
            onKeyDown={(e: ReactKeyboardEvent) => {
              if (e.key === "ArrowDown") (e.preventDefault(), focusItem(panelRef.current, 1))
              else if (e.key === "ArrowUp") (e.preventDefault(), focusItem(panelRef.current, -1))
              else if (e.key === "Home") (e.preventDefault(), focusItem(panelRef.current, "first"))
              else if (e.key === "End") (e.preventDefault(), focusItem(panelRef.current, "last"))
              else if (e.key === "Tab") close()
            }}
            className={cn("flex min-w-[200px] flex-col gap-px p-1.5", panelClassName)}
          >
            {children}
          </div>
        </MenuContext.Provider>
      )}
    </Popover>
  )
}

// ------------------------------------------------------------------------------------------ Select

export interface SelectOption<V extends string> {
  readonly value: V
  readonly label: ReactNode
  readonly description?: ReactNode
  readonly disabled?: boolean
}

export interface SelectProps<V extends string> {
  readonly value: V
  readonly options: ReadonlyArray<SelectOption<V>>
  readonly onValueChange?: (value: V) => void
  readonly label: string
  readonly align?: Align
  readonly className?: string
  readonly disabled?: boolean
}

/** Ghost select ("Light ⌄", "Bot color ⌄"): 13 px + chevron, hairline border, radius 8; opens a menu. */
export function Select<V extends string>({ value, options, onValueChange, label, align = "end", className, disabled }: SelectProps<V>): ReactNode {
  const current = options.find((o) => o.value === value)
  return (
    <Menu
      label={label}
      align={align}
      trigger={(p) => (
        <button
          {...p}
          type="button"
          disabled={disabled}
          aria-label={label}
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1 rounded-lg ps-2.5 pe-1.5 text-sm text-fg hairline border-line-tertiary transition-colors duration-[120ms]",
            "hover:bg-hover aria-expanded:bg-hover disabled:opacity-50",
            className,
          )}
        >
          <span className="truncate">{current?.label ?? value}</span>
          <Icon icon={ChevronDown} size="sm" className="text-icon-secondary" />
        </button>
      )}
    >
      {options.map((o) => (
        <MenuItem key={o.value} checked={o.value === value} disabled={o.disabled} onSelect={() => onValueChange?.(o.value)}>
          {o.label}
        </MenuItem>
      ))}
    </Menu>
  )
}

// ----------------------------------------------------------------------------------------- Tooltip

export interface TooltipProps {
  readonly content: ReactNode
  readonly children: ReactNode
  readonly side?: Side
  readonly align?: Align
  readonly delay?: number
  readonly className?: string
}

/** Tooltip surface: radius 6, 0.5 px border, 12/16 text, padding 4×6. */
export function TooltipSurface({ children, className, id }: { readonly children: ReactNode; readonly className?: string; readonly id?: string }): ReactNode {
  return (
    <div id={id} role="tooltip" className={cn("max-w-[260px] rounded-md bg-elevated px-1.5 py-1 text-xs text-fg hairline border-line-secondary shadow-inline", className)}>
      {children}
    </div>
  )
}

/** Hover/focus tooltip around any inline content. */
export function Tooltip({ content, children, side = "top", align = "center", delay = 500, className }: TooltipProps): ReactNode {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const id = useId()
  const style = useAnchoredPosition(open, anchorRef, panelRef, side, align, 6)
  const show = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(true), delay)
  }
  const hide = () => {
    clearTimeout(timer.current)
    setOpen(false)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <span
      ref={anchorRef}
      className="inline-flex"
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(e) => e.key === "Escape" && hide()}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open && (
        <Portal>
          <div ref={panelRef} style={style} className="pointer-events-none z-[100000] animate-fade-in">
            <TooltipSurface id={id} className={className}>
              {content}
            </TooltipSurface>
          </div>
        </Portal>
      )}
    </span>
  )
}

// ------------------------------------------------------------------------------------------ Dialog

export interface DialogPanelProps {
  readonly children: ReactNode
  readonly className?: string
  readonly width?: number | string
  readonly height?: number | string
  readonly label?: string
  readonly ref?: Ref<HTMLDivElement>
}

/** Static dialog surface: radius 14, 0.5 px border, elevated fill, modal shadow. */
export function DialogPanel({ children, className, width = 400, height, label, ref }: DialogPanelProps): ReactNode {
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      className={cn("flex max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-3xl bg-elevated hairline border-line-secondary shadow-modal outline-none", className)}
      style={{ width, height }}
    >
      {children}
    </div>
  )
}

export function DialogHeader({ title, description, onClose, className }: { readonly title: ReactNode; readonly description?: ReactNode; readonly onClose?: () => void; readonly className?: string }): ReactNode {
  return (
    <div className={cn("flex items-start gap-2 px-4 pt-3.5 pb-3", className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2 className="text-xl font-medium text-fg">{title}</h2>
        {description && <p className="text-sm text-fg-secondary">{description}</p>}
      </div>
      {onClose && (
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="-me-1.5 -mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-icon-secondary transition-colors hover:bg-secondary hover:text-icon"
        >
          <Icon icon={X} size="lg" />
        </button>
      )}
    </div>
  )
}

export interface DialogBodyProps {
  readonly children: ReactNode
  readonly className?: string
  /** The scroll container (scroll positioning, paging). */
  readonly ref?: Ref<HTMLDivElement>
  readonly onScroll?: UIEventHandler<HTMLDivElement>
}

export function DialogBody({ children, className, ref, onScroll }: DialogBodyProps): ReactNode {
  return (
    <div ref={ref} onScroll={onScroll} className={cn("min-h-0 flex-1 overflow-y-auto px-4 pb-4 text-base scrollbar-thin", className)}>
      {children}
    </div>
  )
}

export function DialogFooter({ children, className }: { readonly children: ReactNode; readonly className?: string }): ReactNode {
  return <div className={cn("flex items-center justify-end gap-2 py-3 ps-4 pe-3", className)}>{children}</div>
}

export interface DialogProps extends Omit<DialogPanelProps, "ref"> {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** Vertical placement: centered (default) or near the top (command palette). */
  readonly placement?: "center" | "top"
  /** Close when the scrim is clicked (default true). */
  readonly dismissible?: boolean
}

const focusables = 'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])'

/** Modal dialog: 50 % scrim (z 3000), Esc/scrim close, focus moved in, Tab trapped, focus restored. */
export function Dialog({ open, onOpenChange, placement = "center", dismissible = true, children, ...panel }: DialogProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const el = panelRef.current
    const first = el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector<HTMLElement>(focusables)
    ;(first ?? el)?.focus()
    return () => previous?.focus?.()
  }, [open])
  if (!open) return null
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation()
      onOpenChange(false)
    } else if (e.key === "Tab" && panelRef.current) {
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(focusables))
      if (items.length === 0) return e.preventDefault()
      const first = items[0]!
      const last = items[items.length - 1]!
      if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus())
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus())
    }
  }
  return (
    <Portal>
      <div
        className={cn("fixed inset-0 z-[3000] flex justify-center bg-scrim p-4 animate-fade-in", placement === "center" ? "items-center" : "items-start pt-[22vh]")}
        onPointerDown={(e) => {
          if (dismissible && e.target === e.currentTarget) onOpenChange(false)
        }}
        onKeyDown={onKeyDown}
      >
        <DialogPanel ref={panelRef} {...panel} className={cn("animate-dialog-in", panel.className)}>
          {children}
        </DialogPanel>
      </div>
    </Portal>
  )
}

// ------------------------------------------------------------------------------------------- Toast

export type ToastTone = "neutral" | "success" | "danger" | "warn"

export interface ToastData {
  readonly id?: string
  readonly title: ReactNode
  readonly icon?: LucideIcon
  readonly tone?: ToastTone
  readonly action?: { readonly label: string; readonly onClick: () => void }
  /** ms before auto-dismiss (default 4000; 0 = sticky). */
  readonly duration?: number
}

const toastTone: Record<ToastTone, string> = { neutral: "text-icon-secondary", success: "text-success-fg", danger: "text-danger-fg", warn: "text-warn-fg" }

/** Toast surface: radius 9, 12.5 px text, elevated fill, popover shadow. */
export function Toast({ title, icon, tone = "neutral", action, onDismiss }: ToastData & { readonly onDismiss?: () => void }): ReactNode {
  return (
    <div role="status" className="pointer-events-auto flex animate-rise-in items-center gap-2 rounded-[9px] bg-elevated px-3 py-[9px] text-[12.5px] leading-4 text-fg hairline border-line-tertiary shadow-popover">
      {icon && <Icon icon={icon} size="xs" glyph={14} className={toastTone[tone]} />}
      <span className="min-w-0 flex-1">{title}</span>
      {action && (
        <button type="button" onClick={action.onClick} className="font-medium text-accent-fg hover:underline">
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button type="button" aria-label="Dismiss" onClick={onDismiss} className="-me-1 inline-flex size-5 items-center justify-center rounded-full text-icon-tertiary hover:bg-secondary hover:text-icon">
          <Icon icon={X} size="xs" />
        </button>
      )}
    </div>
  )
}

const ToastContext = createContext<{ toast: (t: ToastData) => string; dismiss: (id: string) => void } | null>(null)

/** Provider + bottom-center viewport. Use `useToast()` inside. */
export function Toaster({ children }: { readonly children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<ReadonlyArray<ToastData & { id: string }>>([])
  const seq = useRef(0)
  const dismiss = useCallback((id: string) => setToasts((ts) => ts.filter((t) => t.id !== id)), [])
  const toast = useCallback(
    (t: ToastData) => {
      const id = t.id ?? `toast-${++seq.current}`
      setToasts((ts) => [...ts.filter((x) => x.id !== id), { ...t, id }].slice(-4))
      const duration = t.duration ?? 4000
      if (duration > 0) setTimeout(() => dismiss(id), duration)
      return id
    },
    [dismiss],
  )
  return (
    <ToastContext.Provider value={{ toast, dismiss }}>
      {children}
      <Portal>
        <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-[5000] flex flex-col items-center gap-2">
          {toasts.map((t) => (
            <Toast key={t.id} {...t} onDismiss={() => dismiss(t.id)} />
          ))}
        </div>
      </Portal>
    </ToastContext.Provider>
  )
}

export const useToast = () => {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error("useToast must be used inside <Toaster>")
  return ctx
}

// --------------------------------------------------------------------------------- CommandPalette

export interface PaletteItem {
  readonly id: string
  readonly label: string
  readonly group?: string
  readonly keywords?: ReadonlyArray<string>
  readonly leading?: ReactNode
  /** After the label (label chip). */
  readonly chip?: ReactNode
  /** A second line under the label (a search hit's snippet); the row grows to fit it. */
  readonly detail?: ReactNode
  /** Far right (unread dot, shortcut). */
  readonly trailing?: ReactNode
  readonly onSelect?: () => void
}

/** Case-insensitive match on label + keywords; every whitespace-separated term must match. Order preserved. */
export const filterPaletteItems = <T extends PaletteItem>(items: ReadonlyArray<T>, query: string): ReadonlyArray<T> => {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return items
  return items.filter((it) => {
    const hay = [it.label, ...(it.keywords ?? [])].join(" ").toLowerCase()
    return terms.every((t) => hay.includes(t))
  })
}

export interface CommandPaletteProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly items: ReadonlyArray<PaletteItem>
  readonly placeholder?: string
  readonly emptyText?: ReactNode
  /** Controlled query (optional). When provided, filtering is up to the caller unless `filter` is true. */
  readonly query?: string
  readonly onQueryChange?: (q: string) => void
  readonly filter?: boolean
  readonly footer?: ReactNode
}

/** Search palette (Cmd/Ctrl+K): 560 px, search field, grouped rows, arrow/Enter navigation. */
export function CommandPalette(props: CommandPaletteProps): ReactNode {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} width={560} placement="top" label="Search" className="max-h-[min(640px,calc(100vh-120px))]">
      <CommandPaletteBody {...props} />
    </Dialog>
  )
}

/** The palette content without the dialog shell (for embedding/static rendering). */
export function CommandPaletteBody({ items, placeholder = "Search", emptyText = "No results", query, onQueryChange, filter, footer, onOpenChange }: CommandPaletteProps): ReactNode {
  const [inner, setInner] = useState("")
  const q = query ?? inner
  const shown = query === undefined || filter ? filterPaletteItems(items, q) : items
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  useEffect(() => setActive(0), [q])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" })
  }, [active])
  const choose = (it: PaletteItem | undefined) => {
    if (!it) return
    it.onSelect?.()
    onOpenChange(false)
  }
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(a + 1, shown.length - 1)))
    else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)))
    else if (e.key === "Enter") (e.preventDefault(), choose(shown[active]))
  }
  let lastGroup: string | undefined
  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b-[0.5px] border-line-secondary px-4">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 text-icon-tertiary" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          data-autofocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
          value={q}
          onChange={(e) => (onQueryChange ? onQueryChange(e.target.value) : setInner(e.target.value))}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent text-lg text-fg outline-none placeholder:text-fg-tertiary focus-visible:outline-none"
        />
      </div>
      <div ref={listRef} id={listId} role="listbox" className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin">
        {shown.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-fg-tertiary">{emptyText}</div>
        ) : (
          shown.map((it, i) => {
            const header = it.group && it.group !== lastGroup ? it.group : undefined
            lastGroup = it.group
            return (
              <div key={it.id}>
                {header && <div className="px-3 pt-2.5 pb-1 text-xs text-fg-tertiary">{header}</div>}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  onPointerMove={() => setActive(i)}
                  onClick={() => choose(it)}
                  className={cn("flex min-h-12 cursor-default items-center gap-2.5 rounded-xl px-3 text-base text-fg", it.detail !== undefined && "py-2", i === active && "bg-hover")}
                >
                  {it.leading}
                  {it.detail !== undefined ? (
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm text-fg-secondary">{it.label}</span>
                        {it.chip}
                      </span>
                      <span className="line-clamp-2 text-base break-words">{it.detail}</span>
                    </span>
                  ) : (
                    <>
                      <span className="truncate">{it.label}</span>
                      {it.chip}
                    </>
                  )}
                  {it.trailing && <span className={cn("ms-auto shrink-0", it.detail !== undefined && "self-start pt-0.5")}>{it.trailing}</span>}
                </div>
              </div>
            )
          })
        )}
      </div>
      {footer && <div className="flex shrink-0 items-center gap-3 border-t-[0.5px] border-line-secondary px-4 py-2 text-xs text-fg-tertiary">{footer}</div>}
    </>
  )
}

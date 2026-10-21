// Sidebar (grok-bot-ui.md §4.1): Search + New round buttons, pinned tiles (3 per row), sections with
// counts and collapse, Bot rows (36 px avatar, name, label chip, preview, unread dot, status),
// group chats, Unassigned, Hidden Bots, and the footer (owner menu + Grok's "Connect apps" pill with
// the connected apps' logos; Computers is in the owner menu). Compact mode = 88 px avatar rail. On a phone
// this is Home (Grok iOS): full width, account / search / new in the header, larger rows with a time
// column, and a long-press on a row or tile opens its menu as an action sheet.
import {
  Blocks,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  FolderInput,
  Info,
  Mail,
  MailOpen,
  Monitor,
  Moon,
  PanelLeft,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  SunMoon,
  Trash2, Pencil } from "lucide-react"
import { type MouseEvent as ReactMouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { useAtomSet } from "@effect/atom-react"
import { Exit } from "effect"
import { DEFAULT_SETTINGS, type BotId, type BotPatch, type ConversationId, type SectionId, type SidebarPlace } from "@openbot/contracts"
import { commands, updateSettingsAtom } from "@openbot/client"
import {
  Avatar,
  AvatarStack,
  Icon,
  IconButton,
  LabelChip,
  Menu,
  MenuItem,
  MenuLabel,
  MenuPanel,
  MenuSeparator,
  PillButton,
  Portal,
  Tooltip,
  UnreadDot,
  cn,
  useToast,
} from "@openbot/ui"
import { ActionSheet } from "../app/ActionSheet.tsx"
import { useRoster, useSessionInfo, valueOr } from "../app/data.ts"
import { formatListTime, initials, plainPreview } from "../app/format.ts"
import { updateReady, useDesktopUpdate } from "../app/desktopUpdate.ts"
import { useIsPhone } from "../app/layout.ts"
import { type LongPressPoint, useArmedClicks, useLongPress } from "../app/longPress.ts"
import { useConnectApps, useDialogs, useSelection, useSettingsDialog } from "../app/uiState.ts"
import { APPS, StackedLogos, useAppStatuses } from "../connections/apps.tsx"
import { describeFailure } from "../cards/useRespond.ts"
import { modKey } from "../palette/SearchPalette.tsx"
import { DropLine, useSidebarDrag } from "./drag.tsx"
import { buildSidebar, type SidebarItem, type SidebarSection } from "./model.ts"

/** The drag source and drop handlers a row or tile takes (drag.tsx). */
type DragProps = Record<string, unknown>

// ------------------------------------------------------------------------------ collapsed state

const COLLAPSED_KEY = "openbot.sidebar.collapsed"
const readCollapsed = (): ReadonlySet<string> => {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : ["hidden"])
  } catch {
    return new Set(["hidden"])
  }
}

const useCollapsed = () => {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const toggle = (id: string) =>
    setCollapsed((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
      } catch {}
      return next
    })
  return { collapsed, toggle }
}

// ---------------------------------------------------------------------------------- context menu

interface ContextTarget {
  readonly x: number
  readonly y: number
  readonly item: SidebarItem
  /** Opened by a touch long-press (the finger is still on the screen). */
  readonly touch?: boolean
}

function RowContextMenu({ target, onClose }: { readonly target: ContextTarget; readonly onClose: () => void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const phone = useIsPhone()
  const armed = useArmedClicks()
  const roster = useRoster()
  const updateBot = useAtomSet(commands["bots.update"], { mode: "promiseExit" })
  const markRead = useAtomSet(commands["conversations.markRead"])
  const setHidden = useAtomSet(commands["conversations.setHidden"])
  const renameConversation = useAtomSet(commands["conversations.rename"], { mode: "promiseExit" })
  const deleteBot = useAtomSet(commands["bots.delete"], { mode: "promiseExit" })
  const deleteConversation = useAtomSet(commands["conversations.delete"], { mode: "promiseExit" })
  const { toast } = useToast()
  const [pos, setPos] = useState({ left: target.x, top: target.y })
  const [confirm, setConfirm] = useState(false)
  const [renaming, setRenaming] = useState<string | undefined>(undefined)
  useEffect(() => {
    const el = ref.current
    if (!el || phone) return
    const r = el.getBoundingClientRect()
    setPos({ left: Math.min(target.x, window.innerWidth - r.width - 8), top: Math.min(target.y, window.innerHeight - r.height - 8) })
    const down = (e: PointerEvent) => {
      if (!el.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    document.addEventListener("pointerdown", down, true)
    document.addEventListener("keydown", key)
    return () => {
      document.removeEventListener("pointerdown", down, true)
      document.removeEventListener("keydown", key)
    }
  }, [target, onClose, confirm, renaming === undefined, phone])
  const run = (f: () => void) => () => {
    f()
    onClose()
  }
  const patch = async (botId: BotId, p: BotPatch) => {
    const exit = await updateBot({ botId, patch: p })
    if (Exit.isFailure(exit)) toast({ title: describeFailure(exit), tone: "danger" })
  }
  const item = target.item
  const conversationId = (item.kind === "bot" ? item.bot.directConversationId : item.summary.id) as ConversationId
  const unread = item.unread
  const sections = [...roster.state.sections.values()].sort((a, b) => a.order - b.order)
  const content = renaming !== undefined && item.kind === "group" ? (
            <form
              className="flex flex-col gap-2 p-1.5"
              onSubmit={(e) => {
                e.preventDefault()
                const title = renaming.trim()
                if (title === "") return
                onClose()
                void renameConversation({ conversationId, title }).then((exit) => {
                  if (Exit.isFailure(exit)) toast({ title: describeFailure(exit), tone: "danger" })
                })
              }}
            >
              <MenuLabel>Rename group</MenuLabel>
              <input
                autoFocus
                value={renaming}
                onChange={(e) => setRenaming(e.target.value)}
                maxLength={80}
                aria-label="Group name"
                className={cn("rounded-lg bg-secondary px-2.5 text-base text-fg outline-none placeholder:text-fg-tertiary", phone ? "h-11" : "h-8")}
              />
              <div className="flex justify-end gap-1.5">
                <PillButton type="button" variant="ghost" size="sm" onClick={() => setRenaming(undefined)}>Cancel</PillButton>
                <PillButton type="submit" variant="primary" size="sm" disabled={renaming.trim() === ""}>Save</PillButton>
              </div>
            </form>
          ) : confirm && item.kind === "bot" ? (
            <>
              <MenuLabel>Delete {item.bot.name}? Its chats, routines and memory go too.</MenuLabel>
              <MenuItem
                icon={Trash2}
                danger
                onSelect={run(() =>
                  void deleteBot({ botId: item.bot.id }).then((exit) => {
                    if (Exit.isFailure(exit)) toast({ title: describeFailure(exit), tone: "danger" })
                  }),
                )}
              >
                Delete Bot
              </MenuItem>
              <MenuItem onSelect={() => setConfirm(false)}>Cancel</MenuItem>
            </>
          ) : confirm && item.kind === "group" ? (
            <>
              <MenuLabel>Delete “{item.summary.title}”? Its messages go too; the Bots stay.</MenuLabel>
              <MenuItem
                icon={Trash2}
                danger
                onSelect={run(() =>
                  void deleteConversation({ conversationId }).then((exit) => {
                    if (Exit.isFailure(exit)) toast({ title: describeFailure(exit), tone: "danger" })
                  }),
                )}
              >
                Delete group
              </MenuItem>
              <MenuItem onSelect={() => setConfirm(false)}>Cancel</MenuItem>
            </>
          ) : (
            <>
              {item.kind === "bot" && (
                <MenuItem icon={item.bot.pinned ? PinOff : Pin} onSelect={run(() => void patch(item.bot.id, { pinned: !item.bot.pinned }))}>
                  {item.bot.pinned ? "Unpin" : "Pin"}
                </MenuItem>
              )}
              {item.kind === "bot" && sections.length > 0 && (
                <>
                  <MenuLabel>Move to</MenuLabel>
                  {sections.map((s) => (
                    <MenuItem key={s.id} icon={FolderInput} checked={item.bot.sectionId === s.id} onSelect={run(() => void patch(item.bot.id, { sectionId: s.id as SectionId, pinned: false }))}>
                      {s.name}
                    </MenuItem>
                  ))}
                  <MenuItem icon={FolderInput} checked={item.bot.sectionId === undefined && !item.bot.pinned} onSelect={run(() => void patch(item.bot.id, { sectionId: null, pinned: false }))}>
                    Unassigned
                  </MenuItem>
                </>
              )}
              {item.kind === "group" && (
                <MenuItem icon={Pencil} onSelect={() => setRenaming(item.summary.title)}>
                  Rename…
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem icon={unread ? MailOpen : Mail} onSelect={run(() => markRead({ conversationId, ...(unread ? {} : { unread: true }) }))}>
                {unread ? "Mark as Read" : "Mark as Unread"}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={Copy}
                onSelect={run(() => {
                  void navigator.clipboard?.writeText(conversationId)
                  toast({ title: "Conversation ID copied", icon: Copy })
                })}
              >
                Copy conversation ID
              </MenuItem>
              <MenuSeparator />
              {item.kind === "bot" ? (
                <MenuItem icon={item.bot.hidden ? Eye : EyeOff} onSelect={run(() => void patch(item.bot.id, { hidden: !item.bot.hidden }))}>
                  {item.bot.hidden ? "Show in sidebar" : "Hide from sidebar"}
                </MenuItem>
              ) : (
                <MenuItem icon={EyeOff} onSelect={run(() => setHidden({ conversationId, hidden: true }))}>
                  Hide from sidebar
                </MenuItem>
              )}
              {item.kind === "bot" && (
                <MenuItem icon={Trash2} danger onSelect={() => setConfirm(true)}>
                  Delete
                </MenuItem>
              )}
              {item.kind === "group" && (
                <MenuItem icon={Trash2} danger onSelect={() => setConfirm(true)}>
                  Delete group…
                </MenuItem>
              )}
            </>
          )
  if (phone) {
    const name = item.kind === "bot" ? item.bot.name : item.summary.title || item.bots.map((b) => b.name).join(", ")
    return (
      <ActionSheet
        label="Bot actions"
        onClose={onClose}
        testId="row-sheet"
        header={
          <div className="flex items-center gap-3">
            {item.kind === "bot" ? (
              <Avatar shape={item.bot.avatar.shape} color={item.bot.avatar.color} size={36} />
            ) : (
              <AvatarStack size={36} outlineColor="var(--ob-elevated)" avatars={item.bots.map((b) => ({ key: b.id, shape: b.avatar.shape, color: b.avatar.color }))} />
            )}
            <span className="min-w-0 flex-1 truncate text-lg font-medium text-fg">{name}</span>
            {item.kind === "bot" && item.bot.label && <LabelChip>{item.bot.label}</LabelChip>}
          </div>
        }
      >
        <div role="menu" aria-label="Bot actions" className="flex flex-col gap-px">
          {content}
        </div>
      </ActionSheet>
    )
  }
  return (
    <Portal>
      <div ref={ref} className="fixed z-[4000] animate-fade-in" style={pos} {...(target.touch ? armed : {})}>
        <MenuPanel label="Bot actions" className="w-[228px]">
          {content}
        </MenuPanel>
      </div>
    </Portal>
  )
}

// ------------------------------------------------------------------------------------------- rows

/** Right-click (desktop) and long-press (touch) both open the row menu at the pointer. */
const useRowMenu = (onMenu: (p: LongPressPoint, touch?: boolean) => void) => {
  const longPress = useLongPress((p) => onMenu(p, true))
  return {
    ...longPress,
    onContextMenu: (e: ReactMouseEvent) => {
      e.preventDefault()
      onMenu({ x: e.clientX, y: e.clientY })
    },
  }
}

function PinnedTile({ item, current, onOpen, onMenu, drag, dragged = false }: { readonly item: SidebarItem & { kind: "bot" }; readonly current: boolean; readonly onOpen: () => void; readonly onMenu: (p: LongPressPoint, touch?: boolean) => void; readonly drag?: DragProps; readonly dragged?: boolean }): ReactNode {
  const b = item.bot
  const menu = useRowMenu(onMenu)
  return (
    <button
      type="button"
      aria-current={current ? "page" : undefined}
      onClick={onOpen}
      {...menu}
      {...drag}
      title={b.name}
      data-bot={b.id}
      className={cn("flex w-[82px] min-w-0 flex-col items-center rounded-xl px-1.5 pt-2 pb-2 transition-colors duration-100 hover:bg-hover active:bg-active aria-[current=page]:bg-active", dragged && "opacity-40")}
    >
      <Avatar
        shape={b.avatar.shape}
        color={b.avatar.color}
        size={56}
        working={item.status === "working"}
        expression={item.status === "working" ? "inspecting" : "neutral"}
        {...(item.status === "attention" ? { status: "attention" as const } : item.unread ? { status: "unread" as const } : {})}
      />
      <span className="mt-[7px] max-w-full truncate text-xs text-fg">{b.name}</span>
      {b.label && <LabelChip className="mt-[5px] max-w-full truncate">{b.label}</LabelChip>}
    </button>
  )
}

function Row({
  item,
  current,
  onOpen,
  onMenu,
  dimmed = false,
  phone = false,
  drag,
  dragged = false,
}: {
  readonly item: SidebarItem
  readonly current: boolean
  readonly onOpen: () => void
  readonly onMenu: (p: LongPressPoint, touch?: boolean) => void
  readonly dimmed?: boolean
  readonly phone?: boolean
  readonly drag?: DragProps
  readonly dragged?: boolean
}): ReactNode {
  const name = item.kind === "bot" ? item.bot.name : item.summary.title || item.bots.map((b) => b.name).join(", ")
  const menu = useRowMenu(onMenu)
  const at = phone ? item.summary?.lastActivityAt : undefined
  const size = phone ? 44 : 36
  return (
    <button
      type="button"
      aria-current={current ? "page" : undefined}
      onClick={onOpen}
      {...menu}
      {...drag}
      data-row={item.key}
      className={cn(
        "relative flex w-full min-w-0 items-center text-start transition-colors duration-100 hover:bg-hover aria-[current=page]:bg-active",
        phone ? "gap-3 rounded-2xl px-2 py-2.5 active:bg-active" : "gap-2.5 rounded-xl p-2",
        dimmed && "opacity-60",
        dragged && "opacity-40",
      )}
    >
      {item.kind === "bot" ? (
        <Avatar
          shape={item.bot.avatar.shape}
          color={dimmed ? "gray" : item.bot.avatar.color}
          size={size}
          working={item.status === "working"}
          expression={item.status === "working" ? "inspecting" : "neutral"}
          {...(item.status === "attention" ? { status: "attention" as const } : {})}
        />
      ) : (
        <AvatarStack size={size} avatars={item.bots.map((b) => ({ key: b.id, shape: b.avatar.shape, color: b.avatar.color }))} />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate text-fg", phone ? "text-[16px] leading-[22px]" : "text-base")}>{name}</span>
          {item.kind === "bot" && item.bot.label && <LabelChip>{item.bot.label}</LabelChip>}
          {at !== undefined && <span className="ms-auto shrink-0 ps-2 text-xs text-fg-tertiary tabular-nums">{formatListTime(at)}</span>}
        </span>
        <span className={cn("truncate", phone ? "text-[14px] leading-5" : "text-sm", item.status === "attention" ? "text-warn-fg" : "text-fg-secondary")}>{plainPreview(item.preview, 200) || " "}</span>
      </span>
      {item.unread && <UnreadDot className={phone ? "me-0.5" : "me-1"} />}
    </button>
  )
}

function SectionHeader({ section, collapsed, onToggle, hidden = false, phone = false }: { readonly section: SidebarSection; readonly collapsed: boolean; readonly onToggle: () => void; readonly hidden?: boolean; readonly phone?: boolean }): ReactNode {
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      className={cn(
        "group flex w-full items-center rounded-md px-3 text-start text-fg-secondary transition-colors hover:text-fg",
        phone ? "h-10 pt-3 pb-1.5 text-sm" : "h-[30px] pt-2 pb-1.5 text-xs",
        hidden && !collapsed && "h-8 rounded-xl bg-hover pt-1.5",
      )}
    >
      <span className="flex-1 truncate">{section.name}</span>
      {collapsed ? (
        <span className="tabular-nums">{section.items.length}</span>
      ) : hidden ? (
        <Icon icon={ChevronDown} size="sm" />
      ) : (
        <Icon icon={ChevronDown} size="xs" className={cn("transition-opacity group-hover:opacity-100", phone ? "opacity-60" : "opacity-0")} />
      )}
    </button>
  )
}

// ------------------------------------------------------------------------------------------ footer

function OwnerMenu(): ReactNode {
  const info = useSessionInfo()
  const roster = useRoster()
  const settingsDialog = useSettingsDialog()
  const updateSettings = useAtomSet(updateSettingsAtom)
  const settings = roster.state.settings ?? DEFAULT_SETTINGS
  const owner = valueOr(info, undefined)
  const name = settings.ownerName ?? owner?.ownerName
  return (
    <Menu
      label="Account"
      side="top"
      align="start"
      trigger={(p) => (
        <button
          {...p}
          type="button"
          aria-label="Account"
          title={name ?? "Account"}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-elevated text-sm text-fg-secondary hairline border-line-tertiary shadow-control transition-colors hover:bg-elevated-hover aria-expanded:bg-elevated-hover"
        >
          {initials(name)}
        </button>
      )}
    >
      {name && <MenuLabel>{name}</MenuLabel>}
      <MenuItem icon={Settings} trailing={`${modKey},`} onSelect={() => settingsDialog.show("general")}>
        Settings
      </MenuItem>
      <MenuItem icon={Monitor} onSelect={() => settingsDialog.show("computers")}>
        Computers
      </MenuItem>
      <MenuItem icon={ShieldCheck} onSelect={() => settingsDialog.show("permissions")}>
        Permissions
      </MenuItem>
      <MenuSeparator />
      <MenuLabel>Theme</MenuLabel>
      <MenuItem icon={Sun} checked={settings.theme === "light"} onSelect={() => updateSettings({ patch: { theme: "light" } })}>
        Light
      </MenuItem>
      <MenuItem icon={Moon} checked={settings.theme === "dark"} onSelect={() => updateSettings({ patch: { theme: "dark" } })}>
        Dark
      </MenuItem>
      <MenuItem icon={SunMoon} checked={settings.theme === "system"} onSelect={() => updateSettings({ patch: { theme: "system" } })}>
        Follow System
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={Info} onSelect={() => settingsDialog.show("updates")}>
        About OpenBot{owner?.version ? ` ${owner.version}` : ""}
      </MenuItem>
    </Menu>
  )
}

// ----------------------------------------------------------------------------------------- sidebar

export interface SidebarProps {
  readonly compact: boolean
  readonly onToggleCompact: () => void
  readonly onSearch: () => void
  readonly onNewChat: () => void
}

export function Sidebar({ compact, onToggleCompact, onSearch, onNewChat }: SidebarProps): ReactNode {
  const roster = useRoster()
  const { conversationId, select } = useSelection()
  const dialogs = useDialogs()
  // Phone Home: no "current" row (the open chat is not on screen), so its unread dot shows too.
  const phone = useIsPhone()
  const open = phone ? null : conversationId
  const model = useMemo(() => buildSidebar(roster.state, open), [roster.state, open])
  const { collapsed, toggle } = useCollapsed()
  const [menu, setMenu] = useState<ContextTarget | undefined>()
  // drag a chat to reorder it, move it between sections or pin it (desktop)
  const drag = useSidebarDrag(!phone)
  /**
   * One place's rows. Each sits in a padded wrapper that takes the drops (no gaps between rows, so
   * the pointer is always over one), with a floating line where the dragged chat would land.
   */
  const rows = (place: SidebarPlace, items: ReadonlyArray<SidebarItem>) =>
    items.map((item, index) => (
      <div key={item.key} className="relative py-0.5" {...drag.row(place, items, index)}>
        {drag.isTarget(place, index) && <DropLine edge="top" />}
        <Row
          item={item}
          phone={phone}
          current={isCurrent(item)}
          onOpen={() => openItem(item)}
          onMenu={onMenu(item)}
          drag={drag.source(item)}
          dragged={drag.dragging?.key === item.key}
        />
        {index === items.length - 1 && drag.isTarget(place, items.length) && <DropLine edge="bottom" />}
      </div>
    ))
  const openItem = (item: SidebarItem) => select((item.kind === "bot" ? item.bot.directConversationId : item.summary.id) as ConversationId)
  const isCurrent = (item: SidebarItem) => open !== null && (item.kind === "bot" ? item.bot.directConversationId : item.summary.id) === open
  const onMenu = (item: SidebarItem) => (p: LongPressPoint, touch = false) => setMenu({ x: p.x, y: p.y, item, touch })
  const onContext = (item: SidebarItem) => (e: ReactMouseEvent) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, item })
  }
  const empty = roster.loaded && roster.bots.length === 0

  if (compact && !phone) return <CompactSidebar model={model} isCurrent={isCurrent} openItem={openItem} onNewChat={onNewChat} onToggleCompact={onToggleCompact} onContext={onContext} menu={menu} closeMenu={() => setMenu(undefined)} />

  return (
    <nav aria-label="Bots" className={cn("relative flex h-full min-w-0 flex-col", phone ? "bg-chrome" : "bg-sidebar")}>
      {model.pinned.length === 0 && drag.accepts("pinned") && (
        // no pins yet: the drop area covers the top bar, not the chats (nothing moves under the pointer)
        <div
          aria-label="Pinned Bots"
          role="group"
          {...drag.zone("pinned", model.pinned)}
          className={cn(
            "ob-pin-drop absolute inset-x-2 top-[calc(env(safe-area-inset-top)+8px)] z-20 flex h-11 animate-fade-in items-center justify-center rounded-xl border border-dashed bg-sidebar text-xs",
            drag.isTarget("pinned", 0) ? "border-accent text-fg" : "border-line-secondary text-fg-secondary",
          )}
        >
          Drag here to pin
        </div>
      )}
      {phone ? (
        <div className="flex shrink-0 items-center gap-2 px-4 pt-[env(safe-area-inset-top)]" data-testid="home-header">
          <div className="flex h-[60px] items-center">
            <OwnerMenu />
          </div>
          <span className="flex-1" />
          <IconButton icon={Search} label="Search" size={44} variant="elevated" onClick={onSearch} />
          <IconButton icon={Plus} label="New chat" size={44} variant="elevated" onClick={onNewChat} />
        </div>
      ) : (
        <div className="ob-sidebar-header flex h-[calc(60px+env(safe-area-inset-top))] shrink-0 items-center gap-2 px-4 pt-[env(safe-area-inset-top)]">
          <IconButton icon={PanelLeft} label={`Compact sidebar (${modKey}B)`} size={28} className="-ms-1 opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100" onClick={onToggleCompact} />
          <span className="flex-1" />
          <IconButton icon={Search} label="Search" title={`Search (${modKey}K)`} variant="elevated" onClick={onSearch} />
          <IconButton icon={Plus} label="New chat" title={`New chat (${modKey}N)`} variant="elevated" onClick={onNewChat} />
        </div>
      )}
      <div className={cn("min-h-0 flex-1 overflow-y-auto pb-3 scrollbar-thin", phone ? "px-2.5" : "px-2")}>
        {model.pinned.length > 0 && (
          <div aria-label="Pinned Bots" role="group" {...drag.zone("pinned", model.pinned)} className="flex flex-wrap items-start justify-center gap-x-1 gap-y-3 px-1 pt-2.5 pb-4">
            {model.pinned.map((item, index) => (
              <div key={item.key} className="relative" {...drag.row("pinned", model.pinned, index, "x")}>
                {drag.isTarget("pinned", index) && <DropLine edge="left" />}
                <PinnedTile
                  item={item}
                  current={isCurrent(item)}
                  onOpen={() => openItem(item)}
                  onMenu={onMenu(item)}
                  drag={drag.source(item)}
                  dragged={drag.dragging?.key === item.key}
                />
                {index === model.pinned.length - 1 && drag.isTarget("pinned", model.pinned.length) && <DropLine edge="right" />}
              </div>
            ))}
          </div>
        )}
        {empty && (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <Avatar shape="blob" color="gray" size={56} ghost />
            <p className="text-sm text-fg-secondary">No Bots yet. Create one to get started.</p>
            <PillButton variant="primary" size="md" leadingIcon={Plus} onClick={() => dialogs.show({ kind: "new-bot" })}>
              Create a Bot
            </PillButton>
          </div>
        )}
        {model.sections.map((section) => {
          const place = section.id as SidebarPlace
          // Unassigned and Group chats show while empty only as a place to drag a chat to
          if (section.items.length === 0 && (section.id === "unassigned" || section.id === "groups") && !drag.accepts(place)) return null
          // "Unassigned" is only a heading once the owner has created sections of their own (Grok).
          if (section.id === "unassigned" && !model.sections.some((s) => s.id !== "unassigned" && s.id !== "groups")) {
            return (
              <div key={section.id} {...drag.zone(place, section.items)} className="flex min-h-8 flex-col pb-3" role="group" aria-label="Bots">
                {rows(place, section.items)}
              </div>
            )
          }
          const isCollapsed = collapsed.has(section.id)
          return (
            <div
              key={section.id}
              {...drag.zone(place, section.items)}
              className={cn("rounded-xl pb-3", drag.accepts(place) && isCollapsed && drag.isTarget(place, section.items.length) && "bg-hover")}
              role="group"
              aria-label={section.name}
              data-section={section.id}
            >
              <SectionHeader section={section} collapsed={isCollapsed} onToggle={() => toggle(section.id)} phone={phone} />
              {!isCollapsed && section.items.length === 0 && (
                <p className={cn("px-3 pb-2 text-xs", drag.isTarget(place, 0) ? "text-accent-fg" : "text-fg-tertiary")}>Drag chats here</p>
              )}
              {!isCollapsed && section.items.length > 0 && <div className="mt-0.5 flex flex-col">{rows(place, section.items)}</div>}
            </div>
          )
        })}
        {model.hidden.items.length > 0 && (
          <div role="group" aria-label="Hidden Bots">
            <SectionHeader section={model.hidden} collapsed={collapsed.has("hidden")} onToggle={() => toggle("hidden")} hidden phone={phone} />
            {!collapsed.has("hidden") && model.hidden.items.map((item) => <Row key={item.key} item={item} phone={phone} dimmed current={isCurrent(item)} onOpen={() => openItem(item)} onMenu={onMenu(item)} />)}
          </div>
        )}
      </div>
      {!phone && <DesktopUpdateButton />}
      <div className={cn("flex shrink-0 items-center gap-2 px-4 pt-2", phone ? "pb-[max(12px,env(safe-area-inset-bottom))]" : "pb-[max(16px,env(safe-area-inset-bottom))]")}>
        {!phone && <OwnerMenu />}
        <ConnectAppsPill phone={phone} />
      </div>
      {menu && <RowContextMenu target={menu} onClose={() => setMenu(undefined)} />}
    </nav>
  )
}

/** Grok's "Connect apps" pill: opens Connect Apps; the connected apps' logos at the right. */
function ConnectAppsPill({ phone }: { readonly phone: boolean }): ReactNode {
  const connectApps = useConnectApps()
  const statuses = useAppStatuses()
  const connected = APPS.filter((app) => statuses.get(app.id)?.state !== "off")
  return (
    <button
      type="button"
      onClick={() => connectApps.show()}
      data-testid="connect-apps-pill"
      className={cn(
        "inline-flex min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-elevated px-4 text-base font-medium text-fg hairline border-line-tertiary shadow-control transition-colors hover:bg-elevated-hover",
        phone ? "h-11" : "h-9",
      )}
    >
      <span className="truncate">Connect apps</span>
      <StackedLogos apps={connected} size={18} />
    </button>
  )
}

/** The desktop app downloaded a new version of itself: one click restarts into it. */
function DesktopUpdateButton({ compact = false }: { readonly compact?: boolean }): ReactNode {
  const update = useDesktopUpdate()
  if (!updateReady(update.state)) return null
  const label = update.state?.status === "ready" ? "Restart to update" : "Download the update"
  if (compact) return <IconButton icon={RefreshCw} label={label} variant="elevated" onClick={update.install} data-testid="desktop-update" />
  return (
    <div className="shrink-0 px-4 pt-2">
      <PillButton variant="primary" size="md" leadingIcon={RefreshCw} className="w-full" onClick={update.install} data-testid="desktop-update">
        {label}
      </PillButton>
    </div>
  )
}

function CompactSidebar({
  model,
  isCurrent,
  openItem,
  onNewChat,
  onToggleCompact,
  onContext,
  menu,
  closeMenu,
}: {
  readonly model: ReturnType<typeof buildSidebar>
  readonly isCurrent: (item: SidebarItem) => boolean
  readonly openItem: (item: SidebarItem) => void
  readonly onNewChat: () => void
  readonly onToggleCompact: () => void
  readonly onContext: (item: SidebarItem) => (e: ReactMouseEvent) => void
  readonly menu: ContextTarget | undefined
  readonly closeMenu: () => void
}): ReactNode {
  const connectApps = useConnectApps()
  const groups: ReadonlyArray<ReadonlyArray<SidebarItem>> = [model.pinned, ...model.sections.map((s) => s.items)].filter((g) => g.length > 0)
  return (
    <nav aria-label="Bots" className="flex h-full flex-col items-center bg-sidebar">
      <div className="ob-compact-top flex h-[60px] shrink-0 items-center">
        <IconButton icon={ChevronRight} label={`Expand sidebar (${modKey}B)`} size={28} onClick={onToggleCompact} />
      </div>
      <div className="flex min-h-0 w-full flex-1 flex-col items-center overflow-y-auto pb-2 scrollbar-thin">
        {groups.map((items, gi) => (
          <div key={gi} className="flex w-full flex-col items-center">
            {gi > 0 && <div className="my-2 h-px w-[54px] bg-line-tertiary" />}
            {items.map((item) => {
              const name = item.kind === "bot" ? item.bot.name : item.summary.title
              return (
                <Tooltip key={item.key} content={name} side="right" delay={300}>
                  <button
                    type="button"
                    aria-label={name}
                    aria-current={isCurrent(item) ? "page" : undefined}
                    onClick={() => openItem(item)}
                    onContextMenu={onContext(item)}
                    className="flex size-[54px] items-center justify-center rounded-xl transition-colors hover:bg-hover aria-[current=page]:bg-active"
                  >
                    {item.kind === "bot" ? (
                      <Avatar
                        shape={item.bot.avatar.shape}
                        color={item.bot.avatar.color}
                        size={36}
                        working={item.status === "working"}
                        {...(item.status === "attention" ? { status: "attention" as const } : item.unread ? { status: "unread" as const } : {})}
                      />
                    ) : (
                      <AvatarStack size={36} avatars={item.bots.map((b) => ({ key: b.id, shape: b.avatar.shape, color: b.avatar.color }))} />
                    )}
                  </button>
                </Tooltip>
              )
            })}
          </div>
        ))}
      </div>
      <div className="flex shrink-0 flex-col items-center gap-2 pt-2 pb-4">
        <DesktopUpdateButton compact />
        <IconButton icon={Plus} label="New chat" onClick={onNewChat} />
        <IconButton icon={Blocks} label="Connect apps" onClick={() => connectApps.show()} />
        <OwnerMenu />
      </div>
      {menu && <RowContextMenu target={menu} onClose={closeMenu} />}
    </nav>
  )
}



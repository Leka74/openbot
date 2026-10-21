// Drag and drop in the sidebar (desktop): a chat is dragged onto a place (the pins, a section,
// Unassigned, Group chats) at a position; dropping sends the place's new order (`sidebar.arrange`),
// so it moves there and keeps that position. Bots go anywhere but Group chats; group chats go into
// sections or Group chats, never the pins.
import { useAtomSet } from "@effect/atom-react"
import { commands } from "@openbot/client"
import type { SidebarItemRef, SidebarPlace } from "@openbot/contracts"
import { cn, useToast } from "@openbot/ui"
import { Exit } from "effect"
import { type DragEvent, type ReactNode, useRef, useState } from "react"
import { describeFailure } from "../cards/useRespond.ts"
import type { SidebarItem } from "./model.ts"

const MIME = "application/x-openbot-chat"

export const refOf = (item: SidebarItem): SidebarItemRef =>
  item.kind === "bot" ? { kind: "bot", botId: item.bot.id } : { kind: "group", conversationId: item.summary.id }

export const canDrop = (item: SidebarItem, place: SidebarPlace): boolean =>
  item.kind === "bot" ? place !== "groups" : place !== "pinned" && place !== "unassigned"

export interface DropTarget {
  readonly place: SidebarPlace
  /** Insert before the item at this index of the place's list (its length: at the end). */
  readonly index: number
}

/** A chat being dragged, where it would land, and the handlers for rows and places. */
export const useSidebarDrag = (enabled: boolean) => {
  const arrange = useAtomSet(commands["sidebar.arrange"], { mode: "promiseExit" })
  const { toast } = useToast()
  // `dragged` is set at once (drops are checked against it); `dragging` re-renders the sidebar
  const dragged = useRef<SidebarItem | undefined>(undefined)
  const [dragging, setDragging] = useState<SidebarItem | undefined>()
  const [target, setTarget] = useState<DropTarget | undefined>()

  const finish = () => {
    dragged.current = undefined
    setDragging(undefined)
    setTarget(undefined)
  }

  const land = async (place: SidebarPlace, list: ReadonlyArray<SidebarItem>, index: number) => {
    const item = dragged.current
    finish()
    if (item === undefined || !canDrop(item, place)) return
    const from = list.findIndex((i) => i.key === item.key)
    const rest = list.filter((i) => i.key !== item.key)
    const at = from !== -1 && from < index ? index - 1 : index
    if (from !== -1 && at === from) return // dropped where it was
    const items = [...rest.slice(0, at), item, ...rest.slice(at)].map(refOf)
    const exit = await arrange({ place, items })
    if (Exit.isFailure(exit)) toast({ title: describeFailure(exit), tone: "danger" })
  }

  /** A chat that can be dragged. */
  const source = (item: SidebarItem) =>
    !enabled
      ? {}
      : {
        draggable: true,
        onDragStart: (e: DragEvent) => {
          e.dataTransfer.effectAllowed = "move"
          e.dataTransfer.setData(MIME, item.key)
          e.dataTransfer.setData("text/plain", item.key)
          dragged.current = item
          // after the drag has started: changing the layout during dragstart makes Chrome cancel it
          setTimeout(() => dragged.current === item && setDragging(item), 0)
        },
        onDragEnd: finish,
      }

  const accept = (place: SidebarPlace, e: DragEvent): boolean => {
    const item = dragged.current
    if (item === undefined || !canDrop(item, place)) return false
    e.preventDefault()
    e.dataTransfer.dropEffect = "move"
    return true
  }

  /** A row (or tile) at `index` of `place`: the drop lands before or after it, by the pointer. */
  const row = (place: SidebarPlace, list: ReadonlyArray<SidebarItem>, index: number, axis: "y" | "x" = "y") =>
    !enabled ? {} : {
      onDragOver: (e: DragEvent<HTMLElement>) => {
        if (!accept(place, e)) return
        e.stopPropagation()
        const rect = e.currentTarget.getBoundingClientRect()
        const after = axis === "y" ? e.clientY > rect.top + rect.height / 2 : e.clientX > rect.left + rect.width / 2
        const next = after ? index + 1 : index
        if (target?.place !== place || target.index !== next) setTarget({ place, index: next })
      },
      onDrop: (e: DragEvent) => {
        if (!accept(place, e)) return
        e.stopPropagation()
        void land(place, list, target?.place === place ? target.index : index)
      },
    }

  /** A whole place (its header, its empty space): the drop lands at the end. */
  const zone = (place: SidebarPlace, list: ReadonlyArray<SidebarItem>) =>
    !enabled ? {} : {
      onDragOver: (e: DragEvent) => {
        if (!accept(place, e)) return
        if (target?.place !== place || target.index !== list.length) setTarget({ place, index: list.length })
      },
      onDrop: (e: DragEvent) => {
        if (!accept(place, e)) return
        void land(place, list, list.length)
      },
    }

  const isTarget = (place: SidebarPlace, index: number) => target?.place === place && target.index === index
  const accepts = (place: SidebarPlace) => dragging !== undefined && canDrop(dragging, place)

  return { dragging, source, row, zone, isTarget, accepts }
}

/**
 * Where a dragged chat will land: a line over the edge of a row (or a bar beside a pinned tile).
 * It floats: nothing moves under the pointer while dragging.
 */
export function DropLine({ edge }: { readonly edge: "top" | "bottom" | "left" | "right" }): ReactNode {
  return (
    <div
      aria-hidden
      data-testid="drop-line"
      className={cn(
        "pointer-events-none absolute z-10 rounded-full bg-accent",
        edge === "top" && "inset-x-2 -top-[3px] h-[3px]",
        edge === "bottom" && "inset-x-2 -bottom-[3px] h-[3px]",
        edge === "left" && "inset-y-2 -left-[3px] w-[3px]",
        edge === "right" && "inset-y-2 -right-[3px] w-[3px]",
      )}
    />
  )
}

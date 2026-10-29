// Quick send (`#/quick-send`): send what you are looking at to a Bot without opening OpenBot. In the
// desktop app it is the floating panel its shortcut opens (apps/desktop/src/quickSend.ts fills it in
// with the browser's page, a fresh copy or a screenshot); in a browser it is the bookmarklet's popup
// (`#/quick-send?url=…&title=…&text=…`). Nothing is sent without Enter (or Send).
import { useAtomSet } from "@effect/atom-react"
import { commands, uploadFilesAtom } from "@openbot/client"
import type { AttachmentId, ConversationId } from "@openbot/contracts"
import { Avatar, cn, Icon, IconButton, PillButton } from "@openbot/ui"
import { Exit } from "effect"
import { Camera, Check, ChevronDown, ClipboardList, Link2, Quote, Users, X } from "lucide-react"
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useRoster } from "../app/data.ts"
import { desktopApp, type QuickSendPrefill } from "../app/notifications.ts"
import { useFollowActiveProfile } from "../app/profiles.ts"
import { useReloadOnUpdate } from "../app/reloadOnUpdate.ts"
import { describeFailure } from "../cards/useRespond.ts"

const LAST_KEY = "openbot.quickSend.to"

interface Target {
  readonly id: ConversationId
  readonly name: string
  readonly kind: "bot" | "group"
  readonly avatar?: { readonly shape: string; readonly color: string }
  readonly lastActivityAt: number
}

interface Draft {
  readonly id: number
  readonly link: QuickSendPrefill["link"] | undefined
  readonly shared: string | undefined
  readonly copied: string | undefined
  readonly images: ReadonlyArray<{ readonly key: string; readonly src: string; readonly label: string }>
  readonly to: string | undefined
}

const emptyDraft = (id = 0): Draft => ({
  id,
  link: undefined,
  shared: undefined,
  copied: undefined,
  images: [],
  to: undefined,
})

const draftOf = (p: QuickSendPrefill): Draft => ({
  id: p.id,
  link: p.link,
  shared: p.text,
  copied: p.clipboard?.text,
  images: p.clipboard?.image ? [{ key: `clip-${p.id}`, src: p.clipboard.image, label: "Copied image" }] : [],
  to: p.to,
})

/** The bookmarklet's popup: `#/quick-send?url=…&title=…&text=…&to=…`. */
const draftOfHash = (): Draft => {
  const q = new URLSearchParams(location.hash.split("?")[1] ?? "")
  const url = q.get("url") ?? undefined
  const text = q.get("text")?.trim() || undefined
  return {
    ...emptyDraft(1),
    link: url ? { url, ...(q.get("title") ? { title: q.get("title")! } : {}) } : undefined,
    shared: text,
    to: q.get("to") ?? undefined,
  }
}

const quote = (text: string) =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")

/** The message: the note, then the page, then what was shared or copied (quoted). */
export const composeQuickSend = (note: string, draft: Pick<Draft, "link" | "shared" | "copied">): string => {
  const parts: Array<string> = []
  if (note.trim() !== "") parts.push(note.trim())
  if (draft.link)
    parts.push(
      draft.link.title && draft.link.title !== draft.link.url
        ? `${draft.link.title}\n${draft.link.url}`
        : draft.link.url,
    )
  for (const text of [draft.shared, draft.copied]) if (text) parts.push(quote(text))
  return parts.join("\n\n")
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, "")
  } catch {
    return url
  }
}

function Chip({
  icon,
  children,
  onRemove,
  label,
}: {
  readonly icon: typeof Link2
  readonly children: ReactNode
  readonly onRemove: () => void
  readonly label: string
}): ReactNode {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full bg-elevated-hover py-1 ps-2.5 pe-1 text-xs text-fg-secondary">
      <Icon icon={icon} size="xs" className="shrink-0 text-fg-tertiary" />
      <span className="min-w-0 truncate">{children}</span>
      <IconButton icon={X} label={`Remove ${label}`} size={20} onClick={onRemove} />
    </span>
  )
}

export function QuickSend(): ReactNode {
  const bridge = desktopApp()?.quickSend
  const inPanel = bridge !== undefined
  const roster = useRoster()
  useReloadOnUpdate()
  useFollowActiveProfile()
  const [draft, setDraft] = useState<Draft>(() => (inPanel ? emptyDraft() : draftOfHash()))
  const [note, setNote] = useState("")
  const [targetId, setTargetId] = useState<string | undefined>(() => localStorage.getItem(LAST_KEY) ?? undefined)
  const [picking, setPicking] = useState(false)
  const [filter, setFilter] = useState("")
  const [status, setStatus] = useState<
    { readonly kind: "idle" | "sending" | "sent" } | { readonly kind: "error"; readonly message: string }
  >({ kind: "idle" })
  const [canShoot, setCanShoot] = useState(false)
  const card = useRef<HTMLDivElement>(null)
  /** The panel opening shown now (`QuickSendPrefill.id`). */
  const opening = useRef(0)
  const input = useRef<HTMLTextAreaElement>(null)
  const send = useAtomSet(commands["messages.send"], { mode: "promiseExit" })
  const upload = useAtomSet(uploadFilesAtom("quick-send"), { mode: "promiseExit" })

  const targets = useMemo((): ReadonlyArray<Target> => {
    const list: Array<Target> = []
    for (const bot of roster.bots) {
      if (bot.hidden) continue
      const summary = roster.state.conversations.get(bot.directConversationId)
      list.push({
        id: bot.directConversationId,
        name: bot.name,
        kind: "bot",
        avatar: bot.avatar,
        lastActivityAt: summary?.lastActivityAt ?? 0,
      })
    }
    for (const c of roster.state.conversations.values()) {
      if (c.kind === "group" && !c.hiddenFromSidebar)
        list.push({ id: c.id, name: c.title || "Group", kind: "group", lastActivityAt: c.lastActivityAt })
    }
    return list.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  }, [roster.bots, roster.state.conversations])

  // A Bot or group named by the link wins; then the last one used here; then the most recent.
  const byName = draft.to
    ? targets.find((t) => t.name.toLowerCase() === draft.to!.replace(/^@/, "").toLowerCase())
    : undefined
  const target = byName ?? targets.find((t) => t.id === targetId) ?? targets[0]

  // the desktop panel: every opening fills it in afresh
  useEffect(() => {
    if (bridge === undefined) return
    const take = (p: unknown) => {
      const prefill = p as QuickSendPrefill
      if (prefill.id === 0) return
      if (prefill.id === opening.current) {
        // the same opening, completed (the browser's page arrives a moment later)
        setDraft((current) => ({ ...current, link: current.link ?? prefill.link }))
        return
      }
      opening.current = prefill.id
      setDraft(draftOf(prefill))
      setNote("")
      setStatus({ kind: "idle" })
      setPicking(false)
      requestAnimationFrame(() => input.current?.focus())
    }
    void bridge.prefill().then(take)
    void bridge.info().then((info) => setCanShoot((info as { canScreenshot?: boolean }).canScreenshot === true))
    return bridge.onPrefill(take)
  }, [bridge])

  // the panel's window follows the card's height
  useLayoutEffect(() => {
    if (bridge === undefined || card.current === null) return
    const observer = new ResizeObserver(() => bridge.resize((card.current?.offsetHeight ?? 200) + 24))
    observer.observe(card.current)
    return () => observer.disconnect()
  }, [bridge])

  const close = () => {
    if (bridge !== undefined) bridge.close()
    else window.close()
  }

  const submit = async () => {
    if (target === undefined || status.kind === "sending") return
    const text = composeQuickSend(note, draft)
    if (text === "" && draft.images.length === 0) return
    setStatus({ kind: "sending" })
    let attachmentIds: ReadonlyArray<AttachmentId> = []
    if (draft.images.length > 0) {
      const files = await Promise.all(
        draft.images.map(async (img, i) => {
          const blob = await (await fetch(img.src)).blob()
          return new File([blob], `${img.label.toLowerCase().replace(/\s+/g, "-")}-${i + 1}.png`, {
            type: blob.type || "image/png",
          })
        }),
      )
      const uploaded = await upload(files)
      if (Exit.isFailure(uploaded)) return setStatus({ kind: "error", message: describeFailure(uploaded) })
      attachmentIds = uploaded.value.map((a) => a.id)
    }
    const sent = await send({
      conversationId: target.id,
      text,
      attachmentIds,
      clientNonce: `quick-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })
    if (Exit.isFailure(sent)) return setStatus({ kind: "error", message: describeFailure(sent) })
    localStorage.setItem(LAST_KEY, target.id)
    setStatus({ kind: "sent" })
    setTimeout(close, 700)
  }

  const shoot = async () => {
    const src = (await bridge?.screenshot()) as string | undefined
    if (src) setDraft((d) => ({ ...d, images: [...d.images, { key: `shot-${Date.now()}`, src, label: "Screenshot" }] }))
    input.current?.focus()
  }

  const shown = targets.filter((t) => t.name.toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 8)
  const empty = composeQuickSend(note, draft) === "" && draft.images.length === 0

  return (
    <div className={cn("flex w-full justify-center p-3", !inPanel && "min-h-full items-start pt-[12vh]")}>
      <div
        ref={card}
        data-testid="quick-send"
        className="flex w-full max-w-[616px] flex-col gap-3 rounded-[22px] border-[0.5px] border-line-tertiary bg-chrome p-4 shadow-modal"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault()
            if (picking) setPicking(false)
            else close()
          }
        }}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex min-w-0 items-center gap-2 rounded-full py-1 ps-1 pe-2.5 text-sm font-medium text-fg hover:bg-elevated-hover"
            onClick={() => setPicking((p) => !p)}
            aria-label="Send to"
            aria-expanded={picking}
            data-testid="quick-send-to"
          >
            {target?.kind === "bot" && target.avatar ? (
              <Avatar shape={target.avatar.shape} color={target.avatar.color} size={24} />
            ) : (
              <Icon icon={Users} size="sm" className="text-fg-tertiary" />
            )}
            <span className="truncate">{target?.name ?? "No Bots yet"}</span>
            <Icon icon={ChevronDown} size="xs" className="text-fg-tertiary" />
          </button>
          <span className="flex-1" />
          <span className="text-xs text-fg-quaternary">esc to close</span>
        </div>

        {picking && (
          <div
            className="flex flex-col gap-1 rounded-2xl bg-elevated p-1.5"
            role="listbox"
            aria-label="Bots and groups"
          >
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && shown[0]) {
                  e.preventDefault()
                  setTargetId(shown[0].id)
                  setDraft((d) => ({ ...d, to: undefined }))
                  setPicking(false)
                  setFilter("")
                  input.current?.focus()
                }
              }}
              placeholder="Find a Bot or group"
              className="h-8 rounded-xl bg-transparent px-2.5 text-sm text-fg outline-none placeholder:text-fg-quaternary"
            />
            {shown.map((t) => (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={t.id === target?.id}
                className={cn(
                  "flex items-center gap-2 rounded-xl px-2 py-1.5 text-start text-sm text-fg hover:bg-elevated-hover",
                  t.id === target?.id && "bg-elevated-hover",
                )}
                onClick={() => {
                  setTargetId(t.id)
                  setDraft((d) => ({ ...d, to: undefined }))
                  setPicking(false)
                  setFilter("")
                  input.current?.focus()
                }}
              >
                {t.kind === "bot" && t.avatar ? (
                  <Avatar shape={t.avatar.shape} color={t.avatar.color} size={22} />
                ) : (
                  <Icon icon={Users} size="sm" className="text-fg-tertiary" />
                )}
                <span className="truncate">{t.name}</span>
              </button>
            ))}
          </div>
        )}

        <textarea
          ref={input}
          autoFocus
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder={target ? `Add a note for ${target.name}…` : "Add a note…"}
          aria-label="Note"
          className="max-h-48 min-h-[44px] resize-none bg-transparent px-1 text-[15px] leading-6 text-fg outline-none placeholder:text-fg-quaternary field-sizing-content"
        />

        {(draft.link || draft.shared || draft.copied || draft.images.length > 0) && (
          <div className="flex flex-wrap gap-1.5" data-testid="quick-send-chips">
            {draft.link && (
              <Chip icon={Link2} label="the page" onRemove={() => setDraft((d) => ({ ...d, link: undefined }))}>
                <span className="text-fg">{draft.link.title || hostOf(draft.link.url)}</span>
                {draft.link.title ? <span className="text-fg-tertiary"> · {hostOf(draft.link.url)}</span> : null}
              </Chip>
            )}
            {draft.shared && (
              <Chip
                icon={Quote}
                label="the shared text"
                onRemove={() => setDraft((d) => ({ ...d, shared: undefined }))}
              >
                {draft.shared.replace(/\s+/g, " ")}
              </Chip>
            )}
            {draft.copied && (
              <Chip
                icon={ClipboardList}
                label="the copied text"
                onRemove={() => setDraft((d) => ({ ...d, copied: undefined }))}
              >
                {draft.copied.replace(/\s+/g, " ")}
              </Chip>
            )}
            {draft.images.map((img) => (
              <span key={img.key} className="relative inline-flex">
                <img
                  src={img.src}
                  alt={img.label}
                  className="h-14 rounded-xl border-[0.5px] border-line-tertiary object-cover"
                />
                <span className="absolute -end-1.5 -top-1.5 rounded-full bg-chrome">
                  <IconButton
                    icon={X}
                    label={`Remove ${img.label.toLowerCase()}`}
                    size={20}
                    onClick={() => setDraft((d) => ({ ...d, images: d.images.filter((i) => i.key !== img.key) }))}
                  />
                </span>
              </span>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          {canShoot && <IconButton icon={Camera} label="Add a screenshot" onClick={() => void shoot()} />}
          <span className="min-w-0 flex-1 truncate text-sm">
            {status.kind === "error" && <span className="text-danger-fg">{status.message}</span>}
            {status.kind === "sent" && (
              <span className="inline-flex items-center gap-1 text-fg-secondary">
                <Icon icon={Check} size="xs" /> Sent to {target?.name}
              </span>
            )}
          </span>
          <PillButton
            variant="primary"
            size="md"
            loading={status.kind === "sending"}
            disabled={empty || target === undefined || status.kind === "sent"}
            onClick={() => void submit()}
            data-testid="quick-send-send"
          >
            Send ↵
          </PillButton>
        </div>
      </div>
    </div>
  )
}

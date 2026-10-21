// New chat (grok-bot-ui.md §4.8): the chat header becomes "To: ‹input›" with a list under it —
// "Create new Bot" (or Create “‹typed›” Bot), "Create group chat", then every Bot filtered as you
// type. Enter opens a Bot's direct chat; Tab adds it as a recipient (2–6 make a group). On a phone it
// is a full-screen page with a back button; each Bot row has a + to add it (there is no Tab key).
import { ChevronLeft, Plus, Users, X } from "lucide-react"
import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useAtomSet } from "@effect/atom-react"
import { Exit } from "effect"
import { MAX_GROUP_BOTS, type Bot, type ConversationId } from "@openbot/contracts"
import { createGroupAtom, newClientNonce, sendMessageAtom } from "@openbot/client"
import { Avatar, IconButton, KeyBadge, PillButton, cn, useToast } from "@openbot/ui"
import { useRoster } from "../app/data.ts"
import { useLayoutMode } from "../app/layout.ts"
import { useDialogs, useSelection } from "../app/uiState.ts"
import { describeFailure } from "../cards/useRespond.ts"
import { Composer, type ComposerSubmit } from "./Composer.tsx"

type Option =
  | { readonly kind: "create-bot"; readonly name?: string }
  | { readonly kind: "create-group" }
  | { readonly kind: "bot"; readonly bot: Bot }

export function NewChatView({ onClose }: { readonly onClose?: (() => void) | undefined }): ReactNode {
  const roster = useRoster()
  const { select } = useSelection()
  const dialogs = useDialogs()
  const createGroup = useAtomSet(createGroupAtom, { mode: "promiseExit" })
  const send = useAtomSet(sendMessageAtom)
  const { toast } = useToast()
  const [query, setQuery] = useState("")
  const [chips, setChips] = useState<ReadonlyArray<Bot>>([])
  const [active, setActive] = useState(0)
  const [listOpen, setListOpen] = useState(true)
  const [groupName, setGroupName] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const mode = useLayoutMode()
  const phone = mode === "phone"

  const options: ReadonlyArray<Option> = useMemo(() => {
    const q = query.trim().toLowerCase()
    const bots = roster.bots.filter((b) => !chips.some((c) => c.id === b.id) && (q === "" || b.name.toLowerCase().includes(q) || (b.label ?? "").toLowerCase().includes(q)))
    const head: Option[] = q ? [{ kind: "create-bot", name: query.trim() }] : [{ kind: "create-bot" }, { kind: "create-group" }]
    return [...head, ...bots.sort((a, b) => Number(a.hidden) - Number(b.hidden)).map((bot) => ({ kind: "bot" as const, bot }))]
  }, [roster.bots, query, chips])

  // Typing highlights the first matching Bot (Grok: "Res" → Research Scout), not "Create “Res” Bot".
  useLayoutEffect(() => {
    const firstBot = options.findIndex((o) => o.kind === "bot")
    setActive(query.trim() && firstBot >= 0 ? firstBot : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, chips.length])

  const onScreen = useRef(true)
  useEffect(() => {
    onScreen.current = true
    return () => {
      onScreen.current = false
    }
  }, [])
  const showConversation = (conversationId: ConversationId) => {
    if (onScreen.current) select(conversationId)
  }

  const openGroup = async (bots: ReadonlyArray<Bot>, firstMessage?: ComposerSubmit) => {
    const exit = await createGroup({ title: groupName.trim() || bots.map((b) => b.name).join(", "), memberBotIds: bots.map((b) => b.id), clientNonce: newClientNonce() })
    if (Exit.isFailure(exit)) {
      toast({ title: describeFailure(exit), tone: "danger" })
      return
    }
    const conversationId = exit.value.id as ConversationId
    if (firstMessage) send({ conversationId, text: firstMessage.text, ...(firstMessage.attachmentIds.length ? { attachmentIds: firstMessage.attachmentIds } : {}) })
    showConversation(conversationId)
  }

  const choose = (opt: Option | undefined, add = false) => {
    if (!opt) return
    if (opt.kind === "create-bot") return dialogs.show({ kind: "new-bot", ...(opt.name ? { name: opt.name } : {}) })
    if (opt.kind === "create-group") return dialogs.show({ kind: "new-group", botIds: chips.map((c) => c.id) })
    if (add || chips.length > 0) {
      if (chips.length >= MAX_GROUP_BOTS) return toast({ title: `A group chat can have at most ${MAX_GROUP_BOTS} Bots` })
      setChips((c) => [...c, opt.bot])
      setQuery("")
      setActive(0)
      inputRef.current?.focus()
      return
    }
    select(opt.bot.directConversationId)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") return (e.preventDefault(), setListOpen(true), setActive((a) => Math.min(a + 1, options.length - 1)))
    if (e.key === "ArrowUp") return (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)))
    if (e.key === "Tab" && !e.shiftKey && listOpen) {
      const opt = options[active]
      if (opt?.kind === "bot") return (e.preventDefault(), choose(opt, true))
    }
    if (e.key === "Backspace" && query === "" && chips.length > 0) return setChips((c) => c.slice(0, -1))
    if (e.key === "Enter") {
      e.preventDefault()
      if (query === "" && chips.length === 1) return select(chips[0]!.directConversationId)
      if (query === "" && chips.length >= 2) return void openGroup(chips)
      return choose(options[active])
    }
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      if (query) setQuery("")
      else onClose?.()
    }
  }

  const onSubmit = async (d: ComposerSubmit) => {
    const targets = chips.length > 0 ? chips : options[active]?.kind === "bot" && query ? [(options[active] as { bot: Bot }).bot] : []
    if (targets.length === 0) {
      toast({ title: "Pick who to message first" })
      inputRef.current?.focus()
      return
    }
    if (targets.length === 1) {
      const conversationId = targets[0]!.directConversationId
      send({ conversationId, text: d.text, ...(d.attachmentIds.length ? { attachmentIds: d.attachmentIds } : {}) })
      showConversation(conversationId)
      return
    }
    await openGroup(targets, d)
  }

  return (
    <main className="relative flex h-full min-w-0 flex-col bg-chrome" aria-label="New chat">
      {phone && (
        <div className="flex shrink-0 items-center gap-2 px-2 pt-[calc(6px+env(safe-area-inset-top))] pb-1">
          {onClose && <IconButton icon={ChevronLeft} label="Back" size={44} onClick={onClose} data-testid="new-chat-back" />}
          <h1 className="flex-1 truncate text-center text-xl font-medium text-fg">New chat</h1>
          <span className="w-11 shrink-0" aria-hidden />
        </div>
      )}
      <div className={cn("flex min-h-12 shrink-0 items-center gap-2 border-b-[0.5px] border-line-secondary ps-4 pe-3", mode === "tablet" && "pt-[env(safe-area-inset-top)]")}>
        <span className="text-lg text-fg-secondary">To:</span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 py-2">
          {chips.map((c) => (
            <span key={c.id} className="inline-flex h-7 items-center gap-1.5 rounded-full bg-secondary ps-1 pe-1 text-base text-fg">
              <Avatar shape={c.avatar.shape} color={c.avatar.color} size={20} />
              {c.name}
              <IconButton icon={X} label={`Remove ${c.name}`} size={20} onClick={() => setChips((x) => x.filter((y) => y.id !== c.id))} />
            </span>
          ))}
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setListOpen(true)
            }}
            onFocus={() => setListOpen(true)}
            onKeyDown={onKeyDown}
            placeholder={chips.length ? "Add another Bot…" : "Start a chat with…"}
            aria-label="To"
            role="combobox"
            aria-expanded={listOpen}
            aria-controls="new-chat-list"
            className="h-7 min-w-[160px] flex-1 bg-transparent text-lg text-fg outline-none placeholder:text-fg-tertiary focus-visible:outline-none"
          />
        </div>
        {onClose && !phone && <IconButton icon={X} label="Close new chat" size={28} onClick={onClose} />}
      </div>
      {chips.length >= 2 && (
        <div className="flex min-h-11 shrink-0 items-center gap-2 border-b-[0.5px] border-line-secondary ps-4 pe-3">
          <Users className="size-4 shrink-0 text-icon-secondary" aria-hidden />
          <input
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                void openGroup(chips)
              }
            }}
            maxLength={80}
            placeholder={`Name this group (optional): ${chips.map((c) => c.name).join(", ")}`}
            aria-label="Group name"
            className="h-7 min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-tertiary focus-visible:outline-none"
          />
          {phone && (
            <PillButton variant="primary" size="card" onClick={() => void openGroup(chips)} data-testid="new-chat-create-group">
              Create
            </PillButton>
          )}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {listOpen && (
          <div
            id="new-chat-list"
            role="listbox"
            className={cn(
              "absolute top-2 z-20 flex animate-fade-in flex-col overflow-hidden rounded-3xl bg-elevated hairline border-line-secondary shadow-popover",
              phone ? "inset-x-2 max-h-[calc(100%-16px)]" : "left-8 max-h-[min(400px,calc(100%-24px))] w-[min(560px,calc(100%-64px))]",
            )}
          >
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5 scrollbar-thin">
              {options.map((o, i) => {
                const key = o.kind === "bot" ? o.bot.id : o.kind
                const selected = i === active
                return (
                  <div
                    key={key}
                    role="option"
                    aria-selected={selected}
                    onPointerMove={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(o)}
                    className={cn("flex cursor-default items-center gap-2.5 rounded-xl px-2.5 text-lg text-fg", phone ? "h-12" : "h-[38px]", selected && "bg-hover")}
                  >
                    {o.kind === "bot" ? (
                      <Avatar shape={o.bot.avatar.shape} color={o.bot.avatar.color} size={22} className={cn(o.bot.hidden && "opacity-50")} />
                    ) : (
                      <span className="inline-flex size-[22px] items-center justify-center rounded-full bg-secondary text-icon-secondary">
                        {o.kind === "create-bot" ? <Plus size={14} aria-hidden /> : <Users size={13} aria-hidden />}
                      </span>
                    )}
                    <span className="truncate">
                      {o.kind === "bot" ? o.bot.name : o.kind === "create-group" ? "Create group chat" : o.name ? `Create “${o.name}” Bot` : "Create new Bot"}
                    </span>
                    {o.kind === "bot" && o.bot.label && <span className="text-sm text-fg-tertiary">{o.bot.label}</span>}
                    {phone && o.kind === "bot" && (
                      <button
                        type="button"
                        aria-label={`Add ${o.bot.name}`}
                        className="ms-auto -me-1 inline-flex size-9 shrink-0 items-center justify-center rounded-full text-icon-secondary active:bg-secondary"
                        onClick={(e) => {
                          e.stopPropagation()
                          choose(o, true)
                        }}
                      >
                        <Plus size={18} aria-hidden />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
            <div className={cn("flex shrink-0 items-center gap-3 border-t-[0.5px] border-line-secondary px-3.5 py-2 text-xs text-fg-tertiary", phone && "hidden")}>
              <span className="flex items-center gap-1">
                <KeyBadge>Tab</KeyBadge> add
              </span>
              <span className="flex items-center gap-1">
                <KeyBadge>↩</KeyBadge> open
              </span>
              {chips.length >= 2 && <span className="ms-auto text-fg-secondary">Enter starts a group chat with {chips.length} Bots</span>}
            </div>
          </div>
        )}
      </div>
      <div className={cn("mx-auto w-full max-w-[992px]", mode === "desktop" ? "px-4 pb-4" : "ob-composer-dock px-4 pb-[max(16px,env(safe-area-inset-bottom))]")} onFocusCapture={() => setListOpen(false)}>
        <Composer draftKey="new" placeholder="Message Bot" mentionable={roster.bots} onSubmit={onSubmit} />
      </div>
    </main>
  )
}


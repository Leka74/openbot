// The pill composer (grok-bot-ui.md §4.6, grok-bot-ui-activity.md F.10.4): + menu (attach files →
// attachments.upload), textarea that grows to 6 lines, @mention picker, Enter to send / Shift+Enter
// for a newline, Stop while the bot works (turns.interrupt) and the context ring. On a phone it is
// Grok iOS's composer: a separate round + beside the pill field, 16 px text (no iOS focus zoom),
// Return inserts a newline and the send button sends; no autofocus (it would pop the keyboard).
import { ArrowUp, Paperclip, Plus, Square, X } from "lucide-react"
import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useAtomSet } from "@effect/atom-react"
import { Exit } from "effect"
import type { Attachment, AttachmentId, Bot, BotId } from "@openbot/contracts"
import { insertDictation } from "@openbot/app-model"
import { uploadFilesAtom } from "@openbot/client"
import { Avatar, IconButton, Menu, MenuItem, MenuPanel, Spinner, cn, useToast } from "@openbot/ui"
import { plainPreview } from "../app/format.ts"
import { isTouchNow, useIsPhone } from "../app/layout.ts"
import { describeFailure } from "../cards/useRespond.ts"
import { ContextRing, type ContextRingProps } from "./ContextRing.tsx"
import { DictationButton } from "./DictationButton.tsx"
import type { MessageEntry } from "./grouping.ts"
import { useDictation } from "./useDictation.ts"

export interface ComposerSubmit {
  readonly text: string
  readonly attachmentIds: ReadonlyArray<AttachmentId>
  readonly addressedBotIds: ReadonlyArray<BotId>
  readonly addressEveryone: boolean
  readonly replyToId?: MessageEntry["id"] | undefined
}

export interface ComposerProps {
  /** Draft + upload key (the conversation id, or "new"). */
  readonly draftKey: string
  readonly placeholder: string
  /** Bots offered by the @ picker (members first). */
  readonly mentionable: ReadonlyArray<Bot>
  /** Group members (mentions resolve to addressedBotIds only for these). */
  readonly members?: ReadonlyArray<Bot>
  readonly allowEveryone?: boolean
  readonly working?: boolean
  readonly onStop?: () => void
  readonly onSubmit: (draft: ComposerSubmit) => void | Promise<unknown>
  readonly replyTo?: MessageEntry | undefined
  readonly replyAuthor?: string | undefined
  readonly onCancelReply?: () => void
  readonly context?: ContextRingProps | undefined
  readonly disabled?: boolean
  readonly autoFocus?: boolean
  readonly className?: string
}

const drafts = new Map<string, string>()
const MAX_LINES = 6
const LINE = 20

interface Upload {
  readonly key: string
  readonly name: string
  readonly attachment?: Attachment
  readonly failed?: string
}

const mentionQuery = (text: string, caret: number): { start: number; query: string } | undefined => {
  const before = text.slice(0, caret)
  const m = /(^|\s)@([\p{L}\p{N}._-]*)$/u.exec(before)
  if (!m) return undefined
  return { start: before.length - m[2]!.length - 1, query: m[2]! }
}

let measureCanvas: HTMLCanvasElement | undefined
const textWidth = (text: string, font: string): number => {
  measureCanvas ??= document.createElement("canvas")
  const ctx = measureCanvas.getContext("2d")
  if (!ctx) return 0
  ctx.font = font
  return ctx.measureText(text).width
}

export function Composer(props: ComposerProps): ReactNode {
  const { draftKey, placeholder, mentionable, members, allowEveryone = false, working = false } = props
  const [text, setText] = useState(() => drafts.get(draftKey) ?? "")
  const [uploads, setUploads] = useState<ReadonlyArray<Upload>>([])
  const [uploading, setUploading] = useState(false)
  const [mention, setMention] = useState<{ start: number; query: string; left: number } | undefined>()
  const [active, setActive] = useState(0)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const upload = useAtomSet(uploadFilesAtom(draftKey), { mode: "promiseExit" })
  const { toast } = useToast()
  const phone = useIsPhone()

  const [dictatingInto, setDictatingInto] = useState<{ readonly base: string; readonly caret: number } | undefined>()
  // Switch drafts with the conversation (derived state, reset during render).
  const [shownKey, setShownKey] = useState(draftKey)
  if (shownKey !== draftKey) {
    setShownKey(draftKey)
    setText(drafts.get(draftKey) ?? "")
    setUploads([])
    setMention(undefined)
  }
  useEffect(() => {
    if (props.autoFocus && !isTouchNow()) taRef.current?.focus()
  }, [draftKey, props.autoFocus])
  useEffect(() => {
    if (props.replyTo) taRef.current?.focus()
  }, [props.replyTo])

  // Autosize up to 6 lines.
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = "0px"
    const h = Math.min(ta.scrollHeight, MAX_LINES * LINE + 8)
    ta.style.height = `${Math.max(h, LINE + 8)}px`
    ta.style.overflowY = ta.scrollHeight > MAX_LINES * LINE + 8 ? "auto" : "hidden"
  }, [text])

  const options = useMemo(() => {
    if (!mention) return []
    const q = mention.query.toLowerCase()
    const bots = mentionable.filter((b) => b.name.toLowerCase().includes(q)).sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
    const list: Array<{ id: string; name: string; bot?: Bot }> = bots.map((b) => ({ id: b.id, name: b.name, bot: b }))
    if (allowEveryone && "everyone".startsWith(q)) list.unshift({ id: "everyone", name: "everyone" })
    return list.slice(0, 8)
  }, [mention, mentionable, allowEveryone])

  const update = (value: string, caret: number) => {
    setText(value)
    drafts.set(draftKey, value)
    const m = mentionQuery(value, caret)
    if (m && taRef.current && shellRef.current) {
      const ta = taRef.current
      const style = getComputedStyle(ta)
      const lineStart = value.lastIndexOf("\n", m.start - 1) + 1
      const width = textWidth(value.slice(lineStart, m.start), `${style.fontSize} ${style.fontFamily}`)
      const shell = shellRef.current.getBoundingClientRect()
      const taRect = ta.getBoundingClientRect()
      const left = Math.max(0, Math.min(taRect.left - shell.left + width - 12, shell.width - 360))
      if (m.query !== mention?.query) setActive(0)
      setMention({ ...m, left })
    } else setMention(undefined)
  }

  const pick = (opt: { name: string }) => {
    if (!mention) return
    const before = text.slice(0, mention.start)
    const after = text.slice(mention.start + 1 + mention.query.length)
    const insert = `@${opt.name} `
    const next = before + insert + after.replace(/^\s/, "")
    setText(next)
    drafts.set(draftKey, next)
    setMention(undefined)
    pendingCaret.current = (before + insert).length
  }

  // Place the caret right after an inserted mention, in the same commit (before the next keystroke).
  const pendingCaret = useRef<number | null>(null)
  useLayoutEffect(() => {
    const ta = taRef.current
    const pos = pendingCaret.current
    if (!ta || pos === null) return
    pendingCaret.current = null
    ta.focus()
    ta.setSelectionRange(pos, pos)
  }, [text])

  const showDraft = (value: string) => {
    setText(value)
    drafts.set(draftKey, value)
  }
  const dictation = useDictation({
    draftKey,
    onStart: () => {
      const caret = taRef.current?.selectionStart ?? text.length
      setDictatingInto({ base: text, caret })
    },
    onText: (spoken) => {
      if (dictatingInto !== undefined) showDraft(insertDictation(dictatingInto.base, dictatingInto.caret, spoken).text)
    },
    onDone: (spoken) => {
      if (dictatingInto === undefined) return
      const caret = insertDictation(dictatingInto.base, dictatingInto.caret, spoken).caret
      setDictatingInto(undefined)
      requestAnimationFrame(() => {
        taRef.current?.focus()
        taRef.current?.setSelectionRange(caret, caret)
      })
    },
    onCancel: () => {
      if (dictatingInto !== undefined) showDraft(dictatingInto.base)
      setDictatingInto(undefined)
    },
    onError: (message) => toast({ title: message, tone: "danger" }),
  })

  const ready = uploads.filter((u) => u.attachment)
  const canSend = !props.disabled && !uploading && dictation.phase === "idle" && (text.trim().length > 0 || ready.length > 0)

  const submit = async () => {
    if (!canSend) return
    const body = text.trim()
    const scope = members ?? []
    const addressed = scope.filter((b) => new RegExp(`(^|\\s)@${b.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$|[.,!?:;])`, "u").test(body)).map((b) => b.id)
    const everyone = allowEveryone && /(^|\s)@everyone\b/.test(body)
    setText("")
    drafts.delete(draftKey)
    setUploads([])
    setMention(undefined)
    await props.onSubmit({
      text: body,
      attachmentIds: ready.map((u) => u.attachment!.id),
      addressedBotIds: addressed,
      addressEveryone: everyone,
      replyToId: props.replyTo?.id,
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && options.length > 0) {
      if (e.key === "ArrowDown") return (e.preventDefault(), setActive((a) => (a + 1) % options.length))
      if (e.key === "ArrowUp") return (e.preventDefault(), setActive((a) => (a - 1 + options.length) % options.length))
      if (e.key === "Enter" || e.key === "Tab") return (e.preventDefault(), pick(options[active] ?? options[0]!))
      if (e.key === "Escape") return (e.preventDefault(), e.stopPropagation(), setMention(undefined))
    }
    if (e.key === "Escape" && props.replyTo) {
      e.preventDefault()
      e.stopPropagation()
      props.onCancelReply?.()
      return
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !(phone && isTouchNow())) {
      e.preventDefault()
      void submit()
    }
  }

  const onFiles = async (files: ReadonlyArray<File>) => {
    if (files.length === 0) return
    const batch = files.map((f, i) => ({ key: `${Date.now()}-${i}-${f.name}`, name: f.name }))
    setUploads((u) => [...u, ...batch])
    setUploading(true)
    const exit = await upload(files)
    setUploading(false)
    if (Exit.isSuccess(exit)) {
      setUploads((u) => u.map((x) => {
        const idx = batch.findIndex((b) => b.key === x.key)
        return idx >= 0 && exit.value[idx] ? { ...x, attachment: exit.value[idx] } : x
      }))
    } else {
      const msg = describeFailure(exit)
      setUploads((u) => u.filter((x) => !batch.some((b) => b.key === x.key)))
      toast({ title: msg, tone: "danger" })
    }
  }

  const actions = (
    <Menu
      label="Composer actions"
      side="top"
      align="start"
      trigger={(p) =>
        phone ? (
          <IconButton {...p} icon={Plus} label="Composer actions" size={44} variant="elevated" className="shadow-composer" />
        ) : (
          <IconButton {...p} icon={Plus} label="Composer actions" size={28} variant="secondary" className="ring-[0.5px] ring-line-tertiary ring-inset" />
        )
      }
    >
      <MenuItem icon={Paperclip} onSelect={() => fileRef.current?.click()}>
        Attach files
      </MenuItem>
    </Menu>
  )

  return (
    <div className={cn("relative w-full", phone && "flex items-end gap-2", props.className)}>
      {mention && options.length > 0 && (
        <div className={cn("absolute bottom-full z-30 mb-2 animate-fade-in", phone ? "inset-x-0" : "w-[360px]")} style={phone ? undefined : { left: mention.left }}>
          <MenuPanel label="Mention a Bot" className="max-h-[360px] overflow-y-auto scrollbar-thin">
            {options.map((o, i) => (
              <div key={o.id} onPointerMove={() => setActive(i)} onMouseDown={(e) => e.preventDefault()}>
                <MenuItem
                  active={i === active}
                  onSelect={() => pick(o)}
                  leading={o.bot ? <Avatar shape={o.bot.avatar.shape} color={o.bot.avatar.color} size={20} /> : <span className="inline-flex size-5 items-center justify-center rounded-full bg-secondary text-xs text-fg-secondary">@</span>}
                  trailing={o.bot ? "Bot" : "Everyone"}
                  className="min-h-[30px] text-base"
                >
                  {o.name}
                </MenuItem>
              </div>
            ))}
          </MenuPanel>
        </div>
      )}
      {phone && actions}
      <div
        ref={shellRef}
        className={cn(
          "flex w-full flex-col rounded-composer bg-elevated hairline border-line-secondary shadow-composer transition-[border-color] duration-150 focus-within:border-line hover:border-line",
          phone && "min-w-0 flex-1",
        )}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault()
        }}
        onDrop={(e) => {
          if (e.dataTransfer.files.length > 0) {
            e.preventDefault()
            void onFiles([...e.dataTransfer.files])
          }
        }}
      >
        {props.replyTo && (
          <div className="flex items-center gap-2 border-b-[0.5px] border-line-tertiary px-3.5 py-2 text-sm">
            <span className="shrink-0 text-fg-secondary">Replying to {props.replyAuthor ?? "message"}</span>
            <span className="min-w-0 flex-1 truncate text-fg">“{plainPreview(props.replyTo.text, 120)}”</span>
            <IconButton icon={X} label="Cancel reply" size={20} onClick={props.onCancelReply} />
          </div>
        )}
        {uploads.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2 pt-2">
            {uploads.map((u) => (
              <span key={u.key} className="inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-full bg-secondary ps-2.5 pe-1 text-sm text-fg">
                {u.attachment ? <Paperclip size={13} className="shrink-0 text-icon-secondary" aria-hidden /> : <Spinner size={12} />}
                <span className="truncate">{u.name}</span>
                <IconButton icon={X} label={`Remove ${u.name}`} size={20} onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))} />
              </span>
            ))}
          </div>
        )}
        <div className={cn("flex min-h-11 items-end gap-2", phone ? "py-1 ps-3.5 pe-1" : "p-2")}>
          {!phone && actions}
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])]
              e.target.value = ""
              void onFiles(files)
            }}
          />
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            disabled={props.disabled}
            readOnly={dictation.phase !== "idle"}
            aria-label={placeholder}
            placeholder={placeholder}
            enterKeyHint={phone ? "enter" : "send"}
            onChange={(e) => update(e.target.value, e.target.selectionStart)}
            onSelect={(e) => {
              const t = e.currentTarget
              if (mention && t.selectionStart !== t.selectionEnd) setMention(undefined)
            }}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              const files = [...e.clipboardData.files]
              if (files.length > 0) {
                e.preventDefault()
                void onFiles(files)
              }
            }}
            onBlur={() => setTimeout(() => setMention(undefined), 120)}
            className={cn(
              "min-w-0 flex-1 resize-none bg-transparent text-lg leading-5 text-fg outline-none placeholder:text-fg-quaternary focus-visible:outline-none disabled:opacity-60",
              phone ? "self-center py-2" : "py-1",
            )}
          />
          {props.context && <ContextRing {...props.context} />}
          {dictation.available && !props.disabled && <DictationButton dictation={dictation} size={phone ? 36 : 28} />}
          {working && (
            <IconButton icon={Square} label="Stop" title="Stop the Bot" size={phone ? 36 : 28} variant={text.trim() ? "secondary" : "primary"} iconSize="xs" onClick={props.onStop} className="[&_svg]:fill-current" />
          )}
          {(!working || text.trim() || ready.length > 0) && (
            <IconButton icon={ArrowUp} label="Send" size={phone ? 36 : 28} variant="accent" aria-disabled={!canSend || undefined} className={cn(!canSend && "cursor-default", phone && !canSend && "opacity-40")} onClick={() => void submit()} />
          )}
        </div>
      </div>
    </div>
  )
}

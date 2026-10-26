// The pill composer (grok-bot-ui.md §4.6, grok-bot-ui-activity.md F.10.4): + menu (attach files →
// attachments.upload), textarea that grows to 6 lines, @mention picker, Enter to send / Shift+Enter
// for a newline, Stop while the bot works (turns.interrupt) and the context ring. On a phone it is
// Grok iOS's composer: a separate round + beside the pill field, 16 px text (no iOS focus zoom),
// Return inserts a newline and the send button sends; no autofocus (it would pop the keyboard).
import { ArrowUp, AudioLines, Paperclip, Plus, Sparkles, Square, X } from "lucide-react"
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
import { skillCommandLength } from "./skillCommand.ts"
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
  /** `false` (returned at once): not sent, the draft stays (New chat with nobody picked). */
  readonly onSubmit: (draft: ComposerSubmit) => void | false | Promise<unknown>
  readonly replyTo?: MessageEntry | undefined
  readonly replyAuthor?: string | undefined
  readonly onCancelReply?: () => void
  readonly context?: ContextRingProps | undefined
  readonly disabled?: boolean
  readonly autoFocus?: boolean
  /** Starts a voice call with this chat's Bot (experiment): shown instead of Send while the box is empty. */
  readonly onCall?: (() => void) | undefined
  /** The skills the chat's Bot has: typing `/` at the start offers them (D5.5). */
  readonly skills?:
    | ReadonlyArray<{ readonly name: string; readonly description: string; readonly argumentHint?: string | undefined }>
    | undefined
  readonly className?: string
}

const drafts = new Map<string, string>()
const draftsBeingFinished = new Map<string, Promise<unknown>>()

const holdDraft = (draftKey: string, until: Promise<unknown>) => {
  draftsBeingFinished.set(draftKey, until)
  void until.finally(() => {
    if (draftsBeingFinished.get(draftKey) === until) draftsBeingFinished.delete(draftKey)
  })
}
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

/** `/gri` at the start of the message (before the caret): the skill name typed so far. */
const slashQuery = (text: string, caret: number): string | undefined =>
  /^\/([a-z0-9_-]*)$/.exec(text.slice(0, caret))?.[1]

const clipText = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

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
  const [slash, setSlash] = useState<string | undefined>()
  // the message needs the textarea's scrollbar: its text no longer lines up with the highlight under it
  const [tall, setTall] = useState(false)
  const mirrorRef = useRef<HTMLDivElement>(null)
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
    setSlash(undefined)
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
    setTall(ta.scrollHeight > MAX_LINES * LINE + 8)
  }, [text])
  const commandEnd = tall ? 0 : skillCommandLength(text, props.skills)

  const options = useMemo(() => {
    if (!mention) return []
    const q = mention.query.toLowerCase()
    const bots = mentionable
      .filter((b) => b.name.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
    const list: Array<{ id: string; name: string; bot?: Bot }> = bots.map((b) => ({ id: b.id, name: b.name, bot: b }))
    if (allowEveryone && "everyone".startsWith(q)) list.unshift({ id: "everyone", name: "everyone" })
    return list.slice(0, 8)
  }, [mention, mentionable, allowEveryone])

  const skillOptions = useMemo(() => {
    if (slash === undefined) return []
    return (props.skills ?? [])
      .filter((skill) => skill.name.includes(slash))
      .sort((a, b) => Number(!a.name.startsWith(slash)) - Number(!b.name.startsWith(slash)))
      .slice(0, 8)
  }, [slash, props.skills])

  const update = (value: string, caret: number) => {
    setText(value)
    drafts.set(draftKey, value)
    const typed = slashQuery(value, caret)
    if (typed !== slash) setActive(0)
    setSlash(typed)
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

  const pickSkill = (skill: { readonly name: string }) => {
    const caret = taRef.current?.selectionStart ?? text.length
    const insert = `/${skill.name} `
    const next = insert + text.slice(caret).replace(/^\s/, "")
    setText(next)
    drafts.set(draftKey, next)
    setSlash(undefined)
    pendingCaret.current = insert.length
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
    onFinishing: (finishing) => holdDraft(draftKey, finishing),
  })

  const [draftBusyElsewhere, setDraftBusyElsewhere] = useState(() => draftsBeingFinished.has(draftKey))
  useEffect(() => {
    const finishing = draftsBeingFinished.get(draftKey)
    if (finishing === undefined) return
    let mounted = true
    void finishing.finally(() => {
      if (!mounted) return
      setDraftBusyElsewhere(false)
      setText(drafts.get(draftKey) ?? "")
    })
    return () => {
      mounted = false
    }
  }, [draftKey])

  const ready = uploads.filter((u) => u.attachment)
  const dictating = dictation.phase !== "idle"
  // while the microphone starts there is nothing spoken yet: Send sends what is typed, if anything
  const speaking = dictation.phase === "recording" || dictation.phase === "finishing"
  const canSend =
    !props.disabled && !uploading && !draftBusyElsewhere && (speaking || text.trim().length > 0 || ready.length > 0)
  const sendingDictation = useRef(false)
  // read when the send happens (after a transcript finishes, maybe after this Composer unmounted):
  // the files, the reply and where it goes as they are then (New chat's recipients picked meanwhile)
  const current = useRef({ uploads, uploading, replyTo: props.replyTo, onSubmit: props.onSubmit })
  useLayoutEffect(() => {
    current.current = { uploads, uploading, replyTo: props.replyTo, onSubmit: props.onSubmit }
  })

  const submit = async () => {
    if (!canSend) return
    if (!dictating) return send(text)
    if (sendingDictation.current || dictatingInto === undefined) return
    sendingDictation.current = true
    try {
      const spoken = await dictation.finish()
      if (spoken !== undefined) await send(insertDictation(dictatingInto.base, dictatingInto.caret, spoken).text)
    } finally {
      sendingDictation.current = false
    }
  }

  const send = async (draft: string) => {
    const { uploads: attached, uploading: stillUploading, replyTo, onSubmit } = current.current
    if (stillUploading) {
      // a file was added while the transcript finished: the text stays here to send once it is up
      toast({ title: "A file is still uploading: send again when it's done" })
      return
    }
    const sentUploads = attached.filter((u) => u.attachment)
    const body = draft.trim()
    if (body.length === 0 && sentUploads.length === 0) return
    const scope = members ?? []
    const addressed = scope
      .filter((b) =>
        new RegExp(`(^|\\s)@${b.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$|[.,!?:;])`, "u").test(body),
      )
      .map((b) => b.id)
    const everyone = allowEveryone && /(^|\s)@everyone\b/.test(body)
    const submitted = onSubmit({
      text: body,
      attachmentIds: sentUploads.map((u) => u.attachment!.id),
      addressedBotIds: addressed,
      addressEveryone: everyone,
      replyToId: replyTo?.id,
    })
    if (submitted === false) return
    setText("")
    drafts.delete(draftKey)
    setUploads((all) => all.filter((u) => !sentUploads.includes(u)))
    setMention(undefined)
    await submitted
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash !== undefined && skillOptions.length > 0) {
      if (e.key === "ArrowDown") return (e.preventDefault(), setActive((a) => (a + 1) % skillOptions.length))
      if (e.key === "ArrowUp")
        return (e.preventDefault(), setActive((a) => (a - 1 + skillOptions.length) % skillOptions.length))
      if (e.key === "Enter" || e.key === "Tab")
        return (e.preventDefault(), pickSkill(skillOptions[active] ?? skillOptions[0]!))
      if (e.key === "Escape") return (e.preventDefault(), e.stopPropagation(), setSlash(undefined))
    }
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
      setUploads((u) =>
        u.map((x) => {
          const idx = batch.findIndex((b) => b.key === x.key)
          return idx >= 0 && exit.value[idx] ? { ...x, attachment: exit.value[idx] } : x
        }),
      )
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
          <IconButton
            {...p}
            icon={Plus}
            label="Composer actions"
            size={44}
            variant="elevated"
            className="shadow-composer"
          />
        ) : (
          <IconButton
            {...p}
            icon={Plus}
            label="Composer actions"
            size={28}
            variant="secondary"
            className="ring-[0.5px] ring-line-tertiary ring-inset"
          />
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
      {slash !== undefined && skillOptions.length > 0 && (
        <div className={cn("absolute bottom-full z-30 mb-2 animate-fade-in", phone ? "inset-x-0" : "w-[360px]")}>
          <MenuPanel label="Use a skill" className="max-h-[360px] overflow-y-auto scrollbar-thin">
            {skillOptions.map((skill, i) => (
              <div key={skill.name} onPointerMove={() => setActive(i)} onMouseDown={(e) => e.preventDefault()}>
                <MenuItem
                  active={i === active}
                  onSelect={() => pickSkill(skill)}
                  icon={Sparkles}
                  trailing={
                    skill.argumentHint !== undefined
                      ? skill.argumentHint
                      : skill.description === ""
                        ? undefined
                        : clipText(skill.description, 36)
                  }
                  className="min-h-[30px] text-base"
                >
                  /{skill.name}
                </MenuItem>
              </div>
            ))}
          </MenuPanel>
        </div>
      )}
      {mention && options.length > 0 && (
        <div
          className={cn("absolute bottom-full z-30 mb-2 animate-fade-in", phone ? "inset-x-0" : "w-[360px]")}
          style={phone ? undefined : { left: mention.left }}
        >
          <MenuPanel label="Mention a Bot" className="max-h-[360px] overflow-y-auto scrollbar-thin">
            {options.map((o, i) => (
              <div key={o.id} onPointerMove={() => setActive(i)} onMouseDown={(e) => e.preventDefault()}>
                <MenuItem
                  active={i === active}
                  onSelect={() => pick(o)}
                  leading={
                    o.bot ? (
                      <Avatar shape={o.bot.avatar.shape} color={o.bot.avatar.color} size={20} />
                    ) : (
                      <span className="inline-flex size-5 items-center justify-center rounded-full bg-secondary text-xs text-fg-secondary">
                        @
                      </span>
                    )
                  }
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
              <span
                key={u.key}
                className="inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-full bg-secondary ps-2.5 pe-1 text-sm text-fg"
              >
                {u.attachment ? (
                  <Paperclip size={13} className="shrink-0 text-icon-secondary" aria-hidden />
                ) : (
                  <Spinner size={12} />
                )}
                <span className="truncate">{u.name}</span>
                <IconButton
                  icon={X}
                  label={`Remove ${u.name}`}
                  size={20}
                  onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}
                />
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
          <div className={cn("relative min-w-0 flex-1", phone && "self-center")}>
            {commandEnd > 0 && (
              <div
                ref={mirrorRef}
                aria-hidden
                data-testid="composer-command"
                className={cn(
                  "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-lg leading-5 text-fg",
                  phone ? "py-2" : "py-1",
                )}
              >
                <span className="rounded-sm bg-accent-soft text-accent">{text.slice(0, commandEnd)}</span>
                {text.slice(commandEnd)}
              </div>
            )}
            <textarea
              ref={taRef}
              rows={1}
              value={text}
              disabled={props.disabled}
              readOnly={dictation.phase !== "idle" || draftBusyElsewhere}
              aria-label={placeholder}
              placeholder={placeholder}
              enterKeyHint={phone ? "enter" : "send"}
              onChange={(e) => update(e.target.value, e.target.selectionStart)}
              onSelect={(e) => {
                const t = e.currentTarget
                if (mention && t.selectionStart !== t.selectionEnd) setMention(undefined)
              }}
              onKeyDown={onKeyDown}
              onScroll={(e) => {
                if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop
              }}
              onPaste={(e) => {
                const files = [...e.clipboardData.files]
                if (files.length > 0) {
                  e.preventDefault()
                  void onFiles(files)
                }
              }}
              onBlur={() =>
                setTimeout(() => {
                  setMention(undefined)
                  setSlash(undefined)
                }, 120)
              }
              className={cn(
                "relative block w-full min-w-0 resize-none bg-transparent text-lg leading-5 outline-none placeholder:text-fg-quaternary focus-visible:outline-none disabled:opacity-60",
                commandEnd > 0 ? "text-transparent caret-fg" : "text-fg",
                phone ? "py-2" : "py-1",
              )}
            />
          </div>
          {props.context && <ContextRing {...props.context} />}
          {draftBusyElsewhere ? (
            <Spinner size={14} label="Finishing the transcript" />
          ) : (
            dictation.available && !props.disabled && <DictationButton dictation={dictation} size={phone ? 36 : 28} />
          )}
          {working && (
            <IconButton
              icon={Square}
              label="Stop"
              title="Stop the Bot"
              size={phone ? 36 : 28}
              variant={text.trim() ? "secondary" : "primary"}
              iconSize="xs"
              onClick={props.onStop}
              className="[&_svg]:fill-current"
            />
          )}
          {props.onCall !== undefined && !working && !dictating && text.trim() === "" && uploads.length === 0 ? (
            <IconButton
              icon={AudioLines}
              label="Start a voice call"
              size={phone ? 36 : 28}
              variant="accent"
              onClick={props.onCall}
              data-testid="voice-call-button"
            />
          ) : (
            (!working || text.trim() || ready.length > 0) && (
              <IconButton
                icon={ArrowUp}
                label="Send"
                size={phone ? 36 : 28}
                variant="accent"
                aria-disabled={!canSend || undefined}
                className={cn(!canSend && "cursor-default", phone && !canSend && "opacity-40")}
                onClick={() => void submit()}
              />
            )
          )}
        </div>
      </div>
    </div>
  )
}

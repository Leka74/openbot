// Typed in-chat cards (grok-bot-ui.md §4.5, grok-bot-ui-activity.md F.6). Each card renders from its
// `card` transcript entry plus the linked RuntimeRequest (live status) and answers through
// `requests.respond` (a Slack draft: `slack.sendDraft` / `slack.discardDraft`). Unknown card types
// render a placeholder.
import { Check, Clock, ExternalLink, FolderCheck, Globe, Hash, KeyRound, Monitor, ShieldCheck, TriangleAlert } from "lucide-react"
import { type KeyboardEvent, type ReactNode, useMemo, useRef, useState } from "react"
import type { Bot, BotId, Card as CardModel, CardState, DecisionId, EntryId, Question, RuntimeRequest, RuntimeResponse } from "@openbot/contracts"
import {
  Card,
  CardActions,
  CardBody,
  CardHeader,
  CardLink,
  Icon,
  OptionRow,
  PillButton,
  Sheet,
  SheetField,
  StatusPill,
  Switch,
  TextArea,
  TextField,
  cn,
} from "@openbot/ui"
import { useComputerView, useDetailsPane, useSelection, useSettingsDialog } from "../app/uiState.ts"
import { Attachments } from "../chat/Attachments.tsx"
import { renderInline } from "../chat/Markdown.tsx"
import { ScreenPeek } from "../computer/ScreenThumbnail.tsx"
import { useComputer } from "../computer/useComputer.ts"
import { useCommand } from "../details/kit.tsx"
import { useRespond, useSaveRule } from "./useRespond.ts"

export interface CardViewProps {
  readonly card: CardModel
  readonly state: CardState
  readonly request?: RuntimeRequest | undefined
  readonly bot?: Bot | undefined
  /** The card's transcript entry (cards answered by entry, e.g. a Slack draft). */
  readonly entryId?: EntryId | undefined
  readonly className?: string
}

type Status = "pending" | "resolved" | "dismissed" | "expired" | "cancelled" | "info"

const statusOf = (state: CardState, request: RuntimeRequest | undefined): Status => {
  if (request) {
    if (request.status === "pending") return "pending"
    if (request.status === "expired") return "expired"
    if (request.status === "cancelled") return state.status === "dismissed" ? "dismissed" : "cancelled"
    if (request.response?.type === "dismiss") return "dismissed"
    return "resolved"
  }
  return state.status
}

const responseOf = (state: CardState, request: RuntimeRequest | undefined): RuntimeResponse | undefined => request?.response ?? state.response

/** Dispatch on the card type. */
export function CardView(props: CardViewProps): ReactNode {
  const card = props.card
  switch (card.type) {
    case "approval":
      return <ApprovalCard {...props} card={card} />
    case "question":
      return <QuestionCard {...props} card={card} />
    case "form":
      return <FormCard {...props} card={card} />
    case "secret-request":
      return <SecretCard {...props} card={card} />
    case "handoff":
      return <HandoffCard {...props} card={card} />
    case "routine":
      return <RoutineCard {...props} card={card} />
    case "slack-draft":
      return <SlackDraftCard {...props} card={card} />
    default:
      return <UnknownCard className={props.className} />
  }
}

export function UnknownCard({ className }: { readonly className?: string | undefined }): ReactNode {
  return (
    <Card className={cn("text-fg-secondary", className)}>
      <p className="text-base">This card can't be shown in this version of OpenBot. Update OpenBot to see it.</p>
    </Card>
  )
}

// ------------------------------------------------------------------------------------------ approval

type ApprovalModel = Extract<CardModel, { type: "approval" }>

/** "…/projects/snip" for a long folder path (the full path is the tooltip and in the card). */
export const shortFolder = (folder: string): string => {
  const parts = folder.split(/[\\/]+/).filter((p) => p.length > 0)
  return parts.length <= 2 ? folder : `…/${parts.slice(-2).join("/")}`
}

const decisionPill = (status: Status, decision: DecisionId | undefined, inFolder = false): ReactNode => {
  if (status === "pending") return <StatusPill tone="warn">Needs approval</StatusPill>
  if (status === "resolved" && inFolder) {
    return (
      <StatusPill tone="success" dot>
        Allowed in folder
      </StatusPill>
    )
  }
  if (status === "expired")
    return (
      <StatusPill dot tone="neutral">
        Expired
      </StatusPill>
    )
  if (status === "cancelled" || status === "dismissed") return <StatusPill tone="neutral">Cancelled</StatusPill>
  switch (decision) {
    case "allow-always":
      return (
        <StatusPill tone="success" dot>
          Always allowed
        </StatusPill>
      )
    case "allow-session":
      return (
        <StatusPill tone="success" dot>
          Allowed this session
        </StatusPill>
      )
    case "deny":
    case "cancel":
      return (
        <StatusPill tone="danger" dot>
          Denied
        </StatusPill>
      )
    default:
      return <StatusPill tone="neutral">Allowed once</StatusPill>
  }
}

const offersDecision = (request: RuntimeRequest | undefined, id: DecisionId): boolean => {
  const cap = request?.responseCapability
  if (!cap || cap.type !== "decision") return id !== "allow-session"
  return cap.options.some((o) => o.id === id)
}

const ruleText = (card: ApprovalModel, request: RuntimeRequest | undefined): string => {
  const rule = request?.suggestedRule ?? card.suggestedRule
  // Rules are bot-scoped but never directory-scoped: "Run bun test commands", not "… in <dir>".
  if (rule?.match.commandPrefix) return `Run ${rule.match.commandPrefix} commands`
  if (rule?.match.pathPrefix) return `${rule.surface === "file-read" ? "Read" : "Edit"} files under ${rule.match.pathPrefix}`
  if (rule?.match.toolName) return `Use ${rule.match.toolName}`
  return card.summary ?? card.title
}

function ApprovalCard({ card, state, request, bot, className }: CardViewProps & { readonly card: ApprovalModel }): ReactNode {
  const status = statusOf(state, request)
  const response = responseOf(state, request)
  const decision = response?.type === "decision" ? response.decision : undefined
  const { respond, busy } = useRespond(request?.id ?? card.requestId)
  const { save, state: saveState } = useSaveRule(`approval:${card.requestId}`)
  const settings = useSettingsDialog()
  const [showFull, setShowFull] = useState(false)
  const botName = bot?.name ?? "This Bot"
  const summary = card.summary ?? card.command ?? card.reason
  const suggested = request?.suggestedRule ?? card.suggestedRule
  // "Allow in ‹folder›": the folder outside the workspace the request works in (its git repo root)
  const folder = request?.projectFolder ?? card.projectFolder
  const inFolder = response?.type === "decision" && response.scope === "project-folder"
  const { selectBot } = useSelection()
  const details = useDetailsPane()
  return (
    <Card className={className} aria-label={card.title} data-card="approval" data-status={status}>
      <CardHeader
        title={card.title}
        // Raised by the bot's background work (D5.7): which piece of work is asking.
        subtitle={card.taskTitle ? <span data-testid="card-task">Part of “{card.taskTitle}”</span> : undefined}
        status={decisionPill(status, decision, inFolder)}
      />
      {summary && <CardBody className="ob-md -mt-1 text-base">{renderInline(summary)}</CardBody>}
      <CardLink className="-mt-1 text-sm" aria-expanded={showFull} onClick={() => setShowFull((v) => !v)}>
        {showFull ? "Hide the full request" : "View the full request"}
      </CardLink>
      {showFull && (
        <Sheet className="animate-fade-in">
          {card.toolName && <SheetField label="Tool">{card.toolName}</SheetField>}
          {card.command && (
            <SheetField label="Command">
              <code className="font-mono text-sm break-all">{card.command}</code>
            </SheetField>
          )}
          {card.cwd && (
            <SheetField label="Directory">
              <code className="font-mono text-sm break-all">{card.cwd}</code>
            </SheetField>
          )}
          {card.paths && card.paths.length > 0 && (
            <SheetField label="Files">
              <span className="flex flex-col font-mono text-sm break-all">
                {card.paths.map((p) => (
                  <span key={p}>{p}</span>
                ))}
              </span>
            </SheetField>
          )}
          {(card.nodeLabel ?? card.nodeId) && <SheetField label="Computer">{card.nodeLabel ?? card.nodeId}</SheetField>}
          {folder && (
            <SheetField label="Project folder">
              <code className="font-mono text-sm break-all">{folder}</code>
            </SheetField>
          )}
          {card.reason && <SheetField label="Why">{card.reason}</SheetField>}
          {card.diff && <pre className="max-h-64 overflow-auto px-3 py-2 font-mono text-xs leading-[16.5px] text-fg-secondary scrollbar-thin">{card.diff}</pre>}
          {!card.toolName && !card.command && !card.cwd && !card.paths && !card.diff && !card.reason && (
            <SheetField label="Request">{request?.detail ?? card.title}</SheetField>
          )}
        </Sheet>
      )}
      {status === "pending" && (
        <CardActions>
          <PillButton variant="primary" size="card" loading={busy === "allow-once"} disabled={busy !== null} onClick={() => respond({ type: "decision", decision: "allow-once" }, "allow-once")}>
            Allow once
          </PillButton>
          {folder && (
            <PillButton
              variant="secondary"
              size="card"
              title={`Allow this and add ${folder} to ${botName}'s project folders: work there won't ask again`}
              data-testid="allow-in-folder"
              loading={busy === "allow-folder"}
              disabled={busy !== null}
              onClick={() => respond({ type: "decision", decision: "allow-once", scope: "project-folder" }, "allow-folder")}
            >
              Allow in {shortFolder(folder)}
            </PillButton>
          )}
          {offersDecision(request, "allow-always") && (
            <PillButton variant="secondary" size="card" loading={busy === "allow-always"} disabled={busy !== null} onClick={() => respond({ type: "decision", decision: "allow-always" }, "allow-always")}>
              Always allow
            </PillButton>
          )}
          {offersDecision(request, "allow-session") && (
            <PillButton variant="secondary" size="card" loading={busy === "allow-session"} disabled={busy !== null} onClick={() => respond({ type: "decision", decision: "allow-session" }, "allow-session")}>
              Allow this session
            </PillButton>
          )}
          <PillButton variant="tertiary" size="card" className="ms-auto" loading={busy === "deny"} disabled={busy !== null} onClick={() => respond({ type: "decision", decision: "deny" }, "deny")}>
            Deny
          </PillButton>
        </CardActions>
      )}
      {status === "resolved" && decision === "allow-always" && (
        <Sheet>
          <div className="flex items-center gap-2.5 px-3 py-2.5">
            <Icon icon={ShieldCheck} size="lg" className="text-icon-secondary" />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-fg-secondary">Added to your Allow rules</div>
              <div className="truncate text-sm text-fg">“{ruleText(card, request)}”</div>
            </div>
            <PillButton size="card" onClick={() => settings.show("permissions")}>
              Edit rule
            </PillButton>
          </div>
        </Sheet>
      )}
      {status === "resolved" && inFolder && folder && (
        <Sheet>
          <div className="flex items-center gap-2.5 px-3 py-2.5" data-testid="allowed-in-folder">
            <Icon icon={FolderCheck} size="lg" className="text-icon-secondary" />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-fg-secondary">Added to {botName}'s project folders</div>
              <div className="truncate font-mono text-sm text-fg" title={folder}>
                {folder}
              </div>
            </div>
            {request?.botId && (
              <PillButton
                size="card"
                onClick={() => {
                  selectBot(request.botId)
                  details.show("details")
                }}
              >
                Edit
              </PillButton>
            )}
          </div>
        </Sheet>
      )}
      {status === "resolved" && (decision === "deny" || decision === "cancel") && <p className="text-sm text-fg-secondary">{botName} won't do this</p>}
      {status === "expired" && suggested && offersDecision(request, "allow-always") && (
        <div>
          <PillButton
            size="xs"
            leadingIcon={saveState === "saved" ? Check : undefined}
            loading={saveState === "saving"}
            disabled={saveState !== "idle"}
            onClick={() => save({ ...(request?.botId ? { botId: request.botId } : {}), surface: suggested.surface, match: suggested.match, action: "allow" })}
          >
            {saveState === "saved" ? "Will allow next time" : "Always allow next time"}
          </PillButton>
        </div>
      )}
      {status === "expired" && !(suggested && offersDecision(request, "allow-always")) && <p className="text-sm text-fg-secondary">Nobody answered in time, so {botName} skipped this.</p>}
    </Card>
  )
}

// ------------------------------------------------------------------------------------------ question

type QuestionModel = Extract<CardModel, { type: "question" }>
const KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

function QuestionCard({ card, state, request, className }: CardViewProps & { readonly card: QuestionModel }): ReactNode {
  const status = statusOf(state, request)
  const response = responseOf(state, request)
  const { respond, busy } = useRespond(request?.id ?? card.requestId)
  const questions = card.questions
  const single = questions.length === 1 && !questions[0]!.multiSelect
  const [selected, setSelected] = useState<Record<string, ReadonlyArray<string>>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const rootRef = useRef<HTMLElement>(null)
  const answerable = status === "pending" && (request !== undefined || card.requestId !== undefined)

  const submit = (answers: Record<string, ReadonlyArray<string>>) => respond({ type: "answers", answers: answers as Record<string, Array<string>> })

  const choose = (q: Question, label: string) => {
    if (!answerable || busy) return
    if (single) {
      void submit({ [q.id]: [label] })
      return
    }
    setSelected((s) => {
      const cur = s[q.id] ?? []
      const next = q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label]
      return { ...s, [q.id]: next }
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!answerable || e.metaKey || e.ctrlKey || e.altKey) return
    if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA") return
    const i = KEYS.indexOf(e.key.toUpperCase())
    const q = questions[0]
    if (i >= 0 && q && i < q.options.length && e.key.length === 1) {
      e.preventDefault()
      choose(q, q.options[i]!.label)
    }
  }

  if (status === "resolved" && response?.type === "answers") {
    return (
      <Card className={className} data-card="question" data-status="resolved">
        {questions.map((q) => {
          const answers = response.answers[q.id] ?? []
          return (
            <div key={q.id} className="flex flex-col gap-2">
              <CardHeader title={q.header ?? card.title ?? q.prompt} />
              <Sheet>
                {answers.map((a) => {
                  const idx = q.options.findIndex((o) => o.label === a)
                  return (
                    <OptionRow key={a} optionKey={idx >= 0 ? KEYS[idx]! : "✎"} disabled trailing={<Icon icon={Check} size="sm" className="text-success-fg" />}>
                      {a}
                    </OptionRow>
                  )
                })}
              </Sheet>
            </div>
          )
        })}
      </Card>
    )
  }

  const dimmed = status === "dismissed" || status === "expired" || status === "cancelled"
  return (
    <Card ref={rootRef} className={cn(dimmed && "opacity-60", className)} tabIndex={answerable ? 0 : undefined} onKeyDown={onKeyDown} data-card="question" data-status={status}>
      {questions.map((q, qi) => (
        <div key={q.id} className="flex flex-col gap-2.5">
          <CardHeader
            title={q.header ? q.header : qi === 0 ? (card.title ?? q.prompt) : q.prompt}
            subtitle={q.header || (qi === 0 && card.title && card.title !== q.prompt) ? q.prompt : undefined}
            status={
              status === "expired" ? (
                <StatusPill dot>Expired</StatusPill>
              ) : dimmed ? (
                <StatusPill>{state.detail ?? "Skipped"}</StatusPill>
              ) : undefined
            }
            {...(answerable && qi === 0 ? { onClose: () => void respond({ type: "dismiss" }, "dismiss"), closeLabel: "Skip question" } : {})}
          />
          {q.options.length > 0 && (
            <Sheet>
              {q.options.map((o, i) => (
                <OptionRow
                  key={o.label}
                  optionKey={KEYS[i] ?? "•"}
                  selected={(selected[q.id] ?? []).includes(o.label)}
                  disabled={!answerable || busy !== null}
                  onClick={() => choose(q, o.label)}
                  title={o.description}
                >
                  <span className="flex flex-col">
                    <span>{o.label}</span>
                    {o.description && <span className="text-sm text-fg-secondary">{o.description}</span>}
                  </span>
                </OptionRow>
              ))}
            </Sheet>
          )}
          {q.allowFreeText && answerable && (
            <TextField
              placeholder="Type your own answer"
              aria-label="Type your own answer"
              className="h-9 text-lg"
              type={q.isSecret ? "password" : "text"}
              value={custom[q.id] ?? ""}
              onChange={(e) => setCustom((c) => ({ ...c, [q.id]: e.target.value }))}
              onKeyDown={(e) => {
                const value = (custom[q.id] ?? "").trim()
                if (e.key === "Enter" && !e.shiftKey && value) {
                  e.preventDefault()
                  if (single) void submit({ [q.id]: [value] })
                  else setSelected((s) => ({ ...s, [q.id]: [...(s[q.id] ?? []), value] }))
                }
              }}
            />
          )}
        </div>
      ))}
      {answerable && !single && (
        <CardActions>
          <PillButton
            variant="primary"
            size="card"
            loading={busy === "respond"}
            disabled={questions.some((q) => (selected[q.id] ?? []).length === 0 && !(custom[q.id] ?? "").trim())}
            onClick={() => {
              const answers: Record<string, ReadonlyArray<string>> = {}
              for (const q of questions) {
                const extra = (custom[q.id] ?? "").trim()
                answers[q.id] = [...(selected[q.id] ?? []), ...(extra && !(selected[q.id] ?? []).includes(extra) ? [extra] : [])]
              }
              void submit(answers)
            }}
          >
            Submit
          </PillButton>
        </CardActions>
      )}
    </Card>
  )
}

// -------------------------------------------------------------------------------------------- form

type FormModel = Extract<CardModel, { type: "form" }>

function FormCard({ card, state, request, className }: CardViewProps & { readonly card: FormModel }): ReactNode {
  const status = statusOf(state, request)
  const { respond, busy } = useRespond(request?.id ?? card.requestId)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const missing = useMemo(() => card.fields.some((f) => f.required && (values[f.key] === undefined || values[f.key] === "")), [card.fields, values])
  const pending = status === "pending"
  return (
    <Card className={className} data-card="form" data-status={status}>
      <div className="flex items-center gap-2.5">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-elevated hairline border-line-tertiary">
          <Icon icon={Globe} size="lg" className="text-icon-secondary" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg text-fg">{card.title}</div>
          <div className="text-sm text-fg-secondary">{pending ? (card.description ?? "Secure Form") : status === "resolved" ? "Submitted" : "Closed"}</div>
        </div>
        {status === "resolved" && <StatusPill tone="success" dot>Done</StatusPill>}
        {status === "expired" && <StatusPill dot>Expired</StatusPill>}
      </div>
      {pending && (
        <>
          <div className="flex flex-col gap-3 rounded-xl bg-elevated p-3 hairline border-line-quaternary">
            {card.fields.map((f) => {
              const label = `${f.label}${f.required ? "" : " (optional)"}`
              const set = (v: unknown) => setValues((s) => ({ ...s, [f.key]: v }))
              if (f.type === "boolean")
                return (
                  <label key={f.key} className="flex items-center justify-between gap-3 text-base text-fg">
                    <span>{label}</span>
                    <Switch checked={values[f.key] === true} onCheckedChange={set} label={f.label} />
                  </label>
                )
              if (f.type === "text")
                return <TextArea key={f.key} label={label} description={f.description} rows={3} value={String(values[f.key] ?? "")} onChange={(e) => set(e.target.value)} />
              if (f.type === "select" || f.type === "multiselect")
                return (
                  <div key={f.key} className="flex flex-col gap-1.5">
                    <span className="text-xs text-fg-secondary">{label}</span>
                    <div className="flex flex-wrap gap-1.5">
                      {(f.options ?? []).map((o) => {
                        const cur = values[f.key]
                        const on = f.type === "multiselect" ? Array.isArray(cur) && cur.includes(o.label) : cur === o.label
                        return (
                          <PillButton
                            key={o.label}
                            size="sm"
                            variant={on ? "primary" : "secondary"}
                            onClick={() => {
                              if (f.type === "multiselect") {
                                const arr = Array.isArray(cur) ? (cur as string[]) : []
                                set(on ? arr.filter((x) => x !== o.label) : [...arr, o.label])
                              } else set(o.label)
                            }}
                          >
                            {o.label}
                          </PillButton>
                        )
                      })}
                    </div>
                  </div>
                )
              return (
                <TextField
                  key={f.key}
                  label={label}
                  description={f.description}
                  type={f.type === "secret" ? "password" : f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                  value={String(values[f.key] ?? "")}
                  onChange={(e) => set(f.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)}
                />
              )
            })}
          </div>
          <CardActions>
            <PillButton variant="primary" size="card" disabled={missing || busy !== null} loading={busy === "submit"} onClick={() => respond({ type: "form", values }, "submit")}>
              Submit
            </PillButton>
            <PillButton variant="tertiary" size="card" className="ms-auto" disabled={busy !== null} onClick={() => respond({ type: "dismiss" }, "skip")}>
              Skip
            </PillButton>
          </CardActions>
        </>
      )}
    </Card>
  )
}

// ------------------------------------------------------------------------------------------ secret

type SecretModel = Extract<CardModel, { type: "secret-request" }>

function SecretCard({ card, state, request, bot, className }: CardViewProps & { readonly card: SecretModel }): ReactNode {
  const status = statusOf(state, request)
  const { respond, busy } = useRespond(request?.id ?? card.requestId)
  const [value, setValue] = useState("")
  const botName = bot?.name ?? "this Bot"
  return (
    <Card className={className} data-card="secret" data-status={status}>
      <CardHeader
        title={card.label}
        subtitle={[card.envVar ? `Given to ${botName} as ${card.envVar}` : `Given only to ${botName}`, card.description].filter(Boolean).join(". ")}
        icon={<Icon icon={KeyRound} size="lg" className="text-icon-secondary" />}
        status={status === "resolved" ? <StatusPill tone="success" dot>Saved</StatusPill> : status === "expired" ? <StatusPill dot>Expired</StatusPill> : undefined}
      />
      {status === "pending" ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (value) void respond({ type: "secret", value }, "save").then((ok) => ok && setValue(""))
          }}
        >
          <TextField type="password" autoComplete="off" placeholder={`Paste your ${card.label}`} aria-label={card.label} value={value} onChange={(e) => setValue(e.target.value)} wrapperClassName="flex-1" className="h-9 text-lg" />
          <PillButton type="submit" variant="primary" size="card" disabled={!value} loading={busy === "save"}>
            Save securely
          </PillButton>
        </form>
      ) : null}
      <p className="flex items-center gap-1.5 text-sm text-fg-secondary">
        <Icon icon={ShieldCheck} size="sm" />
        {status === "resolved" ? "Saved securely and kept private" : "Never stored by OpenBot and never shown to other Bots."}
      </p>
    </Card>
  )
}

// ----------------------------------------------------------------------------------------- handoff

type HandoffModel = Extract<CardModel, { type: "handoff" }>

/**
 * "Action needed" (a bot's `request_takeover`, D1.7; Grok's computer hand-off card): the bot's
 * instruction ("Sign in to GitHub on my screen"), a live peek at its screen, **Take over** (opens the
 * computer view in control: the lease, not an answer) and **Skip**. While the owner holds the screen
 * the card offers **I'm done**: handing the screen back makes the brain answer the hand-off "done".
 */
function HandoffCard({ card, state, request, bot, className }: CardViewProps & { readonly card: HandoffModel }): ReactNode {
  const status = statusOf(state, request)
  const response = responseOf(state, request)
  const name = bot?.name ?? "Bot"
  const skipped = response?.type === "acknowledge" && response.action === "skip"
  const pill =
    status === "pending" ? (
      <StatusPill tone="success" spinner>
        Action needed
      </StatusPill>
    ) : status === "resolved" ? (
      skipped ? (
        <StatusPill tone="neutral">Skipped</StatusPill>
      ) : (
        <StatusPill tone="success" dot>
          You took over · Done
        </StatusPill>
      )
    ) : (
      <StatusPill dot>{status === "expired" ? "Expired" : "Closed"}</StatusPill>
    )
  const botId = bot?.id ?? request?.botId
  return (
    <Card className={className} data-card="handoff" data-status={status}>
      <CardHeader title="Computer" icon={<Icon icon={Monitor} size="lg" className="text-icon-secondary" />} status={pill} />
      <CardBody className="-mt-1 text-base break-words">{card.instruction}</CardBody>
      {card.screenshotUrl && status !== "pending" && (
        <img src={card.screenshotUrl} alt={`${name}'s screen`} className="aspect-[16/10] w-full rounded-xl object-cover hairline border-line-tertiary" />
      )}
      {status === "pending" && botId !== undefined && <HandoffPending requestId={request?.id ?? card.requestId} botId={botId} botName={name} screenshotUrl={card.screenshotUrl} />}
    </Card>
  )
}

function HandoffPending({ requestId, botId, botName, screenshotUrl }: { readonly requestId: string; readonly botId: BotId; readonly botName: string; readonly screenshotUrl: string | undefined }): ReactNode {
  const { respond, busy } = useRespond(requestId)
  const { status, availability, lease } = useComputer(botId)
  const computer = useComputerView()
  // the owner holds the bot's screen: they took over (the view may be closed by now)
  const controlling = status.value?.controller === "user"
  const hasScreen = availability.kind === "stream" || availability.kind === "absent"
  const skip = async () => {
    const ok = await respond({ type: "acknowledge", action: "skip" }, "skip")
    // answered first, so handing the screen back does not count as "done"
    if (ok && controlling) await lease.run({ botId, take: false })
  }
  return (
    <>
      {screenshotUrl ? (
        <img src={screenshotUrl} alt={`${botName}'s screen`} className="aspect-[16/10] w-full rounded-xl object-cover hairline border-line-tertiary" />
      ) : (
        hasScreen && computer.botId !== botId && <ScreenPeek botId={botId} botName={botName} onOpen={() => computer.open(botId)} />
      )}
      {lease.error && <p className="text-sm text-danger-fg">{lease.error}</p>}
      <CardActions>
        {controlling ? (
          <>
            <PillButton variant="primary" size="card" loading={lease.pending} disabled={busy !== null} onClick={() => void lease.run({ botId, take: false })}>
              I'm done
            </PillButton>
            <PillButton variant="secondary" size="card" disabled={busy !== null} onClick={() => computer.open(botId)}>
              Open screen
            </PillButton>
          </>
        ) : (
          <PillButton variant="secondary" size="card" disabled={busy !== null || availability.kind === "unsupported"} onClick={() => computer.open(botId, { takeControl: true })}>
            Take over
          </PillButton>
        )}
        <PillButton variant="tertiary" size="card" className="ms-auto" disabled={busy !== null || lease.pending} loading={busy === "skip"} onClick={() => void skip()}>
          Skip
        </PillButton>
      </CardActions>
    </>
  )
}

// ----------------------------------------------------------------------------------------- routine

type RoutineModel = Extract<CardModel, { type: "routine" }>

function RoutineCard({ card, className }: CardViewProps & { readonly card: RoutineModel }): ReactNode {
  const details = useDetailsPane()
  return (
    <Card className={className} data-card="routine">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-fg">
          <Icon icon={Clock} size="lg" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm text-fg-secondary">{card.action === "created" ? "Created a routine" : "Updated a routine"}</div>
          <div className="truncate text-lg text-fg">{card.name}</div>
          <div className="text-sm text-fg-secondary">{card.triggerSummary}</div>
        </div>
      </div>
      {card.prompt && <p className="line-clamp-3 text-base text-fg-secondary">{card.prompt}</p>}
      <CardLink className="text-sm" onClick={() => details.show("details")}>
        View routines
      </CardLink>
    </Card>
  )
}

// ------------------------------------------------------------------------------------- Slack draft

type SlackDraftModel = Extract<CardModel, { type: "slack-draft" }>

/**
 * "Slack message" (a Bot's `slack_draft`, D3.4; Grok's Slack draft card): Workspace, To, Thread,
 * then the message, editable while pending, and the files it carries (previewed like a chat's).
 * **Send message** posts it as the owner (with files, the text may be empty); **Discard** drops it.
 * Sent: the message as sent and **Open in Slack**.
 */
function SlackDraftCard({ card, state, entryId, className }: CardViewProps & { readonly card: SlackDraftModel }): ReactNode {
  const status = state.status
  const pending = status === "pending"
  const [text, setText] = useState(card.text)
  const send = useCommand("slack.sendDraft", entryId ?? "")
  const discard = useCommand("slack.discardDraft", entryId ?? "")
  const busy = send.pending || discard.pending
  const files = card.files ?? []
  const pill = pending ? (
    <StatusPill tone="success" dot>
      Ready to send
    </StatusPill>
  ) : status === "resolved" ? (
    <StatusPill tone="success" dot>
      Sent
    </StatusPill>
  ) : (
    <StatusPill tone="neutral">Discarded</StatusPill>
  )
  const error = send.error ?? discard.error
  return (
    <Card className={cn("w-full max-w-[560px]", className)} data-card="slack-draft" data-status={status}>
      <CardHeader
        title="Slack message"
        icon={
          <span className="inline-flex size-9 items-center justify-center rounded-xl bg-elevated hairline border-line-tertiary">
            <Icon icon={Hash} size="lg" className="text-icon-secondary" />
          </span>
        }
        status={pill}
      />
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-fg-secondary">Workspace</dt>
        <dd className="min-w-0 truncate text-fg">{card.team}</dd>
        <dt className="text-fg-secondary">To</dt>
        <dd className="min-w-0 truncate text-fg">{card.to}</dd>
        <dt className="text-fg-secondary">Thread</dt>
        <dd className="min-w-0 truncate text-fg">{card.threadLabel ?? "New message"}</dd>
      </dl>
      {pending ? (
        <TextArea
          aria-label="Message"
          rows={Math.min(10, Math.max(3, text.split("\n").length + 1))}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          className="text-base"
        />
      ) : (
        card.text !== "" && (
          <p className={cn("text-base break-words whitespace-pre-wrap", status !== "resolved" && "text-fg-secondary line-through decoration-fg-tertiary")}>{card.text}</p>
        )
      )}
      {files.length > 0 && <Attachments items={files} side="bot" />}
      {error && <p className="text-sm text-danger-fg">{error}</p>}
      {pending && entryId !== undefined && (
        <CardActions>
          <PillButton
            variant="primary"
            size="card"
            disabled={(text.trim() === "" && files.length === 0) || busy}
            loading={send.pending}
            onClick={() => void send.run({ entryId, text: text.trim() })}
          >
            Send message
          </PillButton>
          <PillButton variant="tertiary" size="card" className="ms-auto" disabled={busy} loading={discard.pending} onClick={() => void discard.run({ entryId })}>
            Discard
          </PillButton>
        </CardActions>
      )}
      {status === "resolved" && state.link !== undefined && (
        <a href={state.link} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1 text-sm text-fg-secondary hover:text-fg">
          Open in Slack
          <Icon icon={ExternalLink} size="sm" />
        </a>
      )}
    </Card>
  )
}

/** Inline warning glyph used by notices and the error tray. */
export const WarnIcon = ({ className }: { readonly className?: string }) => <Icon icon={TriangleAlert} size="md" className={cn("text-danger-fg", className)} />

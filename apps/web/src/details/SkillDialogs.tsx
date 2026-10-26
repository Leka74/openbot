// Skill dialogs shared by Settings › Skills and Details › Library (D5.5): the editor (name, when to use
// it, instructions, which Bots have it; an imported skill also shows where it came from and its other
// files) and the skills.sh import (search → preview → which Bots get it → Install). Phone: full-screen
// sheets that Back closes.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { botsAtom, skillPreviewAtom, skillSearchAtom, skillsAtom } from "@openbot/client"
import type { Bot, BotId, Skill, SkillName, SkillSearchResult } from "@openbot/contracts"
import {
  Avatar,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Icon,
  IconButton,
  LabelChip,
  PillButton,
  Switch,
  TextArea,
  TextField,
  cn,
} from "@openbot/ui"
import { Cause } from "effect"
import { AsyncResult, type Atom } from "effect/reactivity"
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  Search,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react"
import { type ReactNode, useMemo, useState } from "react"
import { useBackDismiss } from "../app/nav.ts"
import { Markdown } from "../chat/Markdown.tsx"
import {
  ConfirmDialog,
  EmptyNote,
  ErrorLine,
  LoadingLine,
  type QueryState,
  formatAgo,
  fromResult,
  useCommand,
  useQuery,
  useRosterValue,
} from "./kit.tsx"
import {
  SKILL_NAME_MAX,
  botsWithSkill,
  formatBytes,
  formatInstalls,
  loseText,
  missingSkillDependencies,
  sameBots,
  skillNameError,
  siblingSkillId,
  skillsShErrorText,
  skillsShUrl,
  toSkillName,
  useDebouncedValue,
} from "./skills.ts"

// ------------------------------------------------------------------------------------------ pieces

/** Multi-select of Bots (checkbox rows, like New group); hidden Bots only when already picked. */
export function BotPicker({
  bots,
  value,
  onChange,
  label = "Bots that have it",
}: {
  readonly bots: ReadonlyArray<Bot>
  readonly value: ReadonlyArray<BotId>
  readonly onChange: (ids: ReadonlyArray<BotId>) => void
  readonly label?: string
}): ReactNode {
  const visible = bots.filter((b) => !b.hidden || value.includes(b.id))
  const allOn = visible.length > 0 && visible.every((b) => value.includes(b.id))
  const toggle = (id: BotId) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-h-5 items-center gap-2">
        <span className="min-w-0 flex-1 text-xs text-fg-secondary">{label}</span>
        {visible.length > 1 && (
          <button
            type="button"
            className="text-xs text-fg-tertiary transition-colors hover:text-fg"
            onClick={() => onChange(allOn ? [] : visible.map((b) => b.id))}
          >
            {allOn ? "Clear" : "Select all"}
          </button>
        )}
      </div>
      <div
        role="group"
        aria-label={label}
        data-testid="skill-bot-picker"
        className="flex max-h-[232px] flex-col gap-px overflow-y-auto rounded-2xl max-sm:max-h-none bg-elevated p-1 hairline border-line-tertiary scrollbar-thin"
      >
        {visible.length === 0 && <p className="px-3 py-3 text-center text-sm text-fg-tertiary">No Bots yet.</p>}
        {visible.map((b) => {
          const on = value.includes(b.id)
          return (
            <button
              key={b.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              onClick={() => toggle(b.id)}
              className={cn(
                "flex min-h-10 items-center gap-2.5 rounded-lg px-2 py-1 text-start transition-colors hover:bg-hover",
                on && "bg-active hover:bg-active",
              )}
            >
              <Avatar shape={b.avatar.shape} color={b.avatar.color} size={24} />
              <span className="min-w-0 truncate text-sm text-fg">{b.name}</span>
              {b.label && <LabelChip className="max-sm:hidden">{b.label}</LabelChip>}
              <span
                className={cn(
                  "ms-auto inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] transition-colors",
                  on ? "bg-primary text-fg-inverted" : "hairline border-line",
                )}
              >
                {on && <Icon icon={Check} size="xs" glyph={12} />}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** The Bots that have a skill as overlapped 20 px avatars (up to 4, then +N), or "No Bots". */
export function SkillBots({ bots }: { readonly bots: ReadonlyArray<Bot> }): ReactNode {
  if (bots.length === 0) return <span className="shrink-0 text-sm text-fg-tertiary">No Bots</span>
  const names = bots.map((b) => b.name).join(", ")
  return (
    <span className="flex shrink-0 items-center" title={names} data-testid="skill-bots">
      <span className="sr-only">{names}</span>
      {bots.slice(0, 4).map((b, i) => (
        <Avatar
          key={b.id}
          shape={b.avatar.shape}
          color={b.avatar.color}
          size={20}
          outlineColor="var(--ob-elevated)"
          className={i > 0 ? "-ms-1.5" : undefined}
        />
      ))}
      {bots.length > 4 && <span className="ms-1 text-xs text-fg-tertiary tabular-nums">+{bots.length - 4}</span>}
    </span>
  )
}

/** "skills.sh" chip of an imported skill (the title shows owner/repo/skill). */
export function SkillsShChip({ id }: { readonly id: string }): ReactNode {
  return (
    <span title={`From skills.sh: ${id}`} className="inline-flex shrink-0">
      <LabelChip>skills.sh</LabelChip>
    </span>
  )
}

/** "needs grilling" chip of a skill whose instructions send the Bot to skills the library doesn't have. */
export function SkillNeedsChip({ names }: { readonly names: ReadonlyArray<string> }): ReactNode {
  return (
    <span title={`Needs ${names.join(", ")}, not in the library`} className="inline-flex shrink-0">
      <LabelChip className="border-warn-line-faint bg-warn-soft font-medium text-warn-fg">
        needs {names.join(", ")}
      </LabelChip>
    </span>
  )
}

/** A skill the one being edited sends the Bot to, missing from the library: install it from the same repo. */
function MissingDependency({
  name,
  source,
  botIds,
}: {
  readonly name: string
  readonly source: Skill["source"]
  readonly botIds: ReadonlyArray<BotId>
}): ReactNode {
  const install = useCommand("skills.install", name, skillsShErrorText)
  const id = source === undefined ? undefined : siblingSkillId(source.id, name)
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-2 rounded-xl border border-warn-line-faint bg-warn-soft px-3 py-2.5 text-sm text-warn-fg"
      data-testid="skill-missing"
    >
      <Icon icon={TriangleAlert} size="md" className="shrink-0 text-warn-bright" />
      <span className="min-w-0 flex-1">
        <strong className="font-semibold">Missing skill: {name}.</strong> These instructions send the Bot to it, but it
        isn't in your library, so the skill can't run properly.
      </span>
      {id !== undefined && (
        <PillButton
          variant="primary"
          size="md"
          loading={install.pending}
          data-testid="skill-install-missing"
          onClick={() => void install.run({ id, botIds: [...botIds] })}
        >
          Install {name}
        </PillButton>
      )}
      {install.error && <p className="w-full text-sm text-danger-fg">{install.error}</p>}
    </div>
  )
}

function ExternalLink({
  href,
  children,
  className,
}: {
  readonly href: string
  readonly children: ReactNode
  readonly className?: string
}): ReactNode {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 text-fg-secondary underline-offset-2 transition-colors hover:text-fg hover:underline",
        className,
      )}
    >
      {children}
      <Icon icon={ArrowUpRight} size="xs" />
    </a>
  )
}

function FieldLabel({
  children,
  trailing,
}: {
  readonly children: ReactNode
  readonly trailing?: ReactNode
}): ReactNode {
  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 text-xs text-fg-secondary">{children}</span>
      {trailing}
    </div>
  )
}

/** A query atom read like `useQuery`, with skills.sh failures in plain words. */
function useSkillsShQuery<A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>): QueryState<A> {
  const result = useAtomValue(atom)
  const refresh = useAtomRefresh(atom)
  return useMemo(() => {
    const state = fromResult(result, refresh)
    return AsyncResult.isFailure(result)
      ? { ...state, error: skillsShErrorText(Cause.squash(result.cause)) ?? state.error }
      : state
  }, [result, refresh])
}

// ------------------------------------------------------------------------------------------ editor

/**
 * New skill (`skill` absent; `botIds` preselects Bots) or edit one. Saves the text (`skills.upsert`)
 * when it changed, then who has it (`skills.assign`) when that changed.
 */
export function SkillEditorDialog({
  skill,
  botIds,
  onClose,
}: {
  readonly skill?: Skill | undefined
  readonly botIds?: ReadonlyArray<BotId>
  readonly onClose: () => void
}): ReactNode {
  useBackDismiss(true, onClose, "skill-editor")
  const bots = useRosterValue<ReadonlyArray<Bot>>(botsAtom, [])
  const library = useQuery(skillsAtom).value ?? []
  const key = skill?.name ?? "new"
  const upsert = useCommand("skills.upsert", key)
  const assign = useCommand("skills.assign", key)
  const del = useCommand("skills.delete", key)
  const [name, setName] = useState("")
  const [description, setDescription] = useState(skill?.description ?? "")
  const [body, setBody] = useState(skill?.body ?? "")
  // off: the Bot starts the skill only when the owner types /name (frontmatter `disable-model-invocation`)
  const [ownerOnly, setOwnerOnly] = useState(skill?.disableModelInvocation === true)
  const [picked, setPicked] = useState<ReadonlyArray<BotId>>(() =>
    skill ? botsWithSkill(bots, skill.name).map((b) => b.id) : [...(botIds ?? [])],
  )
  const [confirm, setConfirm] = useState(false)
  // a new skill whose text was saved but whose Bots were not (assign failed): Save again finishes it
  const [created, setCreated] = useState<SkillName | undefined>(undefined)

  const finalName = (skill?.name ?? toSkillName(name)) as SkillName
  const nameError = skill || created === finalName ? undefined : skillNameError(name, library)
  const holders = skill ? botsWithSkill(bots, skill.name) : []
  const canSave = finalName !== "" && nameError === undefined && description.trim() !== "" && body.trim() !== ""
  const files = skill?.files ?? []
  const missing = missingSkillDependencies({ name: finalName, body }, library)

  const save = async () => {
    const textChanged =
      !skill ||
      description.trim() !== skill.description ||
      body !== skill.body ||
      ownerOnly !== (skill.disableModelInvocation === true)
    if (textChanged) {
      const r = await upsert.run({
        name: finalName,
        description: description.trim(),
        body,
        disableModelInvocation: ownerOnly,
      })
      if (!r.ok) return
      if (!skill) setCreated(finalName)
    }
    const had = skill ? holders.map((b) => b.id) : []
    if (!sameBots(picked, had)) {
      const r = await assign.run({ name: finalName, botIds: [...picked] })
      if (!r.ok) return
    }
    onClose()
  }

  const error = upsert.error ?? assign.error ?? del.error
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      width={600}
      label={skill ? `Skill ${skill.name}` : "New skill"}
      className="ob-phone-full"
    >
      <DialogHeader
        title={<span className="break-all">{skill ? skill.name : "New skill"}</span>}
        description={skill ? `Updated ${formatAgo(skill.updatedAt)}` : "Skills are how-tos your Bots follow."}
        onClose={onClose}
      />
      <DialogBody className="flex flex-col gap-4">
        {missing.map((dep) => (
          <MissingDependency key={dep} name={dep} source={skill?.source} botIds={picked} />
        ))}
        {skill?.source && (
          <div
            className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-secondary px-3 py-2 text-sm"
            data-testid="skill-source"
          >
            <span className="text-fg-secondary">From skills.sh</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={skill.source.id}>
              {skill.source.id}
            </span>
            <ExternalLink href={skillsShUrl(skill.source.id)} className="text-sm">
              View
            </ExternalLink>
          </div>
        )}
        {!skill && (
          <TextField
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="weekly-report"
            maxLength={SKILL_NAME_MAX}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            error={nameError}
            description={
              finalName && finalName !== name.trim() ? `Saved as ${finalName}` : "Lower-case letters, digits, - and _."
            }
            data-autofocus
            data-testid="skill-name"
          />
        )}
        <TextArea
          label="When to use it"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Use when asked for the weekly status report"
          description="Bots read this to decide when the skill applies."
          className="max-h-40 min-h-[52px] [field-sizing:content]"
          data-testid="skill-description"
        />
        <TextArea
          label="Instructions"
          rows={12}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={
            "Steps, checklists, examples… in Markdown.\n\n1. Collect last week's done tickets\n2. Group them by project\n3. Post the summary to #status"
          }
          className="min-h-48 font-mono text-xs leading-[18px]"
          data-testid="skill-body"
        />
        {files.length > 0 && (
          <div className="flex flex-col gap-1.5" data-testid="skill-files">
            <FieldLabel>Other files · {files.length}</FieldLabel>
            <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-xl bg-secondary px-3 py-2 scrollbar-thin">
              {files.map((f) => (
                <li key={f} className="flex min-w-0 items-center gap-2 text-fg-secondary">
                  <Icon icon={FileText} size="xs" className="shrink-0 text-icon-tertiary" />
                  <span className="truncate font-mono text-xs" title={f}>
                    {f}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-fg-tertiary">
              Bots open these while they use the skill. Edit them on the server.
            </p>
          </div>
        )}
        <div className="flex items-center gap-3" data-testid="skill-auto">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm text-fg">Bot may start it on its own</span>
            <span className="text-xs text-fg-tertiary">
              Off: the Bot uses it only when you type /{finalName || "name"} in the chat.
            </span>
          </div>
          <Switch
            checked={!ownerOnly}
            onCheckedChange={(on) => setOwnerOnly(!on)}
            label="Bot may start it on its own"
          />
        </div>
        <BotPicker bots={bots} value={picked} onChange={setPicked} />
        {error && <ErrorLine className="px-0">{error}</ErrorLine>}
      </DialogBody>
      <DialogFooter>
        {skill && (
          <IconButton
            icon={Trash2}
            label="Delete skill"
            size={36}
            variant="secondary"
            className="me-auto"
            onClick={() => setConfirm(true)}
            data-testid="delete-skill"
          />
        )}
        <PillButton variant="secondary" size="card" onClick={onClose}>
          Cancel
        </PillButton>
        <PillButton
          variant="primary"
          size="card"
          disabled={!canSave}
          loading={upsert.pending || assign.pending}
          onClick={() => void save()}
          data-testid="save-skill"
        >
          {skill ? "Save" : "Create"}
        </PillButton>
      </DialogFooter>
      {skill && (
        <ConfirmDialog
          open={confirm}
          title={`Delete “${skill.name}”?`}
          body={loseText(holders)}
          confirmLabel="Delete"
          danger
          pending={del.pending}
          error={del.error}
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            const r = await del.run({ name: skill.name })
            if (r.ok) onClose()
          }}
        />
      )}
    </Dialog>
  )
}

// ------------------------------------------------------------------------------------------ import

/** skills.sh import: search, then a preview of the picked skill, then Install (`botIds` preselects Bots). */
export function SkillImportDialog({
  botIds,
  onClose,
}: {
  readonly botIds?: ReadonlyArray<BotId>
  readonly onClose: () => void
}): ReactNode {
  useBackDismiss(true, onClose, "skill-import")
  const [query, setQuery] = useState("")
  const [picked, setPicked] = useState<SkillSearchResult | undefined>(undefined)
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      width={640}
      height={680}
      label="Import from skills.sh"
      className="ob-phone-full"
    >
      {/* the search stays mounted under the preview, so Back shows the same results */}
      <div className={cn("flex min-h-0 flex-1 flex-col", picked && "hidden")}>
        <ImportSearch query={query} setQuery={setQuery} onPick={setPicked} onClose={onClose} />
      </div>
      {picked && (
        <ImportPreview
          key={picked.id}
          result={picked}
          botIds={botIds}
          onBack={() => setPicked(undefined)}
          onClose={onClose}
        />
      )}
    </Dialog>
  )
}

function ImportSearch({
  query,
  setQuery,
  onPick,
  onClose,
}: {
  readonly query: string
  readonly setQuery: (q: string) => void
  readonly onPick: (r: SkillSearchResult) => void
  readonly onClose: () => void
}): ReactNode {
  // search ~300 ms after the typing stops, from 2 characters
  const settled = useDebouncedValue(query.trim(), 300)
  const active = settled.length >= 2 ? settled : ""
  return (
    <>
      <DialogHeader
        title="Import from skills.sh"
        description="Skills shared by the community. Look at what one does before you add it."
        onClose={onClose}
      />
      <div className="relative mx-4 mb-3">
        <Icon
          icon={Search}
          size="sm"
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-icon-tertiary"
        />
        <TextField
          aria-label="Search skills.sh"
          enterKeyHint="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search skills, e.g. pdf"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="h-9 rounded-xl ps-8"
          data-autofocus
          data-testid="skills-sh-search"
        />
      </div>
      <DialogBody>
        {active === "" ? (
          <EmptyNote className="pt-10">Search for what you need, like “pdf”, “spreadsheet” or “code review”.</EmptyNote>
        ) : (
          <SearchResults query={active} onPick={onPick} />
        )}
      </DialogBody>
    </>
  )
}

function SearchResults({
  query,
  onPick,
}: {
  readonly query: string
  readonly onPick: (r: SkillSearchResult) => void
}): ReactNode {
  const search = useSkillsShQuery(skillSearchAtom(query))
  const library = useQuery(skillsAtom).value ?? []
  // the last answer stays (dimmed) while the next query runs; only the current query's atom fills it
  const [last, setLast] = useState<ReadonlyArray<SkillSearchResult> | undefined>(undefined)
  if (search.value !== undefined && search.value !== last) setLast(search.value)
  const results = search.value ?? last
  const busy = search.value === undefined && search.error === undefined
  if (search.error && search.value === undefined)
    return (
      <ErrorLine onRetry={search.refresh} className="px-1">
        {search.error}
      </ErrorLine>
    )
  if (results === undefined || (results.length === 0 && busy)) return <LoadingLine>Searching skills.sh…</LoadingLine>
  if (results.length === 0) return <EmptyNote className="pt-10">Nothing on skills.sh matches “{query}”.</EmptyNote>
  return (
    <div
      aria-busy={busy}
      data-testid="skills-sh-results"
      className={cn(
        "flex flex-col gap-px rounded-2xl bg-elevated p-1 hairline border-line-tertiary transition-opacity",
        busy && "opacity-60",
      )}
    >
      {results.map((r) => {
        const installed = library.some((s) => s.source?.id === r.id)
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onPick(r)}
            data-testid="skills-sh-result"
            className="flex min-h-12 items-center gap-3 rounded-lg px-2 py-1.5 text-start transition-colors hover:bg-hover"
          >
            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-icon-secondary">
              <Icon icon={Sparkles} size="md" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm text-fg">{r.name}</span>
              <span className="truncate text-xs text-fg-secondary">{r.repo}</span>
            </span>
            <span className="shrink-0 text-end text-xs text-fg-tertiary tabular-nums">
              {installed ? "In your library" : formatInstalls(r.installs)}
            </span>
            <Icon icon={ChevronRight} size="xs" className="shrink-0 text-icon-tertiary" />
          </button>
        )
      })}
    </div>
  )
}

function ImportPreview({
  result,
  botIds,
  onBack,
  onClose,
}: {
  readonly result: SkillSearchResult
  readonly botIds: ReadonlyArray<BotId> | undefined
  readonly onBack: () => void
  readonly onClose: () => void
}): ReactNode {
  const preview = useSkillsShQuery(skillPreviewAtom(result.id))
  const bots = useRosterValue<ReadonlyArray<Bot>>(botsAtom, [])
  const library = useQuery(skillsAtom).value ?? []
  const [picked, setPicked] = useState<ReadonlyArray<BotId>>(() => [...(botIds ?? [])])
  const install = useCommand("skills.install", result.id, skillsShErrorText)
  const assign = useCommand("skills.assign", `import:${result.id}`)
  const p = preview.value
  const replaces = p !== undefined && (p.replaces || library.some((s) => s.name === p.name))
  const holders = p !== undefined && replaces ? botsWithSkill(bots, p.name).map((b) => b.id) : []
  // replacing a skill: the Bots that have it start checked (the picker says who has it afterwards)
  const [seeded, setSeeded] = useState(false)
  if (p !== undefined && !seeded) {
    setSeeded(true)
    if (holders.length > 0) setPicked((ids) => [...new Set([...ids, ...holders])])
  }
  const totalBytes = p?.files.reduce((n, f) => n + f.bytes, 0) ?? 0
  const go = async () => {
    const r = await install.run({ id: result.id, botIds: [...picked] })
    if (!r.ok) return
    // install only gives the skill; Bots unchecked here that had it lose it
    if (
      holders.some((id) => !picked.includes(id)) &&
      !(await assign.run({ name: r.value.name, botIds: [...picked] })).ok
    )
      return
    onClose()
  }
  return (
    <>
      <div className="flex shrink-0 items-center gap-1 px-2 pt-2.5 pb-1">
        <button
          type="button"
          onClick={onBack}
          data-testid="skills-sh-back"
          className="inline-flex h-8 items-center gap-0.5 rounded-full ps-1 pe-3 text-sm text-fg-secondary transition-colors hover:bg-hover hover:text-fg"
        >
          <Icon icon={ChevronLeft} size="md" />
          Results
        </button>
        <span className="flex-1" />
        <IconButton icon={X} label="Close" size={28} className="me-1.5" onClick={onClose} />
      </div>
      <DialogBody className="flex flex-col gap-4">
        <div className="flex flex-col gap-1" data-testid="skill-preview">
          <h2 className="text-xl font-medium break-all text-fg">{p?.name ?? result.name}</h2>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-fg-secondary">
            <span className="min-w-0 truncate">{result.repo}</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{formatInstalls(result.installs)}</span>
            <span aria-hidden>·</span>
            <ExternalLink href={skillsShUrl(result.id)}>View on skills.sh</ExternalLink>
          </div>
        </div>
        {preview.loading ? (
          <LoadingLine>Getting it from skills.sh…</LoadingLine>
        ) : preview.error && !p ? (
          <ErrorLine onRetry={preview.refresh} className="px-0">
            {preview.error}
          </ErrorLine>
        ) : p ? (
          <>
            {p.description && <p className="text-base text-fg">{p.description}</p>}
            {replaces && (
              <div
                role="note"
                data-testid="skill-replaces"
                className="flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn-fg"
              >
                <Icon icon={TriangleAlert} size="sm" className="mt-0.5 shrink-0" />
                <span>
                  Your library already has a skill named “{p.name}”. Installing replaces it, for every Bot that has it.
                </span>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <FieldLabel>SKILL.md</FieldLabel>
              <div
                className="max-h-[300px] overflow-y-auto rounded-xl bg-secondary px-3 py-2.5 text-sm text-fg scrollbar-thin"
                data-testid="skill-preview-body"
              >
                <Markdown text={p.body} />
              </div>
            </div>
            <div className="flex flex-col gap-1.5" data-testid="skill-preview-files">
              <FieldLabel
                trailing={<span className="text-xs text-fg-tertiary tabular-nums">{formatBytes(totalBytes)}</span>}
              >
                {p.files.length === 1 ? "1 file" : `${p.files.length} files`}
              </FieldLabel>
              <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-xl bg-secondary px-3 py-2 scrollbar-thin">
                {p.files.map((f) => (
                  <li key={f.path} className="flex min-w-0 items-center gap-2 text-fg-secondary">
                    <Icon icon={FileText} size="xs" className="shrink-0 text-icon-tertiary" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.path}>
                      {f.path}
                    </span>
                    <span className="shrink-0 text-xs text-fg-tertiary tabular-nums">{formatBytes(f.bytes)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <BotPicker bots={bots} value={picked} onChange={setPicked} label="Give it to" />
          </>
        ) : null}
        {(install.error ?? assign.error) && <ErrorLine className="px-0">{install.error ?? assign.error}</ErrorLine>}
      </DialogBody>
      <DialogFooter>
        <PillButton variant="secondary" size="card" onClick={onBack}>
          Back
        </PillButton>
        <PillButton
          variant="primary"
          size="card"
          disabled={!p}
          loading={install.pending || assign.pending}
          onClick={() => void go()}
          data-testid="install-skill"
        >
          {replaces ? "Replace" : "Install"}
        </PillButton>
      </DialogFooter>
    </>
  )
}

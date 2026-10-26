// Settings › Skills (D5.5): the skills library — one row per skill (name, when to use it, a skills.sh
// chip for imported ones, the Bots that have it); a row opens the editor. "New skill" writes one,
// "Import" brings one in from skills.sh. Which Bots have a skill is also set in Details › Library.
import { botsAtom, skillsAtom } from "@openbot/client"
import type { Bot, Skill } from "@openbot/contracts"
import { Icon, PillButton } from "@openbot/ui"
import { ChevronRight, Download, Plus, Sparkles } from "lucide-react"
import { Fragment, type ReactNode, useState } from "react"
import { ErrorLine, LoadingLine, useQuery, useRosterValue } from "../details/kit.tsx"
import {
  SkillBots,
  SkillEditorDialog,
  SkillImportDialog,
  SkillNeedsChip,
  SkillsShChip,
} from "../details/SkillDialogs.tsx"
import { botsWithSkill, missingSkillDependencies } from "../details/skills.ts"
import { GroupLabel, PageHeader, RowDivider, SettingsCard } from "./layout.tsx"

export function SkillsPage(): ReactNode {
  const skills = useQuery(skillsAtom)
  const bots = useRosterValue<ReadonlyArray<Bot>>(botsAtom, [])
  const [editing, setEditing] = useState<Skill | "new" | undefined>(undefined)
  const [importing, setImporting] = useState(false)
  const list = [...(skills.value ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  // the editor follows the library (a save or an import refetches it)
  const open = editing === "new" ? undefined : editing && (list.find((s) => s.name === editing.name) ?? editing)

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Skills"
        description="Skills are how-tos your Bots follow. Each Bot uses only the skills it has, and Bots can save their own."
        actions={
          <>
            <PillButton
              variant="secondary"
              size="md"
              leadingIcon={Download}
              onClick={() => setImporting(true)}
              data-testid="import-skill"
            >
              <span className="max-sm:hidden">Import from skills.sh</span>
              <span className="sm:hidden">Import</span>
            </PillButton>
            <PillButton
              variant="primary"
              size="md"
              leadingIcon={Plus}
              onClick={() => setEditing("new")}
              data-testid="new-skill"
            >
              New skill
            </PillButton>
          </>
        }
      />

      <GroupLabel
        trailing={
          list.length > 0 ? <span className="text-sm text-fg-tertiary tabular-nums">{list.length}</span> : undefined
        }
      >
        Library
      </GroupLabel>
      <SettingsCard testId="skills-library">
        {skills.loading ? (
          <LoadingLine />
        ) : skills.error && !skills.value ? (
          <ErrorLine onRetry={skills.refresh} className="px-4">
            {skills.error}
          </ErrorLine>
        ) : list.length === 0 ? (
          <p className="px-4 py-5 text-center text-sm text-fg-secondary">
            No skills yet. Write one, import one from skills.sh, or ask a Bot to save one.
          </p>
        ) : (
          list.map((s, i) => (
            <Fragment key={s.name}>
              {i > 0 && <RowDivider />}
              <button
                type="button"
                onClick={() => setEditing(s)}
                data-testid="skill-row"
                className="mx-1 flex min-h-[60px] items-center gap-3 rounded-2xl px-3 py-2 text-start transition-colors hover:bg-hover"
              >
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-icon-secondary max-sm:hidden">
                  <Icon icon={Sparkles} size="md" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-base text-fg">{s.name}</span>
                    {s.source && <SkillsShChip id={s.source.id} />}
                    {missingSkillDependencies(s, list).length > 0 && (
                      <SkillNeedsChip names={missingSkillDependencies(s, list)} />
                    )}
                  </span>
                  <span className="truncate text-sm text-fg-secondary">{s.description}</span>
                </span>
                <SkillBots bots={botsWithSkill(bots, s.name)} />
                <Icon icon={ChevronRight} size="sm" className="shrink-0 text-icon-tertiary" />
              </button>
            </Fragment>
          ))
        )}
      </SettingsCard>
      <p className="mt-3 px-1 text-2xs text-fg-quaternary">
        A Bot that wants a skill it doesn't have asks you first. To let that happen without asking, add a rule in
        Permissions.
      </p>

      {editing && (
        <SkillEditorDialog
          key={editing === "new" ? "new" : editing.name}
          skill={open}
          onClose={() => setEditing(undefined)}
        />
      )}
      {importing && <SkillImportDialog onClose={() => setImporting(false)} />}
    </div>
  )
}

// Details › Library: THIS Bot's skills (D5.5; `Bot.skills`, live in the roster). A row opens the skill's
// editor; its × takes the skill away from this Bot (bots.update). "+" adds a library skill the Bot
// doesn't have, writes a new one for it, or imports one from skills.sh. The library itself lives in
// Settings › Skills. Workspace files have no RPC yet (interfaces.md §9).
import { skillsAtom } from "@openbot/client"
import type { Bot, Skill, SkillName } from "@openbot/contracts"
import { Icon, IconButton, Menu, MenuItem, MenuLabel, MenuSeparator } from "@openbot/ui"
import { Download, Plus, Sparkles, X } from "lucide-react"
import { type ReactNode, useState } from "react"
import { useSettingsDialog } from "../contracts.ts"
import { EmptyNote, ErrorLine, LoadingLine, Section, SectionSheet, useCommand, useQuery } from "./kit.tsx"
import { SkillEditorDialog, SkillImportDialog, SkillNeedsChip, SkillsShChip } from "./SkillDialogs.tsx"
import { missingSkillDependencies, skillsOfBot } from "./skills.ts"

export function LibraryTab({ bot }: { readonly bot: Bot }): ReactNode {
  const skills = useQuery(skillsAtom)
  const settings = useSettingsDialog()
  const update = useCommand("bots.update", `${bot.id}/skills`)
  const [editing, setEditing] = useState<Skill | "new" | undefined>(undefined)
  const [importing, setImporting] = useState(false)
  const library = skills.value ?? []
  const mine = skillsOfBot(bot, library)
  const others = library.filter((s) => !bot.skills.includes(s.name)).sort((a, b) => a.name.localeCompare(b.name))
  const setSkills = (names: ReadonlyArray<SkillName>) =>
    void update.run({ botId: bot.id, patch: { skills: [...names] } })
  const open = editing === "new" ? undefined : editing && (library.find((s) => s.name === editing.name) ?? editing)

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Skills"
        trailing={
          <Menu
            label="Add a skill"
            align="end"
            panelClassName="max-h-[min(420px,60vh)] max-w-[300px] overflow-y-auto scrollbar-thin"
            trigger={(p) => (
              <IconButton {...p} icon={Plus} label="Add skill" size={24} iconSize="sm" data-testid="add-skill" />
            )}
          >
            <MenuLabel>
              {others.length > 0
                ? "From the library"
                : library.length > 0
                  ? `${bot.name} has every library skill`
                  : "The library is empty"}
            </MenuLabel>
            {others.map((s) => (
              <MenuItem key={s.name} icon={Sparkles} onSelect={() => setSkills([...bot.skills, s.name])}>
                <span title={s.description}>{s.name}</span>
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem icon={Plus} onSelect={() => setEditing("new")}>
              New skill…
            </MenuItem>
            <MenuItem icon={Download} onSelect={() => setImporting(true)}>
              Browse skills.sh…
            </MenuItem>
          </Menu>
        }
      >
        {skills.loading ? (
          <LoadingLine />
        ) : skills.error && !skills.value ? (
          <ErrorLine onRetry={skills.refresh}>{skills.error}</ErrorLine>
        ) : mine.length === 0 ? (
          <EmptyNote>
            {bot.name} has no skills yet. Add one from the library, or ask {bot.name} to save one.
          </EmptyNote>
        ) : (
          <SectionSheet>
            {mine.map((s) => (
              <div
                key={s.name}
                role="group"
                aria-label={s.name}
                data-testid="skill-row"
                className="group flex min-h-12 items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-hover"
              >
                <Icon icon={Sparkles} size="md" className="shrink-0 text-accent" />
                <button
                  type="button"
                  onClick={() => s.updatedAt !== undefined && setEditing(s as Skill)}
                  className="flex min-w-0 flex-1 flex-col text-start"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm text-fg">{s.name}</span>
                    {s.source && <SkillsShChip id={s.source.id} />}
                    {missingSkillDependencies({ name: s.name, body: s.body ?? "" }, library).length > 0 && (
                      <SkillNeedsChip names={missingSkillDependencies({ name: s.name, body: s.body ?? "" }, library)} />
                    )}
                  </span>
                  <span className="truncate text-sm text-fg-secondary" title={s.description}>
                    {s.description || "…"}
                  </span>
                </button>
                <IconButton
                  icon={X}
                  label={`Take ${s.name} away from ${bot.name}`}
                  size={24}
                  iconSize="sm"
                  disabled={update.pending}
                  onClick={() => setSkills(bot.skills.filter((n) => n !== s.name))}
                  className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                  data-testid="remove-skill"
                />
              </div>
            ))}
          </SectionSheet>
        )}
        {update.error && <ErrorLine>{update.error}</ErrorLine>}
        <button
          type="button"
          onClick={() => settings.show("skills")}
          data-testid="manage-library"
          className="self-start px-3 text-sm text-fg-secondary underline-offset-2 transition-colors hover:text-fg hover:underline"
        >
          Manage the library
        </button>
      </Section>
      {editing && (
        <SkillEditorDialog
          key={editing === "new" ? "new" : editing.name}
          skill={open}
          botIds={[bot.id]}
          onClose={() => setEditing(undefined)}
        />
      )}
      {importing && <SkillImportDialog botIds={[bot.id]} onClose={() => setImporting(false)} />}
    </div>
  )
}

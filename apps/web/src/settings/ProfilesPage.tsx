// Settings › Profiles: the owner's profiles, each with its own Bots, chats, memory, skills, routines
// and connections. Create, rename, switch and delete; the switch is brain-wide (app/profiles.ts).
import { useAtomValue } from "@effect/atom-react"
import { profilesAtom } from "@openbot/client"
import { MAIN_PROFILE_ID, type OwnerProfile } from "@openbot/contracts"
import { Icon, LabelChip, Menu, MenuItem, MenuSeparator, PillButton, TextField, cn } from "@openbot/ui"
import { AsyncResult } from "effect/reactivity"
import { Ellipsis, Pencil, Plus, Trash2, UserRound } from "lucide-react"
import { type ReactNode, useState } from "react"
import { InlineEdit } from "../details/InlineEdit.tsx"
import { ConfirmDialog, ErrorLine, LoadingLine, useCommand } from "../details/kit.tsx"
import { GroupLabel, PageHeader, SettingsCard } from "./layout.tsx"

export function ProfilesPage(): ReactNode {
  const profiles = useAtomValue(profilesAtom)
  const [creating, setCreating] = useState(false)
  return (
    <div className="flex flex-col">
      <PageHeader
        title="Profiles"
        description="Each profile has its own Bots, chats, memory, skills, routines and connections. Computers and harness logins are shared. Switching changes what every open app shows; the other profiles keep working and tell you what happened when you come back."
        actions={
          <PillButton variant="primary" size="card" leadingIcon={Plus} onClick={() => setCreating(true)}>
            New profile
          </PillButton>
        }
      />
      <GroupLabel>Profiles</GroupLabel>
      <SettingsCard testId="profiles-list">
        {creating && <NewProfileForm onDone={() => setCreating(false)} />}
        {AsyncResult.isSuccess(profiles) ? (
          profiles.value.profiles.map((profile, i) => (
            <ProfileRow
              key={profile.id}
              profile={profile}
              active={profile.id === profiles.value.activeId}
              divider={creating || i > 0}
            />
          ))
        ) : (
          <LoadingLine className="py-6" />
        )}
      </SettingsCard>
    </div>
  )
}

function NewProfileForm({ onDone }: { readonly onDone: () => void }): ReactNode {
  const create = useCommand("profiles.create")
  const [name, setName] = useState("")
  return (
    <form
      className="flex flex-col gap-2 px-4 py-3"
      onSubmit={async (e) => {
        e.preventDefault()
        if ((await create.run({ name: name.trim() })).ok) onDone()
      }}
    >
      <div className="flex items-end gap-2">
        <TextField
          label="Name"
          placeholder="Demo"
          value={name}
          maxLength={64}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          wrapperClassName="min-w-0 flex-1"
        />
        <PillButton type="submit" size="md" variant="primary" loading={create.pending} disabled={name.trim() === ""}>
          Create
        </PillButton>
        <PillButton size="md" variant="secondary" onClick={onDone}>
          Cancel
        </PillButton>
      </div>
      {create.error && <ErrorLine className="px-0">{create.error}</ErrorLine>}
    </form>
  )
}

function ProfileRow({
  profile,
  active,
  divider,
}: {
  readonly profile: OwnerProfile
  readonly active: boolean
  readonly divider: boolean
}): ReactNode {
  const rename = useCommand("profiles.rename", profile.id)
  const switchTo = useCommand("profiles.switch", profile.id)
  const remove = useCommand("profiles.delete", profile.id)
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const error = rename.error ?? switchTo.error
  return (
    <div className={cn("flex flex-col", divider && "border-t-[0.5px] border-line-tertiary")} data-testid="profile-row">
      <div className="flex min-h-14 items-center gap-3 px-4 py-2">
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-icon">
          <Icon icon={UserRound} size="md" />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {renaming ? (
            <InlineEdit
              value={profile.name}
              placeholder="Name"
              label="Profile name"
              startEditing
              onEditEnd={() => setRenaming(false)}
              className="text-start text-base font-medium text-fg"
              onSave={(name) => rename.run({ profileId: profile.id, name })}
            />
          ) : (
            <span className="truncate text-base font-medium text-fg">{profile.name}</span>
          )}
          {active && <LabelChip>Active</LabelChip>}
        </div>
        {!active && (
          <PillButton
            size="sm"
            variant="secondary"
            loading={switchTo.pending}
            onClick={() => void switchTo.run({ profileId: profile.id })}
          >
            Switch
          </PillButton>
        )}
        <Menu
          label={`${profile.name} actions`}
          align="end"
          trigger={(p) => (
            <button
              {...p}
              type="button"
              aria-label={`${profile.name} actions`}
              className="inline-flex size-7 items-center justify-center rounded-full text-icon-secondary hover:bg-secondary aria-expanded:bg-secondary"
            >
              <Icon icon={Ellipsis} size="sm" />
            </button>
          )}
        >
          <MenuItem icon={Pencil} onSelect={() => setRenaming(true)}>
            Rename
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={Trash2}
            danger
            disabled={active || profile.id === MAIN_PROFILE_ID}
            onSelect={() => setConfirmDelete(true)}
          >
            Delete
          </MenuItem>
        </Menu>
      </div>
      {error && <ErrorLine className="px-4">{error}</ErrorLine>}
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${profile.name}?`}
        body="Its Bots, with their chats, memory, routines and tasks, and its settings are deleted for good. Computers and harness logins stay."
        confirmLabel="Delete"
        danger
        pending={remove.pending}
        error={remove.error}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          if ((await remove.run({ profileId: profile.id })).ok) setConfirmDelete(false)
        }}
      />
    </div>
  )
}

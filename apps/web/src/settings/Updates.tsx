// Settings › About › Updates: the version that runs, the newest release and what changed since, the
// Update button (the brain installs it and restarts into it), going back to the release before, and
// "Install updates automatically" (Settings `autoUpdate`). The brain's side is apps/server/src/updates.ts.
import { useAtomValue } from "@effect/atom-react"
import { activeProfileIdAtom, updatesStatusAtom } from "@openbot/client"
import { MAIN_PROFILE_ID, type UpdateStatus } from "@openbot/contracts"
import { PillButton, Spinner, Switch } from "@openbot/ui"
import { RefreshCw } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import { ErrorLine, LoadingLine, useCommand, useQuery } from "../details/kit.tsx"
import { useSettingsEditor } from "./GeneralPage.tsx"
import { RowDivider, SettingsCard, SettingsRow } from "./layout.tsx"

const COMMITS_FIRST = 8

const ago = (at: number) => {
  const minutes = Math.round((Date.now() - at) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

const versionOf = (status: UpdateStatus) =>
  `${status.current.version}${status.current.dirty === true ? " (with local changes)" : ""}`

/** The updates card of Settings › About. */
export function UpdatesCard(): ReactNode {
  const status = useQuery(updatesStatusAtom)
  const check = useCommand("updates.check", "about")
  const install = useCommand("updates.install", "about")
  const rollback = useCommand("updates.rollback", "about")
  const { settings, patch, error: settingsError } = useSettingsEditor()
  // the brain reads autoUpdate from the main profile only
  const inMain = useAtomValue(activeProfileIdAtom) === MAIN_PROFILE_ID
  const [allCommits, setAllCommits] = useState(false)
  const value = status.value
  const installing = value?.state === "installing"
  // while it installs, the brain restarts: keep asking until the new one answers
  useEffect(() => {
    if (!installing) return
    const timer = setInterval(status.refresh, 3_000)
    return () => clearInterval(timer)
  }, [installing, status.refresh])

  if (value === undefined)
    return (
      <SettingsCard>
        {status.loading ? <LoadingLine /> : <ErrorLine className="px-4 py-3">{status.error}</ErrorLine>}
      </SettingsCard>
    )

  const commits = value.commits ?? []
  const shown = allCommits ? commits : commits.slice(0, COMMITS_FIRST)
  const available = value.state === "available" && value.latest !== undefined
  const error = install.error ?? rollback.error ?? check.error ?? settingsError

  return (
    <SettingsCard>
      <SettingsRow
        title="Version"
        description={value.current.sha === undefined ? undefined : `Commit ${value.current.sha.slice(0, 7)}`}
        control={
          <span className="font-mono text-xs text-fg-secondary select-all" data-testid="update-version">
            {versionOf(value)}
          </span>
        }
      />
      <RowDivider />
      {installing ? (
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              <Spinner size={14} /> Updating to {value.latest?.version ?? "the new release"}
            </span>
          }
          description={`${value.step ?? "Working…"} Running work gets time to finish; OpenBot restarts by itself and this page comes back.`}
        />
      ) : available ? (
        <SettingsRow
          title={`OpenBot ${value.latest!.version} is available`}
          description={
            value.behind === undefined
              ? `Released ${ago(value.latest!.publishedAt)}.`
              : `${value.behind} change${value.behind === 1 ? "" : "s"}, released ${ago(value.latest!.publishedAt)}.`
          }
          control={
            value.canInstall ? (
              <PillButton
                variant="primary"
                size="card"
                leadingIcon={RefreshCw}
                loading={install.pending}
                onClick={() => void install.run(undefined as never)}
                data-testid="update-install"
              >
                Update
              </PillButton>
            ) : undefined
          }
        >
          {shown.length > 0 && (
            <ul className="flex flex-col gap-1 pt-1" data-testid="update-commits">
              {shown.map((c) => (
                <li key={c.sha} className="flex gap-2 text-sm text-fg-secondary">
                  <span className="shrink-0 font-mono text-xs leading-5 text-fg-tertiary">{c.sha}</span>
                  <span className="min-w-0">{c.message}</span>
                </li>
              ))}
              {commits.length > COMMITS_FIRST && (
                <li>
                  <button
                    type="button"
                    className="text-sm text-accent-fg hover:underline"
                    onClick={() => setAllCommits((v) => !v)}
                  >
                    {allCommits ? "Show fewer" : `Show all ${commits.length}`}
                  </button>
                </li>
              )}
            </ul>
          )}
          {!value.canInstall && (
            <p className="text-sm text-fg-tertiary">
              This OpenBot runs from a clone, not from releases: update it with <code>git pull</code>.
            </p>
          )}
        </SettingsRow>
      ) : (
        <SettingsRow
          title={value.state === "up-to-date" ? "Up to date" : value.state === "checking" ? "Checking…" : "Updates"}
          description={value.checkedAt === undefined ? "Not checked yet." : `Checked ${ago(value.checkedAt)}.`}
          control={
            <PillButton
              variant="secondary"
              size="card"
              loading={check.pending || value.state === "checking"}
              onClick={() => void check.run(undefined as never)}
              data-testid="update-check"
            >
              Check now
            </PillButton>
          }
        />
      )}
      {(value.problem !== undefined || error !== undefined) && !installing && (
        <ErrorLine className="px-4 pb-3">{error ?? value.problem}</ErrorLine>
      )}
      {value.canInstall && inMain && (
        <>
          <RowDivider />
          <SettingsRow
            title="Install updates automatically"
            description="When a new release is out and no Bot has worked for 5 minutes. Off: you choose when, here."
            control={
              <Switch
                checked={settings.autoUpdate}
                onCheckedChange={(autoUpdate) => void patch({ autoUpdate })}
                label="Install updates automatically"
              />
            }
          />
        </>
      )}
      {value.previous !== undefined && !installing && (
        <>
          <RowDivider />
          <SettingsRow
            title="Go back"
            description={`Run ${value.previous} again, the release before this one.`}
            control={
              <PillButton
                variant="secondary"
                size="card"
                loading={rollback.pending}
                onClick={() => void rollback.run(undefined as never)}
                data-testid="update-rollback"
              >
                Go back
              </PillButton>
            }
          />
        </>
      )}
    </SettingsCard>
  )
}

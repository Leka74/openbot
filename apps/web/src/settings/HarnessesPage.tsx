// Settings › Harnesses (grok-bot-ui-activity.md F.10.2, OpenBot original): one card per harness with
// install / version, models and capabilities, and one row per ACCOUNT (harness profile: a login /
// config dir on the brain machine, e.g. ~/.claude-2) with its status and account email. "Add account"
// offers the config dirs the brain found plus a path field; accounts no bot uses can be removed.
// A harness that supports it signs in from here: the brain runs its login command and passes on the
// one-time code from the sign-in page. Otherwise sign-in happens in a terminal on the brain machine.
import { harnessDiscoverAtom, harnessModelsAtom, harnessStatusAtom } from "@openbot/client"
import type { HarnessCapabilities, HarnessStatus } from "@openbot/contracts"
import { Icon, IconButton, PillButton, TextField, cn } from "@openbot/ui"
import { ChevronDown, ExternalLink, LogIn, Plus, RefreshCw, Trash2 } from "lucide-react"
import { type ReactNode, useState } from "react"
import {
  CommandBlock,
  ConfirmDialog,
  ErrorLine,
  HarnessStatusPill,
  HarnessTile,
  INSTALL_HINTS,
  LoadingLine,
  accountName,
  accountNickname,
  formatAgo,
  groupStatuses,
  harnessName,
  harnessReady,
  signInCommand,
  statusProfileId,
  useCommand,
  useQuery,
} from "../details/kit.tsx"
import { GroupLabel, PageHeader, RowDivider, SettingsCard, SettingsRow } from "./layout.tsx"

/** Harnesses that can have more than their default account. */
const MULTI_ACCOUNT = new Set(["claude", "codex"])
const CONFIG_DIR_HINT: Record<string, string> = { claude: "~/.claude-2", codex: "~/.codex-work" }

export function HarnessesPage({ focus }: { readonly focus?: string }): ReactNode {
  const statuses = useQuery(harnessStatusAtom)
  const groups = groupStatuses(statuses.value ?? [])
  return (
    <div className="flex flex-col">
      <PageHeader
        title="Harnesses"
        description="Each Bot thinks with one of these. OpenBot reuses the logins already on the machine where the harness runs, so you can mix subscriptions and accounts."
        actions={
          <PillButton
            size="md"
            variant="secondary"
            leadingIcon={RefreshCw}
            loading={statuses.waiting && !statuses.loading}
            onClick={statuses.refresh}
          >
            Check again
          </PillButton>
        }
      />
      <GroupLabel>On this server</GroupLabel>
      {statuses.loading ? (
        <LoadingLine />
      ) : statuses.error && !statuses.value ? (
        <ErrorLine onRetry={statuses.refresh}>Couldn't check the harnesses: {statuses.error}</ErrorLine>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((g) => (
            <HarnessCard
              key={g.kind}
              kind={g.kind}
              accounts={g.accounts}
              highlighted={focus === g.kind}
              onRefresh={statuses.refresh}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const CAPABILITY_LABELS: ReadonlyArray<[keyof HarnessCapabilities, string]> = [
  ["resume", "Resume"],
  ["steer", "Steer mid-turn"],
  ["interrupt", "Interrupt"],
  ["questions", "Questions"],
  ["compact", "Compact"],
  ["contextUsage", "Context meter"],
  ["images", "Images"],
]

function HarnessCard({
  kind,
  accounts,
  highlighted,
  onRefresh,
}: {
  readonly kind: string
  readonly accounts: ReadonlyArray<HarnessStatus>
  readonly highlighted: boolean
  readonly onRefresh: () => void
}): ReactNode {
  const [adding, setAdding] = useState(false)
  const first = accounts[0]!
  const isFake = kind === "fake"
  const installed = accounts.some((s) => s.installed)
  const version = accounts.find((s) => s.version)?.version
  const checkedAt = accounts.reduce<number | undefined>(
    (at, s) => (s.checkedAt !== undefined && (at === undefined || s.checkedAt > at) ? s.checkedAt : at),
    undefined,
  )
  const modelsFrom = accounts.find(harnessReady)
  const caps = first.capabilities
  const install = INSTALL_HINTS[kind]
  const multi = MULTI_ACCOUNT.has(kind)
  const description = isFake
    ? "Scripted offline harness. Try OpenBot without any account."
    : installed
      ? [
          version ? `v${version}` : "Installed",
          checkedAt ? `checked ${formatAgo(checkedAt)}` : undefined,
          accounts.length > 1 ? `${accounts.length} accounts` : undefined,
        ]
          .filter(Boolean)
          .join(" · ")
      : "Not found on this server"
  return (
    <SettingsCard
      className={cn(highlighted && "ring-2 ring-[color-mix(in_srgb,var(--ob-focus)_35%,transparent)]")}
      testId={`harness-${kind}`}
    >
      <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
        <HarnessTile kind={kind} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-base font-medium text-fg">{harnessName(kind, first)}</span>
          <span className="truncate text-sm text-fg-secondary">{description}</span>
        </div>
        {accounts.length === 1 && <HarnessStatusPill status={first} />}
        {multi && installed && (
          <PillButton
            size="md"
            variant="secondary"
            leadingIcon={Plus}
            onClick={() => setAdding(!adding)}
            data-testid={`add-account-${kind}`}
          >
            Add account
          </PillButton>
        )}
      </div>
      {!isFake &&
        accounts.map((s) => (
          <div key={statusProfileId(s)}>
            <RowDivider />
            <AccountRow status={s} showPill={accounts.length > 1} onRefresh={onRefresh} />
          </div>
        ))}
      {adding && (
        <>
          <RowDivider />
          <AddAccount kind={kind} onDone={() => setAdding(false)} />
        </>
      )}
      {modelsFrom && (
        <>
          <RowDivider />
          <ModelsRow kind={kind} profileId={statusProfileId(modelsFrom)} />
        </>
      )}
      {caps && (
        <SettingsRow
          title="Supports"
          control={
            <span className="flex max-w-[420px] flex-wrap justify-end gap-1">
              {CAPABILITY_LABELS.filter(([k]) => caps[k] === true).map(([, label]) => (
                <span key={label} className="rounded-sm bg-secondary px-1.5 py-px text-2xs text-fg-secondary">
                  {label}
                </span>
              ))}
              <span className="rounded-sm bg-secondary px-1.5 py-px text-2xs text-fg-secondary">
                Approvals:{" "}
                {caps.approvals === "interactive"
                  ? "ask you"
                  : caps.approvals === "policy-only"
                    ? "rules only"
                    : "none"}
              </span>
            </span>
          }
        />
      )}
      {!isFake && !installed && install && (
        <SettingsRow title="Install it" description="Run this on the server, then check again.">
          <CommandBlock command={install} />
        </SettingsRow>
      )}
    </SettingsCard>
  )
}

function AccountRow({
  status,
  showPill,
  onRefresh,
}: {
  readonly status: HarnessStatus
  readonly showPill: boolean
  readonly onRefresh: () => void
}): ReactNode {
  const profileId = statusProfileId(status)
  const isDefault = profileId === "default"
  const [confirm, setConfirm] = useState(false)
  const remove = useCommand("harnesses.removeProfile", profileId)
  const [signingInAgain, setSigningInAgain] = useState(false)
  const signedIn = status.auth.state === "signed-in"
  const signIn = signInCommand(status)
  const nick = accountNickname(status)
  const name =
    status.auth.state === "signed-in" || status.account
      ? accountName(status)
      : status.auth.state === "signed-out"
        ? "Not signed in"
        : accountName(status)
  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-1.5" data-testid={`account-${status.kind}-${profileId}`}>
          <span className="truncate">{nick ? `${nick} · ${name}` : name}</span>
          {isDefault && (
            <span className="shrink-0 rounded-sm bg-secondary px-1.5 py-px text-2xs text-fg-secondary">Default</span>
          )}
        </span>
      }
      description={status.configDir ? <span className="font-mono text-xs">{status.configDir}</span> : undefined}
      control={
        <span className="flex shrink-0 items-center gap-1.5">
          {showPill && <HarnessStatusPill status={status} />}
          {status.signInFromApp && signedIn && !signingInAgain && (
            <IconButton
              icon={LogIn}
              label="Sign in again"
              size={28}
              iconSize="sm"
              onClick={() => setSigningInAgain(true)}
            />
          )}
          {!isDefault && (
            <IconButton icon={Trash2} label="Remove account" size={28} iconSize="sm" onClick={() => setConfirm(true)} />
          )}
        </span>
      }
    >
      {status.problems.length > 0 && (
        <div className="flex flex-col gap-1">
          {status.problems.map((p) => (
            <span key={p} className="text-sm text-danger-fg">
              {p}
            </span>
          ))}
        </div>
      )}
      {status.installed && status.signInFromApp && (!signedIn || signingInAgain) && (
        <SignInHere
          status={status}
          terminalCommand={signIn}
          onFinished={() => {
            setSigningInAgain(false)
            onRefresh()
          }}
          onCancel={signingInAgain ? () => setSigningInAgain(false) : undefined}
        />
      )}
      {status.installed && !status.signInFromApp && !signedIn && signIn && (
        <div className="flex flex-col gap-2">
          <span className="text-sm text-fg-secondary">
            Run this in a terminal on the server with your own account, then check again. OpenBot never sees your
            password or tokens.
          </span>
          <CommandBlock command={signIn} />
          <div className="flex justify-end">
            <PillButton size="md" variant="secondary" onClick={onRefresh}>
              I've signed in
            </PillButton>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        title="Remove this account?"
        body={`OpenBot stops using ${status.configDir ?? "this login"}. Nothing on disk is deleted, and you can add it again later.`}
        confirmLabel="Remove"
        danger
        pending={remove.pending}
        error={remove.error}
        onCancel={() => {
          remove.clearError()
          setConfirm(false)
        }}
        onConfirm={async () => {
          const r = await remove.run({ profileId })
          if (r.ok) setConfirm(false)
        }}
      />
    </SettingsRow>
  )
}

function SignInHere({
  status,
  terminalCommand,
  onFinished,
  onCancel,
}: {
  readonly status: HarnessStatus
  readonly terminalCommand: string | undefined
  readonly onFinished: () => void
  readonly onCancel: (() => void) | undefined
}): ReactNode {
  const profileId = statusProfileId(status)
  const account = { kind: status.kind, profileId }
  const commandKey = `${status.kind}/${profileId}`
  const start = useCommand("harnesses.startSignIn", commandKey)
  const finish = useCommand("harnesses.completeSignIn", commandKey)
  const cancel = useCommand("harnesses.cancelSignIn", commandKey)
  const [signInUrl, setSignInUrl] = useState<string | undefined>(undefined)
  const [code, setCode] = useState("")
  const name = harnessName(status.kind, status)

  const begin = async () => {
    finish.clearError()
    setCode("")
    const started = await start.run(account)
    if (started.ok) setSignInUrl(started.value.url)
  }
  const submit = async () => {
    const finished = await finish.run({ ...account, code: code.trim() })
    setSignInUrl(undefined)
    setCode("")
    if (finished.ok) onFinished()
  }
  const stop = () => {
    if (signInUrl !== undefined) void cancel.run(account)
    setSignInUrl(undefined)
    start.clearError()
    finish.clearError()
    onCancel?.()
  }

  if (signInUrl === undefined) {
    return (
      <div className="flex flex-col gap-2" data-testid={`sign-in-${status.kind}-${profileId}`}>
        <span className="text-sm text-fg-secondary">
          Sign in with your browser. OpenBot runs the {name} login on the server and gives it the one-time code from the
          sign-in page. OpenBot never sees your password or tokens.
        </span>
        {(start.error ?? finish.error) && <ErrorLine className="px-0">{start.error ?? finish.error}</ErrorLine>}
        <div className="flex justify-end gap-2">
          {onCancel && (
            <PillButton size="md" variant="secondary" onClick={stop}>
              Cancel
            </PillButton>
          )}
          <PillButton
            size="md"
            variant="primary"
            leadingIcon={LogIn}
            loading={start.pending}
            onClick={() => void begin()}
          >
            {finish.error ? "Start again" : "Sign in"}
          </PillButton>
        </div>
        {terminalCommand && (
          <details className="text-sm text-fg-secondary">
            <summary className="cursor-pointer">Or sign in from a terminal on the server</summary>
            <div className="pt-2">
              <CommandBlock command={terminalCommand} />
            </div>
          </details>
        )}
      </div>
    )
  }

  return (
    <form
      className="flex flex-col gap-3"
      data-testid={`sign-in-${status.kind}-${profileId}`}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-fg">1. Open the sign-in page and approve.</span>
        <span className="text-xs text-fg-secondary">
          If your browser is signed in to a different {name} account, open the page in a private window.
        </span>
        <div>
          <PillButton
            size="md"
            variant="secondary"
            leadingIcon={ExternalLink}
            onClick={() => window.open(signInUrl, "_blank", "noopener,noreferrer")}
          >
            Open the sign-in page
          </PillButton>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <TextField
          label="2. Paste the code that the page shows"
          placeholder="Code"
          value={code}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setCode(e.target.value)}
          wrapperClassName="min-w-[240px] flex-1"
          className="font-mono text-sm"
        />
        <PillButton size="md" variant="secondary" onClick={stop}>
          Cancel
        </PillButton>
        <PillButton type="submit" size="md" variant="primary" loading={finish.pending} disabled={code.trim() === ""}>
          Finish sign-in
        </PillButton>
      </div>
    </form>
  )
}

function AddAccount({ kind, onDone }: { readonly kind: string; readonly onDone: () => void }): ReactNode {
  const found = useQuery(harnessDiscoverAtom(kind))
  const add = useCommand("harnesses.addProfile", kind)
  const [configDir, setConfigDir] = useState("")
  const [label, setLabel] = useState("")
  const submit = async (input: { readonly configDir: string; readonly label: string }) => {
    const r = await add.run({ kind, ...input })
    if (r.ok) onDone()
  }
  const candidates = found.value ?? []
  return (
    <div className="flex flex-col gap-3 px-4 py-3" data-testid={`add-account-form-${kind}`}>
      <div className="text-base text-fg">Add a {harnessName(kind)} account</div>
      <p className="text-sm text-fg-secondary">
        An account is a separate login on this server, kept in its own config folder (for example the folder a{" "}
        <span className="font-mono">{kind === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"}</span> points at). OpenBot
        runs the CLI with that folder; it never reads or copies your tokens.
      </p>
      {found.loading ? (
        <LoadingLine className="justify-start px-0 py-1">Looking for logins…</LoadingLine>
      ) : candidates.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-fg-secondary">Found on this server</span>
          {candidates.map((c) => (
            <div
              key={c.configDir}
              className="flex items-center gap-3 rounded-xl px-3 py-2 hairline border-line-tertiary"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-fg">{c.suggestedLabel}</span>
                <span className="truncate font-mono text-xs text-fg-secondary">{c.configDir}</span>
              </div>
              <PillButton
                size="sm"
                variant="secondary"
                loading={add.pending}
                onClick={() => void submit({ configDir: c.configDir, label: c.suggestedLabel })}
              >
                Add
              </PillButton>
            </div>
          ))}
        </div>
      ) : (
        <span className="text-xs text-fg-tertiary">
          No other logins found in your home folder. Enter the folder below.
        </span>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void submit({ configDir, label })
        }}
      >
        <TextField
          label="Config folder"
          placeholder={CONFIG_DIR_HINT[kind] ?? "~/.config-dir"}
          value={configDir}
          onChange={(e) => setConfigDir(e.target.value)}
          wrapperClassName="min-w-[220px] flex-1"
          className="font-mono text-sm"
        />
        <TextField
          label="Label"
          placeholder="Work"
          value={label}
          maxLength={64}
          onChange={(e) => setLabel(e.target.value)}
          wrapperClassName="w-[160px]"
        />
        <PillButton type="submit" size="md" variant="primary" loading={add.pending} disabled={configDir.trim() === ""}>
          Add
        </PillButton>
        <PillButton size="md" variant="secondary" onClick={onDone}>
          Cancel
        </PillButton>
      </form>
      {add.error && <ErrorLine className="px-0">{add.error}</ErrorLine>}
    </div>
  )
}

function ModelsRow({ kind, profileId }: { readonly kind: string; readonly profileId: string }): ReactNode {
  const models = useQuery(harnessModelsAtom(kind, profileId))
  const [open, setOpen] = useState(false)
  const list = models.value ?? []
  const def = list.find((m) => m.default)
  return (
    <SettingsRow
      title="Models"
      description={
        models.loading
          ? "Loading…"
          : models.error && !models.value
            ? models.error
            : `${list.length} available${def ? ` · default ${def.label || def.id}` : ""}`
      }
      control={
        list.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-sm text-fg-secondary hover:bg-hover"
          >
            {open ? "Hide" : "Show"}
            <Icon icon={ChevronDown} size="sm" className={cn("transition-transform", open && "rotate-180")} />
          </button>
        )
      }
    >
      {open && (
        <div className="flex flex-wrap gap-1.5">
          {list.map((m) => (
            <span
              key={m.id}
              title={m.id}
              className={cn(
                "rounded-md px-2 py-0.5 text-xs hairline",
                m.default ? "border-line bg-active text-fg" : "border-line-tertiary text-fg-secondary",
              )}
            >
              {m.label || m.id}
            </span>
          ))}
        </div>
      )}
    </SettingsRow>
  )
}

// Connect apps › Hark (D3.5): OpenBot's notifications on the owner's iPhone through Hark until the
// OpenBot iPhone app has its own. Not connected: get Hark on the iPhone, create a service in Hark's
// web dashboard (the app has none), paste its webhook (OpenBot sends a test notification to check
// it). Connected: what to send, a test, Disconnect.
import { harkStatusAtom } from "@openbot/client"
import type { HarkSends, HarkStatus } from "@openbot/contracts"
import { PillButton, Select, TextField } from "@openbot/ui"
import { ExternalLink } from "lucide-react"
import { type ReactNode, useState } from "react"
import { ConfirmDialog, ErrorLine, formatWhen, LoadingLine, useCommand, useQuery } from "../details/kit.tsx"
import { GroupLabel, RowDivider, SettingsCard, SettingsRow } from "../settings/layout.tsx"

export const HARK_SITE = "https://hark.ryan.ceo"
const HARK_APP_STORE = "https://apps.apple.com/us/app/hark-developer-notifications/id6794121509"

export function HarkApp(): ReactNode {
  const status = useQuery(harkStatusAtom)
  return (
    <div className="flex flex-col">
      {status.loading ? (
        <LoadingLine />
      ) : status.error && !status.value ? (
        <ErrorLine onRetry={status.refresh}>Couldn't check Hark: {status.error}</ErrorLine>
      ) : status.value?.connected ? (
        <Connected status={status.value} />
      ) : (
        <Connect />
      )}
    </div>
  )
}

function Connect(): ReactNode {
  const connect = useCommand("hark.connect")
  const [webhook, setWebhook] = useState("")
  return (
    <>
      <GroupLabel>Connect Hark</GroupLabel>
      <SettingsCard testId="hark-connect">
        <SettingsRow
          title="1. Get Hark on your iPhone"
          description="Install it, sign in and allow notifications."
          control={
            <PillButton variant="secondary" size="md" trailingIcon={ExternalLink} onClick={() => window.open(HARK_APP_STORE, "_blank", "noopener")}>
              App Store
            </PillButton>
          }
        />
        <RowDivider />
        <SettingsRow
          title="2. Create a service"
          description="In Hark's web dashboard (signed in with the same account), create a service called OpenBot and copy the webhook URL it shows (…/hooks/whk_…)."
          wide
          control={
            <PillButton variant="secondary" size="md" trailingIcon={ExternalLink} onClick={() => window.open(HARK_SITE, "_blank", "noopener")}>
              Hark dashboard
            </PillButton>
          }
        >
          <TextField
            type="password"
            autoComplete="off"
            placeholder="https://hark.ryan.ceo/hooks/whk_…"
            aria-label="Hark webhook"
            value={webhook}
            onChange={(e) => setWebhook(e.target.value)}
          />
        </SettingsRow>
        <RowDivider />
        <SettingsRow
          title="Connect"
          description="OpenBot sends a test notification to your iPhone and keeps the webhook on this server."
          control={
            <PillButton
              variant="primary"
              size="md"
              disabled={webhook.trim() === ""}
              loading={connect.pending}
              data-testid="hark-connect-button"
              onClick={() => void connect.run({ webhook: webhook.trim() }).then((r) => r.ok && setWebhook(""))}
            >
              Connect
            </PillButton>
          }
        >
          {connect.error && <p className="text-sm text-danger-fg">{connect.error}</p>}
        </SettingsRow>
      </SettingsCard>
    </>
  )
}

const SENDS: ReadonlyArray<{ readonly value: HarkSends; readonly label: string }> = [
  { value: "all", label: "Everything" },
  { value: "needs-you", label: "When a Bot needs you" },
]

function Connected({ status }: { readonly status: HarkStatus }): ReactNode {
  const setSends = useCommand("hark.setSends")
  const test = useCommand("hark.test")
  const disconnect = useCommand("hark.disconnect")
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <GroupLabel>Connected</GroupLabel>
      <SettingsCard testId="hark-connected">
        <SettingsRow
          title="Send to your iPhone"
          description={status.sends === "all"
            ? "Every notification: a Bot finished, wrote, needs you, a routine ran, something failed."
            : "Only when a Bot is waiting for you (a question, an approval, your screen) or something failed."}
          control={
            <Select<HarkSends>
              label="Send"
              value={status.sends}
              onValueChange={(sends) => void setSends.run({ sends })}
              options={SENDS}
            />
          }
        >
          {setSends.error && <p className="text-sm text-danger-fg">{setSends.error}</p>}
        </SettingsRow>
        <RowDivider />
        <SettingsRow
          title="Test"
          description={status.problem ?? (status.lastSentAt === undefined ? "Nothing sent yet." : `Last notification sent ${formatWhen(status.lastSentAt)}.`)}
          control={
            <PillButton variant="secondary" size="md" loading={test.pending} onClick={() => void test.run(undefined as never)}>
              Send a test
            </PillButton>
          }
        >
          {test.error && <p className="text-sm text-danger-fg">{test.error}</p>}
        </SettingsRow>
        <RowDivider />
        <SettingsRow
          title="Disconnect"
          description="OpenBot stops sending to Hark and forgets the webhook."
          control={
            <PillButton variant="secondary" size="md" onClick={() => setConfirming(true)}>
              Disconnect
            </PillButton>
          }
        />
      </SettingsCard>
      <ConfirmDialog
        open={confirming}
        title="Disconnect Hark?"
        body="Your iPhone stops getting OpenBot's notifications. The service stays in Hark until you remove it there."
        confirmLabel="Disconnect"
        danger
        pending={disconnect.pending}
        error={disconnect.error}
        onConfirm={() => void disconnect.run(undefined as never).then((r) => r.ok && setConfirming(false))}
        onCancel={() => setConfirming(false)}
      />
    </>
  )
}

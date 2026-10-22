// Settings › General: appearance (theme, accent, show steps), Bots (bot messaging kill switch, idle
// compaction, default harness, approval expiry), the owner's name, and the apps (desktop app, iPhone
// app, notifications on this device). Values ride on the roster (`settingsAtom`); edits are applied
// optimistically until the roster echoes them.
import { useAtomValue } from "@effect/atom-react"
import { harnessStatusAtom, settingsAtom } from "@openbot/client"
import { type Settings, type SettingsPatch, applySettingsPatch } from "@openbot/contracts"
import { Select, Switch, TextField } from "@openbot/ui"
import { type ReactNode, useState } from "react"
import { ErrorLine, harnessName, harnessReady, useCommand, useQuery } from "../details/kit.tsx"
import { DesktopAppRow, NotificationsRow, QuickSendRow } from "./DesktopApp.tsx"
import { IphoneAppRow } from "./IphoneApp.tsx"
import { GroupLabel, PageHeader, SettingsCard, SettingsRow } from "./layout.tsx"
import { VoiceCallsRow, VoiceInputRow } from "./VoiceInput.tsx"

const NO_DEFAULT = "__none__"

export function useSettingsEditor() {
  const settings = useAtomValue(settingsAtom)
  const update = useCommand("settings.update", "general")
  const [pending, setPending] = useState<SettingsPatch>({})
  // drop the optimistic patch once the roster publishes new settings (the brain's echo)
  const [seen, setSeen] = useState(settings)
  if (seen !== settings) {
    setSeen(settings)
    setPending({})
  }
  const shown: Settings = applySettingsPatch(settings, pending)
  const patch = async (p: SettingsPatch) => {
    setPending((cur) => ({ ...cur, ...p }))
    const r = await update.run({ patch: p })
    if (!r.ok) {
      setPending((cur) => {
        const next: Record<string, unknown> = { ...cur }
        for (const k of Object.keys(p)) delete next[k]
        return next as SettingsPatch
      })
    }
  }
  return { settings: shown, patch, error: update.error }
}

export function GeneralPage(): ReactNode {
  const { settings, patch, error } = useSettingsEditor()
  const harnesses = useQuery(harnessStatusAtom)
  const [name, setName] = useState(settings.ownerName ?? "")
  const [seenName, setSeenName] = useState(settings.ownerName)
  if (seenName !== settings.ownerName) {
    setSeenName(settings.ownerName)
    setName(settings.ownerName ?? "")
  }

  return (
    <div className="flex flex-col">
      <PageHeader title="General" />
      {error && <ErrorLine className="mt-3 px-1">{error}</ErrorLine>}

      <GroupLabel>Appearance</GroupLabel>
      <SettingsCard testId="settings-appearance">
        <SettingsRow
          title="Theme"
          control={
            <Select
              label="Theme"
              value={settings.theme}
              onValueChange={(theme) => void patch({ theme })}
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
                { value: "system", label: "Follow System" },
              ]}
            />
          }
        />
        <SettingsRow
          title="Accent"
          description="Tint your messages and the send button with the Bot's color."
          control={
            <Select
              label="Accent"
              value={settings.accent}
              onValueChange={(accent) => void patch({ accent })}
              options={[
                { value: "bot", label: "Bot color" },
                { value: "black", label: "Black" },
              ]}
            />
          }
        />
        <SettingsRow
          title="Show steps"
          description="Show a collapsed “N steps” row under finished replies, with every tool call the Bot made."
          control={<Switch checked={settings.showSteps} onCheckedChange={(showSteps) => void patch({ showSteps })} label="Show steps" />}
        />
        <SettingsRow
          title="Show compactions"
          description="A line in the chat each time a Bot compacts its context to keep going."
          control={<Switch checked={settings.showCompactions} onCheckedChange={(showCompactions) => void patch({ showCompactions })} label="Show compactions" />}
        />
      </SettingsCard>

      <GroupLabel>Bots</GroupLabel>
      <SettingsCard>
        <SettingsRow
          title="Bot messaging"
          description="Let Bots message each other, post to groups and hand off work. Turn off to stop all Bot-to-Bot messages at once."
          control={<Switch checked={settings.botMessaging} onCheckedChange={(botMessaging) => void patch({ botMessaging })} label="Bot messaging" />}
        />
        <SettingsRow
          title="Compact idle Bots"
          description="When a Bot with a long conversation has been idle for 10 minutes, compact its context so its next reply starts faster and uses less of your plan."
          control={<Switch checked={settings.compactIdleBots} onCheckedChange={(compactIdleBots) => void patch({ compactIdleBots })} label="Compact idle Bots" />}
        />
        <SettingsRow
          title="Bots can search their chats"
          description="Let Bots look back through the chats they are in, so they can find details from earlier conversations. They never see your chats with other Bots."
          control={<Switch checked={settings.botSearch} onCheckedChange={(botSearch) => void patch({ botSearch })} label="Bots can search their chats" />}
        />
        <SettingsRow
          title="Default harness"
          description="Preselected when you create a Bot."
          control={
            <Select
              label="Default harness"
              value={settings.defaultHarness ?? NO_DEFAULT}
              onValueChange={(v) => void patch({ defaultHarness: v === NO_DEFAULT ? null : v })}
              options={[
                { value: NO_DEFAULT, label: "Ask each time" },
                // one entry per harness (a harness can have several accounts); ready when any account is
                ...[...new Set((harnesses.value ?? []).map((h) => h.kind))].map((kind) => {
                  const accounts = (harnesses.value ?? []).filter((h) => h.kind === kind)
                  return { value: kind, label: harnessName(kind, accounts[0]), disabled: !accounts.some(harnessReady) }
                }),
              ]}
            />
          }
        />
        <SettingsRow
          title="Unanswered approvals expire after"
          description="A request nobody answers is denied after this long. The card then offers “Always allow next time”."
          control={
            <Select
              label="Approval expiry"
              value={String(settings.approvalExpiryMinutes)}
              onValueChange={(v) => void patch({ approvalExpiryMinutes: Number(v) })}
              options={[5, 10, 30, 60, 240]
                .concat([settings.approvalExpiryMinutes])
                .filter((v, i, a) => a.indexOf(v) === i)
                .sort((a, b) => a - b)
                .map((m) => ({ value: String(m), label: m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? "" : "s"}` }))}
            />
          }
        />
      </SettingsCard>

      <GroupLabel>Account</GroupLabel>
      <SettingsCard>
        <SettingsRow
          title="Your name"
          description="How your Bots address you."
          wide
          control={
            <TextField
              aria-label="Your name"
              value={name}
              placeholder="Owner"
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name.trim() !== (settings.ownerName ?? "") && void patch({ ownerName: name.trim() ? name.trim() : null })}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              wrapperClassName="w-[220px] max-sm:w-full"
            />
          }
        />
      </SettingsCard>

      <GroupLabel>Voice</GroupLabel>
      <SettingsCard testId="settings-voice">
        <VoiceInputRow />
      </SettingsCard>
      <SettingsCard testId="settings-voice-calls">
        <VoiceCallsRow />
      </SettingsCard>

      <GroupLabel>Apps</GroupLabel>
      <SettingsCard>
        <DesktopAppRow />
        <QuickSendRow />
        <IphoneAppRow />
        <NotificationsRow />
      </SettingsCard>
    </div>
  )
}

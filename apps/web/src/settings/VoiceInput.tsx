import { sttStatusAtom } from "@openbot/client"
import type { SttStatus } from "@openbot/contracts"
import { PillButton } from "@openbot/ui"
import { type ReactNode, useEffect } from "react"
import { ErrorLine, useCommand, useQuery } from "../details/kit.tsx"
import { microphoneAvailable } from "../chat/dictation.ts"
import { SettingsRow } from "./layout.tsx"

const INSTALL_POLL_MS = 1000
const BYTES_PER_MB = 1024 * 1024

const megabytes = (bytes: number | undefined) => Math.round((bytes ?? 0) / BYTES_PER_MB)

const describeStatus = (status: SttStatus): string => {
  const privacy = `Speech is transcribed on this OpenBot by ${status.model}; recordings never leave it.`
  switch (status.state) {
    case "unsupported":
      return "Voice input needs OpenBot running on macOS or Linux (x64 or ARM)."
    case "absent":
      return `Dictate messages with the microphone button in the message box. ${privacy} Turning it on downloads about ${megabytes(status.downloadBytes)} MB once.`
    case "installing": {
      const percent = status.downloadBytes ? Math.floor(((status.downloadedBytes ?? 0) / status.downloadBytes) * 100) : 0
      return `Downloading ${status.model}: ${percent}% (${megabytes(status.downloadedBytes)} of ${megabytes(status.downloadBytes)} MB).`
    }
    case "ready":
      return `On. ${privacy}`
    case "failed":
      return `Setting it up failed: ${status.problem ?? "unknown error"}`
  }
}

export function VoiceInputRow(): ReactNode {
  const status = useQuery(sttStatusAtom)
  const install = useCommand("stt.install")
  const remove = useCommand("stt.remove")
  const current = status.value
  const installing = current?.state === "installing"

  useEffect(() => {
    if (!installing) return
    const poll = setInterval(status.refresh, INSTALL_POLL_MS)
    return () => clearInterval(poll)
  }, [installing, status.refresh])

  const control = (() => {
    if (current === undefined || current.state === "unsupported") return undefined
    if (current.state === "ready") {
      return (
        <PillButton variant="secondary" size="md" loading={remove.pending} onClick={() => void remove.run(undefined as never)} data-testid="voice-input-remove">
          Turn off
        </PillButton>
      )
    }
    return (
      <PillButton variant="primary" size="md" loading={installing || install.pending} onClick={() => void install.run(undefined as never)} data-testid="voice-input-install">
        {current.state === "failed" ? "Try again" : "Turn on"}
      </PillButton>
    )
  })()

  return (
    <SettingsRow title="Voice input" description={current === undefined ? undefined : describeStatus(current)} wide control={control}>
      {current?.state === "ready" && !microphoneAvailable() && (
        <p className="pt-2 text-sm text-fg-secondary">This browser can't use a microphone here: open OpenBot over https or on this computer's own address.</p>
      )}
      {(status.error ?? install.error ?? remove.error) && <ErrorLine className="pt-2">{status.error ?? install.error ?? remove.error}</ErrorLine>}
    </SettingsRow>
  )
}

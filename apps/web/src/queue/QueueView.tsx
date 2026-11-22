// The decision queue in the chat column: the queue's own page, served by the brain to the signed-in owner
// (apps/server/src/queue/live.ts). The brain only has one when OPENBOT_QUEUE or OPENBOT_QUEUE_URL is set.
import { type ReactNode, useEffect, useState } from "react"
import { ArrowLeft } from "lucide-react"
import { IconButton } from "@openbot/ui"

export function QueueView({ onBack }: { readonly onBack?: (() => void) | undefined }): ReactNode {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {onBack && (
        <div className="flex shrink-0 items-center px-2 py-1.5">
          <IconButton icon={ArrowLeft} label="Back" size={36} onClick={onBack} />
        </div>
      )}
      <iframe
        title="Queue"
        src="/queue/"
        className="min-h-0 w-full flex-1 border-0"
        onLoad={(e) => e.currentTarget.contentWindow?.focus()}
      />
    </div>
  )
}

/** Whether the brain has a queue (`/queue/api/enabled` answers 204; without one the app shell answers instead). */
export function useQueueEnabled(): boolean {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    let live = true
    fetch("/queue/api/enabled", { credentials: "same-origin" })
      .then((res) => live && setEnabled(res.status === 204))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  return enabled
}

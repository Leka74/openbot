// The active profile is brain-wide: switching on any device switches every open page. A page that
// sees the active profile change starts over from the new one, without the open chat and
// notifications it kept of the profile left behind; drafts are kept per profile (Composer.tsx).
import { useAtomValue } from "@effect/atom-react"
import { activeProfileIdAtom } from "@openbot/client"
import type { OwnerProfileId } from "@openbot/contracts"
import { useEffect, useRef } from "react"
import { closeShownNotifications } from "./notifications.ts"

const startOver = () => {
  closeShownNotifications()
  if (!location.hash.startsWith("#/quick-send")) history.replaceState(null, "", "#/")
  location.reload()
}

export function useFollowActiveProfile(): void {
  const activeId = useAtomValue(activeProfileIdAtom)
  const loadedWith = useRef<OwnerProfileId | undefined>(undefined)
  useEffect(() => {
    if (activeId === undefined) return
    loadedWith.current ??= activeId
    if (activeId !== loadedWith.current) startOver()
  }, [activeId])
}

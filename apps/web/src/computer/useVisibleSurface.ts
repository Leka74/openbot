import { type RefObject, useEffect, useState } from "react"

/** Passive video has no reason to decode frames offscreen or in an unfocused window.
 * Control callers keep their connection, since disconnecting can release the user's lease.
 */
export function useVisibleSurface(ref: RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!enabled || !ref.current) {
      setVisible(false)
      return
    }
    let intersects = false
    const update = () => setVisible(intersects && document.visibilityState === "visible" && document.hasFocus())
    const observer = new IntersectionObserver(([entry]) => {
      intersects = entry?.isIntersecting === true && entry.intersectionRatio > 0
      update()
    })
    observer.observe(ref.current)
    document.addEventListener("visibilitychange", update)
    window.addEventListener("focus", update)
    window.addEventListener("blur", update)
    return () => {
      observer.disconnect()
      document.removeEventListener("visibilitychange", update)
      window.removeEventListener("focus", update)
      window.removeEventListener("blur", update)
    }
  }, [ref, enabled])
  return enabled && visible
}

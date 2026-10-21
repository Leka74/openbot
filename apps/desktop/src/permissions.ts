/**
 * What pages in the app's windows may use (no Electron here: unit-tested). Only OpenBot's own pages
 * get anything: the microphone alone for voice input (never the camera or the screen), plus what the
 * web app already relies on (notifications, copy, a video's full screen). Everything else is denied.
 */

export interface PermissionAsk {
  readonly permission: string
  /** The asking page's URL or origin. */
  readonly from: string | undefined
  /** For `media`: what it asks for (`audio`, `video`, `unknown`). */
  readonly mediaTypes?: ReadonlyArray<string> | undefined
}

const PAGE_PERMISSIONS: ReadonlySet<string> = new Set(["notifications", "clipboard-sanitized-write", "fullscreen"])

const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

/** Whether a page may have `ask.permission`, given the brain's `https://host[:port]`. */
export const permits = (brainOrigin: string, ask: PermissionAsk): boolean => {
  if (ask.from === undefined || originOf(ask.from) !== originOf(brainOrigin)) return false
  if (ask.permission === "media") return ask.mediaTypes !== undefined && ask.mediaTypes.length > 0 && ask.mediaTypes.every((type) => type === "audio")
  return PAGE_PERMISSIONS.has(ask.permission)
}

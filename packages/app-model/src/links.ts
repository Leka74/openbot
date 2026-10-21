/** ASCII control characters (C0). URL parsers drop tab, CR and LF from inside an address, so
 * `/<tab>\host` would pass as a path here and then resolve to `//host`; an address carrying any of
 * them is never classified at all. */
const hasControl = (url: string): boolean => [...url].some((c) => c.charCodeAt(0) < 0x20)

/** The one href guard shared by the web renderer and the iPhone app: http(s), mailto, same-origin
 * relative paths (`/x`, but not `//host` or `/\host`, which browsers read as `//host`) and
 * `#fragments`; anything else, and anything with a control character inside, renders as plain text. */
export const safeHref = (raw: string): string | undefined => {
  const url = raw.trim()
  if (hasControl(url)) return undefined
  if (/^(https?:|mailto:)/i.test(url)) return url
  if (/^\/(?![/\\])/.test(url) || /^#/.test(url)) return url
  return undefined
}

/** The brain's own attachment route, the only same-origin address an inline image may load. */
const ATTACHMENT_PATH = /^\/api\/attachments\/[A-Za-z0-9_-]+$/

/** The one image-source guard shared by the web renderer and the iPhone app: `https:` anywhere, or
 * an attachment on the brain (`/api/attachments/<id>`), and nothing else. Images load without a
 * click, so no other brain route may get a cookie- or session-bearing GET: an absolute URL on
 * `origin` (the brain's, when known) is held to the attachment rule too, and comes back as its path.
 * `http:`, `data:`, addresses with a control character inside and every other address return
 * undefined and render as text. */
export const imageSrc = (raw: string, origin?: string): string | undefined => {
  const url = raw.trim()
  if (hasControl(url)) return undefined
  if (ATTACHMENT_PATH.test(url)) return url
  if (!/^https:\/\//i.test(url)) return undefined
  if (origin === undefined) return url
  try {
    const parsed = new URL(url)
    if (parsed.origin !== new URL(origin).origin) return url
    return ATTACHMENT_PATH.test(parsed.pathname) && parsed.search === "" && parsed.hash === "" ? parsed.pathname : undefined
  } catch {
    return undefined
  }
}

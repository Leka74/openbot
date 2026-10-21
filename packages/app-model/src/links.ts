/** The one href guard shared by the web renderer and the iPhone app: http(s), mailto, same-origin
 * relative paths (`/x`, but not `//host` or `/\host`, which browsers read as `//host`) and
 * `#fragments`; anything else renders as plain text. */
export const safeHref = (raw: string): string | undefined => {
  const url = raw.trim()
  if (/^(https?:|mailto:)/i.test(url)) return url
  if (/^\/(?![/\\])/.test(url) || /^#/.test(url)) return url
  return undefined
}

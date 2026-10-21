// Pure helpers for attachments in chat bubbles (unit-tested): how a file renders (image / video /
// audio / PDF / file card), its icon family, its size label and its download URL.
import type { Attachment } from "@openbot/contracts"

export type AttachmentKind = "image" | "video" | "audio" | "pdf" | "file"

/** Images the browser renders reliably inline (anything else becomes a file card). */
const INLINE_IMAGES = /^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml|x-icon)$/i
/** Containers browsers can usually play; others (mkv, avi) get a file card. */
const PLAYABLE_VIDEO = /^video\/(mp4|webm|ogg|quicktime)$/i
const PLAYABLE_AUDIO = /^audio\/(mpeg|mp4|aac|wav|x-wav|ogg|webm|flac)$/i

export const attachmentKind = (a: Pick<Attachment, "mime">): AttachmentKind => {
  const mime = a.mime.toLowerCase()
  if (INLINE_IMAGES.test(mime)) return "image"
  if (PLAYABLE_VIDEO.test(mime)) return "video"
  if (PLAYABLE_AUDIO.test(mime)) return "audio"
  if (mime === "application/pdf") return "pdf"
  return "file"
}

export type FileFamily = "image" | "video" | "audio" | "pdf" | "archive" | "code" | "sheet" | "text" | "other"

const ARCHIVE = /(zip|x-tar|gzip|x-bzip2|x-xz|zstd|x-7z|rar|java-archive|android\.package)/i
const SHEET = /(csv|tab-separated|spreadsheet|ms-excel)/i
const CODE = /(json|javascript|x-python|x-sh|xml|yaml|toml|x-ndjson|html|css|wasm)/i

/** Which icon a file card shows. */
export const fileFamily = (a: Pick<Attachment, "mime" | "name">): FileFamily => {
  const mime = a.mime.toLowerCase()
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("video/")) return "video"
  if (mime.startsWith("audio/")) return "audio"
  if (mime === "application/pdf") return "pdf"
  if (ARCHIVE.test(mime)) return "archive"
  if (SHEET.test(mime)) return "sheet"
  if (/(msword|wordprocessing|presentation|powerpoint|opendocument|rtf|epub)/.test(mime)) return "text"
  if (CODE.test(mime)) return "code"
  if (mime.startsWith("text/")) return "text"
  return "other"
}

/** "24.1 MB", "512 KB", "37 bytes" (decimal, as file managers show sizes). */
export const formatBytes = (n: number | undefined): string => {
  if (n === undefined) return ""
  if (n < 1000) return `${n} byte${n === 1 ? "" : "s"}`
  const units = ["KB", "MB", "GB", "TB"]
  let value = n / 1000
  let i = 0
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000
    i++
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[i]}`
}

/** Upper-case extension label for a file card ("MP4", "ZIP"); "" when there is none. */
export const extensionLabel = (name: string): string => {
  const dot = name.lastIndexOf(".")
  return dot <= 0 || dot === name.length - 1 ? "" : name.slice(dot + 1).toUpperCase().slice(0, 6)
}

/** The URL that downloads instead of opening (`Content-Disposition: attachment`). */
export const downloadUrl = (url: string): string => `${url}${url.includes("?") ? "&" : "?"}download=1`

/**
 * Video source with a `#t=` media fragment: browsers (iOS Safari included) then decode and show the
 * frame at 0.1 s as the poster while only the metadata is preloaded.
 */
export const posterFrameUrl = (url: string): string => (url.includes("#") ? url : `${url}#t=0.1`)

// -------------------------------------------------------------------------------------- preview

/** Which renderer the preview dialog uses; undefined = no preview entry point at all. */
export type PreviewKind = "markdown" | "text" | "code"

/** Hard ceiling for in-place preview (2 MiB), not a suggestion. */
export const MAX_PREVIEW_BYTES: number = 2 * 1024 * 1024

/** Whether the file exceeds the preview ceiling; a missing byteSize defers to the streamed guard. */
export const previewTooLarge = (byteSize: number | undefined): boolean =>
  byteSize !== undefined && byteSize > MAX_PREVIEW_BYTES

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "sh", "bash", "zsh",
  "css", "json", "jsonl", "ndjson", "yaml", "yml", "toml", "xml",
])
const CODE_MIMES = new Set([
  "application/json", "application/x-ndjson", "application/yaml", "application/toml",
  "application/xml", "application/x-sh", "text/javascript", "text/css", "text/x-python",
])

/** Lower-case extension of a file name; "" when there is none (dotfiles included). */
const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".")
  return dot <= 0 || dot === name.length - 1 ? "" : name.slice(dot + 1).toLowerCase()
}

/**
 * Picks the preview renderer. Exclusions come first and no non-undefined branch may precede them,
 * so `text/html` can never fall through the `text/*` catch-all (a same-origin executable surface).
 * Extension beats the generic `text/*` because the server maps `.ts`/`.rs`/`.go` to `text/plain`.
 */
export const previewKind = (a: Pick<Attachment, "mime" | "name">): PreviewKind | undefined => {
  const mime = a.mime.trim().toLowerCase()
  const ext = extensionOf(a.name)
  if (/^(image|video|audio)\//.test(mime) || mime === "application/pdf") return undefined
  if (mime === "text/html" || ext === "html" || ext === "htm") return undefined
  if (mime === "text/markdown" || ext === "md" || ext === "markdown") return "markdown"
  if (CODE_EXTENSIONS.has(ext)) return "code"
  if (CODE_MIMES.has(mime)) return "code"
  if (mime.startsWith("text/")) return "text"
  return undefined
}

/** CSS aspect ratio for media with known dimensions (else the kind's default). */
export const aspectRatioOf = (a: Pick<Attachment, "width" | "height">, fallback: string): string =>
  a.width !== undefined && a.height !== undefined && a.width > 0 && a.height > 0 ? `${a.width} / ${a.height}` : fallback

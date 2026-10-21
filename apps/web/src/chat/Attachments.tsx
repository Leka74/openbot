// Attachments inside a chat message (Grok-like), for user and bot messages alike:
//   images → inline thumbnail (≤ 360 px) that opens a full-screen lightbox (download, open, ← →),
//   videos → inline <video controls preload=metadata playsinline> showing its first frame,
//   audio  → a card with <audio controls>,
//   PDFs   → a file card with "Open" (new tab) and Download,
//   others → a file card (icon by type, name, size, Download).
// Media is at most 360 px wide and never wider than the message column (85 % on phones).
import { Download, ExternalLink, File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, X, ChevronLeft, ChevronRight } from "lucide-react"
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import type { Attachment } from "@openbot/contracts"
import { Icon, Portal, cn } from "@openbot/ui"
import {
  aspectRatioOf,
  attachmentKind,
  downloadUrl,
  extensionLabel,
  type FileFamily,
  fileFamily,
  formatBytes,
  posterFrameUrl,
  previewKind,
} from "./attachments.ts"
import { FilePreview } from "./FilePreview.tsx"

const FAMILY_ICONS: Record<FileFamily, typeof File> = {
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  pdf: FileText,
  archive: FileArchive,
  code: FileCode,
  sheet: FileSpreadsheet,
  text: FileText,
  other: File,
}

const metaLine = (a: Attachment): string => [extensionLabel(a.name), formatBytes(a.byteSize)].filter((s) => s !== "").join(" · ")

/** Small round icon link (download / open). */
function IconLink({ href, label, icon, download, newTab, tone = "default" }: {
  readonly href: string
  readonly label: string
  readonly icon: typeof File
  readonly download?: string | undefined
  readonly newTab?: boolean
  readonly tone?: "default" | "inverse"
}): ReactNode {
  return (
    <a
      href={href}
      aria-label={label}
      title={label}
      {...(download === undefined ? {} : { download })}
      {...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
        tone === "inverse" ? "text-white/85 hover:bg-white/15 hover:text-white" : "text-icon-secondary hover:bg-secondary hover:text-icon",
      )}
    >
      <Icon icon={icon} size="md" />
    </a>
  )
}

function FileCard({ attachment, onOpen }: {
  readonly attachment: Attachment
  readonly onOpen?: ((trigger: HTMLButtonElement) => void) | undefined
}): ReactNode {
  const kind = attachmentKind(attachment)
  const family = fileFamily(attachment)
  const previewable = onOpen !== undefined && previewKind(attachment) !== undefined
  const label = (
    <>
      <span className="truncate text-sm font-medium text-fg" title={attachment.name}>
        {attachment.name}
      </span>
      <span className="truncate text-xs text-fg-tertiary">{metaLine(attachment)}</span>
    </>
  )
  return (
    <div
      data-attachment={kind === "pdf" ? "pdf" : "file"}
      className="flex w-[320px] max-w-full items-center gap-3 rounded-2xl bg-elevated py-2.5 ps-3 pe-1.5 hairline border-line-secondary"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-icon-secondary" aria-hidden>
        <Icon icon={FAMILY_ICONS[family]} size="lg" />
      </span>
      {previewable ? (
        // The button wraps only the name/meta column: an interactive element may not contain the
        // Download link (it would swallow its clicks), so Download sits beside it outside.
        <button
          type="button"
          data-attachment-id={attachment.id}
          onClick={(e) => onOpen(e.currentTarget)}
          title="Preview"
          className="flex min-w-0 flex-1 flex-col rounded-lg text-start hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {label}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">{label}</div>
      )}
      {kind === "pdf" && (
        <a
          href={attachment.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-sm text-fg hairline border-line-secondary hover:bg-hover"
        >
          Open
        </a>
      )}
      <IconLink href={downloadUrl(attachment.url)} download={attachment.name} label={`Download ${attachment.name}`} icon={Download} />
    </div>
  )
}

function VideoPlayer({ attachment }: { readonly attachment: Attachment }): ReactNode {
  return (
    <div data-attachment="video" className="flex w-[360px] max-w-full flex-col gap-1">
      <video
        src={posterFrameUrl(attachment.url)}
        controls
        preload="metadata"
        playsInline
        aria-label={attachment.name}
        className="block w-full rounded-2xl bg-black object-contain hairline border-line-tertiary"
        style={{ aspectRatio: aspectRatioOf(attachment, "16 / 9") }}
      />
      <div className="flex min-w-0 items-center gap-1 ps-2">
        <span className="min-w-0 truncate text-xs text-fg-tertiary" title={attachment.name}>
          {attachment.name}
          {attachment.byteSize === undefined ? "" : ` · ${formatBytes(attachment.byteSize)}`}
        </span>
        <IconLink href={downloadUrl(attachment.url)} download={attachment.name} label={`Download ${attachment.name}`} icon={Download} />
      </div>
    </div>
  )
}

function AudioPlayer({ attachment }: { readonly attachment: Attachment }): ReactNode {
  return (
    <div data-attachment="audio" className="flex w-[360px] max-w-full flex-col gap-2 rounded-2xl bg-elevated px-3 pt-2.5 pb-3 hairline border-line-secondary">
      <div className="flex min-w-0 items-center gap-2">
        <Icon icon={FileAudio} size="md" className="shrink-0 text-icon-secondary" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg" title={attachment.name}>
          {attachment.name}
        </span>
        <span className="shrink-0 text-xs text-fg-tertiary">{formatBytes(attachment.byteSize)}</span>
        <IconLink href={downloadUrl(attachment.url)} download={attachment.name} label={`Download ${attachment.name}`} icon={Download} />
      </div>
      <audio src={attachment.url} controls preload="metadata" aria-label={attachment.name} className="w-full" />
    </div>
  )
}

function ImageThumb({ attachment, onOpen }: { readonly attachment: Attachment; readonly onOpen: () => void }): ReactNode {
  const known = attachment.width !== undefined && attachment.height !== undefined
  return (
    <button
      type="button"
      data-attachment="image"
      onClick={onOpen}
      aria-label={`View ${attachment.name}`}
      title={attachment.name}
      className="block max-w-full cursor-zoom-in overflow-hidden rounded-2xl bg-secondary hairline border-line-tertiary focus-visible:outline-2 focus-visible:outline-offset-2"
      style={known ? { width: Math.min(360, attachment.width!), aspectRatio: aspectRatioOf(attachment, "1") } : undefined}
    >
      <img
        src={attachment.url}
        alt={attachment.name}
        loading="lazy"
        decoding="async"
        draggable={false}
        className={cn("block max-h-[360px] max-w-full object-cover", known ? "h-full w-full" : "h-auto w-auto max-w-[min(360px,100%)]")}
      />
    </button>
  )
}

/** Full-screen image viewer: Escape / backdrop closes, ← → step through the message's images. */
export function Lightbox({ images, index, onIndex, onClose }: {
  readonly images: ReadonlyArray<Attachment>
  readonly index: number
  readonly onIndex: (index: number) => void
  readonly onClose: () => void
}): ReactNode {
  const image = images[index]
  const closeRef = useRef<HTMLButtonElement>(null)
  const step = useCallback((delta: number) => {
    if (images.length > 1) onIndex((index + delta + images.length) % images.length)
  }, [images.length, index, onIndex])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const overflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = overflow
      previous?.focus?.()
    }
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
      } else if (e.key === "ArrowLeft") step(-1)
      else if (e.key === "ArrowRight") step(1)
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [onClose, step])
  if (image === undefined) return null
  return (
    <Portal>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={image.name}
        data-testid="lightbox"
        className="fixed inset-0 z-[3000] flex flex-col bg-black/90 animate-fade-in"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        <div className="flex items-center gap-1 px-3 pt-[max(env(safe-area-inset-top),12px)] pb-2 text-white">
          <div className="flex min-w-0 flex-1 flex-col ps-1">
            <span className="truncate text-sm font-medium">{image.name}</span>
            <span className="text-xs text-white/60">
              {[formatBytes(image.byteSize), images.length > 1 ? `${index + 1} of ${images.length}` : ""].filter((s) => s !== "").join(" · ")}
            </span>
          </div>
          <IconLink href={downloadUrl(image.url)} download={image.name} label={`Download ${image.name}`} icon={Download} tone="inverse" />
          <IconLink href={image.url} newTab label="Open in a new tab" icon={ExternalLink} tone="inverse" />
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            title="Close"
            onClick={onClose}
            className="inline-flex size-8 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/15 hover:text-white"
          >
            <Icon icon={X} size="lg" />
          </button>
        </div>
        <div
          className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-[max(env(safe-area-inset-bottom),16px)]"
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose()
          }}
        >
          <img src={image.url} alt={image.name} className="max-h-full max-w-full select-none object-contain" draggable={false} />
          {images.length > 1 && (
            <>
              <button type="button" aria-label="Previous image" onClick={() => step(-1)} className="absolute start-3 top-1/2 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70">
                <Icon icon={ChevronLeft} size="lg" />
              </button>
              <button type="button" aria-label="Next image" onClick={() => step(1)} className="absolute end-3 top-1/2 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70">
                <Icon icon={ChevronRight} size="lg" />
              </button>
            </>
          )}
        </div>
      </div>
    </Portal>
  )
}

export function Attachments({ items, side }: { readonly items: ReadonlyArray<Attachment>; readonly side: "user" | "bot" }): ReactNode {
  const [viewing, setViewing] = useState<number | undefined>(undefined)
  const [previewing, setPreviewing] = useState<Attachment | undefined>(undefined)
  // `Dialog` restores the element focused when it opened, but a mouse click does not always focus
  // a <button>, so the card that opened the preview is captured and focused explicitly on close.
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const closePreview = useCallback(() => setPreviewing(undefined), [])
  // Restoring inside `closePreview` runs synchronously, before `Dialog` unmounts, so its own
  // cleanup would then re-focus whatever was active when the dialog opened (the composer, on
  // browsers that do not focus a <button> on click) and steal the card's focus back. One macrotask
  // later is also required: closing on a scrim click lets the browser's mousedown default action
  // reset focus to <body> *after* this commit, which a synchronous or microtask restore loses to.
  useEffect(() => {
    if (previewing !== undefined || triggerRef.current === null) return
    const trigger = triggerRef.current
    triggerRef.current = null
    const timer = setTimeout(() => trigger.focus(), 0)
    return () => clearTimeout(timer)
  }, [previewing])
  if (items.length === 0) return null
  const images = items.filter((a) => attachmentKind(a) === "image")
  const others = items.filter((a) => attachmentKind(a) !== "image")
  return (
    <div
      data-testid="attachments"
      className={cn("flex w-full max-w-[85%] flex-col gap-1.5 sm:max-w-[min(80%,560px)]", side === "user" ? "items-end self-end" : "items-start self-start")}
    >
      {images.length > 0 && (
        <div className={cn("flex max-w-full flex-wrap gap-1.5", side === "user" ? "justify-end" : "justify-start")}>
          {images.map((a, i) => <ImageThumb key={a.id} attachment={a} onOpen={() => setViewing(i)} />)}
        </div>
      )}
      {others.map((a) => {
        const kind = attachmentKind(a)
        return kind === "video" ? <VideoPlayer key={a.id} attachment={a} /> : kind === "audio" ? <AudioPlayer key={a.id} attachment={a} /> : (
          <FileCard
            key={a.id}
            attachment={a}
            onOpen={(trigger) => {
              triggerRef.current = trigger
              setPreviewing(a)
            }}
          />
        )
      })}
      {viewing !== undefined && <Lightbox images={images} index={viewing} onIndex={setViewing} onClose={() => setViewing(undefined)} />}
      {previewing !== undefined && <FilePreview key={previewing.id} attachment={previewing} onClose={closePreview} />}
    </div>
  )
}

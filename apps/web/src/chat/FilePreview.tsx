// In-place preview of a bot's attachment (architecture §4.10, Chat: attachments). The dialog
// fetches the bytes through the same cookie-authenticated route the Download link uses, so a
// preview never downloads the file and never leaks its content into a failed state: every terminal
// state renders either the text or a message, never a blank panel.
//
// States live on the DOM (`data-preview-state`) so e2e can assert them without matching copy.
import { Download } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import type { Attachment } from "@openbot/contracts"
import { Dialog, DialogBody, DialogHeader, Icon, Spinner } from "@openbot/ui"
import { downloadUrl, formatBytes, MAX_PREVIEW_BYTES, previewKind, previewTooLarge } from "./attachments.ts"
import { useRoster } from "../app/data.ts"
import { Markdown } from "./Markdown.tsx"

/** Where the dialog is in the fetch; `loading` only exists before the outcome is known. */
type PreviewState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly text: string }
  | { readonly kind: "too-large" }
  | { readonly kind: "error"; readonly message: string }

const errorMessage = (status: number): string =>
  status === 404 ? "Couldn't load this file — it may have been deleted" : `Couldn't load this file (HTTP ${status})`

/** Reads the body while counting bytes, so a missing `byteSize` still cannot pull in a huge file. */
const readBounded = async (response: Response): Promise<string | "too-large"> => {
  if (response.body === null) {
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MAX_PREVIEW_BYTES) return "too-large"
    return new TextDecoder("utf-8").decode(buffer)
  }
  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_PREVIEW_BYTES) {
      await reader.cancel()
      return "too-large"
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  // Non-fatal on purpose: extension fallback can classify binary as text, and a fatal decoder would
  // throw on the first bad byte — leaving a `ready` state unreachable and a spinner forever.
  return new TextDecoder("utf-8").decode(bytes)
}

export function FilePreview({ attachment, onClose }: {
  readonly attachment: Attachment
  readonly onClose: () => void
}): ReactNode {
  const kind = previewKind(attachment)
  // The same `.md` must render the same in the bubble and in the dialog, and the bubble passes the
  // roster's bots so `@Bot` becomes an avatar + coloured span. Without it the mention rule is not
  // even active and the text degrades to plain.
  const roster = useRoster()
  const [state, setState] = useState<PreviewState>(() => (previewTooLarge(attachment.byteSize) ? { kind: "too-large" } : { kind: "loading" }))
  const oversized = previewTooLarge(attachment.byteSize)

  useEffect(() => {
    if (oversized) return
    const controller = new AbortController()
    let alive = true
    const run = async (): Promise<void> => {
      try {
        const response = await fetch(attachment.url, { credentials: "same-origin", signal: controller.signal })
        if (!alive) return
        if (!response.ok) {
          setState({ kind: "error", message: errorMessage(response.status) })
          return
        }
        const length = Number(response.headers.get("content-length"))
        if (Number.isFinite(length) && length > MAX_PREVIEW_BYTES) {
          controller.abort()
          setState({ kind: "too-large" })
          return
        }
        const text = await readBounded(response)
        if (!alive) return
        setState(text === "too-large" ? { kind: "too-large" } : { kind: "ready", text })
      } catch {
        // AbortError is the close path, not a failure: stay silent when the dialog is already gone.
        if (!alive || controller.signal.aborted) return
        setState({ kind: "error", message: "Couldn't load this file" })
      }
    }
    void run()
    return () => {
      alive = false
      controller.abort()
    }
  }, [attachment.url, oversized])

  // Second gate: the entry point is not rendered for these, so a stray render returns nothing.
  if (kind === undefined) return null

  const meta = [formatBytes(attachment.byteSize)].filter((s) => s !== "").join(" ")
  const download = (
    <a
      href={downloadUrl(attachment.url)}
      download={attachment.name}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm text-fg hairline border-line-secondary hover:bg-hover"
    >
      <Icon icon={Download} size="sm" />
      Download
    </a>
  )

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} width="min(720px, calc(100vw - 32px))" label={attachment.name} className="ob-phone-full">
      <div data-testid="file-preview" data-preview-state={state.kind} className="flex min-h-0 flex-1 flex-col">
        <DialogHeader title={attachment.name} description={meta || undefined} onClose={onClose} />
        <DialogBody className="ob-md-preview">
          {state.kind === "loading" && (
            <div className="flex justify-center py-8 text-fg-tertiary">
              <Spinner size={16} label="Loading" />
            </div>
          )}
          {state.kind === "ready" && (kind === "markdown" ? <Markdown text={state.text} bots={roster.bots} /> : (
            <pre className="ob-md-preview-code">
              <code>{state.text}</code>
            </pre>
          ))}
          {state.kind === "too-large" && (
            <p className="py-6 text-center text-sm text-fg-secondary">
              This file is too large to preview (limit {Math.round(MAX_PREVIEW_BYTES / 1024 / 1024)} MB). Download it to view it.
            </p>
          )}
          {state.kind === "error" && <p className="py-6 text-center text-sm text-fg-secondary">{state.message}</p>}
        </DialogBody>
        <div className="flex items-center justify-end gap-2 px-4 pb-3">{download}</div>
      </div>
    </Dialog>
  )
}

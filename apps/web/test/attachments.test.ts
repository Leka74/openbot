// Unit tests for how chat attachments render: kind (image / video / audio / PDF / file card), icon
// family, size label, download and poster-frame URLs, aspect ratios.
import { describe, expect, test } from "bun:test"
import {
  aspectRatioOf,
  attachmentKind,
  downloadUrl,
  extensionLabel,
  fileFamily,
  formatBytes,
  MAX_PREVIEW_BYTES,
  posterFrameUrl,
  previewKind,
  previewTooLarge,
} from "../src/chat/attachments.ts"

describe("attachments", () => {
  test("kind: inline images, playable video/audio, PDFs, everything else a file card", () => {
    expect(attachmentKind({ mime: "image/png" })).toBe("image")
    expect(attachmentKind({ mime: "image/JPEG" })).toBe("image")
    expect(attachmentKind({ mime: "image/svg+xml" })).toBe("image")
    expect(attachmentKind({ mime: "image/heic" })).toBe("file")
    expect(attachmentKind({ mime: "image/tiff" })).toBe("file")
    expect(attachmentKind({ mime: "video/mp4" })).toBe("video")
    expect(attachmentKind({ mime: "video/quicktime" })).toBe("video")
    expect(attachmentKind({ mime: "video/webm" })).toBe("video")
    expect(attachmentKind({ mime: "video/x-matroska" })).toBe("file")
    expect(attachmentKind({ mime: "audio/mpeg" })).toBe("audio")
    expect(attachmentKind({ mime: "audio/wav" })).toBe("audio")
    expect(attachmentKind({ mime: "application/pdf" })).toBe("pdf")
    expect(attachmentKind({ mime: "application/zip" })).toBe("file")
    expect(attachmentKind({ mime: "text/plain" })).toBe("file")
  })

  test("icon family by type", () => {
    expect(fileFamily({ mime: "application/zip", name: "a.zip" })).toBe("archive")
    expect(fileFamily({ mime: "application/gzip", name: "a.tgz" })).toBe("archive")
    expect(fileFamily({ mime: "text/csv", name: "a.csv" })).toBe("sheet")
    expect(fileFamily({ mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", name: "a.xlsx" })).toBe("sheet")
    expect(fileFamily({ mime: "application/json", name: "a.json" })).toBe("code")
    expect(fileFamily({ mime: "text/markdown", name: "a.md" })).toBe("text")
    expect(fileFamily({ mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", name: "a.docx" })).toBe("text")
    expect(fileFamily({ mime: "application/pdf", name: "a.pdf" })).toBe("pdf")
    expect(fileFamily({ mime: "video/x-matroska", name: "a.mkv" })).toBe("video")
    expect(fileFamily({ mime: "application/octet-stream", name: "a.bin" })).toBe("other")
  })

  test("labels and URLs", () => {
    expect(formatBytes(undefined)).toBe("")
    expect(formatBytes(1)).toBe("1 byte")
    expect(formatBytes(24_123_456)).toBe("24.1 MB")
    expect(formatBytes(512_000)).toBe("512 KB")
    expect(extensionLabel("cache-demo.mp4")).toBe("MP4")
    expect(extensionLabel("Makefile")).toBe("")
    expect(extensionLabel(".env")).toBe("")
    expect(downloadUrl("/api/attachments/att_1")).toBe("/api/attachments/att_1?download=1")
    expect(downloadUrl("/x?a=1")).toBe("/x?a=1&download=1")
    expect(posterFrameUrl("/api/attachments/att_1")).toBe("/api/attachments/att_1#t=0.1")
    expect(aspectRatioOf({ width: 1920, height: 1080 }, "16 / 9")).toBe("1920 / 1080")
    expect(aspectRatioOf({}, "16 / 9")).toBe("16 / 9")
  })
})

describe("previewKind", () => {
  test("exclusions come first: media, PDF, archives, HTML", () => {
    expect(previewKind({ mime: "image/png", name: "a.png" })).toBeUndefined()
    expect(previewKind({ mime: "video/mp4", name: "a.mp4" })).toBeUndefined()
    expect(previewKind({ mime: "audio/mpeg", name: "a.mp3" })).toBeUndefined()
    expect(previewKind({ mime: "application/pdf", name: "a.pdf" })).toBeUndefined()
    expect(previewKind({ mime: "application/zip", name: "a.zip" })).toBeUndefined()
    expect(previewKind({ mime: "text/html", name: "a.html" })).toBeUndefined()
    expect(previewKind({ mime: "text/plain", name: "a.HTM" })).toBeUndefined()
    expect(previewKind({ mime: "application/octet-stream", name: "a.bin" })).toBeUndefined()
  })

  test("markdown by mime or extension", () => {
    expect(previewKind({ mime: "text/markdown", name: "a.txt" })).toBe("markdown")
    expect(previewKind({ mime: "text/plain", name: "a.md" })).toBe("markdown")
    expect(previewKind({ mime: "application/octet-stream", name: "notes.markdown" })).toBe("markdown")
  })

  test("extension beats the generic text/* because the server maps .ts/.rs/.go to text/plain", () => {
    expect(previewKind({ mime: "text/plain", name: "a.ts" })).toBe("code")
    expect(previewKind({ mime: "text/plain", name: "a.rs" })).toBe("code")
    expect(previewKind({ mime: "text/plain", name: "a.go" })).toBe("code")
    expect(previewKind({ mime: "text/plain", name: "a.json" })).toBe("code")
    expect(previewKind({ mime: "text/plain", name: "a.yaml" })).toBe("code")
  })

  test("code by mime", () => {
    expect(previewKind({ mime: "application/json", name: "a.dat" })).toBe("code")
    expect(previewKind({ mime: "text/css", name: "a.dat" })).toBe("code")
    expect(previewKind({ mime: "text/javascript", name: "a.dat" })).toBe("code")
  })

  test("plain text last, case-normalised", () => {
    expect(previewKind({ mime: "text/csv", name: "a.csv" })).toBe("text")
    expect(previewKind({ mime: "text/plain", name: "Makefile" })).toBe("text")
    expect(previewKind({ mime: "TEXT/MARKDOWN", name: "A.MD" })).toBe("markdown")
    expect(previewKind({ mime: "  Text/Plain  ", name: "a.txt" })).toBe("text")
  })
})

describe("previewTooLarge", () => {
  test("exact 2 MiB boundary; undefined is not too large", () => {
    expect(MAX_PREVIEW_BYTES).toBe(2_097_152)
    expect(previewTooLarge(2_097_151)).toBe(false)
    expect(previewTooLarge(2_097_152)).toBe(false)
    expect(previewTooLarge(2_097_153)).toBe(true)
    expect(previewTooLarge(undefined)).toBe(false)
    expect(previewTooLarge(0)).toBe(false)
  })
})

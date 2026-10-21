// readBounded: the preview's byte-counting read. Its result is tagged, so file content can never be
// mistaken for the over-the-limit stop.
import { expect, test } from "bun:test"
import { MAX_PREVIEW_BYTES } from "../src/chat/attachments.ts"
import { readBounded } from "../src/chat/FilePreview.tsx"

test("readBounded: a file whose whole content is \"too-large\" is text, not the limit", async () => {
  expect(await readBounded(new Response("too-large"))).toEqual({ kind: "text", text: "too-large" })
})

test("readBounded: a streamed body under the limit comes back whole", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("# Notes\n"))
      c.enqueue(new TextEncoder().encode("too-large"))
      c.close()
    },
  })
  expect(await readBounded(new Response(body))).toEqual({ kind: "text", text: "# Notes\ntoo-large" })
})

test("readBounded: one byte over the limit stops reading", async () => {
  expect(await readBounded(new Response(new Uint8Array(MAX_PREVIEW_BYTES + 1)))).toEqual({ kind: "too-large" })
})

test("readBounded: a body without a stream is bounded too", async () => {
  const bodyless = (bytes: Uint8Array) => ({ body: null, arrayBuffer: async () => bytes.buffer }) as unknown as Response
  expect(await readBounded(bodyless(new TextEncoder().encode("too-large")))).toEqual({ kind: "text", text: "too-large" })
  expect(await readBounded(bodyless(new Uint8Array(MAX_PREVIEW_BYTES + 1)))).toEqual({ kind: "too-large" })
})

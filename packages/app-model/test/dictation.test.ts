import { describe, expect, test } from "bun:test"
import { downsample, encodePcm16, insertDictation, joinChunks, toBase64 } from "../src/dictation.ts"

describe("dictation audio", () => {
  test("downsampling averages each window of source samples", () => {
    const source = Float32Array.from([0, 1, 2, 3, 4, 5])
    expect([...downsample(source, 48_000, 16_000)]).toEqual([1, 4])
    expect(downsample(source, 16_000, 16_000)).toBe(source)
  })

  test("encodes little-endian 16-bit PCM with clamped samples", () => {
    const pcm = encodePcm16(Float32Array.from([0, 1, -1, 2, -0.5]))
    const view = new DataView(pcm.buffer)
    expect(pcm.byteLength).toBe(10)
    expect([0, 1, 2, 3, 4].map((i) => view.getInt16(i * 2, true))).toEqual([0, 32767, -32768, 32767, -16384])
  })

  test("joins recorded chunks in order", () => {
    expect([...joinChunks([Float32Array.from([1, 2]), Float32Array.from([]), Float32Array.from([3])])]).toEqual([1, 2, 3])
  })

  test("base64 matches Node's encoder across chunk boundaries", () => {
    const bytes = Uint8Array.from({ length: 0x8000 * 2 + 7 }, (_, i) => (i * 31) % 256)
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"))
  })
})

describe("inserting dictated text", () => {
  test("adds spaces only where the words would touch", () => {
    expect(insertDictation("", 0, "hello")).toEqual({ text: "hello", caret: 5 })
    expect(insertDictation("Please", 6, "check it")).toEqual({ text: "Please check it", caret: 15 })
    expect(insertDictation("Please now", 6, "check it")).toEqual({ text: "Please check it now", caret: 15 })
    expect(insertDictation("Please ", 7, "check")).toEqual({ text: "Please check", caret: 12 })
    expect(insertDictation("ok", 0, "So")).toEqual({ text: "So ok", caret: 3 })
  })
})

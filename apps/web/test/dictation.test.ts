import { describe, expect, test } from "bun:test"
import { formatElapsed } from "../src/chat/useDictation.ts"

describe("dictation timer", () => {
  test("formats the recording time as m:ss", () => {
    expect(formatElapsed(0)).toBe("0:00")
    expect(formatElapsed(75)).toBe("1:15")
  })
})

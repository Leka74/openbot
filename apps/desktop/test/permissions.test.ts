import { describe, expect, test } from "bun:test"
import { permits } from "../src/permissions.ts"

const BRAIN = "https://box.example:8443"

describe("window permissions", () => {
  test("OpenBot's pages get the microphone alone", () => {
    expect(permits(BRAIN, { permission: "media", from: `${BRAIN}/#/chat`, mediaTypes: ["audio"] })).toBe(true)
    expect(permits(BRAIN, { permission: "media", from: BRAIN, mediaTypes: ["audio"] })).toBe(true)
    expect(permits(BRAIN, { permission: "media", from: BRAIN, mediaTypes: ["audio", "video"] })).toBe(false)
    expect(permits(BRAIN, { permission: "media", from: BRAIN, mediaTypes: ["video"] })).toBe(false)
    expect(permits(BRAIN, { permission: "media", from: BRAIN, mediaTypes: ["unknown"] })).toBe(false)
    expect(permits(BRAIN, { permission: "media", from: BRAIN, mediaTypes: [] })).toBe(false)
    expect(permits(BRAIN, { permission: "media", from: BRAIN })).toBe(false)
  })

  test("other sites, and other origins on the same host, get nothing", () => {
    for (const from of ["https://evil.example", "http://box.example:8443", "https://box.example", "file:///connect.html", "not a url", undefined]) {
      expect(permits(BRAIN, { permission: "media", from, mediaTypes: ["audio"] })).toBe(false)
      expect(permits(BRAIN, { permission: "notifications", from })).toBe(false)
    }
  })

  test("OpenBot's pages keep notifications, copy and full screen, and nothing else", () => {
    for (const permission of ["notifications", "clipboard-sanitized-write", "fullscreen"]) expect(permits(BRAIN, { permission, from: BRAIN })).toBe(true)
    for (const permission of ["display-capture", "geolocation", "clipboard-read", "openExternal", "hid", "usb", "serial", "midi", "pointerLock", "unknown"]) {
      expect(permits(BRAIN, { permission, from: BRAIN })).toBe(false)
    }
  })
})

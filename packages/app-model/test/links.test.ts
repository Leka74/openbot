// The href whitelist every renderer shares: the bar an address must clear before it may become a
// link or an image source. `apps/web/test/model.test.ts` has the six original assertions; this file
// is the full illegal-protocol table plus the boundaries those six do not reach.
import { describe, expect, test } from "bun:test"
import { safeHref } from "../src/links.ts"

describe("safeHref: allowed", () => {
  test("http and https, any case", () => {
    expect(safeHref("http://example.com/p")).toBe("http://example.com/p")
    expect(safeHref("https://example.com/p?q=1#f")).toBe("https://example.com/p?q=1#f")
    expect(safeHref("HTTPS://example.com/p")).toBe("HTTPS://example.com/p")
    expect(safeHref("Http://example.com")).toBe("Http://example.com")
  })

  test("mailto", () => {
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c")
    expect(safeHref("MAILTO:a@b.c")).toBe("MAILTO:a@b.c")
  })

  test("same-origin paths: one leading slash, not two", () => {
    expect(safeHref("/api/attachments/att_1")).toBe("/api/attachments/att_1")
    expect(safeHref("/")).toBe("/")
    expect(safeHref("/a/b/c.png")).toBe("/a/b/c.png")
  })

  test("fragments", () => {
    expect(safeHref("#t=0.1")).toBe("#t=0.1")
    expect(safeHref("#")).toBe("#")
  })

  test("surrounding whitespace is trimmed, the result is what gets used", () => {
    expect(safeHref("  https://example.com/p  ")).toBe("https://example.com/p")
    expect(safeHref("\n/api/x\t")).toBe("/api/x")
  })
})

describe("safeHref: rejected protocols, the full table", () => {
  test("script-bearing schemes", () => {
    expect(safeHref("javascript:alert(1)")).toBeUndefined()
    expect(safeHref("JavaScript:alert(1)")).toBeUndefined()
    expect(safeHref("JAVASCRIPT:alert(1)")).toBeUndefined()
    expect(safeHref("  javascript:alert(1)")).toBeUndefined()
    expect(safeHref("javascript:void(0)")).toBeUndefined()
  })

  test("data and other inline-document schemes", () => {
    expect(safeHref("data:text/html,<script>1</script>")).toBeUndefined()
    expect(safeHref("data:image/png;base64,iVBORw0KGgo=")).toBeUndefined()
    expect(safeHref("DATA:text/html,x")).toBeUndefined()
    expect(safeHref("vbscript:msgbox(1)")).toBeUndefined()
    expect(safeHref("file:///etc/passwd")).toBeUndefined()
    expect(safeHref("blob:https://example.com/uuid")).toBeUndefined()
  })

  test("app- and platform-level schemes", () => {
    expect(safeHref("tel:+15551234")).toBeUndefined()
    expect(safeHref("sms:+15551234")).toBeUndefined()
    expect(safeHref("openbot://pair?code=1")).toBeUndefined()
    expect(safeHref("intent://scan/#Intent;scheme=zxing;end")).toBeUndefined()
    expect(safeHref("about:blank")).toBeUndefined()
  })

  test("protocol-relative and other lookalikes never pass", () => {
    expect(safeHref("//evil.example/x")).toBeUndefined()
    expect(safeHref("//evil.example")).toBeUndefined()
    expect(safeHref("///evil.example/x")).toBeUndefined()
  })

  test("a backslash after the first slash is a protocol-relative address too", () => {
    // Browsers normalise `\` to `/` for special schemes, so `<a href="/\evil.example">` resolves to
    // `//evil.example`.
    expect(safeHref("/\\evil.example")).toBeUndefined()
    expect(safeHref("/\\/evil.example")).toBeUndefined()
    expect(safeHref("/\\\\evil.example")).toBeUndefined()
    expect(safeHref("  /\\evil.example")).toBeUndefined()
    // A backslash further along is just part of the path.
    expect(safeHref("/a\\b")).toBe("/a\\b")
  })

  test("bare text and empty input", () => {
    expect(safeHref("")).toBeUndefined()
    expect(safeHref("   ")).toBeUndefined()
    expect(safeHref("example.com/p")).toBeUndefined()
    expect(safeHref("not a url")).toBeUndefined()
    expect(safeHref(".")).toBeUndefined()
    expect(safeHref("..")).toBeUndefined()
  })

  test("a scheme must be at the start — no smuggling it past the anchor", () => {
    expect(safeHref("xjavascript:alert(1)")).toBeUndefined()
    expect(safeHref("https://ok/https://evil")).toBe("https://ok/https://evil")
  })
})

describe("safeHref: the exact boundary between the two", () => {
  test("the scheme test is anchored and case-insensitive, and `/` must be first", () => {
    expect(safeHref("https:")).toBe("https:")
    expect(safeHref("/x")).toBe("/x")
    expect(safeHref("x/y")).toBeUndefined()
    expect(safeHref(" /y")).toBe("/y")
  })

  test("`#` and `mailto:` pass even though no image can load them — loadable() is a separate gate", () => {
    expect(safeHref("#frag")).toBe("#frag")
    expect(safeHref("mailto:x@y")).toBe("mailto:x@y")
  })
})

// Parser-level assertions for the three web rendering additions (task lists, rules, images).
// Structure only — no DOM — so a regression points at the parser rather than at layout.
import { expect, test } from "bun:test"
import { isValidElement, type ReactNode } from "react"
import { parseBlocks, renderInline } from "../src/chat/Markdown.tsx"

const kinds = (source: string) => parseBlocks(source).map((b) => b.kind)
const list = (source: string) => parseBlocks(source)[0] as Extract<ReturnType<typeof parseBlocks>[number], { kind: "list" }>

/** What each inline node is: the tag/component name for elements, or "text" / "fragment". */
const nodeKinds = (out: ReactNode[]): string[] =>
  out.map((node) => {
    if (typeof node === "string") return "text"
    if (isValidElement(node)) {
      if (typeof node.type === "symbol") return "fragment"
      if (typeof node.type === "string") return node.type
      return (node.type as { name?: string }).name ?? "component"
    }
    return typeof node
  })

/** All text under a node, so a fragment-wrapped fallback can be compared by what the user reads. */
const textOf = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children)
  return ""
}

// ---------------------------------------------------------------------------------------- task lists

test("task list: [ ] and [x] become checked, prefix stripped, plain items stay undefined", () => {
  const b = list("- [ ] todo\n- [x] done\n- plain")
  expect(b.items).toEqual(["todo", "done", "plain"])
  expect(b.checked).toEqual([false, true, undefined])
})

test("task list: capital X counts as done", () => {
  expect(list("- [X] shipped").checked).toEqual([true])
})

test("task list: ordered lists carry checked too", () => {
  const b = list("1. [ ] one\n2. [x] two")
  expect(b.ordered).toBe(true)
  expect(b.items).toEqual(["one", "two"])
  expect(b.checked).toEqual([false, true])
})

test("task list: a plain list produces no `checked` property at all", () => {
  // `toEqual` on the whole block guards the backwards-compatible shape (markdown-table.test.ts and
  // model.test.ts compare whole blocks this way).
  expect(parseBlocks("- a\n- b")).toEqual([{ kind: "list", ordered: false, start: 1, items: ["a", "b"] }])
})

test("task list: `[ ]` with no following body is not a task item", () => {
  // TASK requires whitespace plus a body, so the raw text stays as the item and no `checked` array
  // is produced at all (there is no task item in the list).
  expect(list("- [ ]").items).toEqual(["[ ]"])
  expect(list("- [ ]").checked).toBeUndefined()
})

test("task list: an empty box stays a plain item on web, as `marked` renders it on mobile", () => {
  // `marked` strips trailing whitespace while tokenising, so `- [ ]` and `- [ ] ` reach mobile as
  // the same text and both render as a plain bullet. The web parser must agree, or one source line
  // shows ☐ on web and a literal `[ ]` on mobile.
  for (const src of ["- [ ]", "- [ ] ", "- [ ]   ", "- [ ]\t", "- [x]", "- [x] ", "1. [ ]", "1. [ ] ", "+ [ ]", "* [ ]", "- [X]  "]) {
    const b = list(src)
    // No task item anywhere in the list, so no `checked` array at all (the same shape the existing
    // "plain list produces no `checked`" case pins).
    expect({ src, checked: b.checked, items: b.items }).toEqual({
      src,
      checked: undefined,
      items: [src.replace(/^[-+*]\s/, "").replace(/^\d+\.\s/, "")],
    })
  }
  // A space is required between the box and the body, and the body must start with a non-space.
  expect(list("- [ ] a").checked).toEqual([false])
  expect(list("- [ ]  a").checked).toEqual([false])
  expect(list("- [ ]  a").items).toEqual(["a"])
  // A tab is not the space `marked` requires there.
  expect(list("- [ ]\ta").checked).toBeUndefined()
  expect(list("- [ ]\ta").items).toEqual(["[ ]\ta"])
  // The three inputs the architecture review asked to pin explicitly: trailing space and tab stay
  // non-tasks, a real body is a task. ` +` must never drift back to `\s+`.
  expect(list("- [ ] ").checked).toBeUndefined()
  expect(list("- [ ]\t").checked).toBeUndefined()
  expect(list("- [ ] todo").checked).toEqual([false])
  expect(list("- [ ] todo").items).toEqual(["todo"])
})

// ---------------------------------------------------------------------------------------------- rules

test("rule: `- - -` is a rule, not a list", () => {
  const blocks = parseBlocks("- - -")
  expect(blocks).toEqual([{ kind: "rule" }])
})

test("rule: `***`, `___` and indented variants are rules", () => {
  for (const src of ["***", "___", "  ---", "  * * *  "]) expect(kinds(src)).toEqual(["rule"])
})

test("rule: a table separator is never a rule", () => {
  const blocks = parseBlocks("| a | b | c |\n|---|:---:|---:|\n| 1 | 2 | 3 |")
  expect(blocks.map((b) => b.kind)).toEqual(["table"])
})

test("rule: `Title\\n---` stays a paragraph (no setext support, no new visible line)", () => {
  // Without the empty-paragraph guard this would render as "a paragraph + a horizontal line",
  // a user-visible change nobody asked for.
  const blocks = parseBlocks("Title\n---")
  expect(blocks.map((b) => b.kind)).toEqual(["paragraph"])
  expect((blocks[0] as { text: string }).text).toBe("Title\n---")
})

test("rule: a rule after a blank line is a rule even following a paragraph", () => {
  expect(kinds("Title\n\n---")).toEqual(["paragraph", "rule"])
})

test("rule: two dashes are not a rule", () => {
  expect(kinds("--")).toEqual(["paragraph"])
})

test("rule: a rule between lists splits them", () => {
  expect(kinds("- a\n\n---\n\n- b")).toEqual(["list", "rule", "list"])
})

// ---------------------------------------------------------------------------------------------- images

const imageOf = (source: string) => renderInline(source)

test("image: a well-formed image yields an element, not text", () => {
  expect(nodeKinds(imageOf("![a](https://x/y.png)"))).toEqual(["MdImage"])
})

test("image: `javascript:` never produces an image element", () => {
  const out = imageOf("![a](javascript:alert(1))")
  // imageSrc rejects it, so the alt text renders as plain text.
  expect(nodeKinds(out)).not.toContain("MdImage")
  expect(textOf(out[0]!)).toBe("a")
})

test("image: `data:` and protocol-relative hrefs never produce an image element", () => {
  expect(nodeKinds(imageOf("![a](data:image/png;base64,AAAA)"))).not.toContain("MdImage")
  expect(nodeKinds(imageOf("![a](//evil.example/x.png)"))).not.toContain("MdImage")
})

test("image: `#frag` and `mailto:` render as text before any <img> exists", () => {
  expect(nodeKinds(imageOf("![a](#frag)"))).not.toContain("MdImage")
  expect(nodeKinds(imageOf("![a](mailto:x@y)"))).not.toContain("MdImage")
  expect(textOf(imageOf("![a](#frag)")[0]!)).toBe("a")
})

test("image: an empty alt falls back to the href, never an empty string", () => {
  expect(textOf(imageOf("![](#frag)")[0]!)).toBe("#frag")
})

test("image: an attachment and absolute https both render", () => {
  expect(nodeKinds(imageOf("![a](/api/attachments/att_1)"))).toEqual(["MdImage"])
  expect(nodeKinds(imageOf("![a](https://x/y.png)"))).toEqual(["MdImage"])
  expect(nodeKinds(imageOf("![a](HTTPS://x/y.png)"))).toEqual(["MdImage"])
})

test("image: http and brain paths other than attachments render as alt text", () => {
  for (const src of ["http://x/y.png", "HTTP://x/y.png", "/api/conversations", "/api/attachments/att_1/../../logout", "/logout", "/\\evil.example/x.png"]) {
    const out = imageOf(`![a](${src})`)
    expect(nodeKinds(out)).not.toContain("MdImage")
    expect(textOf(out[0]!)).toBe("a")
  }
  expect(textOf(imageOf("![](http://x/y.png)")[0]!)).toBe("http://x/y.png")
})

test("image: the image rule wins over the link rule at the same start position", () => {
  // `![a](b)` matches the link regex at index 1 and the image regex at index 0; renderInline picks
  // the earliest match, so declaration order cannot change the outcome.
  expect(nodeKinds(imageOf("![a](https://x/y.png)"))).toEqual(["MdImage"])
})

test("image: markdown around the image still renders", () => {
  const out = imageOf("see ![a](https://x/y.png) now")
  expect(nodeKinds(out)).toEqual(["text", "MdImage", "text"])
  expect(out[0]).toBe("see ")
  expect(out[2]).toBe(" now")
})

test("image: an image inside ** ** still renders as an image (inline marking is not a block)", () => {
  expect(nodeKinds(imageOf("**![a](https://x/y.png)**"))).toEqual(["strong"])
})

// ------------------------------------------------------------------------------------------ safeHref

// The whitelist itself is tested in `packages/app-model/test/links.test.ts` (it moved there with
// the function); this file only pins the parser's use of it.

test("link: `/\\host` is not a same-origin path, so it renders as text", () => {
  const out = renderInline("[x](/\\evil.example)")
  expect(nodeKinds(out)).not.toContain("Link")
  expect(textOf(out)).toBe("x")
})

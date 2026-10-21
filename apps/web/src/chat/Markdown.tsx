// A small, safe markdown renderer for bot text (no dependencies, no innerHTML). Supports paragraphs
// with soft line breaks, **bold**, *italic*, ~~strike~~, `code`, fenced code blocks, [links](url),
// bare URLs, bullet and numbered lists, blockquotes, #-headings, GFM tables and @Bot mentions
// (avatar + name in the Bot's colour, Grok style). Links only allow http(s), mailto and
// same-origin relative URLs; anything else renders as plain text.
import { Globe } from "lucide-react"
import { Fragment, type ReactNode, useState } from "react"
import { Avatar } from "@openbot/ui"
import { safeHref } from "@openbot/app-model"

export { safeHref }

// ------------------------------------------------------------------------------------------- blocks

export type Block =
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "code"; readonly lang: string; readonly text: string }
  | {
    readonly kind: "list"
    readonly ordered: boolean
    readonly start: number
    readonly items: ReadonlyArray<string>
    /** One entry per item when this is a task list; undefined once an item has no `[ ]`/`[x]` prefix. */
    readonly checked?: ReadonlyArray<boolean | undefined>
  }
  | { readonly kind: "quote"; readonly text: string }
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "rule" }
  | {
    readonly kind: "table"
    readonly header: ReadonlyArray<string>
    readonly align: ReadonlyArray<"left" | "center" | "right" | undefined>
    readonly rows: ReadonlyArray<ReadonlyArray<string>>
  }

const BULLET = /^\s{0,3}[-*+]\s+(.*)$/
const ORDERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/
const FENCE = /^\s{0,3}(```|~~~)\s*([\w+-]*)\s*$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
// `marked`'s task-item rule: the box, then at least one space, then real content. A `[ ]` with
// nothing after it (or only trailing spaces) is a plain list item on both ends — mobile's `marked`
// strips trailing spaces before tokenising, so it cannot tell `- [ ] ` from `- [ ]`.
const TASK = /^\[([ xX])\] +(\S.*)$/

/** Splits a GFM table row into trimmed cells (`\|` is a literal pipe). */
export const splitRow = (line: string): ReadonlyArray<string> => {
  let row = line.trim()
  if (row.startsWith("|")) row = row.slice(1)
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1)
  const cells: string[] = []
  let cur = ""
  for (let i = 0; i < row.length; i++) {
    const c = row[i]!
    if (c === "\\" && row[i + 1] === "|") {
      cur += "|"
      i++
    } else if (c === "|") {
      cells.push(cur.trim())
      cur = ""
    } else cur += c
  }
  cells.push(cur.trim())
  return cells
}

export const parseBlocks = (source: string): ReadonlyArray<Block> => {
  const lines = source.replace(/\r\n?/g, "\n").split("\n")
  const blocks: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length > 0) blocks.push({ kind: "paragraph", text: para.join("\n") })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      i++
      while (i < lines.length && !new RegExp(`^\\s{0,3}${fence[1] === "```" ? "```" : "~~~"}\\s*$`).test(lines[i]!)) body.push(lines[i++]!)
      blocks.push({ kind: "code", lang: fence[2] ?? "", text: body.join("\n") })
      continue
    }
    if (line.trim() === "") {
      flush()
      continue
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      const header = splitRow(line)
      const align = splitRow(lines[i + 1]!).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? ("center" as const) : c.endsWith(":") ? ("right" as const) : c.startsWith(":") ? ("left" as const) : undefined,
      )
      if (header.length > 1 || line.trim().startsWith("|")) {
        flush()
        const rows: Array<ReadonlyArray<string>> = []
        i += 2
        while (i < lines.length && lines[i]!.trim() !== "" && lines[i]!.includes("|")) rows.push(splitRow(lines[i++]!))
        i--
        blocks.push({ kind: "table", header, align, rows })
        continue
      }
    }
    // After tables (so `|---|` stays a separator) and before headings/lists (so `- - -` is not a
    // bullet). The empty-paragraph guard keeps `Title\n---` as text — this renderer has no setext.
    if (para.length === 0 && RULE.test(line)) {
      flush()
      blocks.push({ kind: "rule" })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! })
      continue
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      flush()
      const ordered = !BULLET.test(line)
      const start = ordered ? Number(ORDERED.exec(line)![1]) : 1
      const items: string[] = []
      const checked: Array<boolean | undefined> = []
      while (i < lines.length) {
        const l = lines[i]!
        const m = ordered ? ORDERED.exec(l) : BULLET.exec(l)
        if (m) {
          const raw = (ordered ? m[2] : m[1]) ?? ""
          const task = TASK.exec(raw)
          if (task) {
            checked.push(task[1] !== " ")
            items.push(task[2] ?? "")
          } else {
            checked.push(undefined)
            items.push(raw)
          }
        } else if (l.trim() !== "" && /^\s{2,}\S/.test(l) && items.length > 0) items[items.length - 1] += `\n${l.trim()}`
        else break
        i++
      }
      i--
      blocks.push(
        checked.some((c) => c !== undefined)
          ? { kind: "list", ordered, start, items, checked }
          : { kind: "list", ordered, start, items },
      )
      continue
    }
    const quote = QUOTE.exec(line)
    if (quote) {
      flush()
      const body: string[] = [quote[1] ?? ""]
      while (i + 1 < lines.length && QUOTE.test(lines[i + 1]!)) body.push(QUOTE.exec(lines[++i]!)![1] ?? "")
      blocks.push({ kind: "quote", text: body.join("\n") })
      continue
    }
    para.push(line)
  }
  flush()
  return blocks
}

// ------------------------------------------------------------------------------------------ inline

/** Whether an `<img>` can load this href at all (`safeHref` also lets `#frag` and `mailto:` through). */
const loadable = (href: string): boolean => /^https?:/i.test(href) || (href.startsWith("/") && !href.startsWith("//"))

/** Inline image with its own failure state: a broken image must stay visible as text, never blank.
 * The state remembers which source failed, so a new `href` (an edited or re-rendered message) gets
 * its own try instead of inheriting the old failure. */
function MdImage(props: { readonly href: string; readonly alt: string }): ReactNode {
  const [failedHref, setFailedHref] = useState<string | undefined>(undefined)
  if (failedHref === props.href) {
    return <span className="ob-md-img-fallback">{props.alt || props.href}</span>
  }
  return (
    <img
      src={props.href}
      alt={props.alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className="ob-md-img"
      onError={() => setFailedHref(props.href)}
    />
  )
}

type InlineRule = { readonly re: RegExp; readonly render: (m: RegExpExecArray, key: string) => ReactNode }

/** A Bot that `@Name` mentions resolve to. */
export interface MentionBot {
  readonly name: string
  readonly avatar: { readonly shape: string; readonly color: string }
}
interface MentionScope {
  readonly re: RegExp | undefined
  readonly byName: ReadonlyMap<string, MentionBot>
  /** "bot": name in the Bot's colour (grey bubbles); "inherit": bold in the bubble's text colour. */
  readonly tone: "bot" | "inherit"
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
export const makeMentionScope = (bots: ReadonlyArray<MentionBot>, tone: "bot" | "inherit" = "bot"): MentionScope => {
  const byName = new Map(bots.map((b) => [b.name.toLowerCase(), b] as const))
  const names = [...bots.map((b) => b.name)].sort((a, b) => b.length - a.length).map(escapeRe)
  return { byName, tone, re: names.length === 0 ? undefined : new RegExp(`(?<![\\w@])@(${names.join("|")}|everyone)(?![\\w-])`, "i") }
}

export function Mention({ bot, tone }: { readonly bot: MentionBot | undefined; readonly tone: "bot" | "inherit" }): ReactNode {
  if (bot === undefined) return <strong className="font-semibold">@everyone</strong>
  return (
    <span
      className="ob-mention inline-flex items-baseline gap-[3px] font-medium whitespace-nowrap"
      style={tone === "bot" ? { color: `var(--ob-${bot.avatar.color}-fg, inherit)` } : { fontWeight: 600 }}
    >
      <Avatar shape={bot.avatar.shape as never} color={bot.avatar.color as never} size={16} className="relative top-[3px] shrink-0" />
      {bot.name}
    </span>
  )
}

const mentionRule = (scope: MentionScope): InlineRule | undefined =>
  scope.re === undefined
    ? undefined
    : {
      re: scope.re,
      render: (m, key) => <Mention key={key} bot={m[1]!.toLowerCase() === "everyone" ? undefined : scope.byName.get(m[1]!.toLowerCase())} tone={scope.tone} />,
    }

const rules: ReadonlyArray<InlineRule> = [
  { re: /`([^`\n]+)`/, render: (m, key) => <code key={key}>{m[1]}</code> },
  {
    re: /!\[([^\]\n]*)\]\(([^)\s]+)\)/,
    render: (m, key) => {
      const href = safeHref(m[2]!)
      const alt = m[1] ?? ""
      // `#frag` / `mailto:` pass safeHref but no <img> can load them: fall back to text *before*
      // creating the element, or the user sees a broken image flash before it turns into text.
      if (href === undefined || !loadable(href)) return <Fragment key={key}>{alt || href || m[2]!}</Fragment>
      return <MdImage key={key} href={href} alt={alt} />
    },
  },
  {
    re: /\[([^\]\n]+)\]\(([^)\s]+)\)/,
    render: (m, key) => {
      const href = safeHref(m[2]!)
      if (!href) return <Fragment key={key}>{renderInline(m[1]!, `${key}t`)}</Fragment>
      return <Link key={key} href={href}>{renderInline(m[1]!, `${key}t`)}</Link>
    },
  },
  {
    re: /\bhttps?:\/\/[^\s<>()]+[^\s<>().,:;!?"'\]]/,
    render: (m, key) => (
      <Link key={key} href={m[0]} bare>
        {m[0]}
      </Link>
    ),
  },
  { re: /\*\*(?=\S)([\s\S]+?)\*\*/, render: (m, key) => <strong key={key}>{renderInline(m[1]!, `${key}b`)}</strong> },
  { re: /__(?=\S)([\s\S]+?)__(?!\w)/, render: (m, key) => <strong key={key}>{renderInline(m[1]!, `${key}b`)}</strong> },
  { re: /~~(?=\S)([\s\S]+?)~~/, render: (m, key) => <del key={key}>{renderInline(m[1]!, `${key}s`)}</del> },
  { re: /\*(?=[^\s*])([^*\n]+?)\*/, render: (m, key) => <em key={key}>{renderInline(m[1]!, `${key}i`)}</em> },
  { re: /(?<![\w])_(?=\S)([^_\n]+?)_(?![\w])/, render: (m, key) => <em key={key}>{renderInline(m[1]!, `${key}i`)}</em> },
]

function Link({ href, children, bare = false }: { readonly href: string; readonly children: ReactNode; readonly bare?: boolean }): ReactNode {
  const external = /^https?:/i.test(href)
  return (
    <a href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})} className="break-words">
      {external && !bare && <Globe size={15} strokeWidth={1.75} className="me-1 inline-block -translate-y-px align-middle opacity-70" aria-hidden />}
      {children}
    </a>
  )
}

/** The mention scope of the Markdown render in progress (rendering is synchronous; nested rules inherit it). */
let currentScope: MentionScope | undefined

export const renderInline = (text: string, keyPrefix = "i", scope: MentionScope | undefined = currentScope): ReactNode[] => {
  const mention = scope === undefined ? undefined : mentionRule(scope)
  const active = mention === undefined ? rules : [rules[0]!, mention, ...rules.slice(1)]
  const out: ReactNode[] = []
  let rest = text
  let n = 0
  while (rest.length > 0) {
    let best: { m: RegExpExecArray; rule: InlineRule } | undefined
    for (const rule of active) {
      const m = rule.re.exec(rest)
      if (m && (best === undefined || m.index < best.m.index)) best = { m, rule }
    }
    if (!best) {
      out.push(rest)
      break
    }
    if (best.m.index > 0) out.push(rest.slice(0, best.m.index))
    out.push(best.rule.render(best.m, `${keyPrefix}${n++}`))
    rest = rest.slice(best.m.index + best.m[0].length)
  }
  return out
}

// ------------------------------------------------------------------------------------------ render

/** Renders plain text with only `@Bot` mentions styled (user bubbles). */
export function MentionText({ text, bots, tone = "inherit" }: { readonly text: string; readonly bots: ReadonlyArray<MentionBot>; readonly tone?: "bot" | "inherit" }): ReactNode {
  const scope = makeMentionScope(bots, tone)
  const rule = mentionRule(scope)
  if (rule === undefined) return text
  const out: ReactNode[] = []
  let rest = text
  let n = 0
  for (let m = rule.re.exec(rest); m !== null; m = rule.re.exec(rest)) {
    if (m.index > 0) out.push(rest.slice(0, m.index))
    out.push(rule.render(m, `m${n++}`))
    rest = rest.slice(m.index + m[0].length)
  }
  if (rest) out.push(rest)
  return <>{out}</>
}

export function Markdown({ text, className, bots }: { readonly text: string; readonly className?: string; readonly bots?: ReadonlyArray<MentionBot> }): ReactNode {
  const blocks = parseBlocks(text)
  const previous = currentScope
  currentScope = bots === undefined ? undefined : makeMentionScope(bots, "bot")
  try {
    return renderBlocks(blocks, className)
  } finally {
    currentScope = previous
  }
}

const alignClass = (a: "left" | "center" | "right" | undefined) => (a === "center" ? "text-center" : a === "right" ? "text-right" : "text-left")

function renderBlocks(blocks: ReadonlyArray<Block>, className: string | undefined): ReactNode {
  return (
    <div className={className ? `ob-md ${className}` : "ob-md"}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "table":
            return (
              <div key={i} className="ob-md-table -mx-1 overflow-x-auto px-1">
                <table>
                  <thead>
                    <tr>
                      {b.header.map((h, c) => (
                        <th key={c} className={alignClass(b.align[c])}>{renderInline(h, `t${i}-h${c}-`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {b.header.map((_, c) => (
                          <td key={c} className={alignClass(b.align[c])}>{renderInline(row[c] ?? "", `t${i}-${r}-${c}-`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case "paragraph":
            return <p key={i}>{renderInline(b.text, `p${i}-`)}</p>
          case "rule":
            return <hr key={i} className="ob-md-hr" />
          case "code":
            return (
              <pre key={i} data-lang={b.lang || undefined}>
                <code>{b.text}</code>
              </pre>
            )
          case "heading":
            return <p key={i} className={b.level <= 2 ? "text-xl font-semibold" : "font-semibold"}>{renderInline(b.text, `h${i}-`)}</p>
          case "quote":
            return <blockquote key={i}>{renderInline(b.text, `q${i}-`)}</blockquote>
          case "list":
            return b.ordered ? (
              <ol key={i} start={b.start}>
                {b.items.map((it, j) => (
                  <li key={j} {...(b.checked === undefined ? {} : { "data-task": b.checked[j] === true ? "done" : "todo" })}>
                    {b.checked?.[j] === undefined ? null : <span aria-hidden>{b.checked[j] === true ? "☑" : "☐"}</span>}
                    {b.checked?.[j] === undefined ? null : " "}
                    {renderInline(it, `l${i}-${j}-`)}
                  </li>
                ))}
              </ol>
            ) : (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j} {...(b.checked === undefined ? {} : { "data-task": b.checked[j] === true ? "done" : "todo" })}>
                    {b.checked?.[j] === undefined ? null : <span aria-hidden>{b.checked[j] === true ? "☑" : "☐"}</span>}
                    {b.checked?.[j] === undefined ? null : " "}
                    {renderInline(it, `l${i}-${j}-`)}
                  </li>
                ))}
              </ul>
            )
        }
      })}
    </div>
  )
}

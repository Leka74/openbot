// Bot messages as Markdown, drawn natively: `marked`'s lexer (as on the web) → nested Text for
// paragraphs, emphasis, code, links, lists, quotes, headings, tables and code blocks. A link to a
// website starts with the site's icon (`/api/favicon`, fetched by the brain), or a globe without one.
import * as Linking from "expo-linking"
import { Image } from "expo-image"
import { type Token, type Tokens, marked } from "marked"
import { type ReactNode, useMemo, useState } from "react"
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { imageSrc, remoteImageHost, safeHref } from "@openbot/app-model"
import type { Theme } from "../theme.ts"
import { Icon } from "../ui/Icon.tsx"

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" })

interface Ctx {
  readonly theme: Theme
  readonly color: string
  readonly size: number
  /** The brain to ask for links' site icons (absent: links have none). */
  readonly site?: MarkdownImage | undefined
  readonly uiCard?: boolean | undefined
}

/** The body-text style every text line carries; block(), inlineRows() and MdImage's fallback share it. */
const bodyText = (color: string, size: number) => ({ color, fontSize: size, lineHeight: Math.round(size * 1.36) })

/** Images to render inline from a message: where relative attachment URLs point, and the session
 * headers that only a same-origin request may carry. */
export interface MarkdownImage {
  readonly origin: string
  readonly headers: Readonly<Record<string, string>>
}

/** `imageSrc` lets through https and the brain's attachment path; only the path is the brain's, so
 * only it gets the origin and the session headers. */
const uri = (href: string, origin: string): string => (href.startsWith("/") ? origin + href : href)

/** An image is a block of its own: it holds its own failure state, never a shared one. The caller
 * keys it by the address it loads (origin included), so every new source mounts fresh and gets its
 * own try instead of inheriting an old failure. A remote image waits for a tap; the brain's own
 * attachments load at once. */
function MdImage(props: {
  readonly href: string
  readonly alt: string
  readonly origin: string
  readonly headers: Readonly<Record<string, string>>
  readonly theme: Theme
  readonly size: number
}): ReactNode {
  const host = remoteImageHost(props.href)
  const [load, setLoad] = useState(host === undefined)
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <Text style={bodyText(props.theme.fgSecondary, props.size)} selectable>
        {props.alt || props.href}
      </Text>
    )
  }
  if (!load) {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => setLoad(true)}
        style={[styles.imageLoad, { borderColor: props.theme.line }]}
      >
        <Text style={bodyText(props.theme.fgSecondary, props.size - 2)}>Load image from {host}</Text>
      </Pressable>
    )
  }
  return (
    <Image
      source={{
        uri: uri(props.href, props.origin),
        ...(props.href.startsWith("/") ? { headers: props.headers } : {}),
      }}
      alt={props.alt}
      onError={() => setFailed(true)}
      style={{ width: "100%", maxWidth: 480, aspectRatio: 1, borderRadius: 12 }}
      contentFit="contain"
    />
  )
}

/** A website link's site icon in a small tile on the text line; a globe when the site has none. The
 * brain redraws a one-colour icon to show on this screen (`&theme=`), since its pixels are not ours
 * to look at here. */
function SiteIcon({
  href,
  site,
  theme,
}: {
  readonly href: string
  readonly site: MarkdownImage
  readonly theme: Theme
}): ReactNode {
  const host = /^https?:\/\/([^/?#:@]+)/i.exec(href)?.[1]?.toLowerCase()
  const [failed, setFailed] = useState(false)
  return (
    <View style={[styles.siteIcon, { backgroundColor: theme.secondary }]}>
      {host === undefined || failed ? (
        <Icon name="globe" size={11} color={theme.fgSecondary} />
      ) : (
        <Image
          source={{
            uri: `${site.origin}/api/favicon?host=${encodeURIComponent(host)}&theme=${theme.dark ? "dark" : "light"}`,
            headers: site.headers,
          }}
          style={{ width: 13, height: 13 }}
          contentFit="contain"
          cachePolicy="disk"
          // a 1-pixel image is the brain's "no icon"
          onLoad={(e) => void (e.source.width <= 1 && setFailed(true))}
          onError={() => setFailed(true)}
        />
      )}
    </View>
  )
}

/**
 * Splits an inline token stream at top-level image tokens: text runs become <Text> (with the body
 * style and selectable, exactly like a paragraph today), images become sibling <Image> rows.
 * Without an image config, or without any loadable top-level image, it returns one plain <Text>.
 */
function inlineRows(
  tokens: ReadonlyArray<Token>,
  ctx: Ctx,
  keyBase: string,
  image: MarkdownImage | undefined,
): ReactNode[] {
  const textRow = (run: ReadonlyArray<Token>, key: string): ReactNode => (
    <Text key={key} style={bodyText(ctx.color, ctx.size)} selectable>
      {inline(run, ctx, key)}
    </Text>
  )
  const src = (t: Token): string | undefined => {
    if (t.type !== "image" || image === undefined) return undefined
    const href = imageSrc((t as Tokens.Image).href, image.origin)
    if (ctx.uiCard && !href?.startsWith("/")) return undefined
    return href
  }
  const split = tokens.some((t) => src(t) !== undefined)
  if (!split) return [textRow(tokens, `${keyBase}.t`)]
  const rows: ReactNode[] = []
  let run: Token[] = []
  const flush = () => {
    if (run.some((t) => ("raw" in t ? String(t.raw) : "").trim() !== "")) {
      rows.push(textRow(run, `${keyBase}.t${rows.length}`))
    }
    run = []
  }
  tokens.forEach((t, i) => {
    const href = src(t)
    if (href === undefined || image === undefined) {
      run.push(t)
      return
    }
    flush()
    const img = t as Tokens.Image
    rows.push(
      <MdImage
        key={`${keyBase}.i${i}:${uri(href, image.origin)}`}
        href={href}
        alt={img.text || ""}
        origin={image.origin}
        headers={image.headers}
        theme={ctx.theme}
        size={ctx.size}
      />,
    )
  })
  flush()
  return rows
}

const inline = (tokens: ReadonlyArray<Token> | undefined, ctx: Ctx, keyBase: string): ReactNode[] =>
  (tokens ?? []).map((t, i) => {
    const key = `${keyBase}.${i}`
    switch (t.type) {
      case "strong":
        return (
          <Text key={key} style={{ fontWeight: "700" }}>
            {inline((t as Tokens.Strong).tokens, ctx, key)}
          </Text>
        )
      case "em":
        return (
          <Text key={key} style={{ fontStyle: "italic" }}>
            {inline((t as Tokens.Em).tokens, ctx, key)}
          </Text>
        )
      case "del":
        return (
          <Text key={key} style={{ textDecorationLine: "line-through" }}>
            {inline((t as Tokens.Del).tokens, ctx, key)}
          </Text>
        )
      case "codespan":
        return (
          <Text key={key} style={{ fontFamily: MONO, fontSize: ctx.size - 2, backgroundColor: ctx.theme.codeBg }}>
            {decode((t as Tokens.Codespan).text)}
          </Text>
        )
      case "link": {
        const link = t as Tokens.Link
        const href = safeHref(link.href)
        // A rejected protocol renders as text with no tap target at all (the same guard as
        // the web renderer); an allowed one stays tappable exactly as before.
        if (href === undefined || (ctx.uiCard && !/^https:\/\//i.test(href))) {
          return <Text key={key}>{inline(link.tokens, ctx, key)}</Text>
        }
        return (
          <Text
            key={key}
            style={{ color: ctx.theme.accentFg }}
            onPress={() => void Linking.openURL(href)}
            suppressHighlighting
          >
            {ctx.site !== undefined && /^https?:/i.test(href) && (
              <SiteIcon key={`${key}.icon`} href={href} site={ctx.site} theme={ctx.theme} />
            )}
            {ctx.site !== undefined && /^https?:/i.test(href) ? "\u00a0" : null}
            {inline(link.tokens, ctx, key)}
          </Text>
        )
      }
      case "br":
        return <Text key={key}>{"\n"}</Text>
      case "text": {
        const tt = t as Tokens.Text
        return tt.tokens ? (
          <Text key={key}>{inline(tt.tokens, ctx, key)}</Text>
        ) : (
          <Text key={key}>{decode(tt.text)}</Text>
        )
      }
      case "escape":
        return <Text key={key}>{(t as Tokens.Escape).text}</Text>
      case "image": {
        // Only images nested inside strong/em/del/link reach here — top-level ones are split out by
        // inlineRows() into block rows, and a rejected protocol falls through from there. An image
        // is not a link: degraded to text it stays text, with no tap target in any of the three
        // cases (illegal protocol, legal-but-unloadable, legal-and-loadable).
        const img = t as Tokens.Image
        return <Text key={key}>{img.text || img.href}</Text>
      }
      default:
        return <Text key={key}>{"raw" in t ? decode(String(t.raw)) : ""}</Text>
    }
  })

/** HTML entities marked leaves in text (`&amp;`, `&#39;`, …). */
const decode = (s: string): string =>
  s.replace(
    /&(amp|lt|gt|quot|#39|#x27);/g,
    (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" })[e] ?? _,
  )

const block = (t: Token, ctx: Ctx, key: string, depth = 0, image?: MarkdownImage): ReactNode => {
  const text = bodyText(ctx.color, ctx.size)
  switch (t.type) {
    case "paragraph": {
      const rows = inlineRows((t as Tokens.Paragraph).tokens, ctx, key, image)
      return rows.length === 1 ? (
        rows[0]
      ) : (
        <View key={key} style={{ gap: 4 }}>
          {rows}
        </View>
      )
    }
    case "heading": {
      const h = t as Tokens.Heading
      const size = h.depth <= 1 ? ctx.size + 5 : h.depth === 2 ? ctx.size + 3 : ctx.size + 1
      return (
        <Text
          key={key}
          style={[text, { fontSize: size, lineHeight: Math.round(size * 1.3), fontWeight: "700", marginTop: 4 }]}
        >
          {inline(h.tokens, ctx, key)}
        </Text>
      )
    }
    case "code": {
      const code = t as Tokens.Code
      return (
        <ScrollView
          key={key}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.code, { backgroundColor: ctx.theme.codeBg, borderColor: ctx.theme.lineTertiary }]}
        >
          <Text
            selectable
            style={{
              fontFamily: MONO,
              fontSize: ctx.size - 3,
              lineHeight: Math.round((ctx.size - 3) * 1.45),
              color: ctx.color,
            }}
          >
            {code.text}
          </Text>
        </ScrollView>
      )
    }
    case "blockquote":
      return (
        <View key={key} style={[styles.quote, { borderColor: ctx.theme.line }]}>
          {(t as Tokens.Blockquote).tokens.map((c, i) =>
            block(c, { ...ctx, color: ctx.theme.fgSecondary }, `${key}.${i}`, depth, image),
          )}
        </View>
      )
    case "list": {
      const list = t as Tokens.List
      const start = typeof list.start === "number" ? list.start : 1
      return (
        <View key={key} style={{ gap: 4, paddingLeft: depth > 0 ? 4 : 0 }}>
          {list.items.map((item, i) => (
            <View key={`${key}.${i}`} style={{ flexDirection: "row", gap: 6 }}>
              <Text style={[text, { minWidth: list.ordered ? 20 : 12, color: ctx.theme.fgSecondary }]}>
                {item.task ? (item.checked ? "☑" : "☐") : list.ordered ? `${start + i}.` : "•"}
              </Text>
              <View style={{ flexShrink: 1, gap: 4, opacity: item.task && item.checked ? 0.65 : 1 }}>
                {item.tokens.map((c, j) =>
                  c.type === "text"
                    ? inlineRows((c as Tokens.Text).tokens ?? [c], ctx, `${key}.${i}.${j}`, image)
                    : block(c, ctx, `${key}.${i}.${j}`, depth + 1, image),
                )}
              </View>
            </View>
          ))}
        </View>
      )
    }
    case "table": {
      const table = t as Tokens.Table
      const cell = (c: Tokens.TableCell, i: number, head: boolean) => (
        <View key={i} style={[styles.cell, { borderColor: ctx.theme.lineSecondary }]}>
          <Text style={[text, { fontSize: ctx.size - 2, fontWeight: head ? "600" : "400" }]}>
            {inline(c.tokens, ctx, `${key}.c${i}`)}
          </Text>
        </View>
      )
      return (
        <ScrollView key={key} horizontal showsHorizontalScrollIndicator={false}>
          <View style={[styles.table, { borderColor: ctx.theme.lineSecondary }]}>
            <View style={{ flexDirection: "row" }}>{table.header.map((c, i) => cell(c, i, true))}</View>
            {table.rows.map((row, r) => (
              <View key={r} style={{ flexDirection: "row" }}>
                {row.map((c, i) => cell(c, i, false))}
              </View>
            ))}
          </View>
        </ScrollView>
      )
    }
    case "hr":
      return (
        <View
          key={key}
          style={{ height: StyleSheet.hairlineWidth, backgroundColor: ctx.theme.line, marginVertical: 6 }}
        />
      )
    case "space":
      return null
    default:
      return "text" in t && typeof t.text === "string" && t.text.trim() !== "" ? (
        <Text key={key} style={text}>
          {decode(t.text)}
        </Text>
      ) : null
  }
}

export function Markdown({
  text,
  theme,
  color,
  size = 17,
  image,
  uiCard,
}: {
  readonly text: string
  readonly theme: Theme
  readonly color?: string
  readonly size?: number
  readonly image?: MarkdownImage
  readonly uiCard?: boolean
}): ReactNode {
  const tokens = useMemo(() => {
    try {
      return marked.lexer(text, { gfm: true, breaks: true })
    } catch {
      return [{ type: "paragraph", raw: text, text, tokens: [{ type: "text", raw: text, text }] } as Token]
    }
  }, [text])
  const ctx: Ctx = { theme, color: color ?? theme.fg, size, site: uiCard ? undefined : image, uiCard }
  return <View style={{ gap: 8 }}>{tokens.map((t, i) => block(t, ctx, String(i), 0, image))}</View>
}

const styles = StyleSheet.create({
  // sits on the text line like the web's (its bottom a little under the baseline)
  siteIcon: {
    width: 17,
    height: 17,
    borderRadius: 5,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    transform: [{ translateY: 3 }],
  },
  imageLoad: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  code: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 10 },
  quote: { borderLeftWidth: 3, paddingLeft: 10, gap: 6 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, overflow: "hidden" },
  cell: {
    minWidth: 90,
    maxWidth: 240,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
})

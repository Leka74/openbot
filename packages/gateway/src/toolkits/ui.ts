/**
 * UiToolkit (generative UI): `show_ui` posts a `ui` card, `update_ui` replaces one, both through
 * `UiCardService`. Tool schemas can't hold unions, so a block is an object with exactly one
 * per-type key (`{"table": {...}}`); the handler turns it into the contract's tagged block, decodes
 * it with `UiCardInput` and checks the caps.
 */
import { type AttachmentId, type EntryId, UiCardInput } from "@openbot/contracts"
import {
  type CurrentProfile,
  type DataDir,
  type IdGen,
  Messaging,
  type NodeDirectory,
  UiCardService,
} from "@openbot/core"
import { Effect } from "effect"
import * as p from "../params.ts"
import { textResult, ToolRefusal, utf8Length } from "../results.ts"
import { type AnyTool, defineTool, type ToolCallContext } from "../tool.ts"
import { decodeOrRefuse } from "./bot.ts"
import { chooseNode } from "./node.ts"

export type UiToolkitServices = UiCardService | Messaging | NodeDirectory | IdGen | DataDir | CurrentProfile

const UI_LIMITS = {
  bytes: 32 * 1024,
  blocks: 20,
  tableRows: 50,
  tableColumns: 8,
  options: 6,
  chartSeries: 4,
  chartPoints: 60,
  actions: 4,
} as const

const blockFields = {
  text: p.optional(p.text("Markdown (no HTML, no remote images).")),
  fields: p.optional(p.array(p.object({ label: p.text(), value: p.string() }), "Label/value pairs.")),
  table: p.optional(
    p.object(
      {
        columns: p.array(p.string(), `Column headers (at most ${UI_LIMITS.tableColumns}).`, { minItems: 1 }),
        rows: p.array(p.array(p.string()), `Rows of cells (at most ${UI_LIMITS.tableRows}).`),
      },
      "A table.",
    ),
  ),
  options: p.optional(
    p.object(
      {
        items: p.array(
          p.object({
            id: p.text(),
            title: p.text(),
            subtitle: p.optional(p.string()),
            lines: p.optional(p.array(p.string(), "Short lines, e.g. pros or specs.")),
            value: p.optional(p.string("A headline value, e.g. a price.")),
            note: p.optional(p.string()),
            badge: p.optional(p.string()),
          }),
          `Side-by-side options to compare (at most ${UI_LIMITS.options}).`,
          { minItems: 1 },
        ),
        pick: p.optional(p.string('The id of the option you recommend (shown as "My pick").')),
      },
      "Options to compare.",
    ),
  ),
  stats: p.optional(
    p.array(
      p.object({
        label: p.text(),
        value: p.text(),
        delta: p.optional(p.string('A change, e.g. "+4%".')),
        tone: p.optional(p.literals(["good", "bad", "neutral"])),
      }),
      "Key numbers.",
    ),
  ),
  checklist: p.optional(
    p.array(
      p.object({
        label: p.text(),
        detail: p.optional(p.string()),
        status: p.literals(["done", "active", "upcoming", "failed"]),
      }),
      "Steps with their status (plans, progress).",
    ),
  ),
  timeline: p.optional(
    p.array(
      p.object({ time: p.text(), title: p.text(), detail: p.optional(p.string()), tag: p.optional(p.string()) }),
      "Events in order (schedules, agendas).",
    ),
  ),
  chart: p.optional(
    p.object(
      {
        kind: p.literals(["bar", "line"]),
        fill: p.optional(p.boolean("Fill under each line: an area chart (kind line).")),
        stacked: p.optional(
          p.boolean("Pile the series on top of each other to show totals (bars, or lines with fill)."),
        ),
        unit: p.optional(p.string()),
        series: p.array(
          p.object({
            name: p.text(),
            points: p.array(p.object({ x: p.string("Category label."), y: p.number() }), undefined, { minItems: 1 }),
          }),
          `At most ${UI_LIMITS.chartSeries} series of at most ${UI_LIMITS.chartPoints} points.`,
          { minItems: 1 },
        ),
        highlight: p.optional(p.string("An x value to highlight.")),
      },
      "A bar, line or area chart.",
    ),
  ),
  image: p.optional(
    p.object(
      {
        path: p.text("An image file you made: relative to your workspace, absolute, or ~/… on your host computer."),
        alt: p.string("What it shows."),
      },
      "An image file (never a URL).",
    ),
  ),
  link: p.optional(p.object({ label: p.text(), url: p.text("An https:// URL.") }, "A link that opens outside.")),
  choice: p.optional(
    p.object(
      {
        id: p.text("Key of the answer."),
        label: p.text(),
        mode: p.literals(["one", "many"]),
        options: p.array(
          p.object({ id: p.text(), label: p.text(), detail: p.optional(p.string()), badge: p.optional(p.string()) }),
          undefined,
          { minItems: 1 },
        ),
        default: p.optional(p.array(p.string(), "Option ids selected at first.")),
      },
      "The owner picks one or many options.",
    ),
  ),
  input: p.optional(
    p.object(
      {
        id: p.text("Key of the answer."),
        label: p.text(),
        placeholder: p.optional(p.string()),
        default: p.optional(p.string()),
        multiline: p.optional(p.boolean()),
      },
      "The owner types text.",
    ),
  ),
}
type BlockArgs = p.Infer<typeof blockFields>
const BLOCK_TYPES = Object.keys(blockFields) as ReadonlyArray<keyof BlockArgs>

const cardFields = {
  title: p.optional(p.string("Short card title.")),
  subtitle: p.optional(p.string()),
  collapsed: p.optional(p.boolean("Start folded to the fallback line; the owner taps to open it.")),
  blocks: p.array(
    p.object(blockFields),
    `The card's content, top to bottom (at most ${UI_LIMITS.blocks}). Each block has exactly one of: ${BLOCK_TYPES.join(", ")}.`,
    { minItems: 1 },
  ),
  actions: p.optional(
    p.array(
      p.object({
        id: p.text(),
        label: p.text(),
        style: p.optional(p.literals(["primary", "secondary", "danger"])),
      }),
      `Buttons at the bottom (at most ${UI_LIMITS.actions}). Pressing one sends you the owner's choice and answers as a message, once.`,
    ),
  ),
  fallback: p.text(
    "The card as plain text, one or two sentences: what notifications, search, teammates and old apps show.",
  ),
}
type CardArgs = p.Infer<typeof cardFields>

/** One block's arguments as the contract's tagged block (undecoded). */
const blockOf = (block: BlockArgs, nextImage: () => AttachmentId | undefined): unknown => {
  if (block.text !== undefined) return { type: "text", markdown: block.text }
  if (block.fields !== undefined) return { type: "fields", items: block.fields }
  if (block.table !== undefined) return { type: "table", ...block.table }
  if (block.options !== undefined) return { type: "options", ...block.options }
  if (block.stats !== undefined) return { type: "stats", items: block.stats }
  if (block.checklist !== undefined) return { type: "checklist", items: block.checklist }
  if (block.timeline !== undefined) return { type: "timeline", items: block.timeline }
  if (block.chart !== undefined) return { type: "chart", ...block.chart }
  if (block.image !== undefined) return { type: "image", attachmentId: nextImage(), alt: block.image.alt }
  if (block.link !== undefined) return { type: "link", ...block.link }
  if (block.choice !== undefined) return { type: "choice", ...block.choice }
  return { type: "input", ...block.input }
}

/** The flat tool arguments as the contract's card (undecoded), or what is wrong with them. */
export const toUiCard = (
  args: CardArgs,
  images: ReadonlyArray<AttachmentId>,
): { readonly card: unknown } | { readonly error: string } => {
  for (const [i, block] of args.blocks.entries()) {
    const types = BLOCK_TYPES.filter((type) => block[type] !== undefined)
    if (types.length !== 1) {
      return {
        error: `Block ${i + 1} must have exactly one of ${BLOCK_TYPES.join(", ")} (it has ${types.length === 0 ? "none" : types.join(", ")}).`,
      }
    }
  }
  let image = 0
  const blocks = args.blocks.map((block) => blockOf(block, () => images[image++]))
  return { card: { type: "ui", version: 1, ...args, blocks } }
}

/** What breaks a cap or a rule in `card`, as a message the model can fix. */
export const uiCardProblem = (card: UiCardInput): string | undefined => {
  const bytes = utf8Length(JSON.stringify(card))
  if (bytes > UI_LIMITS.bytes)
    return `The card is ${Math.ceil(bytes / 1024)} KB; keep it under ${UI_LIMITS.bytes / 1024} KB (shorten text, tables or the fallback).`
  if (card.blocks.length > UI_LIMITS.blocks)
    return `The card has ${card.blocks.length} blocks; the most is ${UI_LIMITS.blocks}.`
  const actions = card.actions ?? []
  if (actions.length > UI_LIMITS.actions)
    return `The card has ${actions.length} actions; the most is ${UI_LIMITS.actions}.`
  if (new Set(actions.map((a) => a.id)).size !== actions.length) return "Each action needs its own id."
  const answerIds = new Set<string>()
  for (const [i, block] of card.blocks.entries()) {
    const at = `Block ${i + 1} (${block.type})`
    switch (block.type) {
      case "table":
        if (block.columns.length > UI_LIMITS.tableColumns)
          return `${at} has ${block.columns.length} columns; the most is ${UI_LIMITS.tableColumns}.`
        if (block.rows.length > UI_LIMITS.tableRows)
          return `${at} has ${block.rows.length} rows; the most is ${UI_LIMITS.tableRows}.`
        if (block.rows.some((row) => row.length > block.columns.length))
          return `${at} has a row with more cells than columns.`
        break
      case "options":
        if (block.items.length > UI_LIMITS.options)
          return `${at} has ${block.items.length} options; the most is ${UI_LIMITS.options}.`
        break
      case "chart":
        if (block.series.length > UI_LIMITS.chartSeries)
          return `${at} has ${block.series.length} series; the most is ${UI_LIMITS.chartSeries}.`
        if (block.series.some((s) => s.points.length > UI_LIMITS.chartPoints))
          return `${at} has a series with more than ${UI_LIMITS.chartPoints} points.`
        break
      case "link":
        if (URL.parse(block.url)?.protocol !== "https:") return `${at}: the url must be an https:// link.`
        break
      case "choice": {
        const ids = new Set(block.options.map((o) => o.id))
        if (ids.size !== block.options.length) return `${at}: each option needs its own id.`
        const defaults = block.default ?? []
        if (defaults.some((id) => !ids.has(id))) return `${at}: \`default\` must list ids of its options.`
        if (block.mode === "one" && defaults.length > 1) return `${at}: mode "one" takes at most one default.`
        break
      }
    }
    if (block.type === "choice" || block.type === "input") {
      if (answerIds.has(block.id)) return `${at}: the id "${block.id}" is used twice.`
      answerIds.add(block.id)
    }
  }
  if (answerIds.size > 0 && actions.length === 0)
    return "A card with a choice or an input needs an action (a button) to send the answer."
  return undefined
}

/** Imports the image files, then builds, decodes and checks the card. */
const cardFromArgs = (args: CardArgs, ctx: ToolCallContext) =>
  Effect.gen(function* () {
    const paths = args.blocks.flatMap((block) => (block.image === undefined ? [] : [block.image.path]))
    const images =
      paths.length === 0
        ? []
        : yield* Effect.gen(function* () {
            const target = yield* chooseNode(ctx, undefined, "fs")
            return yield* (yield* Messaging).importFiles({
              nodeId: target.nodeId,
              inv: target.inv,
              cwd: target.workspace,
              paths,
              progress: ctx.progress,
            })
          })
    const notImage = images.find((file) => !file.mime.startsWith("image/"))
    if (notImage !== undefined) return yield* new ToolRefusal({ message: `${notImage.name} is not an image.` })
    const built = toUiCard(
      args,
      images.map((file) => file.id),
    )
    if ("error" in built) return yield* new ToolRefusal({ message: built.error })
    const card = yield* decodeOrRefuse(UiCardInput, built.card, "card")
    const problem = uiCardProblem(card)
    if (problem !== undefined) return yield* new ToolRefusal({ message: problem })
    if (ctx.tool.taskId !== undefined && card.actions !== undefined && card.actions.length > 0)
      return yield* new ToolRefusal({
        message:
          "Background work can't wait for the owner's answer: drop the actions, or say what you need in your result.",
      })
    return card
  })

const showUi = defineTool({
  name: "show_ui",
  toolset: "bot",
  description: `Post a native card in this conversation instead of a prose answer when you compare options, report a status or plan with numbers, lay out a schedule, or let the owner pick from options you worked out (a \`choice\` block and an action, rather than ask_user). Plain answers and explanations stay plain text, never a card. Blocks render top to bottom; each block is an object with exactly one key: text (markdown), fields, table, options (side by side, \`pick\` marks your recommendation), stats, checklist, timeline, chart (bar or line; an area is a line with \`fill\`, for one series or a stacked whole, never many overlapping series; \`stacked\` piles series into totals), image (a file path), link (https only), choice or input. \`fallback\` is required: the card as plain text. With \`actions\` (required when there is a choice or an input), the owner's press (and their choice and input values) comes back to you once, as a new message; without, the card is display-only. Returns the card's entry id for update_ui. Caps: ${UI_LIMITS.blocks} blocks, ${UI_LIMITS.tableRows}×${UI_LIMITS.tableColumns} tables, ${UI_LIMITS.options} options, ${UI_LIMITS.chartSeries} series of ${UI_LIMITS.chartPoints} points, ${UI_LIMITS.actions} actions, ${UI_LIMITS.bytes / 1024} KB.`,
  params: p.params(cardFields),
  annotations: { title: "Show a card", destructiveHint: false, openWorldHint: false },
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const card = yield* cardFromArgs(args, ctx)
      const { entryId } = yield* (yield* UiCardService).show(ctx.tool, card)
      const next =
        card.actions !== undefined && card.actions.length > 0
          ? "The owner's answer arrives later as a new message; don't wait for it. With nothing else to add, reply exactly NO_REPLY."
          : "Don't repeat the card in your reply: add a sentence only for what it doesn't say, else reply exactly NO_REPLY."
      return textResult(`Shown (entry ${entryId}; update_ui changes it). ${next}`)
    }),
})

const updateUi = defineTool({
  name: "update_ui",
  toolset: "bot",
  description:
    "Replace a card you posted with show_ui in this conversation, e.g. to move a checklist along or change a status. Pass its entry id and the whole new card (same fields as show_ui). A card the owner already answered can't change.",
  params: p.params({ entry_id: p.text("The card's entry id (from show_ui)."), ...cardFields }),
  annotations: { title: "Update a card", destructiveHint: false, openWorldHint: false },
  handler: ({ entry_id, ...args }, ctx) =>
    Effect.gen(function* () {
      const card = yield* cardFromArgs(args, ctx)
      yield* (yield* UiCardService).update(ctx.tool, entry_id as EntryId, card)
      return textResult(`Updated the card ${entry_id}. Don't repeat it in your reply.`)
    }),
})

export const UiToolkit: ReadonlyArray<AnyTool<UiToolkitServices>> = [showUi, updateUi]

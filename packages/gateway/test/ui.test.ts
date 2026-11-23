// show_ui / update_ui: flat blocks become the contract's tagged blocks, every cap and rule is refused
// with an ERROR that names it, and image files are imported from the node as attachments.
import { afterEach, describe, expect, test } from "bun:test"
import { LOCAL_NODE_ID, UiCardInput } from "@openbot/contracts"
import { NodeFilesFake } from "@openbot/core/testing"
import { Effect, Result, Schema } from "effect"
import { toUiCard, uiCardProblem, UiToolkit } from "../src/toolkits/ui.ts"
import { BOT_A, type Harness, startHarness, textOf } from "./harness.ts"

const [showUi] = UiToolkit

/** The tool's verdict on raw arguments: the problem, or undefined when the card would be posted. */
const problemOf = (raw: object): string | undefined => {
  const args = showUi!.params.decode(raw)
  if (!args.ok) return args.error
  const built = toUiCard(args.value as Parameters<typeof toUiCard>[0], [])
  if ("error" in built) return built.error
  const card = Schema.decodeUnknownResult(UiCardInput)(built.card)
  if (Result.isFailure(card)) return String(card.failure)
  return uiCardProblem(card.success)
}

const card = (blocks: ReadonlyArray<object>, extra: object = {}) => ({ blocks, fallback: "A card.", ...extra })
const send = { actions: [{ id: "send", label: "Send" }] }
const list = <A>(n: number, f: (i: number) => A): Array<A> => Array.from({ length: n }, (_, i) => f(i))

describe("toUiCard", () => {
  test("every block key becomes its tagged block", () => {
    const args = showUi!.params.decode({
      title: "Plan",
      blocks: [
        { text: "Hi" },
        { fields: [{ label: "A", value: "1" }] },
        { table: { columns: ["A"], rows: [["1"]] } },
        { options: { items: [{ id: "a", title: "A" }], pick: "a" } },
        { stats: [{ label: "A", value: "1", tone: "good" }] },
        { checklist: [{ label: "A", status: "done" }] },
        { timeline: [{ time: "9:00", title: "A" }] },
        { chart: { kind: "line", fill: true, stacked: true, series: [{ name: "A", points: [{ x: "Mon", y: 1 }] }] } },
        { image: { path: "chart.png", alt: "Chart" } },
        { link: { label: "A", url: "https://example.com" } },
        { choice: { id: "c", label: "C", mode: "one", options: [{ id: "x", label: "X" }] } },
        { input: { id: "i", label: "I" } },
      ],
      actions: [{ id: "send", label: "Send", style: "primary" }],
      fallback: "The plan.",
    })
    if (!args.ok) throw new Error(args.error)
    const built = toUiCard(args.value as Parameters<typeof toUiCard>[0], ["att_1" as never])
    if ("error" in built) throw new Error(built.error)
    const decoded = Schema.decodeUnknownSync(UiCardInput)(built.card)
    expect(decoded.blocks.map((b) => b.type)).toEqual([
      "text",
      "fields",
      "table",
      "options",
      "stats",
      "checklist",
      "timeline",
      "chart",
      "image",
      "link",
      "choice",
      "input",
    ])
    expect(decoded).toMatchObject({ type: "ui", version: 1, title: "Plan", fallback: "The plan." })
    expect(decoded.blocks[7]).toMatchObject({ type: "chart", kind: "line", fill: true, stacked: true })
    expect(decoded.blocks[8]).toMatchObject({ type: "image", attachmentId: "att_1", alt: "Chart" })
    expect(uiCardProblem(decoded)).toBeUndefined()
  })

  test("a block needs exactly one key", () => {
    expect(problemOf(card([{}]))).toContain("Block 1 must have exactly one of text, fields")
    expect(problemOf(card([{ text: "a" }, { text: "b", table: { columns: ["A"], rows: [] } }]))).toContain(
      "Block 2 must have exactly one of text, fields, table, options, stats, checklist, timeline, chart, image, link, choice, input (it has text, table)",
    )
  })
})

describe("show_ui refuses what breaks a cap or a rule", () => {
  test("links are https only", () => {
    for (const url of ["javascript:alert(1)", "http://example.com", "data:text/html,<script>alert(1)</script>", "x"]) {
      expect(problemOf(card([{ link: { label: "L", url } }]))).toBe("Block 1 (link): the url must be an https:// link.")
    }
    expect(problemOf(card([{ link: { label: "L", url: "https://example.com/a?b=c" } }]))).toBeUndefined()
  })

  test("caps: tables, options, charts, blocks, actions and bytes", () => {
    const columns = list(10, (i) => `Column ${i + 1}`)
    expect(problemOf(card([{ table: { columns, rows: [] } }]))).toBe("Block 1 (table) has 10 columns; the most is 8.")
    expect(problemOf(card([{ table: { columns: ["A"], rows: list(60, () => ["x"]) } }]))).toBe(
      "Block 1 (table) has 60 rows; the most is 50.",
    )
    expect(problemOf(card([{ table: { columns: ["A"], rows: [["x", "y"]] } }]))).toBe(
      "Block 1 (table) has a row with more cells than columns.",
    )
    expect(problemOf(card([{ options: { items: list(7, (i) => ({ id: `o${i}`, title: "O" })) } }]))).toBe(
      "Block 1 (options) has 7 options; the most is 6.",
    )
    const series = (n: number, points: number) =>
      list(n, (i) => ({ name: `S${i}`, points: list(points, (j) => ({ x: `${j}`, y: j })) }))
    expect(problemOf(card([{ chart: { kind: "line", series: series(5, 1) } }]))).toBe(
      "Block 1 (chart) has 5 series; the most is 4.",
    )
    expect(problemOf(card([{ chart: { kind: "bar", series: series(1, 61) } }]))).toBe(
      "Block 1 (chart) has a series with more than 60 points.",
    )
    expect(problemOf(card(list(21, () => ({ text: "a" }))))).toBe("The card has 21 blocks; the most is 20.")
    expect(problemOf(card([{ text: "a" }], { actions: list(5, (i) => ({ id: `a${i}`, label: "A" })) }))).toBe(
      "The card has 5 actions; the most is 4.",
    )
    expect(problemOf(card([{ text: "x".repeat(33_000) }]))).toContain("keep it under 32 KB")
  })

  test("ids: unique actions and answers, defaults among the options, a button to send answers", () => {
    const choice = (extra: object = {}) => ({
      choice: {
        id: "slot",
        label: "Slot",
        mode: "one",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        ...extra,
      },
    })
    expect(problemOf(card([{ text: "a" }], { actions: [send.actions[0], send.actions[0]] }))).toBe(
      "Each action needs its own id.",
    )
    expect(problemOf(card([choice(), { input: { id: "slot", label: "Slot" } }], send))).toBe(
      'Block 2 (input): the id "slot" is used twice.',
    )
    expect(problemOf(card([choice({ default: ["c"] })], send))).toBe(
      "Block 1 (choice): `default` must list ids of its options.",
    )
    expect(problemOf(card([choice({ default: ["a", "b"] })], send))).toBe(
      'Block 1 (choice): mode "one" takes at most one default.',
    )
    expect(problemOf(card([choice()]))).toBe(
      "A card with a choice or an input needs an action (a button) to send the answer.",
    )
    expect(problemOf(card([choice({ default: ["a"] })], send))).toBeUndefined()
  })

  test("missing fields and bad enums are refused by the params", () => {
    expect(problemOf({ blocks: [{ text: "a" }] })).toBe("`fallback` is required")
    expect(problemOf(card([]))).toBe("`blocks` must have at least 1 item")
    expect(problemOf(card([{ stats: [{ label: "A", value: "1", tone: "meh" }] }]))).toBe(
      "`blocks[0].stats[0].tone` must be one of: good, bad, neutral",
    )
  })
})

describe("show_ui and update_ui through the gateway", () => {
  let h: Harness
  afterEach(async () => {
    await h?.close()
  })
  const WS = `/openbot-test/bots/${BOT_A}/workspace`

  const start = async () => {
    h = await startHarness({ realMessaging: true })
    await h.run(
      Effect.gen(function* () {
        const files = yield* NodeFilesFake
        yield* files.put(
          LOCAL_NODE_ID,
          `${WS}/chart.png`,
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        )
        yield* files.put(LOCAL_NODE_ID, `${WS}/notes.txt`, new TextEncoder().encode("notes"))
      }),
    )
    return h.connect((await h.issue({ toolsets: ["bot"] })).binding)
  }

  test("a valid card is posted with its image imported; a hostile one is an ERROR and posts nothing", async () => {
    const client = await start()
    const hostile = await client.callTool({
      name: "show_ui",
      arguments: card([
        { text: "Script link: [click](javascript:alert(1))" },
        { link: { label: "javascript link", url: "javascript:alert(1)" } },
      ]),
    })
    expect(hostile.isError).toBe(true)
    expect(textOf(hostile)).toBe("ERROR: Block 2 (link): the url must be an https:// link.")

    const shown = await client.callTool({
      name: "show_ui",
      arguments: card(
        [
          { image: { path: "chart.png", alt: "Chart" } },
          { choice: { id: "c", label: "C", mode: "many", options: [{ id: "x", label: "X" }] } },
        ],
        send,
      ),
    })
    expect(textOf(shown)).toContain("Shown (entry ent_ui; update_ui changes it).")
    expect(textOf(shown)).toContain("NO_REPLY")
    const calls = h.messagingCalls.filter((c) => c.method === "showUi")
    expect(calls).toHaveLength(1)
    const posted = calls[0]!.input as UiCardInput
    expect(posted.blocks[0]).toMatchObject({ type: "image", alt: "Chart" })
    expect((posted.blocks[0] as { attachmentId: string }).attachmentId).toStartWith("att_")

    const missing = await client.callTool({
      name: "show_ui",
      arguments: card([{ image: { path: "nope.png", alt: "Nope" } }]),
    })
    expect(missing.isError).toBe(true)
    const notImage = await client.callTool({
      name: "show_ui",
      arguments: card([{ image: { path: "notes.txt", alt: "Notes" } }]),
    })
    expect(textOf(notImage)).toBe("ERROR: notes.txt is not an image.")
  })

  test("update_ui passes the entry id; background work can't post actions", async () => {
    const client = await start()
    const updated = await client.callTool({
      name: "update_ui",
      arguments: { entry_id: "ent_7", ...card([{ checklist: [{ label: "Build", status: "active" }] }]) },
    })
    expect(textOf(updated)).toBe("Updated the card ent_7. Don't repeat it in your reply.")
    expect(h.messagingCalls.find((c) => c.method === "updateUi")?.input).toMatchObject({ entryId: "ent_7" })
    // loose in its schema, checked like show_ui's card
    const bad = await client.callTool({
      name: "update_ui",
      arguments: { entry_id: "ent_7", ...card([{ checklist: [{ label: "Build", status: "later" }] }]) },
    })
    expect(textOf(bad)).toBe(
      "ERROR: Invalid arguments for update_ui: `blocks[0].checklist[0].status` must be one of: done, active, upcoming, failed.",
    )
    const twoKeys = await client.callTool({
      name: "update_ui",
      arguments: { entry_id: "ent_7", ...card([{ text: "a", link: { label: "b", url: "https://x.test" } }]) },
    })
    expect(textOf(twoKeys)).toContain("ERROR: Block 1 must have exactly one of")

    const task = await h.connect((await h.issue({ toolsets: ["bot"], taskId: "tsk_1" as never })).binding)
    const asked = await task.callTool({ name: "show_ui", arguments: card([{ text: "Pick?" }], send) })
    expect(textOf(asked)).toContain("ERROR: Background work can't wait for the owner's answer")
    expect((await task.callTool({ name: "show_ui", arguments: card([{ text: "Done." }]) })).isError).toBeFalsy()
  })
})

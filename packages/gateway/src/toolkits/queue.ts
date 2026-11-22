/**
 * QueueToolkit: `add_to_queue` puts a decision, review or FYI in the owner's queue (`DecisionQueue`),
 * offered only when the brain has a queue (`ToolAvailability.queue`). The owner's decision comes back to
 * the Bot as a `queue-decision` delivery in the conversation it called from.
 */
import { BotService, type CurrentProfile, DecisionQueue } from "@openbot/core"
import { Effect, Option } from "effect"
import * as p from "../params.ts"
import { textResult, ToolRefusal } from "../results.ts"
import { type AnyTool, defineTool, type ToolAvailability } from "../tool.ts"

const queueOn = ({ queue }: ToolAvailability): boolean => queue === true

const DATE = /^\d{4}-\d{2}-\d{2}$/
const UNASSIGNED = "Unassigned"

const addToQueue = defineTool({
  name: "add_to_queue",
  toolset: "bot",
  description:
    "Put something that needs the owner in their queue, the one ranked list they burn down to zero: a `decision` (they approve, reject, pick an option or reply with changes), a `review` (look at a result) or an `fyi`. Say why it needs them now and what you recommend; with `options`, mark yours with `recommended_option`. Their decision comes back to you here as a message; marking an item done tells you nothing. Give a stable `key` to update the same item instead of adding another, and re-add with that key after they send it back. Don't re-add or chase an item they marked done, trashed or filtered: it only comes back when its content materially changes. Use it instead of a card or message when the owner should decide in their own time.",
  params: p.params({
    title: p.text("Short title: what they decide or look at."),
    why: p.text("Why it needs them now."),
    type: p.optional(p.literals(["decision", "review", "fyi"], "Default decision."), "decision"),
    recommendation: p.optional(p.string("What you recommend, and why, in a sentence or two.")),
    options: p.optional(p.array(p.text(), "Choices, in order (at most 9).", { maxItems: 9 })),
    recommended_option: p.optional(
      p.number("Your pick: its 1-based position in `options`.", { integer: true, min: 1, max: 9 }),
    ),
    evidence: p.optional(
      p.array(
        p.object({ text: p.text("What it shows."), url: p.optional(p.string("An https link to it.")) }),
        "What supports it (at most 10).",
        { maxItems: 10 },
      ),
    ),
    due: p.optional(p.string("When it must be decided: YYYY-MM-DD.")),
    stakes: p.optional(p.number("1 normal (default), 2 high, 3 critical.", { integer: true, min: 1, max: 3 })),
    blocking: p.optional(p.boolean("Work waits on it.")),
    key: p.optional(p.string("Stable key: adding again with it updates the same item.")),
  }),
  annotations: { title: "Add to the owner's queue", destructiveHint: false, openWorldHint: false },
  available: queueOn,
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const queue = yield* Effect.serviceOption(DecisionQueue)
      if (Option.isNone(queue)) return yield* new ToolRefusal({ message: "The owner has no queue." })
      if (args.due !== undefined && !DATE.test(args.due))
        return yield* new ToolRefusal({ message: "`due` must be YYYY-MM-DD." })
      const evidence = args.evidence?.map((e) => ({
        text: e.text,
        ...(e.url !== undefined && /^https:\/\//.test(e.url) ? { url: e.url } : {}),
      }))
      const bots = yield* BotService
      const bot = yield* Effect.orDie(bots.get(ctx.claims.botId))
      const section =
        bot.sectionId === undefined ? undefined : (yield* bots.listSections).find((s) => s.id === bot.sectionId)
      const result = yield* queue.value
        .add({
          profileId: bot.ownerProfileId,
          botId: bot.id,
          botName: bot.name,
          conversationId: ctx.claims.conversationId,
          area: section?.name ?? UNASSIGNED,
          type: args.type ?? "decision",
          title: args.title,
          why: args.why,
          recommendation: args.recommendation,
          options: args.options,
          recommendedOption: args.recommended_option,
          evidence,
          due: args.due,
          stakes: args.stakes as 1 | 2 | 3 | undefined,
          blocking: args.blocking,
          key: args.key,
        })
        .pipe(
          Effect.catch((error) => Effect.fail(new ToolRefusal({ message: `The queue refused it: ${error.message}.` }))),
        )
      switch (result._tag) {
        case "added":
          return textResult(`Added to the owner's queue as ${result.id}. Their decision comes back to you here.`)
        case "updated":
          return textResult(`Updated ${result.id} in the owner's queue (revision ${result.revision}).`)
        case "unchanged":
          return textResult(
            result.closed === undefined
              ? `${result.id} is already in the owner's queue as it is.`
              : `The owner already closed ${result.id} (${result.closed}). It comes back only if its content materially changes; don't chase it.`,
          )
        case "filtered":
          return textResult(
            `The owner's rule #${result.rule.id} (${result.rule.label}) filtered it, so it isn't shown. Don't re-add or chase it.`,
          )
      }
    }),
})

export const QueueToolkit: ReadonlyArray<AnyTool<BotService | CurrentProfile>> = [addToQueue]

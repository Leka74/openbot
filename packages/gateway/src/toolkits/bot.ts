/**
 * BotToolkit (D3.2, architecture §4.6): product tools that call core services. Every tool maps to
 * exactly one service method (docs/interfaces.md §6.2 table):
 *
 * message_bot → Messaging.messageBot · post_to_group → Messaging.postToGroup · handoff_task →
 * Messaging.handoffTask · list_bots → BotService.list · ask_user → ApprovalService.askUser ·
 * request_approval → ApprovalService.requestApproval · notify_user → Notifier.notify · remember /
 * forget → MemoryService.putFact / deleteFact · recall_memory → MemoryService.recall · create_routine
 * → RoutineScheduler.create · update_routine → get + merge + update · list_routines →
 * RoutineScheduler.list · save_skill / list_skills → SkillService · list_nodes → NodeDirectory.list
 * (host + bound nodes only) · send_file → Messaging.sendFiles (the file streams from the node, its
 * path policy applies; one bot message with the files lands in the current conversation).
 *
 * D3.3: `ask_user` and `request_approval` never block; they return `pending` with a request id and
 * the answer arrives later as a new message.
 */
import {
  type ConversationId,
  type EntryId,
  MemoryFactId,
  MemoryFactInput,
  type NodeId,
  type NodeSummary,
  Question,
  type Routine,
  type RoutineTrigger,
  RoutineSpec,
  type Section,
  SkillInput,
  type SkillName,
} from "@openbot/contracts"
import {
  type CurrentProfile,
  ApprovalService,
  BotService,
  botActor,
  DataDir,
  formatBytes,
  IdGen,
  MemoryService,
  Messaging,
  HarnessRegistry,
  NodeDirectory,
  Notifier,
  Orchestrator,
  RoutineScheduler,
  SkillService,
} from "@openbot/core"
import { Effect, Result, Schema } from "effect"
import * as p from "../params.ts"
import { capText, linesResult, textResult, ToolRefusal } from "../results.ts"
import { type AnyTool, defineTool, type ToolCallContext } from "../tool.ts"
import { approve, chooseNode } from "./node.ts"
import { notInTask } from "./tasks.ts"

export type BotToolkitServices =
  | CurrentProfile
  | Messaging
  | BotService
  | ApprovalService
  | Notifier
  | MemoryService
  | RoutineScheduler
  | SkillService
  | NodeDirectory
  | HarnessRegistry
  | IdGen
  | DataDir
  | Orchestrator

/** Decodes `value` with an Effect schema; failures become a model-readable refusal. */
export const decodeOrRefuse = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  value: unknown,
  what: string,
): Effect.Effect<S["Type"], ToolRefusal> => {
  const result = Schema.decodeUnknownResult(schema)(value)
  return Result.isSuccess(result)
    ? Effect.succeed(result.success)
    : Effect.fail(new ToolRefusal({ message: `Invalid ${what}: ${String(result.failure.message ?? result.failure)}` }))
}

const isoTime = (ms: number | undefined): string => (ms === undefined ? "—" : new Date(ms).toISOString())

// ============================================================================ messaging

const messageBot = defineTool({
  name: "message_bot",
  toolset: "bot",
  description:
    "Send a message to another bot on your team. Asynchronous: you do not wait for an answer. In a group chat where the recipient is also a member, prefer @mentioning them in your reply: this only notes that they should be woken by your reply (put your message to them in the reply; nothing is posted twice). Otherwise it goes to the recipient's own chat and they reply to you with message_bot if needed. Use list_bots to see who is on the team.",
  params: p.params({
    to: p.text('Recipient bot: its name (e.g. "@Scout" or "Scout") or its id.'),
    text: p.text("The message."),
    urgency: p.optional(
      p.literals(
        ["background", "urgent"],
        "background (default): wakes the recipient now if it is idle, otherwise right after its current turn. urgent: the recipient reads it as soon as possible (folded into its current turn when it is working in the same chat, else right after it). Bots never cut each other off.",
      ),
      "background",
    ),
  }),
  annotations: { title: "Message a bot", destructiveHint: false, openWorldHint: false },
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const messaging = yield* Messaging
      const bots = yield* BotService
      const result = yield* messaging.messageBot(ctx.tool, {
        to: args.to,
        text: args.text,
        urgency: args.urgency ?? "background",
      })
      const name = yield* bots.get(result.recipientBotId).pipe(
        Effect.map((bot) => `@${bot.name}`),
        Effect.orElseSucceed(() => args.to),
      )
      return textResult(
        result.noted === true
          ? notedText(name)
          : result.postedInGroup === true
            ? `Posted in this group chat, addressed to ${name} (delivery ${result.deliveryId}). They will answer here in the group.`
            : `Message sent to ${name} (delivery ${result.deliveryId}). They will answer in their own chat; you will hear back only if they message you.`,
      )
    }),
})

/** message_bot / handoff_task to a fellow member during a group turn (nothing is posted separately). */
const notedText = (name: string) => {
  const bare = name.replace(/^@/, "")
  return `Noted — nothing was posted yet. Your reply is posted in this group: address ${bare} there by @mentioning them with your message, and they are woken by it. If your reply does not @mention ${bare}, this message is posted for them on its own.`
}

const postToGroup = defineTool({
  name: "post_to_group",
  toolset: "bot",
  description:
    "Post a message into a group chat you are a member of. Defaults to the current conversation when it is a group. Mention teammates with @Name to have them respond.",
  params: p.params({
    text: p.text("The message to post."),
    conversation_id: p.optional(p.text("Group conversation id. Omit to post into the current group chat.")),
  }),
  annotations: { title: "Post to a group chat", destructiveHint: false, openWorldHint: false },
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const messaging = yield* Messaging
      const result = yield* messaging.postToGroup(ctx.tool, {
        text: args.text,
        conversationId: args.conversation_id as ConversationId | undefined,
      })
      return textResult(`Posted to group ${result.conversationId} (entry ${result.entryId}).`)
    }),
})

const handoffTask = defineTool({
  name: "handoff_task",
  toolset: "bot",
  description:
    "Hand a task over to another bot: they become its owner and are woken with your task description and context. Asynchronous; you do not wait for the result. In a group chat where the recipient is also a member, the handoff stays in the group: it notes that your reply wakes them (put the task in your reply, @mentioning them), so everyone keeps the same context.",
  params: p.params({
    to: p.text('Recipient bot: its name (e.g. "@Scout") or id.'),
    task: p.text("What the recipient should do, including the expected result."),
    context: p.optional(p.string("Background, file paths in the shared workspace, decisions so far.")),
  }),
  annotations: { title: "Hand off a task", destructiveHint: false, openWorldHint: false },
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const messaging = yield* Messaging
      const bots = yield* BotService
      const result = yield* messaging.handoffTask(ctx.tool, { to: args.to, task: args.task, context: args.context })
      const name = yield* bots.get(result.recipientBotId).pipe(
        Effect.map((bot) => `@${bot.name}`),
        Effect.orElseSucceed(() => args.to),
      )
      return textResult(
        result.noted === true
          ? notedText(name)
          : result.postedInGroup === true
            ? `Task handed off to ${name} in this group chat (delivery ${result.deliveryId}). They now own it and will report here.`
            : `Task handed off to ${name} (delivery ${result.deliveryId}). They now own it.`,
      )
    }),
})

const react = defineTool({
  name: "react",
  toolset: "bot",
  description:
    "React to a message with one emoji (e.g. 👍) instead of posting an acknowledgement. Defaults to the message you are answering (the newest message from someone else in this conversation). If a message needs no answer, react and then reply with exactly NO_REPLY.",
  params: p.params({
    emoji: p.text('One emoji, e.g. "👍", "✅" or "🎉".'),
    message_id: p.optional(p.text("Entry id of the message to react to. Omit for the message you are answering.")),
  }),
  annotations: { title: "React to a message", destructiveHint: false, openWorldHint: false, idempotentHint: true },
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const messaging = yield* Messaging
      const result = yield* messaging.react(ctx.tool, {
        emoji: args.emoji,
        messageId: args.message_id as EntryId | undefined,
      })
      return textResult(`Reacted ${result.emoji} to message ${result.entryId}.`)
    }),
})

const listBots = defineTool({
  name: "list_bots",
  toolset: "bot",
  description: "List the bots on your team (name, id, role, harness). Use the name with message_bot or handoff_task.",
  params: p.params({}),
  annotations: { title: "List bots", readOnlyHint: true, openWorldHint: false },
  idempotent: false,
  handler: (_args, ctx) =>
    Effect.gen(function* () {
      const bots = yield* (yield* BotService).list
      return linesResult(
        bots.map((bot) =>
          [
            `@${bot.name} (${bot.id})`,
            bot.label === undefined || bot.label === "" ? undefined : bot.label,
            `harness ${bot.harness.kind}${bot.harness.model === undefined ? "" : ` / ${bot.harness.model}`}`,
            bot.id === ctx.claims.botId ? "this is you" : undefined,
          ]
            .filter((part) => part !== undefined)
            .join(" — "),
        ),
        "No bots.",
      )
    }),
})

const HARNESS_KINDS = ["claude", "codex", "opencode", "fake"] as const

const normModel = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, " ")
    .trim()
const tokensOf = (s: string) =>
  new Set(
    normModel(s)
      .split(/[\s.]+/)
      .filter(Boolean),
  )

/**
 * Resolves a model the bot asked for to a real model id of the harness (account), so a guess like
 * "sol 6.1" becomes "gpt-6.1-sol". Exact id/label wins, then a unique match whose id or label contains
 * every requested token. Unknown/ambiguous → a refusal that lists the valid ids.
 */
export const resolveModelFor = (kind: string, profileId: string | undefined, requested: string) =>
  Effect.gen(function* () {
    const registry = yield* HarnessRegistry
    const driver = yield* registry.get(kind, profileId)
    const models = yield* driver.listModels.pipe(
      Effect.orElseSucceed(() => [] as ReadonlyArray<{ readonly id: string; readonly label: string }>),
    )
    if (models.length === 0) return requested
    const want = normModel(requested)
    const exact = models.find((m) => normModel(m.id) === want || normModel(m.label) === want)
    if (exact) return exact.id
    const wanted = tokensOf(requested)
    const matches = models.filter((m) => {
      const have = new Set([...tokensOf(m.id), ...tokensOf(m.label)])
      return [...wanted].every((t) => have.has(t))
    })
    if (matches.length === 1) return matches[0]!.id
    const list = models.map((m) => `${m.id}${m.label && m.label !== m.id ? ` (${m.label})` : ""}`).join(", ")
    return yield* Effect.fail(
      new ToolRefusal({
        message: `${matches.length > 1 ? `"${requested}" is ambiguous` : `Unknown ${driver.displayName} model "${requested}"`}. Valid model ids: ${list}. Use list_models, then pass an exact id.`,
      }),
    )
  })

const listModels = defineTool({
  name: "list_models",
  toolset: "bot",
  description:
    "List the real model ids (and labels, effort levels) a harness offers, so you can pick a valid `model` for create_bot / update_bot. Defaults to your own harness and account.",
  params: p.params({
    harness: p.optional(p.literals(HARNESS_KINDS, "claude, codex, opencode or fake. Default: your harness.")),
  }),
  annotations: { title: "List models", readOnlyHint: true, openWorldHint: false },
  idempotent: false,
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const self = yield* (yield* BotService).get(ctx.claims.botId)
      const kind = args.harness ?? self.harness.kind
      const registry = yield* HarnessRegistry
      const driver = yield* registry.get(kind, kind === self.harness.kind ? self.harness.profileId : undefined)
      const models = yield* driver.listModels
      return linesResult(
        models.map((m) =>
          [
            `${m.id}`,
            m.label && m.label !== m.id ? m.label : undefined,
            m.default ? "default" : undefined,
            m.efforts?.length ? `efforts: ${m.efforts.join("/")}` : undefined,
          ]
            .filter((x) => x !== undefined)
            .join(" — "),
        ),
        `${driver.displayName} reported no models.`,
      )
    }),
})

const createBot = defineTool({
  name: "create_bot",
  toolset: "bot",
  description:
    "Create a new bot (teammate) on the user's team. It gets its own chat, workspace and memory, and is immediately reachable with message_bot / handoff_task. By default it uses the same harness and computer as you. Give it a clear job in `instructions` (its persona and responsibilities). Returns the new bot's name and id.",
  params: p.params({
    name: p.text('Display name, unique on the team (e.g. "Research Scout"). Max 64 characters.'),
    label: p.optional(p.string('Short role chip shown under the name, e.g. "Research" or "Ops".')),
    instructions: p.optional(
      p.string("The bot's job: who it is, what it is responsible for, how it should work and report back."),
    ),
    harness: p.optional(
      p.literals(
        HARNESS_KINDS,
        "Which AI harness runs the bot: claude, codex, opencode, or fake (offline demo). Default: the same as yours.",
      ),
    ),
    model: p.optional(
      p.string(
        'Model id from list_models (a close name like "sol 6.1" is resolved to the real id). Omit to use the harness default, or your own model when using your harness.',
      ),
    ),
    effort: p.optional(
      p.string(
        "Reasoning effort, e.g. low | medium | high. Omit for the default (yours when using your harness and model).",
      ),
    ),
    host_node: p.optional(p.string("Node (computer) id where its tools run. Default: your host node. See list_nodes.")),
  }),
  annotations: { title: "Create a bot", destructiveHint: false, openWorldHint: false },
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const bots = yield* BotService
      const self = yield* bots.get(ctx.claims.botId)
      const sameHarness = args.harness === undefined || args.harness === self.harness.kind
      const kind = args.harness ?? self.harness.kind
      const model =
        args.model === undefined || args.model.trim() === ""
          ? undefined
          : yield* resolveModelFor(kind, sameHarness ? self.harness.profileId : undefined, args.model.trim())
      const bot = yield* bots.create(
        {
          name: args.name.trim(),
          ...(args.label === undefined || args.label.trim() === "" ? {} : { label: args.label.trim() }),
          ...(args.instructions === undefined ? {} : { instructions: args.instructions }),
          harness: {
            kind: args.harness ?? self.harness.kind,
            ...(model !== undefined
              ? { model }
              : sameHarness && self.harness.model !== undefined
                ? { model: self.harness.model }
                : {}),
            ...(args.effort !== undefined
              ? { effort: args.effort }
              : sameHarness && model === undefined && self.harness.effort !== undefined
                ? { effort: self.harness.effort }
                : {}),
            ...(sameHarness && self.harness.profileId !== undefined ? { profileId: self.harness.profileId } : {}),
          },
          hostNodeId: (args.host_node ?? self.hostNodeId) as NodeId,
          clientNonce: `tool:${ctx.claims.botId}:${ctx.tool.callId ?? `${args.name}:${Date.now()}`}`,
          // Autonomy is the owner's call: a bot-created bot gets the owner's default for new bots
          // (Settings), never more than its creator (the tool takes no autonomy argument).
        },
        { autonomyCeiling: self.autonomy },
      )
      return textResult(
        `Created @${bot.name} (${bot.id}) — harness ${bot.harness.kind}${bot.harness.model === undefined ? "" : ` / ${bot.harness.model}`}. It is on the team now; brief it with message_bot or give it work with handoff_task.`,
      )
    }),
})

const updateBot = defineTool({
  name: "update_bot",
  toolset: "bot",
  description:
    "Update another bot's (or your own) name, label, instructions, model, effort or sidebar pin. Use it to refine the job of a bot you created or fix its model. Only the fields you pass change.",
  params: p.params({
    bot: p.text('The bot to update: its name (e.g. "@Scout") or id.'),
    name: p.optional(p.string("New display name.")),
    label: p.optional(p.string("New role chip (empty string clears it).")),
    instructions: p.optional(p.string("Replacement instructions (the full new text, not a diff).")),
    model: p.optional(
      p.string("New harness-native model id (empty string = harness default). Starts a new session for that bot."),
    ),
    effort: p.optional(p.string("New reasoning effort, e.g. low | medium | high (empty string = default).")),
    pinned: p.optional(p.boolean("Pin (true) or unpin (false) the bot at the top of the owner's sidebar.")),
  }),
  annotations: { title: "Update a bot", destructiveHint: false, openWorldHint: false },
  handler: (args, _ctx) =>
    Effect.gen(function* () {
      const bots = yield* BotService
      const target = yield* bots.resolve(args.bot)
      if (
        args.name === undefined &&
        args.label === undefined &&
        args.instructions === undefined &&
        args.model === undefined &&
        args.effort === undefined &&
        args.pinned === undefined
      ) {
        return yield* Effect.fail(
          new ToolRefusal({
            message: "Nothing to update: pass name, label, instructions, model, effort and/or pinned.",
          }),
        )
      }
      const resolvedModel =
        args.model === undefined || args.model.trim() === ""
          ? args.model
          : yield* resolveModelFor(target.harness.kind, target.harness.profileId, args.model.trim())
      const harnessChange = resolvedModel !== undefined || args.effort !== undefined
      const { model: _m, effort: _e, ...keep } = target.harness
      const harness = harnessChange
        ? {
            ...keep,
            ...((resolvedModel ?? target.harness.model ?? "") === ""
              ? {}
              : { model: resolvedModel ?? target.harness.model }),
            ...((args.effort ?? target.harness.effort ?? "") === ""
              ? {}
              : { effort: args.effort ?? target.harness.effort }),
          }
        : undefined
      const bot = yield* bots.update(target.id, {
        ...(harness === undefined ? {} : { harness }),
        ...(args.name === undefined ? {} : { name: args.name.trim() }),
        ...(args.label === undefined ? {} : { label: args.label.trim() === "" ? null : args.label.trim() }),
        ...(args.instructions === undefined ? {} : { instructions: args.instructions }),
        ...(args.pinned === undefined ? {} : { pinned: args.pinned }),
      })
      return textResult(`Updated @${bot.name} (${bot.id}).`)
    }),
})

// ============================================================================ sidebar sections

/** Finds a section by id or (case-insensitive) name. */
const findSection = (sections: ReadonlyArray<Section>, ref: string): Section | undefined => {
  const key = ref.trim().toLowerCase()
  return sections.find((s) => s.id === ref.trim()) ?? sections.find((s) => s.name.toLowerCase() === key)
}

const UNASSIGNED = new Set(["", "none", "unassigned", "no section"])

const listSections = defineTool({
  name: "list_sections",
  toolset: "bot",
  description:
    "List the sections that organize bots in the owner's sidebar, with the bots in each (and the unassigned ones).",
  params: p.params({}),
  annotations: { title: "List sidebar sections", readOnlyHint: true, openWorldHint: false },
  idempotent: false,
  handler: () =>
    Effect.gen(function* () {
      const service = yield* BotService
      const sections = [...(yield* service.listSections)].sort((a, b) => a.order - b.order)
      const bots = (yield* service.list).filter((b) => !b.hidden)
      const names = (ids: ReadonlyArray<string>) => (ids.length === 0 ? "(empty)" : ids.join(", "))
      const lines = sections.map(
        (s) => `${s.name} (${s.id}): ${names(bots.filter((b) => b.sectionId === s.id).map((b) => `@${b.name}`))}`,
      )
      const known = new Set(sections.map((s) => s.id as string))
      const unassigned = bots
        .filter((b) => b.sectionId === undefined || !known.has(b.sectionId))
        .map((b) => `@${b.name}`)
      return linesResult([...lines, `Unassigned: ${names(unassigned)}`], "No sections.")
    }),
})

const createSection = defineTool({
  name: "create_section",
  toolset: "bot",
  description:
    'Create a section in the owner\'s sidebar to group bots (e.g. "Engineering"). Use move_bot_to_section to put bots in it.',
  params: p.params({ name: p.text("Section name, max 64 characters.") }),
  annotations: { title: "Create a sidebar section", destructiveHint: false, openWorldHint: false },
  handler: (args) =>
    Effect.gen(function* () {
      const service = yield* BotService
      const existing = findSection(yield* service.listSections, args.name)
      if (existing !== undefined) return textResult(`Section "${existing.name}" (${existing.id}) already exists.`)
      const section = yield* service.createSection(args.name.trim())
      return textResult(`Created section "${section.name}" (${section.id}).`)
    }),
})

const renameSection = defineTool({
  name: "rename_section",
  toolset: "bot",
  description: "Rename a section in the owner's sidebar.",
  params: p.params({
    section: p.text("The section's current name or id."),
    name: p.text("The new name."),
  }),
  annotations: { title: "Rename a sidebar section", destructiveHint: false, openWorldHint: false },
  handler: (args) =>
    Effect.gen(function* () {
      const service = yield* BotService
      const section = findSection(yield* service.listSections, args.section)
      if (section === undefined)
        return yield* Effect.fail(new ToolRefusal({ message: `No section "${args.section}". Use list_sections.` }))
      const renamed = yield* service.renameSection(section.id, args.name.trim())
      return textResult(`Renamed section "${section.name}" to "${renamed.name}".`)
    }),
})

const deleteSection = defineTool({
  name: "delete_section",
  toolset: "bot",
  description: "Delete a section from the owner's sidebar. Its bots are not deleted; they become unassigned.",
  params: p.params({ section: p.text("The section's name or id.") }),
  annotations: { title: "Delete a sidebar section", destructiveHint: false, openWorldHint: false },
  handler: (args) =>
    Effect.gen(function* () {
      const service = yield* BotService
      const section = findSection(yield* service.listSections, args.section)
      if (section === undefined)
        return yield* Effect.fail(new ToolRefusal({ message: `No section "${args.section}". Use list_sections.` }))
      yield* service.deleteSection(section.id)
      return textResult(`Deleted section "${section.name}"; its bots are now unassigned.`)
    }),
})

const moveBotToSection = defineTool({
  name: "move_bot_to_section",
  toolset: "bot",
  description:
    'Move a bot (or yourself) into a section of the owner\'s sidebar. The section is created if it does not exist. Pass section "none" to make the bot unassigned.',
  params: p.params({
    bot: p.text('The bot: its name (e.g. "@Scout") or id.'),
    section: p.text('Section name or id; created when missing. "none" = unassigned.'),
  }),
  annotations: { title: "Move a bot to a section", destructiveHint: false, openWorldHint: false },
  handler: (args) =>
    Effect.gen(function* () {
      const service = yield* BotService
      const bot = yield* service.resolve(args.bot)
      if (UNASSIGNED.has(args.section.trim().toLowerCase())) {
        yield* service.update(bot.id, { sectionId: null, pinned: false })
        return textResult(`@${bot.name} is now unassigned.`)
      }
      const section =
        findSection(yield* service.listSections, args.section) ?? (yield* service.createSection(args.section.trim()))
      yield* service.update(bot.id, { sectionId: section.id, pinned: false })
      return textResult(`Moved @${bot.name} to section "${section.name}".`)
    }),
})

// ============================================================================ questions & approvals (D3.3)

/** Appended to every async ask (`ask_user`, `request_approval`, `request_takeover`). */
export const PENDING_HINT =
  "Do not wait for it: end your turn now. The owner already sees the card, so do not announce or repeat it; with nothing else to add, reply exactly NO_REPLY. The answer will arrive as a new message in this conversation."

const askUser = defineTool({
  name: "ask_user",
  toolset: "bot",
  description:
    "Ask the user one or more questions with a question card. Returns immediately with status pending; the answer arrives later as a new message. End your turn after calling it.",
  params: p.params({
    title: p.optional(p.string("Short card title.")),
    questions: p.array(
      p.object({
        id: p.optional(p.text("Stable id for the answer (default q1, q2, …).")),
        prompt: p.text("The question."),
        options: p.optional(
          p.array(
            p.object({
              label: p.text("Option text."),
              description: p.optional(p.string("Extra explanation.")),
            }),
            "Choices to offer (omit for a free-text answer).",
          ),
        ),
        multi_select: p.optional(p.boolean("Allow picking several options (default false).")),
        allow_free_text: p.optional(p.boolean("Allow a typed answer besides the options (default true).")),
      }),
      "The questions (at least one).",
      { minItems: 1, maxItems: 8 },
    ),
  }),
  annotations: { title: "Ask the user", destructiveHint: false, openWorldHint: false },
  // A background task cannot ask (D5.7): it says what it needs in its result.
  available: notInTask,
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const approvals = yield* ApprovalService
      const questions = yield* Effect.forEach(args.questions, (q, i) =>
        decodeOrRefuse(
          Question,
          {
            id: q.id ?? `q${i + 1}`,
            prompt: q.prompt,
            options: (q.options ?? []).map((o) =>
              o.description === undefined ? { label: o.label } : { label: o.label, description: o.description },
            ),
            multiSelect: q.multi_select ?? false,
            allowFreeText: q.allow_free_text ?? true,
          },
          `question ${i + 1}`,
        ),
      )
      const receipt = yield* approvals.askUser(ctx.tool, { title: args.title, questions })
      return textResult(`status: pending\nrequestId: ${receipt.requestId}\n${PENDING_HINT}`)
    }),
})

const requestApproval = defineTool({
  name: "request_approval",
  toolset: "bot",
  description:
    "Ask the user to approve an action before you take it (an approval card with Allow / Deny). Returns immediately with status pending; the decision arrives later as a new message. End your turn after calling it.",
  params: p.params({
    title: p.text("What you want to do, in one line."),
    detail: p.optional(p.string("Why, risks, and what happens next.")),
    command: p.optional(p.string("The command you intend to run, if any.")),
    paths: p.optional(p.array(p.string(), "Files the action touches, if any.")),
  }),
  annotations: { title: "Request approval", destructiveHint: false, openWorldHint: false },
  available: notInTask,
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const approvals = yield* ApprovalService
      const receipt = yield* approvals.requestApproval(ctx.tool, {
        title: args.title,
        detail: args.detail,
        command: args.command,
        paths: args.paths,
      })
      return textResult(`status: pending\nrequestId: ${receipt.requestId}\n${PENDING_HINT}`)
    }),
})

const notifyUser = defineTool({
  name: "notify_user",
  toolset: "bot",
  description: "Send the user a notification (does not wait for an answer). Use for finished work or important news.",
  params: p.params({
    text: p.text("The notification body."),
    title: p.optional(p.string("Short title (default: your name).")),
  }),
  annotations: { title: "Notify the user", destructiveHint: false, openWorldHint: false },
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const notifier = yield* Notifier
      const bots = yield* BotService
      const title =
        args.title ??
        (yield* bots.get(ctx.claims.botId).pipe(
          Effect.map((bot) => bot.name),
          Effect.orElseSucceed(() => "Your bot"),
        ))
      const sent = yield* notifier.notify({
        kind: "message",
        botId: ctx.claims.botId,
        conversationId: ctx.claims.conversationId,
        title,
        body: args.text,
      })
      return textResult(
        sent === undefined
          ? "Not delivered: the user muted notifications for you. Put the information in your reply instead."
          : `Notification sent (${sent.id}).`,
      )
    }),
})

// ============================================================================ memory (D5.4)

const remember = defineTool({
  name: "remember",
  toolset: "bot",
  description:
    "Save a fact to your long-term memory (one file per fact plus a line in MEMORY.md). Saving with an existing id or title updates that fact.",
  params: p.params({
    title: p.text('Short title, e.g. "Prefers dark mode".'),
    body: p.string("The fact, with enough context to be useful later."),
    description: p.optional(p.string("One-line hook shown in the memory index.")),
    id: p.optional(p.text("Existing fact id to update (lower-case slug). Default: derived from the title.")),
  }),
  annotations: { title: "Remember", destructiveHint: false, openWorldHint: false },
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const memory = yield* MemoryService
      const input = yield* decodeOrRefuse(
        MemoryFactInput,
        {
          title: args.title,
          body: args.body,
          ...(args.description === undefined ? {} : { description: args.description }),
          ...(args.id === undefined ? {} : { id: args.id }),
        },
        "memory fact",
      )
      const fact = yield* memory.putFact(botActor(ctx.tool), ctx.claims.botId, input)
      return textResult(`Saved memory "${fact.title}" (id ${fact.id}).`)
    }),
})

const forget = defineTool({
  name: "forget",
  toolset: "bot",
  description: "Delete a fact from your long-term memory by id (see recall_memory for ids).",
  params: p.params({ id: p.text("Fact id.") }),
  annotations: { title: "Forget", destructiveHint: true, openWorldHint: false },
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const memory = yield* MemoryService
      const id = yield* decodeOrRefuse(MemoryFactId, args.id, "fact id")
      yield* memory.deleteFact(botActor(ctx.tool), ctx.claims.botId, id)
      return textResult(`Forgot memory ${id}.`)
    }),
})

const recallMemory = defineTool({
  name: "recall_memory",
  toolset: "bot",
  description:
    "Search your long-term memory. Returns the facts whose title, description or body contains the query (all facts when omitted).",
  params: p.params({ query: p.optional(p.string("Case-insensitive search text.")) }),
  annotations: { title: "Recall memory", readOnlyHint: true, openWorldHint: false },
  idempotent: false,
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const memory = yield* MemoryService
      const query = args.query === undefined || args.query.trim() === "" ? undefined : args.query
      const facts = yield* memory.recall(ctx.claims.botId, query)
      return linesResult(
        facts.map(
          (fact) =>
            `## ${fact.title} (id ${fact.id})${fact.description === undefined ? "" : `\n${fact.description}`}\n${fact.body}`,
        ),
        query === undefined ? "Your memory is empty." : `No memory matches "${query}".`,
      )
    }),
})

// ============================================================================ routines (D5.3)

const triggerFields = {
  schedule: p.literals(
    ["cron", "interval", "once", "manual", "slack"],
    "cron: a 5-field cron expression in `cron` (+ `timezone`). interval: every `every_minutes` (≥ 5). once: at the time in `at`. manual: only when run by hand. slack: when a Slack message arrives (`slack_on`; only while the owner's Slack is connected); the run reads the messages after the prompt.",
  ),
  cron: p.optional(p.string('5-field cron expression, e.g. "0 9 * * 1-5" (schedule=cron).')),
  timezone: p.optional(p.string('IANA timezone for cron, e.g. "Europe/Berlin" (default UTC).')),
  every_minutes: p.optional(p.number("Interval in minutes, at least 5 (schedule=interval).", { integer: true })),
  at: p.optional(p.string('ISO 8601 date-time for schedule=once, e.g. "2026-11-01T09:00:00Z".')),
  slack_on: p.optional(
    p.literals(
      ["dm", "mention", "phrase", "message"],
      "schedule=slack: dm (someone writes to the owner directly), mention (someone @mentions them), phrase (a message contains `slack_phrase`), message (every message in `slack_channel`).",
    ),
  ),
  slack_phrase: p.optional(p.string("schedule=slack, slack_on=phrase: the words to look for (any case).")),
  slack_channel: p.optional(
    p.string("schedule=slack: only in this channel (#name or id); required for slack_on=message."),
  ),
}

interface TriggerArgs {
  readonly schedule?: "cron" | "interval" | "once" | "manual" | "slack" | undefined
  readonly cron?: string | undefined
  readonly timezone?: string | undefined
  readonly every_minutes?: number | undefined
  readonly at?: string | undefined
  readonly slack_on?: "dm" | "mention" | "phrase" | "message" | undefined
  readonly slack_phrase?: string | undefined
  readonly slack_channel?: string | undefined
}

const parseAt = (at: string): Effect.Effect<number, ToolRefusal> => {
  const ms = /^\d+$/.test(at.trim()) ? Number(at.trim()) : Date.parse(at)
  return Number.isFinite(ms)
    ? Effect.succeed(ms)
    : Effect.fail(new ToolRefusal({ message: `\`at\` must be an ISO 8601 date-time, got "${at}"` }))
}

/** Builds a trigger from tool args, falling back to the fields of `current` when it has the same type. */
const buildTrigger = (args: TriggerArgs, current: RoutineTrigger | undefined): Effect.Effect<unknown, ToolRefusal> =>
  Effect.gen(function* () {
    const type = args.schedule ?? current?.type
    if (type === undefined) return yield* new ToolRefusal({ message: "`schedule` is required" })
    const same = current !== undefined && current.type === type ? current : undefined
    switch (type) {
      case "cron": {
        const schedule = args.cron ?? (same?.type === "cron" ? same.schedule : undefined)
        if (schedule === undefined)
          return yield* new ToolRefusal({ message: "`cron` is required when schedule is cron" })
        return { type: "cron", schedule, timezone: args.timezone ?? (same?.type === "cron" ? same.timezone : "UTC") }
      }
      case "interval": {
        const everyMinutes = args.every_minutes ?? (same?.type === "interval" ? same.everyMinutes : undefined)
        if (everyMinutes === undefined) {
          return yield* new ToolRefusal({ message: "`every_minutes` is required when schedule is interval" })
        }
        return { type: "interval", everyMinutes }
      }
      case "once": {
        if (args.at !== undefined) return { type: "once", at: yield* parseAt(args.at) }
        if (same?.type === "once") return { type: "once", at: same.at }
        return yield* new ToolRefusal({ message: "`at` is required when schedule is once" })
      }
      case "manual":
        return { type: "manual" }
      case "slack": {
        const on = args.slack_on ?? (same?.type === "slack" ? same.on : undefined)
        if (on === undefined)
          return yield* new ToolRefusal({ message: "`slack_on` is required when schedule is slack" })
        const phrase = args.slack_phrase ?? (same?.type === "slack" ? same.phrase : undefined)
        const channel = args.slack_channel ?? (same?.type === "slack" ? same.channel : undefined)
        return {
          type: "slack",
          on,
          ...(phrase === undefined || phrase.trim() === "" ? {} : { phrase: phrase.trim() }),
          ...(channel === undefined || channel.trim() === "" ? {} : { channel: channel.trim() }),
        }
      }
      default:
        return yield* new ToolRefusal({ message: `Routines with a ${type} trigger cannot be edited by a bot` })
    }
  })

const describeTrigger = (trigger: RoutineTrigger): string => {
  switch (trigger.type) {
    case "cron":
      return `cron "${trigger.schedule}" (${trigger.timezone})`
    case "interval":
      return `every ${trigger.everyMinutes} min`
    case "once":
      return `once at ${isoTime(trigger.at)}`
    case "manual":
      return "manual"
    case "slack":
      return `slack ${trigger.on}${trigger.phrase === undefined ? "" : ` "${trigger.phrase}"`}${trigger.channel === undefined ? "" : ` in ${trigger.channel}`}`
    case "webhook":
      return "webhook"
  }
}

const describeRoutine = (routine: Routine): string =>
  [
    `${routine.name} (${routine.id})`,
    describeTrigger(routine.trigger),
    routine.enabled ? "active" : "paused",
    routine.nextRunAt === undefined ? undefined : `next run ${isoTime(routine.nextRunAt)}`,
    routine.lastRunAt === undefined
      ? undefined
      : `last run ${isoTime(routine.lastRunAt)} (${routine.lastRunStatus ?? "?"})`,
  ]
    .filter((part) => part !== undefined)
    .join(" — ")

const outputParam = p.literals(
  ["direct", "own-conversation"],
  "Where runs post: direct (your chat with the user, default) or own-conversation (a new conversation per run).",
)

const createRoutine = defineTool({
  name: "create_routine",
  toolset: "bot",
  description:
    "Create a routine for yourself: a prompt that is delivered to you on a schedule (cron, interval, once or manual) or when a Slack message arrives (slack). Each run posts into your chat. Returns the routine id.",
  params: p.params({
    name: p.text("Routine name."),
    prompt: p.text("The instruction you will receive on each run."),
    ...triggerFields,
    output: p.optional(outputParam),
    enabled: p.optional(p.boolean("Start active (default true).")),
  }),
  annotations: { title: "Create a routine", destructiveHint: false, openWorldHint: false },
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const scheduler = yield* RoutineScheduler
      const trigger = yield* buildTrigger(args, undefined)
      const spec = yield* decodeOrRefuse(
        RoutineSpec,
        {
          name: args.name,
          prompt: args.prompt,
          trigger,
          enabled: args.enabled ?? true,
          output: args.output ?? "direct",
        },
        "routine",
      )
      const routine = yield* scheduler.create(botActor(ctx.tool), { botId: ctx.claims.botId, spec })
      return textResult(`Created routine ${describeRoutine(routine)}.`)
    }),
})

const updateRoutine = defineTool({
  name: "update_routine",
  toolset: "bot",
  description:
    "Change one of your routines. Only the fields you pass change; pass `enabled: false` to pause it. See list_routines for ids.",
  params: p.params({
    routine_id: p.text("Routine id."),
    name: p.optional(p.text("New name.")),
    prompt: p.optional(p.text("New prompt.")),
    schedule: p.optional(triggerFields.schedule),
    cron: triggerFields.cron,
    timezone: triggerFields.timezone,
    every_minutes: triggerFields.every_minutes,
    at: triggerFields.at,
    slack_on: triggerFields.slack_on,
    slack_phrase: triggerFields.slack_phrase,
    slack_channel: triggerFields.slack_channel,
    output: p.optional(outputParam),
    enabled: p.optional(p.boolean("Active (true) or paused (false).")),
  }),
  annotations: { title: "Update a routine", destructiveHint: false, openWorldHint: false },
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const scheduler = yield* RoutineScheduler
      const current = yield* scheduler.get(args.routine_id as Routine["id"])
      if (current.botId !== ctx.claims.botId) {
        return yield* new ToolRefusal({ message: "You can only change your own routines" })
      }
      const triggerChanged =
        args.schedule !== undefined ||
        args.cron !== undefined ||
        args.timezone !== undefined ||
        args.every_minutes !== undefined ||
        args.at !== undefined ||
        args.slack_on !== undefined ||
        args.slack_phrase !== undefined ||
        args.slack_channel !== undefined
      const trigger = triggerChanged ? yield* buildTrigger(args, current.trigger) : current.trigger
      const spec = yield* decodeOrRefuse(
        RoutineSpec,
        {
          name: args.name ?? current.name,
          prompt: args.prompt ?? current.prompt,
          trigger,
          enabled: args.enabled ?? current.enabled,
          output: args.output ?? current.output,
        },
        "routine",
      )
      const routine = yield* scheduler.update(botActor(ctx.tool), { routineId: current.id, spec })
      return textResult(`Updated routine ${describeRoutine(routine)}.`)
    }),
})

const listRoutines = defineTool({
  name: "list_routines",
  toolset: "bot",
  description: "List your routines with their schedule, state and next run.",
  params: p.params({}),
  annotations: { title: "List routines", readOnlyHint: true, openWorldHint: false },
  idempotent: false,
  handler: (_args, ctx) =>
    Effect.gen(function* () {
      const routines = yield* (yield* RoutineScheduler).list({ botId: ctx.claims.botId })
      return linesResult(routines.map(describeRoutine), "You have no routines.")
    }),
})

// ============================================================================ skills (D5.5)

const saveSkill = defineTool({
  name: "save_skill",
  toolset: "bot",
  description:
    "Save a reusable skill (a SKILL.md: when to use it, and the instructions) to the skills library and give it to yourself. Saving the name of one of your skills updates it; a library skill you do not have cannot be replaced.",
  params: p.params({
    name: p.text('Lower-case slug, e.g. "weekly-report".'),
    description: p.text("When to use this skill (one or two sentences)."),
    body: p.text("The instructions, in markdown."),
  }),
  annotations: { title: "Save a skill", destructiveHint: false, openWorldHint: false },
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const skills = yield* SkillService
      const input = yield* decodeOrRefuse(SkillInput, args, "skill (name must be a lower-case slug)")
      const skill = yield* skills.upsert(botActor(ctx.tool), input)
      return textResult(`Saved skill ${skill.name}; you have it from your next message on.`)
    }),
})

const listSkills = defineTool({
  name: "list_skills",
  toolset: "bot",
  description:
    "List the skills library: each skill's name, when to use it, where it came from, and which Bots have it (you included).",
  params: p.params({}),
  annotations: { title: "List skills", readOnlyHint: true, openWorldHint: false },
  idempotent: false,
  handler: (_args, ctx) =>
    Effect.gen(function* () {
      const skills = yield* (yield* SkillService).list
      const team = yield* (yield* BotService).list
      return linesResult(
        skills.map((skill) => {
          const holders = team
            .filter((bot) => bot.skills.includes(skill.name))
            .map((bot) => (bot.id === ctx.tool.claims.botId ? "you" : `@${bot.name}`))
          const source = skill.source === undefined ? "written here" : `from skills.sh (${skill.source.id})`
          return `${skill.name} — ${skill.description} [${source}; ${holders.length === 0 ? "no Bot has it" : `has it: ${holders.join(", ")}`}]`
        }),
        "The skills library is empty.",
      )
    }),
})

/** How much of a skill's instructions `enable_skill` returns (results stay under ~10 KB, D1.6). */
const SKILL_RESULT_BYTES = 8 * 1024

/** The skill and the Bot a skill tool is about (`bot` absent: the caller). */
const skillTarget = (ctx: ToolCallContext, name: string, bot: string | undefined) =>
  Effect.gen(function* () {
    const bots = yield* BotService
    const skill = yield* (yield* SkillService)
      .get(name as SkillName)
      .pipe(
        Effect.catchTag(
          "NotFound",
          () => new ToolRefusal({ message: `There is no skill named "${name}" in the library (see list_skills).` }),
        ),
      )
    const target =
      bot === undefined || bot.trim() === ""
        ? yield* bots.get(ctx.tool.claims.botId).pipe(Effect.orDie)
        : yield* bots.resolve(bot)
    return { skill, target, self: target.id === ctx.tool.claims.botId }
  })

const enableSkill = defineTool({
  name: "enable_skill",
  toolset: "bot",
  description:
    "Ask the owner to give you (or a teammate) a skill from the library. Waits for their answer on an approval card; the skill works from the Bot's next message on.",
  params: p.params({
    name: p.text("The skill's name, from list_skills."),
    bot: p.optional(p.text("A teammate to give it to (name or id). Omit for yourself.")),
  }),
  annotations: { title: "Turn on a skill", destructiveHint: false, openWorldHint: false },
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const { skill, target, self } = yield* skillTarget(ctx, args.name, args.bot)
      if (target.skills.includes(skill.name))
        return textResult(`${self ? "You already have" : `@${target.name} already has`} ${skill.name}.`)
      yield* approve(
        ctx,
        {
          kind: "mcp-approval",
          toolName: "enable_skill",
          server: "openbot",
          surface: "skills",
          title: self ? `Use the skill “${skill.name}”` : `Give @${target.name} the skill “${skill.name}”`,
          detail: skill.description,
          input: { name: skill.name, bot: target.name },
        },
        `the skill ${skill.name}`,
      )
      // re-read: the Bot's skills may have changed while the card was open
      const fresh = yield* (yield* BotService).get(target.id)
      if (!fresh.skills.includes(skill.name))
        yield* (yield* BotService).update(target.id, { skills: [...fresh.skills, skill.name] })
      if (!self) return textResult(`@${target.name} has ${skill.name} now, from its next message on.`)
      // it loads natively from the next turn; its instructions come along so it can be used right away
      return textResult(
        `You have ${skill.name} now; from your next message on it loads like your other skills. Its instructions, to use it right away:\n\n${
          capText(skill.body, SKILL_RESULT_BYTES).text
        }`,
      )
    }),
})

const disableSkill = defineTool({
  name: "disable_skill",
  toolset: "bot",
  description:
    "Drop a skill you no longer need (no approval needed), or ask the owner to take one from a teammate (approval card).",
  params: p.params({
    name: p.text("The skill's name."),
    bot: p.optional(p.text("A teammate to take it from (name or id). Omit for yourself.")),
  }),
  annotations: { title: "Turn off a skill", destructiveHint: true, openWorldHint: false },
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const { skill, target, self } = yield* skillTarget(ctx, args.name, args.bot)
      if (!target.skills.includes(skill.name))
        return textResult(`${self ? "You do not have" : `@${target.name} does not have`} ${skill.name}.`)
      if (!self) {
        yield* approve(
          ctx,
          {
            kind: "mcp-approval",
            toolName: "disable_skill",
            server: "openbot",
            surface: "skills",
            title: `Take the skill “${skill.name}” from @${target.name}`,
            detail: skill.description,
            input: { name: skill.name, bot: target.name },
          },
          `taking ${skill.name} from @${target.name}`,
        )
      }
      const fresh = yield* (yield* BotService).get(target.id)
      yield* (yield* BotService).update(target.id, { skills: fresh.skills.filter((n) => n !== skill.name) })
      return textResult(`${self ? "You no longer have" : `@${target.name} no longer has`} ${skill.name}.`)
    }),
})

// ---------------------------------------------------------------------------- skills.sh (D5.5)

const formatInstalls = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n))

const findSkills = defineTool({
  name: "find_skills",
  toolset: "bot",
  description:
    "Search skills.sh, the public catalog of agent skills, for skills on a topic. Returns ids (owner/repo/skill) with install counts, most installed first. Read one with preview_skill before suggesting it.",
  params: p.params({
    query: p.text('What the skill is about, e.g. "react" or "pdf forms".'),
  }),
  annotations: { title: "Find skills", readOnlyHint: true, openWorldHint: true },
  idempotent: false,
  handler: (args) =>
    Effect.gen(function* () {
      const skills = yield* SkillService
      const found = yield* skills.search(args.query)
      const library = new Set(
        (yield* skills.list).flatMap((skill) => (skill.source === undefined ? [] : [skill.source.id])),
      )
      return linesResult(
        found.map(
          (hit) =>
            `${hit.id} — ${formatInstalls(hit.installs)} installs${library.has(hit.id) ? " (already in the library)" : ""}`,
        ),
        `No skills on skills.sh match "${args.query}".`,
      )
    }),
})

const previewSkill = defineTool({
  name: "preview_skill",
  toolset: "bot",
  description:
    "Read a skills.sh skill before installing it: its description, instructions and files. Nothing is installed.",
  params: p.params({
    id: p.text("The skill's id from find_skills: owner/repo/skill."),
  }),
  annotations: { title: "Preview a skill", readOnlyHint: true, openWorldHint: true },
  idempotent: false,
  handler: (args) =>
    Effect.gen(function* () {
      const preview = yield* (yield* SkillService).preview(args.id)
      const files = preview.files.map((file) => `- ${file.path} (${formatBytes(file.bytes)})`).join("\n")
      return textResult(
        [
          `${preview.name} (${preview.id})${preview.replaces ? " — the library already has a skill with this name; installing replaces it" : ""}`,
          `When to use it: ${preview.description}`,
          `Files:\n${files}`,
          `SKILL.md:\n${capText(preview.body, SKILL_RESULT_BYTES).text}`,
        ].join("\n\n"),
      )
    }),
})

/** A failed install as a refusal that says what to do next (never a manual copy). */
const installFailed = (error: { readonly _tag: string; readonly message?: string }) =>
  new ToolRefusal({
    message: `${(error._tag === "NotFound" ? "skills.sh has no such skill" : (error.message ?? "The install failed")).replace(/\.$/, "")}. Tell the owner; do not install it another way (copied files are not loaded).`,
  })

const installSkill = defineTool({
  name: "install_skill",
  toolset: "bot",
  description:
    "Install a skill from skills.sh into the library and give it to Bots (default: you). Waits for the owner's approval on a card that shows the skill and who gets it.",
  params: p.params({
    id: p.text("The skill's id: owner/repo/skill."),
    bots: p.optional(p.array(p.text(), "Who gets it: Bot names or ids (omit for yourself).", { maxItems: 20 })),
  }),
  annotations: { title: "Install a skill", destructiveHint: false, openWorldHint: true },
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const skills = yield* SkillService
      const bots = yield* BotService
      const targets =
        args.bots === undefined || args.bots.length === 0
          ? [yield* bots.get(ctx.tool.claims.botId).pipe(Effect.orDie)]
          : yield* Effect.forEach(args.bots, (ref) => bots.resolve(ref))
      const preview = yield* skills.preview(args.id).pipe(Effect.mapError(installFailed))
      const who = targets.map((bot) => (bot.id === ctx.tool.claims.botId ? "you" : `@${bot.name}`)).join(", ")
      yield* approve(
        ctx,
        {
          kind: "mcp-approval",
          toolName: "install_skill",
          server: "openbot",
          surface: "skills",
          title: `Install the skill “${preview.name}” from skills.sh for ${targets.map((bot) => bot.name).join(", ")}`,
          detail: `${preview.description}\n\n${preview.id} · ${preview.files.length} file${preview.files.length === 1 ? "" : "s"}${
            preview.replaces ? " · replaces the library's skill with this name" : ""
          }`,
          input: { id: preview.id, bots: targets.map((bot) => bot.name) },
        },
        `installing ${preview.name}`,
      )
      const installed = yield* skills
        .install(
          preview.id,
          targets.map((bot) => bot.id),
        )
        .pipe(Effect.mapError(installFailed))
      const forSelf = targets.some((bot) => bot.id === ctx.tool.claims.botId)
      return textResult(
        `Installed ${installed.name} for ${who}; it loads from the next message on.${
          forSelf
            ? ` Its instructions, to use it right away:\n\n${capText(installed.body, SKILL_RESULT_BYTES).text}`
            : ""
        }`,
      )
    }),
})

// ============================================================================ nodes

/** One line per node, as shown by `list_nodes`. */
export const describeNode = (node: NodeSummary, hostNodeId: string): string =>
  [
    `${node.label} (${node.id})`,
    node.id === hostNodeId ? "your host node (default for node tools)" : undefined,
    node.status,
    `${node.platform}${node.hostname === "" ? "" : ` · ${node.hostname}`}`,
    node.capabilities.length === 0 ? "no capabilities" : `capabilities ${node.capabilities.join(", ")}`,
  ]
    .filter((part) => part !== undefined)
    .join(" — ")

const listNodes = defineTool({
  name: "list_nodes",
  toolset: "bot",
  description:
    "List the computers (nodes) you can use: your host node and any other bound nodes, with status and capabilities. Pass a node id as `node` to the node tools to target it.",
  params: p.params({}),
  annotations: { title: "List nodes", readOnlyHint: true, openWorldHint: false },
  idempotent: false,
  handler: (_args, ctx) =>
    Effect.gen(function* () {
      const nodes = yield* (yield* NodeDirectory).list
      const allowed = new Set<string>([ctx.claims.hostNodeId, ...ctx.claims.boundNodeIds])
      const visible = nodes.filter((node) => allowed.has(node.id))
      visible.sort((a, b) => (a.id === ctx.claims.hostNodeId ? -1 : b.id === ctx.claims.hostNodeId ? 1 : 0))
      return linesResult(
        visible.map((node) => describeNode(node, ctx.claims.hostNodeId)),
        "No nodes are available to you.",
      )
    }),
})

// ============================================================================ files

const sendFile = defineTool({
  name: "send_file",
  toolset: "bot",
  description:
    "Send a file you produced — an image, video, audio clip, PDF, archive or any document — to the owner, or with `to` to another Bot. Without `to` it is posted in this conversation as your message: images show inline, videos and audio play in the chat, other files get a download card. Use it instead of printing a path: nobody can open paths on your computer. With `to` = a Bot's name, the files go to that Bot (in this group chat when it is a member, else to its own chat) and it is woken with them; they are copied into its workspace (`inbox/…`). `to` may also be a group chat id you are in. `path` is relative to your workspace (or absolute, or ~/…); `paths` sends several files (up to 10) in one message; `caption` is shown with them. Large files are fine (default limit 200 MB each); archive a directory first (zip/tar). Your reply can still follow.",
  params: p.params({
    path: p.optional(p.text("The file to send: relative to your workspace, absolute, or ~/… on the node.")),
    paths: p.optional(
      p.array(p.text(), "Several files to send in one message (instead of `path`), at most 10.", {
        minItems: 1,
        maxItems: 10,
      }),
    ),
    caption: p.optional(p.string("Text shown with the file(s), e.g. what it is.")),
    node: p.optional(p.text("Node id or name the file is on (see list_nodes). Default: your host node.")),
    to: p.optional(
      p.text(
        'Send to another Bot instead (its name, e.g. "@Scout", or id), or to a group chat id you are in. Default: the owner, in this conversation.',
      ),
    ),
  }),
  annotations: { title: "Send a file", destructiveHint: false, openWorldHint: false },
  handler: (args, ctx) =>
    Effect.gen(function* () {
      const paths = [...(args.path === undefined ? [] : [args.path]), ...(args.paths ?? [])]
      if (paths.length === 0) {
        return yield* new ToolRefusal({
          message: 'Pass `path` (or `paths`): the file(s) to send, e.g. {"path": "output/demo.mp4"}.',
        })
      }
      const target = yield* chooseNode(ctx, args.node, "fs")
      const result = yield* (yield* Messaging).sendFiles(ctx.tool, {
        nodeId: target.nodeId,
        inv: target.inv,
        cwd: target.workspace,
        paths,
        caption: args.caption,
        to: args.to,
        progress: ctx.progress,
      })
      const files = result.files
        .map(
          ({ attachment }) =>
            `${attachment.name} (${attachment.byteSize === undefined ? "" : `${formatBytes(attachment.byteSize)}, `}${attachment.mime})`,
        )
        .join(", ")
      if (result.replayed === true)
        return textResult(`Already sent: ${files} (message ${result.entryId}). Nothing was sent again.`)
      const recipient =
        result.recipientBotId === undefined
          ? undefined
          : yield* (yield* BotService).get(result.recipientBotId).pipe(
              Effect.map((bot) => `@${bot.name}`),
              Effect.orElseSucceed(() => "the Bot"),
            )
      return textResult(
        recipient !== undefined
          ? `Sent ${files} to ${recipient} ${result.destination === "group" ? "in this group chat" : "in their chat"} (message ${result.entryId}). They are woken with the files, which are copied into their workspace (inbox/…).`
          : result.destination === "group"
            ? `Posted ${files} in the group chat ${result.conversationId} (message ${result.entryId}).`
            : `Sent ${files} to the owner in this conversation (message ${result.entryId}). They can open it in the chat now; don't repeat the file path in your reply.`,
      )
    }),
})

/** Every bot tool, in the order they are listed. */
export const BotToolkit: ReadonlyArray<AnyTool<BotToolkitServices>> = [
  messageBot,
  postToGroup,
  handoffTask,
  react,
  listBots,
  listModels,
  createBot,
  updateBot,
  listSections,
  createSection,
  renameSection,
  deleteSection,
  moveBotToSection,
  askUser,
  requestApproval,
  notifyUser,
  sendFile,
  remember,
  forget,
  recallMemory,
  createRoutine,
  updateRoutine,
  listRoutines,
  saveSkill,
  listSkills,
  enableSkill,
  disableSkill,
  findSkills,
  previewSkill,
  installSkill,
  listNodes,
]

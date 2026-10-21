/**
 * SlackToolkit (D3.4): the owner's Slack, offered while it is connected (`ToolAvailability.slack`,
 * decided when the MCP session starts; connecting Slack changes the Bot's instructions, which reopens
 * its session with these tools).
 *
 * slack_search / slack_read / slack_find → SlackConnector · slack_draft → SlackService.draft (an
 * editable draft the owner sends themselves; nothing reaches Slack from a Bot directly).
 */
import { type DataDir, type IdGen, Messaging, type NodeDirectory, type SlackConversation, SlackConnector, type SlackMessage, SlackService } from "@openbot/core"
import { Effect, Option } from "effect"
import * as p from "../params.ts"
import { capText, textResult, ToolRefusal } from "../results.ts"
import { type AnyTool, defineTool, type ToolAvailability } from "../tool.ts"
import { chooseNode } from "./node.ts"

const slackConnected = ({ slack }: ToolAvailability): boolean => slack === true

const NOT_CONNECTED = "Slack isn't connected."

const connector = Effect.serviceOption(SlackConnector).pipe(
  Effect.flatMap(Option.match({
    onNone: () => Effect.fail(new ToolRefusal({ message: NOT_CONNECTED })),
    onSome: Effect.succeed,
  })),
)

const pad = (n: number) => String(n).padStart(2, "0")

/** `2026-10-19 14:02` in the brain's time zone. */
export const slackTime = (ts: string): string => {
  const d = new Date(Number(ts) * 1000)
  if (Number.isNaN(d.getTime())) return ts
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const MESSAGE_TEXT_CHARS = 1_500

/** One message: a header line, then its text indented. */
export const formatSlackMessage = (message: SlackMessage, options?: { readonly where?: string | undefined; readonly link?: boolean }): string => {
  const facts = [`ts ${message.ts}`]
  if (message.threadTs !== undefined && message.threadTs !== message.ts) facts.push(`in thread ${message.threadTs}`)
  if (message.replyCount !== undefined && message.replyCount > 0) facts.push(`${message.replyCount} ${message.replyCount === 1 ? "reply" : "replies"}`)
  const head = [options?.where, message.author, slackTime(message.ts)].filter((part) => part !== undefined).join(" · ")
  const text = message.text.length > MESSAGE_TEXT_CHARS ? `${message.text.slice(0, MESSAGE_TEXT_CHARS)}…` : message.text
  const files = message.files === undefined || message.files.length === 0 ? [] : [`  [files: ${message.files.join(", ")}]`]
  return [
    `${head} (${facts.join(", ")})`,
    ...text.split("\n").map((line) => `  ${line}`),
    ...files,
    ...(options?.link === true ? [`  ${message.permalink}`] : []),
  ].join("\n")
}

const describeConversation = (conversation: SlackConversation): string =>
  conversation.kind === "dm"
    ? `DM with ${conversation.label}`
    : conversation.kind === "group-dm"
    ? `group DM with ${conversation.label}`
    : conversation.label

const slackSearch = defineTool({
  name: "slack_search",
  toolset: "bot",
  description:
    "Search the owner's Slack (everything they can see), newest first. Uses Slack's search syntax: words or \"an exact phrase\", plus filters such as from:@alice, in:#general, in:@bob (a DM), after:2026-10-01, before:2026-10-15, on:2026-10-19, has:link, is:thread. Each result has its place, author, time, ts and link; read the surrounding conversation or thread with slack_read.",
  params: p.params({
    query: p.text("What to search for, in Slack search syntax."),
    limit: p.optional(p.number("How many results (default 20, at most 50).", { integer: true, min: 1, max: 50 })),
  }),
  annotations: { title: "Search Slack", readOnlyHint: true, openWorldHint: true },
  available: slackConnected,
  idempotent: false,
  handler: (args) =>
    Effect.gen(function*() {
      const slack = yield* connector
      const found = yield* slack.search({ query: args.query, limit: args.limit ?? 20 })
      if (found.messages.length === 0) return textResult(`Nothing in Slack matches ${JSON.stringify(args.query)}.`)
      const head = `${found.messages.length} of ${found.total} ${found.total === 1 ? "match" : "matches"}, newest first:`
      const body = found.messages.map((m) => formatSlackMessage(m, { where: m.where, link: true }))
      return textResult(capText([head, ...body].join("\n\n")).text)
    }),
})

const slackRead = defineTool({
  name: "slack_read",
  toolset: "bot",
  description:
    "Read a Slack conversation the owner can see: its latest messages, oldest first, or one thread. `conversation` is a channel (#name or its id), a person (@handle or their name: the owner's DM with them), or a Slack message link (opens that message's thread). Page back with `before` (the ts of the oldest message you have).",
  params: p.params({
    conversation: p.text("#channel, a channel id, @person or their name, or a Slack message link."),
    thread: p.optional(p.string("Read this thread instead: the ts of its first message (as shown by slack_read or slack_search).")),
    limit: p.optional(p.number("How many messages (default 30, at most 100).", { integer: true, min: 1, max: 100 })),
    before: p.optional(p.string("Only messages before this ts (to page back).")),
  }),
  annotations: { title: "Read Slack", readOnlyHint: true, openWorldHint: true },
  available: slackConnected,
  idempotent: false,
  handler: (args) =>
    Effect.gen(function*() {
      const slack = yield* connector
      const read = yield* slack.read({
        conversation: args.conversation,
        thread: args.thread === undefined || args.thread.trim() === "" ? undefined : args.thread.trim(),
        limit: args.limit ?? 30,
        before: args.before === undefined || args.before.trim() === "" ? undefined : args.before.trim(),
      })
      const place = `${describeConversation(read.conversation)} (${read.conversation.id})`
      if (read.messages.length === 0) return textResult(`${place}: no messages${args.before === undefined ? "" : " before that"}.`)
      const oldest = read.messages[0]!.ts
      const head = `${place}${read.conversation.topic === undefined || read.conversation.topic === "" ? "" : ` — topic: ${read.conversation.topic}`}\n${read.messages.length} messages, oldest first${read.more ? ` (older ones: before ${oldest})` : ""}:`
      return textResult(capText([head, ...read.messages.map((m) => formatSlackMessage(m))].join("\n\n")).text)
    }),
})

const slackFind = defineTool({
  name: "slack_find",
  toolset: "bot",
  description:
    "Find Slack channels the owner is in and people in the workspace by name (part of a name works). Shows ids and @handles for slack_read and slack_draft.",
  params: p.params({
    query: p.text("Part of a channel name or a person's name."),
  }),
  annotations: { title: "Find in Slack", readOnlyHint: true, openWorldHint: true },
  available: slackConnected,
  idempotent: false,
  handler: (args) =>
    Effect.gen(function*() {
      const slack = yield* connector
      const found = yield* slack.find(args.query)
      const lines: Array<string> = []
      if (found.conversations.length > 0) {
        lines.push("Conversations:")
        for (const c of found.conversations) lines.push(`- ${describeConversation(c)} (${c.id})${c.topic === undefined || c.topic === "" ? "" : ` — ${c.topic}`}`)
      }
      if (found.people.length > 0) {
        lines.push("People:")
        for (const person of found.people) {
          lines.push(`- ${person.name}${person.handle === undefined ? "" : ` (@${person.handle})`} ${person.id}${person.title === undefined || person.title === "" ? "" : ` — ${person.title}`}`)
        }
      }
      return textResult(lines.length === 0 ? `No channel or person in Slack matches ${JSON.stringify(args.query)}.` : capText(lines.join("\n")).text)
    }),
})

const slackDraft = defineTool({
  name: "slack_draft",
  toolset: "bot",
  description:
    "Write a Slack message for the owner to send: it appears in this chat as a draft they can edit, then send (it goes out as them) or discard. This is the only way to write in Slack; you are not told when they send it. `to` is a channel (#name or id), a person (@handle or name: a DM), several people separated by commas (a group DM), or a Slack message link (a reply in its thread). Mention people as @Name. Keep Slack's tone: short and plain, no headings. `files` attaches files you made (a video, an image, a PDF…; paths like send_file's, up to 10): they are uploaded with the message, which becomes their comment.",
  params: p.params({
    to: p.text("#channel, a channel id, @person or their name, \"Alice, Bob\", or a Slack message link."),
    text: p.string("The message, as the owner would write it (may be empty when files are attached)."),
    thread: p.optional(p.string("Reply in this thread: the ts of its first message, or a message link.")),
    files: p.optional(p.array(p.text(), "Files to attach: relative to your workspace, absolute, or ~/… on the node (at most 10).", { minItems: 1, maxItems: 10 })),
    node: p.optional(p.text("Node id or name the files are on (see list_nodes). Default: your host node.")),
  }),
  annotations: { title: "Draft a Slack message", destructiveHint: false, openWorldHint: false },
  available: slackConnected,
  handler: (args, ctx) =>
    Effect.gen(function*() {
      const service = yield* Effect.serviceOption(SlackService)
      if (Option.isNone(service)) return yield* new ToolRefusal({ message: NOT_CONNECTED })
      const paths = args.files ?? []
      if (paths.length > 0) {
        const status = yield* (yield* connector).status
        if ((status.missingScopes ?? []).includes("files:write")) {
          return yield* new ToolRefusal({
            message: "The owner's Slack app can't upload files yet: it needs an update (Connect apps › Slack shows how). Draft the text alone, or tell the owner.",
          })
        }
      }
      // the files come into OpenBot now (the draft shows them); Slack gets them when the owner sends it
      const files = paths.length === 0 ? [] : yield* Effect.gen(function*() {
        const target = yield* chooseNode(ctx, args.node, "fs")
        return yield* (yield* Messaging).importFiles({ nodeId: target.nodeId, inv: target.inv, cwd: target.workspace, paths, progress: ctx.progress })
      })
      const drafted = yield* service.value.draft(ctx.tool, {
        to: args.to,
        text: args.text,
        thread: args.thread === undefined || args.thread.trim() === "" ? undefined : args.thread.trim(),
        ...(files.length === 0 ? {} : { files }),
      })
      return textResult(
        `Drafted for ${drafted.to}${drafted.inThread ? " (in the thread)" : ""}${files.length === 0 ? "" : ` with ${files.map((f) => f.name).join(", ")}`}. The owner sees it in this chat and sends or discards it themselves. Don't repeat the message in your reply; with nothing else to add, reply exactly NO_REPLY.`,
      )
    }),
})

export const SlackToolkit: ReadonlyArray<AnyTool<Messaging | NodeDirectory | IdGen | DataDir>> = [slackSearch, slackRead, slackFind, slackDraft]

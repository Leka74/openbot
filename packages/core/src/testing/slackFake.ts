/**
 * In-memory `SlackConnector` for tests (D3.4): workspace "Acme" where the owner is "Owner" (U_OWNER),
 * with #general (C_GENERAL) and Alice (U_ALICE, DM D_ALICE). `emit` publishes a Slack message as if
 * it arrived; `click` is the owner's "Send to OpenBot" on a message; `sent` lists what was posted and
 * `replies` the notes Slack showed the owner; `missingScopes` makes it an app from an older manifest.
 */
import { InvalidInput, type SlackStatus, Unavailable } from "@openbot/contracts"
import { Context, Effect, Layer, PubSub, Stream } from "effect"
import { SlackConnector, type SlackConversation, type SlackEvent, type SlackMessage, type SlackShortcut } from "../ports/Slack.ts"

export const SLACK_GENERAL: SlackConversation = { id: "C_GENERAL", kind: "channel", label: "#general" }
export const SLACK_ALICE_DM: SlackConversation = { id: "D_ALICE", kind: "dm", label: "Alice" }

export const slackMessage = (overrides: Partial<SlackMessage> & { readonly text: string }): SlackMessage => ({
  channelId: SLACK_GENERAL.id,
  ts: "1729340000.000100",
  userId: "U_ALICE",
  author: "Alice",
  permalink: `https://acme.slack.com/archives/${overrides.channelId ?? SLACK_GENERAL.id}/p${(overrides.ts ?? "1729340000.000100").replace(".", "")}`,
  ...overrides,
})

export interface SlackSent {
  readonly channelId: string
  readonly text: string
  readonly threadTs?: string | undefined
  readonly files?: ReadonlyArray<{ readonly name: string; readonly path: string; readonly byteSize: number }> | undefined
}

export class SlackConnectorFake extends Context.Service<SlackConnectorFake, {
  readonly emit: (event: SlackEvent) => Effect.Effect<void>
  readonly click: (shortcut: Omit<SlackShortcut, "reply">) => Effect.Effect<void>
  readonly sent: Effect.Effect<ReadonlyArray<SlackSent>>
  readonly replies: Effect.Effect<ReadonlyArray<string>>
  readonly setConnected: (connected: boolean) => Effect.Effect<void>
}>()("openbot/core/testing/SlackConnectorFake") {
  static readonly layer = (options?: { readonly connected?: boolean; readonly missingScopes?: ReadonlyArray<string> }): Layer.Layer<SlackConnector | SlackConnectorFake> =>
    Layer.effectContext(
      Effect.gen(function*() {
        const events = yield* PubSub.unbounded<SlackEvent>()
        const shortcuts = yield* PubSub.unbounded<SlackShortcut>()
        const replies: Array<string> = []
        const changes = yield* PubSub.unbounded<SlackStatus>()
        const sent: Array<SlackSent> = []
        let connected = options?.connected ?? true
        const status = (): SlackStatus =>
          connected
            ? {
              connected: true,
              team: "Acme",
              teamUrl: "https://acme.slack.com/",
              userId: "U_OWNER",
              userName: "Owner",
              events: "live",
              ...(options?.missingScopes === undefined ? {} : { missingScopes: options.missingScopes }),
            }
            : { connected: false, events: "off" }
        const ensure = Effect.suspend(() => (connected ? Effect.void : Effect.fail(new Unavailable({ message: "Slack isn't connected." }))))
        const where = (to: string): Effect.Effect<SlackConversation, InvalidInput> => {
          const key = to.trim().toLowerCase()
          if (key === "#general" || key === "c_general") return Effect.succeed(SLACK_GENERAL)
          if (key === "@alice" || key === "alice" || key === "d_alice") return Effect.succeed(SLACK_ALICE_DM)
          return Effect.fail(new InvalidInput({ message: `Nobody in Slack is called "${to.trim()}".` }))
        }
        const connector = SlackConnector.of({
          status: Effect.sync(status),
          changes: Stream.fromPubSub(changes),
          connect: () =>
            Effect.sync(() => {
              connected = true
              PubSub.publishUnsafe(changes, status())
              return status()
            }),
          disconnect: Effect.sync(() => {
            connected = false
            PubSub.publishUnsafe(changes, status())
          }),
          search: ({ query }) =>
            Effect.andThen(ensure, Effect.succeed({ total: 1, messages: [{ ...slackMessage({ text: `About ${query}` }), where: "#general" }] })),
          read: ({ conversation }) =>
            Effect.andThen(ensure, Effect.map(where(conversation), (c) => ({ conversation: c, messages: [slackMessage({ channelId: c.id, text: "Hello" })], more: false }))),
          find: () => Effect.succeed({ conversations: [SLACK_GENERAL], people: [{ id: "U_ALICE", name: "Alice", handle: "alice" }] }),
          resolve: ({ to, thread }) =>
            Effect.andThen(
              ensure,
              Effect.map(where(to), (conversation) =>
                thread === undefined
                  ? { conversation }
                  : { conversation, thread: slackMessage({ channelId: conversation.id, ts: thread, threadTs: thread, text: "Can someone look at the deploy?" }) }),
            ),
          send: (input) =>
            Effect.andThen(
              ensure,
              Effect.sync(() => {
                sent.push(input)
                if (input.files !== undefined && input.files.length > 0) return { permalink: `https://acme.slack.com/archives/${input.channelId}` }
                const ts = `1729340000.${String(200 + sent.length).padStart(6, "0")}`
                return { ts, permalink: `https://acme.slack.com/archives/${input.channelId}/p${ts.replace(".", "")}` }
              }),
            ),
          events: Stream.fromPubSub(events),
          shortcuts: Stream.fromPubSub(shortcuts),
        })
        const fake = SlackConnectorFake.of({
          emit: (event) => Effect.asVoid(PubSub.publish(events, event)),
          click: (shortcut) =>
            Effect.asVoid(PubSub.publish(shortcuts, { ...shortcut, reply: (text) => Effect.sync(() => void replies.push(text)) })),
          sent: Effect.sync(() => [...sent]),
          replies: Effect.sync(() => [...replies]),
          setConnected: (value) =>
            Effect.sync(() => {
              connected = value
            }),
        })
        return Context.make(SlackConnector, connector).pipe(Context.add(SlackConnectorFake, fake))
      }),
    )
}

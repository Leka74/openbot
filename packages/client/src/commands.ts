// Command (mutation) atoms for every unary RPC in `OpenBotRpcs` (architecture §4.10).
//
//   const create = useAtomSet(commands["bots.create"], { mode: "promise" })
//   await create({ name: "Scout", harness: { kind: "fake" }, clientNonce })
//
// - The write value is the RPC payload itself.
// - Writing a fn atom while a previous call is still running interrupts that call (single flight).
//   For actions that can overlap (one approval card per request, …) use a keyed instance:
//   `commandAtom("requests.respond", requestId)`.
// - On success, reactivity keys for the data the command changed are invalidated, so query atoms
//   (`routinesAtom`, `memoryAtom`, …) refetch. Live data (roster, conversations) arrives on its streams.
import { Effect } from "effect"
import { OpenBotRpcs } from "@openbot/contracts"
import { Atom, Reactivity } from "effect/reactivity"
import type { Rpc, RpcClientError, RpcGroup } from "effect/rpc"
import { Keys, type ReactivityKey } from "./keys.ts"
import { once } from "./once.ts"
import { OpenBotClient } from "./rpc.ts"

type Rpcs = RpcGroup.Rpcs<typeof OpenBotRpcs>
export type RpcTag = Rpcs["_tag"]
/** The streaming RPCs, served by the replica atoms instead. */
export type StreamTag = "roster.subscribe" | "conversations.subscribe"
export type CommandTag = Exclude<RpcTag, StreamTag>

export type CommandPayload<T extends RpcTag> = Rpc.PayloadConstructor<Rpc.ExtractTag<Rpcs, T>>
export type CommandSuccess<T extends RpcTag> = Rpc.Success<Rpc.ExtractTag<Rpcs, T>>
export type CommandError<T extends RpcTag> = Rpc.Error<Rpc.ExtractTag<Rpcs, T>> | RpcClientError.RpcClientError
export type CommandAtom<T extends CommandTag> = Atom.AtomResultFn<CommandPayload<T>, CommandSuccess<T>, CommandError<T>>

const STREAM_TAGS: ReadonlySet<string> = new Set<StreamTag>(["roster.subscribe", "conversations.subscribe"])

/** What each mutating RPC invalidates. Read-only RPCs are absent. */
export const COMMAND_INVALIDATES: Partial<Record<CommandTag, ReadonlyArray<ReactivityKey>>> = {
  "bots.create": [Keys.session, Keys.botContext],
  "bots.update": [Keys.botContext, Keys.computer],
  "bots.delete": [Keys.session, Keys.botContext, Keys.routines, Keys.usage],
  "bots.newSession": [Keys.botContext],
  "bots.compact": [Keys.botContext],
  "sections.create": [Keys.sections],
  "sections.rename": [Keys.sections],
  "sections.delete": [Keys.sections],
  "sections.reorder": [Keys.sections],
  "conversations.createGroup": [],
  "conversations.setMembers": [],
  "conversations.rename": [],
  "conversations.markRead": [],
  "conversations.setHidden": [],
  "conversations.delete": [Keys.requests],
  "messages.send": [],
  "messages.react": [],
  "turns.interrupt": [Keys.requests],
  "turns.retry": [],
  "attachments.upload": [],
  "requests.respond": [Keys.requests, Keys.rules],
  "routines.create": [Keys.routines],
  "routines.update": [Keys.routines],
  "routines.setEnabled": [Keys.routines],
  "routines.delete": [Keys.routines],
  "routines.runNow": [Keys.routines],
  "memory.putFact": [Keys.memory, Keys.botContext],
  "memory.deleteFact": [Keys.memory, Keys.botContext],
  "memory.setIndex": [Keys.memory, Keys.botContext],
  "skills.upsert": [Keys.skills],
  "skills.delete": [Keys.skills, Keys.botContext],
  "skills.assign": [Keys.botContext],
  "skills.install": [Keys.skills, Keys.botContext],
  "nodes.createPairingCode": [],
  "nodes.rename": [Keys.nodes],
  "nodes.revoke": [Keys.nodes, Keys.computer],
  "nodes.setCapabilities": [Keys.nodes, Keys.computer],
  "computer.ensure": [Keys.computer],
  "computer.lease": [Keys.computer],
  "computer.reset": [Keys.computer],
  "settings.update": [Keys.settings],
  "harnesses.addProfile": [Keys.harnesses],
  "harnesses.removeProfile": [Keys.harnesses],
  "rules.upsert": [Keys.rules],
  "rules.delete": [Keys.rules],
  "tasks.cancel": [Keys.tasks],
  "slack.connect": [Keys.slack, Keys.botContext],
  "slack.disconnect": [Keys.slack, Keys.botContext],
  "slack.sendDraft": [],
  "slack.discardDraft": [],
  "stt.install": [Keys.stt],
  "stt.remove": [Keys.stt],
  "stt.open": [],
  "stt.append": [],
  "stt.finish": [],
  "stt.discard": [],
}

/** Run one RPC as an Effect (for composing inside other `runtime.fn` atoms). */
export const callRpc = <T extends CommandTag>(tag: T, payload: CommandPayload<T>): Effect.Effect<CommandSuccess<T>, CommandError<T>, OpenBotClient> =>
  Effect.flatMap(OpenBotClient, (client) => (client as any)(tag, payload) as Effect.Effect<CommandSuccess<T>, CommandError<T>>)

const SEP = "\u0000"

/** One write = one box, so `once` can tell a real call from a re-run of the last one (see once.ts). */
interface Invocation {
  readonly payload: unknown
}

const commandFamily = Atom.family((key: string) => {
  const tag = key.slice(0, key.indexOf(SEP)) as CommandTag
  const invalidates = COMMAND_INVALIDATES[tag]
  const label = `openbot/command/${tag}${key.length > tag.length + 1 ? `/${key.slice(tag.length + 1)}` : ""}`
  const inner = OpenBotClient.runtime
    .fn((invocation: Invocation) =>
      once(
        invocation,
        Effect.gen(function* (): Effect.fn.Return<unknown, unknown, OpenBotClient | Reactivity.Reactivity> {
          const client = yield* OpenBotClient
          const call = (client as any)(tag, invocation.payload) as Effect.Effect<unknown, unknown>
          if (invalidates === undefined || invalidates.length === 0) return yield* call
          const reactivity = yield* Reactivity.Reactivity
          return yield* reactivity.mutation(invalidates, call)
        }),
      ),
    )
    .pipe(Atom.withLabel(`${label}/inner`))
  // The public atom boxes every payload (Reset / Interrupt pass through untouched).
  return Atom.writable(
    (get) => get(inner),
    (ctx, value: unknown) =>
      ctx.set(inner, value === Atom.Reset || value === Atom.Interrupt ? (value as never) : { payload: value }),
  ).pipe(Atom.withLabel(label))
})

/**
 * The command atom for `tag`. Atoms are memoized per `(tag, instanceKey)`; different instance keys
 * run independently (e.g. one per request id), the same key is single-flight.
 */
export const commandAtom = <T extends CommandTag>(tag: T, instanceKey = ""): CommandAtom<T> => {
  if (STREAM_TAGS.has(tag)) throw new Error(`${tag} is a stream; use the replica atoms`)
  return commandFamily(`${tag}${SEP}${instanceKey}`) as unknown as CommandAtom<T>
}

/** One shared command atom per unary RPC: `commands["settings.update"]`. */
export const commands: { readonly [T in CommandTag]: CommandAtom<T> } = Object.fromEntries(
  [...OpenBotRpcs.requests.keys()].filter((tag) => !STREAM_TAGS.has(tag)).map((tag) => [tag, commandAtom(tag as CommandTag)]),
) as { readonly [T in CommandTag]: CommandAtom<T> }

// Named aliases for the most used commands.
export const createBotAtom = commands["bots.create"]
export const updateBotAtom = commands["bots.update"]
export const deleteBotAtom = commands["bots.delete"]
export const newSessionAtom = commands["bots.newSession"]
export const compactAtom = commands["bots.compact"]
export const createGroupAtom = commands["conversations.createGroup"]
export const markReadAtom = commands["conversations.markRead"]
export const interruptTurnAtom = commands["turns.interrupt"]
export const retryTurnAtom = commands["turns.retry"]
export const updateSettingsAtom = commands["settings.update"]
export const createPairingCodeAtom = commands["nodes.createPairingCode"]
/** Answer a runtime request; keyed per request so answering two cards never interrupts one. */
export const respondRequestAtom = (requestId: string): CommandAtom<"requests.respond"> => commandAtom("requests.respond", requestId)

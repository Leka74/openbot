// Shared primitives for every OpenBot contract: branded ids, scalars, harness kinds, usage,
// authors and the forward-compatible tagged-union helper. Effect 4.0.4 Schema only (browser-safe).
// Ported from vendor/scratch/contracts/src/base.ts (domain-contract.md §F.4).
import { Schema, SchemaGetter } from "effect"

// ---------------------------------------------------------------------------- scalars
export const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
export const Millis = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
export type Millis = typeof Millis.Type
export const NonNegativeInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
export type NonNegativeInt = typeof NonNegativeInt.Type
/** Lower-case slug used for file-backed names (memory facts, skills): `a-z0-9`, `-`, `_`, max 64. */
export const Slug = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/))
export type Slug = typeof Slug.Type

const makeId = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  NonEmptyString.pipe(Schema.brand<B>(brand))

/** Ids are server-allocated prefixed ULIDs (`bot_…`, `cnv_…`, `ent_…`); the prefix is a convention, not validated. */
export const BotId = makeId("BotId")
export type BotId = typeof BotId.Type
export const UserId = makeId("UserId")
export type UserId = typeof UserId.Type
export const ConversationId = makeId("ConversationId")
export type ConversationId = typeof ConversationId.Type
export const EntryId = makeId("EntryId")
export type EntryId = typeof EntryId.Type
export const RequestId = makeId("RequestId")
export type RequestId = typeof RequestId.Type
export const TurnId = makeId("TurnId")
export type TurnId = typeof TurnId.Type
export const NodeId = makeId("NodeId")
export type NodeId = typeof NodeId.Type
export const RoutineId = makeId("RoutineId")
export type RoutineId = typeof RoutineId.Type
export const RoutineRunId = makeId("RoutineRunId")
export type RoutineRunId = typeof RoutineRunId.Type
export const SectionId = makeId("SectionId")
export type SectionId = typeof SectionId.Type
export const AttachmentId = makeId("AttachmentId")
export type AttachmentId = typeof AttachmentId.Type
export const ApprovalRuleId = makeId("ApprovalRuleId")
export type ApprovalRuleId = typeof ApprovalRuleId.Type
export const NotificationId = makeId("NotificationId")
export type NotificationId = typeof NotificationId.Type
/** A piece of work a bot runs in parallel with its conversations (background task, D5.7). */
export const TaskId = makeId("TaskId")
export type TaskId = typeof TaskId.Type
/** A profile of the owner: its own bots, chats, memory, skills, routines and connections. */
export const OwnerProfileId = makeId("OwnerProfileId")
export type OwnerProfileId = typeof OwnerProfileId.Type

/** The brain's in-process node (D1.1). Always present unless disabled by config. */
export const LOCAL_NODE_ID = "node_local" as NodeId
/** The profile every brain starts with; what existed before profiles belongs to it. */
export const MAIN_PROFILE_ID = "prf_main" as OwnerProfileId
/** The single owner (D0.2). */
export const OWNER_USER_ID = "user_owner" as UserId

/** Prefixes used by `IdGen` (architecture §3.5). */
export const IdPrefix = {
  bot: "bot",
  conversation: "cnv",
  entry: "ent",
  request: "req",
  turn: "trn",
  routine: "rtn",
  routineRun: "run",
  node: "nod",
  section: "sec",
  attachment: "att",
  rule: "rul",
  notification: "ntf",
  task: "tsk",
  profile: "prf",
} as const

// ---------------------------------------------------------------------------- harness
export const KnownHarnessKinds = ["claude", "codex", "opencode", "fake"] as const
/** The harnesses this build ships drivers for. */
export const HarnessKind = Schema.Literals(KnownHarnessKinds)
export type HarnessKind = typeof HarnessKind.Type
/**
 * A harness kind as stored and sent on the wire: any non-empty string. Unknown kinds (a bot created
 * by a newer build, or a driver that is not installed) are KEPT, so the bot still loads and the UI can
 * say "harness X is unavailable". Use {@link isKnownHarnessKind} to narrow.
 */
export type HarnessKindName = HarnessKind | (string & {})
export const HarnessKindName = NonEmptyString as unknown as Schema.Codec<HarnessKindName, string>
export const isKnownHarnessKind = (kind: string): kind is HarnessKind =>
  (KnownHarnessKinds as ReadonlyArray<string>).includes(kind)

/** Where a transcript fact came from, for dedupe/debugging. Never used as a UI key. */
export const HarnessRef = Schema.Struct({
  harness: HarnessKindName,
  /** Native id: Claude tool_use id / api message id + block index, Codex item id, OpenCode part key. */
  nativeId: NonEmptyString,
})
export type HarnessRef = typeof HarnessRef.Type

export const Usage = Schema.Struct({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cachedInputTokens: Schema.optionalKey(NonNegativeInt),
  reasoningTokens: Schema.optionalKey(NonNegativeInt),
  costUsd: Schema.optionalKey(Schema.Number),
})
export type Usage = typeof Usage.Type

/** Context-window usage of a native session (context ring, D6.5). */
export const ContextUsage = Schema.Struct({ usedTokens: NonNegativeInt, windowTokens: NonNegativeInt })
export type ContextUsage = typeof ContextUsage.Type

export const Author = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user"), userId: UserId, name: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("bot"), botId: BotId }),
  Schema.Struct({ kind: Schema.Literal("system") }),
])
export type Author = typeof Author.Type

// ---------------------------------------------------------------------------- forward compatibility
/**
 * A tagged union that decodes members whose tag this build does not know into an explicit,
 * decode-only `unknown` member instead of failing (t3code `kindUnionWithFallback` idea, but the
 * unknown value is KEPT so the UI can render "update OpenBot to see this", like Grok's renderer).
 * A known tag whose payload is malformed still fails, unless `malformedAsUnknown` is set. Encoding an
 * unknown member is forbidden.
 */
export const withUnknownFallback = <
  const Members extends ReadonlyArray<Schema.Top & { readonly fields: object }>,
  const Tag extends string,
  const KeepFields extends Schema.Struct.Fields,
>(options: {
  readonly members: Members
  readonly tag: Tag
  readonly keep: KeepFields
  readonly malformedAsUnknown?: boolean
}) => {
  const known = knownTags(options.members, options.tag)
  const unknownType = Schema.Struct({
    ...options.keep,
    [options.tag]: Schema.Literal("unknown"),
    originalTag: Schema.String,
  } as KeepFields & { [K in Tag]: Schema.Literal<"unknown"> } & { originalTag: Schema.String })
  const unknownArm = Schema.Struct({
    ...options.keep,
    [options.tag]: Schema.String.check(
      Schema.makeFilter(
        (value: string) =>
          (value !== "unknown" && (options.malformedAsUnknown === true || !known.has(value))) ||
          `A known ${options.tag} must decode in full.`,
      ),
    ),
  } as KeepFields & { [K in Tag]: Schema.String }).pipe(
    Schema.decodeTo(unknownType as Schema.Top, {
      decode: SchemaGetter.transform((raw: any) => ({
        ...raw,
        [options.tag]: "unknown",
        originalTag: raw[options.tag],
      })),
      encode: SchemaGetter.forbidden(() => `Unknown ${options.tag} values are decode-only.`),
    }),
  )
  return {
    schema: Schema.Union([...options.members, unknownArm]) as unknown as Schema.Codec<
      Members[number]["Type"] | (typeof unknownType)["Type"],
      Members[number]["Encoded"],
      never,
      never
    >,
    unknownType,
    known,
  }
}

export const knownTags = (
  members: ReadonlyArray<Schema.Top & { readonly fields: object }>,
  tag: string,
): ReadonlySet<string> => {
  const tags = new Set<string>()
  for (const member of members) {
    const field = (member.fields as Record<string, unknown>)[tag] as
      { readonly literal?: unknown; readonly literals?: ReadonlyArray<unknown> } | undefined
    for (const literal of field?.literals ?? [field?.literal]) {
      if (typeof literal !== "string") throw new Error(`Every member needs a string literal "${tag}".`)
      tags.add(literal)
    }
  }
  return tags
}

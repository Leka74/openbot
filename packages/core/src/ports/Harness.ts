/**
 * Harness port (architecture §3.1, D2). Two-level SPI trimmed from t3code's provider SPI:
 * a `HarnessDriver` (one per harness kind, a plain record so several can coexist) opens scoped
 * `HarnessSession`s — ONE per bot ("one mind per bot", D5.0), shared by all of its conversations;
 * each turn belongs to one conversation (`TurnInput.conversationId`).
 *
 * Rules (AGENTS.md, D2): adapters keep SDK types inside their package, emit normalized whole-item
 * upserts (`contracts.HarnessEvent`), and declare capabilities honestly — never fake approvals,
 * permission modes or remote placements.
 */
import type {
  Bot,
  BotId,
  ContextUsage,
  HarnessCapabilities as ContractHarnessCapabilities,
  ConversationId,
  HarnessEvent,
  HarnessKind,
  HarnessRequest,
  HarnessRequestResolution,
  HarnessStatus,
  ModelInfo,
  OwnerProfileId,
  SkillName,
  TaskId,
  TurnId,
} from "@openbot/contracts"
import { HarnessUnavailable, normalizeProfileId } from "@openbot/contracts"
import { Context, Effect, Layer, Ref, Scope, Stream } from "effect"
import type { HarnessError } from "./errors.ts"
import type { McpBinding } from "./Mcp.ts"
import type { ResolvedPlacement } from "./Placement.ts"

export type { HarnessKind }

/**
 * An OpenBot `(bot, conversation)` key: `"<botId>:<conversationId>"`.
 * - `OpenSessionInput.sessionKey` / the minted `McpClaims.sessionKey`: the bot's session, keyed on
 *   its HOME conversation (its DM) — stable for the bot's single session.
 * - Per gateway tool call the gateway substitutes the CURRENT turn's conversation, so node-protocol
 *   `Invocation.runId` routes a node's `node.requestApproval {runId}` to the conversation the bot is
 *   working in.
 */
export const sessionKeyOf = (botId: BotId, conversationId: ConversationId): string => `${botId}:${conversationId}`

/**
 * The driver-facing `OpenSessionInput.sessionKey` of a background task's own session (D5.7):
 * `"<botId>:<taskId>"`, unique per task so drivers that key native state on the session key (MCP
 * server names, process labels) never mix it up with the bot's main session. The task's MCP claims
 * keep `sessionKeyOf(botId, originConversationId)` (node approvals route to that conversation).
 */
export const taskSessionKeyOf = (botId: BotId, taskId: TaskId): string => `${botId}:${taskId}`

/** Inverse of {@link sessionKeyOf}; `undefined` for malformed keys. Ids never contain ':'. */
export const parseSessionKey = (
  key: string,
): { readonly botId: BotId; readonly conversationId: ConversationId } | undefined => {
  const index = key.indexOf(":")
  if (index <= 0 || index === key.length - 1) return undefined
  return { botId: key.slice(0, index) as BotId, conversationId: key.slice(index + 1) as ConversationId }
}

/**
 * Declared, never faked (D2). The schema lives in contracts (`contracts.HarnessCapabilities`) so the
 * UI can gate actions; `remotePlacements` lists the remote modes the driver implements
 * (`native-local` is implied).
 */
export type HarnessCapabilities = ContractHarnessCapabilities

/**
 * Instructions assembled by `InstructionRenderer` (§4.3.7). Adapters inject `text`:
 * Claude `systemPrompt.append`, Codex `developerInstructions`, OpenCode instruction entries.
 */
export interface RenderedInstructions {
  /** Full instruction text, sections joined in order. */
  readonly text: string
  readonly sections: {
    /** OpenBot base: who you are, the team, openbot tools, async rules for ask_user/approvals. */
    readonly base: string
    /** The bot's own `instructions`. */
    readonly persona: string
    /** Team roster, one line per bot. */
    readonly team: string
    /** The group chats the bot is in (title, id, members), one line per group; absent or empty: none. */
    readonly groups?: string | undefined
    /** `MEMORY.md` index (capped at 4 KB). */
    readonly memoryIndex: string
    /** `placement.promptAppend`. */
    readonly placement: string
    /** How to use the owner's Slack while it is connected (D3.4); absent or empty: not connected. */
    readonly slack?: string | undefined
  }
  /** Stable hash of `text`; a change means the session must be reopened (Claude snapshot semantics). */
  readonly hash: string
}

export interface TurnAttachment {
  /** Absolute path readable by the harness process (brain side). */
  readonly path: string
  readonly mime: string
  readonly name: string
}

export interface TurnInput {
  readonly turnId: TurnId
  /**
   * The conversation this turn belongs to (its replies, tool calls and cards land there). The text
   * already says where it comes from (origin tags); adapters may ignore this.
   */
  readonly conversationId?: ConversationId | undefined
  /** Already rendered with sender attribution for group / bot-to-bot (§5.4). */
  readonly text: string
  readonly attachments: ReadonlyArray<TurnAttachment>
  /**
   * The owner's `/name` command for one of the Bot's skills (D5.5). `text` carries it as an
   * instruction with the skill inline; an adapter whose harness starts skills itself sends its own
   * command for `name` with `args`: `text` with only the owner's request in place of that instruction.
   */
  readonly skillCommand?: { readonly name: string; readonly args: string } | undefined
}

export interface OpenSessionInput {
  readonly bot: Bot
  /**
   * The Bot's skills marked `disable-model-invocation` (D5.5): only the owner's `/name` starts them,
   * so an adapter leaves them out of what the model may load on its own. Absent: none.
   */
  readonly ownerOnlySkills?: ReadonlyArray<SkillName> | undefined
  /**
   * The bot's HOME conversation (its DM). The session serves every conversation of the bot; turns
   * name theirs in `TurnInput.conversationId`.
   */
  readonly conversationId: ConversationId
  /** Stable key of the bot's single session: `sessionKeyOf(bot.id, bot.directConversationId)`. */
  readonly sessionKey: string
  /** Resume when defined. */
  readonly nativeSessionId: string | undefined
  readonly placement: ResolvedPlacement
  readonly instructions: RenderedInstructions
  /** MCP servers to register. Tokens go in headers, never on argv. */
  readonly mcp: ReadonlyArray<McpBinding>
  readonly model: string | undefined
  readonly effort: string | undefined
  /**
   * Approvals and questions raised by the native harness. Blocks the native callback until resolved.
   * Implemented by `ApprovalService` (via the runner). Never fails: errors resolve as `deny`.
   */
  readonly onRequest: (request: HarnessRequest) => Effect.Effect<HarnessRequestResolution>
  /**
   * `"task"`: a background-work session (D5.7). Its work ends with its final answer, so the adapter
   * must not let long commands detach into harness-managed background jobs that die with the session.
   * Absent = the bot's main session.
   */
  readonly purpose?: "main" | "task" | undefined
}

export interface HarnessSession {
  /** Hot, per-session stream of normalized events (`contracts.HarnessEvent`). */
  readonly events: Stream.Stream<HarnessEvent>
  readonly nativeSessionId: Effect.Effect<string | undefined>
  /** Completes when the turn is ACCEPTED; the turn end arrives as an event. */
  readonly startTurn: (input: TurnInput) => Effect.Effect<void, HarnessError>
  /** Capability-gated; fails with `HarnessError({code: "unsupported"})` otherwise. */
  readonly steer: (input: TurnInput) => Effect.Effect<void, HarnessError>
  readonly interrupt: Effect.Effect<void>
  /** Capability-gated; fails with `HarnessError({code: "unsupported"})` otherwise. */
  readonly compact: Effect.Effect<void, HarnessError>
  readonly contextUsage: Effect.Effect<ContextUsage | undefined>
}

export interface HarnessDriver {
  readonly kind: HarnessKind
  /**
   * The harness account (profile) this driver instance runs with; absent = the harness's default
   * profile. Several drivers of one kind coexist, one per profile (a profile = a login/config home).
   */
  readonly profileId?: string | undefined
  /** "Claude", "Codex", "OpenCode", "Fake". */
  readonly displayName: string
  readonly capabilities: HarnessCapabilities
  /** Installed? version? auth/account label? Never fails; no model call (D2.6). */
  readonly probe: Effect.Effect<HarnessStatus>
  readonly listModels: Effect.Effect<ReadonlyArray<ModelInfo>, HarnessError>
  /** The session lives until the provided scope closes. */
  readonly openSession: (input: OpenSessionInput) => Effect.Effect<HarnessSession, HarnessError, Scope.Scope>
  /** Stops what the driver keeps for a deleted owner profile (its server); absent = nothing kept. */
  readonly forgetOwnerProfile?: ((profileId: OwnerProfileId) => Effect.Effect<void>) | undefined
}

export interface HarnessRegistryShape {
  /**
   * The driver of `kind` for `profileId` (absent / `"default"` = the default profile). Fails with
   * `HarnessUnavailable` for unknown/unregistered kinds and profiles; never falls back to another
   * profile (a bot must not silently run on someone else's account).
   */
  readonly get: (kind: string, profileId?: string | undefined) => Effect.Effect<HarnessDriver, HarnessUnavailable>
  /** Every registered driver: one per (kind, profile). */
  readonly list: Effect.Effect<ReadonlyArray<HarnessDriver>>
  /**
   * Registers a driver; replaces an existing driver of the same (kind, profile). The registration is
   * removed when the caller's scope closes (driver layers call this inside `Layer.effectDiscard`).
   */
  readonly register: (driver: HarnessDriver) => Effect.Effect<void, never, Scope.Scope>
  /** Every driver forgets a deleted owner profile (`HarnessDriver.forgetOwnerProfile`). */
  readonly forgetOwnerProfile: (profileId: OwnerProfileId) => Effect.Effect<void>
}

/** Registry key of a (kind, profile): `"claude"` for the default profile, `"claude/<profileId>"` otherwise. */
export const driverKeyOf = (kind: string, profileId?: string | undefined): string => {
  const profile = normalizeProfileId(profileId)
  return profile === undefined ? kind : `${kind}/${profile}`
}

/** The driver of a bot (its harness kind and account). */
export const driverForBot = (
  registry: Pick<HarnessRegistryShape, "get">,
  bot: { readonly harness: { readonly kind: string; readonly profileId?: string | undefined } },
): Effect.Effect<HarnessDriver, HarnessUnavailable> => registry.get(bot.harness.kind, bot.harness.profileId)

export class HarnessRegistry extends Context.Service<HarnessRegistry, HarnessRegistryShape>()(
  "openbot/core/HarnessRegistry",
) {
  /** Live registry (no dependencies). Drivers add themselves with `HarnessRegistry.registerLayer`. */
  static readonly layer: Layer.Layer<HarnessRegistry> = Layer.effect(
    HarnessRegistry,
    Effect.gen(function* () {
      const drivers = yield* Ref.make<ReadonlyMap<string, HarnessDriver>>(new Map())
      return HarnessRegistry.of({
        get: (kind, profileId) =>
          Effect.flatMap(Ref.get(drivers), (map) => {
            const driver = map.get(driverKeyOf(kind, profileId))
            if (driver) return Effect.succeed(driver)
            const profile = normalizeProfileId(profileId)
            const known = [...map.values()].find((d) => d.kind === kind)
            return Effect.fail(
              new HarnessUnavailable({
                harness: kind,
                message:
                  profile === undefined || known === undefined
                    ? `Harness "${kind}" is not available.`
                    : `The ${known.displayName} account "${profile}" is not available.`,
              }),
            )
          }),
        list: Effect.map(Ref.get(drivers), (map) => [...map.values()]),
        forgetOwnerProfile: (profileId) =>
          Effect.flatMap(Ref.get(drivers), (map) =>
            Effect.forEach(map.values(), (driver) => driver.forgetOwnerProfile?.(profileId) ?? Effect.void, {
              discard: true,
            }),
          ),
        register: (driver) => {
          const key = driverKeyOf(driver.kind, driver.profileId)
          return Effect.acquireRelease(
            Ref.update(drivers, (map) => new Map(map).set(key, driver)),
            () =>
              Ref.update(drivers, (map) => {
                if (map.get(key) !== driver) return map
                const next = new Map(map)
                next.delete(key)
                return next
              }),
          )
        },
      })
    }),
  )

  /** A layer that registers `driver` for the lifetime of the layer. */
  static readonly registerLayer = <E, R>(
    driver: Effect.Effect<HarnessDriver, E, R>,
  ): Layer.Layer<never, E, HarnessRegistry | Exclude<R, Scope.Scope>> =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const registry = yield* HarnessRegistry
        yield* registry.register(yield* driver)
      }),
    )
}

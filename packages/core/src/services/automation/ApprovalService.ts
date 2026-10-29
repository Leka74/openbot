/**
 * ApprovalService (D3.3, D5.6, architecture §4.3.4, §5.2).
 *
 * - `evaluate` is the runners' `onRequest`: rules decide allow / deny / ask
 *   (`policy.evaluateRules`); when NO rule matches, the bot's autonomy decides allow / ask
 *   (`autonomy.evaluateAutonomy`: "full" allows, "workspace" allows what provably stays in
 *   `ctx.workspace` or a project folder — Settings' shared ∪ the bot's own, `~` expanded with
 *   `HostPaths.home`). Allowed / denied without asking → an `auto-decided` event (no card; it carries
 *   the turn and the gated tool call's key so the UI folds it into the turn's steps). Ask → a
 *   `RuntimeRequest` (pending, `expiresAt = now + expiry`) and a card entry in the conversation the
 *   turn runs in (a group's approvals stay in the group, next to the work), a notification,
 *   `ctx.onPending`, then the caller waits
 *   for `respond` or expiry. Expiry → `expired` + deny (the card offers "Always allow next time").
 *   Interrupting the waiting fiber cancels the request.
 * - "Allow in ‹folder›": when autonomy "workspace" asks because a shell / file request works in a
 *   directory outside every root, the card offers that directory's git repo root
 *   (`HostPaths.projectRoot`, else the directory; `offerableFolder`) as `projectFolder`.
 * - `respond` (`requests.respond`) validates the response against the request's capability,
 *   persists it (request + card), saves a bot-scoped rule for "Always allow", adds the offered
 *   folder to the bot's project folders for `scope: "project-folder"` (publishing the bot), and
 *   wakes the waiter.
 * - `askUser` / `requestApproval` (gateway tools) are NON-blocking: they post the card and return
 *   `{status: "pending", requestId}`. The answer (or the expiry) becomes a `user-message`
 *   delivery on `asyncAnswers`, which the Orchestrator drains. Idempotent on the tool call id.
 * - `evaluateNode` serves a node's own `ask` ceiling with the same rules and cards (autonomy never
 *   overrides a node owner's explicit `ask`).
 * - `requestTakeover` (gateway tool `request_takeover`, D1.7) is async too: an "Action needed"
 *   hand-off card (kind `handoff`, acknowledge `done` | `skip`). With a `ComputerPort` in the
 *   context (optional, like `HostPaths`), the owner's control lease and the card stay in step:
 *   handing the screen back (`computer.lease {take: false}`) answers the bot's pending hand-offs
 *   with `done`, and answering a hand-off gives the lease back BEFORE the bot is told, so its next
 *   `computer` action is not refused. Hand-offs expire after `HANDOFF_EXPIRY_MINUTES`, re-armed
 *   while the owner still holds control (they are working on it).
 *
 * Pending waiters live in memory; a brain restart expires every pending request (boot recovery,
 * D2.5). ApprovalService never writes Turns and never calls the Orchestrator.
 */
import type {
  ApprovalRule,
  Bot,
  BotId,
  ConversationId,
  DecisionId,
  DecisionOption,
  EntryId,
  HarnessApprovalRequest,
  HarnessQuestionRequest,
  HarnessRequest,
  HarnessRequestResolution,
  KnownCard,
  KnownTranscriptEntry,
  Question,
  RequestId,
  ResponseCapability,
  RuntimeRequest,
  RuntimeRequestKind,
  RuntimeRequestSubject,
  RuntimeResponse,
  RuntimeResponseInput,
  SuggestedRule,
  TaskId,
  TurnId,
} from "@openbot/contracts"
import { InvalidInput, normalizeProjectFolder, NotFound, OWNER_USER_ID, RequestNotPending } from "@openbot/contracts"
import type { NodeApprovalResponse } from "@openbot/node-protocol"
import { Clock, Deferred, Duration, Effect, FiberMap, Layer, Option, Queue, Stream } from "effect"
import { parseSessionKey } from "../../ports/Harness.ts"
import { HostPaths } from "../../ports/HostPaths.ts"
import { IdGen } from "../../ports/IdGen.ts"
import { Notifier } from "../../ports/Notifier.ts"
import { ApprovalRuleRepo, BotRepo, RequestRepo, TurnRepo } from "../../ports/repos.ts"
import {
  type ApprovalContext,
  ApprovalService,
  type ApprovalWorkspace,
  ConversationService,
  type DeliveryInput,
  type EntryDraft,
  LiveHub,
  type NodeApprovalInput,
  type PendingRequestReceipt,
  SettingsService,
  type ToolContext,
} from "../../ports/services.ts"
import { ComputerPort } from "../../ports/Computer.ts"
import { evaluateAutonomy, isInsideWorkspace, offerableFolder, outsideWorkDir } from "./autonomy.ts"
import { describeRule, evaluateRules, type PolicySubject, suggestRule, surfaceOf } from "./policy.ts"
import { oneLine, truncate } from "./text.ts"
import { required } from "../conversation/internal/util.ts"
import { inBotProfile } from "../profiles/lookup.ts"
import { currentProfileId, inProfile } from "../../ports/Profiles.ts"

/** Deny message for rule-blocked requests (§4.3.4). */
export const BLOCKED_BY_RULES = "Blocked by your rules"
export const EXPIRED_MESSAGE = "The approval request expired without an answer."

/** Limits for the async tools (model-readable refusals). */
export const ASK_LIMITS = { questions: 10, options: 12, titleChars: 200, instructionChars: 1_000 } as const

/**
 * How long a hand-off (`request_takeover`) waits for the owner: longer than approvals (a login or a
 * 2FA code needs the owner at their desk). While the owner holds control at that moment, it waits
 * another period instead of expiring.
 */
export const HANDOFF_EXPIRY_MINUTES = 30

/** What the bot reads when the owner answered its hand-off. */
export const HANDOFF_DONE_TEXT = "The owner finished on your screen and handed it back."
export const HANDOFF_SKIP_TEXT = "The owner skipped taking over."

/** How a pending request left `pending`. */
type SettledBy = "rule" | "user" | "expired" | "cancelled"

interface Outcome {
  readonly by: SettledBy
  /** The user's raw decision (before "allow-always" is narrowed for the harness). */
  readonly decision?: DecisionId | undefined
  readonly resolution: HarnessRequestResolution
}

interface PendingEntry {
  readonly requestId: RequestId
  /** Blocking requests (`evaluate`, `evaluateNode`): the waiter. */
  readonly deferred?: Deferred.Deferred<Outcome> | undefined
  /** Async tool requests: where the answer is delivered (the conversation the bot asked from). */
  readonly deliverTo?: { readonly conversationId: ConversationId; readonly botId: BotId } | undefined
}

interface NewRequest {
  readonly bot: Bot
  /** The conversation the bot works in (the turn's / the tool call's). */
  readonly originConversationId: ConversationId
  readonly turnId?: TurnId | undefined
  readonly kind: RuntimeRequestKind
  readonly title: string
  readonly detail?: string | undefined
  readonly subject: RuntimeRequestSubject
  readonly responseCapability: ResponseCapability
  readonly suggestedRule?: SuggestedRule | undefined
  /** "Allow in ‹folder›" offer. */
  readonly projectFolder?: string | undefined
  readonly source: RuntimeRequest["source"]
  readonly blocking: boolean
  readonly card: (requestId: RequestId) => KnownCard
  /** Raised by a background task (D5.7): the card is labelled with its title. */
  readonly task?: { readonly id: TaskId; readonly title: string } | undefined
  /** Overrides Settings' `approvalExpiryMinutes` (hand-offs). */
  readonly expiryMinutes?: number | undefined
}

const cancelResolution: HarnessRequestResolution = { decision: "cancel" }

const approvalOptions = (
  request: Pick<HarnessApprovalRequest, "suggestions">,
  offerAlways: boolean,
): ReadonlyArray<DecisionOption> => {
  const options: Array<DecisionOption> = [{ id: "allow-once", label: "Allow once" }]
  if (offerAlways) options.push({ id: "allow-always", label: "Always allow" })
  for (const s of request.suggestions ?? []) {
    if (s.decision === "deny" || s.decision === "allow-always" || options.some((o) => o.id === s.decision)) continue
    options.push({
      id: s.decision,
      ...(s.label === undefined ? {} : { label: s.label }),
      ...(s.native === undefined ? {} : { native: s.native }),
    })
  }
  options.push({ id: "deny", label: "Deny" })
  return options
}

const notificationLead = (kind: RuntimeRequestKind): string =>
  kind === "question" ? "Has a question" : kind === "handoff" ? "Needs you on its screen" : "Needs approval"

const answersText = (
  questions: ReadonlyArray<Question>,
  answers: Readonly<Record<string, ReadonlyArray<string>>>,
): string =>
  questions
    .map((q) => {
      const values = answers[q.id] ?? []
      const shown =
        q.isSecret === true ? "(provided privately)" : values.length === 0 ? "(no answer)" : values.join(", ")
      return `- ${oneLine(q.prompt)}: ${shown}`
    })
    .join("\n")

export const makeApprovalService = Effect.gen(function* () {
  const conversations = yield* ConversationService
  const settings = yield* SettingsService
  const notifier = yield* Notifier
  const requests = yield* RequestRepo
  const rules = yield* ApprovalRuleRepo
  const bots = yield* BotRepo
  const ids = yield* IdGen
  const hub = yield* LiveHub
  const turns = yield* TurnRepo
  const hostPaths = Option.getOrUndefined(yield* Effect.serviceOption(HostPaths))
  const computer = Option.getOrUndefined(yield* Effect.serviceOption(ComputerPort))

  const pending = new Map<RequestId, PendingEntry>()
  /** Expiry timers of async requests (interrupted when answered or cancelled). */
  const timers = yield* FiberMap.make<RequestId>()
  const answers = yield* Queue.unbounded<DeliveryInput>()
  yield* Effect.addFinalizer(() => Queue.shutdown(answers))

  /** Atomically claims a pending request: exactly one of respond / expiry / cancel wins. */
  const takePending = (requestId: RequestId) =>
    Effect.sync(() => {
      const entry = pending.get(requestId)
      pending.delete(requestId)
      return Option.fromNullishOr(entry)
    })

  const getRequest = (requestId: RequestId) =>
    requests.get(requestId).pipe(
      Effect.orDie,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new NotFound({ entity: "request", id: requestId })),
          onSome: Effect.succeed,
        }),
      ),
    )

  const setCardState = (cardEntryId: EntryId, state: Extract<KnownTranscriptEntry, { kind: "card" }>["state"]) =>
    conversations
      .updateEntry(cardEntryId, (entry) => (entry.kind === "card" ? { ...entry, state } : entry))
      .pipe(
        Effect.asVoid,
        Effect.catch((error) => Effect.logWarning("ApprovalService: card not updated", error)),
      )

  /** Persists a terminal state of a request and its card (never fails). */
  const finish = (
    request: RuntimeRequest,
    patch: {
      readonly status: Exclude<RuntimeRequest["status"], "pending">
      readonly statusReason?: string | undefined
      readonly response?: RuntimeResponse | undefined
      readonly cardDetail?: string | undefined
    },
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const next: RuntimeRequest = {
        ...request,
        status: patch.status,
        resolvedAt: now,
        ...(patch.statusReason === undefined ? {} : { statusReason: patch.statusReason }),
        ...(patch.response === undefined ? {} : { response: patch.response }),
        ...(patch.status === "resolved" ? { resolvedBy: { kind: "user" as const, userId: OWNER_USER_ID } } : {}),
      }
      yield* conversations
        .upsertRequest(next)
        .pipe(Effect.catch((error) => Effect.logWarning("ApprovalService: request not persisted", error)))
      const cardStatus =
        patch.status === "resolved"
          ? patch.response?.type === "dismiss"
            ? ("dismissed" as const)
            : ("resolved" as const)
          : patch.status
      yield* setCardState(request.cardEntryId, {
        status: cardStatus,
        ...(patch.response === undefined ? {} : { response: patch.response }),
        ...(patch.cardDetail === undefined ? {} : { detail: patch.cardDetail }),
      })
      return next
    })

  /**
   * Persists a new pending request + its card in the conversation the bot works in (a group's cards
   * stay in the group), notifies.
   */
  const createRequest = (input: NewRequest) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const { approvalExpiryMinutes } = yield* inProfile(input.bot.ownerProfileId)(settings.get)
      const expiryMinutes = input.expiryMinutes ?? approvalExpiryMinutes
      const conversationId = input.originConversationId
      const requestId = yield* ids.requestId
      const cardEntryId = yield* ids.entryId
      const request: RuntimeRequest = {
        id: requestId,
        conversationId,
        botId: input.bot.id,
        cardEntryId,
        kind: input.kind,
        status: "pending",
        title: input.title,
        subject: input.subject,
        responseCapability: input.responseCapability,
        source: input.source,
        blocking: input.blocking,
        createdAt: now,
        expiresAt: now + expiryMinutes * 60_000,
        ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        ...(input.detail === undefined ? {} : { detail: input.detail }),
        ...(input.suggestedRule === undefined ? {} : { suggestedRule: input.suggestedRule }),
        ...(input.projectFolder === undefined ? {} : { projectFolder: input.projectFolder }),
        ...(input.task === undefined ? {} : { taskId: input.task.id }),
      }
      yield* conversations.upsertRequest(request)
      const card = input.card(requestId)
      const draft = {
        id: cardEntryId,
        kind: "card",
        conversationId,
        author: { kind: "bot", botId: input.bot.id },
        card:
          input.task !== undefined && (card.type === "approval" || card.type === "question")
            ? { ...card, taskTitle: input.task.title }
            : card,
        state: { status: "pending" },
        ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      } as EntryDraft
      yield* conversations.appendEntry(draft)
      yield* notifier.notify({
        kind: "waiting",
        botId: input.bot.id,
        conversationId,
        title: input.bot.name,
        body: `${notificationLead(input.kind)}: ${truncate(oneLine(input.title), 120)}`,
      })
      return request
    })

  // ------------------------------------------------------------------------ blocking requests

  /**
   * Waits for the user's answer or expiry. Interruption (turn interrupted / session closed) cancels
   * the request so its card never stays actionable.
   */
  const awaitOutcome = (
    request: RuntimeRequest,
    deferred: Deferred.Deferred<Outcome>,
    onExpire: HarnessRequestResolution,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const waitMs = Math.max(0, (request.expiresAt ?? now) - now)
      const answered = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(Duration.millis(waitMs)))
      if (Option.isSome(answered)) return answered.value
      const claimed = yield* takePending(request.id)
      if (Option.isNone(claimed)) return yield* Deferred.await(deferred) // respond/cancel won the race
      const latest = yield* requests.get(request.id).pipe(Effect.orDie, Effect.map(Option.getOrElse(() => request)))
      yield* finish(latest, { status: "expired", statusReason: "timeout" })
      return { by: "expired", resolution: onExpire } satisfies Outcome
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          const claimed = yield* takePending(request.id)
          if (Option.isNone(claimed)) return
          const latest = yield* requests.get(request.id).pipe(Effect.orDie, Effect.map(Option.getOrElse(() => request)))
          yield* finish(latest, { status: "cancelled", statusReason: "turn-ended" })
        }),
      ),
    )

  const askBlocking = (
    input: NewRequest,
    onPending: ApprovalContext["onPending"],
    onExpire: HarnessRequestResolution,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const request = yield* createRequest(input)
        const deferred = yield* Deferred.make<Outcome>()
        pending.set(request.id, { requestId: request.id, deferred })
        return yield* restore(
          Effect.gen(function* () {
            if (onPending !== undefined) yield* onPending(request)
            return yield* awaitOutcome(request, deferred, onExpire)
          }),
        ).pipe(
          // Interrupted before awaitOutcome installed its handler: still cancel the request.
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              const claimed = yield* takePending(request.id)
              if (Option.isSome(claimed)) yield* finish(request, { status: "cancelled", statusReason: "turn-ended" })
            }),
          ),
        )
      }),
    )

  /**
   * The turn an auto-decision belongs to: the context's, else the bot's running turn in that
   * conversation (node ceilings and gateway tools report no turn), so the UI can fold it into the
   * turn's steps.
   */
  const turnOf = (ctx: Pick<ApprovalContext, "bot" | "conversationId" | "turnId">) =>
    ctx.turnId !== undefined
      ? Effect.succeed<TurnId | undefined>(ctx.turnId)
      : turns.listActive.pipe(
          Effect.map(
            (active) =>
              active
                .filter(
                  (t) => t.botId === ctx.bot.id && t.conversationId === ctx.conversationId && t.status !== "queued",
                )
                .at(-1)?.id,
          ),
          Effect.orElseSucceed((): TurnId | undefined => undefined),
        )

  const autoDecided = (
    ctx: Pick<ApprovalContext, "bot" | "conversationId" | "turnId" | "recordDecision">,
    request: HarnessApprovalRequest,
    decision: "allowed" | "denied",
    by: { readonly rule: ApprovalRule | undefined } | { readonly autonomy: Bot["autonomy"] },
  ) => {
    const event = {
      type: "auto-decided" as const,
      decision,
      summary: truncate(oneLine(request.title), 200),
      toolName: request.toolName,
      ...("autonomy" in by ? { autonomy: by.autonomy } : by.rule === undefined ? {} : { ruleId: by.rule.id }),
      ...(request.toolKey === undefined ? {} : { toolKey: request.toolKey }),
    }
    // A background task's decisions are its steps, never lines in the conversation (D5.7).
    if (ctx.recordDecision !== undefined) {
      return ctx
        .recordDecision(event)
        .pipe(Effect.catchCause((cause) => Effect.logWarning("ApprovalService: auto-decided not recorded", cause)))
    }
    return Effect.flatMap(turnOf(ctx), (turnId) =>
      conversations.appendEvent({
        conversationId: ctx.conversationId,
        event,
        ...(turnId === undefined ? {} : { turnId }),
      }),
    ).pipe(
      Effect.asVoid,
      Effect.catch((error) => Effect.logWarning("ApprovalService: auto-decided not written", error)),
    )
  }

  const policySubject = (request: HarnessApprovalRequest): PolicySubject => ({
    surface: surfaceOf(request),
    toolName: request.toolName,
    command: request.command,
    paths: request.paths,
  })

  const approvalCard =
    (
      request: HarnessApprovalRequest,
      suggested: SuggestedRule,
      reason: string | undefined,
      projectFolder: string | undefined,
    ) =>
    (requestId: RequestId): KnownCard => ({
      type: "approval",
      requestId,
      requestKind: request.kind,
      title: request.title,
      toolName: request.toolName,
      suggestedRule: suggested,
      ...(request.detail.length === 0 ? {} : { summary: request.detail }),
      ...(request.command === undefined ? {} : { command: request.command }),
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.diff === undefined ? {} : { diff: request.diff }),
      ...(request.paths === undefined ? {} : { paths: request.paths }),
      ...(request.nodeId === undefined ? {} : { nodeId: request.nodeId }),
      ...(reason === undefined ? {} : { reason }),
      ...(projectFolder === undefined ? {} : { projectFolder }),
    })

  const approvalSubject = (request: HarnessApprovalRequest): RuntimeRequestSubject => ({
    toolName: request.toolName,
    ...(request.command === undefined ? {} : { command: request.command }),
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.paths === undefined ? {} : { paths: request.paths }),
    ...(request.diff === undefined ? {} : { diff: request.diff }),
    ...(request.server === undefined ? {} : { server: request.server }),
    ...(request.input === undefined ? {} : { input: request.input }),
    ...(request.nodeId === undefined ? {} : { nodeId: request.nodeId }),
  })

  /** The workspace path for rule suggestions when the request runs where the workspace is. */
  const suggestionWorkspace = (ctx: ApprovalContext, request: HarnessApprovalRequest): string | undefined => {
    const workspace = ctx.workspace
    if (workspace === undefined || (request.nodeId !== undefined && request.nodeId !== workspace.nodeId))
      return undefined
    return (request.paths ?? []).every((p) => isInsideWorkspace(workspace.path, p, request.cwd ?? workspace.path))
      ? workspace.path
      : undefined
  }

  /** The context's workspace plus the project folders (shared ∪ the bot's) and the node's home. */
  const autonomyWorkspace = (ctx: ApprovalContext) =>
    Effect.gen(function* () {
      const workspace = ctx.workspace
      if (workspace === undefined) return undefined
      const { sharedProjectFolders } = yield* inProfile(ctx.bot.ownerProfileId)(settings.get)
      const home = workspace.home ?? hostPaths?.home(workspace.nodeId)
      return {
        ...workspace,
        projectFolders: [...(workspace.projectFolders ?? []), ...sharedProjectFolders, ...ctx.bot.projectFolders],
        ...(home === undefined ? {} : { home }),
      } satisfies ApprovalWorkspace
    })

  /**
   * "Allow in ‹folder›" for a request that works outside every root: the git repo root around its
   * directory (when `HostPaths` knows it and it may be offered), else the directory itself.
   */
  const folderOffer = (request: HarnessApprovalRequest, workspace: ApprovalWorkspace | undefined) =>
    Effect.gen(function* () {
      if (workspace === undefined) return undefined
      const dir = outsideWorkDir(request, workspace)
      if (dir === undefined) return undefined
      const repo = hostPaths === undefined ? undefined : yield* hostPaths.projectRoot(workspace.nodeId, dir)
      if (repo !== undefined && offerableFolder(repo, workspace.home)) return normalizeProjectFolder(repo)
      return offerableFolder(dir, workspace.home) ? normalizeProjectFolder(dir) : undefined
    }).pipe(
      Effect.catchDefect((defect) =>
        Effect.logWarning("ApprovalService: no folder offer", defect).pipe(Effect.as(undefined)),
      ),
    )

  /**
   * Rules → allow / deny / ask; no matching rule → the bot's autonomy (when `applyAutonomy`) →
   * allow / ask (blocking).
   */
  const evaluateApproval = (
    ctx: ApprovalContext,
    request: HarnessApprovalRequest,
    source: RuntimeRequest["source"],
    applyAutonomy: boolean,
  ): Effect.Effect<Outcome, NotFound> =>
    Effect.gen(function* () {
      const subject = policySubject(request)
      const all = yield* rules.list({ profileId: ctx.bot.ownerProfileId, botId: ctx.bot.id }).pipe(Effect.orDie)
      const decision = evaluateRules(all, ctx.bot.id, subject)
      if (decision.action === "allow") {
        yield* autoDecided(ctx, request, "allowed", { rule: decision.rule })
        return { by: "rule", decision: "allow-once", resolution: { decision: "allow-once" } } satisfies Outcome
      }
      if (decision.action === "deny") {
        yield* autoDecided(ctx, request, "denied", { rule: decision.rule })
        return {
          by: "rule",
          decision: "deny",
          resolution: { decision: "deny", message: BLOCKED_BY_RULES },
        } satisfies Outcome
      }
      // An explicit "Ask first" rule always asks; only the default (no rule) defers to autonomy.
      let projectFolder: string | undefined
      if (applyAutonomy && decision.rule === undefined) {
        const workspace = yield* autonomyWorkspace(ctx)
        const autonomy = evaluateAutonomy(ctx.bot.autonomy, request, workspace)
        if (autonomy.action === "allow") {
          yield* autoDecided(ctx, request, "allowed", { autonomy: ctx.bot.autonomy })
          return { by: "rule", decision: "allow-once", resolution: { decision: "allow-once" } } satisfies Outcome
        }
        // Only "workspace" makes a project folder matter for what asks next time.
        if (ctx.bot.autonomy === "workspace") projectFolder = yield* folderOffer(request, workspace)
      }
      const suggested = suggestRule(subject, suggestionWorkspace(ctx, request))
      // "Always allow" must name a program: a shell command without one (`$EDITOR x`, a bare
      // relative path) would otherwise save a rule allowing EVERY command of the tool.
      const offerAlways = !(
        subject.surface === "shell" &&
        subject.command !== undefined &&
        suggested.match.commandPrefix === undefined
      )
      const reason =
        decision.rule === undefined ? undefined : `Paused by your Ask first rule: ${describeRule(decision.rule)}`
      return yield* askBlocking(
        {
          bot: ctx.bot,
          originConversationId: ctx.conversationId,
          turnId: ctx.turnId,
          kind: request.kind,
          title: request.title,
          detail: request.detail.length === 0 ? undefined : request.detail,
          subject: approvalSubject(request),
          responseCapability: { type: "decision", options: approvalOptions(request, offerAlways), allowMessage: true },
          suggestedRule: suggested,
          projectFolder,
          source,
          blocking: true,
          card: approvalCard(request, suggested, reason, projectFolder),
          task: ctx.task,
        },
        ctx.onPending,
        { decision: "deny", message: EXPIRED_MESSAGE },
      )
    })

  const evaluateQuestion = (
    ctx: ApprovalContext,
    request: HarnessQuestionRequest,
    source: RuntimeRequest["source"],
  ): Effect.Effect<Outcome, NotFound> =>
    askBlocking(
      {
        bot: ctx.bot,
        originConversationId: ctx.conversationId,
        turnId: ctx.turnId,
        kind: "question",
        title: request.title ?? request.questions[0]?.prompt ?? "Question",
        subject: {},
        responseCapability: { type: "answers", questions: request.questions },
        source,
        blocking: true,
        card: (requestId) => ({
          type: "question",
          requestId,
          questions: request.questions,
          ...(request.title === undefined ? {} : { title: request.title }),
        }),
        task: ctx.task,
      },
      ctx.onPending,
      { decision: "cancel", message: "The user did not answer in time." },
    )

  /** Errors and defects never escape `evaluate`: they deny (fail closed). */
  const failClosed = <R>(effect: Effect.Effect<Outcome, NotFound, R>) =>
    effect.pipe(
      Effect.catch((error) =>
        Effect.logWarning("ApprovalService: request could not be raised", error).pipe(
          Effect.as<Outcome>({
            by: "rule",
            resolution: { decision: "deny", message: `OpenBot could not ask the user (${error._tag}).` },
          }),
        ),
      ),
      Effect.catchDefect((defect) =>
        Effect.logError("ApprovalService: evaluation failed", defect).pipe(
          Effect.as<Outcome>({
            by: "rule",
            resolution: { decision: "deny", message: "OpenBot could not evaluate this request." },
          }),
        ),
      ),
    )

  const evaluate = (ctx: ApprovalContext, request: HarnessRequest) =>
    Effect.gen(function* () {
      const requestId = request.nativeRequestId
      const source = { origin: ctx.harness, method: request.kind, nativeRequestId: requestId ?? "" }
      const outcome = yield* failClosed(
        request.kind === "question"
          ? evaluateQuestion(ctx, request, source)
          : evaluateApproval(ctx, request, source, true),
      )
      return outcome.resolution
    })

  // ------------------------------------------------------------------------ node approvals

  const nodeRequest = (input: NodeApprovalInput): HarnessApprovalRequest => {
    const { action, target, reason } = input.request
    const node = input.nodeId
    const base = {
      toolName: `node.${action}`,
      detail: reason,
      nodeId: node,
      nativeRequestId: input.request.invocationId,
    }
    switch (action) {
      case "run-command":
        return {
          ...base,
          kind: "command-approval",
          surface: "shell",
          title: `Run a command on ${node}`,
          command: target,
        }
      case "write-file":
        return {
          ...base,
          kind: "file-approval",
          surface: "file-edit",
          title: `Change a file on ${node}`,
          paths: [target],
        }
      case "read-file":
        return {
          ...base,
          kind: "file-approval",
          surface: "file-read",
          title: `Read a file on ${node}`,
          paths: [target],
        }
      case "browser":
        return {
          ...base,
          kind: "tool-approval",
          surface: "browser",
          title: `Use the browser on ${node}: ${truncate(target, 120)}`,
        }
      default:
        return {
          ...base,
          kind: "tool-approval",
          surface: "other",
          title: `${action} on ${node}: ${truncate(target, 120)}`,
        }
    }
  }

  const evaluateNode = (input: NodeApprovalInput): Effect.Effect<NodeApprovalResponse> =>
    Effect.gen(function* () {
      const bot = yield* bots.get(input.request.botId as BotId).pipe(Effect.orDie)
      if (Option.isNone(bot)) return { decision: "deny", by: "rule" } as const
      const key = input.request.runId === undefined ? undefined : parseSessionKey(input.request.runId)
      const conversationId =
        key !== undefined && key.botId === bot.value.id ? key.conversationId : bot.value.directConversationId
      const request = nodeRequest(input)
      const outcome = yield* failClosed(
        evaluateApproval(
          { bot: bot.value, conversationId, harness: "openbot" },
          request,
          {
            origin: "openbot",
            method: "node.requestApproval",
            nativeRequestId: input.request.invocationId,
          },
          false,
        ),
      )
      const raw = outcome.decision ?? ("decision" in outcome.resolution ? outcome.resolution.decision : "deny")
      const decision: NodeApprovalResponse["decision"] =
        raw === "allow-always"
          ? "allow-always"
          : raw === "allow-once" || raw === "allow-session"
            ? "allow-once"
            : "deny"
      const by = outcome.by === "cancelled" ? "expired" : outcome.by
      return { decision, by }
    }).pipe(
      Effect.catchDefect((defect) =>
        Effect.logError("ApprovalService.evaluateNode failed", defect).pipe(
          Effect.as({ decision: "deny" as const, by: "rule" }),
        ),
      ),
    )

  // ------------------------------------------------------------------------ async tool requests (D3.3)

  const deliverAsync = (entry: PendingEntry, request: RuntimeRequest, text: string) =>
    entry.deliverTo === undefined
      ? Effect.void
      : Queue.offer(answers, {
          conversationId: entry.deliverTo.conversationId,
          botId: entry.deliverTo.botId,
          kind: "user-message",
          text,
          urgency: "urgent",
          sourceEntryId: request.cardEntryId,
        }).pipe(Effect.asVoid)

  /** The owner holds the bot's control lease right now (false without a ComputerPort or on error). */
  const ownerHoldsScreen = (botId: BotId) =>
    computer === undefined
      ? Effect.succeed(false)
      : computer.status(botId).pipe(
          Effect.map((status) => status.controller === "user"),
          Effect.orElseSucceed(() => false),
        )

  /**
   * Gives the bot its screen back when the owner holds it (answered hand-offs: the bot is about to
   * act on its screen again). Best effort: an unreachable node changes nothing here.
   */
  const handBackScreen = (botId: BotId) =>
    computer === undefined
      ? Effect.void
      : Effect.gen(function* () {
          if (!(yield* ownerHoldsScreen(botId))) return
          yield* computer.lease(botId, false)
        }).pipe(
          Effect.timeout(Duration.seconds(10)),
          Effect.catchCause((cause) => Effect.logWarning("ApprovalService: the screen was not handed back", cause)),
        )

  const expiredText = (request: RuntimeRequest, approvalExpiryMinutes: number): string => {
    const title = oneLine(request.title)
    switch (request.kind) {
      case "handoff":
        return `Nobody took over your screen for "${title}" within ${HANDOFF_EXPIRY_MINUTES} minutes; the request expired. Do not assume it was done.`
      case "question":
        return `Your question "${title}" expired without an answer after ${approvalExpiryMinutes} minutes. Do not assume an answer.`
      default:
        return `Your approval request "${title}" expired without an answer after ${approvalExpiryMinutes} minutes. Do not assume an answer.`
    }
  }

  const expireAsync = (requestId: RequestId): Effect.Effect<void> =>
    Effect.gen(function* () {
      const current = yield* getRequest(requestId)
      // a hand-off the owner is still working on (they hold the screen) waits another period
      if (
        current.kind === "handoff" &&
        current.status === "pending" &&
        pending.has(requestId) &&
        (yield* ownerHoldsScreen(current.botId))
      ) {
        const now = yield* Clock.currentTimeMillis
        yield* conversations
          .upsertRequest({ ...current, expiresAt: now + HANDOFF_EXPIRY_MINUTES * 60_000 })
          .pipe(Effect.catch((error) => Effect.logWarning("ApprovalService: hand-off expiry not extended", error)))
        yield* Effect.sleep(Duration.minutes(HANDOFF_EXPIRY_MINUTES))
        return yield* expireAsync(requestId)
      }
      const claimed = yield* takePending(requestId)
      if (Option.isNone(claimed)) return
      const request = yield* getRequest(requestId)
      const { approvalExpiryMinutes } = yield* inBotProfile(request.botId)(settings.get).pipe(
        Effect.provideService(BotRepo, bots),
      )
      yield* finish(request, { status: "expired", statusReason: "timeout" })
      yield* deliverAsync(claimed.value, request, expiredText(request, approvalExpiryMinutes))
    }).pipe(
      // the request went with its conversation: nothing left to expire
      Effect.catchTag("NotFound", () => Effect.asVoid(takePending(requestId))),
      Effect.catchDefect((defect) => Effect.logError("ApprovalService: expiry failed", defect)),
    )

  const resolveToolBot = (ctx: ToolContext) =>
    bots.get(ctx.claims.botId).pipe(
      Effect.orDie,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new InvalidInput({ message: "Unknown bot." })),
          onSome: Effect.succeed,
        }),
      ),
    )

  /** Same tool call id → the same request (D3.3 idempotency). */
  const existingReceipt = (ctx: ToolContext) =>
    ctx.callId === undefined
      ? Effect.succeed(Option.none<PendingRequestReceipt>())
      : requests
          .findByNativeId(ctx.claims.botId, ctx.callId)
          .pipe(
            Effect.orDie,
            Effect.map(Option.map((r): PendingRequestReceipt => ({ status: "pending", requestId: r.id }))),
          )

  const createAsync = (
    ctx: ToolContext,
    bot: Bot,
    input: Omit<NewRequest, "bot" | "originConversationId" | "blocking">,
  ) =>
    Effect.gen(function* () {
      const request = yield* createRequest({
        ...input,
        bot,
        originConversationId: ctx.claims.conversationId,
        blocking: false,
      }).pipe(
        Effect.catch((error) =>
          Effect.fail(new InvalidInput({ message: `Could not post the request: ${error._tag}.` })),
        ),
      )
      pending.set(request.id, {
        requestId: request.id,
        deliverTo: { conversationId: ctx.claims.conversationId, botId: bot.id },
      })
      const now = yield* Clock.currentTimeMillis
      yield* FiberMap.run(
        timers,
        request.id,
        Effect.sleep(Duration.millis(Math.max(0, (request.expiresAt ?? now) - now))).pipe(
          Effect.andThen(expireAsync(request.id)),
        ),
      )
      return { status: "pending", requestId: request.id } satisfies PendingRequestReceipt
    })

  const validateQuestions = (questions: ReadonlyArray<Question>) => {
    if (questions.length === 0) return "Ask at least one question."
    if (questions.length > ASK_LIMITS.questions) return `Ask at most ${ASK_LIMITS.questions} questions at once.`
    const seen = new Set<string>()
    for (const q of questions) {
      if (seen.has(q.id)) return `Duplicate question id "${q.id}".`
      seen.add(q.id)
      if (q.prompt.trim().length === 0) return `Question "${q.id}" has no prompt.`
      if (q.options.length > ASK_LIMITS.options)
        return `Question "${q.id}" has more than ${ASK_LIMITS.options} options.`
      if (q.options.length === 0 && !q.allowFreeText) return `Question "${q.id}" needs options or allowFreeText.`
    }
    return undefined
  }

  const askUser = (
    ctx: ToolContext,
    input: { readonly title?: string | undefined; readonly questions: ReadonlyArray<Question> },
  ) =>
    Effect.gen(function* () {
      const existing = yield* existingReceipt(ctx)
      if (Option.isSome(existing)) return existing.value
      const problem = validateQuestions(input.questions)
      if (problem !== undefined) return yield* new InvalidInput({ message: problem })
      const bot = yield* resolveToolBot(ctx)
      const title = input.title?.trim()
      return yield* createAsync(ctx, bot, {
        kind: "question",
        title: truncate(
          title !== undefined && title.length > 0 ? title : input.questions[0]!.prompt,
          ASK_LIMITS.titleChars,
        ),
        subject: { toolName: "ask_user" },
        responseCapability: { type: "answers", questions: input.questions },
        source: { origin: "openbot", method: "ask_user", nativeRequestId: ctx.callId ?? "" },
        card: (requestId) => ({
          type: "question",
          requestId,
          questions: input.questions,
          ...(title === undefined || title.length === 0 ? {} : { title }),
        }),
      })
    })

  const requestApproval = (
    ctx: ToolContext,
    input: {
      readonly title: string
      readonly detail?: string | undefined
      readonly command?: string | undefined
      readonly paths?: ReadonlyArray<string> | undefined
    },
  ) =>
    Effect.gen(function* () {
      const existing = yield* existingReceipt(ctx)
      if (Option.isSome(existing)) return existing.value
      const title = input.title.trim()
      if (title.length === 0)
        return yield* new InvalidInput({ message: "request_approval needs a title describing the action." })
      const bot = yield* resolveToolBot(ctx)
      const subject: RuntimeRequestSubject = {
        toolName: "request_approval",
        ...(input.command === undefined ? {} : { command: input.command }),
        ...(input.paths === undefined ? {} : { paths: input.paths }),
      }
      return yield* createAsync(ctx, bot, {
        kind: "mcp-approval",
        title: truncate(title, ASK_LIMITS.titleChars),
        detail: input.detail,
        subject,
        // The bot explicitly asked the owner: no rule can stand in for that, so no "Always allow".
        responseCapability: { type: "decision", options: approvalOptions({}, false), allowMessage: true },
        source: { origin: "openbot", method: "request_approval", nativeRequestId: ctx.callId ?? "" },
        card: (requestId) => ({
          type: "approval",
          requestId,
          requestKind: "mcp-approval",
          title: truncate(title, ASK_LIMITS.titleChars),
          toolName: "request_approval",
          ...(input.detail === undefined ? {} : { summary: input.detail }),
          ...(input.command === undefined ? {} : { command: input.command }),
          ...(input.paths === undefined ? {} : { paths: input.paths }),
        }),
      })
    })

  const requestTakeover = (ctx: ToolContext, input: { readonly instruction: string }) =>
    Effect.gen(function* () {
      if (ctx.taskId !== undefined) {
        return yield* new InvalidInput({
          message: "Background work cannot hand the screen to the owner. Say what you need from them in your result.",
        })
      }
      const existing = yield* existingReceipt(ctx)
      if (Option.isSome(existing)) return existing.value
      const instruction = input.instruction.trim()
      if (instruction.length === 0) {
        return yield* new InvalidInput({
          message: "request_takeover needs an instruction: what the owner should do on your screen.",
        })
      }
      if (instruction.length > ASK_LIMITS.instructionChars) {
        return yield* new InvalidInput({
          message: `Keep the instruction under ${ASK_LIMITS.instructionChars} characters.`,
        })
      }
      const bot = yield* resolveToolBot(ctx)
      const nodeId = ctx.claims.hostNodeId
      return yield* createAsync(ctx, bot, {
        kind: "handoff",
        title: truncate(oneLine(instruction), ASK_LIMITS.titleChars),
        subject: { toolName: "request_takeover", nodeId },
        // "Take over" is the computer lease (`computer.lease`), not an answer: the card stays open
        responseCapability: { type: "acknowledge", actions: ["done", "skip"] },
        source: { origin: "openbot", method: "request_takeover", nativeRequestId: ctx.callId ?? "" },
        expiryMinutes: HANDOFF_EXPIRY_MINUTES,
        card: (requestId) => ({ type: "handoff", requestId, nodeId, instruction }),
      })
    })

  /**
   * The owner handed the bot's screen back: every pending hand-off of the bot is answered `done`
   * (the card closes as "Done" and the bot is told).
   */
  const answerHandoffs = (botId: BotId) =>
    Effect.gen(function* () {
      const open = (yield* requests.list({ statuses: ["pending"], botId }).pipe(Effect.orDie)).filter(
        (r) => r.kind === "handoff" && !r.blocking && pending.has(r.id),
      )
      for (const request of open) {
        yield* Effect.ignore(respond({ requestId: request.id, response: { type: "acknowledge", action: "done" } }))
      }
    }).pipe(Effect.catchDefect((defect) => Effect.logError("ApprovalService: hand-offs not answered", defect)))

  // ------------------------------------------------------------------------ respond

  interface Interpreted {
    readonly stored: RuntimeResponse
    readonly decision?: DecisionId | undefined
    readonly resolution: HarnessRequestResolution
    readonly status: "resolved" | "cancelled"
    readonly statusReason?: string | undefined
  }

  const invalid = (message: string) => Effect.fail(new InvalidInput({ message }))

  /** Checks a response against the request's capability and maps it for the harness. */
  const interpret = (
    request: RuntimeRequest,
    response: RuntimeResponseInput,
  ): Effect.Effect<Interpreted, InvalidInput> => {
    if (response.type === "dismiss") {
      return Effect.succeed({
        stored: response,
        decision: "deny",
        resolution:
          request.kind === "question" ? cancelResolution : { decision: "deny", message: "Dismissed by the user." },
        status: "cancelled",
        statusReason: "dismissed",
      })
    }
    const capability = request.responseCapability
    switch (capability.type) {
      case "decision": {
        if (response.type !== "decision") return invalid(`This request expects a decision, not "${response.type}".`)
        const option = capability.options.find((o) => o.id === response.decision)
        if (option === undefined && response.decision !== "deny") {
          return invalid(`"${response.decision}" is not offered for this request.`)
        }
        if (response.message !== undefined && !capability.allowMessage)
          return invalid("This request does not take a message.")
        if (response.scope === "project-folder") {
          if (request.projectFolder === undefined) return invalid("This request does not offer a project folder.")
          if (response.decision !== "allow-once") return invalid("“Allow in folder” allows once and adds the folder.")
        }
        // OpenBot owns "Always allow" (the saved rule); the harness only gets a one-time allow.
        const forHarness: DecisionId = response.decision === "allow-always" ? "allow-once" : response.decision
        return Effect.succeed({
          stored: response,
          decision: response.decision,
          resolution: {
            decision: forHarness,
            ...(response.message === undefined ? {} : { message: response.message }),
            ...(response.updatedInput === undefined ? {} : { updatedInput: response.updatedInput }),
            ...(option?.native === undefined ? {} : { native: option.native }),
          },
          status: "resolved",
        })
      }
      case "answers": {
        if (response.type !== "answers") return invalid(`This request expects answers, not "${response.type}".`)
        const harnessAnswers: Record<string, string | ReadonlyArray<string>> = {}
        const stored: Record<string, ReadonlyArray<string>> = {}
        for (const q of capability.questions) {
          const values = (response.answers[q.id] ?? []).filter((v) => v.length > 0)
          if (values.length === 0) return invalid(`Question "${q.id}" has no answer.`)
          if (!q.multiSelect && values.length > 1) return invalid(`Question "${q.id}" takes one answer.`)
          if (!q.allowFreeText && !values.every((v) => q.options.some((o) => o.label === v))) {
            return invalid(`Question "${q.id}" only accepts its options.`)
          }
          harnessAnswers[q.id] = q.multiSelect ? values : values[0]!
          stored[q.id] = q.isSecret === true ? ["(provided)"] : values
        }
        return Effect.succeed({
          stored: { type: "answers", answers: stored },
          resolution: { answers: harnessAnswers },
          status: "resolved",
        })
      }
      case "form": {
        if (response.type !== "form") return invalid(`This request expects a form, not "${response.type}".`)
        const harnessAnswers: Record<string, string> = {}
        for (const field of capability.fields) {
          const value = response.values[field.key]
          if (value === undefined || value === null || value === "") {
            if (field.required) return invalid(`"${field.label}" is required.`)
            continue
          }
          harnessAnswers[field.key] = typeof value === "string" ? value : JSON.stringify(value)
        }
        return Effect.succeed({ stored: response, resolution: { answers: harnessAnswers }, status: "resolved" })
      }
      case "secret": {
        if (response.type !== "secret") return invalid(`This request expects a secret, not "${response.type}".`)
        if (!("value" in response) || response.value.length === 0) return invalid("The secret value is missing.")
        // The value goes to the asking harness only; it is never stored or streamed.
        return Effect.succeed({
          stored: { type: "secret", provided: true },
          resolution: { answers: { [capability.envVar ?? "secret"]: response.value } },
          status: "resolved",
        })
      }
      case "acknowledge": {
        if (response.type !== "acknowledge")
          return invalid(`This request expects an acknowledgement, not "${response.type}".`)
        if (!capability.actions.includes(response.action))
          return invalid(`"${response.action}" is not offered for this request.`)
        return Effect.succeed({
          stored: response,
          resolution: { decision: response.action === "skip" ? "deny" : "allow-once" },
          status: "resolved",
        })
      }
    }
  }

  const saveAlwaysRule = (request: RuntimeRequest) =>
    Effect.gen(function* () {
      const suggested: SuggestedRule = request.suggestedRule ?? {
        surface: "other",
        match: request.subject.toolName === undefined ? {} : { toolName: request.subject.toolName },
      }
      const bot = yield* Effect.orDie(required(bots.get(request.botId), "bot", request.botId))
      const rule: ApprovalRule = {
        id: yield* ids.ruleId,
        ownerProfileId: bot.ownerProfileId,
        botId: request.botId,
        surface: suggested.surface,
        match: suggested.match,
        action: "allow",
        origin: "always-allow",
        createdAt: yield* Clock.currentTimeMillis,
      }
      yield* rules.upsert(rule).pipe(Effect.orDie)
      return rule
    })

  /** Adds `folder` to the bot's project folders (no-op when present) and publishes the bot. */
  const addProjectFolder = (botId: BotId, folder: string) =>
    Effect.gen(function* () {
      const found = yield* bots.get(botId).pipe(Effect.orDie)
      if (Option.isNone(found)) return undefined
      const bot = found.value
      if (bot.projectFolders.includes(folder)) return bot
      const next: Bot = {
        ...bot,
        projectFolders: [...bot.projectFolders, folder],
        updatedAt: yield* Clock.currentTimeMillis,
      }
      yield* bots.upsert(next).pipe(Effect.orDie)
      yield* hub.publishRoster({ type: "bot.upserted", bot: next })
      return next
    })

  const asyncAnswerText = (request: RuntimeRequest, interpreted: Interpreted): string => {
    const title = oneLine(request.title)
    if (interpreted.status === "cancelled") return `The user dismissed your request "${title}" without answering.`
    const stored = interpreted.stored
    if (request.kind === "handoff" && stored.type === "acknowledge") {
      return stored.action === "skip"
        ? `${HANDOFF_SKIP_TEXT} (You asked: "${title}".) Carry on without it if you can, or tell them what you still need.`
        : `${HANDOFF_DONE_TEXT} (You asked: "${title}".) Look at the screen again before you continue.`
    }
    if (stored.type === "answers" && request.responseCapability.type === "answers") {
      return `The user answered your question "${title}":\n${answersText(request.responseCapability.questions, stored.answers)}`
    }
    if (stored.type === "decision") {
      const verdict = stored.decision === "deny" || stored.decision === "cancel" ? "denied" : "approved"
      const note =
        stored.message === undefined || stored.message.trim().length === 0
          ? ""
          : `\nTheir note: ${stored.message.trim()}`
      return `The user ${verdict} your request "${title}".${note}`
    }
    return `The user responded to your request "${title}".`
  }

  const respond = (input: { readonly requestId: RequestId; readonly response: RuntimeResponseInput }) =>
    Effect.gen(function* () {
      const request = yield* getRequest(input.requestId)
      if (request.status !== "pending") {
        return yield* new RequestNotPending({ requestId: request.id, status: request.status })
      }
      const interpreted = yield* interpret(request, input.response)
      const claimed = yield* takePending(request.id)
      if (Option.isNone(claimed)) {
        // Pending in storage but no live waiter (e.g. raised before a restart): not resumable.
        yield* finish(request, { status: "expired", statusReason: "not_resumable" })
        return yield* new RequestNotPending({ requestId: request.id, status: "expired" })
      }
      const entry = claimed.value
      const outcome: Outcome = { by: "user", decision: interpreted.decision, resolution: interpreted.resolution }
      return yield* Effect.gen(function* () {
        yield* FiberMap.remove(timers, request.id)
        let cardDetail: string | undefined
        if (interpreted.decision === "allow-always" && interpreted.status === "resolved") {
          const rule = yield* saveAlwaysRule(request)
          cardDetail = `Added to your Allow rules: ${describeRule(rule)}`
        } else if (
          interpreted.stored.type === "decision" &&
          interpreted.stored.scope === "project-folder" &&
          request.projectFolder !== undefined &&
          interpreted.status === "resolved"
        ) {
          const bot = yield* addProjectFolder(request.botId, request.projectFolder)
          cardDetail = `Added ${request.projectFolder} to ${bot?.name ?? "the Bot"}'s project folders`
        } else if (interpreted.decision === "deny" && interpreted.status === "resolved") {
          cardDetail = "Denied"
        }
        const next = yield* finish(request, {
          status: interpreted.status,
          statusReason: interpreted.statusReason,
          response: interpreted.stored,
          cardDetail,
        })
        // an answered hand-off gives the screen back first: the bot acts on it as soon as it is told
        if (request.kind === "handoff") yield* handBackScreen(request.botId)
        yield* deliverAsync(entry, request, asyncAnswerText(request, interpreted))
        return next
      }).pipe(
        // The waiter is released even if persisting failed (it must never hang).
        Effect.ensuring(entry.deferred === undefined ? Effect.void : Deferred.succeed(entry.deferred, outcome)),
      )
    })

  // ------------------------------------------------------------------------ cancel

  const cancelPending = (input: {
    readonly botId?: BotId | undefined
    readonly conversationId?: ConversationId | undefined
    readonly turnId?: TurnId | undefined
    readonly taskId?: TaskId | undefined
    readonly kinds?: ReadonlyArray<RuntimeRequest["kind"]> | undefined
    readonly asyncOnly?: boolean | undefined
    readonly reason: string
    readonly cardDetail?: string | undefined
  }) =>
    Effect.gen(function* () {
      const matching = (yield* requests
        .list({
          statuses: ["pending"],
          ...(input.botId === undefined ? {} : { botId: input.botId }),
          ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
          ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        })
        .pipe(Effect.orDie)).filter(
        (r) =>
          (input.taskId === undefined || r.taskId === input.taskId) &&
          (input.kinds === undefined || input.kinds.includes(r.kind)) &&
          (input.asyncOnly !== true || !r.blocking),
      )
      let count = 0
      for (const request of matching) {
        const claimed = yield* takePending(request.id)
        yield* FiberMap.remove(timers, request.id)
        yield* finish(request, { status: "cancelled", statusReason: input.reason, cardDetail: input.cardDetail })
        if (Option.isSome(claimed) && claimed.value.deferred !== undefined) {
          yield* Deferred.succeed(claimed.value.deferred, { by: "cancelled", resolution: cancelResolution })
        }
        count++
      }
      return count
    }).pipe(
      Effect.catchDefect((defect) =>
        Effect.logError("ApprovalService.cancelPending failed", defect).pipe(Effect.as(0)),
      ),
    )

  // the owner handed the screen back (computer view "I'm done"): pending hand-offs are done
  if (computer !== undefined) {
    yield* computer.leaseChanges.pipe(
      Stream.runForEach((change) =>
        change.holder === "bot" && change.cause === "lease" ? answerHandoffs(change.botId) : Effect.void,
      ),
      Effect.catchCause((cause) => Effect.logWarning("ApprovalService: lease changes ended", cause)),
      Effect.forkScoped({ startImmediately: true }),
    )
  }

  return ApprovalService.of({
    evaluate,
    evaluateNode,
    respond,
    listPending: ({ conversationId }) =>
      Effect.gen(function* () {
        const profileBots = new Set((yield* bots.listIn(yield* currentProfileId).pipe(Effect.orDie)).map((b) => b.id))
        const pending = yield* requests
          .list({ statuses: ["pending"], ...(conversationId === undefined ? {} : { conversationId }) })
          .pipe(Effect.orDie)
        return pending.filter((request) => profileBots.has(request.botId))
      }),
    askUser,
    requestApproval,
    requestTakeover,
    asyncAnswers: Stream.fromQueue(answers),
    cancelPending,
  })
})

/**
 * `HostPaths` and `ComputerPort` are optional (read with `Effect.serviceOption`): without HostPaths
 * `~` is never expanded; without ComputerPort hand-offs do not follow the owner's control lease.
 */
export const ApprovalServiceLive: Layer.Layer<
  ApprovalService,
  never,
  | ConversationService
  | SettingsService
  | Notifier
  | RequestRepo
  | ApprovalRuleRepo
  | BotRepo
  | TurnRepo
  | IdGen
  | LiveHub
> = Layer.effect(ApprovalService, makeApprovalService)

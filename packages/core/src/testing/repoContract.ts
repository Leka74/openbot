/**
 * Repository contract suite: the behavior every implementation of the repository/store ports must
 * have. Framework-agnostic (no `bun:test` import) so `@openbot/persistence` can run the exact same
 * cases against SQLite:
 *
 * ```ts
 * import { repoContractCases } from "@openbot/core/testing"
 * for (const c of repoContractCases) test(c.name, () => Effect.runPromise(Effect.provide(c.run, layer)))
 * ```
 *
 * Each case expects FRESH (empty) repositories. Failures are `ContractViolation` errors.
 */
import type {
  ApprovalRuleId,
  MemoryFactId,
  Millis,
  NotificationId,
  OwnerProfileId,
  SkillName,
  StreamCursor,
} from "@openbot/contracts"
import { MAIN_PROFILE_ID } from "@openbot/contracts"
import { Data, Effect, Option, Result } from "effect"
import { McpTokenRepo } from "../ports/Mcp.ts"
import { BootRecovery } from "../ports/Persistence.ts"
import { ProcessLedger } from "../ports/ProcessLedger.ts"
import { HeldNotificationRepo, inProfile } from "../ports/Profiles.ts"
import {
  ApprovalRuleRepo,
  BotRepo,
  conversationReplicaKey,
  ConversationRepo,
  EntryRepo,
  NodeRepo,
  type NodeRecord,
  REPLICA_LOG_WINDOW,
  ReplicaLog,
  type ReplicaRecord,
  RequestRepo,
  RoutineRepo,
  SectionRepo,
  SettingsRepo,
  TaskRepo,
  TurnRepo,
  UsageRepo,
} from "../ports/repos.ts"
import { AttachmentStore, MemoryStore, SkillStore } from "../ports/stores.ts"
import {
  OTHER_PROFILE,
  botId,
  conversationId,
  entryId,
  makeBot,
  makeCardEntry,
  makeClaims,
  makeDirectConversation,
  makeEventEntry,
  makeGroupConversation,
  makeMessageEntry,
  makeRequest,
  makeRoutine,
  makeRoutineRun,
  makeRule,
  makeSection,
  makeTask,
  makeToolCallEntry,
  makeTurn,
  nodeId,
  requestId,
  routineId,
  routineRunId,
  sectionId,
  taskId,
  turnId,
} from "./builders.ts"
import type { RepositoryPorts } from "../ports/Persistence.ts"

export class ContractViolation extends Data.TaggedError("ContractViolation")<{ readonly message: string }> {}

export interface RepoContractCase {
  readonly name: string
  readonly run: Effect.Effect<void, unknown, RepositoryPorts>
}

// ---------------------------------------------------------------------------- assertions

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  )

const equal = (actual: unknown, expected: unknown, label: string) =>
  stable(actual) === stable(expected)
    ? Effect.void
    : Effect.fail(new ContractViolation({ message: `${label}: expected ${stable(expected)}, got ${stable(actual)}` }))

const ok = (condition: boolean, label: string) =>
  condition ? Effect.void : Effect.fail(new ContractViolation({ message: label }))

const some = <A>(option: Option.Option<A>, label: string): Effect.Effect<A, ContractViolation> =>
  Option.isSome(option)
    ? Effect.succeed(option.value)
    : Effect.fail(new ContractViolation({ message: `${label}: expected some` }))

const none = <A>(option: Option.Option<A>, label: string) => ok(Option.isNone(option), `${label}: expected none`)

const ids = (xs: ReadonlyArray<{ readonly id: string }>) => xs.map((x) => x.id)

const contractCase = (name: string, run: Effect.Effect<void, unknown, RepositoryPorts>): RepoContractCase => ({
  name,
  run,
})

// ---------------------------------------------------------------------------- cases

const nodeRecord = (id: string, overrides?: Partial<NodeRecord>): NodeRecord => ({
  id: nodeId(id),
  label: id,
  kind: "remote",
  publicKey: `key-${id}`,
  declaredCapabilities: ["fs@1"],
  approvedCapabilities: [],
  platform: "linux",
  hostname: id,
  roots: ["/srv"],
  createdAt: 0,
  ...overrides,
})

export const repoContractCases: ReadonlyArray<RepoContractCase> = [
  contractCase(
    "BotRepo: upsert, get, list by createdAt, delete",
    Effect.gen(function* () {
      const repo = yield* BotRepo
      yield* repo.upsert(makeBot({ id: botId("bot_b"), createdAt: 2 }))
      yield* repo.upsert(makeBot({ id: botId("bot_a"), createdAt: 1 }))
      yield* repo.upsert(makeBot({ id: botId("bot_b"), createdAt: 2, name: "Renamed" }))
      yield* repo.upsert(makeBot({ id: botId("bot_other"), ownerProfileId: OTHER_PROFILE, createdAt: 3 }))
      yield* equal(ids(yield* repo.list), ["bot_a", "bot_b", "bot_other"], "list order")
      yield* equal(ids(yield* repo.listIn(MAIN_PROFILE_ID)), ["bot_a", "bot_b"], "one profile")
      yield* equal(ids(yield* repo.listIn(OTHER_PROFILE)), ["bot_other"], "another profile")
      yield* equal((yield* some(yield* repo.get(botId("bot_b")), "get")).name, "Renamed", "upsert replaces")
      yield* equal(yield* repo.delete(botId("bot_a")), true, "delete existing")
      yield* equal(yield* repo.delete(botId("bot_a")), false, "delete missing")
      yield* none(yield* repo.get(botId("bot_a")), "deleted bot")
    }),
  ),

  contractCase(
    "SectionRepo: list ordered by order then id",
    Effect.gen(function* () {
      const repo = yield* SectionRepo
      yield* repo.upsert(makeSection({ id: sectionId("sec_c"), order: 1 }))
      yield* repo.upsert(makeSection({ id: sectionId("sec_b"), order: 0 }))
      yield* repo.upsert(makeSection({ id: sectionId("sec_a"), order: 1 }))
      yield* repo.upsert(makeSection({ id: sectionId("sec_other"), ownerProfileId: OTHER_PROFILE, order: 0 }))
      yield* equal(ids(yield* repo.list(MAIN_PROFILE_ID)), ["sec_b", "sec_a", "sec_c"], "order")
      yield* equal(ids(yield* repo.list(OTHER_PROFILE)), ["sec_other"], "another profile's")
      yield* repo.delete(sectionId("sec_b"))
      yield* none(yield* repo.get(sectionId("sec_b")), "deleted section")
    }),
  ),

  contractCase(
    "ConversationRepo: filters, ordering, members",
    Effect.gen(function* () {
      const repo = yield* ConversationRepo
      yield* repo.upsert(
        makeDirectConversation({ id: conversationId("cnv_dm"), botId: botId("bot_a"), lastActivityAt: 5 }),
      )
      yield* repo.upsert(
        makeGroupConversation({
          id: conversationId("cnv_group"),
          memberBotIds: [botId("bot_a"), botId("bot_b")],
          lastActivityAt: 9,
        }),
      )
      yield* repo.upsert(
        makeDirectConversation({
          id: conversationId("cnv_hidden"),
          botId: botId("bot_b"),
          lastActivityAt: 7,
          hiddenFromSidebar: true,
        }),
      )
      yield* equal(ids(yield* repo.list()), ["cnv_group", "cnv_hidden", "cnv_dm"], "lastActivityAt desc")
      yield* equal(ids(yield* repo.list({ botId: botId("bot_a") })), ["cnv_group", "cnv_dm"], "by bot")
      yield* equal(ids(yield* repo.list({ kind: "direct" })), ["cnv_hidden", "cnv_dm"], "by kind")
      yield* equal(ids(yield* repo.list({ includeHidden: false })), ["cnv_group", "cnv_dm"], "without hidden")
      yield* equal(yield* repo.members(conversationId("cnv_group")), ["bot_a", "bot_b"], "group members")
      yield* equal(yield* repo.members(conversationId("cnv_dm")), ["bot_a"], "direct members")
      // membership index follows upserts
      yield* repo.upsert(
        makeGroupConversation({
          id: conversationId("cnv_group"),
          memberBotIds: [botId("bot_b"), botId("bot_c")],
          lastActivityAt: 9,
        }),
      )
      yield* equal(ids(yield* repo.list({ botId: botId("bot_a") })), ["cnv_dm"], "member removed")
    }),
  ),

  contractCase(
    "BotRepo: one native session per bot",
    Effect.gen(function* () {
      const repo = yield* BotRepo
      const a = botId("bot_a")
      yield* repo.upsert(makeBot({ id: a, createdAt: 1 }))
      yield* none(yield* repo.getSession(a), "no session yet")
      yield* repo.setSession({ botId: a, driver: "claude", nativeSessionId: "s1", updatedAt: 1 })
      yield* repo.setSession({
        botId: a,
        driver: "claude",
        nativeSessionId: "s2",
        seen: { cnv_group: entryId("ent_9") },
        lastConversationId: conversationId("cnv_group"),
        updatedAt: 2,
      })
      const stored = yield* some(yield* repo.getSession(a), "session")
      yield* equal(stored.nativeSessionId, "s2", "replaced")
      yield* equal(stored.seen, { cnv_group: "ent_9" }, "seen cursors kept")
      yield* equal(stored.lastConversationId, "cnv_group", "last conversation kept")
      yield* repo.clearSession(a)
      yield* none(yield* repo.getSession(a), "cleared")
      yield* repo.setSession({ botId: a, driver: "codex", nativeSessionId: "t1", updatedAt: 3 })
      yield* repo.delete(a)
      yield* none(yield* repo.getSession(a), "bot delete removes its session")
    }),
  ),

  contractCase(
    "EntryRepo: revision guard",
    Effect.gen(function* () {
      const repo = yield* EntryRepo
      const first = yield* repo.upsert(
        makeMessageEntry({ id: entryId("ent_1"), revision: 0, text: "a", createdAt: 10 }),
      )
      yield* ok(first.applied, "insert applied")
      const newer = yield* repo.upsert(
        makeMessageEntry({ id: entryId("ent_1"), revision: 2, text: "c", createdAt: 10 }),
      )
      yield* ok(newer.applied, "higher revision applied")
      const stale = yield* repo.upsert(
        makeMessageEntry({ id: entryId("ent_1"), revision: 1, text: "b", createdAt: 10 }),
      )
      yield* ok(!stale.applied, "lower revision rejected")
      if (!stale.applied) yield* equal(stale.current.revision, 2, "stale returns current")
      const same = yield* repo.upsert(makeMessageEntry({ id: entryId("ent_1"), revision: 2, text: "d", createdAt: 10 }))
      yield* ok(!same.applied, "equal revision rejected")
      const stored = yield* some(yield* repo.get(entryId("ent_1")), "get")
      yield* equal(stored.kind === "message" ? stored.text : undefined, "c", "stored text")
    }),
  ),

  contractCase(
    "EntryRepo: paging by cursor (oldest first)",
    Effect.gen(function* () {
      const repo = yield* EntryRepo
      const cnv = conversationId("cnv_page")
      for (let i = 1; i <= 7; i++) {
        yield* repo.upsert(
          makeMessageEntry({ id: entryId(`ent_${i}`), conversationId: cnv, createdAt: i * 10, text: `m${i}` }),
        )
      }
      yield* repo.upsert(
        makeMessageEntry({ id: entryId("ent_other"), conversationId: conversationId("cnv_x"), createdAt: 1 }),
      )
      const tail = yield* repo.page({ conversationId: cnv, limit: 3 })
      yield* equal(ids(tail.entries), ["ent_5", "ent_6", "ent_7"], "tail")
      yield* ok(tail.hasMoreBefore && tail.beforeCursor !== null, "tail has more")
      yield* equal(tail.precedingTimestamp, 40, "precedingTimestamp")
      const middle = yield* repo.page({ conversationId: cnv, before: tail.beforeCursor!, limit: 3 })
      yield* equal(ids(middle.entries), ["ent_2", "ent_3", "ent_4"], "middle page")
      const first = yield* repo.page({ conversationId: cnv, before: middle.beforeCursor!, limit: 3 })
      yield* equal(ids(first.entries), ["ent_1"], "first page")
      yield* ok(!first.hasMoreBefore && first.beforeCursor === null, "no more before")
      const all = yield* repo.page({ conversationId: cnv, limit: 100 })
      yield* equal(all.entries.length, 7, "page is per conversation")
      yield* ok(!all.hasMoreBefore, "everything fits")
    }),
  ),

  contractCase(
    "EntryRepo: ties on createdAt order by id; createdAt is immutable",
    Effect.gen(function* () {
      const repo = yield* EntryRepo
      const cnv = conversationId("cnv_tie")
      yield* repo.upsert(makeMessageEntry({ id: entryId("ent_b"), conversationId: cnv, createdAt: 5 }))
      yield* repo.upsert(makeMessageEntry({ id: entryId("ent_a"), conversationId: cnv, createdAt: 5 }))
      yield* repo.upsert(makeMessageEntry({ id: entryId("ent_c"), conversationId: cnv, createdAt: 5 }))
      const page = yield* repo.page({ conversationId: cnv, limit: 2 })
      yield* equal(ids(page.entries), ["ent_b", "ent_c"], "tie order")
      const rest = yield* repo.page({ conversationId: cnv, before: page.beforeCursor!, limit: 2 })
      yield* equal(ids(rest.entries), ["ent_a"], "tie page")
      yield* repo.upsert(makeMessageEntry({ id: entryId("ent_a"), conversationId: cnv, createdAt: 99, revision: 1 }))
      yield* equal((yield* some(yield* repo.get(entryId("ent_a")), "get")).createdAt, 5, "createdAt kept")
    }),
  ),

  contractCase(
    "EntryRepo: listExchange (the messages two bots sent each other, both directions)",
    Effect.gen(function* () {
      const repo = yield* EntryRepo
      const [a, b, c] = [botId("bot_xa"), botId("bot_xb"), botId("bot_xc")]
      const [dmA, dmB] = [conversationId("cnv_xa"), conversationId("cnv_xb")]
      const message = (id: string, conversation: typeof dmA, createdAt: number, from: typeof a, to?: typeof a) =>
        repo.upsert(
          makeMessageEntry({
            id: entryId(id),
            conversationId: conversation,
            createdAt,
            role: "bot",
            author: { kind: "bot", botId: from },
            ...(to === undefined ? {} : { toBotId: to }),
          }),
        )
      // b → a lives in a's DM, a → b in b's
      yield* message("ent_x1", dmA, 10, b, a)
      yield* message("ent_x2", dmB, 20, a, b)
      yield* message("ent_x4", dmB, 30, a, b)
      yield* message("ent_x3", dmA, 30, b, a)
      yield* message("ent_x5", dmB, 40, a, b)
      // not part of it: a's reply to the owner, c → a, a → b elsewhere, a tool call
      yield* message("ent_n1", dmA, 15, a)
      yield* message("ent_n2", dmA, 25, c, a)
      yield* message("ent_n3", conversationId("cnv_xg"), 35, a, b)
      yield* repo.upsert(
        makeToolCallEntry({
          id: entryId("ent_n4"),
          conversationId: dmA,
          createdAt: 12,
          author: { kind: "bot", botId: a },
        }),
      )
      const query = { botIds: [a, b] as const, conversationIds: [dmA, dmB] }
      const newest = yield* repo.listExchange({ ...query, direction: "older", limit: 2 })
      yield* equal(ids(newest.entries), ["ent_x4", "ent_x5"], "the newest, oldest first")
      yield* ok(newest.more, "more older")
      const older = yield* repo.listExchange({
        ...query,
        direction: "older",
        from: { createdAt: 30, id: "ent_x4" },
        limit: 5,
      })
      yield* equal(ids(older.entries), ["ent_x1", "ent_x2", "ent_x3"], "before a position (ties by id)")
      yield* ok(!older.more, "nothing older")
      const newer = yield* repo.listExchange({
        ...query,
        direction: "newer",
        from: { createdAt: 20, id: "ent_x2" },
        limit: 2,
      })
      yield* equal(ids(newer.entries), ["ent_x3", "ent_x4"], "after a position")
      yield* ok(newer.more, "more newer")
      const all = yield* repo.listExchange({ ...query, direction: "newer", limit: 10 })
      yield* equal(ids(all.entries), ["ent_x1", "ent_x2", "ent_x3", "ent_x4", "ent_x5"], "from the oldest")
      yield* ok(!all.more, "nothing newer")
      const swapped = yield* repo.listExchange({
        botIds: [b, a],
        conversationIds: [dmB, dmA],
        direction: "older",
        limit: 10,
      })
      yield* equal(ids(swapped.entries), ids(all.entries), "either bot first")
    }),
  ),

  contractCase(
    "EntryRepo: lookups (listAfter, clientNonce, nativeId, turn) and remove",
    Effect.gen(function* () {
      const repo = yield* EntryRepo
      const cnv = conversationId("cnv_find")
      yield* repo.upsert(
        makeMessageEntry({ id: entryId("ent_1"), conversationId: cnv, createdAt: 1, clientNonce: "n1" }),
      )
      yield* repo.upsert(
        makeMessageEntry({
          id: entryId("ent_2"),
          conversationId: cnv,
          createdAt: 2,
          role: "bot",
          author: { kind: "bot", botId: botId("bot_a") },
          turnId: turnId("trn_1"),
          harnessRef: { harness: "fake", nativeId: "msg-1" },
        }),
      )
      yield* repo.upsert(
        makeEventEntry({ id: entryId("ent_3"), conversationId: cnv, createdAt: 3, turnId: turnId("trn_1") }),
      )
      yield* equal(ids(yield* repo.listAfter(cnv, entryId("ent_1"), 10)), ["ent_2", "ent_3"], "after ent_1")
      yield* equal(ids(yield* repo.listAfter(cnv, undefined, 2)), ["ent_1", "ent_2"], "from start, limited")
      yield* equal(
        ids(yield* repo.listAfter(cnv, entryId("ent_unknown"), 10)),
        ["ent_1", "ent_2", "ent_3"],
        "unknown anchor",
      )
      yield* equal((yield* some(yield* repo.findByClientNonce(cnv, "n1"), "nonce")).id, "ent_1", "by nonce")
      yield* none(yield* repo.findByClientNonce(conversationId("cnv_other"), "n1"), "nonce is per conversation")
      yield* equal((yield* some(yield* repo.findByNativeId(cnv, "msg-1"), "native")).id, "ent_2", "by native id")
      yield* equal(ids(yield* repo.listByTurn(turnId("trn_1"))), ["ent_2", "ent_3"], "by turn")
      yield* equal(yield* repo.remove(entryId("ent_2")), true, "remove")
      yield* none(yield* repo.get(entryId("ent_2")), "removed")
    }),
  ),

  contractCase(
    "RequestRepo: filters and native id lookup",
    Effect.gen(function* () {
      const repo = yield* RequestRepo
      yield* repo.upsert(makeRequest({ id: requestId("req_1"), createdAt: 1, turnId: turnId("trn_1") }))
      yield* repo.upsert(
        makeRequest({
          id: requestId("req_2"),
          createdAt: 2,
          status: "resolved",
          source: { origin: "openbot", method: "ask_user", nativeRequestId: "call-9" },
        }),
      )
      yield* repo.upsert(
        makeRequest({
          id: requestId("req_3"),
          createdAt: 3,
          botId: botId("bot_b"),
          conversationId: conversationId("cnv_b"),
        }),
      )
      yield* equal(ids(yield* repo.list({ statuses: ["pending"] })), ["req_1", "req_3"], "pending")
      yield* equal(ids(yield* repo.list({ conversationId: conversationId("cnv_b") })), ["req_3"], "by conversation")
      yield* equal(
        ids(yield* repo.list({ botId: botId("bot_test"), turnId: turnId("trn_1") })),
        ["req_1"],
        "by bot + turn",
      )
      yield* equal(
        (yield* some(yield* repo.findByNativeId(botId("bot_test"), "call-9"), "native")).id,
        "req_2",
        "by native id",
      )
      yield* none(yield* repo.findByNativeId(botId("bot_b"), "call-9"), "native id is per bot")
      yield* repo.deleteByConversation(conversationId("cnv_b"))
      yield* equal(ids(yield* repo.list()), ["req_1", "req_2"], "deleteByConversation")
    }),
  ),

  contractCase(
    "TurnRepo: recent per conversation and active",
    Effect.gen(function* () {
      const repo = yield* TurnRepo
      yield* repo.upsert(makeTurn({ id: turnId("trn_1"), startedAt: 1, status: "completed" }))
      yield* repo.upsert(makeTurn({ id: turnId("trn_2"), startedAt: 2, status: "running" }))
      yield* repo.upsert(makeTurn({ id: turnId("trn_3"), startedAt: 3, status: "queued" }))
      yield* repo.upsert(
        makeTurn({ id: turnId("trn_4"), startedAt: 4, status: "waiting", conversationId: conversationId("cnv_x") }),
      )
      yield* equal(
        ids(yield* repo.listByConversation(conversationId("cnv_test"), 2)),
        ["trn_2", "trn_3"],
        "most recent 2, oldest first",
      )
      yield* equal(ids(yield* repo.listActive), ["trn_2", "trn_3", "trn_4"], "active")
      yield* repo.upsert(makeTurn({ id: turnId("trn_2"), startedAt: 2, status: "interrupted" }))
      yield* equal(ids(yield* repo.listActive), ["trn_3", "trn_4"], "status update")
      yield* repo.deleteByConversation(conversationId("cnv_x"))
      yield* none(yield* repo.get(turnId("trn_4")), "deleteByConversation")
      yield* equal(ids(yield* repo.listActive), ["trn_3"], "other conversations kept")
    }),
  ),

  contractCase(
    "RoutineRepo: CRUD and only the newest 20 runs kept",
    Effect.gen(function* () {
      const repo = yield* RoutineRepo
      yield* repo.upsert(makeRoutine({ id: routineId("rtn_1"), createdAt: 1 }))
      yield* repo.upsert(makeRoutine({ id: routineId("rtn_2"), createdAt: 2, botId: botId("bot_b") }))
      yield* equal(ids(yield* repo.list({ botId: botId("bot_b") })), ["rtn_2"], "by bot")
      for (let i = 1; i <= 25; i++) {
        yield* repo.upsertRun(
          makeRoutineRun({
            id: routineRunId(`run_${String(i).padStart(2, "0")}`),
            routineId: routineId("rtn_1"),
            startedAt: i,
          }),
        )
      }
      yield* repo.upsertRun(
        makeRoutineRun({ id: routineRunId("run_other"), routineId: routineId("rtn_2"), startedAt: 1 }),
      )
      const runs = yield* repo.listRuns(routineId("rtn_1"))
      yield* equal(runs.length, 20, "20 kept")
      yield* equal(runs[0]?.id, "run_25", "newest first")
      yield* equal(runs[19]?.id, "run_06", "oldest kept")
      yield* none(yield* repo.getRun(routineRunId("run_05")), "pruned run")
      yield* repo.upsertRun(
        makeRoutineRun({
          id: routineRunId("run_25"),
          routineId: routineId("rtn_1"),
          startedAt: 25,
          status: "succeeded",
        }),
      )
      yield* equal((yield* some(yield* repo.getRun(routineRunId("run_25")), "run")).status, "succeeded", "run update")
      yield* equal((yield* repo.listRuns(routineId("rtn_1"))).length, 20, "update does not prune more")
      yield* repo.delete(routineId("rtn_1"))
      yield* equal(yield* repo.listRuns(routineId("rtn_1")), [], "delete removes runs")
      yield* equal((yield* repo.listRuns(routineId("rtn_2"))).length, 1, "other routine untouched")
    }),
  ),

  contractCase(
    "NodeRepo: nodes, public keys, single-use pairing codes",
    Effect.gen(function* () {
      const repo = yield* NodeRepo
      yield* repo.upsert(nodeRecord("nod_b", { createdAt: 2 }))
      yield* repo.upsert(nodeRecord("nod_a", { createdAt: 1 }))
      yield* equal(ids(yield* repo.list), ["nod_a", "nod_b"], "list order")
      yield* equal((yield* some(yield* repo.findByPublicKey("key-nod_b"), "by key")).id, "nod_b", "by key")
      yield* repo.putPairingCode({ code: "ABCD1234", createdAt: 0, expiresAt: 100 as Millis })
      yield* repo.putPairingCode({ code: "EXPIRED1", createdAt: 0, expiresAt: 10 as Millis })
      yield* equal(
        (yield* some(yield* repo.consumePairingCode("ABCD1234", 50 as Millis), "code")).code,
        "ABCD1234",
        "consume",
      )
      yield* none(yield* repo.consumePairingCode("ABCD1234", 50 as Millis), "single use")
      yield* none(yield* repo.consumePairingCode("EXPIRED1", 10 as Millis), "expired")
      yield* none(yield* repo.consumePairingCode("EXPIRED1", 5 as Millis), "expired codes are deleted")
      yield* none(yield* repo.consumePairingCode("NOPE", 0 as Millis), "unknown")
    }),
  ),

  contractCase(
    "ApprovalRuleRepo: bot filter includes global rules",
    Effect.gen(function* () {
      const repo = yield* ApprovalRuleRepo
      yield* repo.upsert(makeRule({ id: "rul_global" as ApprovalRuleId, createdAt: 1 }))
      yield* repo.upsert(makeRule({ id: "rul_a" as ApprovalRuleId, botId: botId("bot_a"), createdAt: 2 }))
      yield* repo.upsert(makeRule({ id: "rul_b" as ApprovalRuleId, botId: botId("bot_b"), createdAt: 3 }))
      yield* repo.upsert(makeRule({ id: "rul_other" as ApprovalRuleId, ownerProfileId: OTHER_PROFILE, createdAt: 4 }))
      yield* equal(ids(yield* repo.list({ profileId: MAIN_PROFILE_ID })), ["rul_global", "rul_a", "rul_b"], "all")
      yield* equal(
        ids(yield* repo.list({ profileId: MAIN_PROFILE_ID, botId: botId("bot_a") })),
        ["rul_global", "rul_a"],
        "bot + global",
      )
      yield* equal(
        ids(yield* repo.list({ profileId: OTHER_PROFILE, botId: botId("bot_a") })),
        ["rul_other"],
        "per profile",
      )
      yield* repo.delete("rul_a" as ApprovalRuleId)
      yield* none(yield* repo.get("rul_a" as ApprovalRuleId), "deleted")
    }),
  ),

  contractCase(
    "SettingsRepo: JSON key/values",
    Effect.gen(function* () {
      const repo = yield* SettingsRepo
      yield* none(yield* repo.get("theme"), "absent")
      yield* repo.set("theme", "dark")
      yield* repo.set("nested", { a: [1, 2], b: { c: true } })
      yield* equal(yield* some(yield* repo.get("nested"), "nested"), { a: [1, 2], b: { c: true } }, "round trip")
      yield* equal([...(yield* repo.getAll).keys()].sort(), ["nested", "theme"], "getAll")
      yield* repo.remove("theme")
      yield* none(yield* repo.get("theme"), "removed")
    }),
  ),

  contractCase(
    "UsageRepo: totals per bot since a timestamp",
    Effect.gen(function* () {
      const repo = yield* UsageRepo
      yield* repo.record({
        botId: botId("bot_a"),
        turnId: turnId("trn_1"),
        at: 1 as Millis,
        usage: { inputTokens: 10, outputTokens: 1 },
      })
      yield* repo.record({
        botId: botId("bot_a"),
        turnId: turnId("trn_1"),
        at: 3 as Millis,
        usage: { inputTokens: 0, outputTokens: 0 },
      })
      yield* repo.record({
        botId: botId("bot_a"),
        turnId: turnId("trn_2"),
        at: 5 as Millis,
        usage: { inputTokens: 20, outputTokens: 2, costUsd: 0.5 },
      })
      yield* repo.record({ botId: botId("bot_b"), at: 6 as Millis, usage: { inputTokens: 1, outputTokens: 1 } })
      const all = yield* repo.totalsByBot()
      yield* equal(
        all.map((t) => [t.botId, t.usage.inputTokens, t.records, t.turnCount, t.lastAt]),
        [
          ["bot_a", 30, 3, 2, 5],
          ["bot_b", 1, 1, 0, 6],
        ],
        "all time",
      )
      const recent = yield* repo.totalsByBot(5 as Millis)
      yield* equal(
        recent.map((t) => [t.botId, t.usage.inputTokens, t.usage.costUsd]),
        [
          ["bot_a", 20, 0.5],
          ["bot_b", 1, undefined],
        ],
        "since",
      )
      yield* equal((yield* repo.list({ botId: botId("bot_a") })).length, 3, "list by bot")
    }),
  ),

  contractCase(
    "ReplicaLog: append, resume window, epochs",
    Effect.gen(function* () {
      const log = yield* ReplicaLog
      const key = conversationReplicaKey(conversationId("cnv_r"))
      const record = (sequence: number, epoch = "e1"): ReplicaRecord => ({
        replicaKey: key,
        epoch,
        sequence,
        change: {
          replica: "conversation",
          change: { type: "entry.removed", entryId: entryId(`ent_${sequence}`), reason: "deleted" },
        },
      })
      yield* none(yield* log.head(key), "no head")
      yield* log.reset(key, "e1")
      yield* equal(yield* some(yield* log.head(key), "head"), { epoch: "e1", sequence: 0 }, "reset head")
      const total = REPLICA_LOG_WINDOW + 10
      for (let s = 1; s <= total; s++) yield* log.append(record(s))
      yield* equal(yield* some(yield* log.head(key), "head"), { epoch: "e1", sequence: total }, "head after appends")
      const at = (sequence: number, epoch = "e1"): StreamCursor => ({ epoch, sequence })
      const recent = yield* some(yield* log.readAfter(key, at(total - 3)), "recent")
      yield* equal(
        recent.map((r) => r.sequence),
        [total - 2, total - 1, total],
        "replay tail",
      )
      yield* equal(yield* some(yield* log.readAfter(key, at(total)), "caught up"), [], "caught up → empty")
      const edge = yield* some(yield* log.readAfter(key, at(total - REPLICA_LOG_WINDOW)), "edge of window")
      yield* equal(edge.length, REPLICA_LOG_WINDOW, "exactly the window")
      yield* none(yield* log.readAfter(key, at(total - REPLICA_LOG_WINDOW - 1)), "gap beyond window")
      yield* none(yield* log.readAfter(key, at(1, "e0")), "other epoch")
      yield* none(yield* log.readAfter(key, at(total + 5)), "cursor ahead of head")
      const outOfOrder = yield* Effect.result(log.append(record(total + 2)))
      yield* ok(Result.isFailure(outOfOrder), "out-of-order append fails")
      yield* log.reset(key, "e2")
      yield* none(yield* log.readAfter(key, at(total)), "old epoch after reset")
      yield* log.drop(key)
      yield* none(yield* log.head(key), "dropped")
      yield* log.append(record(1, "e2"))
      yield* equal((yield* some(yield* log.readAfter(key, at(0, "e2")), "new epoch")).length, 1, "new epoch replay")
    }),
  ),

  contractCase(
    "McpTokenRepo: lookup and revocation",
    Effect.gen(function* () {
      const repo = yield* McpTokenRepo
      const claims = (bot: string) => ({
        botId: botId(bot),
        conversationId: conversationId("cnv_test"),
        sessionKey: `${bot}:cnv_test`,
        toolsets: ["bot" as const],
        hostNodeId: nodeId("node_local"),
        workspacePath: `/data/bots/${bot}/workspace`,
        boundNodeIds: [],
      })
      yield* repo.put({ hash: "h1", claims: claims("bot_a"), createdAt: 0, revoked: false })
      yield* repo.put({ hash: "h2", claims: claims("bot_a"), createdAt: 0, revoked: false })
      yield* repo.put({ hash: "h3", claims: claims("bot_b"), createdAt: 0, revoked: false })
      yield* equal((yield* some(yield* repo.lookup("h1"), "lookup")).claims.botId, "bot_a", "claims")
      yield* repo.revoke("h1")
      yield* ok((yield* some(yield* repo.lookup("h1"), "revoked")).revoked, "revoked flag")
      yield* repo.revokeAll(botId("bot_a"))
      yield* ok((yield* some(yield* repo.lookup("h2"), "h2")).revoked, "revokeAll by bot")
      yield* ok(!(yield* some(yield* repo.lookup("h3"), "h3")).revoked, "other bot untouched")
      yield* repo.revokeAll()
      yield* ok((yield* some(yield* repo.lookup("h3"), "h3")).revoked, "revokeAll")
      yield* none(yield* repo.lookup("missing"), "unknown hash")
    }),
  ),

  contractCase(
    "ProcessLedger: record, remove, clear",
    Effect.gen(function* () {
      const ledger = yield* ProcessLedger
      yield* ledger.record({ pid: 20, pgid: 20, kind: "codex-app-server", startedAt: 2 })
      yield* ledger.record({ pid: 10, pgid: 10, kind: "claude", startedAt: 1 })
      yield* equal(
        (yield* ledger.list).map((r) => r.pid),
        [10, 20],
        "ordered by start",
      )
      yield* ledger.remove(10)
      yield* equal(
        (yield* ledger.list).map((r) => r.pid),
        [20],
        "removed",
      )
      yield* ledger.clear
      yield* equal(yield* ledger.list, [], "cleared")
    }),
  ),

  contractCase(
    "MemoryStore: index and facts per bot",
    Effect.gen(function* () {
      const store = yield* MemoryStore
      const a = botId("bot_a")
      yield* equal(yield* store.readIndex(a), "", "empty index")
      yield* store.writeIndex(a, "- [Dark mode](dark-mode.md)")
      yield* store.putFact(a, { id: "zeta" as MemoryFactId, title: "Zeta", body: "z", updatedAt: 1 })
      yield* store.putFact(a, {
        id: "dark-mode" as MemoryFactId,
        title: "Dark mode",
        body: "prefers dark",
        updatedAt: 2,
      })
      yield* equal(ids(yield* store.listFacts(a)), ["dark-mode", "zeta"], "ordered by id")
      yield* equal(yield* store.listFacts(botId("bot_b")), [], "per bot")
      yield* equal(yield* store.deleteFact(a, "zeta" as MemoryFactId), true, "delete")
      yield* none(yield* store.getFact(a, "zeta" as MemoryFactId), "deleted fact")
      yield* store.deleteAll(a)
      yield* equal([yield* store.readIndex(a), (yield* store.listFacts(a)).length], ["", 0], "deleteAll")
    }),
  ),

  contractCase(
    "SkillStore: library CRUD",
    Effect.gen(function* () {
      const store = yield* SkillStore
      yield* store.put({ name: "triage" as SkillName, description: "Triage issues", body: "# Triage", updatedAt: 1 })
      yield* store.put({ name: "deploy" as SkillName, description: "Deploy", body: "# Deploy", updatedAt: 1 })
      yield* equal(
        (yield* store.list).map((s) => s.name),
        ["deploy", "triage"],
        "ordered by name",
      )
      yield* store.put({ name: "deploy" as SkillName, description: "Deploy v2", body: "# Deploy", updatedAt: 2 })
      yield* equal((yield* some(yield* store.get("deploy" as SkillName), "get")).description, "Deploy v2", "replace")
      yield* equal(yield* store.delete("deploy" as SkillName), true, "delete")
      yield* ok((yield* store.dir("triage" as SkillName)).endsWith("/skills/triage"), "skill folder")
    }).pipe(inProfile(MAIN_PROFILE_ID)),
  ),

  contractCase(
    "TaskRepo: upsert, list newest first with filters, steps, delete",
    Effect.gen(function* () {
      const repo = yield* TaskRepo
      const a = botId("bot_a")
      yield* repo.upsert(makeTask({ id: taskId("tsk_1"), botId: a, createdAt: 1, status: "succeeded", result: "done" }))
      yield* repo.upsert(
        makeTask({
          id: taskId("tsk_2"),
          botId: a,
          createdAt: 2,
          status: "running",
          conversationId: conversationId("cnv_g"),
        }),
      )
      yield* repo.upsert(makeTask({ id: taskId("tsk_3"), botId: botId("bot_b"), createdAt: 3 }))
      yield* equal(ids(yield* repo.list()), ["tsk_3", "tsk_2", "tsk_1"], "newest first")
      yield* equal(ids(yield* repo.list({ botId: a })), ["tsk_2", "tsk_1"], "by bot")
      yield* equal(ids(yield* repo.list({ statuses: ["queued", "running"] })), ["tsk_3", "tsk_2"], "by status")
      yield* equal(ids(yield* repo.list({ conversationId: conversationId("cnv_g") })), ["tsk_2"], "by origin")
      yield* equal(ids(yield* repo.list({ limit: 1 })), ["tsk_3"], "limit")
      yield* equal(ids(yield* repo.list({ statuses: [] })), [], "no statuses")
      yield* repo.upsert(makeTask({ id: taskId("tsk_2"), botId: a, createdAt: 2, status: "failed", error: "boom" }))
      yield* equal((yield* some(yield* repo.get(taskId("tsk_2")), "get")).error, "boom", "replace")
      yield* repo.putStep(
        taskId("tsk_2"),
        makeToolCallEntry({ id: entryId("ent_s2"), createdAt: 5, status: "running" }),
      )
      yield* repo.putStep(
        taskId("tsk_2"),
        makeMessageEntry({ id: entryId("ent_s1"), createdAt: 4, role: "bot", text: "hi" }),
      )
      yield* repo.putStep(
        taskId("tsk_2"),
        makeToolCallEntry({ id: entryId("ent_s2"), createdAt: 5, status: "completed", revision: 1 }),
      )
      const steps = yield* repo.steps(taskId("tsk_2"))
      yield* equal(ids(steps), ["ent_s1", "ent_s2"], "steps in order")
      yield* ok(steps[1]?.kind === "tool-call" && steps[1].status === "completed", "step replaced")
      yield* equal(yield* repo.steps(taskId("tsk_1")), [], "other task has no steps")
      yield* equal(yield* repo.delete(taskId("tsk_2")), true, "delete")
      yield* none(yield* repo.get(taskId("tsk_2")), "deleted")
      yield* equal(yield* repo.steps(taskId("tsk_2")), [], "steps deleted")
      yield* equal(yield* repo.delete(taskId("tsk_2")), false, "delete again")
    }),
  ),

  contractCase(
    "AttachmentStore: put, read, delete",
    Effect.gen(function* () {
      const store = yield* AttachmentStore
      const record = yield* store.put({ name: "a.txt", mime: "text/plain", bytes: new TextEncoder().encode("hi") })
      yield* equal([record.name, record.mime, record.byteSize], ["a.txt", "text/plain", 2], "metadata")
      yield* ok(record.path.endsWith(record.id), "path ends with id")
      const bytes = yield* some(yield* store.read(record.id), "read")
      yield* equal(new TextDecoder().decode(bytes), "hi", "bytes")
      yield* equal((yield* some(yield* store.get(record.id), "get")).id, record.id, "get")
      yield* equal(yield* store.delete(record.id), true, "delete")
      yield* none(yield* store.read(record.id), "deleted")
    }).pipe(inProfile(MAIN_PROFILE_ID)),
  ),

  contractCase(
    "HeldNotificationRepo: per profile, oldest first, capped, dismissed through an id",
    Effect.gen(function* () {
      const repo = yield* HeldNotificationRepo
      const a = "prf_a" as OwnerProfileId
      const b = "prf_b" as OwnerProfileId
      const held = (id: string, at: number) => ({
        notification: { id: id as NotificationId, kind: "finished" as const, title: "Ada", body: id, at },
        needsYou: false,
      })
      for (const [i, id] of ["ntf_1", "ntf_2", "ntf_3", "ntf_4"].entries()) yield* repo.hold(a, held(id, i), 3)
      yield* repo.hold(b, held("ntf_b", 9), 3)
      const first = yield* repo.summary(a)
      yield* equal(
        first.items.map((i) => i.notification.id),
        ["ntf_2", "ntf_3", "ntf_4"],
        "oldest dropped past the cap",
      )
      yield* equal([first.dropped, first.since], [1, undefined], "dropped counted, never left")
      yield* equal(
        (yield* repo.summary(b)).items.map((i) => i.notification.id),
        ["ntf_b"],
        "other profile",
      )

      yield* repo.dismiss(a, "ntf_x" as NotificationId)
      yield* equal((yield* repo.summary(a)).items.length, 3, "unknown id clears nothing")
      yield* repo.dismiss(a, "ntf_3" as NotificationId)
      yield* repo.markLeft(a, 42 as Millis)
      const after = yield* repo.summary(a)
      yield* equal(
        [after.items.map((i) => i.notification.id), after.dropped, after.since],
        [["ntf_4"], 0, 42],
        "dismissed through",
      )
      yield* repo.dismiss(b, "ntf_4" as NotificationId)
      yield* equal((yield* repo.summary(a)).items.length, 1, "dismiss stays in its profile")
    }),
  ),
]

// ---------------------------------------------------------------------------- boot recovery

export interface BootRecoveryContractCase {
  readonly name: string
  readonly run: Effect.Effect<void, unknown, RepositoryPorts | BootRecovery>
}

/**
 * The D2.5 / §4.4 recovery expectations for any `BootRecovery` implementation (persistence runs
 * them against SQLite with its `PersistenceLive` + `BootRecovery` layers; FRESH repositories).
 */
export const bootRecoveryContractCases: ReadonlyArray<BootRecoveryContractCase> = [
  {
    name: "BootRecovery: interrupts turns, finalizes entries, expires requests and cards, interrupts runs, revokes tokens",
    run: Effect.gen(function* () {
      const turns = yield* TurnRepo
      const entries = yield* EntryRepo
      const requests = yield* RequestRepo
      const routines = yield* RoutineRepo
      const tokens = yield* McpTokenRepo
      const ledger = yield* ProcessLedger
      const recovery = yield* BootRecovery

      yield* turns.upsert(makeTurn({ id: turnId("trn_run"), status: "running" }))
      yield* turns.upsert(makeTurn({ id: turnId("trn_wait"), status: "waiting", startedAt: 1 }))
      yield* turns.upsert(makeTurn({ id: turnId("trn_done"), status: "completed", startedAt: 2 }))
      yield* entries.upsert(
        makeMessageEntry({
          id: entryId("ent_stream"),
          turnId: turnId("trn_run"),
          role: "bot",
          author: { kind: "bot", botId: botId("bot_test") },
          streaming: true,
          text: "partial",
        }),
      )
      yield* entries.upsert(
        makeToolCallEntry({ id: entryId("ent_tool"), turnId: turnId("trn_run"), status: "running", createdAt: 1 }),
      )
      yield* entries.upsert(makeCardEntry({ id: entryId("ent_card"), turnId: turnId("trn_wait") }))
      yield* requests.upsert(
        makeRequest({ id: requestId("req_test"), cardEntryId: entryId("ent_card"), turnId: turnId("trn_wait") }),
      )
      yield* requests.upsert(
        makeRequest({ id: requestId("req_done"), status: "resolved", cardEntryId: entryId("ent_other") }),
      )
      yield* routines.upsert(makeRoutine({ id: routineId("rtn_a") }))
      yield* routines.upsertRun(
        makeRoutineRun({ id: routineRunId("run_a"), routineId: routineId("rtn_a"), status: "running" }),
      )
      yield* tokens.put({ hash: "h1", claims: makeClaims(), createdAt: 0, revoked: false })
      yield* ledger.record({ pid: 10, pgid: 10, kind: "claude", startedAt: 0 })
      const tasks = yield* TaskRepo
      yield* tasks.upsert(
        makeTask({ id: taskId("tsk_run"), status: "running", startedAt: 1, progress: "Reading", createdAt: 1 }),
      )
      yield* tasks.upsert(makeTask({ id: taskId("tsk_q"), status: "queued", createdAt: 2 }))
      yield* tasks.upsert(makeTask({ id: taskId("tsk_ok"), status: "succeeded", createdAt: 3 }))
      yield* tasks.putStep(taskId("tsk_run"), makeToolCallEntry({ id: entryId("ent_tstep"), status: "running" }))

      const report = yield* recovery.run

      yield* equal(report.interruptedTasks.map((t) => t.id).sort(), ["tsk_q", "tsk_run"], "interrupted tasks")
      const failedTask = yield* some(yield* tasks.get(taskId("tsk_run")), "task")
      yield* ok(
        failedTask.status === "failed" &&
          failedTask.error === "interrupted by a restart" &&
          failedTask.progress === undefined,
        "task failed",
      )
      yield* equal(
        (yield* some(yield* tasks.get(taskId("tsk_ok")), "ok task")).status,
        "succeeded",
        "finished task untouched",
      )
      const tstep = (yield* tasks.steps(taskId("tsk_run")))[0]
      yield* ok(tstep?.kind === "tool-call" && tstep.status === "interrupted", "task step interrupted")

      yield* equal(report.interruptedTurns.map((t) => t.id).sort(), ["trn_run", "trn_wait"], "interrupted turns")
      yield* equal(
        (yield* some(yield* turns.get(turnId("trn_done")), "done turn")).status,
        "completed",
        "finished turn untouched",
      )
      yield* equal(
        (yield* some(yield* turns.get(turnId("trn_run")), "turn")).status,
        "interrupted",
        "turn persisted as interrupted",
      )
      const message = yield* some(yield* entries.get(entryId("ent_stream")), "message")
      yield* ok(
        message.kind === "message" && !message.streaming && message.aborted === true && message.revision === 1,
        "streaming bot message finalized + aborted",
      )
      const tool = yield* some(yield* entries.get(entryId("ent_tool")), "tool")
      yield* ok(
        tool.kind === "tool-call" && tool.status === "interrupted" && tool.revision === 1,
        "running tool call interrupted",
      )
      const request = yield* some(yield* requests.get(requestId("req_test")), "request")
      yield* equal([request.status, request.statusReason], ["expired", "not_resumable"], "pending request expired")
      yield* equal(
        (yield* some(yield* requests.get(requestId("req_done")), "resolved")).status,
        "resolved",
        "resolved request untouched",
      )
      const card = yield* some(yield* entries.get(entryId("ent_card")), "card")
      yield* ok(card.kind === "card" && card.state.status === "expired" && card.revision === 1, "card expired")
      yield* equal(
        report.expiredRequests.map((r) => r.id),
        ["req_test"],
        "report requests",
      )
      yield* equal(
        report.updatedEntries.map((e) => e.id).sort(),
        ["ent_card", "ent_stream", "ent_tool"],
        "report entries",
      )
      yield* equal(
        (yield* some(yield* routines.getRun(routineRunId("run_a")), "run")).status,
        "interrupted",
        "run interrupted",
      )
      yield* equal(
        (yield* some(yield* routines.get(routineId("rtn_a")), "routine")).lastRunStatus,
        "interrupted",
        "routine lastRunStatus",
      )
      yield* ok((yield* some(yield* tokens.lookup("h1"), "token")).revoked, "tokens revoked")
      yield* equal((yield* ledger.list).length, 0, "ledger cleared")

      const again = yield* recovery.run
      yield* equal(
        [
          again.interruptedTurns.length,
          again.expiredRequests.length,
          again.updatedEntries.length,
          again.interruptedRuns.length,
          again.interruptedTasks.length,
        ],
        [0, 0, 0, 0, 0],
        "idempotent",
      )
    }),
  },
]

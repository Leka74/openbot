/**
 * In-memory implementations of every repository port (architecture §3.2). Used by core service
 * tests and by other packages' tests. Behavior is the contract the SQLite implementation must match
 * (see `packages/core/test/ports/repos.test.ts`).
 *
 * Every operation is a single synchronous step (`Effect.sync`), so operations are atomic.
 */
import type {
  ApprovalRule,
  ApprovalRuleId,
  Bot,
  BotId,
  Conversation,
  ConversationId,
  EntryId,
  HeldNotification,
  KnownTranscriptEntry,
  Millis,
  NodeId,
  OwnerProfile,
  OwnerProfileId,
  RequestId,
  Routine,
  RoutineId,
  RoutineRun,
  RoutineRunId,
  RuntimeRequest,
  Section,
  SectionId,
  StreamCursor,
  Task,
  TaskId,
  TranscriptEntry,
  Turn,
  TurnId,
  Usage,
} from "@openbot/contracts"
import { MAIN_PROFILE_ID, ROUTINE_RUNS_KEPT } from "@openbot/contracts"
import { Context, Effect, Layer, Option } from "effect"
import { RepoError } from "../ports/errors.ts"
import {
  indexMemoryEntry,
  indexMemoryTask,
  makeMemorySearchIndex,
  makeMemorySearchRepo,
  type MemorySearchIndex,
} from "./memorySearch.ts"
import { McpTokenRepo, type McpTokenRecord } from "../ports/Mcp.ts"
import { ProcessLedger, type ProcessRecord } from "../ports/ProcessLedger.ts"
import { HeldNotificationRepo, OwnerProfileRepo, ProfileStorage } from "../ports/Profiles.ts"
import {
  ApprovalRuleRepo,
  BotRepo,
  ConversationRepo,
  type EntryPage,
  type EntryPageAfter,
  EntryRepo,
  type ExchangeSlice,
  type BotSessionRecord,
  type NodeRecord,
  NodeRepo,
  type PairingCodeRecord,
  REPLICA_LOG_WINDOW,
  type ReplicaKey,
  ReplicaLog,
  type ReplicaRecord,
  RequestRepo,
  RoutineRepo,
  SearchRepo,
  SectionRepo,
  SettingsRepo,
  type SettingsStore,
  TaskRepo,
  TurnRepo,
  type UpsertOutcome,
  type UsageRecord,
  UsageRepo,
  type UsageTotals,
} from "../ports/repos.ts"

const byCreatedAt = <A extends { readonly createdAt: number }>(a: A, b: A) => a.createdAt - b.createdAt

const option = <A>(value: A | undefined): Option.Option<A> => (value === undefined ? Option.none() : Option.some(value))

// ============================================================================ bots & sections

export const makeMemoryBotRepo = () =>
  Effect.sync(() => {
    const bots = new Map<BotId, Bot>()
    const sessions = new Map<BotId, BotSessionRecord>()
    return BotRepo.of({
      get: (id) => Effect.sync(() => option(bots.get(id))),
      list: Effect.sync(() => [...bots.values()].sort(byCreatedAt)),
      listIn: (profileId) =>
        Effect.sync(() => [...bots.values()].filter((b) => b.ownerProfileId === profileId).sort(byCreatedAt)),
      upsert: (bot) => Effect.sync(() => void bots.set(bot.id, bot)),
      delete: (id) =>
        Effect.sync(() => {
          sessions.delete(id)
          return bots.delete(id)
        }),
      getSession: (botId) => Effect.sync(() => option(sessions.get(botId))),
      setSession: (record) => Effect.sync(() => void sessions.set(record.botId, record)),
      clearSession: (botId) => Effect.sync(() => void sessions.delete(botId)),
    })
  })

export const makeMemorySectionRepo = () =>
  Effect.sync(() => {
    const sections = new Map<SectionId, Section>()
    return SectionRepo.of({
      list: (profileId) =>
        Effect.sync(() =>
          [...sections.values()]
            .filter((s) => s.ownerProfileId === profileId)
            .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        ),
      get: (id) => Effect.sync(() => option(sections.get(id))),
      upsert: (section) => Effect.sync(() => void sections.set(section.id, section)),
      delete: (id) => Effect.sync(() => sections.delete(id)),
    })
  })

// ============================================================================ conversations

export const conversationMembers = (conversation: Conversation): ReadonlyArray<BotId> => {
  switch (conversation.kind) {
    case "direct":
    case "routine-run":
      return [conversation.botId]
    case "group":
      return conversation.memberBotIds
  }
}

export const makeMemoryConversationRepo = () =>
  Effect.sync(() => {
    const conversations = new Map<ConversationId, Conversation>()
    return ConversationRepo.of({
      get: (id) => Effect.sync(() => option(conversations.get(id))),
      list: (filter) =>
        Effect.sync(() =>
          [...conversations.values()]
            .filter((c) => filter?.kind === undefined || c.kind === filter.kind)
            .filter((c) => filter?.botId === undefined || conversationMembers(c).includes(filter.botId))
            .filter((c) => filter?.includeHidden !== false || !c.hiddenFromSidebar)
            .sort((a, b) => b.lastActivityAt - a.lastActivityAt || (a.id < b.id ? -1 : 1)),
        ),
      upsert: (conversation) => Effect.sync(() => void conversations.set(conversation.id, conversation)),
      delete: (id) => Effect.sync(() => conversations.delete(id)),
      members: (id) =>
        Effect.sync(() => {
          const c = conversations.get(id)
          return c ? conversationMembers(c) : []
        }),
    })
  })

// ============================================================================ entries

/** Total order of entries inside a conversation: `(createdAt, id)`. */
export const compareEntries = (
  a: { readonly createdAt: number; readonly id: string },
  b: { readonly createdAt: number; readonly id: string },
) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Opaque page cursor `"<createdAt>:<id>"` (ids never contain ':'). */
export const encodeEntryCursor = (entry: { readonly createdAt: number; readonly id: string }) =>
  `${entry.createdAt}:${entry.id}`
export const decodeEntryCursor = (cursor: string): { createdAt: number; id: string } | undefined => {
  const index = cursor.indexOf(":")
  if (index <= 0) return undefined
  const createdAt = Number(cursor.slice(0, index))
  const id = cursor.slice(index + 1)
  return Number.isFinite(createdAt) && id.length > 0 ? { createdAt, id } : undefined
}

/** `index`: keep the search docs of a shared in-memory search index up to date (`MemoryPersistence`). */
export const makeMemoryEntryRepo = (index?: MemorySearchIndex) =>
  Effect.sync(() => {
    const entries = new Map<EntryId, TranscriptEntry>()
    const inConversation = (conversationId: ConversationId) =>
      [...entries.values()].filter((e) => e.conversationId === conversationId).sort(compareEntries)

    return EntryRepo.of({
      get: (id) => Effect.sync(() => option(entries.get(id))),
      upsert: (entry: KnownTranscriptEntry) =>
        Effect.sync((): UpsertOutcome<TranscriptEntry> => {
          const current = entries.get(entry.id)
          if (current !== undefined && current.revision >= entry.revision) return { applied: false, current }
          // createdAt is immutable once written.
          const value: TranscriptEntry =
            current !== undefined && current.createdAt !== entry.createdAt
              ? { ...entry, createdAt: current.createdAt }
              : entry
          entries.set(entry.id, value)
          if (index !== undefined) indexMemoryEntry(index, value)
          return { applied: true, value }
        }),
      remove: (id) =>
        Effect.sync(() => {
          index?.docs.delete(id)
          return entries.delete(id)
        }),
      page: ({ conversationId, before, limit }) =>
        Effect.gen(function* () {
          const all = inConversation(conversationId)
          let end = all.length
          if (before !== undefined) {
            const cursor = decodeEntryCursor(before)
            if (cursor === undefined) {
              return yield* new RepoError({ op: "EntryRepo.page", message: `Invalid cursor: ${before}` })
            }
            end = all.findIndex((e) => compareEntries(e, cursor) >= 0)
            if (end === -1) end = all.length
          }
          const start = Math.max(0, end - Math.max(0, limit))
          const page = all.slice(start, end)
          const first = page[0]
          const preceding = all[start - 1]
          const result: EntryPage = {
            entries: page,
            hasMoreBefore: start > 0,
            beforeCursor: start > 0 && first !== undefined ? encodeEntryCursor(first) : null,
            precedingTimestamp: preceding?.createdAt,
          }
          return result
        }),
      pageAfter: ({ conversationId, after, limit }) =>
        Effect.gen(function* () {
          const cursor = decodeEntryCursor(after)
          if (cursor === undefined) {
            return yield* new RepoError({ op: "EntryRepo.pageAfter", message: `Invalid cursor: ${after}` })
          }
          const rest = inConversation(conversationId).filter((e) => compareEntries(e, cursor) > 0)
          const page = rest.slice(0, Math.max(0, Math.floor(limit)))
          const last = page[page.length - 1]
          const hasMoreAfter = rest.length > page.length
          const result: EntryPageAfter = {
            entries: page,
            hasMoreAfter,
            afterCursor: hasMoreAfter && last !== undefined ? encodeEntryCursor(last) : null,
          }
          return result
        }),
      listExchange: ({ botIds: [a, b], conversationIds, direction, from, limit }) =>
        Effect.sync((): ExchangeSlice => {
          const all = [...entries.values()]
            .filter(
              (e) =>
                conversationIds.includes(e.conversationId) &&
                e.kind === "message" &&
                e.author.kind === "bot" &&
                ((e.author.botId === a && e.toBotId === b) || (e.author.botId === b && e.toBotId === a)),
            )
            .sort(compareEntries)
          const size = Math.max(0, Math.floor(limit))
          if (direction === "older") {
            const end = from === undefined ? all.length : all.filter((e) => compareEntries(e, from) < 0).length
            const start = Math.max(0, end - size)
            return { entries: all.slice(start, end), more: start > 0 }
          }
          const start = from === undefined ? 0 : all.filter((e) => compareEntries(e, from) <= 0).length
          return { entries: all.slice(start, start + size), more: start + size < all.length }
        }),
      listAfter: (conversationId, afterEntryId, limit) =>
        Effect.sync(() => {
          const all = inConversation(conversationId)
          const anchor = afterEntryId === undefined ? undefined : entries.get(afterEntryId)
          const rest =
            anchor === undefined || anchor.conversationId !== conversationId
              ? all
              : all.filter((e) => compareEntries(e, anchor) > 0)
          return rest.slice(0, Math.max(0, limit))
        }),
      findByClientNonce: (conversationId, clientNonce) =>
        Effect.sync(() =>
          option(
            [...entries.values()].find(
              (e) => e.conversationId === conversationId && e.kind === "message" && e.clientNonce === clientNonce,
            ),
          ),
        ),
      findByNativeId: (conversationId, nativeId) =>
        Effect.sync(() =>
          option(
            [...entries.values()].find(
              (e) => e.conversationId === conversationId && e.harnessRef?.nativeId === nativeId,
            ),
          ),
        ),
      listByTurn: (turnId) =>
        Effect.sync(() => [...entries.values()].filter((e) => e.turnId === turnId).sort(compareEntries)),
    })
  })

// ============================================================================ requests

export const makeMemoryRequestRepo = () =>
  Effect.sync(() => {
    const requests = new Map<RequestId, RuntimeRequest>()
    return RequestRepo.of({
      get: (id) => Effect.sync(() => option(requests.get(id))),
      upsert: (request) => Effect.sync(() => void requests.set(request.id, request)),
      list: (filter) =>
        Effect.sync(() =>
          [...requests.values()]
            .filter((r) => filter?.conversationId === undefined || r.conversationId === filter.conversationId)
            .filter((r) => filter?.botId === undefined || r.botId === filter.botId)
            .filter((r) => filter?.turnId === undefined || r.turnId === filter.turnId)
            .filter((r) => filter?.statuses === undefined || filter.statuses.includes(r.status))
            .sort(byCreatedAt),
        ),
      findByNativeId: (botId, nativeRequestId) =>
        Effect.sync(() =>
          option([...requests.values()].find((r) => r.botId === botId && r.source.nativeRequestId === nativeRequestId)),
        ),
      deleteByConversation: (conversationId) =>
        Effect.sync(() => {
          for (const [id, request] of requests) if (request.conversationId === conversationId) requests.delete(id)
        }),
    })
  })

// ============================================================================ turns

const ACTIVE_TURN_STATUSES: ReadonlyArray<Turn["status"]> = ["queued", "running", "waiting"]

export const makeMemoryTurnRepo = () =>
  Effect.sync(() => {
    const turns = new Map<TurnId, Turn>()
    const byStart = (a: Turn, b: Turn) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    return TurnRepo.of({
      get: (id) => Effect.sync(() => option(turns.get(id))),
      upsert: (turn) => Effect.sync(() => void turns.set(turn.id, turn)),
      listByConversation: (conversationId, limit) =>
        Effect.sync(() => {
          const all = [...turns.values()].filter((t) => t.conversationId === conversationId).sort(byStart)
          return limit <= 0 ? [] : all.slice(-limit)
        }),
      listActive: Effect.sync(() =>
        [...turns.values()].filter((t) => ACTIVE_TURN_STATUSES.includes(t.status)).sort(byStart),
      ),
      deleteByConversation: (conversationId) =>
        Effect.sync(() => {
          for (const [id, turn] of turns) if (turn.conversationId === conversationId) turns.delete(id)
        }),
    })
  })

// ============================================================================ background tasks

export const makeMemoryTaskRepo = (index?: MemorySearchIndex) =>
  Effect.sync(() => {
    const tasks = new Map<TaskId, Task>()
    const steps = new Map<TaskId, Map<EntryId, TranscriptEntry>>()
    const newestFirst = (a: Task, b: Task) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
    return TaskRepo.of({
      get: (id) => Effect.sync(() => option(tasks.get(id))),
      upsert: (task) =>
        Effect.sync(() => {
          tasks.set(task.id, task)
          if (index !== undefined) indexMemoryTask(index, task)
        }),
      list: (filter) =>
        Effect.sync(() => {
          const all = [...tasks.values()]
            .filter((t) => filter?.botId === undefined || t.botId === filter.botId)
            .filter((t) => filter?.conversationId === undefined || t.conversationId === filter.conversationId)
            .filter((t) => filter?.statuses === undefined || filter.statuses.includes(t.status))
            .sort(newestFirst)
          return filter?.limit === undefined ? all : all.slice(0, Math.max(0, Math.floor(filter.limit)))
        }),
      delete: (id) =>
        Effect.sync(() => {
          steps.delete(id)
          index?.docs.delete(id)
          return tasks.delete(id)
        }),
      putStep: (taskId, step) =>
        Effect.sync(() => {
          const map = steps.get(taskId) ?? new Map<EntryId, TranscriptEntry>()
          const current = map.get(step.id)
          map.set(step.id, current === undefined ? step : { ...step, createdAt: current.createdAt })
          steps.set(taskId, map)
        }),
      steps: (taskId) => Effect.sync(() => [...(steps.get(taskId)?.values() ?? [])].sort(compareEntries)),
    })
  })

// ============================================================================ routines

export const makeMemoryRoutineRepo = () =>
  Effect.sync(() => {
    const routines = new Map<RoutineId, Routine>()
    const runs = new Map<RoutineRunId, RoutineRun>()
    const newestFirst = (a: RoutineRun, b: RoutineRun) =>
      b.startedAt - a.startedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
    return RoutineRepo.of({
      get: (id) => Effect.sync(() => option(routines.get(id))),
      list: (filter) =>
        Effect.sync(() =>
          [...routines.values()]
            .filter((r) => filter?.botId === undefined || r.botId === filter.botId)
            .sort(byCreatedAt),
        ),
      upsert: (routine) => Effect.sync(() => void routines.set(routine.id, routine)),
      delete: (id) =>
        Effect.sync(() => {
          for (const [runId, run] of runs) if (run.routineId === id) runs.delete(runId)
          return routines.delete(id)
        }),
      upsertRun: (run) =>
        Effect.sync(() => {
          runs.set(run.id, run)
          const own = [...runs.values()].filter((r) => r.routineId === run.routineId).sort(newestFirst)
          for (const stale of own.slice(ROUTINE_RUNS_KEPT)) runs.delete(stale.id)
        }),
      getRun: (id) => Effect.sync(() => option(runs.get(id))),
      listRuns: (routineId) =>
        Effect.sync(() => [...runs.values()].filter((r) => r.routineId === routineId).sort(newestFirst)),
    })
  })

// ============================================================================ nodes

export const makeMemoryNodeRepo = () =>
  Effect.sync(() => {
    const nodes = new Map<NodeId, NodeRecord>()
    const codes = new Map<string, PairingCodeRecord>()
    return NodeRepo.of({
      get: (id) => Effect.sync(() => option(nodes.get(id))),
      list: Effect.sync(() => [...nodes.values()].sort(byCreatedAt)),
      findByPublicKey: (publicKey) =>
        Effect.sync(() => option([...nodes.values()].find((n) => n.publicKey === publicKey))),
      upsert: (node) => Effect.sync(() => void nodes.set(node.id, node)),
      delete: (id) => Effect.sync(() => nodes.delete(id)),
      putPairingCode: (record) => Effect.sync(() => void codes.set(record.code, record)),
      consumePairingCode: (code, now) =>
        Effect.sync(() => {
          const record = codes.get(code)
          if (record === undefined) return Option.none()
          codes.delete(code)
          return now < record.expiresAt ? Option.some(record) : Option.none()
        }),
    })
  })

// ============================================================================ owner profiles

export const MAIN_PROFILE: OwnerProfile = { id: MAIN_PROFILE_ID, name: "Main", createdAt: 0 as Millis }

export const makeMemoryOwnerProfileRepo = () =>
  Effect.sync(() => {
    const profiles = new Map<OwnerProfileId, OwnerProfile>([[MAIN_PROFILE.id, MAIN_PROFILE]])
    return OwnerProfileRepo.of({
      list: Effect.sync(() => [...profiles.values()].sort(byCreatedAt)),
      get: (id) => Effect.sync(() => option(profiles.get(id))),
      upsert: (profile) => Effect.sync(() => void profiles.set(profile.id, profile)),
      delete: (id) => Effect.sync(() => void profiles.delete(id)),
    })
  })

export const makeMemoryHeldNotificationRepo = () =>
  Effect.sync(() => {
    const held = new Map<OwnerProfileId, Array<HeldNotification>>()
    const dropped = new Map<OwnerProfileId, number>()
    const left = new Map<OwnerProfileId, Millis>()
    return HeldNotificationRepo.of({
      hold: (profileId, item, cap) =>
        Effect.sync(() => {
          const items = [...(held.get(profileId) ?? []), item]
          const over = Math.max(0, items.length - cap)
          held.set(profileId, items.slice(over))
          dropped.set(profileId, (dropped.get(profileId) ?? 0) + over)
        }),
      summary: (profileId) =>
        Effect.sync(() => {
          const since = left.get(profileId)
          return {
            ...(since === undefined ? {} : { since }),
            items: held.get(profileId) ?? [],
            dropped: dropped.get(profileId) ?? 0,
          }
        }),
      dismiss: (profileId, through) =>
        Effect.sync(() => {
          const items = held.get(profileId) ?? []
          const index = items.findIndex((item) => item.notification.id === through)
          if (index === -1) return
          held.set(profileId, items.slice(index + 1))
          dropped.delete(profileId)
        }),
      markLeft: (profileId, at) => Effect.sync(() => void left.set(profileId, at)),
    })
  })

// ============================================================================ approval rules

export const makeMemoryApprovalRuleRepo = () =>
  Effect.sync(() => {
    const rules = new Map<ApprovalRuleId, ApprovalRule>()
    return ApprovalRuleRepo.of({
      get: (id) => Effect.sync(() => option(rules.get(id))),
      list: (filter) =>
        Effect.sync(() =>
          [...rules.values()]
            .filter((r) => r.ownerProfileId === filter.profileId)
            .filter((r) => filter.botId === undefined || r.botId === undefined || r.botId === filter.botId)
            .sort(byCreatedAt),
        ),
      upsert: (rule) => Effect.sync(() => void rules.set(rule.id, rule)),
      delete: (id) => Effect.sync(() => rules.delete(id)),
    })
  })

// ============================================================================ settings

/** Values are deep-copied through JSON, like a real store (catches non-serializable values early). */
const jsonCopy = (op: string, value: unknown) =>
  Effect.try({
    try: () => (value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown)),
    catch: (cause) => new RepoError({ op, message: "Value is not JSON-serializable", cause }),
  })

/** `initial`: the brain's own keys (the main profile's). */
export const makeMemorySettingsRepo = (initial?: Readonly<Record<string, unknown>>) =>
  Effect.sync(() => {
    const profiles = new Map<OwnerProfileId, Map<string, unknown>>([
      [MAIN_PROFILE_ID, new Map(Object.entries(initial ?? {}))],
    ])
    const storeOf = (profileId: OwnerProfileId): SettingsStore => {
      const values = () => {
        const found = profiles.get(profileId)
        if (found !== undefined) return found
        const created = new Map<string, unknown>()
        profiles.set(profileId, created)
        return created
      }
      return {
        get: (key) => Effect.sync(() => (values().has(key) ? Option.some(values().get(key)) : Option.none())),
        getAll: Effect.sync(() => new Map(values())),
        set: (key, value) => Effect.map(jsonCopy("SettingsRepo.set", value), (copy) => void values().set(key, copy)),
        remove: (key) => Effect.sync(() => void values().delete(key)),
      }
    }
    return SettingsRepo.of({ ...storeOf(MAIN_PROFILE_ID), forProfile: storeOf })
  })

// ============================================================================ usage

export const addUsage = (a: Usage, b: Usage): Usage => {
  const sumOptional = (x: number | undefined, y: number | undefined) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0)
  const cached = sumOptional(a.cachedInputTokens, b.cachedInputTokens)
  const reasoning = sumOptional(a.reasoningTokens, b.reasoningTokens)
  const cost = sumOptional(a.costUsd, b.costUsd)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    ...(cost === undefined ? {} : { costUsd: cost }),
  }
}

export const makeMemoryUsageRepo = () =>
  Effect.sync(() => {
    const records: Array<UsageRecord> = []
    return UsageRepo.of({
      record: (record) => Effect.sync(() => void records.push(record)),
      totalsByBot: (sinceMs?: Millis) =>
        Effect.sync(() => {
          const totals = new Map<BotId, { usage: Usage; records: number; turns: Set<string>; lastAt: Millis }>()
          for (const r of records) {
            if (sinceMs !== undefined && r.at < sinceMs) continue
            const current = totals.get(r.botId)
            if (current === undefined) {
              totals.set(r.botId, {
                usage: r.usage,
                records: 1,
                turns: new Set(r.turnId === undefined ? [] : [r.turnId]),
                lastAt: r.at,
              })
            } else {
              current.usage = addUsage(current.usage, r.usage)
              current.records += 1
              if (r.turnId !== undefined) current.turns.add(r.turnId)
              current.lastAt = Math.max(current.lastAt, r.at) as Millis
            }
          }
          return [...totals.entries()]
            .map(([botId, t]): UsageTotals => ({
              botId,
              usage: t.usage,
              records: t.records,
              turnCount: t.turns.size,
              lastAt: t.lastAt,
            }))
            .sort((a, b) => (a.botId < b.botId ? -1 : a.botId > b.botId ? 1 : 0))
        }),
      list: (filter) =>
        Effect.sync(() =>
          records.filter(
            (r) =>
              (filter?.botId === undefined || r.botId === filter.botId) &&
              (filter?.sinceMs === undefined || r.at >= filter.sinceMs),
          ),
        ),
    })
  })

// ============================================================================ replica log

export const makeMemoryReplicaLog = (window: number = REPLICA_LOG_WINDOW) =>
  Effect.sync(() => {
    const heads = new Map<ReplicaKey, StreamCursor>()
    const logs = new Map<ReplicaKey, Array<ReplicaRecord>>()
    return ReplicaLog.of({
      head: (replicaKey) => Effect.sync(() => option(heads.get(replicaKey))),
      append: (record) =>
        Effect.gen(function* () {
          const head = heads.get(record.replicaKey)
          if (head !== undefined && (head.epoch !== record.epoch || record.sequence !== head.sequence + 1)) {
            return yield* new RepoError({
              op: "ReplicaLog.append",
              message: `Out-of-order append to ${record.replicaKey}: head ${head.epoch}/${head.sequence}, got ${record.epoch}/${record.sequence}`,
            })
          }
          const log = head === undefined ? [] : (logs.get(record.replicaKey) ?? [])
          log.push(record)
          if (log.length > window) log.splice(0, log.length - window)
          logs.set(record.replicaKey, log)
          heads.set(record.replicaKey, { epoch: record.epoch, sequence: record.sequence })
        }),
      readAfter: (replicaKey, cursor) =>
        Effect.sync(() => {
          const head = heads.get(replicaKey)
          if (head === undefined || head.epoch !== cursor.epoch || cursor.sequence > head.sequence) return Option.none()
          if (cursor.sequence === head.sequence) return Option.some([])
          const log = logs.get(replicaKey) ?? []
          const oldest = log[0]
          // The record right after the cursor must still be in the window.
          if (oldest === undefined || oldest.sequence > cursor.sequence + 1) return Option.none()
          return Option.some(log.filter((r) => r.sequence > cursor.sequence))
        }),
      reset: (replicaKey, epoch) =>
        Effect.sync(() => {
          heads.set(replicaKey, { epoch, sequence: 0 })
          logs.set(replicaKey, [])
        }),
      drop: (replicaKey) =>
        Effect.sync(() => {
          heads.delete(replicaKey)
          logs.delete(replicaKey)
        }),
    })
  })

// ============================================================================ MCP tokens & process ledger

export const makeMemoryMcpTokenRepo = () =>
  Effect.sync(() => {
    const tokens = new Map<string, McpTokenRecord>()
    return McpTokenRepo.of({
      put: (record) => Effect.sync(() => void tokens.set(record.hash, record)),
      lookup: (hash) => Effect.sync(() => option(tokens.get(hash))),
      revoke: (hash) =>
        Effect.sync(() => {
          const record = tokens.get(hash)
          if (record !== undefined) tokens.set(hash, { ...record, revoked: true })
        }),
      revokeAll: (botId) =>
        Effect.sync(() => {
          for (const [hash, record] of tokens) {
            if (botId === undefined || record.claims.botId === botId) tokens.set(hash, { ...record, revoked: true })
          }
        }),
    })
  })

export const makeMemoryProcessLedger = () =>
  Effect.sync(() => {
    const records = new Map<number, ProcessRecord>()
    return ProcessLedger.of({
      record: (entry) => Effect.sync(() => void records.set(entry.pid, entry)),
      remove: (pid) => Effect.sync(() => void records.delete(pid)),
      list: Effect.sync(() => [...records.values()].sort((a, b) => a.startedAt - b.startedAt)),
      clear: Effect.sync(() => records.clear()),
    })
  })

// ============================================================================ layers

export const MemoryBotRepo = Layer.effect(BotRepo, makeMemoryBotRepo())
export const MemorySectionRepo = Layer.effect(SectionRepo, makeMemorySectionRepo())
export const MemoryConversationRepo = Layer.effect(ConversationRepo, makeMemoryConversationRepo())
export const MemoryEntryRepo = Layer.effect(EntryRepo, makeMemoryEntryRepo())
export const MemoryRequestRepo = Layer.effect(RequestRepo, makeMemoryRequestRepo())
export const MemoryTurnRepo = Layer.effect(TurnRepo, makeMemoryTurnRepo())
export const MemoryTaskRepo = Layer.effect(TaskRepo, makeMemoryTaskRepo())
/**
 * `EntryRepo`, `TaskRepo` and `SearchRepo` over one search index (what `MemoryPersistence` uses):
 * writes to entries and tasks are searchable at once. Needs `ConversationRepo` and `TurnRepo`.
 */
export const MemorySearchableTranscript: Layer.Layer<
  EntryRepo | TaskRepo | SearchRepo,
  never,
  ConversationRepo | TurnRepo | BotRepo
> = Layer.effectContext(
  Effect.gen(function* () {
    const index = makeMemorySearchIndex()
    return Context.make(EntryRepo, yield* makeMemoryEntryRepo(index)).pipe(
      Context.add(TaskRepo, yield* makeMemoryTaskRepo(index)),
      Context.add(SearchRepo, yield* makeMemorySearchRepo(index)),
    )
  }),
)
export const MemoryRoutineRepo = Layer.effect(RoutineRepo, makeMemoryRoutineRepo())
export const MemoryNodeRepo = Layer.effect(NodeRepo, makeMemoryNodeRepo())
export const MemoryOwnerProfileRepo = Layer.effect(OwnerProfileRepo, makeMemoryOwnerProfileRepo())
/** The in-memory repositories drop with their records; nothing is left to purge. */
export const MemoryProfileStorage = Layer.succeed(ProfileStorage, ProfileStorage.of({ purge: () => Effect.void }))
export const MemoryHeldNotificationRepo = Layer.effect(HeldNotificationRepo, makeMemoryHeldNotificationRepo())
export const MemoryApprovalRuleRepo = Layer.effect(ApprovalRuleRepo, makeMemoryApprovalRuleRepo())
export const MemorySettingsRepo = (initial?: Readonly<Record<string, unknown>>) =>
  Layer.effect(SettingsRepo, makeMemorySettingsRepo(initial))
export const MemoryUsageRepo = Layer.effect(UsageRepo, makeMemoryUsageRepo())
export const MemoryReplicaLog = Layer.effect(ReplicaLog, makeMemoryReplicaLog())
export const MemoryMcpTokenRepo = Layer.effect(McpTokenRepo, makeMemoryMcpTokenRepo())
export const MemoryProcessLedger = Layer.effect(ProcessLedger, makeMemoryProcessLedger())

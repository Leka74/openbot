/**
 * The owner's queue (`DecisionQueue`): what Bots put in front of the owner, ranked, for the owner to
 * burn down to zero. One SQLite file (`<data>/queue.sqlite`), synchronous, every method takes `now`.
 *
 * - Items belong to the Bot that added them (and the conversation it added them from, where its
 *   decision goes back). A `key` makes re-adding update the same item: an open item gets the new
 *   content (a new revision when it changed); a closed one stays closed until its content materially
 *   changes, then it comes back as the next revision.
 * - Decisions: approve (optionally an option), reject and reply (with a note) and trash go back to the
 *   Bot after `UNDO_GRACE_MS` (undo works until then); done ("skip") closes the item and tells nobody;
 *   snooze hides it until a time.
 * - Burn-down: open items of the same Bot and type (split at two weeks old), three or more, show as one
 *   stack that clears in one go. "Not this kind" rules close matching items now and on every add. Items
 *   that matter are never stacked or filtered: stakes 2–3, blocking, due within three days or overdue.
 * - Nothing is deleted: a rule turned off brings its items back.
 */
import { Database } from "bun:sqlite"

export const UNDO_GRACE_MS = 20_000
/** How long done/cleared items can be brought back with undo. */
export const UNDO_WINDOW_MS = 60 * 60_000
const DAY = 86_400_000
const STACK_MIN = 3
const STACK_SPLIT_DAYS = 14

export type QueueItemType = "decision" | "review" | "fyi"
export type QueueAction = "approve" | "reject" | "reply" | "skip" | "drop" | "snooze"
/** Actions the Bot hears about. */
const DELIVERED: ReadonlySet<QueueAction> = new Set(["approve", "reject", "reply", "drop"])

export interface QueueEvidence {
  readonly text: string
  readonly url?: string | undefined
}

export interface QueueAddInput {
  readonly profileId: string
  readonly botId: string
  readonly botName: string
  readonly conversationId: string
  /** Groups items into splits (e.g. the Bot's sidebar section). */
  readonly area: string
  readonly type: QueueItemType
  readonly title: string
  readonly why: string
  readonly recommendation?: string | undefined
  readonly options?: ReadonlyArray<string> | undefined
  /** 1-based index into `options`. */
  readonly recommendedOption?: number | undefined
  readonly evidence?: ReadonlyArray<QueueEvidence> | undefined
  /** `YYYY-MM-DD`. */
  readonly due?: string | undefined
  readonly stakes?: 1 | 2 | 3 | undefined
  readonly blocking?: boolean | undefined
  readonly key?: string | undefined
}

export type QueueAddResult =
  | { readonly _tag: "added"; readonly id: string }
  | { readonly _tag: "updated"; readonly id: string; readonly revision: number }
  | { readonly _tag: "unchanged"; readonly id: string; readonly closed?: string | undefined }
  | { readonly _tag: "filtered"; readonly id: string; readonly rule: { readonly id: number; readonly label: string } }

export interface QueueItemView {
  readonly id: string
  readonly key: string
  readonly revision: number
  readonly botId: string
  readonly owner: string
  readonly area: string
  readonly type: QueueItemType
  readonly title: string
  readonly why: string
  readonly recommendation: string | null
  readonly options: ReadonlyArray<{ readonly id: number; readonly label: string }>
  readonly recOption: number | null
  readonly evidence: ReadonlyArray<QueueEvidence>
  readonly due: string | null
  readonly stakes: number
  readonly blocking: boolean
  readonly createdMs: number
  readonly score: number
  readonly reasons: ReadonlyArray<string>
}

export interface QueueStack {
  readonly sig: string
  readonly label: string
  readonly type: QueueItemType
  readonly area: string
  readonly owner: string
  readonly count: number
  readonly ids: ReadonlyArray<string>
  readonly sample: ReadonlyArray<{ readonly id: string; readonly title: string }>
  readonly newestDays: number
  readonly oldestDays: number
}

export interface QueueRuleMatch {
  readonly botId?: string | undefined
  readonly type?: QueueItemType | undefined
  readonly titleHas?: string | undefined
}

export interface QueueRuleView {
  readonly id: number
  readonly label: string
  readonly reason: string
  readonly on: boolean
  readonly filtered: number
}

export interface QueueState {
  readonly items: ReadonlyArray<QueueItemView>
  readonly stacks: ReadonlyArray<QueueStack>
  readonly rules: ReadonlyArray<QueueRuleView>
  readonly openTotal: number
  readonly clearedToday: number
  readonly pendingDelivery: number
}

export interface QueueDecideInput {
  readonly profileId: string
  readonly ids: ReadonlyArray<string>
  readonly action: QueueAction
  /** Option id (1-based) for approve. */
  readonly option?: number | undefined
  readonly note?: string | undefined
  /** Snooze: hours from now. */
  readonly hours?: number | undefined
}

/** A decision the Bot should hear about now (its undo grace is over). */
export interface QueueDelivery {
  readonly decisionId: number
  readonly profileId: string
  readonly botId: string
  readonly conversationId: string
  readonly itemId: string
  readonly key: string
  readonly title: string
  readonly action: QueueAction
  readonly option: string | null
  readonly note: string | null
}

export class QueueError extends Error {}

interface ItemRow {
  id: string
  profile_id: string
  key: string
  revision: number
  bot_id: string
  bot_name: string
  conversation_id: string
  area: string
  type: QueueItemType
  title: string
  why: string
  recommendation: string | null
  options: string
  rec_option: number | null
  evidence: string
  due: string | null
  stakes: number
  blocking: number
  fingerprint: string
  status: "open" | "snoozed" | "closed"
  snooze_until: number | null
  close_reason: string | null
  filtered_by: number | null
  created_ms: number
  updated_ms: number
  closed_ms: number | null
}

interface RuleRow {
  id: number
  profile_id: string
  match_json: string
  label: string
  reason: string
  enabled: number
  created_ms: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  bot_id TEXT NOT NULL,
  bot_name TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  area TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  why TEXT NOT NULL,
  recommendation TEXT,
  options TEXT NOT NULL,
  rec_option INTEGER,
  evidence TEXT NOT NULL,
  due TEXT,
  stakes INTEGER NOT NULL,
  blocking INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  snooze_until INTEGER,
  close_reason TEXT,
  filtered_by INTEGER,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  closed_ms INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS items_key ON items (profile_id, bot_id, key);
CREATE INDEX IF NOT EXISTS items_status ON items (profile_id, status);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch TEXT NOT NULL,
  item_id TEXT NOT NULL,
  action TEXT NOT NULL,
  option INTEGER,
  note TEXT,
  deliver INTEGER NOT NULL,
  decided_ms INTEGER NOT NULL,
  undone_ms INTEGER,
  delivered_ms INTEGER
);
CREATE INDEX IF NOT EXISTS decisions_pending ON decisions (deliver, delivered_ms, undone_ms);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL,
  match_json TEXT NOT NULL,
  label TEXT NOT NULL,
  reason TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  created_ms INTEGER NOT NULL
);
`

const startOfDay = (ms: number): number => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Whole days from today to `due` (negative: overdue); undefined when `due` isn't a date. */
const daysUntil = (due: string | null, now: number): number | undefined => {
  if (due === null || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return undefined
  const [y, m, d] = due.split("-").map(Number) as [number, number, number]
  return Math.round((new Date(y, m - 1, d).getTime() - startOfDay(now)) / DAY)
}

const ageDays = (row: ItemRow, now: number): number => Math.max(0, Math.floor((now - row.created_ms) / DAY))

/** Never stacked or filtered. */
const isProtected = (row: ItemRow, now: number): boolean => {
  const days = daysUntil(row.due, now)
  return row.stakes >= 2 || row.blocking === 1 || (days !== undefined && days <= 3)
}

const rank = (row: ItemRow, now: number): { readonly score: number; readonly reasons: Array<string> } => {
  const reasons: Array<string> = []
  let score = row.type === "decision" ? 30 : row.type === "review" ? 20 : 5
  if (row.stakes >= 3) {
    score += 30
    reasons.push("critical")
  } else if (row.stakes === 2) {
    score += 15
    reasons.push("high stakes")
  }
  if (row.blocking === 1) {
    score += 15
    reasons.push("blocking work")
  }
  const days = daysUntil(row.due, now)
  if (days !== undefined) {
    if (days < 0) {
      score += 30
      reasons.push(`overdue ${-days}d`)
    } else if (days === 0) {
      score += 25
      reasons.push("due today")
    } else if (days === 1) {
      score += 20
      reasons.push("due tomorrow")
    } else if (days <= 7) {
      score += days <= 3 ? 12 : 5
      reasons.push(`due in ${days}d`)
    }
  }
  const age = ageDays(row, now)
  score += Math.min(14, age)
  if (age >= 2) reasons.push(`waiting ${age}d`)
  return { score, reasons }
}

const parseJson = <A>(text: string, fallback: A): A => {
  try {
    return JSON.parse(text) as A
  } catch {
    return fallback
  }
}

const optionsOf = (row: ItemRow): ReadonlyArray<{ readonly id: number; readonly label: string }> =>
  parseJson<Array<string>>(row.options, []).map((label, i) => ({ id: i + 1, label }))

const ruleMatches = (match: QueueRuleMatch, row: ItemRow): boolean =>
  (match.botId === undefined || match.botId === row.bot_id) &&
  (match.type === undefined || match.type === row.type) &&
  (match.titleHas === undefined || row.title.toLowerCase().includes(match.titleHas.toLowerCase()))

const fingerprintOf = (input: QueueAddInput): string =>
  JSON.stringify([
    input.type,
    input.title,
    input.why,
    input.recommendation ?? null,
    input.options ?? [],
    input.recommendedOption ?? null,
    input.evidence ?? [],
    input.due ?? null,
    input.stakes ?? 1,
    input.blocking === true,
  ])

const TYPE_PLURAL: Record<QueueItemType, string> = { decision: "decisions", review: "reviews", fyi: "FYIs" }

export class QueueStore {
  private readonly db: Database

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true })
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  private nextId(): string {
    const row = this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM items").get()
    let n = (row?.n ?? 0) + 1
    while (this.db.query("SELECT 1 FROM items WHERE id = ?").get(`q${n}`) !== null) n += 1
    return `q${n}`
  }

  private item(profileId: string, id: string): ItemRow | undefined {
    return (
      this.db
        .query<ItemRow, [string, string]>("SELECT * FROM items WHERE profile_id = ? AND id = ?")
        .get(profileId, id) ?? undefined
    )
  }

  private rules(profileId: string): Array<RuleRow> {
    return this.db.query<RuleRow, [string]>("SELECT * FROM rules WHERE profile_id = ? ORDER BY id").all(profileId)
  }

  /** The first enabled rule that catches `row`, unless it is protected. */
  private filterFor(row: ItemRow, now: number): RuleRow | undefined {
    if (isProtected(row, now)) return undefined
    return this.rules(row.profile_id).find((r) => r.enabled === 1 && ruleMatches(parseJson(r.match_json, {}), row))
  }

  private closeFiltered(row: ItemRow, rule: RuleRow, now: number): void {
    this.db
      .query("UPDATE items SET status = 'closed', close_reason = ?, filtered_by = ?, closed_ms = ? WHERE id = ?")
      .run(`filtered by rule #${rule.id}`, rule.id, now, row.id)
  }

  add(input: QueueAddInput, now: number): QueueAddResult {
    if (input.title.trim() === "") throw new QueueError("an item needs a title")
    if (input.recommendedOption !== undefined) {
      const count = input.options?.length ?? 0
      if (input.recommendedOption < 1 || input.recommendedOption > count)
        throw new QueueError(`recommended_option must be between 1 and ${count}`)
    }
    const fingerprint = fingerprintOf(input)
    const fields = {
      bot_name: input.botName,
      conversation_id: input.conversationId,
      area: input.area,
      type: input.type,
      title: input.title.trim(),
      why: input.why.trim(),
      recommendation: input.recommendation?.trim() || null,
      options: JSON.stringify(input.options ?? []),
      rec_option: input.recommendedOption ?? null,
      evidence: JSON.stringify(input.evidence ?? []),
      due: input.due ?? null,
      stakes: input.stakes ?? 1,
      blocking: input.blocking === true ? 1 : 0,
      fingerprint,
    }
    return this.db.transaction((): QueueAddResult => {
      const existing =
        input.key === undefined
          ? undefined
          : (this.db
              .query<ItemRow, [string, string, string]>(
                "SELECT * FROM items WHERE profile_id = ? AND bot_id = ? AND key = ?",
              )
              .get(input.profileId, input.botId, input.key) ?? undefined)
      if (existing !== undefined && existing.fingerprint === fingerprint) {
        return existing.status === "closed"
          ? { _tag: "unchanged", id: existing.id, closed: existing.close_reason ?? "closed" }
          : { _tag: "unchanged", id: existing.id }
      }
      let id: string
      let revision = 1
      if (existing !== undefined) {
        id = existing.id
        revision = existing.revision + 1
        this.db
          .query(
            `UPDATE items SET revision = $revision, bot_name = $bot_name, conversation_id = $conversation_id, area = $area,
               type = $type, title = $title, why = $why, recommendation = $recommendation, options = $options,
               rec_option = $rec_option, evidence = $evidence, due = $due, stakes = $stakes, blocking = $blocking,
               fingerprint = $fingerprint, status = 'open', snooze_until = NULL, close_reason = NULL, filtered_by = NULL,
               closed_ms = NULL, updated_ms = $now WHERE id = $id`,
          )
          .run({ ...fields, revision, now, id })
      } else {
        id = this.nextId()
        this.db
          .query(
            `INSERT INTO items (id, profile_id, key, revision, bot_id, bot_name, conversation_id, area, type, title, why,
               recommendation, options, rec_option, evidence, due, stakes, blocking, fingerprint, status, created_ms, updated_ms)
             VALUES ($id, $profile_id, $key, 1, $bot_id, $bot_name, $conversation_id, $area, $type, $title, $why,
               $recommendation, $options, $rec_option, $evidence, $due, $stakes, $blocking, $fingerprint, 'open', $now, $now)`,
          )
          .run({ ...fields, id, profile_id: input.profileId, key: input.key ?? id, bot_id: input.botId, now })
      }
      const row = this.item(input.profileId, id)!
      const rule = this.filterFor(row, now)
      if (rule !== undefined) {
        this.closeFiltered(row, rule, now)
        return { _tag: "filtered", id, rule: { id: rule.id, label: rule.label } }
      }
      return existing === undefined ? { _tag: "added", id } : { _tag: "updated", id, revision }
    })()
  }

  /** Brings snoozed items whose time came back into the queue. */
  private wake(profileId: string, now: number): void {
    this.db
      .query(
        "UPDATE items SET status = 'open', snooze_until = NULL WHERE profile_id = ? AND status = 'snoozed' AND snooze_until <= ?",
      )
      .run(profileId, now)
  }

  private openRows(profileId: string, now: number): Array<ItemRow> {
    this.wake(profileId, now)
    return this.db
      .query<ItemRow, [string]>("SELECT * FROM items WHERE profile_id = ? AND status = 'open'")
      .all(profileId)
  }

  private view(row: ItemRow, now: number): QueueItemView {
    const { score, reasons } = rank(row, now)
    return {
      id: row.id,
      key: row.key,
      revision: row.revision,
      botId: row.bot_id,
      owner: row.bot_name,
      area: row.area,
      type: row.type,
      title: row.title,
      why: row.why,
      recommendation: row.recommendation,
      options: optionsOf(row),
      recOption: row.rec_option,
      evidence: parseJson<Array<QueueEvidence>>(row.evidence, []),
      due: row.due,
      stakes: row.stakes,
      blocking: row.blocking === 1,
      createdMs: row.created_ms,
      score,
      reasons,
    }
  }

  private stacksOf(rows: ReadonlyArray<ItemRow>, now: number): Array<QueueStack> {
    const groups = new Map<string, Array<ItemRow>>()
    for (const row of rows) {
      if (isProtected(row, now)) continue
      const old = ageDays(row, now) >= STACK_SPLIT_DAYS
      const sig = `${row.bot_id}|${row.type}|${old ? "old" : "new"}`
      groups.set(sig, [...(groups.get(sig) ?? []), row])
    }
    const stacks: Array<QueueStack> = []
    for (const [sig, group] of groups) {
      if (group.length < STACK_MIN) continue
      const sorted = [...group].sort((a, b) => b.created_ms - a.created_ms)
      const first = sorted[0]!
      const old = sig.endsWith("|old")
      stacks.push({
        sig,
        label: `${TYPE_PLURAL[first.type]} from ${first.bot_name}${old ? ", over two weeks old" : ""}`,
        type: first.type,
        area: first.area,
        owner: first.bot_name,
        count: sorted.length,
        ids: sorted.map((r) => r.id),
        sample: sorted.slice(0, 5).map((r) => ({ id: r.id, title: r.title })),
        newestDays: ageDays(first, now),
        oldestDays: ageDays(sorted[sorted.length - 1]!, now),
      })
    }
    return stacks.sort((a, b) => b.count - a.count)
  }

  state(profileId: string, now: number): QueueState {
    const rows = this.openRows(profileId, now)
    const items = rows.map((row) => this.view(row, now)).sort((a, b) => b.score - a.score || a.createdMs - b.createdMs)
    const filteredCounts = new Map(
      this.db
        .query<{ filtered_by: number; n: number }, [string]>(
          "SELECT filtered_by, count(*) AS n FROM items WHERE profile_id = ? AND status = 'closed' AND filtered_by IS NOT NULL GROUP BY filtered_by",
        )
        .all(profileId)
        .map((r) => [r.filtered_by, r.n] as const),
    )
    const cleared = this.db
      .query<{ n: number }, [string, number]>(
        "SELECT count(*) AS n FROM items WHERE profile_id = ? AND status = 'closed' AND closed_ms >= ?",
      )
      .get(profileId, startOfDay(now))
    const pending = this.db
      .query<{ n: number }, [string]>(
        `SELECT count(*) AS n FROM decisions d JOIN items i ON i.id = d.item_id
         WHERE i.profile_id = ? AND d.deliver = 1 AND d.delivered_ms IS NULL AND d.undone_ms IS NULL`,
      )
      .get(profileId)
    return {
      items,
      stacks: this.stacksOf(rows, now),
      rules: this.rules(profileId).map((r) => ({
        id: r.id,
        label: r.label,
        reason: r.reason,
        on: r.enabled === 1,
        filtered: filteredCounts.get(r.id) ?? 0,
      })),
      openTotal: items.length,
      clearedToday: cleared?.n ?? 0,
      pendingDelivery: pending?.n ?? 0,
    }
  }

  decide(input: QueueDecideInput, now: number): { readonly decided: number } {
    if (input.ids.length === 0) throw new QueueError("nothing selected")
    if (input.ids.length > 1 && input.action !== "skip" && input.action !== "snooze")
      throw new QueueError("only done and remind me work on several items at once")
    if ((input.action === "reject" || input.action === "reply") && (input.note ?? "").trim() === "")
      throw new QueueError(input.action === "reply" ? "say what should change" : "say why not")
    const batch = `b${now}-${Math.random().toString(36).slice(2, 8)}`
    return this.db.transaction(() => {
      let decided = 0
      for (const id of input.ids) {
        const row = this.item(input.profileId, id)
        if (row === undefined || row.status === "closed") continue
        if (input.action === "snooze") {
          const hours = Math.max(0.25, input.hours ?? 3)
          this.db
            .query("UPDATE items SET status = 'snoozed', snooze_until = ? WHERE id = ?")
            .run(Math.round(now + hours * 3_600_000), id)
        } else {
          let option: number | null = null
          if (input.action === "approve") {
            const options = optionsOf(row)
            option = input.option ?? (options.length > 0 ? row.rec_option : null)
            if (options.length > 0 && option === null) throw new QueueError("pick an option")
            if (option !== null && !options.some((o) => o.id === option)) throw new QueueError("no such option")
          }
          this.db
            .query("UPDATE items SET status = 'closed', close_reason = ?, closed_ms = ? WHERE id = ?")
            .run(input.action === "skip" ? "done" : input.action, now, id)
          this.db
            .query(
              "INSERT INTO decisions (batch, item_id, action, option, note, deliver, decided_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .run(batch, id, input.action, option, input.note?.trim() || null, DELIVERED.has(input.action) ? 1 : 0, now)
        }
        decided += 1
      }
      if (decided === 0) throw new QueueError("that's no longer in the queue")
      return { decided }
    })()
  }

  /** Clears a stack: every item of it that is still open and still in it is done (one undo brings all back). */
  clearStack(profileId: string, sig: string, ids: ReadonlyArray<string>, now: number): { readonly cleared: number } {
    const stack = this.stacksOf(this.openRows(profileId, now), now).find((s) => s.sig === sig)
    if (stack === undefined) throw new QueueError("that stack has changed; look again")
    const seen = new Set(ids)
    const clear = stack.ids.filter((id) => seen.has(id))
    if (clear.length === 0) throw new QueueError("that stack has changed; look again")
    return { cleared: this.decide({ profileId, ids: clear, action: "skip" }, now).decided }
  }

  /** Undoes the latest decision batch still in reach: done within the hour, the rest before it reached the Bot. */
  undo(profileId: string, now: number): { readonly item: string | null; readonly count: number } {
    return this.db.transaction(() => {
      const last = this.db
        .query<{ batch: string }, [string, number, number]>(
          `SELECT d.batch FROM decisions d JOIN items i ON i.id = d.item_id
           WHERE i.profile_id = ? AND d.undone_ms IS NULL AND d.delivered_ms IS NULL
             AND ((d.deliver = 0 AND d.decided_ms >= ?) OR d.deliver = 1) AND d.decided_ms <= ?
           ORDER BY d.decided_ms DESC, d.id DESC LIMIT 1`,
        )
        .get(profileId, now - UNDO_WINDOW_MS, now)
      if (last === null) return { item: null, count: 0 }
      const rows = this.db
        .query<{ id: number; item_id: string }, [string]>(
          "SELECT id, item_id FROM decisions WHERE batch = ? AND undone_ms IS NULL",
        )
        .all(last.batch)
      for (const d of rows) {
        this.db.query("UPDATE decisions SET undone_ms = ? WHERE id = ?").run(now, d.id)
        this.db
          .query(
            "UPDATE items SET status = 'open', close_reason = NULL, closed_ms = NULL WHERE id = ? AND status = 'closed' AND filtered_by IS NULL",
          )
          .run(d.item_id)
      }
      return { item: rows[0]?.item_id ?? null, count: rows.length }
    })()
  }

  // ---------------------------------------------------------------- rules ("not this kind")

  private labelOf(profileId: string, match: QueueRuleMatch): string {
    const bot =
      match.botId === undefined
        ? undefined
        : (this.db
            .query<{ bot_name: string }, [string, string]>(
              "SELECT bot_name FROM items WHERE profile_id = ? AND bot_id = ? ORDER BY updated_ms DESC LIMIT 1",
            )
            .get(profileId, match.botId)?.bot_name ?? "a Bot")
    const what = match.type === undefined ? "anything" : TYPE_PLURAL[match.type]
    const parts = [
      bot === undefined ? `${match.type === undefined ? "anything" : `any ${what}`}` : `${what} from ${bot}`,
    ]
    if (match.titleHas !== undefined) parts.push(`with "${match.titleHas}" in the title`)
    return match.botId === undefined && match.type === undefined && match.titleHas !== undefined
      ? `anything with "${match.titleHas}" in the title`
      : parts.join(" ")
  }

  private normalizeMatch(match: QueueRuleMatch): QueueRuleMatch {
    const titleHas = match.titleHas?.trim()
    const out: QueueRuleMatch = {
      ...(match.botId === undefined ? {} : { botId: match.botId }),
      ...(match.type === undefined ? {} : { type: match.type }),
      ...(titleHas === undefined || titleHas === "" ? {} : { titleHas }),
    }
    if (out.botId === undefined && out.type === undefined && out.titleHas === undefined)
      throw new QueueError("a rule needs a Bot, a type or a title phrase")
    if (out.titleHas !== undefined && out.titleHas.length < 3) throw new QueueError("a title phrase needs 3+ letters")
    return out
  }

  /** How many open items a rule would catch now, and how many of those stay because they're protected. */
  preview(
    profileId: string,
    match: QueueRuleMatch,
    now: number,
  ): { readonly match: QueueRuleMatch; readonly label: string; readonly count: number; readonly protected: number } {
    const m = this.normalizeMatch(match)
    const hits = this.openRows(profileId, now).filter((row) => ruleMatches(m, row))
    const kept = hits.filter((row) => isProtected(row, now)).length
    return { match: m, label: this.labelOf(profileId, m), count: hits.length - kept, protected: kept }
  }

  /** Narrow to broad: this Bot's items of this type, anything from this Bot, anything of this type. */
  suggest(profileId: string, target: { readonly id?: string; readonly sig?: string }, now: number) {
    let botId: string | undefined
    let type: QueueItemType | undefined
    if (target.id !== undefined) {
      const row = this.item(profileId, target.id)
      if (row === undefined) throw new QueueError("that's no longer in the queue")
      botId = row.bot_id
      type = row.type
    } else if (target.sig !== undefined) {
      const [bot, kind] = target.sig.split("|")
      botId = bot
      type = kind as QueueItemType
    }
    if (botId === undefined || type === undefined) throw new QueueError("nothing to base a rule on")
    return [{ botId, type }, { botId }, { type }].map((match) => this.preview(profileId, match, now))
  }

  addRule(
    profileId: string,
    match: QueueRuleMatch,
    reason: string,
    now: number,
  ): { readonly id: number; readonly filtered: number } {
    const m = this.normalizeMatch(match)
    return this.db.transaction(() => {
      const result = this.db
        .query(
          "INSERT INTO rules (profile_id, match_json, label, reason, enabled, created_ms) VALUES (?, ?, ?, ?, 1, ?)",
        )
        .run(profileId, JSON.stringify(m), this.labelOf(profileId, m), reason.trim(), now)
      const rule = this.db
        .query<RuleRow, [number]>("SELECT * FROM rules WHERE id = ?")
        .get(Number(result.lastInsertRowid))!
      let filtered = 0
      for (const row of this.openRows(profileId, now)) {
        if (!isProtected(row, now) && ruleMatches(m, row)) {
          this.closeFiltered(row, rule, now)
          filtered += 1
        }
      }
      return { id: rule.id, filtered }
    })()
  }

  /** Turns a rule off: the items it filtered come back. */
  ruleOff(profileId: string, id: number): { readonly restored: number } {
    return this.db.transaction(() => {
      const changed = this.db
        .query("UPDATE rules SET enabled = 0 WHERE profile_id = ? AND id = ? AND enabled = 1")
        .run(profileId, id)
      if (changed.changes === 0) throw new QueueError("no such rule")
      const restored = this.db
        .query(
          "UPDATE items SET status = 'open', close_reason = NULL, filtered_by = NULL, closed_ms = NULL WHERE profile_id = ? AND filtered_by = ?",
        )
        .run(profileId, id)
      return { restored: restored.changes }
    })()
  }

  // ---------------------------------------------------------------- deliveries to the Bots

  /** Decisions whose undo grace is over and that the Bot hasn't heard about yet. */
  due(now: number): Array<QueueDelivery> {
    return this.db
      .query<
        {
          id: number
          action: QueueAction
          option: number | null
          note: string | null
          profile_id: string
          bot_id: string
          conversation_id: string
          item_id: string
          key: string
          title: string
          options: string
        },
        [number]
      >(
        `SELECT d.id, d.action, d.option, d.note, i.profile_id, i.bot_id, i.conversation_id, i.id AS item_id, i.key, i.title, i.options
         FROM decisions d JOIN items i ON i.id = d.item_id
         WHERE d.deliver = 1 AND d.delivered_ms IS NULL AND d.undone_ms IS NULL AND d.decided_ms <= ?
         ORDER BY d.id`,
      )
      .all(now - UNDO_GRACE_MS)
      .map((r) => ({
        decisionId: r.id,
        profileId: r.profile_id,
        botId: r.bot_id,
        conversationId: r.conversation_id,
        itemId: r.item_id,
        key: r.key,
        title: r.title,
        action: r.action,
        option: r.option === null ? null : (parseJson<Array<string>>(r.options, [])[r.option - 1] ?? null),
        note: r.note,
      }))
  }

  markDelivered(decisionIds: ReadonlyArray<number>, now: number): void {
    const mark = this.db.query("UPDATE decisions SET delivered_ms = ? WHERE id = ?")
    this.db.transaction(() => {
      for (const id of decisionIds) mark.run(now, id)
    })()
  }
}

/** What the Bot reads when the owner decided one of its items. */
export const decisionText = (d: QueueDelivery): string => {
  const title = JSON.stringify(d.title)
  const ref = `(queue item ${d.itemId}, key ${JSON.stringify(d.key)})`
  switch (d.action) {
    case "approve":
      return [
        `[Queue] The owner approved ${title}${d.option === null ? "" : ` and chose: ${d.option}`} ${ref}. Go ahead.`,
        ...(d.note === null ? [] : [`Note: ${d.note}`]),
      ].join("\n")
    case "reject":
      return `[Queue] The owner rejected ${title} ${ref}. Why: ${d.note ?? "no reason given"}`
    case "reply":
      return `[Queue] The owner sent ${title} back with changes ${ref}: ${d.note ?? ""}\nFix it, then add it to the queue again with the same key.`
    case "drop":
      return `[Queue] The owner trashed ${title} ${ref}: don't pursue it or add it again.`
    default:
      return `[Queue] ${title} ${ref}: ${d.action}`
  }
}

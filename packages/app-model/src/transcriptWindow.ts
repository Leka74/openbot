// A chat opened away from its newest messages (a search hit, the Find bar): the pages of
// `conversations.around` merged into one window, and what the chat shows while it is open. The
// live replica keeps only the newest part of a chat, so the window lives next to it: newer
// revisions of the window's entries come from the replica, and once the window reaches the newest
// entry, the two join into one continuous transcript that stays live.
import { compareEntries, type ConversationState, type RuntimeRequest, type TranscriptEntry, type TranscriptWindow, type Turn, type TurnId } from "@openbot/contracts"

/** The loaded part of a chat around a target, oldest first, with the cursors to load more. */
export interface ChatWindow {
  readonly entries: ReadonlyArray<TranscriptEntry>
  readonly turns: ReadonlyMap<TurnId, Turn>
  readonly requests: ReadonlyMap<string, RuntimeRequest>
  /** Null when nothing is older. */
  readonly beforeCursor: string | null
  /** Null when the window reaches the newest entry. */
  readonly afterCursor: string | null
}

/** Entries merged by id (the newer revision wins), in transcript order. */
export const mergeEntries = (...lists: ReadonlyArray<ReadonlyArray<TranscriptEntry>>): ReadonlyArray<TranscriptEntry> => {
  const byId = new Map<string, TranscriptEntry>()
  for (const list of lists) {
    for (const e of list) {
      const known = byId.get(e.id)
      if (known === undefined || e.revision > known.revision) byId.set(e.id, e)
    }
  }
  return [...byId.values()].sort(compareEntries)
}

/** Turns and requests carry no revision: the later source (a newer page, the live replica) wins. */
const mergeById = <K, V>(base: ReadonlyMap<K, V>, later: Iterable<readonly [K, V]>): ReadonlyMap<K, V> => {
  const out = new Map(base)
  for (const [k, v] of later) out.set(k, v)
  return out
}

/**
 * The window after a page arrives: the first page starts it; an older / newer page extends it on
 * that side and moves only that side's cursor.
 */
export const applyWindowPage = (window: ChatWindow | undefined, page: TranscriptWindow, side: "first" | "older" | "newer"): ChatWindow => {
  const turns = page.turns.map((t) => [t.id, t] as const)
  const requests = page.requests.map((r) => [r.id as string, r] as const)
  if (window === undefined || side === "first") {
    return {
      entries: mergeEntries(page.entries),
      turns: new Map(turns),
      requests: new Map(requests),
      beforeCursor: page.hasMoreBefore ? page.beforeCursor : null,
      afterCursor: page.hasMoreAfter ? page.afterCursor : null,
    }
  }
  return {
    entries: mergeEntries(window.entries, page.entries),
    turns: mergeById(window.turns, turns),
    requests: mergeById(window.requests, requests),
    beforeCursor: side === "older" ? (page.hasMoreBefore ? page.beforeCursor : null) : window.beforeCursor,
    afterCursor: side === "newer" ? (page.hasMoreAfter ? page.afterCursor : null) : window.afterCursor,
  }
}

/**
 * Whether the window and the replica are one continuous transcript: only once the window reaches
 * the newest entry. Sharing an entry with the replica proves nothing: a reaction or an edit to an
 * old message puts it in the replica too, far from the part the replica holds in one piece.
 */
export const joinsReplica = (window: ChatWindow): boolean => window.afterCursor === null

/** What the chat shows while a window is open. */
export interface WindowView {
  readonly entries: ReadonlyArray<TranscriptEntry>
  readonly turns: ReadonlyMap<TurnId, Turn>
  readonly requests: ReadonlyMap<string, RuntimeRequest>
  /** The window and the replica are one continuous transcript (live from here on). */
  readonly joined: boolean
}

/**
 * The window with newer revisions (and turns / requests) from the replica; once joined, the
 * replica's newer entries too (older ones may be lone edits: the window's own older pages bring
 * them). Before that, the replica's other entries stay out: they belong to pages not loaded yet.
 */
export const windowView = (window: ChatWindow, replica: Pick<ConversationState, "entries" | "turns" | "requests">): WindowView => {
  const joined = joinsReplica(window)
  const turns = mergeById(window.turns, replica.turns)
  const requests = mergeById(window.requests, replica.requests as ReadonlyMap<string, RuntimeRequest>)
  const first = window.entries[0]
  if (joined) {
    const live = [...replica.entries.values()].filter((e) => first === undefined || compareEntries(e, first) >= 0)
    return { entries: mergeEntries(window.entries, live), turns, requests, joined }
  }
  const entries = window.entries.map((e) => {
    const live = replica.entries.get(e.id)
    return live !== undefined && live.revision > e.revision ? live : e
  })
  return { entries, turns, requests, joined }
}

/** The newest entry the replica has (marks where "New messages" start counting). */
export const newestOf = (entries: ReadonlyMap<string, TranscriptEntry>): TranscriptEntry | undefined => {
  let newest: TranscriptEntry | undefined
  for (const e of entries.values()) if (newest === undefined || compareEntries(e, newest) > 0) newest = e
  return newest
}

/** Messages after `mark` (written while a window was open): the "New messages" badge. */
export const messagesAfter = (entries: ReadonlyMap<string, TranscriptEntry>, mark: TranscriptEntry | undefined): number => {
  let n = 0
  for (const e of entries.values()) if (e.kind === "message" && (mark === undefined || compareEntries(e, mark) > 0)) n++
  return n
}

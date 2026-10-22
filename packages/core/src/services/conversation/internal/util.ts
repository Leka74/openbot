/**
 * Small pure helpers shared by the conversation services (W1.2). Internal: not exported from the
 * package barrel.
 */
import type {
  Attachment,
  Bot,
  BotId,
  Card,
  Conversation,
  KnownConversationEvent,
  KnownTranscriptEntry,
  RequestId,
  TranscriptEntry,
} from "@openbot/contracts"
import { NotFound } from "@openbot/contracts"
import { Effect, Option } from "effect"
import type { RepoError } from "../../../ports/errors.ts"
import { formatBytes } from "../files.ts"

/** The request a card answers, if any (its pending / answered state lives on the request). */
export const cardRequestId = (card: Card): RequestId | undefined =>
  card.type === "approval" || card.type === "form" || card.type === "secret-request" || card.type === "handoff" ||
    card.type === "question"
    ? card.requestId
    : undefined

/** Repository failures are defect-like (services.ts header): turn them into defects. */
export const orDie = <A, R>(effect: Effect.Effect<A, RepoError, R>): Effect.Effect<A, never, R> => Effect.orDie(effect)

/** `Option` lookup → value or `NotFound{entity, id}`; repository errors die. */
export const required = <A, R>(
  lookup: Effect.Effect<Option.Option<A>, RepoError, R>,
  entity: string,
  id: string,
): Effect.Effect<A, NotFound, R> =>
  Effect.flatMap(Effect.orDie(lookup), (found) =>
    Option.isSome(found) ? Effect.succeed(found.value) : Effect.fail(new NotFound({ entity, id })))

/**
 * Removes keys whose value is `undefined` (shallow). Contract structs use `optionalKey`, which
 * rejects explicit `undefined` when encoded at the RPC edge, so every entity we build goes through
 * this before it is persisted or published.
 */
export const compact = <A extends object>(value: A): A => {
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) if (v !== undefined) out[key] = v
  return out as A
}

/** Member bots of a conversation (direct / routine-run: the owner bot; group: its members). */
export const conversationBotIds = (conversation: Conversation): ReadonlyArray<BotId> =>
  conversation.kind === "group" ? conversation.memberBotIds : [conversation.botId]

const encoder = new TextEncoder()
const utf8Length = (text: string): number => encoder.encode(text).length

/** At most `maxBytes` UTF-8 bytes from the START of `text`, never splitting a code point. */
export const capUtf8 = (text: string, maxBytes: number): string => {
  if (utf8Length(text) <= maxBytes) return text
  let out = ""
  let used = 0
  for (const char of text) {
    const size = utf8Length(char)
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return out
}

/** At most `maxBytes` UTF-8 bytes from the END of `text` (newest kept), never splitting a code point. */
export const capUtf8Tail = (text: string, maxBytes: number): string => {
  if (utf8Length(text) <= maxBytes) return text
  const chars = Array.from(text)
  let used = 0
  let start = chars.length
  while (start > 0) {
    const size = utf8Length(chars[start - 1]!)
    if (used + size > maxBytes) break
    used += size
    start--
  }
  return chars.slice(start).join("")
}

/** "Sent cache-demo.mp4" / "Sent 3 files" (previews of messages that only carry files). */
export const attachmentsLine = (attachments: ReadonlyArray<Attachment>): string =>
  attachments.length === 1 ? `Sent ${attachments[0]!.name}` : `Sent ${attachments.length} files`

/**
 * A message as another session reads it (group catch-up): its text, plus the files it carries,
 * e.g. `Here it is [attached: demo.mp4 (video/mp4, 24.1 MB)]`.
 */
export const messageWithAttachments = (text: string, attachments: ReadonlyArray<Attachment>): string => {
  if (attachments.length === 0) return text
  const files = attachments
    .map((a) => `${a.name} (${a.mime}${a.byteSize === undefined ? "" : `, ${formatBytes(a.byteSize)}`})`)
    .join(", ")
  return `${text.trim()}${text.trim() === "" ? "" : " "}[attached: ${files}]`
}

/** One-line preview text (sidebar rows, routine summaries). */
export const previewOf = (text: string, maxChars = 140): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`
}

/**
 * Stable 53-bit string hash (cyrb53) as hex. Used for `RenderedInstructions.hash`: it only needs to
 * change when the text changes; it is not a security boundary.
 */
export const hashText = (text: string, seed = 0): string => {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  return value.toString(16).padStart(14, "0")
}

// ============================================================================ bots: names and mentions

/** Case-insensitive name key. */
export const nameKey = (name: string): string => name.trim().toLowerCase()

/** Resolves a bot by id, exact name or `@name` (case-insensitive). */
export const findBotByRef = (bots: ReadonlyArray<Bot>, ref: string): Bot | undefined => {
  const trimmed = ref.trim()
  const byId = bots.find((b) => b.id === trimmed)
  if (byId !== undefined) return byId
  const key = nameKey(trimmed.startsWith("@") ? trimmed.slice(1) : trimmed)
  return bots.find((b) => nameKey(b.name) === key)
}

const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}_-]/u.test(char)

export interface ParsedMentions {
  /** Mentioned bots in order of first mention (deduplicated). */
  readonly botIds: ReadonlyArray<BotId>
  /** `@everyone` was used. */
  readonly everyone: boolean
}

/**
 * Finds `@Name` mentions of `bots` in `text` (case-insensitive; longest name wins so "@Research
 * Scout" beats "@Research"; the character after the name must not continue a word) and
 * `@everyone`.
 */
export const parseMentions = (text: string, bots: ReadonlyArray<Pick<Bot, "id" | "name">>): ParsedMentions => {
  const lower = text.toLowerCase()
  const candidates = bots
    .map((b) => ({ id: b.id, key: nameKey(b.name) }))
    .filter((b) => b.key.length > 0)
    .sort((a, b) => b.key.length - a.key.length)
  const found: Array<BotId> = []
  let everyone = false
  for (let i = lower.indexOf("@"); i !== -1; i = lower.indexOf("@", i + 1)) {
    if (i > 0 && isWordChar(lower[i - 1])) continue // e-mail addresses, foo@bar
    const rest = lower.slice(i + 1)
    if (rest.startsWith("everyone") && !isWordChar(rest["everyone".length])) {
      everyone = true
      continue
    }
    const match = candidates.find((c) => rest.startsWith(c.key) && !isWordChar(rest[c.key.length]))
    if (match !== undefined && !found.includes(match.id)) found.push(match.id)
  }
  return { botIds: found, everyone }
}

// ============================================================================ transcript helpers

/** True for entries that are still being produced. */
export const isStreamingEntry = (entry: TranscriptEntry): boolean =>
  ((entry.kind === "message" || entry.kind === "reasoning") && entry.streaming) ||
  (entry.kind === "tool-call" && (entry.status === "pending" || entry.status === "running" || entry.status === "awaiting-approval"))

/** Narrow a stored entry to the encodable union (drops decode-only `unknown` entries). */
export const asKnown = (entry: TranscriptEntry): KnownTranscriptEntry | undefined =>
  entry.kind === "unknown" ? undefined : entry

/**
 * Housekeeping lines (a Bot compacting its context, a new session): they neither move the
 * conversation in the sidebar nor become its preview.
 */
export const isHousekeeping = (entry: KnownTranscriptEntry): boolean => entry.kind === "event" && entry.event.type === "session-changed"

/** Short human text for an event line (previews, group catch-up lines). */
export const describeEvent = (event: KnownConversationEvent): string => {
  switch (event.type) {
    case "name-changed":
      return `Renamed to ${event.to}`
    case "joined":
      return `${event.name} joined`
    case "member-added":
      return `${event.name} was added`
    case "member-removed":
      return `${event.name} was removed`
    case "messaged-bot":
      return `Messaged @${event.toName}`
    case "posted-to-group":
      return `Posted to ${event.title}`
    case "handoff":
      return `Handed off to @${event.toName}: ${event.task}`
    case "bot-exchange":
      return `${event.messageCount} messages between bots`
    case "hop-limit":
      return "Stopped: too many hand-offs"
    case "routine-changed":
      return `Routine ${event.routineName} ${event.action}`
    case "routine-run":
      return `Routine ${event.routineName} ${event.status}`
    case "memory-updated":
      return event.title === undefined ? "Updated memory" : `Memory: ${event.title}`
    case "skill-saved":
      return `Saved skill ${event.name}`
    case "auto-decided":
      return `${event.decision === "allowed" ? "Allowed" : "Denied"}: ${event.summary}`
    case "request-elsewhere":
      return "Waiting for you in a direct chat"
    case "session-changed":
      return event.action === "new-session" ? "Started a new session" : "Compacted the session"
    case "voice-call":
      return "Voice chat"
  }
}

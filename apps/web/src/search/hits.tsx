// A search hit as the Search view and the Cmd+K palette show it: the chat's avatar(s), the chat,
// who wrote it and when, and the snippet with the matched words marked (from the brain's
// `highlights`, UTF-16 ranges; no HTML).
import type { ReactNode } from "react"
import type { SearchHit } from "@openbot/contracts"
import { highlightParts } from "@openbot/app-model"
import { Avatar, AvatarStack, cn } from "@openbot/ui"
import type { RosterView } from "../app/data.ts"
import { formatListTime } from "../app/format.ts"

/** "Chief of Staff", a group's title, "Routine run". */
export const chatLabel = (roster: RosterView, hit: Pick<SearchHit, "conversationId">): string => {
  const c = roster.state.conversations.get(hit.conversationId)
  if (c === undefined) return "A chat"
  if (c.kind === "direct") return roster.botById(c.botIds[0])?.name ?? c.title
  return c.title || c.botIds.map((id) => roster.botById(id)?.name ?? "").filter(Boolean).join(", ")
}

/** "You", a Bot's name, "OpenBot" (system lines). */
export const authorLabel = (roster: RosterView, hit: SearchHit): string =>
  hit.author.kind === "owner" ? "You" : hit.author.kind === "bot" ? (roster.botById(hit.author.botId)?.name ?? "A Bot") : "OpenBot"

const KIND_LABEL: Partial<Record<SearchHit["kind"], string>> = { card: "Card", event: "Event", notice: "Notice", "tool-call": "Step", task: "Task result" }

export function HitLeading({ roster, hit, size = 28 }: { readonly roster: RosterView; readonly hit: SearchHit; readonly size?: number }): ReactNode {
  const c = roster.state.conversations.get(hit.conversationId)
  if (c !== undefined && c.kind === "group") {
    return <AvatarStack size={size - 4} outlineColor="var(--ob-elevated)" avatars={c.botIds.slice(0, 3).map((id) => ({ key: id, shape: roster.botById(id)?.avatar.shape, color: roster.botById(id)?.avatar.color }))} />
  }
  const bot = roster.botById(c?.botIds[0] ?? (hit.author.kind === "bot" ? hit.author.botId : undefined))
  return <Avatar shape={bot?.avatar.shape} color={bot?.avatar.color} size={size} />
}

/** The snippet with its highlights marked. */
export function Snippet({ hit, className }: { readonly hit: SearchHit; readonly className?: string }): ReactNode {
  return (
    <span className={className}>
      {highlightParts(hit.snippet, hit.highlights).map((p, i) =>
        p.mark ? (
          <mark key={i} className="rounded-[3px] bg-[light-dark(#fde68a,#6b5a12)] px-px text-fg">
            {p.text}
          </mark>
        ) : (
          p.text
        ),
      )}
    </span>
  )
}

/** "Chief of Staff · You · 2:41 PM" (+ the kind when it isn't a message). */
export function HitMeta({ roster, hit, className }: { readonly roster: RosterView; readonly hit: SearchHit; readonly className?: string }): ReactNode {
  const kind = KIND_LABEL[hit.kind]
  const to = hit.toBotId !== undefined ? roster.botById(hit.toBotId)?.name : undefined
  const chat = chatLabel(roster, hit)
  const author = authorLabel(roster, hit)
  const who = to ? `${author} to ${to}` : author === chat ? undefined : author
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 text-xs text-fg-tertiary", className)}>
      <span className="truncate font-medium text-fg-secondary">{chat}</span>
      {who !== undefined && (
        <>
          <span aria-hidden>·</span>
          <span className="truncate">{who}</span>
        </>
      )}
      {kind && <span className="shrink-0 rounded-full bg-secondary px-1.5 text-2xs leading-4 text-fg-secondary">{kind}</span>}
      <span className="ms-auto shrink-0 tabular-nums">{formatListTime(hit.createdAt)}</span>
    </span>
  )
}

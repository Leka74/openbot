// The transcript's rows (`layoutTranscript` from @openbot/app-model, as on the web): timestamps, the
// owner's and the Bots' bubbles with attachments, cards, collapsed steps, events, bot-to-bot
// exchanges, notices, and each working Bot's status line.
import { type BubbleItem, formatTimestamp, type Row } from "@openbot/app-model"
import type { Bot, RuntimeRequest, TranscriptEntryOf } from "@openbot/contracts"
import { Image } from "expo-image"
import { type ReactNode, useEffect, useState } from "react"
import { Animated, Pressable, StyleSheet, Text, View } from "react-native"
import type { Connection } from "../session.ts"
import { sessionHeaders } from "../session.ts"
import type { Theme } from "../theme.ts"
import { Avatar } from "../ui/Avatar.tsx"
import { Icon } from "../ui/Icon.tsx"
import { CardView } from "./Cards.tsx"
import { Markdown } from "./Markdown.tsx"

type MessageEntry = TranscriptEntryOf<"message">
type EventEntry = TranscriptEntryOf<"event">

export interface RowContext {
  readonly theme: Theme
  readonly connection: Connection
  readonly group: boolean
  readonly botById: (id: string | undefined) => Bot | undefined
  readonly requestFor: (entry: TranscriptEntryOf<"card">) => RuntimeRequest | undefined
  readonly primary: Bot | undefined
  readonly retry: (clientNonce: string) => void
}

export function RowView({ row, ctx }: { readonly row: Row; readonly ctx: RowContext }): ReactNode {
  const { theme } = ctx
  switch (row.type) {
    case "timestamp":
      return <Text style={[styles.timestamp, { color: theme.fgTertiary }]}>{formatTimestamp(row.at)}</Text>
    case "new-divider":
      return (
        <View style={styles.divider}>
          <View style={[styles.rule, { backgroundColor: theme.accent }]} />
          <Text style={{ color: theme.accentFg, fontSize: 12, fontWeight: "600" }}>New</Text>
          <View style={[styles.rule, { backgroundColor: theme.accent }]} />
        </View>
      )
    case "group":
      return <Group row={row} ctx={ctx} />
    case "card": {
      const author = row.entry.author.kind === "bot" ? ctx.botById(row.entry.author.botId) : undefined
      return (
        <View style={styles.block}>
          {ctx.group && author && <Text style={[styles.speaker, { color: theme.fgSecondary }]}>{author.name}</Text>}
          <CardView card={row.entry.card} state={row.entry.state} request={ctx.requestFor(row.entry)} bot={author ?? ctx.primary} entryId={row.entry.id} theme={theme} />
        </View>
      )
    }
    case "steps":
      return <Steps steps={row.steps} failed={row.failed} theme={theme} />
    case "exchange": {
      const peer = ctx.botById(row.peerBotId)
      const n = row.entries.length
      return <EventLine theme={theme} text={`${n} ${n === 1 ? "message" : "messages"} with ${peer?.name ?? "a Bot"}`} />
    }
    case "event":
      return <EventLine theme={theme} text={describeEvent(row.entry, ctx)} />
    case "notice":
      return <EventLine theme={theme} text={row.entry.text} tone={row.entry.level === "error" ? theme.dangerFg : row.entry.level === "warning" ? theme.warn : undefined} />
    case "unknown":
      return <EventLine theme={theme} text="This message can't be shown in this version of the app." />
  }
}

function Group({ row, ctx }: { readonly row: Extract<Row, { type: "group" }>; readonly ctx: RowContext }): ReactNode {
  const { theme } = ctx
  const user = row.side === "user"
  const bot = row.botId ? ctx.botById(row.botId) : undefined
  const addressee = row.addressee ? ctx.botById(row.addressee) : undefined
  return (
    <View style={[styles.group, { alignItems: user ? "flex-end" : "flex-start" }]}>
      {!user && ctx.group && bot && (
        <View style={styles.speakerRow}>
          <Avatar avatar={bot.avatar} size={18} />
          <Text style={[styles.speaker, { color: theme.fgSecondary, marginLeft: 0 }]}>{bot.name}</Text>
        </View>
      )}
      {!user && addressee && <Text style={[styles.speaker, { color: theme.fgTertiary }]}>to @{addressee.name}</Text>}
      {row.items.map((item) => (
        <Bubble key={item.kind === "entry" ? item.entry.id : item.pending.clientNonce} item={item} user={user} ctx={ctx} />
      ))}
    </View>
  )
}

function Bubble({ item, user, ctx }: { readonly item: BubbleItem; readonly user: boolean; readonly ctx: RowContext }): ReactNode {
  const { theme } = ctx
  if (item.kind === "pending") {
    const p = item.pending
    return (
      <Pressable onPress={() => p.status === "failed" && ctx.retry(p.clientNonce)} style={{ alignItems: "flex-end", maxWidth: "82%" }}>
        <View style={[styles.bubble, { backgroundColor: theme.bubbleUser, opacity: p.status === "sending" ? 0.7 : 1 }]}>
          <Text style={{ color: theme.bubbleUserFg, fontSize: 17, lineHeight: 23 }}>{p.text}</Text>
        </View>
        {p.status === "failed" && <Text style={{ color: theme.dangerFg, fontSize: 13, marginTop: 3 }}>Not sent · Tap to retry</Text>}
      </Pressable>
    )
  }
  const e: MessageEntry = item.entry
  const images = e.attachments.filter((a) => a.mime.startsWith("image/"))
  const files = e.attachments.filter((a) => !a.mime.startsWith("image/"))
  const headers = sessionHeaders(ctx.connection)
  return (
    <View style={{ maxWidth: user ? "82%" : "100%", alignItems: user ? "flex-end" : "flex-start", gap: 4 }}>
      {images.length > 0 && (
        <View style={[styles.images, { justifyContent: user ? "flex-end" : "flex-start" }]}>
          {images.map((a) => (
            <Image
              key={a.id}
              source={{ uri: `${ctx.connection.origin}/api/attachments/${a.id}`, headers }}
              style={[styles.image, { aspectRatio: a.width && a.height ? a.width / a.height : 1, backgroundColor: theme.elevated }]}
              contentFit="cover"
              transition={150}
            />
          ))}
        </View>
      )}
      {files.map((a) => (
        <View key={a.id} style={[styles.file, { backgroundColor: theme.elevated, borderColor: theme.lineTertiary }]}>
          <Icon name="file" size={18} color={theme.iconSecondary} />
          <Text numberOfLines={1} style={{ color: theme.fg, fontSize: 15, flexShrink: 1 }}>{a.name}</Text>
        </View>
      ))}
      {e.text.trim() !== "" &&
        (user ? (
          <View style={[styles.bubble, { backgroundColor: theme.bubbleUser }]}>
            <Text selectable style={{ color: theme.bubbleUserFg, fontSize: 17, lineHeight: 23 }}>{e.text}</Text>
          </View>
        ) : (
          <View style={[styles.bubble, styles.botBubble, { backgroundColor: theme.bubbleBot }]}>
            <Markdown text={e.text} theme={theme} image={{ origin: ctx.connection.origin, headers }} />
          </View>
        ))}
    </View>
  )
}

function EventLine({ theme, text, tone }: { readonly theme: Theme; readonly text: string; readonly tone?: string | undefined }): ReactNode {
  return <Text style={[styles.event, { color: tone ?? theme.fgTertiary }]}>{text}</Text>
}

function Steps({ steps, failed, theme }: { readonly steps: Extract<Row, { type: "steps" }>["steps"]; readonly failed: boolean; readonly theme: Theme }): ReactNode {
  const [open, setOpen] = useState(false)
  const tools = steps.filter((s) => s.kind === "tool-call")
  const label = `${tools.length > 0 ? `${tools.length} ${tools.length === 1 ? "step" : "steps"}` : "Thought it through"}${failed ? " · stopped" : ""}`
  return (
    <View style={styles.block}>
      <Pressable onPress={() => setOpen(!open)} style={styles.stepsHead} hitSlop={6}>
        <Text style={{ color: theme.fgTertiary, fontSize: 14 }}>{label}</Text>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} color={theme.fgTertiary} />
      </Pressable>
      {open &&
        steps.map((s) => (
          <Text key={s.id} numberOfLines={2} style={{ color: theme.fgSecondary, fontSize: 14, marginLeft: 10, marginTop: 4 }}>
            {s.kind === "tool-call" ? `${s.title ?? s.name}${s.inputSummary ? ` · ${s.inputSummary}` : ""}` : "Thinking"}
          </Text>
        ))}
    </View>
  )
}

const ROUTINE_VERB = { created: "Created routine", updated: "Updated routine", deleted: "Removed routine", paused: "Paused routine", resumed: "Resumed routine" } as const
const RUN_VERB = { started: "Running", succeeded: "Ran", failed: "Routine failed:", skipped: "Skipped" } as const

/** One line for an event (the web's chat/Events.tsx, as text). */
const describeEvent = (entry: EventEntry, ctx: RowContext): string => {
  const ev = entry.event
  const name = (id: string, fallback?: string) => ctx.botById(id)?.name ?? fallback ?? "a Bot"
  switch (ev.type) {
    case "name-changed":
      return `Renamed to ${ev.to}`
    case "joined":
      return `${name(ev.botId, ev.name)} joined the team`
    case "member-added":
      return `${name(ev.botId, ev.name)} was added to the chat`
    case "member-removed":
      return `${name(ev.botId, ev.name)} was removed from the chat`
    case "messaged-bot":
      return `Messaged ${name(ev.toBotId, ev.toName)}${ev.urgency === "urgent" ? " (urgent)" : ""}`
    case "posted-to-group":
      return `Posted to ${ev.title}`
    case "handoff":
      return `Handed off to ${name(ev.toBotId, ev.toName)} · ${ev.task}`
    case "bot-exchange": {
      const n = ev.messageCount
      return `${n} ${n === 1 ? "message" : "messages"} with ${ev.peerBotIds.length === 1 ? name(ev.peerBotIds[0]!) : `${ev.peerBotIds.length} Bots`}`
    }
    case "hop-limit":
      return "Stopped: too many hand-offs"
    case "routine-changed":
      return `${(ROUTINE_VERB as Record<string, string>)[ev.action] ?? "Changed routine"} ${ev.routineName}`
    case "routine-run":
      return `${(RUN_VERB as Record<string, string>)[ev.status] ?? "Routine"} ${ev.routineName}`
    case "memory-updated":
      return `${ev.action === "remembered" ? "Remembered" : ev.action === "forgot" ? "Forgot" : "Updated memory"}${ev.title ? ` “${ev.title}”` : ""}`
    case "skill-saved":
      return `Saved skill ${ev.name}`
    case "auto-decided":
      return `${ev.decision === "denied" ? "Blocked by your rules:" : ev.autonomy === "workspace" ? "Allowed in its workspace:" : ev.autonomy === "full" ? "Allowed (Full auto):" : "Allowed by your rules:"} ${ev.summary}`
    case "request-elsewhere":
      return `${name(ev.botId)} needs your approval in your direct chat`
    case "session-changed":
      return ev.action === "compacted" ? "Compacted context" : "Started a new session"
    default:
      return "Something happened here that this version of the app can't show."
  }
}

/** A working Bot's line under the transcript ("Thinking it through…"), pulsing. */
export function StatusLine({ bot, text, theme }: { readonly bot: Bot | undefined; readonly text: string; readonly theme: Theme }): ReactNode {
  const [pulse] = useState(() => new Animated.Value(0.45))
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.45, duration: 900, useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [pulse])
  return (
    <View style={styles.status}>
      <Avatar avatar={bot?.avatar} size={22} />
      <Animated.Text style={{ color: theme.fgSecondary, fontSize: 15, opacity: pulse }}>{text}</Animated.Text>
    </View>
  )
}

const styles = StyleSheet.create({
  timestamp: { textAlign: "center", fontSize: 13, marginVertical: 10 },
  divider: { flexDirection: "row", alignItems: "center", gap: 8, marginVertical: 8 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  group: { gap: 4, marginVertical: 4 },
  block: { marginVertical: 4, alignItems: "flex-start" },
  speakerRow: { flexDirection: "row", alignItems: "center", gap: 6, marginLeft: 4, marginBottom: 2 },
  speaker: { fontSize: 13, marginLeft: 4, marginBottom: 2 },
  bubble: { borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10 },
  botBubble: { paddingVertical: 12 },
  images: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  image: { width: 220, maxHeight: 320, borderRadius: 18 },
  file: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, borderWidth: StyleSheet.hairlineWidth, maxWidth: 280 },
  event: { textAlign: "center", fontSize: 13, marginVertical: 6, paddingHorizontal: 24 },
  stepsHead: { flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: 4 },
  status: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, paddingLeft: 2 },
})

// Cards in a chat (the web's cards/Cards.tsx, native): questions with lettered options (Grok iOS),
// approvals, computer hand-offs, secrets, routines, Slack drafts; forms open in the web app.
import { useAtomSet } from "@effect/atom-react"
import { commandAtom, respondRequestAtom } from "@openbot/client"
import type { Bot, Card, CardState, EntryId, RequestId, RuntimeRequest, RuntimeResponseInput } from "@openbot/contracts"
import { Exit } from "effect"
import * as Haptics from "expo-haptics"
import { type ReactNode, useState } from "react"
import * as Linking from "expo-linking"
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { openWeb } from "../nav.ts"
import type { Theme } from "../theme.ts"
import { Icon } from "../ui/Icon.tsx"

type Status = CardState["status"]

/** A request's live status wins over the card's stored one. */
const statusOf = (state: CardState, request: RuntimeRequest | undefined): Status =>
  request === undefined ? state.status : request.status === "pending" ? "pending" : request.status === "resolved" ? "resolved" : request.status === "expired" ? "expired" : "cancelled"

const failureText = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return ""
  const failure = exit.cause.reasons.find((r) => r._tag === "Fail") as { readonly error?: { _tag?: string; message?: string; status?: string } } | undefined
  const e = failure?.error
  if (e?._tag === "RequestNotPending") return `This request is already ${e.status ?? "closed"}.`
  return e?.message || "Couldn't reach OpenBot. Check your connection and try again."
}

const useRespond = (requestId: string | undefined) => {
  const set = useAtomSet(respondRequestAtom(requestId ?? "none"), { mode: "promiseExit" })
  const [busy, setBusy] = useState<string | null>(null)
  const respond = async (response: RuntimeResponseInput, tag: string): Promise<boolean> => {
    if (requestId === undefined) return false
    setBusy(tag)
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined)
    try {
      const exit = await set({ requestId: requestId as RequestId, response })
      if (Exit.isFailure(exit)) {
        Alert.alert("Couldn't send that", failureText(exit))
        return false
      }
      return true
    } finally {
      setBusy(null)
    }
  }
  return { respond, busy }
}

export interface CardProps {
  readonly card: Card
  readonly state: CardState
  readonly request: RuntimeRequest | undefined
  readonly bot: Bot | undefined
  /** The card's transcript entry (a Slack draft is answered by entry). */
  readonly entryId?: EntryId | undefined
  readonly theme: Theme
}

export function CardView(props: CardProps): ReactNode {
  const { card } = props
  switch (card.type) {
    case "question":
      return <QuestionCard {...props} card={card} />
    case "approval":
      return <ApprovalCard {...props} card={card} />
    case "handoff":
      return <HandoffCard {...props} card={card} />
    case "secret-request":
      return <SecretCard {...props} card={card} />
    case "slack-draft":
      return <SlackDraftCard {...props} card={card} />
    case "routine":
      return (
        <Shell theme={props.theme}>
          <Text style={[styles.kicker, { color: props.theme.fgSecondary }]}>Routine {card.action}</Text>
          <Text style={[styles.title, { color: props.theme.fg }]}>{card.name}</Text>
          <Text style={[styles.body, { color: props.theme.fgSecondary }]}>{card.triggerSummary}</Text>
        </Shell>
      )
    case "form":
      return (
        <Shell theme={props.theme}>
          <Text style={[styles.title, { color: props.theme.fg }]}>{card.title}</Text>
          {card.description ? <Text style={[styles.body, { color: props.theme.fgSecondary }]}>{card.description}</Text> : null}
          {statusOf(props.state, props.request) === "pending" ? (
            <Button theme={props.theme} label="Fill in" primary onPress={() => openWeb("#/", "OpenBot")} />
          ) : (
            <Done theme={props.theme} text="Answered" />
          )}
        </Shell>
      )
    default:
      return (
        <Shell theme={props.theme}>
          <Text style={[styles.body, { color: props.theme.fgSecondary }]}>This card can't be shown in this version of the app.</Text>
        </Shell>
      )
  }
}

function Shell({ theme, children }: { readonly theme: Theme; readonly children: ReactNode }): ReactNode {
  return <View style={[styles.card, { backgroundColor: theme.bubbleBot }]}>{children}</View>
}

function Button({ theme, label, onPress, primary = false, busy = false, disabled = false }: { readonly theme: Theme; readonly label: string; readonly onPress: () => void; readonly primary?: boolean; readonly busy?: boolean; readonly disabled?: boolean }): ReactNode {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      style={({ pressed }) => [styles.button, { backgroundColor: primary ? theme.primary : theme.secondary, opacity: pressed || disabled ? 0.6 : 1 }]}
    >
      {busy ? <ActivityIndicator color={primary ? theme.onPrimary : theme.fg} /> : <Text style={[styles.buttonText, { color: primary ? theme.onPrimary : theme.fg }]}>{label}</Text>}
    </Pressable>
  )
}

function Done({ theme, text }: { readonly theme: Theme; readonly text: string }): ReactNode {
  return (
    <View style={styles.done}>
      <Icon name="check" size={14} color={theme.fgTertiary} />
      <Text style={{ color: theme.fgTertiary, fontSize: 14 }}>{text}</Text>
    </View>
  )
}

// ------------------------------------------------------------------------------------- question

function QuestionCard({ card, state, request, theme }: CardProps & { readonly card: Extract<Card, { type: "question" }> }): ReactNode {
  const status = statusOf(state, request)
  const { respond, busy } = useRespond(request?.id ?? card.requestId)
  const [picked, setPicked] = useState<Record<string, ReadonlyArray<string>>>({})
  const [step, setStep] = useState(0)
  const response = state.response ?? (request?.response as CardState["response"])
  const answerable = status === "pending" && (request?.id ?? card.requestId) !== undefined
  const q = card.questions[Math.min(step, card.questions.length - 1)]
  if (!q) return null

  if (!answerable) {
    const answers = response?.type === "answers" ? Object.values(response.answers).flat() : []
    return (
      <Shell theme={theme}>
        <Text style={[styles.title, { color: theme.fg }]}>{card.questions[0]?.prompt ?? card.title}</Text>
        <Done theme={theme} text={answers.length > 0 ? answers.join(", ") : status === "resolved" ? "Answered in the chat" : status === "expired" ? "Expired" : "Closed"} />
      </Shell>
    )
  }

  const choose = (label: string) => {
    const current = picked[q.id] ?? []
    if (q.multiSelect) {
      setPicked({ ...picked, [q.id]: current.includes(label) ? current.filter((l) => l !== label) : [...current, label] })
      return
    }
    const next = { ...picked, [q.id]: [label] }
    setPicked(next)
    if (step < card.questions.length - 1) setStep(step + 1)
    else void respond({ type: "answers", answers: next as Record<string, Array<string>> }, label)
  }
  const last = step >= card.questions.length - 1
  return (
    <Shell theme={theme}>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Text style={[styles.title, { color: theme.fg, flex: 1 }]}>{q.prompt}</Text>
        <Pressable onPress={() => void respond({ type: "dismiss" }, "dismiss")} hitSlop={10} accessibilityLabel="Skip question">
          <Icon name="close" size={18} color={theme.iconSecondary} />
        </Pressable>
      </View>
      <View style={[styles.options, { backgroundColor: theme.bg, borderColor: theme.lineTertiary }]}>
        {q.options.map((o, i) => {
          const on = (picked[q.id] ?? []).includes(o.label)
          return (
            <Pressable
              key={o.label}
              onPress={() => choose(o.label)}
              disabled={busy !== null}
              style={({ pressed }) => [styles.option, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.lineSecondary }, pressed && { backgroundColor: theme.secondary }]}
            >
              <View style={[styles.letter, { backgroundColor: on ? theme.primary : theme.secondary }]}>
                <Text style={{ color: on ? theme.onPrimary : theme.fgSecondary, fontSize: 14, fontWeight: "500" }}>{String.fromCharCode(65 + i)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: theme.fg, fontSize: 17 }}>{o.label}</Text>
                {o.description ? <Text style={{ color: theme.fgTertiary, fontSize: 14, marginTop: 2 }}>{o.description}</Text> : null}
              </View>
              {busy === o.label && <ActivityIndicator color={theme.fg} />}
            </Pressable>
          )
        })}
      </View>
      {q.multiSelect && (
        <Button
          theme={theme}
          primary
          label={last ? "Send" : "Next"}
          busy={busy === "multi"}
          disabled={(picked[q.id] ?? []).length === 0}
          onPress={() => (last ? void respond({ type: "answers", answers: picked as Record<string, Array<string>> }, "multi") : setStep(step + 1))}
        />
      )}
      <Text style={{ color: theme.fgTertiary, fontSize: 15 }}>Or answer in the chat below</Text>
    </Shell>
  )
}

// ------------------------------------------------------------------------------------- approval

function ApprovalCard({ card, state, request, theme }: CardProps & { readonly card: Extract<Card, { type: "approval" }> }): ReactNode {
  const status = statusOf(state, request)
  const { respond, busy } = useRespond(request?.id ?? card.requestId)
  const response = state.response ?? (request?.response as CardState["response"])
  const decided = response?.type === "decision" ? response.decision : undefined
  return (
    <Shell theme={theme}>
      {card.taskTitle ? <Text style={[styles.kicker, { color: theme.fgSecondary }]}>{card.taskTitle}</Text> : null}
      <Text style={[styles.title, { color: theme.fg }]}>{card.title}</Text>
      {card.summary ? <Text style={[styles.body, { color: theme.fgSecondary }]}>{card.summary}</Text> : null}
      {card.command ? (
        <View style={[styles.command, { backgroundColor: theme.codeBg }]}>
          <Text selectable style={{ color: theme.fg, fontFamily: "Menlo", fontSize: 13 }}>{card.command}</Text>
        </View>
      ) : null}
      {status === "pending" ? (
        <View style={styles.row}>
          <Button theme={theme} primary label="Allow" busy={busy === "allow"} onPress={() => void respond({ type: "decision", decision: "allow-once" }, "allow")} />
          {card.suggestedRule ? <Button theme={theme} label="Always" busy={busy === "always"} onPress={() => void respond({ type: "decision", decision: "allow-always" }, "always")} /> : null}
          <View style={{ flex: 1 }} />
          <Button theme={theme} label="Deny" busy={busy === "deny"} onPress={() => void respond({ type: "decision", decision: "deny" }, "deny")} />
        </View>
      ) : (
        <Done theme={theme} text={status === "resolved" ? (decided === "deny" ? "Denied" : decided === "allow-always" ? "Always allowed" : "Allowed") : status === "expired" ? "Expired" : (state.detail ?? "Closed")} />
      )}
    </Shell>
  )
}

// ------------------------------------------------------------------------------------- hand-off

function HandoffCard({ card, state, request, bot, theme }: CardProps & { readonly card: Extract<Card, { type: "handoff" }> }): ReactNode {
  const status = statusOf(state, request)
  const { respond, busy } = useRespond(request?.id ?? card.requestId)
  const botId = bot?.id ?? request?.botId
  const lease = useAtomSet(commandAtom("computer.lease", botId ?? "none"), { mode: "promiseExit" })
  const response = state.response ?? (request?.response as CardState["response"])
  const skipped = response?.type === "acknowledge" && response.action === "skip"
  return (
    <Shell theme={theme}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="computer" size={17} color={theme.iconSecondary} />
        <Text style={[styles.kicker, { color: status === "pending" ? theme.success : theme.fgSecondary, marginBottom: 0 }]}>
          {status === "pending" ? "Action needed" : status === "resolved" ? (skipped ? "Skipped" : "You took over · Done") : status === "expired" ? "Expired" : "Closed"}
        </Text>
      </View>
      <Text style={[styles.title, { color: theme.fg }]}>{card.instruction}</Text>
      {status === "pending" && botId !== undefined && (
        <View style={styles.row}>
          <Button theme={theme} primary label="Take over" onPress={() => openWeb(`#/computer/${encodeURIComponent(botId)}?control=1`, `${bot?.name ?? "Bot"}'s computer`)} />
          <Button
            theme={theme}
            label="I'm done"
            busy={busy === "done"}
            onPress={() => void lease({ botId: botId as never, take: false }).then((exit) => Exit.isFailure(exit) && Alert.alert("Couldn't hand it back", failureText(exit)))}
          />
          <View style={{ flex: 1 }} />
          <Button theme={theme} label="Skip" busy={busy === "skip"} onPress={() => void respond({ type: "acknowledge", action: "skip" }, "skip")} />
        </View>
      )}
    </Shell>
  )
}

// ------------------------------------------------------------------------------------- secret

function SecretCard({ card, state, request, theme }: CardProps & { readonly card: Extract<Card, { type: "secret-request" }> }): ReactNode {
  const status = statusOf(state, request)
  const { respond, busy } = useRespond(request?.id ?? card.requestId)
  const [value, setValue] = useState("")
  return (
    <Shell theme={theme}>
      <Text style={[styles.title, { color: theme.fg }]}>{card.label}</Text>
      {card.description ? <Text style={[styles.body, { color: theme.fgSecondary }]}>{card.description}</Text> : null}
      {status === "pending" ? (
        <>
          <TextInput
            value={value}
            onChangeText={setValue}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Paste it here"
            placeholderTextColor={theme.fgQuaternary}
            style={[styles.secret, { color: theme.fg, backgroundColor: theme.bg, borderColor: theme.lineSecondary }]}
          />
          <View style={styles.row}>
            <Button theme={theme} primary label="Save" busy={busy === "save"} disabled={value === ""} onPress={() => void respond({ type: "secret", value }, "save").then((ok) => ok && setValue(""))} />
            <View style={{ flex: 1 }} />
            <Button theme={theme} label="Skip" busy={busy === "skip"} onPress={() => void respond({ type: "dismiss" }, "skip")} />
          </View>
        </>
      ) : (
        <Done theme={theme} text={state.detail ?? (status === "resolved" ? "Saved securely" : "Closed")} />
      )}
    </Shell>
  )
}

// ------------------------------------------------------------------------------------ Slack draft

/** A Slack message a Bot drafted (D3.4): edit it, then Send (it goes out as you, with its files) or Discard. */
function SlackDraftCard({ card, state, entryId, theme }: CardProps & { readonly card: Extract<Card, { type: "slack-draft" }> }): ReactNode {
  const [text, setText] = useState(card.text)
  const send = useAtomSet(commandAtom("slack.sendDraft", entryId ?? "none"), { mode: "promiseExit" })
  const discard = useAtomSet(commandAtom("slack.discardDraft", entryId ?? "none"), { mode: "promiseExit" })
  const [busy, setBusy] = useState<"send" | "discard" | null>(null)
  const act = async (which: "send" | "discard") => {
    if (entryId === undefined) return
    setBusy(which)
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined)
    try {
      const exit = which === "send" ? await send({ entryId, text: text.trim() }) : await discard({ entryId })
      if (Exit.isFailure(exit)) Alert.alert(which === "send" ? "Couldn't send it" : "Couldn't discard it", failureText(exit))
    } finally {
      setBusy(null)
    }
  }
  const pending = state.status === "pending"
  const files = card.files ?? []
  const facts: ReadonlyArray<[string, string]> = [
    ["Workspace", card.team],
    ["To", card.to],
    ["Thread", card.threadLabel ?? "New message"],
    ...(files.length === 0 ? [] : [[files.length === 1 ? "File" : "Files", files.map((f) => f.name).join(", ")] as [string, string]]),
  ]
  return (
    <Shell theme={theme}>
      <Text style={[styles.kicker, { color: theme.fgSecondary }]}>Slack message</Text>
      <View style={{ gap: 2 }}>
        {facts.map(([label, value]) => (
          <Text key={label} style={[styles.body, { color: theme.fg }]} numberOfLines={1}>
            <Text style={{ color: theme.fgSecondary }}>{label}  </Text>
            {value}
          </Text>
        ))}
      </View>
      {pending ? (
        <>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            editable={busy === null}
            style={[styles.draft, { color: theme.fg, backgroundColor: theme.bg, borderColor: theme.lineSecondary }]}
          />
          <View style={styles.row}>
            <Button theme={theme} primary label="Send" busy={busy === "send"} disabled={(text.trim() === "" && files.length === 0) || entryId === undefined} onPress={() => void act("send")} />
            <View style={{ flex: 1 }} />
            <Button theme={theme} label="Discard" busy={busy === "discard"} disabled={entryId === undefined} onPress={() => void act("discard")} />
          </View>
        </>
      ) : (
        <>
          {card.text !== "" && <Text style={[styles.body, { color: state.status === "resolved" ? theme.fg : theme.fgTertiary }]}>{card.text}</Text>}
          {state.status === "resolved" && state.link !== undefined ? (
            <Pressable onPress={() => void Linking.openURL(state.link!)} accessibilityRole="link">
              <Done theme={theme} text="Sent · Open in Slack" />
            </Pressable>
          ) : (
            <Done theme={theme} text={state.status === "resolved" ? "Sent" : "Discarded"} />
          )}
        </>
      )}
    </Shell>
  )
}

const styles = StyleSheet.create({
  card: { borderRadius: 24, padding: 18, gap: 12, alignSelf: "stretch" },
  kicker: { fontSize: 14, fontWeight: "500" },
  title: { fontSize: 19, fontWeight: "600", lineHeight: 25 },
  body: { fontSize: 15, lineHeight: 21 },
  options: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  option: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 14, paddingVertical: 13 },
  letter: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" },
  button: { height: 40, borderRadius: 20, paddingHorizontal: 18, alignItems: "center", justifyContent: "center", minWidth: 72 },
  buttonText: { fontSize: 15, fontWeight: "600" },
  done: { flexDirection: "row", alignItems: "center", gap: 6 },
  command: { borderRadius: 10, padding: 10 },
  secret: { height: 44, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, fontSize: 16 },
  draft: { minHeight: 88, maxHeight: 240, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, lineHeight: 22, textAlignVertical: "top" },
})

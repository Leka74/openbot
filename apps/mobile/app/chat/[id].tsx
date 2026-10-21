// A chat (Grok iOS): floating glass back button, the Bot's name pill and a "…" menu over the
// transcript; the glass composer at the bottom. Rows come from the shared `layoutTranscript`.
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { activityPhrase, chatStatuses, type ChatStatus, layoutTranscript, type PendingMessage, requestForCard, type Row } from "@openbot/app-model"
import { commands, conversationAtom, interruptTurnAtom, loadOlderAtom, outboxAtom, retrySendAtom, sendMessageAtom } from "@openbot/client"
import { type Bot, type BotId, type ConversationId, DEFAULT_SETTINGS, emptyConversationState, transcriptOf } from "@openbot/contracts"
import { router, useLocalSearchParams } from "expo-router"
import { type ReactNode, useEffect } from "react"
import { ActionSheetIOS, Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Composer } from "../../src/chat/Composer.tsx"
import { RowView, StatusLine } from "../../src/chat/Rows.tsx"
import { useRoster, valueOr } from "../../src/data.ts"
import { openWeb } from "../../src/nav.ts"
import { useConnection } from "../../src/runtime.tsx"
import { useTheme } from "../../src/theme.ts"
import { Avatar, AvatarStack } from "../../src/ui/Avatar.tsx"
import { Glass, GlassCircle } from "../../src/ui/glass.tsx"

const ACTIVE = new Set(["queued", "running", "waiting"])

type Item = { readonly kind: "row"; readonly row: Row } | { readonly kind: "status"; readonly status: ChatStatus; readonly key: string }

export default function Chat(): ReactNode {
  const { id } = useLocalSearchParams<{ id: string }>()
  const conversationId = (id ?? "") as ConversationId
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const connection = useConnection()
  const roster = useRoster()
  const state = valueOr(useAtomValue(conversationAtom(conversationId)), emptyConversationState)
  const outbox = useAtomValue(outboxAtom(conversationId))
  const send = useAtomSet(sendMessageAtom)
  const retry = useAtomSet(retrySendAtom)
  const interrupt = useAtomSet(interruptTurnAtom)
  const markRead = useAtomSet(commands["conversations.markRead"])
  const loadOlder = useAtomSet(loadOlderAtom, { mode: "promiseExit" })

  const summary = roster.state.conversations.get(conversationId)
  const conversation = state.conversation
  const isGroup = (conversation?.kind ?? summary?.kind) === "group"
  const botIds: ReadonlyArray<BotId> = conversation
    ? conversation.kind === "group"
      ? conversation.memberBotIds
      : [conversation.botId]
    : ((summary?.botIds ?? []) as ReadonlyArray<BotId>)
  const members = botIds.map((b) => roster.botById(b)).filter((b): b is Bot => b !== undefined)
  const primary = members[0]
  const title = isGroup ? (conversation?.title || summary?.title || members.map((m) => m.name).join(", ")) : (primary?.name ?? summary?.title ?? "")
  const settings = roster.state.settings ?? DEFAULT_SETTINGS

  // read once it is on screen
  const unread = summary?.unreadCount ?? 0
  useEffect(() => {
    if (unread > 0 && state.synchronized) {
      const t = setTimeout(() => markRead({ conversationId }), 500)
      return () => clearTimeout(t)
    }
    return undefined
  }, [unread, state.synchronized, conversationId, markRead])

  const stateEntries = state.entries
  const stateTurns = state.turns
  const showSteps = settings.showSteps
  const entries = transcriptOf({ entries: stateEntries })
  const nonces = new Set(entries.flatMap((e) => (e.kind === "message" && e.clientNonce ? [e.clientNonce] : [])))
  const pending: ReadonlyArray<PendingMessage> = outbox
    .filter((o) => !nonces.has(o.clientNonce))
    .map((o) => ({ clientNonce: o.clientNonce, text: o.input.text, createdAt: o.createdAt, status: o.status, error: o.error }))
  const rows = layoutTranscript({ entries, turns: stateTurns, pending, showSteps, showCompactions: settings.showCompactions, direct: !isGroup })
  const turns = [...stateTurns.values()].filter((t) => ACTIVE.has(t.status)).sort((a, b) => a.startedAt - b.startedAt)
  const statuses = chatStatuses({ conversationId, botIds, activities: roster.state.activities, turns, conversations: roster.state.conversations, tasks: roster.state.tasks })
  const streaming = new Set(entries.flatMap((e) => (e.kind === "message" && e.streaming && e.author.kind === "bot" ? [e.author.botId] : [])))
  const working = statuses.some((s) => s.kind === "turn")

  // inverted list: newest first
  const items: ReadonlyArray<Item> = [
    ...[...statuses].reverse().map((s, i): Item => ({ kind: "status", status: s, key: `status-${s.botId}-${i}` })),
    ...[...rows].reverse().map((row): Item => ({ kind: "row", row })),
  ]

  const statusText = (s: ChatStatus): string =>
    s.kind === "turn"
      ? activityPhrase({ activity: roster.state.activities.get(s.botId), turn: turns.find((t) => t.botId === s.botId), streaming: streaming.has(s.botId) })
      : s.kind === "handling"
      ? "Handling…"
      : `Busy in ${s.where}${s.queued ? " · your message is queued" : ""}`

  const hasScreen = !isGroup && primary !== undefined && (roster.state.nodes.get(primary.hostNodeId)?.capabilities ?? []).some((c) => /^(desktop|screen|browser)@/.test(c))
  const menu = () => {
    const options = [...(hasScreen ? [`${primary!.name}'s computer`] : []), "Open in web app", "Cancel"]
    const run = (i: number) => {
      const label = options[i]
      if (label === `${primary?.name}'s computer`) openWeb(`#/computer/${encodeURIComponent(primary!.id)}`, label)
      if (label === "Open in web app") openWeb(`#/c/${encodeURIComponent(conversationId)}`, title)
    }
    if (Platform.OS === "ios") ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex: options.length - 1 }, run)
    else Alert.alert(title, undefined, [...options.slice(0, -1).map((t, i) => ({ text: t, onPress: () => run(i) })), { text: "Cancel", style: "cancel" as const }])
  }

  const ctx = {
    theme,
    connection,
    group: isGroup,
    botById: (b: string | undefined) => roster.botById(b),
    requestFor: (e: Parameters<typeof requestForCard>[0]) => requestForCard(e, state.requests),
    primary,
    retry: (clientNonce: string) => retry({ conversationId, clientNonce }),
  }

  const top = insets.top + 6
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: theme.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <FlatList
        inverted
        data={items}
        keyExtractor={(item) => (item.kind === "row" ? item.row.key : item.key)}
        renderItem={({ item }) => (item.kind === "row" ? <RowView row={item.row} ctx={ctx} /> : <StatusLine bot={roster.botById(item.status.botId)} text={statusText(item.status)} theme={theme} />)}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: top + 64 }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (state.hasMoreBefore) void loadOlder(conversationId)
        }}
        ListEmptyComponent={state.synchronized ? undefined : <Text style={[styles.loading, { color: theme.fgTertiary }]}>Loading…</Text>}
      />
      <View style={{ paddingBottom: Math.max(insets.bottom, 10), paddingTop: 6 }}>
        <Composer
          conversationId={conversationId}
          theme={theme}
          working={working}
          placeholder={isGroup ? `Message ${title}` : `Ask ${primary?.name ?? "your Bot"}`}
          onSend={(text, attachmentIds) => send({ conversationId, text, ...(attachmentIds.length > 0 ? { attachmentIds: [...attachmentIds] as never } : {}) })}
          onStop={() => interrupt({ conversationId })}
        />
      </View>

      {/* floating header */}
      <View style={[styles.header, { top }]} pointerEvents="box-none">
        <GlassCircle icon="back" label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} />
        <Pressable onPress={menu} accessibilityRole="button" accessibilityLabel={`${title}, options`} style={styles.titleWrap}>
          <Glass interactive style={styles.titlePill}>
            {isGroup ? <AvatarStack avatars={members.map((m) => m.avatar)} size={26} outline={theme.elevated} /> : <Avatar avatar={primary?.avatar} size={26} />}
            <Text numberOfLines={1} style={[styles.title, { color: theme.fg }]}>{title}</Text>
          </Glass>
        </Pressable>
        <GlassCircle icon="more" label="More" onPress={menu} />
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  header: { position: "absolute", left: 16, right: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  titleWrap: { flexShrink: 1 },
  titlePill: { height: 44, borderRadius: 22, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 10, paddingRight: 16, maxWidth: 240 },
  title: { fontSize: 17, fontWeight: "600", flexShrink: 1 },
  loading: { textAlign: "center", marginVertical: 40, fontSize: 15, transform: [{ scaleY: -1 }] },
})

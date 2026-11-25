// A chat (Grok iOS): the native bar with Back, the Bot's name and its computer over the full-width
// transcript (on the iPhone Duo's cover screen, Back and the computer sit at the top of the side strip);
// the glass composer at the bottom. Rows come from the shared `layoutTranscript`.
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  activityPhrase,
  chatStatuses,
  type ChatStatus,
  layoutTranscript,
  type PendingMessage,
  requestForCard,
  type Row,
} from "@openbot/app-model"
import {
  commands,
  conversationAtom,
  interruptTurnAtom,
  loadOlderAtom,
  outboxAtom,
  retrySendAtom,
  sendMessageAtom,
} from "@openbot/client"
import {
  type Bot,
  type BotId,
  type ConversationId,
  DEFAULT_SETTINGS,
  emptyConversationState,
  transcriptOf,
} from "@openbot/contracts"
import { Exit } from "effect"
import { Stack, useLocalSearchParams } from "expo-router"
import { useHeaderHeight } from "expo-router/react-navigation"
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from "react"
import { Alert, AppState, FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Composer } from "../../src/chat/Composer.tsx"
import { RowView, StatusLine } from "../../src/chat/Rows.tsx"
import { failureText, useRoster, valueOr } from "../../src/data.ts"
import { useIsBesideSidebar } from "../../src/home/ChatSidebar.tsx"
import { leaveChat, openWeb } from "../../src/nav.ts"
import { useConnection } from "../../src/runtime.tsx"
import { useTheme } from "../../src/theme.ts"
import { Avatar, AvatarStack } from "../../src/ui/Avatar.tsx"
import { type BarItem, NativeBarItems, useBarLivesInSideRail, useBottomEdgeInset } from "../../src/ui/NativeBar.tsx"

const ACTIVE = new Set(["queued", "running", "waiting"])

const transparent = (hex: string) => `${hex.slice(0, 7)}00`

type Item =
  | { readonly kind: "row"; readonly row: Row }
  | { readonly kind: "status"; readonly status: ChatStatus; readonly key: string }

export default function Chat(): ReactNode {
  const { id } = useLocalSearchParams<{ id: string }>()
  const conversationId = (id ?? "") as ConversationId
  return <ChatScreen key={conversationId} conversationId={conversationId} />
}

const useAppActive = (): boolean => {
  const [active, setActive] = useState(AppState.currentState === "active")
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => setActive(next === "active"))
    return () => subscription.remove()
  }, [])
  return active
}

function ChatScreen({ conversationId }: { readonly conversationId: ConversationId }): ReactNode {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const connection = useConnection()
  const roster = useRoster()
  const result = useAtomValue(conversationAtom(conversationId))
  const state = valueOr(result, emptyConversationState)
  const failed = result._tag === "Failure"
  const outbox = useAtomValue(outboxAtom(conversationId))
  const send = useAtomSet(sendMessageAtom)
  const retry = useAtomSet(retrySendAtom)
  const interrupt = useAtomSet(interruptTurnAtom, { mode: "promiseExit" })
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
  const title = isGroup
    ? conversation?.title || summary?.title || members.map((m) => m.name).join(", ")
    : (primary?.name ?? summary?.title ?? "")
  const settings = roster.state.settings ?? DEFAULT_SETTINGS

  const appActive = useAppActive()
  const unread = summary?.unreadCount ?? 0
  useEffect(() => {
    if (unread > 0 && state.synchronized && appActive) {
      const t = setTimeout(() => markRead({ conversationId }), 500)
      return () => clearTimeout(t)
    }
    return undefined
  }, [unread, state.synchronized, appActive, conversationId, markRead])

  const loadingOlder = useRef(false)
  const hasMoreBefore = state.hasMoreBefore
  const loadOlderOnce = () => {
    if (!hasMoreBefore || loadingOlder.current) return
    loadingOlder.current = true
    void loadOlder(conversationId).finally(() => {
      loadingOlder.current = false
    })
  }

  const stateEntries = state.entries
  const stateTurns = state.turns
  const showSteps = settings.showSteps
  const showCompactions = settings.showCompactions
  const entries = transcriptOf({ entries: stateEntries })
  const nonces = new Set(entries.flatMap((e) => (e.kind === "message" && e.clientNonce ? [e.clientNonce] : [])))
  const pending: ReadonlyArray<PendingMessage> = outbox
    .filter((o) => !nonces.has(o.clientNonce))
    .map((o) => ({
      clientNonce: o.clientNonce,
      text: o.input.text,
      createdAt: o.createdAt,
      status: o.status,
      error: o.error,
    }))
  const rows = layoutTranscript({ entries, turns: stateTurns, pending, showSteps, showCompactions, direct: !isGroup })
  const turns = [...stateTurns.values()].filter((t) => ACTIVE.has(t.status)).sort((a, b) => a.startedAt - b.startedAt)
  const statuses = chatStatuses({
    conversationId,
    botIds,
    activities: roster.state.activities,
    turns,
    conversations: roster.state.conversations,
    tasks: roster.state.tasks,
  })
  const streaming = new Set(
    entries.flatMap((e) => (e.kind === "message" && e.streaming && e.author.kind === "bot" ? [e.author.botId] : [])),
  )
  const working = statuses.some((s) => s.kind === "turn")

  const items: ReadonlyArray<Item> = [
    ...[...statuses].reverse().map((s, i): Item => ({ kind: "status", status: s, key: `status-${s.botId}-${i}` })),
    ...[...rows].reverse().map((row): Item => ({ kind: "row", row })),
  ]

  const statusText = (s: ChatStatus): string =>
    s.kind === "turn"
      ? activityPhrase({
          activity: roster.state.activities.get(s.botId),
          turn: turns.find((t) => t.botId === s.botId),
          streaming: streaming.has(s.botId),
        })
      : s.kind === "handling"
        ? "Handling…"
        : `Busy in ${s.where}${s.queued ? " · your message is queued" : ""}`

  const hasScreen =
    !isGroup &&
    primary !== undefined &&
    (roster.state.nodes.get(primary.hostNodeId)?.capabilities ?? []).some((c) => /^(desktop|screen|browser)@/.test(c))
  const actions = [
    ...(hasScreen && primary !== undefined
      ? [
          {
            title: `${primary.name}'s computer`,
            icon: "display" as const,
            onPress: () => openWeb(`#/computer/${encodeURIComponent(primary.id)}`, `${primary.name}'s computer`),
          },
        ]
      : []),
  ]
  const besideSidebar = useIsBesideSidebar()
  const barInSideRail = useBarLivesInSideRail()
  const bottomInset = useBottomEdgeInset()
  const headerHeight = useHeaderHeight()
  const backItems: ReadonlyArray<BarItem> = besideSidebar
    ? []
    : [{ kind: "button", icon: "chevron.left", label: "Back", onPress: leaveChat }]
  const titleItem: BarItem = {
    kind: "view",
    label: title,
    element: (
      <View style={styles.titleRow}>
        {isGroup ? (
          <AvatarStack avatars={members.map((m) => m.avatar)} size={30} outline={theme.bg} />
        ) : (
          <Avatar avatar={primary?.avatar} size={30} />
        )}
        <Text numberOfLines={1} style={[styles.title, { color: theme.fg }]}>
          {title}
        </Text>
      </View>
    ),
  }
  const actionItems: ReadonlyArray<BarItem> = actions.map((action) => ({
    kind: "button",
    icon: action.icon,
    label: action.title,
    onPress: action.onPress,
  }))

  const botById = roster.botById
  const requests = state.requests
  const ctx = {
    theme,
    connection,
    group: isGroup,
    botById,
    requestFor: (e: Parameters<typeof requestForCard>[0]) => requestForCard(e, requests),
    primary,
    retry: (clientNonce: string) => retry({ conversationId, clientNonce }),
  }

  let emptyState: ReactElement | undefined
  if (failed) {
    emptyState = (
      <Text accessibilityRole="alert" style={[styles.loading, { color: theme.fgSecondary }]}>
        Couldn't load this conversation. Go back and try again.
      </Text>
    )
  } else if (!state.synchronized) {
    emptyState = <Text style={[styles.loading, { color: theme.fgTertiary }]}>Loading…</Text>
  }

  const rightInset = barInSideRail ? 0 : insets.right
  const sideInsets = { paddingLeft: insets.left, paddingRight: rightInset }
  const barBottom = Math.max(headerHeight, insets.top + 52)
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Stack.Screen
        options={{
          headerShown: true,
          headerTransparent: true,
          headerShadowVisible: false,
          headerBackVisible: false,
          title: "",
          headerTitle: () => null,
        }}
      />
      <NativeBarItems leading={[...backItems, titleItem]} trailing={actionItems} />
      <FlatList
        inverted
        data={failed ? [] : items}
        keyExtractor={(item) => (item.kind === "row" ? item.row.key : item.key)}
        renderItem={({ item }) =>
          item.kind === "row" ? (
            <RowView row={item.row} ctx={ctx} />
          ) : (
            <StatusLine bot={roster.botById(item.status.botId)} text={statusText(item.status)} theme={theme} />
          )
        }
        contentContainerStyle={{
          paddingLeft: 16 + insets.left,
          paddingRight: 16 + rightInset,
          paddingTop: 12,
          paddingBottom: barBottom + 12,
        }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onEndReachedThreshold={0.4}
        onEndReached={loadOlderOnce}
        ListEmptyComponent={emptyState}
      />
      <View
        pointerEvents="none"
        style={[
          styles.topFade,
          {
            height: barBottom + 28,
            experimental_backgroundImage: `linear-gradient(to bottom, ${theme.bg} ${Math.round((barBottom / (barBottom + 28)) * 100)}%, ${transparent(theme.bg)})`,
          },
        ]}
      />
      {!failed && (
        <View style={{ paddingBottom: Math.max(bottomInset, 10), paddingTop: 6, ...sideInsets }}>
          <Composer
            conversationId={conversationId}
            theme={theme}
            working={working}
            placeholder={isGroup ? `Message ${title}` : `Ask ${primary?.name ?? "your Bot"}`}
            onSend={(text, attachmentIds) =>
              send({
                conversationId,
                text,
                ...(attachmentIds.length > 0 ? { attachmentIds: [...attachmentIds] as never } : {}),
              })
            }
            onStop={async () => {
              const exit = await interrupt({ conversationId })
              if (Exit.isFailure(exit)) Alert.alert("Couldn't stop", failureText(exit))
            }}
          />
        </View>
      )}
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  topFade: { position: "absolute", top: 0, left: 0, right: 0 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8, maxWidth: 240 },
  title: { fontSize: 17, fontWeight: "600", flexShrink: 1 },
  loading: { textAlign: "center", marginVertical: 40, fontSize: 15, transform: [{ scaleY: -1 }] },
})

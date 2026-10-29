// Home (Grok iOS): pinned Bots as tiles, then the sections, group chats and unassigned Bots, each row
// with its preview, time and status. Floating glass chrome: account, search and new chat at the top,
// Computers at the bottom.
import { useAtomValue } from "@effect/atom-react"
import { buildSidebar, formatListTime, initials, plainPreview, type SidebarItem } from "@openbot/app-model"
import { connectionAtom, sessionInfoAtom } from "@openbot/client"
import { type ReactNode, useMemo, useState } from "react"
import {
  ActionSheetIOS,
  Alert,
  Platform,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useRoster, valueOr } from "../src/data.ts"
import { openChat, openWeb } from "../src/nav.ts"
import { useSession } from "../src/runtime.tsx"
import { type Theme, useTheme } from "../src/theme.ts"
import { Avatar, AvatarStack } from "../src/ui/Avatar.tsx"
import { Glass, GlassCircle } from "../src/ui/glass.tsx"
import { Icon } from "../src/ui/Icon.tsx"

export default function Home(): ReactNode {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const roster = useRoster()
  const connection = useAtomValue(connectionAtom)
  const info = valueOr(useAtomValue(sessionInfoAtom), undefined)
  const { disconnect } = useSession()
  const [query, setQuery] = useState<string | undefined>(undefined)

  const model = useMemo(() => buildSidebar(roster.state), [roster.state])
  const q = query?.trim().toLowerCase() ?? ""
  const matches = (item: SidebarItem) =>
    q === "" ||
    (item.kind === "bot"
      ? `${item.bot.name} ${item.bot.label ?? ""}`
      : `${item.summary.title ?? ""} ${item.bots.map((b) => b.name).join(" ")}`
    )
      .toLowerCase()
      .includes(q)
  const pinned = q === "" ? model.pinned : []
  const sections = model.sections
    .map((s) => ({
      key: s.id,
      title: s.name,
      data: q === "" ? s.items : [...s.items, ...(s.id === "unassigned" ? model.pinned : [])].filter(matches),
    }))
    .filter((s) => s.data.length > 0)

  const ownerName = info?.ownerName ?? roster.state.settings?.ownerName
  const account = () => {
    const actions = ["Settings", "Profiles", "Computers", "Disconnect this iPhone", "Cancel"] as const
    const run = (i: number) => {
      if (i === 0) openWeb("#/settings/general", "Settings")
      if (i === 1) openWeb("#/settings/profiles", "Profiles")
      if (i === 2) openWeb("#/settings/computers", "Computers")
      if (i === 3) {
        Alert.alert("Disconnect this iPhone?", "You can connect it again with a new code from Settings › iPhone app.", [
          { text: "Cancel", style: "cancel" },
          { text: "Disconnect", style: "destructive", onPress: () => void disconnect() },
        ])
      }
    }
    if (Platform.OS === "ios")
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [...actions], cancelButtonIndex: 4, destructiveButtonIndex: 3 },
        run,
      )
    else
      Alert.alert("OpenBot", undefined, [
        { text: actions[0], onPress: () => run(0) },
        { text: actions[1], onPress: () => run(1) },
        { text: actions[2], onPress: () => run(2) },
        { text: actions[3], style: "destructive", onPress: () => run(3) },
        { text: "Cancel", style: "cancel" },
      ])
  }

  const top = insets.top + 8
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.key}
        stickySectionHeadersEnabled={false}
        contentInsetAdjustmentBehavior="never"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingTop: top + 60, paddingBottom: insets.bottom + 96 }}
        ListHeaderComponent={
          <>
            {query !== undefined && (
              <Glass style={styles.search}>
                <Icon name="search" size={16} color={theme.iconSecondary} />
                <TextInput
                  autoFocus
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search Bots and chats"
                  placeholderTextColor={theme.fgQuaternary}
                  style={[styles.searchInput, { color: theme.fg }]}
                  returnKeyType="search"
                />
                <Pressable onPress={() => setQuery(undefined)} hitSlop={8} accessibilityLabel="Close search">
                  <Text style={{ color: theme.accentFg, fontSize: 15, fontWeight: "600" }}>Cancel</Text>
                </Pressable>
              </Glass>
            )}
            {pinned.length > 0 && (
              <View style={styles.tiles}>
                {pinned.map((item) => (
                  <Pressable
                    key={item.key}
                    onPress={() => openChat(item.bot.directConversationId)}
                    style={({ pressed }) => [
                      styles.tile,
                      { backgroundColor: theme.elevated, opacity: pressed ? 0.7 : 1 },
                    ]}
                  >
                    <View>
                      <Avatar avatar={item.bot.avatar} size={56} />
                      <StatusDot status={item.status} theme={theme} big />
                    </View>
                    <Text numberOfLines={1} style={[styles.tileName, { color: theme.fg }]}>
                      {item.bot.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
            {!roster.loaded && (
              <Text style={[styles.empty, { color: theme.fgTertiary }]}>
                {connection.status === "offline" ? "Can't reach OpenBot. Retrying…" : "Connecting…"}
              </Text>
            )}
          </>
        }
        renderSectionHeader={({ section }) => (
          <Text style={[styles.sectionTitle, { color: theme.fgSecondary }]}>{section.title}</Text>
        )}
        renderItem={({ item }) => <Row item={item} theme={theme} />}
      />

      {/* floating chrome */}
      <View style={[styles.topBar, { top }]} pointerEvents="box-none">
        <Pressable onPress={account} accessibilityRole="button" accessibilityLabel="Account">
          <Glass interactive style={styles.monogram}>
            <Text style={{ color: theme.fg, fontSize: 17, fontWeight: "600" }}>{initials(ownerName)}</Text>
          </Glass>
        </Pressable>
        <View style={{ flexDirection: "row", gap: 10 }}>
          <GlassCircle icon="search" label="Search" onPress={() => setQuery(query === undefined ? "" : undefined)} />
          <GlassCircle icon="plus" label="New chat" onPress={() => openWeb("#/new", "New chat")} />
        </View>
      </View>
      {connection.status === "offline" && roster.loaded && (
        <View style={[styles.offline, { top: top + 52 }]} pointerEvents="none">
          <Glass style={styles.offlinePill}>
            <Text style={{ color: theme.fgSecondary, fontSize: 13 }}>Reconnecting…</Text>
          </Glass>
        </View>
      )}
      <View style={[styles.bottomBar, { bottom: insets.bottom + 10 }]} pointerEvents="box-none">
        <Pressable
          onPress={() => openWeb("#/settings/computers", "Computers")}
          accessibilityRole="button"
          style={{ flex: 1 }}
        >
          <Glass interactive style={styles.computers}>
            <Icon name="computer" size={18} color={theme.icon} />
            <Text style={{ color: theme.fg, fontSize: 17, fontWeight: "500" }}>Computers</Text>
          </Glass>
        </Pressable>
      </View>
    </View>
  )
}

function StatusDot({
  status,
  theme,
  big = false,
}: {
  readonly status: SidebarItem["status"]
  readonly theme: Theme
  readonly big?: boolean
}): ReactNode {
  if (status === "idle") return null
  const color = status === "working" ? theme.success : status === "attention" ? theme.warn : theme.accent
  const size = big ? 14 : 11
  return (
    <View
      style={{
        position: "absolute",
        right: big ? 2 : -1,
        bottom: big ? 2 : -1,
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        borderWidth: 2,
        borderColor: big ? theme.elevated : theme.bg,
      }}
    />
  )
}

function Row({ item, theme }: { readonly item: SidebarItem; readonly theme: Theme }): ReactNode {
  const conversationId = item.kind === "bot" ? item.bot.directConversationId : item.summary.id
  const name = item.kind === "bot" ? item.bot.name : item.summary.title || item.bots.map((b) => b.name).join(", ")
  const at = item.kind === "bot" ? item.summary?.lastActivityAt : item.summary.lastActivityAt
  const busy = item.status === "working" || item.status === "attention"
  return (
    <Pressable
      onPress={() => openChat(conversationId)}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.secondary }]}
    >
      <View>
        {item.kind === "bot" ? (
          <Avatar avatar={item.bot.avatar} size={44} />
        ) : (
          <AvatarStack avatars={item.bots.map((b) => b.avatar)} size={44} outline={theme.bg} />
        )}
        <StatusDot status={item.status} theme={theme} />
      </View>
      <View style={styles.rowText}>
        <View style={styles.rowTop}>
          <Text numberOfLines={1} style={[styles.rowName, { color: theme.fg }]}>
            {name}
          </Text>
          {item.kind === "bot" && item.bot.label ? (
            <View style={[styles.chip, { backgroundColor: theme.secondary, borderColor: theme.lineTertiary }]}>
              <Text numberOfLines={1} style={{ color: theme.fgSecondary, fontSize: 12 }}>
                {item.bot.label}
              </Text>
            </View>
          ) : null}
          <View style={{ flex: 1 }} />
          {at !== undefined && (
            <Text style={[styles.time, { color: item.unread ? theme.accentFg : theme.fgTertiary }]}>
              {formatListTime(at)}
            </Text>
          )}
        </View>
        <Text numberOfLines={1} style={[styles.preview, { color: busy ? theme.fg : theme.fgSecondary }]}>
          {plainPreview(item.preview) || " "}
        </Text>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  topBar: {
    position: "absolute",
    left: 16,
    right: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  monogram: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  bottomBar: { position: "absolute", left: 16, right: 16, flexDirection: "row" },
  computers: {
    height: 52,
    borderRadius: 26,
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  offline: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  offlinePill: { paddingHorizontal: 14, height: 30, borderRadius: 15, justifyContent: "center" },
  search: {
    marginHorizontal: 16,
    marginBottom: 12,
    height: 44,
    borderRadius: 22,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
  },
  searchInput: { flex: 1, fontSize: 16, height: 44 },
  tiles: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 12, gap: 8, marginBottom: 8 },
  tile: {
    width: "31.5%",
    aspectRatio: 1,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 6,
  },
  tileName: { fontSize: 14, fontWeight: "500", maxWidth: "100%" },
  sectionTitle: { fontSize: 15, marginTop: 18, marginBottom: 4, paddingHorizontal: 20 },
  row: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 20, paddingVertical: 10 },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowName: { fontSize: 17, fontWeight: "600", flexShrink: 1 },
  chip: {
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderWidth: StyleSheet.hairlineWidth,
    flexShrink: 1,
    maxWidth: 140,
  },
  time: { fontSize: 13 },
  preview: { fontSize: 15 },
  empty: { textAlign: "center", marginTop: 40, fontSize: 15 },
})

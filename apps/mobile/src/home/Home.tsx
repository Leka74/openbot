// Home (Grok iOS): pinned Bots as tiles, then the sections, group chats and unassigned Bots, each row
// with its preview, time and status. Floating glass chrome: account, search and new chat at the top,
// Computers at the bottom.
import { useAtomValue } from "@effect/atom-react"
import { buildSidebar, formatListTime, initials, plainPreview, type SidebarItem } from "@openbot/app-model"
import { connectionAtom, sessionInfoAtom } from "@openbot/client"
import { Stack } from "expo-router"
import { memo, type ReactNode, useMemo, useState } from "react"
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
import { useRoster, valueOr } from "../data.ts"
import { openChat, openWeb } from "../nav.ts"
import { useSession } from "../runtime.tsx"
import { type Theme, useTheme } from "../theme.ts"
import { Avatar, AvatarStack } from "../ui/Avatar.tsx"
import { Glass, GlassCircle } from "../ui/glass.tsx"
import { Icon } from "../ui/Icon.tsx"
import { NativeBarItems, railItems, useBarLivesInSideRail, useBottomEdgeInset } from "../ui/NativeBar.tsx"

export function Home(): ReactNode {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const roster = useRoster()
  const connection = useAtomValue(connectionAtom)
  const info = valueOr(useAtomValue(sessionInfoAtom), undefined)
  const { disconnect } = useSession()
  const [query, setQuery] = useState<string | undefined>(undefined)
  const [listWidth, setListWidth] = useState(0)
  const barInSideRail = useBarLivesInSideRail()
  const bottomInset = useBottomEdgeInset()

  const model = useMemo(() => buildSidebar(roster.state), [roster.state])
  const tile = tileLayout(listWidth)
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

  const toggleSearch = () => setQuery(query === undefined ? "" : undefined)
  const newChat = () => openWeb("#/new", "New chat")
  const computers = () => openWeb("#/settings/computers", "Computers")

  const top = insets.top + 8
  const sides = { left: 16 + insets.left, right: 16 + insets.right }
  return (
    <View
      style={{ flex: 1, backgroundColor: theme.bg }}
      onLayout={(e) => setListWidth(e.nativeEvent.layout.width - insets.left - insets.right)}
    >
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.key}
        stickySectionHeadersEnabled={false}
        contentInsetAdjustmentBehavior="never"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{
          paddingTop: top + 60,
          paddingBottom: barInSideRail ? bottomInset + 24 : insets.bottom + 96,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        }}
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
                    accessibilityRole="button"
                    accessibilityLabel={item.bot.name}
                    style={({ pressed }) => [
                      styles.tile,
                      {
                        ...(tile.width === undefined ? {} : { width: tile.width }),
                        backgroundColor: theme.elevated,
                        opacity: pressed ? 0.7 : 1,
                      },
                    ]}
                  >
                    <View>
                      <Avatar avatar={item.bot.avatar} size={tile.avatar} />
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

      <Stack.Screen options={{ headerShown: barInSideRail, headerTransparent: true, title: "" }} />
      {barInSideRail && (
        <NativeBarItems
          bottom={railItems([
            { kind: "button", icon: "magnifyingglass", label: "Search", onPress: toggleSearch },
            { kind: "button", icon: "plus", label: "New chat", onPress: newChat },
            { kind: "button", icon: "display", label: "Computers", onPress: computers },
          ])}
        />
      )}
      {/* floating chrome */}
      <View style={[styles.topBar, { top, ...sides }]} pointerEvents="box-none">
        <Pressable onPress={account} accessibilityRole="button" accessibilityLabel="Account">
          <Glass interactive style={styles.monogram}>
            <Text style={{ color: theme.fg, fontSize: 17, fontWeight: "600" }}>{initials(ownerName)}</Text>
          </Glass>
        </Pressable>
        {!barInSideRail && (
          <View style={{ flexDirection: "row", gap: 10 }}>
            <GlassCircle icon="search" label="Search" onPress={toggleSearch} />
            <GlassCircle icon="plus" label="New chat" onPress={newChat} />
          </View>
        )}
      </View>
      {connection.status === "offline" && roster.loaded && (
        <View style={[styles.offline, { top: top + 52 }]} pointerEvents="none">
          <Glass style={styles.offlinePill}>
            <Text style={{ color: theme.fgSecondary, fontSize: 13 }}>Reconnecting…</Text>
          </Glass>
        </View>
      )}
      {!barInSideRail && (
        <View style={[styles.bottomBar, { bottom: insets.bottom + 10, ...sides }]} pointerEvents="box-none">
          <Pressable onPress={computers} accessibilityRole="button" style={{ flex: 1 }}>
            <Glass interactive style={styles.computers}>
              <Icon name="computer" size={18} color={theme.icon} />
              <Text style={{ color: theme.fg, fontSize: 17, fontWeight: "500" }}>Computers</Text>
            </Glass>
          </Pressable>
        </View>
      )}
    </View>
  )
}

export function StatusDot({
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

const tileGap = 8
const tilePadding = 12
const smallestTile = 104

const tileLayout = (listWidth: number) => {
  const usable = Math.max(0, listWidth - tilePadding * 2)
  const columns = Math.max(3, Math.floor((usable + tileGap) / (smallestTile + tileGap)))
  const width = listWidth === 0 ? undefined : Math.floor((usable - tileGap * (columns - 1)) / columns)
  const avatar = width === undefined ? 56 : Math.min(56, Math.round(width * 0.52))
  return { width, avatar }
}

export const rowConversationId = (item: SidebarItem): string =>
  item.kind === "bot" ? item.bot.directConversationId : item.summary.id

interface RowProps {
  readonly item: SidebarItem
  readonly theme: Theme
  readonly selected?: boolean
  readonly onOpen?: (conversationId: string) => void
}

const sameBots = (a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>) =>
  a.length === b.length && a.every((bot, i) => bot === b[i])

const sameItem = (a: SidebarItem, b: SidebarItem): boolean => {
  if (a.key !== b.key || a.status !== b.status || a.preview !== b.preview || a.unread !== b.unread) return false
  if (a.kind === "bot" && b.kind === "bot")
    return a.bot === b.bot && a.summary?.lastActivityAt === b.summary?.lastActivityAt
  if (a.kind === "group" && b.kind === "group")
    return (
      a.summary.title === b.summary.title &&
      a.summary.lastActivityAt === b.summary.lastActivityAt &&
      sameBots(a.bots, b.bots)
    )
  return false
}

export const Row = memo(
  RowContent,
  (a: RowProps, b: RowProps) => a.theme === b.theme && a.selected === b.selected && sameItem(a.item, b.item),
)

function RowContent({ item, theme, selected = false, onOpen = openChat }: RowProps): ReactNode {
  const conversationId = rowConversationId(item)
  const name = item.kind === "bot" ? item.bot.name : item.summary.title || item.bots.map((b) => b.name).join(", ")
  const at = item.kind === "bot" ? item.summary?.lastActivityAt : item.summary.lastActivityAt
  const busy = item.status === "working" || item.status === "attention"
  return (
    <Pressable
      onPress={() => onOpen(conversationId)}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.row,
        selected && [styles.selectedRow, { backgroundColor: theme.secondary }],
        pressed && { backgroundColor: theme.secondary },
      ]}
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
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  monogram: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  bottomBar: { position: "absolute", flexDirection: "row" },
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
  tiles: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: tilePadding, gap: tileGap, marginBottom: 8 },
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
  selectedRow: { marginHorizontal: 8, paddingHorizontal: 12, borderRadius: 14 },
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

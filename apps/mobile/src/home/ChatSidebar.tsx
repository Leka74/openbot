import { buildSidebar, type SidebarItem } from "@openbot/app-model"
import { createContext, type ReactNode, useContext, useMemo } from "react"
import { FlatList, Pressable, SectionList, StyleSheet, Text, View } from "react-native"
import Animated, { FadeIn, FadeOut } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useRoster } from "../data.ts"
import { leaveChat, switchChat } from "../nav.ts"
import { useTheme } from "../theme.ts"
import { Avatar, AvatarStack } from "../ui/Avatar.tsx"
import { Icon } from "../ui/Icon.tsx"
import { Row, rowConversationId, StatusDot } from "./Home.tsx"

export const sidebarWidth = 300
export const collapsedSidebarWidth = 76
const contentIn = FadeIn.duration(180).delay(60)
const contentOut = FadeOut.duration(120)

export const BesideSidebarContext = createContext(false)

export const useIsBesideSidebar = (): boolean => useContext(BesideSidebarContext)

const openUnlessOpen = (conversationId: string, openConversationId: string | undefined) => {
  if (conversationId !== openConversationId) switchChat(conversationId)
}

export function ChatSidebar({
  openConversationId,
  collapsed,
  onToggleCollapsed,
}: {
  readonly openConversationId: string | undefined
  readonly collapsed: boolean
  readonly onToggleCollapsed: () => void
}): ReactNode {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const roster = useRoster()
  const model = useMemo(() => buildSidebar(roster.state, openConversationId), [roster.state, openConversationId])
  const sections = [
    ...(model.pinned.length > 0
      ? [{ key: "pinned", title: "Pinned", data: model.pinned as ReadonlyArray<SidebarItem> }]
      : []),
    ...model.sections.map((s) => ({ key: s.id, title: s.name, data: s.items })),
  ].filter((s) => s.data.length > 0)
  const everyItem = sections.flatMap((s) => s.data)

  const collapseToggle = (
    <Pressable
      onPress={onToggleCollapsed}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={collapsed ? "Show chat list" : "Collapse chat list"}
      style={styles.iconButton}
    >
      <Icon name="sidebar" size={20} color={theme.iconSecondary} />
    </Pressable>
  )

  const backToChats = (
    <Pressable
      onPress={leaveChat}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Back to chats"
      style={styles.back}
    >
      <Icon name="back" size={20} color={theme.fg} />
      {!collapsed && (
        <Text accessibilityRole="header" style={[styles.title, { color: theme.fg }]}>
          Chats
        </Text>
      )}
    </Pressable>
  )

  return (
    <View
      style={[
        styles.sidebar,
        {
          width: collapsed ? collapsedSidebarWidth : sidebarWidth,
          paddingTop: insets.top + 8,
          borderRightColor: theme.lineTertiary,
        },
      ]}
    >
      {collapsed ? (
        <Animated.View key="collapsed" entering={contentIn} exiting={contentOut} style={styles.fill}>
          <View style={styles.collapsedHeader}>{backToChats}</View>
          <FlatList
            data={everyItem}
            keyExtractor={(item) => item.key}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ alignItems: "center", gap: 10, paddingVertical: 8 }}
            renderItem={({ item }) => <RailAvatar item={item} open={rowConversationId(item) === openConversationId} />}
          />
          <View style={[styles.collapsedFooter, { paddingBottom: insets.bottom + 12 }]}>{collapseToggle}</View>
        </Animated.View>
      ) : (
        <Animated.View key="expanded" entering={contentIn} exiting={contentOut} style={styles.fill}>
          <View style={styles.header}>
            {backToChats}
            {collapseToggle}
          </View>
          <SectionList
            sections={sections}
            keyExtractor={(item) => item.key}
            stickySectionHeadersEnabled={false}
            contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
            renderSectionHeader={({ section }) => (
              <Text style={[styles.sectionTitle, { color: theme.fgSecondary }]}>{section.title}</Text>
            )}
            renderItem={({ item }) => (
              <Row
                item={item}
                theme={theme}
                selected={rowConversationId(item) === openConversationId}
                onOpen={(conversationId) => openUnlessOpen(conversationId, openConversationId)}
              />
            )}
          />
        </Animated.View>
      )}
    </View>
  )
}

function RailAvatar({ item, open }: { readonly item: SidebarItem; readonly open: boolean }): ReactNode {
  const theme = useTheme()
  const name = item.kind === "bot" ? item.bot.name : item.summary.title || item.bots.map((b) => b.name).join(", ")
  return (
    <Pressable
      onPress={() => switchChat(rowConversationId(item))}
      accessibilityRole="button"
      accessibilityLabel={name}
      accessibilityState={{ selected: open }}
      style={[styles.ring, { borderColor: open ? theme.accent : "transparent" }]}
    >
      <View>
        {item.kind === "bot" ? (
          <Avatar avatar={item.bot.avatar} size={44} />
        ) : (
          <AvatarStack avatars={item.bots.map((b) => b.avatar)} size={44} outline={theme.bg} />
        )}
        <StatusDot status={item.status} theme={theme} />
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  sidebar: { borderRightWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  fill: { flex: 1 },
  header: {
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 12,
    paddingRight: 8,
    marginBottom: 4,
  },
  collapsedHeader: { height: 44, alignItems: "center", justifyContent: "center", marginBottom: 4 },
  collapsedFooter: { alignItems: "center", paddingTop: 8 },
  back: { flexDirection: "row", alignItems: "center", gap: 6, height: 44, paddingHorizontal: 4 },
  title: { fontSize: 20, fontWeight: "700" },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  sectionTitle: { fontSize: 13, fontWeight: "600", marginTop: 14, marginBottom: 2, paddingHorizontal: 20 },
  ring: { padding: 3, borderRadius: 28, borderWidth: 2 },
})

import { Stack, useGlobalSearchParams } from "expo-router"
import { type ReactNode, useState } from "react"
import { StyleSheet, useWindowDimensions, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { BesideSidebarContext, ChatSidebar } from "../../src/home/ChatSidebar.tsx"
import { useTheme } from "../../src/theme.ts"

const narrowestWidthWithSidebar = 640

export default function ChatLayout(): ReactNode {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  const { id } = useGlobalSearchParams<{ id?: string }>()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const showsSidebar = width - insets.left - insets.right >= narrowestWidthWithSidebar

  return (
    <View style={[styles.row, { backgroundColor: theme.bg, paddingLeft: showsSidebar ? insets.left : 0 }]}>
      {showsSidebar && (
        <ChatSidebar
          openConversationId={id}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((collapsed) => !collapsed)}
        />
      )}
      <BesideSidebarContext.Provider value={showsSidebar}>
        <View style={styles.chat}>
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg } }}>
            <Stack.Screen name="[id]" options={showsSidebar ? { animation: "none" } : undefined} />
          </Stack>
        </View>
      </BesideSidebarContext.Provider>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: "row" },
  chat: { flex: 1 },
})

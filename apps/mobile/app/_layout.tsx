// Root: the session (keychain), the OpenBot client for it, and the screens. Not connected → only the
// connect screen; connected → Home, chats and the web pages.
import "../src/polyfills.ts"
import { Stack } from "expo-router"
import { StatusBar } from "expo-status-bar"
import type { ReactNode } from "react"
import { View } from "react-native"
import { GestureHandlerRootView } from "react-native-gesture-handler"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { ClientProvider, SessionProvider, useSession } from "../src/runtime.tsx"
import { useTheme } from "../src/theme.ts"

export default function RootLayout(): ReactNode {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <SessionProvider>
          <Root />
        </SessionProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}

function Root(): ReactNode {
  const { connection } = useSession()
  const theme = useTheme()
  if (connection === undefined) return <View style={{ flex: 1, backgroundColor: theme.bg }} />
  const stack = (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg } }}>
      <Stack.Protected guard={connection !== null}>
        <Stack.Screen name="index" />
        <Stack.Screen name="chat" />
        <Stack.Screen name="web" options={{ presentation: "modal", headerShown: true, title: "" }} />
      </Stack.Protected>
      <Stack.Protected guard={connection === null}>
        <Stack.Screen name="connect" />
      </Stack.Protected>
    </Stack>
  )
  return (
    <>
      <StatusBar style={theme.dark ? "light" : "dark"} />
      {connection ? <ClientProvider connection={connection}>{stack}</ClientProvider> : stack}
    </>
  )
}

// A page of the web app inside the app (Settings, Computers, a Bot's computer, new chats), signed in
// with the app's own session through a one-time code.
import { router, Stack, useLocalSearchParams } from "expo-router"
import { createElement, type ReactNode, useEffect, useState } from "react"
import { ActivityIndicator, Platform, StyleSheet, Text, View } from "react-native"
import { SafeAreaView } from "react-native-screens/experimental"
import { WebView } from "react-native-webview"
import { useConnection } from "../src/runtime.tsx"
import { webPageUrl } from "../src/session.ts"
import { useTheme } from "../src/theme.ts"
import { NativeBarItems } from "../src/ui/NativeBar.tsx"

const sideEdges = { left: true, right: true } as const

export default function Web(): ReactNode {
  const { path, title } = useLocalSearchParams<{ path?: string; title?: string }>()
  const theme = useTheme()
  const connection = useConnection()
  const [url, setUrl] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    let live = true
    webPageUrl(connection, path ?? "#/")
      .then((u) => live && setUrl(u))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [connection, path])

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Stack.Screen
        options={{
          title: title ?? "OpenBot",
          headerStyle: { backgroundColor: theme.bg },
          headerTitleStyle: { color: theme.fg },
          headerShadowVisible: false,
        }}
      />
      <NativeBarItems trailing={[{ kind: "button", icon: "xmark", label: "Done", onPress: () => router.back() }]} />
      <SafeAreaView edges={sideEdges} style={styles.fill}>
        {error !== undefined ? (
          <Text style={[styles.message, { color: theme.dangerFg }]}>{error}</Text>
        ) : url === undefined ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={theme.fg} />
        ) : Platform.OS === "web" ? (
          createElement("iframe", { src: url, style: { flex: 1, border: 0, width: "100%", height: "100%" } })
        ) : (
          <WebView
            source={{ uri: url }}
            style={{ flex: 1, backgroundColor: theme.bg }}
            sharedCookiesEnabled
            allowsInlineMediaPlayback
            startInLoadingState
            renderLoading={() => <ActivityIndicator style={StyleSheet.absoluteFill} color={theme.fg} />}
          />
        )}
      </SafeAreaView>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  message: { textAlign: "center", marginTop: 40, paddingHorizontal: 32, fontSize: 15 },
})

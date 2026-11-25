// Connect: scan the code under Settings › iPhone app in OpenBot (or paste it, or the login link
// OpenBot printed), trade it for a session, done.
import { CameraView, useCameraPermissions } from "expo-camera"
import * as Clipboard from "expo-clipboard"
import { Image } from "expo-image"
import { type ReactNode, useRef, useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useSession } from "../src/runtime.tsx"
import { connect, parseConnectInput } from "../src/session.ts"
import { useTheme } from "../src/theme.ts"
import { Glass, GlassCircle } from "../src/ui/glass.tsx"
import { Icon } from "../src/ui/Icon.tsx"

export default function Connect(): ReactNode {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const { connected } = useSession()
  const [text, setText] = useState("")
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [permission, requestPermission] = useCameraPermissions()
  const handled = useRef(false)

  const submit = async (value: string) => {
    const input = parseConnectInput(value)
    if (typeof input === "string") return setError(input)
    setError(undefined)
    setBusy(true)
    try {
      await connected(await connect(input))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      handled.current = false
    } finally {
      setBusy(false)
    }
  }

  const scan = async () => {
    const granted = permission?.granted || (await requestPermission()).granted
    if (!granted) return setError("Allow the camera to scan the code, or paste the link instead.")
    handled.current = false
    setScanning(true)
  }

  if (scanning) {
    return (
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => {
            if (handled.current) return
            handled.current = true
            setScanning(false)
            setText(data)
            void submit(data)
          }}
        />
        <View style={[styles.scanFrame, { borderColor: "rgba(255,255,255,0.9)" }]} pointerEvents="none" />
        <Text style={[styles.scanHint, { bottom: insets.bottom + 110 }]}>
          Scan the code under Settings › iPhone app in OpenBot
        </Text>
        <GlassCircle
          icon="close"
          label="Cancel"
          onPress={() => setScanning(false)}
          style={{ position: "absolute", top: insets.top + 8, left: 16 + insets.left }}
        />
      </View>
    )
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={[
        styles.body,
        {
          paddingTop: insets.top + 48,
          paddingBottom: insets.bottom + 24,
          paddingLeft: 28 + insets.left,
          paddingRight: 28 + insets.right,
        },
      ]}
      contentInsetAdjustmentBehavior="never"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
    >
      <View style={styles.column}>
        <Image source={require("../assets/icon.png")} style={styles.logo} />
        <Text style={[styles.title, { color: theme.fg }]}>Connect to your OpenBot</Text>
        <Text style={[styles.lead, { color: theme.fgSecondary }]}>
          In OpenBot on your computer, open Settings › iPhone app and scan the code. You can also paste the login link
          OpenBot printed when it started.
        </Text>

        <Pressable
          onPress={() => void scan()}
          disabled={busy}
          accessibilityRole="button"
          style={{ alignSelf: "stretch" }}
        >
          <View style={[styles.primary, { backgroundColor: theme.primary }]}>
            <Icon name="scan" size={18} color={theme.onPrimary} />
            <Text style={[styles.primaryText, { color: theme.onPrimary }]}>Scan code</Text>
          </View>
        </Pressable>

        <Text style={[styles.or, { color: theme.fgTertiary }]}>or paste the link</Text>
        <Glass style={styles.field}>
          <TextInput
            value={text}
            onChangeText={(t) => {
              setText(t)
              setError(undefined)
            }}
            placeholder="https://… or openbot://connect…"
            placeholderTextColor={theme.fgQuaternary}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            onSubmitEditing={() => void submit(text)}
            style={[styles.input, { color: theme.fg }]}
          />
          {text === "" ? (
            <Pressable
              onPress={() => void Clipboard.getStringAsync().then((t) => t && setText(t.trim()))}
              accessibilityRole="button"
              style={styles.paste}
            >
              <Text style={{ color: theme.accentFg, fontSize: 15, fontWeight: "600" }}>Paste</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={() => void submit(text)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Connect"
              style={styles.paste}
            >
              {busy ? <ActivityIndicator color={theme.fg} /> : <Icon name="send" size={18} color={theme.fg} />}
            </Pressable>
          )}
        </Glass>
        {error !== undefined && <Text style={[styles.error, { color: theme.dangerFg }]}>{error}</Text>}
        {busy && text === "" && <ActivityIndicator style={{ marginTop: 16 }} color={theme.fg} />}
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  body: { flexGrow: 1, alignItems: "center" },
  column: { width: "100%", maxWidth: 440, alignItems: "center" },
  logo: { width: 72, height: 72, borderRadius: 18, marginBottom: 24 },
  title: { fontSize: 26, fontWeight: "700", textAlign: "center", letterSpacing: -0.4 },
  lead: { fontSize: 16, lineHeight: 22, textAlign: "center", marginTop: 10, marginBottom: 32 },
  primary: {
    height: 52,
    borderRadius: 26,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  primaryText: { fontSize: 17, fontWeight: "600" },
  or: { marginTop: 28, marginBottom: 10, fontSize: 14 },
  field: {
    alignSelf: "stretch",
    height: 52,
    borderRadius: 26,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 18,
    paddingRight: 6,
  },
  input: { flex: 1, fontSize: 16, height: 52 },
  paste: { height: 40, minWidth: 56, paddingHorizontal: 10, alignItems: "center", justifyContent: "center" },
  error: { marginTop: 14, fontSize: 14, lineHeight: 19, textAlign: "center" },
  scanFrame: {
    position: "absolute",
    alignSelf: "center",
    top: "28%",
    width: 240,
    height: 240,
    borderWidth: 3,
    borderRadius: 28,
  },
  scanHint: {
    position: "absolute",
    left: 32,
    right: 32,
    textAlign: "center",
    color: "#fff",
    fontSize: 16,
    fontWeight: "500",
  },
})

// The composer (Grok iOS): a glass "+" for photos, camera and files, a glass pill with the text and
// the send button (stop while the Bot works). Files upload over the RPC socket before sending;
// photos are shrunk on the phone first (compress.ts).
import { useAtomSet } from "@effect/atom-react"
import { uploadFilesAtom, type UploadSource } from "@openbot/client"
import { Exit } from "effect"
import * as DocumentPicker from "expo-document-picker"
import { File } from "expo-file-system"
import * as Haptics from "expo-haptics"
import { Image } from "expo-image"
import * as ImagePicker from "expo-image-picker"
import { type ComponentRef, type ReactNode, useRef, useState } from "react"
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import type { Theme } from "../theme.ts"
import { Glass, GlassCircle } from "../ui/glass.tsx"
import { Icon } from "../ui/Icon.tsx"
import { compressPhoto, type Picked } from "./compress.ts"

const sourceOf = (p: Picked): UploadSource => ({
  name: p.name,
  type: p.mime,
  size: p.size,
  arrayBuffer: () => new File(p.uri).arrayBuffer(),
})

export interface ComposerProps {
  readonly conversationId: string
  readonly placeholder: string
  readonly theme: Theme
  /** a Bot is answering here: the stop button */
  readonly working: boolean
  readonly onSend: (text: string, attachmentIds: ReadonlyArray<string>) => void
  readonly onStop: () => void
}

export function Composer({ conversationId, placeholder, theme, working, onSend, onStop }: ComposerProps): ReactNode {
  const [text, setText] = useState("")
  const [picked, setPicked] = useState<ReadonlyArray<Picked>>([])
  const [uploading, setUploading] = useState(false)
  const upload = useAtomSet(uploadFilesAtom(conversationId), { mode: "promiseExit" })
  const input = useRef<ComponentRef<typeof TextInput>>(null)
  const canSend = (text.trim() !== "" || picked.length > 0) && !uploading

  const add = (items: ReadonlyArray<Picked>) => setPicked((p) => [...p, ...items].slice(0, 10))

  const pickPhotos = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"],
      allowsMultipleSelection: true,
      selectionLimit: 10,
      quality: 0.85,
    })
    if (r.canceled) return
    add(
      r.assets.map((a, i) => ({
        key: `${a.uri}${i}`,
        uri: a.uri,
        name: a.fileName ?? `photo-${Date.now()}-${i}.jpg`,
        mime: a.mimeType ?? "image/jpeg",
        size: a.fileSize ?? 0,
        width: a.width,
        height: a.height,
        image: a.type !== "video",
      })),
    )
  }
  const takePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync()
    if (!permission.granted) return Alert.alert("Camera", "Allow the camera in Settings to take a photo.")
    const r = await ImagePicker.launchCameraAsync({ quality: 0.85 })
    if (r.canceled) return
    const a = r.assets[0]!
    add([
      {
        key: a.uri,
        uri: a.uri,
        name: a.fileName ?? `photo-${Date.now()}.jpg`,
        mime: a.mimeType ?? "image/jpeg",
        size: a.fileSize ?? 0,
        width: a.width,
        height: a.height,
        image: true,
      },
    ])
  }
  const pickFiles = async () => {
    const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
    if (r.canceled) return
    add(
      r.assets.map((a, i) => ({
        key: `${a.uri}${i}`,
        uri: a.uri,
        name: a.name,
        mime: a.mimeType ?? "application/octet-stream",
        size: a.size ?? 0,
        image: (a.mimeType ?? "").startsWith("image/"),
      })),
    )
  }
  const attach = () => {
    const options = ["Photo Library", "Take Photo", "Choose File", "Cancel"]
    const run = (i: number) => void [pickPhotos, takePhoto, pickFiles][i]?.()
    if (Platform.OS === "ios") ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex: 3 }, run)
    else
      Alert.alert("Attach", undefined, [
        ...options.slice(0, 3).map((t, i) => ({ text: t, onPress: () => run(i) })),
        { text: "Cancel", style: "cancel" as const },
      ])
  }

  const send = async () => {
    if (!canSend) return
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined)
    let ids: ReadonlyArray<string> = []
    if (picked.length > 0) {
      setUploading(true)
      // one at a time: a decoded 48 MP photo is large in memory
      const ready: Array<Picked> = []
      for (const p of picked) ready.push(await compressPhoto(p))
      const exit = await upload(ready.map(sourceOf))
      setUploading(false)
      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find((r) => r._tag === "Fail") as
          { readonly error?: { message?: string } } | undefined
        return Alert.alert("Couldn't attach", failure?.error?.message ?? "Check your connection and try again.")
      }
      ids = exit.value.map((a) => a.id)
    }
    onSend(text.trim(), ids)
    setText("")
    setPicked([])
  }

  return (
    <View style={styles.wrap}>
      {picked.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tray}>
          {picked.map((p) => (
            <View
              key={p.key}
              style={[styles.thumb, { backgroundColor: theme.elevated, borderColor: theme.lineSecondary }]}
            >
              {p.image ? (
                <Image source={{ uri: p.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
              ) : (
                <View style={styles.fileThumb}>
                  <Icon name="file" size={20} color={theme.iconSecondary} />
                  <Text numberOfLines={2} style={{ color: theme.fgSecondary, fontSize: 11, textAlign: "center" }}>
                    {p.name}
                  </Text>
                </View>
              )}
              <Pressable
                onPress={() => setPicked((all) => all.filter((x) => x.key !== p.key))}
                hitSlop={8}
                style={[styles.remove, { backgroundColor: theme.bg }]}
                accessibilityLabel={`Remove ${p.name}`}
              >
                <Icon name="close" size={11} color={theme.fg} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}
      <View style={styles.row}>
        <GlassCircle icon="plus" label="Attach" size={48} iconSize={21} onPress={attach} />
        <Glass style={styles.pill}>
          <TextInput
            ref={input}
            value={text}
            onChangeText={setText}
            placeholder={placeholder}
            placeholderTextColor={theme.fgQuaternary}
            multiline
            numberOfLines={1}
            style={[styles.input, { color: theme.fg }]}
            accessibilityLabel={placeholder}
          />
          {canSend || uploading ? (
            <Pressable
              onPress={() => void send()}
              accessibilityRole="button"
              accessibilityLabel="Send"
              style={[styles.send, { backgroundColor: theme.primary }]}
            >
              {uploading ? (
                <ActivityIndicator color={theme.onPrimary} />
              ) : (
                <Icon name="send" size={18} color={theme.onPrimary} />
              )}
            </Pressable>
          ) : working ? (
            <Pressable
              onPress={onStop}
              accessibilityRole="button"
              accessibilityLabel="Stop"
              style={[styles.send, { backgroundColor: theme.primary }]}
            >
              <Icon name="stop" size={14} color={theme.onPrimary} />
            </Pressable>
          ) : (
            <Pressable onPress={() => input.current?.focus()} accessibilityLabel="Dictate" style={styles.mic}>
              <Icon name="mic" size={20} color={theme.iconSecondary} />
            </Pressable>
          )}
        </Glass>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  tray: { gap: 8, paddingHorizontal: 16 },
  thumb: { width: 64, height: 64, borderRadius: 14, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth },
  fileThumb: { flex: 1, alignItems: "center", justifyContent: "center", gap: 2, padding: 4 },
  remove: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 10, paddingHorizontal: 16 },
  pill: {
    flex: 1,
    minHeight: 48,
    borderRadius: 24,
    flexDirection: "row",
    alignItems: "flex-end",
    paddingLeft: 18,
    paddingRight: 6,
    paddingVertical: 6,
  },
  input: {
    flex: 1,
    fontSize: 17,
    lineHeight: 22,
    minHeight: 36,
    maxHeight: 140,
    paddingTop: 7,
    paddingBottom: 7,
    marginRight: 6,
  },
  send: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  mic: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
})

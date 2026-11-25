import { beforeEach, expect, mock, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { conversationAtom, interruptTurnAtom, outboxAtom, rosterAtom } from "@openbot/client"
import { emptyConversationState, emptyRosterState, Internal, NotFound } from "@openbot/contracts"
import { Exit } from "effect"
import { AsyncResult } from "effect/reactivity"

const conversationId = "cnv_missing"
let result
let outbox
const alert = mock(() => {})
let onStop
let stopExit

mock.module("@effect/atom-react", () => ({
  useAtomValue: (atom) => {
    if (atom === conversationAtom(conversationId)) return result
    if (atom === rosterAtom) return AsyncResult.success(emptyRosterState)
    if (atom === outboxAtom(conversationId)) return outbox
    throw new Error("Unexpected atom")
  },
  useAtomSet: (atom, options) => {
    if (atom === interruptTurnAtom && options?.mode === "promiseExit") return async () => stopExit
    return () => {}
  },
}))

const Container = ({ children }) => createElement("div", null, children)
mock.module("react-native", () => ({
  Alert: { alert },
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
  FlatList: ({ data, ListEmptyComponent }) =>
    createElement("div", null, data.length === 0 ? ListEmptyComponent : "Transcript"),
  KeyboardAvoidingView: Container,
  Platform: { OS: "ios" },
  StyleSheet: { create: (styles) => styles },
  Text: Container,
  View: Container,
  useColorScheme: () => "dark",
}))
mock.module("expo-router", () => ({
  useLocalSearchParams: () => ({ id: conversationId }),
  Stack: { Screen: () => null },
}))
mock.module("expo-router/react-navigation", () => ({ useHeaderHeight: () => 0 }))
mock.module("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }))
mock.module("../src/runtime.tsx", () => ({ useConnection: () => ({}) }))
mock.module("../src/nav.ts", () => ({ leaveChat: mock(() => {}), openWeb: mock(() => {}) }))
mock.module("../src/home/ChatSidebar.tsx", () => ({ useIsBesideSidebar: () => false }))
mock.module("../src/chat/Composer.tsx", () => ({
  Composer: (props) => {
    onStop = props.onStop
    return createElement("input", { "aria-label": "Message" })
  },
}))
mock.module("../src/chat/Rows.tsx", () => ({ RowView: () => null, StatusLine: () => null }))
mock.module("../src/ui/Avatar.tsx", () => ({ Avatar: () => null, AvatarStack: () => null }))
mock.module("../src/ui/NativeBar.tsx", () => ({
  NativeBarItems: ({ leading }) =>
    leading.map((item) => (item.kind === "button" ? createElement("button", { key: item.label }, item.label) : null)),
  useBarLivesInSideRail: () => false,
  useBottomEdgeInset: () => 0,
}))

const { default: Chat } = await import("../app/chat/[id].tsx")

beforeEach(() => {
  result = AsyncResult.initial()
  outbox = []
  stopExit = Exit.void
  alert.mockClear()
})

test("a terminal conversation error replaces Loading and removes the composer", () => {
  result = AsyncResult.fail(new NotFound({ entity: "conversation", id: conversationId }))
  outbox = [{ clientNonce: "pending", input: { text: "Unsent message" }, createdAt: 1, status: "sending" }]
  const html = renderToStaticMarkup(createElement(Chat))
  expect(html).toContain("Couldn&#x27;t load this conversation. Go back and try again.")
  expect(html).toContain("Back")
  expect(html).not.toContain("Loading")
  expect(html).not.toContain('aria-label="Message"')
})

test("an initial conversation still loads, and a synchronized empty chat does not", () => {
  expect(renderToStaticMarkup(createElement(Chat))).toContain("Loading")
  result = AsyncResult.success({ ...emptyConversationState, synchronized: true })
  const html = renderToStaticMarkup(createElement(Chat))
  expect(html).not.toContain("Loading")
  expect(html).not.toContain("load this conversation")
  expect(html).toContain('aria-label="Message"')
})

test("a rejected Stop shows an alert, while a successful Stop does not", async () => {
  renderToStaticMarkup(createElement(Chat))
  stopExit = Exit.fail(new Internal({ message: "Stop was refused" }))
  await onStop()
  expect(alert).toHaveBeenCalledWith("Couldn't stop", "Stop was refused")
  alert.mockClear()
  stopExit = Exit.void
  await onStop()
  expect(alert).not.toHaveBeenCalled()
})

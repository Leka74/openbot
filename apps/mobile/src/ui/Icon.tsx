// Icons: SF Symbols on iOS (expo-symbols), the matching Material Symbols elsewhere.
import { SymbolView } from "expo-symbols"
import type { ReactNode } from "react"

const ICONS = {
  back: { ios: "chevron.left", web: "arrow_back_ios_new" },
  sidebar: { ios: "sidebar.left", web: "left_panel_open" },
  chats: { ios: "bubble.left.and.bubble.right", web: "forum" },
  more: { ios: "ellipsis", web: "more_horiz" },
  plus: { ios: "plus", web: "add" },
  search: { ios: "magnifyingglass", web: "search" },
  send: { ios: "arrow.up", web: "arrow_upward" },
  stop: { ios: "stop.fill", web: "stop" },
  mic: { ios: "mic", web: "mic" },
  computer: { ios: "display", web: "desktop_windows" },
  close: { ios: "xmark", web: "close" },
  check: { ios: "checkmark", web: "check" },
  settings: { ios: "gearshape", web: "settings" },
  chevronRight: { ios: "chevron.right", web: "chevron_right" },
  chevronDown: { ios: "chevron.down", web: "expand_more" },
  scan: { ios: "qrcode.viewfinder", web: "qr_code_scanner" },
  photo: { ios: "photo", web: "image" },
  file: { ios: "doc", web: "description" },
  camera: { ios: "camera", web: "photo_camera" },
  warning: { ios: "exclamationmark.triangle", web: "warning" },
  retry: { ios: "arrow.clockwise", web: "refresh" },
  logout: { ios: "rectangle.portrait.and.arrow.right", web: "logout" },
  bolt: { ios: "bolt.fill", web: "bolt" },
  person: { ios: "person.crop.circle", web: "account_circle" },
  globe: { ios: "globe", web: "public" },
  external: { ios: "arrow.up.right", web: "arrow_outward" },
} as const

export type IconName = keyof typeof ICONS

export function Icon({
  name,
  size = 18,
  color,
}: {
  readonly name: IconName
  readonly size?: number
  readonly color: string
}): ReactNode {
  const symbol = ICONS[name]
  return (
    <SymbolView
      name={symbol as never}
      size={size}
      tintColor={color}
      weight="medium"
      style={{ width: size, height: size }}
    />
  )
}

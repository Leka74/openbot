import { Stack } from "expo-router"
import type { SFSymbol } from "expo-symbols"
import type { ReactElement, ReactNode } from "react"
import { useWindowDimensions } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

export interface BarButton {
  readonly kind: "button"
  readonly icon: SFSymbol
  readonly label: string
  readonly onPress: () => void
}

export interface BarMenu {
  readonly kind: "menu"
  readonly icon: SFSymbol
  readonly label: string
  readonly actions: ReadonlyArray<{ readonly title: string; readonly icon?: SFSymbol; readonly onPress: () => void }>
}

export interface BarView {
  readonly kind: "view"
  readonly label: string
  readonly element: ReactElement
}

export interface BarSpacer {
  readonly kind: "spacer"
  readonly width: number
}

export type BarItem = BarButton | BarMenu | BarView | BarSpacer

const railGroupGap: BarItem = { kind: "spacer", width: 24 }
const railEndGap: BarItem = { kind: "spacer", width: 16 }

export const railItems = (actions: ReadonlyArray<BarItem>, back: ReadonlyArray<BarItem> = []): BarItem[] => {
  if (actions.length === 0 && back.length === 0) return []
  const gap = actions.length > 0 && back.length > 0 ? [railGroupGap] : []
  return [...actions, ...gap, ...back, railEndGap]
}

export const useBarLivesInSideRail = (): boolean => {
  const insets = useSafeAreaInsets()
  const { width, height } = useWindowDimensions()
  return height > width && insets.left + insets.right > 0
}

const sideRailBottomInset = 24

export const useBottomEdgeInset = (): number => {
  const insets = useSafeAreaInsets()
  return useBarLivesInSideRail() ? Math.min(insets.bottom, sideRailBottomInset) : insets.bottom
}

function renderItem(item: BarItem): ReactNode {
  if (item.kind === "spacer") return <Stack.Toolbar.Spacer key={`spacer-${item.width}`} width={item.width} />
  if (item.kind === "view")
    return (
      <Stack.Toolbar.View key={item.label} hidesSharedBackground>
        {item.element}
      </Stack.Toolbar.View>
    )
  if (item.kind === "menu")
    return (
      <Stack.Toolbar.Menu key={item.label} icon={item.icon} accessibilityLabel={item.label}>
        {item.actions.map((action) => (
          <Stack.Toolbar.MenuAction
            key={action.title}
            {...(action.icon === undefined ? {} : { icon: action.icon })}
            onPress={action.onPress}
          >
            {action.title}
          </Stack.Toolbar.MenuAction>
        ))}
      </Stack.Toolbar.Menu>
    )
  return (
    <Stack.Toolbar.Button key={item.label} icon={item.icon} accessibilityLabel={item.label} onPress={item.onPress} />
  )
}

export function NativeBarItems({
  leading = [],
  trailing = [],
  bottom = [],
}: {
  readonly leading?: ReadonlyArray<BarItem>
  readonly trailing?: ReadonlyArray<BarItem>
  readonly bottom?: ReadonlyArray<BarItem>
}): ReactNode {
  return (
    <>
      {leading.length > 0 && <Stack.Toolbar placement="left">{leading.map(renderItem)}</Stack.Toolbar>}
      {trailing.length > 0 && <Stack.Toolbar placement="right">{trailing.map(renderItem)}</Stack.Toolbar>}
      {bottom.length > 0 && <Stack.Toolbar placement="bottom">{bottom.map(renderItem)}</Stack.Toolbar>}
    </>
  )
}

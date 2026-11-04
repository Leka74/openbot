/** Keep transport, reducers and notification side effects live; batch presentation updates. */
export const presentationIntervalMs = (): number =>
  typeof document === "undefined" ? 0 : document.visibilityState === "visible" && document.hasFocus() ? 50 : 1000

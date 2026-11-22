// A bot's whole desktop over `/ws/computer/:botId?mode=view|control` (raw RFB, see ./desktop.ts) drawn
// by noVNC's RFB client into a caller-owned element. Watching = `mode=view` + `viewOnly`; control =
// `mode=control` (the brain refuses it without the lease) with input and keyboard focus. Reconnects
// with backoff; React state changes only on phase changes, never per frame. A page in the background
// stops watching immediately (an unwatched screen can sleep), as does an offscreen/unfocused view.
//
// noVNC is loaded on first use (dynamic import) so the app shell never pays for it.
import { useVisibleSurface } from "./useVisibleSurface.ts"
import type RFB from "@novnc/novnc"
import { type RefObject, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react"
import {
  backoffMs,
  classifyClose,
  type DesktopConn,
  desktopReducer,
  initialDesktopConn,
  keysymsOf,
  KEYSYM,
  type ViewMode,
} from "./desktop.ts"
import { computerSocketUrl } from "./protocol.ts"

type RfbClass = typeof RFB

let rfbModule: Promise<RfbClass> | undefined
/**
 * The noVNC RFB class, loaded once. noVNC logs every failed connect as a console error; the view says
 * it already, so its log is off unless `localStorage["openbot.novncLog"]` names a level ("debug"…).
 */
export const loadRfb = (): Promise<RfbClass> => {
  rfbModule ??= import("@novnc/novnc").then(
    (m) => {
      let level: string | null = null
      try {
        level = globalThis.localStorage?.getItem("openbot.novncLog") ?? null
      } catch {
        // storage blocked
      }
      try {
        m.initLogging?.((level ?? "none") as "none")
      } catch {
        m.initLogging?.("none")
      }
      return m.default
    },
    (e: unknown) => {
      rfbModule = undefined
      throw e
    },
  )
  return rfbModule
}

export interface UseDesktopOptions {
  readonly botId: string
  /** Connect at all (false: idle, the last state is kept for display). */
  readonly enabled: boolean
  readonly mode: ViewMode
  readonly viewPath?: string | undefined
  /** The element noVNC draws into (its children belong to noVNC). */
  readonly targetRef: RefObject<HTMLElement | null>
  /** JPEG quality 0–9 (Grok starts at 6). Thumbnails use less. */
  readonly quality?: number
  /** A preview (the side thumbnail): it does not keep the screen awake, and lets it sleep. */
  readonly passive?: boolean
  /** Something went wrong: refetch `computer.status`. */
  readonly onTrouble?: () => void
  /** The brain ended this control socket (handed back elsewhere, or no lease): watch again. */
  readonly onLeaseLost?: () => void
}

export interface DesktopHandle {
  readonly state: DesktopConn
  /** Reconnect now (resets the backoff). */
  readonly retry: () => void
  /** Keyboard focus to the remote screen (control mode). */
  readonly focus: () => void
  /** Type text on the remote screen (the phone keyboard); `Backspace` / `Enter` as keys. */
  readonly typeText: (text: string) => void
  readonly pressKey: (key: keyof typeof KEYSYM) => void
}

export function useDesktop({
  botId,
  enabled,
  mode,
  viewPath,
  targetRef,
  quality = 6,
  passive = false,
  onTrouble,
  onLeaseLost,
}: UseDesktopOptions): DesktopHandle {
  const [state, dispatch] = useReducer(desktopReducer, initialDesktopConn)
  const [generation, setGeneration] = useState(0)
  const rfbRef = useRef<RFB | undefined>(undefined)
  const troubleRef = useRef(onTrouble)
  const leaseLostRef = useRef(onLeaseLost)
  const shown = useVisibleSurface(targetRef, enabled)
  // in control the owner holds the screen anyway: keep the socket
  const live = enabled && (shown || mode === "control")
  useLayoutEffect(() => {
    troubleRef.current = onTrouble
    leaseLostRef.current = onLeaseLost
  })

  useEffect(() => {
    if (!live) {
      dispatch({ type: "disable" })
      return
    }
    let disposed = false
    let failures = 0
    // control sockets the brain refused before the upgrade (HTTP 403: no lease), in a row
    let refused = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let current: RFB | undefined

    const schedule = () => {
      if (disposed) return
      failures++
      timer = setTimeout(() => void connect(), backoffMs(failures))
    }

    const connect = async () => {
      if (disposed) return
      dispatch({ type: "attempt" })
      let RfbCtor: RfbClass
      try {
        RfbCtor = await loadRfb()
      } catch (e) {
        if (disposed) return
        console.warn("[openbot] the noVNC viewer failed to load", e)
        dispatch({ type: "load-failed", message: "The screen viewer didn't load. Check your connection." })
        schedule()
        return
      }
      const target = targetRef.current
      if (disposed) return
      if (!target) {
        schedule()
        return
      }
      const socket = new WebSocket(computerSocketUrl(botId, mode, viewPath, passive))
      socket.binaryType = "arraybuffer"
      let opened = false
      let connected = false
      let ended = false
      // noVNC replaces the socket's on* handlers; listeners added here keep the close code and reason
      socket.addEventListener("open", () => {
        opened = true
      })
      let rfb: RFB
      try {
        rfb = new RfbCtor(target, socket, { shared: true })
      } catch (e) {
        socket.close()
        console.warn("[openbot] the noVNC viewer failed to start", e)
        dispatch({ type: "load-failed", message: "The screen viewer couldn't start in this browser." })
        schedule()
        return
      }
      current = rfb
      rfbRef.current = rfb
      rfb.viewOnly = mode !== "control"
      rfb.scaleViewport = true
      rfb.clipViewport = false
      rfb.resizeSession = false
      rfb.background = "transparent"
      rfb.qualityLevel = quality
      rfb.compressionLevel = 2
      rfb.focusOnClick = mode === "control"
      rfb.showDotCursor = mode === "control"

      const end = (code: number, reason: string) => {
        if (ended || disposed) return
        ended = true
        if (current === rfb) current = undefined
        if (rfbRef.current === rfb) rfbRef.current = undefined
        const close = { code, reason, mode, opened, connected }
        dispatch({ type: "closed", close })
        troubleRef.current?.()
        const verdict = classifyClose(close)
        refused = mode === "control" && !opened ? refused + 1 : 0
        if (verdict === "lease-lost" || refused >= 2) {
          leaseLostRef.current?.()
          return
        }
        if (verdict === "asleep") return
        if (connected) failures = 0
        schedule()
      }
      socket.addEventListener("close", (e: CloseEvent) => end(e.code, e.reason))
      rfb.addEventListener("connect", () => {
        if (disposed) return
        connected = true
        failures = 0
        dispatch({ type: "connected" })
        if (mode === "control") rfb.focus({ preventScroll: true })
      })
      // a handshake failure noVNC detects itself; the socket's close event (with the brain's code) wins
      // when it comes in the same task
      rfb.addEventListener("disconnect", () => {
        setTimeout(() => end(1006, ""), 50)
      })
    }

    void connect()
    return () => {
      disposed = true
      clearTimeout(timer)
      const rfb = current
      current = undefined
      if (rfbRef.current === rfb) rfbRef.current = undefined
      try {
        rfb?.disconnect()
      } catch {
        // already disconnected
      }
    }
  }, [botId, live, mode, viewPath, targetRef, quality, passive, generation])

  const retry = useCallback(() => setGeneration((g) => g + 1), [])
  const focus = useCallback(() => rfbRef.current?.focus({ preventScroll: true }), [])
  const typeText = useCallback((text: string) => {
    const rfb = rfbRef.current
    if (!rfb) return
    for (const keysym of keysymsOf(text)) rfb.sendKey(keysym, null)
  }, [])
  const pressKey = useCallback((key: keyof typeof KEYSYM) => rfbRef.current?.sendKey(KEYSYM[key], null), [])
  return { state, retry, focus, typeText, pressKey }
}

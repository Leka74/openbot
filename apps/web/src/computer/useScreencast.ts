// Live screen of a bot's browser over `/ws/computer/:botId?mode=view|control` (see ./protocol.ts).
// Frames are decoded off the socket and painted onto a caller-owned <canvas>; React state only changes
// on phase / size / lease / URL changes, never per frame. Only the newest pending frame is drawn.
import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { containFit } from "./desktop.ts"
import {
  type BrowserInputEvent,
  computerSocketUrl,
  decodeScreencastFrame,
  decodeScreencastNotice,
  type ScreencastFrameMeta,
} from "./protocol.ts"

import { useVisibleSurface } from "./useVisibleSurface.ts"

export type ScreenPhase =
  /** Not connecting (disabled). */
  | "idle"
  /** Socket opening (first attempt or a reconnect). */
  | "connecting"
  /** Socket open, no frame painted yet. */
  | "waiting"
  /** At least one frame painted. */
  | "live"
  /** The server said the stream ended (`Ended` notice); a reconnect is scheduled. */
  | "ended"
  /** The socket could not be opened; a reconnect is scheduled. */
  | "unreachable"

export interface ScreencastState {
  readonly phase: ScreenPhase
  /** Size of the last painted frame (`width/height` = image pixels; `viewport*` = page CSS pixels). */
  readonly meta: Pick<ScreencastFrameMeta, "width" | "height" | "viewportWidth" | "viewportHeight"> | undefined
  /** Lease holder as last announced by the server. */
  readonly holder: "user" | "bot" | undefined
  readonly page: { readonly url: string; readonly title: string } | undefined
  /** Reason from an `Ended` notice. */
  readonly message: string | undefined
}

export interface UseScreencastOptions {
  readonly botId: string
  readonly enabled: boolean
  readonly mode: "view" | "control"
  readonly viewPath?: string | undefined
  readonly canvasRef: RefObject<HTMLCanvasElement | null>
  /** Called when the socket fails or ends, so the caller can refetch `computer.status`. */
  readonly onTrouble?: () => void
}

const initial: ScreencastState = {
  phase: "idle",
  meta: undefined,
  holder: undefined,
  page: undefined,
  message: undefined,
}

const backoffMs = (attempt: number) => Math.min(10_000, 500 * 2 ** Math.max(0, attempt - 1))

export function useScreencast({ botId, enabled, mode, viewPath, canvasRef, onTrouble }: UseScreencastOptions) {
  const visible = useVisibleSurface(canvasRef, enabled)
  const live = enabled && (mode === "control" || visible)
  const [state, setState] = useState<ScreencastState>(initial)
  const [generation, setGeneration] = useState(0)
  const socketRef = useRef<WebSocket | null>(null)
  const metaRef = useRef<ScreencastState["meta"]>(undefined)
  const troubleRef = useRef(onTrouble)
  useLayoutEffect(() => {
    troubleRef.current = onTrouble
  })

  useEffect(() => {
    if (!live) return
    let disposed = false
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let ws: WebSocket | null = null
    // frame pump: keep only the newest undecoded frame
    let pending: { meta: ScreencastFrameMeta; image: Uint8Array } | undefined
    let drawing = false
    let painted = false
    let paintTimer: ReturnType<typeof setTimeout> | undefined
    let lastDecode = -Infinity
    const frameInterval = mode === "control" ? 1000 / 15 : 200
    const schedulePaint = () => {
      if (disposed || drawing || paintTimer !== undefined || !pending) return
      paintTimer = setTimeout(() => {
        paintTimer = undefined
        void paint()
      }, Math.max(0, frameInterval - (performance.now() - lastDecode)))
    }

    const patch = (p: Partial<ScreencastState>) => {
      if (!disposed) setState((s) => ({ ...s, ...p }))
    }

    const paint = async () => {
      if (drawing) return
      drawing = true
      try {
        if (pending && !disposed) {
          lastDecode = performance.now()
          const frame = pending
          pending = undefined
          const blob = new Blob([frame.image as Uint8Array<ArrayBuffer>], { type: frame.meta.mime })
          let bitmap: ImageBitmap
          try {
            bitmap = await createImageBitmap(blob)
          } catch {
            return
          }
          const canvas = canvasRef.current
          if (disposed || !canvas) {
            bitmap.close()
            return
          }
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width
            canvas.height = bitmap.height
          }
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0)
          bitmap.close()
          const next = {
            width: canvas.width,
            height: canvas.height,
            viewportWidth: frame.meta.viewportWidth,
            viewportHeight: frame.meta.viewportHeight,
          }
          const prev = metaRef.current
          const sizeChanged =
            !prev ||
            prev.width !== next.width ||
            prev.height !== next.height ||
            prev.viewportWidth !== next.viewportWidth ||
            prev.viewportHeight !== next.viewportHeight
          if (sizeChanged) metaRef.current = next
          if (!painted || sizeChanged) {
            painted = true
            patch({ phase: "live", meta: next, message: undefined })
          }
        }
      } finally {
        drawing = false
        schedulePaint()
      }
    }

    const scheduleReconnect = () => {
      if (disposed) return
      attempt++
      timer = setTimeout(connect, backoffMs(attempt))
    }

    const connect = () => {
      if (disposed) return
      painted = false
      patch({ phase: "connecting" })
      let opened = false
      const socket = new WebSocket(computerSocketUrl(botId, mode, viewPath))
      socket.binaryType = "arraybuffer"
      ws = socket
      socketRef.current = socket
      socket.onopen = () => {
        opened = true
        attempt = 0
        patch({ phase: "waiting", message: undefined })
      }
      socket.onmessage = (e: MessageEvent) => {
        if (typeof e.data === "string") {
          const notice = decodeScreencastNotice(e.data)
          if (!notice) return
          if (notice._tag === "Lease") patch({ holder: notice.holder })
          else if (notice._tag === "Url") patch({ page: { url: notice.url, title: notice.title } })
          else patch({ phase: "ended", message: notice.reason })
          return
        }
        if (e.data instanceof ArrayBuffer) {
          const frame = decodeScreencastFrame(e.data)
          if (!frame) return
          pending = frame
          schedulePaint()
        }
      }
      socket.onclose = (e: CloseEvent) => {
        if (socketRef.current === socket) socketRef.current = null
        if (disposed) return
        // control sockets are closed with 1000 after Stop; the caller switches back to `view`
        if (e.code === 1000 && mode === "control") {
          patch({ holder: "bot" })
          troubleRef.current?.()
          return
        }
        if (!opened) patch({ phase: "unreachable" })
        else setState((s) => ({ ...s, phase: s.phase === "ended" ? "ended" : "connecting" }))
        troubleRef.current?.()
        scheduleReconnect()
      }
    }

    connect()
    return () => {
      disposed = true
      clearTimeout(timer)
      clearTimeout(paintTimer)
      pending = undefined
      if (ws) {
        ws.onclose = null
        ws.onmessage = null
        ws.onopen = null
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, "viewer closed")
      }
      if (socketRef.current === ws) socketRef.current = null
    }
  }, [botId, live, mode, viewPath, canvasRef, generation])

  /** Send one input event (control sockets only; silently dropped otherwise). */
  const send = useCallback(
    (event: BrowserInputEvent) => {
      const ws = socketRef.current
      if (mode !== "control" || !ws || ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify(event))
    },
    [mode],
  )

  const reconnect = useCallback(() => setGeneration((g) => g + 1), [])

  // disabled: report idle (the last frame size and lease stay known)
  const shown = useMemo<ScreencastState>(
    () => (live || state.phase === "idle" ? state : { ...state, phase: "idle" }),
    [live, state],
  )
  return { state: shown, send, reconnect, metaRef }
}

/** Contain-fit a `aspect` (w/h) box inside an element; returns the fitted CSS size. */
export function useContainFit(
  containerRef: RefObject<HTMLElement | null>,
  aspect: number,
): { readonly width: number; readonly height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w <= 0 || h <= 0) return
      const next = containFit(w, h, aspect)
      setSize((s) => (s.width === next.width && s.height === next.height ? s : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [containerRef, aspect])
  return size
}

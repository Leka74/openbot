import { downsample, encodePcm16, joinChunks, toBase64 } from "@openbot/app-model"
import { sttStatusAtom } from "@openbot/client"
import { DICTATION_SAMPLE_RATE } from "@openbot/contracts"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { useCommand, useQuery } from "../details/kit.tsx"
import { describeMicrophoneError, type Microphone, microphoneAvailable, startMicrophone } from "./dictation.ts"

export type DictationPhase = "idle" | "starting" | "recording" | "finishing"

export interface DictationControls {
  readonly available: boolean
  readonly phase: DictationPhase
  readonly elapsedSeconds: number
  readonly start: () => void
  readonly finish: () => void
  readonly cancel: () => void
}

export interface DictationCallbacks {
  readonly draftKey: string
  readonly onStart: () => void
  readonly onText: (text: string) => void
  readonly onDone: (text: string) => void
  readonly onCancel: () => void
  readonly onError: (message: string) => void
}

const PUMP_INTERVAL_MS = 120
const MIN_CHUNK_SECONDS = 0.25
const TIMER_TICK_MS = 250
const INSTALL_POLL_MS = 1000

interface Recording {
  readonly attempt: number
  readonly sessionId: Promise<string | undefined>
  readonly chunks: Array<Float32Array>
  microphone?: Microphone
  inFlight: Promise<void>
  sending: boolean
  latestText: string
  pump?: ReturnType<typeof setInterval>
}

const recordingSampleRate = (active: Recording) => active.microphone?.sampleRate ?? DICTATION_SAMPLE_RATE

const bufferedSeconds = (active: Recording) => active.chunks.reduce((total, chunk) => total + chunk.length, 0) / recordingSampleRate(active)

const takeBufferedAudio = (active: Recording): string =>
  toBase64(encodePcm16(downsample(joinChunks(active.chunks.splice(0)), recordingSampleRate(active), DICTATION_SAMPLE_RATE)))

export function useDictation(callbacks: DictationCallbacks): DictationControls {
  const status = useQuery(sttStatusAtom)
  const installing = status.value?.state === "installing"
  useEffect(() => {
    if (!installing) return
    const poll = setInterval(status.refresh, INSTALL_POLL_MS)
    return () => clearInterval(poll)
  }, [installing, status.refresh])
  const openSession = useCommand("stt.open", callbacks.draftKey).run
  const appendAudio = useCommand("stt.append", callbacks.draftKey).run
  const finishSession = useCommand("stt.finish", callbacks.draftKey).run
  const discardSession = useCommand("stt.discard", callbacks.draftKey).run
  const [phase, setPhase] = useState<DictationPhase>("idle")
  const [startedAt, setStartedAt] = useState(0)
  const [now, setNow] = useState(0)
  const recording = useRef<Recording | undefined>(undefined)
  const attempt = useRef(0)
  const latest = useRef(callbacks)
  useLayoutEffect(() => {
    latest.current = callbacks
  })

  const release = useCallback((active: Recording) => {
    clearInterval(active.pump)
    void active.microphone?.stop()
    if (recording.current === active) recording.current = undefined
  }, [])

  const fail = useCallback((active: Recording, message: string) => {
    attempt.current++
    release(active)
    void active.sessionId.then((sessionId) => {
      if (sessionId !== undefined) void discardSession({ sessionId })
    })
    setPhase("idle")
    latest.current.onDone(active.latestText)
    latest.current.onError(message)
  }, [release, discardSession])

  const sendBuffered = useCallback(async (active: Recording) => {
    const sessionId = await active.sessionId
    if (sessionId === undefined || active.attempt !== attempt.current) return
    const result = await appendAudio({ sessionId, pcmBase64: takeBufferedAudio(active) })
    if (active.attempt !== attempt.current) return
    if (!result.ok) return fail(active, result.error)
    active.latestText = result.value.text
    latest.current.onText(result.value.text)
  }, [appendAudio, fail])

  const pumpOnce = useCallback((active: Recording) => {
    if (active.sending || bufferedSeconds(active) < MIN_CHUNK_SECONDS) return
    active.sending = true
    active.inFlight = sendBuffered(active).finally(() => {
      active.sending = false
    })
  }, [sendBuffered])

  const finish = useCallback(async () => {
    const active = recording.current
    if (active === undefined || active.microphone === undefined) return
    clearInterval(active.pump)
    setPhase("finishing")
    await active.microphone.stop()
    await active.inFlight
    const sessionId = await active.sessionId
    if (sessionId === undefined || active.attempt !== attempt.current) return
    const result = await finishSession({ sessionId, pcmBase64: takeBufferedAudio(active) })
    if (active.attempt !== attempt.current) return
    if (!result.ok) return fail(active, result.error)
    release(active)
    latest.current.onText(result.value.text)
    latest.current.onDone(result.value.text)
    setPhase("idle")
  }, [finishSession, fail, release])

  const start = useCallback(async () => {
    if (recording.current !== undefined) return
    const thisAttempt = ++attempt.current
    const sessionId = openSession(undefined as never).then((result) => {
      if (result.ok) return result.value.sessionId
      if (thisAttempt === attempt.current && recording.current !== undefined) fail(recording.current, result.error)
      return undefined
    })
    const active: Recording = { attempt: thisAttempt, sessionId, chunks: [], inFlight: Promise.resolve(), sending: false, latestText: "" }
    recording.current = active
    setPhase("starting")
    latest.current.onStart()
    try {
      const microphone = await startMicrophone((samples) => active.chunks.push(samples), () => void finish())
      active.microphone = microphone
      if (thisAttempt !== attempt.current) return void microphone.stop()
      active.pump = setInterval(() => pumpOnce(active), PUMP_INTERVAL_MS)
      setStartedAt(Date.now())
      setNow(Date.now())
      setPhase("recording")
    } catch (error) {
      if (thisAttempt === attempt.current) fail(active, describeMicrophoneError(error))
    }
  }, [openSession, finish, pumpOnce, fail])

  const cancel = useCallback(() => {
    const active = recording.current
    attempt.current++
    if (active === undefined) return
    release(active)
    void active.sessionId.then((sessionId) => {
      if (sessionId !== undefined) void discardSession({ sessionId })
    })
    setPhase("idle")
    latest.current.onCancel()
  }, [discardSession, release])

  useEffect(() => {
    if (phase !== "recording") return
    const ticker = setInterval(() => setNow(Date.now()), TIMER_TICK_MS)
    return () => clearInterval(ticker)
  }, [phase])

  useEffect(() => {
    if (phase !== "recording" && phase !== "starting") return
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    window.addEventListener("keydown", cancelOnEscape, true)
    return () => window.removeEventListener("keydown", cancelOnEscape, true)
  }, [phase, cancel])

  useEffect(() => cancel, [cancel])

  return {
    available: status.value?.state === "ready" && microphoneAvailable(),
    phase,
    elapsedSeconds: phase === "recording" ? Math.floor((now - startedAt) / 1000) : 0,
    start: () => void start(),
    finish: () => void finish(),
    cancel,
  }
}

export const formatElapsed = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`

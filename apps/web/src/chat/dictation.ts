import { MAX_DICTATION_SECONDS } from "@openbot/contracts"

export const microphoneAvailable = (): boolean =>
  typeof window !== "undefined" && window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === "function"

const TAP_PROCESSOR = "openbot-dictation-tap"
const TAP_MODULE = `registerProcessor("${TAP_PROCESSOR}", class extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) this.port.postMessage(channel.slice(0))
    return true
  }
})`

export interface Microphone {
  readonly sampleRate: number
  readonly stop: () => void
}

export const startMicrophone = async (onAudio: (samples: Float32Array) => void, onLimitReached: () => void): Promise<Microphone> => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
  const context = new AudioContext()
  const moduleUrl = URL.createObjectURL(new Blob([TAP_MODULE], { type: "text/javascript" }))
  const limit = setTimeout(onLimitReached, MAX_DICTATION_SECONDS * 1000)
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    clearTimeout(limit)
    stream.getTracks().forEach((track) => track.stop())
    void context.close()
    URL.revokeObjectURL(moduleUrl)
  }
  try {
    await context.audioWorklet.addModule(moduleUrl)
    const source = context.createMediaStreamSource(stream)
    const tap = new AudioWorkletNode(context, TAP_PROCESSOR)
    const silence = context.createGain()
    silence.gain.value = 0
    tap.port.onmessage = (event: MessageEvent<Float32Array>) => onAudio(event.data)
    source.connect(tap).connect(silence).connect(context.destination)
  } catch (error) {
    stop()
    throw error
  }
  return { sampleRate: context.sampleRate, stop }
}

export const describeMicrophoneError = (error: unknown): string => {
  const name = error instanceof DOMException ? error.name : ""
  if (name === "NotAllowedError" || name === "SecurityError") return "OpenBot can't use the microphone. Allow it in your browser's site settings."
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found."
  if (name === "NotReadableError") return "The microphone is in use by another app."
  return "The microphone could not start."
}

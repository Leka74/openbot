import { CString, dlopen, FFIType, type Pointer, ptr } from "bun:ffi"
import type { RecognizerLaunch, RecognizerReply, RecognizerRequest } from "./recognizer-protocol.ts"

const OFFLINE_RECOGNIZER_CONFIG_BYTES = 608
const CONFIG_OFFSETS = {
  sampleRate: 0,
  featureDim: 4,
  encoder: 8,
  decoder: 16,
  joiner: 24,
  tokens: 104,
  numThreads: 112,
  debug: 116,
  provider: 120,
  modelType: 128,
  decodingMethod: 528,
  maxActivePaths: 536,
} as const
const FEATURE_DIM = 80
const MAX_ACTIVE_PATHS = 4

const launch = JSON.parse(process.argv[2] ?? "{}") as RecognizerLaunch
const reply = (message: RecognizerReply) => process.send?.(message)

const sherpa = dlopen(launch.library, {
  SherpaOnnxCreateOfflineRecognizer: { args: [FFIType.ptr], returns: FFIType.ptr },
  SherpaOnnxCreateOfflineStream: { args: [FFIType.ptr], returns: FFIType.ptr },
  SherpaOnnxAcceptWaveformOffline: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.void },
  SherpaOnnxDecodeOfflineStream: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
  SherpaOnnxGetOfflineStreamResultAsJson: { args: [FFIType.ptr], returns: FFIType.ptr },
  SherpaOnnxDestroyOfflineStreamResultJson: { args: [FFIType.ptr], returns: FFIType.void },
  SherpaOnnxDestroyOfflineStream: { args: [FFIType.ptr], returns: FFIType.void },
}).symbols

const stringsKeptAlive: Array<Uint8Array> = []
const cString = (value: string): bigint => {
  const bytes = new TextEncoder().encode(`${value}\0`)
  stringsKeptAlive.push(bytes)
  return BigInt(ptr(bytes))
}

const recognizerConfig = (): Uint8Array => {
  const config = new Uint8Array(OFFLINE_RECOGNIZER_CONFIG_BYTES)
  const view = new DataView(config.buffer)
  view.setInt32(CONFIG_OFFSETS.sampleRate, launch.sampleRate, true)
  view.setInt32(CONFIG_OFFSETS.featureDim, FEATURE_DIM, true)
  view.setBigUint64(CONFIG_OFFSETS.encoder, cString(launch.encoder), true)
  view.setBigUint64(CONFIG_OFFSETS.decoder, cString(launch.decoder), true)
  view.setBigUint64(CONFIG_OFFSETS.joiner, cString(launch.joiner), true)
  view.setBigUint64(CONFIG_OFFSETS.tokens, cString(launch.tokens), true)
  view.setInt32(CONFIG_OFFSETS.numThreads, launch.threads, true)
  view.setInt32(CONFIG_OFFSETS.debug, 0, true)
  view.setBigUint64(CONFIG_OFFSETS.provider, cString("cpu"), true)
  view.setBigUint64(CONFIG_OFFSETS.modelType, cString(launch.modelType), true)
  view.setBigUint64(CONFIG_OFFSETS.decodingMethod, cString("greedy_search"), true)
  view.setInt32(CONFIG_OFFSETS.maxActivePaths, MAX_ACTIVE_PATHS, true)
  return config
}

const decode = (recognizer: Pointer, samples: Float32Array, sampleRate: number): string => {
  const stream = sherpa.SherpaOnnxCreateOfflineStream(recognizer)
  if (stream === null) throw new Error("sherpa-onnx could not create a stream.")
  try {
    sherpa.SherpaOnnxAcceptWaveformOffline(stream, sampleRate, ptr(samples), samples.length)
    sherpa.SherpaOnnxDecodeOfflineStream(recognizer, stream)
    const json = sherpa.SherpaOnnxGetOfflineStreamResultAsJson(stream)
    if (json === null) throw new Error("sherpa-onnx returned no result.")
    try {
      const result = JSON.parse(new CString(json).toString()) as { readonly text?: unknown }
      return typeof result.text === "string" ? result.text.trim() : ""
    } finally {
      sherpa.SherpaOnnxDestroyOfflineStreamResultJson(json)
    }
  } finally {
    sherpa.SherpaOnnxDestroyOfflineStream(stream)
  }
}

const recognizer = sherpa.SherpaOnnxCreateOfflineRecognizer(recognizerConfig()) as Pointer | null
if (recognizer === null) {
  reply({ type: "failed", message: "sherpa-onnx could not load the speech model." })
  process.exit(1)
}

process.on("message", (request: RecognizerRequest) => {
  try {
    reply({ type: "decoded", id: request.id, text: decode(recognizer, request.samples, request.sampleRate) })
  } catch (error) {
    reply({ type: "decode-failed", id: request.id, message: error instanceof Error ? error.message : String(error) })
  }
})
process.on("disconnect", () => process.exit(0))
reply({ type: "ready" })

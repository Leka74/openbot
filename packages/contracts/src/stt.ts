import { Schema } from "effect"
import { NonNegativeInt } from "./base.ts"

export const SttStatus = Schema.Struct({
  state: Schema.Literals(["unsupported", "absent", "installing", "ready", "failed"]),
  model: Schema.String,
  downloadBytes: Schema.optionalKey(NonNegativeInt),
  downloadedBytes: Schema.optionalKey(NonNegativeInt),
  problem: Schema.optionalKey(Schema.String),
})
export type SttStatus = typeof SttStatus.Type

export const MAX_DICTATION_SECONDS = 600
export const DICTATION_SAMPLE_RATE = 16_000
const PCM16_BYTES_PER_SAMPLE = 2
const MAX_DICTATION_CHUNK_SECONDS = 60
export const MAX_DICTATION_CHUNK_BYTES = MAX_DICTATION_CHUNK_SECONDS * DICTATION_SAMPLE_RATE * PCM16_BYTES_PER_SAMPLE

export const SttSession = Schema.Struct({ sessionId: Schema.String })
export type SttSession = typeof SttSession.Type

export const SttTranscription = Schema.Struct({ text: Schema.String })
export type SttTranscription = typeof SttTranscription.Type

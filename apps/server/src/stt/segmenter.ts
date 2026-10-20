const FRAME_SECONDS = 0.03
const PAUSE_SECONDS = 0.5
const MIN_SEGMENT_SECONDS = 0.5
const MAX_SEGMENT_SECONDS = 12
const FORCED_SPLIT_SEARCH_SECONDS = 4
const KEEP_BEFORE_SPEECH_SECONDS = 0.3
const MIN_DECODABLE_SECONDS = 0.3
const MIN_SPEECH_LEVEL = 0.01
const MAX_SPEECH_LEVEL = 0.04
const NOISE_FLOOR_MULTIPLIER = 3
const NOISE_FLOOR_PERCENTILE = 0.1
const MIN_FRAMES_FOR_NOISE_FLOOR = 10

const frameLength = (sampleRate: number): number => Math.round(sampleRate * FRAME_SECONDS)

export const frameLevels = (samples: Float32Array, sampleRate: number): Array<number> => {
  const length = frameLength(sampleRate)
  const levels: Array<number> = []
  for (let start = 0; start + length <= samples.length; start += length) {
    let sumOfSquares = 0
    for (let index = start; index < start + length; index++) sumOfSquares += samples[index]! * samples[index]!
    levels.push(Math.sqrt(sumOfSquares / length))
  }
  return levels
}

export const speechThreshold = (levelHistory: ReadonlyArray<number>): number => {
  if (levelHistory.length < MIN_FRAMES_FOR_NOISE_FLOOR) return MIN_SPEECH_LEVEL
  const sorted = Float64Array.from(levelHistory).sort()
  const noiseFloor = sorted[Math.floor((sorted.length - 1) * NOISE_FLOOR_PERCENTILE)]!
  return Math.min(MAX_SPEECH_LEVEL, Math.max(MIN_SPEECH_LEVEL, noiseFloor * NOISE_FLOOR_MULTIPLIER))
}

export const containsSpeech = (samples: Float32Array, sampleRate: number, threshold: number): boolean =>
  samples.length >= sampleRate * MIN_DECODABLE_SECONDS && frameLevels(samples, sampleRate).some((level) => level >= threshold)

export const leadingSilenceToDrop = (samples: Float32Array, sampleRate: number, threshold: number): number => {
  const levels = frameLevels(samples, sampleRate)
  const firstSpeechFrame = levels.findIndex((level) => level >= threshold)
  const silentFrames = firstSpeechFrame === -1 ? levels.length : firstSpeechFrame
  return Math.max(0, silentFrames * frameLength(sampleRate) - Math.round(sampleRate * KEEP_BEFORE_SPEECH_SECONDS))
}

const quietestFrame = (levels: ReadonlyArray<number>, from: number, to: number): number => {
  let quietest = from
  for (let frame = from; frame < to; frame++) if (levels[frame]! < levels[quietest]!) quietest = frame
  return quietest
}

export const findSegmentEnd = (samples: Float32Array, sampleRate: number, threshold: number): number | undefined => {
  const levels = frameLevels(samples, sampleRate)
  const pauseFrames = Math.round(PAUSE_SECONDS / FRAME_SECONDS)
  const minSegmentFrames = Math.round(MIN_SEGMENT_SECONDS / FRAME_SECONDS)
  const maxSegmentFrames = Math.round(MAX_SEGMENT_SECONDS / FRAME_SECONDS)
  let heardSpeech = false
  let quietRun = 0
  for (let frame = 0; frame < Math.min(levels.length, maxSegmentFrames); frame++) {
    if (levels[frame]! >= threshold) {
      heardSpeech = true
      quietRun = 0
      continue
    }
    quietRun++
    const pauseMiddle = frame - Math.floor(pauseFrames / 2)
    if (heardSpeech && quietRun === pauseFrames && pauseMiddle >= minSegmentFrames) return pauseMiddle * frameLength(sampleRate)
  }
  if (levels.length < maxSegmentFrames) return undefined
  const searchFrom = maxSegmentFrames - Math.round(FORCED_SPLIT_SEARCH_SECONDS / FRAME_SECONDS)
  return quietestFrame(levels, searchFrom, maxSegmentFrames) * frameLength(sampleRate)
}

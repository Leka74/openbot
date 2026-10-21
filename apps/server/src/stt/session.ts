import { containsSpeech, findSegmentEnd, frameLevels, leadingSilenceToDrop, speechThreshold } from "./segmenter.ts"

type Decode = (samples: Float32Array) => Promise<string>

const CATCH_UP_CHUNK_SECONDS = 1

const concatSamples = (first: Float32Array, second: Float32Array): Float32Array => {
  const joined = new Float32Array(first.length + second.length)
  joined.set(first, 0)
  joined.set(second, first.length)
  return joined
}

const joinTranscript = (parts: ReadonlyArray<string>): string => parts.filter((part) => part.length > 0).join(" ")

export class DictationSession {
  private readonly committed: Array<string> = []
  private readonly levelHistory: Array<number> = []
  private pending: Float32Array = new Float32Array(0)
  private lastPartial = ""
  private receivedSamples = 0

  constructor(
    private readonly decode: Decode,
    private readonly sampleRate: number,
  ) {}

  get receivedSeconds(): number {
    return this.receivedSamples / this.sampleRate
  }

  get pendingSeconds(): number {
    return this.pending.length / this.sampleRate
  }

  async append(samples: Float32Array): Promise<string> {
    const threshold = this.take(samples)
    if (this.fallingBehind(samples)) {
      if (await this.commitFinishedSegments(threshold)) this.lastPartial = ""
      return joinTranscript([...this.committed, this.lastPartial])
    }
    await this.commitNextSegment(threshold)
    this.lastPartial = await this.decodePending(threshold)
    return joinTranscript([...this.committed, this.lastPartial])
  }

  async finish(samples: Float32Array): Promise<string> {
    const threshold = this.take(samples)
    await this.commitFinishedSegments(threshold)
    return joinTranscript([...this.committed, await this.decodePending(threshold)])
  }

  private take(samples: Float32Array): number {
    this.receivedSamples += samples.length
    this.levelHistory.push(...frameLevels(samples, this.sampleRate))
    this.pending = concatSamples(this.pending, samples)
    return speechThreshold(this.levelHistory)
  }

  private fallingBehind(samples: Float32Array): boolean {
    return samples.length > this.sampleRate * CATCH_UP_CHUNK_SECONDS
  }

  private async commitNextSegment(threshold: number): Promise<boolean> {
    const segmentEnd = findSegmentEnd(this.pending, this.sampleRate, threshold)
    if (segmentEnd !== undefined) {
      const segment = this.pending.subarray(0, segmentEnd)
      if (containsSpeech(segment, this.sampleRate, threshold)) this.committed.push(await this.decode(segment))
      this.pending = this.pending.slice(segmentEnd)
    }
    this.pending = this.pending.slice(leadingSilenceToDrop(this.pending, this.sampleRate, threshold))
    return segmentEnd !== undefined
  }

  private async commitFinishedSegments(threshold: number): Promise<boolean> {
    let committedAny = false
    while (await this.commitNextSegment(threshold)) committedAny = true
    return committedAny
  }

  private async decodePending(threshold: number): Promise<string> {
    return containsSpeech(this.pending, this.sampleRate, threshold) ? await this.decode(this.pending) : ""
  }
}

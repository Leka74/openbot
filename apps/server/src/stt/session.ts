import { containsSpeech, findSegmentEnd, frameLevels, leadingSilenceToDrop, speechThreshold } from "./segmenter.ts"

export type Decode = (samples: Float32Array) => Promise<string>

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
  private receivedSamples = 0

  constructor(
    private readonly decode: Decode,
    private readonly sampleRate: number,
  ) {}

  get receivedSeconds(): number {
    return this.receivedSamples / this.sampleRate
  }

  async append(samples: Float32Array): Promise<string> {
    this.take(samples)
    await this.commitFinishedSegment()
    return joinTranscript([...this.committed, await this.decodePending()])
  }

  private take(samples: Float32Array) {
    this.receivedSamples += samples.length
    this.levelHistory.push(...frameLevels(samples, this.sampleRate))
    this.pending = concatSamples(this.pending, samples)
  }

  private threshold(): number {
    return speechThreshold(this.levelHistory)
  }

  private async commitFinishedSegment() {
    const threshold = this.threshold()
    const segmentEnd = findSegmentEnd(this.pending, this.sampleRate, threshold)
    if (segmentEnd !== undefined) {
      const segment = this.pending.subarray(0, segmentEnd)
      if (containsSpeech(segment, this.sampleRate, threshold)) this.committed.push(await this.decode(segment))
      this.pending = this.pending.slice(segmentEnd)
    }
    this.pending = this.pending.slice(leadingSilenceToDrop(this.pending, this.sampleRate, threshold))
  }

  private async decodePending(): Promise<string> {
    return containsSpeech(this.pending, this.sampleRate, this.threshold()) ? await this.decode(this.pending) : ""
  }
}

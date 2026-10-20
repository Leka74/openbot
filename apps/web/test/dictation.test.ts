import { describe, expect, test } from "bun:test"
import { DICTATION_TAP_MODULE, tapMessageHandler } from "../src/chat/dictation.ts"
import { formatElapsed } from "../src/chat/useDictation.ts"

const RENDER_QUANTUM = 128

interface TapPort {
  readonly posted: Array<unknown>
  onmessage: ((event: { readonly data: unknown }) => void) | null
  postMessage: (message: unknown) => void
}

interface Tap {
  readonly port: TapPort
  readonly process: (inputs: ReadonlyArray<ReadonlyArray<Float32Array>>) => boolean
}

const loadTap = (): Tap => {
  let Processor: (new () => Tap) | undefined
  class AudioWorkletProcessor {
    readonly port: TapPort = {
      posted: [],
      onmessage: null,
      postMessage(message) {
        this.posted.push(message)
      },
    }
  }
  new Function("registerProcessor", "AudioWorkletProcessor", DICTATION_TAP_MODULE)((_: string, registered: new () => Tap) => {
    Processor = registered
  }, AudioWorkletProcessor)
  return new Processor!()
}

const quantum = (value: number) => new Float32Array(RENDER_QUANTUM).fill(value)

describe("the microphone tap", () => {
  test("posts full buffers as they fill and the partial one when flushed", () => {
    const tap = loadTap()
    for (let index = 0; index < 32; index++) tap.process([[quantum(0.1)]])
    expect(tap.port.posted).toHaveLength(1)
    expect((tap.port.posted[0] as Float32Array).length).toBe(4096)
    for (let index = 0; index < 3; index++) tap.process([[quantum(0.2)]])
    tap.port.onmessage?.({ data: "flush" })
    const [, tail, flushed] = tap.port.posted
    expect(tail).toBeInstanceOf(Float32Array)
    expect((tail as Float32Array).length).toBe(3 * RENDER_QUANTUM)
    expect((tail as Float32Array)[0]).toBeCloseTo(0.2)
    expect(flushed).toBe("flushed")
  })

  test("a flush with nothing buffered only confirms it", () => {
    const tap = loadTap()
    tap.port.onmessage?.({ data: "flush" })
    expect(tap.port.posted).toEqual(["flushed"])
  })

  test("the page passes audio on and treats the flush confirmation as a signal, never as audio", () => {
    const received: Array<Float32Array> = []
    let flushed = 0
    const handle = tapMessageHandler((samples) => received.push(samples), () => flushed++)
    handle({ data: quantum(0.3) } as MessageEvent<Float32Array>)
    handle({ data: "flushed" } as MessageEvent<string>)
    handle({ data: "something else" } as MessageEvent<string>)
    expect(received).toHaveLength(1)
    expect(flushed).toBe(1)
  })
})

describe("dictation timer", () => {
  test("formats the recording time as m:ss", () => {
    expect(formatElapsed(0)).toBe("0:00")
    expect(formatElapsed(75)).toBe("1:15")
  })
})

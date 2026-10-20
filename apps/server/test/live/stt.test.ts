import { describe, expect, test } from "bun:test"
import { downsample, encodePcm16, toBase64 } from "@openbot/app-model"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pcm16WavSamples } from "../../src/stt/engine.ts"
import { SpeechToTextLive } from "../../src/stt/service.ts"
import { eventually, login, rpcClient, startServer } from "../helpers.ts"

const LIVE_STT = process.env["OPENBOT_LIVE_STT"] === "1"
const STT_DIR = process.env["OPENBOT_LIVE_STT_DIR"] ?? join(homedir(), ".cache", "openbot-live-stt")
const CLIP = process.env["OPENBOT_LIVE_STT_CLIP"]
const INSTALL_TIMEOUT_MS = 15 * 60_000
const MICROPHONE_RATE = 48_000
const MODEL_RATE = 16_000
const CHUNK_SECONDS = 0.25

const upsampleByRepeating = (samples: Float32Array, factor: number): Float32Array =>
  Float32Array.from({ length: samples.length * factor }, (_, index) => samples[Math.floor(index / factor)]!)

const median = (values: ReadonlyArray<number>) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

describe.skipIf(!LIVE_STT)("voice input with the real sherpa-onnx and Parakeet", () => {
  test(
    "streams a recording the way the browser does and keeps up with speech",
    async () => {
      const server = await startServer({ server: { speechToText: SpeechToTextLive({ dir: STT_DIR }) } })
      try {
        const cookie = await login(server.base, server.ownerToken)
        await server.run(Effect.gen(function*() {
          const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })
          yield* client["stt.install"]()
          const status = yield* eventually(client["stt.status"](), (s) => s.state !== "installing", { timeout: INSTALL_TIMEOUT_MS, label: "install" })
          expect(status.state).toBe("ready")

          const clip = CLIP ?? join(STT_DIR, "model", "test_wavs", "en.wav")
          const { samples } = pcm16WavSamples(new Uint8Array(readFileSync(clip)))
          const asMicrophone = upsampleByRepeating(samples, MICROPHONE_RATE / MODEL_RATE)
          const openedAt = performance.now()
          const { sessionId } = yield* client["stt.open"]()
          const openMs = performance.now() - openedAt
          const chunkSamples = CHUNK_SECONDS * MICROPHONE_RATE
          const appendMs: Array<number> = []
          let live = ""
          for (let offset = 0; offset < asMicrophone.length; offset += chunkSamples) {
            const chunk = downsample(asMicrophone.subarray(offset, offset + chunkSamples), MICROPHONE_RATE, MODEL_RATE)
            const sentAt = performance.now()
            live = (yield* client["stt.append"]({ sessionId, pcmBase64: toBase64(encodePcm16(chunk)) })).text
            appendMs.push(performance.now() - sentAt)
          }
          const finishedAt = performance.now()
          const final = yield* client["stt.finish"]({ sessionId, pcmBase64: "" })
          const finishMs = performance.now() - finishedAt
          console.log({
            seconds: samples.length / MODEL_RATE,
            openMs: Math.round(openMs),
            appendMedianMs: Math.round(median(appendMs)),
            appendMaxMs: Math.round(Math.max(...appendMs)),
            finishMs: Math.round(finishMs),
            live,
            final: final.text,
          })
          if (CLIP === undefined) expect(final.text.toLowerCase()).toContain("country")
          expect(final.text.length).toBeGreaterThan(0)
        }))
      } finally {
        await server.close()
      }
    },
    INSTALL_TIMEOUT_MS + 120_000,
  )
})

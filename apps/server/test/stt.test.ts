import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { MAX_DICTATION_CHUNK_BYTES, type SttStatus } from "@openbot/contracts"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DictationSession } from "../src/stt/session.ts"
import { containsSpeech, findSegmentEnd, leadingSilenceToDrop, speechThreshold } from "../src/stt/segmenter.ts"
import { parseRecognizerOutput, type SttArchive, type SttManifest, sttPlatformOf, SpeechToTextLive } from "../src/index.ts"
import { eventually, login, rpcClient, startServer } from "./helpers.ts"

const RATE = 16_000
const SPEECH_LEVEL = 0.3
const CRASH_LEVEL = 0.95

const fakeRecognizer = () => `#!${process.execPath}
const port = Number(process.argv.find((arg) => arg.startsWith("--port=")).slice("--port=".length))
Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: (request, server) => (server.upgrade(request) ? undefined : new Response("websocket only", { status: 400 })),
  websocket: {
    message(socket, message) {
      if (typeof message === "string") return
      const view = new DataView(message.buffer, message.byteOffset, message.byteLength)
      const samples = new Float32Array(message.buffer.slice(message.byteOffset + 8, message.byteOffset + 8 + view.getInt32(4, true)))
      if (samples.some((sample) => Math.abs(sample) > ${(SPEECH_LEVEL + CRASH_LEVEL) / 2})) process.exit(7)
      socket.send(JSON.stringify({ lang: "", text: " country " }))
    },
  },
})
`

const tone = (seconds: number, level = SPEECH_LEVEL) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => level * Math.sin(i / 3))
const silence = (seconds: number) => new Float32Array(Math.round(seconds * RATE))
const join32 = (...parts: ReadonlyArray<Float32Array>) => {
  const joined = new Float32Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return joined
}
const chunked = (samples: Float32Array, seconds: number) => {
  const size = Math.round(seconds * RATE)
  return Array.from({ length: Math.ceil(samples.length / size) }, (_, i) => samples.subarray(i * size, (i + 1) * size))
}
const pcm16Base64 = (samples: Float32Array) => {
  const view = new DataView(new ArrayBuffer(samples.length * 2))
  samples.forEach((sample, i) => view.setInt16(i * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true))
  return Buffer.from(view.buffer).toString("base64")
}
const wavBytes = (samples: Float32Array) => {
  const data = Buffer.from(pcm16Base64(samples), "base64")
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write("WAVEfmt ", 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(RATE, 24)
  header.writeUInt32LE(RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}
const occurrences = (text: string, word: string) => text.split(word).length - 1

interface Fixtures {
  readonly runtime: SttArchive
  readonly model: SttArchive
  readonly stop: () => void
}

const packFolder = (root: string, folder: string) => {
  const file = join(root, `${folder}.tar.bz2`)
  const packed = Bun.spawnSync(["tar", "-cjf", file, "-C", root, folder])
  if (packed.exitCode !== 0) throw new Error(packed.stderr.toString())
  const contents = readFileSync(file)
  return { sha256: createHash("sha256").update(contents).digest("hex"), bytes: contents.byteLength }
}

const makeFixtures = (): Fixtures => {
  const root = mkdtempSync(join(tmpdir(), "openbot-stt-fixtures-"))
  const recognizer = join(root, "fake-runtime", "bin", "sherpa-onnx-offline-websocket-server")
  mkdirSync(join(root, "fake-runtime", "bin"), { recursive: true })
  writeFileSync(recognizer, fakeRecognizer())
  chmodSync(recognizer, 0o755)
  mkdirSync(join(root, "fake-model", "test_wavs"), { recursive: true })
  for (const name of ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]) writeFileSync(join(root, "fake-model", name), name)
  writeFileSync(join(root, "fake-model", "test_wavs", "en.wav"), wavBytes(tone(1)))
  const runtime = packFolder(root, "fake-runtime")
  const model = packFolder(root, "fake-model")
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => new Response(Bun.file(join(root, new URL(request.url).pathname.slice(1)))),
  })
  const origin = `http://127.0.0.1:${server.port}`
  return {
    runtime: { url: `${origin}/fake-runtime.tar.bz2`, ...runtime },
    model: { url: `${origin}/fake-model.tar.bz2`, ...model },
    stop: () => {
      void server.stop(true)
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const manifestFor = (fixtures: Fixtures, runtime: SttArchive | null = fixtures.runtime): SttManifest => {
  const platform = sttPlatformOf(process.platform, process.arch)
  return {
    runtimes: platform === undefined || runtime === null ? {} : { [platform]: runtime },
    model: {
      label: "Fake Parakeet",
      archive: fixtures.model,
      modelType: "nemo_transducer",
      encoder: "encoder.int8.onnx",
      decoder: "decoder.int8.onnx",
      joiner: "joiner.int8.onnx",
      tokens: "tokens.txt",
      sampleWav: "test_wavs/en.wav",
      sampleExpectedWord: "country",
    },
  }
}

const startWithManifest = (manifest: SttManifest, dataDir = mkdtempSync(join(tmpdir(), "openbot-server-test-")), recognizerIdleMs?: number) =>
  startServer({ dataDir, server: { speechToText: SpeechToTextLive({ dir: join(dataDir, "stt"), manifest, recognizerIdleMs }) } })

const recognizersRunningUnder = (dataDir: string) =>
  Bun.spawnSync(["pgrep", "-f", join(dataDir, "stt", "runtime")]).stdout.toString().trim().split("\n").filter((line) => line.length > 0).length

const settled = (status: SttStatus) => status.state !== "installing"

let fixtures: Fixtures
beforeAll(() => {
  fixtures = makeFixtures()
})
afterAll(() => fixtures.stop())

describe("segmenting speech at pauses", () => {
  test("the speech threshold follows the noise floor within fixed bounds", () => {
    expect(speechThreshold([])).toBe(0.01)
    expect(speechThreshold(Array(50).fill(0.002))).toBe(0.01)
    expect(speechThreshold(Array(50).fill(0.008))).toBeCloseTo(0.024)
    expect(speechThreshold(Array(50).fill(0.5))).toBe(0.04)
  })

  test("ends a segment in the middle of a pause after speech", () => {
    const end = findSegmentEnd(join32(tone(1), silence(0.7), tone(1)), RATE, 0.01)
    expect(end).toBeGreaterThan(1 * RATE)
    expect(end).toBeLessThan(1.7 * RATE)
  })

  test("ends a segment at a trailing pause, so a finished sentence is committed while you wait", () => {
    const end = findSegmentEnd(join32(tone(1), silence(0.6)), RATE, 0.01)
    expect(end).toBeGreaterThan(1 * RATE)
  })

  test("keeps going while speech has no pause, and splits long speech at its quietest point", () => {
    expect(findSegmentEnd(join32(tone(1), silence(0.3), tone(1)), RATE, 0.01)).toBeUndefined()
    expect(findSegmentEnd(tone(5), RATE, 0.01)).toBeUndefined()
    const long = join32(tone(9), tone(0.3, 0.02), tone(4))
    const end = findSegmentEnd(long, RATE, 0.01)!
    expect(end).toBeGreaterThanOrEqual(8 * RATE)
    expect(end).toBeLessThanOrEqual(12 * RATE)
  })

  test("drops leading silence but keeps a little before speech", () => {
    const dropped = leadingSilenceToDrop(join32(silence(2), tone(1)), RATE, 0.01)
    expect(dropped).toBeGreaterThan(1.6 * RATE)
    expect(dropped).toBeLessThanOrEqual(1.7 * RATE)
    expect(leadingSilenceToDrop(tone(1), RATE, 0.01)).toBe(0)
    expect(containsSpeech(silence(2), RATE, 0.01)).toBe(false)
    expect(containsSpeech(tone(0.1), RATE, 0.01)).toBe(false)
  })
})

describe("a dictation session", () => {
  test("decodes each finished sentence once and only re-decodes the one in progress", async () => {
    const decoded: Array<number> = []
    const session = new DictationSession(async (samples) => {
      decoded.push(Math.round((samples.length / RATE) * 10) / 10)
      return `part${decoded.length}`
    }, RATE)
    let text = ""
    for (const chunk of chunked(join32(silence(0.5), tone(1.2), silence(0.8), tone(1)), 0.25)) text = await session.append(chunk)
    const [firstSentence, secondSentence] = text.split(" ")
    expect(secondSentence).toBeDefined()
    const commitIndex = Number(firstSentence!.slice("part".length)) - 1
    expect(decoded[commitIndex]).toBeGreaterThanOrEqual(1.2)
    expect(decoded.slice(commitIndex + 1).every((seconds) => seconds < 1.5)).toBe(true)
    expect(session.receivedSeconds).toBeCloseTo(3.5)
  })

  test("returns nothing for silence without calling the recognizer", async () => {
    let calls = 0
    const session = new DictationSession(async () => {
      calls++
      return "never"
    }, RATE)
    expect(await session.append(silence(3))).toBe("")
    expect(calls).toBe(0)
  })
})

describe("recognizer output", () => {
  test("takes the text of the last JSON line, trimmed", () => {
    expect(parseRecognizerOutput('noise\n{"text": " hello there "}\n')).toBe("hello there")
    expect(parseRecognizerOutput("no result")).toBeUndefined()
    expect(parseRecognizerOutput('{"text": 3}')).toBeUndefined()
  })

  test("maps OS and CPU to a runtime build", () => {
    expect(sttPlatformOf("darwin", "arm64")).toBe("darwin-arm64")
    expect(sttPlatformOf("linux", "arm64")).toBe("linux-arm64")
    expect(sttPlatformOf("win32", "x64")).toBeUndefined()
  })
})

describe("voice input over RPC", () => {
  test(
    "installs, dictates live, recovers from a recognizer crash, survives a restart and is removed",
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "openbot-server-test-"))
      const first = await startWithManifest(manifestFor(fixtures), dataDir)
      try {
        const cookie = await login(first.base, first.ownerToken)
        await first.run(Effect.gen(function*() {
          const client = yield* rpcClient(`${first.wsBase}/rpc`, { cookie, origin: first.base })
          expect(yield* client["stt.status"]()).toEqual({ state: "absent", model: "Fake Parakeet", downloadBytes: fixtures.runtime.bytes + fixtures.model.bytes })
          expect((yield* Effect.flip(client["stt.open"]()))._tag).toBe("Unavailable")

          const started = yield* client["stt.install"]()
          expect(started.state).toBe("installing")
          expect(yield* eventually(client["stt.status"](), settled, { label: "install" })).toEqual({ state: "ready", model: "Fake Parakeet" })

          const { sessionId } = yield* client["stt.open"]()
          const live: Array<string> = []
          const speech = join32(tone(1.2), silence(0.8), tone(1))
          for (const chunk of chunked(speech, 0.25)) live.push((yield* client["stt.append"]({ sessionId, pcmBase64: pcm16Base64(chunk) })).text)
          expect(live.some((text) => occurrences(text, "country") === 1)).toBe(true)
          const final = yield* client["stt.finish"]({ sessionId, pcmBase64: pcm16Base64(silence(0.1)) })
          expect(occurrences(final.text, "country")).toBe(2)
          expect((yield* Effect.flip(client["stt.append"]({ sessionId, pcmBase64: "" })))._tag).toBe("NotFound")

          const other = yield* client["stt.open"]()
          const tooLarge = "A".repeat(Math.ceil((MAX_DICTATION_CHUNK_BYTES * 4) / 3) + 100)
          expect((yield* Effect.flip(client["stt.append"]({ sessionId: other.sessionId, pcmBase64: tooLarge })))._tag).toBe("InvalidInput")
          expect((yield* Effect.flip(client["stt.append"]({ sessionId: other.sessionId, pcmBase64: "%%%" })))._tag).toBe("InvalidInput")
          const crashed = yield* Effect.flip(client["stt.append"]({ sessionId: other.sessionId, pcmBase64: pcm16Base64(tone(1, CRASH_LEVEL)) }))
          expect(crashed).toMatchObject({ _tag: "Unavailable", message: expect.stringContaining("log") })
          yield* client["stt.discard"]({ sessionId: other.sessionId })

          const afterCrash = yield* client["stt.open"]()
          const recovered = yield* client["stt.finish"]({ sessionId: afterCrash.sessionId, pcmBase64: pcm16Base64(tone(1)) })
          expect(recovered.text).toBe("country")
          expect(recognizersRunningUnder(dataDir)).toBe(1)
        }))
      } finally {
        await first.close({ keepData: true })
      }
      expect(recognizersRunningUnder(dataDir)).toBe(0)

      const second = await startWithManifest(manifestFor(fixtures), dataDir)
      try {
        const cookie = await login(second.base, second.ownerToken)
        await second.run(Effect.gen(function*() {
          const client = yield* rpcClient(`${second.wsBase}/rpc`, { cookie, origin: second.base })
          expect((yield* client["stt.status"]()).state).toBe("ready")
          yield* client["stt.open"]()
          expect(yield* client["stt.remove"]()).toMatchObject({ state: "absent", model: "Fake Parakeet" })
          expect(recognizersRunningUnder(dataDir)).toBe(0)
          expect((yield* Effect.flip(client["stt.open"]()))._tag).toBe("Unavailable")
        }))
      } finally {
        await second.close()
      }
    },
    30_000,
  )

  test("the recognizer stops after sitting idle and starts again on the next dictation", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openbot-server-test-"))
    const server = await startWithManifest(manifestFor(fixtures), dataDir, 300)
    try {
      const cookie = await login(server.base, server.ownerToken)
      await server.run(Effect.gen(function*() {
        const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })
        yield* client["stt.install"]()
        yield* eventually(client["stt.status"](), settled, { label: "install" })
        const { sessionId } = yield* client["stt.open"]()
        yield* client["stt.finish"]({ sessionId, pcmBase64: pcm16Base64(tone(1)) })
        expect(recognizersRunningUnder(dataDir)).toBe(1)
        yield* eventually(Effect.sync(() => recognizersRunningUnder(dataDir)), (running) => running === 0, { label: "idle stop" })
        const again = yield* client["stt.open"]()
        expect((yield* client["stt.finish"]({ sessionId: again.sessionId, pcmBase64: pcm16Base64(tone(1)) })).text).toBe("country")
      }))
    } finally {
      await server.close()
    }
  }, 30_000)

  test("a download that does not match its pinned checksum fails the install", async () => {
    const server = await startWithManifest(manifestFor(fixtures, { ...fixtures.runtime, sha256: "0".repeat(64) }))
    try {
      const cookie = await login(server.base, server.ownerToken)
      await server.run(Effect.gen(function*() {
        const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })
        yield* client["stt.install"]()
        expect(yield* eventually(client["stt.status"](), settled, { label: "install" })).toMatchObject({ state: "failed", problem: expect.stringContaining("checksum") })
      }))
    } finally {
      await server.close()
    }
  })

  test("a brain without a runtime build reports unsupported and installs nothing", async () => {
    const server = await startWithManifest(manifestFor(fixtures, null))
    try {
      const cookie = await login(server.base, server.ownerToken)
      await server.run(Effect.gen(function*() {
        const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })
        expect(yield* client["stt.install"]()).toEqual({ state: "unsupported", model: "Fake Parakeet" })
      }))
    } finally {
      await server.close()
    }
  })
})

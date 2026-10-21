import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { encodePcm16, joinChunks, toBase64 } from "@openbot/app-model"
import { MAX_DICTATION_SECONDS, type SttStatus } from "@openbot/contracts"
import { ProcessLedger } from "@openbot/core"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { RECOGNIZER_PROCESS_ENTRY, startRecognizer, sttLayout } from "../src/stt/engine.ts"
import { type SttArchive, type SttManifest, sttPlatformOf } from "../src/stt/manifest.ts"
import { containsSpeech, findSegmentEnd, leadingSilenceToDrop, speechThreshold } from "../src/stt/segmenter.ts"
import { SpeechToText, SpeechToTextLive, type SpeechToTextOptions } from "../src/stt/service.ts"
import { DictationSession } from "../src/stt/session.ts"
import { eventually, login, type OpenBotClient, rpcClient, startServer, type TestServer } from "./helpers.ts"

const RATE = 16_000
const SPEECH_LEVEL = 0.3
const DECODE_FAIL_LEVEL = 0.5
const HANG_LEVEL = 0.7
const CRASH_LEVEL = 0.95
const FAKE_RECOGNIZER = fileURLToPath(new URL("./fixtures/fake-recognizer.ts", import.meta.url))

const tone = (seconds: number, level = SPEECH_LEVEL) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => level * Math.sin(i / 3))
const silence = (seconds: number) => new Float32Array(Math.round(seconds * RATE))
const chunked = (samples: Float32Array, seconds: number) => {
  const size = Math.round(seconds * RATE)
  return Array.from({ length: Math.ceil(samples.length / size) }, (_, i) => samples.subarray(i * size, (i + 1) * size))
}
const pcm = (samples: Float32Array) => toBase64(encodePcm16(samples))
const wavBytes = (samples: Float32Array) => {
  const data = encodePcm16(samples)
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
  runtime: SttArchive
  model: SttArchive
  misheardModel: SttArchive
  twoFolderRuntime: SttArchive
  endlessRuntime: SttArchive
  failNextDownload: boolean
  holdDownloads: Promise<void> | undefined
  stop: () => void
}

const archive = (root: string, origin: string, file: string, ...folders: ReadonlyArray<string>): SttArchive => {
  const packed = Bun.spawnSync(["tar", "-cjf", join(root, file), "-C", root, ...folders])
  if (packed.exitCode !== 0) throw new Error(packed.stderr.toString())
  const contents = readFileSync(join(root, file))
  return { url: `${origin}/${file}`, sha256: createHash("sha256").update(contents).digest("hex"), bytes: contents.byteLength }
}

const writeModel = (root: string, folder: string, misheard?: string) => {
  mkdirSync(join(root, folder, "test_wavs"), { recursive: true })
  for (const name of ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]) writeFileSync(join(root, folder, name), name)
  writeFileSync(join(root, folder, "test_wavs", "en.wav"), wavBytes(tone(1)))
  if (misheard !== undefined) writeFileSync(join(root, folder, "misheard.txt"), misheard)
}

const makeFixtures = (): Fixtures => {
  const root = mkdtempSync(join(tmpdir(), "openbot-stt-fixtures-"))
  for (const folder of ["fake-runtime", "other-runtime"]) {
    mkdirSync(join(root, folder, "lib"), { recursive: true })
    writeFileSync(join(root, folder, "lib", "placeholder"), folder)
  }
  writeModel(root, "fake-model")
  writeModel(root, "misheard-model", "hello")
  const fixtures = { failNextDownload: false, holdDownloads: undefined } as Fixtures
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      await fixtures.holdDownloads
      if (fixtures.failNextDownload) {
        fixtures.failNextDownload = false
        return new Response("try later", { status: 503 })
      }
      if (new URL(request.url).pathname === "/endless.tar.bz2") {
        return new Response(new ReadableStream({ pull: (controller) => controller.enqueue(new Uint8Array(64 * 1024)) }))
      }
      return new Response(Bun.file(join(root, new URL(request.url).pathname.slice(1))))
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  fixtures.runtime = archive(root, origin, "fake-runtime.tar.bz2", "fake-runtime")
  fixtures.model = archive(root, origin, "fake-model.tar.bz2", "fake-model")
  fixtures.misheardModel = archive(root, origin, "misheard-model.tar.bz2", "misheard-model")
  fixtures.twoFolderRuntime = archive(root, origin, "two-folders.tar.bz2", "fake-runtime", "other-runtime")
  fixtures.endlessRuntime = { url: `${origin}/endless.tar.bz2`, sha256: "0".repeat(64), bytes: 1_000_000 }
  fixtures.stop = () => {
    void server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
  return fixtures
}

const manifestFor = (fixtures: Fixtures, parts?: { readonly runtime?: SttArchive | null; readonly model?: SttArchive }): SttManifest => {
  const platform = sttPlatformOf(process.platform, process.arch)
  const runtime = parts?.runtime === undefined ? fixtures.runtime : parts.runtime
  return {
    runtimes: platform === undefined || runtime === null ? {} : { [platform]: runtime },
    model: {
      label: "Fake Parakeet",
      archive: parts?.model ?? fixtures.model,
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

const startWithManifest = (manifest: SttManifest, extra?: Partial<SpeechToTextOptions> & { readonly dataDir?: string }) => {
  const dataDir = extra?.dataDir ?? mkdtempSync(join(tmpdir(), "openbot-server-test-"))
  return startServer({
    dataDir,
    server: { speechToText: SpeechToTextLive({ dir: join(dataDir, "stt"), manifest, recognizerEntry: FAKE_RECOGNIZER, ...extra }) },
  })
}

const recognizersRunningUnder = (dataDir: string) =>
  Bun.spawnSync(["pgrep", "-f", join(dataDir, "stt", "model")]).stdout.toString().trim().split("\n").filter((line) => line.length > 0).length

const settled = (status: SttStatus) => status.state !== "installing"

const modelMarker = (dataDir: string, name: string) => join(dataDir, "stt", "model", name)
const setModelMarker = (dataDir: string, name: string, present: boolean) =>
  present ? writeFileSync(modelMarker(dataDir, name), "") : rmSync(modelMarker(dataDir, name), { force: true })

const recognizerPids = async (server: TestServer) => (await recognizerLedgerEntries(server)).map((entry) => entry.pid)

const withClient = async <A>(server: TestServer, body: (client: OpenBotClient) => Effect.Effect<A, unknown>) => {
  const cookie = await login(server.base, server.ownerToken)
  return server.run(Effect.flatMap(rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base }), body))
}

const installed = (client: OpenBotClient) => client["stt.install"]().pipe(Effect.andThen(eventually(client["stt.status"](), settled, { label: "install" })))

const recognizerLedgerEntries = (server: TestServer) =>
  server.run(
    Effect.gen(function*() {
      const entries = yield* (yield* ProcessLedger).list
      return entries.filter((entry) => entry.label === "speech recognizer")
    }),
  )

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

  test("ends a segment in the middle of the first pause after speech", () => {
    const end = findSegmentEnd(joinChunks([tone(1), silence(0.7), tone(1), silence(0.7), tone(1)]), RATE, 0.01)
    expect(end).toBeGreaterThan(1 * RATE)
    expect(end).toBeLessThan(1.7 * RATE)
  })

  test("ends a segment at a trailing pause, so a finished sentence is committed while you wait", () => {
    expect(findSegmentEnd(joinChunks([tone(1), silence(0.6)]), RATE, 0.01)).toBeGreaterThan(1 * RATE)
  })

  test("keeps going while speech has no pause, and splits long speech at its quietest point", () => {
    expect(findSegmentEnd(joinChunks([tone(1), silence(0.3), tone(1)]), RATE, 0.01)).toBeUndefined()
    expect(findSegmentEnd(tone(5), RATE, 0.01)).toBeUndefined()
    const end = findSegmentEnd(joinChunks([tone(9), tone(0.3, 0.02), tone(4)]), RATE, 0.01)!
    expect(end).toBeGreaterThanOrEqual(8 * RATE)
    expect(end).toBeLessThanOrEqual(12 * RATE)
  })

  test("never returns a segment longer than twelve seconds, even when the pause comes later", () => {
    expect(findSegmentEnd(joinChunks([tone(14), silence(1), tone(1)]), RATE, 0.01)).toBeLessThanOrEqual(12 * RATE)
  })

  test("drops leading silence but keeps a little before speech", () => {
    const dropped = leadingSilenceToDrop(joinChunks([silence(2), tone(1)]), RATE, 0.01)
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
    for (const chunk of chunked(joinChunks([silence(0.5), tone(1.2), silence(0.8), tone(1)]), 0.25)) text = await session.append(chunk)
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

  test("drains a backlog instead of re-decoding it when the recognizer falls behind", async () => {
    const decodedSeconds: Array<number> = []
    const session = new DictationSession(async (samples) => {
      decodedSeconds.push(samples.length / RATE)
      return "s"
    }, RATE)
    const backlog = joinChunks(Array.from({ length: 10 }, () => joinChunks([tone(3), silence(0.7)])))
    const text = await session.append(backlog)
    expect(session.pendingSeconds).toBeLessThan(4)
    expect(decodedSeconds.every((seconds) => seconds <= 12)).toBe(true)
    expect(decodedSeconds.reduce((total, seconds) => total + seconds, 0)).toBeLessThan(backlog.length / RATE)
    expect(occurrences(text, "s")).toBe(decodedSeconds.length)
  })

  test("keeps showing the last partial text while catching up, and drops it once that speech is committed", async () => {
    let decodes = 0
    const session = new DictationSession(async () => `p${++decodes}`, RATE)
    const partial = await session.append(tone(0.5))
    expect(partial).toBe("p1")
    expect(await session.append(tone(1.5))).toBe("p1")
    const committed = await session.append(joinChunks([tone(0.25), silence(1.5)]))
    expect(committed).toBe("p2")
  })

  test("never decodes more than twelve seconds at once, even when speech arrives in small pieces without a pause", async () => {
    const decodedSeconds: Array<number> = []
    const session = new DictationSession(async (samples) => {
      decodedSeconds.push(samples.length / RATE)
      return "s"
    }, RATE)
    for (const chunk of chunked(tone(11.75), 0.25)) await session.append(chunk)
    decodedSeconds.length = 0
    await session.append(tone(0.75))
    expect(decodedSeconds.every((seconds) => seconds <= 12)).toBe(true)
    expect(session.pendingSeconds).toBeLessThan(5)
  })

  test("finish decodes the last piece of speech whatever its length", async () => {
    const session = new DictationSession(async (samples) => `heard ${Math.round(samples.length / RATE)}s`, RATE)
    expect(await session.finish(tone(2))).toBe("heard 2s")
  })
})

describe("the recognizer process", () => {
  test("a recognizer that cannot load its library fails at once and says why", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-stt-broken-"))
    try {
      mkdirSync(join(root, "runtime", "lib"), { recursive: true })
      const startedAt = Date.now()
      const failure = await startRecognizer({
        entry: RECOGNIZER_PROCESS_ENTRY,
        layout: sttLayout(root),
        model: manifestFor(fixtures).model,
        sampleRate: RATE,
        decodeTimeoutMs: 5_000,
        startupTimeoutMs: 30_000,
      }).then(() => undefined, (error: Error) => error.message)
      expect(failure).toContain("exited with code 1")
      expect(failure).toContain("Failed to open library")
      expect(Date.now() - startedAt).toBeLessThan(10_000)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
})

describe("voice input over RPC", () => {
  test("installs, dictates live, survives a restart and is removed", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openbot-server-test-"))
    const first = await startWithManifest(manifestFor(fixtures), { dataDir })
    try {
      await withClient(first, (client) =>
        Effect.gen(function*() {
          expect(yield* client["stt.status"]()).toEqual({ state: "absent", model: "Fake Parakeet", downloadBytes: fixtures.runtime.bytes + fixtures.model.bytes })
          expect(yield* Effect.flip(client["stt.open"]())).toMatchObject({ _tag: "Unavailable" })
          expect(yield* installed(client)).toEqual({ state: "ready", model: "Fake Parakeet" })
          expect(recognizersRunningUnder(dataDir)).toBe(0)

          const { sessionId } = yield* client["stt.open"]()
          const live: Array<string> = []
          for (const chunk of chunked(joinChunks([tone(1.2), silence(0.8), tone(1)]), 0.25)) {
            live.push((yield* client["stt.append"]({ sessionId, pcmBase64: pcm(chunk) })).text)
          }
          expect(live.some((text) => occurrences(text, "country") === 1)).toBe(true)
          const final = yield* client["stt.finish"]({ sessionId, pcmBase64: pcm(silence(0.1)) })
          expect(occurrences(final.text, "country")).toBe(2)
          expect(yield* Effect.flip(client["stt.append"]({ sessionId, pcmBase64: "" }))).toMatchObject({ _tag: "NotFound" })

          const other = yield* client["stt.open"]()
          expect(yield* Effect.flip(client["stt.append"]({ sessionId: other.sessionId, pcmBase64: "A".repeat(3_000_000) }))).toMatchObject({ _tag: "InvalidInput" })
          expect(yield* Effect.flip(client["stt.append"]({ sessionId: other.sessionId, pcmBase64: "%%%" }))).toMatchObject({ _tag: "InvalidInput" })
          yield* client["stt.discard"]({ sessionId: other.sessionId })
          expect(yield* Effect.flip(client["stt.finish"]({ sessionId: other.sessionId, pcmBase64: "" }))).toMatchObject({ _tag: "NotFound" })
          expect(recognizersRunningUnder(dataDir)).toBe(1)
        }))
      expect(await recognizerLedgerEntries(first)).toHaveLength(1)
    } finally {
      await first.close({ keepData: true })
    }
    expect(recognizersRunningUnder(dataDir)).toBe(0)

    const second = await startWithManifest(manifestFor(fixtures), { dataDir })
    try {
      await withClient(second, (client) =>
        Effect.gen(function*() {
          expect((yield* client["stt.status"]()).state).toBe("ready")
          yield* client["stt.open"]()
          expect(yield* client["stt.remove"]()).toMatchObject({ state: "absent", model: "Fake Parakeet" })
          expect(recognizersRunningUnder(dataDir)).toBe(0)
          expect(yield* Effect.flip(client["stt.open"]())).toMatchObject({ _tag: "Unavailable" })
        }))
      expect(await recognizerLedgerEntries(second)).toHaveLength(0)
    } finally {
      await second.close()
    }
  }, 30_000)

  test("a crashed or hung recognizer is replaced once, even when two dictations notice at the same time", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openbot-server-test-"))
    const server = await startWithManifest(manifestFor(fixtures), { dataDir, decodeTimeoutMs: 500 })
    try {
      await withClient(server, (client) =>
        Effect.gen(function*() {
          yield* installed(client)
          const [a, b, c] = yield* Effect.all([client["stt.open"](), client["stt.open"](), client["stt.open"]()])
          const crashed = yield* Effect.flip(client["stt.append"]({ sessionId: c.sessionId, pcmBase64: pcm(tone(1, CRASH_LEVEL)) }))
          expect(crashed).toMatchObject({ _tag: "Unavailable", message: expect.stringContaining("log") })
          const both = yield* Effect.promise(() =>
            server.run(
              Effect.gen(function*() {
                const speech = yield* SpeechToText
                return yield* Effect.all([a, b].map(({ sessionId }) => speech.finish(sessionId, encodePcm16(tone(1)))), { concurrency: "unbounded" })
              }),
            )
          )
          expect(both.map(({ text }) => text)).toEqual(["country", "country"])
          expect(recognizersRunningUnder(dataDir)).toBe(1)

          const hung = yield* client["stt.open"]()
          expect(yield* Effect.flip(client["stt.finish"]({ sessionId: hung.sessionId, pcmBase64: pcm(tone(1, HANG_LEVEL)) }))).toMatchObject({ _tag: "Unavailable" })
          const after = yield* client["stt.open"]()
          expect((yield* client["stt.finish"]({ sessionId: after.sessionId, pcmBase64: pcm(tone(1)) })).text).toBe("country")
          expect(recognizersRunningUnder(dataDir)).toBe(1)
        }))
      expect(await recognizerLedgerEntries(server)).toHaveLength(1)
    } finally {
      await server.close()
    }
    expect(recognizersRunningUnder(dataDir)).toBe(0)
  }, 30_000)

  test("the recognizer stops once every dictation has ended or been abandoned", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openbot-server-test-"))
    const server = await startWithManifest(manifestFor(fixtures), { dataDir, recognizerIdleMs: 300, sessionIdleMs: 200 })
    try {
      await withClient(server, (client) =>
        Effect.gen(function*() {
          yield* installed(client)
          const finished = yield* client["stt.open"]()
          yield* client["stt.finish"]({ sessionId: finished.sessionId, pcmBase64: pcm(tone(1)) })
          expect(recognizersRunningUnder(dataDir)).toBe(1)
          yield* eventually(Effect.sync(() => recognizersRunningUnder(dataDir)), (running) => running === 0, { label: "idle stop" })

          const abandoned = yield* client["stt.open"]()
          yield* client["stt.append"]({ sessionId: abandoned.sessionId, pcmBase64: pcm(tone(1)) })
          expect(recognizersRunningUnder(dataDir)).toBe(1)
          yield* eventually(Effect.sync(() => recognizersRunningUnder(dataDir)), (running) => running === 0, { label: "abandoned stop" })
          expect(yield* Effect.flip(client["stt.append"]({ sessionId: abandoned.sessionId, pcmBase64: pcm(tone(1)) }))).toMatchObject({ _tag: "NotFound" })
        }))
      expect(await recognizerLedgerEntries(server)).toHaveLength(0)
    } finally {
      await server.close()
    }
  }, 30_000)

  test(`a dictation stops at ${MAX_DICTATION_SECONDS / 60} minutes of audio`, async () => {
    const server = await startWithManifest(manifestFor(fixtures))
    try {
      await withClient(server, (client) =>
        Effect.gen(function*() {
          yield* installed(client)
          const { sessionId } = yield* client["stt.open"]()
          const minute = pcm(silence(60))
          for (let minutes = 1; minutes < MAX_DICTATION_SECONDS / 60; minutes++) yield* client["stt.append"]({ sessionId, pcmBase64: minute })
          yield* client["stt.append"]({ sessionId, pcmBase64: pcm(silence(59.5)) })
          const crossingTheCap = yield* client["stt.append"]({ sessionId, pcmBase64: pcm(joinChunks([silence(0.5), tone(0.5)])) })
          expect(crossingTheCap.text).toBe("")
          const over = yield* Effect.flip(client["stt.append"]({ sessionId, pcmBase64: pcm(tone(0.1)) }))
          expect(over).toMatchObject({ _tag: "InvalidInput", message: expect.stringContaining("10 minutes") })
          expect(yield* client["stt.finish"]({ sessionId, pcmBase64: "" })).toEqual({ text: "" })

          const late = yield* client["stt.open"]()
          for (let minutes = 1; minutes < MAX_DICTATION_SECONDS / 60; minutes++) yield* client["stt.append"]({ sessionId: late.sessionId, pcmBase64: minute })
          yield* client["stt.append"]({ sessionId: late.sessionId, pcmBase64: pcm(joinChunks([silence(59), tone(1)])) })
          expect(yield* client["stt.finish"]({ sessionId: late.sessionId, pcmBase64: pcm(tone(0.5)) })).toEqual({ text: "country" })
        }))
    } finally {
      await server.close()
    }
  }, 30_000)

  test("install failures are reported and Turn on can be pressed again", async () => {
    const failsWith = async (manifest: SttManifest, problem: string) => {
      const server = await startWithManifest(manifest)
      try {
        await withClient(server, (client) => Effect.map(installed(client), (status) => expect(status).toMatchObject({ state: "failed", problem: expect.stringContaining(problem) })))
      } finally {
        await server.close()
      }
    }
    await failsWith(manifestFor(fixtures, { runtime: fixtures.twoFolderRuntime }), "exactly one folder")
    await failsWith(manifestFor(fixtures, { model: fixtures.misheardModel }), "misheard")
    await failsWith(manifestFor(fixtures, { runtime: { ...fixtures.runtime, sha256: "0".repeat(64) } }), "checksum")

    const retried = await startWithManifest(manifestFor(fixtures))
    try {
      await withClient(retried, (client) =>
        Effect.gen(function*() {
          fixtures.failNextDownload = true
          expect(yield* installed(client)).toMatchObject({ state: "failed", problem: expect.stringContaining("503") })
          expect(yield* installed(client)).toEqual({ state: "ready", model: "Fake Parakeet" })
        }))
    } finally {
      await retried.close()
    }
  }, 30_000)

  test("a download that runs past its pinned size is cut off", async () => {
    const server = await startWithManifest(manifestFor(fixtures, { runtime: fixtures.endlessRuntime }))
    try {
      await withClient(server, (client) =>
        Effect.map(installed(client), (status) => expect(status).toMatchObject({ state: "failed", problem: expect.stringContaining("larger than its pinned 1000000 bytes") })))
    } finally {
      await server.close()
    }
  }, 30_000)

  test("a failed download or unpack leaves nothing behind", async () => {
    const leavesNothing = async (manifest: SttManifest) => {
      const dataDir = mkdtempSync(join(tmpdir(), "openbot-server-test-"))
      const server = await startWithManifest(manifest, { dataDir })
      try {
        await withClient(server, (client) => Effect.map(installed(client), (status) => expect(status.state).toBe("failed")))
        expect(existsSync(join(dataDir, "stt"))).toBe(false)
      } finally {
        await server.close()
      }
    }
    await leavesNothing(manifestFor(fixtures, { runtime: fixtures.endlessRuntime }))
    await leavesNothing(manifestFor(fixtures, { runtime: fixtures.twoFolderRuntime }))
    await leavesNothing(manifestFor(fixtures, { model: { ...fixtures.model, sha256: "0".repeat(64) } }))
  }, 30_000)

  test("voice input cannot be turned off while it installs", async () => {
    const server = await startWithManifest(manifestFor(fixtures))
    let release = () => {}
    fixtures.holdDownloads = new Promise((resolve) => {
      release = resolve
    })
    try {
      await withClient(server, (client) =>
        Effect.gen(function*() {
          expect((yield* client["stt.install"]()).state).toBe("installing")
          expect(yield* Effect.flip(client["stt.remove"]())).toMatchObject({ _tag: "Conflict" })
          release()
          expect(yield* eventually(client["stt.status"](), settled, { label: "install" })).toEqual({ state: "ready", model: "Fake Parakeet" })
        }))
    } finally {
      release()
      fixtures.holdDownloads = undefined
      await server.close()
    }
  }, 30_000)

  test("a recognizer that fails to start, or fails one decode, does not break later dictations", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openbot-server-test-"))
    const server = await startWithManifest(manifestFor(fixtures), { dataDir, startupTimeoutMs: 300 })
    try {
      await withClient(server, (client) =>
        Effect.gen(function*() {
          yield* installed(client)
          setModelMarker(dataDir, "fail-start", true)
          expect(yield* Effect.flip(client["stt.open"]())).toMatchObject({ _tag: "Unavailable" })
          setModelMarker(dataDir, "fail-start", false)
          const first = yield* client["stt.open"]()
          expect((yield* client["stt.append"]({ sessionId: first.sessionId, pcmBase64: pcm(tone(1)) })).text).toBe("country")
          const pidAfterStart = yield* Effect.promise(() => recognizerPids(server))
          expect(pidAfterStart).toHaveLength(1)

          yield* Effect.sleep("800 millis")
          const failed = yield* Effect.flip(client["stt.append"]({ sessionId: first.sessionId, pcmBase64: pcm(tone(1, DECODE_FAIL_LEVEL)) }))
          expect(failed).toMatchObject({ _tag: "Unavailable" })
          const second = yield* client["stt.open"]()
          expect((yield* client["stt.finish"]({ sessionId: second.sessionId, pcmBase64: pcm(tone(2)) })).text).toBe("country")
          expect(yield* Effect.promise(() => recognizerPids(server))).toEqual(pidAfterStart)
        }))
    } finally {
      await server.close()
    }
  }, 30_000)

  test("a recognizer that never becomes ready is killed when its startup time runs out", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openbot-server-test-"))
    const server = await startWithManifest(manifestFor(fixtures), { dataDir, startupTimeoutMs: 300 })
    try {
      await withClient(server, (client) =>
        Effect.gen(function*() {
          yield* installed(client)
          setModelMarker(dataDir, "hang-start", true)
          expect(yield* Effect.flip(client["stt.open"]())).toMatchObject({ _tag: "Unavailable" })
          yield* eventually(Effect.sync(() => recognizersRunningUnder(dataDir)), (running) => running === 0, { timeout: 3_000, label: "hung start killed" })
        }))
      expect(await recognizerLedgerEntries(server)).toHaveLength(0)
    } finally {
      await server.close()
    }
  }, 30_000)

  test("a recognizer that ignores SIGTERM is still stopped when voice input is turned off", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openbot-server-test-"))
    const server = await startWithManifest(manifestFor(fixtures), { dataDir })
    try {
      await withClient(server, (client) =>
        Effect.gen(function*() {
          yield* installed(client)
          setModelMarker(dataDir, "ignore-sigterm", true)
          yield* client["stt.open"]()
          expect(recognizersRunningUnder(dataDir)).toBe(1)
          const removingAt = Date.now()
          yield* client["stt.remove"]()
          expect(Date.now() - removingAt).toBeLessThan(3_500)
          expect(recognizersRunningUnder(dataDir)).toBe(0)
        }))
    } finally {
      await server.close()
    }
  }, 30_000)

  test.each(["startup", "shutdown", "idle shutdown", "interrupted shutdown"] as const)("removal blocks dictation and installation during recognizer %s", async (stage) => {
    const dataDir = mkdtempSync(join(tmpdir(), "openbot-server-test-"))
    const entered = Effect.runSync(Deferred.make<void>())
    const resume = Effect.runSync(Deferred.make<void>())
    const pause = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)))
    let held = false
    const speech = SpeechToTextLive({ dir: join(dataDir, "stt"), manifest: manifestFor(fixtures), recognizerEntry: FAKE_RECOGNIZER, recognizerIdleMs: stage === "idle shutdown" ? 20 : undefined }).pipe(
      Layer.provide(Layer.succeed(ProcessLedger, ProcessLedger.of({
        record: () => Effect.suspend(() => held && stage === "startup" ? pause : Effect.void),
        remove: () => Effect.suspend(() => held && stage !== "startup" ? pause : Effect.void),
        list: Effect.succeed([]),
        clear: Effect.void,
      }))),
    )
    const server = await startServer({ dataDir, server: { speechToText: speech } })
    try {
      await withClient(server, (client) =>
        Effect.gen(function*() {
          yield* installed(client)
          setModelMarker(dataDir, "ignore-sigterm", true)
        }))
      await server.run(Effect.gen(function*() {
        const service = yield* SpeechToText
        const initial = stage === "startup" ? undefined : yield* service.open
        held = true
        if (stage === "idle shutdown" && initial !== undefined) {
          yield* service.discard(initial.sessionId)
          yield* Deferred.await(entered)
        }
        const opening = stage === "startup"
          ? yield* service.open.pipe(
            Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }),
            Effect.forkScoped({ startImmediately: true }),
          )
          : undefined
        if (stage === "startup") yield* Deferred.await(entered)
        const removing = yield* service.remove.pipe(Effect.forkScoped({ startImmediately: true }))
        if (stage === "shutdown" || stage === "interrupted shutdown") yield* Deferred.await(entered)
        const interruption = stage === "interrupted shutdown"
          ? yield* Fiber.interrupt(removing).pipe(Effect.forkScoped({ startImmediately: true }))
          : undefined
        yield* Effect.gen(function*() {
          expect(existsSync(join(dataDir, "stt", "model"))).toBe(true)
          yield* Effect.promise(() => withClient(server, (client) => Effect.gen(function*() {
            expect(yield* Effect.flip(client["stt.open"]())).toMatchObject({ _tag: "Conflict" })
            expect(yield* Effect.flip(client["stt.install"]())).toMatchObject({ _tag: "Conflict" })
            expect(yield* Effect.flip(client["stt.remove"]())).toMatchObject({ _tag: "Conflict" })
            expect(yield* Effect.flip(client["stt.append"]({ sessionId: "removed", pcmBase64: "" }))).toMatchObject({ _tag: "Conflict" })
          })))
        }).pipe(Effect.ensuring(Effect.sync(() => { held = false }).pipe(Effect.andThen(Deferred.succeed(resume, undefined)))))
        if (interruption === undefined) expect((yield* Fiber.join(removing)).state).toBe("absent")
        else {
          yield* Fiber.join(interruption)
          expect((yield* service.status).state).toBe("absent")
        }
        if (opening !== undefined) expect(yield* Fiber.join(opening)).toMatchObject({ _tag: "Conflict" })
        expect(recognizersRunningUnder(dataDir)).toBe(0)
        expect(existsSync(join(dataDir, "stt"))).toBe(false)
        expect(yield* Effect.flip(service.open)).toMatchObject({ _tag: "Unavailable" })
      }))
      await withClient(server, (client) => Effect.gen(function*() {
        expect((yield* installed(client)).state).toBe("ready")
        yield* client["stt.open"]()
        yield* client["stt.remove"]()
        expect(recognizersRunningUnder(dataDir)).toBe(0)
      }))
    } finally {
      held = false
      Effect.runSync(Deferred.succeed(resume, undefined))
      await server.close()
    }
  }, 30_000)

  test("a pending transcription resumed after removal says voice input is not set up", async () => {
    const server = await startWithManifest(manifestFor(fixtures))
    const entered = Effect.runSync(Deferred.make<void>())
    const resume = Effect.runSync(Deferred.make<void>())
    const finish = DictationSession.prototype.finish
    const paused = spyOn(DictationSession.prototype, "finish").mockImplementation(async function(this: DictationSession, samples: Float32Array) {
      Effect.runSync(Deferred.succeed(entered, undefined))
      await Effect.runPromise(Deferred.await(resume))
      return finish.call(this, samples)
    })
    try {
      await withClient(server, installed)
      await server.run(Effect.gen(function*() {
        const service = yield* SpeechToText
        const { sessionId } = yield* service.open
        const finishing = yield* service.finish(sessionId, encodePcm16(tone(1))).pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(entered)
        yield* service.remove.pipe(Effect.ensuring(Deferred.succeed(resume, undefined)))
        expect(yield* Fiber.join(finishing)).toMatchObject({ _tag: "Unavailable", message: expect.stringContaining("isn't set up") })
        expect(recognizersRunningUnder(server.dataDir)).toBe(0)
      }))
    } finally {
      Effect.runSync(Deferred.succeed(resume, undefined))
      paused.mockRestore()
      await server.close()
    }
  }, 30_000)

  test("a brain without a runtime build reports unsupported and installs nothing", async () => {
    const server = await startWithManifest(manifestFor(fixtures, { runtime: null }))
    try {
      await withClient(server, (client) => Effect.map(client["stt.install"](), (status) => expect(status).toEqual({ state: "unsupported", model: "Fake Parakeet" })))
    } finally {
      await server.close()
    }
  })
})

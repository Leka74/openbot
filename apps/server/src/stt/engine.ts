import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { availableParallelism } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { SttArchive, SttModel } from "./manifest.ts"
import type { RecognizerLaunch, RecognizerReply, RecognizerRequest } from "./recognizer-protocol.ts"

export interface SttLayout {
  readonly root: string
  readonly runtime: string
  readonly model: string
  readonly work: string
  readonly marker: string
}

export const sttLayout = (root: string): SttLayout => ({
  root,
  runtime: path.join(root, "runtime"),
  model: path.join(root, "model"),
  work: path.join(root, "work"),
  marker: path.join(root, "installed.json"),
})

interface InstalledMarker {
  readonly runtimeSha256: string
  readonly modelSha256: string
}

export const RECOGNIZER_PROCESS_ENTRY = fileURLToPath(new URL("./recognizer-process.ts", import.meta.url))
const RECOGNIZER_STOP_GRACE_MS = 2_000
const UNPACK_TIMEOUT_MS = 600_000
const MAX_RECOGNIZER_THREADS = 4
const STDERR_TAIL_CHARS = 2_000
const ERROR_TAIL_LINES = 3
const PCM16_SCALE = 0x8000

const lastLines = (text: string): string => text.trim().split("\n").slice(-ERROR_TAIL_LINES).join(" ")

const errorReason = (stderr: string): string => {
  const lines = stderr.trim().split("\n").map((line) => line.trim())
  return lines.findLast((line) => /^error\b/i.test(line)) ?? lastLines(stderr)
}

export const isInstalled = async (layout: SttLayout, runtime: SttArchive, model: SttModel): Promise<boolean> => {
  try {
    const marker = JSON.parse(await readFile(layout.marker, "utf8")) as InstalledMarker
    return marker.runtimeSha256 === runtime.sha256 && marker.modelSha256 === model.archive.sha256
  } catch {
    return false
  }
}

export const markInstalled = (layout: SttLayout, runtime: SttArchive, model: SttModel): Promise<void> => {
  const marker: InstalledMarker = { runtimeSha256: runtime.sha256, modelSha256: model.archive.sha256 }
  return writeFile(layout.marker, JSON.stringify(marker))
}

const downloadVerified = async (archive: SttArchive, file: string, onReceived: (bytes: number) => void, signal: AbortSignal) => {
  const response = await fetch(archive.url, { signal })
  if (!response.ok || response.body === null) throw new Error(`Downloading ${archive.url} failed (HTTP ${response.status}).`)
  const hash = createHash("sha256")
  const sink = Bun.file(file).writer()
  let received = 0
  try {
    for await (const chunk of response.body) {
      received += chunk.byteLength
      if (received > archive.bytes) throw new Error(`${path.basename(file)} is larger than its pinned ${archive.bytes} bytes.`)
      hash.update(chunk)
      sink.write(chunk)
      onReceived(received)
    }
  } finally {
    await sink.end()
  }
  if (hash.digest("hex") !== archive.sha256) throw new Error(`${path.basename(file)} does not match its pinned checksum.`)
}

const untar = async (archiveFile: string, into: string) => {
  const tar = Bun.spawn(["tar", "-xjf", archiveFile, "-C", into], { stdout: "ignore", stderr: "pipe", timeout: UNPACK_TIMEOUT_MS })
  const [exitCode, stderr] = await Promise.all([tar.exited, new Response(tar.stderr).text()])
  if (exitCode !== 0) throw new Error(`Unpacking ${path.basename(archiveFile)} failed: ${lastLines(stderr)}`)
}

const unpackSingleFolder = async (archiveFile: string, destination: string, staging: string) => {
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  await untar(archiveFile, staging)
  const entries = await readdir(staging)
  if (entries.length !== 1 || entries[0] === undefined) throw new Error(`${path.basename(archiveFile)} does not hold exactly one folder.`)
  await rm(destination, { recursive: true, force: true })
  await rename(path.join(staging, entries[0]), destination)
  await rm(staging, { recursive: true, force: true })
}

const archiveFileName = (archive: SttArchive): string => path.basename(new URL(archive.url).pathname)

export const downloadStt = async (
  layout: SttLayout,
  runtime: SttArchive,
  model: SttModel,
  onProgress: (downloadedBytes: number, downloadBytes: number) => void,
  signal: AbortSignal,
): Promise<void> => {
  await rm(layout.root, { recursive: true, force: true })
  await mkdir(layout.work, { recursive: true })
  const downloadBytes = runtime.bytes + model.archive.bytes
  const parts = [
    { archive: runtime, destination: layout.runtime },
    { archive: model.archive, destination: layout.model },
  ]
  let completedBytes = 0
  try {
    for (const { archive, destination } of parts) {
      const file = path.join(layout.work, archiveFileName(archive))
      await downloadVerified(archive, file, (received) => onProgress(completedBytes + received, downloadBytes), signal)
      completedBytes += archive.bytes
      await unpackSingleFolder(file, destination, path.join(layout.work, "staging"))
      await rm(file, { force: true })
    }
  } catch (error) {
    await rm(layout.root, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export const pcm16Samples = (pcm: Uint8Array): Float32Array => {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const samples = new Float32Array(Math.floor(pcm.byteLength / 2))
  for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(index * 2, true) / PCM16_SCALE
  return samples
}

export const pcm16WavSamples = (wav: Uint8Array): { readonly samples: Float32Array; readonly sampleRate: number } => {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  let sampleRate = 0
  let offset = 12
  while (offset + 8 <= wav.byteLength) {
    const chunkId = String.fromCharCode(...wav.subarray(offset, offset + 4))
    const chunkBytes = view.getUint32(offset + 4, true)
    if (chunkId === "fmt ") sampleRate = view.getUint32(offset + 12, true)
    if (chunkId === "data") return { samples: pcm16Samples(wav.subarray(offset + 8, offset + 8 + chunkBytes)), sampleRate }
    offset += 8 + chunkBytes
  }
  throw new Error("The WAV file has no audio data.")
}

export interface Recognizer {
  readonly pid: number
  readonly decode: (samples: Float32Array, sampleRate: number) => Promise<string>
  readonly stop: () => Promise<void>
  readonly alive: () => boolean
}

interface RecognizerOptions {
  readonly entry: string
  readonly layout: SttLayout
  readonly model: SttModel
  readonly sampleRate: number
  readonly decodeTimeoutMs: number
  readonly startupTimeoutMs: number
}

const sharedLibraryName = (): string => (process.platform === "darwin" ? "libsherpa-onnx-c-api.dylib" : "libsherpa-onnx-c-api.so")

const killGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal)
  } catch {
    return
  }
}

const recognizerLaunch = (options: RecognizerOptions): RecognizerLaunch => ({
  library: path.join(options.layout.runtime, "lib", sharedLibraryName()),
  encoder: path.join(options.layout.model, options.model.encoder),
  decoder: path.join(options.layout.model, options.model.decoder),
  joiner: path.join(options.layout.model, options.model.joiner),
  tokens: path.join(options.layout.model, options.model.tokens),
  modelType: options.model.modelType,
  threads: Math.max(1, Math.min(MAX_RECOGNIZER_THREADS, availableParallelism())),
  sampleRate: options.sampleRate,
})

const libraryPathWith = (libraryDir: string): string =>
  [libraryDir, process.env["LD_LIBRARY_PATH"]].filter((entry) => entry !== undefined && entry !== "").join(":")

export const startRecognizer = (options: RecognizerOptions): Promise<Recognizer> =>
  new Promise((resolveStarted, rejectStarted) => {
    const waiting = new Map<number, (outcome: string | Error) => void>()
    let nextRequestId = 0
    let broken = false
    let stderrTail = ""

    const child = Bun.spawn([process.execPath, options.entry, JSON.stringify(recognizerLaunch(options))], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      detached: true,
      serialization: "advanced",
      env: { ...process.env, LD_LIBRARY_PATH: libraryPathWith(path.join(options.layout.runtime, "lib")) },
      ipc: (message: RecognizerReply) => {
        if (message.type === "ready") {
          clearTimeout(startupTimer)
          resolveStarted(recognizer)
          return
        }
        if (message.type === "failed") {
          broken = true
          rejectStarted(new Error(message.message))
          return
        }
        const settle = waiting.get(message.id)
        waiting.delete(message.id)
        settle?.(message.type === "decoded" ? message.text : new Error(message.message))
      },
    })

    void (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of child.stderr) stderrTail = (stderrTail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_CHARS)
    })().catch(() => undefined)

    const startupTimer = setTimeout(() => {
      broken = true
      killGroup(child.pid, "SIGKILL")
      rejectStarted(new Error(`The speech recognizer did not start within ${options.startupTimeoutMs / 1000} s.`))
    }, options.startupTimeoutMs)

    void child.exited.then((exitCode) => {
      clearTimeout(startupTimer)
      broken = true
      const tail = stderrTail.trim().length > 0 ? ` ${errorReason(stderrTail)}` : ""
      const exited = new Error(`The speech recognizer exited with code ${exitCode}.${tail}`)
      for (const settle of waiting.values()) settle(exited)
      waiting.clear()
      rejectStarted(exited)
    })

    const decode = (samples: Float32Array, sampleRate: number) =>
      new Promise<string>((resolve, reject) => {
        if (broken) return reject(new Error("The speech recognizer is not running."))
        const id = nextRequestId++
        const timer = setTimeout(() => {
          broken = true
          killGroup(child.pid, "SIGKILL")
        }, options.decodeTimeoutMs)
        waiting.set(id, (outcome) => {
          clearTimeout(timer)
          if (outcome instanceof Error) reject(outcome)
          else resolve(outcome)
        })
        const request: RecognizerRequest = { id, samples, sampleRate }
        child.send(request)
      })

    const stop = async () => {
      broken = true
      killGroup(child.pid, "SIGTERM")
      const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(RECOGNIZER_STOP_GRACE_MS).then(() => false)])
      if (!exited) killGroup(child.pid, "SIGKILL")
    }

    const recognizer: Recognizer = { pid: child.pid, decode, stop, alive: () => !broken && child.exitCode === null }
  })

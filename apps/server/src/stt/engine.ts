import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { availableParallelism } from "node:os"
import path from "node:path"
import type { SttArchive, SttModel } from "./manifest.ts"

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

const RECOGNIZER_SERVER_BINARY = "sherpa-onnx-offline-websocket-server"
const RECOGNIZER_STARTUP_TIMEOUT_MS = 60_000
const RECOGNIZER_CONNECT_RETRY_MS = 100
const RECOGNIZER_STOP_GRACE_MS = 2_000
const DECODE_TIMEOUT_MS = 60_000
const DECODE_HEADER_BYTES = 8
const PCM16_SCALE = 0x8000
const UNPACK_TIMEOUT_MS = 600_000
const MAX_RECOGNIZER_THREADS = 4
const ERROR_TAIL_LINES = 3

export type InstallProgress = (downloadedBytes: number, downloadBytes: number) => void

export const isInstalled = async (layout: SttLayout, runtime: SttArchive, model: SttModel): Promise<boolean> => {
  try {
    const marker = JSON.parse(await readFile(layout.marker, "utf8")) as InstalledMarker
    return marker.runtimeSha256 === runtime.sha256 && marker.modelSha256 === model.archive.sha256
  } catch {
    return false
  }
}

const lastLines = (text: string): string => text.trim().split("\n").slice(-ERROR_TAIL_LINES).join(" ")

interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

const runCommand = async (
  command: ReadonlyArray<string>,
  options: { readonly timeoutMs: number; readonly env?: Record<string, string | undefined> },
): Promise<CommandResult> => {
  const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe", timeout: options.timeoutMs, env: options.env })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { exitCode, stdout, stderr, timedOut: child.signalCode !== null && exitCode !== 0 }
}

const downloadVerified = async (archive: SttArchive, file: string, onReceived: (bytes: number) => void, signal: AbortSignal) => {
  const response = await fetch(archive.url, { signal })
  if (!response.ok || response.body === null) throw new Error(`Downloading ${archive.url} failed (HTTP ${response.status}).`)
  const hash = createHash("sha256")
  const sink = Bun.file(file).writer()
  let received = 0
  try {
    for await (const chunk of response.body) {
      hash.update(chunk)
      sink.write(chunk)
      received += chunk.byteLength
      onReceived(received)
    }
  } finally {
    await sink.end()
  }
  if (hash.digest("hex") !== archive.sha256) throw new Error(`${path.basename(file)} does not match its pinned checksum.`)
}

const unpackSingleFolder = async (archiveFile: string, destination: string, staging: string) => {
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  const unpacked = await runCommand(["tar", "-xjf", archiveFile, "-C", staging], { timeoutMs: UNPACK_TIMEOUT_MS })
  if (unpacked.exitCode !== 0) throw new Error(`Unpacking ${path.basename(archiveFile)} failed: ${lastLines(unpacked.stderr)}`)
  const entries = await readdir(staging)
  if (entries.length !== 1 || entries[0] === undefined) throw new Error(`${path.basename(archiveFile)} does not hold exactly one folder.`)
  await rm(destination, { recursive: true, force: true })
  await rename(path.join(staging, entries[0]), destination)
  await rm(staging, { recursive: true, force: true })
}

export const parseRecognizerOutput = (stdout: string): string | undefined => {
  const resultLine = stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("{")).at(-1)
  if (resultLine === undefined) return undefined
  try {
    const result = JSON.parse(resultLine) as { readonly text?: unknown }
    return typeof result.text === "string" ? result.text.trim() : undefined
  } catch {
    return undefined
  }
}

export const recognizerThreads = (): number => Math.max(1, Math.min(MAX_RECOGNIZER_THREADS, availableParallelism()))

const withLibraryPath = (libraryDir: string): Record<string, string | undefined> => ({
  ...process.env,
  LD_LIBRARY_PATH: [libraryDir, process.env["LD_LIBRARY_PATH"]].filter((entry) => entry !== undefined && entry.length > 0).join(":"),
})

export interface ResidentRecognizer {
  readonly pid: number
  readonly decode: (samples: Float32Array) => Promise<string>
  readonly stop: () => Promise<void>
  readonly alive: () => boolean
}

const freeLoopbackPort = (): number => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => undefined } })
  const port = listener.port
  listener.stop(true)
  return port
}

const killGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal)
  } catch {
    return
  }
}

const tryConnect = (url: string): Promise<WebSocket | undefined> =>
  new Promise((resolve) => {
    const socket = new WebSocket(url)
    socket.binaryType = "arraybuffer"
    socket.addEventListener("open", () => resolve(socket), { once: true })
    socket.addEventListener("error", () => resolve(undefined), { once: true })
  })

const connectOnceListening = async (url: string, child: Bun.Subprocess): Promise<WebSocket> => {
  const deadline = Date.now() + RECOGNIZER_STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The speech recognizer exited with code ${child.exitCode} while starting.`)
    const socket = await tryConnect(url)
    if (socket !== undefined) return socket
    await Bun.sleep(RECOGNIZER_CONNECT_RETRY_MS)
  }
  throw new Error(`The speech recognizer did not start within ${RECOGNIZER_STARTUP_TIMEOUT_MS / 1000} s.`)
}

const decodeRequest = (samples: Float32Array, sampleRate: number): Uint8Array => {
  const request = new Uint8Array(DECODE_HEADER_BYTES + samples.byteLength)
  const header = new DataView(request.buffer)
  header.setInt32(0, sampleRate, true)
  header.setInt32(4, samples.byteLength, true)
  const littleEndianSamples = new DataView(request.buffer, DECODE_HEADER_BYTES)
  samples.forEach((sample, index) => littleEndianSamples.setFloat32(index * 4, sample, true))
  return request
}

export const startResidentRecognizer = async (layout: SttLayout, model: SttModel, sampleRate: number): Promise<ResidentRecognizer> => {
  const port = freeLoopbackPort()
  const child = Bun.spawn(
    [
      path.join(layout.runtime, "bin", RECOGNIZER_SERVER_BINARY),
      `--port=${port}`,
      "--num-io-threads=1",
      "--num-work-threads=1",
      "--max-batch-size=1",
      `--num-threads=${recognizerThreads()}`,
      `--model-type=${model.modelType}`,
      `--encoder=${path.join(layout.model, model.encoder)}`,
      `--decoder=${path.join(layout.model, model.decoder)}`,
      `--joiner=${path.join(layout.model, model.joiner)}`,
      `--tokens=${path.join(layout.model, model.tokens)}`,
      "--log-file=/dev/null",
    ],
    { stdout: "ignore", stderr: "ignore", detached: true, env: withLibraryPath(path.join(layout.runtime, "lib")) },
  )
  let socket: WebSocket
  try {
    socket = await connectOnceListening(`ws://127.0.0.1:${port}`, child)
  } catch (error) {
    killGroup(child.pid, "SIGKILL")
    throw error
  }

  let connected = true
  let awaitingReply: { readonly settle: (reply: string | Error) => void } | undefined
  const settleReply = (reply: string | Error) => {
    const waiting = awaitingReply
    awaitingReply = undefined
    waiting?.settle(reply)
  }
  socket.addEventListener("message", (event) => settleReply(String(event.data)))
  socket.addEventListener("close", () => {
    connected = false
    settleReply(new Error("The speech recognizer closed its connection."))
  })

  const decodeNow = (samples: Float32Array) =>
    new Promise<string>((resolve, reject) => {
      if (!connected) return reject(new Error("The speech recognizer is not running."))
      const timer = setTimeout(() => {
        settleReply(new Error(`The speech recognizer did not answer within ${DECODE_TIMEOUT_MS / 1000} s.`))
        socket.close()
      }, DECODE_TIMEOUT_MS)
      awaitingReply = {
        settle: (reply) => {
          clearTimeout(timer)
          if (reply instanceof Error) return reject(reply)
          const text = parseRecognizerOutput(reply)
          if (text === undefined) return reject(new Error(`The speech recognizer sent an unexpected reply: ${reply.slice(0, 200)}`))
          resolve(text)
        },
      }
      socket.send(decodeRequest(samples, sampleRate))
    })

  let queue: Promise<unknown> = Promise.resolve()
  const decode = (samples: Float32Array): Promise<string> => {
    const decoded = queue.then(() => decodeNow(samples))
    queue = decoded.catch(() => undefined)
    return decoded
  }

  const stop = async () => {
    connected = false
    socket.close()
    killGroup(child.pid, "SIGTERM")
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(RECOGNIZER_STOP_GRACE_MS).then(() => false)])
    if (!exited) killGroup(child.pid, "SIGKILL")
  }

  return { pid: child.pid, decode, stop, alive: () => connected && child.exitCode === null }
}

export const pcm16WavSamples = (wav: Uint8Array): { readonly samples: Float32Array; readonly sampleRate: number } => {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  let sampleRate = 0
  let offset = 12
  while (offset + 8 <= wav.byteLength) {
    const chunkId = String.fromCharCode(...wav.subarray(offset, offset + 4))
    const chunkBytes = view.getUint32(offset + 4, true)
    if (chunkId === "fmt ") sampleRate = view.getUint32(offset + 12, true)
    if (chunkId === "data") {
      const samples = new Float32Array(Math.floor(chunkBytes / 2))
      for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(offset + 8 + index * 2, true) / PCM16_SCALE
      return { samples, sampleRate }
    }
    offset += 8 + chunkBytes
  }
  throw new Error("The WAV file has no audio data.")
}

const archiveFileName = (archive: SttArchive): string => path.basename(new URL(archive.url).pathname)

export const installStt = async (
  layout: SttLayout,
  runtime: SttArchive,
  model: SttModel,
  onProgress: InstallProgress,
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
  for (const { archive, destination } of parts) {
    const file = path.join(layout.work, archiveFileName(archive))
    await downloadVerified(archive, file, (received) => onProgress(completedBytes + received, downloadBytes), signal)
    completedBytes += archive.bytes
    await unpackSingleFolder(file, destination, path.join(layout.work, "staging"))
    await rm(file, { force: true })
  }
  const sample = pcm16WavSamples(new Uint8Array(await readFile(path.join(layout.model, model.sampleWav))))
  const recognizer = await startResidentRecognizer(layout, model, sample.sampleRate)
  const sampleText = await recognizer.decode(sample.samples).finally(() => recognizer.stop())
  if (!sampleText.toLowerCase().includes(model.sampleExpectedWord)) {
    throw new Error(`The speech model misheard its own sample recording ("${sampleText}").`)
  }
  const marker: InstalledMarker = { runtimeSha256: runtime.sha256, modelSha256: model.archive.sha256 }
  await writeFile(layout.marker, JSON.stringify(marker))
}

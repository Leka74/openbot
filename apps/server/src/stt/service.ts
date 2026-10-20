import {
  Conflict,
  DICTATION_SAMPLE_RATE,
  InvalidInput,
  MAX_DICTATION_SECONDS,
  NotFound,
  type SttStatus,
  type SttTranscription,
  Unavailable,
} from "@openbot/contracts"
import { ProcessLedger } from "@openbot/core"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { randomUUID } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import path from "node:path"
import {
  downloadStt,
  isInstalled,
  markInstalled,
  pcm16Samples,
  pcm16WavSamples,
  RECOGNIZER_PROCESS_ENTRY,
  type Recognizer,
  startRecognizer,
  sttLayout,
} from "./engine.ts"
import { PARAKEET_MANIFEST, type SttManifest, sttPlatformOf } from "./manifest.ts"
import { DictationSession } from "./session.ts"

export class SpeechToText extends Context.Service<SpeechToText, {
  readonly status: Effect.Effect<SttStatus>
  readonly install: Effect.Effect<SttStatus>
  readonly remove: Effect.Effect<SttStatus, Conflict>
  readonly open: Effect.Effect<{ readonly sessionId: string }, Unavailable>
  readonly append: (sessionId: string, pcm: Uint8Array) => Effect.Effect<SttTranscription, NotFound | InvalidInput | Unavailable>
  readonly finish: (sessionId: string, pcm: Uint8Array) => Effect.Effect<SttTranscription, NotFound | InvalidInput | Unavailable>
  readonly discard: (sessionId: string) => Effect.Effect<void>
}>()("openbot/server/SpeechToText") {}

export interface SpeechToTextOptions {
  readonly dir: string
  readonly manifest?: SttManifest | undefined
  readonly recognizerEntry?: string | undefined
  readonly recognizerIdleMs?: number | undefined
  readonly sessionIdleMs?: number | undefined
  readonly decodeTimeoutMs?: number | undefined
  readonly startupTimeoutMs?: number | undefined
}

const RECOGNIZER_IDLE_MS = 5 * 60_000
const SESSION_IDLE_MS = 2 * 60_000
const DECODE_TIMEOUT_MS = 60_000
const STARTUP_TIMEOUT_MS = 60_000

const NOT_SET_UP = "Voice input isn't set up on this OpenBot yet. Turn it on in Settings › General."
const RECOGNIZER_FAILED = "Voice input could not transcribe; the details are in the brain's log."

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error))

interface OpenSession {
  readonly session: DictationSession
  lastUsedAt: number
}

export const SpeechToTextLive = (options: SpeechToTextOptions): Layer.Layer<SpeechToText> =>
  Layer.effect(
    SpeechToText,
    Effect.gen(function*() {
      const manifest = options.manifest ?? PARAKEET_MANIFEST
      const model = manifest.model
      const layout = sttLayout(options.dir)
      const platform = sttPlatformOf(process.platform, process.arch)
      const runtime = platform === undefined ? undefined : manifest.runtimes[platform]
      const recognizerIdleMs = options.recognizerIdleMs ?? RECOGNIZER_IDLE_MS
      const sessionIdleMs = options.sessionIdleMs ?? SESSION_IDLE_MS
      const ledger = yield* Effect.serviceOption(ProcessLedger)
      const layerScope = yield* Effect.scope

      const restingStatus = (): SttStatus =>
        runtime === undefined
          ? { state: "unsupported", model: model.label }
          : { state: "absent", model: model.label, downloadBytes: runtime.bytes + model.archive.bytes }
      const installedAlready = runtime !== undefined && (yield* Effect.promise(() => isInstalled(layout, runtime, model)))
      let status: SttStatus = installedAlready ? { state: "ready", model: model.label } : restingStatus()

      const sessions = new Map<string, OpenSession>()
      let recognizer: Promise<Recognizer> | undefined
      let idleTimer: ReturnType<typeof setTimeout> | undefined

      const recordInLedger = (pid: number) =>
        Option.match(ledger, {
          onNone: () => Promise.resolve(),
          onSome: (processes) =>
            Effect.runPromise(
              Effect.flatMap(Clock.currentTimeMillis, (startedAt) =>
                processes.record({ pid, pgid: pid, kind: "other", label: "speech recognizer", startedAt })).pipe(
                  Effect.catch((error) => Effect.logWarning(`ProcessLedger.record failed: ${error.message}`)),
                ),
            ),
        })
      const removeFromLedger = (pid: number) =>
        Option.match(ledger, {
          onNone: () => Promise.resolve(),
          onSome: (processes) =>
            Effect.runPromise(processes.remove(pid).pipe(Effect.catch((error) => Effect.logWarning(`ProcessLedger.remove failed: ${error.message}`)))),
        })

      const launch = async (sampleRate: number): Promise<Recognizer> => {
        const started = await startRecognizer({
          entry: options.recognizerEntry ?? RECOGNIZER_PROCESS_ENTRY,
          layout,
          model,
          sampleRate,
          decodeTimeoutMs: options.decodeTimeoutMs ?? DECODE_TIMEOUT_MS,
          startupTimeoutMs: options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
        })
        await recordInLedger(started.pid)
        return started
      }

      const retire = async (stopping: Recognizer) => {
        await stopping.stop()
        await removeFromLedger(stopping.pid)
      }

      const stopRecognizer = async () => {
        clearTimeout(idleTimer)
        const running = recognizer
        recognizer = undefined
        const started = await running?.catch(() => undefined)
        if (started !== undefined) await retire(started)
      }

      const runningRecognizer = async (): Promise<Recognizer> => {
        const current = recognizer ?? (recognizer = launch(DICTATION_SAMPLE_RATE))
        const started = await current.catch(() => undefined)
        if (started?.alive()) return started
        if (recognizer === current) {
          recognizer = launch(DICTATION_SAMPLE_RATE)
          if (started !== undefined) void retire(started)
        }
        return recognizer
      }

      const forgetIdleSessions = (now: number) => {
        for (const [sessionId, active] of sessions) if (now - active.lastUsedAt > sessionIdleMs) sessions.delete(sessionId)
      }

      const scheduleIdleStop = () => {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          forgetIdleSessions(Date.now())
          if (sessions.size === 0) void stopRecognizer()
          else scheduleIdleStop()
        }, recognizerIdleMs)
      }

      const decode = async (samples: Float32Array) => {
        const running = await runningRecognizer()
        scheduleIdleStop()
        return running.decode(samples, DICTATION_SAMPLE_RATE)
      }

      yield* Effect.addFinalizer(() => Effect.promise(stopRecognizer))

      const recognizerFailure = (error: unknown) =>
        Effect.logWarning("Voice input could not transcribe", { error: describeError(error) }).pipe(
          Effect.andThen(Effect.fail(new Unavailable({ message: RECOGNIZER_FAILED }))),
        )

      const whenReady = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | Unavailable> =>
        Effect.suspend((): Effect.Effect<A, E | Unavailable> => (status.state === "ready" ? effect : Effect.fail(new Unavailable({ message: NOT_SET_UP }))))

      const open = whenReady(
        Effect.gen(function*() {
          forgetIdleSessions(Date.now())
          yield* Effect.tryPromise({ try: runningRecognizer, catch: (error) => error }).pipe(Effect.catch(recognizerFailure))
          scheduleIdleStop()
          const sessionId = randomUUID()
          sessions.set(sessionId, { session: new DictationSession(decode, DICTATION_SAMPLE_RATE), lastUsedAt: Date.now() })
          return { sessionId }
        }),
      )

      const transcribe = (sessionId: string, pcm: Uint8Array, final: boolean) =>
        whenReady(
          Effect.gen(function*() {
            const active = sessions.get(sessionId)
            if (active === undefined) return yield* new NotFound({ entity: "dictation", id: sessionId })
            const remainingSamples = Math.max(0, Math.round((MAX_DICTATION_SECONDS - active.session.receivedSeconds) * DICTATION_SAMPLE_RATE))
            const received = pcm16Samples(pcm)
            if (!final && received.length > 0 && remainingSamples === 0) {
              return yield* new InvalidInput({ message: `Dictation stops after ${MAX_DICTATION_SECONDS / 60} minutes.` })
            }
            const samples = received.subarray(0, remainingSamples)
            active.lastUsedAt = Date.now()
            const text = yield* Effect.tryPromise({
              try: () => (final ? active.session.finish(samples) : active.session.append(samples)),
              catch: (error) => error,
            }).pipe(Effect.catch(recognizerFailure))
            return { text }
          }),
        )

      const append = (sessionId: string, pcm: Uint8Array) => transcribe(sessionId, pcm, false)
      const finish = (sessionId: string, pcm: Uint8Array) =>
        transcribe(sessionId, pcm, true).pipe(Effect.ensuring(Effect.sync(() => sessions.delete(sessionId))))
      const discard = (sessionId: string) => Effect.sync(() => void sessions.delete(sessionId))

      const checkSample = async () => {
        const sample = pcm16WavSamples(new Uint8Array(await readFile(path.join(layout.model, model.sampleWav))))
        const checker = await launch(sample.sampleRate)
        const heard = await checker.decode(sample.samples, sample.sampleRate).finally(() => retire(checker))
        if (!heard.toLowerCase().includes(model.sampleExpectedWord)) throw new Error(`The speech model misheard its own sample recording ("${heard}").`)
      }

      const runInstall = (archive: NonNullable<typeof runtime>) =>
        Effect.tryPromise({
          try: async (signal) => {
            await downloadStt(layout, archive, model, (downloadedBytes, downloadBytes) => {
              status = { state: "installing", model: model.label, downloadBytes, downloadedBytes }
            }, signal)
            await checkSample()
            await markInstalled(layout, archive, model)
          },
          catch: describeError,
        }).pipe(
          Effect.matchEffect({
            onSuccess: () =>
              Effect.sync(() => {
                status = { state: "ready", model: model.label }
              }),
            onFailure: (problem) =>
              Effect.logWarning("Voice input could not be installed", { problem }).pipe(
                Effect.andThen(Effect.sync(() => {
                  status = { state: "failed", model: model.label, problem }
                })),
              ),
          }),
        )

      const install = Effect.suspend(() => {
        if (runtime === undefined || status.state === "installing" || status.state === "ready") return Effect.succeed(status)
        status = { state: "installing", model: model.label, downloadBytes: runtime.bytes + model.archive.bytes, downloadedBytes: 0 }
        return Effect.as(Effect.forkIn(runInstall(runtime), layerScope), status)
      })

      const remove = Effect.suspend(() => {
        if (status.state === "installing") return Effect.fail(new Conflict({ reason: "Voice input is still installing." }))
        sessions.clear()
        return Effect.promise(async () => {
          await stopRecognizer()
          await rm(layout.root, { recursive: true, force: true })
          status = restingStatus()
          return status
        })
      })

      return SpeechToText.of({ status: Effect.sync(() => status), install, remove, open, append, finish, discard })
    }),
  )

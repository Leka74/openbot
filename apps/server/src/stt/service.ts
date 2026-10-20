import {
  Conflict,
  DICTATION_SAMPLE_RATE,
  InvalidInput,
  MAX_DICTATION_CHUNK_BYTES,
  MAX_DICTATION_SECONDS,
  NotFound,
  type SttStatus,
  type SttTranscription,
  Unavailable,
} from "@openbot/contracts"
import { ProcessLedger } from "@openbot/core"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { installStt, isInstalled, type ResidentRecognizer, startResidentRecognizer, sttLayout } from "./engine.ts"
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
  readonly recognizerIdleMs?: number | undefined
}

const RECOGNIZER_IDLE_MS = 5 * 60_000
const SESSION_IDLE_MS = 2 * 60_000
const PCM16_SCALE = 0x8000

const NOT_SET_UP = "Voice input isn't set up on this OpenBot yet. Turn it on in Settings › General."
const RECOGNIZER_FAILED = "Voice input could not transcribe; the details are in the brain's log."

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const pcm16Samples = (pcm: Uint8Array): Float32Array => {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const samples = new Float32Array(Math.floor(pcm.byteLength / 2))
  for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(index * 2, true) / PCM16_SCALE
  return samples
}

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
      const ledger = yield* Effect.serviceOption(ProcessLedger)
      const layerScope = yield* Effect.scope

      const restingStatus = (): SttStatus =>
        runtime === undefined
          ? { state: "unsupported", model: model.label }
          : { state: "absent", model: model.label, downloadBytes: runtime.bytes + model.archive.bytes }
      const installedAlready = runtime !== undefined && (yield* Effect.promise(() => isInstalled(layout, runtime, model)))
      let status: SttStatus = installedAlready ? { state: "ready", model: model.label } : restingStatus()

      const sessions = new Map<string, OpenSession>()
      let recognizer: Promise<ResidentRecognizer> | undefined
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

      const stopRecognizer = async () => {
        clearTimeout(idleTimer)
        const running = recognizer
        recognizer = undefined
        if (running === undefined) return
        const started = await running.catch(() => undefined)
        if (started === undefined) return
        await started.stop()
        await removeFromLedger(started.pid)
      }

      const scheduleIdleStop = () => {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          if (sessions.size === 0) void stopRecognizer()
          else scheduleIdleStop()
        }, recognizerIdleMs)
      }

      const runningRecognizer = async (): Promise<ResidentRecognizer> => {
        const current = recognizer === undefined ? undefined : await recognizer.catch(() => undefined)
        if (current?.alive()) return current
        if (current !== undefined) await stopRecognizer()
        const starting = startResidentRecognizer(layout, model, DICTATION_SAMPLE_RATE).then(async (started) => {
          await recordInLedger(started.pid)
          return started
        })
        recognizer = starting
        starting.catch(() => {
          if (recognizer === starting) recognizer = undefined
        })
        return starting
      }

      const decode = async (samples: Float32Array) => {
        scheduleIdleStop()
        return (await runningRecognizer()).decode(samples)
      }

      yield* Effect.addFinalizer(() => Effect.promise(stopRecognizer))

      const forgetIdleSessions = (now: number) => {
        for (const [sessionId, open] of sessions) if (now - open.lastUsedAt > SESSION_IDLE_MS) sessions.delete(sessionId)
      }

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

      const transcribeInto = (sessionId: string, pcm: Uint8Array) =>
        whenReady(
          Effect.gen(function*() {
            const active = sessions.get(sessionId)
            if (active === undefined) return yield* new NotFound({ entity: "dictation", id: sessionId })
            if (pcm.byteLength > MAX_DICTATION_CHUNK_BYTES) return yield* new InvalidInput({ message: "That piece of audio is too large." })
            if (active.session.receivedSeconds > MAX_DICTATION_SECONDS) {
              return yield* new InvalidInput({ message: `Dictation stops after ${MAX_DICTATION_SECONDS / 60} minutes.` })
            }
            active.lastUsedAt = Date.now()
            const text = yield* Effect.tryPromise({ try: () => active.session.append(pcm16Samples(pcm)), catch: (error) => error }).pipe(
              Effect.catch(recognizerFailure),
            )
            return { text }
          }),
        )

      const append = (sessionId: string, pcm: Uint8Array) => transcribeInto(sessionId, pcm)
      const finish = (sessionId: string, pcm: Uint8Array) =>
        transcribeInto(sessionId, pcm).pipe(Effect.ensuring(Effect.sync(() => sessions.delete(sessionId))))
      const discard = (sessionId: string) => Effect.sync(() => void sessions.delete(sessionId))

      const runInstall = (archive: NonNullable<typeof runtime>) =>
        Effect.tryPromise({
          try: (signal) =>
            installStt(layout, archive, model, (downloadedBytes, downloadBytes) => {
              status = { state: "installing", model: model.label, downloadBytes, downloadedBytes }
            }, signal),
          catch: (error) => new Error(describeError(error)),
        }).pipe(
          Effect.matchEffect({
            onSuccess: () =>
              Effect.sync(() => {
                status = { state: "ready", model: model.label }
              }),
            onFailure: (error) =>
              Effect.logWarning("Voice input could not be installed", { error: error.message }).pipe(
                Effect.andThen(Effect.sync(() => {
                  status = { state: "failed", model: model.label, problem: error.message }
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

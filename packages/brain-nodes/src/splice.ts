/**
 * Socket plumbing for data streams. Every brain-side data path is "socket <-> socket": a node data
 * stream (`/node/stream/:id`) spliced to a UI viewer, a relay consumer (Codex `environment/add`),
 * or a brain-internal TCP target. Frames are forwarded verbatim (binary stays binary, text stays
 * text), so each stream kind keeps its own framing end to end and the brain never parses payloads.
 *
 * Ported from vendor/scratch/hands-e2e/pipe.ts.
 */
import { Effect, Exit } from "effect"
import type { Scope } from "effect"
import * as Socket from "effect/socket/Socket"

export type Frame = string | Uint8Array

/** A socket whose reader and writer were acquired once (Effect 4 sockets are single-reader, G1). */
export interface Duplex {
  readonly pull: Effect.Effect<ReadonlyArray<Frame>, Socket.SocketError>
  readonly writer: Socket.Writer
}

/** Acquire reader + writer in the caller's scope; closing the scope closes the socket. */
export const open = (socket: Socket.Socket): Effect.Effect<Duplex, Socket.SocketError, Scope.Scope> =>
  Effect.gen(function* () {
    const reader = yield* socket.reader
    const writer = yield* socket.writer
    return { pull: reader.pull, writer }
  })

export interface SpliceCount {
  frames: number
  bytes: number
}

export interface SpliceResult {
  /** a → b */
  readonly ab: SpliceCount
  /** b → a */
  readonly ba: SpliceCount
  /** `a` or `b`: whichever side ended first (closed or failed). */
  readonly endedBy: "a" | "b"
  /** close code of the side that ended first, when it closed cleanly with a code. */
  readonly closeCode: number | undefined
}

const frameBytes = (f: Frame): number => (typeof f === "string" ? f.length : f.byteLength)

const pump = (from: Duplex, to: Duplex, count: SpliceCount, map: ((frame: Frame) => Frame) | undefined) =>
  Effect.forever(
    Effect.flatMap(from.pull, (frames) => {
      if (frames.length === 0) return Effect.void
      count.frames += frames.length
      for (const f of frames) count.bytes += frameBytes(f)
      const out = map === undefined ? frames : frames.map(map)
      return to.writer.writeAll(out as unknown as readonly [Frame, ...Array<Frame>])
    }),
  )

export interface SpliceOptions {
  /** Rewrite frames going a → b (e.g. UI text input → terminal bytes). Default: verbatim. */
  readonly mapAB?: ((frame: Frame) => Frame) | undefined
  /** Rewrite frames going b → a. Default: verbatim. */
  readonly mapBA?: ((frame: Frame) => Frame) | undefined
}

const closeCodeOf = (exit: Exit.Exit<unknown, Socket.SocketError>): number | undefined => {
  if (Exit.isSuccess(exit)) return undefined
  for (const reason of exit.cause.reasons) {
    if (
      reason._tag === "Fail" &&
      Socket.isSocketError(reason.error) &&
      reason.error.reason._tag === "SocketCloseError"
    ) {
      return reason.error.reason.code
    }
  }
  return undefined
}

/**
 * Forward frames both ways until either side closes or fails. Buffered frames of the closing side
 * are drained into the other side first. The caller's scope closes both sockets afterwards; when the
 * first side closed with a code, the same code is forwarded to the other side.
 */
export const splice = (a: Duplex, b: Duplex, options?: SpliceOptions): Effect.Effect<SpliceResult> =>
  Effect.gen(function* () {
    const ab: SpliceCount = { frames: 0, bytes: 0 }
    const ba: SpliceCount = { frames: 0, bytes: 0 }
    const result = yield* Effect.raceFirst(
      Effect.exit(pump(a, b, ab, options?.mapAB)).pipe(Effect.map((exit) => ({ endedBy: "a" as const, exit }))),
      Effect.exit(pump(b, a, ba, options?.mapBA)).pipe(Effect.map((exit) => ({ endedBy: "b" as const, exit }))),
    )
    const closeCode = closeCodeOf(result.exit)
    const other = result.endedBy === "a" ? b : a
    if (closeCode !== undefined && closeCode !== 1005 && closeCode !== 1006) {
      yield* Effect.ignore(other.writer.write(new Socket.CloseEvent(closeCode)))
    }
    return { ab, ba, endedBy: result.endedBy, closeCode }
  })

/** Open two sockets in the current scope and splice them. */
export const spliceSockets = (
  a: Socket.Socket,
  b: Socket.Socket,
): Effect.Effect<SpliceResult, Socket.SocketError, Scope.Scope> =>
  Effect.gen(function* () {
    const da = yield* open(a)
    const db = yield* open(b)
    return yield* splice(da, db)
  })

/** Best-effort close with a WebSocket close code (reason is truncated to the 123-byte limit). */
export const closeSocket = (socket: Socket.Socket, code: number, reason?: string): Effect.Effect<void> =>
  Effect.scoped(
    Effect.flatMap(socket.writer, (w) => Effect.ignore(w.write(new Socket.CloseEvent(code, truncateReason(reason))))),
  )

export const closeWriter = (writer: Socket.Writer, code: number, reason?: string): Effect.Effect<void> =>
  Effect.ignore(writer.write(new Socket.CloseEvent(code, truncateReason(reason))))

/** `socket`, closed with 1001 once `until` completes while it is being read. */
export const closedWhen = (socket: Socket.Socket, until: Effect.Effect<void> | undefined): Socket.Socket =>
  until === undefined
    ? socket
    : Socket.make({
        reader: Effect.tap(socket.reader, () =>
          Effect.forkScoped(
            Effect.andThen(
              until,
              Effect.flatMap(socket.writer, (writer) => closeWriter(writer, 1001)),
            ),
          ),
        ),
        writer: socket.writer,
      })

/** WebSocket close reasons are limited to 123 UTF-8 bytes. */
export const truncateReason = (reason: string | undefined): string | undefined => {
  if (reason === undefined) return undefined
  const bytes = new TextEncoder().encode(reason)
  if (bytes.length <= 123) return reason
  return new TextDecoder().decode(bytes.subarray(0, 120)).replace(/�$/, "") + "…"
}

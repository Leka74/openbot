/**
 * File helpers for the file-backed stores: atomic writes (temp file + rename) with `Bun.write`,
 * reads with `Bun.file`, and directory operations from `node:fs/promises` (Bun has no rename/readdir
 * API of its own). Every failure becomes a `RepoError`.
 */
import { RepoError } from "@openbot/core"
import { Effect } from "effect"
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"

const attempt = <A>(op: string, message: string, run: () => Promise<A>): Effect.Effect<A, RepoError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new RepoError({ op, message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`, cause }),
  })

const isMissing = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR")

let tempCounter = 0

/** Writes `data` to `path` atomically: a sibling temp file is written, then renamed over `path`. */
export const writeFileAtomic = (op: string, path: string, data: string | Uint8Array): Effect.Effect<void, RepoError> =>
  attempt(op, `Cannot write ${path}`, async () => {
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}-${(tempCounter++).toString(36)}`
    try {
      await Bun.write(temp, data)
      await rename(temp, path)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  })

export interface StreamWriter {
  /** Appends a chunk to the temp file. */
  readonly write: (chunk: Uint8Array) => Effect.Effect<void, RepoError>
  /** Flushes, closes and renames the temp file over the target; returns the bytes written. */
  readonly commit: Effect.Effect<number, RepoError>
  /** Closes and removes the temp file (never fails). */
  readonly abort: Effect.Effect<void>
}

/**
 * Incremental atomic write for large files: chunks go to a sibling temp file (Bun `FileSink`), then
 * `commit` renames it over `path`. Memory stays at one chunk; nothing appears at `path` unless the
 * whole file was written.
 */
export const openStreamWriter = (op: string, path: string): Effect.Effect<StreamWriter, RepoError> =>
  attempt(op, `Cannot write ${path}`, async () => {
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}-${(tempCounter++).toString(36)}`
    const sink = Bun.file(temp).writer({ highWaterMark: 1024 * 1024 })
    let written = 0
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      await sink.end()
    }
    return {
      write: (chunk) =>
        attempt(op, `Cannot write ${path}`, async () => {
          sink.write(chunk)
          written += chunk.byteLength
          // keep at most ~1 MiB buffered in the sink
          await sink.flush()
        }),
      commit: attempt(op, `Cannot write ${path}`, async () => {
        await close()
        await rename(temp, path)
        return written
      }),
      abort: Effect.promise(async () => {
        await close().catch(() => undefined)
        await rm(temp, { force: true }).catch(() => undefined)
      }),
    } satisfies StreamWriter
  })

/** Reads a UTF-8 file; `undefined` when it does not exist. */
export const readTextFile = (op: string, path: string): Effect.Effect<string | undefined, RepoError> =>
  attempt(op, `Cannot read ${path}`, async () => {
    const file = Bun.file(path)
    try {
      return await file.text()
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  })

/** Reads a file's bytes; `undefined` when it does not exist. */
export const readBytesFile = (op: string, path: string): Effect.Effect<Uint8Array | undefined, RepoError> =>
  attempt(op, `Cannot read ${path}`, async () => {
    try {
      return new Uint8Array(await Bun.file(path).arrayBuffer())
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  })

/** Last modification time in ms; `undefined` when missing. */
export const modifiedAt = (op: string, path: string): Effect.Effect<number | undefined, RepoError> =>
  attempt(op, `Cannot stat ${path}`, async () => {
    try {
      return Math.floor((await stat(path)).mtimeMs)
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
  })

export interface DirEntry {
  readonly name: string
  readonly isFile: boolean
  readonly isDirectory: boolean
}

/** Directory listing; empty when the directory does not exist. */
export const listDirectory = (op: string, path: string): Effect.Effect<ReadonlyArray<DirEntry>, RepoError> =>
  attempt(op, `Cannot list ${path}`, async () => {
    try {
      const entries = await readdir(path, { withFileTypes: true })
      return entries.map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() }))
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  })

/** Removes a file or directory tree; returns whether it existed. */
export const removePath = (op: string, path: string): Effect.Effect<boolean, RepoError> =>
  attempt(op, `Cannot remove ${path}`, async () => {
    try {
      await stat(path)
    } catch (error) {
      if (isMissing(error)) return false
      throw error
    }
    await rm(path, { recursive: true, force: true })
    return true
  })

/** Renames `from` to `to`; false when `from` does not exist. */
export const movePath = (op: string, from: string, to: string): Effect.Effect<boolean, RepoError> =>
  attempt(op, `Cannot move ${from}`, async () => {
    try {
      await rename(from, to)
    } catch (error) {
      if (isMissing(error)) return false
      throw error
    }
    return true
  })

export const ensureDirectory = (op: string, path: string): Effect.Effect<void, RepoError> =>
  attempt(op, `Cannot create ${path}`, async () => {
    await mkdir(path, { recursive: true })
  })

/** Ids used as single path segments must not escape their directory. */
export const safeSegment = (op: string, value: string): Effect.Effect<string, RepoError> =>
  value.length === 0 ||
  value === "." ||
  value === ".." ||
  value.includes("/") ||
  value.includes("\\") ||
  value.includes("\u0000")
    ? Effect.fail(new RepoError({ op, message: `Unsafe path segment: ${JSON.stringify(value)}` }))
    : Effect.succeed(value)

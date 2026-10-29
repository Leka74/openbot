import { SequentialIdGen } from "@openbot/core/testing"
import { MAIN_PROFILE_ID } from "@openbot/contracts"
import {
  type BootRecovery,
  type CurrentProfile,
  inProfile,
  type ProcessRecord,
  type RepositoryPorts,
} from "@openbot/core"
import { Effect, Layer } from "effect"
import type { SqlClient } from "effect/sql"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PersistenceRepositoriesLive, PersistenceSqlLive } from "../src/index.ts"

const created: Array<string> = []

/** A fresh temp data dir; removed by `cleanupTempDirs`. */
export const tempDataDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "openbot-persistence-"))
  created.push(dir)
  return dir
}

export const cleanupTempDirs = async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}

/** Records every process group the boot recovery asks to kill, without signalling anything. */
export const recordingKiller = () => {
  const killed: Array<ProcessRecord> = []
  return {
    killed,
    killProcessGroup: (record: ProcessRecord) => Effect.sync(() => (killed.push(record), true)),
  }
}

/** Persistence for `dataDir` with the SQL client exposed and a deterministic IdGen. */
export const testPersistence = (
  dataDir: string,
  killProcessGroup: (record: ProcessRecord) => Effect.Effect<boolean> = () => Effect.succeed(true),
): Layer.Layer<RepositoryPorts | BootRecovery | SqlClient.SqlClient, unknown> =>
  PersistenceRepositoriesLive(dataDir, { killProcessGroup }).pipe(
    Layer.provideMerge(PersistenceSqlLive(dataDir)),
    Layer.provide(SequentialIdGen()),
  )

/** Runs `effect` in the main profile. */
export const run = <A, E>(
  effect: Effect.Effect<A, E, RepositoryPorts | BootRecovery | SqlClient.SqlClient | CurrentProfile>,
  layer: Layer.Layer<RepositoryPorts | BootRecovery | SqlClient.SqlClient, unknown>,
): Promise<A> =>
  Effect.runPromise(Effect.provide(effect.pipe(inProfile(MAIN_PROFILE_ID)), layer) as Effect.Effect<A, unknown>)

/**
 * The shared repository contract (`@openbot/core/testing`) against SQLite + files: the same cases
 * the in-memory doubles pass, each on a fresh temp data dir.
 */
import { bootRecoveryContractCases, repoContractCases, searchContractCases } from "@openbot/core/testing"
import { afterAll, describe, expect, test } from "bun:test"
import { cleanupTempDirs, recordingKiller, run, tempDataDir, testPersistence } from "./helpers.ts"

afterAll(cleanupTempDirs)

describe("SQLite persistence satisfies the repository contract", () => {
  for (const c of repoContractCases) {
    test(c.name, async () => {
      await run(c.run, testPersistence(await tempDataDir()))
    })
  }
})

describe("SQLite persistence satisfies the message search contract", () => {
  for (const c of searchContractCases) {
    test(c.name, async () => {
      await run(c.run, testPersistence(await tempDataDir()))
    })
  }
})

describe("SQLite persistence satisfies the boot recovery contract", () => {
  for (const c of bootRecoveryContractCases) {
    test(c.name, async () => {
      const killer = recordingKiller()
      await run(c.run, testPersistence(await tempDataDir(), killer.killProcessGroup))
      expect(killer.killed.map((r) => r.pgid)).toEqual([10])
    })
  }
})

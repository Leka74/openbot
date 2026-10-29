import type { BotId, ConversationId, EntryId, Millis, NotificationId } from "@openbot/contracts"
import { DEFAULT_SETTINGS, MAIN_PROFILE_ID } from "@openbot/contracts"
import {
  BootRecovery,
  BotRepo,
  EntryRepo,
  HeldNotificationRepo,
  ProcessLedger,
  readSettings,
  RepoError,
  SettingsRepo,
  TurnRepo,
  writeSettings,
} from "@openbot/core"
import {
  botId,
  conversationId,
  entryId,
  makeBot,
  makeMessageEntry,
  makeTurn,
  SequentialIdGen,
  turnId,
} from "@openbot/core/testing"
import { afterAll, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { killProcessGroup, migrations, Persistence, PersistenceLive } from "../src/index.ts"
import { cleanupTempDirs, recordingKiller, run, tempDataDir, testPersistence } from "./helpers.ts"

afterAll(cleanupTempDirs)

describe("database setup", () => {
  test("creates the database in the data dir with WAL, busy_timeout, synchronous=NORMAL and foreign keys", async () => {
    const dir = await tempDataDir()
    const pragmas = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const [journal] = yield* sql<{ journal_mode: string }>`PRAGMA journal_mode`
        const [busy] = yield* sql<{ timeout: number }>`PRAGMA busy_timeout`
        const [sync] = yield* sql<{ synchronous: number }>`PRAGMA synchronous`
        const [fk] = yield* sql<{ foreign_keys: number }>`PRAGMA foreign_keys`
        return [journal?.journal_mode, busy?.timeout, sync?.synchronous, fk?.foreign_keys]
      }),
      testPersistence(dir),
    )
    expect(pragmas).toEqual(["wal", 5000, 1, 1])
    expect(existsSync(join(dir, "openbot.sqlite"))).toBe(true)
    expect(existsSync(join(dir, "skills-lib", ".claude-plugin", "plugin.json"))).toBe(true)
    expect(existsSync(join(dir, "attachments"))).toBe(true)
  })

  test("migrations are idempotent and data survives reopening", async () => {
    const dir = await tempDataDir()
    const bot = makeBot({ id: botId("bot_keep"), name: "Keeper", createdAt: 1 })
    const notification = { id: "ntf_kept" as NotificationId, kind: "waiting" as const, title: "K", body: "b", at: 1 }
    await run(
      Effect.gen(function* () {
        yield* (yield* BotRepo).upsert(bot)
        yield* (yield* HeldNotificationRepo).hold(MAIN_PROFILE_ID, { notification, needsYou: true }, 500)
      }),
      testPersistence(dir),
    )
    // Reopen the same data dir twice: migrations must not re-run, data must still be there.
    for (let i = 0; i < 2; i++) {
      const [applied, stored, away] = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const rows = yield* sql<{
            migration_id: number
            name: string
          }>`SELECT migration_id, name FROM effect_sql_migrations`
          const keeper = yield* (yield* BotRepo).get(botId("bot_keep"))
          const held = yield* (yield* HeldNotificationRepo).summary(MAIN_PROFILE_ID)
          return [rows.map((r) => `${r.migration_id}_${r.name}`), keeper, held] as const
        }),
        testPersistence(dir),
      )
      expect(applied).toEqual(Object.keys(migrations).map((key) => key.replace(/^0+/, "")))
      expect(Option.getOrUndefined(stored)?.name).toBe("Keeper")
      expect(away.items).toEqual([{ notification, needsYou: true }])
    }
  })

  test("PersistenceLive builds with only IdGen and exposes Persistence.boot", async () => {
    const dir = await tempDataDir()
    const layer = PersistenceLive(dir, { killProcessGroup: () => Effect.succeed(false) }).pipe(
      Layer.provide(SequentialIdGen()),
    )
    const report = await Effect.runPromise(Effect.provide(Persistence.boot, layer))
    expect(report.interruptedTurns).toEqual([])
  })

  test("an unwritable data dir fails the layer with PersistenceError", async () => {
    const layer = PersistenceLive("/proc/openbot-cannot-exist").pipe(Layer.provide(SequentialIdGen()))
    const exit = await Effect.runPromiseExit(Effect.provide(Effect.void, layer))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(exit)).toContain("PersistenceError")
  })
})

describe("payload decoding", () => {
  test("corrupt rows fail loudly with RepoError", async () => {
    const dir = await tempDataDir()
    const exit = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO bots (id, created_at, payload_json) VALUES ('bot_bad', 1, '{"id":"bot_bad"}')`
        return yield* Effect.exit((yield* BotRepo).list)
      }),
      testPersistence(dir),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause)
      expect(error instanceof RepoError).toBe(true)
      expect(error instanceof RepoError ? error.message : "").toContain("Corrupt bot row bot_bad")
    }
  })

  test("entries of unknown kinds (written by a newer build) decode as unknown", async () => {
    const dir = await tempDataDir()
    const entry = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const payload = JSON.stringify({
          id: "ent_future",
          conversationId: "cnv_x",
          revision: 0,
          createdAt: 5,
          updatedAt: 5,
          author: { kind: "system" },
          kind: "hologram",
          sparkle: true,
        })
        yield* sql`INSERT INTO entries (id, conversation_id, revision, created_at, kind, payload_json)
          VALUES ('ent_future', 'cnv_x', 0, 5, 'hologram', ${payload})`
        return yield* (yield* EntryRepo).get(entryId("ent_future"))
      }),
      testPersistence(dir),
    )
    const value = Option.getOrThrow(entry)
    expect(value.kind).toBe("unknown")
    expect(value.kind === "unknown" ? value.originalTag : undefined).toBe("hologram")
  })

  test("settings round-trip through the typed helpers", async () => {
    const dir = await tempDataDir()
    const settings = await run(
      Effect.gen(function* () {
        yield* writeSettings(MAIN_PROFILE_ID, {
          ...DEFAULT_SETTINGS,
          theme: "dark",
          showSteps: false,
          ownerName: "Ada",
        })
        yield* (yield* SettingsRepo).set("brain.ownerTokenHash", { hash: "abc" })
        return yield* readSettings(MAIN_PROFILE_ID)
      }),
      testPersistence(dir),
    )
    expect(settings).toMatchObject({ theme: "dark", showSteps: false, ownerName: "Ada" })
  })

  test("entry paging rejects an invalid cursor", async () => {
    const dir = await tempDataDir()
    const exit = await run(
      Effect.exit(
        Effect.flatMap(EntryRepo, (repo) =>
          repo.page({ conversationId: conversationId("cnv_a"), before: "nope", limit: 5 }),
        ),
      ),
      testPersistence(dir),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("concurrent revision-guarded upserts keep the highest revision", async () => {
    const dir = await tempDataDir()
    const stored = await run(
      Effect.gen(function* () {
        const repo = yield* EntryRepo
        yield* Effect.forEach(
          [3, 1, 5, 2, 4],
          (revision) =>
            repo.upsert(makeMessageEntry({ id: entryId("ent_c"), revision, text: `r${revision}`, createdAt: 1 })),
          { concurrency: "unbounded" },
        )
        return yield* repo.get(entryId("ent_c"))
      }),
      testPersistence(dir),
    )
    const value = Option.getOrThrow(stored)
    expect([value.revision, value.kind === "message" ? value.text : ""]).toEqual([5, "r5"])
  })
})

describe("boot recovery", () => {
  test("marks running turns interrupted and kills ledger process groups (real process)", async () => {
    const dir = await tempDataDir()
    const child = Bun.spawn(["sleep", "30"], { detached: true, stdio: ["ignore", "ignore", "ignore"] })
    const startedAt = Date.now()
    try {
      const layer = testPersistence(dir, killProcessGroup)
      const result = await run(
        Effect.gen(function* () {
          yield* (yield* ProcessLedger).record({
            pid: child.pid,
            pgid: child.pid,
            kind: "other",
            label: "sleep",
            startedAt,
          })
          yield* (yield* TurnRepo).upsert(makeTurn({ id: turnId("trn_live"), status: "running" }))
          const report = yield* (yield* BootRecovery).run
          const turn = yield* (yield* TurnRepo).get(turnId("trn_live"))
          return { report, turn: Option.getOrThrow(turn), ledger: yield* (yield* ProcessLedger).list }
        }),
        layer,
      )
      expect(result.report.killedProcesses.map((r) => r.pid)).toEqual([child.pid])
      expect(result.turn.status).toBe("interrupted")
      expect(result.turn.stopReason).toBe("brain-restart")
      expect(result.ledger).toEqual([])
      expect(await child.exited).not.toBe(0)
      expect(child.signalCode).toBe("SIGKILL")
    } finally {
      child.kill("SIGKILL")
    }
  })

  test("recovery state persists: a second boot on the same data dir finds nothing to do", async () => {
    const dir = await tempDataDir()
    const killer = recordingKiller()
    await run(
      Effect.gen(function* () {
        yield* (yield* TurnRepo).upsert(makeTurn({ id: turnId("trn_a"), status: "waiting" }))
        yield* (yield* EntryRepo).upsert(
          makeMessageEntry({
            id: entryId("ent_s") as EntryId,
            turnId: turnId("trn_a"),
            role: "bot",
            author: { kind: "bot", botId: "bot_test" as BotId },
            streaming: true,
            conversationId: "cnv_test" as ConversationId,
            createdAt: 1 as Millis,
          }),
        )
        const first = yield* (yield* BootRecovery).run
        expect(first.interruptedTurns.length).toBe(1)
        expect(first.updatedEntries.map((e): string => e.id)).toEqual(["ent_s"])
      }),
      testPersistence(dir, killer.killProcessGroup),
    )
    const second = await run(
      Effect.flatMap(BootRecovery, (r) => r.run),
      testPersistence(dir, killer.killProcessGroup),
    )
    expect([second.interruptedTurns.length, second.updatedEntries.length, second.expiredRequests.length]).toEqual([
      0, 0, 0,
    ])
  })
})

describe("killProcessGroup guards", () => {
  const kill = (record: { pid: number; pgid: number; startedAt: number }) =>
    Effect.runSync(killProcessGroup({ ...record, kind: "other" }))

  test("never signals init, process group 0/1 or the brain itself", () => {
    expect(kill({ pid: 1, pgid: 1, startedAt: 0 })).toBe(false)
    expect(kill({ pid: 0, pgid: 0, startedAt: 0 })).toBe(false)
    expect(kill({ pid: process.pid, pgid: process.pid, startedAt: Date.now() })).toBe(false)
  })

  test("refuses a recorded pid that was reused by a process started at a different time", async () => {
    if (!existsSync("/proc/self/stat")) return
    const child = Bun.spawn(["sleep", "30"], { detached: true, stdio: ["ignore", "ignore", "ignore"] })
    try {
      // Recorded as started an hour ago: the live process with that pid is someone else.
      expect(kill({ pid: child.pid, pgid: child.pid, startedAt: Date.now() - 3_600_000 })).toBe(false)
      expect(child.exitCode).toBeNull()
    } finally {
      child.kill("SIGKILL")
      await child.exited
    }
  })

  test("returns false for a group that no longer exists", async () => {
    const child = Bun.spawn(["true"], { detached: true, stdio: ["ignore", "ignore", "ignore"] })
    await child.exited
    expect(kill({ pid: child.pid, pgid: child.pid, startedAt: Date.now() })).toBe(false)
  })
})

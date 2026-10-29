/**
 * `PersistenceLive(dataDir)`: one layer that provides every repository/store port
 * (`RepositoryPorts`) plus `BootRecovery` (architecture §4.4, interfaces §2.1).
 *
 * - SQLite at `<data>/openbot.sqlite` via `@effect/sql-sqlite-bun` (one serialized connection).
 *   PRAGMAs: WAL (client default), busy_timeout=5000, synchronous=NORMAL, foreign_keys=ON.
 * - Migrations (`SqliteMigrator.fromRecord`) run while the layer is built, before any repository
 *   is used; re-running them on an existing database is a no-op.
 * - File stores under the data dir (memory, skills, attachments) with atomic writes.
 * - `BootRecovery.run` applies core's `runBootRecovery` rules inside one transaction, killing
 *   leftover process groups recorded in the `ProcessLedger`.
 *
 * The server runs `(yield* BootRecovery).run` once at boot (or `Persistence.boot`).
 */
import { SqliteClient } from "@effect/sql-sqlite-bun"
import {
  ApprovalRuleRepo,
  AttachmentStore,
  CarryoverStore,
  BootRecovery,
  type BootRecoveryReport,
  BotRepo,
  ConversationRepo,
  type DataDirShape,
  EntryRepo,
  HeldNotificationRepo,
  IdGen,
  makeDataDir,
  McpTokenRepo,
  MemoryStore,
  NodeRepo,
  OwnerProfileRepo,
  ProcessLedger,
  ProfileStorage,
  type ProcessRecord,
  ProfileDirs,
  ReplicaLog,
  RepoError,
  type RepositoryPorts,
  RequestRepo,
  RoutineRepo,
  runBootRecovery,
  SearchRepo,
  SectionRepo,
  SettingsRepo,
  SkillStore,
  TaskRepo,
  TurnRepo,
  UsageRepo,
} from "@openbot/core"
import { MAIN_PROFILE_ID } from "@openbot/contracts"
import { Context, Effect, Layer, Schema } from "effect"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import { describeCause } from "./codec.ts"
import { runMigrations } from "./migrations/index.ts"
import { killProcessGroup as defaultKillProcessGroup } from "./processes.ts"
import { makeSqlBotRepo, makeSqlSectionRepo } from "./repos/bots.ts"
import { makeSqlConversationRepo } from "./repos/conversations.ts"
import { makeSqlEntryRepo } from "./repos/entries.ts"
import { makeSqlNodeRepo } from "./repos/nodes.ts"
import { makeSqlHeldNotificationRepo } from "./repos/held.ts"
import { makeSqlOwnerProfileRepo } from "./repos/profiles.ts"
import { makeSqlProfileStorage } from "./repos/profileStorage.ts"
import { makeSqlReplicaLog } from "./repos/replica.ts"
import { makeSqlRoutineRepo } from "./repos/routines.ts"
import { makeSqlSearchRepo } from "./repos/search.ts"
import { makeSqlApprovalRuleRepo, makeSqlSettingsRepo, makeSqlUsageRepo } from "./repos/settings.ts"
import { makeSqlMcpTokenRepo, makeSqlProcessLedger } from "./repos/system.ts"
import { makeSqlTaskRepo } from "./repos/tasks.ts"
import { makeSqlRequestRepo, makeSqlTurnRepo } from "./repos/turns.ts"
import { makeFileAttachmentStore } from "./stores/attachmentStore.ts"
import { makeFileCarryoverStore } from "./stores/carryoverStore.ts"
import { ensureDirectory } from "./stores/files.ts"
import { makeFileMemoryStore } from "./stores/memoryStore.ts"
import { makeProfileDirs } from "./stores/profileDirs.ts"
import { makeFileSkillStore } from "./stores/skillStore.ts"

/** Building the persistence layer failed (data dir not writable, database unreadable, migration failed). */
export class PersistenceError extends Schema.TaggedError<PersistenceError>()("PersistenceError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface PersistenceOptions {
  /** Database file; defaults to `<dataDir>/openbot.sqlite`. `":memory:"` works for throwaway databases. */
  readonly filename?: string | undefined
  /** Kills a leftover process group at boot; defaults to SIGKILL with pid-reuse guards (`processes.ts`). */
  readonly killProcessGroup?: ((record: ProcessRecord) => Effect.Effect<boolean>) | undefined
}

const toPersistenceError = (message: string) => (cause: unknown) =>
  new PersistenceError({ message: `${message}: ${describeCause(cause)}`, cause })

/** Applies the connection PRAGMAs that the client does not set itself (WAL + busy_timeout are client options). */
const configureConnection = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`PRAGMA synchronous = NORMAL`
  yield* sql`PRAGMA foreign_keys = ON`
})

/**
 * SQLite client for the data dir, configured and migrated. Provides `SqlClient` and the Bun
 * `SqliteClient` (for diagnostics/tests); the repositories need only `SqlClient`.
 */
export const PersistenceSqlLive = (
  dataDir: string,
  options?: Pick<PersistenceOptions, "filename">,
): Layer.Layer<SqlClient.SqlClient | SqliteClient.SqliteClient, PersistenceError> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const dirs = makeDataDir(dataDir)
      yield* ensureDirectory("Persistence.init", dirs.root).pipe(
        Effect.mapError(toPersistenceError("Cannot create the data dir")),
      )
      const client = yield* SqliteClient.make({
        filename: options?.filename ?? dirs.database,
        busyTimeout: "5 seconds",
      }).pipe(Effect.mapError(toPersistenceError("Cannot open the database")))
      yield* configureConnection.pipe(
        Effect.provideService(SqlClient.SqlClient, client),
        Effect.mapError(toPersistenceError("Cannot configure the database")),
      )
      yield* runMigrations.pipe(
        Effect.provideService(SqlClient.SqlClient, client),
        Effect.mapError(toPersistenceError("Database migration failed")),
      )
      return Context.make(SqliteClient.SqliteClient, client).pipe(Context.add(SqlClient.SqlClient, client))
    }),
  ).pipe(Layer.provide(Reactivity.layer))

/** Every repository/store port over an existing `SqlClient` (already migrated) and the data dir's files. */
export const makeRepositories = (
  dirs: DataDirShape,
): Effect.Effect<Context.Context<RepositoryPorts>, RepoError, SqlClient.SqlClient | IdGen> =>
  Effect.gen(function* () {
    const main = dirs.profile(MAIN_PROFILE_ID)
    yield* ensureDirectory("Persistence.init", main.attachments)
    yield* ensureDirectory("Persistence.init", main.skillsLib)
    const skills = yield* makeFileSkillStore(dirs)
    return Context.make(BotRepo, yield* makeSqlBotRepo)
      .pipe(
        Context.add(SectionRepo, yield* makeSqlSectionRepo),
        Context.add(ConversationRepo, yield* makeSqlConversationRepo),
        Context.add(EntryRepo, yield* makeSqlEntryRepo),
        Context.add(SearchRepo, yield* makeSqlSearchRepo),
        Context.add(RequestRepo, yield* makeSqlRequestRepo),
        Context.add(TurnRepo, yield* makeSqlTurnRepo),
        Context.add(TaskRepo, yield* makeSqlTaskRepo),
        Context.add(RoutineRepo, yield* makeSqlRoutineRepo),
        Context.add(NodeRepo, yield* makeSqlNodeRepo),
        Context.add(OwnerProfileRepo, yield* makeSqlOwnerProfileRepo),
        Context.add(ProfileStorage, yield* makeSqlProfileStorage),
        Context.add(HeldNotificationRepo, yield* makeSqlHeldNotificationRepo),
        Context.add(ApprovalRuleRepo, yield* makeSqlApprovalRuleRepo),
        Context.add(SettingsRepo, yield* makeSqlSettingsRepo),
        Context.add(UsageRepo, yield* makeSqlUsageRepo),
        Context.add(ReplicaLog, yield* makeSqlReplicaLog()),
        Context.add(McpTokenRepo, yield* makeSqlMcpTokenRepo),
        Context.add(ProcessLedger, yield* makeSqlProcessLedger),
      )
      .pipe(
        Context.add(MemoryStore, yield* makeFileMemoryStore(dirs)),
        Context.add(SkillStore, skills),
        Context.add(AttachmentStore, yield* makeFileAttachmentStore(dirs)),
        Context.add(CarryoverStore, yield* makeFileCarryoverStore(dirs)),
        Context.add(ProfileDirs, makeProfileDirs(dirs)),
      )
  })

/**
 * `BootRecovery` over the given repositories: core's D2.5 rules, run in one SQLite transaction so a
 * crash mid-recovery leaves the database untouched (recovery is idempotent and simply re-runs).
 */
export const makeBootRecovery = (
  repositories: Context.Context<RepositoryPorts>,
  options?: Pick<PersistenceOptions, "killProcessGroup">,
): Effect.Effect<BootRecovery["Service"], never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const run: Effect.Effect<BootRecoveryReport, RepoError> = runBootRecovery({
      killProcessGroup: options?.killProcessGroup ?? defaultKillProcessGroup,
    }).pipe(
      sql.withTransaction,
      Effect.provideContext(repositories),
      Effect.mapError((cause) =>
        cause instanceof RepoError
          ? cause
          : new RepoError({ op: "BootRecovery.run", message: describeCause(cause), cause }),
      ),
      Effect.withSpan("BootRecovery.run"),
    )
    return BootRecovery.of({ run })
  })

/** Repositories + `BootRecovery` over a provided `SqlClient` (see `PersistenceSqlLive`). */
export const PersistenceRepositoriesLive = (
  dataDir: string,
  options?: Pick<PersistenceOptions, "killProcessGroup">,
): Layer.Layer<RepositoryPorts | BootRecovery, PersistenceError, SqlClient.SqlClient | IdGen> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const repositories = yield* makeRepositories(makeDataDir(dataDir)).pipe(
        Effect.mapError(toPersistenceError("Cannot initialize the stores")),
      )
      const recovery = yield* makeBootRecovery(repositories, options)
      return Context.add(repositories, BootRecovery, recovery)
    }),
  )

/** The whole persistence layer for a data dir (what the server composes). */
export const PersistenceLive = (
  dataDir: string,
  options?: PersistenceOptions,
): Layer.Layer<RepositoryPorts | BootRecovery, PersistenceError, IdGen> =>
  PersistenceRepositoriesLive(dataDir, options).pipe(Layer.provide(PersistenceSqlLive(dataDir, options)))

/** Convenience accessors (architecture §4.4 `Persistence.boot`). */
export const Persistence = {
  /** Runs boot recovery once: kill leftover process groups, interrupt turns, expire pending requests. */
  boot: Effect.flatMap(BootRecovery, (recovery) => recovery.run),
} as const

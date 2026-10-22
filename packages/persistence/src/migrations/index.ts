/**
 * Migrations, statically imported (architecture §4.4: `SqliteMigrator.fromRecord`). Keys are
 * `<id>_<name>`; the migrator records applied ids in `effect_sql_migrations` and runs each once.
 * Never edit a released migration: add a new one.
 */
import { SqliteMigrator } from "@effect/sql-sqlite-bun"
import Initial from "./0001_initial.ts"
import OneMindPerBot from "./0002_one_mind_per_bot.ts"
import BackgroundTasks from "./0003_background_tasks.ts"
import MessageSearch from "./0004_message_search.ts"

export const migrations = {
  "0001_initial": Initial,
  "0002_one_mind_per_bot": OneMindPerBot,
  "0003_background_tasks": BackgroundTasks,
  "0004_message_search": MessageSearch,
} as const

export const migrationLoader = SqliteMigrator.fromRecord(migrations)

/** Applies pending migrations; returns the `[id, name]` pairs applied by this run. */
export const runMigrations = SqliteMigrator.run({ loader: migrationLoader })

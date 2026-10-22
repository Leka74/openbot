/**
 * @openbot/persistence — SQLite repositories, migrations, file stores (memory, skills,
 * attachments), boot recovery and the process ledger (architecture §4.4).
 *
 * The server composes `PersistenceLive(dataDir)`; everything else is exported for tests and tools.
 */
export * from "./PersistenceLive.ts"
export { migrations, runMigrations } from "./migrations/index.ts"
export { killProcessGroup, processStartTimeMs, START_TIME_TOLERANCE_MS } from "./processes.ts"
export { decodeEntryCursor, encodeEntryCursor } from "./repos/entries.ts"
export { SEARCH_VERSION_KEY } from "./repos/search.ts"
export { MEMORY_INDEX_FILE } from "./stores/memoryStore.ts"
export { PLUGIN_MANIFEST, pluginManifest, SKILL_FILE } from "./stores/skillStore.ts"
export { parseFrontmatter, renderFrontmatter } from "./stores/frontmatter.ts"

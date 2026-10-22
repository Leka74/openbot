/**
 * @openbot/core — ports (§3), domain service shapes and implementations (§4.3).
 * Test doubles live at the subpath `@openbot/core/testing`.
 *
 * Core never imports an SDK, SQL, React, `Bun.*` or `node:*` (AGENTS.md).
 */
export * from "./ports/index.ts"
export * from "./services/conversation/index.ts"
export * from "./services/automation/index.ts"
export * from "./services/search/index.ts"

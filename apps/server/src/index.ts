/**
 * @openbot/server — the brain's composition root (architecture §4.9). `src/main.ts` is the CLI entry;
 * these exports are for tests and embedding.
 */
export * from "./auth.ts"
export * from "./config.ts"
export * from "./listeners.ts"
export * from "./routes.ts"
export * from "./profiles.ts"
export * from "./rpc.ts"
export * from "./server.ts"
export * from "./shutdown.ts"
export * from "./stt/engine.ts"
export * from "./stt/manifest.ts"
export * from "./stt/service.ts"
export * from "./web.ts"

/**
 * @openbot/harness-claude — the Claude Agent SDK harness adapter (architecture §4.5 Claude; D2.1).
 *
 * Public surface is SDK-type-free: the injectable `query` is the structural `ClaudeQueryFunction`.
 */
export {
  CLAUDE_CAPABILITIES,
  type ClaudeHarnessConfig,
  ClaudeHarnessLive,
  claudeDriver,
  type DriverDeps,
  makeClaudeDriver,
  resolveExecutable,
} from "./Driver.ts"
export { cleanEnv, DISALLOWED_NATIVE_TOOLS, PREAPPROVED_TOOLS } from "./config.ts"
export { ClaudeEventPipeline, type PipelineOptions, type PipelineOutput } from "./normalize.ts"
export { parseAccountInfo, parseAuth, parseInitialization, parseModels } from "./probe.ts"
export {
  canonicalClaudeDir,
  type ClaudeConfigDirCandidate,
  type ClaudeProfile,
  claudeStateFile,
  defaultClaudeConfigDir,
  discoverClaudeConfigDirs,
  looksLikeClaudeConfigDir,
  parseClaudeState,
  profileEnv,
  readClaudeAccount,
} from "./profile.ts"
export type { ClaudeQueryFunction, ClaudeQueryHandle, ClaudeQueryParams } from "./sdk.ts"
export { bundledClaudeExecutable, type ClaudeSignInInput, startClaudeSignIn } from "./signIn.ts"
export { openClaudeSession, type SessionDeps } from "./Session.ts"

/**
 * The seam between OpenBot and `@anthropic-ai/claude-agent-sdk`.
 *
 * The adapter talks to the SDK only through `ClaudeQueryFunction`, a structural, SDK-type-free
 * subset of `query()`, so that:
 * - tests inject a fake `query` that replays recorded frames (architecture §8);
 * - SDK types never leave this package (AGENTS.md) — the public config mentions only these types.
 *
 * Output frames are treated as `unknown` and parsed defensively by the normalizer: the SDK message
 * union grows over time and unknown types must be ignored (sdk-claude.md §13).
 */
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk"

/** A running `query()`: an async iterator of SDK frames plus the control methods OpenBot uses. */
export interface ClaudeQueryHandle extends AsyncIterator<unknown, void> {
  readonly interrupt: () => Promise<unknown>
  readonly close: () => void
  readonly setMcpServers: (servers: Record<string, unknown>) => Promise<unknown>
  readonly initializationResult: () => Promise<unknown>
  readonly getContextUsage: () => Promise<unknown>
  /**
   * The structured data behind `/usage` (SDK `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`:
   * experimental, so quota.ts parses the answer defensively). Absent on SDKs and fakes without it.
   */
  readonly usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?:
    ((opts?: { readonly skipBehaviors?: boolean }) => Promise<unknown>) | undefined
}

export interface ClaudeQueryParams {
  /** Streaming input (SDK `AsyncIterable<SDKUserMessage>`). */
  readonly prompt: AsyncIterable<unknown>
  /** SDK `Options`, built by `config.ts`. */
  readonly options: Readonly<Record<string, unknown>>
}

/** Structural `query()`; the default is the SDK's. Inject a fake for tests. */
export type ClaudeQueryFunction = (params: ClaudeQueryParams) => ClaudeQueryHandle

/** The SDK's `query`, adapted to the structural seam. */
export const defaultQuery: ClaudeQueryFunction = (params) =>
  sdkQuery({
    prompt: params.prompt as AsyncIterable<SDKUserMessage>,
    options: params.options as Options,
  }) as unknown as ClaudeQueryHandle

/** Iterate the Query object itself, not `q[Symbol.asyncIterator]()` (t3code ClaudeAdapterV2:511-519). */
export const queryMessages = (handle: ClaudeQueryHandle): AsyncIterable<unknown> => ({
  [Symbol.asyncIterator]: () => handle,
})

export type { Options as SdkOptions, SDKUserMessage as SdkUserMessage }

/**
 * Install/version/auth probe without a model call (D2.6; sdk-claude.md §7 "free capability probe";
 * port of t3code `probeClaudeCapabilities`, ClaudeProvider.ts:377-470, MIT).
 *
 * `query()` is started with a prompt iterable that never yields, so nothing reaches the API;
 * `initializationResult()` returns the account, the model catalog and the CLI version. The query is
 * then aborted and closed.
 */
import type { HarnessAccount, HarnessCapabilities, HarnessStatus, ModelInfo } from "@openbot/contracts"
import { Clock, Effect, Option } from "effect"
import type { ClaudeQueryFunction, ClaudeQueryHandle } from "./sdk.ts"

export const PROBE_TIMEOUT_MS = 25_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined

export interface ParsedInitialization {
  readonly version: string | undefined
  readonly auth: HarnessStatus["auth"]
  readonly account: HarnessAccount | undefined
  readonly models: ReadonlyArray<ModelInfo>
  readonly problems: ReadonlyArray<string>
}

const PROVIDER_LABELS: Record<string, string> = {
  bedrock: "Amazon Bedrock",
  anthropicAws: "Amazon Bedrock",
  vertex: "Google Vertex AI",
  anthropicGoogleCloud: "Google Vertex AI",
  foundry: "Microsoft Foundry",
  mantle: "Mantle",
  gateway: "Enterprise gateway",
}

/**
 * Auth from `AccountInfo` (t3code `claudeAuthStatus`): `tokenSource: "none"` with no API key,
 * email or subscription is the only proof of "signed out"; silence is not disproof.
 */
export const parseAuth = (account: unknown): HarnessStatus["auth"] => {
  const a = isRecord(account) ? account : {}
  const email = str(a.email)
  const organization = str(a.organization)
  const subscription = str(a.subscriptionType)
  const tokenSource = str(a.tokenSource)
  const apiKeySource = str(a.apiKeySource)
  const provider = str(a.apiProvider)
  if (provider !== undefined && provider !== "firstParty") {
    return { state: "signed-in", label: PROVIDER_LABELS[provider] ?? provider }
  }
  const hasApiKey = apiKeySource !== undefined && apiKeySource !== "none"
  if (tokenSource === "none" && !hasApiKey && !email && !subscription) return { state: "signed-out" }
  const who = email ?? organization
  const label =
    who !== undefined
      ? subscription !== undefined
        ? `${who} (${subscription})`
        : who
      : (subscription ?? (hasApiKey ? "API key" : undefined))
  if (label === undefined && tokenSource === undefined && !hasApiKey) return { state: "unknown" }
  return { state: "signed-in", ...(label !== undefined ? { label } : {}) }
}

/** The account fields of `AccountInfo` (email, subscription, organization); never a token. */
export const parseAccountInfo = (account: unknown): HarnessAccount | undefined => {
  const a = isRecord(account) ? account : {}
  const email = str(a.email)
  const plan = str(a.subscriptionType)
  const organization = str(a.organization)
  if (email === undefined && plan === undefined && organization === undefined) return undefined
  return {
    ...(email !== undefined ? { email } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(organization !== undefined ? { organization } : {}),
  }
}

export const parseModels = (models: unknown): ReadonlyArray<ModelInfo> => {
  if (!Array.isArray(models)) return []
  const seen = new Set<string>()
  return models.flatMap((entry): ReadonlyArray<ModelInfo> => {
    if (!isRecord(entry)) return []
    const id = str(entry.value)
    if (id === undefined || seen.has(id)) return []
    seen.add(id)
    const efforts = Array.isArray(entry.supportedEffortLevels)
      ? entry.supportedEffortLevels.filter((e): e is string => typeof e === "string")
      : []
    return [
      {
        id,
        label: str(entry.displayName) ?? id,
        ...(id === "default" ? { default: true } : {}),
        ...(efforts.length > 0 ? { efforts } : {}),
      },
    ]
  })
}

/** Parses `SDKControlInitializeResponse`. */
export const parseInitialization = (init: unknown): ParsedInitialization => {
  const i = isRecord(init) ? init : {}
  const auth = parseAuth(i.account)
  return {
    version: str(i.claude_code_version),
    auth,
    account: auth.state === "signed-out" ? undefined : parseAccountInfo(i.account),
    models: parseModels(i.models),
    problems:
      auth.state === "signed-out" ? ["Claude is not signed in. Run `claude auth login` on the brain machine."] : [],
  }
}

const NOT_INSTALLED = /native cli binary|not found|enoent|no such file/i

export const describeProbeError = (cause: unknown): { readonly installed: boolean; readonly problem: string } => {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (NOT_INSTALLED.test(message)) {
    return { installed: false, problem: `Claude Code CLI not found (${message.split("\n")[0]})` }
  }
  return { installed: true, problem: `Claude probe failed: ${message.split("\n")[0]}` }
}

/** Extracts `2.1.280` from `claude --version` output (`2.1.280 (Claude Code)`). */
export const parseCliVersion = (text: string): string | undefined => /\b(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/.exec(text)?.[1]

/**
 * `<executable> --version` (no model call). Older CLIs (2.1.280) omit `claude_code_version` from the
 * initialize response; the SDK's bundled CLI reports it, so this is only needed for a user binary.
 */
export const readCliVersion = async (
  executable: string,
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs = 5000,
): Promise<string | undefined> => {
  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) childEnv[key] = value
  try {
    const proc = Bun.spawn([executable, "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: childEnv,
    })
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs)
    try {
      const text = await new Response(proc.stdout).text()
      await proc.exited
      return parseCliVersion(text)
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return undefined
  }
}

export interface ProbeInput extends IdleQueryInput {
  readonly capabilities: HarnessCapabilities
  /** Version fallback when the initialize response has none (default: `readCliVersion(executable)`). */
  readonly cliVersion?: (() => Promise<string | undefined>) | undefined
}

export interface ProbeResult {
  readonly status: HarnessStatus
  readonly models: ReadonlyArray<ModelInfo> | undefined
}

const waitForAbort = (signal: AbortSignal): Promise<void> =>
  signal.aborted
    ? Promise.resolve()
    : new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))

export interface IdleQueryInput {
  readonly query: ClaudeQueryFunction
  readonly env: Record<string, string | undefined>
  readonly executable?: string | undefined
  readonly cwd?: string | undefined
  readonly timeoutMs?: number | undefined
}

export type IdleQueryOutcome<A> = { readonly value: A } | { readonly error: unknown }

/**
 * Starts a `query()` whose prompt never yields (nothing reaches the API), hands the initialized
 * query to `use`, then aborts and closes it. Never fails: errors and the timeout come back as `error`.
 */
export const withIdleQuery = <A>(
  input: IdleQueryInput,
  use: (handle: ClaudeQueryHandle, init: unknown) => Promise<A>,
): Effect.Effect<IdleQueryOutcome<A>> => {
  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS
  return Effect.callback<IdleQueryOutcome<A>>((resume) => {
    const abort = new AbortController()
    let handle: ClaudeQueryHandle | undefined
    const cleanup = () => {
      if (!abort.signal.aborted) abort.abort()
      try {
        handle?.close()
      } catch {
        // already closed
      }
    }
    try {
      const started = input.query({
        // Never yields: no prompt reaches the API.
        // oxlint-disable-next-line require-yield
        prompt: (async function* (): AsyncGenerator<never> {
          await waitForAbort(abort.signal)
        })(),
        options: {
          persistSession: false,
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {},
          settings: { disableAllHooks: true },
          env: input.env,
          abortController: abort,
          stderr: () => {},
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.executable !== undefined ? { pathToClaudeCodeExecutable: input.executable } : {}),
        },
      })
      handle = started
      started
        .initializationResult()
        .then((init) => use(started, init))
        .then(
          (value) => {
            cleanup()
            resume(Effect.succeed({ value }))
          },
          (error: unknown) => {
            cleanup()
            resume(Effect.succeed({ error }))
          },
        )
    } catch (error) {
      cleanup()
      resume(Effect.succeed({ error }))
    }
    return Effect.sync(cleanup)
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: (): Effect.Effect<IdleQueryOutcome<A>> =>
        Effect.succeed({ error: new Error(`Claude did not answer within ${Math.round(timeoutMs / 1000)} s`) }),
    }),
  )
}

/** Never fails; never calls the model. */
export const runProbe = (input: ProbeInput): Effect.Effect<ProbeResult> =>
  Effect.gen(function* () {
    const idle = yield* withIdleQuery(input, (_handle, init) => Promise.resolve(init))
    const outcome: { readonly init?: unknown; readonly error?: unknown } =
      "value" in idle ? { init: idle.value } : { error: idle.error }
    const checkedAt = yield* Clock.currentTimeMillis
    const base = { kind: "claude", displayName: "Claude", capabilities: input.capabilities, checkedAt } as const
    if (outcome.error !== undefined || outcome.init === undefined) {
      const { installed, problem } = describeProbeError(outcome.error ?? "no initialization result")
      return { status: { ...base, installed, auth: { state: "unknown" }, problems: [problem] }, models: undefined }
    }
    const parsed = parseInitialization(outcome.init)
    const fallback =
      input.cliVersion ??
      (input.executable !== undefined ? () => readCliVersion(input.executable!, input.env) : undefined)
    const version =
      parsed.version ??
      (fallback
        ? yield* Effect.promise(fallback).pipe(Effect.timeoutOption(5000), Effect.map(Option.getOrUndefined))
        : undefined)
    return {
      status: {
        ...base,
        installed: true,
        ...(version !== undefined ? { version } : {}),
        auth: parsed.auth,
        ...(parsed.account !== undefined ? { account: parsed.account } : {}),
        problems: [...parsed.problems],
      },
      models: parsed.models,
    }
  })

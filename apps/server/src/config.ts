/**
 * Server configuration (architecture §4.9): CLI flags with `OPENBOT_*` environment equivalents.
 * CLI beats environment beats defaults. Pure (no I/O) so it is unit-testable.
 *
 * | Flag | Env | Default |
 * |---|---|---|
 * | `--data-dir <path>` | `OPENBOT_DATA_DIR` | `$XDG_DATA_HOME/openbot`, else `~/.local/share/openbot` |
 * | `--port <n>` | `OPENBOT_PORT` | `7420` (`0` = ephemeral) |
 * | `--host <host>` | `OPENBOT_HOST` | `127.0.0.1` |
 * | `--public-origin <url>` (repeatable) | `OPENBOT_PUBLIC_ORIGIN` (comma separated) | none |
 * | `--no-local-node` | `OPENBOT_LOCAL_NODE=0` | local node on |
 * | `--dev` | `OPENBOT_DEV=1` | off |
 * | `--harness <list>` (repeatable, comma separated) | `OPENBOT_HARNESSES` | `fake,claude,codex,opencode` |
 * | `--claude-path <path>` | `OPENBOT_CLAUDE_PATH` | the Agent SDK's bundled CLI (version-matched) |
 * | `--max-file-mb <n>` | `OPENBOT_MAX_FILE_MB` | `200` (largest file a bot may send with `send_file`) |
 * | `--desktop-idle <minutes>` | `OPENBOT_DESKTOP_IDLE_MINUTES` | `10` (an unused bot desktop goes to sleep; `0` = never) |
 * | (env only) | `OPENBOT_SKILLS_SH_URL` | `https://skills.sh` (the skills catalog; tests point it at a fake) |
 * | (env only) | `OPENBOT_SLACK_API_URL` | `https://slack.com/api` (Slack's Web API; tests point it at a fake) |
 * | (env only) | `OPENBOT_HARK_URL` | `https://hark.ryan.ceo` (iPhone notifications; tests point it at a fake) |
 */
import { KnownHarnessKinds } from "@openbot/contracts"
import { Context, Layer } from "effect"

/** Brain version (mirrors apps/server/package.json). Sent in `node.hello` and `session.info`. */
export const OPENBOT_VERSION = "0.0.0"

export const DEFAULT_PORT = 7420
export const DEFAULT_HOST = "127.0.0.1"
/** Harnesses registered by default: fake always, the real ones report install/auth through their probes. */
export const DEFAULT_HARNESSES: ReadonlyArray<HarnessName> = ["fake", "claude", "codex", "opencode"]

export type HarnessName = "fake" | "claude" | "codex" | "opencode"

export interface ServerConfigShape {
  /** Absolute data root. */
  readonly dataDir: string
  /** Public listener port (`0` = ephemeral, tests). */
  readonly port: number
  /** Public listener bind address. */
  readonly host: string
  /** Extra origins the brain is reachable at (Tailscale serve, reverse proxy): `scheme://host[:port]`. */
  readonly publicOrigins: ReadonlyArray<string>
  /** Run the in-process local node (`node_local`). */
  readonly localNode: boolean
  /** Bun dev server: HMR + browser console forwarding for the web app. */
  readonly dev: boolean
  /** Harness drivers to register. `fake` is always included. */
  readonly harnesses: ReadonlyArray<HarnessName>
  /** Claude Code CLI: an absolute path, or `undefined` for the SDK's bundled CLI. */
  readonly claudePath: string | undefined
  /** Largest file a bot may send (`send_file`), bytes; absent = core's default (200 MB). */
  readonly maxFileBytes?: number | undefined
  /** skills.sh base URL (D5.5 import); absent = https://skills.sh. */
  readonly skillsShUrl?: string | undefined
  /** Slack Web API base URL (D3.4); absent = https://slack.com/api. */
  readonly slackApiUrl?: string | undefined
  /** Hark's address (D3.5); absent = https://hark.ryan.ceo. */
  readonly harkUrl?: string | undefined
  /** An unused bot desktop sleeps after this long, ms (0 = never); absent = 10 min. */
  readonly desktopIdleMs?: number | undefined
}

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()("openbot/server/ServerConfig") {
  static readonly layer = (config: ServerConfigShape): Layer.Layer<ServerConfig> => Layer.succeed(ServerConfig, config)
}

export class ConfigError extends Error {
  override readonly name = "ConfigError"
}

export const USAGE = `Usage: openbot [options]

Options:
  --data-dir <path>       Data directory (default: $XDG_DATA_HOME/openbot or ~/.local/share/openbot)
  --port <n>              Public port (default: ${DEFAULT_PORT}; 0 = pick a free port)
  --host <host>           Bind address (default: ${DEFAULT_HOST})
  --public-origin <url>   Extra origin the brain is reached at, e.g. https://box.tailnet.ts.net (repeatable)
  --no-local-node         Do not run this machine as a node
  --dev                   Development mode (hot module reloading for the web app)
  --harness <list>        Harnesses to enable, comma separated (default: ${DEFAULT_HARNESSES.join(",")}; fake is always on)
  --claude-path <path>    Claude Code CLI to use (default: the Agent SDK's bundled CLI)
  --max-file-mb <n>       Largest file a bot may send to you with send_file, in MB (default: 200)
  --desktop-idle <min>    Put an unused bot desktop to sleep after this many minutes (default: 10; 0 = never)
  -h, --help              Show this help
  -v, --version           Show the version

Every option also reads an OPENBOT_* environment variable (OPENBOT_DATA_DIR, OPENBOT_PORT, OPENBOT_HOST,
OPENBOT_PUBLIC_ORIGIN, OPENBOT_LOCAL_NODE=0, OPENBOT_DEV=1, OPENBOT_HARNESSES, OPENBOT_CLAUDE_PATH, OPENBOT_MAX_FILE_MB,
OPENBOT_DESKTOP_IDLE_MINUTES).`

export type Env = Readonly<Record<string, string | undefined>>

export type ParsedCommand =
  | { readonly _tag: "Run"; readonly config: ServerConfigShape }
  | { readonly _tag: "Help" }
  | { readonly _tag: "Version" }

const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path)

/** `~` expansion and absolute resolution against `cwd` (POSIX paths). */
export const resolvePath = (path: string, home: string, cwd: string): string => {
  const expanded = path === "~" ? home : path.startsWith("~/") ? `${home}/${path.slice(2)}` : path
  if (expanded.startsWith("/")) return trimSlash(expanded.replace(/\/{2,}/g, "/"))
  const parts = `${cwd}/${expanded}`.split("/")
  const out: Array<string> = []
  for (const part of parts) {
    if (part === "" || part === ".") continue
    if (part === "..") out.pop()
    else out.push(part)
  }
  return `/${out.join("/")}`
}

/** Default data dir: `$XDG_DATA_HOME/openbot`, else `~/.local/share/openbot`. */
export const defaultDataDir = (env: Env, home: string): string => {
  const xdg = env["XDG_DATA_HOME"]
  return xdg !== undefined && xdg.trim() !== "" && xdg.startsWith("/")
    ? `${trimSlash(xdg)}/openbot`
    : `${trimSlash(home)}/.local/share/openbot`
}

/** `https://Box.example:443/x` → `https://box.example`. Throws `ConfigError` for anything but http(s). */
export const normalizeOrigin = (input: string): string => {
  let url: URL
  try {
    url = new URL(input.includes("://") ? input : `https://${input}`)
  } catch {
    throw new ConfigError(`--public-origin: "${input}" is not a URL`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`--public-origin: "${input}" must be an http(s) origin`)
  }
  return url.origin
}

const parsePort = (value: string, from: string): number => {
  if (!/^\d+$/.test(value.trim())) throw new ConfigError(`${from}: "${value}" is not a port number`)
  const port = Number(value)
  if (port < 0 || port > 65_535) throw new ConfigError(`${from}: ${port} is out of range (0-65535)`)
  return port
}

const parseBool = (value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined
  const v = value.trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(v)) return true
  if (["0", "false", "no", "off", ""].includes(v)) return false
  return undefined
}

const isHarnessName = (name: string): name is HarnessName => (KnownHarnessKinds as ReadonlyArray<string>).includes(name)

const parseHarnesses = (values: ReadonlyArray<string>, from: string): ReadonlyArray<HarnessName> => {
  const names = values.flatMap((v) => v.split(",")).map((v) => v.trim().toLowerCase()).filter((v) => v !== "")
  const out: Array<HarnessName> = ["fake"]
  for (const name of names) {
    if (name === "all") {
      for (const h of DEFAULT_HARNESSES) if (!out.includes(h)) out.push(h)
      continue
    }
    if (!isHarnessName(name)) {
      throw new ConfigError(`${from}: unknown harness "${name}" (expected ${DEFAULT_HARNESSES.join(", ")})`)
    }
    if (!out.includes(name)) out.push(name)
  }
  return out
}

const VALUE_FLAGS = ["--data-dir", "--port", "--host", "--public-origin", "--harness", "--claude-path", "--max-file-mb", "--desktop-idle"] as const
type ValueFlag = (typeof VALUE_FLAGS)[number]

/**
 * Parses `argv` (without the runtime and script) and the environment. Throws `ConfigError` with a
 * human message on bad input.
 */
export const parseCommand = (
  argv: ReadonlyArray<string>,
  env: Env,
  system: { readonly home: string; readonly cwd: string },
): ParsedCommand => {
  const values: Record<ValueFlag, Array<string>> = {
    "--data-dir": [],
    "--port": [],
    "--host": [],
    "--public-origin": [],
    "--harness": [],
    "--claude-path": [],
    "--max-file-mb": [],
    "--desktop-idle": [],
  }
  let dev: boolean | undefined
  let localNode: boolean | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "-h" || arg === "--help") return { _tag: "Help" }
    if (arg === "-v" || arg === "--version") return { _tag: "Version" }
    if (arg === "--dev") {
      dev = true
      continue
    }
    if (arg === "--no-dev") {
      dev = false
      continue
    }
    if (arg === "--no-local-node") {
      localNode = false
      continue
    }
    if (arg === "--local-node") {
      localNode = true
      continue
    }
    const eq = arg.indexOf("=")
    const name = (eq === -1 ? arg : arg.slice(0, eq)) as ValueFlag
    if (!(VALUE_FLAGS as ReadonlyArray<string>).includes(name)) {
      throw new ConfigError(`unknown option "${arg}" (see --help)`)
    }
    let value: string | undefined
    if (eq !== -1) value = arg.slice(eq + 1)
    else {
      value = argv[i + 1]
      if (value === undefined || value.startsWith("--")) throw new ConfigError(`${name} needs a value`)
      i++
    }
    values[name].push(value)
  }

  const last = (flag: ValueFlag, envName: string): { value: string; from: string } | undefined => {
    const fromCli = values[flag].at(-1)
    if (fromCli !== undefined) return { value: fromCli, from: flag }
    const fromEnv = env[envName]
    return fromEnv !== undefined && fromEnv.trim() !== "" ? { value: fromEnv, from: envName } : undefined
  }

  const dataDirInput = last("--data-dir", "OPENBOT_DATA_DIR")
  const dataDir = dataDirInput === undefined
    ? defaultDataDir(env, system.home)
    : resolvePath(dataDirInput.value.trim(), system.home, system.cwd)

  const portInput = last("--port", "OPENBOT_PORT")
  const port = portInput === undefined ? DEFAULT_PORT : parsePort(portInput.value, portInput.from)

  const host = last("--host", "OPENBOT_HOST")?.value.trim() ?? DEFAULT_HOST

  const originInputs = values["--public-origin"].length > 0
    ? values["--public-origin"]
    : (env["OPENBOT_PUBLIC_ORIGIN"] ?? "").split(",")
  const publicOrigins: Array<string> = []
  for (const raw of originInputs) {
    if (raw.trim() === "") continue
    const origin = normalizeOrigin(raw.trim())
    if (!publicOrigins.includes(origin)) publicOrigins.push(origin)
  }

  const harnessInputs = values["--harness"].length > 0
    ? { list: values["--harness"], from: "--harness" }
    : env["OPENBOT_HARNESSES"] !== undefined && env["OPENBOT_HARNESSES"].trim() !== ""
    ? { list: [env["OPENBOT_HARNESSES"]], from: "OPENBOT_HARNESSES" }
    : undefined
  const harnesses = harnessInputs === undefined ? DEFAULT_HARNESSES : parseHarnesses(harnessInputs.list, harnessInputs.from)

  const claudeInput = last("--claude-path", "OPENBOT_CLAUDE_PATH")
  const claudePath = claudeInput === undefined || claudeInput.value.trim() === "bundled"
    ? undefined
    : resolvePath(claudeInput.value.trim(), system.home, system.cwd)

  const maxFileInput = last("--max-file-mb", "OPENBOT_MAX_FILE_MB")
  let maxFileBytes: number | undefined
  if (maxFileInput !== undefined) {
    const mb = Number(maxFileInput.value.trim())
    if (!Number.isFinite(mb) || mb <= 0 || mb > 100_000) {
      throw new ConfigError(`${maxFileInput.from}: "${maxFileInput.value}" is not a size in MB (1-100000)`)
    }
    maxFileBytes = Math.round(mb * 1_000_000)
  }

  const idleInput = last("--desktop-idle", "OPENBOT_DESKTOP_IDLE_MINUTES")
  let desktopIdleMs: number | undefined
  if (idleInput !== undefined) {
    const minutes = Number(idleInput.value.trim())
    if (idleInput.value.trim() === "" || !Number.isFinite(minutes) || minutes < 0 || minutes > 7 * 24 * 60) {
      throw new ConfigError(`${idleInput.from}: "${idleInput.value}" is not a number of minutes (0 = never)`)
    }
    desktopIdleMs = Math.round(minutes * 60_000)
  }

  const skillsShInput = env["OPENBOT_SKILLS_SH_URL"]?.trim()
  let skillsShUrl: string | undefined
  if (skillsShInput !== undefined && skillsShInput !== "") {
    if (!/^https?:\/\/[^/\s]+/i.test(skillsShInput)) throw new ConfigError(`OPENBOT_SKILLS_SH_URL: "${skillsShInput}" is not an http(s) URL`)
    skillsShUrl = skillsShInput.replace(/\/+$/, "")
  }

  const slackInput = env["OPENBOT_SLACK_API_URL"]?.trim()
  let slackApiUrl: string | undefined
  if (slackInput !== undefined && slackInput !== "") {
    if (!/^https?:\/\/[^/\s]+/i.test(slackInput)) throw new ConfigError(`OPENBOT_SLACK_API_URL: "${slackInput}" is not an http(s) URL`)
    slackApiUrl = slackInput.replace(/\/+$/, "")
  }

  const harkInput = env["OPENBOT_HARK_URL"]?.trim()
  let harkUrl: string | undefined
  if (harkInput !== undefined && harkInput !== "") {
    if (!/^https?:\/\/[^/\s]+/i.test(harkInput)) throw new ConfigError(`OPENBOT_HARK_URL: "${harkInput}" is not an http(s) URL`)
    harkUrl = harkInput.replace(/\/+$/, "")
  }

  return {
    _tag: "Run",
    config: {
      dataDir,
      port,
      host,
      publicOrigins,
      localNode: localNode ?? parseBool(env["OPENBOT_LOCAL_NODE"]) ?? true,
      dev: dev ?? parseBool(env["OPENBOT_DEV"]) ?? false,
      harnesses,
      claudePath,
      ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
      ...(desktopIdleMs === undefined ? {} : { desktopIdleMs }),
      ...(skillsShUrl === undefined ? {} : { skillsShUrl }),
      ...(slackApiUrl === undefined ? {} : { slackApiUrl }),
      ...(harkUrl === undefined ? {} : { harkUrl }),
    },
  }
}

/**
 * `DataDir` port (architecture §3.5): every on-disk location the brain uses, derived from one root.
 * Pure string joins (POSIX separators); core never imports `node:path`.
 */
import { Context, Layer } from "effect"

export interface DataDirShape {
  /** Absolute data root, e.g. `~/.local/share/openbot`. */
  readonly root: string
  /** `<root>/openbot.sqlite` */
  readonly database: string
  /** `<root>/bots/<id>` */
  readonly botDir: (botId: string) => string
  /** `<root>/bots/<id>/memory` (Claude `autoMemoryDirectory`; `MEMORY.md` + fact files). */
  readonly memoryDir: (botId: string) => string
  /** `<root>/bots/<id>/workspace` (cwd for native-local placements). */
  readonly workspaceDir: (botId: string) => string
  /** `<root>/skills-lib` (Claude plugin layout). */
  readonly skillsLib: string
  /** `<root>/codex-home` (OpenBot `CODEX_HOME`). */
  readonly codexHome: string
  /** `<root>/opencode-config` (OpenBot `OPENCODE_CONFIG_DIR`). */
  readonly opencodeConfig: string
  /** `<root>/attachments` (files at `<root>/attachments/<id>`). */
  readonly attachments: string
  /** `<root>/local-node` (local node data: browser profile, audit log). */
  readonly localNode: string
  /** `<root>/logs` */
  readonly logs: string
  /** `<root>/carryover.json`: what a stopping brain hands to the next boot (`CarryoverStore`). */
  readonly carryover: string
  /** `<root>/brain-identity.json` (0600): the brain's Ed25519 keypair that nodes pin (brain-nodes). */
  readonly brainIdentity: string
  /** `<root>/slack.json` (0600): the owner's Slack tokens (D3.4). */
  readonly slack: string
  readonly stt: string
}

/** Joins path segments with `/`, collapsing duplicate separators and dropping a trailing one. */
export const joinPath = (...segments: ReadonlyArray<string>): string => {
  const joined = segments.filter((s) => s.length > 0).join("/").replace(/\/{2,}/g, "/")
  return joined.length > 1 && joined.endsWith("/") ? joined.slice(0, -1) : joined
}

export const makeDataDir = (root: string): DataDirShape => {
  const base = joinPath(root)
  const botDir = (botId: string) => joinPath(base, "bots", botId)
  return {
    root: base,
    database: joinPath(base, "openbot.sqlite"),
    botDir,
    memoryDir: (botId) => joinPath(botDir(botId), "memory"),
    workspaceDir: (botId) => joinPath(botDir(botId), "workspace"),
    skillsLib: joinPath(base, "skills-lib"),
    codexHome: joinPath(base, "codex-home"),
    opencodeConfig: joinPath(base, "opencode-config"),
    attachments: joinPath(base, "attachments"),
    localNode: joinPath(base, "local-node"),
    logs: joinPath(base, "logs"),
    carryover: joinPath(base, "carryover.json"),
    brainIdentity: joinPath(base, "brain-identity.json"),
    slack: joinPath(base, "slack.json"),
    stt: joinPath(base, "stt"),
  }
}

export class DataDir extends Context.Service<DataDir, DataDirShape>()("openbot/core/DataDir") {
  /** Live layer: paths only. Creating directories is the job of persistence / the server. */
  static readonly layer = (root: string): Layer.Layer<DataDir> => Layer.succeed(DataDir, makeDataDir(root))
}

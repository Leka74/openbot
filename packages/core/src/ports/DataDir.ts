/**
 * `DataDir` port (architecture §3.5): every on-disk location the brain uses, derived from one root.
 * Pure string joins (POSIX separators); core never imports `node:path`.
 *
 * What belongs to an owner profile (skills, attachments, Slack, Hark, ntfy) is under `profile(id)`:
 * the main profile keeps the paths it had before profiles, the others live in `<root>/profiles/<id>`.
 * Bot dirs stay at `bots/<id>` (a Bot belongs to one profile for good); computers, harness logins and
 * the brain's own files are shared.
 */
import { MAIN_PROFILE_ID, type OwnerProfileId } from "@openbot/contracts"
import { Context, Layer } from "effect"

/** The files of one owner profile. */
export interface ProfilePaths {
  /** `<root>` for the main profile, `<root>/profiles/<id>` for the others. */
  readonly root: string
  /** `skills-lib` (Claude plugin layout). */
  readonly skillsLib: string
  /** `attachments` (files at `attachments/<id>`). */
  readonly attachments: string
  /** `slack.json` (0600): the owner's Slack tokens (D3.4). */
  readonly slack: string
  /** `hark.json` (0600): the owner's Hark webhook (D3.5). */
  readonly hark: string
  /** `ntfy.json` (0600): the owner's ntfy topic and access token (D3.6). */
  readonly ntfy: string
}

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
  /** `<root>/codex-home` (OpenBot `CODEX_HOME`). */
  readonly codexHome: string
  /** `<root>/opencode-config` (OpenBot `OPENCODE_CONFIG_DIR`). */
  readonly opencodeConfig: string
  /** `<root>/local-node` (local node data: browser profile, audit log). */
  readonly localNode: string
  /** `<root>/logs` */
  readonly logs: string
  /** `<root>/carryover.json`: what a stopping brain hands to the next boot (`CarryoverStore`). */
  readonly carryover: string
  /** `<root>/brain-identity.json` (0600): the brain's Ed25519 keypair that nodes pin (brain-nodes). */
  readonly brainIdentity: string
  readonly stt: string
  /** Voice calls (experiment): llama.cpp, the voice model, Kokoro. */
  readonly voice: string
  /** `<root>/profiles` */
  readonly profiles: string
  readonly profile: (id: OwnerProfileId) => ProfilePaths
}

/** Joins path segments with `/`, collapsing duplicate separators and dropping a trailing one. */
export const joinPath = (...segments: ReadonlyArray<string>): string => {
  const joined = segments
    .filter((s) => s.length > 0)
    .join("/")
    .replace(/\/{2,}/g, "/")
  return joined.length > 1 && joined.endsWith("/") ? joined.slice(0, -1) : joined
}

/** A profile id as one path segment (ids are brain-allocated; anything else cannot leave the folder). */
const profileSegment = (id: OwnerProfileId): string => id.replace(/[^A-Za-z0-9_-]/g, "_")

export const makeDataDir = (root: string): DataDirShape => {
  const base = joinPath(root)
  const botDir = (botId: string) => joinPath(base, "bots", botId)
  const profiles = joinPath(base, "profiles")
  const profile = (id: OwnerProfileId): ProfilePaths => {
    const dir = id === MAIN_PROFILE_ID ? base : joinPath(profiles, profileSegment(id))
    return {
      root: dir,
      skillsLib: joinPath(dir, "skills-lib"),
      attachments: joinPath(dir, "attachments"),
      slack: joinPath(dir, "slack.json"),
      hark: joinPath(dir, "hark.json"),
      ntfy: joinPath(dir, "ntfy.json"),
    }
  }
  return {
    root: base,
    database: joinPath(base, "openbot.sqlite"),
    botDir,
    memoryDir: (botId) => joinPath(botDir(botId), "memory"),
    workspaceDir: (botId) => joinPath(botDir(botId), "workspace"),
    codexHome: joinPath(base, "codex-home"),
    opencodeConfig: joinPath(base, "opencode-config"),
    localNode: joinPath(base, "local-node"),
    logs: joinPath(base, "logs"),
    carryover: joinPath(base, "carryover.json"),
    brainIdentity: joinPath(base, "brain-identity.json"),
    stt: joinPath(base, "stt"),
    voice: joinPath(base, "voice"),
    profiles,
    profile,
  }
}

export class DataDir extends Context.Service<DataDir, DataDirShape>()("openbot/core/DataDir") {
  /** Live layer: paths only. Creating directories is the job of persistence / the server. */
  static readonly layer = (root: string): Layer.Layer<DataDir> => Layer.succeed(DataDir, makeDataDir(root))
}

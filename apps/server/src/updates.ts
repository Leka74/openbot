/**
 * Updates (contracts updates.ts): the newest GitHub Release of OpenBot (published by CI for every green
 * push to main, .github/workflows/release.yml), compared with what runs now, and installed on request.
 *
 * - What runs now: `release.json` at the root of the running code (written by scripts/deploy.ts, or
 *   brought by a release's tarball). A clone run straight from git (no release.json) reports its
 *   commit and cannot install: it updates with `git pull`.
 * - Checking: `GET /repos/<repo>/releases/latest`, then `compare/<current>...<latest>` for the
 *   commits in between. At start (after a minute) and every hour; `updates.check` asks now.
 * - Installing: the tarball is downloaded to `<data>/updates`, its sha256 checked, unpacked, and its
 *   packages installed (`bun install --frozen-lockfile`, the iPhone app left out); then
 *   scripts/deploy.ts from it runs as its own process (a transient systemd unit where the brain is the
 *   `openbot` service), so it outlives this brain: it drains it, backs up, starts the new release and
 *   goes back to this one if that does not start. `attempt.json` remembers what was being installed,
 *   so the next brain can say when it did not take.
 * - Going back: deploy.ts `--use` with the release before the current one.
 * - Automatic (Settings `autoUpdate`, off by default): a new release installs once no turn or task has
 *   run for 5 minutes; a release that failed to install is not tried again by itself.
 */
import {
  Conflict,
  MAIN_PROFILE_ID,
  type UpdateCommit,
  type UpdateRelease,
  type UpdateStatus,
  Unavailable,
} from "@openbot/contracts"
import { inProfile, Notifier, SettingsService } from "@openbot/core"
import { Database } from "bun:sqlite"
import { Context, Effect, Layer } from "effect"
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

export const DEFAULT_UPDATE_REPO = "Leka74/openbot"
const CHECK_EVERY_MS = 60 * 60 * 1000
const FIRST_CHECK_AFTER_MS = 60 * 1000
const QUIET_BEFORE_AUTO_MS = 5 * 60 * 1000
const TICK_MS = 60 * 1000
const COMMITS_SHOWN = 50

export class Updates extends Context.Service<
  Updates,
  {
    readonly status: Effect.Effect<UpdateStatus>
    readonly check: Effect.Effect<UpdateStatus>
    readonly install: Effect.Effect<UpdateStatus, Conflict | Unavailable>
    readonly rollback: Effect.Effect<UpdateStatus, Conflict | Unavailable>
  }
>()("openbot/server/Updates") {}

export interface UpdatesOptions {
  /** `<data>`: downloads go to `<data>/updates`; the database tells whether Bots are working. */
  readonly dataDir: string
  /** Where scripts/deploy.ts keeps releases (default `~/.local/share/openbot-releases`). */
  readonly releasesDir?: string | undefined
  /** `owner/name` on GitHub. */
  readonly repo?: string | undefined
  readonly apiUrl?: string | undefined
  /** The root of the running code (default: three levels above this file). */
  readonly root?: string | undefined
  readonly fetch?: ((url: string, init?: RequestInit) => Promise<Response>) | undefined
  /** Installs the unpacked release's packages (default `bun install --frozen-lockfile`). */
  readonly installPackages?: ((dir: string, log: string) => Promise<void>) | undefined
  /** Starts scripts/deploy.ts (default: a transient systemd unit, else a detached process). */
  readonly launch?: ((argv: ReadonlyArray<string>, log: string) => void) | undefined
  /** Check and auto-update on a timer (default true; tests drive it by hand). */
  readonly schedule?: boolean | undefined
}

interface Current {
  readonly version: string
  readonly sha?: string | undefined
  readonly dirty?: boolean | undefined
}

interface Latest extends UpdateRelease {
  readonly tarball: string
  readonly checksum: string
}

const run = (argv: ReadonlyArray<string>, cwd?: string) => {
  const proc = Bun.spawnSync([...argv], { ...(cwd === undefined ? {} : { cwd }), stdout: "pipe", stderr: "pipe" })
  return { ok: proc.exitCode === 0, out: `${proc.stdout.toString()}${proc.stderr.toString()}`.trim() }
}

const readJson = <A>(file: string): A | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as A
  } catch {
    return undefined
  }
}

/** What the code at `root` is: its release.json, else its git commit. */
export const currentOf = (root: string): Current => {
  const info = readJson<{ version?: unknown; sha?: unknown; dirty?: unknown }>(join(root, "release.json"))
  if (info !== undefined && typeof info.version === "string") {
    return {
      version: info.version,
      ...(typeof info.sha === "string" ? { sha: info.sha } : {}),
      ...(info.dirty === true ? { dirty: true } : {}),
    }
  }
  const head = run(["git", "rev-parse", "HEAD"], root)
  const sha = head.ok ? head.out.trim() : undefined
  const dirty = head.ok && run(["git", "status", "--porcelain"], root).out !== ""
  return { version: sha === undefined ? "dev" : `dev-${sha.slice(0, 7)}`, ...(sha === undefined ? {} : { sha }), dirty }
}

const sameCommit = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a))

/** Turns and tasks queued or running, from the brain's own database (0 when it cannot be read). */
const workInFlight = (dataDir: string): number => {
  try {
    const db = new Database(join(dataDir, "openbot.sqlite"), { readonly: true })
    try {
      const count = (sql: string) => (db.query(sql).get() as { n: number }).n
      return (
        count("select count(*) as n from turns where status in ('queued','running','waiting')") +
        count("select count(*) as n from tasks where status in ('queued','running')")
      )
    } finally {
      db.close()
    }
  } catch {
    return 0
  }
}

const defaultInstallPackages = async (dir: string, log: string) => {
  const out = openSync(log, "a")
  const proc = Bun.spawn([process.execPath, "install", "--frozen-lockfile", "--filter", "!@openbot/mobile"], {
    cwd: dir,
    stdout: out,
    stderr: out,
    stdin: "ignore",
  })
  if ((await proc.exited) !== 0) throw new Error(`installing its packages failed (see ${log})`)
}

/** deploy.ts outlives this brain: a transient systemd unit next to the `openbot` service, else setsid. */
const defaultLaunch = (argv: ReadonlyArray<string>, log: string) => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith("CLAUDE")) env[key] = value
  const asService = existsSync(join(homedir(), ".config/systemd/user/openbot.service"))
  if (asService) {
    const unit = `openbot-update-${Date.now()}`
    const started = Bun.spawnSync(
      [
        "systemd-run",
        "--user",
        "--collect",
        `--unit=${unit}`,
        `--property=StandardOutput=append:${log}`,
        `--property=StandardError=append:${log}`,
        `--setenv=PATH=${env["PATH"] ?? "/usr/bin:/bin"}`,
        ...argv,
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    )
    if (started.exitCode === 0) return
  }
  const out = openSync(log, "a")
  Bun.spawn(["setsid", ...argv], { env, stdout: out, stderr: out, stdin: "ignore" }).unref()
}

export const UpdatesLive = (options: UpdatesOptions): Layer.Layer<Updates, never, SettingsService | Notifier> =>
  Layer.effect(
    Updates,
    Effect.gen(function* () {
      const settings = yield* SettingsService
      // updating is the brain's business: the main profile's settings decide
      const brainSettings = inProfile(MAIN_PROFILE_ID)(settings.get)
      const notifier = yield* Notifier
      const repo = options.repo ?? DEFAULT_UPDATE_REPO
      const api = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "")
      const fetchFn = options.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init))
      const root = resolve(options.root ?? join(import.meta.dir, "../../.."))
      const releasesDir = resolve(options.releasesDir ?? join(homedir(), ".local/share/openbot-releases"))
      const dir = join(options.dataDir, "updates")
      const log = join(dir, "update.log")
      const installPackages = options.installPackages ?? defaultInstallPackages
      const launch = options.launch ?? defaultLaunch

      const current = currentOf(root)
      const realRoot = (() => {
        try {
          return realpathSync(root)
        } catch {
          return root
        }
      })()
      const realReleases = (() => {
        try {
          return realpathSync(releasesDir)
        } catch {
          return releasesDir
        }
      })()
      // only code that deploy.ts put in place can be replaced the same way
      const canInstall = realRoot.startsWith(`${realReleases}/`) && existsSync(join(root, "release.json"))

      /** The release just before the running one, to go back to. */
      const previousRelease = (): { readonly name: string; readonly version: string } | undefined => {
        if (!canInstall) return undefined
        try {
          const names = readdirSync(realReleases, { withFileTypes: true })
            .filter((e) => e.isDirectory() && join(realReleases, e.name) !== realRoot)
            .map((e) => e.name)
            .sort()
          const name = names.filter((n) => n < realRoot.slice(realReleases.length + 1)).at(-1)
          if (name === undefined) return undefined
          const version = readJson<{ version?: string }>(join(realReleases, name, "release.json"))?.version ?? name
          return { name, version }
        } catch {
          return undefined
        }
      }

      let state: UpdateStatus["state"] = "unknown"
      let latest: Latest | undefined
      let commits: ReadonlyArray<UpdateCommit> | undefined
      let behind: number | undefined
      let checkedAt: number | undefined
      let step: string | undefined
      let problem: string | undefined
      const failedVersions = new Set<string>()
      const memoryFile = join(dir, "state.json")
      const memory = readJson<{ notified?: string }>(memoryFile) ?? {}

      // the last install: did it take?
      const attemptFile = join(dir, "attempt.json")
      const attempt = readJson<{ version?: string; sha?: string; from?: string }>(attemptFile)
      if (attempt !== undefined) {
        rmSync(attemptFile, { force: true })
        const took = attempt.version === current.version || sameCommit(attempt.sha, current.sha)
        const wentBack = attempt.from === current.version
        if (!took && !wentBack && attempt.version !== undefined) {
          problem = `Installing ${attempt.version} did not work, so OpenBot is still on ${current.version}. Its log: ${log}`
          failedVersions.add(attempt.version)
        } else if (!took && wentBack && attempt.version !== undefined) {
          problem = `${attempt.version} did not start, so OpenBot went back to ${current.version}. Its log: ${log}`
          failedVersions.add(attempt.version)
        }
      }

      const snapshot = (): UpdateStatus => {
        const previous = previousRelease()
        return {
          current: {
            version: current.version,
            ...(current.sha === undefined ? {} : { sha: current.sha }),
            ...(current.dirty === true ? { dirty: true } : {}),
          },
          state,
          ...(latest === undefined
            ? {}
            : {
                latest: { version: latest.version, sha: latest.sha, publishedAt: latest.publishedAt, url: latest.url },
              }),
          ...(commits === undefined ? {} : { commits }),
          ...(behind === undefined ? {} : { behind }),
          ...(checkedAt === undefined ? {} : { checkedAt }),
          ...(step === undefined ? {} : { step }),
          ...(problem === undefined ? {} : { problem }),
          ...(previous === undefined ? {} : { previous: previous.version }),
          canInstall,
        }
      }

      const github = async <A>(path: string): Promise<A | undefined> => {
        const res = await fetchFn(`${api}${path}`, {
          headers: { accept: "application/vnd.github+json", "user-agent": "OpenBot" },
          signal: AbortSignal.timeout(20_000),
        })
        if (res.status === 404) return undefined
        if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
        return (await res.json()) as A
      }

      const checkNow = async (): Promise<void> => {
        if (state === "installing") return
        state = "checking"
        try {
          const release = await github<{
            tag_name: string
            target_commitish: string
            published_at: string
            html_url: string
            assets: ReadonlyArray<{ name: string; browser_download_url: string }>
          }>(`/repos/${repo}/releases/latest`)
          checkedAt = Date.now()
          if (release === undefined) {
            latest = undefined
            state = "unknown"
            problem = `${repo} has no releases yet.`
            return
          }
          const version = release.tag_name.replace(/^v/, "")
          const asset = (suffix: string) => release.assets.find((a) => a.name.endsWith(suffix))?.browser_download_url
          const tarball = asset(".tar.gz")
          const checksum = asset(".tar.gz.sha256")
          if (tarball === undefined || checksum === undefined) throw new Error(`release ${version} has no tarball`)
          latest = {
            version,
            sha: release.target_commitish,
            publishedAt: Date.parse(release.published_at) || checkedAt,
            url: release.html_url,
            tarball,
            checksum,
          }
          if (problem?.startsWith(repo)) problem = undefined
          if (version === current.version || sameCommit(latest.sha, current.sha)) {
            commits = []
            behind = 0
            state = "up-to-date"
            return
          }
          const compared =
            current.sha === undefined
              ? undefined
              : await github<{
                  status: string
                  ahead_by: number
                  commits: ReadonlyArray<{ sha: string; commit: { message: string } }>
                }>(`/repos/${repo}/compare/${current.sha}...${latest.sha}`).catch(() => undefined)
          if (compared !== undefined && compared.ahead_by === 0) {
            // what runs is newer than (or the same as) the newest release
            commits = []
            behind = 0
            state = "up-to-date"
            return
          }
          behind = compared?.ahead_by
          commits = compared?.commits
            .slice(-COMMITS_SHOWN)
            .reverse()
            .map((c) => ({ sha: c.sha.slice(0, 7), message: c.commit.message.split("\n")[0]!.trim() }))
          state = "available"
        } catch (error) {
          state = latest === undefined ? "unknown" : "available"
          problem = `Could not check for updates: ${error instanceof Error ? error.message : String(error)}`
        }
      }

      const announce = Effect.gen(function* () {
        if (state !== "available" || latest === undefined || memory.notified === latest.version) return
        if ((yield* brainSettings).autoUpdate) return
        memory.notified = latest.version
        mkdirSync(dir, { recursive: true })
        writeFileSync(memoryFile, JSON.stringify(memory))
        yield* notifier.notify({
          kind: "update",
          title: "OpenBot update",
          body: `${latest.version} is ready to install${behind === undefined ? "" : ` (${behind} change${behind === 1 ? "" : "s"})`}. Settings › About.`,
        })
      })

      const check = Effect.gen(function* () {
        yield* Effect.promise(checkNow)
        yield* announce
        return snapshot()
      })

      const sha256 = (file: string) => {
        const hasher = new Bun.CryptoHasher("sha256")
        hasher.update(readFileSync(file))
        return hasher.digest("hex")
      }

      /** Hands off to deploy.ts (its own process): this brain is drained and replaced. */
      const deploy = (script: string, extra: ReadonlyArray<string>, attemptOf: { version: string; sha?: string }) => {
        mkdirSync(dir, { recursive: true })
        writeFileSync(attemptFile, JSON.stringify({ ...attemptOf, from: current.version }))
        launch(
          [process.execPath, script, "--local", "--data-dir", options.dataDir, "--releases", releasesDir, ...extra],
          log,
        )
      }

      const installNow = async (target: Latest) => {
        try {
          mkdirSync(dir, { recursive: true })
          writeFileSync(log, `--- ${new Date().toISOString()} installing ${target.version}\n`, { flag: "a" })
          step = "Downloading…"
          const file = join(dir, `openbot-${target.version}.tar.gz`)
          const res = await fetchFn(target.tarball, { signal: AbortSignal.timeout(10 * 60_000) })
          if (!res.ok) throw new Error(`the download answered ${res.status}`)
          await Bun.write(file, res)
          const expected = (await (await fetchFn(target.checksum)).text()).trim().split(/\s+/)[0]
          if (expected === undefined || sha256(file) !== expected.toLowerCase()) {
            throw new Error("the download does not match its checksum")
          }
          step = "Unpacking…"
          const unpacked = join(dir, "src")
          rmSync(unpacked, { recursive: true, force: true })
          mkdirSync(unpacked, { recursive: true })
          const tar = run(["tar", "-xzf", file, "-C", unpacked])
          if (!tar.ok) throw new Error(`unpacking failed: ${tar.out}`)
          const source = join(unpacked, "openbot")
          if (!existsSync(join(source, "scripts/deploy.ts"))) throw new Error("the release has no scripts/deploy.ts")
          step = "Installing packages…"
          await installPackages(source, log)
          step = "Restarting…"
          const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)
          deploy(join(source, "scripts/deploy.ts"), ["--release-id", `${stamp}-${target.sha.slice(0, 7)}`], {
            version: target.version,
            sha: target.sha,
          })
          rmSync(file, { force: true })
        } catch (error) {
          state = "failed"
          step = undefined
          problem = `Installing ${target.version} failed: ${error instanceof Error ? error.message : String(error)}`
          failedVersions.add(target.version)
          writeFileSync(log, `${problem}\n`, { flag: "a" })
        }
      }

      const notInstallable = new Unavailable({
        message:
          "This OpenBot runs from a clone, not from releases: update it with git pull (or deploy it with scripts/deploy.ts).",
      })

      const install = Effect.gen(function* () {
        if (!canInstall) return yield* Effect.fail(notInstallable)
        if (state === "installing")
          return yield* Effect.fail(new Conflict({ reason: "An update is already being installed." }))
        if (latest === undefined) yield* Effect.promise(checkNow)
        const target = latest
        if (target === undefined)
          return yield* Effect.fail(new Unavailable({ message: problem ?? "No release found." }))
        state = "installing"
        problem = undefined
        step = "Starting…"
        yield* Effect.forkDetach(Effect.promise(() => installNow(target)))
        return snapshot()
      })

      const rollback = Effect.gen(function* () {
        if (!canInstall) return yield* Effect.fail(notInstallable)
        if (state === "installing") return yield* Effect.fail(new Conflict({ reason: "An update is being installed." }))
        const previous = previousRelease()
        if (previous === undefined)
          return yield* Effect.fail(new Unavailable({ message: "There is no earlier release here." }))
        state = "installing"
        problem = undefined
        step = `Going back to ${previous.version}…`
        deploy(join(root, "scripts/deploy.ts"), ["--use", previous.name], { version: previous.version })
        return snapshot()
      })

      // the timer: a check at start and every hour; automatic installs once Bots have been quiet
      if (options.schedule !== false) {
        let lastCheck = 0
        let quietSince: number | undefined
        const tick = Effect.gen(function* () {
          const now = Date.now()
          if (now - lastCheck >= CHECK_EVERY_MS || lastCheck === 0) {
            lastCheck = now
            yield* check
          }
          const target = latest
          if (state !== "available" || target === undefined || !canInstall || failedVersions.has(target.version)) {
            quietSince = undefined
            return
          }
          if (!(yield* brainSettings).autoUpdate) return
          if (workInFlight(options.dataDir) > 0) {
            quietSince = undefined
            return
          }
          quietSince ??= now
          if (now - quietSince >= QUIET_BEFORE_AUTO_MS) {
            quietSince = undefined
            yield* Effect.ignore(install)
          }
        })
        yield* Effect.sleep(FIRST_CHECK_AFTER_MS).pipe(
          Effect.andThen(Effect.forever(Effect.ignoreCause(tick).pipe(Effect.andThen(Effect.sleep(TICK_MS))))),
          Effect.forkScoped,
        )
      }

      return Updates.of({ status: Effect.sync(snapshot), check, install, rollback })
    }),
  )

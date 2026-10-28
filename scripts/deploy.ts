#!/usr/bin/env bun
/**
 * `bun run deploy`: ships the working tree to the live OpenBot without losing the bots' work.
 *
 *   bun run deploy [--grace 3m] [--now] [--to <ssh host> | --local] [--use <release>] [--data-dir <dir>] [--releases <dir>] [-- <server args>]
 *
 * The brain on another machine: `--to` (or `{ "host": "<ssh host>" }` in this machine's
 * `~/.config/openbot/deploy.json`) copies the working tree to `<host>:~/.local/share/openbot-staging`
 * (only what changed) and runs this script there, which does the steps below on that machine.
 * `--local` deploys on this machine anyway.
 *
 * 1. Copies the repo into a new release, `<releases>/<id>` (unchanged files are hard links to the
 *    previous release, so it is quick and small), and checks that it loads (`main.ts --version`).
 * 2. Drains the running brain (SIGUSR2, apps/server/src/drain.ts): no new turn or task starts, messages
 *    wait, running work gets `--grace` (default 3 minutes); what is still running or waiting then is
 *    saved, and the new brain resumes it. `--now` skips the wait (SIGTERM: saved and resumed too).
 *    A brain from before drains existed loses queued work when it stops: it is waited on until no turn
 *    or task has been queued or running for a minute, then stopped.
 * 3. Backs up the database (`<data>/backups/pre-deploy-<release>.sqlite`, with the time added when that
 *    release was started before; the newest 5 are kept).
 * 4. Starts the new release with the running brain's arguments (or the ones after `--`, or the last
 *    deploy's) and waits for "OpenBot started". If it does not start, the previous release is started
 *    again.
 * 5. Points `<releases>/current` at it and keeps the newest releases.
 *
 * `--use <release>` starts a release already in `<releases>` (going back to an earlier one) instead of
 * copying the repo. Each release holds `release.json` (`version`, `sha`, `dirty`): from the tarball of
 * a published release (CI), else written here; the brain reads it to compare itself with the newest
 * release (apps/server/src/updates.ts).
 *
 * Where the brain runs as the systemd user service `openbot` (scripts/openbot.service: it starts on
 * boot and again after a crash), it is started and stopped through systemd; the service runs
 * `<releases>/current` with the arguments in `<data>/brain.env`.
 *
 * Every `CLAUDE*` variable is removed from the brain's environment (a brain started from inside a
 * Claude Code session must not inherit its account).
 */
import { Database } from "bun:sqlite"
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const KEEP_RELEASES = 3
const KEEP_BACKUPS = 5
/** A brain that cannot drain loses queued work when it stops: it must have been idle this long. */
const LEGACY_QUIET_MS = 60_000
const STARTUP_TIMEOUT_MS = 120_000
const EXCLUDES = ["/vendor", "/.git", "screenshots", "/apps/mobile", "/.turbo"]

const say = (line: string) => console.log(`deploy: ${line}`)
// a function declaration: a call narrows types like `return` does
function fail(line: string): never {
  console.error(`deploy: ${line}`)
  process.exit(1)
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

// ---------------------------------------------------------------------------- arguments

const parseDuration = (text: string): number => {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim())
  if (!match) return fail(`not a duration: ${text} (e.g. 90s, 3m)`)
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[(match[2] ?? "s") as "ms" | "s" | "m" | "h"]
  return Math.round(Number(match[1]) * unit)
}

const argv = process.argv.slice(2)
const VALUE_OPTIONS = ["--grace", "--to", "--data-dir", "--releases", "--release-id", "--use"]
const FLAG_OPTIONS = ["--now", "--local"]
/** Where the server arguments start: after `--`, or at the first argument that is not this script's
 * own (Bun drops a leading `--`, so `bun run deploy -- --port 7420` arrives as `--port 7420`). */
const serverArgsAt = (): number => {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--") return i
    if (VALUE_OPTIONS.includes(arg)) i++
    else if (!FLAG_OPTIONS.includes(arg)) return i
  }
  return argv.length
}
const split = serverArgsAt()
const own = argv.slice(0, split)
const passed = split === argv.length ? undefined : argv.slice(argv[split] === "--" ? split + 1 : split)
const option = (name: string) => {
  const at = own.indexOf(name)
  return at < 0 ? undefined : own[at + 1]
}
const repo = resolve(import.meta.dir, "..")
const dataDir = resolve(option("--data-dir") ?? join(homedir(), ".local/share/openbot"))
const releases = resolve(option("--releases") ?? join(homedir(), ".local/share/openbot-releases"))
const graceMs = parseDuration(option("--grace") ?? "3m")
const now = own.includes("--now")

/** The machine the brain runs on, when it is not this one. */
const deployHost = (): string | undefined => {
  if (own.includes("--local")) return undefined
  const flag = option("--to")
  if (flag !== undefined) return flag
  const file = join(homedir(), ".config/openbot/deploy.json")
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { host?: string }).host : undefined
}

const SERVICE = "openbot.service"
/** The brain runs as the systemd user service: deploys start and stop it through systemd. */
const asService = existsSync(join(homedir(), ".config/systemd/user", SERVICE))

// ---------------------------------------------------------------------------- the running brain

interface Brain {
  readonly pid: number
  readonly cwd: string
  readonly args: ReadonlyArray<string>
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const runningBrain = (): Brain | undefined => {
  const pidFile = join(dataDir, "brain.pid")
  if (!existsSync(pidFile)) return undefined
  const pid = Number(readFileSync(pidFile, "utf8").trim())
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return undefined
  const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8")
    .split("\0")
    .filter((part) => part !== "")
  const main = cmdline.findIndex((part) => part.endsWith("apps/server/src/main.ts"))
  if (main < 0) return fail(`pid ${pid} in ${pidFile} is not an OpenBot brain: ${cmdline.join(" ")}`)
  return { pid, cwd: readlinkSync(`/proc/${pid}/cwd`), args: cmdline.slice(main + 1) }
}

/** Turns and tasks queued, running or waiting (read-only; the brain keeps writing). */
const workInFlight = (): { turns: number; tasks: number } => {
  try {
    const db = new Database(join(dataDir, "openbot.sqlite"), { readonly: true })
    try {
      const count = (sql: string) => (db.query(sql).get() as { n: number }).n
      return {
        turns: count("select count(*) as n from turns where status in ('queued','running','waiting')"),
        tasks: count("select count(*) as n from tasks where status in ('queued','running')"),
      }
    } finally {
      db.close()
    }
  } catch {
    return { turns: 0, tasks: 0 }
  }
}

const brainEnv = (): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("CLAUDE")) env[key] = value
  }
  return env
}

// ---------------------------------------------------------------------------- steps

const run = (cmd: ReadonlyArray<string>, cwd = repo) => {
  const proc = Bun.spawnSync([...cmd], { cwd, env: brainEnv(), stdout: "pipe", stderr: "pipe" })
  return { ok: proc.exitCode === 0, out: `${proc.stdout.toString()}${proc.stderr.toString()}`.trim() }
}

/** `20261028-132249` (UTC). */
const timeStamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)

const releaseId = () => {
  const given = option("--release-id")
  if (given !== undefined) return given
  const stamp = timeStamp()
  const sha = run(["git", "rev-parse", "--short", "HEAD"]).out
  const dirty = run(["git", "status", "--porcelain"]).out !== ""
  return `${stamp}-${sha || "nogit"}${dirty ? "-dirty" : ""}`
}

const prepareRelease = (previous: string | undefined) => {
  const release = join(releases, releaseId())
  mkdirSync(releases, { recursive: true })
  say(`copying the repo to ${release}`)
  const rsync = [
    "rsync",
    "-a",
    "--delete",
    ...EXCLUDES.flatMap((pattern) => ["--exclude", pattern]),
    ...(previous !== undefined && existsSync(previous) ? [`--link-dest=${previous}`] : []),
    `${repo}/`,
    `${release}/`,
  ]
  const copied = run(rsync)
  if (!copied.ok) fail(`copying failed:\n${copied.out}`)
  // what this release is (a published release's tarball brings its own)
  const id = release.split("/").at(-1)!
  if (!existsSync(join(release, "release.json"))) {
    const sha = /-([0-9a-f]{7,40})(?:-dirty)?$/.exec(id)?.[1]
    const info = { version: id, ...(sha === undefined ? {} : { sha }), dirty: id.endsWith("-dirty") }
    writeFileSync(join(release, "release.json"), `${JSON.stringify(info, null, 2)}\n`)
  }
  const loads = run(["bun", "apps/server/src/main.ts", "--version"], release)
  if (!loads.ok) {
    rmSync(release, { recursive: true, force: true })
    fail(`the new release does not load, nothing was changed:\n${loads.out}`)
  }
  return release
}

const stopBrain = async (brain: Brain) => {
  const canDrain = existsSync(join(brain.cwd, "apps/server/src/drain.ts"))
  if (now) {
    say("stopping the brain now (its work is saved and resumed)")
    process.kill(brain.pid, "SIGTERM")
  } else if (canDrain) {
    await Bun.write(join(dataDir, "drain.json"), JSON.stringify({ graceMs }))
    say(`draining: running work gets up to ${Math.round(graceMs / 1000)} s, then the rest is saved and resumed`)
    process.kill(brain.pid, "SIGUSR2")
  } else {
    say(`this brain cannot drain yet: waiting until no turn or task has run for ${LEGACY_QUIET_MS / 1000} s`)
    let quietSince: number | undefined
    let lastReport = 0
    while (quietSince === undefined || Date.now() - quietSince < LEGACY_QUIET_MS) {
      const { turns, tasks } = workInFlight()
      if (turns + tasks > 0) {
        quietSince = undefined
        if (Date.now() - lastReport > 60_000) {
          say(`waiting: ${turns} turn(s), ${tasks} task(s) queued or running`)
          lastReport = Date.now()
        }
      } else quietSince ??= Date.now()
      await sleep(5_000)
    }
    process.kill(brain.pid, "SIGTERM")
  }
  const deadline = Date.now() + (canDrain && !now ? graceMs : 0) + 60_000
  let lastReport = Date.now()
  while (alive(brain.pid)) {
    if (Date.now() > deadline) {
      say("the brain did not stop in time: stopping it")
      process.kill(brain.pid, "SIGTERM")
      await sleep(10_000)
      if (alive(brain.pid)) process.kill(brain.pid, "SIGKILL")
      break
    }
    if (Date.now() - lastReport > 15_000) {
      const { turns, tasks } = workInFlight()
      say(`still finishing: ${turns} turn(s), ${tasks} task(s)`)
      lastReport = Date.now()
    }
    await sleep(500)
  }
  // a brain that ended badly is due to be restarted by systemd: it must not come back
  if (asService) systemctl("stop", SERVICE)
  say("the old brain stopped")
}

const systemctl = (...args: ReadonlyArray<string>) => run(["systemctl", "--user", ...args])

/** Starts the brain: the service on `<releases>/current` (pointed at `cwd`), else a detached process. */
const launch = async (
  cwd: string,
  args: ReadonlyArray<string>,
  log: number,
): Promise<{ readonly ended: () => boolean; readonly stop: () => Promise<void> } | undefined> => {
  if (asService) {
    if (args.some((arg) => /\s/.test(arg)))
      fail(`server arguments with spaces cannot go in brain.env: ${args.join(" ")}`)
    await Bun.write(join(dataDir, "brain.env"), `OPENBOT_ARGS=${args.join(" ")}\n`)
    pointCurrent(cwd)
    const started = systemctl("restart", SERVICE)
    if (!started.ok) {
      console.error(started.out)
      return undefined
    }
    const stop = async () => void systemctl("stop", SERVICE)
    return { ended: () => !systemctl("is-active", "--quiet", SERVICE).ok, stop }
  }
  const child = Bun.spawn(["setsid", "bun", "apps/server/src/main.ts", ...args], {
    cwd,
    env: brainEnv(),
    stdin: "ignore",
    stdout: log,
    stderr: log,
  })
  child.unref()
  const stop = async () => {
    // setsid made it a process-group leader: its harness children go with it
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {}
    for (let i = 0; i < 40 && alive(child.pid); i++) await sleep(500)
    if (alive(child.pid)) process.kill(-child.pid, "SIGKILL")
  }
  return { ended: () => child.exitCode !== null, stop }
}

const startBrain = async (cwd: string, args: ReadonlyArray<string>): Promise<boolean> => {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const logPath = join(dataDir, "server.log")
  const offset = existsSync(logPath) ? statSync(logPath).size : 0
  const brain = await launch(cwd, args, openSync(logPath, "a"))
  if (brain === undefined) return false
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(500)
    // `offset` counts bytes: cut the bytes, not the decoded text (the log is not ASCII)
    const text = existsSync(logPath) ? readFileSync(logPath).subarray(offset).toString("utf8") : ""
    if (text.includes("OpenBot started")) return true
    if (text.includes("failed to start") || brain.ended()) {
      console.error(text.split("\n").slice(-20).join("\n"))
      await brain.stop()
      return false
    }
  }
  say('no "OpenBot started" in time: stopping it')
  await brain.stop()
  return false
}

/**
 * `<data>/backups/pre-deploy-<id>.sqlite`, taken while no brain runs (`-<time>` added when a release is
 * started again: `--use`); the newest few are kept.
 */
const backupDatabase = (release: string) => {
  const database = join(dataDir, "openbot.sqlite")
  if (!existsSync(database)) return
  const dir = join(dataDir, "backups")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const name = `pre-deploy-${release.split("/").at(-1)}`
  const first = join(dir, `${name}.sqlite`)
  const target = existsSync(first) ? join(dir, `${name}-${timeStamp()}.sqlite`) : first
  const db = new Database(database)
  try {
    db.run(`VACUUM INTO '${target.replaceAll("'", "''")}'`)
  } finally {
    db.close()
  }
  const old = readdirSync(dir)
    .filter((name) => name.startsWith("pre-deploy-") && name.endsWith(".sqlite"))
    .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => a.at - b.at)
    .slice(0, -KEEP_BACKUPS)
    .map((b) => b.name)
  for (const name of old) rmSync(join(dir, name), { force: true })
  say(`database backed up to ${target}`)
}

const pointCurrent = (release: string) => {
  const link = join(releases, "current")
  const temp = `${link}.tmp-${process.pid}`
  rmSync(temp, { force: true })
  symlinkSync(release, temp)
  renameSync(temp, link)
}

const prune = (keep: ReadonlyArray<string>) => {
  const all = readdirSync(releases, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(releases, entry.name))
    .sort()
  const newest = all.slice(-KEEP_RELEASES)
  for (const dir of all) {
    if (!newest.includes(dir) && !keep.includes(dir)) rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------- another machine

const STAGING = ".local/share/openbot-staging"
const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`

/** Copies the working tree to the brain's machine and deploys there (the release is named here: git is not copied). */
const shipTo = (host: string): never => {
  const ssh = ["ssh", "-o", "BatchMode=yes"]
  say(`copying the repo to ${host}`)
  const copied = run([
    "rsync",
    "-az",
    "--delete",
    "-e",
    ssh.join(" "),
    ...EXCLUDES.flatMap((pattern) => ["--exclude", pattern]),
    `${repo}/`,
    `${host}:${STAGING}/`,
  ])
  if (!copied.ok) fail(`copying to ${host} failed:\n${copied.out}`)
  const forwarded = own.filter((arg, i) => arg !== "--local" && arg !== "--to" && own[i - 1] !== "--to")
  const command = [
    `cd ${STAGING} && PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH" exec bun scripts/deploy.ts --local --release-id ${quote(releaseId())}`,
    ...forwarded.map(quote),
    ...(passed === undefined ? [] : ["--", ...passed.map(quote)]),
  ].join(" ")
  const remote = Bun.spawnSync([...ssh, host, command], { stdin: "ignore", stdout: "inherit", stderr: "inherit" })
  process.exit(remote.exitCode ?? 1)
}

// ---------------------------------------------------------------------------- main

const host = deployHost()
if (host !== undefined) shipTo(host)

const savedArgsPath = join(dataDir, "deploy.json")
const brain = runningBrain()
const args =
  passed ??
  brain?.args ??
  (existsSync(savedArgsPath)
    ? (JSON.parse(readFileSync(savedArgsPath, "utf8")) as { args: Array<string> }).args
    : undefined)
if (args === undefined)
  fail("OpenBot is not running and no earlier deploy is known: pass the server arguments after --")

const current = existsSync(join(releases, "current")) ? readlinkSync(join(releases, "current")) : undefined
const use = option("--use")
const release =
  use === undefined
    ? prepareRelease(current ?? brain?.cwd)
    : (() => {
        const chosen = resolve(releases, use)
        if (!chosen.startsWith(`${releases}/`) || !existsSync(join(chosen, "apps/server/src/main.ts")))
          fail(`no release ${use} in ${releases}`)
        say(`going back to ${chosen}`)
        return chosen
      })()
if (brain !== undefined) await stopBrain(brain)
backupDatabase(release)
say(`starting ${release}`)
if (await startBrain(release, args)) {
  pointCurrent(release)
  await Bun.write(savedArgsPath, JSON.stringify({ args, release }, null, 2))
  prune([release, ...(current === undefined ? [] : [current])])
  say("done: OpenBot runs the new release; cut-off work resumes on its own")
} else {
  const previous = brain?.cwd ?? current
  if (previous === undefined || !existsSync(previous))
    fail("the new release did not start and there is no previous one to go back to")
  say(`the new release did not start: going back to ${previous}`)
  if (!(await startBrain(previous, brain?.args ?? args)))
    fail("the previous release did not start either: see server.log")
  fail("rolled back to the previous release; see server.log for why the new one failed")
}

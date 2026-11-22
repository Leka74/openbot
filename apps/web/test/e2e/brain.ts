// E2E harness (W3.1): spawns the REAL brain (`apps/server/src/main.ts`) as a child process with a
// temp data dir and an ephemeral port, logs a Chromium page in through the printed login URL, and
// offers an `OpenBotRpcs` client over `/rpc` (session cookie) for server-side assertions.
//
// Only the offline fake ("Demo") harness is used for turns: no model spend. The local node's browser
// runs headless (DISPLAY / WAYLAND_DISPLAY are removed from the brain's environment).
import * as BunSocket from "@effect/platform-bun/BunSocket"
import {
  applyConversationStreamItem,
  applyRosterStreamItem,
  type BotActivity,
  type ConversationId,
  type ConversationState,
  emptyConversationState,
  emptyRosterState,
  OpenBotRpcs,
  type RosterState,
} from "@openbot/contracts"
import { Effect, Exit, Fiber, Layer, Ref, Scope, Stream } from "effect"
import { RpcClient, type RpcClientError, RpcSerialization } from "effect/rpc"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Browser, type BrowserContext, type BrowserContextOptions, chromium, type Page } from "playwright-core"

export const chromiumPath = process.env.OPENBOT_CHROMIUM ?? "/usr/bin/chromium"
export const hasChromium = existsSync(chromiumPath)
export const shotsDir = new URL("./screenshots", import.meta.url).pathname
mkdirSync(shotsDir, { recursive: true })

const repoRoot = new URL("../../../../", import.meta.url).pathname
export const serverMain = join(repoRoot, "apps/server/src/main.ts")
export const nodeMain = join(repoRoot, "apps/node/src/main.ts")

/** Environment for child processes: no display (headless browsers), no inherited OpenBot config. */
export const childEnv = (extra?: Record<string, string>): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (k === "DISPLAY" || k === "WAYLAND_DISPLAY" || k.startsWith("OPENBOT_")) continue
    env[k] = v
  }
  // test brains never ask GitHub for updates; background bot messages wake their recipient quickly
  return { ...env, OPENBOT_UPDATES: "off", OPENBOT_BOT_WAKE_DEBOUNCE_MS: "50", ...extra }
}

export interface Brain {
  /** `http://127.0.0.1:<port>` */
  readonly base: string
  readonly loginUrl: string
  readonly token: string
  readonly dataDir: string
  /** Everything the brain printed (stdout + stderr). */
  readonly log: () => string
  /** Stops the brain and starts it again on the same port and data (an update does that), with `args` added. */
  readonly restart: (args?: ReadonlyArray<string>) => Promise<void>
  readonly stop: () => Promise<void>
}

/** Reads a child's stream into `sink` until `pattern` matches (or the timeout / EOF). */
const pump = (stream: ReadableStream<Uint8Array>, sink: { text: string }) => {
  const decoder = new TextDecoder()
  void (async () => {
    for await (const chunk of stream) sink.text += decoder.decode(chunk)
  })().catch(() => undefined)
}

const waitFor = async (
  sink: { text: string },
  pattern: RegExp,
  timeoutMs: number,
  what: string,
  exited: () => boolean,
) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const m = pattern.exec(sink.text)
    if (m) return m
    if (exited()) break
    await Bun.sleep(50)
  }
  throw new Error(`${what} did not show up within ${timeoutMs} ms:\n${sink.text.slice(-4000)}`)
}

/**
 * `env`: extra variables for the brain, e.g. `OPENBOT_SKILLS_SH_URL` (a fake skills.sh). `prepare`
 * runs on the empty data folder before the brain starts (e.g. links to installed models).
 */
export const startBrain = async (options?: {
  readonly harnesses?: string
  readonly args?: ReadonlyArray<string>
  readonly env?: Record<string, string>
  readonly prepare?: (dataDir: string) => void
}): Promise<Brain> => {
  const dataDir = mkdtempSync(join(tmpdir(), "openbot-e2e-brain-"))
  options?.prepare?.(dataDir)
  const args = ["--data-dir", dataDir, "--harness", options?.harnesses ?? "fake", ...(options?.args ?? [])]
  const spawn = async (port: string, extra: ReadonlyArray<string>) => {
    const child = Bun.spawn([process.execPath, serverMain, ...args, "--port", port, ...extra], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv(options?.env),
    })
    const sink = { text: "" }
    pump(child.stdout, sink)
    pump(child.stderr, sink)
    const m = await waitFor(
      sink,
      /OpenBot is running → (\S+)/,
      30_000,
      "the brain's login URL",
      () => child.exitCode !== null,
    )
    return { child, sink, loginUrl: m[1]! }
  }
  const kill = async (child: Bun.Subprocess) => {
    child.kill("SIGTERM")
    await Promise.race([child.exited, Bun.sleep(15_000)])
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
  }
  let running = await spawn("0", [])
  const url = new URL(running.loginUrl)
  return {
    base: url.origin,
    loginUrl: running.loginUrl,
    token: url.searchParams.get("token") ?? "",
    dataDir,
    log: () => running.sink.text,
    restart: async (extra = []) => {
      await kill(running.child)
      running = await spawn(url.port, extra)
    },
    stop: async () => {
      await kill(running.child)
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------------- browser

export const launchBrowser = (args?: ReadonlyArray<string>): Promise<Browser> =>
  chromium.launch({ executablePath: chromiumPath, ...(args === undefined ? {} : { args: [...args] }) })

export interface AppPage {
  readonly page: Page
  readonly context: BrowserContext
  /** Page errors and console errors seen so far. */
  readonly errors: Array<string>
  readonly shot: (name: string) => Promise<void>
}

/** Opens the app logged in (login URL → cookie), at `route`; `context` sets the window (a phone's, say). */
export const openApp = async (
  browser: Browser,
  brain: Brain,
  options?: { readonly theme?: "dark" | "light"; readonly route?: string; readonly context?: BrowserContextOptions },
): Promise<AppPage> => {
  const theme = options?.theme ?? "dark"
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: theme,
    ...options?.context,
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const errors: Array<string> = []
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`)
  })
  // a hash-only goto after landing on `/` would race the app's boot
  await context.request.get(brain.loginUrl)
  await page.goto(`${brain.base}/${options?.route ?? ""}`)
  await page.evaluate(() => document.fonts.ready)
  return {
    page,
    context,
    errors,
    shot: async (name) => {
      await page.waitForTimeout(250)
      await page.screenshot({ path: join(shotsDir, `${name}.png`) })
    },
  }
}

// ---------------------------------------------------------------------------------- RPC

export type OpenBotClient = RpcClient.FromGroup<typeof OpenBotRpcs, RpcClientError.RpcClientError>

export const login = async (base: string, token: string): Promise<string> => {
  const res = await fetch(`${base}/api/auth/login?token=${encodeURIComponent(token)}`, { redirect: "manual" })
  if (res.status !== 302) throw new Error(`login failed: ${res.status}`)
  const cookie = res.headers.get("set-cookie")
  if (cookie === null) throw new Error("login set no cookie")
  return cookie.split(";")[0]!
}

export interface Rpc {
  readonly cookie: string
  /** Runs `f` with a connected client (scoped to the call). */
  readonly call: <A, E>(f: (client: OpenBotClient) => Effect.Effect<A, E, Scope.Scope>) => Promise<A>
  /** A live conversation replica (snapshot + upserts folded with the contract reducer). */
  readonly conversation: (id: ConversationId) => Promise<ConversationState>
  /** A live roster replica in the background, plus every activity it saw. */
  readonly watchRoster: () => RosterWatch
  readonly close: () => Promise<void>
}

export interface RosterWatch {
  readonly state: () => RosterState
  readonly activities: () => ReadonlyArray<BotActivity>
  readonly stop: () => Promise<void>
}

export const connectRpc = async (brain: Brain): Promise<Rpc> => {
  const cookie = await login(brain.base, brain.token)
  const scope = Effect.runSync(Scope.make())
  const client = await Effect.runPromise(
    Effect.gen(function* () {
      const protocol = yield* Layer.build(
        RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
          Layer.provide(
            BunSocket.layerWebSocket(`${brain.base.replace(/^http/, "ws")}/rpc`, {
              headers: { cookie, origin: brain.base },
              openTimeout: 5_000,
            }),
          ),
          Layer.provide(RpcSerialization.layerJson),
        ),
      )
      return yield* RpcClient.make(OpenBotRpcs).pipe(Effect.provideContext(protocol))
    }).pipe(Scope.provide(scope)),
  )
  return {
    cookie,
    call: (f) => Effect.runPromise(Effect.scoped(f(client))),
    conversation: (id) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const state = yield* Ref.make<ConversationState>(emptyConversationState)
            const fiber = yield* client["conversations.subscribe"]({ conversationId: id }).pipe(
              Stream.runForEach((item) => Ref.update(state, (s) => applyConversationStreamItem(s, item))),
              Effect.forkScoped,
            )
            // wait for the synchronized marker (or a short deadline)
            const deadline = Date.now() + 5_000
            while (Date.now() < deadline) {
              const s = yield* Ref.get(state)
              if (s.synchronized) break
              yield* Effect.sleep("20 millis")
            }
            yield* Fiber.interrupt(fiber)
            return yield* Ref.get(state)
          }),
        ),
      ),
    watchRoster: () => {
      let state = emptyRosterState
      const seen: Array<BotActivity> = []
      const fiber = Effect.runFork(
        client["roster.subscribe"]({}).pipe(
          Stream.runForEach((item) =>
            Effect.sync(() => {
              state = applyRosterStreamItem(state, item)
              const change = (item as { kind?: string; change?: { type?: string; activity?: BotActivity } }).change
              if (item.kind === "change" && change?.type === "activity.updated" && change.activity)
                seen.push(change.activity)
            }),
          ),
        ),
      )
      return {
        state: () => state,
        activities: () => seen,
        stop: () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined),
      }
    },
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }
}

/** Polls `read` until `predicate` holds. */
export const eventually = async <A>(
  read: () => Promise<A>,
  predicate: (a: A) => boolean,
  options?: { readonly timeout?: number; readonly label?: string },
): Promise<A> => {
  const deadline = Date.now() + (options?.timeout ?? 15_000)
  let last: A | undefined
  while (Date.now() < deadline) {
    last = await read()
    if (predicate(last)) return last
    await Bun.sleep(100)
  }
  throw new Error(
    `timed out waiting for ${options?.label ?? "condition"}; last: ${JSON.stringify(last)?.slice(0, 3000)}`,
  )
}

// ---------------------------------------------------------------------------------- UI helpers

/** Creates a Demo-harness bot through the New Bot dialog (New chat → Create new Bot). */
export const createBotViaUi = async (page: Page, name: string) => {
  await page.keyboard.press("Control+n")
  const to = page.getByRole("combobox", { name: "To" })
  await to.fill(name)
  await page
    .getByRole("option", { name: new RegExp(`Create .*${name}`) })
    .first()
    .click()
  const form = page.getByTestId("new-bot-form")
  await form.waitFor()
  await form.getByTestId("harness-chip-fake").click()
  await form.getByTestId("create-bot").click()
  await page.getByRole("textbox", { name: `Message ${name}` }).waitFor()
}

/** Sends a composer message in the open conversation. */
export const send = async (page: Page, botOrGroupName: string, text: string) => {
  const box = page.getByRole("textbox", { name: `Message ${botOrGroupName}` })
  await box.fill(text)
  await box.press("Enter")
}

/** Waits until no turn runs in the open conversation (the composer's Stop button is gone). */
export const waitIdle = async (page: Page, timeout = 15_000) => {
  await page.waitForTimeout(150)
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ state: "detached", timeout })
}

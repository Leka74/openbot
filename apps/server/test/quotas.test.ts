// Plan limits per harness account (`harnesses.quota`) through the real brain: one answer per
// (kind, account) with the account's own report and its Bots, reports kept between calls unless
// `refresh`, a driver without a report, and the fallback (a Bot whose last turn hit a usage limit).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { HarnessQuotaReport, Millis } from "@openbot/contracts"
import { type HarnessDriver, HarnessRegistry, TurnRepo } from "@openbot/core"
import { makeTurn, turnId } from "@openbot/core/testing"
import { FakeHarnessLive, makeFakeDriver } from "@openbot/harness-fake"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { type ServerOptions } from "../src/index.ts"
import { login, type OpenBotClient, rpcClient, startServer, type TestServer } from "./helpers.ts"

const RESET = 4_000_000_000_000

/** How often each account was asked, keyed by its config dir name. */
const asked = new Map<string, number>()

const report = (dir: string): Omit<HarnessQuotaReport, "checkedAt"> =>
  dir === ".claude"
    ? {
        windows: [
          { kind: "session", usedPercent: 100, resetsAt: RESET },
          { kind: "week", usedPercent: 41, resetsAt: RESET },
        ],
        account: { email: "main@example.com", plan: "team" },
        extraUsage: false,
      }
    : { windows: [{ kind: "session", usedPercent: 7 }], account: { email: "two@example.com" } }

/** A fake driver posing as `kind` for one account; Claude accounts report plan limits, Codex does not. */
const accountDriver = (
  kind: HarnessDriver["kind"],
  profileId: string | undefined,
  configDir: string,
): HarnessDriver => {
  const dir = basename(configDir)
  return {
    ...makeFakeDriver({ displayName: kind === "claude" ? "Claude" : "Codex" }),
    kind,
    ...(profileId !== undefined ? { profileId } : {}),
    ...(kind === "claude"
      ? {
          quota: Effect.sync(() => {
            asked.set(dir, (asked.get(dir) ?? 0) + 1)
            return { ...report(dir), checkedAt: Date.now() }
          }),
        }
      : {}),
  }
}

const makeHome = () => {
  const home = mkdtempSync(join(tmpdir(), "openbot-quotas-home-"))
  for (const name of [".claude", ".claude-2", ".codex"]) {
    mkdirSync(join(home, name))
    writeFileSync(join(home, name, name === ".codex" ? "auth.json" : ".credentials.json"), "{}")
  }
  return home
}

const serverOptions = (home: string): ServerOptions => ({
  drivers: Layer.mergeAll(
    FakeHarnessLive,
    HarnessRegistry.registerLayer(Effect.succeed(accountDriver("claude", undefined, join(home, ".claude")))),
    HarnessRegistry.registerLayer(Effect.succeed(accountDriver("codex", undefined, join(home, ".codex")))),
  ),
  profiles: {
    home,
    env: {},
    driverFor: (profile) =>
      Effect.succeed(accountDriver(profile.kind as HarnessDriver["kind"], profile.id, profile.configDir!)),
  },
})

let home: string
let server: TestServer
let cookie: string

beforeAll(async () => {
  home = makeHome()
  server = await startServer({ config: { harnesses: ["fake", "claude", "codex"] }, server: serverOptions(home) })
  cookie = await login(server.base, server.ownerToken)
}, 30_000)

afterAll(async () => {
  await server?.close()
  rmSync(home, { recursive: true, force: true })
}, 30_000)

const withClient = <A, E>(f: (client: OpenBotClient) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base }), f)),
  )

describe("harnesses.quota", () => {
  test("one answer per account, in the order of the accounts, with its report and its Bots", async () => {
    const out = await withClient((client) =>
      Effect.gen(function* () {
        const profiles = yield* client["harnesses.profiles"]({ kind: "claude" })
        const two = profiles.find((p) => p.configDir === join(home, ".claude-2"))!
        const main = yield* client["bots.create"]({ name: "Main", harness: { kind: "claude" }, clientNonce: "q-1" })
        const twin = yield* client["bots.create"]({
          name: "Twin",
          harness: { kind: "claude", profileId: two.id },
          clientNonce: "q-2",
        })
        const coder = yield* client["bots.create"]({ name: "Coder", harness: { kind: "codex" }, clientNonce: "q-3" })
        return { two, main, twin, coder, quotas: yield* client["harnesses.quota"]({}) }
      }),
    )
    expect(out.quotas.map((q) => `${q.kind}/${q.profileId}`)).toEqual([
      "claude/default",
      `claude/${out.two.id}`,
      "codex/default",
      "fake/default",
    ])
    const [main, two, codex, fake] = out.quotas
    expect(main).toMatchObject({
      profileLabel: "Default",
      windows: [
        { kind: "session", usedPercent: 100, resetsAt: RESET },
        { kind: "week", usedPercent: 41, resetsAt: RESET },
      ],
      account: { email: "main@example.com", plan: "team" },
      extraUsage: false,
      botIds: [out.main.id],
      otherProfileBots: 0,
      limitHits: [],
    })
    expect(main!.problem).toBeUndefined()
    expect(two).toMatchObject({ windows: [{ kind: "session", usedPercent: 7 }], botIds: [out.twin.id] })
    // a harness without a report still lists its Bots
    expect(codex).toMatchObject({
      windows: [],
      problem: "Codex does not report plan limits to OpenBot.",
      botIds: [out.coder.id],
    })
    expect(fake!.windows).toEqual([])
  })

  test("reports are kept between calls; refresh asks every account again", async () => {
    const before = new Map(asked)
    const out = await withClient((client) =>
      Effect.gen(function* () {
        const kept = yield* client["harnesses.quota"]({})
        const afterKept = new Map(asked)
        const fresh = yield* client["harnesses.quota"]({ refresh: true })
        return { kept, afterKept, fresh }
      }),
    )
    expect(out.afterKept).toEqual(before)
    expect(asked.get(".claude")).toBe((before.get(".claude") ?? 0) + 1)
    expect(asked.get(".claude-2")).toBe((before.get(".claude-2") ?? 0) + 1)
    expect(out.fresh[0]!.checkedAt).toBeGreaterThanOrEqual(out.kept[0]!.checkedAt)
    expect(out.fresh[0]!.windows).toEqual(out.kept[0]!.windows)
  })

  test("fallback: a Bot whose last finished turn failed on a usage limit is listed with the provider's text", async () => {
    const quotas = () => withClient((client) => client["harnesses.quota"]({}))
    const main = (await quotas())[0]!
    const botId = main.botIds[0]!
    const now = Date.now()
    const failure = {
      code: "usage-limit",
      message: "You've hit your session limit · resets 3pm",
      retryable: false,
    } as const
    await server.run(
      Effect.gen(function* () {
        const turns = yield* TurnRepo
        yield* turns.upsert(
          makeTurn({
            id: turnId("trn_limit"),
            botId,
            status: "failed",
            startedAt: (now - 60_000) as Millis,
            endedAt: (now - 50_000) as Millis,
            failure,
          }),
        )
      }),
    )
    const hit = (await quotas())[0]!
    expect(hit.limitHits).toEqual([{ botId, at: now - 50_000, message: failure.message }])

    // the Bot's next finished turn clears it
    await server.run(
      Effect.gen(function* () {
        const turns = yield* TurnRepo
        yield* turns.upsert(
          makeTurn({ id: turnId("trn_ok"), botId, status: "completed", startedAt: (now - 10_000) as Millis }),
        )
      }),
    )
    expect((await quotas())[0]!.limitHits).toEqual([])
  })
})

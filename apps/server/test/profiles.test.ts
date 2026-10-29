// Harness accounts (profiles) through the real brain: first-boot discovery of ~/.claude-* and
// ~/.codex-* in a temp home, one status per (kind, profile), add/remove/discover over `/rpc`, bots
// bound to an account, and no re-seeding after the owner removed one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type HarnessProfile, type HarnessStatus, MAIN_PROFILE_ID } from "@openbot/contracts"
import { type HarnessDriver, HarnessRegistry } from "@openbot/core"
import { FakeHarnessLive, makeFakeDriver } from "@openbot/harness-fake"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { type ServerOptions } from "../src/index.ts"
import { login, type OpenBotClient, rpcClient, startServer, type TestServer } from "./helpers.ts"

const claudeState = (email: string) =>
  JSON.stringify({ oauthAccount: { emailAddress: email, organizationName: "Org" } })

const makeHome = () => {
  const home = mkdtempSync(join(tmpdir(), "openbot-profiles-home-"))
  mkdirSync(join(home, ".claude"))
  writeFileSync(join(home, ".claude", ".credentials.json"), "{}")
  writeFileSync(join(home, ".claude.json"), claudeState("main@example.com"))
  for (const n of [2, 3]) {
    mkdirSync(join(home, `.claude-${n}`))
    writeFileSync(join(home, `.claude-${n}`, ".credentials.json"), "{}")
    writeFileSync(join(home, `.claude-${n}`, ".claude.json"), claudeState(`acct${n}@example.com`))
  }
  for (const name of [".codex", ".codex-work"]) {
    mkdirSync(join(home, name))
    writeFileSync(join(home, name, "auth.json"), "{}")
  }
  return home
}

/** Every profile id a session was opened with, per kind. */
const opened: Array<string> = []

/** A fake driver posing as `kind` for one account; its probe reports an account named after the dir. */
const accountDriver = (
  kind: HarnessDriver["kind"],
  profileId: string | undefined,
  configDir: string,
): HarnessDriver => {
  const base = makeFakeDriver({ displayName: kind === "claude" ? "Claude" : "Codex" })
  return {
    ...base,
    kind,
    ...(profileId !== undefined ? { profileId } : {}),
    probe: Effect.succeed({
      kind,
      installed: true,
      auth: { state: "signed-in", label: `${basename(configDir)}@example.com` },
      account: { email: `${basename(configDir)}@example.com` },
      problems: [],
    } satisfies HarnessStatus),
    openSession: (input) => {
      opened.push(`${kind}/${input.bot.harness.profileId ?? "default"}`)
      return base.openSession(input)
    },
  }
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

const boot = async (dataDir?: string) => {
  server = await startServer({
    ...(dataDir ? { dataDir } : {}),
    config: { harnesses: ["fake", "claude", "codex"] },
    server: serverOptions(home),
  })
  cookie = await login(server.base, server.ownerToken)
}

beforeAll(async () => {
  home = makeHome()
  await boot()
}, 30_000)

afterAll(async () => {
  await server?.close()
  rmSync(home, { recursive: true, force: true })
}, 30_000)

const withClient = <A, E>(f: (client: OpenBotClient) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base }), f)),
  )

const summary = (profiles: ReadonlyArray<HarnessProfile>) =>
  profiles.map((p) => `${p.kind}:${p.isDefault ? "default" : p.label}:${p.configDir ?? "-"}`)

describe("harness accounts", () => {
  test("first boot adds the discovered accounts; status lists one entry per (kind, account)", async () => {
    const { profiles, status } = await withClient((client) =>
      Effect.all({ profiles: client["harnesses.profiles"]({}), status: client["harnesses.status"]() }),
    )
    expect(summary(profiles)).toEqual([
      `claude:default:${join(home, ".claude")}`,
      `claude:acct2@example.com (Org):${join(home, ".claude-2")}`,
      `claude:acct3@example.com (Org):${join(home, ".claude-3")}`,
      `codex:default:${join(home, ".codex")}`,
      `codex:codex-work:${join(home, ".codex-work")}`,
      "fake:default:-",
    ])
    const claude = status.filter((s) => s.kind === "claude")
    expect(claude.map((s) => [s.profileLabel, s.account?.email, s.configDir])).toEqual([
      ["Default", ".claude@example.com", join(home, ".claude")],
      ["acct2@example.com (Org)", ".claude-2@example.com", join(home, ".claude-2")],
      ["acct3@example.com (Org)", ".claude-3@example.com", join(home, ".claude-3")],
    ])
    expect(claude[0]!.profileId).toBe("default")
    expect(new Set(claude.map((s) => s.profileId)).size).toBe(3)
    expect(status.map((s) => s.kind)).toEqual(["claude", "claude", "claude", "codex", "codex", "fake"])
  })

  test("discover / add / validation", async () => {
    mkdirSync(join(home, ".claude-4"))
    writeFileSync(join(home, ".claude-4", ".claude.json"), claudeState("four@example.com"))
    const out = await withClient((client) =>
      Effect.gen(function* () {
        const found = yield* client["harnesses.discover"]({ kind: "claude" })
        const added = yield* client["harnesses.addProfile"]({ kind: "claude", label: "", configDir: "~/.claude-4" })
        const again = yield* Effect.flip(
          client["harnesses.addProfile"]({ kind: "claude", label: "x", configDir: join(home, ".claude-4") }),
        )
        const defaultDir = yield* Effect.flip(
          client["harnesses.addProfile"]({ kind: "claude", label: "x", configDir: join(home, ".claude") }),
        )
        const relative = yield* Effect.flip(
          client["harnesses.addProfile"]({ kind: "claude", label: "x", configDir: "claude-9" }),
        )
        const missing = yield* Effect.flip(
          client["harnesses.addProfile"]({ kind: "claude", label: "x", configDir: join(home, "nope") }),
        )
        const opencode = yield* Effect.flip(
          client["harnesses.addProfile"]({ kind: "opencode", label: "x", configDir: home }),
        )
        const afterAdd = yield* client["harnesses.discover"]({ kind: "claude" })
        const status = yield* client["harnesses.status"]()
        return { found, added, again, defaultDir, relative, missing, opencode, afterAdd, status }
      }),
    )
    expect(out.found).toEqual([
      {
        kind: "claude",
        configDir: join(home, ".claude-4"),
        suggestedLabel: "four@example.com (Org)",
        account: { email: "four@example.com", organization: "Org" },
      },
    ])
    expect(out.added).toMatchObject({ kind: "claude", label: "claude-4", configDir: join(home, ".claude-4") })
    expect(out.again._tag).toBe("Conflict")
    expect(out.defaultDir._tag).toBe("Conflict")
    expect(out.relative._tag).toBe("InvalidInput")
    expect(out.missing._tag).toBe("InvalidInput")
    expect(out.opencode._tag).toBe("InvalidInput")
    expect(out.afterAdd).toEqual([])
    // live: the new account's driver is registered without a restart
    expect(out.status.find((s) => s.profileId === out.added.id)?.account?.email).toBe(".claude-4@example.com")
  })

  test("a bot runs on its account; the account cannot be removed while a bot uses it", async () => {
    opened.length = 0
    const out = await withClient((client) =>
      Effect.gen(function* () {
        const profiles = yield* client["harnesses.profiles"]({ kind: "claude" })
        const two = profiles.find((p) => p.configDir === join(home, ".claude-2"))!
        const bot = yield* client["bots.create"]({
          name: "Twin",
          harness: { kind: "claude", profileId: two.id },
          clientNonce: "twin-1",
        })
        const unknown = yield* Effect.flip(
          client["bots.create"]({
            name: "Ghost",
            harness: { kind: "claude", profileId: "hpf_nope" },
            clientNonce: "ghost-1",
          }),
        )
        yield* client["messages.send"]({ conversationId: bot.directConversationId, text: "hi", clientNonce: "m-1" })
        for (let i = 0; i < 200 && opened.length === 0; i++) yield* Effect.sleep(10)
        const models = yield* client["harnesses.models"]({ kind: "claude", profileId: two.id })
        const refused = yield* Effect.flip(client["harnesses.removeProfile"]({ profileId: two.id }))
        const moved = yield* client["bots.update"]({
          botId: bot.id,
          patch: { harness: { kind: "claude", profileId: "default" } },
        })
        yield* client["harnesses.removeProfile"]({ profileId: two.id })
        const forbidden = yield* Effect.flip(client["harnesses.removeProfile"]({ profileId: "default" }))
        const gone = yield* Effect.flip(client["harnesses.removeProfile"]({ profileId: two.id }))
        const status = yield* client["harnesses.status"]()
        return { bot, two, unknown, models, refused, moved, forbidden, gone, status }
      }),
    )
    expect(out.bot.harness).toEqual({ kind: "claude", profileId: out.two.id })
    expect(out.unknown._tag).toBe("HarnessUnavailable")
    expect(opened).toEqual([`claude/${out.two.id}`])
    expect(out.models.length).toBeGreaterThan(0)
    expect(out.refused._tag).toBe("Conflict")
    expect(out.refused._tag === "Conflict" && out.refused.reason).toContain("Twin uses this account")
    expect(out.moved.harness).toEqual({ kind: "claude" })
    expect(out.forbidden._tag).toBe("Forbidden")
    expect(out.gone._tag).toBe("NotFound")
    expect(out.status.some((s) => s.profileId === out.two.id)).toBe(false)
  })

  test("the account in use names only the active profile's Bots", async () => {
    const out = await withClient((client) =>
      Effect.gen(function* () {
        const profiles = yield* client["harnesses.profiles"]({ kind: "claude" })
        const three = profiles.find((p) => p.configDir === join(home, ".claude-3"))!
        const harness = { kind: "claude", profileId: three.id } as const
        const other = yield* client["profiles.create"]({ name: "Other" })
        yield* client["profiles.switch"]({ profileId: other.id })
        yield* client["bots.create"]({ name: "Hidden", harness, clientNonce: "hidden-1", introduce: false })
        yield* client["profiles.switch"]({ profileId: MAIN_PROFILE_ID })
        const elsewhere = yield* Effect.flip(client["harnesses.removeProfile"]({ profileId: three.id }))
        yield* client["bots.create"]({ name: "Shown", harness, clientNonce: "shown-1", introduce: false })
        const both = yield* Effect.flip(client["harnesses.removeProfile"]({ profileId: three.id }))
        return { elsewhere, both }
      }),
    )
    expect(out.elsewhere._tag === "Conflict" && out.elsewhere.reason).toBe(
      "1 Bot in another profile uses this account. Move it to another account first.",
    )
    expect(out.both._tag === "Conflict" && out.both.reason).toBe(
      "Shown and 1 Bot in another profile use this account. Move them to another account first.",
    )
  })

  test("after a restart the accounts come back, and a removed one is not rediscovered automatically", async () => {
    const dataDir = server.dataDir
    await server.close({ keepData: true })
    await boot(dataDir)
    const out = await withClient((client) =>
      Effect.all({
        profiles: client["harnesses.profiles"]({ kind: "claude" }),
        found: client["harnesses.discover"]({ kind: "claude" }),
      }),
    )
    expect(summary(out.profiles)).toEqual([
      `claude:default:${join(home, ".claude")}`,
      `claude:acct3@example.com (Org):${join(home, ".claude-3")}`,
      `claude:claude-4:${join(home, ".claude-4")}`,
    ])
    // offered again in Add account, but not re-added on boot
    expect(out.found.map((c) => c.configDir)).toEqual([join(home, ".claude-2")])
  })
})

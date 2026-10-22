/**
 * Wave-0 integration additions: boot recovery, session keys, workspace paths, the settings
 * key/value codec and InternalAddress.
 */
import { describe, expect, test } from "bun:test"
import { DEFAULT_SETTINGS, LOCAL_NODE_ID } from "@openbot/contracts"
import type { NodeRpcs } from "@openbot/node-protocol"
import { Effect, Layer } from "effect"
import type { RpcClient, RpcGroup } from "effect/rpc"
import {
  BootRecovery,
  InternalAddress,
  makeDataDir,
  type NodeClient,
  parseSessionKey,
  ProcessLedger,
  readSettings,
  sessionKeyOf,
  SettingsRepo,
  settingsFromEntries,
  settingsToEntries,
  workspacePathFor,
  writeSettings,
} from "../../src/ports/index.ts"
import {
  botId,
  bootRecoveryContractCases,
  conversationId,
  MemoryBootRecovery,
  MemoryPersistence,
  remoteNodeSummary,
  runTest,
  SequentialIdGen,
  TestPorts,
} from "../../src/testing/index.ts"

const persistence = MemoryPersistence.pipe(Layer.provide(SequentialIdGen()))

describe("BootRecovery (shared rules over in-memory repositories)", () => {
  for (const c of bootRecoveryContractCases) {
    test(c.name, async () => {
      await Effect.runPromise(Effect.provide(c.run, Layer.provideMerge(MemoryBootRecovery(), persistence)))
    })
  }

  test("signals every ledger process group through the injected killer", async () => {
    const killed: Array<number> = []
    const layer = Layer.provideMerge(
      MemoryBootRecovery({ killProcessGroup: (r) => Effect.sync(() => (killed.push(r.pgid), r.pgid !== 2)) }),
      persistence,
    )
    const report = await Effect.runPromise(
      Effect.gen(function*() {
        const ledger = yield* ProcessLedger
        yield* ledger.record({ pid: 1, pgid: 1, kind: "codex-app-server", startedAt: 0 })
        yield* ledger.record({ pid: 2, pgid: 2, kind: "opencode-serve", startedAt: 1 })
        return yield* (yield* BootRecovery).run
      }).pipe(Effect.provide(layer)),
    )
    expect(killed).toEqual([1, 2])
    expect(report.killedProcesses.map((p) => p.pid)).toEqual([1])
  })

  test("TestPorts provides BootRecovery and InternalAddress", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const report = yield* (yield* BootRecovery).run
        const url = yield* (yield* InternalAddress).baseUrl
        return { report, url }
      }),
      TestPorts(),
    )
    expect(out.report.interruptedTurns).toEqual([])
    expect(out.url).toBe("http://127.0.0.1:0")
  })
})

describe("session keys and workspace paths", () => {
  test("sessionKeyOf / parseSessionKey round trip", () => {
    const key = sessionKeyOf(botId("bot_01"), conversationId("cnv_02"))
    expect(key).toBe("bot_01:cnv_02")
    expect(parseSessionKey(key)).toEqual({ botId: botId("bot_01"), conversationId: conversationId("cnv_02") })
    expect(parseSessionKey("garbage")).toBeUndefined()
    expect(parseSessionKey(":x")).toBeUndefined()
    expect(parseSessionKey("x:")).toBeUndefined()
  })

  test("workspacePathFor: local node uses the data dir, remote nodes their first root", () => {
    const dataDir = makeDataDir("/data")
    expect(workspacePathFor({ node: { id: LOCAL_NODE_ID, roots: ["/ignored"] }, botId: botId("bot_a"), dataDir })).toBe(
      "/data/bots/bot_a/workspace",
    )
    expect(workspacePathFor({ node: remoteNodeSummary("nod_r", { roots: ["/home/me/openbot"] }), botId: botId("bot_a"), dataDir }))
      .toBe("/home/me/openbot/workspaces/bot_a")
    expect(workspacePathFor({ node: remoteNodeSummary("nod_r", { roots: [] }), botId: botId("bot_a"), dataDir })).toBe(
      "~/openbot/workspaces/bot_a",
    )
  })

  test("InternalAddress.layer strips trailing slashes", async () => {
    const url = await Effect.runPromise(
      Effect.flatMap(InternalAddress, (a) => a.baseUrl).pipe(Effect.provide(InternalAddress.layer("http://127.0.0.1:9/"))),
    )
    expect(url).toBe("http://127.0.0.1:9")
  })
})

describe("settings key/value codec", () => {
  test("absent keys decode to defaults; invalid stored values fall back per key", () => {
    expect(settingsFromEntries(new Map())).toEqual(DEFAULT_SETTINGS)
    const settings = settingsFromEntries(
      new Map<string, unknown>([["theme", "dark"], ["approvalExpiryMinutes", -5], ["unrelated", 1], ["ownerName", "Ada"]]),
    )
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, theme: "dark", ownerName: "Ada" })
  })

  test("writeSettings / readSettings round trip through SettingsRepo, removing cleared keys", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function*() {
        yield* writeSettings({ ...DEFAULT_SETTINGS, theme: "light", defaultHarness: "codex" })
        const first = yield* readSettings
        yield* writeSettings({ ...DEFAULT_SETTINGS, theme: "light" })
        const repo = yield* SettingsRepo
        const keys = [...(yield* repo.getAll).keys()].sort()
        return { first, second: yield* readSettings, keys }
      }).pipe(Effect.provide(persistence)),
    )
    expect(out.first).toEqual({ ...DEFAULT_SETTINGS, theme: "light", defaultHarness: "codex" })
    expect(out.second).toEqual({ ...DEFAULT_SETTINGS, theme: "light" })
    expect(out.keys).toEqual(["accent", "approvalExpiryMinutes", "botMessaging", "botSearch", "compactIdleBots", "defaultAutonomy", "sharedProjectFolders", "showCompactions", "showSteps", "slackMentions", "theme"])
    expect(settingsToEntries(DEFAULT_SETTINGS).map(([k]) => k).sort()).toEqual(
      ["accent", "approvalExpiryMinutes", "botMessaging", "botSearch", "compactIdleBots", "defaultAutonomy", "defaultHarness", "ownerName", "sharedProjectFolders", "showCompactions", "showSteps", "slackMentions", "slackSendTo", "theme"],
    )
  })
})

describe("NodeClient", () => {
  test("an in-process RpcTest.makeClient(NodeRpcs) client is a NodeClient (LocalNode)", () => {
    const asNodeClient = (client: RpcClient.RpcClient<RpcGroup.Rpcs<typeof NodeRpcs>>): NodeClient => client
    expect(typeof asNodeClient).toBe("function")
  })
})

// LocalNode (D1.1): `@openbot/node-daemon`'s NodeHandlersLive in-process as `node_local`, reached
// through `NodeDirectory.client` like any node. Exec, fs, node-policy approvals through
// ApprovalService, and the terminal socket (`/ws/terminal/:botId` → pty.open → StreamBroker.dialLocal).
import { afterAll, describe, expect, test } from "bun:test"
import type { BotId } from "@openbot/contracts"
import { DEFAULT_SETTINGS, LOCAL_NODE_ID, MAIN_PROFILE_ID } from "@openbot/contracts"
import { LiveHub, NodeDirectory, NodeFiles, OwnerProfiles } from "@openbot/core"
import { ApprovalServiceFake, makeBot } from "@openbot/core/testing"
import type { ExecEvent } from "@openbot/node-protocol"
import { Effect, Layer, Stream } from "effect"
import * as Socket from "effect/socket/Socket"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type LocalNodeDaemonOptions, open } from "../src/index.ts"
import { brainStack, dialWebSocket, putBot, run, startServer, tempDir } from "./helpers.ts"

const dir = tempDir()
afterAll(() => dir.cleanup())

/** Hermetic node-daemon settings: no PATH probing, no browser. */
const daemon = (extra?: Partial<NonNullable<LocalNodeDaemonOptions["node"]>>): LocalNodeDaemonOptions => ({
  node: { detectBinaries: false, browser: { enabled: false }, forwardAudit: false, ...extra },
})

const withLocal = <A, E>(options: LocalNodeDaemonOptions, effect: Effect.Effect<A, E, any>, extra?: Layer.Layer<any>) =>
  run(
    effect.pipe(
      Effect.provide(
        Layer.fresh(brainStack({ dataRoot: dir.path, localDaemon: options, ...(extra ? { extra } : {}) })),
      ) as any,
    ) as Effect.Effect<A, E, never>,
  )

const workspace = (botId: string) => {
  const path = join(dir.path, "bots", botId, "workspace")
  mkdirSync(path, { recursive: true })
  return path
}

const inv = (botId: string, n: number) => ({ invocationId: `inv_${n}`, botId, runId: `${botId}:cnv_${botId}` })

const outputOf = (events: ReadonlyArray<ExecEvent>) =>
  events.flatMap((e) => (e._tag === "Output" ? [e.data] : [])).join("")

describe("local node", () => {
  test("project folders (shared ∪ the bot's own) are roots of the local node for that bot only", () => {
    const project = join(dir.path, "projects", "snip")
    const shared = join(dir.path, "shared")
    mkdirSync(project, { recursive: true })
    mkdirSync(shared, { recursive: true })
    const proj = makeBot({ id: "bot_proj" as BotId, projectFolders: [project] })
    const plain = makeBot({ id: "bot_plain" as BotId })
    const view = { profiles: [{ id: MAIN_PROFILE_ID, name: "Main", createdAt: 0 }], activeId: MAIN_PROFILE_ID }
    const roster = Layer.mock(LiveHub, {
      subscribeRoster: () =>
        Stream.make({
          kind: "snapshot" as const,
          cursor: { epoch: "r", sequence: 0 },
          bots: [proj, plain],
          conversations: [],
          activities: [],
          nodes: [],
          sections: [],
          settings: { ...DEFAULT_SETTINGS, sharedProjectFolders: [shared] },
        }).pipe(Stream.concat(Stream.never)),
    })
    const profiles = Layer.mock(OwnerProfiles, { view: Effect.succeed(view), changes: Stream.make(view) })
    return withLocal(
      daemon(),
      Effect.gen(function* () {
        const client = yield* (yield* NodeDirectory).client(LOCAL_NODE_ID)
        workspace("bot_proj")
        workspace("bot_plain")
        const events = yield* client["shell.exec"]({
          inv: inv("bot_proj", 1),
          command: "pwd",
          cwd: project,
          timeoutMs: 10_000,
        }).pipe(Stream.runCollect)
        expect(outputOf(events)).toContain(project)
        yield* client["fs.write"]({ inv: inv("bot_proj", 2), path: join(project, "a.txt"), content: "x" })
        yield* client["fs.write"]({ inv: inv("bot_plain", 3), path: join(shared, "b.txt"), content: "y" })
        const denied = yield* Effect.flip(client["fs.read"]({ inv: inv("bot_plain", 4), path: join(project, "a.txt") }))
        expect(denied._tag).toBe("PathDenied")
      }),
      Layer.merge(roster, profiles),
    )
  })

  test("node_local is registered online and runs shell.exec and fs calls through NodeDirectory.client", () =>
    withLocal(
      daemon(),
      Effect.gen(function* () {
        const directory = yield* NodeDirectory
        const summary = yield* directory.get(LOCAL_NODE_ID)
        expect(summary).toMatchObject({ id: LOCAL_NODE_ID, kind: "local", status: "online", label: "This computer" })
        expect(summary.capabilities).toEqual(expect.arrayContaining(["fs@1", "shell@1", "pty@1"]))
        expect(summary.capabilities).not.toContain("browser@1")
        expect(summary.roots).toEqual([join(dir.path, "bots", "{botId}", "workspace")])
        expect((yield* directory.list).map((n) => n.id)).toContain(LOCAL_NODE_ID)

        const ws = workspace("bot_local")
        const client = yield* directory.client(LOCAL_NODE_ID)
        const events = yield* client["shell.exec"]({
          inv: inv("bot_local", 1),
          command: "echo hello-local; pwd",
          cwd: ws,
          timeoutMs: 10_000,
        }).pipe(Stream.runCollect)
        expect(events[0]?._tag).toBe("Started")
        expect(outputOf(events)).toContain("hello-local")
        expect(outputOf(events)).toContain(ws)
        expect(events.at(-1)).toMatchObject({ _tag: "Exit", code: 0, timedOut: false })

        const written = yield* client["fs.write"]({
          inv: inv("bot_local", 2),
          path: join(ws, "note.txt"),
          content: "hi there",
        })
        expect(written.size).toBe(8)
        const read = yield* client["fs.read"]({ inv: inv("bot_local", 3), path: join(ws, "note.txt") })
        expect(read).toMatchObject({ content: "hi there", truncated: false })

        // each bot reaches only its own workspace; nothing outside the roots
        workspace("bot_other")
        const otherBot = yield* Effect.flip(client["fs.read"]({ inv: inv("bot_other", 4), path: join(ws, "note.txt") }))
        expect(otherBot._tag).toBe("PathDenied")
        const outside = yield* Effect.flip(client["fs.read"]({ inv: inv("bot_local", 5), path: "/etc/hostname" }))
        expect(outside._tag).toBe("PathDenied")
      }),
    ))

  test("NodeFiles.download streams a file from the local node intact (fs.download over an in-memory transfer stream)", () =>
    withLocal(
      daemon(),
      Effect.gen(function* () {
        const files = yield* NodeFiles
        const ws = workspace("bot_send")
        mkdirSync(join(ws, "output"), { recursive: true })
        const data = new Uint8Array(9 * 1024 * 1024 + 4321)
        for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 9)) & 0xff
        writeFileSync(join(ws, "output", "cache-demo.mp4"), data)
        const sha = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

        const download = yield* Effect.scoped(
          Effect.gen(function* () {
            const dl = yield* files.download({
              nodeId: LOCAL_NODE_ID,
              inv: inv("bot_send", 1),
              path: "output/cache-demo.mp4",
              cwd: ws,
              maxBytes: 50_000_000,
            })
            const hasher = new Bun.CryptoHasher("sha256")
            let size = 0
            let chunks = 0
            yield* Stream.runForEach(dl.chunks, (chunk) =>
              Effect.sync(() => {
                hasher.update(chunk)
                size += chunk.byteLength
                chunks++
              }),
            )
            return {
              name: dl.name,
              path: dl.path,
              size: dl.size,
              headLength: dl.head.byteLength,
              received: size,
              chunks,
              sha: hasher.digest("hex"),
            }
          }),
        )
        expect(download).toMatchObject({
          name: "cache-demo.mp4",
          path: join(ws, "output", "cache-demo.mp4"),
          size: data.byteLength,
          headLength: 4096,
        })
        expect(download.received).toBe(data.byteLength)
        expect(download.chunks).toBe(10)
        expect(download.sha).toBe(sha(data))

        // the same path policy as fs.read: other bots' workspaces and anything outside are refused
        workspace("bot_other2")
        const otherBot = yield* Effect.flip(
          Effect.scoped(
            files.download({
              nodeId: LOCAL_NODE_ID,
              inv: inv("bot_other2", 2),
              path: join(ws, "output", "cache-demo.mp4"),
              maxBytes: 50_000_000,
            }),
          ),
        )
        expect(otherBot._tag).toBe("PathDenied")
        const tooBig = yield* Effect.flip(
          Effect.scoped(
            files.download({
              nodeId: LOCAL_NODE_ID,
              inv: inv("bot_send", 3),
              path: "output/cache-demo.mp4",
              cwd: ws,
              maxBytes: 1_000_000,
            }),
          ),
        )
        expect(tooBig).toMatchObject({ _tag: "FsError", code: "EFBIG" })
        const offline = yield* Effect.flip(
          Effect.scoped(
            files.download({ nodeId: "nod_gone" as never, inv: inv("bot_send", 4), path: "x", maxBytes: 1 }),
          ),
        )
        expect(offline._tag).toBe("NodeUnavailable")
      }),
    ))

  test("NodeFiles.upload writes a streamed file into the bot's workspace (verified, atomic); a same-size file is kept", () =>
    withLocal(
      daemon(),
      Effect.gen(function* () {
        const files = yield* NodeFiles
        const ws = workspace("bot_inbox")
        const data = new Uint8Array(5 * 1024 * 1024 + 99)
        for (let i = 0; i < data.length; i++) data[i] = (i * 17 + (i >> 10)) & 0xff
        // odd chunk sizes on purpose (re-chunked to ≤ 1 MiB frames)
        const parts: Array<Uint8Array> = []
        for (let at = 0; at < data.length; at += 700_001) parts.push(data.slice(at, at + 700_001))
        const target = join(ws, "inbox", "att_9", "diagram.png")
        const first = yield* files.upload({
          nodeId: LOCAL_NODE_ID,
          inv: inv("bot_inbox", 1),
          path: target,
          size: data.byteLength,
          chunks: Stream.fromIterable(parts),
        })
        expect(first).toEqual({ path: target, size: data.byteLength, skipped: false })
        const sha = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
        expect(sha(new Uint8Array(readFileSync(target)))).toBe(sha(data))
        const again = yield* files.upload({
          nodeId: LOCAL_NODE_ID,
          inv: inv("bot_inbox", 2),
          path: target,
          size: data.byteLength,
          chunks: Stream.die("must not be read"),
        })
        expect(again.skipped).toBe(true)
        const outside = yield* Effect.flip(
          files.upload({
            nodeId: LOCAL_NODE_ID,
            inv: inv("bot_inbox", 3),
            path: "/etc/openbot-test.bin",
            size: 1,
            chunks: Stream.make(new Uint8Array([1])),
          }),
        )
        expect(outside._tag).toBe("PathDenied")
      }),
    ))

  test("a node ceiling of ask goes to ApprovalService.evaluateNode as node_local", () =>
    withLocal(
      daemon({ policy: { ceiling: "ask" } }),
      Effect.gen(function* () {
        const directory = yield* NodeDirectory
        const approvals = yield* ApprovalServiceFake
        const ws = workspace("bot_ask")
        const client = yield* directory.client(LOCAL_NODE_ID)
        const events = yield* client["shell.exec"]({
          inv: inv("bot_ask", 1),
          command: "echo approved",
          cwd: ws,
          timeoutMs: 10_000,
        }).pipe(Stream.runCollect)
        expect(outputOf(events)).toContain("approved")
        const asked = yield* approvals.nodeRequests
        expect(asked.length).toBeGreaterThanOrEqual(1)
        expect(asked[0]!.nodeId).toBe(LOCAL_NODE_ID)
        expect(asked[0]!.request).toMatchObject({
          botId: "bot_ask",
          runId: "bot_ask:cnv_bot_ask",
          action: "run-command",
        })
      }),
    ))

  test("the terminal socket runs a pty in the bot's workspace on the local node", () =>
    withLocal(
      daemon(),
      Effect.gen(function* () {
        const server = yield* startServer
        const botId = "bot_term" as BotId
        yield* putBot(makeBot({ id: botId, hostNodeId: LOCAL_NODE_ID }))
        const socket = yield* dialWebSocket(`${server.ws}/ws/terminal/${botId}?cols=100&rows=30`)
        const term = yield* open(socket)
        const decoder = new TextDecoder()
        let screen = ""
        const readUntil = (needle: string) =>
          Effect.gen(function* () {
            while (!screen.includes(needle)) {
              for (const f of yield* term.pull) screen += typeof f === "string" ? `\n[text]${f}\n` : decoder.decode(f)
            }
          }).pipe(Effect.timeout("10 seconds"))

        // xterm.js sends strings; the brain turns them into terminal bytes
        yield* term.writer.write("echo term-$((40+2)); pwd\r")
        yield* readUntil("term-42")
        yield* readUntil(join(dir.path, "bots", botId, "workspace"))
        yield* term.writer.write(JSON.stringify({ resize: { cols: 120, rows: 40 } }))
        yield* term.writer.write(new TextEncoder().encode("exit\r"))
        yield* readUntil('[text]{"exit":0')
        const closed = yield* Effect.flip(Effect.forever(term.pull)).pipe(Effect.timeout("5 seconds"))
        expect(Socket.isSocketError(closed)).toBe(true)
      }),
    ))

  test("terminal refusals: unknown bot 404, offline host 503", () =>
    withLocal(
      daemon(),
      Effect.gen(function* () {
        const server = yield* startServer
        yield* putBot(makeBot({ id: "bot_far" as BotId, hostNodeId: "nod_missing" as never }))
        const status = (botId: string) =>
          Effect.promise(
            async () =>
              (
                await fetch(`${server.http}/ws/terminal/${botId}`, {
                  headers: {
                    connection: "upgrade",
                    upgrade: "websocket",
                    "sec-websocket-version": "13",
                    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
                  },
                })
              ).status,
          )
        expect(yield* status("bot_nobody")).toBe(404)
        expect(yield* status("bot_far")).toBe(503)
      }),
    ))
})

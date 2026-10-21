#!/usr/bin/env bun
// DEV MOCK SERVER for the web UI (W2.2): serves index.html through a Bun HTML import (Tailwind via
// bunfig.toml, HMR in development) and implements `OpenBotRpcs` over Effect RPC WebSocket at /rpc
// with an in-memory brain seeded like the Grok Bot reference renders.
//
//   bun apps/web/dev/mock-server.ts [--port 4321] [--host 127.0.0.1] [--empty] [--fast]
//
// --empty starts with no Bots (first-run onboarding); --fast speeds simulated turns up 4x.
// Prints `OPENBOT_MOCK_URL=<url>` once listening (the screenshot test reads it).
import { BunHttpServer } from "@effect/platform-bun"
import { Deferred, Effect, Layer, ManagedRuntime, Result } from "effect"
import { OpenBotRpcs } from "@openbot/contracts"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import * as Socket from "effect/socket/Socket"
import indexHtml from "../index.html"
import { MockBrain } from "./mock/brain.ts"
import { ACCENTS, desktopScene, RfbSession } from "./mock/rfb.ts"
import { seed } from "./mock/seed.ts"

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

export interface MockServer {
  readonly url: string
  readonly brain: MockBrain
  readonly stop: () => Promise<void>
}

export const startMockServer = async (options: { port?: number; hostname?: string; empty?: boolean; speed?: number; development?: boolean } = {}): Promise<MockServer> => {
  const brain = new MockBrain()
  if (options.speed !== undefined) brain.speed = options.speed
  if (options.empty) brain.firstRun = true
  else seed(brain)

  const RpcLive = RpcServer.layerHttp({ group: OpenBotRpcs, path: "/rpc", protocol: "websocket", disableFatalDefects: true }).pipe(
    Layer.provide(OpenBotRpcs.toLayer(brain.handlers() as never)),
    Layer.provide(RpcSerialization.layerJson),
  )
  const Attachments = HttpRouter.add(
    "GET",
    "/api/attachments/:id",
    Effect.gen(function* () {
      const { id } = yield* HttpRouter.params
      const a = id ? brain.attachments.get(id) : undefined
      return a ? HttpServerResponse.uint8Array(a.bytes, { contentType: a.mime }) : HttpServerResponse.text("not found", { status: 404 })
    }),
  )
  // `/ws/computer/:botId?mode=view|control`: a fake RFB desktop per viewer (dev/mock/rfb.ts), with the
  // brain's refusals (404 / 409 / 403) and close codes (1000 control released, 1012 screen reset)
  const Desktop = HttpRouter.add(
    "GET",
    "/ws/computer/:botId",
    Effect.gen(function* () {
      const { botId = "" } = yield* HttpRouter.params
      const request = yield* HttpServerRequest.HttpServerRequest
      const mode = new URL(request.url, "http://mock").searchParams.get("mode") === "control" ? "control" : "view"
      const check = brain.desktopViewerCheck(botId, mode)
      if (!check.ok) return HttpServerResponse.text(check.text, { status: check.status })
      const upgraded = yield* Effect.result(request.upgrade)
      if (Result.isFailure(upgraded)) return HttpServerResponse.text("expected a WebSocket upgrade", { status: 400 })
      yield* runDesktop(brain, upgraded.success, botId, mode, check)
      return HttpServerResponse.empty()
    }),
  )
  const DesktopInput = HttpRouter.add(
    "GET",
    "/api/mock/desktop",
    Effect.sync(() => {
      const viewers = [...brain.desktopViewers.values()].reduce((n, set) => n + set.size, 0)
      return HttpServerResponse.text(JSON.stringify({ ...brain.desktopInput, viewers }), { contentType: "application/json" })
    }),
  )
  // dev helper: the Bot asks for a hand-off again (`request_takeover`) in its direct chat
  const Takeover = HttpRouter.add(
    "POST",
    "/api/mock/takeover/:botId",
    Effect.gen(function* () {
      const { botId = "" } = yield* HttpRouter.params
      const bot = brain.bot(botId)
      if (!bot) return HttpServerResponse.text("unknown bot", { status: 404 })
      const request = brain.takeover(bot.directConversationId, bot.id, "Sign in to globex.io on my screen, then hand it back")
      return HttpServerResponse.text(JSON.stringify({ requestId: request.id }), { contentType: "application/json" })
    }),
  )
  const SpeechToText = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/api/mock/stt",
      Effect.sync(() =>
        HttpServerResponse.text(JSON.stringify({ status: brain.stt, discards: brain.sttDiscards }), {
          contentType: "application/json",
        })),
    ),
    HttpRouter.add(
      "POST",
      "/api/mock/stt",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const query = new URL(request.url, "http://mock").searchParams
        brain.sttFailsAppend = query.get("failsAppend") === "1"
        if (query.get("resetToReady") === "1") brain.stt = { state: "ready", model: brain.stt.model }
        return HttpServerResponse.empty()
      }),
    ),
  )
  const development = options.development ?? process.env.NODE_ENV !== "production"
  const ServerLive = HttpRouter.serve(Layer.mergeAll(RpcLive, Attachments, Desktop, DesktopInput, Takeover, SpeechToText), { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(
      BunHttpServer.layer({
        port: options.port ?? 4321,
        hostname: options.hostname ?? "127.0.0.1",
        idleTimeout: 0,
        routes: { "/": indexHtml },
        development: development ? { hmr: true, console: true } : false,
      }),
    ),
  )
  const runtime = ManagedRuntime.make(ServerLive as Layer.Layer<HttpServer.HttpServer, unknown>)
  const server = await runtime.runPromise(HttpServer.HttpServer)
  const address = server.address as { readonly port: number; readonly hostname?: string }
  const url = `http://${options.hostname ?? "127.0.0.1"}:${address.port}`
  brain.origin = url
  return {
    url,
    brain,
    stop: async () => {
      await Promise.race([runtime.dispose(), Bun.sleep(1500)])
    },
  }
}

/** One viewer: RFB handshake + updates until either side closes (or the brain closes it: release / reset). */
const runDesktop = (brain: MockBrain, socket: Socket.Socket, botId: string, mode: "view" | "control", look: { readonly accent: string; readonly page: "signin" | "dashboard" }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const reader = yield* socket.reader
      const writer = yield* socket.writer
      // like the brain when it can't start or reach the screen: 1011 + the reason
      const broken = brain.desktopBroken.get(botId)
      if (broken !== undefined) return yield* Effect.ignore(writer.write(new Socket.CloseEvent(1011, broken)))
      const width = 1920
      const height = 1200
      const session = new RfbSession({
        width,
        height,
        name: `${brain.bot(botId)?.name ?? "Bot"}'s computer`,
        scene: desktopScene({ width, height, accent: ACCENTS[look.accent] ?? ACCENTS["blue"]!, page: look.page }),
        control: mode === "control",
        onInput: (e) => {
          if (e.kind === "pointer") brain.desktopInput.pointer++
          else brain.desktopInput.keys++
        },
      })
      const closed = yield* Deferred.make<{ readonly code: number; readonly reason: string }>()
      const leave = brain.joinDesktop(botId, { mode, close: (code, reason) => void Deferred.doneUnsafe(closed, Effect.succeed({ code, reason })) })
      yield* Effect.addFinalizer(() => Effect.sync(leave))
      yield* writer.write(session.greeting())
      const pump = Effect.forever(
        Effect.flatMap(reader.pull, (frames) =>
          Effect.forEach(
            frames,
            (frame) => {
              const out = session.receive(typeof frame === "string" ? new TextEncoder().encode(frame) : frame)
              if (session.closed) return Effect.andThen(writer.write(new Socket.CloseEvent(1011, "unsupported RFB message")), Effect.fail("closed" as const))
              return out.length > 0 ? writer.writeAll(out as unknown as readonly [Uint8Array, ...Uint8Array[]]) : Effect.void
            },
            { discard: true },
          ),
        ),
      )
      const ended = yield* Effect.raceFirst(
        Effect.as(Effect.exit(pump), undefined),
        Deferred.await(closed),
      )
      if (ended) yield* Effect.ignore(writer.write(new Socket.CloseEvent(ended.code, ended.reason)))
    }),
  ).pipe(Effect.catchCause(() => Effect.void))

const webDir = new URL("..", import.meta.url).pathname.replace(/\/$/, "")

if (import.meta.main && process.cwd() !== webDir && !process.env.OPENBOT_MOCK_CHILD) {
  // Bun reads bunfig.toml (the Tailwind plugin for HTML imports) from the working directory and
  // resolves the plugin from there; only apps/web declares it. Re-run from apps/web.
  const child = Bun.spawn([process.execPath, "dev/mock-server.ts", ...process.argv.slice(2)], {
    cwd: webDir,
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, OPENBOT_MOCK_CHILD: "1" },
  })
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig))
  process.exit(await child.exited)
} else if (import.meta.main) {
  const port = Number(arg("port") ?? process.env.PORT ?? 4321)
  const server = await startMockServer({
    port,
    hostname: arg("host") ?? "127.0.0.1",
    empty: flag("empty"),
    ...(flag("fast") ? { speed: 0.25 } : {}),
  })
  console.log(`OpenBot web dev mock: ${server.url}`)
  console.log(`OPENBOT_MOCK_URL=${server.url}`)
  const shutdown = async () => {
    await server.stop()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

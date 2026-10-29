/**
 * Route layers for the server (W2.1). brain-nodes owns no listener: the server adds these to its
 * routers (D1.8).
 *
 * PUBLIC listener:
 *   GET  /node              signed control socket          (NodeGateway.control)
 *   POST /node/pair         pairing                        (NodeGateway.pair)
 *   GET  /node/stream/:id   one-time data streams          (NodeGateway.stream)
 *   GET  /node/install.sh, /node/download/:target          (NodeInstall, when the brain can build the node)
 *   GET  /ws/computer/:botId?mode=view|control[&passive=1] (ComputerService.viewer, after `authorize`)
 *   GET  /ws/terminal/:botId?cols=&rows=                   (ComputerService.terminal, after `authorize`)
 * INTERNAL listener (loopback):
 *   GET  /relay/:nodeId/:kind                              (RelayService.handle)
 *
 * Every WebSocket route goes through `HttpServerRequest.upgrade`, so the server must use
 * `BunHttpServer` (not `toWebHandler`), with WebSocket pings on (`sendPings`) or `idleTimeout: 0`,
 * so quiet data streams are not dropped (RPC pings keep control sockets alive anyway).
 */
import type { DataDir } from "@openbot/core"
import { Routes } from "@openbot/node-protocol"
import { Effect, Layer } from "effect"
import type { Scope } from "effect"
import { HttpRouter, HttpServerRequest, type HttpServerResponse } from "effect/http"
import { ComputerService } from "./Computer.ts"
import type { BrainNodesConfig } from "./config.ts"
import { NodeGateway } from "./NodeGateway.ts"
import { addInstallRoutes } from "./NodeInstall.ts"
import { RelayService } from "./Relay.ts"

/**
 * `HttpRouter.use` spelled out: a layer that adds routes to the server's router. (oxlint's React
 * plugin mistakes a call named `use` for a hook.)
 */
const routes = <E, R>(
  add: (router: HttpRouter.HttpRouter) => Effect.Effect<void, E, R>,
): Layer.Layer<never, E, HttpRouter.HttpRouter | Exclude<R, Scope.Scope>> =>
  Layer.effectDiscard(Effect.flatMap(HttpRouter.HttpRouter, add))

/** `/node`, `/node/pair`, `/node/stream/:id` (public listener). */
export const NodePublicRoutes: Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | NodeGateway | BrainNodesConfig | DataDir
> = routes(
  Effect.fnUntraced(function* (router) {
    const gateway = yield* NodeGateway
    yield* router.add("GET", Routes.control, gateway.control)
    yield* router.add("POST", Routes.pair, gateway.pair)
    yield* router.add(
      "GET",
      Routes.streamPattern as `/${string}`,
      Effect.flatMap(HttpRouter.params, (params) => gateway.stream(params["id"] ?? "")),
    )
    yield* addInstallRoutes(router)
  }),
)

/** `/relay/:nodeId/:kind` (internal listener only: never expose it publicly). */
export const NodeInternalRoutes: Layer.Layer<never, never, HttpRouter.HttpRouter | RelayService> = routes(
  Effect.fnUntraced(function* (router) {
    const relays = yield* RelayService
    yield* router.add(
      "GET",
      "/relay/:nodeId/:kind",
      Effect.flatMap(HttpRouter.params, (params) => relays.handle(params["nodeId"] ?? "", params["kind"] ?? "")),
    )
  }),
)

export type ViewerSurface = "computer-view" | "computer-control" | "terminal"

/**
 * Authorizes a viewer upgrade (cookie session, Origin allow-list, bot ACL; D4.4). Return `undefined`
 * to allow, or the refusal response (401/403).
 */
export type ViewerAuthorizer<R> = (input: {
  readonly request: HttpServerRequest.HttpServerRequest
  readonly botId: string
  readonly surface: ViewerSurface
}) => Effect.Effect<HttpServerResponse.HttpServerResponse | undefined, never, R>

const queryOf = (request: HttpServerRequest.HttpServerRequest) => new URL(request.url, "http://localhost").searchParams

const numberParam = (value: string | null): number | undefined => {
  if (value === null || value.trim() === "") return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/**
 * `/ws/computer/:botId` and `/ws/terminal/:botId` (public listener). `authorize` runs before any
 * upgrade; brain-nodes does not know about web sessions. An allowed viewer closes once
 * `closeWhen(botId)` completes.
 */
export const ViewerRoutes = <R>(
  authorize: ViewerAuthorizer<R>,
  closeWhen?: (botId: string) => Effect.Effect<void, never, R>,
): Layer.Layer<never, never, HttpRouter.HttpRouter | ComputerService | R> =>
  routes(
    Effect.fnUntraced(function* (router) {
      const computer = yield* ComputerService
      const context = yield* Effect.context<R>()
      const guard = (
        surface: (request: HttpServerRequest.HttpServerRequest) => ViewerSurface,
        handler: (
          request: HttpServerRequest.HttpServerRequest,
          botId: string,
          until: Effect.Effect<void> | undefined,
        ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>,
      ) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const params = yield* HttpRouter.params
          const botId = params["botId"] ?? ""
          const refused = yield* Effect.provide(authorize({ request, botId, surface: surface(request) }), context)
          if (refused !== undefined) return refused
          const until = closeWhen === undefined ? undefined : Effect.provide(closeWhen(botId), context)
          return yield* handler(request, botId, until)
        })
      yield* router.add(
        "GET",
        "/ws/computer/:botId",
        guard(
          (request) => (queryOf(request).get("mode") === "control" ? "computer-control" : "computer-view"),
          (request, botId, until) =>
            computer.viewer({
              botId,
              mode: queryOf(request).get("mode") === "control" ? "control" : "view",
              passive: queryOf(request).get("passive") === "1",
              closeWhen: until,
            }),
        ),
      )
      yield* router.add(
        "GET",
        "/ws/terminal/:botId",
        guard(
          () => "terminal",
          (request, botId, until) => {
            const q = queryOf(request)
            return computer.terminal({
              botId,
              cols: numberParam(q.get("cols")),
              rows: numberParam(q.get("rows")),
              closeWhen: until,
            })
          },
        ),
      )
    }),
  )

/** Test/dev helper: a `ViewerAuthorizer` that allows everything. Never use it on a real listener. */
export const allowAllViewers: ViewerAuthorizer<never> = () => Effect.succeed(undefined)

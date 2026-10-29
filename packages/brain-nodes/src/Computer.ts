/**
 * `ComputerService` (architecture §4.8, §5.5; D1.7; remote-computer-control.md §5): the bot's screen
 * on its host node, and the user's terminal there.
 *
 * Surface (per host node, effective capabilities): `desktop` with `desktop@1` (a whole X desktop
 * per bot: noVNC view), else `screen` with `screen@1` (a Mac's own screen, shared: screenshot frames
 * framed like the CDP screencast, input through `screen.input`), else `browser` with `browser@1`
 * (the bot's browser window: CDP screencast), else `none`. A node that lacks desktops but says what it misses (`node.hello.desktop.missing`)
 * gets `missing` in the status, whatever its surface, so the UI can say what to install.
 *
 * - `ComputerPort` (`computer.status / ensure / lease / reset`): `ensure` → `desktop.ensure` or
 *   `browser.ensure` on the host node (one at a time per bot). The brain owns the control LEASE and
 *   mirrors it with `lease.set`; while the user holds it the node refuses the bot's `computer.act` /
 *   `browser.action` with `LeaseHeld`. Handing it back closes the control viewers. `reset` stops a
 *   desktop (`desktop.stop`, which also ends the user's control) and closes its viewers. Every change
 *   of holder is published on `leaseChanges` (core answers pending hand-offs from it).
 * - Idle desktops sleep: a ready desktop goes to `desktop.stop` after `desktopIdleMs` (10 min) with
 *   nothing keeping it awake: nobody watching (passive viewers, the side preview with `passive=1`,
 *   do not count and are closed with 1012), the bot in control, and no work for the bot (an active
 *   turn, a queued or running task, a pending hand-off). Its next use starts it again (a viewer, a
 *   bot action, `computer.ensure`); the browser profile, so every login, stays.
 * - Viewer socket (`/ws/computer/:botId?mode=view|control`, public listener; the server checks the
 *   cookie, Origin and bot ACL first; `control` answers 403 unless the user holds the lease):
 *   - desktop: raw RFB both ways between the viewer (noVNC, binary frames) and ONE node data stream
 *     per viewer (`computer.stream` → `vnc-view` / `vnc-control`; VNC is stateful per connection).
 *     The desktop is ensured first. Close codes to the viewer: 1000 "control released" (control
 *     viewers, when the lease is handed back), 1012 "screen reset" (every viewer, `reset`), 4403
 *     "take control first" (control without the lease), 1011 + reason (the screen could not be
 *     started or reached, or its stream ended); a code the node closed the stream with is forwarded.
 *   - browser: one CDP screencast per bot is fanned out to every viewer (one node data stream per
 *     bot). Binary frames are `encodeScreencastFrame` frames, text frames are `ScreencastNotice`
 *     JSON, both forwarded verbatim. New viewers get the last frame and URL immediately (idle pages do
 *     not repaint). In `control` mode (lease holder only), text frames from the viewer are
 *     `BrowserInputEvent` JSON and go to `browser.input`.
 * - Terminal socket (`/ws/terminal/:botId?cols=&rows=`): `pty.open` in the bot's workspace on its host
 *   node (created first), spliced to the node's `pty` stream (binary = terminal bytes; text =
 *   `{"resize":{cols,rows}}` from the viewer, `{"exit":…}` from the node). For xterm.js, whose
 *   `onData` yields strings, any OTHER text frame from the viewer is forwarded as UTF-8 terminal
 *   bytes. On failure the viewer gets a text frame `{"error": "…"}` and a 1011 close.
 */
import type { BotId, ComputerState, ComputerStatus, NodeId, NodeSummary } from "@openbot/contracts"
import { Conflict, LOCAL_NODE_ID, NodeUnavailable, NotFound } from "@openbot/contracts"
import {
  BotRepo,
  type ComputerLeaseChange,
  ComputerPort,
  DataDir,
  IdGen,
  NodeDirectory,
  RequestRepo,
  TaskRepo,
  TurnRepo,
  workspacePathFor,
} from "@openbot/core"
import {
  BrowserInputEvent,
  describeNodeError,
  type DesktopSupport,
  hasCapability,
  type LeaseHolder,
  NodeEventTypes,
  PtyResize,
} from "@openbot/node-protocol"
import { Clock, Context, Effect, Exit, Fiber, Layer, Option, PubSub, Result, Schema, Semaphore, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import type * as Socket from "effect/socket/Socket"
import { mkdir } from "node:fs/promises"
import { BrainNodesConfig } from "./config.ts"
import { NodeRegistry } from "./NodeRegistry.ts"
import { closedWhen, closeWriter, type Duplex, type Frame, open, splice } from "./splice.ts"
import { openNodeStream, StreamBroker } from "./StreamBroker.ts"

type Handler = Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>

export type ViewerMode = "view" | "control"

/** WebSocket close codes the desktop viewer socket uses (see the header). */
export const DesktopCloseCodes = {
  /** The user handed control back: control viewers close; reconnect in `view` mode. */
  released: 1000,
  /** The stream failed or the screen could not be started/reached (the reason says why). */
  failed: 1011,
  /** `computer.reset` stopped the desktop: reconnect to get the fresh one. */
  reset: 1012,
  /** `mode=control` without holding the lease. */
  controlRefused: 4403,
} as const

/** How long `desktop.ensure` may take before the screen counts as failed. */
const DESKTOP_START_TIMEOUT = "60 seconds"
/** How long a Mac may take to answer `screen.ensure` (it may be showing a permission prompt). */
const SCREEN_CHECK_TIMEOUT = "30 seconds"

export interface ComputerServiceShape {
  readonly status: (botId: BotId) => Effect.Effect<ComputerStatus, NotFound>
  readonly ensure: (botId: BotId) => Effect.Effect<ComputerStatus, NotFound | NodeUnavailable>
  readonly lease: (botId: BotId, take: boolean) => Effect.Effect<ComputerStatus, NotFound | NodeUnavailable | Conflict>
  readonly reset: (botId: BotId) => Effect.Effect<ComputerStatus, NotFound | NodeUnavailable>
  readonly leaseChanges: Stream.Stream<ComputerLeaseChange>
  /** `GET /ws/computer/:botId?mode=view|control` — call AFTER the server authorized the request. */
  readonly viewer: (input: {
    readonly botId: string
    readonly mode: ViewerMode
    readonly passive?: boolean | undefined
    /** The viewer closes once it completes. */
    readonly closeWhen?: Effect.Effect<void> | undefined
  }) => Handler
  /** `GET /ws/terminal/:botId?cols=&rows=` — call AFTER the server authorized the request. */
  readonly terminal: (input: {
    readonly botId: string
    readonly cols?: number | undefined
    readonly rows?: number | undefined
    /** The terminal closes once it completes. */
    readonly closeWhen?: Effect.Effect<void> | undefined
  }) => Handler
  /** Viewers currently attached to a bot's screen (screencast or desktop relays; tests, diagnostics). */
  readonly viewerCount: (botId: BotId) => Effect.Effect<number>
}

export class ComputerService extends Context.Service<ComputerService, ComputerServiceShape>()(
  "openbot/brain-nodes/ComputerService",
) {}

type Surface = "browser" | "desktop" | "screen"

interface BotComputer {
  readonly nodeId: NodeId
  readonly surface: Surface
  state: ComputerState
  message: string | undefined
  windowTargetId: string | undefined
  /** desktop: the screen size `desktop.ensure` reported */
  width?: number | undefined
  height?: number | undefined
  /** desktop: programs the node said it lacks (`DesktopUnavailable.missing`) */
  missing?: ReadonlyArray<string> | undefined
}

/** A viewer relayed to its own node VNC stream. */
interface DesktopViewer {
  readonly id: number
  readonly mode: ViewerMode
  readonly writer: Socket.Writer
  /** a preview (the side thumbnail): it does not keep the screen awake */
  readonly passive: boolean
}

interface Viewer {
  readonly id: number
  readonly mode: ViewerMode
  readonly writer: Socket.Writer
}

interface Hub {
  readonly botId: BotId
  readonly nodeId: NodeId
  /** the bot's browser window (CDP screencast) or the Mac's own screen */
  readonly surface: "browser" | "screen"
  readonly viewers: Map<number, Viewer>
  lastFrame: Uint8Array | undefined
  lastUrl: string | undefined
  fiber: Fiber.Fiber<void> | undefined
}

const surfaceOf = (capabilities: ReadonlyArray<string>): ComputerStatus["surface"] =>
  hasCapability(capabilities, "desktop")
    ? "desktop"
    : hasCapability(capabilities, "screen")
      ? "screen"
      : hasCapability(capabilities, "browser")
        ? "browser"
        : "none"

const decodeInput = Schema.decodeUnknownOption(Schema.fromJsonString(BrowserInputEvent))
const decodeNotice = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ _tag: Schema.String })))

/** Programs a node lacks for desktops, from a `DesktopUnavailable` failure. */
const missingOf = (e: unknown): ReadonlyArray<string> | undefined => {
  if (typeof e !== "object" || e === null || (e as { _tag?: unknown })._tag !== "DesktopUnavailable") return undefined
  const missing = (e as { missing?: ReadonlyArray<string> | undefined }).missing
  return missing !== undefined && missing.length > 0 ? missing : undefined
}

const nodeErrorText = (e: unknown): string => {
  if (typeof e === "object" && e !== null && "_tag" in e) {
    const tag = (e as { _tag: string })._tag
    if (tag === "RpcClientError") return "the computer is unreachable"
    if (tag === "TimeoutError") return "the screen took too long to start"
    if (tag === "DesktopUnavailable") {
      const message = (e as { message?: unknown }).message
      const missing = missingOf(e)
      return `${typeof message === "string" && message !== "" ? message : "The desktop is unavailable"}${
        missing === undefined ? "" : ` (missing: ${missing.join(", ")})`
      }`
    }
    try {
      return describeNodeError(e as Parameters<typeof describeNodeError>[0]) ?? tag
    } catch {
      return tag
    }
  }
  return String(e)
}

/** VNC streams are raw binary; a stray text frame is passed on as its UTF-8 bytes. */
const binaryFrame = (frame: Frame): Frame => (typeof frame === "string" ? utf8.encode(frame) : frame)

const decodePtyResize = Schema.decodeUnknownOption(Schema.fromJsonString(PtyResize))
const isPtyResize = (text: string): boolean => text.startsWith("{") && Option.isSome(decodePtyResize(text))
const utf8 = new TextEncoder()

/**
 * Viewer → node frames of the terminal socket: binary and `{"resize":…}` pass verbatim; any other text
 * (xterm.js `onData` strings) becomes UTF-8 terminal bytes, since the node treats text as control.
 */
export const terminalInputFrame = (frame: Frame): Frame =>
  typeof frame !== "string" || isPtyResize(frame) ? frame : utf8.encode(frame)

/**
 * Any failure reaching a node, as the CONTRACT `NodeUnavailable{nodeId, message}` (the error the
 * `OpenBotRpcs` and the gateway render). node-protocol has its own `NodeUnavailable{nodeId, reason}`
 * and typed wire errors; those become the message text.
 */
export const toNodeUnavailable = (nodeId: NodeId, error: unknown): NodeUnavailable =>
  error instanceof NodeUnavailable ? error : new NodeUnavailable({ nodeId, message: nodeErrorText(error) })

const clampSize = (n: number | undefined, fallback: number, max: number) =>
  n === undefined || !Number.isFinite(n) || n < 1 ? fallback : Math.min(Math.floor(n), max)

export const makeComputerService = Effect.gen(function* () {
  const bots = yield* BotRepo
  const directory = yield* NodeDirectory
  const registry = yield* NodeRegistry
  const broker = yield* StreamBroker
  const dataDir = yield* DataDir
  const ids = yield* IdGen
  const turns = yield* TurnRepo
  const tasks = yield* TaskRepo
  const requests = yield* RequestRepo
  const config = yield* BrainNodesConfig
  const layerScope = yield* Effect.scope

  const computers = new Map<BotId, BotComputer>()
  const controllers = new Map<BotId, LeaseHolder>()
  const hubs = new Map<BotId, Hub>()
  const hubLock = yield* Semaphore.make(1)
  const ensureLocks = new Map<BotId, Semaphore.Semaphore>()
  const desktopViewers = new Map<BotId, Map<number, DesktopViewer>>()
  /** When each ready desktop last had something keeping it awake (cleared when it starts). */
  const lastAwake = new Map<BotId, number>()
  const leaseChanges = yield* PubSub.unbounded<ComputerLeaseChange>()
  yield* Effect.addFinalizer(() => PubSub.shutdown(leaseChanges))
  let viewerSeq = 0

  const getBot = (botId: BotId) =>
    Effect.flatMap(Effect.orDie(bots.get(botId)), (bot) =>
      Option.isSome(bot) ? Effect.succeed(bot.value) : Effect.fail(new NotFound({ entity: "bot", id: botId })),
    )

  const controllerOf = (botId: BotId): LeaseHolder => controllers.get(botId) ?? "bot"

  /** What the node said about desktops at its last `node.hello` (absent on older nodes). */
  const desktopSupportOf = (nodeId: NodeId) =>
    Effect.map(registry.connection(nodeId), (conn) => (Option.isSome(conn) ? conn.value.hello.desktop : undefined))
  /** What a Mac said about its own screen at its last `node.hello`. */
  const screenSupportOf = (nodeId: NodeId) =>
    Effect.map(registry.connection(nodeId), (conn) => (Option.isSome(conn) ? conn.value.hello.screen : undefined))

  const sizeOf = (current: BotComputer | undefined, support: DesktopSupport | undefined) => {
    const width = current?.width ?? support?.width
    const height = current?.height ?? support?.height
    return width !== undefined && height !== undefined && width > 0 && height > 0 ? { width, height } : {}
  }

  const statusOf = (botId: BotId) =>
    Effect.gen(function* () {
      const bot = yield* getBot(botId)
      const nodeId = bot.hostNodeId
      const node = yield* Effect.option(directory.get(nodeId))
      const base = { botId, nodeId, controller: controllerOf(botId) } as const
      if (Option.isNone(node)) {
        return {
          ...base,
          state: "error",
          surface: "none",
          message: `Can't reach ${bot.name}'s computer`,
        } satisfies ComputerStatus
      }
      const support = yield* desktopSupportOf(nodeId)
      const screenSupport = yield* screenSupportOf(nodeId)
      // the node could give a screen if it had these programs or permissions (shown whatever the surface)
      const lackingList = screenSupport !== undefined ? screenSupport.missing : (support?.missing ?? [])
      const lacking = lackingList.length > 0 ? { missing: lackingList } : {}
      const surface = surfaceOf(node.value.capabilities)
      if (surface === "none") {
        return {
          ...base,
          state: "unsupported",
          surface,
          message:
            "missing" in lacking
              ? `${node.value.label} can't give ${bot.name} a screen yet`
              : `${node.value.label} has no browser for ${bot.name}`,
          ...lacking,
        } satisfies ComputerStatus
      }
      const viewPath = `/ws/computer/${botId}`
      const c = computers.get(botId)
      const current = c !== undefined && c.nodeId === nodeId && c.surface === surface ? c : undefined
      const size =
        surface === "desktop" ? sizeOf(current, support) : surface === "screen" ? sizeOf(current, screenSupport) : {}
      const missing =
        surface === "browser"
          ? lacking
          : current?.missing !== undefined
            ? { missing: current.missing }
            : // a Mac's permissions as of its hello, until the screen was used
              surface === "screen" && current?.state !== "ready"
              ? lacking
              : {}
      if (node.value.status !== "online") {
        return {
          ...base,
          state: "error",
          surface,
          viewPath,
          message: `Can't reach ${bot.name}'s screen: ${node.value.label} is offline`,
          ...size,
          ...missing,
        } satisfies ComputerStatus
      }
      return {
        ...base,
        state: current?.state ?? "absent",
        surface,
        viewPath,
        ...(current?.message === undefined ? {} : { message: current.message }),
        ...size,
        ...missing,
      } satisfies ComputerStatus
    })

  const setComputer = (
    botId: BotId,
    nodeId: NodeId,
    surface: Surface,
    patch: Partial<Omit<BotComputer, "nodeId" | "surface">>,
  ) =>
    Effect.sync(() => {
      const prev = computers.get(botId)
      const base: BotComputer =
        prev !== undefined && prev.nodeId === nodeId && prev.surface === surface
          ? prev
          : { nodeId, surface, state: "absent", message: undefined, windowTargetId: undefined }
      computers.set(botId, { ...base, ...patch })
    })

  const lockFor = (botId: BotId) =>
    Effect.suspend(() => {
      const existing = ensureLocks.get(botId)
      if (existing !== undefined) return Effect.succeed(existing)
      return Effect.map(Semaphore.make(1), (s) => {
        ensureLocks.set(botId, s)
        return s
      })
    })

  // ---------------------------------------------------------------- viewers (fan-out)
  const broadcast = (hub: Hub, frame: Frame, filter?: (v: Viewer) => boolean) =>
    Effect.forEach(
      [...hub.viewers.values()].filter((v) => filter === undefined || filter(v)),
      (v) => Effect.ignore(v.writer.write(frame)),
      { discard: true },
    )

  const notice = (body: Record<string, unknown>) => JSON.stringify(body)

  const closeViewers = (hub: Hub, code: number, reason: string, filter?: (v: Viewer) => boolean) =>
    Effect.forEach(
      [...hub.viewers.values()].filter((v) => filter === undefined || filter(v)),
      (v) => closeWriter(v.writer, code, reason),
      { discard: true },
    )

  /** Close a bot's desktop viewers (all, or one mode); their node streams close with them. */
  const closeDesktopViewers = (botId: BotId, code: number, reason: string, mode?: ViewerMode) =>
    Effect.forEach(
      [...(desktopViewers.get(botId)?.values() ?? [])].filter((v) => mode === undefined || v.mode === mode),
      (v) => closeWriter(v.writer, code, reason),
      { discard: true },
    )

  const mirrorLease = (botId: BotId, nodeId: NodeId, holder: LeaseHolder) =>
    Effect.flatMap(directory.client(nodeId), (client) => client["lease.set"]({ botId, holder }))

  /** Records the new holder; publishes a change when there is one. */
  const setController = (botId: BotId, holder: LeaseHolder, cause: ComputerLeaseChange["cause"]) =>
    Effect.suspend(() => {
      const before = controllerOf(botId)
      controllers.set(botId, holder)
      return before === holder
        ? Effect.void
        : PubSub.publish(leaseChanges, { botId, holder, cause }).pipe(Effect.asVoid)
    })

  // ---------------------------------------------------------------- ComputerPort
  const ensure: ComputerServiceShape["ensure"] = (botId) =>
    Effect.gen(function* () {
      const lock = yield* lockFor(botId)
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const s = yield* statusOf(botId)
          if (s.state === "unsupported" || s.state === "ready" || s.surface === "none") return s
          const surface = s.surface
          const client = yield* directory.client(s.nodeId)
          yield* setComputer(botId, s.nodeId, surface, { state: "starting", message: undefined })
          if (surface === "desktop") {
            const ensured = yield* Effect.result(
              client["desktop.ensure"]({ botId }).pipe(Effect.timeout(DESKTOP_START_TIMEOUT)),
            )
            if (Result.isFailure(ensured)) {
              yield* setComputer(botId, s.nodeId, surface, {
                state: "error",
                message: `Can't start the screen: ${nodeErrorText(ensured.failure)}`,
                missing: missingOf(ensured.failure),
              })
            } else {
              lastAwake.delete(botId)
              yield* setComputer(botId, s.nodeId, surface, {
                state: "ready",
                message: undefined,
                width: ensured.success.width,
                height: ensured.success.height,
                missing: undefined,
              })
            }
          } else if (surface === "screen") {
            const ensured = yield* Effect.result(
              client["screen.ensure"]({ botId }).pipe(Effect.timeout(SCREEN_CHECK_TIMEOUT)),
            )
            if (Result.isFailure(ensured)) {
              const failure = ensured.failure
              yield* setComputer(botId, s.nodeId, surface, {
                state: "error",
                // a Mac's permissions: its own words say what to allow
                message:
                  typeof failure === "object" &&
                  failure !== null &&
                  "_tag" in failure &&
                  failure._tag === "DesktopUnavailable"
                    ? failure.message
                    : `Can't use the screen: ${nodeErrorText(failure)}`,
                missing: missingOf(failure),
              })
            } else {
              yield* setComputer(botId, s.nodeId, surface, {
                state: "ready",
                message: undefined,
                width: ensured.success.width,
                height: ensured.success.height,
                missing: undefined,
              })
            }
          } else {
            const ensured = yield* Effect.result(client["browser.ensure"]({ botId }))
            if (Result.isFailure(ensured)) {
              yield* setComputer(botId, s.nodeId, surface, { state: "error", message: nodeErrorText(ensured.failure) })
            } else {
              yield* setComputer(botId, s.nodeId, surface, {
                state: "ready",
                message: undefined,
                windowTargetId: ensured.success.windowTargetId,
              })
            }
          }
          const after = yield* statusOf(botId)
          if (after.state === "ready" && controllerOf(botId) === "user")
            yield* Effect.ignore(mirrorLease(botId, s.nodeId, "user"))
          return after
        }),
      )
    })

  const lease: ComputerServiceShape["lease"] = (botId, take) =>
    Effect.gen(function* () {
      const s = yield* statusOf(botId)
      if (s.surface === "none" || s.state === "unsupported") {
        return yield* new Conflict({ reason: "This computer has no screen to take over" })
      }
      const holder: LeaseHolder = take ? "user" : "bot"
      const mirrored = yield* Effect.result(mirrorLease(botId, s.nodeId, holder))
      // Taking control needs the node (it must refuse the bot); handing back never gets stuck on an
      // unreachable node: it gets the lease again when it reconnects.
      if (Result.isFailure(mirrored) && take) return yield* toNodeUnavailable(s.nodeId, mirrored.failure)
      if (!take) yield* closeDesktopViewers(botId, DesktopCloseCodes.released, "control released", "control")
      const hub = hubs.get(botId)
      if (hub !== undefined) {
        yield* broadcast(hub, notice({ _tag: "Lease", holder }))
        if (!take) yield* closeViewers(hub, 1000, "control released", (v) => v.mode === "control")
      }
      yield* setController(botId, holder, "lease")
      return yield* statusOf(botId)
    })

  const reset: ComputerServiceShape["reset"] = (botId) =>
    Effect.gen(function* () {
      const s = yield* statusOf(botId)
      // only desktops can be reset; a browser window has nothing to start over
      if (s.surface !== "desktop") return s
      const lock = yield* lockFor(botId)
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const client = yield* directory.client(s.nodeId)
          yield* closeDesktopViewers(botId, DesktopCloseCodes.reset, "screen reset")
          const stopped = yield* Effect.result(client["desktop.stop"]({ botId }))
          if (Result.isFailure(stopped)) return yield* toNodeUnavailable(s.nodeId, stopped.failure)
          yield* setComputer(botId, s.nodeId, "desktop", {
            state: "absent",
            message: undefined,
            width: undefined,
            height: undefined,
            missing: undefined,
          })
          // stopping the desktop ended the user's control on the node too
          yield* setController(botId, "bot", "reset")
        }),
      )
      return yield* statusOf(botId)
    })

  // ---------------------------------------------------------------- screencast hub
  /** Pump the bot's screencast to every viewer until the node stream ends or the hub stops. */
  const runHub = (hub: Hub) =>
    Effect.scoped(
      Effect.gen(function* () {
        const ensured = yield* Effect.result(ensure(hub.botId))
        if (Result.isFailure(ensured) || ensured.success.state !== "ready") {
          const message = Result.isFailure(ensured)
            ? ensured.failure.message
            : (ensured.success.message ??
              (hub.surface === "screen" ? "The screen is not available" : "The browser is not available"))
          return yield* broadcast(hub, notice({ _tag: "Ended", reason: message }))
        }
        const client = yield* directory.client(hub.nodeId)
        const opened = yield* Effect.result(
          hub.surface === "screen"
            ? Effect.map(
                openNodeStream(broker, {
                  nodeId: hub.nodeId,
                  kind: "screen",
                  open: (ticket) =>
                    client["screen.stream"]({
                      botId: hub.botId,
                      streamId: ticket.streamId,
                      streamToken: ticket.streamToken,
                    }),
                }),
                (o) => o.socket,
              ).pipe(Effect.mapError((e): unknown => e))
            : Effect.map(
                openNodeStream(broker, {
                  nodeId: hub.nodeId,
                  kind: "cdp-screencast",
                  open: (ticket) =>
                    client["browser.screencast"]({
                      botId: hub.botId,
                      streamId: ticket.streamId,
                      streamToken: ticket.streamToken,
                    }),
                }),
                (o) => o.socket,
              ).pipe(Effect.mapError((e): unknown => e)),
        )
        if (Result.isFailure(opened)) {
          return yield* broadcast(hub, notice({ _tag: "Ended", reason: nodeErrorText(opened.failure) }))
        }
        const node = yield* open(opened.success)
        const pumped = yield* Effect.exit(
          Effect.forever(
            Effect.flatMap(node.pull, (frames) =>
              Effect.forEach(
                frames,
                (frame) => {
                  if (typeof frame === "string") {
                    const tag = decodeNotice(frame)
                    if (Option.isSome(tag) && tag.value._tag === "Url") hub.lastUrl = frame
                  } else {
                    hub.lastFrame = frame
                  }
                  return broadcast(hub, frame)
                },
                { discard: true },
              ),
            ),
          ),
        )
        if (Exit.isFailure(pumped)) {
          yield* broadcast(hub, notice({ _tag: "Ended", reason: "The screen stream ended" }))
        }
      }),
    ).pipe(
      Effect.catchCause((cause) => Effect.logDebug("screencast hub ended", { botId: hub.botId, cause })),
      Effect.ensuring(
        hubLock.withPermits(1)(
          Effect.suspend(() => {
            if (hubs.get(hub.botId) === hub) hubs.delete(hub.botId)
            // viewers fall back to reconnecting; they get a fresh hub
            return closeViewers(hub, 1011, "screen stream ended")
          }),
        ),
      ),
    )

  const joinHub = (botId: BotId, nodeId: NodeId, surface: Hub["surface"], viewer: Omit<Viewer, "id">) =>
    hubLock
      .withPermits(1)(
        Effect.gen(function* () {
          let hub = hubs.get(botId)
          let stale: Fiber.Fiber<void> | undefined
          if (hub !== undefined && (hub.nodeId !== nodeId || hub.surface !== surface)) {
            // the bot moved to another node: stop the old stream (outside the lock, as in leaveHub)
            stale = hub.fiber
            hubs.delete(botId)
            hub = undefined
          }
          const v: Viewer = { ...viewer, id: ++viewerSeq }
          if (hub === undefined) {
            const created: Hub = {
              botId,
              nodeId,
              surface,
              viewers: new Map([[v.id, v]]),
              lastFrame: undefined,
              lastUrl: undefined,
              fiber: undefined,
            }
            hubs.set(botId, created)
            created.fiber = yield* Effect.forkIn(runHub(created), layerScope, { startImmediately: true })
            return { hub: created, viewer: v, stale }
          }
          hub.viewers.set(v.id, v)
          return { hub, viewer: v, stale }
        }),
      )
      .pipe(Effect.tap(({ stale }) => (stale === undefined ? Effect.void : Fiber.interrupt(stale))))

  /**
   * The last viewer stops the hub. The hub fiber is interrupted OUTSIDE the lock: its own finalizer
   * takes `hubLock`, so interrupting it while holding the lock would deadlock (every later viewer and
   * the brain's shutdown would hang).
   */
  const leaveHub = (hub: Hub, viewer: Viewer) =>
    hubLock
      .withPermits(1)(
        Effect.sync(() => {
          hub.viewers.delete(viewer.id)
          if (hub.viewers.size === 0 && hubs.get(hub.botId) === hub) {
            hubs.delete(hub.botId)
            return hub.fiber
          }
          return undefined
        }),
      )
      .pipe(Effect.flatMap((fiber) => (fiber === undefined ? Effect.void : Fiber.interrupt(fiber))))

  const runViewer = (socket: Socket.Socket, botId: BotId, nodeId: NodeId, mode: ViewerMode, surface: Hub["surface"]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const io: Duplex = yield* open(socket)
        // joining and registering the leave are one step (a viewer can drop at any moment)
        const { hub } = yield* Effect.acquireRelease(
          joinHub(botId, nodeId, surface, { mode, writer: io.writer }),
          (joined) => leaveHub(joined.hub, joined.viewer),
        )
        // late joiners see the current state at once
        yield* Effect.ignore(io.writer.write(notice({ _tag: "Lease", holder: controllerOf(botId) })))
        if (hub.lastUrl !== undefined) yield* Effect.ignore(io.writer.write(hub.lastUrl))
        if (hub.lastFrame !== undefined) yield* Effect.ignore(io.writer.write(hub.lastFrame))
        yield* Effect.forever(
          Effect.flatMap(io.pull, (frames) =>
            Effect.forEach(
              frames,
              (frame) => {
                if (mode !== "control" || typeof frame !== "string" || controllerOf(botId) !== "user")
                  return Effect.void
                const event = decodeInput(frame)
                if (Option.isNone(event)) return Effect.void
                return directory.client(nodeId).pipe(
                  Effect.flatMap((client) =>
                    surface === "screen"
                      ? Effect.ignore(client["screen.input"]({ botId, event: event.value }))
                      : Effect.ignore(client["browser.input"]({ botId, event: event.value })),
                  ),
                  Effect.ignore,
                )
              },
              { discard: true },
            ),
          ),
        )
      }),
    ).pipe(Effect.ignore)

  // ---------------------------------------------------------------- desktop relay (VNC)
  const joinDesktop = (botId: BotId, mode: ViewerMode, writer: Socket.Writer, passive: boolean) =>
    Effect.sync(() => {
      const viewer: DesktopViewer = { id: ++viewerSeq, mode, writer, passive }
      const forBot = desktopViewers.get(botId) ?? new Map<number, DesktopViewer>()
      forBot.set(viewer.id, viewer)
      desktopViewers.set(botId, forBot)
      return viewer
    })

  const leaveDesktop = (botId: BotId, viewer: DesktopViewer) =>
    Effect.sync(() => {
      const forBot = desktopViewers.get(botId)
      if (forBot === undefined) return
      forBot.delete(viewer.id)
      if (forBot.size === 0) desktopViewers.delete(botId)
    })

  /**
   * One viewer ↔ its own node VNC stream, raw RFB both ways, until either side closes. The desktop
   * is ensured first (a reset in progress finishes before: same lock).
   */
  const runDesktopViewer = (socket: Socket.Socket, botId: BotId, nodeId: NodeId, mode: ViewerMode, passive: boolean) =>
    Effect.scoped(
      Effect.gen(function* () {
        const io = yield* open(socket)
        // registered at once, so a release or reset during the start-up closes this viewer too
        yield* Effect.acquireRelease(joinDesktop(botId, mode, io.writer, passive && mode === "view"), (v) =>
          leaveDesktop(botId, v),
        )
        const fail = (code: number, reason: string) => closeWriter(io.writer, code, reason)
        // a preview never wakes a sleeping screen
        if (
          passive &&
          (yield* Effect.map(Effect.option(statusOf(botId)), (s) => Option.isSome(s) && s.value.state === "absent"))
        ) {
          return yield* fail(DesktopCloseCodes.reset, "screen asleep")
        }
        const ensured = yield* Effect.result(ensure(botId))
        if (Result.isFailure(ensured)) {
          return yield* fail(
            DesktopCloseCodes.failed,
            ensured.failure._tag === "NotFound" ? "unknown bot" : ensured.failure.message,
          )
        }
        if (ensured.success.state !== "ready" || ensured.success.surface !== "desktop") {
          return yield* fail(DesktopCloseCodes.failed, ensured.success.message ?? "The screen is not available")
        }
        // the lease may have been handed back since the upgrade was allowed
        if (mode === "control" && controllerOf(botId) !== "user") {
          return yield* fail(DesktopCloseCodes.controlRefused, "Take control first")
        }
        const client = yield* Effect.result(directory.client(nodeId))
        if (Result.isFailure(client)) return yield* fail(DesktopCloseCodes.failed, client.failure.message)
        const opened = yield* Effect.result(
          openNodeStream(broker, {
            nodeId,
            kind: mode === "control" ? "vnc-control" : "vnc-view",
            open: (ticket) =>
              client.success["computer.stream"]({
                botId,
                mode,
                streamId: ticket.streamId,
                streamToken: ticket.streamToken,
              }),
          }),
        )
        if (Result.isFailure(opened)) {
          const failure = opened.failure
          const tag = typeof failure === "object" && failure !== null && "_tag" in failure ? failure._tag : undefined
          // the node lost the desktop (e.g. its display died): the next viewer starts it again
          if (tag === "DesktopUnavailable") yield* setComputer(botId, nodeId, "desktop", { state: "absent" })
          return yield* fail(
            tag === "LeaseHeld" ? DesktopCloseCodes.controlRefused : DesktopCloseCodes.failed,
            `Can't reach the screen: ${nodeErrorText(failure)}`,
          )
        }
        const remote = yield* open(opened.success.socket)
        const result = yield* splice(io, remote, { mapAB: binaryFrame, mapBA: binaryFrame })
        // the node ended the stream without a close code of its own (dropped, failed): say so
        if (
          result.endedBy === "b" &&
          (result.closeCode === undefined || result.closeCode === 1005 || result.closeCode === 1006)
        ) {
          yield* fail(DesktopCloseCodes.failed, "The screen stream ended")
        }
      }),
    ).pipe(Effect.catchCause((cause) => Effect.logDebug("desktop viewer ended", { botId, mode, cause })))

  const viewer: ComputerServiceShape["viewer"] = ({ botId, mode, passive, closeWhen }) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const s = yield* Effect.result(statusOf(botId as BotId))
      if (Result.isFailure(s)) return HttpServerResponse.text("unknown bot", { status: 404 })
      const st = s.success
      if (st.surface === "none" || st.state === "unsupported") {
        return HttpServerResponse.text(st.message ?? "no live view", { status: 409 })
      }
      if (
        st.state === "error" &&
        st.message !== undefined &&
        Option.isNone(yield* Effect.option(directory.client(st.nodeId)))
      ) {
        return HttpServerResponse.text(st.message, { status: 503 })
      }
      if (mode === "control" && st.controller !== "user") {
        return HttpServerResponse.text("Take control first", { status: 403 })
      }
      const upgraded = yield* Effect.result(request.upgrade)
      if (Result.isFailure(upgraded)) return HttpServerResponse.text("expected a WebSocket upgrade", { status: 400 })
      const socket = closedWhen(upgraded.success, closeWhen)
      if (st.surface === "desktop") {
        // detached: the route fiber is interrupted when the viewer closes (G2); the relay closes the
        // node stream itself
        const fiber = yield* Effect.forkDetach(
          runDesktopViewer(socket, botId as BotId, st.nodeId, mode, passive === true),
        )
        yield* Fiber.await(fiber)
        return HttpServerResponse.empty()
      }
      yield* runViewer(socket, botId as BotId, st.nodeId, mode, st.surface === "screen" ? "screen" : "browser")
      return HttpServerResponse.empty()
    })

  // ---------------------------------------------------------------- terminal
  const runTerminal = (socket: Socket.Socket, botId: BotId, node: NodeSummary, cols: number, rows: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const io = yield* open(socket)
        const fail = (message: string) =>
          Effect.andThen(
            Effect.ignore(io.writer.write(JSON.stringify({ error: message }))),
            closeWriter(io.writer, 1011, message),
          )
        const client = yield* Effect.result(directory.client(node.id))
        if (Result.isFailure(client)) return yield* fail(client.failure.message)
        const cwd = workspacePathFor({ node, botId, dataDir })
        const inv = { invocationId: yield* ids.next("inv"), botId, runId: `terminal-${botId}` }
        if (node.id === LOCAL_NODE_ID) {
          yield* Effect.promise(() => mkdir(cwd, { recursive: true }).catch(() => undefined))
        } else {
          // best effort: the node reports its own error from pty.open when this fails
          yield* client.success["fs.mkdir"]({ inv, path: cwd, recursive: true }).pipe(
            Effect.timeout("10 seconds"),
            Effect.ignore,
          )
        }
        const opened = yield* Effect.result(
          openNodeStream(broker, {
            nodeId: node.id,
            kind: "pty",
            open: (ticket) =>
              client.success["pty.open"]({
                inv,
                cols,
                rows,
                cwd,
                streamId: ticket.streamId,
                streamToken: ticket.streamToken,
              }),
          }),
        )
        if (Result.isFailure(opened)) return yield* fail(nodeErrorText(opened.failure))
        const remote = yield* open(opened.success.socket)
        yield* splice(io, remote, { mapAB: terminalInputFrame })
      }),
    ).pipe(Effect.catchCause((cause) => Effect.logDebug("terminal ended", { botId, cause })))

  const terminal: ComputerServiceShape["terminal"] = ({ botId, cols, rows, closeWhen }) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const bot = yield* Effect.option(getBot(botId as BotId))
      if (Option.isNone(bot)) return HttpServerResponse.text("unknown bot", { status: 404 })
      const node = yield* Effect.option(directory.get(bot.value.hostNodeId))
      if (Option.isNone(node) || node.value.status !== "online") {
        return HttpServerResponse.text(`Can't reach ${bot.value.name}'s computer`, { status: 503 })
      }
      if (!hasCapability(node.value.capabilities, "pty")) {
        return HttpServerResponse.text(`${node.value.label} has no terminal`, { status: 409 })
      }
      const upgraded = yield* Effect.result(request.upgrade)
      if (Result.isFailure(upgraded)) return HttpServerResponse.text("expected a WebSocket upgrade", { status: 400 })
      // detached: the route fiber is interrupted when the viewer closes (G2); drain the pty first
      const fiber = yield* Effect.forkDetach(
        runTerminal(
          closedWhen(upgraded.success, closeWhen),
          bot.value.id,
          node.value,
          clampSize(cols, 80, 1000),
          clampSize(rows, 24, 500),
        ),
      )
      yield* Fiber.await(fiber)
      return HttpServerResponse.empty()
    })

  // ---------------------------------------------------------------- idle desktops sleep
  /** Bots with work under way: an active turn, a queued or running task, or a pending hand-off. */
  const busyBots = Effect.gen(function* () {
    const [active, running, pending] = yield* Effect.all([
      turns.listActive,
      tasks.list({ statuses: ["queued", "running"] }),
      requests.list({ statuses: ["pending"] }),
    ])
    return new Set<BotId>([
      ...active.map((t) => t.botId),
      ...running.map((t) => t.botId),
      // the owner is about to use the screen the bot set up for them
      ...pending.filter((r) => r.kind === "handoff").map((r) => r.botId),
    ])
  })

  /** Viewers that keep a screen awake: not the passive previews. */
  const watching = (botId: BotId) => [...(desktopViewers.get(botId)?.values() ?? [])].filter((v) => !v.passive).length
  const watchedOrHeld = (botId: BotId) => watching(botId) > 0 || controllerOf(botId) === "user"

  const sleepDesktop = (botId: BotId, nodeId: NodeId) =>
    Effect.gen(function* () {
      const lock = yield* lockFor(botId)
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const c = computers.get(botId)
          // woken elsewhere, moved, or someone came to watch meanwhile
          if (
            c === undefined ||
            c.nodeId !== nodeId ||
            c.surface !== "desktop" ||
            c.state !== "ready" ||
            watchedOrHeld(botId)
          )
            return
          const client = yield* directory.client(nodeId)
          // the previews show it asleep (1012: they do not reconnect on their own)
          yield* closeDesktopViewers(botId, DesktopCloseCodes.reset, "screen asleep")
          yield* client["desktop.stop"]({ botId })
          yield* setComputer(botId, nodeId, "desktop", { state: "absent", message: undefined })
          lastAwake.delete(botId)
          awakeSince.delete(botId)
          yield* Effect.logInfo("bot screen asleep after idle", { botId })
        }),
      )
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("bot screen could not sleep", { botId, cause })))

  /** When each ready desktop was first seen by the idle check, and whether its keep-awake was logged. */
  const awakeSince = new Map<BotId, { readonly at: number; logged: boolean }>()

  const sleepIdleDesktops = Effect.gen(function* () {
    const awake = [...computers].filter(([, c]) => c.surface === "desktop" && c.state === "ready")
    for (const botId of [...lastAwake.keys()]) if (!awake.some(([id]) => id === botId)) lastAwake.delete(botId)
    for (const botId of [...awakeSince.keys()]) if (!awake.some(([id]) => id === botId)) awakeSince.delete(botId)
    if (awake.length === 0) return
    const busy = yield* busyBots
    const now = yield* Clock.currentTimeMillis
    for (const [botId, c] of awake) {
      const since = lastAwake.get(botId)
      const first = awakeSince.get(botId) ?? { at: now, logged: false }
      awakeSince.set(botId, first)
      const reasons = [
        ...(busy.has(botId) ? ["working"] : []),
        ...(watching(botId) > 0 ? [`${watching(botId)} watching`] : []),
        ...(controllerOf(botId) === "user" ? ["owner in control"] : []),
      ]
      if (since === undefined || reasons.length > 0) {
        lastAwake.set(botId, now)
        // once per awake stretch: why a screen is still up past the idle time
        if (reasons.length > 0 && !first.logged && now - first.at >= config.desktopIdleMs) {
          first.logged = true
          yield* Effect.logInfo("bot screen kept awake", { botId, reasons })
        }
      } else if (now - since >= config.desktopIdleMs) yield* sleepDesktop(botId, c.nodeId)
    }
  })

  if (config.desktopIdleMs > 0) {
    const every = Math.min(60_000, Math.max(20, Math.floor(config.desktopIdleMs / 4)))
    yield* Effect.forever(
      Effect.andThen(
        Effect.sleep(every),
        sleepIdleDesktops.pipe(Effect.catchCause((cause) => Effect.logWarning("idle screen check failed", { cause }))),
      ),
    ).pipe(Effect.forkIn(layerScope, { startImmediately: true }))
  }

  // ---------------------------------------------------------------- node lifecycle
  // a node that comes back online gets the user's leases again; one that goes away loses its windows
  yield* directory.changes.pipe(
    Stream.runForEach((change) =>
      Effect.gen(function* () {
        if (change.type === "node.removed") {
          for (const [botId, c] of computers) if (c.nodeId === change.nodeId) computers.delete(botId)
          return
        }
        const node = change.node
        for (const [botId, c] of [...computers]) {
          if (c.nodeId !== node.id) continue
          if (node.status !== "online") computers.set(botId, { ...c, state: "absent", windowTargetId: undefined })
        }
        if (node.status === "online") {
          // the node gets the leases again (also hand-backs it missed while it was away)
          for (const [botId, holder] of [...controllers]) {
            const bot = yield* Effect.option(getBot(botId))
            if (Option.isSome(bot) && bot.value.hostNodeId === node.id)
              yield* Effect.ignore(mirrorLease(botId, node.id, holder))
          }
        }
      }),
    ),
    Effect.forkIn(layerScope, { startImmediately: true }),
  )
  yield* registry.events.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        const data = (typeof event.data === "object" && event.data !== null ? event.data : {}) as Record<
          string,
          unknown
        >
        const botId = typeof data["botId"] === "string" ? (data["botId"] as BotId) : undefined
        if (botId === undefined) return
        const c = computers.get(botId)
        // a bot action (gateway `computer` tool) started the screen, or it stopped: watchable or not
        if (event.type === NodeEventTypes.desktopStarted) {
          lastAwake.delete(botId)
          if (c === undefined || c.nodeId !== event.nodeId || c.state !== "starting") {
            computers.set(botId, {
              nodeId: event.nodeId,
              surface: "desktop",
              state: "ready",
              message: undefined,
              windowTargetId: undefined,
            })
          }
          return
        }
        if (event.type === NodeEventTypes.desktopStopped) {
          if (c !== undefined && c.surface === "desktop" && c.nodeId === event.nodeId)
            computers.set(botId, { ...c, state: "absent" })
          return
        }
        // on a desktop node the browser is one window of the screen (and a Mac shares its whole
        // screen): its events change nothing
        if (c !== undefined && (c.surface === "desktop" || c.surface === "screen") && c.nodeId === event.nodeId) return
        if (event.type === NodeEventTypes.browserClosed && c !== undefined && c.nodeId === event.nodeId) {
          computers.set(botId, { ...c, state: "absent", windowTargetId: undefined })
        }
        // a bot action (gateway `browser` tool) opened the window: the screen is there to watch
        if (event.type === NodeEventTypes.browserOpened) {
          const windowTargetId = typeof data["windowTargetId"] === "string" ? data["windowTargetId"] : undefined
          if (c === undefined || c.nodeId !== event.nodeId || c.state !== "starting") {
            computers.set(botId, {
              nodeId: event.nodeId,
              surface: "browser",
              state: "ready",
              message: undefined,
              windowTargetId,
            })
          }
        }
      }),
    ),
    Effect.forkIn(layerScope, { startImmediately: true }),
  )

  const service = ComputerService.of({
    status: statusOf,
    ensure,
    lease,
    reset,
    leaseChanges: Stream.fromPubSub(leaseChanges),
    viewer,
    terminal,
    viewerCount: (botId) =>
      Effect.sync(() => (hubs.get(botId)?.viewers.size ?? 0) + (desktopViewers.get(botId)?.size ?? 0)),
  })
  return service
})

/** `ComputerPort` (for the `computer.*` RPCs) plus the viewer/terminal socket handlers. Layer 0. */
export const ComputerServiceLive: Layer.Layer<
  ComputerPort | ComputerService,
  never,
  | BotRepo
  | TurnRepo
  | TaskRepo
  | RequestRepo
  | NodeDirectory
  | NodeRegistry
  | StreamBroker
  | DataDir
  | IdGen
  | BrainNodesConfig
> = Layer.effectContext(
  Effect.map(makeComputerService, (service) =>
    Context.make(ComputerService, service).pipe(
      Context.add(
        ComputerPort,
        ComputerPort.of({
          status: service.status,
          ensure: service.ensure,
          lease: service.lease,
          reset: service.reset,
          leaseChanges: service.leaseChanges,
        }),
      ),
    ),
  ),
)

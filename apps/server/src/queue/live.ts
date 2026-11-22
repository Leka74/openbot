/**
 * The owner's queue in the brain (opt-in; store.ts has the model).
 *
 * - `OPENBOT_QUEUE=on`: the built-in queue. `<data>/queue.sqlite`, the page at `/queue/` (the app shows it
 *   at `#/queue`), Bots add items with `add_to_queue`, and the owner's decisions go back to each Bot once
 *   their undo grace is over (checked every few seconds), as one `queue-decision` delivery per Bot and
 *   conversation.
 * - `OPENBOT_QUEUE_URL=http://…`: an external backend instead. `/queue/*` is proxied to it for the
 *   signed-in owner (same paths), and `add_to_queue` posts `{ ...item, profileId, botId, botName,
 *   conversationId, area }` to `<url>/api/add`, which answers `{ "result": DecisionQueueAddResult }`.
 *   The backend routes decisions itself.
 * - Neither: no queue, no tool, no page (`/queue/api/enabled` is 404, so the app shows no Queue button).
 */
import {
  DecisionQueue,
  type DecisionQueueAddResult,
  DecisionQueueRefused,
  inProfile,
  Orchestrator,
  OwnerProfiles,
} from "@openbot/core"
import type { BotId, ConversationId, OwnerProfileId } from "@openbot/contracts"
import { Context, Duration, Effect, Layer, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { readFileSync } from "node:fs"
import { WebAuth } from "../auth.ts"
import { decisionText, type QueueAction, QueueError, type QueueRuleMatch, QueueStore } from "./store.ts"

export type QueueMode =
  { readonly kind: "builtin"; readonly file: string } | { readonly kind: "external"; readonly url: string }

/** `OPENBOT_QUEUE` / `OPENBOT_QUEUE_URL` → the queue's mode; undefined = no queue. */
export const queueModeFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  dataDir: string,
): QueueMode | undefined => {
  const url = env["OPENBOT_QUEUE_URL"]?.trim()
  if (url !== undefined && url !== "") return { kind: "external", url: url.replace(/\/+$/, "") }
  return env["OPENBOT_QUEUE"] === "on" ? { kind: "builtin", file: `${dataDir}/queue.sqlite` } : undefined
}

/** The queue's backend, for its routes. */
export class QueueBackend extends Context.Service<
  QueueBackend,
  { readonly store: QueueStore; readonly url?: undefined } | { readonly store?: undefined; readonly url: string }
>()("openbot/server/QueueBackend") {}

const DELIVERY_EVERY = Duration.seconds(5)

/** Hands every decision whose grace is over to its Bot: one delivery per Bot and conversation. */
const deliverDue = (store: QueueStore) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator
    const due = store.due(Date.now())
    const groups = new Map<string, typeof due>()
    for (const d of due)
      groups.set(`${d.botId}|${d.conversationId}`, [...(groups.get(`${d.botId}|${d.conversationId}`) ?? []), d])
    for (const group of groups.values()) {
      const first = group[0]!
      yield* orchestrator
        .deliver({
          botId: first.botId as BotId,
          conversationId: first.conversationId as ConversationId,
          kind: "queue-decision",
          text: group.map(decisionText).join("\n\n"),
          urgency: "urgent",
        })
        .pipe(
          // the Bot's profile, like routine runs: its turn, settings and live updates live there
          inProfile(first.profileId as OwnerProfileId),
          Effect.catch((error) => Effect.logWarning("queue: a decision could not reach its Bot", error)),
        )
      // delivered or not (a deleted Bot), it isn't tried again
      store.markDelivered(
        group.map((d) => d.decisionId),
        Date.now(),
      )
    }
  })

const builtinLayer = (file: string) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const store = yield* Effect.acquireRelease(
        Effect.sync(() => new QueueStore(file)),
        (s) => Effect.sync(() => s.close()),
      )
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep(DELIVERY_EVERY).pipe(
            Effect.andThen(deliverDue(store)),
            Effect.catchCause((cause) => Effect.logWarning("queue: delivery round failed", cause)),
          ),
        ),
      )
      const queue = DecisionQueue.of({
        add: (input) =>
          Effect.try({
            try: () => store.add(input, Date.now()),
            catch: (error) =>
              new DecisionQueueRefused(error instanceof QueueError ? error.message : "the queue failed"),
          }),
      })
      return Context.make(DecisionQueue, queue).pipe(Context.add(QueueBackend, QueueBackend.of({ store })))
    }),
  )

const externalLayer = (url: string) =>
  Layer.mergeAll(
    Layer.succeed(QueueBackend, QueueBackend.of({ url })),
    Layer.succeed(
      DecisionQueue,
      DecisionQueue.of({
        add: (input) =>
          Effect.tryPromise({
            try: async () => {
              const res = await fetch(`${url}/api/add`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(input),
                redirect: "error",
              })
              const body = (await res.json().catch(() => ({}))) as { result?: DecisionQueueAddResult; error?: string }
              if (!res.ok || body.result === undefined)
                throw new QueueError(body.error ?? `the queue answered ${res.status}`)
              return body.result
            },
            catch: (error) =>
              new DecisionQueueRefused(error instanceof QueueError ? error.message : "the queue isn't reachable"),
          }),
      }),
    ),
  )

/** The queue for `mode`; nothing at all without one. */
export const QueueLive = (mode: QueueMode | undefined) =>
  mode === undefined ? Layer.empty : mode.kind === "builtin" ? builtinLayer(mode.file) : externalLayer(mode.url)

// ---------------------------------------------------------------- routes

const PAGE_DIR = new URL("./page/", import.meta.url)
const PAGE_FILES: Record<string, { readonly file: string; readonly type: string }> = {
  "/queue/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/queue/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/queue/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
}
const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"
const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" }

const json = (value: unknown, status = 200) =>
  HttpServerResponse.text(JSON.stringify(value), { status, contentType: "application/json", headers: NO_STORE })
const refuse = (status: number, reason: string) => HttpServerResponse.text(reason, { status, headers: NO_STORE })

type Body = Record<string, unknown>
const str = (body: Body, key: string): string | undefined =>
  typeof body[key] === "string" ? (body[key] as string) : undefined
const num = (body: Body, key: string): number | undefined =>
  typeof body[key] === "number" && Number.isFinite(body[key]) ? (body[key] as number) : undefined
const ACTIONS: ReadonlySet<string> = new Set(["approve", "reject", "reply", "skip", "drop", "snooze"])
const TYPES: ReadonlySet<string> = new Set(["decision", "review", "fyi"])
const matchOf = (value: unknown): QueueRuleMatch => {
  const m = typeof value === "object" && value !== null ? (value as Body) : {}
  const type = str(m, "type")
  return {
    botId: str(m, "botId"),
    type: type !== undefined && TYPES.has(type) ? (type as QueueRuleMatch["type"]) : undefined,
    titleHas: str(m, "titleHas"),
  }
}

/** One API call of the built-in queue: the store's refusals become 400s with their text. */
const API: Record<string, (store: QueueStore, profileId: string, body: Body, now: number) => unknown> = {
  "/queue/api/decide": (store, profileId, body, now) => {
    const action = str(body, "action") ?? ""
    if (!ACTIONS.has(action)) throw new QueueError("unknown action")
    const ids = Array.isArray(body["ids"])
      ? body["ids"].filter((x): x is string => typeof x === "string")
      : [str(body, "id")].filter((x): x is string => x !== undefined)
    return store.decide(
      {
        profileId,
        ids,
        action: action as QueueAction,
        option: num(body, "option"),
        note: str(body, "note"),
        hours: num(body, "hours"),
      },
      now,
    )
  },
  "/queue/api/undo": (store, profileId, _body, now) => store.undo(profileId, now),
  "/queue/api/stack-clear": (store, profileId, body, now) =>
    store.clearStack(
      profileId,
      str(body, "sig") ?? "",
      Array.isArray(body["ids"]) ? body["ids"].filter((x): x is string => typeof x === "string") : [],
      now,
    ),
  "/queue/api/rule-suggest": (store, profileId, body, now) => ({
    suggestions: store.suggest(profileId, { id: str(body, "id"), sig: str(body, "sig") }, now),
  }),
  "/queue/api/rule-preview": (store, profileId, body, now) => store.preview(profileId, matchOf(body["match"]), now),
  "/queue/api/rule-add": (store, profileId, body, now) =>
    store.addRule(profileId, matchOf(body["match"]), str(body, "reason") ?? "", now),
  "/queue/api/rule-off": (store, profileId, body) => store.ruleOff(profileId, num(body, "id") ?? -1),
}

/** Proxies one request to the external backend (the owner was checked; only its own origin is sent on). */
const proxy = (url: string, request: HttpServerRequest.HttpServerRequest, path: string) =>
  Effect.gen(function* () {
    const web = yield* Effect.orDie(HttpServerRequest.toWeb(request))
    const upstream = yield* Effect.tryPromise(async () => {
      const headers: Record<string, string> = {}
      for (const name of ["content-type", "range"]) {
        const value = web.headers.get(name)
        if (value !== null) headers[name] = value
      }
      return fetch(url + path.slice("/queue".length), {
        method: request.method,
        headers,
        redirect: "error",
        ...(request.method === "POST" ? { body: await web.arrayBuffer() } : {}),
      })
    }).pipe(Effect.option)
    if (Option.isNone(upstream)) return refuse(502, "The queue isn't running.")
    const res = upstream.value
    const headers = new Headers(res.headers)
    headers.delete("x-frame-options")
    headers.set("cache-control", "no-store")
    headers.set(
      "content-security-policy",
      `${res.headers.get("content-security-policy") ?? "default-src 'none'"}; frame-ancestors 'self'`,
    )
    return HttpServerResponse.raw(new Response(res.body, { status: res.status, headers }), { status: res.status })
  })

/** `/queue/*` for the signed-in owner; nothing is registered without a queue. */
export const QueueRoutes = Layer.effectDiscard(
  Effect.gen(function* () {
    const backend = yield* Effect.serviceOption(QueueBackend)
    if (Option.isNone(backend)) return
    const router = yield* HttpRouter.HttpRouter
    const auth = yield* WebAuth
    const profiles = yield* OwnerProfiles
    const { store, url } = backend.value
    const handle = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const access = yield* auth.authenticate(request)
      if (!access.ok) return refuse(access.status, access.reason)
      const path = new URL(request.url, "http://localhost").pathname
      if (path === "/queue") return HttpServerResponse.redirect("/queue/", { status: 302 })
      if (path === "/queue/api/enabled") return HttpServerResponse.empty({ status: 204, headers: NO_STORE })
      if (url !== undefined) return yield* proxy(url, request, path)
      if (store === undefined) return refuse(404, "not found")
      if (request.method === "GET") {
        if (path === "/queue/api/state") return json(store.state(yield* profiles.active, Date.now()))
        const page = PAGE_FILES[path]
        if (page === undefined) return refuse(404, "not found")
        return HttpServerResponse.text(readFileSync(new URL(page.file, PAGE_DIR), "utf8"), {
          contentType: page.type,
          headers: { ...NO_STORE, "content-security-policy": PAGE_CSP },
        })
      }
      const call = request.method === "POST" ? API[path] : undefined
      if (call === undefined) return refuse(404, "not found")
      const body = Option.getOrElse(yield* Effect.option(request.json), () => ({}))
      const profileId = yield* profiles.active
      try {
        return json(call(store, profileId, typeof body === "object" && body !== null ? (body as Body) : {}, Date.now()))
      } catch (error) {
        if (error instanceof QueueError) return json({ error: error.message }, 400)
        throw error
      }
    })
    yield* router.add("*", "/queue/*", handle)
  }),
)

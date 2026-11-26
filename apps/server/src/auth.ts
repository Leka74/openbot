/**
 * Web auth for the single owner (D4.4, architecture §4.9, hands-architecture-synthesis.md §S.7).
 *
 * - **Owner token.** Generated on first run and kept in `<data>/auth.json` (mode 0600). The brain
 *   prints `http://127.0.0.1:<port>/?token=…` on every start; the token is exchanged for a session.
 * - **Sessions.** `openbot_session` cookie: HttpOnly, SameSite=Lax, Path=/, Secure behind https.
 *   Only the SHA-256 of a session token is stored (also in `auth.json`), so sessions survive restarts.
 * - **Origin allow-list.** Every cookie-authenticated request and WebSocket upgrade must come from an
 *   allowed origin (public origins + `http://127.0.0.1:<port>` + `http://localhost:<port>`) when the
 *   browser sends one; `Sec-Fetch-Site: cross-site` is refused too (cross-site WebSocket hijacking).
 * - **wsTicket.** Single use, 60 s, minted over an authenticated POST, for clients that cannot attach
 *   cookies to a WebSocket.
 * - **App codes.** Single use, 5 min, minted by the signed-in web app (its "Connect the iPhone app" QR
 *   code); the app trades one (or the owner token) for a session token it keeps and sends as
 *   `Authorization: Bearer` (`POST /api/auth/app-login`).
 * - **Web codes.** Single use, 60 s, minted by the app for its in-app web pages: `GET /api/auth/login?code=`
 *   sets the app's own session as the web view's cookie (no new session).
 * - Logging out revokes the session and closes the sockets opened with it.
 *
 * The MCP gateway never accepts these cookies (bearer only, internal listener).
 */
import { randomToken, safeEqual, sha256Hex } from "@openbot/node-protocol"
import { Clock, Context, Deferred, Effect, Layer, Semaphore } from "effect"
import type { HttpServerRequest } from "effect/http"
import { chmod, mkdir, rename } from "node:fs/promises"

export const SESSION_COOKIE = "openbot_session"
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const TICKET_TTL_MS = 60 * 1000
export const APP_CODE_TTL_MS = 5 * 60 * 1000
export const WEB_CODE_TTL_MS = 60 * 1000
const MAX_SESSIONS = 64

export interface Session {
  /** SHA-256 (hex) of the session token. */
  readonly id: string
  readonly createdAt: number
  readonly expiresAt: number
}

export type AuthResult =
  | { readonly ok: true; readonly session: Session; readonly via: "cookie" | "ticket" }
  | { readonly ok: false; readonly status: 401 | 403; readonly reason: string }

export interface WebAuthShape {
  /** The owner token (printed in the login URL). */
  readonly ownerToken: string
  /** Exchanges the owner token for a session token; `undefined` when the token is wrong. */
  readonly login: (
    token: string,
  ) => Effect.Effect<{ readonly sessionToken: string; readonly session: Session } | undefined>
  /** Revokes a session (closing its sockets). Unknown tokens are ignored. */
  readonly logout: (sessionToken: string) => Effect.Effect<void>
  /** The live session of a session token. */
  readonly session: (sessionToken: string | undefined) => Effect.Effect<Session | undefined>
  readonly mintTicket: (
    session: Session,
  ) => Effect.Effect<{ readonly ticket: string; readonly expiresInSeconds: number }>
  /** A one-time code the iPhone app trades for a session of its own (`loginWithAppCode`). */
  readonly mintAppCode: (
    session: Session,
  ) => Effect.Effect<{ readonly code: string; readonly expiresInSeconds: number }>
  /** Redeems (and burns) an app code: a new session, while the session that minted it is alive. */
  readonly loginWithAppCode: (
    code: string,
  ) => Effect.Effect<{ readonly sessionToken: string; readonly session: Session } | undefined>
  /** A one-time code for the session token itself (the app's in-app web pages). */
  readonly mintWebCode: (
    sessionToken: string,
  ) => Effect.Effect<{ readonly code: string; readonly expiresInSeconds: number }>
  /** Redeems (and burns) a web code: its session token, while that session is alive. */
  readonly redeemWebCode: (code: string) => Effect.Effect<string | undefined>
  /** Redeems (and burns) a ticket. */
  readonly redeemTicket: (ticket: string) => Effect.Effect<Session | undefined>
  /** Whether the session (by `Session.id`) is still signed in. */
  readonly isLive: (sessionId: string) => Effect.Effect<boolean>
  /** Completes when the session is revoked (logout). */
  readonly revoked: (session: Session) => Effect.Effect<void>
  /**
   * Cookie session (+ Origin allow-list) or, when `allowTicket`, a `?wsTicket=` in the URL.
   * 401 = no valid credential, 403 = a credential from a disallowed origin.
   */
  readonly authenticate: (
    request: HttpServerRequest.HttpServerRequest,
    options?: { readonly allowTicket?: boolean | undefined },
  ) => Effect.Effect<AuthResult>
  /** `Set-Cookie` value that stores `sessionToken` (Secure when the request came over https). */
  readonly sessionCookie: (request: HttpServerRequest.HttpServerRequest, sessionToken: string) => string
  /** `Set-Cookie` value that clears the session cookie. */
  readonly clearCookie: (request: HttpServerRequest.HttpServerRequest) => string
  /** The Origin check alone (undefined = allowed). */
  readonly checkOrigin: (request: HttpServerRequest.HttpServerRequest) => string | undefined
}

export class WebAuth extends Context.Service<WebAuth, WebAuthShape>()("openbot/server/WebAuth") {}

// ============================================================================ pure helpers

/** The session token from the `openbot_session` cookie. */
/** The session token of a request: the `openbot_session` cookie, or `Authorization: Bearer` (the iPhone app). */
export const sessionTokenOf = (request: HttpServerRequest.HttpServerRequest): string | undefined => {
  const fromParsed = request.cookies[SESSION_COOKIE]
  if (fromParsed !== undefined && fromParsed !== "") return fromParsed
  const header = request.headers["cookie"]
  const match = header === undefined ? null : new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(header)
  if (match?.[1] !== undefined) return match[1]
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers["authorization"] ?? "")
  return bearer?.[1]
}

/** Query parameters of a request URL (relative or absolute). */
export const searchParamsOf = (request: HttpServerRequest.HttpServerRequest): URLSearchParams =>
  new URL(request.url, "http://localhost").searchParams

/**
 * Origin allow-list check (D4.4). Requests without `Origin` (non-browser clients, same-origin
 * navigations) pass; `Origin: null` and unlisted origins are refused, as is `Sec-Fetch-Site: cross-site`.
 */
export const originRefusal = (
  headers: Readonly<Record<string, string | undefined>>,
  allowed: ReadonlyArray<string>,
): string | undefined => {
  const site = headers["sec-fetch-site"]
  if (site === "cross-site") return "cross-site requests are not allowed"
  const origin = headers["origin"]
  if (origin === undefined) return undefined
  if (origin === "null" || !allowed.includes(origin.toLowerCase())) return `origin ${origin} is not allowed`
  return undefined
}

/** True when the request reached the brain over https (directly or through a TLS proxy / Tailscale serve). */
export const isSecureRequest = (
  headers: Readonly<Record<string, string | undefined>>,
  publicOrigins: ReadonlyArray<string>,
): boolean => {
  if (headers["x-forwarded-proto"]?.split(",")[0]?.trim() === "https") return true
  const host = headers["host"]?.toLowerCase()
  if (host === undefined) return false
  return publicOrigins.some((origin) => {
    const url = new URL(origin)
    return url.protocol === "https:" && url.host === host
  })
}

// ============================================================================ store (<data>/auth.json)

interface AuthFile {
  readonly version: 1
  readonly ownerToken: string
  readonly sessions: ReadonlyArray<Session>
}

const isAuthFile = (value: unknown): value is AuthFile => {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    v["version"] === 1 &&
    typeof v["ownerToken"] === "string" &&
    (v["ownerToken"] as string).length >= 32 &&
    Array.isArray(v["sessions"]) &&
    (v["sessions"] as Array<unknown>).every(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as Session).id === "string" &&
        typeof (s as Session).createdAt === "number" &&
        typeof (s as Session).expiresAt === "number",
    )
  )
}

const writeAuthFile = async (path: string, file: AuthFile): Promise<void> => {
  const tmp = `${path}.${process.pid}.tmp`
  await Bun.write(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, path)
}

/** Loads `auth.json`, creating it (with a fresh owner token) on first run. A corrupt file is set aside. */
export const loadAuthFile = (path: string): Effect.Effect<{ readonly file: AuthFile; readonly created: boolean }> =>
  Effect.promise(async () => {
    await mkdir(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true })
    const handle = Bun.file(path)
    if (await handle.exists()) {
      const parsed = (await handle.json().catch(() => undefined)) as unknown
      if (isAuthFile(parsed)) {
        await chmod(path, 0o600).catch(() => undefined)
        return { file: parsed, created: false }
      }
      await rename(path, `${path}.corrupt-${Date.now()}`).catch(() => undefined)
    }
    const file: AuthFile = { version: 1, ownerToken: randomToken(32), sessions: [] }
    await writeAuthFile(path, file)
    return { file, created: true }
  })

export interface WebAuthOptions {
  /** `<data>/auth.json` */
  readonly path: string
  /** Allowed browser origins (lower-case `scheme://host[:port]`). */
  readonly allowedOrigins: ReadonlyArray<string>
  /** Configured public origins (Secure-cookie detection). */
  readonly publicOrigins: ReadonlyArray<string>
}

export const makeWebAuth = (options: WebAuthOptions) =>
  Effect.gen(function* () {
    const loaded = yield* loadAuthFile(options.path)
    let file: AuthFile = loaded.file
    const lock = yield* Semaphore.make(1)
    const tickets = new Map<string, { readonly session: Session; readonly expiresAt: number }>()
    const appCodes = new Map<string, { readonly session: Session; readonly expiresAt: number }>()
    const webCodes = new Map<string, { readonly sessionToken: string; readonly expiresAt: number }>()
    const revocations = new Map<string, Deferred.Deferred<void>>()

    const persist = (update: (current: AuthFile) => AuthFile) =>
      lock.withPermits(1)(
        Effect.promise(async () => {
          file = update(file)
          await writeAuthFile(options.path, file)
        }),
      )

    const session: WebAuthShape["session"] = (token) =>
      Effect.gen(function* () {
        if (token === undefined || token.length < 16 || token.length > 128) return undefined
        const id = yield* sha256Hex(token)
        const now = yield* Clock.currentTimeMillis
        return file.sessions.find((s) => s.id === id && s.expiresAt > now)
      })

    const newSession = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const sessionToken = randomToken(32)
      const created: Session = { id: yield* sha256Hex(sessionToken), createdAt: now, expiresAt: now + SESSION_TTL_MS }
      yield* persist((current) => ({
        ...current,
        sessions: [...current.sessions.filter((s) => s.expiresAt > now).slice(-(MAX_SESSIONS - 1)), created],
      }))
      return { sessionToken, session: created }
    })

    const login: WebAuthShape["login"] = (token) =>
      safeEqual(token.trim(), file.ownerToken) ? newSession : Effect.succeed(undefined)

    const mintAppCode: WebAuthShape["mintAppCode"] = (owner) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        for (const [c, entry] of appCodes) if (entry.expiresAt <= now) appCodes.delete(c)
        const code = randomToken(16)
        appCodes.set(code, { session: owner, expiresAt: now + APP_CODE_TTL_MS })
        return { code, expiresInSeconds: APP_CODE_TTL_MS / 1000 }
      })

    const loginWithAppCode: WebAuthShape["loginWithAppCode"] = (code) =>
      Effect.gen(function* () {
        const entry = appCodes.get(code)
        appCodes.delete(code)
        if (entry === undefined) return undefined
        const now = yield* Clock.currentTimeMillis
        if (entry.expiresAt <= now) return undefined
        // the web session that showed the code must still be signed in
        if (!file.sessions.some((s) => s.id === entry.session.id && s.expiresAt > now)) return undefined
        return yield* newSession
      })

    const mintWebCode: WebAuthShape["mintWebCode"] = (sessionToken) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        for (const [c, entry] of webCodes) if (entry.expiresAt <= now) webCodes.delete(c)
        const code = randomToken(16)
        webCodes.set(code, { sessionToken, expiresAt: now + WEB_CODE_TTL_MS })
        return { code, expiresInSeconds: WEB_CODE_TTL_MS / 1000 }
      })

    const redeemWebCode: WebAuthShape["redeemWebCode"] = (code) =>
      Effect.gen(function* () {
        const entry = webCodes.get(code)
        webCodes.delete(code)
        if (entry === undefined) return undefined
        if (entry.expiresAt <= (yield* Clock.currentTimeMillis)) return undefined
        return (yield* session(entry.sessionToken)) === undefined ? undefined : entry.sessionToken
      })

    const revoke = (id: string) =>
      Effect.gen(function* () {
        const deferred = revocations.get(id)
        if (deferred !== undefined) {
          revocations.delete(id)
          yield* Deferred.succeed(deferred, undefined)
        }
        for (const [ticket, entry] of tickets) if (entry.session.id === id) tickets.delete(ticket)
        for (const [code, entry] of appCodes) if (entry.session.id === id) appCodes.delete(code)
      })

    const logout: WebAuthShape["logout"] = (token) =>
      Effect.gen(function* () {
        const found = yield* session(token)
        if (found === undefined) return
        yield* persist((current) => ({ ...current, sessions: current.sessions.filter((s) => s.id !== found.id) }))
        yield* revoke(found.id)
      })

    const mintTicket: WebAuthShape["mintTicket"] = (owner) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        for (const [t, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(t)
        const ticket = randomToken(16)
        tickets.set(ticket, { session: owner, expiresAt: now + TICKET_TTL_MS })
        return { ticket, expiresInSeconds: TICKET_TTL_MS / 1000 }
      })

    const redeemTicket: WebAuthShape["redeemTicket"] = (ticket) =>
      Effect.gen(function* () {
        const entry = tickets.get(ticket)
        tickets.delete(ticket)
        if (entry === undefined) return undefined
        const now = yield* Clock.currentTimeMillis
        if (entry.expiresAt <= now) return undefined
        // the session behind the ticket must still be alive
        return file.sessions.find((s) => s.id === entry.session.id && s.expiresAt > now)
      })

    const isLive: WebAuthShape["isLive"] = (sessionId) =>
      Effect.map(Clock.currentTimeMillis, (now) => file.sessions.some((s) => s.id === sessionId && s.expiresAt > now))

    const revoked: WebAuthShape["revoked"] = (owner) =>
      Effect.suspend(() => {
        let deferred = revocations.get(owner.id)
        if (deferred === undefined) {
          deferred = Deferred.makeUnsafe<void>()
          revocations.set(owner.id, deferred)
        }
        return Deferred.await(deferred)
      })

    const checkOrigin = (request: HttpServerRequest.HttpServerRequest, allowed: ReadonlyArray<string>) =>
      originRefusal(request.headers, allowed)

    const allowedOrigins = options.allowedOrigins

    const authenticate: WebAuthShape["authenticate"] = (request, opts) =>
      Effect.gen(function* () {
        if (opts?.allowTicket === true) {
          const ticket = searchParamsOf(request).get("wsTicket")
          if (ticket !== null) {
            const owner = yield* redeemTicket(ticket)
            return owner === undefined
              ? ({ ok: false, status: 401, reason: "invalid or used ticket" } as const)
              : ({ ok: true, session: owner, via: "ticket" } as const)
          }
        }
        const owner = yield* session(sessionTokenOf(request))
        if (owner === undefined) return { ok: false, status: 401, reason: "not signed in" } as const
        const refused = checkOrigin(request, allowedOrigins)
        if (refused !== undefined) return { ok: false, status: 403, reason: refused } as const
        return { ok: true, session: owner, via: "cookie" } as const
      })

    const cookieAttributes = (request: HttpServerRequest.HttpServerRequest) =>
      `Path=/; HttpOnly; SameSite=Lax${isSecureRequest(request.headers, options.publicOrigins) ? "; Secure" : ""}`

    return {
      created: loaded.created,
      service: WebAuth.of({
        ownerToken: file.ownerToken,
        login,
        logout,
        session,
        mintTicket,
        mintAppCode,
        loginWithAppCode,
        mintWebCode,
        redeemWebCode,
        redeemTicket,
        isLive,
        revoked,
        authenticate,
        sessionCookie: (request, token) =>
          `${SESSION_COOKIE}=${token}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; ${cookieAttributes(request)}`,
        clearCookie: (request) => `${SESSION_COOKIE}=; Max-Age=0; ${cookieAttributes(request)}`,
        checkOrigin: (request) => checkOrigin(request, allowedOrigins),
      }),
    }
  })

export const WebAuthLayer = (options: WebAuthOptions): Layer.Layer<WebAuth> =>
  Layer.effect(
    WebAuth,
    Effect.map(makeWebAuth(options), (built) => built.service),
  )

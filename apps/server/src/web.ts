/**
 * Serving the web app (`apps/web`, D6.1) from the public listener.
 *
 * The app is the Bun HTML import of `@openbot/web/index.html`. `/` is gated: without a session the
 * brain answers a small login page (open the printed URL, or paste the token), so the HTML import is
 * never served at `/` by Bun directly. Two modes:
 *
 * - **hmr** (`--dev`, and the working directory's `bunfig.toml` loads `bun-plugin-tailwind`, e.g.
 *   `bun run dev`): the HTML import is a Bun route at a hidden path with Bun's dev server (HMR,
 *   browser console). `/` fetches that route over loopback and returns the page.
 * - **bundle** (default, any working directory): `Bun.build` of the same HTML import with the
 *   Tailwind plugin passed programmatically, kept in memory; assets are served from `/assets/*`.
 *   (Bun only reads `[serve.static]` plugins from the working directory's `bunfig.toml`, so the
 *   route would lose Tailwind when the brain is started from elsewhere.) Built on first use and
 *   rebuilt on every page load in `--dev` without HMR.
 */
import webIndex from "@openbot/web/index.html"
import { Effect } from "effect"
import { existsSync, readFileSync } from "node:fs"

/** Where the HTML import is mounted in hmr mode (not linked anywhere; `/` serves it after auth). */
export const HIDDEN_APP_ROUTE = "/__openbot/app"

export type WebMode = "hmr" | "bundle"

export interface WebPlan {
  readonly mode: WebMode
  /** Routes for `Bun.serve` (hmr mode only). */
  readonly bunRoutes: Record<string, typeof webIndex> | undefined
  /** `development` for `Bun.serve`. */
  readonly development: false | { readonly hmr: true; readonly console: true }
  /** Why hmr is off in `--dev` (logged once). */
  readonly note?: string | undefined
}

/** True when `bunfig.toml` in `cwd` configures `bun-plugin-tailwind` and the plugin resolves from there. */
export const cwdLoadsTailwind = (cwd: string): boolean => {
  const bunfig = `${cwd}/bunfig.toml`
  if (!existsSync(bunfig)) return false
  try {
    if (!readFileSync(bunfig, "utf8").includes("bun-plugin-tailwind")) return false
    Bun.resolveSync("bun-plugin-tailwind", cwd)
    return true
  } catch {
    return false
  }
}

export const planWeb = (input: { readonly dev: boolean; readonly cwd: string }): WebPlan => {
  if (!input.dev) return { mode: "bundle", bunRoutes: undefined, development: false }
  if (cwdLoadsTailwind(input.cwd)) {
    return { mode: "hmr", bunRoutes: { [HIDDEN_APP_ROUTE]: webIndex }, development: { hmr: true, console: true } }
  }
  return {
    mode: "bundle",
    bunRoutes: undefined,
    development: false,
    note: "hot reloading needs the Tailwind plugin from apps/server/bunfig.toml: start the brain with `bun run dev` from the repo root",
  }
}

// ============================================================================ bundle mode

export interface BuiltAsset {
  readonly body: Blob
  readonly type: string
}

export interface WebBundle {
  readonly html: string
  /** `/assets/<file>` → contents. */
  readonly assets: ReadonlyMap<string, BuiltAsset>
}

/** Bundles the web app (HTML import + Tailwind) in memory. Rejects with the bundler logs. */
export const buildWebBundle = async (options: { readonly dev: boolean }): Promise<WebBundle> => {
  const { default: tailwind } = await import("bun-plugin-tailwind")
  const result = await Bun.build({
    entrypoints: [webIndex.index],
    plugins: [tailwind],
    target: "browser",
    minify: !options.dev,
    sourcemap: options.dev ? "inline" : "none",
    publicPath: "/",
    naming: { entry: "[name].[ext]", chunk: "assets/[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]" },
    define: { "process.env.NODE_ENV": JSON.stringify(options.dev ? "development" : "production") },
  })
  if (!result.success) {
    throw new Error(result.logs.map((log) => String(log)).join("\n") || "the web app failed to build")
  }
  let html: string | undefined
  const assets = new Map<string, BuiltAsset>()
  for (const output of result.outputs) {
    const path = output.path.replace(/^\.\//, "/")
    if (path.endsWith(".html")) html = await output.text()
    else assets.set(path, { body: output, type: output.type })
  }
  if (html === undefined) throw new Error("the web build produced no HTML")
  return { html, assets }
}

/** Builds lazily; prod caches the first successful build, `--dev` rebuilds on every page load. */
export const makeBundleCache = (options: { readonly dev: boolean }) => {
  let current: Promise<WebBundle> | undefined
  let previous: WebBundle | undefined
  const page = async (): Promise<WebBundle> => {
    if (current === undefined || options.dev) {
      const prior = current
      current = buildWebBundle(options)
      current.catch(() => {
        current = undefined
      })
      if (prior !== undefined) previous = await prior.catch(() => previous)
    }
    return current
  }
  const asset = async (path: string): Promise<BuiltAsset | undefined> => {
    const latest = await (current ?? page()).catch(() => undefined)
    return latest?.assets.get(path) ?? previous?.assets.get(path)
  }
  return { page, asset }
}

// ============================================================================ pages

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

const shell = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<link rel="icon" href="data:," />
<style>
  :root { color-scheme: light dark; --bg: #0b0b0c; --fg: #f4f4f5; --muted: #a1a1aa; --line: #27272a; --accent: #f4f4f5; --accent-fg: #0b0b0c; }
  @media (prefers-color-scheme: light) { :root { --bg: #fafafa; --fg: #18181b; --muted: #52525b; --line: #e4e4e7; --accent: #18181b; --accent-fg: #fafafa; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
    font: 15px/22px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: min(440px, calc(100vw - 32px)); padding: 32px; border: 1px solid var(--line); border-radius: 24px; }
  h1 { margin: 0 0 8px; font-size: 22px; line-height: 28px; font-weight: 600; }
  p { margin: 0 0 16px; color: var(--muted); }
  code { font: 13px/20px ui-monospace, "SF Mono", Menlo, monospace; color: var(--fg); word-break: break-all; }
  form { display: flex; gap: 8px; margin-top: 8px; }
  input { flex: 1; min-width: 0; padding: 10px 14px; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: var(--fg); font: inherit; }
  button { padding: 10px 18px; border-radius: 999px; border: 0; background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  button.wide { width: 100%; }
  .error { color: #f87171; }
  .device { margin: 20px 0 24px; }
  .match { margin: 4px 0 8px; color: var(--fg); font-size: 56px; line-height: 64px; font-weight: 700; letter-spacing: 2px; text-align: center; font-variant-numeric: tabular-nums; }
  .or { padding-top: 20px; border-top: 1px solid var(--line); }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`

/** The page `/` answers without a session. Never contains the token. */
export const loginPage = (options?: { readonly error?: string | undefined }): string =>
  shell(
    "Sign in · OpenBot",
    `<h1>OpenBot is running</h1>
<div class="device" id="device">
  <p>Signed in to OpenBot on your phone or another computer? Let it sign this browser in.</p>
  <button type="button" class="wide" id="device-start">Sign in with another device</button>
  <div id="device-wait" hidden>
    <p>Open OpenBot where you're signed in. It asks whether to let this browser in: choose</p>
    <p class="match" id="device-match" aria-live="polite"></p>
  </div>
  <p id="device-status" hidden></p>
</div>
<p class="or">Or open the link printed in the terminal where you started OpenBot. It looks like
<code>http://127.0.0.1:7420/?token=…</code> Or paste the token here:</p>
${options?.error === undefined ? "" : `<p class="error">${escapeHtml(options.error)}</p>`}
<form method="get" action="/">
  <input name="token" type="password" autocomplete="off" spellcheck="false" placeholder="Token" aria-label="Token" required />
  <button type="submit">Sign in</button>
</form>
<script src="/login.js" defer></script>`,
  )

/**
 * The login page's script (`GET /login.js`): "Sign in with another device" asks the brain for a
 * request (`/api/auth/device/start`), shows its number, and polls until a signed-in app allows it
 * (the poll's answer sets the session cookie) or refuses it.
 */
export const LOGIN_SCRIPT = `"use strict";
(function () {
  var start = document.getElementById("device-start");
  var wait = document.getElementById("device-wait");
  var number = document.getElementById("device-match");
  var status = document.getElementById("device-status");
  if (!start) return;
  var say = function (text, error) {
    status.textContent = text;
    status.hidden = !text;
    status.className = error ? "error" : "";
  };
  var post = function (path, body) {
    return fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (res) { return res.json().catch(function () { return {}; }); });
  };
  var reset = function (text) {
    wait.hidden = true;
    start.hidden = false;
    start.disabled = false;
    start.textContent = "Try again";
    say(text, true);
  };
  start.addEventListener("click", function () {
    start.disabled = true;
    say("");
    post("/api/auth/device/start", { kind: "browser" }).then(function (begun) {
      if (!begun.deviceCode) return reset(begun.error || "OpenBot could not start that. Try again.");
      start.hidden = true;
      wait.hidden = false;
      number.textContent = String(begun.match);
      say("Waiting for you to allow it…");
      var until = Date.now() + begun.expiresInSeconds * 1000;
      var poll = function () {
        if (Date.now() > until) return reset("That request expired.");
        post("/api/auth/device/poll", { deviceCode: begun.deviceCode }).then(function (answer) {
          if (answer.status === "approved") { say("Allowed. Opening OpenBot…"); location.replace("/"); return; }
          if (answer.status === "refused") return reset("That request was turned down or cancelled.");
          if (answer.status === "expired") return reset("That request expired.");
          setTimeout(poll, (begun.interval || 2) * 1000);
        }, function () { setTimeout(poll, 4000); });
      };
      setTimeout(poll, (begun.interval || 2) * 1000);
    }, function () { reset("OpenBot could not be reached. Try again."); });
  });
})();
`

/**
 * The service worker (`GET /sw.js`) of Web Push (webPush.ts): it shows every push as a
 * notification (WebKit revokes the subscription of a worker that shows none), one per chat, and a click
 * opens its chat.
 */
export const SERVICE_WORKER = `"use strict";
// a new version takes over at once; a client must be controlled for navigate(), also one opened
// before push was turned on
self.addEventListener("install", function () {
  self.skipWaiting();
});
self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("push", function (event) {
  var n = event.data ? event.data.json() : {};
  event.waitUntil(self.registration.showNotification(n.title || "OpenBot", {
    body: n.body,
    tag: n.conversationId || n.id,
    renotify: true,
    requireInteraction: n.kind === "waiting",
    data: { path: n.conversationId ? "/#/c/" + encodeURIComponent(n.conversationId) : "/" },
  }));
});
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = new URL(event.notification.data.path, self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (open) {
    if (open.length === 0) return self.clients.openWindow(url);
    return open[0].focus().then(function (focused) { return focused.navigate(url); }).catch(function () {
      return self.clients.openWindow(url);
    });
  }));
});
`

export const unavailablePage = (detail: string): string =>
  shell(
    "OpenBot",
    `<h1>The web app could not be loaded</h1>
<p>The brain is running, but building the web app failed:</p>
<p><code>${escapeHtml(detail.slice(0, 4000))}</code></p>`,
  )

export const PAGE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const

/** CSP of the error pages (no scripts). */
export const STATIC_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"

/** CSP of the login page: its own script (`/login.js`) talking to this brain, nothing else. */
export const LOGIN_PAGE_CSP =
  "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"

// ============================================================================ the app page

export interface WebApp {
  readonly mode: WebMode
  /** The app HTML for an authenticated request. */
  readonly page: Effect.Effect<
    { readonly ok: true; readonly html: string } | { readonly ok: false; readonly detail: string }
  >
  /** `/assets/*` in bundle mode. */
  readonly asset: (path: string) => Effect.Effect<BuiltAsset | undefined>
}

/** `selfBase` reaches this server over loopback (hmr mode fetches the hidden route through it). */
export const makeWebApp = (plan: WebPlan, options: { readonly dev: boolean; readonly selfBase: string }): WebApp => {
  if (plan.mode === "hmr") {
    return {
      mode: "hmr",
      page: Effect.promise(async () => {
        try {
          const res = await fetch(`${options.selfBase}${HIDDEN_APP_ROUTE}`)
          const html = await res.text()
          if (!res.ok || !html.includes("<script")) {
            return {
              ok: false as const,
              detail: `the Bun dev server answered ${res.status} without the app (see the brain's log)`,
            }
          }
          return { ok: true as const, html }
        } catch (error) {
          return { ok: false as const, detail: error instanceof Error ? error.message : String(error) }
        }
      }),
      asset: () => Effect.succeed(undefined),
    }
  }
  const cache = makeBundleCache({ dev: options.dev })
  return {
    mode: "bundle",
    page: Effect.promise(() =>
      cache.page().then(
        (bundle) => ({ ok: true as const, html: bundle.html }),
        (error: unknown) => ({ ok: false as const, detail: error instanceof Error ? error.message : String(error) }),
      ),
    ),
    asset: (path) => Effect.promise(() => cache.asset(path)),
  }
}

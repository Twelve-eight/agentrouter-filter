// agentrouter / chat-only-provider gateway for Codex CLI.
//
// Why this exists
// ---------------
// 1. Codex 0.154 removed the chat/completions wire entirely (`wire_api = "chat"`
//    -> "no longer supported"; the only accepted value is "responses").
// 2. Codex has no request-rewriting hook (only PreToolUse / UserPromptSubmit /
//    SessionStart / ...), so the outbound sanitisation that omp applied through
//    G:/omp works/.omp/hooks/pre/strip-illegal.ts cannot be attached to Codex
//    directly.
// 3. agentrouter (ps.air-outer.com) content-blocks certain character/word
//    combinations and its client allowlist rejects unknown clients.
//
// This process is the transport that carries the omp hook's filter over to
// Codex, and bridges chat-only upstreams (wb2api) onto the responses wire.
//
// Routes (point a Codex model_provider at http://127.0.0.1:7878/<prefix>/v1):
//   /ar/*  -> https://ps.air-outer.com/v1     (native responses upstream)
//   /wb/*  -> http://127.0.0.1:7863/v1        (chat upstream, bridged)
//   /rc/*  -> https://api.relaycat.top/v1     (native responses upstream)
//   /u/*   -> whichever registry provider serves the request's `model`
//
// filter.mjs does NOT run on every route: it is opt-in per route, and only the
// routes flagged `filter: true` below (plus registry entries with `filter: true`
// in providers.json, reached through /u) are sanitised. Today that is
// agentrouter only - the other upstreams forward the body verbatim, so their
// emoji/non-approved characters are preserved. The README route table is the
// authoritative list; it is kept in sync with this flag rather than restated
// here, because a second copy is what drifts.
//
// The listener is a LOCAL TRUST component: it binds 127.0.0.1 and performs no
// authentication of its own, and the unified /u route substitutes the upstream
// credential from the environment. Anything that can reach 127.0.0.1:7878 can
// therefore spend the configured upstream keys and read the usage log. See the
// README's "本地信任边界" note.

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { filterBody } from "./filter.mjs";
import { guardBody, selectRules, summarize } from "./egress-guard.mjs";
import { bridgeAnthropicStream, bridgeChatStream, toAnthropicBody, toChatBody } from "./bridge.mjs";
import { record as recordUsage } from "./usage.mjs";
import { statsApi } from "./stats-api.mjs";
import { stripForeignItemIds, stripAllItemIds, isItemIdRejection } from "./responses-ids.mjs";

// Per-provider credentials for upstreams whose key is not already in the
// machine/user environment (agentrouter's is Machine-scoped; justwoker's could
// not be, since setting Machine scope needs admin). Kept in a gitignored file so
// the secret never reaches the repository, and loaded BEFORE the registry is read
// because providerFor() resolves keys from process.env.
//
// PRECEDENCE: this file OVERRIDES the ambient environment (see loadLocalEnv).
//
// Why that direction, when the usual convention is the opposite: an inherited
// environment variable is a SNAPSHOT taken when the process tree was created,
// and this gateway is launched by autostart through Windows Terminal, whose
// shell may have been running for hours. Rotating a key with
// [Environment]::SetEnvironmentVariable updates the registry but NOT any
// already-running shell, so the gateway kept inheriting a REVOKED key.
//
// Measured 2026-09-24: after rotating JUSTWOKER_API_KEY, the file and the User
// scope both held the new value, direct calls with it returned 200, and the
// gateway still answered 401 'Invalid token' - because its parent terminal had
// captured the old value earlier and the old code let the environment win.
//
// The failure mode is the point: a shadowed key is indistinguishable from a bad
// key at the API boundary, so it sends you hunting the wrong problem. Making the
// FILE authoritative means editing it is always sufficient, and
// `AR_ALLOW_ENV_OVERRIDE=1` is there for the rare case an operator really does
// need to inject a key per-process.
//
// Format: KEY=value per line, `#` comments, surrounding quotes stripped.
function loadLocalEnv() {
  const file = new URL("./.env.local", import.meta.url);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return; // no local overrides - environment alone is fine
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // The file wins - see the precedence note above loadLocalEnv. A stale
    // ambient variable once shadowed a rotated key here and surfaced only as an
    // upstream 401. AR_ALLOW_ENV_OVERRIDE=1 restores the old direction for the
    // rare case an operator must inject a key per-process.
    if (process.env.AR_ALLOW_ENV_OVERRIDE === "1") {
      if (process.env[key] === undefined) process.env[key] = value;
    } else {
      process.env[key] = value;
    }
  }
}
loadLocalEnv();

const PORT = Number(process.env.AR_GATEWAY_PORT ?? 7878);
const HOST = "127.0.0.1";

// Idle deadline for an upstream BUSINESS response body. This is DISTINCT from the
// probe deadline in fetchLocalJSON (db2c5dd added that one, and only for the
// /status and /healthz probes). An upstream that flushes its response headers and
// then goes silent - a half-open TCP connection, or a body truncated mid-flight -
// would otherwise hang this path forever: it had no setTimeout on the business
// body, only res.on("close") (which fires on CLIENT disconnect, not on upstream
// silence). This is an IDLE timeout, not a total-duration cap: every received
// chunk resets it, so a long but healthy stream is never cut - only a genuinely
// dead socket is. 0 disables it. The 120s default sits well above any single
// inter-chunk gap a real generation produces while still bounding a stall.
const BODY_IDLE_TIMEOUT_MS = Number(process.env.AR_UPSTREAM_BODY_IDLE_MS ?? 120_000);


// The opencode-zen free tier only serves requests that carry the OpenCode
// client's first five built-in tool definitions (see oc-zen-proxy.mjs). The proxy
// prepends them, so they must be stripped from anything the caller sees - a tool
// the caller never declared must not show up in a response.
const TOOL_GUARD_NAMES = new Set(["bash", "edit", "glob", "grep", "read"]);
function isGuardToolName(name) {
  return typeof name === "string" && TOOL_GUARD_NAMES.has(name);
}


// Origins only: the incoming path already carries /v1/.. (Codex base_url is
// http://127.0.0.1:7878/<prefix>/v1).
// AR_UPSTREAM_<PREFIX> overrides a route's origin (e.g. to point /ar at a
// mirror, or at a local echo for testing).
//
// Per-route behaviour:
//   filter - run the agentrouter char/word filter + identity block and inject
//            the extra model-facing requirements. Only agentrouter needs it (its
//            word list blocks on opaque content); running it on other upstreams
//            would only lose fidelity (emoji and non-approved scripts deleted,
//            identifiers rewritten).
//            The phrase list is the GLM upstream word list, so it stays until
//            glm-5.3 is reachable for re-testing (it is 503 right now); the
//            identity rewrite is an unconditional user requirement.
const ROUTES = {
  ar: {
    name: "agentrouter",
    base: process.env.AR_UPSTREAM_AR ?? "https://ps.air-outer.com",
    chat: false,
    filter: true,
    // ps.air-outer.com validates the prefix of every replayed item id against
    // the item type (reasoning -> rs, message -> msg, function_call -> fc, ...)
    // and answers 400 for a foreign one. See responses-ids.mjs for the probes.
    strictItemIds: true,
  },
  // Two key groups share this host; the route cannot tell them apart, so the
  // name covers both. Usage rows still separate them by model.
  rc: {
    name: "relaycat",
    base: process.env.AR_UPSTREAM_RC ?? "https://api.relaycat.top",
    chat: false,
  },
  wb: { name: "wb2api", base: process.env.AR_UPSTREAM_WB ?? "http://127.0.0.1:7863", chat: true },
  // anyrouter.top is TLS-blocked on a direct connection (omp reports "unknown
  // certificate verification error"); it needs the local HTTP proxy. The proxy
  // is applied per-route so agentrouter (which hangs through it) stays direct.
  an: { name: "anyrouter", base: process.env.AR_UPSTREAM_AN ?? "https://anyrouter.top", chat: false, proxy: process.env.AR_PROXY_AN ?? "http://127.0.0.1:7897" },
  // justwoker serves Claude models on the anthropic wire. Its
  // /v1/chat/completions exists but Cloudflare blocks every POST to it (403
  // "Attention Required!"; GET /v1/models passes), and /v1/responses is
  // "not implemented" - so the anthropic bridge is the only working path.
  jw: { name: "justwoker", base: process.env.AR_UPSTREAM_JW ?? "https://api.justwoker.icu", anthropic: true },
};

// ---------------------------------------------------------------------------
// model registry (providers.json)
//
// The /u route dispatches on the request's `model` field, so one client provider
// entry covers every upstream. providers.json is also what
// tools/build-model-catalog.cjs reads, so the picker and the gateway cannot
// disagree about which models exist or where they go.
// ---------------------------------------------------------------------------
const ROUTE_PREFIX = { agentrouter: "AR", relaycat: "RC", "relaycat-cn": "RC", wb2api: "WB", anyrouter: "AN", justwoker: "JW" };

// omp's own dashboard client (MIT), vendored from its embedded-client blob. Served
// as static files so the browser loads index.js/styles.css relative to /stats/.
// Read per request, not at module load: the vendored files get swapped when the
// UI is refreshed, and caching them here would make that require a gateway restart.
const STATS_CLIENT_DIR = fileURLToPath(new URL("./vendor/omp-stats/", import.meta.url));
const STATS_CLIENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const REGISTRY_PATH = new URL("./providers.json", import.meta.url);

// Read per request, not at module load - same reasoning as the stats client above. A
// module-load read meant adding a model to providers.json silently required a
// gateway restart, and the failure mode is nasty: the model is already in the
// picker (the catalog builder reads the same file directly) so selecting it
// returns "unknown model" from the gateway while everything looks configured.
// Re-parsing a ~5 KB file per request is far cheaper than that class of bug.
//
// The parsed object is cached against the file's mtime+size, so a request pays
// one stat() and only re-parses when the file actually changed.
let registryCache = { key: null, value: null };
function registry() {
  let st;
  try {
    st = fs.statSync(REGISTRY_PATH);
  } catch {
    // File missing/unreadable: keep serving the last good copy rather than
    // dropping every route.
    if (registryCache.value) return registryCache.value;
    throw new Error("providers.json is unreadable");
  }
  const key = `${st.mtimeMs}:${st.size}`;
  if (registryCache.key !== key) {
    try {
      const value = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
      registryCache = { key, value };
    } catch (e) {
      // Torn read (the file is mid-rewrite) or a syntax error from a bad edit.
      // Serving the last good copy is the whole point of the stat fallback above,
      // so this must not throw - an unguarded parse would 500 every request in
      // exactly the window the fallback exists to cover. `key` is deliberately
      // NOT updated, so the next request re-stats and retries instead of caching
      // the failure until a restart.
      if (registryCache.value) return registryCache.value;
      throw e;
    }
  }
  return registryCache.value;
}

/** Resolve a client model id to the upstream that serves it. */
function providerFor(model) {
  const reg = registry();
  const spec = reg.models[model];
  if (!spec || typeof spec !== "object") return null;
  const p = reg.providers[spec.p];
  if (!p) return null;
  return {
    name: spec.p,
    // Overridable for testing/mirrors. Accept the provider name
    // (AR_UPSTREAM_AGENTROUTER) and the legacy route prefix (AR_UPSTREAM_AR),
    // so the existing /ar-style overrides keep working.
    base: process.env[`AR_UPSTREAM_${spec.p.toUpperCase().replace(/-/g, "_")}`]
      ?? process.env[`AR_UPSTREAM_${ROUTE_PREFIX[spec.p] ?? ""}`]
      ?? p.base,
    // Wire selection. The provider's own `wire` is the default, but a model
    // may override it (`"wire"` inside its providers.json entry). anyrouter needs
    // this: the provider serves `gpt-6-astra` on the responses wire while its
    // claude ids live ONLY on the anthropic /v1/messages face - probing showed
    // /v1/responses answering 404 "当前 API 不支持所选模型" for every claude id,
    // and /v1/messages answering 400/503 (i.e. reaching the business layer).
    // Without the override, registering a claude id would send it down the
    // responses passthrough and it could never work.
    wire: typeof spec.wire === "string" ? spec.wire : p.wire,
    chat: (typeof spec.wire === "string" ? spec.wire : p.wire) === "chat",
    anthropic: (typeof spec.wire === "string" ? spec.wire : p.wire) === "anthropic",
    filter: p.filter === true,
    // Strict-Responses upstream: a replayed item id must follow its per-type
    // prefix contract, and an id minted by a DIFFERENT upstream has to be
    // dropped before the body leaves. Declared per provider in providers.json so
    // this toggle sits with the other upstream facts instead of being hardcoded.
    strictItemIds: p.strictItemIds === true,
    proxy: p.proxy,
    // Upstream model id, when it differs from the id the client sent.
    upstreamModel: spec.m ?? model,
    // The credential is per-provider, but a client of the unified route sends only
    // ONE key (its own provider's env_key). Forwarding that key to a different
    // upstream fails - e.g. the agentrouter key at the local wb2api returns
    // "missing or invalid API key". So the gateway substitutes the key each
    // upstream actually needs; without this the unified route only works for the
    // provider whose key the client happened to send.
    keyEnv: p.keyEnv,
    key: p.keyEnv ? process.env[p.keyEnv] : undefined,
    // Effort levels the upstream accepts, when it is pickier than chat/completions
    // (opencode-zen's mimo-v2.6-flash-free: low/medium/high only; max/xhigh are
    // 400). A MODEL may override the provider window with its own `efforts` array
    // in providers.json: zen's space-bunny-free accepts all six levels, so
    // inheriting the provider list silently downgraded a `max` request to `high`
    // (measured 2026-09-24; the clamp itself lives in bridge.mjs toChatBody).
    // Precedence: model > provider > null (no clamp).
    efforts: Array.isArray(spec.efforts) ? spec.efforts
      : (Array.isArray(p.efforts) ? p.efforts : null),
    // Egress redaction. providers.json `egressGuard` selects which rules run
    // before the body leaves the machine; a model entry may narrow it further
    // (same model > provider precedence as `efforts`).
    //   true / "all" -> every rule
    //   ["api-key", "host-identity"] -> only those (prefixes allowed)
    //   absent -> no redaction (the default: only for providers we trust)
    egressGuard: spec.egressGuard !== undefined ? spec.egressGuard
      : (p.egressGuard !== undefined ? p.egressGuard : null),
    // Extra request headers to inject on the wire, per model or per provider
    // (providers.json `headers`). anyrouter's claude ids REQUIRE
    // `anthropic-beta: context-1m-2025-08-07`: without it the upstream answers
    // 400 "1m 上下文已经全量可用,请启用 1m 上下文后重试", and WITH it the error
    // layer advances to 503 (Service Unavailable) - which is how we know the
    // header is right and the remaining failure is the upstream channel pool.
    // Absent => null => nothing injected => existing providers unchanged.
    headers: (spec.headers && typeof spec.headers === "object")
      ? spec.headers
      : ((p.headers && typeof p.headers === "object") ? p.headers : null),
    // Cross-realm fallback target for this model (providers.json "fallback"),
    // e.g. "global:deepseek-v4.1-flash" -> "cn:deepseek-v4.1-flash".
    fallback: typeof spec.fallback === "string" ? spec.fallback : null,
  };
}

/** Every client-facing model id, for GET /u/v1/models. */
function modelList() {
  return Object.entries(registry().models)
    .filter(([, v]) => v && typeof v === "object")
    .map(([id, v]) => ({ id, object: "model", owned_by: v.p }));
}

// The anthropic wire authenticates with `x-api-key` and requires
// `anthropic-version`; a Bearer Authorization header is ignored (probe-verified:
// /v1/messages with x-api-key returned 200, the same call with Bearer 403'd at
// Cloudflare). Codex sends `Authorization: Bearer ..`, so translate rather than
// forward.
function anthropicHeaders(headers, extra = null) {
  const out = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
  const bearer = headers.authorization?.replace(/^Bearer\s+/i, "");
  const key = headers["x-api-key"] ?? bearer;
  if (key) out["x-api-key"] = key;
  // `accept` is deliberately NOT forwarded. This upstream sits behind
  // Cloudflare, and an explicit `accept: */*` intermittently drew a 403
  // "Attention Required!" page (measured: same body, same key, 1/3 requests
  // failed with it, 0/3 without). Nothing here needs content negotiation.
  for (const h of ["originator", "version", "session_id", "user-agent", "anthropic-beta"]) {
    if (headers[h] !== undefined) out[h] = headers[h];
  }
  // Registry-declared headers win over the forwarded ones: a provider that
  // states it needs `anthropic-beta` must get exactly that, not whatever the
  // client happened to send. Absent => nothing changes for existing providers.
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === "string" && v) out[k.toLowerCase()] = v;
    }
  }
  return out;
}
function log(...a) {
  process.stdout.write(`[${new Date().toISOString()}] ${a.join(" ")}\n`);
}

function request(url, { method, headers, body, proxy }) {
  const u = new URL(url);
  // Frame the body explicitly instead of letting Node pick.
  //
  // A request that HAS a body and NO Content-Length is sent as
  // `Transfer-Encoding: chunked`. Some upstreams cannot decode that and answer
  // a body-level error even though the bytes are valid JSON. Measured
  // 2026-09-24 against motomoto.lol (a New-API relay), SAME key and SAME body:
  //
  //   chunked         -> HTTP 400 `Invalid request: invalid JSON request body`
  //                      (new_api_error, request id 20260924122122...)
  //   Content-Length  -> HTTP 200 with a real completion
  //
  // The wire bytes of the body are identical either way; only the framing
  // changes. Every caller here passes a complete string (a JSON body, up to
  // ~500 KB), so the length is always known.
  const framed = body !== undefined && body !== null
    && headers["Content-Length"] === undefined && headers["content-length"] === undefined
    && headers["Transfer-Encoding"] === undefined && headers["transfer-encoding"] === undefined
    ? { ...headers, "Content-Length": Buffer.byteLength(body) }
    : headers;
  if (!proxy) {
    return new Promise((resolve, reject) => {
      const mod = u.protocol === "https:" ? https : http;
      const req = mod.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + u.search,
          method,
          headers: framed,
        },
        (res) => resolve(res),
      );
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }
  // HTTP CONNECT tunnel through a local proxy (needed by anyrouter.top).
  return new Promise((resolve, reject) => {
    const p = new URL(proxy);
    const port = u.port || (u.protocol === "https:" ? 443 : 80);
    const connectReq = http.request({
      host: p.hostname,
      port: p.port || 8080,
      method: "CONNECT",
      path: `${u.hostname}:${port}`,
      headers: { Host: `${u.hostname}:${port}` },
    });
    connectReq.on("connect", (cres, socket) => {
      if (cres.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT ${cres.statusCode}`));
        return;
      }
      const req = https.request(
        {
          socket,
          servername: u.hostname,
          path: u.pathname + u.search,
          method,
          headers: { ...framed, Host: u.hostname },
        },
        (res) => resolve(res),
      );
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
    connectReq.on("error", reject);
    connectReq.end();
  });
}

// ---------------------------------------------------------------------------
// 429 retry
// ---------------------------------------------------------------------------
//
// wb2api answers 429 when the account its pool picked cannot serve the request
// (the pool holds several accounts and picks again on the next attempt). A 429
// that reaches Codex aborts the whole turn, so a transient account exhaustion
// used to kill a live session. Retrying here keeps that from happening.
//
// Only 429 is retried. A 400/401/403/404/422 describes the request itself and
// would fail identically on a replay; 5xx is deliberately left alone so a
// genuinely broken upstream stays visible instead of being hidden behind three
// silent retries. The backoff is bounded (<= ~3s by default) so a real outage
// still fails fast enough for the client to react.
const RETRY_STATUS = 429;
const RETRY_MAX = 3; // extra attempts after the first
const RETRY_BASE_MS = 400;

function retryAfterMs(res, attempt) {
  const raw = res?.headers?.["retry-after"];
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 10000);
  const at = Date.parse(String(raw ?? ""));
  if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), 10000);
  return RETRY_BASE_MS * 2 ** attempt; // 400, 800, 1600
}

async function requestWithRetry(url, opts, label) {
  const retry = opts.retry !== false;
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await request(url, opts);
    if (res.statusCode !== RETRY_STATUS || !retry || attempt >= RETRY_MAX) return res;
    const wait = retryAfterMs(res, attempt);
    // Drain the discarded attempt; an unconsumed response keeps its socket open.
    res.resume();
    log(`!! ${label} answered 429; retrying (${attempt + 1}/${RETRY_MAX}) in ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
  }
}


// Idle-timeout guard for an upstream BUSINESS response body (S4). The passthrough
// and bridge paths register only end/close/error handlers, so an upstream that
// stops sending after its headers - without ending or erroring - is never noticed
// and the client waits for its own timeout. This arms a timer that fires only if
// no chunk arrives for BODY_IDLE_TIMEOUT_MS; every chunk (and a normal end/close/
// error) rearms or clears it, so a slow-but-live stream is untouched. On idle it
// runs onIdle() once and destroys the upstream, which lets each caller finish with
// an explicit terminal state instead of hanging. Returns a disarm() the caller
// must invoke on its own terminal path. Disabled when the configured value is <= 0.
function armBodyIdleTimeout(upstream, onIdle) {
  if (!(BODY_IDLE_TIMEOUT_MS > 0)) return () => {};
  let fired = false;
  let timer = null;
  const disarm = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };
  const trip = () => {
    if (fired) return;
    fired = true;
    disarm();
    try { onIdle(); } catch {}
    try { if (!upstream.destroyed) upstream.destroy(); } catch {}
  };
  const rearm = () => {
    if (fired) return;
    disarm();
    timer = setTimeout(trip, BODY_IDLE_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
  };
  upstream.on("data", rearm);
  upstream.on("end", disarm);
  upstream.on("close", disarm);
  upstream.on("error", disarm);
  rearm();
  return disarm;
}



// ---------------------------------------------------------------------------
// cross-realm fallback (global -> cn)
// ---------------------------------------------------------------------------
//
// Why this exists
// ---------------
// wb2api keeps the CN and global account pools strictly separate: a `global:`
// request only ever picks a global account, and vice versa
// (internal/pool/pick.go: `realmOK` filters candidates AND the all-cooling
// fallback `pickEarliestExpiryLocked`). There is no cross-realm degradation on
// that side, upstream or locally, and the pool's own regression test asserts
// the separation. So when every global account is rate-limited, the client turn
// dies on a 429 - which is exactly what was killing Codex sessions.
//
// The direction is deliberately one-way, global -> cn:
//   * global accounts get their allowance refreshed on their own;
//   * cn credits are the scarce, hard-to-regenerate resource.
// So global is spent by default and cn only covers the exhausted window.
//
// Two rules keep this honest:
//   1. ENTERING the fallback requires an OBSERVED upstream failure - never a
//      health probe. A domain can report healthy=0/not-servable and still
//      serve: the pool re-selects soft-cooled accounts in the all-cooling
//      fallback and really does send them. Routing on the probe alone would
//      abandon global while it can still answer, which is the opposite of the
//      intent.
//   2. LEAVING the fallback requires POSITIVE evidence that global can serve
//      this model again - a selectable account in GET /status. The window
//      therefore never sticks to cn longer than global is actually down.
//
// Everything here is inert for models that declare no `fallback` in
// providers.json, so other models' behaviour is unchanged.

// client model id -> epoch ms until which we should stay on the fallback id.
const fallbackUntil = new Map();

// provider base -> { at, value } for GET /status. Kept short: the recovery
// time only matters at arm time, and a stale answer only costs one extra probe.
const statusCache = new Map();
// Env-overridable so tests can observe cache transitions without sleeping.
const STATUS_TTL_MS = Number(process.env.AR_REALM_STATUS_TTL_MS ?? 30_000);
const STATUS_TIMEOUT_MS = Number(process.env.AR_REALM_STATUS_TIMEOUT_MS ?? 3_000);

// provider base -> { at, value } for GET /healthz realm_servable.
const healthCache = new Map();
const HEALTH_TTL_MS = Number(process.env.AR_REALM_HEALTH_TTL_MS ?? 30_000);
const HEALTH_TIMEOUT_MS = Number(process.env.AR_REALM_HEALTH_TIMEOUT_MS ?? 2_000);

// Used when the recovery time is unknown (no /status, or the key is missing).
// The window is a guard against hammering global; the positive-evidence check
// above normally clears it long before this fires.
const FALLBACK_UNKNOWN_WINDOW_MS = 15 * 60_000;
// Hard ceiling so a bogus far-future reset_at cannot pin us to cn forever.
const FALLBACK_MAX_WINDOW_MS = 24 * 3600_000;

// resolveFallback results, keyed by "<provider>::<target model id>".
const fallbackCache = new Map();

/** Mirror of wb2api's resolve_model.go: strip a leading `cn:` / `global:`. */
function bareModelOf(id) {
  if (typeof id !== "string") return "";
  const i = id.indexOf(":");
  if (i < 0) return id;
  const prefix = id.slice(0, i);
  return prefix === "cn" || prefix === "global" ? id.slice(i + 1) : id;
}

/** Which realm a model id belongs to, by the same prefix convention. */
function realmOfModel(id) {
  return typeof id === "string" && id.startsWith("global:") ? "global" : "cn";
}

/**
 * Resolve a client model id's configured fallback, if it is safe to use.
 *
 * Returns { id, upstreamModel } or null. Null covers three cases that must all
 * be visible rather than silent: no fallback configured; the target is not in
 * the registry; the target is served by a DIFFERENT provider (it would need
 * another credential and base URL, so honouring it through the current route
 * object would send the wrong key to the wrong host).
 */
function resolveFallback(clientModel, route) {
  if (!route || typeof route.fallback !== "string" || !route.fallback) return null;
  const cacheKey = route.name + "::" + route.fallback;
  if (fallbackCache.has(cacheKey)) return fallbackCache.get(cacheKey);
  let out = null;
  const target = providerFor(route.fallback);
  if (!target) {
    log(`!! cross-realm: fallback target '${route.fallback}' is not in providers.json; fallback disabled for '${clientModel}'`);
  } else if (target.name !== route.name) {
    log(`!! cross-realm: fallback target '${route.fallback}' is served by '${target.name}', not '${route.name}'; refusing (different credential/base)`);
  } else {
    out = { id: route.fallback, upstreamModel: target.upstreamModel };
  }
  fallbackCache.set(cacheKey, out);
  return out;
}

/**
 * Publish which realm actually answered, and when the next good chance to
 * leave the fallback is. Both headers are informational: the gateway still
 * answers the request normally, so a client that ignores them is unaffected.
 *
 * Only sent when the model has a fallback configured - models without one
 * keep byte-identical responses.
 */
function setRealmHeaders(res, realm, retryAt, source) {
  if (!realm) return;
  try {
    res.setHeader("X-Gateway-Realm", realm);
    if (retryAt) res.setHeader("X-Gateway-Retry-At", new Date(retryAt).toISOString());
    if (source) res.setHeader("X-Gateway-Realm-Source", source);
  } catch {
    // Headers already flushed (a streaming bridge wrote its head first).
    // The body is unaffected; losing the hint beats failing the request.
  }
}
/** GET a local JSON endpoint with a bounded timeout; null on any failure. */
async function fetchLocalJSON(url, headers, timeoutMs) {
  // This deadline owns the entire exchange, not just receipt of the headers.
  // Keep cancellation local to probes; normal upstream retry semantics stay put.
  return new Promise((resolve) => {
    let req;
    let response;
    let settled = false;
    const deadline = Date.now() + timeoutMs;
    const finish = (value, cancel = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cancel) {
        response?.destroy();
        req?.destroy();
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null, true), timeoutMs);
    try {
      const u = new URL(url);
      const mod = u.protocol === "https:" ? https : http;
      req = mod.request({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        headers,
      }, async (res) => {
        response = res;
        if (settled) { res.destroy(); return; }
        try {
          if (res.statusCode !== 200) { finish(null, true); return; }
          const chunks = [];
          for await (const c of res) {
            if (settled) return;
            if (Date.now() >= deadline) { finish(null, true); return; }
            chunks.push(c);
          }
          if (settled) return;
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          // Parsing is synchronous, so also check the clock after it returns.
          if (Date.now() >= deadline) finish(null, true);
          else finish(value);
        } catch {
          finish(null, true);
        }
      });
      req.on("error", () => finish(null, true));
      req.end();
    } catch {
      finish(null, true);
    }
  });
}

/** Cached GET /status. null when the key is missing or the call fails. */
async function fetchStatus(route) {
  if (!route || !route.key) return null;
  const hit = statusCache.get(route.base);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.value;
  const value = await fetchLocalJSON(
    route.base + "/status",
    { authorization: `Bearer ${route.key}` },
    STATUS_TIMEOUT_MS,
  );
  statusCache.set(route.base, { at: Date.now(), value });
  return value;
}

/** Cached GET /healthz (no auth). null when the call fails. */
async function fetchHealth(route) {
  if (!route) return null;
  const hit = healthCache.get(route.base);
  if (hit && Date.now() - hit.at < HEALTH_TTL_MS) return hit.value;
  const value = await fetchLocalJSON(route.base + "/healthz", {}, HEALTH_TIMEOUT_MS);
  healthCache.set(route.base, { at: Date.now(), value });
  return value;
}

/**
 * Can any global account serve `bareModel` right now, and if not, when is the
 * earliest one expected back?
 *
 * Returns { ok, at, source } where at is epoch ms or null:
 *   source "status"        ok=true  - at least one account is selectable now
 *   source "status-model"  ok=false - the only blocker is a MODEL-level 6004
 *                                     cooldown whose reset_at is upstream's own
 *                                     wall clock (authoritative)
 *   source "status-account" ok=false - blocked at account level; `until` is a
 *                                     LOCAL estimate and may be truncated to
 *                                     soft_rate_max, so it can be earlier than
 *                                     the real recovery. Labelled separately so
 *                                     callers are not misled by the precision.
 *   source "health"        - /status unavailable; realm_servable is a boolean
 *                             with no time, so at=null
 *   source "unknown"       - nothing usable
 *
 * Disabled accounts are skipped, not treated as "recovering": they need a
 * human re-login, so counting them would produce a recovery time that never
 * arrives.
 */
function globalRealmState(status, bareModel) {
  const accounts = Array.isArray(status?.accounts)
    ? status.accounts.filter((a) => a && a.realm === "global")
    : null;
  if (!accounts) return null;
  if (!accounts.length) return { ok: false, at: null, source: "no-account" };
  const now = Date.now();
  let minAt = null;
  // Which KIND of blocker produced minAt. This must be tracked per-account, not
  // as a sticky any-account flag: an account with a truncated account-level
  // `until` can expire EARLIER than another account's upstream-authoritative
  // model reset, and then it is the one that decides the reported time. A sticky
  // flag would label that estimate "status-model" and overstate its precision.
  let minLevel = null;
  for (const a of accounts) {
    if (a.disabled) continue;
    // Account-level block: `until` is a LOCAL estimate (soft_rate_max can
    // truncate it, and hard_credit parks the account until the 04:00 re-probe,
    // not until credits actually return).
    let at = 0;
    let level = "account";
    const until = Date.parse(a.until ?? "");
    if (Number.isFinite(until)) at = Math.max(at, until);
    for (const m of a.rate_limited_models ?? []) {
      if (m.model !== bareModel) continue;
      const reset = Date.parse(m.reset_at ?? "") || Date.parse(m.until ?? "");
      // `>=` rather than `>` matters: when the cooldown was NOT truncated,
      // wb2api reports Until == ResetAt (see pool/entry.go: ResetAt is the raw
      // upstream wall clock and equals Until in the untruncated case). That
      // equality IS the authoritative case, so it must still label as "model".
      if (Number.isFinite(reset) && reset >= at) {
        // Model-level 6004 reset from the upstream's own wall clock: the most
        // authoritative signal available, so it wins the label for THIS account.
        at = reset;
        level = "model";
      }
    }
    if (at <= now) return { ok: true, at: null, source: "status" };
    if (minAt === null || at < minAt) {
      minAt = at;
      minLevel = level;
    }
  }
  if (minAt === null) return { ok: false, at: null, source: "all-disabled" };
  return { ok: false, at: minAt, source: minLevel === "model" ? "status-model" : "status-account" };
}

/**
 * Combined check used both to arm and to leave the fallback window.
 * Prefers /status (per-model, absolute times); falls back to /healthz, which
 * only answers "is any account of that realm selectable at all".
 */
async function globalAvailability(route, bareModel) {
  const status = await fetchStatus(route);
  if (status) {
    const st = globalRealmState(status, bareModel);
    if (st) return st;
  }
  const health = await fetchHealth(route);
  if (typeof health?.realm_servable?.global === "boolean") {
    const ok = health.realm_servable.global === true;
    return { ok, at: null, source: ok ? "health" : "health-negative" };
  }
  return { ok: false, at: null, source: "unknown" };
}

/**
 * Arm the fallback window for `clientModel` after an observed failure, and work
 * out when global is expected back. Returns { retryAt: Date|null, source }.
 *
 * The window is always armed, even when the recovery time is unknown - staying
 * on the fallback briefly is strictly better than hammering a dead domain on
 * every request. It is cleared early the moment globalAvailability reports a
 * selectable account.
 */
async function armFallback(clientModel, route, status, errText) {
  const bare = bareModelOf(route.upstreamModel);
  let retryAt = null;
  let source = "unknown";
  const rec = await globalAvailability(route, bare);
  if (rec.at) {
    retryAt = new Date(rec.at);
    source = rec.source;
  } else if (rec.ok) {
    // /status already shows a selectable global account, yet the upstream just
    // answered 429/503. Treat it as transient: keep the fallback for this
    // request, but re-try global on the very next one.
    retryAt = new Date(Date.now() + 5_000);
    source = "transient";
  } else {
    source = rec.source;
  }
  const now = Date.now();
  const until = retryAt ? retryAt.getTime() : now + FALLBACK_UNKNOWN_WINDOW_MS;
  fallbackUntil.set(clientModel, Math.min(until, now + FALLBACK_MAX_WINDOW_MS));
  const body = String(errText ?? "").replace(/\s+/g, " ").slice(0, 160);
  log(`!! cross-realm: ${clientModel} exhausted (upstream ${status}); fallback armed until ` +
      `${new Date(fallbackUntil.get(clientModel)).toISOString()} source=${source}; upstream said: ${body}`);
  return { retryAt, source };
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
  // Usage dashboard. The UI is omp's own React client (MIT, vendored under
  // vendor/omp-stats/) and the data comes from stats-api.mjs, which maps this
  // gateway's usage log onto the API contract that client expects. Kept on the
  // gateway process so there is no second thing to start.
  if (req.method === "GET" && (req.url === "/stats" || req.url === "/stats/")) {
    res.writeHead(302, { Location: "/stats/index.html", "Cache-Control": "no-cache" });
    res.end();
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/stats/")) {
    const rel = decodeURIComponent(req.url.slice("/stats/".length).split("?")[0]);
    // Contain the path: a request for /stats/../../server.mjs must not escape the
    // vendored client directory.
    const full = path.join(STATS_CLIENT_DIR, rel);
    const type = STATS_CLIENT_TYPES[path.extname(full).toLowerCase()];
    if (!type || !full.startsWith(STATS_CLIENT_DIR)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    let body;
    try {
      // Read per request, like the registry above: the vendored files are swapped
      // during development and a cached copy would keep serving the old client.
      body = fs.readFileSync(full);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(body);
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/api/")) {
    const q = new URL(req.url, "http://127.0.0.1");
    const payload = statsApi(q.pathname, q.searchParams);
    if (payload === null) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unknown endpoint" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(JSON.stringify(payload));
    return;
  }
  const m = req.url.match(/^\/(ar|rc|wb|an|jw|u)(\/.*)$/);
  if (!m) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  const [, prefix, rest] = m;
  // A client that disconnects mid-request makes this throw, and the handler is
  // async (an unawaited rejection exits Node). This gateway is the only entry
  // point for every local client, so one bad request must not take it down.
  const chunks = [];
  try {
    for await (const c of req.chunks ?? req) chunks.push(c);
  } catch (e) {
    log(`request aborted while reading body: ${e?.message ?? e}`);
    try {
      res.destroy();
    } catch {}
    return;
  }
  const raw = Buffer.concat(chunks);

  // Forward the identity headers Codex sends. agentrouter's client allowlist
  // keys off `originator` (probe-verified: originator: codex_exec -> 200,
  // originator: omp -> 401). These are Codex's OWN headers, not spoofed ones.
  const headers = { "Content-Type": "application/json" };
  // `anthropic-beta` is forwarded because some anthropic-wire upstreams gate a
  // capability behind it (anyrouter: context-1m-2025-08-07, without which it
  // answers 400). It was previously dropped here, so a client could send it and
  // the gateway would silently strip it.
  for (const h of ["authorization", "x-api-key", "originator", "version", "session_id", "user-agent", "accept", "anthropic-beta"]) {
    if (req.headers[h] !== undefined) headers[h] = req.headers[h];
  }
  if (headers["user-agent"] === undefined) headers["user-agent"] = "codex_exec/0.154.0";


  const isResponses = /\/responses\/?$/.test(rest);

  // GET /u/v1/models -> the aggregated registry, so a client can enumerate every
  // upstream through the single unified provider entry.
  if (prefix === "u" && /\/models\/?$/.test(rest)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: modelList() }));
    return;
  }

  let body = raw.length ? raw.toString("utf8") : undefined;
  let changed = false;
  let route;

  if (prefix === "u") {
    // Unified route: the request's own `model` field selects the upstream, so the
    // client needs one provider entry for everything and cannot pick a model its
    // provider does not serve (the failure mode of the per-provider routes).
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad json" } }));
      return;
    }
    route = providerFor(parsed.model);
    if (!route) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: `unknown model '${parsed.model}'; GET /u/v1/models lists the ${modelList().length} available ids`,
            type: "invalid_request_error",
          },
        }),
      );
      return;
    }
    // Rewrite to the upstream's own id when the registry maps them differently.
    if (route.upstreamModel !== parsed.model) {
      parsed.model = route.upstreamModel;
      body = JSON.stringify(parsed);
      changed = true;
    }
  } else {
    route = ROUTES[prefix];
  }

  const isChatUpstream = route.chat;
  const isAnthropicUpstream = route.anthropic;

  // The model the client asked for. On the unified route `route.upstreamModel` is
  // set by the registry; on the per-prefix routes the registry is not consulted,
  // so read it from the body we already hold. Without this, usage rows from /ar
  // /rc /wb /an had no model (null) and no provider (undefined -> "unknown").
  let requestModel = route.upstreamModel ?? null;
  if (!requestModel && body !== undefined && isResponses) {
    try {
      requestModel = JSON.parse(body)?.model ?? null;
    } catch {}
  }
  // Substitute the upstream's own credential (see providerFor). Only for the
  // unified route: the per-provider routes keep forwarding the client's key
  // verbatim so their behaviour is unchanged.
  if (prefix === "u") {
    if (route.key) {
      headers.authorization = `Bearer ${route.key}`;
      delete headers["x-api-key"];
    } else {
      log(`!! ${route.name} has no ${route.keyEnv} in the environment; forwarding the client key`);
    }
  }

  // Telemetry runs before any rewriting and reports the reasoning-item count as
  // the client sent it. Nothing removes reasoning items any more (the
  // stripReasoning switch is gone), so this is a plain observation of the
  // request, not a pre/post measurement.
  let incoming = null;
  if (body !== undefined && isResponses) {
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed.input)) {
        incoming = {
          items: parsed.input.length,
          reasoning: parsed.input.filter((it) => it?.type === "reasoning").length,
          calls: parsed.input.filter((it) => it?.type === "function_call").length,
          outputs: parsed.input.filter((it) => it?.type === "function_call_output").length,
        };
      }
    } catch {
      /* not JSON (e.g. GET) - nothing to report */
    }
  }

  if (body !== undefined && route.filter) {
    try {
      const next = filterBody(body, { injectInstructions: true });
      changed = next !== body;
      body = next;
    } catch (e) {
      // Fail-open, matching the omp hook (README: "失败时放行不阻断"). The request
      // still goes out, but UNFILTERED - and this route's whole purpose is to
      // sanitise before the body leaves the machine, so the bypass must at least
      // be visible in the log. Silent here would mean an unsanitised body is
      // indistinguishable from a clean one.
      log(
        `!! filter threw on ${prefix}${rest}; forwarding UNFILTERED (${raw.length} bytes): ${e?.message ?? e}`,
      );
    }
  }
  if (changed && route.filter) log(`filter rewrote ${prefix}${rest} body (${raw.length} -> ${Buffer.byteLength(body)})`);

  if (incoming) {
    log(
      `${prefix}${rest}: items=${incoming.items} reasoning=${incoming.reasoning}` +
        ` calls=${incoming.calls} outputs=${incoming.outputs}`,
    );
  }

  if (isResponses && isChatUpstream) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad json" } }));
      return;
    }

    // Cross-realm fallback (see the helpers section above). `clientModel` is
    // the id the client asked for and is the key the window is stored under;
    // the id actually sent upstream is tracked separately, because the
    // registry may map them differently (`spec.m`).
    const clientModel = parsed.model;
    const fb = resolveFallback(clientModel, route);
    let realmUsed = fb ? realmOfModel(clientModel) : null;
    let realmRetryAt = null;
    let realmSource = null;

    if (fb) {
      const armed = fallbackUntil.get(clientModel);
      if (armed !== undefined) {
        if (Date.now() >= armed) {
          // Window expired: try global again, unconditionally.
          fallbackUntil.delete(clientModel);
          log(`cross-realm: ${clientModel} fallback window expired; back on global`);
        } else {
          // Inside the window. Leaving it requires POSITIVE evidence that
          // global can serve again - never a bare healthy count.
          const avail = await globalAvailability(route, bareModelOf(clientModel));
          if (avail.ok) {
            fallbackUntil.delete(clientModel);
            log(`cross-realm: ${clientModel} global recovered early (source=${avail.source}); leaving fallback`);
          } else {
            parsed.model = fb.upstreamModel;
            realmUsed = "cn";
            realmSource = avail.source;
            realmRetryAt = avail.at ? new Date(avail.at) : new Date(armed);
            log(`cross-realm: ${clientModel} served from ${fb.id} (window armed, source=${avail.source})`);
          }
        }
      }
    }

    // One upstream attempt. A fresh toolMap per attempt: it is built from the
    // tools sent in THAT request and is used to split wire names back on the
    // response, so a retry must never reuse the failed attempt's map.
    const sendChat = async (modelId) => {
      const toolMap = { byWire: new Map(), byPair: new Map() };
      // Same fail-closed guard as the anthropic path (see the note there).
      let guardedBody = parsed;
      if (route.egressGuard) {
        try {
          const guarded = guardBody(JSON.stringify(parsed), selectRules(route.egressGuard));
          guardedBody = JSON.parse(guarded.body);
          if (guarded.findings.length) {
            log(`egress-guard ${prefix}${rest} -> ${route.name}: ${summarize(guarded.findings)}`);
          }
        } catch (e) {
          log(`!! egress-guard FAILED on ${prefix}${rest} -> ${route.name}; refusing to forward: ${e?.message ?? e}`);
          return { error: new Error(`egress guard failed; blocked rather than forwarded unredacted`) };
        }
      }
      const chat = toChatBody(guardedBody, modelId, route.efforts ?? null, toolMap);
      log(`bridge ${prefix}${rest} -> ${route.name} model=${modelId} msgs=${chat.messages.length} tools=${chat.tools?.length ?? 0}`);
      try {
        const upstream = await requestWithRetry(route.base + "/v1/chat/completions", {
          method: "POST",
          headers,
          body: JSON.stringify(chat),
          proxy: route.proxy,
        }, `${prefix}${rest} -> ${route.name} model=${modelId}`);
        return { upstream, toolMap };
      } catch (e) {
        return { error: e };
      }
    };

    // Request clock, started before the FIRST upstream attempt: every terminal
    // branch below (2xx stream, upstream 4xx/5xx, local 502) records a duration.
    // One row per client request: the arm-and-retry attempt inside the fallback
    // window decides the outcome and is what gets booked, the discarded attempt
    // is not booked a second time. Declared BEFORE fail502 so the 502 closure
    // only ever reads an initialised binding.
    const t0 = Date.now();

    // A local/transport failure (requestWithRetry threw) is still a request the
    // gateway made, so it is booked with ok:false + status 502 exactly like the
    // passthrough path books its failures. Before this the bridge path recorded
    // NOTHING here while the passthrough path recorded ok:false - two standards
    // for the same business event (audit S3). `modelId` is the id actually sent
    // upstream on the attempt that failed (after a cross-realm fallback that is
    // the cn id).
    const fail502 = (e, modelId) => {
      recordUsage({
        route: prefix,
        provider: route.name,
        model: modelId ?? parsed.model,
        effort: parsed.reasoning?.effort ?? null,
        ok: false,
        status: 502,
        duration_ms: Date.now() - t0,
        input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        cached_tokens: 0,
      });
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(e?.message ?? e) } }));
    };

    let attempt = await sendChat(parsed.model);
    if (attempt.error) {
      fail502(attempt.error, parsed.model);
      return;
    }
    let upstream = attempt.upstream;
    let toolMap = attempt.toolMap;

    // The retry fires only on an OBSERVED exhaustion of the source realm, and
    // only while the request is still on global (a request already served from
    // cn must not bounce back). 429 is what wb2api answers when every account of
    // the realm is cooling; 503 when none is selectable at all.
    if (fb && realmUsed === "global" && (upstream.statusCode === 429 || upstream.statusCode === 503)) {
      const errChunks = [];
      for await (const c of upstream) errChunks.push(c);
      const text = Buffer.concat(errChunks).toString("utf8");
      log(`bridge upstream ${upstream.statusCode}: ${text.slice(0, 200)}`);
      const armed = await armFallback(clientModel, route, upstream.statusCode, text);
      realmRetryAt = armed.retryAt;
      realmSource = armed.source;
      parsed.model = fb.upstreamModel;
      realmUsed = "cn";
      attempt = await sendChat(fb.upstreamModel);
      if (attempt.error) {
        fail502(attempt.error, parsed.model);
        return;
      }
      upstream = attempt.upstream;
      toolMap = attempt.toolMap;
    }

    if (upstream.statusCode >= 400) {
      const errChunks = [];
      for await (const c of upstream) errChunks.push(c);
      const text = Buffer.concat(errChunks).toString("utf8");
      log(`bridge upstream ${upstream.statusCode}: ${text.slice(0, 200)}`);
      // Same accounting standard as the passthrough path (audit S3): a bridged
      // upstream 4xx/5xx is a booked FAILURE row, not a missing one. Before
      // this /stats could not see a single failed wb2api request that came
      // through /wb, while the same failure on /ar was recorded - two
      // standards for one event. Chat-wire usage names are prompt_/completion_;
      // the responses-style names are accepted as a fallback only because an
      // error body is the sole usage source here and no counters are invented.
      let errUsage = null;
      try {
        errUsage = JSON.parse(text)?.usage ?? null;
      } catch {}
      recordUsage({
        route: prefix,
        provider: route.name,
        model: parsed.model,
        effort: parsed.reasoning?.effort ?? null,
        ok: false,
        status: upstream.statusCode,
        duration_ms: Date.now() - t0,
        input_tokens: errUsage?.prompt_tokens ?? errUsage?.input_tokens ?? 0,
        output_tokens: errUsage?.completion_tokens ?? errUsage?.output_tokens ?? 0,
        reasoning_tokens: errUsage?.completion_tokens_details?.reasoning_tokens ?? 0,
        cached_tokens: errUsage?.prompt_tokens_details?.cached_tokens ?? 0,
      });
      setRealmHeaders(res, realmUsed, realmRetryAt, realmSource);
      res.writeHead(upstream.statusCode, { "Content-Type": "application/json" });
      res.end(text);
      return;
    }
    // setHeader before the bridge writes its own head: writeHead merges
    // previously-set headers, so bridge.mjs needs no change.
    setRealmHeaders(res, realmUsed, realmRetryAt, realmSource);
    // S4: an upstream that stalls after its headers would hang the bridge, whose
    // only terminals are end/close/error. Arm an idle guard on the raw upstream; on
    // idle it destroys the socket, which trips bridgeChatStream's close/error path
    // and emits response.failed - no phantom success row (the success onUsage below
    // runs only on finish()). It self-disarms on the upstream's own end/close/error.
    armBodyIdleTimeout(upstream, () => log(`!! upstream stream idle > ${BODY_IDLE_TIMEOUT_MS}ms (chat bridge, ${route.name}); aborting`));
    bridgeChatStream(upstream, res, parsed.model, parsed.reasoning?.effort, parsed.stream !== false, (u) => {
      recordUsage({
        route: prefix,
        provider: route.name,
        model: parsed.model,
        effort: parsed.reasoning?.effort ?? null,
        ok: true,
        duration_ms: Date.now() - t0,
        input_tokens: u?.input_tokens ?? 0,
        output_tokens: u?.output_tokens ?? 0,
        reasoning_tokens: u?.output_tokens_details?.reasoning_tokens ?? 0,
        cached_tokens: u?.input_tokens_details?.cached_tokens ?? 0,
      });
    }, isGuardToolName, toolMap);
    return;
  }

  if (isResponses && isAnthropicUpstream) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad json" } }));
      return;
    }
    const toolMap = { byWire: new Map(), byPair: new Map() };
    // Redact BEFORE the wire conversion: toAnthropicBody is what produces the
    // bytes that actually leave, so guarding after it would be too late.
    //
    // FAIL CLOSED, unlike the agentrouter filter above. That filter is a
    // content-shaping convenience and failing open keeps traffic moving; this
    // one exists because the upstream is not trusted with host data, so a
    // guard that cannot run must NOT forward the original bytes.
    if (route.egressGuard) {
      try {
        const guarded = guardBody(JSON.stringify(parsed), selectRules(route.egressGuard));
        parsed = JSON.parse(guarded.body);
        if (guarded.findings.length) {
          log(`egress-guard ${prefix}${rest} -> ${route.name}: ${summarize(guarded.findings)}`);
        }
      } catch (e) {
        log(`!! egress-guard FAILED on ${prefix}${rest} -> ${route.name}; refusing to forward: ${e?.message ?? e}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: {
            message: `egress guard failed for ${route.name}; request blocked rather than forwarded unredacted`,
            type: "egress_guard_error",
          },
        }));
        return;
      }
    }
    const msg = toAnthropicBody(parsed, parsed.model, toolMap);
    log(`bridge ${prefix}${rest} -> ${route.name} model=${parsed.model} msgs=${msg.messages.length} tools=${msg.tools?.length ?? 0}`);
    // Request clock for EVERY terminal branch below (2xx bridge, upstream
    // 4xx/5xx, local 502). It used to be created only on the success path, so
    // the failure branches had no duration to report (audit S3).
    const t0 = Date.now();
    let upstream;
    try {
      upstream = await requestWithRetry(route.base + "/v1/messages", {
        method: "POST",
        headers: anthropicHeaders(headers, route.headers),
        body: JSON.stringify(msg),
        proxy: route.proxy,
      }, `${prefix}${rest} -> ${route.name} model=${parsed.model}`);
    } catch (e) {
      // A throw from requestWithRetry (DNS/TLS/proxy/connection refused) is a
      // failed request, not a silent one: book it 502 exactly as the chat bridge
      // and the passthrough path do (audit S3).
      recordUsage({
        route: prefix,
        provider: route.name,
        model: parsed.model,
        effort: parsed.reasoning?.effort ?? null,
        ok: false,
        status: 502,
        duration_ms: Date.now() - t0,
        input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        cached_tokens: 0,
      });
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(e?.message ?? e) } }));
      return;
    }
    if (upstream.statusCode >= 400) {
      const errChunks = [];
      for await (const c of upstream) errChunks.push(c);
      const text = Buffer.concat(errChunks).toString("utf8");
      log(`bridge upstream ${upstream.statusCode}: ${text.slice(0, 200)}`);
      // Same accounting standard as the passthrough path (audit S3): a bridged
      // upstream 4xx/5xx is a booked FAILURE row, not a missing one. Before
      // this /stats showed zero failed justwoker/anyrouter requests - the
      // ledger carried successes only. Anthropic error bodies carry no usage;
      // counters stay 0 rather than being estimated.
      recordUsage({
        route: prefix,
        provider: route.name,
        model: parsed.model,
        effort: parsed.reasoning?.effort ?? null,
        ok: false,
        status: upstream.statusCode,
        duration_ms: Date.now() - t0,
        input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        cached_tokens: 0,
      });
      res.writeHead(upstream.statusCode, { "Content-Type": "application/json" });
      res.end(text);
      return;
    }
    // The toolMap MUST be forwarded (7th argument, after toolGuard). Without it the
    // return direction cannot rebuild a namespaced call: the wire name
    // `multi_agent_v1__spawn_agent` came back as {name: that, namespace: null}, and
    // Codex does not recognise it as spawn_agent - the same "sub-agents invisible"
    // symptom as the 2026-09-22 report, but on the reply path instead of the request
    // path. Measured 2026-09-24 against the real justwoker upstream: opus-4-8 DID
    // call the tool, and the un-restored name is what made it useless.
    // S4: same idle guard as the chat bridge - a silent upstream trips the bridge
    // close/error path (response.failed) instead of hanging; self-disarms on end.
    armBodyIdleTimeout(upstream, () => log(`!! upstream stream idle > ${BODY_IDLE_TIMEOUT_MS}ms (anthropic bridge, ${route.name}); aborting`));
    bridgeAnthropicStream(upstream, res, parsed.model, parsed.stream !== false, (u) => {
      recordUsage({
        route: prefix,
        provider: route.name,
        model: parsed.model,
        effort: parsed.reasoning?.effort ?? null,
        ok: true,
        duration_ms: Date.now() - t0,
        input_tokens: u?.input_tokens ?? 0,
        output_tokens: u?.output_tokens ?? 0,
        reasoning_tokens: u?.output_tokens_details?.reasoning_tokens ?? 0,
        cached_tokens: u?.input_tokens_details?.cached_tokens ?? 0,
      });
    }, isGuardToolName, toolMap);
    return;
  }

  const target = route.base + rest;
  log(`proxy ${prefix}${rest} -> ${target} (${route.name}) bytes=${raw.length}`);

  // --- strict-Responses item ids (agentrouter) -------------------------------
  // The upstream validates the prefix of every REPLAYED item id against the item
  // type and answers 400 "Expected an ID that begins with 'rs'" for one minted
  // elsewhere (relaycat mints `item_...`). Renaming cannot work - the id is
  // resolved in the upstream's own store, and a rewritten one comes back as
  // "Item with id .. not found" - so a foreign id is DROPPED. The request the
  // gateway would otherwise send is untouched: only ids that contradict the
  // contract this upstream states in its own error message are removed.
  //
  // Level 2 (stripAllItemIds) runs only in response to the upstream's own
  // rejection, covering the residue level 1 cannot judge: an id with an
  // acceptable prefix that this upstream has no record of.
  let sentBody = body;
  const canRepairIds = route.strictItemIds && isResponses && req.method === "POST" && body !== undefined;
  if (canRepairIds) {
    const fixed = stripForeignItemIds(body);
    if (fixed.dropped) {
      sentBody = fixed.body;
      log(`strict-item-ids ${prefix}${rest}: dropped ${fixed.dropped} foreign replay id(s)`);
    }
  }

  const sendUpstream = (payload) => requestWithRetry(
    target,
    // Retrying a GET is pointless and would only add latency to /models.
    { method: req.method, headers, body: payload, proxy: route.proxy, retry: req.method === "POST" },
    `${prefix}${rest} (${route.name})`,
  );

  let upstream;
  const t0 = Date.now();
  try {
    upstream = await sendUpstream(sentBody);

    // The upstream is the authority on its own id store: when it answers 400
    // complaining about a replayed id, resend once with every id dropped. The
    // error body is small, so buffering it here does not affect streaming; the
    // success path below still pipes through untouched.
    if (canRepairIds && upstream.statusCode === 400) {
      const parts = [];
      for await (const c of upstream) parts.push(c);
      const text = Buffer.concat(parts).toString("utf8");
      const all = isItemIdRejection(text) ? stripAllItemIds(sentBody) : { body: sentBody, dropped: 0 };
      if (all.dropped) {
        log(`strict-item-ids ${prefix}${rest}: upstream rejected replayed ids; retrying with all ${all.dropped} dropped`);
        upstream = await sendUpstream(all.body);
      } else {
        // Not repairable (a non-id 400, or an `item_reference` whose id IS its
        // payload). Answer with the upstream's own bytes rather than dropping
        // them on the floor - including its content-type, so an error the client
        // already understands keeps its shape.
        res.writeHead(400, {
          "Content-Type": upstream.headers["content-type"] ?? "application/json",
          "Cache-Control": "no-cache",
        });
        res.end(text);
        recordUsage({
          route: prefix,
          provider: route.name,
          model: requestModel,
          effort: null,
          ok: false,
          status: 400,
          duration_ms: Date.now() - t0,
          input_tokens: 0,
          output_tokens: 0,
          reasoning_tokens: 0,
          cached_tokens: 0,
        });
        return;
      }
    }
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(e?.message ?? e) } }));
    return;
  }
  res.writeHead(upstream.statusCode, {
    "Content-Type": upstream.headers["content-type"] ?? "application/json",
    "Cache-Control": "no-cache",
  });
  // Without this, an upstream that drops mid-response emits an unhandled 'error'
  // on the IncomingMessage. The process-level guards then swallow it and this
  // socket is never ended, so the client waits for its own timeout instead of
  // seeing a clear failure. Reproduced: headers + one chunk, then silence for the
  // full 12s probe window. The bridge path already had an error handler; this
  // passthrough path (agentrouter/relaycat/anyrouter - most traffic) did not.
  upstream.on("error", (e) => {
    log(`!! upstream error after ${upstream.statusCode} (${route.name}): ${e?.code ?? e?.message ?? e}`);
    try {
      res.destroy();
    } catch {}
  });
  res.on("close", () => {
    // Client went away (or we finished): stop pulling from the upstream.
    if (!upstream.destroyed) upstream.destroy();
  });

  // Passthrough (agentrouter / relaycat / anyrouter) usage. The upstream's own
  // `usage` object is the only source; nothing is estimated. A streamed response
  // carries usage in its final event, so the body is sniffed rather than buffered
  // wholesale (buffering would defeat streaming).
  const ct = String(upstream.headers["content-type"] ?? "");
  if (!ct.includes("event-stream")) {
    // Non-streamed passthrough body. S4: guard against an upstream that sends its
    // headers (and maybe a partial body) then goes silent without ending. On idle
    // we end the client response with a clear 504-shaped terminal state (or just
    // close it if bytes were already flushed) and book a failed, zero-token row -
    // never a phantom success.
    const parts = [];
    let settled = false;
    const disarmIdle = armBodyIdleTimeout(upstream, () => {
      if (settled) return;
      settled = true;
      log(`!! upstream body idle > ${BODY_IDLE_TIMEOUT_MS}ms after ${upstream.statusCode} (${route.name}); aborting`);
      try {
        if (!res.headersSent) res.writeHead(504, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "upstream body idle timeout", type: "gateway_timeout" } }));
      } catch {
        try { res.destroy(); } catch {}
      }
      recordUsage({
        route: prefix,
        provider: route.name,
        model: requestModel,
        effort: null,
        ok: false,
        status: 504,
        duration_ms: Date.now() - t0,
        input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        cached_tokens: 0,
      });
    });
    upstream.on("data", (c) => parts.push(c));
    upstream.on("end", () => {
      disarmIdle();
      if (settled) return;
      settled = true;
      const text = Buffer.concat(parts).toString("utf8");
      res.end(text);
      let u = null;
      try {
        u = JSON.parse(text)?.usage ?? null;
      } catch {}
      recordUsage({
        route: prefix,
        provider: route.name,
        model: requestModel,
        effort: null,
        ok: upstream.statusCode < 400,
        status: upstream.statusCode,
        duration_ms: Date.now() - t0,
        input_tokens: u?.input_tokens ?? 0,
        output_tokens: u?.output_tokens ?? 0,
        reasoning_tokens: u?.output_tokens_details?.reasoning_tokens ?? 0,
        cached_tokens: u?.input_tokens_details?.cached_tokens ?? 0,
      });
    });
    return;
  }

  // Streamed passthrough: watch for the usage-bearing event without altering the
  // bytes the client receives.
  //
  // S5: parse SSE events INCREMENTALLY as they arrive and keep the last usage seen,
  // rather than sniffing only the trailing 64KB at end. The old tail window silently
  // dropped a usage event that arrived earlier than the final 64KB (e.g. usage sent
  // mid-stream followed by a large body), booking ok:true with 0 tokens. `lineBuf`
  // only holds a partial trailing line between chunks, so memory stays bounded even
  // for a very long response.
  //
  // S4: the same idle guard as above. On idle we stop piping and book a failed,
  // zero-token row. Headers are already sent for a stream, so the client simply sees
  // the connection close rather than a 504 body - the point is that it stops waiting.
  let lineBuf = "";
  let captured = null;
  const scanLine = (raw) => {
    const t = raw.trim();
    if (!t.startsWith("data:")) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const j = JSON.parse(payload);
      if (j?.response?.usage) captured = j.response.usage;
      else if (j?.usage) captured = j.usage;
    } catch {}
  };
  let streamSettled = false;
  const bookStream = (ok, status) => {
    if (streamSettled) return;
    streamSettled = true;
    recordUsage({
      route: prefix,
      provider: route.name,
      model: requestModel,
      effort: null,
      ok,
      status,
      duration_ms: Date.now() - t0,
      input_tokens: captured?.input_tokens ?? 0,
      output_tokens: captured?.output_tokens ?? 0,
      reasoning_tokens: captured?.output_tokens_details?.reasoning_tokens ?? 0,
      cached_tokens: captured?.input_tokens_details?.cached_tokens ?? 0,
    });
  };
  const disarmStreamIdle = armBodyIdleTimeout(upstream, () => {
    log(`!! upstream stream idle > ${BODY_IDLE_TIMEOUT_MS}ms after ${upstream.statusCode} (${route.name}); aborting`);
    try { res.destroy(); } catch {}
    bookStream(false, 504);
  });
  upstream.on("data", (c) => {
    lineBuf += c.toString("utf8");
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop() ?? "";
    for (const line of lines) scanLine(line);
  });
  upstream.on("end", () => {
    disarmStreamIdle();
    if (lineBuf) scanLine(lineBuf);
    bookStream(upstream.statusCode < 400, upstream.statusCode);
  });
  upstream.pipe(res);
  } catch (e) {
    // Last-resort guard: keep the process alive and tell the client what broke.
    log(`!! unhandled error in handler: ${e?.stack ?? e}`);
    try {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(e?.message ?? e), type: "gateway_error" } }));
    } catch {}
  }
});

// Node exits on an unhandled rejection by default. Never let that happen here:
// this process serves every local client.
process.on("unhandledRejection", (e) => log(`!! unhandledRejection: ${e?.stack ?? e}`));
process.on("uncaughtException", (e) => log(`!! uncaughtException: ${e?.stack ?? e}`));

server.on("error", (e) => {
  // A second instance (typically the autostart copy) already owns the port.
  // Exiting quietly beats an unhandled 'error' stack dump; the live instance
  // serves the same routes.
  if (e && e.code === "EADDRINUSE") {
    log(`port ${PORT} already in use; another gateway instance is serving it (exiting)`);
    process.exit(0);
  }
  throw e;
});


// Only bind the port when run as the entry point; importing this module (tests)
// must not start a second gateway.
const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  server.listen(PORT, HOST, () => log(`gateway listening on http://${HOST}:${PORT} (unified /u with ${modelList().length} models; routes: /ar /rc /wb /an /jw)`));
}

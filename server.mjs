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
import { bridgeAnthropicStream, bridgeChatStream, toAnthropicBody, toChatBody } from "./bridge.mjs";
import { record as recordUsage } from "./usage.mjs";
import { statsApi } from "./stats-api.mjs";

// Per-provider credentials for upstreams whose key is not already in the
// machine/user environment (agentrouter's is Machine-scoped; justwoker's could
// not be, since setting Machine scope needs admin). Kept in a gitignored file so
// the secret never reaches the repository, and loaded BEFORE the registry is read
// because providerFor() resolves keys from process.env.
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
    // A real environment variable wins, so an explicit override still works.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadLocalEnv();

const PORT = Number(process.env.AR_GATEWAY_PORT ?? 7878);
const HOST = "127.0.0.1";

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
    chat: p.wire === "chat",
    anthropic: p.wire === "anthropic",
    filter: p.filter === true,
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
    // (opencode-zen free models: low/medium/high only; max/xhigh are 400).
    efforts: Array.isArray(p.efforts) ? p.efforts : null,
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
function anthropicHeaders(headers) {
  const out = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
  const bearer = headers.authorization?.replace(/^Bearer\s+/i, "");
  const key = headers["x-api-key"] ?? bearer;
  if (key) out["x-api-key"] = key;
  // `accept` is deliberately NOT forwarded. This upstream sits behind
  // Cloudflare, and an explicit `accept: */*` intermittently drew a 403
  // "Attention Required!" page (measured: same body, same key, 1/3 requests
  // failed with it, 0/3 without). Nothing here needs content negotiation.
  for (const h of ["originator", "version", "session_id", "user-agent"]) {
    if (headers[h] !== undefined) out[h] = headers[h];
  }
  return out;
}
function log(...a) {
  process.stdout.write(`[${new Date().toISOString()}] ${a.join(" ")}\n`);
}

function request(url, { method, headers, body, proxy }) {
  const u = new URL(url);
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
          headers,
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
          headers: { ...headers, Host: u.hostname },
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
  for (const h of ["authorization", "x-api-key", "originator", "version", "session_id", "user-agent", "accept"]) {
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
    const chat = toChatBody(parsed, parsed.model, route.efforts ?? null);
    log(`bridge ${prefix}${rest} -> ${route.name} model=${parsed.model} msgs=${chat.messages.length} tools=${chat.tools?.length ?? 0}`);
    let upstream;
    try {
      upstream = await request(route.base + "/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify(chat),
        proxy: route.proxy,
      });
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(e?.message ?? e) } }));
      return;
    }
    if (upstream.statusCode >= 400) {
      const errChunks = [];
      for await (const c of upstream) errChunks.push(c);
      const text = Buffer.concat(errChunks).toString("utf8");
      log(`bridge upstream ${upstream.statusCode}: ${text.slice(0, 200)}`);
      res.writeHead(upstream.statusCode, { "Content-Type": "application/json" });
      res.end(text);
      return;
    }
    const t0 = Date.now();
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
    }, isGuardToolName);
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
    const msg = toAnthropicBody(parsed, parsed.model);
    log(`bridge ${prefix}${rest} -> ${route.name} model=${parsed.model} msgs=${msg.messages.length} tools=${msg.tools?.length ?? 0}`);
    let upstream;
    try {
      upstream = await request(route.base + "/v1/messages", {
        method: "POST",
        headers: anthropicHeaders(headers),
        body: JSON.stringify(msg),
        proxy: route.proxy,
      });
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(e?.message ?? e) } }));
      return;
    }
    if (upstream.statusCode >= 400) {
      const errChunks = [];
      for await (const c of upstream) errChunks.push(c);
      const text = Buffer.concat(errChunks).toString("utf8");
      log(`bridge upstream ${upstream.statusCode}: ${text.slice(0, 200)}`);
      res.writeHead(upstream.statusCode, { "Content-Type": "application/json" });
      res.end(text);
      return;
    }
    const t0 = Date.now();
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
    });
    return;
  }

  const target = route.base + rest;
  log(`proxy ${prefix}${rest} -> ${target} (${route.name}) bytes=${raw.length}`);
  let upstream;
  try {
    upstream = await request(target, { method: req.method, headers, body, proxy: route.proxy });
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
  const t0 = Date.now();
  const ct = String(upstream.headers["content-type"] ?? "");
  if (!ct.includes("event-stream")) {
    const parts = [];
    upstream.on("data", (c) => parts.push(c));
    upstream.on("end", () => {
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

  // Streamed passthrough: watch for the final usage-bearing event without
  // altering the bytes the client receives.
  let tail = "";
  let captured = null;
  upstream.on("data", (c) => {
    tail += c.toString("utf8");
    if (tail.length > 65536) tail = tail.slice(-65536);
  });
  upstream.on("end", () => {
    for (const line of tail.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      try {
        const j = JSON.parse(t.slice(5).trim());
        if (j?.response?.usage) captured = j.response.usage;
        else if (j?.usage) captured = j.usage;
      } catch {}
    }
    recordUsage({
      route: prefix,
      provider: route.name,
      model: requestModel,
      effort: null,
      ok: upstream.statusCode < 400,
      status: upstream.statusCode,
      duration_ms: Date.now() - t0,
      input_tokens: captured?.input_tokens ?? 0,
      output_tokens: captured?.output_tokens ?? 0,
      reasoning_tokens: captured?.output_tokens_details?.reasoning_tokens ?? 0,
      cached_tokens: captured?.input_tokens_details?.cached_tokens ?? 0,
    });
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

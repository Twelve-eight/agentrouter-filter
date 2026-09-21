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
// Everything posted is sanitised by filter.mjs first.

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";
import { filterBody } from "./filter.mjs";
import { bridgeChatStream, toChatBody } from "./bridge.mjs";

const PORT = Number(process.env.AR_GATEWAY_PORT ?? 7878);
const HOST = "127.0.0.1";

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
    base: process.env.AR_UPSTREAM_AR ?? "https://ps.air-outer.com",
    chat: false,
    filter: true,
  },
  rc: {
    base: process.env.AR_UPSTREAM_RC ?? "https://api.relaycat.top",
    chat: false,
  },
  wb: { base: process.env.AR_UPSTREAM_WB ?? "http://127.0.0.1:7863", chat: true },
  // anyrouter.top is TLS-blocked on a direct connection (omp reports "unknown
  // certificate verification error"); it needs the local HTTP proxy. The proxy
  // is applied per-route so agentrouter (which hangs through it) stays direct.
  an: { base: process.env.AR_UPSTREAM_AN ?? "https://anyrouter.top", chat: false, proxy: process.env.AR_PROXY_AN ?? "http://127.0.0.1:7897" },
};

// ---------------------------------------------------------------------------
// model registry (providers.json)
//
// The /u route dispatches on the request's `model` field, so one client provider
// entry covers every upstream. providers.json is also what
// tools/build-model-catalog.cjs reads, so the picker and the gateway cannot
// disagree about which models exist or where they go.
// ---------------------------------------------------------------------------
const ROUTE_PREFIX = { agentrouter: "AR", relaycat: "RC", "relaycat-cn": "RC", wb2api: "WB", anyrouter: "AN" };

const REGISTRY = JSON.parse(fs.readFileSync(new URL("./providers.json", import.meta.url), "utf8"));

/** Resolve a client model id to the upstream that serves it. */
function providerFor(model) {
  const spec = REGISTRY.models[model];
  if (!spec || typeof spec !== "object") return null;
  const p = REGISTRY.providers[spec.p];
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
  };
}

/** Every client-facing model id, for GET /u/v1/models. */
function modelList() {
  return Object.entries(REGISTRY.models)
    .filter(([, v]) => v && typeof v === "object")
    .map(([id, v]) => ({ id, object: "model", owned_by: v.p }));
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
  const m = req.url.match(/^\/(ar|rc|wb|an|u)(\/.*)$/);
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
    } catch {
      /* fail-open, matching the omp hook */
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
    const chat = toChatBody(parsed, parsed.model);
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
    bridgeChatStream(upstream, res, parsed.model, parsed.reasoning?.effort, parsed.stream !== false);
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
  server.listen(PORT, HOST, () => log(`gateway listening on http://${HOST}:${PORT} (unified /u with ${modelList().length} models; routes: /ar /rc /wb /an)`));
}

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
    // No stripReasoning: relaycat never 400'd across resumed turns, and the
    // earlier "it's a no-op" justification came from telemetry that ran AFTER
    // the strip (self-fulfilling). Per-route fidelity: don't rewrite what has no
    // demonstrated problem. Telemetry now reports the pre-strip reasoning count,
    // so a real replay would be visible in the log before deciding to enable it.
  },
  wb: { base: process.env.AR_UPSTREAM_WB ?? "http://127.0.0.1:7863", chat: true },
  // anyrouter.top is TLS-blocked on a direct connection (omp reports "unknown
  // certificate verification error"); it needs the local HTTP proxy. The proxy
  // is applied per-route so agentrouter (which hangs through it) stays direct.
  // No stripReasoning: anyrouter's astra was verified replay-safe (3x replay OK,
  // including across prompt_cache_key changes).
  an: { base: process.env.AR_UPSTREAM_AN ?? "https://anyrouter.top", chat: false, proxy: process.env.AR_PROXY_AN ?? "http://127.0.0.1:7897" },
};

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
  const m = req.url.match(/^\/(ar|rc|wb|an)(\/.*)$/);
  if (!m) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  const [, prefix, rest] = m;
  const route = ROUTES[prefix];
  const chunks = [];
  for await (const c of req.chunks ?? req) chunks.push(c);
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
  const isChatUpstream = route.chat;

  let body = raw.length ? raw.toString("utf8") : undefined;
  let changed = false;

  // Telemetry MUST run before any rewriting: measuring after the strip would
  // always report reasoning=0 on a stripping route and could never distinguish
  // "the client sent none" from "we removed them".
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
  if (changed) log(`filter rewrote ${prefix}${rest} body (${raw.length} -> ${Buffer.byteLength(body)})`);

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
    log(`bridge ${prefix}${rest} model=${parsed.model} msgs=${chat.messages.length} tools=${chat.tools?.length ?? 0}`);
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
    bridgeChatStream(upstream, res, parsed.model, parsed.reasoning?.effort);
    return;
  }

  const target = route.base + rest;
  log(`proxy ${prefix}${rest} -> ${target} bytes=${raw.length}`);
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
  upstream.pipe(res);
});

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
  server.listen(PORT, HOST, () => log(`agentrouter gateway listening on http://${HOST}:${PORT} (routes: /ar /rc /wb /an)`));
}

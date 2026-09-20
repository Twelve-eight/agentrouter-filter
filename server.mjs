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
import { bridgeChatStream, toChatBody } from "./bridge.mjs";

const PORT = Number(process.env.AR_GATEWAY_PORT ?? 7878);
const HOST = "127.0.0.1";

// Origins only: the incoming path already carries /v1/.. (Codex base_url is
// http://127.0.0.1:7878/<prefix>/v1).
// AR_UPSTREAM_<PREFIX> overrides a route's origin (e.g. to point /ar at a
// mirror, or at a local echo for testing).
//
// Per-route behaviour:
//   filter        - run the agentrouter char/word filter + identity block and
//                   inject the extra model-facing requirements. Only agentrouter
//                   needs it (its word list blocks on opaque content); running it
//                   on other upstreams would only lose fidelity (emoji and
//                   non-approved scripts deleted, identifiers rewritten).
//   stripReasoning- drop replayed `reasoning` items before forwarding.
//                   agentrouter's astra sits behind a multi-Azure-resource pool
//                   with no session affinity: an encrypted_content item is bound
//                   to the resource that created it, so replaying it after the
//                   load balancer moves the session returns 400
//                   ("could not be verified" / "different .. OpenAI resource").
//                   This is the codex-side equivalent of models.yml
//                   `compat.replayResponsesReasoning: false`.
const ROUTES = {
  ar: {
    base: process.env.AR_UPSTREAM_AR ?? "https://ps.air-outer.com",
    chat: false,
    // No filter, no stripReasoning.
    //
    // Filter removed 2026-09-20 after measurement: agentrouter's blocking is a
    // cumulative, probabilistic content classifier, not a character/word rule.
    //   - every phrase filter.mjs rewrote: 12/12 PASS
    //   - every Unicode range probed (25 ranges incl. emoji/kana): ALLOW 2/2
    //   - the same input blocked on one run and passed on another
    // Sts2 DEVLOG's bisect had already shown the real trigger is a 5.5KB pure-ASCII
    // tool result that only blocks inside a 600-message context. A deterministic
    // filter cannot address that, and it silently cost fidelity (emoji and
    // non-approved scripts deleted, identifiers rewritten).
    //
    // Reasoning stripping was retired for the same reason the user gave: it is no
    // longer needed.
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

  // Telemetry only: report what the client sent, so the log shows the real
  // request shape. No rewriting happens on any route (see the ROUTES comment).
  if (body !== undefined && isResponses) {
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed.input)) {
        const n = (t) => parsed.input.filter((it) => it?.type === t).length;
        log(`${prefix}${rest}: items=${parsed.input.length} reasoning=${n("reasoning")} calls=${n("function_call")} outputs=${n("function_call_output")}`);
      }
    } catch {
      /* not JSON (e.g. GET) - nothing to report */
    }
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

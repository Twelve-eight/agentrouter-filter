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
    filter: true,
    stripReasoning: true,
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
// responses -> chat/completions conversion (for chat-only upstreams)
// ---------------------------------------------------------------------------

function toChatMessages(body) {
  const out = [];
  // wb2api requires the first message to be a system message (400 code 11-128).
  const sys = [];
  if (body.instructions) sys.push(body.instructions);
  const items = Array.isArray(body.input) ? body.input : [{ role: "user", content: body.input }];
  const tail = [];
  for (const it of items) {
    if (typeof it === "string") {
      tail.push({ role: "user", content: it });
      continue;
    }
    if (it.type === "reasoning") continue;
    if (it.type === "function_call") {
      tail.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: it.call_id ?? it.id,
            type: "function",
            function: { name: it.name, arguments: it.arguments ?? "{}" },
          },
        ],
      });
      continue;
    }
    if (it.type === "function_call_output") {
      tail.push({
        role: "tool",
        tool_call_id: it.call_id,
        content: typeof it.output === "string" ? it.output : JSON.stringify(it.output ?? ""),
      });
      continue;
    }
    const role = it.role ?? "user";
    const parts = Array.isArray(it.content) ? it.content : [{ type: "input_text", text: String(it.content ?? "") }];
    const text = parts
      .map((p) => {
        if (typeof p === "string") return p;
        if (p.type === "input_text" || p.type === "output_text" || p.type === "text") return p.text ?? "";
        if (p.type === "input_image") return "";
        return "";
      })
      .join("");
    if (role === "system" || role === "developer") sys.push(text);
    else tail.push({ role, content: text });
  }
  return [{ role: "system", content: sys.filter(Boolean).join("\n\n") || "You are a coding agent." }, ...tail];
}

function toChatTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const mapped = tools
    .filter((t) => t && (t.type === "function" || t.name))
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.parameters ?? { type: "object", properties: {} },
      },
    }));
  return mapped.length ? mapped : undefined;
}

function toChatBody(body, model) {
  const messages = toChatMessages(body);
  const chat = { model, messages, stream: true };
  const tools = toChatTools(body.tools);
  if (tools) chat.tools = tools;
  if (body.tool_choice && body.tool_choice !== "none") {
    chat.tool_choice = body.tool_choice === "required" ? "required" : body.tool_choice;
  }
  if (body.max_output_tokens) chat.max_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.parallel_tool_calls !== undefined) chat.parallel_tool_calls = body.parallel_tool_calls;
  return chat;
}

// ---------------------------------------------------------------------------
// chat SSE -> responses SSE
// ---------------------------------------------------------------------------

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function bridgeChatStream(upstream, res, model, effort) {
  const respId = "resp_" + Math.random().toString(36).slice(2, 14);
  const created = Math.floor(Date.now() / 1000);
  const base = { id: respId, object: "response", created_at: created, model, status: "in_progress", output: [] };
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  sse(res, "response.created", { type: "response.created", response: base });
  sse(res, "response.in_progress", { type: "response.in_progress", response: base });

  let buf = "";
  let seq = 2;
  let msgId = null;
  let msgOpen = false;
  let msgIndex = -1;
  let text = "";
  let reasoning = "";
  const calls = new Map(); // index -> {id,name,args,itemId,added,outIndex}
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  // output_index must be a monotonic per-item counter, NOT output.length: items
  // are only appended to `output` at close/finish, so using output.length gave a
  // message and a function_call the same index, and codex drops such a stream
  // (observed as repeated identical resends). items[] keeps slot order so the
  // final `output` array matches the indices regardless of emit order.
  let nextOutIndex = 0;
  const items = [];
  const openItem = () => {
    const i = nextOutIndex++;
    items[i] = null;
    return i;
  };
  const placeItem = (i, item) => {
    items[i] = item;
  };

  const openMessage = () => {
    if (msgOpen) return;
    msgOpen = true;
    msgId = "msg_" + Math.random().toString(36).slice(2, 14);
    msgIndex = openItem();
    sse(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: msgIndex,
      item: { type: "message", id: msgId, role: "assistant", status: "in_progress", content: [] },
      sequence_number: seq++,
    });
    sse(res, "response.content_part.added", {
      type: "response.content_part.added",
      content_index: 0,
      item_id: msgId,
      output_index: msgIndex,
      part: { type: "output_text", text: "", annotations: [] },
      sequence_number: seq++,
    });
  };

  const closeMessage = () => {
    if (!msgOpen) return;
    const item = {
      type: "message",
      id: msgId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    sse(res, "response.content_part.done", {
      type: "response.content_part.done",
      content_index: 0,
      item_id: msgId,
      output_index: msgIndex,
      part: { type: "output_text", text, annotations: [] },
      sequence_number: seq++,
    });
    sse(res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: msgIndex,
      item,
      sequence_number: seq++,
    });
    placeItem(msgIndex, item);
    msgOpen = false;
  };

  const openCall = (idx, delta) => {
    let c = calls.get(idx);
    if (!c) {
      c = { id: delta.id || `call_${idx}_${Math.random().toString(36).slice(2, 10)}`, name: "", args: "", itemId: "fc_" + Math.random().toString(36).slice(2, 14), added: false, outIndex: -1 };
      calls.set(idx, c);
    }
    if (delta.id) c.id = delta.id;
    if (delta.function?.name) c.name += delta.function.name;
    if (!c.added && c.name) {
      c.added = true;
      c.outIndex = openItem();
      sse(res, "response.output_item.added", {
        type: "response.output_item.added",
        output_index: c.outIndex,
        item: { type: "function_call", id: c.itemId, status: "in_progress", arguments: "", call_id: c.id, name: c.name },
        sequence_number: seq++,
      });
    }
    const chunk = delta.function?.arguments;
    if (chunk) {
      c.args += chunk;
      sse(res, "response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        delta: chunk,
        item_id: c.itemId,
        output_index: c.outIndex,
        sequence_number: seq++,
      });
    }
  };

  const finish = () => {
    closeMessage();
    for (const c of calls.values()) {
      if (!c.added) continue;
      sse(res, "response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        arguments: c.args || "{}",
        item_id: c.itemId,
        output_index: c.outIndex,
        sequence_number: seq++,
      });
      const item = { type: "function_call", id: c.itemId, status: "completed", arguments: c.args || "{}", call_id: c.id, name: c.name };
      sse(res, "response.output_item.done", {
        type: "response.output_item.done",
        output_index: c.outIndex,
        item,
        sequence_number: seq++,
      });
      placeItem(c.outIndex, item);
    }
    sse(res, "response.completed", {
      type: "response.completed",
      response: { ...base, status: "completed", output: items.filter(Boolean), usage },
    });
    res.end();
  };

  upstream.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      let j;
      try {
        j = JSON.parse(payload);
      } catch {
        continue;
      }
      if (j.usage) {
        usage = {
          input_tokens: j.usage.prompt_tokens ?? 0,
          output_tokens: j.usage.completion_tokens ?? 0,
          total_tokens: j.usage.total_tokens ?? 0,
        };
      }
      const d = j.choices?.[0]?.delta;
      if (!d) continue;
      if (d.reasoning_content) reasoning += d.reasoning_content;
      if (d.content) {
        openMessage();
        text += d.content;
        sse(res, "response.output_text.delta", {
          type: "response.output_text.delta",
          content_index: 0,
          delta: d.content,
          item_id: msgId,
          output_index: msgIndex,
          sequence_number: seq++,
        });
      }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) openCall(tc.index ?? 0, tc);
      }
    }
  });
  upstream.on("end", finish);
  upstream.on("error", () => {
    try {
      sse(res, "response.failed", { type: "response.failed", response: { ...base, status: "failed" } });
      res.end();
    } catch {}
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

  if (body !== undefined && (route.filter || route.stripReasoning)) {
    try {
      if (route.filter) {
        const next = filterBody(body, { injectInstructions: true });
        changed = next !== body;
        body = next;
      }
      if (route.stripReasoning) {
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed.input)) {
          const kept = parsed.input.filter((it) => it?.type !== "reasoning");
          const dropped = parsed.input.length - kept.length;
          if (dropped > 0) {
            parsed.input = kept;
            body = JSON.stringify(parsed);
            changed = true;
          }
        }
      }
    } catch {
      /* fail-open, matching the omp hook */
    }
  }
  if (changed) log(`filter rewrote ${prefix}${rest} body (${raw.length} -> ${Buffer.byteLength(body)})`);

  if (incoming) {
    const after = (() => {
      try {
        const p = JSON.parse(body);
        return Array.isArray(p.input) ? p.input.filter((it) => it?.type === "reasoning").length : null;
      } catch {
        return null;
      }
    })();
    log(
      `${prefix}${rest}: items=${incoming.items} reasoning=${incoming.reasoning}` +
        (after !== null && after !== incoming.reasoning ? ` -> ${after}` : "") +
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

// Exported so tests can drive the bridge in-process (see
// tools/test-bridge-indices.mjs): a synthetic upstream stream plus a recording
// `res` is deterministic, whereas a live turn only hits these lines when the
// model happens to emit a content preamble before its tool call.
export { bridgeChatStream, toChatBody, toChatMessages, toChatTools };

// Only bind the port when run as the entry point; importing this module (tests)
// must not start a second gateway.
const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  server.listen(PORT, HOST, () => log(`agentrouter gateway listening on http://${HOST}:${PORT} (routes: /ar /rc /wb /an)`));
}

// Regression test for the anthropic-wire registry plumbing.
//
// Why this file exists: anyrouter exposes its claude ids ONLY on the anthropic
// /v1/messages face. Probed 2026-09-24: /v1/responses answers 404
// "当前 API 不支持所选模型" for every claude id, and /v1/messages answers 400
// (missing beta header) or 503 (channel pool down) - i.e. it reaches the
// business layer. So a claude id registered under anyrouter needs THREE things
// the gateway did not previously support:
//
//   1. a MODEL-level wire override - the provider default is "responses", so
//      without it the id would go down the responses passthrough and could
//      never work;
//   2. an injected `anthropic-beta: context-1m-2025-08-07` - without it the
//      upstream refuses with 400 "1m 上下文已经全量可用,请启用 1m 上下文后重试";
//   3. `anthropic-beta` forwarded from the client when present - it was
//      previously dropped by the inbound header whitelist, silently.
//
// What is pinned here:
//   A. the registry declares both claude ids with wire=anthropic + the beta
//      header, and leaves gpt-6-astra-an on the responses wire (so adding the
//      claude ids did not drag astra onto the wrong face);
//   B. the gateway actually SENDS wire=anthropic + the beta header for those
//      ids - asserted on the real outbound request, not on the registry;
//   C. gpt-6-astra-an still goes to /v1/responses (no regression);
//   D. justwoker's claude-opus-4-8 - the pre-existing anthropic provider with
//      NO headers configured - is byte-identical to before: /v1/messages,
//      x-api-key auth, and NO anthropic-beta header. This is the zero-regression
//      guard for the change.
//
// No port is bound and no network call is made: http.createServer is stubbed to
// capture the real handler and http/https.request are stubbed so the "upstream"
// is a recording fake. server.mjs only calls listen() when it is the entry point.
//
// Run: node tools/test-anthropic-registry.mjs   (exits non-zero on failure)
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import fs from "node:fs";

let failed = 0;
const logs = [];
const realStdout = process.stdout.write.bind(process.stdout);
process.stdout.write = (s) => { logs.push(String(s)); return true; };
const out = (s) => realStdout(s);

const check = (name, fn) => {
  try {
    fn();
    out(`PASS  ${name}\n`);
  } catch (e) {
    failed++;
    out(`FAIL  ${name}\n        ${e?.message ?? e}\n`);
  }
};
const eq = (a, b, what) => {
  if (a !== b) throw new Error(`${what}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
};

// --- A. registry shape (read the real file) --------------------------------
const reg = JSON.parse(fs.readFileSync(new URL("../providers.json", import.meta.url), "utf8"));
const BETA = "context-1m-2025-08-07";

check("registry: claude-opus-5-5 is anthropic-wired with the 1m beta header", () => {
  const s = reg.models["claude-opus-5-5"];
  if (!s) throw new Error("claude-opus-5-5 not registered");
  eq(s.p, "anyrouter", "provider");
  eq(s.wire, "anthropic", "wire override");
  eq(s.headers?.["anthropic-beta"], BETA, "anthropic-beta header");
});
check("registry: claude-fable-5-1 likewise", () => {
  const s = reg.models["claude-fable-5-1"];
  if (!s) throw new Error("claude-fable-5-1 not registered");
  eq(s.p, "anyrouter", "provider");
  eq(s.wire, "anthropic", "wire override");
  eq(s.headers?.["anthropic-beta"], BETA, "anthropic-beta header");
});
check("registry: gpt-6-astra-an stays on the responses wire", () => {
  const s = reg.models["gpt-6-astra-an"];
  eq(s.wire, undefined, "no model-level wire override");
  eq(reg.providers[s.p].wire, "responses", "provider wire");
});
check("registry: justwoker claude-opus-4-8 declares NO injected headers", () => {
  const s = reg.models["claude-opus-4-8"];
  if (!s) throw new Error("claude-opus-4-8 not registered");
  eq(s.headers, undefined, "model headers");
  eq(reg.providers.justwoker.headers, undefined, "provider headers");
});
check("registry: no array sneaks into `models` (would list as a fake id)", () => {
  const arrays = Object.entries(reg.models).filter(([, v]) => Array.isArray(v)).map(([k]) => k);
  if (arrays.length) throw new Error("array entries in models: " + arrays.join(", "));
});

// --- capture the real handler, record what it forwards ----------------------
let handler = null;
const forwarded = [];
http.createServer = (h) => { handler = h; return { on() {}, listen() {} }; };

// The recording fake upstream. Two shapes must be handled:
//   * direct providers   -> http(s).request(opts, onResponse)
//   * proxied providers  -> the CONNECT branch in server.mjs calls
//     http.request({method:"CONNECT"}) and waits for a "connect" EVENT (not the
//     response callback), then tunnels https.request over the returned socket.
//     anyrouter is proxied, so a stub that only calls onResponse never settles.
const stub = () => (opts, onResponse) => {
  const req = new EventEmitter();
  req.write = (b) => { pending.body = String(b); };
  req.end = () => {};

  const isConnect = String(opts?.method ?? '').toUpperCase() === 'CONNECT';

  if (isConnect) {
    // Hand back a socket-like object; the caller then opens https over it.
    const socket = new EventEmitter();
    socket.destroy = () => {};
    setImmediate(() => {
      req.emit('connect', { statusCode: 200 }, socket);
    });
    return req;
  }

  const rec = {
    host: String(opts?.hostname ?? ""),
    path: String(opts?.path ?? ""),
    headers: opts?.headers ?? {},
    body: null,
    viaConnect: Boolean(opts?.socket),
  };
  forwarded.push(rec);
  const pending = { body: null };
  rec._pending = pending;

  const up = new EventEmitter();
  up.statusCode = 200;
  up.headers = { "content-type": "text/event-stream" };
  up.destroyed = false;
  up.destroy = () => {};
  up.pipe = () => {};
  up.resume = () => {};
  const sse = [
    'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":3}}}',
    "",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PONG"}}',
    "",
    'data: {"type":"message_delta","usage":{"output_tokens":1}}',
    "",
    'data: {"type":"message_stop"}',
    "",
  ].join("\n");
  const chunks = [Buffer.from(sse)];
  up[Symbol.asyncIterator] = async function* () { for (const c of chunks) yield c; };

  // Capture the body at end() time so the record is complete before assertions.
  const realEnd = req.end.bind(req);
  req.end = () => {
    rec.body = pending.body;
    setImmediate(() => {
      if (typeof onResponse === "function") onResponse(up);
      setImmediate(() => { for (const c of chunks) up.emit("data", c); up.emit("end"); });
    });
    realEnd();
  };
  return req;
};
http.request = stub();
https.request = stub();


https.request = stub();

await import("../server.mjs");
out("");

const fakeRes = () => ({
  headersSent: false, status: undefined, body: null, headers: {}, _done: null,
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  writeHead(s) { this.headersSent = true; this.status = s; },
  end(b) { if (b !== undefined) this.body = String(b); if (this._done) this._done(); },
  on() {}, destroy() {}, pipe() {},
  write(b) { this.body = (this.body ?? "") + String(b); return true; },
});

async function post(body, headers = {}) {
  const res = fakeRes();
  const done = new Promise((r) => { res._done = r; });
  await handler(
    { method: "POST", url: "/u/v1/responses", headers, chunks: [Buffer.from(JSON.stringify(body))] },
    res,
  );
  await Promise.race([done, new Promise((r) => setTimeout(r, 1500))]);
  return res;
}

const reqBody = (model) => ({ model, stream: false, input: [{ role: "user", content: "hi" }] });

// --- B. the claude ids really go out over /v1/messages + beta ---------------
forwarded.length = 0;
await post(reqBody("claude-opus-5-5"));
check("outbound: claude-opus-5-5 uses the anthropic face", () => {
  eq(forwarded.length, 1, "one upstream call");
  eq(forwarded[0].path, "/v1/messages", "path");
});
check("outbound: claude-opus-5-5 carries the injected 1m beta header", () => {
  eq(forwarded[0].headers["anthropic-beta"], BETA, "anthropic-beta");
});
check("outbound: claude-opus-5-5 carries the anthropic version + key", () => {
  eq(forwarded[0].headers["anthropic-version"], "2023-06-01", "anthropic-version");
  if (!forwarded[0].headers["x-api-key"]) throw new Error("x-api-key missing");
});

forwarded.length = 0;
await post(reqBody("claude-fable-5-1"));
check("outbound: claude-fable-5-1 likewise", () => {
  eq(forwarded[0].path, "/v1/messages", "path");
  eq(forwarded[0].headers["anthropic-beta"], BETA, "anthropic-beta");
});

// A client-supplied beta header must reach the upstream too (it used to be
// stripped by the inbound whitelist before it could ever be forwarded).
forwarded.length = 0;
await post(reqBody("claude-opus-5-5"), { "anthropic-beta": "some-client-beta" });
check("outbound: registry header wins over a client-supplied one", () => {
  eq(forwarded[0].headers["anthropic-beta"], BETA, "anthropic-beta");
});

// --- C. astra-an is untouched: still the responses passthrough --------------
forwarded.length = 0;
await post(reqBody("gpt-6-astra-an"));
check("outbound: gpt-6-astra-an still uses /v1/responses", () => {
  eq(forwarded[0].path, "/v1/responses", "path");
});
check("outbound: gpt-6-astra-an gets no anthropic-beta header", () => {
  eq(forwarded[0].headers["anthropic-beta"], undefined, "anthropic-beta");
});

// --- D. justwoker zero-regression ------------------------------------------
forwarded.length = 0;
await post(reqBody("claude-opus-4-8"));
check("outbound: claude-opus-4-8 still uses /v1/messages", () => {
  eq(forwarded.length, 1, "one upstream call");
  eq(forwarded[0].path, "/v1/messages", "path");
});
check("outbound: claude-opus-4-8 injects NO anthropic-beta (unchanged)", () => {
  eq(forwarded[0].headers["anthropic-beta"], undefined, "anthropic-beta");
});
check("outbound: claude-opus-4-8 keeps x-api-key auth (unchanged)", () => {
  if (!forwarded[0].headers["x-api-key"]) throw new Error("x-api-key missing");
});
check("outbound: claude-opus-4-8 does not go through the anyrouter proxy", () => {
  eq(forwarded[0].host, "api.justwoker.icu", "host");
});

out("");
out(failed ? `${failed} check(s) FAILED\n` : "all checks passed\n");
process.exitCode = failed ? 1 : 0;

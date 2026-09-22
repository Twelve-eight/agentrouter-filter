// Regression test for the gateway's cross-realm fallback (global -> cn).
//
// Why this file exists: wb2api keeps the CN and global account pools strictly
// separate (internal/pool/pick.go: realmOK filters candidates AND the
// all-cooling fallback below it). When every global account is rate-limited, a
// `global:` request therefore dies on 429 and kills the Codex turn - the
// failure this feature exists to absorb. The pool's own regression test
// asserts that separation, so the fallback has to live on the gateway side.
//
// What is pinned here:
//   1. ENTER: a fully exhausted global attempt (every internal retry answers
//      429) makes the gateway retry the SAME request against the cn id, and the
//      client gets the cn answer, not the 429. The retried body really carries
//      the cn model id.
//   2. The client is told which realm answered, plus when global is expected
//      back (X-Gateway-Realm / X-Gateway-Retry-At / X-Gateway-Realm-Source).
//   3. STAY: while the window is armed and global is still down, the next
//      request goes straight to cn with exactly ONE upstream call - no wasted
//      global attempt.
//   4. LEAVE: once GET /status shows a selectable global account, the next
//      request goes back to global (positive evidence, never a healthy count).
//   5. A model WITHOUT `fallback` configured is untouched: its 429 retries
//      exactly as before and is passed through, with no realm headers.
//
// Note on retries: requestWithRetry treats 429 as retryable (RETRY_MAX = 3), so
// exhausting global costs 1 + 3 upstream attempts on purpose. That is the point
// - the pool re-picks on each attempt, so a merely *busy* global account
// recovers within the retries and no cn credit is spent. Only a realm that is
// genuinely out of accounts reaches the fallback.
//
// No port is bound and no network call is made: http.createServer is stubbed to
// capture the real handler, and http/https.request are stubbed so both the
// upstream and the gateway's own /status + /healthz reads are recordings.
// server.mjs only calls listen() when it is the entry point.
//
// Run: node tools/test-realm-fallback.mjs   (exits non-zero on failure)
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";

// Set BEFORE server.mjs is imported: these constants are read at module load,
// and the LEAVE case has to observe a recovered /status inside the same process
// instead of waiting out the 30s cache TTL.
process.env.AR_REALM_STATUS_TTL_MS = "0";
process.env.AR_REALM_HEALTH_TTL_MS = "0";

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

const sseBody = () => [
  'data: {"choices":[{"delta":{"content":"PONG"}}]}',
  "",
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
  "",
  "data: [DONE]",
  "",
].join("\n");

// --- upstream + local-endpoint fake -----------------------------------------
let script = [];
const chatCalls = [];
let localStatus = null;
let localHealth = null;
let localHits = 0;

const stubRequest = () => (opts, onResponse) => {
  const path = String(opts?.path ?? "");
  const rec = { host: String(opts?.hostname ?? ""), path, body: null };
  const upstream = new EventEmitter();
  upstream.headers = { "content-type": "application/json" };
  upstream.destroyed = false;
  upstream.destroy = () => {};
  upstream.pipe = () => {};
  upstream.resume = () => {};
  const req = { on: () => req, write: (b) => { rec.body = String(b); }, end() {} };

  // Deliver the body the way Node delivers a real http response: both an
  // EventEmitter (on("data")/on("end") - the passthrough and bridge paths) and
  // async-iterable (for await - the fallback's error drain). A plain
  // EventEmitter would throw on the latter and turn a product path into a test
  // artefact.
  const finish = (status, text, contentType = "application/json") => {
    upstream.statusCode = status;
    upstream.headers["content-type"] = contentType;
    const chunks = text === null ? [] : [Buffer.from(text)];
    upstream[Symbol.asyncIterator] = async function* () { for (const c of chunks) yield c; };
    setImmediate(() => {
      if (typeof onResponse === "function") onResponse(upstream);
      setImmediate(() => {
        for (const c of chunks) upstream.emit("data", c);
        upstream.emit("end");
      });
    });
  };

  if (path === "/status" || path === "/healthz") {
    localHits++;
    if (path === "/status") finish(localStatus ? 200 : 503, localStatus ? JSON.stringify(localStatus) : "{}");
    else finish(200, JSON.stringify(localHealth ?? { healthy: 1, realm_servable: { cn: true, global: true } }));
    return req;
  }

  chatCalls.push(rec);
  const step = script.shift();
  if (!step) {
    // More upstream calls than scripted is itself a failure (a stray retry), so
    // answer with a loud error instead of a fake 200 that would mask it.
    finish(500, JSON.stringify({ error: { message: "TEST: unscripted upstream call" } }));
    return req;
  }
  finish(step.status, step.body, step.contentType ?? "application/json");
  return req;
};
http.request = stubRequest();
https.request = stubRequest();

let handler = null;
http.createServer = (h) => {
  handler = h;
  return { on() {}, listen() {} };
};

await import("../server.mjs");
out("");

const fakeRes = () => ({
  headersSent: false,
  status: undefined,
  ended: false,
  body: null,
  headers: {},
  // Resolved by end(). The bridges answer asynchronously (their listeners fire
  // on the upstream's 'end'), so post() must wait for completion rather than
  // assert against a half-built response.
  _done: null,
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  writeHead(s) { this.headersSent = true; this.status = s; },
  end(b) {
    this.ended = true;
    if (b !== undefined) this.body = String(b);
    if (this._done) this._done();
  },
  on() {},
  destroy() {},
  pipe() {},
  write(b) { this.body = (this.body ?? "") + String(b); return true; },
});

/** Drive the real request handler in-process (no socket is ever opened). */
async function post(body) {
  const res = fakeRes();
  const done = new Promise((resolve) => { res._done = resolve; });
  await handler(
    { method: "POST", url: "/u/v1/responses", headers: {}, chunks: [Buffer.from(JSON.stringify(body))] },
    res,
  );
  // Bounded wait for res.end().
  await Promise.race([done, new Promise((r) => setTimeout(r, 2000))]);
  return res;
}

const reqBody = (model) => ({
  model,
  stream: false,
  input: [{ role: "user", content: "hi" }],
  reasoning: { effort: "max" },
});

const GLOBAL = "global:deepseek-v4.1-flash";
const CN = "cn:deepseek-v4.1-flash";

const e429 = () => ({ status: 429, body: JSON.stringify({ error: { code: "rate_limit_exceeded", message: "all cooling" } }) });
const ok = () => ({ status: 200, body: sseBody(), contentType: "text/event-stream" });
// One client-visible global attempt = the send plus requestWithRetry's 3 retries.
const globalExhausted = () => [e429(), e429(), e429(), e429()];

const globalStatus = (until = "2999-01-01T00:00:00+08:00") => ({
  accounts: [{ uid: "g1", realm: "global", disabled: false, cooling: true, until }],
  realm_totals: { cn: { healthy: 1 }, global: { healthy: 0 } },
});
const recoveredStatus = () => ({
  accounts: [{ uid: "g1", realm: "global", disabled: false, cooling: false, until: "0001-01-01T00:00:00Z" }],
  realm_totals: { cn: { healthy: 1 }, global: { healthy: 1 } },
});

// --- 1. ENTER: global exhausted -> cn answers -------------------------------
script = [...globalExhausted(), ok()];
localStatus = globalStatus();
localHealth = { healthy: 1, realm_servable: { cn: true, global: false } };
chatCalls.length = 0;

let res = await post(reqBody(GLOBAL));
check("enter: client gets 200 (not the global 429)", () => eq(res.status, 200, "status"));
check("enter: 4 global attempts then 1 cn attempt", () => eq(chatCalls.length, 5, "call count"));
check("enter: every global attempt used the global id", () => {
  for (let i = 0; i < 4; i++) eq(JSON.parse(chatCalls[i].body).model, GLOBAL, `attempt ${i + 1} model`);
});
check("enter: the fallback attempt used the cn id", () => eq(JSON.parse(chatCalls[4].body).model, CN, "fallback model"));
check("enter: response says cn answered", () => eq(res.headers["x-gateway-realm"], "cn", "realm header"));
check("enter: response carries an ISO recovery time", () => {
  const v = res.headers["x-gateway-retry-at"];
  if (!v) throw new Error("X-Gateway-Retry-At missing");
  if (!Number.isFinite(Date.parse(v))) throw new Error(`not a date: ${v}`);
});
check("enter: recovery time is the account-level until", () =>
  eq(res.headers["x-gateway-retry-at"], new Date("2999-01-01T00:00:00+08:00").toISOString(), "retry-at"));
check("enter: the source is labelled so precision is not overstated", () =>
  eq(res.headers["x-gateway-realm-source"], "status-account", "source header"));
check("enter: exhaustion is logged", () => {
  if (!logs.some((l) => l.includes("cross-realm") && l.includes("exhausted"))) {
    throw new Error("no cross-realm exhaustion line in the log");
  }
});

// --- 2. STAY: window armed -> one hop, straight to cn ------------------------
script = [ok()];
chatCalls.length = 0;
res = await post(reqBody(GLOBAL));
check("stay: still 200", () => eq(res.status, 200, "status"));
check("stay: exactly ONE upstream call (no wasted global probe)", () => eq(chatCalls.length, 1, "call count"));
check("stay: that call already used cn", () => eq(JSON.parse(chatCalls[0].body).model, CN, "model"));
check("stay: still reports cn", () => eq(res.headers["x-gateway-realm"], "cn", "realm header"));

// --- 3. LEAVE: global selectable again -> back to global ---------------------
localStatus = recoveredStatus();
localHealth = { healthy: 1, realm_servable: { cn: true, global: true } };
script = [ok()];
chatCalls.length = 0;
res = await post(reqBody(GLOBAL));
check("leave: exactly ONE upstream call", () => eq(chatCalls.length, 1, "call count"));
check("leave: went back to the global id", () => eq(JSON.parse(chatCalls[0].body).model, GLOBAL, "model"));
check("leave: reports global", () => eq(res.headers["x-gateway-realm"], "global", "realm header"));
check("leave: recovery is announced", () => {
  if (!logs.some((l) => l.includes("cross-realm") && l.includes("recovered early"))) {
    throw new Error("no recovery line in the log");
  }
});

// --- 4. a model WITHOUT fallback is untouched -------------------------------
// gpt-5.4 declares no "fallback" in providers.json. Its 429 retries exactly as
// before and is passed through; no realm header, no redirect.
script = [e429(), e429(), e429(), e429()];
chatCalls.length = 0;
res = await post(reqBody("gpt-5.4"));
check("no-fallback: 429 passed through unchanged", () => eq(res.status, 429, "status"));
check("no-fallback: retried like before (1 + 3)", () => eq(chatCalls.length, 4, "call count"));
check("no-fallback: never redirected to another realm", () => {
  for (const c of chatCalls) eq(JSON.parse(c.body).model, "gpt-5.4", "model on every attempt");
});
check("no-fallback: no realm header added", () => eq(res.headers["x-gateway-realm"], undefined, "realm header"));

out("");
out(failed ? `${failed} check(s) FAILED\n` : "all checks passed\n");
process.exitCode = failed ? 1 : 0;

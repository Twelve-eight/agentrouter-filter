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
//   5. A CN target that is cooling or has unknown status is never called; a
//      fallback-window request returns a bounded retryable 503 instead.
//   6. A model WITHOUT `fallback` configured is untouched: its 429 retries
//      exactly as before and is passed through, with no realm headers.
//
// Note on retries: wb2api chat requests treat 429 and 503 as retryable
// (RETRY_MAX = 3), so exhausting global costs 1 + 3 upstream attempts on
// purpose. That is the point - the pool re-picks on each attempt, so a merely
// *busy* global account recovers within the retries and no cn credit is spent.
// Other providers keep the default 429-only retry policy. Only a realm that is
// genuinely out of accounts can reach the fallback, and only a CN /status
// result can authorize that hop.
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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Set BEFORE server.mjs is imported: these constants are read at module load,
// and the LEAVE case has to observe a recovered /status inside the same process
// instead of waiting out the 30s cache TTL.
process.env.AR_REALM_STATUS_TTL_MS = "0";
process.env.AR_REALM_HEALTH_TTL_MS = "0";
process.env.AR_REALM_STATUS_TIMEOUT_MS = "25";
process.env.AR_REALM_HEALTH_TIMEOUT_MS = "25";

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
let localFaults = {};
const localRequests = [];

const stubRequest = () => (opts, onResponse) => {
  const path = String(opts?.path ?? "");
  const rec = { host: String(opts?.hostname ?? ""), path, body: null };
  const upstream = new EventEmitter();
  upstream.headers = { "content-type": "application/json" };
  upstream.destroyed = false;
  let releaseBody;
  upstream.destroy = () => { upstream.destroyed = true; releaseBody?.(); };
  upstream.pipe = () => {};
  upstream.resume = () => {};
  const req = { on: () => req, write: (b) => { rec.body = String(b); }, end() {}, destroy() { rec.cancelled = true; upstream.destroy(); } };
  rec.upstream = upstream;

  // Deliver the body the way Node delivers a real http response: both an
  // EventEmitter (on("data")/on("end") - the passthrough and bridge paths) and
  // async-iterable (for await - the fallback's error drain). A plain
  // EventEmitter would throw on the latter and turn a product path into a test
  // artefact.
  const finish = (status, text, contentType = "application/json", extraHeaders = {}) => {
    upstream.statusCode = status;
    upstream.headers = { "content-type": contentType, ...extraHeaders };
    const chunks = text === null ? [] : [Buffer.from(text)];
    upstream[Symbol.asyncIterator] = async function* () { for (const c of chunks) yield c; };
    setImmediate(() => {
      if (rec.cancelled) return;
      if (typeof onResponse === "function") onResponse(upstream);
      setImmediate(() => {
        if (upstream.destroyed) return;
        for (const c of chunks) upstream.emit("data", c);
        upstream.emit("end");
      });
    });
  };

  if (path === "/status" || path === "/healthz") {
    localHits++;
    localRequests.push(rec);
    const fault = localFaults[path];
    if (fault === "headers-hang") return req;
    if (fault === "body-hang") {
      upstream.statusCode = 200;
      upstream[Symbol.asyncIterator] = async function* () {
        yield Buffer.from("{");
        await new Promise(resolve => { releaseBody = resolve; });
      };
      setImmediate(() => onResponse(upstream));
      return req;
    }
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
  finish(step.status, step.body, step.contentType ?? "application/json", step.headers ?? {});
  return req;
};
http.request = stubRequest();
https.request = stubRequest();

let handler = null;
http.createServer = (h) => {
  handler = h;
  return { on() {}, listen() {} };
};

// Isolate usage before the real server (and its usage dependency) is imported.
// Each run owns a new directory; keep its artifacts for post-run inspection.
const testTmp = fileURLToPath(new URL("../.tmp/", import.meta.url));
if (process.platform === "win32" && path.parse(testTmp).root.toLowerCase() !== "g:" + path.sep) {
  throw new Error("Usage isolation tests must run from a project on G:");
}
fs.mkdirSync(testTmp, { recursive: true });
process.env.AR_USAGE_DIR = fs.mkdtempSync(path.join(testTmp, "test-realm-fallback-usage-"));

await import("../server.mjs");
out(`测试账本目录: ${process.env.AR_USAGE_DIR}\n`);
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
  let timer;
  try {
    await Promise.race([
      (async () => {
        await handler(
          { method: "POST", url: "/u/v1/responses", headers: {}, chunks: [Buffer.from(JSON.stringify(body))] },
          res,
        );
        await done;
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("handler did not finish within 5000ms")), 5000); }),
    ]);
  } finally { clearTimeout(timer); }
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

const usableCn = () => ({ uid: "c1", realm: "cn", disabled: false, cooling: false, until: "0001-01-01T00:00:00Z" });
const coolingCn = (until = "2999-01-01T00:00:00+08:00") => ({
  uid: "c1", realm: "cn", disabled: false, cooling: true, until,
});
const globalStatus = (until = "2999-01-01T00:00:00+08:00", cn = usableCn()) => ({
  accounts: [{ uid: "g1", realm: "global", disabled: false, cooling: true, until }, cn],
  realm_totals: { cn: { healthy: cn ? 1 : 0 }, global: { healthy: 0 } },
});
const recoveredStatus = () => ({
  accounts: [
    { uid: "g1", realm: "global", disabled: false, cooling: false, until: "0001-01-01T00:00:00Z" },
    usableCn(),
  ],
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

// A real global account can still be selectable even when one request failed.
// That is a transient global error, not permission to spend CN credits.
await clearWindow();
localStatus = recoveredStatus();
localHealth = { healthy: 1, realm_servable: { cn: true, global: true } };
script = [...globalExhausted()];
chatCalls.length = 0;
res = await post(reqBody(GLOBAL));
check("transient-global: does not fall back while global status is usable", () => {
  eq(res.status, 503, "status");
  eq(chatCalls.length, 4, "calls");
  for (const c of chatCalls) eq(JSON.parse(c.body).model, GLOBAL, "model");
});
check("transient-global: emits a short retry signal", () => {
  eq(res.headers["retry-after"], "5", "retry-after");
  const remaining = Date.parse(res.headers["x-gateway-retry-at"]) - Date.now();
  if (!(remaining > 0 && remaining <= 10_000)) throw new Error("transient retry signal missing or unbounded");
});

// --- 5. the precision label follows the account that sets the time ----------
// Real observation (2026-09-22): one global account was cooling with a local
// account-level until of 16:41 while another carried the upstream's
// model-level reset_at of the NEXT DAY. The earliest of those (16:41) is a
// local estimate that soft_rate_max may have truncated, so it must NOT be
// labelled "status-model" - that would claim upstream authority for a guess.
// This case pins the label to whichever account actually decided the time.
{
  const restore = {
    status: localStatus,
    health: localHealth,
    script: script,
  };
  // Clear the armed window first so the next request re-enters global and
  // re-arms it against this mixed /status.
  localStatus = globalStatus("2020-01-01T00:00:00+08:00"); // already expired
  localHealth = { healthy: 1, realm_servable: { cn: true, global: true } };
  script = [ok()]; // one global attempt that SUCCEEDS, clearing the window
  chatCalls.length = 0;
  await post(reqBody(GLOBAL));

  // Now: account A = soon local estimate, account B = upstream model reset.
  const soon = new Date(Date.now() + 60_000).toISOString();          // local estimate
  const far = new Date(Date.now() + 24 * 3600_000).toISOString();    // upstream model reset
  localStatus = {
    accounts: [
      { uid: "gA", realm: "global", disabled: false, cooling: true, until: soon },
      { uid: "gB", realm: "global", disabled: false, cooling: true, until: soon, rate_limited_models: [
        { model: "deepseek-v4.1-flash", reset_at: far },
      ] },
    ],
    realm_totals: { cn: { healthy: 1 }, global: { healthy: 0 } },
  };
  localHealth = { healthy: 1, realm_servable: { cn: true, global: false } };
  script = [...globalExhausted(), ok()];
  chatCalls.length = 0;
  res = await post(reqBody(GLOBAL));
  check("label: earliest blocker decides, not the most authoritative one", () =>
    eq(res.headers["x-gateway-realm-source"], "status-account", "source header"));
  check("label: time is that earliest blocker", () =>
    eq(res.headers["x-gateway-retry-at"], new Date(soon).toISOString(), "retry-at"));

  // And when the MODEL reset is the earliest blocker, the label flips.
  const soon2 = new Date(Date.now() + 120_000).toISOString();
  const far2 = new Date(Date.now() + 48 * 3600_000).toISOString();
  localStatus = {
    accounts: [
      { uid: "gA", realm: "global", disabled: false, cooling: true, until: far2 },
      { uid: "gB", realm: "global", disabled: false, cooling: true, until: soon2, rate_limited_models: [
        { model: "deepseek-v4.1-flash", reset_at: soon2 },
      ] },
    ],
    realm_totals: { cn: { healthy: 1 }, global: { healthy: 0 } },
  };
  script = [...globalExhausted(), ok()];
  chatCalls.length = 0;
  res = await post(reqBody(GLOBAL));
  check("label: a model-level blocker IS labelled authoritative", () =>
    eq(res.headers["x-gateway-realm-source"], "status-model", "source header"));
  check("label: and carries the upstream reset time", () =>
    eq(res.headers["x-gateway-retry-at"], new Date(soon2).toISOString(), "retry-at"));

  // Leave the module in a sane state for the summary below.
  localStatus = restore.status;
  localHealth = restore.health;
  script = restore.script;
}

// --- 6. CN must be confirmed before the gateway spends it --------------------
async function clearWindow() {
  localFaults = {};
  localStatus = recoveredStatus();
  localHealth = { realm_servable: { global: true, cn: true } };
  script = [ok()];
  await post(reqBody(GLOBAL));
}

// 6a. Global exhausted + CN unavailable: do not send a speculative CN request.
await clearWindow();
localStatus = globalStatus("2999-01-01T00:00:00+08:00", coolingCn());
localHealth = { healthy: 1, realm_servable: { cn: false, global: false } };
script = [...globalExhausted()];
chatCalls.length = 0;
res = await post(reqBody(GLOBAL));
check("cn-unavailable: returns retryable 503", () => eq(res.status, 503, "status"));
check("cn-unavailable: global was retried, but CN was never called", () => {
  eq(chatCalls.length, 4, "calls");
  for (const c of chatCalls) eq(JSON.parse(c.body).model, GLOBAL, "model");
});
check("cn-unavailable: Retry-After is present", () => eq(res.headers["retry-after"], "5", "retry-after"));
check("cn-unavailable: body uses server_is_overloaded", () =>
  eq(JSON.parse(res.body).error.code, "server_is_overloaded", "error code"));
check("cn-unavailable: recovery time still points at global", () =>
  eq(res.headers["x-gateway-retry-at"], new Date("2999-01-01T00:00:00+08:00").toISOString(), "retry-at"));

// 6b. A fallback window that was previously armed must re-check CN. If CN has
// cooled in the meantime, the request fails locally instead of being sent there.
await clearWindow();
localStatus = globalStatus();
localHealth = { healthy: 1, realm_servable: { cn: true, global: false } };
script = [...globalExhausted(), ok()];
chatCalls.length = 0;
res = await post(reqBody(GLOBAL));
check("cn-window: initial confirmed fallback succeeds", () => eq(res.status, 200, "status"));
localStatus = globalStatus("2999-01-01T00:00:00+08:00", coolingCn());
localHealth = { healthy: 1, realm_servable: { cn: false, global: false } };
script = [];
chatCalls.length = 0;
res = await post(reqBody(GLOBAL));
check("cn-window: cooled CN returns retryable 503", () => eq(res.status, 503, "status"));
check("cn-window: cooled CN is not called", () => eq(chatCalls.length, 0, "calls"));
check("cn-window: cooled CN error is normalized", () =>
  eq(JSON.parse(res.body).error.code, "server_is_overloaded", "error code"));

// 6c. Once /status confirms CN again, the already-armed window may use it.
localStatus = globalStatus();
localHealth = { healthy: 1, realm_servable: { cn: true, global: false } };
script = [ok()];
chatCalls.length = 0;
res = await post(reqBody(GLOBAL));
check("cn-recovered: uses CN after positive status evidence", () => {
  eq(res.status, 200, "status");
  eq(chatCalls.length, 1, "calls");
  eq(JSON.parse(chatCalls[0].body).model, CN, "model");
});

// --- 7. Unknown probes are fail-closed, not an implicit CN permission --------
await clearWindow();
localStatus = null;
localHealth = {}; // no usable availability signal for either realm
script = [
  { status: 503, body: "{}", headers: { "retry-after": "0.001" } },
  { status: 503, body: "{}", headers: { "retry-after": "0.001" } },
  { status: 503, body: "{}", headers: { "retry-after": "0.001" } },
  { status: 503, body: "{}", headers: { "retry-after": "0.001" } },
];
chatCalls.length = 0;
res = await post(reqBody(GLOBAL));
check("unknown: observed global failure returns retryable 503", () => eq(res.status, 503, "status"));
check("unknown: no CN request is sent", () => {
  eq(chatCalls.length, 4, "calls");
  for (const c of chatCalls) eq(JSON.parse(c.body).model, GLOBAL, "model");
});
check("unknown: source is explicitly unknown", () => eq(res.headers["x-gateway-realm-source"], "unknown", "source"));
check("unknown: body uses server_is_overloaded", () =>
  eq(JSON.parse(res.body).error.code, "server_is_overloaded", "error code"));
check("unknown: Retry-After is present", () => eq(res.headers["retry-after"], "5", "retry-after"));

script = [];
chatCalls.length = 0;
res = await post(reqBody(GLOBAL));
check("unknown: next request still does not call CN", () => {
  eq(res.status, 503, "status");
  eq(chatCalls.length, 0, "calls");
  eq(res.headers["x-gateway-realm-source"], "unknown", "source");
});
check("unknown: retains the bounded recovery window", () => {
  const remaining = Date.parse(res.headers["x-gateway-retry-at"]) - Date.now();
  if (!(remaining > 60_000 && remaining <= 15 * 60_000)) throw new Error("unknown window missing or too short");
});

localHealth = { realm_servable: { global: "true", cn: "true" } };
script = [];
chatCalls.length = 0;
res = await post(reqBody(GLOBAL));
check("unknown: non-boolean health does not authorize CN", () => {
  eq(res.status, 503, "status");
  eq(chatCalls.length, 0, "calls");
});

localHealth = { realm_servable: { global: true, cn: true } };
script = [ok()];
chatCalls.length = 0;
res = await post(reqBody(GLOBAL));
check("health: positive global evidence clears window", () => {
  eq(res.status, 200, "status");
  eq(JSON.parse(chatCalls[0].body).model, GLOBAL, "model");
});

// --- 8. wb2api 503 gets bounded retries and a Codex-readable error ------------
await clearWindow();
localStatus = recoveredStatus();
localHealth = { realm_servable: { global: true, cn: true } };
const fast503 = () => ({ status: 503, body: JSON.stringify({ error: { message: "no_healthy_account" } }), headers: { "retry-after": "0.001" } });
script = [fast503(), fast503(), fast503(), fast503()];
chatCalls.length = 0;
res = await post(reqBody(CN));
check("wb503: retries 503 three times", () => eq(chatCalls.length, 4, "calls"));
check("wb503: final status is 503", () => eq(res.status, 503, "status"));
check("wb503: final error is server_is_overloaded", () =>
  eq(JSON.parse(res.body).error.code, "server_is_overloaded", "error code"));
check("wb503: Retry-After is short and explicit", () => eq(res.headers["retry-after"], "5", "retry-after"));

// --- 9. Probe deadlines cancel owned I/O and still fail closed -----------------
for (const endpoint of ["/status", "/healthz"]) {
  for (const fault of ["headers-hang", "body-hang"]) {
    await clearWindow();
    localStatus = null;
    localHealth = {};
    localFaults = { [endpoint]: fault };
    localRequests.length = 0;
    script = [fast503(), fast503(), fast503(), fast503()];
    chatCalls.length = 0;
    const start = Date.now();
    res = await post(reqBody(GLOBAL));
    check(endpoint + " " + fault + ": deadline fails closed", () => {
      eq(res.status, 503, "status");
      eq(chatCalls.length, 4, "calls");
      for (const c of chatCalls) eq(JSON.parse(c.body).model, GLOBAL, "model");
      if (Date.now() - start > 4500) throw new Error("probe exceeded bounded completion allowance");
    });
    check(endpoint + " " + fault + ": cancels request and response", () => {
      const hit = localRequests.find(r => r.path === endpoint);
      if (!hit) throw new Error("probe request was not recorded");
      eq(hit.cancelled, true, "request cancelled");
      eq(hit.upstream.destroyed, true, "response destroyed");
    });
  }
}
localFaults = {};

out("");
out(failed ? `${failed} check(s) FAILED\n` : "all checks passed\n");
process.exitCode = failed ? 1 : 0;

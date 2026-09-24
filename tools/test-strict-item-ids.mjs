// End-to-end test for strict-Responses item-id repair on the agentrouter route.
//
// Why this file exists: a session served by relaycat (ids minted as `item_...`)
// and then served by agentrouter replayed those ids verbatim and the turn died on
//   Invalid 'input[127].id': 'item_9c5b989663879ef37cb7082c'.
//   Expected an ID that begins with 'rs'. [trace_id=76537bee...]
// responses-ids.mjs fixes the body, and tools/test-responses-ids.mjs pins that
// class directly. What neither covers is the WIRING: does the gateway actually
// repair an /ar request, and does it leave every OTHER upstream's ids alone?
// That is what this file pins, by driving the real request handler in-process
// with the http layer stubbed (no socket, no network, no port bound).
//
// Run: node tools/test-strict-item-ids.mjs   (exits non-zero on failure)
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failed = 0;
const logs = [];
const realStdout = process.stdout.write.bind(process.stdout);
process.stdout.write = (s) => { logs.push(String(s)); return true; };
const out = (s) => realStdout(s);

const check = (name, fn) => {
  try { fn(); out(`PASS  ${name}\n`); }
  catch (e) { failed++; out(`FAIL  ${name}\n        ${e?.message ?? e}\n`); }
};
const eq = (a, b, what) => {
  if (a !== b) throw new Error(`${what}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
};

// --- upstream stub ----------------------------------------------------------
let script = [];
const calls = [];

const stubRequest = () => (opts, onResponse) => {
  const rec = { host: String(opts?.hostname ?? ""), path: String(opts?.path ?? ""), body: null, headers: opts?.headers ?? {} };
  const upstream = new EventEmitter();
  upstream.headers = { "content-type": "application/json" };
  upstream.destroyed = false;
  upstream.destroy = () => { upstream.destroyed = true; };
  upstream.pipe = () => {};
  upstream.resume = () => {};
  const req = { on: () => req, write: (b) => { rec.body = String(b); }, end() {}, destroy() {}, };
  const finish = (status, text) => {
    upstream.statusCode = status;
    const chunks = text === null ? [] : [Buffer.from(text)];
    upstream[Symbol.asyncIterator] = async function* () { for (const c of chunks) yield c; };
    setImmediate(() => {
      onResponse(upstream);
      setImmediate(() => {
        if (upstream.destroyed) return;
        for (const c of chunks) upstream.emit("data", c);
        upstream.emit("end");
      });
    });
  };
  calls.push(rec);
  const step = script.shift();
  if (!step) { finish(500, JSON.stringify({ error: { message: "TEST: unscripted upstream call" } })); return req; }
  finish(step.status, step.body);
  return req;
};
http.request = stubRequest();
https.request = stubRequest();

let handler = null;
http.createServer = (h) => { handler = h; return { on() {}, listen() {} }; };

const testTmp = fileURLToPath(new URL("../.tmp/", import.meta.url));
if (process.platform === "win32" && path.parse(testTmp).root.toLowerCase() !== "g:" + path.sep) {
  throw new Error("These tests must run from a project on G:");
}
fs.mkdirSync(testTmp, { recursive: true });
process.env.AR_USAGE_DIR = fs.mkdtempSync(path.join(testTmp, "test-strict-item-ids-usage-"));

await import("../server.mjs");
out(`测试账本目录: ${process.env.AR_USAGE_DIR}\n\n`);

const fakeRes = () => ({
  headersSent: false, status: undefined, ended: false, body: null, headers: {}, _done: null,
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  writeHead(s) { this.headersSent = true; this.status = s; },
  end(b) { this.ended = true; if (b !== undefined) this.body = String(b); if (this._done) this._done(); },
  on() {}, destroy() {}, pipe() {}, write(b) { this.body = (this.body ?? "") + String(b); return true; },
});

/** Drive the real handler in-process. `url` picks the route under test. */
async function post(body, url = "/ar/v1/responses") {
  const res = fakeRes();
  const done = new Promise((resolve) => { res._done = resolve; });
  let timer;
  try {
    await Promise.race([
      (async () => {
        await handler(
          { method: "POST", url, headers: { originator: "codex_exec" }, chunks: [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))] },
          res,
        );
        await done;
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("handler did not finish within 5000ms")), 5000); }),
    ]);
  } finally { clearTimeout(timer); }
  return res;
}

const REJECT_RS = JSON.stringify({ error: { message: "OpenAI Responses bad request: Invalid 'input[1].id': 'item_9c5b989663879ef37cb7082c'. Expected an ID that begins with 'rs'. [trace_id=76537bee1fa8ea2e23c577d8b0d63b4]" } });
const okBody = JSON.stringify({ id: "resp_1", object: "response", output: [] });

const foreignBody = (model = "gpt-6-astra-ar") => ({
  model,
  stream: false,
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "reasoning", id: "item_9c5b989663879ef37cb7082c", summary: [{ type: "summary_text", text: "s" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "again" }] },
  ],
});

// --- 1. the reported failure is repaired before the upstream sees it ---------
script = [{ status: 200, body: okBody }];
calls.length = 0;
let res = await post(foreignBody());
check("ar: foreign id is dropped BEFORE the body leaves", () => {
  eq(calls.length, 1, "one upstream call");
  const sent = JSON.parse(calls[0].body);
  eq(sent.input[1].id, undefined, "reasoning id removed");
  eq(sent.input[1].type, "reasoning", "item itself preserved");
  eq(sent.input.length, 3, "item count unchanged");
});
check("ar: client still gets 200", () => eq(res.status, 200, "status"));
check("ar: one upstream attempt only (no wasted retry)", () => eq(calls.length, 1, "call count"));
check("ar: the repair is logged", () => {
  if (!logs.some((l) => l.includes("strict-item-ids") && l.includes("foreign replay id"))) {
    throw new Error("no strict-item-ids log line");
  }
});

// --- 2. level 2: an id with a legal prefix the upstream does not know ---------
script = [
  { status: 400, body: REJECT_RS },
  { status: 200, body: okBody },
];
calls.length = 0;
res = await post({ model: "gpt-6-astra-ar", stream: false, input: [
  { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
  { type: "reasoning", id: "rs_jpmw1umntvs", summary: [] },
] });
check("level 2: a rejected replay is retried once", () => eq(calls.length, 2, "call count"));
check("level 2: the retry carries NO ids", () => {
  const sent = JSON.parse(calls[1].body);
  eq(sent.input[1].id, undefined, "rs_ id dropped on the retry");
});
check("level 2: client gets the successful retry", () => eq(res.status, 200, "status"));
check("level 2: the retry is logged", () => {
  if (!logs.some((l) => l.includes("upstream rejected replayed ids"))) throw new Error("no retry log line");
});

// --- 3. a non-id 400 is passed through, NOT retried --------------------------
const other400 = JSON.stringify({ error: { message: "Invalid 'input[1].content': array too long." } });
script = [{ status: 400, body: other400 }];
calls.length = 0;
res = await post(foreignBody());
check("unrelated 400: not retried", () => eq(calls.length, 1, "call count"));
check("unrelated 400: passed through with its own bytes", () => {
  eq(res.status, 400, "status");
  err(res).includes("array too long") || (() => { throw new Error(`body: ${res.body}`); })();
});
function err(r) { return String(r.body ?? ""); }

// --- 4. other upstreams keep their ids ---------------------------------------
// relaycat mints `item_...` itself: rewriting it there would corrupt a route that
// works today. Only agentrouter declares strictItemIds.
script = [{ status: 200, body: okBody }];
calls.length = 0;
res = await post(foreignBody("gpt-6-astra"), "/u/v1/responses");
check("relaycat (/u, gpt-6-astra): foreign-looking id is NOT touched", () => {
  const sent = JSON.parse(calls[0].body);
  eq(sent.input[1].id, "item_9c5b989663879ef37cb7082c", "id preserved verbatim");
});

script = [{ status: 200, body: okBody }];
calls.length = 0;
await post(foreignBody("gpt-5.4"), "/u/v1/responses");
check("relaycat built-in slug (/u): id untouched", () => {
  const sent = JSON.parse(calls[0].body);
  eq(sent.input[1].id, "item_9c5b989663879ef37cb7082c", "id preserved verbatim");
});

// --- 5. the fix survives a realistic replay (many types, mixed origins) ------
// A real Codex replay carries the whole preceding session: relaycat-minted
// `item_` ids next to agentrouter's own `rs_`/`msg_`/`fc_` ones. Only the foreign
// ones may go, and `call_id` must keep the tool results attached.
const mixed = {
  model: "gpt-6-astra-ar",
  stream: false,
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
    { type: "reasoning", id: "item_9c5b989663879ef37cb7082c", summary: [{ type: "summary_text", text: "foreign" }], encrypted_content: null },
    { type: "function_call", id: "item_d0f50abcbcc15aca86017ecc", call_id: "call_keep", name: "exec_command", arguments: "{\"cmd\":\"echo hi\"}" },
    { type: "function_call_output", id: "item_deadbeef", call_id: "call_keep", output: "hi" },
    { type: "reasoning", id: "rs_own_ok", summary: [], encrypted_content: "gAAAAAB_own" },
    { type: "message", id: "msg_own_ok", role: "assistant", content: [{ type: "output_text", text: "done" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "and again" }] },
  ],
};
script = [{ status: 200, body: okBody }];
calls.length = 0;
await post(mixed);
check("mixed replay: foreign ids dropped, own ids kept, links intact", () => {
  const sent = JSON.parse(calls[0].body);
  const [m0, r1, fc, fco, r4, m5] = sent.input;
  eq(sent.input.length, 7, "no item removed");
  eq(m0.id, undefined, "user message never had an id");
  eq(r1.id, undefined, "foreign reasoning id dropped");
  eq(r1.encrypted_content, undefined, "null blob stays absent");
  eq(r1.summary[0].text, "foreign", "reasoning summary preserved");
  eq(fc.id, undefined, "foreign function_call id dropped");
  eq(fc.call_id, "call_keep", "call linkage preserved");
  eq(fco.id, undefined, "foreign function_call_output id dropped");
  eq(fco.call_id, "call_keep", "tool result still attached");
  eq(r4.id, "rs_own_ok", "agentrouter's own reasoning id kept");
  eq(r4.encrypted_content, "gAAAAAB_own", "its blob kept with it");
  eq(m5.id, "msg_own_ok", "agentrouter's own message id kept");
});

// --- 6. GET requests are untouched -------------------------------------------
script = [{ status: 200, body: JSON.stringify({ object: "list", data: [] }) }];
calls.length = 0;
res = fakeRes();
await handler({ method: "GET", url: "/ar/v1/models", headers: {}, chunks: [] }, res);
check("GET /ar/v1/models: no body is invented", () => eq(calls[0].body, null, "no request body"));

out(`\n${failed ? `${failed} FAILED` : "all checks passed"}\n`);
if (failed) process.exitCode = 1;

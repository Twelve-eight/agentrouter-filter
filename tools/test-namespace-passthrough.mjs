// Regression test for the namespace-tool passthrough on `flattenNamespaceTools`
// routes (northstar-kiro today).
//
// Why this file exists (measured 2026-10-06/07): kiro silently drops Codex's
// namespace tool shape, so the gateway flattens `multi_agent_v1__spawn_agent`.
// The OUT half was present (tools flattened) but the history-replay half was
// missing: a replayed `{name:"spawn_agent", namespace:"multi_agent_v1"}` went
// upstream verbatim, the model read its own history and called the BARE name,
// and the bare name cannot be mapped back - Codex answered
//   unsupported call: spawn_agent
// for every attempt (13 occurrences in one session on 2026-10-06).
//
// What is pinned here, all through the REAL request handler (http stubbed):
//   1. OUT: a replayed namespaced call is renamed to the flat wire name before
//      the body leaves, while the original fields survive for the return path.
//   2. BACK: the upstream's flat call comes back as {name, namespace}.
//   3. SAFETY NET: even if the model emits the bare sub-tool name, the response
//      is restored to {name, namespace} - but ONLY when unambiguous.
//   4. AMBIGUITY: two namespaces owning the same sub-tool name are NOT guessed;
//      a bare call is left alone rather than attributed to the wrong namespace.
//   5. FLAT SHADOW: a real flat tool named like a sub-tool is never captured by
//      the safety net.
//   6. SPLIT HAZARD: namespace ids containing "__" (mcp__codex_app) resolve via
//      the map, not by splitting on the first separator.
//   7. NON-ADOPTERS: a route without flattenNamespaceTools keeps its namespace
//      tools and replayed calls untouched.
//
// NOTE: northstar-kiro dials through the local HTTP proxy, so the stub answers
// the CONNECT handshake and lets the https.request that follows be the recorded
// upstream call. Without that branch the handler waits forever (found the hard
// way: the first version of this test timed out).
//
// No port is bound and no real network call is made.
// Run: node tools/test-namespace-passthrough.mjs   (exits non-zero on failure)
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
  // Proxy branch: the gateway first issues CONNECT through http.request. Answer
  // with an immediate 200 + a fake socket; the https.request that follows is the
  // recorded upstream call below.
  if (opts && opts.method === "CONNECT") {
    const creq = new EventEmitter();
    creq.end = () => setImmediate(() => creq.emit("connect", { statusCode: 200 }, new EventEmitter()));
    creq.destroy = () => {};
    return creq;
  }
  const rec = { host: String(opts?.hostname ?? ""), path: String(opts?.path ?? ""), body: null, headers: opts?.headers ?? {} };
  const upstream = new EventEmitter();
  upstream.headers = { "content-type": (script[0] && script[0].contentType) || "application/json" };
  upstream.destroyed = false;
  upstream.destroy = () => { upstream.destroyed = true; };
  upstream.pipe = () => {};
  upstream.resume = () => {};
  const req = { on: () => req, write: (b) => { rec.body = String(b); }, end() {}, destroy() {} };
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
process.env.AR_USAGE_DIR = fs.mkdtempSync(path.join(testTmp, "test-namespace-passthrough-usage-"));

await import("../server.mjs");
out(`测试账本目录: ${process.env.AR_USAGE_DIR}\n\n`);

const fakeRes = () => ({
  headersSent: false, status: undefined, ended: false, body: null, headers: {}, _done: null,
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  writeHead(s) { this.headersSent = true; this.status = s; },
  end(b) { this.ended = true; if (b !== undefined) this.body = String(b); if (this._done) this._done(); },
  on() {}, destroy() {}, pipe() {}, write(b) { this.body = (this.body ?? "") + String(b); return true; },
});

async function post(body, url = "/u/v1/responses") {
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

const upstreamCall = (name, args = "{}") => JSON.stringify({
  id: "resp_1", object: "response", status: "completed",
  output: [{ type: "function_call", id: "fc_1", call_id: "toolu_bdrk_test1", name, arguments: args, status: "completed" }],
});

const spawnNs = (subs) => ({ type: "namespace", name: "multi_agent_v1", description: "sub-agents", tools: subs });
const spawnSub = { type: "function", name: "spawn_agent", description: "spawn", parameters: { type: "object", properties: { message: { type: "string" } } } };
const waitSub = { type: "function", name: "wait_agent", description: "wait", parameters: { type: "object", properties: {} } };

// --- 1. OUT: history replay is renamed; BACK: flat call gains namespace -------
script = [{ status: 200, body: upstreamCall("multi_agent_v1__spawn_agent") }];
calls.length = 0;
let res = await post({
  model: "ki:opus5.5", stream: false, instructions: "t",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "spawn one" }] },
    { type: "function_call", name: "spawn_agent", namespace: "multi_agent_v1", call_id: "toolu_bdrk_old", arguments: "{\"message\":\"go\"}" },
    { type: "function_call_output", call_id: "toolu_bdrk_old", output: "{\"agent_id\":\"x\"}" },
  ],
  tools: [spawnNs([spawnSub, waitSub])],
});
check("OUT: replayed call is renamed to the flat wire name", () => {
  const sent = JSON.parse(calls[0].body);
  eq(sent.input[1].name, "multi_agent_v1__spawn_agent", "replayed name");
});
check("OUT: tool list is flattened", () => {
  const sent = JSON.parse(calls[0].body);
  eq(sent.tools.length, 2, "flat tool count");
  eq(sent.tools[0].name, "multi_agent_v1__spawn_agent", "flat name");
});
check("BACK: flat call returns as {name, namespace}", () => {
  const j = JSON.parse(res.body);
  eq(j.output[0].name, "spawn_agent", "restored name");
  eq(j.output[0].namespace, "multi_agent_v1", "restored namespace");
});
check("the rename is logged", () => {
  if (!logs.some((l) => l.includes("namespace-tools") && l.includes("renamed 1 replayed call"))) {
    throw new Error("no rename log line");
  }
});

// --- 2. SAFETY NET: bare name from the upstream is restored ------------------
script = [{ status: 200, body: upstreamCall("spawn_agent") }];
calls.length = 0;
res = await post({
  model: "ki:opus5.5", stream: false, instructions: "t",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "spawn one" }] }],
  tools: [spawnNs([spawnSub, waitSub])],
});
check("SAFETY NET: bare upstream name is restored when unambiguous", () => {
  const j = JSON.parse(res.body);
  eq(j.output[0].name, "spawn_agent", "name");
  eq(j.output[0].namespace, "multi_agent_v1", "namespace");
});

// --- 3. AMBIGUITY: two namespaces owning the same name are not guessed -------
script = [{ status: 200, body: upstreamCall("spawn_agent") }];
calls.length = 0;
res = await post({
  model: "ki:opus5.5", stream: false, instructions: "t",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x" }] }],
  tools: [
    { type: "namespace", name: "ns_a", description: "a", tools: [spawnSub] },
    { type: "namespace", name: "ns_b", description: "b", tools: [{ type: "function", name: "spawn_agent", description: "spawn b", parameters: { type: "object", properties: {} } }] },
  ],
});
check("AMBIGUITY: a name owned by two namespaces is left untouched", () => {
  const j = JSON.parse(res.body);
  eq(j.output[0].name, "spawn_agent", "name kept");
  eq(j.output[0].namespace ?? null, null, "no namespace invented");
});

// --- 4. FLAT SHADOW: a real flat tool of the same name wins ------------------
script = [{ status: 200, body: upstreamCall("spawn_agent") }];
calls.length = 0;
res = await post({
  model: "ki:opus5.5", stream: false, instructions: "t",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x" }] }],
  tools: [
    spawnNs([waitSub]),
    { type: "function", name: "spawn_agent", description: "a real flat tool", parameters: { type: "object", properties: {} } },
  ],
});
check("FLAT SHADOW: the flat tool is never captured by the safety net", () => {
  const j = JSON.parse(res.body);
  eq(j.output[0].name, "spawn_agent", "name");
  eq(j.output[0].namespace ?? null, null, "no namespace invented");
});

// --- 5. SPLIT HAZARD: namespace ids containing "__" --------------------------
script = [{ status: 200, body: upstreamCall("mcp__codex_app__list_threads") }];
calls.length = 0;
res = await post({
  model: "ki:opus5.5", stream: false, instructions: "t",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x" }] }],
  tools: [{
    type: "namespace", name: "mcp__codex_app", description: "app tools",
    tools: [{ type: "function", name: "list_threads", description: "list", parameters: { type: "object", properties: {} } }],
  }],
});
check("SPLIT HAZARD: mcp__codex_app is resolved by the map, not by parsing", () => {
  const j = JSON.parse(res.body);
  eq(j.output[0].name, "list_threads", "name");
  eq(j.output[0].namespace, "mcp__codex_app", "namespace");
});

// --- 6. NON-ADOPTERS are untouched ------------------------------------------
// gpt-5.4 lives on relaycat, which does NOT declare flattenNamespaceTools.
// Logs accumulate across cases, so only lines written from here on count.
const nonAdopterLogStart = logs.length;
script = [{ status: 200, body: upstreamCall("spawn_agent") }];
calls.length = 0;
res = await post({
  model: "gpt-5.4", stream: false, instructions: "t",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "x" }] },
    { type: "function_call", name: "spawn_agent", namespace: "multi_agent_v1", call_id: "toolu_bdrk_old2", arguments: "{}" },
  ],
  tools: [spawnNs([spawnSub])],
});
check("NON-ADOPTER: namespace tools are sent verbatim", () => {
  const sent = JSON.parse(calls[0].body);
  eq(sent.tools[0].type, "namespace", "tool shape kept");
});
check("NON-ADOPTER: replayed call is untouched", () => {
  const sent = JSON.parse(calls[0].body);
  eq(sent.input[1].name, "spawn_agent", "name kept");
  eq(sent.input[1].namespace, "multi_agent_v1", "namespace kept");
});
check("NON-ADOPTER: no rename is logged", () => {
  if (logs.slice(nonAdopterLogStart).some((l) => l.includes("renamed") && l.includes("replayed call"))) {
    throw new Error("unexpected rename log");
  }
});

// --- 7. STREAMING: Codex always streams, so the SSE rewrite is the real path --
// The gateway must restore the name on every data: line (added / done / completed)
// without touching event: lines.
const sseLine = (obj) => "data: " + JSON.stringify(obj) + "\n";
const sseBody = [
  "event: response.output_item.added\n",
  sseLine({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "toolu_bdrk_s1", name: "multi_agent_v1__spawn_agent", arguments: "", status: "in_progress" }, sequence_number: 1 }),
  "event: response.output_item.done\n",
  sseLine({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "toolu_bdrk_s1", name: "multi_agent_v1__spawn_agent", arguments: "{}", status: "completed" }, sequence_number: 2 }),
  sseLine({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } }),
].join("");
script = [{ status: 200, body: sseBody, contentType: "text/event-stream" }];
calls.length = 0;
res = await post({
  model: "ki:opus5.5", stream: true, instructions: "t",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x" }] }],
  tools: [spawnNs([spawnSub])],
});
check("STREAMING: every data: line is rewritten to {name, namespace}", () => {
  const body = String(res.body ?? "");
  const dataLines = body.split("\n").filter((l) => l.startsWith("data:"));
  if (dataLines.length < 3) throw new Error("expected at least 3 data lines, got " + dataLines.length);
  for (const l of dataLines) {
    const j = JSON.parse(l.slice(5).trim());
    const item = j.item ?? (j.response?.output ?? []).find((o) => o.type === "function_call");
    if (j.type === "response.output_item.added" || j.type === "response.output_item.done") {
      eq(item.name, "spawn_agent", j.type + " name");
      eq(item.namespace, "multi_agent_v1", j.type + " namespace");
    }
  }
});
check("STREAMING: event: lines pass through untouched", () => {
  const body = String(res.body ?? "");
  if (!body.includes("event: response.output_item.added")) throw new Error("event line lost");
});

// --- 8. STREAMING + SAFETY NET: a bare name inside SSE is restored -----------
const bareSse = [
  sseLine({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_2", call_id: "toolu_bdrk_s2", name: "spawn_agent", arguments: "", status: "in_progress" }, sequence_number: 1 }),
  sseLine({ type: "response.completed", response: { id: "resp_2", status: "completed", output: [] } }),
].join("");
script = [{ status: 200, body: bareSse, contentType: "text/event-stream" }];
calls.length = 0;
res = await post({
  model: "ki:opus5.5", stream: true, instructions: "t",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x" }] }],
  tools: [spawnNs([spawnSub])],
});
check("STREAMING + SAFETY NET: bare name in SSE is restored", () => {
  const body = String(res.body ?? "");
  const added = body.split("\n").find((l) => l.startsWith("data:") && l.includes("output_item.added"));
  if (!added) throw new Error("no added line");
  const j = JSON.parse(added.slice(5).trim());
  eq(j.item.name, "spawn_agent", "name");
  eq(j.item.namespace, "multi_agent_v1", "namespace");
});

out(failed ? `\n${failed} check(s) FAILED\n` : "\nall checks passed\n");
process.exitCode = failed ? 1 : 0;

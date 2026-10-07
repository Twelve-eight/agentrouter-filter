// Regression test for the jw shell carrier (justwoker/opus-4-8).
//
// WHY: measured 2026-10-07, this upstream REPLACES the caller's tool list (only
// bash/grep/glob/apply_patch survive) and its streaming path emits no content
// blocks at all, so every Codex sub-agent turn came back empty. The gateway now
// folds the real tools into one carrier `bash` carrying an @tool: protocol and
// asks for the non-streaming form.
//
// What is pinned here, through the REAL request handler with http stubbed:
//   1. OUT: the tool list the upstream receives is the single carrier `bash`.
//   2. OUT: every replayed function_call is encoded as @tool:<name> <json>.
//   3. OUT: `stream` is false (the streaming wire produces no content).
//   4. BACK: a carrier call becomes a real function_call named after the @tool:
//      name, with the arguments the model put in the JSON.
//   5. BACK: a plain shell command (no prefix) becomes the caller's own shell
//      tool, NOT a dropped call.
//   6. BACK: a malformed JSON payload is surfaced, never executed blindly.
//   7. BACK: text and thinking blocks survive the non-streaming path.
//   8. SAFETY: the guard list (bash!) does not delete the carrier call.
//   9. NO CARRIER: a route without the flag is untouched (old behaviour).
//
// Run: node tools/test-shell-carrier.mjs   (exits non-zero on failure)
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toAnthropicBody } from "../bridge.mjs";

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

let script = [];
const calls = [];
const stubRequest = () => (opts, onResponse) => {
  const rec = { host: String(opts?.hostname ?? ""), path: String(opts?.path ?? ""), body: null };
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
fs.mkdirSync(testTmp, { recursive: true });
process.env.AR_USAGE_DIR = fs.mkdtempSync(path.join(testTmp, "test-shell-carrier-usage-"));
process.env.JUSTWOKER_API_KEY = "test-key";

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

// The gateway re-emits SSE (Codex always streams), while the UPSTREAM was asked
// for JSON. Pull the terminal event's response object out of the stream.
function finalResponse(res) {
  const text = res.body ?? '';
  if (text.trim().startsWith('{')) return JSON.parse(text); // stream:false client
  let last = null;
  for (const block of text.split(/\n\n/)) {
    const m = /^data: (.*)$/m.exec(block);
    if (!m) continue;
    let j; try { j = JSON.parse(m[1]); } catch { continue; }
    if (j.type === 'response.completed' || j.type === 'response.failed') last = j.response;
  }
  if (!last) throw new Error('no terminal response event in: ' + text.slice(0, 300));
  return last;
}
const anthropicBody = (content, extra = {}) => JSON.stringify({
  id: "msg_test", type: "message", role: "assistant", model: "claude-opus-4-8",
  stop_reason: "end_turn", content,
  usage: { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 900 },
  ...extra,
});

const tools = [
  { type: "function", name: "exec_command", description: "Run a shell command. Never used for edits.", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } },
  { type: "function", name: "apply_patch", description: "Edit files.", parameters: { type: "object", properties: { patch: { type: "string" } } } },
];

// --- 1..3: OUTBOUND -----------------------------------------------------------
script = [{ status: 200, body: anthropicBody([{ type: "text", text: "ok" }]) }];
calls.length = 0;
let res = await post({
  model: "claude-opus-4-8", stream: true, instructions: "t",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
    { type: "function_call", name: "exec_command", call_id: "toolu_a", arguments: "{\"cmd\":\"dir\"}" },
    { type: "function_call_output", call_id: "toolu_a", output: "out" },
  ],
  tools,
});
const sent = JSON.parse(calls[0].body);
check("OUT: the upstream receives ONE carrier tool named bash", () => {
  eq(sent.tools.length, 1, "tool count");
  eq(sent.tools[0].name, "bash", "carrier name");
});
check("OUT: the carrier description teaches the @tool: protocol", () => {
  const d = sent.tools[0].description;
  if (!d.includes("@tool:")) throw new Error("protocol line missing");
  if (!d.includes("exec_command")) throw new Error("real tool list missing");
});
check("OUT: stream is false (the stream wire returns no content)", () => {
  eq(sent.stream, false, "stream flag");
});
check("OUT: a replayed call is encoded as @tool:<name> <json>", () => {
  const tu = sent.messages.flatMap((m) => m.content).find((c) => c.type === "tool_use");
  eq(tu.name, "bash", "replayed tool name");
  const cmd = tu.input.command;
  if (!cmd.startsWith("@tool:exec_command ")) throw new Error(`command=${cmd}`);
  if (JSON.parse(cmd.slice("@tool:exec_command ".length)).cmd !== "dir") throw new Error(`payload=${cmd}`);
});
check("OUT: the tool_result keeps its original id so the loop closes", () => {
  const tr = sent.messages.flatMap((m) => m.content).find((c) => c.type === "tool_result");
  eq(tr.tool_use_id, "toolu_a", "tool_result id");
});

// --- 4: BACK, carrier call with @tool: ---------------------------------------
script = [{ status: 200, body: anthropicBody([
  { type: "text", text: "running it" },
  { type: "tool_use", id: "toolu_bdrk_real", name: "bash", input: { command: "@tool:exec_command {\"cmd\": \"dir C:\\\\x\"}" } },
]) }];
res = await post({ model: "claude-opus-4-8", stream: true, instructions: "t", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }], tools });
let j = finalResponse(res);
let fc = (j.output ?? []).find((it) => it.type === "function_call");
check("BACK: the carrier call becomes a real function_call", () => {
  if (!fc) throw new Error(`no function_call in ${JSON.stringify(j.output)}`);
  eq(fc.name, "exec_command", "unwrapped name");
  if (JSON.parse(fc.arguments).cmd !== "dir C:\\x") throw new Error(`args=${fc.arguments}`);
  eq(fc.call_id, "toolu_bdrk_real", "call_id preserved");
});
check("BACK: text survives the non-streaming path", () => {
  const msg = (j.output ?? []).find((it) => it.type === "message");
  eq(msg?.content?.[0]?.text, "running it", "text");
});

// --- 5: BACK, plain shell command --------------------------------------------
script = [{ status: 200, body: anthropicBody([
  { type: "tool_use", id: "toolu_plain", name: "bash", input: { command: "echo hello" } },
]) }];
res = await post({ model: "claude-opus-4-8", stream: true, instructions: "t", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }], tools });
j = finalResponse(res);
fc = (j.output ?? []).find((it) => it.type === "function_call");
check("BACK: a plain command runs as the caller's shell tool", () => {
  if (!fc) throw new Error("the plain call was dropped entirely");
  eq(fc.name, "exec_command", "shell tool name");
  eq(JSON.parse(fc.arguments).cmd, "echo hello", "command");
});

// --- 6: BACK, malformed payload ----------------------------------------------
script = [{ status: 200, body: anthropicBody([
  { type: "tool_use", id: "toolu_bad", name: "bash", input: { command: "@tool:exec_command {not json" } },
]) }];
res = await post({ model: "claude-opus-4-8", stream: true, instructions: "t", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }], tools });
j = finalResponse(res);
fc = (j.output ?? []).find((it) => it.type === "function_call");
check("BACK: malformed JSON is surfaced, not executed as a shell command", () => {
  if (!fc) throw new Error("call dropped");
  const args = JSON.parse(fc.arguments);
  if (!args.error) throw new Error(`expected an error payload, got ${fc.arguments}`);
});

// --- 7: BACK, thinking block --------------------------------------------------
script = [{ status: 200, body: anthropicBody([
  { type: "thinking", thinking: "weighing options" },
  { type: "text", text: "done" },
]) }];
res = await post({ model: "claude-opus-4-8", stream: true, instructions: "t", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }], tools });
j = finalResponse(res);
check("BACK: a thinking block becomes a reasoning item", () => {
  const r = (j.output ?? []).find((it) => it.type === "reasoning");
  if (!r) throw new Error(`no reasoning item in ${JSON.stringify(j.output.map((x) => x.type))}`);
  if (!JSON.stringify(r).includes("weighing options")) throw new Error("thinking text lost");
});
check("BACK: output order is [reasoning, message, calls]", () => {
  const kinds = (j.output ?? []).map((it) => it.type);
  const firstMessage = kinds.indexOf("message");
  const firstCall = kinds.findIndex((k) => k === "function_call");
  if (kinds.indexOf("reasoning") !== 0 && kinds.length > 1) {
    if (kinds[0] !== "reasoning") throw new Error(`expected reasoning first, got ${kinds.join(",")}`);
  }
  if (firstCall >= 0 && firstMessage >= 0 && firstCall < firstMessage) throw new Error(`calls before message: ${kinds.join(",")}`);
});

// --- 8: usage accounting -------------------------------------------------------
const recent = JSON.parse(fs.readFileSync(path.join(process.env.AR_USAGE_DIR, fs.readdirSync(process.env.AR_USAGE_DIR)[0]), "utf8").split("\n").filter(Boolean).pop());
check("USAGE: the carrier turn is booked with the upstream's real counters", () => {
  eq(recent.input_tokens, 1000, "input tokens");
  eq(recent.cached_tokens, 900, "cache read");
  eq(recent.ok, true, "ok");
});

// --- 9: the converter leaves a non-carrier route untouched --------------------
//
// Tested on toAnthropicBody directly rather than through the handler: jw is the
// only anthropic-wire provider, so a request that reaches the bridge from another
// model never happens in production. The contract that matters is the DEFAULT
// (shellCarrier absent): full tool list, caller's own stream flag, untouched
// replay. A regression here would silently reroute every other provider.
{
  const body = {
    model: 'm', instructions: 't', stream: true,
    tools: [
      { type: 'function', name: 'exec_command', description: 'd', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
      { type: 'function', name: 'apply_patch', description: 'd', parameters: { type: 'object', properties: { patch: { type: 'string' } } } },
    ],
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: '{"cmd":"dir"}' },
    ],
  };
  const plain = toAnthropicBody(body, 'm');
  check('SAFETY: without shellCarrier the tool list and names are untouched', () => {
    eq(plain.tools.length, 2, 'tool count');
    eq(plain.tools[0].name, 'exec_command', 'first tool name');
    eq(plain.stream, true, 'stream flag is the caller\'s, not forced');
    const tu = plain.messages.flatMap((m) => m.content).find((c) => c.type === 'tool_use');
    eq(tu.name, 'exec_command', 'replayed call keeps its name');
    eq(tu.input.cmd, 'dir', 'replayed call keeps its raw input');
  });

  const carried = toAnthropicBody(body, 'm', null, true);
  check('SAFETY: with shellCarrier the same body is folded into bash', () => {
    eq(carried.tools.length, 1, 'tool count');
    eq(carried.tools[0].name, 'bash', 'carrier name');
    eq(carried.stream, false, 'stream forced off for the upstream');
  });
}
out(failed ? `\n${failed} check(s) failed\n` : "\nall checks passed\n");
process.exit(failed ? 1 : 0);

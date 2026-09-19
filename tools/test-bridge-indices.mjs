// Regression test for the bridge's output_index collision.
//
// Trigger: the chat upstream streams `content` BEFORE `tool_calls` (a preamble
// then a tool call). The old code used `output.length` for every emitted index,
// but items are only pushed to `output` at close/finish time - so the message
// and the function_call both got output_index 0, and the call's `done` event
// even landed on index 1 after the message was closed. Codex drops such a stream.
//
// This test fakes a chat upstream with that exact shape and asserts every
// emitted output_index is distinct and consistent between added/done.
import http from "node:http";
import { spawn } from "node:child_process";

const ECHO_PORT = 7896;
const GW_PORT = 7876;

// Fake chat upstream: content delta first, then a tool call, then [DONE].
const upstream = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");
  send({ choices: [{ index: 0, delta: { role: "assistant", content: "Let me check. " } }] });
  send({ choices: [{ index: 0, delta: { content: "Calling the tool." } }] });
  send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "read_file", arguments: '{"path":' } }] } }] });
  send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"AGENTS.md"}' } }] } }] });
  send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  res.write("data: [DONE]\n\n");
  res.end();
});
await new Promise((r) => upstream.listen(ECHO_PORT, "127.0.0.1", r));

const gw = spawn(process.execPath, ["G:/omp works/Tools/agentrouter-filter/server.mjs"], {
  env: { ...process.env, AR_GATEWAY_PORT: String(GW_PORT), AR_UPSTREAM_WB: `http://127.0.0.1:${ECHO_PORT}` },
  stdio: ["ignore", "pipe", "pipe"],
});
await new Promise((r) => setTimeout(r, 1200));

const body = JSON.stringify({
  model: "global:deepseek-v4.1-flash",
  instructions: "You are a coding agent.",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "read AGENTS.md" }] }],
  tools: [{ type: "function", name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }],
  tool_choice: "auto",
  stream: true,
  prompt_cache_key: "idx-test",
});

const res = await fetch(`http://127.0.0.1:${GW_PORT}/wb/v1/responses`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer x", originator: "codex_exec" },
  body,
});
const text = await res.text();
gw.kill();
upstream.close();

// Collect every (event, output_index) pair plus the item type it refers to.
const events = [];
for (const block of text.split("\n\n")) {
  const ev = block.match(/^event: (\S+)/m)?.[1];
  const data = block.match(/^data: (.*)$/m)?.[1];
  if (!ev || !data) continue;
  let j;
  try { j = JSON.parse(data); } catch { continue; }
  if (j.output_index !== undefined) events.push({ ev, idx: j.output_index, item: j.item?.type ?? null });
}

console.log("--- emitted output_index by event ---");
for (const e of events) console.log(`  ${e.ev.padEnd(38)} index=${e.idx} item=${e.item ?? ""}`);

// added indices must be unique
const added = events.filter((e) => e.ev === "response.output_item.added");
const addedIdx = added.map((e) => e.idx);
const unique = new Set(addedIdx).size === addedIdx.length;

// every done index must match the added index of the same item type
const done = events.filter((e) => e.ev === "response.output_item.done");
const doneIdx = done.map((e) => e.idx);
const match = JSON.stringify(addedIdx) === JSON.stringify(doneIdx);

const completed = /response\.completed/.test(text);
const outputItems = (() => {
  const m = text.match(/"type":"response\.completed".*?"output":(\[.*?\]),"usage"/s);
  if (!m) return null;
  try { return JSON.parse(m[1]).map((x) => `${x.type}@${x.id ?? ""}`); } catch { return null; }
})();

console.log("\nadded indices      :", addedIdx.join(","));
console.log("done indices       :", doneIdx.join(","));
console.log("unique added       :", unique);
console.log("added==done order  :", match);
console.log("response.completed :", completed);
console.log("output[] items     :", outputItems ? outputItems.join(", ") : "(unparsed)");

const pass = unique && match && completed;
console.log("\n" + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);

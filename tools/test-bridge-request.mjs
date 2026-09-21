// Tests for the REQUEST direction (responses -> chat): toChatMessages/toChatBody.
//
// Why this file exists: tools/test-bridge-indices.mjs only covers the RESPONSE
// direction (bridgeChatStream). Both wb2api bugs lived on the untested side:
//   1. parallel function_calls were emitted as one assistant message each, giving
//      A{c1} A{c2} A{c3} T(c1) T(c2) T(c3) - upstream code 11148
//      "tool calls and tool results do not match";
//   2. reasoning items were dropped entirely, so DeepSeek's thinking mode
//      rejected the follow-up turn with code 11155 "the reasoning content from
//      the previous turn must be passed back in thinking mode".
// wb2api reports both as the misleading 503 "all accounts are temporarily
// unavailable", so a passing PONG probe (msgs=2 tools=0) proves nothing here.
//
// The shapes below are copied from a real codex session
// (rollout-2026-09-21T09-51-10-...jsonl): 73 reasoning, 121 function_call,
// 121 function_call_output.
import assert from "node:assert";
import { toChatMessages, toChatBody } from "../bridge.mjs";

let pass = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
}

const call = (id, name) => ({ type: "function_call", call_id: id, name, arguments: "{}" });
const out = (id) => ({ type: "function_call_output", call_id: id, output: "ok" });
const reasoning = (text) => ({ type: "reasoning", id: "rs_1", summary: [], content: [{ type: "reasoning_text", text }] });

// --- parallel tool calls must merge into ONE assistant turn -------------------
check("3 parallel calls -> 1 assistant with 3 tool_calls, then 3 tool msgs", () => {
  const msgs = toChatMessages({
    input: [call("c1", "exec"), call("c2", "list"), call("c3", "templates"), out("c1"), out("c2"), out("c3")],
  });
  const body = msgs.filter((m) => m.role !== "system");
  const assistants = body.filter((m) => m.role === "assistant");
  assert.strictEqual(assistants.length, 1, `expected 1 assistant, got ${assistants.length}`);
  assert.strictEqual(assistants[0].tool_calls.length, 3, "assistant must carry all 3 tool_calls");
  assert.deepStrictEqual(
    assistants[0].tool_calls.map((t) => t.id),
    ["c1", "c2", "c3"],
  );
  const tools = body.filter((m) => m.role === "tool");
  assert.strictEqual(tools.length, 3, "each result is its own tool message");
  // order: assistant before every tool result
  const ai = body.indexOf(assistants[0]);
  for (const t of tools) assert.ok(body.indexOf(t) > ai, "tool results must follow the assistant turn");
});

check("separate turns stay separate (calls split by a user message)", () => {
  const msgs = toChatMessages({
    input: [
      call("c1", "a"),
      out("c1"),
      { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
      call("c2", "b"),
      out("c2"),
    ],
  });
  const assistants = msgs.filter((m) => m.role === "assistant");
  assert.strictEqual(assistants.length, 2, "a user turn must break the merge");
  assert.strictEqual(assistants[0].tool_calls.length, 1);
  assert.strictEqual(assistants[1].tool_calls.length, 1);
});

// --- reasoning must survive into the chat request -----------------------------
check("reasoning is attached as reasoning_content on the following assistant", () => {
  const msgs = toChatMessages({
    input: [reasoning("I will inspect the repo"), call("c1", "exec"), out("c1")],
  });
  const assistant = msgs.find((m) => m.role === "assistant");
  assert.ok(assistant, "assistant message missing");
  assert.strictEqual(assistant.reasoning_content, "I will inspect the repo");
});

check("reasoning is not emitted as its own message", () => {
  const msgs = toChatMessages({ input: [reasoning("thinking"), call("c1", "x"), out("c1")] });
  assert.ok(
    !msgs.some((m) => m.role === "reasoning"),
    "reasoning must ride on the assistant message, not stand alone",
  );
});

check("every assistant carrying tool_calls in a real-shaped turn has reasoning", () => {
  // mirrors the real session: reasoning, then a parallel batch, repeatedly
  const input = [];
  for (let i = 0; i < 3; i++) {
    input.push(reasoning(`step ${i}`));
    input.push(call(`a${i}`, "exec"), call(`b${i}`, "list"));
    input.push(out(`a${i}`), out(`b${i}`));
  }
  const msgs = toChatMessages({ input });
  const assistants = msgs.filter((m) => m.role === "assistant");
  assert.strictEqual(assistants.length, 3, `expected 3 assistant turns, got ${assistants.length}`);
  for (const [i, a] of assistants.entries()) {
    assert.strictEqual(a.reasoning_content, `step ${i}`, `turn ${i} lost its reasoning`);
    assert.strictEqual(a.tool_calls.length, 2, `turn ${i} must merge both calls`);
  }
});

// --- the surrounding contract still holds -------------------------------------
check("first message is always system (wb2api requires it)", () => {
  const msgs = toChatMessages({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] });
  assert.strictEqual(msgs[0].role, "system");
});

check("tool_call ids and arguments are preserved verbatim", () => {
  const msgs = toChatMessages({
    input: [
      { type: "function_call", call_id: "call_abc", name: "read", arguments: '{"path":"a b"}' },
      out("call_abc"),
    ],
  });
  const a = msgs.find((m) => m.role === "assistant");
  assert.strictEqual(a.tool_calls[0].id, "call_abc");
  assert.strictEqual(a.tool_calls[0].function.name, "read");
  assert.strictEqual(a.tool_calls[0].function.arguments, '{"path":"a b"}');
  const t = msgs.find((m) => m.role === "tool");
  assert.strictEqual(t.tool_call_id, "call_abc");
});


// --- response direction: reasoning must be emitted BEFORE the tool calls --------
// Codex records items in stream order and replays them; a real session shows
// `reasoning` immediately before `function_call`. Emitting reasoning at finish()
// put it after the calls, so the replayed assistant turn had no
// reasoning_content and DeepSeek rejected it (code 11155).
import { Readable } from "node:stream";
import { bridgeChatStream } from "../bridge.mjs";

function runStream(chunks, stream = true) {
  const out = [];
  let body = null;
  const res = { writeHead() {}, write(s) { out.push(s); }, end(s) { if (s) body = s; } };
  bridgeChatStream(Readable.from(chunks), res, "m", "max", stream, null);
  return new Promise((r) => setTimeout(() => r({ text: out.join(""), body }), 60));
}

const RC_CHUNKS = [
  'data: {"choices":[{"delta":{"reasoning_content":"think first"}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"exec","arguments":"{}"}}]}}]}\n\n',
  'data: [DONE]\n\n',
];

await (async () => {
  const { text } = await runStream(RC_CHUNKS);
  check("streaming: reasoning output_index precedes function_call", () => {
    const order = [...text.matchAll(/"output_index":(\d+),"item":\{"type":"([a-z_]+)"/g)].map((m) => m[2] + "#" + m[1]);
    assert.ok(order.length >= 2, "expected at least two items, got " + order.length);
    assert.strictEqual(order[0], "reasoning#0", "reasoning must open first, got " + order.join(" -> "));
    assert.ok(order.some((o) => o.startsWith("function_call")), "function_call missing");
  });

  const { body } = await runStream(RC_CHUNKS, false);
  check("non-streaming: output is [reasoning, ..] with the text preserved", () => {
    const j = JSON.parse(body);
    const types = j.output.map((o) => o.type);
    assert.strictEqual(types[0], "reasoning", "reasoning must come first, got " + types.join(","));
    assert.strictEqual(j.output[0].content[0].text, "think first");
  });

  const { text: noRc } = await runStream([
    'data: {"choices":[{"delta":{"content":"plain"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  check("no reasoning upstream -> no reasoning item emitted", () => {
    assert.ok(!/"type":"reasoning"/.test(noRc), "must not invent a reasoning item");
  });
})();

console.log(pass ? `\n${pass} checks passed` : "\nno checks ran");

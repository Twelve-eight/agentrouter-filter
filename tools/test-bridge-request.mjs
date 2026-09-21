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

// --- anthropic wire (justwoker) -----------------------------------------------
// The anthropic bridge has its own request shape and its own SSE dialect, so the
// chat-side checks above prove nothing about it. Both bugs these guard against
// are silent: a mis-shaped request is a 400 from the upstream, and a mis-ordered
// stream makes codex drop the turn (observed as repeated identical resends)
// rather than error.
import { toAnthropicBody, bridgeAnthropicStream } from "../bridge.mjs";

check("anthropic: system is top-level, not a message", () => {
  const b = toAnthropicBody(
    { instructions: "be terse", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] },
    "claude-opus-4-8",
  );
  assert.strictEqual(b.system, "be terse");
  assert.ok(!b.messages.some((m) => m.role === "system"), "system must not appear as a message");
  assert.strictEqual(b.messages[0].role, "user");
});

check("anthropic: tools use input_schema and tool_choice is an object", () => {
  const b = toAnthropicBody(
    {
      instructions: "x",
      tool_choice: "required",
      tools: [{ type: "function", name: "f", description: "d", parameters: { type: "object", properties: {} } }],
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    },
    "m",
  );
  assert.strictEqual(b.tools[0].input_schema.type, "object");
  assert.strictEqual(b.tools[0].function, undefined, "must not carry the chat-style `function` wrapper");
  assert.deepStrictEqual(b.tool_choice, { type: "any" });
});

check("anthropic: parallel calls collapse into ONE assistant, results into ONE user", () => {
  const b = toAnthropicBody(
    {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "do both" }] },
        call("c1", "exec"),
        call("c2", "list"),
        out("c1"),
        out("c2"),
      ],
    },
    "m",
  );
  const assistants = b.messages.filter((m) => m.role === "assistant");
  assert.strictEqual(assistants.length, 1, `expected 1 assistant, got ${assistants.length}`);
  assert.deepStrictEqual(assistants[0].content.map((c) => c.type), ["tool_use", "tool_use"]);
  const users = b.messages.filter((m) => m.role === "user");
  assert.strictEqual(users.length, 2, "the prompt turn plus ONE tool_result turn");
  assert.deepStrictEqual(users[1].content.map((c) => c.type), ["tool_result", "tool_result"]);
  // alternating roles is what the wire requires
  const roles = b.messages.map((m) => m.role);
  for (let i = 1; i < roles.length; i++) {
    assert.notStrictEqual(roles[i], roles[i - 1], `roles must alternate, got ${roles.join(",")}`);
  }
});

check("anthropic: reasoning is dropped, not sent as an unsigned thinking block", () => {
  const b = toAnthropicBody(
    {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        reasoning("I should call the tool"),
        call("c1", "exec"),
        out("c1"),
      ],
    },
    "m",
  );
  const flat = JSON.stringify(b.messages);
  assert.ok(!/thinking/.test(flat), "a thinking block without a signature is rejected upstream");
  assert.ok(!/I should call the tool/.test(flat), "reasoning text must not leak into a text block");
});

check("anthropic: tool arguments string is parsed into input", () => {
  const b = toAnthropicBody(
    {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "function_call", call_id: "c1", name: "f", arguments: '{"city":"Paris"}' },
      ],
    },
    "m",
  );
  const tu = b.messages.flatMap((m) => m.content).find((c) => c.type === "tool_use");
  assert.ok(tu, "tool_use block missing");
  assert.deepStrictEqual(tu.input, { city: "Paris" });
  assert.strictEqual(tu.id, "c1");
});

function runAnthropic(chunks, stream = true) {
  const out = [];
  let body = null;
  const res = { writeHead() {}, write(s) { out.push(s); }, end(s) { if (s) body = s; } };
  bridgeAnthropicStream(Readable.from(chunks), res, "m", stream, null);
  return new Promise((r) => setTimeout(() => r({ text: out.join(""), body }), 60));
}

const AN_CHUNKS = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0}}}\n\n',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"consider this"}}\n\n',
  'data: {"type":"content_block_stop","index":0}\n\n',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hello"}}\n\n',
  'data: {"type":"content_block_stop","index":1}\n\n',
  'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_9","name":"get_weather","input":{}}}\n\n',
  'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Par"}}\n\n',
  'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"is\\"}"}}\n\n',
  'data: {"type":"content_block_stop","index":2}\n\n',
  'data: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
  'data: {"type":"message_stop"}\n\n',
];

await (async () => {
  const { text } = await runAnthropic(AN_CHUNKS);
  check("anthropic streaming: reasoning opens before message and function_call", () => {
    const order = [...text.matchAll(/"output_index":(\d+),"item":\{"type":"([a-z_]+)"/g)].map((m) => m[2] + "#" + m[1]);
    assert.strictEqual(order[0], "reasoning#0", "reasoning must claim index 0, got " + order.join(" -> "));
    assert.strictEqual(order[1], "message#1", "message must follow reasoning, got " + order.join(" -> "));
    assert.strictEqual(order[2], "function_call#2", "function_call must follow the message, got " + order.join(" -> "));
  });

  check("anthropic streaming: tool input fragments are reassembled", () => {
    const done = [...text.matchAll(/data: (\{"type":"response\.function_call_arguments\.done".*?\})\n\n/g)];
    assert.strictEqual(done.length, 1, "expected exactly one arguments.done event");
    assert.strictEqual(JSON.parse(done[0][1]).arguments, '{"city":"Paris"}');
  });

  check("anthropic streaming: usage maps input+output tokens", () => {
    const m = text.match(/data: (\{"type":"response\.completed".*?\})\n\n/s);
    assert.ok(m, "response.completed missing");
    const u = JSON.parse(m[1]).response.usage;
    assert.strictEqual(u.input_tokens, 11);
    assert.strictEqual(u.output_tokens, 7);
    assert.strictEqual(u.total_tokens, 18);
  });

  const { body } = await runAnthropic(AN_CHUNKS, false);
  check("anthropic non-streaming: JSON body with the same item order", () => {
    const j = JSON.parse(body);
    assert.strictEqual(j.status, "completed");
    const types = j.output.map((o) => o.type);
    assert.deepStrictEqual(types, ["reasoning", "message", "function_call"], "got " + types.join(","));
    assert.strictEqual(j.output[1].content[0].text, "hello");
    assert.strictEqual(j.output[2].name, "get_weather");
  });
})();

console.log(pass ? `\n${pass} checks passed` : "\nno checks ran");

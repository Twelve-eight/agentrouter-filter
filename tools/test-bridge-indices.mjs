// Deterministic regression test for the bridge's output_index handling.
//
// Why in-process: a live tool turn only reaches the buggy path when the model
// happens to emit a content preamble BEFORE its tool_calls. Driving
// bridgeChatStream directly with a synthetic chat SSE stream (one content chunk,
// then tool_call chunks) plus a recording `res` exercises exactly those lines on
// every run.
//
// Bug being guarded: every emitted output_index used `output.length`, but items
// were only appended to the output array at close/finish time. The preamble
// response therefore emitted
//   added message@0, added function_call@0, done message@0, done function_call@1
// i.e. a duplicate index plus an added/done mismatch, which makes codex drop the
// stream and resend the identical request body.
import { Readable } from "node:stream";
import { bridgeChatStream } from "../server.mjs";

// A fake chat-completions SSE upstream: content first, then a tool call.
function fakeUpstream() {
  const frames = [
    { choices: [{ index: 0, delta: { role: "assistant", content: "Let me check. " } }] },
    { choices: [{ index: 0, delta: { content: "Calling the tool." } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "read_file", arguments: '{"path":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"AGENTS.md"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ];
  const payload = frames.map((f) => "data: " + JSON.stringify(f) + "\n\n").join("") + "data: [DONE]\n\n";
  return Readable.from([Buffer.from(payload, "utf8")]);
}

// Recording `res` that captures every sse() write.
function recordingRes() {
  const writes = [];
  return {
    writes,
    writeHead() {},
    write(chunk) {
      const block = String(chunk);
      const ev = block.match(/^event: (\S+)/m)?.[1];
      const data = block.match(/^data: (.*)$/m)?.[1];
      if (!ev || !data) return true;
      let j;
      try { j = JSON.parse(data); } catch { return true; }
      writes.push({ ev, j });
      return true;
    },
    end() {},
  };
}

const res = recordingRes();
bridgeChatStream(fakeUpstream(), res, "global:deepseek-v4.1-flash", "low");

// bridgeChatStream finishes synchronously for a Readable.from(...) source, but
// allow a tick in case the stream is paused/resumed internally.
await new Promise((r) => setTimeout(r, 50));

const events = res.writes.filter((w) => w.j.output_index !== undefined);
console.log("--- emitted output_index by event ---");
for (const e of events) console.log(`  ${e.ev.padEnd(38)} index=${e.j.output_index} item=${e.j.item?.type ?? ""}`);

const added = events.filter((e) => e.ev === "response.output_item.added");
const done = events.filter((e) => e.ev === "response.output_item.done");
const addedIdx = added.map((e) => e.j.output_index);
const doneIdx = done.map((e) => e.j.output_index);

const unique = new Set(addedIdx).size === addedIdx.length;
const monotonic = addedIdx.every((v, i) => i === 0 || v > addedIdx[i - 1]);
const orderMatch = JSON.stringify(addedIdx) === JSON.stringify(doneIdx);

const completed = res.writes.find((w) => w.ev === "response.completed");
const outputTypes = completed ? completed.j.response.output.map((o) => `${o.type}@${o.id}`) : [];
// output[] must be ordered by index: message (index 0) before function_call (1).
const outputOrdered = completed
  ? completed.j.response.output.length === addedIdx.length &&
    completed.j.response.output[0].type === "message" &&
    completed.j.response.output[1].type === "function_call"
  : false;

// The message must keep index 0 throughout and the call index 1 throughout.
const msgIdx = new Set(events.filter((e) => e.j.item_id === added[0]?.j.item.id).map((e) => e.j.output_index));
const callItemId = added.find((e) => e.j.item?.type === "function_call")?.j.item.id;
const callIdx = new Set(events.filter((e) => e.j.item_id === callItemId).map((e) => e.j.output_index));

console.log("\nadded indices       :", addedIdx.join(","));
console.log("done indices        :", doneIdx.join(","));
console.log("unique added        :", unique);
console.log("monotonic added     :", monotonic);
console.log("added == done order :", orderMatch);
console.log("message indices     :", [...msgIdx].join(","));
console.log("function_call indices:", [...callIdx].join(","));
console.log("response.completed  :", Boolean(completed));
console.log("output[] order      :", outputTypes.join(", "), "| ordered:", outputOrdered);

const pass =
  unique && monotonic && orderMatch && Boolean(completed) && outputOrdered &&
  msgIdx.size === 1 && callIdx.size === 1 && [...msgIdx][0] !== [...callIdx][0];

console.log("\n" + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);

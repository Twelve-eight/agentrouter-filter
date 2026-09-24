// Regression test: a chat-SSE upstream that delivers a COMPLETE answer and then
// drops the connection rudely (no clean end) must still produce a completed turn.
//
// Why this file exists: motomoto.lol (a New-API relay) sends the entire SSE body
// - including `data: [DONE]` and a real completion ("Hi") plus usage - and then
// aborts the socket. Measured 2026-09-24 with a raw client: outcome=aborted after
// 164s, all 5 SSE lines present, `[DONE]` present. bridgeChatStream treated that
// abort as a failure, so the caller got
//   {"status":"failed","error":{"code":"upstream_error","message":"upstream stream aborted"}}
// and a 502 even though the answer had fully arrived.
//
// The rule pinned here, and its boundary:
//   * disconnect AFTER a completion signal (`[DONE]` or finish_reason
//     stop/tool_calls/function_call)  -> completed turn (the answer is kept);
//   * disconnect BEFORE any signal -> still a failure (this is the case the
//     handler exists for; swallowing it would hide a truncated stream).
//
// Run: node tools/test-bridge-rude-close.mjs   (exits non-zero on failure)
import { Readable } from "node:stream";
import { bridgeChatStream } from "../bridge.mjs";

let pass = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok    ${name}`); }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}

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
      let j; try { j = JSON.parse(data); } catch { return true; }
      writes.push({ ev, j });
      return true;
    },
    end() {},
  };
}

const frames = (finishReason, content) => [
  { choices: [{ index: 0, delta: { role: "assistant" } }] },
  { choices: [{ index: 0, delta: { content } }] },
  { choices: [{ index: 0, delta: { content: "" }, finish_reason: finishReason }], usage: { prompt_tokens: 22, completion_tokens: 5, total_tokens: 27 } },
];
const sseText = (fs2) => fs2.map((f) => "data: " + JSON.stringify(f) + "\n\n").join("");

/**
 * An upstream that emits `payload` then destroys its socket instead of ending
 * cleanly - exactly what motomoto does. `Readable.from` cannot express this, so
 * the stream is driven by hand.
 */
class RudeStream extends Readable {
  constructor(payload) { super(); this.payload = payload; }
  _read() {
    if (this.sent) return;
    this.sent = true;
    this.push(Buffer.from(this.payload, "utf8"));
    setImmediate(() => this.destroy(new Error("socket hang up")));
  }
}

// --- 1. the motomoto shape: [DONE] present, then a rude destroy ---------------
{
  const res = recordingRes();
  const payload = sseText(frames("stop", "Hi")) + "data: [DONE]\n\n";
  bridgeChatStream(new RudeStream(payload), res, "gpt-6-astra");
  await new Promise((r) => setTimeout(r, 120));

  check("complete answer + rude destroy -> response.completed", () => {
    const evs = res.writes.map((w) => w.ev);
    if (!evs.includes("response.completed")) throw new Error(`events: ${evs.join(",")}`);
    if (evs.includes("response.failed")) throw new Error("must NOT report failure");
  });
  check("the arrived text is preserved", () => {
    const done = res.writes.find((w) => w.ev === "response.completed");
    const msg = done.j.response.output.find((it) => it.type === "message");
    if (!msg) throw new Error("no message item in the completed output");
    if (msg.content[0].text !== "Hi") throw new Error(`text: ${JSON.stringify(msg.content[0].text)}`);
  });
  check("usage is reported", () => {
    const done = res.writes.find((w) => w.ev === "response.completed");
    if (done.j.response.usage.total_tokens !== 27) throw new Error(`usage: ${JSON.stringify(done.j.response.usage)}`);
  });
  check("status is completed, not failed", () => {
    const done = res.writes.find((w) => w.ev === "response.completed");
    if (done.j.response.status !== "completed") throw new Error(`status: ${done.j.response.status}`);
  });
}

// --- 2. finish_reason WITHOUT [DONE] on a rude close is still a failure -------
// A finish_reason only says the model stopped a choice; the upstream may still
// have been about to send usage. `test-stream-terminal`'s `finish-then-close`
// gate pins the same contract, so this is the boundary, not an oversight.
{
  const res = recordingRes();
  bridgeChatStream(new RudeStream(sseText(frames("tool_calls", ""))), res, "m");
  await new Promise((r) => setTimeout(r, 120));
  check("finish_reason without [DONE] + rude destroy -> response.failed", () => {
    const evs = res.writes.map((w) => w.ev);
    if (!evs.includes("response.failed")) throw new Error(`events: ${evs.join(",")}`);
    if (evs.includes("response.completed")) throw new Error("must not report completion");
  });
}

// --- 3. the boundary: NO completion signal, rude destroy -> still a failure ---
{
  const res = recordingRes();
  const truncated = "data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: "half a sen" } }] }) + "\n\n";
  bridgeChatStream(new RudeStream(truncated), res, "m");
  await new Promise((r) => setTimeout(r, 120));
  check("truncated stream + rude destroy -> response.failed (must not be swallowed)", () => {
    const evs = res.writes.map((w) => w.ev);
    if (!evs.includes("response.failed")) throw new Error(`events: ${evs.join(",")}`);
    if (evs.includes("response.completed")) throw new Error("a truncated stream must not complete");
  });
}

// --- 4. a clean end still works (no regression) ------------------------------
{
  const res = recordingRes();
  bridgeChatStream(Readable.from([Buffer.from(sseText(frames("stop", "Hi")) + "data: [DONE]\n\n", "utf8")]), res, "m");
  await new Promise((r) => setTimeout(r, 120));
  check("clean end + [DONE] -> completed (unchanged)", () => {
    const evs = res.writes.map((w) => w.ev);
    if (!evs.includes("response.completed")) throw new Error(`events: ${evs.join(",")}`);
    if (evs.includes("response.failed")) throw new Error("must not fail");
  });
}

// --- 5. no double completion when both end and close fire --------------------
{
  const res = recordingRes();
  bridgeChatStream(new RudeStream(sseText(frames("stop", "Hi")) + "data: [DONE]\n\n"), res, "m");
  await new Promise((r) => setTimeout(r, 120));
  const completions = res.writes.filter((w) => w.ev === "response.completed").length;
  check("exactly one response.completed is emitted", () => {
    if (completions !== 1) throw new Error(`completions: ${completions}`);
  });
}

console.log(`\n${pass} checks passed${process.exitCode ? " (with failures above)" : ""}`);

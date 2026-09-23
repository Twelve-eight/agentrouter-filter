// Isolated regression coverage: no server import, sockets, credentials or files.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { bridgeChatStream, bridgeAnthropicStream, createResponsesEmitter } from "../bridge.mjs";

const frame = (value) => "data: " + JSON.stringify(value) + "\n\n";
const text = frame({ choices: [{ delta: { content: "partial" } }] });
const tools = frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "ns__run", arguments: '{"x":' } }] } }] });
const done = "data: [DONE]\n\n";
const stop = (reason = "stop") => frame({ choices: [{ delta: {}, finish_reason: reason }] });
const error = frame({ error: { message: "fixture failure" } });
const usage = frame({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, completion_tokens_details: { reasoning_tokens: 1 } } });
function recorder() {
  return {
    chunks: [], ends: 0, headersSent: false, status: null,
    writeHead(status) { this.status = status; this.headersSent = true; },
    write(value) { this.chunks.push(String(value)); return true; },
    end(value) { if (value !== undefined) this.chunks.push(String(value)); this.ends++; },
    events() { return this.chunks.join("").split("\n").filter(l => l.startsWith("data:")).map(l => JSON.parse(l.slice(5))); },
  };
}
function setup(stream, anthropic = false) {
  const up = new EventEmitter();
  const res = recorder();
  const usages = [];
  if (anthropic) bridgeAnthropicStream(up, res, "fixture", stream, u => usages.push(u));
  else bridgeChatStream(up, res, "fixture", "max", stream, u => usages.push(u));
  return { up, res, usages, send: s => up.emit("data", Buffer.from(s)) };
}
function result(res, stream) {
  if (!stream) return JSON.parse(res.chunks.join(""));
  return res.events().filter(e => e.type === "response.completed" || e.type === "response.failed").at(-1)?.response;
}
let checks = 0;
function check(name, fn) { fn(); checks++; console.log("PASS " + name); }
for (const stream of [true, false]) {
  const faults = {
    "error-frame": ({ send }) => send(error),
    "missing-terminal": () => {},
    "half-tool": ({ send }) => send(tools),
    "transport-error": ({ up }) => up.emit("error", new Error("fixture")),
    "aborted": ({ up }) => up.emit("aborted"),
    "premature-close": ({ up }) => up.emit("close"),
    "length": ({ send }) => send(stop("length") + done),
    "content-filter": ({ send }) => send(stop("content_filter") + done),
    "unknown-finish": ({ send }) => send(stop("unexpected") + done),
    "error-after-finish": ({ send }) => send(stop() + error + done),
    "error-after-done": ({ send }) => send(done + error),
    "truncated-json": ({ send }) => send('data: {"choices":'),
    "finish-then-close": ({ send, up }) => { send(stop()); up.emit("close"); },
  };
  for (const [name, fault] of Object.entries(faults)) {
    check(name + " stream=" + stream, () => {
      const h = setup(stream);
      h.send(text);
      fault(h);
      h.up.emit("end");
      h.up.emit("error", new Error("late fixture"));
      h.up.emit("end");
      h.up.emit("close");
      const before = h.res.chunks.length;
      h.send(text + done);
      assert.equal(h.res.chunks.length, before, "no output after terminal");
      assert.equal(h.res.ends, 1, "exactly one end");
      assert.equal(h.usages.length, 0, "no success usage");
      const r = result(h.res, stream);
      assert.equal(r.status, "failed");
      assert.equal(r.output.find(o => o.type === "message").content[0].text, "partial");
      if (name === "half-tool") assert.equal(r.output.find(o => o.type === "function_call").arguments, '{"x":');
      if (stream) {
        assert.equal(h.res.events().filter(e => e.type === "response.failed").length, 1);
        assert.equal(h.res.events().filter(e => e.type === "response.completed").length, 0);
      } else assert.equal(h.res.status, 502);
    });
  }
  for (const [name, terminal] of Object.entries({ done, stop: stop(), tools: stop("tool_calls"), legacy: stop("function_call"), both: stop() + done, "final-line": "data: [DONE]" })) {
    check("success " + name + " stream=" + stream, () => {
      const h = setup(stream);
      h.send(text + usage + terminal);
      h.up.emit("end");
      h.up.emit("close");
      h.up.emit("error", new Error("late fixture"));
      h.up.emit("end");
      assert.equal(h.res.ends, 1);
      assert.equal(result(h.res, stream).status, "completed");
      assert.equal(h.usages.length, 1);
      assert.equal(h.usages[0].total_tokens, 5);
      assert.equal(h.usages[0].output_tokens_details.reasoning_tokens, 1);
    });
  }
  check("usage after finish stream=" + stream, () => {
    const h = setup(stream);
    h.send(text + stop() + usage + done);
    h.up.emit("end");
    assert.equal(h.usages[0].total_tokens, 5);
  });
  check("split utf8 and terminal stream=" + stream, () => {
    const h = setup(stream);
    const bytes = Buffer.from(frame({ choices: [{ delta: { content: "中文" } }] }) + done);
    for (const byte of bytes) h.up.emit("data", Buffer.from([byte]));
    h.up.emit("end");
    assert.equal(result(h.res, stream).output[0].content[0].text, "中文");
  });
  check("anthropic transport failure then end stream=" + stream, () => {
    const h = setup(stream, true);
    h.send(frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }));
    h.up.emit("error", new Error("fixture"));
    h.up.emit("end");
    assert.equal(h.res.ends, 1);
    assert.equal(h.usages.length, 0);
    assert.equal(result(h.res, stream).status, "failed");
  });
  for (const first of ["finish", "fail"]) {
    check("shared emitter " + first + " stream=" + stream, () => {
      const res = recorder();
      let usages = 0;
      const em = createResponsesEmitter({ res, model: "fixture", stream, onUsage: () => usages++ });
      em.reasoning("reason"); em.text("partial"); em.call(0, { id: "c1", name: "run", args: "{}" });
      em[first]();
      const before = res.chunks.length;
      em.text("late"); em.reasoning("late"); em.call(1, { name: "late", args: "{}" }); em.setUsage({ total_tokens: 999 });
      em.fail(); em.finish();
      assert.equal(res.chunks.length, before);
      assert.equal(res.ends, 1);
      assert.equal(usages, first === "finish" ? 1 : 0);
    });
  }
}
console.log(checks + " checks passed");

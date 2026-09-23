// Regression test for the filter's FAIL-OPEN contract on the gateway's
// sanitised route.
//
// Why this file exists: `server.mjs` runs filter.mjs only for routes flagged
// `filter: true` (today: agentrouter `/ar`), and wraps the call in a bare
// `catch {}`. The catch is deliberate - the README documents 失败时放行不阻断,
// matching the omp hook, and a live Codex session must not be dropped because
// the sanitiser tripped. The defect was that the bypass was INVISIBLE: if
// filterBody threw, the request went out completely unfiltered and nothing was
// logged, so an unsanitised body was indistinguishable from a clean one.
//
// What is pinned here:
//   1. the fail-open trigger is real - a body exists that JSON.parse accepts
//      (so it is a body the gateway would happily forward) but whose sanitising
//      throws, and that throw is not an artificial hook added for the test;
//   2. on that body the handler still FORWARDS the request, byte-identical to
//      what the client sent - fail-open, not fail-closed, and not a 4xx/5xx;
//   3. the bypass is announced in the log with the route and the error;
//   4. a normal /ar body IS rewritten (so the test cannot pass merely because
//      the filter silently stopped doing anything);
//   5. a route without `filter: true` forwards verbatim (the R07-05 claim in
//      server.mjs's header - not everything posted is sanitised).
//
// No port is bound and no network call is made: `http.createServer` is stubbed
// to capture the real handler, and `http/https.request` are stubbed so the
// "upstream" is a recording fake. server.mjs only calls listen() when it is the
// entry point, so importing it here cannot start a second gateway.
//
// Run: node tools/test-filter-failopen.mjs   (exits non-zero on failure)
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { filterBody } from "../filter.mjs";

let failed = 0;

// server.mjs logs to process.stdout through its own log(); those lines are part
// of what this test asserts on, so stdout is captured for the whole run and the
// test's own output goes through realStdout below.
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

// --- capture the real handler, and record what it forwards -------------------
let handler = null;
const forwarded = [];
http.createServer = (h) => {
  handler = h;
  return { on() {}, listen() {} };
};
// server.mjs calls mod.request(options, onResponse) and resolves its own promise
// from that callback, so the fake upstream must hand it back a response object.
const stubRequest = () => (_opts, onResponse) => {
  const rec = { url: String(_opts?.hostname ?? "") + String(_opts?.path ?? ""), body: null };
  forwarded.push(rec);
  const upstream = new EventEmitter();
  upstream.statusCode = 200;
  upstream.headers = { "content-type": "application/json" };
  upstream.destroyed = false;
  upstream.destroy = () => {};
  upstream.pipe = () => {};
  const req = { on: () => req, write: (b) => { rec.body = String(b); }, end() {} };
  if (typeof onResponse === "function") setImmediate(() => onResponse(upstream));
  return req;
};
http.request = stubRequest();
https.request = stubRequest();

// Isolate usage before the real server (and its usage dependency) is imported.
// Each run owns a new directory; keep its artifacts for post-run inspection.
const testTmp = fileURLToPath(new URL("../.tmp/", import.meta.url));
if (process.platform === "win32" && path.parse(testTmp).root.toLowerCase() !== "g:" + path.sep) {
  throw new Error("Usage isolation tests must run from a project on G:");
}
fs.mkdirSync(testTmp, { recursive: true });
process.env.AR_USAGE_DIR = fs.mkdtempSync(path.join(testTmp, "test-filter-failopen-usage-"));

await import("../server.mjs");
out(`测试账本目录: ${process.env.AR_USAGE_DIR}\n`);
out("");

const fakeRes = () => ({
  headersSent: false,
  status: undefined,
  ended: false,
  writeHead(s) { this.headersSent = true; this.status = s; },
  end() { this.ended = true; },
  on() {},
  destroy() {},
  pipe() {},
});

/** Drive the real request handler in-process (no socket is ever opened). */
async function post(url, body) {
  const res = fakeRes();
  try {
    await handler({ method: "POST", url, headers: {}, chunks: [Buffer.from(body)] }, res);
  } catch (e) {
    throw new Error(`handler threw for ${url}: ${e?.message ?? e}`);
  }
  return res;
}

// --- 1. a genuine trigger: parses fine, sanitising throws --------------------
//
// deepSanitize recurses per nesting level, so a deeply nested JSON array
// overflows the stack while JSON.parse (iterative in V8) still accepts it. The
// depth is searched rather than hardcoded so this keeps working if either limit
// moves; the search is bounded.
function findThrowingBody() {
  for (let depth = 2000; depth <= 60000; depth += 500) {
    const raw = "[".repeat(depth) + "1" + "]".repeat(depth);
    let parses = true;
    try { JSON.parse(raw); } catch { parses = false; }
    if (!parses) continue;
    try {
      filterBody(raw, { injectInstructions: true });
    } catch (e) {
      return { raw, depth, error: e };
    }
  }
  return null;
}

const trigger = findThrowingBody();

check("a body exists that JSON.parse accepts but sanitising throws on", () => {
  if (!trigger) {
    throw new Error("could not construct a parseable body that makes filterBody throw (searched depth 2000-60000)");
  }
  // Prove the throw comes from the sanitizer, not from JSON parsing.
  JSON.parse(trigger.raw);
  if (!(trigger.error instanceof RangeError)) {
    throw new Error(`expected a RangeError from deepSanitize recursion, got ${trigger.error?.constructor?.name}: ${trigger.error?.message}`);
  }
});

check("filterBody itself fails open on non-JSON input (documented filter-level contract)", () => {
  const raw = "{ not json at all";
  if (filterBody(raw, { injectInstructions: true }) !== raw) {
    throw new Error("filterBody must return the raw body unchanged when it cannot parse it");
  }
});

// --- 2-5. the handler: fail-open, announced, still filtering the normal case --

if (trigger) {
  const identity = "You are Claude Code, Anthropic's official CLI tool for Claude.";
  const normal = JSON.stringify({ model: "m", instructions: identity, input: [] });

  const beforeNormal = forwarded.length;
  await post("/ar/v1/responses", normal);
  const normalFwd = forwarded[beforeNormal]?.body;

  const beforeThrow = forwarded.length;
  const resThrow = await post("/ar/v1/responses", trigger.raw);
  const throwFwd = forwarded[beforeThrow]?.body;

  const beforeRc = forwarded.length;
  const resRc = await post("/rc/v1/responses", normal);
  const rcFwd = forwarded[beforeRc]?.body;

  check("a normal /ar body IS rewritten (baseline: the filter is doing its job)", () => {
    if (!normalFwd) throw new Error("no upstream request was made for the normal /ar body");
    if (!normalFwd.includes("You are Codex")) {
      throw new Error("the identity sentence was not rewritten on the filtered route");
    }
    if (normalFwd.includes(identity)) throw new Error("the original identity sentence survived filtering");
  });

  check("a throwing filter forwards the request UNFILTERED instead of blocking it", () => {
    if (throwFwd === undefined) throw new Error("the request was not forwarded at all - fail-open was violated");
    if (throwFwd !== trigger.raw) {
      throw new Error(`forwarded body differs from what the client sent (${String(throwFwd).length} vs ${trigger.raw.length} bytes)`);
    }
    // Fail-open means the client is not punished for the sanitiser's failure.
    if (resThrow.status !== undefined && resThrow.status >= 400) {
      throw new Error(`request was rejected with status ${resThrow.status}; fail-open requires it to proceed`);
    }
  });

  check("the bypass is logged with the route prefix and the error message", () => {
    const lines = logs.map((l) => l.trim());
    const line = lines.find((l) => /UNFILTERED/i.test(l));
    if (!line) throw new Error(`no UNFILTERED log line was written; log was:\n        ${lines.join("\n        ")}`);
    if (!line.includes("ar/v1/responses")) throw new Error(`log line does not name the route: ${line}`);
    if (!/Maximum call stack size exceeded/.test(line)) {
      throw new Error(`log line does not carry the underlying error: ${line}`);
    }
  });

  check("a route without filter:true forwards verbatim (server.mjs header claim)", () => {
    if (rcFwd !== normal) {
      throw new Error("the /rc route modified the body; only filter:true routes may be rewritten");
    }
    if (resRc.status !== undefined && resRc.status >= 400) {
      throw new Error(`/rc request was rejected with status ${resRc.status}`);
    }
  });

  out(`\n      trigger: depth-${trigger.depth} nested array, ${trigger.raw.length} bytes, ${trigger.error.constructor.name}\n`);
}

out(failed ? `\n${failed} check(s) failed\n` : "\nall checks passed\n");
process.exit(failed ? 1 : 0);

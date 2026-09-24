// Post-write check for the files this project generates or hand-edits.
//
// Why: the `..` spread has been silently collapsed to `..` in transit at least
// five times (bridge.mjs, server.mjs, usage.mjs, build-model-catalog.cjs,
// stats-api.mjs), and each time the result was a file that looked right in a diff
// but failed at parse or runtime. A one-line `node --check` on the actual bytes
// catches it before it reaches a running process.
//
// The vendored dashboard client (vendor/omp-stats/) is built output and is not
// parsed here; the API it calls (stats-api.mjs) is in PLAIN.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// This file lives in tools/, so the project root is one level up.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PLAIN = ["server.mjs", "bridge.mjs", "filter.mjs", "egress-guard.mjs", "usage.mjs", "pricing.mjs", "stats-api.mjs"];

let failed = 0;

function check(name, file, code) {
  const tmp = path.join(ROOT, ".check-tmp.mjs");
  fs.writeFileSync(tmp, code);
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    const msg = String(e.stderr ?? e.message).split("\n").slice(0, 4).join("\n");
    console.log(`  FAIL  ${name}\n${msg}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

console.log("syntax check:");
for (const f of PLAIN) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  check(f, p, fs.readFileSync(p, "utf8"));
}

// CJS helper (uses require)
const cjs = path.join(ROOT, "tools", "build-model-catalog.cjs");
if (fs.existsSync(cjs)) check("tools/build-model-catalog.cjs", cjs, fs.readFileSync(cjs, "utf8"));

// The dashboard UI is vendored from omp (vendor/omp-stats/) and is already built
// output, so there is nothing here to parse - stats-api.mjs, which the client
// actually talks to, is in PLAIN above.

// Collapsed-spread sweep: a `..x`/`..x` run outside a string is almost certainly
// a mangled `...`. Cheap to detect, and it is the exact failure this guards.
console.log("collapsed-spread sweep:");
for (const f of [...PLAIN, "tools/build-model-catalog.cjs", "providers.json"]) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  const hits = [];
  const lines = fs.readFileSync(p, "utf8").split("\n");
  lines.forEach((line, i) => {
    // two or more dots immediately followed by an identifier/bracket, where the
    // preceding char is not a dot (so `...` is fine) and not inside a comment
    const m = line.match(/(^|[^.\w])\.\.(?=[A-Za-z_$[({])/);
    if (m && !/^\s*(\/\/|\*)/.test(line)) hits.push(`    ${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
  });
  if (hits.length) {
    failed += hits.length;
    console.log(`  FAIL  ${f}`);
    for (const h of hits) console.log(h);
  }
}
if (!failed) console.log("  ok    no collapsed spreads");

console.log(failed ? `\n${failed} problem(s)` : "\nall checks passed");
process.exit(failed ? 1 : 0);

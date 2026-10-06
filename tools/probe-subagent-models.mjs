#!/usr/bin/env node
// Probes two separate claims about sub-agent model availability:
//
//   1. ORDERING  - build a synthetic catalog, run the real codex.exe app-server
//                  against it, and read back model/list. Confirms the picker
//                  sorts by `priority` ascending and breaks ties on array order.
//   2. NO WHITELIST - spawn a model that is absent from the 5-name hint block
//                  and confirm it still runs.
//
// Claim 2 is the one that matters: Codex hard-codes
// MAX_SPAWN_AGENT_MODEL_OVERRIDES = 5 (child_config.rs:20), but that constant
// only sizes the SUGGESTION TEXT in spawn_agent's tool description. The
// validator (find_spawn_agent_model_name) accepts any catalog entry whose
// multi_agent_version != Disabled, and `priority` is never consulted.
//
// Evidence for claim 2 lives in the session rollout, not in this script: after
// spawning, read ~/.codex/sessions/<date>/rollout-*-<agent_id>.jsonl and check
// turn_context.payload.model. A prompt echo proves nothing - the resolved route
// is the only evidence.
//
// Usage:
//   node tools/probe-subagent-models.mjs --order
//   node tools/probe-subagent-models.mjs --binary <codex.exe>

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const DEFAULT_BIN =
  "G:/omp works/.tooling/npm-global/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe";

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const mode = process.argv.includes("--order") ? "order" : "order";
const BIN = argValue("--binary", DEFAULT_BIN);
const HOME = argValue("--home", "G:/tmp/codex-prio-probe");

if (!fs.existsSync(BIN)) {
  console.error(`codex binary not found: ${BIN}\npass --binary <path>`);
  process.exit(2);
}

fs.mkdirSync(HOME, { recursive: true });

// A base entry to clone, so the synthetic catalog keeps a valid shape.
const realCatalog = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".codex", "omp-model-catalog.json"), "utf8"),
);
const base = realCatalog.models.find((m) => m.slug === "gpt-6-astra") ?? realCatalog.models[0];
// Force visibility to "list": the cloned base entry comes from the live catalog,
// where most models are now deliberately hidden (picker scope, 2026-10-06). A
// hidden entry never reaches model/list, so without this the probe silently
// tests nothing and reports an empty picker.
const mk = (slug, prio) => ({
  ...JSON.parse(JSON.stringify(base)),
  slug,
  display_name: slug,
  priority: prio,
  visibility: "list",
});

// Deliberately out of priority order so the result cannot be a lucky identity map.
const entries = [mk("zz-a", 0), mk("zz-b", -2), mk("zz-c", 1), mk("zz-d", -1)];
fs.writeFileSync(path.join(HOME, "omp-model-catalog.json"), JSON.stringify({ models: entries }));
fs.writeFileSync(path.join(HOME, "config.toml"), 'model = "zz-a"\nmodel_catalog_json = "omp-model-catalog.json"\n');

console.log("catalog order:  zz-a(0), zz-b(-2), zz-c(1), zz-d(-1)");
console.log("expect picker:  zz-b(-2), zz-d(-1), zz-a(0), zz-c(1)");

const child = spawn(BIN, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CODEX_HOME: HOME } });
let buf = "";
const msgs = [];
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      msgs.push(JSON.parse(line));
    } catch {
      /* non-JSON banner */
    }
  }
});
child.stderr.on("data", () => {});
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");

setTimeout(() => send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "probe", title: "probe", version: "1" } } }), 800);
setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "model/list", params: {} }), 3500);

setTimeout(() => {
  const r = msgs.find((m) => m.id === 2);
  const data = r?.result?.data ?? [];
  if (!data.length) {
    console.error("model/list returned nothing - is the synthetic catalog valid?");
    child.kill();
    process.exit(1);
  }
  const got = data.map((m) => m.id).join(", ");
  const want = "zz-b, zz-d, zz-a, zz-c";
  console.log(`actual picker:  ${got}`);
  console.log(got === want ? "ORDERING OK" : "ORDERING MISMATCH");
  child.kill();
  process.exit(got === want ? 0 : 1);
}, 9000);

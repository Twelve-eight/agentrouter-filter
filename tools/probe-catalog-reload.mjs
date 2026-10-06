#!/usr/bin/env node
// Does `model_catalog_json` hot-reload, or is a Codex restart required?
//
// Answer (measured 2026-10-06): STARTUP ONLY. A running Codex process keeps the
// catalog it parsed at load time; edits to omp-model-catalog.json do NOT take
// effect until Codex restarts. The gateway's providers.json is the opposite
// (read per request), which is why "rebuild the catalog" and "add a provider"
// have different apply stories and the difference keeps getting asked about.
//
// Why this is a script and not a sentence in DEVLOG: the two files look
// identical in shape (both are JSON the gateway/codex read from disk) and the
// wrong assumption is invisible - you rebuild, nothing changes, and you blame
// the builder. This pins the behaviour to an executable assertion.
//
// Method: spawn a real codex.exe app-server against a scratch CODEX_HOME whose
// catalog marks zz-alpha visible, ask model/list, rewrite the catalog so
// zz-beta is the visible one, ask the SAME process again, then start a FRESH
// process and ask a third time. Startup-only predicts [alpha], [alpha], [beta].
//
// Usage: node tools/probe-catalog-reload.mjs
//        node tools/probe-catalog-reload.mjs --binary <codex.exe>

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_BIN =
  "G:/omp works/.tooling/npm-global/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe";

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BIN = argValue("--binary", DEFAULT_BIN);
const ROOT = argValue("--home", "G:/tmp/codex-catalog-reload");

if (!fs.existsSync(BIN)) {
  console.error(`codex binary not found: ${BIN}\npass --binary <path>`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startAppServer(home) {
  const child = spawn(BIN, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CODEX_HOME: home } });
  const state = { child, msgs: [], buf: "" };
  child.stdout.on("data", (d) => {
    state.buf += d.toString();
    let i;
    while ((i = state.buf.indexOf("\n")) !== -1) {
      const line = state.buf.slice(0, i).trim();
      state.buf = state.buf.slice(i + 1);
      if (!line) continue;
      try {
        state.msgs.push(JSON.parse(line));
      } catch {
        /* banner */
      }
    }
  });
  child.stderr.on("data", () => {});
  return state;
}

const send = (s, o) => s.child.stdin.write(JSON.stringify(o) + "\n");
const visibleIds = (s, id) =>
  (s.msgs.find((m) => m.id === id)?.result?.data ?? []).map((m) => m.id).sort();

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });

  // A base entry to clone, so the synthetic catalog keeps a valid shape.
  const realCatalog = JSON.parse(
    fs.readFileSync(path.join(process.env.USERPROFILE ?? process.env.HOME, ".codex", "omp-model-catalog.json"), "utf8"),
  );
  const base = realCatalog.models.find((m) => m.slug === "gpt-6-astra") ?? realCatalog.models[0];
  const mk = (slug, vis) => ({ ...JSON.parse(JSON.stringify(base)), slug, display_name: slug, visibility: vis, priority: 0 });

  const catA = { models: [mk("zz-alpha", "list"), mk("zz-beta", "hide")] };
  const catB = { models: [mk("zz-alpha", "hide"), mk("zz-beta", "list")] };
  const catPath = path.join(ROOT, "omp-model-catalog.json");
  fs.writeFileSync(catPath, JSON.stringify(catA));
  fs.writeFileSync(path.join(ROOT, "config.toml"), 'model = "zz-alpha"\nmodel_catalog_json = "omp-model-catalog.json"\n');

  const init = (s) =>
    send(s, { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "probe", title: "probe", version: "1" } } });

  const s1 = startAppServer(ROOT);
  await sleep(800);
  init(s1);
  await sleep(2500);
  send(s1, { jsonrpc: "2.0", id: 10, method: "model/list", params: {} });
  await sleep(2500);
  const list1 = visibleIds(s1, 10);
  console.log(`catalog A (alpha=list, beta=hide) -> picker: ${JSON.stringify(list1)}`);

  fs.writeFileSync(catPath, JSON.stringify(catB));
  console.log("rewrote the file to B (alpha=hide, beta=list); process still running");
  await sleep(500);
  send(s1, { jsonrpc: "2.0", id: 11, method: "model/list", params: {} });
  await sleep(2500);
  const list2 = visibleIds(s1, 11);
  console.log(`same process, after the edit   -> picker: ${JSON.stringify(list2)}`);
  s1.child.kill();
  await sleep(700);

  const s2 = startAppServer(ROOT);
  await sleep(800);
  init(s2);
  await sleep(2500);
  send(s2, { jsonrpc: "2.0", id: 20, method: "model/list", params: {} });
  await sleep(2500);
  const list3 = visibleIds(s2, 20);
  console.log(`fresh process on B             -> picker: ${JSON.stringify(list3)}`);
  s2.child.kill();

  console.log("");
  const freshOk = eq(list3, ["zz-beta"]);
  if (!freshOk) {
    console.log(`INCONCLUSIVE: a fresh process did not read the new file (${JSON.stringify(list3)})`);
    process.exit(1);
  }
  if (eq(list2, ["zz-beta"])) {
    console.log("VERDICT: HOT RELOAD - a running process picks up catalog edits; no restart needed");
    console.log("(this contradicts the 2026-10-06 measurement - re-check before trusting either)");
    process.exit(1);
  }
  if (eq(list2, list1)) {
    console.log("VERDICT: STARTUP ONLY - the running process keeps the catalog it loaded; RESTART CODEX");
    process.exit(0);
  }
  console.log(`INCONCLUSIVE: unexpected second result ${JSON.stringify(list2)}`);
  process.exit(1);
})();

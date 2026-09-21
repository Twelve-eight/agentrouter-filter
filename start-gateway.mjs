// Start the production gateway (7878) detached.
//
// Why a wrapper instead of just running server.mjs: the gateway must outlive the
// console that launched it (it is the entry point for every local client), and
// `start /b` from a shell dies with that shell. Detached + append logging,
// matching run-service-tab.ps1 (Start-Process -RedirectStandardOutput TRUNCATES
// the log, so stdio goes to an append handle instead).
//
// Per-provider credentials live in .env.local (gitignored), which server.mjs
// loads itself - so nothing secret belongs in this file.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";

const DIR = "G:\\omp works\\Tools\\agentrouter-filter";
const LOG = "G:\\omp works\\.tmp\\argw-autostart.log";
const PORT = Number(process.env.AR_GATEWAY_PORT ?? 7878);

const listening = await new Promise((resolve) => {
  const s = net.connect(PORT, "127.0.0.1");
  s.on("connect", () => { s.destroy(); resolve(true); });
  s.on("error", () => resolve(false));
});
if (listening) {
  console.log(`[start-gateway] already listening on ${PORT} - nothing to do.`);
  process.exit(0);
}

const out = fs.openSync(LOG, "a");
const child = spawn(process.execPath, [`${DIR}\\server.mjs`], {
  cwd: DIR,
  detached: true,
  stdio: ["ignore", out, out],
  env: process.env,
});
child.unref();
console.log(`[start-gateway] launched pid ${child.pid}; waiting for ${PORT} ..`);

for (let i = 1; i <= 30; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const up = await new Promise((resolve) => {
    const s = net.connect(PORT, "127.0.0.1");
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });
  if (up) {
    console.log(`[start-gateway] OK - listening on ${PORT} after ${i}s`);
    process.exit(0);
  }
}
console.log(`[start-gateway] FAILED - ${PORT} not listening after 30s; see ${LOG}`);
process.exit(1);

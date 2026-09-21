// Start (or restart) the production gateway on PORT.
//
// Why a wrapper instead of just running server.mjs: the gateway must outlive the
// console that launched it (it is the entry point for every local client), and
// `start /b` from a shell dies with that shell. Detached + append logging,
// matching run-service-tab.ps1 (Start-Process -RedirectStandardOutput TRUNCATES
// the log, so stdio goes to an append handle instead).
//
// Per-provider credentials live in .env.local (gitignored), which server.mjs
// loads itself - so nothing secret belongs in this file.
//
// RESTART SEMANTICS: this script RESTARTS by default. The gateway reads its code
// at module load, so a code change (or any registry entry the running process
// cached before an edit) only takes effect after the process is replaced -
// probing the port and reporting "already listening" would look like success
// while the old code kept serving. Use `--if-down` for the logon/idempotent case
// where an existing process should be left alone.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";

const DIR = "G:\\omp works\\Tools\\agentrouter-filter";
const LOG = "G:\\omp works\\.tmp\\argw-autostart.log";
const PORT = Number(process.env.AR_GATEWAY_PORT ?? 7878);
const IF_DOWN = process.argv.includes("--if-down");

const probe = () =>
  new Promise((resolve) => {
    const s = net.connect(PORT, "127.0.0.1");
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });

if (await probe()) {
  if (IF_DOWN) {
    console.log(`[start-gateway] already listening on ${PORT} - nothing to do (--if-down).`);
    process.exit(0);
  }
  // Find the owner of PORT and stop it. Resolved via the OS rather than a PID
  // file: the gateway is also started by autostart, so a recorded pid can be
  // stale while a live process still holds the port.
  const { execFileSync } = await import("node:child_process");
  let killed = 0;
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-NetTCPConnection -State Listen -LocalPort ${PORT} -ErrorAction SilentlyContinue | ` +
          `Select-Object -ExpandProperty OwningProcess -Unique | ` +
          `ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue; $_ }`,
      ],
      { encoding: "utf8" },
    );
    killed = out.split(/\s+/).filter(Boolean).length;
  } catch (e) {
    console.log(`[start-gateway] could not stop the listener: ${e?.message?.split("\n")[0]}`);
  }
  console.log(`[start-gateway] stopped ${killed} listener(s) on ${PORT}; restarting ..`);
  for (let i = 1; i <= 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!(await probe())) break;
  }
  if (await probe()) {
    console.log(`[start-gateway] FAILED - ${PORT} still held after 10s`);
    process.exit(1);
  }
}

// Open the log for append. Windows keeps the handle of a just-killed process
// alive briefly (and an older gateway may still hold it), so a single openSync
// can fail with EBUSY - which would abort the restart exactly when it is most
// needed. Retry, then fall back to a rotated name rather than failing the start:
// losing log continuity is far cheaper than leaving the gateway down.
function openLog() {
  for (let i = 1; i <= 10; i++) {
    try {
      return fs.openSync(LOG, "a");
    } catch (e) {
      if (e?.code !== "EBUSY" && e?.code !== "EPERM") throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
  const alt = LOG.replace(/\.log$/, `.${Date.now()}.log`);
  console.log(`[start-gateway] ${LOG} is locked; logging to ${alt}`);
  return fs.openSync(alt, "a");
}
const out = openLog();
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
  if (await probe()) {
    console.log(`[start-gateway] OK - listening on ${PORT} after ${i}s`);
    process.exit(0);
  }
}
console.log(`[start-gateway] FAILED - ${PORT} not listening after 30s; see ${LOG}`);
process.exit(1);

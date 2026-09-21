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
// at module load, so a code change only takes effect after the process is
// replaced - probing the port and reporting "already listening" would look like
// success while the old code kept serving. Use `--if-down` for the logon /
// idempotent case where an existing process should be left alone.
//
// ORDERING IS LOAD-BEARING: everything that can fail (locating node, checking
// server.mjs, proving the log directory is writable) is done BEFORE the listener
// is stopped. Killing first meant a failure in any later step left the gateway
// down with nothing to replace it - which is how the first version of this file
// behaved: it printed "restarting .." and then died opening the log, taking the
// service with it.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const DIR = "G:\\omp works\\Tools\\agentrouter-filter";
const LOG = "G:\\omp works\\.tmp\\argw-autostart.log";
const PORT = Number(process.env.AR_GATEWAY_PORT ?? 7878);
const IF_DOWN = process.argv.includes("--if-down");
const SERVER = path.join(DIR, "server.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = () =>
  new Promise((resolve) => {
    const s = net.connect(PORT, "127.0.0.1");
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });

// --- preflight: every check that must abort BEFORE the old process is stopped ---

if (!fs.existsSync(SERVER)) {
  console.log(`[start-gateway] FAILED - missing ${SERVER}`);
  process.exit(1);
}
try {
  fs.accessSync(SERVER, fs.constants.R_OK);
} catch {
  console.log(`[start-gateway] FAILED - ${SERVER} is not readable`);
  process.exit(1);
}
// Prove the log directory is writable without touching the log itself: the log is
// legitimately held by the running gateway, so opening it here would fail for a
// reason that does not indicate a real problem.
const logDir = path.dirname(LOG);
try {
  fs.mkdirSync(logDir, { recursive: true });
  const probeFile = path.join(logDir, `.write-probe-${process.pid}`);
  fs.writeFileSync(probeFile, "");
  fs.unlinkSync(probeFile);
} catch (e) {
  console.log(`[start-gateway] FAILED - log directory not writable: ${e?.message?.split("\n")[0]}`);
  process.exit(1);
}

// --- stop the current listener, if any ---

if (await probe()) {
  if (IF_DOWN) {
    console.log(`[start-gateway] already listening on ${PORT} - nothing to do (--if-down).`);
    process.exit(0);
  }
  // Resolved through the OS rather than a pid file: autostart can own the port
  // while any recorded pid is stale.
  let stopped = [];
  try {
    const { execFileSync } = await import("node:child_process");
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
    stopped = out.split(/\s+/).filter(Boolean);
  } catch (e) {
    console.log(`[start-gateway] could not stop the listener: ${e?.message?.split("\n")[0]}`);
  }
  console.log(`[start-gateway] stopped ${stopped.length} listener(s) on ${PORT}; restarting ..`);
  for (let i = 1; i <= 20; i++) {
    await sleep(500);
    if (!(await probe())) break;
  }
  if (await probe()) {
    console.log(`[start-gateway] FAILED - ${PORT} still held after 10s; not starting a second copy`);
    process.exit(1);
  }
}

// --- launch ---

// Open the log for append. Windows keeps a just-killed process's handle alive
// briefly, so the open can still fail with EBUSY right after the stop. Retry,
// then rotate to a timestamped name: losing log continuity is far cheaper than
// leaving the gateway down.
function openLog() {
  for (let i = 1; i <= 20; i++) {
    try {
      return fs.openSync(LOG, "a");
    } catch (e) {
      if (e?.code !== "EBUSY" && e?.code !== "EPERM") throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
  const alt = LOG.replace(/\.log$/, `.${Date.now()}.log`);
  console.log(`[start-gateway] ${LOG} is locked; logging to ${alt}`);
  return fs.openSync(alt, "a");
}

let out;
try {
  out = openLog();
} catch (e) {
  // Preflight proved the directory is writable, so this is unexpected - report it
  // with the gateway's state spelled out rather than dying silently.
  console.log(`[start-gateway] FAILED to open a log: ${e?.message?.split("\n")[0]}`);
  console.log(`[start-gateway] the gateway is now STOPPED; re-run this script to retry`);
  process.exit(1);
}

const child = spawn(process.execPath, [SERVER], {
  cwd: DIR,
  detached: true,
  stdio: ["ignore", out, out],
  env: process.env,
});
child.on("error", (e) => {
  console.log(`[start-gateway] spawn error: ${e?.message}`);
});
child.unref();
console.log(`[start-gateway] launched pid ${child.pid}; waiting for ${PORT} ..`);

for (let i = 1; i <= 30; i++) {
  await sleep(1000);
  if (await probe()) {
    console.log(`[start-gateway] OK - listening on ${PORT} after ${i}s`);
    process.exit(0);
  }
}
console.log(`[start-gateway] FAILED - ${PORT} not listening after 30s; see ${LOG}`);
process.exit(1);

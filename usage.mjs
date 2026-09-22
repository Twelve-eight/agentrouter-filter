// Usage accounting for the gateway.
//
// Records one row per completed request: which provider/model served it, token
// counts as reported by the upstream, duration, and whether it succeeded. The
// data comes from what the upstream already returns (responses `usage`, chat
// `usage`), so nothing is estimated.
//
// Storage: JSON Lines, one file per day under data/usage/. Append-only and
// flushed per record, so a crash loses at most the request in flight. JSONL is
// chosen over a database because the volume is small (one line per request) and
// it stays readable/repairable by hand.
//
// Cost is NOT computed here: provider prices are not published in a machine
// readable form and inventing a table would be a fabrication. Credits are shown
// only where an upstream reports them (wb2api publishes `credits` per model).
//
// Two things that must never be conflated in the aggregate: `cost: null`
// ("no published price") and a priced-at-zero cost object (`total: 0`). See
// costOf() and summarize() for how they are kept apart.
import fs from "node:fs";
import path from "node:path";
import { priceFor } from "./pricing.mjs";

// fileURLToPath, not URL.pathname: pathname stays percent-encoded ("/G:/omp%20works/..")
// and the leading slash must go on Windows. Getting this wrong made every write
// fail silently inside record()'s catch.
import { fileURLToPath } from "node:url";
const DIR_PATH = fileURLToPath(new URL("./data/usage/", import.meta.url));

function ensureDir() {
  fs.mkdirSync(DIR_PATH, { recursive: true });
}

function fileFor(day) {
  return path.join(DIR_PATH, `${day}.jsonl`);
}

function dayKey(d = new Date()) {
  // Local day: the operator reads these in local time.
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Append one usage record. Never throws: accounting must not break traffic. */
function record(row) {
  try {
    ensureDir();
    // Price is resolved here (once per request) rather than at read time: the
    // table can change, and a historical row should keep the cost it actually
    // incurred. cost:null means no published price - never 0.
    let cost = null;
    try {
      // Only price rows that consumed tokens. A failed request (0 in, 0 out) has no
      // cost; pricing it made `if (r.cost)` always true, so priced_requests tracked
      // requests exactly and the "N/M priced" indicator could never show the
      // unpriced share.
      if ((row.input_tokens ?? 0) + (row.output_tokens ?? 0) === 0) throw new Error("no tokens");
      cost = priceFor(row.model, {
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        input_tokens_details: { cached_tokens: row.cached_tokens },
      });
    } catch {
      /* pricing must never break accounting */
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...row , cost});
    fs.appendFileSync(fileFor(dayKey()), line + "\n");
  } catch (e) {
    process.stdout.write(`[usage] write failed: ${e?.message ?? e}\n`);
  }
}

/** Read records for the last `days` days (inclusive of today). */
function read(days = 7) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getTime() - i * 86400000);
    const f = fileFor(dayKey(d));
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* a torn last line after a crash - skip it */
      }
    }
  }
  return out;
}

// The row's cost object, or null when no price is known for it.
//
// Existence + shape, never truthiness: `{ total: 0 }` is a real price of zero
// and must stay distinguishable from `null`. Historical rows can also carry a
// non-object in this field (an earlier writer put a bare number/string there);
// those are malformed and must not be counted as priced either.
function costOf(row) {
  const c = row?.cost;
  return c !== null && typeof c === "object" && !Array.isArray(c) ? c : null;
}

// A finite numeric total, else 0. A malformed `total` (string, null, NaN) must
// contribute nothing rather than turn the running sum into a string.
function totalOf(cost) {
  const t = cost?.total;
  return typeof t === "number" && Number.isFinite(t) ? t : 0;
}

/**
 * Aggregate rows into the shapes the UI needs.
 *
 * Priced vs unpriced is decided by costOf(): a row with `cost: null` is not
 * counted in `priced_requests` and adds nothing to `cost_usd`, while a row with
 * a `total: 0` cost object IS counted and adds 0. Callers must therefore read
 * `priced_requests` to interpret the sum - `cost_usd === 0` with
 * `priced_requests === 0` means "nothing was priced", not "it was all free".
 * Only `priced_requests === requests` makes a zero sum a real zero bill.
 */
function summarize(rows) {
  const byProvider = new Map();
  const byModel = new Map();
  const byDay = new Map();
  const byEffort = new Map();
  const totals = {
    requests: 0,
    ok: 0,
    failed: 0,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    duration_ms: 0,
      cost_usd: 0,
    priced_requests: 0,
};

  const bump = (map, key, r) => {
    let e = map.get(key);
    if (!e) {
      e = {
        key,
        requests: 0,
        ok: 0,
        failed: 0,
        input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        cached_tokens: 0,
        duration_ms: 0,
        cost_usd: 0,
        priced_requests: 0,
      };
      map.set(key, e);
    }
    e.requests++;
    if (r.ok) e.ok++;
    else e.failed++;
    e.input_tokens += r.input_tokens ?? 0;
    e.output_tokens += r.output_tokens ?? 0;
    e.reasoning_tokens += r.reasoning_tokens ?? 0;
    e.cached_tokens += r.cached_tokens ?? 0;
    const cost = costOf(r);
    if (cost) {
      e.cost_usd += totalOf(cost);
      e.priced_requests++;
    }
    e.duration_ms += r.duration_ms ?? 0;
  };

  for (const r of rows) {
    totals.requests++;
    if (r.ok) totals.ok++;
    else totals.failed++;
    totals.input_tokens += r.input_tokens ?? 0;
    totals.output_tokens += r.output_tokens ?? 0;
    totals.reasoning_tokens += r.reasoning_tokens ?? 0;
    totals.cached_tokens += r.cached_tokens ?? 0;
    const cost = costOf(r);
    if (cost) {
      totals.cost_usd += totalOf(cost);
      totals.priced_requests++;
    }
    totals.duration_ms += r.duration_ms ?? 0;

    bump(byProvider, r.provider ?? "unknown", r);
    bump(byModel, r.model ?? "unknown", r);
    bump(byDay, (r.ts ?? "").slice(0, 10) || "unknown", r);
    if (r.effort) bump(byEffort, r.effort, r);
  }

  const arr = (m) =>
    [...m.values()].sort((a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens));

  return {
    totals,
    byProvider: arr(byProvider),
    byModel: arr(byModel),
    byDay: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byEffort: arr(byEffort),
  };
}

export { record, read, summarize, dayKey, costOf };

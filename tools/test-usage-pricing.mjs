// Regression test for the priced / unpriced 口径 in usage.mjs summarize().
//
// Why this file exists: R15-02. The original finding claimed zero-amount
// requests were not counted; the recheck withdrew that (a `total: 0` cost object
// IS truthy, so it was always counted) and left a narrower, real problem: the
// aggregate could not tell "no published price" apart from "priced at zero".
// The fix is an explicit existence test (costOf) instead of object truthiness -
// NOT `cost_usd != null` / `Number.isFinite(cost_usd)`, which would let an
// all-unpriced aggregate read as free. These checks pin exactly that contract.
//
// The rows below are shaped like real data/usage/*.jsonl entries, including the
// two shapes that actually occur in the historical files: `cost: null` (no
// published price) and `cost` missing entirely (rows written before pricing
// landed). Both mean unpriced.
//
// Run: node tools/test-usage-pricing.mjs   (exits non-zero on failure)
import { summarize, costOf } from "../usage.mjs";

let failed = 0;

const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n        ${e?.message ?? e}`);
  }
};

// A cost object as pricing.mjs returns it, with `total` overridable.
const costObj = (total) => ({
  input: 0.00015,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  total,
  tier: "base",
  vendor: "fixture",
  estimate: true,
  peak: null,
  discount: 1,
});

// One usage row. `cost` is passed through verbatim (undefined = key absent),
// which is how the malformed/missing historical shapes are reproduced.
const row = (model, cost, extra = {}) => ({
  ts: "2026-09-22T00:00:00.000Z",
  route: "ar",
  provider: "agentrouter",
  model,
  effort: null,
  ok: true,
  duration_ms: 1000,
  input_tokens: 1000,
  output_tokens: 0,
  reasoning_tokens: 0,
  cached_tokens: 0,
  cost,
  ...extra,
});

const totalsOf = (rows) => summarize(rows).totals;
const byModelOf = (rows) => Object.fromEntries(summarize(rows).byModel.map((e) => [e.key, e]));

// --- the three shapes that must stay distinguishable ------------------------

check("cost:null is NOT counted in priced_requests", () => {
  const t = totalsOf([row("unpriced", null)]);
  if (t.priced_requests !== 0) throw new Error(`priced_requests=${t.priced_requests}, expected 0`);
  if (t.requests !== 1) throw new Error(`requests=${t.requests}, expected 1`);
});

check("cost:{total:0} IS counted as priced and contributes 0", () => {
  const t = totalsOf([row("zero-rate", costObj(0))]);
  if (t.priced_requests !== 1) throw new Error(`priced_requests=${t.priced_requests}, expected 1`);
  if (t.cost_usd !== 0) throw new Error(`cost_usd=${t.cost_usd}, expected 0`);
});

check("a priced cost object contributes its total", () => {
  const t = totalsOf([row("priced", costObj(0.00015))]);
  if (t.priced_requests !== 1) throw new Error(`priced_requests=${t.priced_requests}, expected 1`);
  if (Math.abs(t.cost_usd - 0.00015) > 1e-12) throw new Error(`cost_usd=${t.cost_usd}, expected 0.00015`);
});

check("priced and unpriced rows sum independently", () => {
  const t = totalsOf([row("a", costObj(0.00015)), row("b", null), row("c", costObj(0))]);
  if (t.requests !== 3) throw new Error(`requests=${t.requests}, expected 3`);
  if (t.priced_requests !== 2) throw new Error(`priced_requests=${t.priced_requests}, expected 2`);
  if (Math.abs(t.cost_usd - 0.00015) > 1e-12) throw new Error(`cost_usd=${t.cost_usd}, expected 0.00015`);
});

// --- the 口径 itself: a zero sum must be readable -----------------------------

check("all-unpriced rows: cost_usd 0 AND priced_requests 0", () => {
  const t = totalsOf([row("a", null), row("b", null, { ok: false, input_tokens: 0 })]);
  if (t.cost_usd !== 0) throw new Error(`cost_usd=${t.cost_usd}, expected 0`);
  if (t.priced_requests !== 0) throw new Error(`priced_requests=${t.priced_requests}, expected 0`);
  // The distinction the fix exists for: this is NOT the same as an all-zero-rate
  // set, which reports the same cost_usd but priced_requests === requests.
  const free = totalsOf([row("a", costObj(0)), row("b", costObj(0))]);
  if (free.cost_usd !== t.cost_usd) throw new Error("fixture error: zero-rate set should also sum to 0");
  if (free.priced_requests !== free.requests) {
    throw new Error(`all-zero-rate set must read as fully priced (priced=${free.priced_requests} of ${free.requests})`);
  }
  if (t.priced_requests === free.priced_requests) throw new Error("all-unpriced and all-free are indistinguishable");
});

check("empty row set: cost_usd 0, priced_requests 0", () => {
  const t = totalsOf([]);
  if (t.cost_usd !== 0 || t.priced_requests !== 0) throw new Error(JSON.stringify(t));
});

// --- malformed historical values ---------------------------------------------

check("a missing cost key (pre-pricing rows) is not priced", () => {
  const t = totalsOf([row("legacy", undefined)]);
  if (t.priced_requests !== 0) throw new Error(`priced_requests=${t.priced_requests}, expected 0`);
  if (t.cost_usd !== 0) throw new Error(`cost_usd=${t.cost_usd}, expected 0`);
});

for (const bad of [5, 0, "0.5", "", true, [], [costObj(1)]]) {
  check(`malformed cost ${JSON.stringify(bad)} is not priced and cannot corrupt cost_usd`, () => {
    const t = totalsOf([row("bad", bad), row("good", costObj(0.00015))]);
    if (t.priced_requests !== 1) throw new Error(`priced_requests=${t.priced_requests}, expected 1`);
    if (typeof t.cost_usd !== "number" || !Number.isFinite(t.cost_usd)) {
      throw new Error(`cost_usd is ${typeof t.cost_usd} (${t.cost_usd}), expected a finite number`);
    }
    if (Math.abs(t.cost_usd - 0.00015) > 1e-12) throw new Error(`cost_usd=${t.cost_usd}, expected 0.00015`);
  });
}

for (const badTotal of ["0.5", null, undefined, NaN, {}, [1]]) {
  check(`malformed total ${JSON.stringify(badTotal)} contributes 0, not a string/NaN`, () => {
    const t = totalsOf([row("bad-total", costObj(badTotal)), row("good", costObj(0.00015))]);
    if (t.priced_requests !== 2) throw new Error(`priced_requests=${t.priced_requests}, expected 2 (the object exists)`);
    if (typeof t.cost_usd !== "number" || !Number.isFinite(t.cost_usd)) {
      throw new Error(`cost_usd is ${typeof t.cost_usd} (${t.cost_usd}), expected a finite number`);
    }
    if (Math.abs(t.cost_usd - 0.00015) > 1e-12) throw new Error(`cost_usd=${t.cost_usd}, expected 0.00015`);
  });
}

// --- the grouping maps keep the same 口径 ------------------------------------

check("byModel / byProvider / byDay / byEffort split priced and unpriced the same way", () => {
  const rows = [
    row("priced-model", costObj(0.00015), { effort: "high" }),
    row("zero-model", costObj(0)),
    row("unpriced-model", null),
    row("unpriced-model", null),
  ];
  const s = summarize(rows);
  const m = Object.fromEntries(s.byModel.map((e) => [e.key, e]));
  if (m["priced-model"]?.priced_requests !== 1) throw new Error("byModel priced row not counted");
  if (m["zero-model"]?.priced_requests !== 1) throw new Error("byModel zero-rate row must count as priced");
  if (m["unpriced-model"]?.priced_requests !== 0) throw new Error("byModel unpriced rows must not count");
  if (m["unpriced-model"]?.requests !== 2) throw new Error("byModel must still count unpriced requests");
  if (s.byProvider.length !== 1 || s.byProvider[0].priced_requests !== 2) {
    throw new Error(`byProvider priced_requests=${s.byProvider[0]?.priced_requests}, expected 2`);
  }
  if (s.byDay.length !== 1 || s.byDay[0].priced_requests !== 2) {
    throw new Error(`byDay priced_requests=${s.byDay[0]?.priced_requests}, expected 2`);
  }
  if (s.byEffort.length !== 1 || s.byEffort[0].priced_requests !== 1) {
    throw new Error(`byEffort priced_requests=${s.byEffort[0]?.priced_requests}, expected 1 (only the high-effort row has effort set)`);
  }
});

// --- costOf is the single shared predicate -----------------------------------

check("costOf agrees with summarize on every shape (stats-api.mjs uses it too)", () => {
  const priced = [
    costObj(0),
    costObj(0.5),
    {},
  ];
  for (const c of priced) if (costOf({ cost: c }) === null) throw new Error(`expected priced: ${JSON.stringify(c)}`);
  const unpriced = [null, undefined, 0, 5, "0.5", true, [], [costObj(1)]];
  for (const c of unpriced) {
    if (costOf({ cost: c }) !== null) throw new Error(`expected unpriced: ${JSON.stringify(c)}`);
  }
  if (costOf(undefined) !== null) throw new Error("costOf(undefined) must be null");
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);

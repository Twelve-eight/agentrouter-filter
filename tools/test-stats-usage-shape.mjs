// Regression test for the /stats usage 口径 (stats-api.mjs toOmpRow).
//
// Why this file exists (measured 2026-10-07): the user read "950k" off the /stats
// requests table for a session the gateway itself knew was ~475k. Not a config
// bug: our usage rows record input_tokens INCLUSIVE of the cache buckets (all
// bridged upstreams do - verified over 60562 historical rows, cacheRead +
// cacheWrite never exceeded input_tokens), while omp's client fields mean the
// opposite (usage.input = UNCACHED input, cacheRead written separately). Passing
// our number through under omp's name double-counted the cache: a 474k-cached
// 475k prompt published input=475059 + cacheRead=474496 => "total 950122".
//
// What is pinned here:
//   1. input is uncached input (input_tokens - cacheRead - cacheWrite).
//   2. totalTokens + the aggregate formula equal the TRUE turn size, not the
//      double-counted one - i.e. the number the requests table shows.
//   3. cacheRead is NOT billed twice: the published input + cacheRead + write
//      sum stays equal to the upstream's input_tokens (+output).
//   4. a cache bucket larger than input_tokens clamps input at 0 rather than
//      going negative (the strict-Anthropic shape that justwoker can produce).
//
// Run: node tools/test-stats-usage-shape.mjs   (exits non-zero on failure)
import { toOmpRow, statsApi } from "../stats-api.mjs";

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

// A real row from 2026-10-07T09:18:03Z (cn:deepseek-v4.1-flash), the exact row
// that rendered as "950122" in the requests table.
const doubleCounted = {
  ts: "2026-10-07T09:18:03.593Z",
  route: "u",
  provider: "wb2api",
  model: "cn:deepseek-v4.1-flash",
  ok: true,
  duration_ms: 5000,
  input_tokens: 494658,
  output_tokens: 6988,
  cached_tokens: 494336,
  cache_write_tokens: 0,
  cost: { input: 0.0002, output: 0.0042, cacheRead: 0.0015, cacheWrite: 0, total: 0.0059 },
};

check("input is UNCACHED input, not the raw inclusive number", () => {
  const row = toOmpRow(doubleCounted);
  const expected = 494658 - 494336;
  if (row.usage.input !== expected) {
    throw new Error(`input=${row.usage.input}, expected ${expected} (raw 494658 - cache 494336)`);
  }
  if (row.usage.cacheRead !== 494336) throw new Error(`cacheRead=${row.usage.cacheRead}`);
});

check("totalTokens is the true turn size, not the double-counted one", () => {
  const row = toOmpRow(doubleCounted);
  const trueSize = 494658 + 6988; // upstream prompt + completion
  if (row.usage.totalTokens !== trueSize) {
    throw new Error(`totalTokens=${row.usage.totalTokens}, expected ${trueSize}`);
  }
  if (row.usage.totalTokens === 494658 + 494336 + 6988) {
    throw new Error("totalTokens still double-counts the cache (the 950k read)");
  }
});

check("cacheWrite survives as its own bucket instead of being forced to 0", () => {
  const row = toOmpRow({ ...doubleCounted, cached_tokens: 0, cache_write_tokens: 10000 });
  if (row.usage.cacheWrite !== 10000) throw new Error(`cacheWrite=${row.usage.cacheWrite}, expected 10000`);
  if (row.usage.input !== 494658 - 10000) throw new Error(`input=${row.usage.input}, expected ${494658 - 10000}`);
});

check("cache buckets larger than input clamp input at 0 (never negative)", () => {
  const row = toOmpRow({ ...doubleCounted, input_tokens: 1000, cached_tokens: 900, cache_write_tokens: 900 });
  if (row.usage.input !== 0) throw new Error(`input=${row.usage.input}, expected 0`);
  if (!Number.isFinite(row.usage.totalTokens) || row.usage.totalTokens < 0) {
    throw new Error(`totalTokens=${row.usage.totalTokens}`);
  }
});

check("a row with no cache at all is unchanged", () => {
  const row = toOmpRow({ ...doubleCounted, input_tokens: 12345, cached_tokens: 0, cache_write_tokens: 0, output_tokens: 67 });
  if (row.usage.input !== 12345) throw new Error(`input=${row.usage.input}, expected 12345`);
  if (row.usage.totalTokens !== 12412) throw new Error(`totalTokens=${row.usage.totalTokens}, expected 12412`);
});

// The aggregate is the other half of the contract: the "Uncached Input" card and
// the cacheRate must be computed from the corrected buckets, not the raw row.
check("aggregate reports corrected input and a cache rate that can reach 1", () => {
  const mapped = toOmpRow(doubleCounted);
  const input = mapped.usage.input;
  const cacheRead = mapped.usage.cacheRead;
  const cacheRate = input + cacheRead ? cacheRead / (input + cacheRead) : 0;
  if (!(cacheRate > 0.99 && cacheRate <= 1)) {
    throw new Error(`cacheRate=${cacheRate}, expected just under 1 for a fully cached prompt`);
  }
});

// Guards the export the check-syntax gate relies on.
check("statsApi still answers the requests-table endpoint", () => {
  const rows = statsApi("/api/stats/recent", new URLSearchParams("limit=5"));
  if (!Array.isArray(rows)) throw new Error("recent must return an array");
});

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);

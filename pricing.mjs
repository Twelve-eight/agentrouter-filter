// Model prices, read from omp's models.dev cache.
//
// Why that source: models.dev is the price table omp already uses, and it is
// cached locally in C:/Users/o_Obl/.omp/agent/models.db (`model_cache.models` is
// a JSON array per provider, each entry carrying
// `cost: {input, output, cacheRead, cacheWrite}` in USD per 1M tokens). Reading
// it beats hand-maintaining a price list, and it is the same authority the user's
// other tooling bills against.
//
// Nothing is invented: a model with no entry (or an all-zero one) reports no cost
// rather than a guess. `longContext` pricing is honoured when the input exceeds
// its threshold, since several models switch rates above 272k tokens.
//
// The DB is read once at startup and cached; it changes only when omp refreshes
// its catalog.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const DB = process.env.OMP_MODELS_DB ?? "C:/Users/o_Obl/.omp/agent/models.db";

// Only the model VENDOR's own entry is used. Resellers (charm-hyper, opencode-*,
// ollama-cloud, venice, github-copilot, kilo, zenmux, ...) list the same id at
// their own markup - deepseek-v4.1-flash is 0.15 there vs 0.3 from the vendor -
// and our upstreams are resellers that are absent from this table entirely, so
// their entry (if any) would not be our price either. Using the vendor keeps the
// number comparable across channels and stable over time.
const VENDORS = new Set([
  "openai",
  "anthropic",
  "google",
  "google-vertex",
  "deepseek",
  "moonshot",
  "zai",
  "xai",
  "mistral",
  "minimax",
  "minimax-cn",
  "alibaba",
  "qwen",
]);

// Models missing from models.db, priced by hand from the operator's own invoice.
//
// These are NOT guesses. Each entry records where the number came from so a
// future reader can re-derive it instead of trusting it.
//
// gpt-6.1-sol: the upstream (ovo) bills per its own panel. TWO measured
// requests, both 0.24x group and both listing input $2/M / output $10/M:
//   P1: input 41863, output 100, cacheRead 40192, charged $0.00286
//       -> official total $0.011917 -> implied cacheRead  $0.18846/M
//   P2: input 149785, output 419, cacheRead 145664, charged $0.009332
//       -> official total $0.038883 -> implied cacheRead  $0.18159/M
//   The two disagree by 3.8%, so the panel's own multi-stage rounding is wider
//   than any single clean candidate: the sol-family convention from models.db
//   ($0.2/M = 10% of a $0.4 input on gpt-5.6) misses BOTH invoices by more than
//   $0.185 does. $0.185/M is the value that minimises the worst relative error
//   across the two observations (+/-1.3%):
//     P1 -> $0.002827 charged (actual $0.00286)
//     P2 -> $0.009451 charged (actual $0.009332)
//   The 口径 check lives in the previous commit: cached tokens are billed at the
//   cache rate AND excluded from full-rate input; nothing else reproduces the
//   panel. If a third invoice points at a cleaner value, revisit.
//
//   LONG CONTEXT: the operator doubles EVERY line once the input passes 248k
//   tokens (measured on the same panel, 2026-10-03). The doubling is written out
//   explicitly rather than derived, because priceFor() replaces the rate set
//   wholesale.
const MANUAL = {
  "gpt-6.1-sol": {
    cost: {
      input: 2, output: 10, cacheRead: 0.185, cacheWrite: 2.5,
      longContext: { inputThreshold: 248000, input: 4, output: 20, cacheRead: 0.37, cacheWrite: 5 },
    },
    provider: "ovo (operator invoices 2026-10-03)",
    note: "cacheRead fitted to two 0.24x invoices; all rates double above 248k input",
  },
};

let INDEX = null;
let LOADED_FROM = null;

function load() {
  if (INDEX) return INDEX;
  INDEX = new Map();
  if (!fs.existsSync(DB)) {
    LOADED_FROM = `missing (${DB})`;
    return INDEX;
  }
  try {
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare("SELECT provider_id, models FROM model_cache").all();
    let n = 0;
    for (const r of rows) {
      let models;
      try {
        models = JSON.parse(r.models);
      } catch {
        continue;
      }
      if (!Array.isArray(models)) continue;
      if (!VENDORS.has(r.provider_id)) continue; // vendor list price only
      for (const m of models) {
        const c = m?.cost;
        if (!c || (!c.input && !c.output && !c.cacheRead && !c.cacheWrite)) continue;
        const prev = INDEX.get(m.id);
        if (prev) continue; // first vendor wins; ties are the same list price
        INDEX.set(m.id, { cost: c, provider: r.provider_id, vendor: true });
        n++;
      }
    }
    db.close();
    // Hand-priced entries win over models.db: they exist precisely because the
    // DB has no row for that id, and if it ever gains one we still trust the
    // invoice-derived number until someone re-derives it.
    let m = 0;
    for (const [id, entry] of Object.entries(MANUAL)) {
      INDEX.set(id, { cost: entry.cost, provider: entry.provider, vendor: false, manual: true });
      m++;
    }
    LOADED_FROM = `${n} priced models from ${DB}, ${m} hand-priced`;
  } catch (e) {
    LOADED_FROM = `read failed: ${e?.message ?? e}`;
  }
  return INDEX;
}

// Gateway id -> the vendor's OWN id in models.db. Needed because the ids differ:
// DeepSeek publishes `deepseek-flash` (display name "DeepSeek V4.1 Flash"), which
// no string transformation can derive from our `deepseek-v4.1-flash`. Without
// this the lookup fell through to a reseller's entry (charm-hyper, 0.3/1.2 with
// cacheRead 0.03 instead of the vendor's 0.006).
const ALIAS = {
  "deepseek-v4.1-flash": "deepseek-flash",
  "global:deepseek-v4.1-flash": "deepseek-flash",
  "global:deepseek-v4.1-flash-sg": "deepseek-flash",
  "cn:deepseek-v4.1-flash": "deepseek-flash",
  "deepseek-v4.1-flash-sg": "deepseek-flash",
  "deepseek-v4-flash": "deepseek-v4-flash",
  "cn:deepseek-v4-flash": "deepseek-v4-flash",
  "deepseek-v4-pro": "deepseek-v4-pro",
  "cn:deepseek-v4-pro": "deepseek-v4-pro",
  // Gateway-namespaced spellings of gpt-6.1-sol. The gateway records the CLIENT's
  // model string, and clients pick from the catalog where these appear as
  // rc:6.1sol / rc65:6.1sol / ovoapi:6.1sol. Stripping the prefix alone yields
  // "6.1sol", which matches nothing, so each needs an explicit alias.
  "rc:6.1sol": "gpt-6.1-sol",
  "rc65:6.1sol": "gpt-6.1-sol",
  "ovoapi:6.1sol": "gpt-6.1-sol",
  "6.1sol": "gpt-6.1-sol",
};

/** Strip a routing namespace so `global:gpt-5.6-sol` can match `gpt-5.6-sol`. */
function candidates(model) {
  const out = [];
  const alias = ALIAS[model];
  if (alias) out.push(alias);
  out.push(model);
  const bare = String(model).replace(/^[a-z0-9-]+:/i, "");
  if (bare !== model) {
    if (ALIAS[bare]) out.push(ALIAS[bare]);
    out.push(bare);
  }
  return out;
}

/**
 * Price for one request. `usage` uses the responses/chat shape.
 * Returns null when no price is known - callers must show "n/a", never 0.
 */
function priceFor(model, usage, provider = null) {
  const idx = load();
  let hit = null;
  for (const c of candidates(model)) {
    hit = idx.get(c);
    if (hit) break;
  }
  if (!hit) return null;
  // hit.provider is the VENDOR whose list price this is, not our reseller.
  const vendor = hit.provider;

  const inTok = usage?.input_tokens ?? 0;
  const outTok = usage?.output_tokens ?? 0;
  const cacheRead = usage?.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = usage?.input_tokens_details?.cache_write_tokens ?? 0;

  // Long-context rates replace the base rates once input crosses the threshold.
  let c = hit.cost;
  let tier = "base";
  if (c.longContext && inTok > (c.longContext.inputThreshold ?? Infinity)) {
    // Read the threshold BEFORE overwriting the rate set: the tier label used to
    // be built from c.longContext after reassignment, so it always printed
    // "long (?+ input)" instead of the real threshold.
    const threshold = c.longContext.inputThreshold;
    c = {
      input: c.longContext.input,
      output: c.longContext.output,
      cacheRead: c.longContext.cacheRead,
      cacheWrite: c.longContext.cacheWrite,
    };
    tier = `long (${threshold}+ input)`;
  }

  // Cached input is billed at the cache rate, so it must not also be charged at
  // the full input rate. Upstreams report cached_tokens as part of input_tokens.
  const billableIn = Math.max(0, inTok - cacheRead);
  const perM = (tok, rate) => (tok / 1e6) * (rate ?? 0);

  // Off-peak discount (deepseek-style: reduced rate outside the peak windows).
  let discount = 1;
  let peak = null;
  const tb = hit.cost.timeBased;
  if (tb?.offPeakMultiplier && Array.isArray(tb.peakWindows)) {
    const now = new Date();
    const wd = now.getDay();
    const mins = now.getHours() * 60 + now.getMinutes();
    const inPeak = tb.peakWindows.some(
      (w) => Array.isArray(w.weekdays) && w.weekdays.includes(wd) && mins >= w.startMinute && mins < w.endMinute,
    );
    if (!inPeak) discount = tb.offPeakMultiplier;
    peak = inPeak ? "peak" : "off-peak";
  }

  const parts = {
    input: perM(billableIn, c.input) * discount,
    cacheRead: perM(cacheRead, c.cacheRead) * discount,
    cacheWrite: perM(cacheWrite, c.cacheWrite) * discount,
    output: perM(outTok, c.output) * discount,
  };
  const total = parts.input + parts.cacheRead + parts.cacheWrite + parts.output;
  return {
    ...parts,
    total,
    tier,
    vendor,
    // Reference list price of the model's vendor, NOT our reseller's charge.
    estimate: true,
    peak,
    discount,
    rates: c,
  };
}

function priceInfo() {
  load();
  return LOADED_FROM;
}

export { priceFor, priceInfo };

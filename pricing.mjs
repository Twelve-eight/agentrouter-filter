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
  // Claude 5.5 line. models.db currently ships no row for either id, so the
  // numbers below come straight from Anthropic's own pricing page
  // (docs.anthropic.com/en/docs/about-claude/pricing, read 2026-10-07):
  //   Claude Opus 5.5   $4 / $20   cache 5m-write $5   hits $0.20
  //   Claude Sonnet 5.5 $2 / $10   cache 5m-write $2.50 hits $0.20
  // cacheWrite uses the 5-minute rate; the 1-hour rate ($8 / $4) is only used
  // when a caller explicitly asks for 1h caching, which we never do.
  // Free tiers. $0 is the ACTUAL price, not a missing value - these ids are
  // only reachable through opencode-zen's free tier, which bills nothing.
  // Recorded so the dashboard shows a real 0 instead of "n/a"; if zen ever
  // starts charging for them, replace these with the invoice-derived numbers.
  "space-bunny-free": {
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    provider: "opencode-zen free tier",
    note: "free tier - $0 by design, not a missing price",
  },
  "zen:space-bunny": {
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    provider: "opencode-zen free tier",
    note: "free tier - $0 by design, not a missing price",
  },
  "mimo-v2.6-flash-free": {
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    provider: "opencode-zen free tier",
    note: "free tier - $0 by design, not a missing price",
  },
  "zen:mimo-v2.6-flash": {
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    provider: "opencode-zen free tier",
    note: "free tier - $0 by design, not a missing price",
  },
  "claude-opus-5-5": {
    cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    provider: "anthropic (official pricing page 2026-10-07)",
    note: "Opus 5.5 - $4/$20, cache write $5 (5m), hits $0.20",
  },
  "claude-sonnet-5-5": {
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    provider: "anthropic (official pricing page 2026-10-07)",
    note: "Sonnet 5.5 - $2/$10, cache write $2.50 (5m), hits $0.20",
  },
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
  // northstar-kiro serves the CURRENT Claude line under dotted ids. models.db
  // spells them with hyphens (claude-opus-5-5 / claude-sonnet-5-5), and the
  // vendor's own page (docs.anthropic.com .../pricing, read 2026-10-07) lists
  // Opus 5.5 at $4/$20 and Sonnet 5.5 at $2/$10. Without these the lookup
  // missed entirely and both kiro models showed "n/a" in the dashboard.
  "ki:opus5.5": "claude-opus-5-5",
  "ki:sonnet5.5": "claude-sonnet-5-5",
  // antigravity's Gemini id carries an effort suffix the vendor id does not.
  // Google's own pricing page (ai.google.dev/gemini-api/docs/pricing, read
  // 2026-10-07) lists gemini-3.8-flash at $0.75/$3.75 with $0.075 cache read
  // (promotional through 2026-12-31; doubles on 2027-01-01).
  "ag:gemini3.8h": "gemini-3.8-flash",
  "gemini-3.8-flash-high": "gemini-3.8-flash",
  // Hidden-but-spawnable slugs. visibility:"hide" only narrows the picker -
  // the whole catalog can still be selected as a sub-agent model - so an
  // unpriced entry here is still a real spend the dashboard cannot show.
  // Each alias maps our routing slug onto the vendor id in models.db.
  // Verified against the db on 2026-10-07 (see the existence probe in DEVLOG).
  "gpt-6-astra-ar": "gpt-6-astra",
  "gpt-6-astra-an": "gpt-6-astra",
  "ovoapi:6astra": "gpt-6-astra",
  "rc65:6astra": "gpt-6-astra",
  "rc:5.6luna": "gpt-5.6-luna",
  "rc65:5.6luna": "gpt-5.6-luna",
  "ovoapi:5.6terra": "gpt-5.6-terra",
  "rc65:5.6terra": "gpt-5.6-terra",
  "rc65:5.6sol": "gpt-5.6-sol",
  "gpt-5.6-sol-ar": "gpt-5.6-sol",
  "rc:5.6solc": "gpt-5.6-sol",
  "rc:5.6": "gpt-5.6",
  "rc65:5.5": "gpt-5.5",
  "rc:5.5c": "gpt-5.5",
  "rc:5.6c": "gpt-5.6",
  "ag:sonnet4-5": "claude-sonnet-4-5",
  "ag:sonnet4-6": "claude-sonnet-4-6",
  "ag:haiku4-5": "claude-haiku-4-5",
  "ag:opus4-6": "claude-opus-4-6",
  "ag:opus4-6t": "claude-opus-4-6",
  "ovo05:opus5": "claude-opus-5",
  "ovo05:sonnet5": "claude-sonnet-5",
  "ovoapi:claude-opus-5.5": "claude-opus-5-5",
  "ovo05:opus5.5": "claude-opus-5-5",
  "mimo-v2.6-flash-free": "mimo-v2.6-flash",
  "zen:mimo-v2.6-flash": "mimo-v2.6-flash",
  "cn:minimax-m3": "MiniMax-M3",
  "cn:kimi-k3-1": "kimi-k3",
  "ovoapi:claude-opus-4.8": "claude-opus-4-8",
  "rc:5.6solc": "gpt-5.6-sol",
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
  //
  // The WRITE bucket is subtracted too. On the Anthropic wire `input_tokens`
  // already INCLUDES cache_creation (measured 2026-10-03: a 10367-token write
  // reported input_tokens 10369), so billing the full input rate on those tokens
  // AND the write rate on top would double-charge the whole prompt. Read and
  // write are never both non-zero in one turn, so the subtraction is safe even
  // when a provider reports them separately.
  const billableIn = Math.max(0, inTok - cacheRead - cacheWrite);
  // Two upstream conventions exist and both reach this function:
  //   (a) cache is a SUBSET of input_tokens  (wb2api / OpenAI-style
  //       prompt_tokens, and the Anthropic wire as justwoker reports it -
  //       measured 2026-10-03), so the cache share is subtracted above;
  //   (b) cache is NOT part of input_tokens (the strict Anthropic reading).
  //       Subtracting there would under-bill the uncached remainder, because
  //       cacheRead + cacheWrite can exceed inTok and clamp billableIn to 0.
  // Detect (b) arithmetically and undo the subtraction for that row only.
  // Real rows sit far from the boundary (a ~350k-token Claude turn reports a
  // few hundred UNcached tokens beside a ~350k cache write), so the test is
  // unambiguous in practice; a provider that reports cache > input is
  // self-identifying as convention (b).
  const cacheIsSubset = cacheRead + cacheWrite <= inTok;
  const billableUncached = cacheIsSubset ? billableIn : inTok;
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
    input: perM(billableUncached, c.input) * discount,
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

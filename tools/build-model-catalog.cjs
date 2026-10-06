// Build ~/.codex/omp-model-catalog.json = built-in catalog + our upstream models.
//
// Why merge: `model_catalog_json` REPLACES the whole catalog (verified: pointing it
// at the 5-entry file drops gpt-6-astra/gpt-5.5/gpt-5.4/... entirely). Codex renders
// its built-in catalog via `codex debug models`, and that output round-trips
// byte-identically as an input catalog (verified), so the built-in entries are taken
// verbatim from there and our models appended.
//
// Slug = the literal model id sent upstream. Codex forwards the slug verbatim
// (verified: `agentrouter/deepseek-v4-flash` reached ps.air-outer.com as-is), and it
// does NOT accept a per-entry provider field (model_provider/provider are dropped).
// The provider therefore comes from config.toml/profile, and the picker is global.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CODEX = 'G:/omp works/.tooling/npm-global/codex.cmd';
const OUT = path.join(os.homedir(), '.codex', 'omp-model-catalog.json');
const TMP = path.join('G:/omp works/.tmp', 'catalog-builtin.json');
// Read the BUILT-IN catalog through a scratch CODEX_HOME that has no
// model_catalog_json. Reading through the real CODEX_HOME would be circular:
// once config.toml points at OUT, `debug models` renders OUT, so the script would
// take its own previous output as "built-in" and could never recover from a bad
// write (it happens to be idempotent today, but it would bake in any mistake).
const SCRATCH = 'G:/omp works/.tmp/codex-scratch-home';
fs.mkdirSync(SCRATCH, { recursive: true });
fs.writeFileSync(path.join(SCRATCH, 'config.toml'), 'model = "gpt-5.2"\n');

// 1) built-in catalog, verbatim
const raw = execFileSync('cmd.exe', ['/c', CODEX, 'debug', 'models'], {
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
  env: { ...process.env, CODEX_HOME: SCRATCH },
});
const builtin = JSON.parse(raw);
if (!Array.isArray(builtin.models) || builtin.models.length < 5) {
  throw new Error(`refusing to build: built-in catalog looks wrong (${builtin.models?.length} models)`);
}
// Guard: the built-in catalog must NOT contain our additions, otherwise we are
// reading our own output again (e.g. CODEX_HOME was ignored).
const ours_present = builtin.models.some((m) => m.slug === 'global:kimi-k3');
if (ours_present) {
  throw new Error('refusing to build: read a catalog that already contains our models (circular read)');
}
fs.writeFileSync(TMP, JSON.stringify(builtin));

const LEVELS = {
  minimal: 'Minimal reasoning for the fastest responses',
  low: 'Fast responses with lighter reasoning',
  medium: 'Balances speed and reasoning depth for everyday tasks',
  high: 'Greater reasoning depth for complex problems',
  xhigh: 'Extra high reasoning depth for complex problems',
  max: 'Maximum reasoning depth for the hardest problems',
};
const levels = (...names) =>
  names.map((e) => ({
    effort: e,
    // codex rejects the catalog if a level has no description, so never emit an
    // undefined one for a level we did not anticipate (minimal/xhigh came from
    // wb2api's published set).
    description: LEVELS[e] ?? `${e} reasoning depth`,
  }));
const BASE = 'You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user\'s goals.';

// 2) our models. `slug` must equal the upstream model id.
//
// `default_reasoning_level` is NOT cosmetic: when the TUI picker is used, codex
// writes the chosen model AND this default level into config.toml, overwriting the
// user's global `model_reasoning_effort`. Deriving it from the effort list (the
// original `efforts[0]`) made every picker click silently downgrade the user's
// `max` to `low`. Default to `max`: it matches the level the user has configured,
// so picking one of our models changes nothing they did not ask for. `max` is
// verified accepted by both the agentrouter and wb2api paths.
const DEFAULT_EFFORT = 'max';

// PICKER SCOPE (2026-10-06, user decision).
//
// The user reviewed the full usage-ranked inventory and named the models they
// want offered, in this order. Everything else is marked visibility "hide":
// it disappears from the picker and from the spawn_agent hint, but stays in the
// catalog and therefore stays ROUTABLE and SPAWNABLE by name.
//
// Why hide instead of deleting the entries:
//   - the desktop title generator calls the built-in slug gpt-5.6-luna on every
//     new thread; dropping it from the registry reproduced the 503 storm
//     documented in DEVLOG 2026-09-22;
//   - the auto-review feature calls codex-auto-review;
//   - the user's standing rule is that EVERY registered model must remain
//     usable as a sub-agent (find_spawn_agent_model_name never consults
//     visibility - child_config.rs:323-329).
// Hiding satisfies all three: model/list filters on show_in_picker, so the
// picker shows exactly the models below, while the routes stay alive.
//
// The trailing comment numbers are the ranks from the inventory published to
// the user on 2026-10-06 (7-day half-life weighted, data/usage/*.jsonl).
//
// HINT: spawn_agent's "Available model overrides" block is capped at 5
// (MAX_SPAWN_AGENT_MODEL_OVERRIDES, child_config.rs:20) and is filled from the
// head of the picker order, so the first five entries below are the five names
// that block advertises.
const KEEP_SLUGS = [
  'ovoapi:6.1sol',              // #2  - second-heaviest route in the pool
  'global:deepseek-v4.1-flash', // #1  - the workhorse dev model
  'cn:deepseek-v4.1-flash',     // #3  - the fallback realm
  'claude-opus-4-8',            // #5  - user-requested; anthropic RETURN path
  'ki:opus5.5',                 // #15 - northstar kiro
  'space-bunny-free',           // #12 - zen free tier
  'deepseek-v4-flash',          // #14 - agentrouter
  'global:gpt-6-astra',         // #25 - wb2api
  'ki:sonnet5.5',               // #29 - northstar kiro
  'rc65:6.1sol',                // #30 - relaycat 0.065 group
  'ag:gemini3.8h',              // new - antigravity gemini-3.8-flash-high
];
const KEEP_SET = new Set(KEEP_SLUGS);
// The five names spawn_agent advertises: the head of the picker order.
const HINT_SLUGS = new Set(KEEP_SLUGS.slice(0, 5));
// Display names. Two rules, both requested by the user:
//   1. the route marker is the GROUP MULTIPLIER, not the word "via" - "(0.065)"
//      reads as "served through the 0.065x group" and is shorter;
//   2. model ids are abbreviated (gpt-6-sol -> 6sol, claude-opus-5 -> opus5), so
//      the picker line stays readable.
// A provider with no known ratio falls back to its short name in the marker, so
// nothing is ever left unlabelled.
const PROVIDER_ABBR = {
  agentrouter: 'ar',
  relaycat: 'rc',
  relaycat65: 'rc65',
  'relaycat-cn': 'cn',
  wb2api: 'wb',
  anyrouter: 'an',
  justwoker: 'jw',
  'northstar-kiro': 'ki',
  'opencode-zen': 'zen',
  motomoto: 'moto',
  ovoapi: 'ovo',
  'ovoapi-amz': 'ovo',
  antigravity: 'ag',
};

// Shorten a model id for display. Deliberately conservative: only the shapes we
// actually serve are rewritten, so an unknown id passes through untouched rather
// than being mangled.
function shortModel(id) {
  let s = String(id);
  // A realm prefix is meaningful (global vs cn pool) and stays, but as a compact
  // tag rather than a word that eats the line: 'global x' -> 'G x', 'cn x' -> 'C x'.
  let prefix = '';
  const realm = s.match(/^(global|cn):/);
  if (realm) { prefix = (realm[1] === 'global' ? 'G ' : 'C '); s = s.slice(realm[0].length); }
  s = s
    .replace(/^gpt-/, '')
    .replace(/^claude-/, '')
    .replace(/^deepseek-v/, 'dsv')
    .replace(/^deepseek-/, 'ds')
    .replace(/^gemini-/, 'gem')
    .replace(/^mimo-v/, 'mimo')
    // Word-level shorthands. Order matters: longest first, so '-flash-free'
    // is not half-eaten by '-free'.
    .replace(/codex-auto-review/g, 'review')
    .replace(/-openai-compact$/, '-c')
    .replace(/-flash-free$/, 'f')
    .replace(/-flash$/, 'f')
    .replace(/-free$/, 'f')
    .replace(/-thinking$/, '-t')
    .replace(/-preview$/, '')
    .replace(/-tiered$/, '-t');
  return prefix + s;
}

/** The "(marker)" shown after a display name: the ratio when known, else the short provider name. */
function routeMarker(slug, spec) {
  const ratio = REGISTRY.providers[spec?.p]?.ratio;
  if (typeof ratio === 'number') return String(ratio);
  return PROVIDER_ABBR[spec?.p] ?? spec?.p ?? '?';
}

function entry(slug, display, description, efforts, contextWindow, modalities = ["text"]) {
  return {
    slug,
    display_name: display,
    description,
    base_instructions: BASE,
    default_reasoning_level: DEFAULT_EFFORT,
    supported_reasoning_levels: levels(...efforts),
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    // `priority` has TWO independent meanings, both verified on 2026-09-22 by
    // capturing the request body with a local proxy:
    //   priority > 0  - ordering among the built-in entries in the picker list.
    //   priority < 0  - the entry is listed in spawn_agent's "Available model
    //                   overrides" HINT text (max 5 shown). Negative priority does
    //                   NOT gate spawning: the validator accepts any catalog entry.
    //                   So 0 (default) keeps an entry routable and pickable while
    //                   leaving the hint list alone.
    // HINT_SLUGS below chooses which 5 models get advertised in the hint.
    priority: HINT_SLUGS.has(slug) ? -1 : 0,
    supports_reasoning_summaries: true,
    default_reasoning_summary: 'none',
    support_verbosity: false,
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: false,
    context_window: contextWindow,
    max_context_window: contextWindow,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: modalities,
    supports_search_tool: false,
  };
}

// Models that accept IMAGE input, measured through the gateway - not inferred from
// the model family and not copied from a vendor page.
//
// Why this table exists: `input_modalities` was hardcoded to ['text'] for every
// entry, so Codex believed no routed model could read a picture and refused to
// attach one. The DeepSeek flash routes do accept images - verified 2026-10-03 by
// POSTing a 1x1 PNG through the live gateway (port 7878, /u/v1/chat/completions)
// and through wb2api directly (7863): all six ids below answered 200 and named the
// colour, so the picture reached the model rather than being dropped.
//
// Add an id here only after that probe. A wrong "image" claim makes the picker
// offer a picture the upstream will reject; a wrong "text" claim silently strips
// the image (the old bug), which is worse because it fails without an error.
const VISION_SLUGS = new Set([
  'deepseek-v4.1-flash',
  'global:deepseek-v4.1-flash',
  'global:deepseek-v4.1-flash-sg',
  'cn:deepseek-v4.1-flash',
  'deepseek-v4-flash',
  'cn:deepseek-v4-flash',
]);

// The model list comes from providers.json - the same file the gateway routes on.
// Hand-maintaining a second list here is how the picker and the gateway would
// drift apart (a model could appear in one and not the other). The label is
// derived from the provider so the origin stays visible in the picker.
const REGISTRY = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "providers.json"), "utf8"));

// Context windows come from omp's models.yml - the same file the user's other
// tooling is configured from, and the only place the real limits are recorded
// (agentrouter/relaycat publish no context_length). wb2api publishes its own per
// model and is queried below. Anything still unknown falls back to CTX_DEFAULT,
// marked UNVERIFIED rather than presented as measured.
const MODELS_YML = process.env.OMP_MODELS_YML ?? "C:/Users/o_Obl/.omp/agent/models.yml";
const CTX_DEFAULT = 200000; // UNVERIFIED for providers that publish nothing
const CTX_YML = {};
try {
  // Minimal parse: `- id: <model>` followed by `contextWindow: <n>` in the same
  // entry. A YAML dependency is not worth it for two keys.
  const text = fs.readFileSync(MODELS_YML, "utf8");
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const idm = line.match(/^\s*-\s*id:\s*(\S+)/);
    if (idm) { current = idm[1]; continue; }
    const cwm = line.match(/^\s*contextWindow:\s*(\d+)/);
    if (cwm && current) { CTX_YML[current] = Number(cwm[1]); current = null; }
  }
  console.log(`context windows: ${Object.keys(CTX_YML).length} from models.yml`);
} catch (e) {
  console.log(`context windows: models.yml unreadable (${e?.message?.slice(0, 40)}); using defaults`);
}
const CTX = {};
const EFF = {};
try {
  const raw = require("node:child_process").execFileSync(
    "curl",
    ["-s", "-m", "20", "http://127.0.0.1:7863/v1/models", "-H", `Authorization: Bearer ${process.env.WORKBUDDY_API_KEY ?? "sk-workbuddy"}`],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  for (const m of JSON.parse(raw).data ?? []) {
    if (m.context_length > 0) CTX[m.id] = m.context_length;
    // Same payload also carries the authoritative effort set. Guessing it gave
    // models levels they reject (gpt-5.3-codex is medium-only; deepseek-v4-pro is
    // high/xhigh) and hid levels they accept (minimal, xhigh).
    if (Array.isArray(m.reasoning_supported_efforts) && m.reasoning_supported_efforts.length) {
      EFF[m.id] = m.reasoning_supported_efforts;
    }
  }
  console.log(`context windows: ${Object.keys(CTX).length}, effort sets: ${Object.keys(EFF).length} from wb2api`);
} catch (e) {
  console.log(`context windows: wb2api unreachable (${e?.message?.slice(0, 40)}); using defaults`);
}

// Fallback only: agentrouter and relaycat publish no effort metadata, so their
// entries keep this set. wb2api publishes `reasoning_supported_efforts` per model
// and that wins (see EFF above).
const EFFORTS_DEFAULT = ["low", "medium", "high", "max"];

// Last-known context windows, read back from the catalog this script previously
// wrote. Needed because the live sources are not always complete: wb2api lists
// only the models whose account pool is currently healthy, so while the global
// accounts are cooling its global:* entries vanish from /v1/models and every one
// of them silently fell back to CTX_DEFAULT (200000 instead of 1000000) - which
// then made them compact at ~190k. Precedence keeps live data authoritative
// (CTX > CTX_YML > CTX_PREV > default), so a genuine upstream correction still
// wins; this only fills gaps a temporary outage would otherwise turn into a
// permanent downgrade.
const CTX_PREV = {};
try {
  const prev = JSON.parse(fs.readFileSync(OUT, "utf8"));
  for (const m of prev.models ?? []) {
    if (m.slug && m.context_window > 0) CTX_PREV[m.slug] = m.context_window;
  }
} catch {
  // no previous catalog (first run) - nothing to remember
}

// The effort levels the GATEWAY will actually forward. providers.json is the
// single source of truth for the clamp (see providerFor() in server.mjs): a model
// may narrow its provider's window with its own `efforts` array. Advertising the
// unclamped set here makes the picker a liar - the user selects `max`, the gateway
// rewrites it to `high`, and nothing says so. Measured 2026-09-24: zen's
// mimo-v2.6-flash-free inherited [low,medium,high] while the catalog advertised
// `max` from the EFFORTS_DEFAULT guess, and space-bunny-free (which accepts all six
// levels) was advertised WITHOUT minimal/xhigh. Precedence mirrors the gateway:
// model clamp > provider clamp > live upstream metadata > built-in default.
function clampWindow(slug) {
  const spec = REGISTRY.models[slug];
  const prov = spec && REGISTRY.providers[spec.p];
  if (Array.isArray(spec?.efforts) && spec.efforts.length) return spec.efforts;
  if (Array.isArray(prov?.efforts) && prov.efforts.length) return prov.efforts;
  return null;
}

const ours = Object.entries(REGISTRY.models)
  .filter(([, v]) => v && typeof v === "object")
  .map(([slug, spec]) => {
    const prov = spec.p;
    const upstream = spec.m ?? slug;
    return entry(
      slug,
      `${shortModel(spec.m ?? slug)} (${routeMarker(slug, spec)})`,
      `${upstream} served by ${prov} through the local gateway`,
      clampWindow(slug) ?? EFF[slug] ?? EFFORTS_DEFAULT,
      CTX[slug] ?? CTX_YML[spec.m ?? slug] ?? CTX_YML[slug] ?? CTX_PREV[slug] ?? CTX_DEFAULT,
      VISION_SLUGS.has(slug) ? ['text', 'image'] : ['text'],
    );
  })
  // The registry also lists codex's built-in slugs (the gateway must route them),
  // but their catalog entries already exist and are richer. Drop them here: the
  // built-in entry wins below, and reporting that as a "collision" would be noise.
  .filter((m) => !builtin.models.some((b) => b.slug === m.slug));
// ---------------------------------------------------------------------------
// Ordering: most-used first, from the gateway's own ledger.
//
// The picker renders this catalog sorted by `priority` ascending and breaks ties
// on ARRAY ORDER - both verified 2026-10-06 against a synthetic catalog:
// `zz-b(-2), zz-d(-1), zz-a(0), zz-c(1)` came back in exactly that order, and
// seven entries all sharing `-1` came back in the order they were written.
//
// So moving a model up the picker means moving it up this array. That is also
// the ONLY lever available here, because `priority` is already spoken for in
// both directions: values < 0 additionally fill spawn_agent's override hint (the
// five smallest win - measured with 7 negatives, only the first 5 were listed)
// and the built-ins own the positive band (1..43). Reordering the array leaves
// both of those semantics exactly as they are.
//
// (Fractional priorities are not an option either: a catalog using them was
// rejected outright and codex fell back to its built-in five. Integers only.)
//
// The signal is the gateway's usage ledger (`data/usage/YYYY-MM-DD.jsonl`, one
// row per completed request - see usage.mjs). Recency is weighted with a 7-day
// half-life so the picker surfaces what is in use NOW rather than what a one-off
// probe session hammered two weeks ago. Models with no recorded traffic score 0
// and keep their registry position, below everything that has traffic.
//
// Only day-named files are read: `*.phantom-merged.jsonl` is a repaired copy of
// a single day and was verified on 2026-10-06 to be a 100% subset of that day's
// file, so globbing it would double-count those rows.
//
// Degrades safely: a missing or unreadable ledger leaves the order untouched
// (the pre-existing registry order) rather than failing the build.
const USAGE_HALF_LIFE_DAYS = 7;
function usageScores() {
  const dir = process.env.AR_USAGE_DIR
    ? path.resolve(process.env.AR_USAGE_DIR)
    : path.join(__dirname, "..", "data", "usage");
  const scores = new Map();
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  } catch {
    return scores;
  }
  const now = Date.now();
  for (const name of names) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // a torn last line after a crash
      }
      if (!row || typeof row.model !== "string" || typeof row.provider !== "string") continue;
      const ts = Date.parse(row.ts);
      const ageDays = Number.isFinite(ts) ? Math.max(0, (now - ts) / 86400000) : 0;
      const key = `${row.provider}|${row.model}`;
      scores.set(key, (scores.get(key) ?? 0) + Math.pow(0.5, ageDays / USAGE_HALF_LIFE_DAYS));
    }
  }
  return scores;
}
const USAGE_SCORES = usageScores();
function usageScoreOf(slug) {
  const spec = REGISTRY.models[slug];
  if (!spec || typeof spec !== "object") return 0;
  return USAGE_SCORES.get(`${spec.p}|${spec.m ?? slug}`) ?? 0;
}
const oursOrdered = (() => {
  // The kept models lead, in the exact order the user listed them. The rest
  // follow in usage order - they are hidden from the picker, but their position
  // still decides where they would reappear if one is ever un-hidden.
  const rank = new Map(KEEP_SLUGS.map((slug, i) => [slug, i]));
  const missing = KEEP_SLUGS.filter((slug) => !ours.some((m) => m.slug === slug));
  if (missing.length) {
    throw new Error(`refusing to build: KEEP_SLUGS names models the registry does not serve: ${missing.join(', ')}`);
  }
  const kept = ours
    .filter((m) => rank.has(m.slug))
    .sort((a, b) => rank.get(a.slug) - rank.get(b.slug));
  const rest = ours
    .filter((m) => !rank.has(m.slug))
    .map((m, i) => ({ m, i, score: usageScoreOf(m.slug) }))
    // Stable: equal scores - including the whole no-traffic tail - keep registry order.
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
    .map((x) => x.m);
  console.log(`picker: ${kept.length} listed, ${rest.length} hidden`);
  return [...kept, ...rest];
})();

// 3) merge, built-ins first.
//
// On a slug collision the BUILT-IN entry wins: codex authors it for that exact
// model and it carries fields ours does not set (model_messages, the
// model-specific base_instructions, tool_mode, multi_agent_version,
// experimental_supported_tools, ..), so overlaying our thinner entry would lose
// real behaviour.
//
// But the collision MUST NOT be silent: a collision means the entry below is dead
// code, so a later edit here (e.g. changing reasoning levels) would appear to do
// nothing. Report every ignored field difference instead.
const RICH_ONLY = ['base_instructions', 'model_messages', 'tool_mode', 'multi_agent_version'];
const have = new Set(builtin.models.map((m) => m.slug));
const added = oursOrdered.filter((m) => !have.has(m.slug));
const collisions = oursOrdered.filter((m) => have.has(m.slug));

// Only built-ins the registry can route: the picker must never offer a model
// that /u would answer 404 for. (codex-auto-review, gpt-daybreak-* were listed
// by codex but served by nobody; codex-auto-review is now in the registry.)
// Guard: the spawn_agent override list is capped at 5 entries and is filled in
// catalog order, built-ins first. A built-in entry with a negative priority would
// therefore silently evict one of HINT_SLUGS. Today every built-in uses a
// positive value (astra 1 .. codex-auto-review 43) - fail loudly if that changes,
// rather than shipping a sub-agent list that quietly lost a model.
const builtinNegative = builtin.models.filter((m) => typeof m.priority === "number" && m.priority < 0);
if (builtinNegative.length) {
  throw new Error(
    `refusing to build: built-in entries now use a negative priority (${builtinNegative.map((m) => `${m.slug}=${m.priority}`).join(', ')}); ` +
      'they would occupy slots in the spawn_agent override list - re-check that list before proceeding',
  );
}
if (HINT_SLUGS.size > 5) {
  throw new Error(`refusing to build: HINT_SLUGS has ${HINT_SLUGS.size} entries but the spawn_agent override list only shows 5`);
}
const ROUTED = new Set(Object.keys(REGISTRY.models).filter((k) => REGISTRY.models[k] && typeof REGISTRY.models[k] === "object"));
const droppedBuiltins = builtin.models.filter((m) => !ROUTED.has(m.slug)).map((m) => m.slug);
const keptBuiltins = builtin.models.filter((m) => ROUTED.has(m.slug));

const merged = { models: [...keptBuiltins, ...added] };

// Picker scope, enforced over the WHOLE catalog (built-ins included). Built-in
// entries are not in KEEP_SLUGS, so they are hidden too - they stay routable
// through the gateway, which is all the title generator and auto-review need.
for (const m of merged.models) {
  m.visibility = KEEP_SET.has(m.slug) ? 'list' : 'hide';
}

// 4) Normalize the default reasoning level across the WHOLE catalog, built-ins
//    included.
//
//    The picker pre-selects an entry's default and writes it back to config.toml
//    as the global `model_reasoning_effort`. Codex's built-in defaults are
//    low/medium (gpt-6-astra is `low`), so picking the user's own model would
//    silently downgrade their configured `max` - verified with cn:kimi-k3-1
//    before this was fixed. Normalizing only our own entries would leave that
//    trap on every built-in entry the user might click.
//
//    Respect each entry's supported set: max is not universal (gpt-5.5 and
//    gpt-5.4 stop at xhigh), and a level the model rejects would turn a picker
//    click into an upstream 422.
const PREFERENCE = ['max', 'xhigh', 'high'];
for (const m of merged.models) {
  const supported = (m.supported_reasoning_levels ?? []).map((l) => l.effort);
  if (!supported.length) continue;
  // If none of the preferred levels is offered (gpt-5.3-codex is medium-only),
  // fall back to the model's highest supported level rather than leaving the
  // entry's construction default in place - that default may not be supported at
  // all, and the picker writes whatever is here straight into config.toml.
  const best = PREFERENCE.find((e) => supported.includes(e)) ?? supported[supported.length - 1];
  m.default_reasoning_level = best;
}
// Every gpt-* route must offer `xhigh`.
//
// User requirement 2026-10-02: "all GPT models should be usable at xhigh". The
// catalog's supported_reasoning_levels is what Codex validates a requested effort
// against (agent/child_config.rs -> validate_spawn_agent_reasoning_effort), so a
// level missing here is a level the user cannot pick - even when the upstream
// accepts it. Probed through the live gateway 2026-10-02: gpt-5.5, gpt-5.6-sol,
// global:gpt-5.3-codex, rc:6, rc65:6sol and ovoapi:gpt-5.6-sol all answered 200
// with reasoning.effort=xhigh. The two that failed (gpt-5.2 = 502, motomoto =
// 503) are broken models, not an xhigh rejection.
//
// Inserted AFTER the default-level normalization above on purpose: that step
// picks a default from the levels present, and adding xhigh first would silently
// move a medium-only entry's default (gpt-5.3-codex) up to xhigh. This only
// widens what may be selected; defaults stay as normalized.
//
// The match is on the UPSTREAM id with any realm prefix stripped, so one rule
// covers rc:/rc65:/ovoapi:/motomoto:/global:/cn: aliases of the same model.
const EFFORT_RANK = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'];
for (const m of merged.models) {
  const spec = REGISTRY.models[m.slug];
  const upstream = (spec?.m ?? m.slug).replace(/^(global|cn):/, '');
  if (!/^gpt/i.test(upstream)) continue;
  const list = m.supported_reasoning_levels ?? [];
  if (list.some((l) => l.effort === 'xhigh')) continue;
  list.push({ effort: 'xhigh', description: LEVELS.xhigh });
  list.sort((a, b) => EFFORT_RANK.indexOf(a.effort) - EFFORT_RANK.indexOf(b.effort));
  m.supported_reasoning_levels = list;
}

// Prefer the recorded context limit over codex's built-in value. Codex ships
// conservative numbers for the built-in slugs (gpt-6-astra: 272000), while
// models.yml records what the upstream actually accepts (1050000). Leaving the
// smaller value makes codex compact long before it has to.
for (const m of merged.models) {
  const real = CTX_YML[m.slug] ?? CTX_PREV[m.slug];
  if (real && real > (m.context_window ?? 0)) {
    m.context_window = real;
    m.max_context_window = Math.max(real, m.max_context_window ?? 0);
  }
}

// User-pinned context windows.
//
// Applied AFTER the recorded-value loop above, on purpose: that loop only ever
// RAISES a window (from models.yml / the previous catalog), so a pin placed
// earlier would be silently overwritten. Keyed by UPSTREAM model id, so one pin
// covers every route that serves that model (rc / rc65 / ovoapi all serve
// gpt-6-sol, and all three should read the same).
//
// Why a pin at all: the relaycat and ovo providers publish no context_length, so
// these ids fell back to CTX_DEFAULT (200000) marked UNVERIFIED. The user states
// the real limit is 240k. A pin beats a guess.
//
// NOTE: gpt-6-astra is deliberately NOT pinned - models.yml records 1050000 for
// it, and this file's own precedence rule is that a recorded value beats a
// blanket default. Only the sol/base ids are pinned.
const CTX_PIN = {
  'gpt-6': 240000,
  'gpt-6-sol': 240000,
  'gpt-6.1-sol': 240000,
};
for (const m of merged.models) {
  const spec = REGISTRY.models[m.slug];
  const upstream = spec?.m ?? m.slug;
  const pin = CTX_PIN[upstream];
  if (pin) {
    m.context_window = pin;
    m.max_context_window = pin;
  }
}

// Name the upstream on every entry. The built-in entries are taken verbatim from
// codex, so their display names are bare ("GPT-6-Astra") - ambiguous here, where
// relaycat / agentrouter / anyrouter / wb2api all serve the same model id. Entries
// that already say "(via X)" are left exactly as they are.
for (const m of merged.models) {
  const spec = REGISTRY.models[m.slug];
  if (!spec) continue;
  // Rebuild from the model id so a built-in entry gets the same short name as
  // our own entries; drop any previous marker first.
  const base = shortModel(spec.m ?? m.slug);
  m.display_name = `${base} (${routeMarker(m.slug, spec)})`;
}

// 5) Per-model auto-compaction limits.
//
//    WHY PER-MODEL: the global `model_auto_compact_token_limit` in config.toml
//    OVERRIDES any per-entry value (measured: per-entry 1000 with global 300000
//    never compacted; the same entry with the global key absent compacted
//    immediately). So a single global number cannot express "astra compacts at
//    260k, everything else at 500k" - the global key has to stay unset and every
//    entry carries its own value. Defaults > global > per-entry is the precedence.
//
//    WHY astra IS LOWER: this is the USER'S CHOICE, not a measured failure
//    threshold - do not "correct" it back to COMPACT_DEFAULT after seeing astra
//    work past 260k. astra's agentrouter quota is the scarcest resource in the
//    pool (it exhausts and only resets at 10:00 / 19:00 Beijing time), and a
//    long thread re-sends its whole context on every turn, so a smaller window
//    keeps the per-turn burn down. It is a cost/quota decision.
const COMPACT_ASTRA = 260000;
const COMPACT_DEFAULT = 500000;
// Reply headroom. The limit counts input only, so the threshold has to sit far
// enough below the window that the model still has room to answer.
const REPLY_MARGIN = 8192;
for (const m of merged.models) {
  const limit = /astra/.test(m.slug) ? COMPACT_ASTRA : COMPACT_DEFAULT;
  // Never let the threshold exceed the window codex will ACTUALLY use. Codex
  // applies effective_context_window_percent (95 on every entry here) before
  // comparing against this limit, so clamping to the raw context_window still
  // left six entries unreachable: 191808 against an effective 190000 (gpt-5.2,
  // gpt-5.3-codex), 263808 against 258400 (gpt-5.6-luna, codex-auto-review,
  // global:gpt-5.3-codex) and 500000 against 486400 (cn:minimax-m3). A limit
  // above the effective window means compaction can never fire before the
  // request is already over the window - exactly the failure this clamp exists
  // to prevent.
  const window = m.context_window ?? 0;
  const pct = m.effective_context_window_percent ?? 100;
  const effective = Math.floor((window * pct) / 100);
  m.auto_compact_token_limit = effective ? Math.min(limit, Math.max(1000, effective - REPLY_MARGIN)) : limit;
}

fs.writeFileSync(OUT, JSON.stringify(merged, null, 2) + '\n');

console.log(`built-in: ${keptBuiltins.length} of ${builtin.models.length} (registry-routed)`);
if (droppedBuiltins.length) console.log(`dropped (no provider serves them): ${droppedBuiltins.join(', ')}`);
console.log(`added:    ${added.length} -> ${added.map((m) => m.slug).join(', ')}`);
console.log(`total:    ${merged.models.length}`);
console.log(`written:  ${OUT}`);

if (collisions.length) {
  console.log('');
  console.log('!! SLUG COLLISIONS - the entries below are IGNORED (built-in wins)');
  for (const o of collisions) {
    const b = builtin.models.find((m) => m.slug === o.slug);
    console.log(`!!   ${o.slug}`);
    const keys = new Set([...Object.keys(o), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      if (RICH_ONLY.includes(k)) continue;
      const ov = JSON.stringify(o[k]);
      const bv = JSON.stringify(b[k]);
      if (ov !== bv) console.log(`!!     ${k}: ours=${ov} builtin=${bv}`);
    }
    console.log('!!     -> rename the slug, or drop this entry from `ours`');
  }
}

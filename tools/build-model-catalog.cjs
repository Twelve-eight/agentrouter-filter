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

// The models a sub-agent may be spawned with: these are the only entries offered in
// spawn_agent's "Available model overrides" list (see the priority note inside
// entry()). Everything else stays spawnable through inheritance only.
//
// The list is CAPPED AT 5 by Codex, so adding an entry means evicting one. Usage
// counted across data/usage/*.jsonl on 2026-09-24: global:deepseek-v4.1-flash
// 4956, cn:deepseek-v4.1-flash 1098, mimo-v2.6-flash-free 16, and BOTH
// global:deepseek-v4.1-flash-sg and zen:mimo-v2.6-flash 0. claude-opus-4-8 was
// requested by the user, so the never-used sg alias gives up its slot; the zen
// alias (also 0) was kept because zen:mimo-v2.6-flash is the documented example of
// a prefixed alias, and evicting both would leave the list with no alias at all.
//
// claude-opus-4-8 qualifies only because the anthropic RETURN path now forwards
// toolMap - see the note at the bridgeAnthropicStream call in server.mjs.
const OVERRIDE_SLUGS = new Set([
  'global:deepseek-v4.1-flash',
  'cn:deepseek-v4.1-flash',
  'mimo-v2.6-flash-free',
  'zen:mimo-v2.6-flash',
  'claude-opus-4-8',
]);
function entry(slug, display, description, efforts, contextWindow) {
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
    //   priority < 0  - the entry is offered in spawn_agent's "Available model
    //                   overrides" list. The list is capped at 5 entries and only
    //                   negative priorities qualify; built-ins (1..43) and every
    //                   other entry stay out of it. So 0 (default) keeps an entry
    //                   routable and pickable while leaving the override list alone.
    // OVERRIDE_SLUGS below is the single place that decides which models a
    // sub-agent may be spawned with.
    priority: OVERRIDE_SLUGS.has(slug) ? -1 : 0,
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
    input_modalities: ['text'],
    supports_search_tool: false,
  };
}

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
      `${spec.m ?? slug} (via ${prov})`,
      `${upstream} served by ${prov} through the local gateway`,
      clampWindow(slug) ?? EFF[slug] ?? EFFORTS_DEFAULT,
      CTX[slug] ?? CTX_YML[spec.m ?? slug] ?? CTX_YML[slug] ?? CTX_PREV[slug] ?? CTX_DEFAULT,
    );
  })
  // The registry also lists codex's built-in slugs (the gateway must route them),
  // but their catalog entries already exist and are richer. Drop them here: the
  // built-in entry wins below, and reporting that as a "collision" would be noise.
  .filter((m) => !builtin.models.some((b) => b.slug === m.slug));

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
const added = ours.filter((m) => !have.has(m.slug));
const collisions = ours.filter((m) => have.has(m.slug));

// Only built-ins the registry can route: the picker must never offer a model
// that /u would answer 404 for. (codex-auto-review, gpt-daybreak-* were listed
// by codex but served by nobody; codex-auto-review is now in the registry.)
// Guard: the spawn_agent override list is capped at 5 entries and is filled in
// catalog order, built-ins first. A built-in entry with a negative priority would
// therefore silently evict one of OVERRIDE_SLUGS. Today every built-in uses a
// positive value (astra 1 .. codex-auto-review 43) - fail loudly if that changes,
// rather than shipping a sub-agent list that quietly lost a model.
const builtinNegative = builtin.models.filter((m) => typeof m.priority === "number" && m.priority < 0);
if (builtinNegative.length) {
  throw new Error(
    `refusing to build: built-in entries now use a negative priority (${builtinNegative.map((m) => `${m.slug}=${m.priority}`).join(', ')}); ` +
      'they would occupy slots in the spawn_agent override list - re-check that list before proceeding',
  );
}
if (OVERRIDE_SLUGS.size > 5) {
  throw new Error(`refusing to build: OVERRIDE_SLUGS has ${OVERRIDE_SLUGS.size} entries but the spawn_agent override list only shows 5`);
}
const ROUTED = new Set(Object.keys(REGISTRY.models).filter((k) => REGISTRY.models[k] && typeof REGISTRY.models[k] === "object"));
const droppedBuiltins = builtin.models.filter((m) => !ROUTED.has(m.slug)).map((m) => m.slug);
const keptBuiltins = builtin.models.filter((m) => ROUTED.has(m.slug));

const merged = { models: [...keptBuiltins, ...added] };

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

// Name the upstream on every entry. The built-in entries are taken verbatim from
// codex, so their display names are bare ("GPT-6-Astra") - ambiguous here, where
// relaycat / agentrouter / anyrouter / wb2api all serve the same model id. Entries
// that already say "(via X)" are left exactly as they are.
for (const m of merged.models) {
  if (/\(via /.test(m.display_name ?? "")) continue;
  const prov = REGISTRY.models[m.slug]?.p;
  if (prov) m.display_name = `${m.display_name} (via ${prov})`;
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

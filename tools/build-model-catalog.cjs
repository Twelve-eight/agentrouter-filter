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
    priority: 0,
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

// Context windows. wb2api publishes a real `context_length` per model, so it is
// queried rather than guessed (a fabricated 1M would stop codex compacting in
// time and long sessions would hit the upstream limit - a short test cannot
// show that). Providers that publish nothing fall back to CTX_DEFAULT, which is
// marked unverified rather than presented as measured.
const CTX_DEFAULT = 200000; // UNVERIFIED for providers that publish no context size
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

const ours = Object.entries(REGISTRY.models)
  .filter(([, v]) => v && typeof v === "object")
  .map(([slug, spec]) => {
    const prov = spec.p;
    const upstream = spec.m ?? slug;
    return entry(
      slug,
      `${spec.m ?? slug} (via ${prov})`,
      `${upstream} served by ${prov} through the local gateway`,
      EFF[slug] ?? EFFORTS_DEFAULT,
      CTX[slug] ?? CTX_DEFAULT,
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

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
  low: 'Fast responses with lighter reasoning',
  medium: 'Balances speed and reasoning depth for everyday tasks',
  high: 'Greater reasoning depth for complex problems',
  max: 'Maximum reasoning depth for the hardest problems',
};
const levels = (...names) => names.map((e) => ({ effort: e, description: LEVELS[e] }));
const BASE = 'You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user\'s goals.';

// 2) our models. `slug` must equal the upstream model id.
function entry(slug, display, description, efforts, contextWindow) {
  return {
    slug,
    display_name: display,
    description,
    base_instructions: BASE,
    default_reasoning_level: efforts[0],
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

const ours = [
  // agentrouter (ps.air-outer.com) - provider `agentrouter`, route /ar
  entry('deepseek-v4-flash', 'DeepSeek V4 Flash (agentrouter)', 'DeepSeek V4 Flash via agentrouter', ['low', 'medium', 'high', 'max'], 1000000),
  entry('glm-5.3', 'GLM 5.3 (agentrouter)', 'GLM 5.3 via agentrouter', ['low', 'medium', 'high', 'max'], 1000000),
  entry('claude-opus-4-8', 'Claude Opus 4.8 (agentrouter)', 'Claude Opus 4.8 via agentrouter', ['low', 'medium', 'high', 'max'], 1000000),
  entry('claude-opus-5', 'Claude Opus 5 (agentrouter)', 'Claude Opus 5 via agentrouter', ['low', 'medium', 'high', 'max'], 1000000),
  // relaycat-cn (api.relaycat.top, CN key group) - provider `relaycat-cn`, route /rc.
  // The plain `relaycat` key serves the built-in names (gpt-6-astra, gpt-5.6-sol, ..)
  // which are already in the built-in catalog, so nothing to add for it.
  entry('deepseek-v4.1-flash', 'DeepSeek V4.1 Flash (relaycat)', 'DeepSeek V4.1 Flash via relaycat', ['low', 'medium', 'high', 'max'], 1000000),
  // wb2api (local 127.0.0.1:7863) - provider `wb2api`, route /wb. All verified 200.
  entry('global:deepseek-v4.1-flash', 'DeepSeek V4.1 Flash (workbuddy)', 'DeepSeek V4.1 Flash via the local WorkBuddy gateway', ['low', 'medium', 'high', 'max'], 1000000),
  entry('global:gpt-6-astra', 'GPT-6-Astra (workbuddy)', 'GPT-6-Astra via the local WorkBuddy gateway', ['low', 'medium', 'high', 'max'], 1000000),
  entry('global:gpt-5.6-sol', 'GPT-5.6-Sol (workbuddy)', 'GPT-5.6-Sol via the local WorkBuddy gateway', ['low', 'medium', 'high', 'max'], 1000000),
  entry('global:gpt-5.6-terra', 'GPT-5.6-Terra (workbuddy)', 'GPT-5.6-Terra via the local WorkBuddy gateway', ['low', 'medium', 'high', 'max'], 1000000),
  entry('global:gpt-5.6-luna', 'GPT-5.6-Luna (workbuddy)', 'GPT-5.6-Luna via the local WorkBuddy gateway', ['low', 'medium', 'high', 'max'], 1000000),
  entry('global:gpt-5.5', 'GPT-5.5 (workbuddy)', 'GPT-5.5 via the local WorkBuddy gateway', ['low', 'medium', 'high', 'max'], 1000000),
  entry('global:gpt-5.3-codex', 'GPT-5.3-Codex (workbuddy)', 'GPT-5.3-Codex via the local WorkBuddy gateway', ['low', 'medium', 'high', 'max'], 1000000),
  entry('global:gemini-3.5-flash', 'Gemini 3.5 Flash (workbuddy)', 'Gemini 3.5 Flash via the local WorkBuddy gateway', ['low', 'medium', 'high', 'max'], 1000000),
  entry('global:glm-5.3', 'GLM 5.3 (workbuddy)', 'GLM 5.3 via the local WorkBuddy gateway', ['low', 'medium', 'high', 'max'], 1000000),
  entry('global:kimi-k3', 'Kimi K3 (workbuddy)', 'Kimi K3 via the local WorkBuddy gateway', ['low', 'medium', 'high', 'max'], 1000000),
  entry('global:deepseek-v4.1-flash-sg', 'DeepSeek V4.1 Flash SG (workbuddy)', 'DeepSeek V4.1 Flash (SG node) via the local WorkBuddy gateway', ['low', 'medium', 'high', 'max'], 1000000),
  entry('cn:deepseek-v4-pro', 'DeepSeek V4 Pro (workbuddy)', 'DeepSeek V4 Pro via the local WorkBuddy gateway', ['low', 'medium', 'high', 'max'], 1000000),
  entry('cn:kimi-k3-1', 'Kimi K3 (workbuddy CN)', 'Kimi K3 via the local WorkBuddy gateway (CN node)', ['low', 'medium', 'high', 'max'], 1000000),
];

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

const merged = { models: [...builtin.models, ...added] };
fs.writeFileSync(OUT, JSON.stringify(merged, null, 2) + '\n');

console.log(`built-in: ${builtin.models.length}`);
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

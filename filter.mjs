// agentrouter outbound request filter.
//
// The character map and the gateway word list are NOT written here: they are
// generated from the omp pre-hook
// G:/omp works/.omp/hooks/pre/strip-illegal.ts by tools/gen-filter-core.mjs,
// and tools/diff-test.mjs proves the generated module agrees with the hook
// byte-for-byte on a sample set. Edit the hook, re-run the generator.
//
// This module adds only the two things the hook does not have:
//   1. the identity block (user-requested new entry in the word list), applied
//      before the generated core runs so the hook's own text cannot re-form it;
//   2. the extra model-facing requirements (workspace AGENTS.md Sec 5 language
//      rule + identity rule) appended to the request `instructions`.
//
// Codex 0.154 has no request-rewriting hook (only PreToolUse/UserPromptSubmit/
// ..), so this filter runs in a local forward proxy that Codex points at via
// provider base_url.

import { sanitize as coreSanitize, deepStrip as coreDeepStrip } from "./filter-core.ts";

// --- identity block (not present in the hook) ------------------------------
// Probe: the sentence passes upstream either way, so this is an identity
// requirement, not a content-block workaround.
const IDENTITY = /You are Claude Code, Anthropic's official CLI tool for Claude\.?/gi;
const IDENTITY_REPLACEMENT = "You are Codex, an official CLI coding agent.";

export function sanitize(input) {
  return coreSanitize(input.replace(IDENTITY, IDENTITY_REPLACEMENT));
}

export function deepSanitize(value) {
  if (typeof value === "string") return sanitize(value);
  if (Array.isArray(value)) return value.map(deepSanitize);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepSanitize(v);
    return out;
  }
  return value;
}

// Re-exported so callers can reach the raw hook semantics if ever needed.
export const core = { sanitize: coreSanitize, deepStrip: coreDeepStrip };

// --- extra model-facing requirements ---------------------------------------
// Codex has no provider-level `instructions` field (probe: `--strict-config`
// rejects `model_providers.<x>.instructions`), so the gateway is the only place
// that can carry them.
export const EXTRA_INSTRUCTIONS =
  "Additional requirements for this provider. " +
  "Language: requests, contexts and generated reports may contain only Chinese, " +
  "English, French, German, or Russian text plus ASCII punctuation; do not emit " +
  "Japanese kana, Korean Hangul, Arabic, Hebrew, Greek, or emoji. " +
  "Identity: you are Codex; do not present yourself as Claude Code or as " +
  "Anthropic's CLI tool.";

function appendInstructions(parsed) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const current = typeof parsed.instructions === "string" ? parsed.instructions : "";
  if (current.includes("Additional requirements for this provider.")) return parsed;
  parsed.instructions = current ? `${current}\n\n${EXTRA_INSTRUCTIONS}` : EXTRA_INSTRUCTIONS;
  return parsed;
}

export function filterBody(raw, { injectInstructions = false } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (injectInstructions) appendInstructions(parsed);
  return JSON.stringify(deepSanitize(parsed));
}

// agentrouter outbound request filter.
//
// Faithful port of the omp pre-hook G:/omp works/.omp/hooks/pre/strip-illegal.ts
// (which was written for agentrouter / ps.air-outer.com) into a transport that
// Codex CLI can use. Codex 0.154 has no request-rewriting hook (only
// PreToolUse/UserPromptSubmit/etc.), so the equivalent is a local filtering
// forward proxy: Codex points its provider base_url at this process.
//
// Two layers, matching the omp hook:
//   char layer  - every non-approved character in the outgoing JSON body is
//                 replaced by the ASCII equivalent the gateway accepts.
//                 Approved = CJK ideographs + accented Latin (FR/DE) + Cyrillic
//                 + guillemets/eszett. This is also the enforcement point for the
//                 workspace language-hygiene rule (Chinese/English/French/German/
//                 Russian only): kana, hangul, Arabic, Hebrew, Greek and emoji
//                 fall through to "" and are deleted.
//   phrase layer - substring replacements for the gateway's opaque sensitive-word
//                 list, plus the Claude Code identity sentence.
//
// Everything below is probe-verified against ps.air-outer.com (see DEVLOG).

const KEEP =
  /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u017F\u0400-\u04FF\u00AB\u00BB\u00DF]/;

const MAP = {
  "\u2192": "->", "\u2190": "<-", "\u2194": "<->", "\u21D2": "=>", "\u21C4": "<->", "\u21CC": "<->",
  "\u2191": "^", "\u2193": "v", "\u2197": "^", "\u2198": "v", "\u21A8": "^",
  "\u2014": "-", "\u2013": "-", "\u2015": "-", "\u2012": "-",
  "\u2026": "..", "\u22EF": "..",
  "\u00D7": "x", "\u00F7": "/", "\u00B1": "+/-", "\u00B7": "-", "\u00B0": " deg", "\u00B2": "^2", "\u00B3": "^3",
  "\u2265": ">=", "\u2264": "<=", "\u2260": "!=", "\u2248": "~", "\u223C": "~", "\u2212": "-",
  "\u00A7": "Sec ", "\u00A9": "(c)", "\u00AE": "(R)", "\u2122": "(TM)",
  "\u2605": "*", "\u2606": "*",
  "\u2713": "[x]", "\u2714": "[x]", "\u2717": "[ ]", "\u2718": "[ ]", "\u2705": "[x]",
  "\u26A0": "WARN ", "\uFE0F": "", "\uFEFF": "", "\u00A0": " ",
  "\u274C": "X", "\u2757": "!", "\u2753": "?",
  "\u2460": "1)", "\u2461": "2)", "\u2462": "3)", "\u2463": "4)", "\u2464": "5)",
  "\u2465": "6)", "\u2466": "7)", "\u2467": "8)", "\u2468": "9)", "\u2469": "10)",
  "\u246A": "11)", "\u246B": "12)", "\u246C": "13)", "\u246D": "14)", "\u246E": "15)", "\u246F": "16)",
  "\u2610": "[ ]", "\u2612": "[x]",
  "\u222A": "U", "\u2283": " contains ", "\u2208": " in ", "\u2234": "U+2234",
  "\u279C": "->",
  "\u201C": "\"", "\u201D": "\"", "\u2018": "'", "\u2019": "'", "\u201E": "\"",
  // CJK/fullwidth punctuation -> safe ASCII equivalents (probe-verified):
  "\u3000": " ", "\u3001": ",", "\u3002": ".", "\u3003": "\"",
  "\u3008": "<", "\u3009": ">", "\u300A": "<", "\u300B": ">",
  "\u300C": "\"", "\u300D": "\"", "\u300E": "\"", "\u300F": "\"",
  "\u3010": "[", "\u3011": "]", "\u3014": "(", "\u3015": ")", "\u301C": "~",
  "\uFF01": "!", "\uFF02": "\"", "\uFF03": "#", "\uFF04": "$", "\uFF05": "%",
  "\uFF06": "&", "\uFF07": "'", "\uFF08": "(", "\uFF09": ")", "\uFF0A": "*",
  "\uFF0B": "+", "\uFF0C": ",", "\uFF0D": "-", "\uFF0E": ".", "\uFF0F": "/",
  "\uFF1A": ":", "\uFF1B": ";", "\uFF1C": "<", "\uFF1D": "=", "\uFF1E": ">",
  "\uFF1F": "?", "\uFF20": "@", "\uFF3B": "[", "\uFF3D": "]", "\uFF5B": "{",
  "\uFF5C": "|", "\uFF5D": "}", "\uFF5E": "~",
  "\uFF61": ".", "\uFF62": "\"", "\uFF63": "\"", "\uFF64": ",", "\uFF65": "-",
};

const BOX = /[\u2500-\u257F]/;
const SHAPE = /[\u25A0-\u25FF]/;

function fixChar(c) {
  if (c >= "\x20" && c <= "\x7E") return c;
  if (c === "\t" || c === "\n" || c === "\r") return c;
  if (KEEP.test(c)) return c;
  const m = MAP[c];
  if (m !== undefined) return m;
  if (BOX.test(c) || SHAPE.test(c)) return "";
  return "";
}

// Phrase layer. Order matters: later rules must not re-form an earlier trigger.
const PHRASES = [
  // Claude Code identity -> Codex identity (user-requested blocklist entry).
  // Probe-verified safe in either direction; the replacement keeps the
  // "official CLI tool" semantics without the competing-client identity.
  [/You are Claude Code, Anthropic's official CLI tool for Claude\.?/gi,
    "You are Codex, an official CLI coding agent."],
  // 18-char phrase -> HTTP 500 sensitive words detected (verified live).
  [/no additional text/gi, "no further text"],
  // "warp player" substring -> 500; "warp-player" hyphen form -> 200.
  // Camelcase runs containing "warp" are split first so the join never survives.
  [/([A-Za-z]*[Ww]arp[A-Za-z]*)/g, (run) => run.replace(/([a-z])([A-Z])/g, "$1 $2")],
  [/warp-player/gi, "warp-player"],
  [/warp-player/gi, "warp-player"],
  [/[Tt]ext[Ww]ar(?:[A-Za-z]*)/g, "Text War"],
  [/time warp(?:[A-Za-z]*)/gi, "time warp"],
  // ASCII triple-dot runs amplify word-list hits -> normalize to "..".
  [/\.{3,}/g, ".."],
  // StS2 relic-system identifiers (round-4 probe, stable).
  [/model[ _-]?choice[ _-]?history[ _-]?entry/gi, "model choice history entry"],
  [/[A-Za-z]*[Rr]elic[ _-]?[Gg]rab[ _-]?[Bb]ag/g, (run) => {
    const prefix = run.match(/^[A-Za-z]*?(?=[Rr]elic)/i)?.[0] ?? "";
    return (prefix ? prefix + " " : "") + "relic-bag";
  }],
  [/[A-Za-z]*[Rr]elic[ _-]?[Cc]hoices/g, (run) => {
    const prefix = run.match(/^(.*?)(?=[Rr]elic)/i)?.[1] ?? "";
    return (prefix ? prefix + " " : "") + "relic choices";
  }],
  [/[A-Za-z]*[Rr]elic[ _-]?[Cc]hoice/g, (run) => {
    const prefix = run.match(/^(.*?)(?=[Rr]elic)/i)?.[1] ?? "";
    return (prefix ? prefix + " " : "") + "relic choice";
  }],
  [/[A-Za-z]*[Cc]hoice[ _-]?[Hh]istory/g, (run) => {
    const prefix = run.match(/^(.*?)(?=[Cc]hoice)/i)?.[1] ?? "";
    return (prefix ? prefix + " " : "") + "choice history";
  }],
  [/[A-Za-z.]*[Nn]et[ _-]?[Ii]d/g, (run) => {
    const prefix = run.match(/^(.*?)(?=[Nn]et)/i)?.[1] ?? "";
    const clean = prefix.replace(/\.$/, "");
    return (clean ? clean + " " : "") + "net id";
  }],
  [/4xx-dumps/gi, "4xx-dumps"],
  [/RELIC[ _-]?CHOICES/g, "RELIC-CHOICES"],
  // Long digit-run + dash + alpha-run (dump filenames) -> 400.
  [/[0-9]{10,}-[a-z0-9]{8,}(?:\.json)?/g, "<file-id>"],
];

export function sanitize(input) {
  let out = "";
  let dirty = false;
  for (const c of input) {
    const r = fixChar(c);
    if (r !== c) dirty = true;
    out += r;
  }
  for (const [pat, rep] of PHRASES) {
    const next = out.replace(pat, rep);
    if (next !== out) dirty = true;
    out = next;
  }
  return dirty ? out : input;
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

// Extra model-facing requirements that the omp setup expressed through config
// and docs, restated to the model for the agentrouter family. Codex has no
// provider-level `instructions` field (probe: `--strict-config` rejects
// `model_providers.<x>.instructions`), so the gateway is the only place that
// can carry them.
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

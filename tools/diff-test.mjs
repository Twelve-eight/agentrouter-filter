// Differential test: generated filter-core.ts vs the ORIGINAL omp hook.
//
// The hook is TypeScript with an `import type`; node 24 strips types natively,
// imports, so it can be loaded directly. Both sides get identical inputs and
// must agree byte-for-byte, which is what proves the generator lost no rule.
//
// SCOPE - read this before trusting a green run. This is a COPY-FIDELITY test,
// not a correctness test for the rules. Both sides are the SAME rule set: the
// generated file is derived from the hook core, and the reference below is that
// same hook core. It therefore cannot fail because a rule is wrong, obsolete,
// or no longer matches what the upstream blocks - it can only fail when the
// generator drops or alters something during the copy. Whether the rules are
// still correct or still needed is a separate question answered by probing the
// upstream (see the README section on whether this layer is still required),
// never by this file. A "0 mismatches" line must not be read as "the filter is
// correct".
//
// The samples below are also drawn from the same ruleset, so they exercise the
// copy, not the rules' coverage of real upstream behaviour.
import { sanitize as genSanitize, deepStrip as genDeepStrip } from "../filter-core.ts";
import fs from "node:fs";

const SRC = "G:/omp works/.omp/hooks/pre/strip-illegal.ts";
const src = fs.readFileSync(SRC, "utf8");
const start = src.split("\n").findIndex((l) => l.startsWith("const KEEP = "));
const end = src.split("\n").findIndex((l) => l.startsWith("export default function (pi"));
let core = src.split("\n").slice(start, end).join("\n");
core = core
  .replace("const MAP: Record<string, string> = {", "const MAP = {")
  .replace("function fixChar(c: string): string {", "function fixChar(c) {")
  .replace("function sanitize(s: string): string {", "function sanitize(s) {")
  .replace("function deepStrip(value: unknown, changed: { flag: boolean }): unknown {", "function deepStrip(value, changed) {")
  .replace("const out: Record<string, unknown> = {};", "const out = {};");
const refFactory = new Function(`${core}\nreturn { sanitize, deepStrip };`);
const ref = refFactory();

const samples = [
  "plain ascii text",
  "You are Claude Code, Anthropic's official CLI tool for Claude.",
  "no " + String.fromCharCode(97, 100, 100, 105, 116, 105, 111, 110, 97, 108) + " text here",
  "no additional text",
  "time warp power",
  "TimeWarpPower",
  "Time/Warp Power",
  "timewarp",
  "warp player",
  "warp-player",
  "warpPlayer",
  "textWar etc",
  "TextWar..",
  "a...b",
  "a....b",
  "a..b",
  "model choice history entry",
  "SharedRelicGrabBag",
  "relic grab bag",
  "Shared relic choices",
  "Shared relic choice",
  "choice history entry",
  "playerNetId",
  "player.net.id",
  "http-4xx-dumps",
  "RELIC CHOICES",
  "1734567890123-abcdef1234.json",
  "1734567890123-abcdef12",
  "中文 保持",
  "\u3053\u3093\u306B\u3061\u306F",
  "\uC548\uB155",
  "\u0645\u0631\u062D\u0628\u0627",
  "\u03B1\u03B2\u03B3",
  "\u{1F600}\u{1F680}",
  "\u2500\u2502\u25A0",
  "\u041F\u0440\u0438\u0432\u0435\u0442",
  "caf\u00E9 na\u00EFve",
  "arrow \u2192 here \u2026 end",
  "box \u2500\u2502 shape \u25A0",
  "\u00A7 1 \u00A9 x \u2122 y",
  "\u2713 done \u2717 not",
  "fullwidth \uFF01\uFF08x\uFF09",
  "combining \uFE0F zero",
  "dashes \u2014\u2013\u2015\u2012",
  "math \u2265\u2264\u2260\u2248",
];

let fail = 0;
for (const s of samples) {
  const a = genSanitize(s);
  const b = ref.sanitize(s);
  if (a !== b) {
    fail++;
    console.log("MISMATCH sanitize:", JSON.stringify(s));
    console.log("  gen:", JSON.stringify(a));
    console.log("  ref:", JSON.stringify(b));
  }
}

// deepStrip over a nested structure (the hook's real input shape).
const tree = {
  content: [{ type: "text", text: samples[1] }, { type: "text", text: samples[3] }],
  details: { nested: [{ deep: samples[27] }, samples[30]] },
  n: 5,
  b: true,
  nul: null,
};
const g = genDeepStrip(tree, { flag: false });
const r = ref.deepStrip(tree, { flag: false });
if (JSON.stringify(g) !== JSON.stringify(r)) {
  fail++;
  console.log("MISMATCH deepStrip");
  console.log("  gen:", JSON.stringify(g));
  console.log("  ref:", JSON.stringify(r));
}

console.log(`\n${samples.length} sanitize samples + 1 deepStrip tree, mismatches: ${fail}`);
process.exit(fail ? 1 : 0);

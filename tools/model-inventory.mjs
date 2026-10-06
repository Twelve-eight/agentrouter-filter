#!/usr/bin/env node
// Model inventory: one usage row per catalog entry, most-used first.
//
// Two outputs, both regenerated from the same scan:
//   1. JSON export  (default: G:/tmp/model-usage-export.json) for ad-hoc analysis
//   2. Canvas       (--canvas <path>) for the human-facing table
//
// Usage weighting is a 7-day half-life decay: score += 0.5 ^ (age_days / 7).
// That makes the ranking answer "what am I using NOW" rather than "what did a
// one-off probe hammer two weeks ago". A plain request count would let a single
// bad afternoon dominate for a month.
//
// Ledger scope: only day-named files (`YYYY-MM-DD.jsonl`). `*.phantom-merged.jsonl`
// is a repaired copy of a single day and was verified on 2026-10-06 to be a 100%
// subset of that day's file, so globbing it would double-count those rows.
//
// Usage:
//   node tools/model-inventory.mjs
//   node tools/model-inventory.mjs --canvas C:/path/to/inventory.canvas.tsx
//   node tools/model-inventory.mjs --json G:/tmp/out.json --top 20

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HALF_LIFE_DAYS = 7;

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const jsonOut = argValue("--json", "G:/tmp/model-usage-export.json");
const canvasOut = argValue("--canvas", null);
const topN = Number(argValue("--top", "15"));

const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "providers.json"), "utf8"));
const catalog = JSON.parse(
  fs.readFileSync(path.join(process.env.USERPROFILE ?? process.env.HOME, ".codex", "omp-model-catalog.json"), "utf8"),
);
const usageDir = path.join(ROOT, "data", "usage");

// ---- scan the ledger -------------------------------------------------------
const now = Date.now();
const acc = new Map(); // "provider|model" -> stats
let files = [];
try {
  files = fs.readdirSync(usageDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
} catch {
  console.warn(`no usage ledger at ${usageDir}; every row will read as zero`);
}

let scanned = 0;
for (const name of files) {
  let text;
  try {
    text = fs.readFileSync(path.join(usageDir, name), "utf8");
  } catch {
    continue;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // torn last line after a crash
    }
    if (!row || typeof row.model !== "string" || typeof row.provider !== "string") continue;
    scanned++;
    const key = `${row.provider}|${row.model}`;
    let a = acc.get(key);
    if (!a) {
      a = { req: 0, ok: 0, fail: 0, tin: 0, tout: 0, decay: 0, last: "" };
      acc.set(key, a);
    }
    a.req++;
    if (row.ok === true) a.ok++;
    else a.fail++;
    a.tin += Number(row.input_tokens) || 0;
    a.tout += Number(row.output_tokens) || 0;
    const ts = Date.parse(row.ts);
    if (Number.isFinite(ts)) {
      a.decay += Math.pow(0.5, Math.max(0, (now - ts) / 86400000) / HALF_LIFE_DAYS);
      if (typeof row.ts === "string" && row.ts > a.last) a.last = row.ts;
    }
  }
}

// ---- join against the registry --------------------------------------------
const catalogBySlug = new Map(catalog.models.map((m) => [m.slug, m]));
const rows = [];
for (const [slug, spec] of Object.entries(registry.models)) {
  if (!spec || typeof spec !== "object") continue; // `_comment` string entries
  const a = acc.get(`${spec.p}|${spec.m ?? slug}`) ?? { req: 0, ok: 0, fail: 0, tin: 0, tout: 0, decay: 0, last: "" };
  const cat = catalogBySlug.get(slug);
  rows.push({
    slug,
    upstream: spec.m ?? slug,
    provider: spec.p,
    providerAbbr: spec.p,
    display: cat?.display_name ?? "(not in catalog)",
    inCatalog: !!cat,
    priority: cat?.priority ?? null,
    decay: Math.round(a.decay * 10) / 10,
    req: a.req,
    ok: a.ok,
    fail: a.fail,
    tin: a.tin,
    tout: a.tout,
    last: a.last,
  });
}
rows.sort((a, b) => b.decay - a.decay || b.req - a.req);

const payload = {
  generatedAt: new Date().toISOString(),
  halfLifeDays: HALF_LIFE_DAYS,
  scannedRows: scanned,
  totalModels: rows.length,
  totalRequests: rows.reduce((s, r) => s + r.req, 0),
  rows,
};
fs.writeFileSync(jsonOut, JSON.stringify(payload, null, 1));

console.log(`ledger files: ${files.length}, rows scanned: ${scanned}`);
console.log(`models: ${rows.length}, requests: ${payload.totalRequests}`);
console.log(`json: ${jsonOut}`);
console.log(`\ntop ${topN}:`);
rows.slice(0, topN).forEach((r, i) => {
  const flag = r.priority === -1 ? "  [hint]" : r.req === 0 ? "  [never]" : r.ok === 0 ? "  [0 ok]" : "";
  console.log(
    `${String(i + 1).padStart(3)} ${String(r.decay).padStart(9)} ${String(r.req).padStart(7)} ${r.ok}/${r.fail}  ${r.slug}${flag}`,
  );
});

// ---- optional canvas -------------------------------------------------------
if (canvasOut) {
  const J = (s) => JSON.stringify(s);
  const dataLines = rows
    .map((r) => {
      const last = (r.last || "").slice(0, 10);
      const prio = r.priority === null ? "null" : r.priority;
      return `  { slug: ${J(r.slug)}, display: ${J(r.display)}, provider: ${J(r.providerAbbr)}, priority: ${prio}, decay: ${r.decay}, req: ${r.req}, ok: ${r.ok}, fail: ${r.fail}, tin: ${r.tin}, tout: ${r.tout}, last: ${J(last)} },`;
    })
    .join("\n");

  const pinned = rows.filter((r) => r.priority === -1).map((r) => `  ${J(r.slug)},`).join("\n");

  const out = `import { H1, H2, Table, Text, Callout, Row, Stack, useHostTheme } from "cursor/canvas";

// GENERATED by Tools/agentrouter-filter/tools/model-inventory.mjs --canvas
// Regenerate after adding models or when the usage ranking drifts.

type ModelRow = {
  slug: string;
  display: string;
  provider: string;
  priority: number | null;
  decay: number;
  req: number;
  ok: number;
  fail: number;
  tin: number;
  tout: number;
  last: string;
};

const ROWS: ModelRow[] = [
${dataLines}
];

const nf = new Intl.NumberFormat("en-US");
const fmt = (n: number) => nf.format(n);

const tok = (n: number) => {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
};

const dash = (n: number, f: (v: number) => string) => (n > 0 ? f(n) : "-");

// 当前 priority = -1 的模型，也就是 spawn_agent 提示块里列出的名字。
const PINNED = new Set([
${pinned}
]);

export default function ModelUsageInventory() {
  const theme = useHostTheme();
  const sorted = [...ROWS].sort((a, b) => b.decay - a.decay || b.req - a.req);
  const used = ROWS.filter((r) => r.req > 0);
  const unused = ROWS.filter((r) => r.req === 0);
  const totalReq = ROWS.reduce((s, r) => s + r.req, 0);
  const totalIn = ROWS.reduce((s, r) => s + r.tin, 0);
  const totalOut = ROWS.reduce((s, r) => s + r.tout, 0);

  const headers = ["序", "模型", "线路", "加权", "请求", "成功", "失败", "输入", "输出", "最近", "优先级"];

  const body = sorted.map((r, i) => [
    String(i + 1),
    <Stack gap={2}>
      <Text weight="medium">{r.display}</Text>
      <Text size="small" tone="tertiary">{r.slug}</Text>
    </Stack>,
    r.provider,
    dash(r.decay, (v) => v.toFixed(0)),
    dash(r.req, fmt),
    dash(r.req, () => fmt(r.ok)),
    dash(r.req, () => fmt(r.fail)),
    dash(r.tin, tok),
    dash(r.tout, tok),
    r.last || "-",
    PINNED.has(r.slug) ? "-1 提示位" : String(r.priority ?? "-"),
  ]);

  const stat = (label: string, value: string) => (
    <Stack gap={2}>
      <Text size="small" tone="tertiary">{label}</Text>
      <Text weight="semibold">{value}</Text>
    </Stack>
  );

  return (
    <Stack gap={24} style={{ padding: 24, color: theme.text.primary }}>
      <Stack gap={6}>
        <H1>网关模型清单：用量与选择器顺序</H1>
        <Text tone="secondary" size="small">
          数据来源：网关用量账本 data/usage/*.jsonl，每条完成请求一行。共 {fmt(ROWS.length)} 个已注册模型、
          {fmt(totalReq)} 次请求。加权列使用 ${HALF_LIFE_DAYS} 天半衰期衰减，越近的流量权重越高。
        </Text>
      </Stack>

      <Row gap={32} align="start" wrap>
        {stat("已注册", fmt(ROWS.length))}
        {stat("有调用记录", fmt(used.length))}
        {stat("从未调用", fmt(unused.length))}
        {stat("请求总数", fmt(totalReq))}
        {stat("输入 token", tok(totalIn))}
        {stat("输出 token", tok(totalOut))}
      </Row>

      <Callout tone="info" title="实测结论：子代理模型没有上限">
        <Text size="small">
          不存在子代理白名单。Codex 用整份 catalog 校验 spawn 请求，下面 {fmt(ROWS.length)} 个模型都能按名字直接指定。
          唯一的限制是提示文本：spawn_agent 的工具说明里列 5 个建议名字，取自本表表头，这个 5 是 Codex 二进制里硬编码的。
          实测证据：10 路并发 spawn 全部受理（含不在提示块里的 zen:space-bunny / ki:sonnet5.5 / gpt-6-astra），
          逐个核对 turn_context，实际路由模型等于请求模型。
        </Text>
      </Callout>

      <H2>全部 {fmt(ROWS.length)} 个模型，按用量降序</H2>
      <Table
        headers={headers}
        rows={body}
        striped
        stickyHeader
        columnAlign={["right", "left", "left", "right", "right", "right", "right", "right", "right", "left", "right"]}
      />

      <Stack gap={8}>
        <H2>从未调用（{fmt(unused.length)} 个）</H2>
        <Text size="small" tone="secondary">
          {unused.map((r) => r.slug).join("  /  ")}
        </Text>
      </Stack>
    </Stack>
  );
}
`;
  fs.writeFileSync(canvasOut, out);
  console.log(`canvas: ${canvasOut} (${rows.length} rows)`);
}

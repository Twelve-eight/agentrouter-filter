// omp /stats contract, backed by this gateway's own usage log.
//
// WHY THIS EXISTS: the dashboard UI is omp's own React client (vendored under
// vendor/omp-stats/, MIT, extracted from omp's `packages/stats/src/embedded-client.ts`
// blob). Rather than write a second dashboard, we serve that client and implement
// the API it calls, mapping our JSONL usage rows onto omp's row shape.
//
// The contract was taken from a live omp dashboard (`omp stats --port 3847`) by
// reading each endpoint's real JSON, not from reading the bundle: field names are
// what the React client actually consumes, so a rename here blanks a panel.
//
// Endpoints with no backing data in a proxy (sessions/transcripts, snapcompact
// gain, message-content behavior) return empty results rather than throwing, so
// those panels render empty instead of taking the whole page down.
import { read as readUsage, costOf } from "./usage.mjs";

// Range table, verbatim from omp's aggregator (aggregator.ts `TTo`).
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const BUCKET_5M = 5 * 60 * 1000;
const RANGES = {
  "1h": { timeSeriesHours: 1, timeSeriesBucketMs: BUCKET_5M, modelSeriesDays: 1, modelSeriesBucketMs: BUCKET_5M, modelPerformanceDays: 1, modelPerformanceBucketMs: BUCKET_5M, costSeriesDays: 1 },
  "24h": { timeSeriesHours: 24, timeSeriesBucketMs: HOUR, modelSeriesDays: 1, modelSeriesBucketMs: HOUR, modelPerformanceDays: 1, modelPerformanceBucketMs: HOUR, costSeriesDays: 1 },
  "7d": { timeSeriesHours: 24 * 7, timeSeriesBucketMs: DAY, modelSeriesDays: 7, modelSeriesBucketMs: DAY, modelPerformanceDays: 7, modelPerformanceBucketMs: DAY, costSeriesDays: 7 },
  "30d": { timeSeriesHours: 24 * 30, timeSeriesBucketMs: DAY, modelSeriesDays: 30, modelSeriesBucketMs: DAY, modelPerformanceDays: 30, modelPerformanceBucketMs: DAY, costSeriesDays: 30 },
  "90d": { timeSeriesHours: 24 * 90, timeSeriesBucketMs: DAY, modelSeriesDays: 90, modelSeriesBucketMs: DAY, modelPerformanceDays: 90, modelPerformanceBucketMs: DAY, costSeriesDays: 90 },
  all: { timeSeriesHours: 24 * 3650, timeSeriesBucketMs: DAY, modelSeriesDays: 3650, modelSeriesBucketMs: DAY, modelPerformanceDays: 3650, modelPerformanceBucketMs: DAY, costSeriesDays: 3650 },
};
const DEFAULT_RANGE = "24h";

function resolveRange(range) {
  const key = String(range ?? "").trim().toLowerCase();
  const spec = RANGES[key] ?? RANGES[DEFAULT_RANGE];
  const hours = spec.timeSeriesHours;
  // "all" must not be a rolling 10-year window (it would drop nothing today but
  // would silently start dropping rows in 2036); omp uses null to mean "no cutoff".
  const cutoff = key === "all" ? null : Date.now() - hours * HOUR;
  return { spec, cutoff };
}

/** Our usage rows for the widest window any range needs, newest last. */
function loadRows(rangeKey) {
  const key = String(rangeKey ?? "").trim().toLowerCase();
  const days = key === "all" ? 3650 : Math.max(1, Math.ceil((RANGES[key] ?? RANGES[DEFAULT_RANGE]).timeSeriesHours / 24));
  return readUsage(days);
}

const tsOf = (r) => {
  const t = Date.parse(r?.ts ?? "");
  return Number.isFinite(t) ? t : 0;
};
const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * One of our rows -> the flat shape omp's client reads.
 *
 * 口径: "unpriced" must not be reported as "free". `costUnpriced` is the ONLY
 * signal for that distinction, because the cost object below is zero-filled for
 * the client (`cost: null` would blank its arithmetic) - so a row that is
 * genuinely priced at zero and a row with no published price both surface as
 * total 0 and are told apart solely by this flag. It is derived with usage.mjs's
 * costOf() so both modules agree on what "priced" means; a truthiness test would
 * disagree on a malformed cost value.
 */
function toOmpRow(r) {
  const cost = costOf(r);
  const input = n(r.input_tokens);
  const output = n(r.output_tokens);
  const cacheRead = n(r.cached_tokens);
  return {
    id: 0,
    // omp keys drill-downs by session file; a proxy has no transcript, so the
    // route stands in as the grouping key ("/u", "/ar", ...). Panels that group
    // by session then read as "per route", which is the useful grouping here.
    sessionFile: `gateway${r.route ? "/" + r.route : ""}`,
    entryId: String(tsOf(r)),
    folder: r.route ? `/${r.route}` : "gateway",
    model: r.model ?? "unknown",
    provider: r.provider ?? "unknown",
    api: r.route ?? "u",
    timestamp: tsOf(r),
    duration: n(r.duration_ms),
    ttft: null,
    stopReason: r.ok ? "stop" : "error",
    errorMessage: r.ok ? null : (r.error ?? "request failed"),
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite: 0,
      totalTokens: input + output + cacheRead,
      premiumRequests: 0,
      cost: {
        input: n(cost?.input),
        output: n(cost?.output),
        cacheRead: n(cost?.cacheRead),
        cacheWrite: n(cost?.cacheWrite),
        total: n(cost?.total),
      },
    },
    agentType: "main",
    // null here means "no published price" - omp excludes these from cost
    // averages instead of counting them as free.
    costUnpriced: cost === null,
  };
}

function inWindow(rows, cutoff) {
  const mapped = rows.map(toOmpRow);
  return cutoff == null ? mapped : mapped.filter((r) => r.timestamp >= cutoff);
}

/** omp's per-group aggregate, field-for-field (client reads all of these). */
function aggregate(rows) {
  const requests = rows.length;
  let failed = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalCost = 0;
  let unpriced = 0;
  let durationSum = 0;
  let durationCount = 0;
  let firstTimestamp = 0;
  let lastTimestamp = 0;
  // Single pass: the per-range row set can be tens of thousands of rows and this
  // runs once per group per endpoint.
  for (const r of rows) {
    if (r.errorMessage) failed++;
    input += r.usage.input;
    output += r.usage.output;
    cacheRead += r.usage.cacheRead;
    cacheWrite += r.usage.cacheWrite;
    if (r.costUnpriced) unpriced++;
    else totalCost += r.usage.cost.total;
    if (r.duration > 0) {
      durationSum += r.duration;
      durationCount++;
    }
    if (r.timestamp > 0) {
      // Loop instead of Math.min(...timestamps): spreading an unbounded array into
      // a variadic call throws RangeError once the row set is large enough.
      if (!firstTimestamp || r.timestamp < firstTimestamp) firstTimestamp = r.timestamp;
      if (r.timestamp > lastTimestamp) lastTimestamp = r.timestamp;
    }
  }
  const successful = requests - failed;
  return {
    totalRequests: requests,
    successfulRequests: successful,
    failedRequests: failed,
    errorRate: requests ? failed / requests : 0,
    totalInputTokens: input,
    totalOutputTokens: output,
    totalCacheReadTokens: cacheRead,
    totalCacheWriteTokens: cacheWrite,
    // Share of input served from cache. omp computes it against input+cacheRead;
    // a proxy reports cached_tokens separately, so the same formula applies.
    cacheRate: input + cacheRead ? cacheRead / (input + cacheRead) : 0,
    cacheSavings: 0,
    totalCost,
    unpricedRequests: unpriced,
    totalPremiumRequests: 0,
    avgDuration: durationCount ? durationSum / durationCount : 0,
    avgTtft: 0,
    avgTokensPerSecond: durationSum ? (output / durationSum) * 1000 : 0,
    firstTimestamp,
    lastTimestamp,
  };
}

function groupBy(rows, keyOf) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    const list = groups.get(k);
    if (list) list.push(r);
    else groups.set(k, [r]);
  }
  return groups;
}

function byModel(rows) {
  const out = [];
  // The group key is composite (model + provider) because the same model id is
  // served by several upstreams and must stay separate - but it is only a KEY.
  // Pushing it as `model` leaked a literal NUL into the API (the client rendered
  // "deepseek-v4.1-flash\u0000relaycat-cn"), so take the fields off the row.
  for (const [, list] of groupBy(rows, (r) => `${r.model}\u0000${r.provider}`)) {
    out.push({ model: list[0].model, provider: list[0].provider, ...aggregate(list) });
  }
  return out.sort((a, b) => b.totalInputTokens + b.totalOutputTokens - (a.totalInputTokens + a.totalOutputTokens));
}

function byFolder(rows) {
  const out = [];
  for (const [folder, list] of groupBy(rows, (r) => r.folder)) {
    out.push({ folder, ...aggregate(list) });
  }
  return out.sort((a, b) => b.totalInputTokens + b.totalOutputTokens - (a.totalInputTokens + a.totalOutputTokens));
}

function byAgentType(rows) {
  const out = [];
  for (const [agentType, list] of groupBy(rows, (r) => r.agentType)) {
    const a = aggregate(list);
    out.push({
      agentType,
      totalRequests: a.totalRequests,
      totalInputTokens: a.totalInputTokens,
      totalOutputTokens: a.totalOutputTokens,
      totalCacheReadTokens: a.totalCacheReadTokens,
      totalCacheWriteTokens: a.totalCacheWriteTokens,
      totalCost: a.totalCost,
    });
  }
  return out.sort((a, b) => b.totalInputTokens + b.totalOutputTokens - (a.totalInputTokens + a.totalOutputTokens));
}

/** Bucket rows into [start, start+bucket) windows, oldest first. */
function bucketize(rows, hours, bucketMs, reduce) {
  const now = Date.now();
  const start = now - hours * HOUR;
  const count = Math.max(1, Math.ceil((now - start) / bucketMs));
  const buckets = new Array(count);
  for (let i = 0; i < count; i++) buckets[i] = { timestamp: start + i * bucketMs, rows: [] };
  for (const r of rows) {
    if (r.timestamp < start) continue;
    const i = Math.min(count - 1, Math.floor((r.timestamp - start) / bucketMs));
    buckets[i].rows.push(r);
  }
  return buckets.map((b) => reduce(b.rows, b.timestamp));
}

function timeSeries(rows, hours, bucketMs) {
  return bucketize(rows, hours, bucketMs, (list, timestamp) => ({
    timestamp,
    requests: list.length,
    errors: list.filter((r) => r.errorMessage).length,
    tokens: list.reduce((s, r) => s + r.usage.input + r.usage.output, 0),
    cost: list.reduce((s, r) => s + r.usage.cost.total, 0),
  }));
}

function modelSeries(rows, days, bucketMs) {
  return bucketize(rows, days * 24, bucketMs, (list, timestamp) =>
    [...groupBy(list, (r) => `${r.model}\u0000${r.provider}`)].map(([, l]) => ({
      timestamp,
      model: l[0].model,
      provider: l[0].provider,
      requests: l.length,
    })),
  ).flat();
}

function modelPerformanceSeries(rows, days, bucketMs) {
  return bucketize(rows, days * 24, bucketMs, (list, timestamp) =>
    [...groupBy(list, (r) => `${r.model}\u0000${r.provider}`)].map(([, l]) => {
      const durations = l.map((r) => r.duration).filter((d) => d > 0);
      const sum = durations.reduce((s, d) => s + d, 0);
      const output = l.reduce((s, r) => s + r.usage.output, 0);
      return {
        timestamp,
        model: l[0].model,
        provider: l[0].provider,
        requests: l.length,
        avgTtft: 0,
        avgTokensPerSecond: sum ? (output / sum) * 1000 : 0,
      };
    }),
  ).flat();
}

function costSeries(rows, days) {
  return bucketize(rows, days * 24, DAY, (list, timestamp) =>
    [...groupBy(list, (r) => `${r.model}\u0000${r.provider}`)].map(([, l]) => {
      const sum = (f) => l.reduce((s, r) => s + f(r), 0);
      return {
        timestamp,
        model: l[0].model,
        provider: l[0].provider,
        cost: sum((r) => r.usage.cost.total),
        unpricedRequests: l.filter((r) => r.costUnpriced).length,
        costInput: sum((r) => r.usage.cost.input),
        costOutput: sum((r) => r.usage.cost.output),
        costCacheRead: sum((r) => r.usage.cost.cacheRead),
        costCacheWrite: sum((r) => r.usage.cost.cacheWrite),
        requests: l.length,
      };
    }),
  ).flat();
}

function byProvider(rows) {
  const out = [];
  for (const [provider, list] of groupBy(rows, (r) => r.provider)) {
    const a = aggregate(list);
    out.push({
      provider,
      totalRequests: a.totalRequests,
      failedRequests: a.failedRequests,
      models: new Set(list.map((r) => r.model)).size,
      totalInputTokens: a.totalInputTokens,
      totalOutputTokens: a.totalOutputTokens,
      totalCacheReadTokens: a.totalCacheReadTokens,
      totalCacheWriteTokens: a.totalCacheWriteTokens,
      totalTokens: a.totalInputTokens + a.totalOutputTokens,
      totalCost: a.totalCost,
      unpricedRequests: a.unpricedRequests,
      totalPremiumRequests: 0,
      avgTokensPerSecond: a.avgTokensPerSecond,
    });
  }
  return out.sort((a, b) => b.totalTokens - a.totalTokens);
}

function hourlyByProvider(rows) {
  // omp buckets by hour-of-day (0-23) over the window, not by absolute hour.
  const cutoff = Date.now() - 24 * HOUR;
  const out = [];
  for (const [key, list] of groupBy(rows.filter((r) => r.timestamp >= cutoff), (r) => `${r.provider}\u0000${new Date(r.timestamp).getHours()}`)) {
    const [provider, hour] = key.split("\u0000");
    out.push({
      provider,
      hour: Number(hour),
      totalTokens: list.reduce((s, r) => s + r.usage.input + r.usage.output, 0),
      outputTokens: list.reduce((s, r) => s + r.usage.output, 0),
      requests: list.length,
    });
  }
  return out.sort((a, b) => a.hour - b.hour || a.provider.localeCompare(b.provider));
}

function providerSeries(rows, days, bucketMs) {
  return bucketize(rows, days * 24, bucketMs, (list, timestamp) =>
    [...groupBy(list, (r) => r.provider)].map(([, l]) => ({
      timestamp,
      provider: l[0].provider,
      totalTokens: l.reduce((s, r) => s + r.usage.input + r.usage.output, 0),
      cost: l.reduce((s, r) => s + r.usage.cost.total, 0),
      unpricedRequests: l.filter((r) => r.costUnpriced).length,
      requests: l.length,
    })),
  ).flat();
}

function recentRows(rows, limit) {
  return rows
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

function errorRows(rows, limit) {
  return rows
    .filter((r) => r.errorMessage)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

const EMPTY_AGG = aggregate([]);

/**
 * Route one /api/* request. Returns a plain object (or array) for the caller to
 * serialise, or null when the path is not ours.
 */
export function statsApi(pathname, searchParams) {
  const range = searchParams.get("range");
  const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 0, 0), 1000);

  // Range-independent: recent/errors only need a window wide enough to hold the
  // requested rows, so they use the default and sort by time.
  if (pathname === "/api/stats/recent") {
    return recentRows(inWindow(loadRows("all"), null), limit || 100);
  }
  if (pathname === "/api/stats/errors") {
    return errorRows(inWindow(loadRows(range ?? DEFAULT_RANGE), resolveRange(range).cutoff), limit || 50);
  }

  const rows = inWindow(loadRows(range), resolveRange(range).cutoff);
  const { spec } = resolveRange(range);

  switch (pathname) {
    case "/api/stats":
      return {
        overall: aggregate(rows),
        byModel: byModel(rows),
        byFolder: byFolder(rows),
        byAgentType: byAgentType(rows),
        timeSeries: timeSeries(rows, spec.timeSeriesHours, spec.timeSeriesBucketMs),
        modelSeries: modelSeries(rows, spec.modelSeriesDays, spec.modelSeriesBucketMs),
        modelPerformanceSeries: modelPerformanceSeries(rows, spec.modelPerformanceDays, spec.modelPerformanceBucketMs),
        costSeries: costSeries(rows, spec.costSeriesDays),
      };
    case "/api/stats/overview":
      return {
        overall: aggregate(rows),
        byAgentType: byAgentType(rows),
        timeSeries: timeSeries(rows, spec.timeSeriesHours, spec.timeSeriesBucketMs),
      };
    case "/api/stats/model-dashboard":
      return {
        byModel: byModel(rows),
        modelSeries: modelSeries(rows, spec.modelSeriesDays, spec.modelSeriesBucketMs),
        modelPerformanceSeries: modelPerformanceSeries(rows, spec.modelPerformanceDays, spec.modelPerformanceBucketMs),
      };
    case "/api/stats/costs":
      return { costSeries: costSeries(rows, spec.costSeriesDays) };
    case "/api/stats/providers":
      return {
        providers: byProvider(rows),
        hourly: hourlyByProvider(rows),
        series: providerSeries(rows, spec.modelSeriesDays, spec.modelSeriesBucketMs),
        // Populated only when the upstream reports account-level quota windows;
        // a proxy sees one credential per route and has nothing to add here.
        usageSeries: [],
        windowInsights: [],
      };
    case "/api/stats/folders":
      return byFolder(rows);
    case "/api/stats/models":
      return byModel(rows);
    case "/api/stats/timeseries":
      return timeSeries(rows, spec.timeSeriesHours, spec.timeSeriesBucketMs);
    case "/api/stats/tools":
      // Tool calls happen inside the agent, not the proxy - the gateway only sees
      // the request envelope. Empty (not zeroed) so the panel shows "no data"
      // rather than a misleading flat line at zero.
      return { byTool: [], byToolModel: [], series: [] };
    case "/api/stats/behavior":
      return { overall: { totalMessages: 0, totalYelling: 0, totalProfanity: 0, totalAnguish: 0, totalNegation: 0, totalRepetition: 0, totalBlame: 0, totalChars: 0, firstTimestamp: 0, lastTimestamp: 0 }, byModel: [], behaviorSeries: [] };
    case "/api/stats/gain":
      return { overall: { savedTokens: 0, savedBytes: 0, hits: 0, outputBytes: 0, originalBytes: 0, reductionPercent: null }, bySource: {}, timeSeries: [], project: null, projects: [] };
    // Transcript drill-downs: the proxy stores no conversation text, so these are
    // empty rather than 404 - a 404 makes the client surface an error banner.
    case "/api/sessions":
      return [];
    case "/api/session/trace":
    case "/api/session/entry":
      return { error: "not available in the gateway dashboard" };
    case "/api/sync":
      return { synced: 0, files: 0, totalMessages: rows.length };
    default:
      return null;
  }
}

export { RANGES, DEFAULT_RANGE };

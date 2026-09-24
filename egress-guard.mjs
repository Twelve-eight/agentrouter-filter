// Egress guard: redaction for upstreams we do not trust with host data.
//
// WHY THIS EXISTS
// A provider can be technically reachable and still be a privacy liability. The
// justwoker case (2026-09-24) is the motivating one: a captured request showed
// the host username, absolute workspace paths, OS build number, timezone, shell
// name, and - because Codex reads files - verbatim API keys inside tool_result
// blocks. None of that is needed for the model to write code, and all of it is
// exactly what a data-harvesting endpoint would want.
//
// DESIGN CONSTRAINTS
//  1. Deterministic. Regex only; no model call, no network, no heuristics that
//     change between runs. A redaction you cannot predict is not a control.
//  2. Must not silently corrupt JSON. The guard parses, rewrites only STRING
//     leaves, and re-serialises, so a replacement can never break the envelope
//     or merge two fields.
//  3. Must not break coding. Redactions keep the shape the model needs:
//     C:\Users\<user>\proj stays a path, KEY=<redacted> stays an assignment.
//  4. Auditable. Every hit is reported by rule name so the caller can log and
//     the operator can see what was actually removed.
//  5. Fail-closed at the CALL SITE (server.mjs), not here: this module throws on
//     malformed input rather than quietly returning the original bytes.

function R(name, re, replacement) {
  return { name, re, replacement };
}

const REDACTED = "<redacted>";

// Values that are REFERENCES to a secret rather than the secret itself. Coding
// agents read source code constantly, so apiKey: process.env.X and
// password: getPassword() are the COMMON case; redacting those would stop the
// model reasoning about the code it was asked to edit.
const REFERENCE_PREFIX = /^(?:process\.env|os\.environ|env\.|import\.meta|self\.|this\.|getenv|readSecret|config\.|settings\.|opts\.|options\.|args\.|$\{?|\{\{?|%[A-Za-z_]+%|<\w+>)/i;
const BARE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function looksLikeReference(value) {
  if (REFERENCE_PREFIX.test(value)) return true;
  // A bare identifier (no digits, no symbols) is a variable name, not a secret.
  // Real credentials essentially always contain a digit or a symbol.
  if (BARE_IDENTIFIER.test(value)) return true;
  return false;
}

// A strict test for an env/reference EXPRESSION, used when the key name has
// already established that the field holds a secret. Unlike looksLikeReference
// it does NOT accept bare identifiers, so a literal secret is never mistaken
// for a variable name.
const REFERENCE_EXPRESSION = /^(?:process\.env|os\.environ|env\.|import\.meta|getenv|readSecret|\$\{|\{\{|%[A-Za-z_]+%|<\w+>)/;

// Does this VALUE look like a real credential rather than a placeholder?
//
// The distinction matters: redacting `sk-workbuddy` (a local, non-secret
// placeholder the user must be able to write into config) is a usability bug,
// while missing a real key is a security bug. Real keys carry a digit in
// practice; hand-written placeholders are usually all-lowercase words.
function looksLikeCredential(value) {
  if (typeof value !== "string") return false;
  if (!/[0-9]/.test(value)) return false;
  return value.length >= 12;
}

// The host identity this process runs as. Short and common values are dropped so
// a rule can never rewrite ordinary prose.
function hostIdentities() {
  const names = [process.env.USERNAME, process.env.COMPUTERNAME, process.env.USERDOMAIN, process.env.USER]
    .filter((v) => typeof v === "string" && v.trim().length >= 4)
    .filter((v) => !/^(?:user|admin|test|guest|home|default|windows|system)$/i.test(v.trim()));
  return [...new Set(names.map((v) => v.trim()))];
}

const escapeRe = (s) => s.replace(/[.*+?$()|[\]\\]/g, "\\$");

// Field NAMES that imply their value is a secret.
//
// This list is not guesswork: an independent packet scan of this provider
// (2026-09-24) counted hits per field name, and these are its results --
// credentials 37657, API Key 22734, credential 8216, 令牌 6071, OpenAI Key 3917,
// 凭证 3191, 密钥 2546, JWT 2187, 密码 1458, dsn 1201, URL凭据 636, 私钥 469,
// AccessKey 378, SecretKey 204, encryptionkey 184, GitHub Token 18.
//
// Redacting by KEY (not only by value shape) is the only way to cover the long
// tail: a value-pattern list can never enumerate every credential format, but a
// field called `credentials` is a credential no matter what it looks like.
const SECRET_SEGMENTS = new Set([
  "secret", "token", "password", "passwd", "passphrase", "pwd",
  "credential", "credentials", "dsn", "jwt", "bearer", "key",
]);

// A segment that marks a key as deliberately PUBLIC. `publicKey` / `public_key`
// carry no secret, and redacting them would break signature verification code.
const PUBLIC_SEGMENTS = new Set(["public", "pub"]);

const CJK_SECRET = /(?:令牌|凭证|密钥|密码|私钥|凭据|口令)/;

// Keys whose SUBTREE is a JSON Schema rather than data.
//
// This distinction is load-bearing. A schema describes SHAPE: the key
// `properties.password` means "this tool accepts a field named password", and
// its children are keywords (`type`, `description`, ...) rather than secret
// values. Treating it as data redacted `type: "string"` into
// `type: "<redacted>"` and the upstream rejected the whole request with
// TOOL_SCHEMA_INVALID (measured 2026-09-24). Key-name redaction is therefore
// suppressed inside a schema; value-shape rules still run, so a real credential
// pasted into a description is still caught while `type`/`required`/`enum`
// keywords survive intact.
const SCHEMA_ROOT_KEYS = new Set([
  "input_schema", "inputSchema", "parameters", "json_schema", "schema",
]);

// Split camelCase / snake_case / kebab-case / dotted names into segments so
// `apiKey` and `API_KEY` both resolve to [api, key] while `tokenizer` stays a
// single innocent word.
function keySegments(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9\u4e00-\u9fff]+/g, "_")
    .toLowerCase()
    .split("_")
    .filter(Boolean);
}

// Trailing segments that turn a secret word into a description OF secrets:
// `keyCount` is a number, `apiKeyName` is a label. Neither is a secret value.
const DESCRIPTOR_SEGMENTS = new Set([
  "count", "name", "names", "len", "length", "size", "id", "ids",
  "type", "types", "list", "index", "idx", "path", "file", "url",
  "enabled", "required", "optional", "hint", "label", "desc", "help",
]);

export function isSensitiveKey(key) {
  if (typeof key !== "string" || key.length === 0) return false;
  if (CJK_SECRET.test(key)) return true;
  const segs = keySegments(key);
  const secret = segs.filter((s) => SECRET_SEGMENTS.has(s));
  if (secret.length === 0) return false;
  // `publicKey` / `public_key` are names, not secrets.
  if (secret.every((s) => s === "key") && segs.some((s) => PUBLIC_SEGMENTS.has(s))) return false;
  // A field whose LAST segment describes a secret rather than holding one.
  const last = segs[segs.length - 1];
  if (DESCRIPTOR_SEGMENTS.has(last) && !secret.includes(last)) return false;
  return true;
}

export function buildRules() {
  const rules = [
    // ---- credentials: never needed in order to write code ----------------
    R("private-key-block",
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
      "-----BEGIN PRIVATE KEY-----<redacted>-----END PRIVATE KEY-----"),

    R("jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, REDACTED),

    R("bearer-token", /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, "Bearer " + REDACTED),

    // Provider API keys. 20+ chars after the prefix keeps local placeholders
    // such as sk-workbuddy / sk-local-gateway readable while catching real keys.
    R("api-key-sk", /\bsk-[A-Za-z0-9_-]{24,}/g, "sk-" + REDACTED),
    R("github-token", /\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED),
    R("aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED),
    R("google-api-key", /\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED),
    R("slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, REDACTED),
    R("npm-token", /\bnpm_[A-Za-z0-9]{30,}/g, REDACTED),

    // Credentials embedded in a URL: scheme://user:pass@host
    R("credential-in-url",
      /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]{1,64}:[^\s/@]{1,}@/gi,
      (m, scheme) => scheme + "<redacted>@"),

    // KEY=value or "key": "value" for secret-sounding names. The value must look
    // like a literal credential, not a variable reference (looksLikeReference).
    R("secret-assignment",
      /\b([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|credential|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|session[_-]?id)[A-Za-z0-9_.-]*)\s*[:=]\s*(["']?)([^\s"',;]{12,})\2/gi,
      // (the callback below additionally requires a digit - see looksLikeCredential)
      (m, key, quote, value) => ((REFERENCE_EXPRESSION.test(value) || !looksLikeCredential(value)) ? m : key + "=" + quote + REDACTED + quote)),

    // .env style line whose NAME says it holds a secret, whatever the value is.
    // Chinese field names, from the same packet scan: 令牌 6071, 凭证 3191,
    // 密钥 2546, 密码 1458, 私钥 469. Matched as `名称: 值` / `名称=值`, which is
    // how they appear inside config files and tool output.
    R("secret-assignment-cjk",
      /([\u4e00-\u9fff]{0,6}(?:令牌|凭证|密钥|密码|私钥|凭据|口令))["']?\s*[:=：]\s*(["']?)([^\s"',;，。]{3,})\2/g,
      (m, key, quote) => key + "=" + quote + REDACTED + quote),

    R("env-secret-line",
      /^([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PWD)[A-Za-z0-9_]*)=(.+)$/gm,
      (m, key, value) => ((REFERENCE_EXPRESSION.test(value.trim()) || !looksLikeCredential(value.trim())) ? m : key + "=" + REDACTED)),

    // ---- host identity: the collect-information-about-the-computer part ---
    R("windows-user-path", /([A-Za-z]:\\Users\\)[^\\\s"']+/g, (m, prefix) => prefix + "<user>"),
    R("posix-home-path", /(\/(?:home|Users)\/)[^/\s"']+/g, (m, prefix) => prefix + "<user>"),
    // UNC \\MACHINE\share -> \\<host>\share
    R("unc-host", /\\\\[^\\\s"']+\\/g, "\\\\<host>\\"),

    // The Windows build number is pure fingerprint; keep the family so the model
    // still picks the right shell syntax.
    R("windows-build", /\bWindows\s+\d+\.\d+(?:\.\d+)*/gi, "Windows"),

    // Private-network addresses identify the LAN.
    R("private-ip",
      /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
      "<private-ip>"),

    R("mac-address", /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, "<mac>"),
  ];

  // Exact host identity strings (username / computer name). Word-boundary
  // anchored so a name is not rewritten inside a longer token.
  for (const name of hostIdentities()) {
    rules.push(R("host-identity:" + name,
      new RegExp("(?<![A-Za-z0-9_])" + escapeRe(name) + "(?![A-Za-z0-9_])", "g"),
      "<host>"));
  }
  return rules;
}

export const RULES = buildRules();
export const RULE_NAMES = RULES.map((r) => r.name);

// Names may be exact rule names, a category prefix (e.g. "host-identity"), or
// the literal true / "all" for the whole set.
export function selectRules(spec) {
  if (spec === undefined || spec === null || spec === false) return [];
  if (spec === true || spec === "all" || spec === "*") return RULES;
  const wanted = Array.isArray(spec) ? spec : [spec];
  const chosen = [];
  for (const w of wanted) {
    if (typeof w !== "string" || !w) continue;
    for (const r of RULES) {
      if (r.name === w || r.name.startsWith(w + ":")) {
        if (!chosen.includes(r)) chosen.push(r);
      }
    }
  }
  return chosen;
}

// Redact one string. Returns the new text plus one finding per rule that fired.
export function redactText(input, rules = RULES) {
  if (typeof input !== "string" || input.length === 0) return { text: input, findings: [] };
  const findings = [];
  let text = input;
  for (const rule of rules) {
    let hits = 0;
    text = text.replace(rule.re, (...args) => {
      hits++;
      return typeof rule.replacement === "function" ? rule.replacement(...args) : rule.replacement;
    });
    if (hits > 0) findings.push({ rule: rule.name, count: hits });
  }
  return { text, findings };
}

// Walk a JSON value, rewriting only string leaves.
//
// `underSensitive` propagates down a subtree: once a key is named `credentials`
// or `密码`, every scalar beneath it is replaced regardless of its shape, while
// the key names and the overall structure survive. That is deliberate - a model
// asked to edit config code still needs to see WHICH fields exist, but never
// their values.
export function redactValue(value, rules = RULES) {
  const findings = [];
  // `inSchema` propagates down a schema subtree and suppresses KEY-NAME
  // redaction only; string values are still filtered by shape.
  const walk = (v, underSensitive, inSchema) => {
    if (typeof v === "string") {
      if (underSensitive && !inSchema && v.length > 0) {
        // Only an explicit env/reference EXPRESSION survives here
        // (`process.env.X`, `readSecret(...)`) - that is the thing a coding agent
        // must still see in order to edit config code.
        //
        // NOTE: the broader looksLikeReference() heuristic is deliberately NOT
        // used. It accepts any bare identifier, which made `password:
        // hunter2hunter2` pass through untouched (measured 2026-09-24). Under a
        // key already known to hold a secret there is no ambiguity to resolve.
        if (REFERENCE_EXPRESSION.test(v)) return v;
        findings.push({ rule: "sensitive-key", count: 1 });
        return REDACTED;
      }
      const r = redactText(v, rules);
      if (r.findings.length) findings.push(...r.findings);
      return r.text;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, underSensitive, inSchema));
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        const childSchema = inSchema || SCHEMA_ROOT_KEYS.has(k);
        out[k] = walk(val, underSensitive || isSensitiveKey(k), childSchema);
      }
      return out;
    }
    return v;
  };
  return { value: walk(value, false, false), findings };
}

// Guard a serialised request body. Throws on unparseable JSON so the caller can
// fail closed rather than forward the original bytes.
export function guardBody(raw, rules = RULES) {
  const parsed = JSON.parse(raw);
  const { value, findings } = redactValue(parsed, rules);
  const merged = new Map();
  for (const f of findings) merged.set(f.rule, (merged.get(f.rule) ?? 0) + f.count);
  return {
    body: JSON.stringify(value),
    findings: [...merged].map(([rule, count]) => ({ rule, count })),
  };
}

// Compact one-line summary for the gateway log.
export function summarize(findings) {
  return findings.map((f) => f.rule + "x" + f.count).join(",");
}

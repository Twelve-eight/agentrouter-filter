
import { guardBody, redactText, RULES, summarize } from "../egress-guard.mjs";

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log("PASS  " + name); pass++; } catch (e) { console.log("FAIL  " + name + "\n      " + e.message); fail++; } };
const eq = (a, b, what) => { if (a !== b) throw new Error(what + ": got " + JSON.stringify(a) + " want " + JSON.stringify(b)); };
const has = (s, sub, what) => { if (!s.includes(sub)) throw new Error(what + ": missing " + JSON.stringify(sub) + " in " + JSON.stringify(s.slice(0, 200))); };
const hasNot = (s, sub, what) => { if (s.includes(sub)) throw new Error(what + ": still present " + JSON.stringify(sub)); };

console.log("rules loaded: " + RULES.length);
console.log(RULES.map(r => r.name).join(", "));
console.log("");

// --- credentials
t("redacts a real sk- key", () => {
  const r = redactText("JUSTWOKER_API_KEY=sk-tS8yWCzfEjZeWDLUtenr84pRJXbe21GnPbJP9SM7oQIbCjqP");
  hasNot(r.text, "tS8yWCzfEjZeWDLU", "key body");
  has(r.text, "<redacted>", "replacement");
});
t("keeps a local placeholder key readable", () => {
  const r = redactText("api_key: sk-workbuddy");
  eq(r.text, "api_key: sk-workbuddy", "short placeholder untouched");
});
t("keeps process.env references readable", () => {
  const r = redactText("const k = process.env.OPENCODE_API_KEY;");
  eq(r.text, "const k = process.env.OPENCODE_API_KEY;", "reference untouched");
});
t("redacts an env line with a literal value", () => {
  const r = redactText("OPENCODE_API_KEY=sk-DVfabcdefghijklmnopqrstuvwxyz");
  hasNot(r.text, "DVfabcdefg", "value");
});
t("redacts AWS keys", () => {
  const r = redactText("aws_access_key_id = AKIAIOSFODNN7EXAMPLE");
  hasNot(r.text, "AKIAIOSFODNN7EXAMPLE", "aws key");
});
t("redacts a private key block", () => {
  const r = redactText("-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----");
  hasNot(r.text, "MIIEow", "key body");
});
t("redacts credentials in a URL", () => {
  const r = redactText("https://alice:hunter2@example.com/v1");
  hasNot(r.text, "hunter2", "password");
  has(r.text, "example.com", "host kept");
});

// --- host identity
t("redacts the windows user path", () => {
  const r = redactText("C:\\Users\\o_Obl\\AppData\\Local");
  hasNot(r.text, "o_Obl", "username");
  has(r.text, "C:\\Users\\<user>", "shape kept");
});
t("redacts the windows build number", () => {
  const r = redactText("OS: Microsoft Windows 10.0.19045");
  hasNot(r.text, "19045", "build");
  has(r.text, "Windows", "family kept");
});
t("redacts private IPs", () => {
  const r = redactText("gateway on 192.168.10.100:7878");
  hasNot(r.text, "192.168.10.100", "lan ip");
});
t("redacts a MAC address", () => {
  const r = redactText("adapter 3C-7C-3F-1A-2B-4C");
  hasNot(r.text, "3C-7C-3F-1A-2B-4C", "mac");
});

// --- must NOT break normal coding content
t("leaves ordinary code untouched", () => {
  const code = "export function toChatBody(body, model, allowedEfforts = null) { return body; }";
  eq(redactText(code).text, code, "plain code");
});
t("leaves a public path untouched", () => {
  const s = "see /usr/local/bin/node and C:\\Program Files\\nodejs";
  eq(redactText(s).text, s, "public paths");
});
t("leaves ordinary prose untouched", () => {
  const s = "The quick brown fox jumps over the lazy dog.";
  eq(redactText(s).text, s, "prose");
});

// --- body guard
t("guardBody rewrites only string leaves and keeps valid JSON", () => {
  const raw = JSON.stringify({
    model: "claude-opus-4-8",
    system: "User: o_Obl. OS: Windows 10.0.19045. dir C:\\Users\\o_Obl\\proj",
    messages: [{ role: "user", content: "JUSTWOKER_API_KEY=sk-tS8yWCzfEjZeWDLUtenr84pRJXbe21GnPbJP9SM7oQIbCjqP" }],
    max_tokens: 8192,
  });
  const g = guardBody(raw);
  const p = JSON.parse(g.body);
  eq(p.model, "claude-opus-4-8", "model preserved");
  eq(p.max_tokens, 8192, "number preserved");
  hasNot(g.body, "o_Obl", "username");
  hasNot(g.body, "19045", "build");
  hasNot(g.body, "tS8yWCzfEjZeWDLU", "api key");
  if (!g.findings.length) throw new Error("no findings reported");
});
t("guardBody throws on malformed JSON (fail closed)", () => {
  let threw = false;
  try { guardBody("{not json"); } catch { threw = true; }
  if (!threw) throw new Error("did not throw");
});

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);

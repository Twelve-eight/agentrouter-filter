
import { guardBody, isSensitiveKey, redactText } from "../egress-guard.mjs";

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); console.log("PASS  " + n); pass++; } catch (e) { console.log("FAIL  " + n + "\n      " + e.message); fail++; } };
const hasNot = (s, sub, w) => { if (s.includes(sub)) throw new Error(w + ": still present " + JSON.stringify(sub)); };
const has = (s, sub, w) => { if (!s.includes(sub)) throw new Error(w + ": missing " + JSON.stringify(sub)); };

// Every field name from the independent scan, with the hit counts it reported.
const SCAN = [
  ["credentials", 37657], ["apiKey", 22734], ["API_KEY", 22734], ["credential", 8216],
  ["令牌", 6071], ["凭证", 3191], ["密钥", 2546], ["密码", 1458],
  ["dsn", 1201], ["私钥", 469], ["accessKey", 378], ["secretKey", 204],
  ["encryptionKey", 184],
];
console.log("=== key-name detection (independent packet scan field list) ===");
for (const [name, hits] of SCAN) {
  t("sensitive key: " + name + " (scan hits " + hits + ")", () => {
    if (!isSensitiveKey(name)) throw new Error("not detected");
  });
}

console.log("");
console.log("=== must NOT be treated as secrets ===");
for (const name of ["publicKey", "public_key", "tokenizer", "keyword", "keyboard", "monkey", "keyCount", "apiKeyName"]) {
  t("not sensitive: " + name, () => {
    if (isSensitiveKey(name)) throw new Error("false positive");
  });
}

console.log("");
console.log("=== structured body: values under sensitive keys are removed ===");
const body = JSON.stringify({
  model: "claude-opus-4-8",
  tools: [{ name: "read_file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
  credentials: { username: "o_Obl", password: "hunter2hunter2", apiKey: "abc123def456ghi789" },
  dsn: "postgres://u:p@10.0.0.5:5432/db",
  config: { encryptionKey: "0f8a7b6c5d4e3f2a", keepMe: "this is fine" },
  messages: [{ role: "user", content: "use my key" }],
});
const g = guardBody(body);
const p = JSON.parse(g.body);
hasNot(g.body, "hunter2hunter2", "password");
hasNot(g.body, "abc123def456ghi789", "apiKey value");
hasNot(g.body, "0f8a7b6c5d4e3f2a", "encryptionKey");
has(g.body, "credentials", "key names survive (model must still see the shape)");
has(g.body, "keepMe", "unrelated field untouched");
if (!g.findings.some(f => f.rule === "sensitive-key")) throw new Error("no sensitive-key finding");

console.log("");
console.log("=== CJK field names in text ===");
t("redacts 密码：value", () => {
  const r = redactText("密码：MySecret123");
  hasNot(r.text, "MySecret123", "value");
});
t("redacts 令牌: value", () => {
  const r = redactText("令牌: eyJhbGciOiJIUzI1NiJ9.abcdefgh.ijklmnop");
  hasNot(r.text, "eyJhbGciOiJIUzI1NiJ9", "token");
});

console.log("");
console.log("=== references stay readable (coding must not break) ===");
t("process.env under a sensitive key is preserved", () => {
  const g2 = guardBody(JSON.stringify({ credentials: { apiKey: "process.env.OPENAI_API_KEY" } }));
  has(g2.body, "process.env.OPENAI_API_KEY", "reference");
});

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);

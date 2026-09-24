
import { guardBody, isSensitiveKey, redactText } from "../egress-guard.mjs";

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); console.log("PASS  " + n); pass++; } catch (e) { console.log("FAIL  " + n + "\n      " + e.message); fail++; } };
const hasNot = (s, sub, w) => { if (s.includes(sub)) throw new Error(w + ": still present " + JSON.stringify(sub)); };
const has = (s, sub, w) => { if (!s.includes(sub)) throw new Error(w + ": missing " + JSON.stringify(sub)); };
const eq = (a, b, w) => { if (a !== b) throw new Error(w + ": got " + JSON.stringify(a) + " want " + JSON.stringify(b)); };

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
console.log("=== JSON Schema must survive (regression: TOOL_SCHEMA_INVALID) ===");
// Measured 2026-09-24: key-name redaction walked INTO tool schemas, so
// `properties.password.type: "string"` became `type: "<redacted>"` and justwoker
// rejected the whole request with TOOL_SCHEMA_INVALID. A schema describes shape;
// `password` there is a FIELD NAME, not a secret value.
t("tool input_schema survives intact", () => {
  const body = JSON.stringify({
    tools: [{ name: "login", input_schema: {
      type: "object",
      properties: { password: { type: "string" }, apiKey: { type: "string" }, key: { type: "string" } },
      required: ["password"],
    } }],
  });
  const g = guardBody(body);
  const schema = JSON.parse(g.body).tools[0].input_schema;
  eq(schema.properties.password.type, "string", "password.type");
  eq(schema.properties.apiKey.type, "string", "apiKey.type");
  eq(schema.properties.key.type, "string", "key.type");
  eq(schema.properties.password.description, undefined, "no stray description");
  eq(JSON.stringify(schema.required), JSON.stringify(["password"]), "required");
});
t("anthropic-style input_schema also survives", () => {
  const body = JSON.stringify({
    tools: [{ name: "t", input_schema: { type: "object", properties: { secret: { type: "string" } } } }],
  });
  const g = guardBody(body);
  eq(JSON.parse(g.body).tools[0].input_schema.properties.secret.type, "string", "secret.type");
});
t("a real credential inside a schema DESCRIPTION is still redacted", () => {
  const SECRET = "sk-abcdefghijklmnopqrstuvwxyz012345";
  const body = JSON.stringify({
    tools: [{ name: "t", input_schema: { type: "object", properties: { c: { type: "string", description: "use " + SECRET } } } }],
  });
  const g = guardBody(body);
  hasNot(g.body, SECRET, "key in description");
  eq(JSON.parse(g.body).tools[0].input_schema.properties.c.type, "string", "shape preserved");
});
t("data under a sensitive key is still redacted (schema fix must not weaken it)", () => {
  const g = guardBody(JSON.stringify({ credentials: { password: "hunter2hunter2" } }));
  hasNot(g.body, "hunter2hunter2", "password value");
});

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);

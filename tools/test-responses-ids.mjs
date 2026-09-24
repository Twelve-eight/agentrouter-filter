// Unit tests for strict-Responses item-id normalisation (responses-ids.mjs).
//
// Why this file exists: agentrouter (ps.air-outer.com) validates the PREFIX of
// every replayed item id against the item type. A session previously served by
// relaycat - which mints ids as `item_...` - replayed them here verbatim and the
// turn died on:
//   Invalid 'input[127].id': 'item_9c5b989663879ef37cb7082c'.
//   Expected an ID that begins with 'rs'. [trace_id=76537bee...]
//
// The prefix table asserted below is copied from the upstream's OWN error
// messages, one live probe per row (2026-09-24, model gpt-6-astra):
//   reasoning "begins with 'rs'" | message "begins with 'msg'" |
//   function_call "begins with 'fc'" | function_call_output "begins with 'fc'" |
//   web_search_call "begins with 'ws'" | custom_tool_call "begins with 'ctc'" |
//   custom_tool_call_output "begins with 'ctco'"
//
// The two facts that decide the DESIGN, both measured, are pinned here as well:
//   1. renaming does NOT work (the id is looked up in the upstream's own store),
//      so the fix must DROP the id rather than rewrite its prefix;
//   2. dropping always works, and the linkage the model needs is `call_id`, not
//      `id` - which is why dropping is behaviour-preserving.
//
// Run: node tools/test-responses-ids.mjs   (exits non-zero on failure)
import assert from "node:assert";
import { stripForeignItemIds, stripAllItemIds, isItemIdRejection } from "../responses-ids.mjs";

let pass = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
}

const body = (input, extra = {}) => JSON.stringify({ model: "gpt-6-astra", stream: false, input, ...extra });
const idsOf = (text) => JSON.parse(text).input.map((it) => it?.id);

// --- 1. the reported failure: a relaycat-minted id on a reasoning item --------
check("a foreign `item_` reasoning id is dropped (the reported 400)", () => {
  const raw = body([
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "reasoning", id: "item_9c5b989663879ef37cb7082c", summary: [{ type: "summary_text", text: "s" }] },
  ]);
  const { body: out, dropped } = stripForeignItemIds(raw);
  assert.strictEqual(dropped, 1, "one id dropped");
  assert.deepStrictEqual(idsOf(out), [undefined, undefined], "the item keeps its place, loses its id");
  const item = JSON.parse(out).input[1];
  assert.strictEqual(item.type, "reasoning", "item type preserved");
  assert.deepStrictEqual(item.summary, [{ type: "summary_text", text: "s" }], "summary preserved");
});

// --- 2. every type the upstream states a prefix for --------------------------
check("each type: a matching-prefix id is left ALONE", () => {
  const cases = [
    ["reasoning", "rs_abc"], ["message", "msg_abc"],
    ["function_call", "fc_abc"], ["web_search_call", "ws_abc"],
    ["custom_tool_call", "ctc_abc"], ["custom_tool_call_output", "ctco_abc"],
  ];
  for (const [type, id] of cases) {
    const raw = body([{ type, id, call_id: "call_x" }]);
    const { dropped, body: out } = stripForeignItemIds(raw);
    assert.strictEqual(dropped, 0, `${type}: should be untouched`);
    assert.strictEqual(out, raw, `${type}: body must be byte-identical (no rewrite)`);
  }
});

check("function_call_output follows the function_call prefix (fc)", () => {
  const raw = body([{ type: "function_call_output", id: "fc_abc", call_id: "call_x", output: "ok" }]);
  assert.strictEqual(stripForeignItemIds(raw).dropped, 0, "fc_ id accepted");
  const foreign = body([{ type: "function_call_output", id: "item_abc", call_id: "call_x", output: "ok" }]);
  assert.strictEqual(stripForeignItemIds(foreign).dropped, 1, "item_ id dropped");
});

check("each type: a foreign id is dropped", () => {
  const cases = ["reasoning", "message", "function_call", "function_call_output", "web_search_call", "custom_tool_call", "custom_tool_call_output"];
  for (const type of cases) {
    const raw = body([{ type, id: "item_foreign", call_id: "call_x" }]);
    const { dropped } = stripForeignItemIds(raw);
    assert.strictEqual(dropped, 1, `${type}: expected the foreign id dropped`);
  }
});

// --- 3. encrypted_content travels with the id it was encrypted for -----------
check("dropping a reasoning id also drops its encrypted_content", () => {
  const raw = body([{ type: "reasoning", id: "item_x", summary: [], encrypted_content: "gAAAAAB_foreign" }]);
  const item = JSON.parse(stripForeignItemIds(raw).body).input[0];
  assert.ok(!("encrypted_content" in item), "foreign blob must not survive its id");
});

check("a kept reasoning id keeps its encrypted_content (upstream's own replay)", () => {
  const raw = body([{ type: "reasoning", id: "rs_own", summary: [], encrypted_content: "gAAAAAB_own" }]);
  const { body: out, dropped } = stripForeignItemIds(raw);
  assert.strictEqual(dropped, 0, "own id untouched");
  assert.strictEqual(JSON.parse(out).input[0].encrypted_content, "gAAAAAB_own", "blob must survive");
});

// --- 4. things this module must NOT touch ------------------------------------
check("item_reference is never stripped (its id IS the payload)", () => {
  const raw = body([{ type: "item_reference", id: "item_abc" }]);
  const { dropped, body: out } = stripForeignItemIds(raw);
  assert.strictEqual(dropped, 0);
  assert.strictEqual(out, raw);
  const all = stripAllItemIds(raw);
  assert.strictEqual(all.dropped, 0, "level 2 must also leave it alone");
});

check("unknown item types are left alone", () => {
  const raw = body([{ type: "some_future_item", id: "item_abc" }]);
  assert.strictEqual(stripForeignItemIds(raw).dropped, 0);
});

check("non-JSON / non-array input is passed through unchanged", () => {
  for (const raw of ["not json", "{}", body(undefined)]) {
    const { body: out, dropped } = stripForeignItemIds(raw ?? "");
    assert.strictEqual(dropped, 0);
    assert.strictEqual(out, raw ?? "", "must be byte-identical");
  }
});

check("call_id and every non-id field survive the drop", () => {
  const raw = body([
    { type: "function_call", id: "item_foreign", call_id: "call_keep_me", name: "exec_command", arguments: "{\"cmd\":\"echo hi\"}" },
    { type: "function_call_output", id: "item_foreign2", call_id: "call_keep_me", output: "hi" },
  ]);
  const input = JSON.parse(stripForeignItemIds(raw).body).input;
  assert.strictEqual(input[0].call_id, "call_keep_me");
  assert.strictEqual(input[0].name, "exec_command");
  assert.strictEqual(input[1].call_id, "call_keep_me");
  assert.strictEqual(input[1].output, "hi");
});

check("nothing to fix -> the ORIGINAL string is returned (no re-serialise)", () => {
  const raw = body([{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }]);
  const { body: out, dropped } = stripForeignItemIds(raw);
  assert.strictEqual(dropped, 0);
  assert.strictEqual(out, raw);
});

// --- 5. level 2: the blunt fallback ------------------------------------------
check("stripAllItemIds drops ids of every type, including legal ones", () => {
  const raw = body([
    { type: "reasoning", id: "rs_own", summary: [], encrypted_content: "gAAAAAB_own" },
    { type: "message", id: "msg_own", role: "assistant", content: [] },
    { type: "function_call", id: "fc_own", call_id: "call_x", name: "n", arguments: "{}" },
  ]);
  const { body: out, dropped } = stripAllItemIds(raw);
  assert.strictEqual(dropped, 3, "all three ids dropped");
  const input = JSON.parse(out).input;
  assert.deepStrictEqual(input.map((it) => it.id), [undefined, undefined, undefined]);
  assert.ok(!("encrypted_content" in input[0]), "encrypted blob dropped with its id");
  assert.strictEqual(input[2].call_id, "call_x", "call linkage intact");
});

check("level 2 drops a foreign encrypted_content even when no id is present", () => {
  // Measured: `{type:"reasoning", summary:[], content:null, encrypted_content:"gAAA.."}`
  // without any id answers "The encrypted content .. could not be verified".
  const raw = body([{ type: "reasoning", summary: [], content: null, encrypted_content: "gAAAAAB_foreign" }]);
  assert.strictEqual(stripForeignItemIds(raw).dropped, 0, "level 1 has no id to judge");
  const { body: out, dropped } = stripAllItemIds(raw);
  assert.strictEqual(dropped, 1, "level 2 must act on the blob alone");
  assert.ok(!("encrypted_content" in JSON.parse(out).input[0]), "blob removed");
});

check("level 1 alone cannot rescue a legal-prefix id the upstream does not know", () => {
  // Measured: replaying an unknown `rs_..` answers "Item with id 'rs_..' not
  // found" - level 1 sees nothing wrong, which is exactly why level 2 exists.
  const raw = body([{ type: "reasoning", id: "rs_jpmw1umntvs", summary: [] }]);
  assert.strictEqual(stripForeignItemIds(raw).dropped, 0, "level 1 leaves it");
  assert.strictEqual(stripAllItemIds(raw).dropped, 1, "level 2 removes it");
});

// --- 6. rejection detection gates the retry ----------------------------------
check("the upstream's own id complaints are recognised", () => {
  const real = [
    `{"error":{"message":"OpenAI Responses bad request: Invalid 'input[127].id': 'item_9c5b989663879ef37cb7082c'. Expected an ID that begins with 'rs'. [trace_id=76537bee1fa8ea2e23c577d8b0d63b4]"}}`,
    `{"error":{"message":"Invalid 'input[1].id': 'item_a9c8bc3ee010b2b80ae3ad58'. Expected an ID that begins with 'msg'. [trace_id=e7d12f467278188919a70c6f6970f650]"}}`,
    `{"error":{"message":"Item with id 'rs_9c5b989663879ef37cb7082c' not found. [trace_id=25b1941d805cc76edf83ead20682c463]"}}`,
    `{"error":{"message":"The encrypted content gAAA... could not be verified. Reason: Encrypted content could not be decrypted or parsed. [trace_id=c34158e7afb10f7e230191f90341aa33]"}}`,
  ];
  for (const t of real) assert.ok(isItemIdRejection(t), `should match: ${t.slice(0, 60)}`);
});

check("unrelated 400s do NOT trigger a retry", () => {
  const others = [
    `{"error":{"message":"Invalid 'input[1].content': array too long. Expected an array with maximum length 0, but got an array with length 1 instead."}}`,
    `{"error":{"message":"Missing required parameter: 'input[1].call_id'."}}`,
    `{"error":{"message":"Budget pool quota has been exhausted"}}`,
    "",
    null,
    undefined,
  ];
  for (const t of others) assert.ok(!isItemIdRejection(t), `should not match: ${String(t).slice(0, 50)}`);
});

console.log(`\n${pass} checks passed${process.exitCode ? " (with failures above)" : ""}`);

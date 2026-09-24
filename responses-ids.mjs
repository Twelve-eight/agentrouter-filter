// Strict-Responses item-ID normalisation for agentrouter (ps.air-outer.com).
//
// WHY THIS EXISTS
// ---------------
// Codex replays the previous turns of a session on every request, and several
// upstreams we route mint their item ids in their OWN namespace. relaycat, for
// example, answers a message item as
//     { "type": "message", "id": "item_66935b8aec1a06f235fcf537", ... }
// (measured 2026-09-24). Codex stores that id and replays it verbatim on every
// later turn. When the same session is then served by agentrouter, the replay is
// rejected outright:
//     Invalid 'input[127].id': 'item_9c5b989663879ef37cb7082c'.
//     Expected an ID that begins with 'rs'. [trace_id=76537bee...]
// That 400 kills the turn - the exact failure this module exists to remove.
//
// WHAT WAS MEASURED (2026-09-24, https://ps.air-outer.com/v1/responses,
// model gpt-6-astra, one probe per row)
// ---------------------------------------------------------------------------
//   reasoning               "Expected an ID that begins with 'rs'"    -> rs_*
//   message                 "Expected an ID that begins with 'msg'"   -> msg*
//   function_call           "Expected an ID that begins with 'fc'"    -> fc*
//   function_call_output    "Expected an ID that begins with 'fc'"    -> fc*
//   web_search_call         "Expected an ID that begins with 'ws'"    -> ws*
//   custom_tool_call        "Expected an ID that begins with 'ctc'"   -> ctc*
//   custom_tool_call_output "Expected an ID that begins with 'ctco'"  -> ctco*
//
// Two further facts, both measured, decide the design:
//
//   1. RENAMING DOES NOT WORK. Rewriting the offending id to a `rs_`-prefixed
//      one still fails - "Item with id 'rs_9c5b98..' not found" - because the
//      upstream resolves the id in ITS OWN store. A foreign id can therefore
//      never be made acceptable by fixing the prefix alone.
//   2. DROPPING ALWAYS WORKS. With the id removed (and `encrypted_content`
//      removed with it, see below) the very same replay answers 200. Verified
//      for reasoning (content:null / summary present - the reported shape),
//      reasoning with only a summary, message, function_call,
//      function_call_output, web_search_call, custom_tool_call and
//      custom_tool_call_output. The linkage the model actually needs is
//      `call_id`, not `id`; the user-visible text/arguments ride in the item
//      body. So an id is pure metadata on the replay path and removing one is
//      behaviour-preserving.
//
// encrypted_content travels WITH the id: it is a blob encrypted by the upstream
// that minted the id, and a foreign blob is rejected with "The encrypted content
// gAAA... could not be decrypted or parsed" (measured). agentrouter's OWN
// reasoning item (id rs_*, encrypted_content present) replays fine, so the
// content must be kept whenever its own id is kept, and dropped whenever that id
// is dropped.
//
// SCOPE
// -----
// This runs ONLY on upstreams that declare `strictItemIds` (agentrouter today),
// and only on the responses wire. relaycat / wb2api / justjoker / anyrouter /
// opencode-zen / motomoto are untouched: their ids are their own business.
//
// Two levels, because the upstream reports two distinct id faults:
//   * stripForeignItemIds - drops ids whose prefix does not match the type's
//     contract above. This is provably foreign, and it is the reported bug.
//   * stripAllItemIds - drops every replay id (and every reasoning
//     encrypted_content). Used only as a RETRY response to the upstream's own
//     complaint, for the case a foreign id happens to carry an acceptable
//     prefix, or for an id this upstream minted but no longer resolves ("Item
//     with id 'rs_..' not found" - the upstream pools several Azure resources
//     without session affinity, so even its own ids can go missing).
//
// Nothing here runs on the happy path of a healthy request: the first attempt is
// byte-identical to what the gateway sent before, and stripAllItemIds is only
// reached after the upstream itself asked for the replay to be fixed.

// Item types that carry an id this upstream validates, mapped to the prefix IT
// states in its own error message. The bare prefix (no underscore) is used
// deliberately: that is the exact contract the upstream enforces. An id from
// another upstream (relaycat's `item_...`) matches none of them.
const ID_PREFIX_BY_TYPE = {
  reasoning: "rs",
  message: "msg",
  function_call: "fc",
  function_call_output: "fc",
  web_search_call: "ws",
  custom_tool_call: "ctc",
  custom_tool_call_output: "ctco",
};

// `item_reference` is deliberately absent from the table above: there the id is
// the ENTIRE payload (it means "include the item you stored under this id"), so
// stripping it would turn a rejected request into a nonsense one. It is left
// untouched and the upstream's error is passed through - a reference to another
// upstream's item genuinely cannot be served here.
const SKIP_TYPES = new Set([ "item_reference" ]);

function isForeignId(type, id) {
  const prefix = ID_PREFIX_BY_TYPE[type];
  if (!prefix) return false;      // unknown type: not our call to make
  if (typeof id !== "string") return false;
  return !id.startsWith(prefix);
}

// Drop agentrouter's own `encrypted_content` pair-partner only when the id it was
// encrypted for is going away.
function stripEncryptedWithId(item) {
  if (item.type === "reasoning" && "encrypted_content" in item) delete item.encrypted_content;
}

// A reasoning item can carry a foreign `encrypted_content` WITHOUT carrying an
// id at all (measured: `{type:"reasoning", summary:[], content:null,
// encrypted_content:"gAAA..."}` answers "The encrypted content could not be
// verified"). Level 2 therefore drops that blob on its own account, not merely as
// the id's pair-partner.
function hasDroppablePayload(type, item) {
  return "id" in item || (type === "reasoning" && "encrypted_content" in item);
}

function rewrite(input, drop) {
  let dropped = 0;
  const out = [];
  for (const item of input) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      out.push(item);
      continue;
    }
    const type = item.type;
    if (SKIP_TYPES.has(type) || !drop(type, item)) {
      out.push(item);
      continue;
    }
    const copy = { ...item };
    delete copy.id;
    stripEncryptedWithId(copy);
    dropped++;
    out.push(copy);
  }
  return { input: out, dropped };
}

/**
 * Remove replay ids that cannot belong to a strict-Responses upstream because
 * their prefix contradicts the type contract that upstream enforces.
 * @returns {{body: string, dropped: number}} dropped=0 and body===input when
 *          nothing needed changing, so callers can skip the rewrite entirely.
 */
export function stripForeignItemIds(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { body: text, dropped: 0 }; }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.input)) {
    return { body: text, dropped: 0 };
  }
  const { input, dropped } = rewrite(parsed.input, (type, item) => isForeignId(type, item.id));
  if (!dropped) return { body: text, dropped: 0 };
  return { body: JSON.stringify({ ...parsed, input }), dropped };
}

/**
 * Remove EVERY replay id (and every reasoning encrypted_content) from `input`.
 * The blunt fallback, reached only after the upstream rejected a replay by id.
 */
export function stripAllItemIds(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { body: text, dropped: 0 }; }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.input)) {
    return { body: text, dropped: 0 };
  }
  const { input, dropped } = rewrite(parsed.input, hasDroppablePayload);
  if (!dropped) return { body: text, dropped: 0 };
  return { body: JSON.stringify({ ...parsed, input }), dropped };
}

// The upstream's two id complaints, plus the encrypted-blob one. Kept as narrow
// as the measurements allow: a 400 for any OTHER reason must not trigger a
// rewrite-and-retry, because resending a malformed body would only burn quota.
const REJECTION_PATTERNS = [
  /Expected an ID that begins with '/i,
  /Item with id '[^']*' not found/i,
  /encrypted content .* could not be (decrypted|verified)/i,
];

/** Does this 400 body complain about a replayed item id / blob? */
export function isItemIdRejection(text) {
  if (typeof text !== "string" || !text) return false;
  return REJECTION_PATTERNS.some((re) => re.test(text));
}

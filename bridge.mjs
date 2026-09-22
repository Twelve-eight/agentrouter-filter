// responses <-> chat/completions and responses <-> anthropic/messages
// translation, plus the chat/anthropic SSE -> responses SSE bridges. Side-effect
// free: this module binds no port and holds no global state, so tests can import
// it without starting a gateway (see tools/test-bridge-indices.mjs).
//
// Two bridges are needed because Codex accepts only wire_api = "responses":
//   - wb2api speaks chat/completions (DeepSeek/Qwen style)
//   - justwoker speaks anthropic/messages (Claude style) and its
//     /v1/chat/completions is Cloudflare-blocked (403), so chat is not an option
//     there even though the endpoint exists.

// ---------------------------------------------------------------------------
// responses -> chat/completions conversion (for chat-only upstreams)
// ---------------------------------------------------------------------------

function toChatMessages(body) {
  const out = [];
  // wb2api requires the first message to be a system message (400 code 11-128).
  const sys = [];
  if (body.instructions) sys.push(body.instructions);
  const items = Array.isArray(body.input) ? body.input : [{ role: "user", content: body.input }];
  const tail = [];
  // Reasoning text waiting to be attached to the next assistant message.
  const pendingReasoning = [];
  for (const it of items) {
    if (typeof it === "string") {
      tail.push({ role: "user", content: it });
      continue;
    }
    if (it.type === "reasoning") {
      // DeepSeek's thinking mode rejects a follow-up turn whose previous
      // assistant turn lacks its reasoning: code 11155 "the reasoning content
      // from the previous turn must be passed back in thinking mode", which
      // wb2api surfaces as the misleading 503 "all accounts are temporarily
      // unavailable". Dropping these items entirely is what caused it.
      //
      // chat/completions has no separate reasoning item: the text rides on the
      // assistant message as `reasoning_content`. So collect it here and attach
      // it to the next assistant message produced below.
      const parts = Array.isArray(it.content) ? it.content : [];
      const text = parts
        .map((c) => (typeof c === "string" ? c : c?.text ?? ""))
        .join("")
        .trim();
      if (text) pendingReasoning.push(text);
      continue;
    }
    if (it.type === "function_call") {
      // Consecutive function_calls are ONE assistant turn with several tool_calls,
      // not one assistant message each. Emitting them separately produced
      // A{a} A{b} T(a) T(b), which strict upstreams reject with
      // code 11148 "tool calls and tool results do not match" (wb2api surfaces it
      // as the misleading 503 "all accounts are temporarily unavailable").
      //
      // Codex 0.155 additionally replays a turn's own text as a `message` item
      // BEFORE the function_calls of that same turn. Creating a second assistant
      // message for the calls split one turn into A{content} + A{tool_calls}, and
      // the reasoning item - which the branch below attaches to the FIRST
      // assistant message it meets - never reached the tool-call message. The
      // turn that produced the tool results then had no `reasoning_content` and
      // DeepSeek rejected the follow-up with code 11155 "the reasoning content
      // from the previous turn must be passed back in thinking mode" (again
      // surfaced as 503). So append to the assistant message that is still open.
      const call = {
        id: it.call_id ?? it.id,
        type: "function",
        function: { name: it.name, arguments: it.arguments ?? "{}" },
      };
      let target = tail[tail.length - 1];
      if (!target || target.role !== "assistant") {
        target = { role: "assistant", content: null, tool_calls: [] };
        tail.push(target);
      }
      if (!Array.isArray(target.tool_calls)) target.tool_calls = [];
      target.tool_calls.push(call);
      // Reasoning that arrives AFTER the turn's text still belongs to this
      // assistant message; merge instead of overwriting.
      if (pendingReasoning.length) {
        target.reasoning_content = [target.reasoning_content, ...pendingReasoning.splice(0)]
          .filter(Boolean)
          .join("\n\n");
      }
      continue;
    }
    if (it.type === "function_call_output") {
      tail.push({
        role: "tool",
        tool_call_id: it.call_id,
        content: typeof it.output === "string" ? it.output : JSON.stringify(it.output ?? ""),
      });
      continue;
    }
    const role = it.role ?? "user";
    const parts = Array.isArray(it.content) ? it.content : [{ type: "input_text", text: String(it.content ?? "") }];
    const text = parts
      .map((p) => {
        if (typeof p === "string") return p;
        if (p.type === "input_text" || p.type === "output_text" || p.type === "text") return p.text ?? "";
        if (p.type === "input_image") return "";
        return "";
      })
      .join("");
    if (role === "system" || role === "developer") sys.push(text);
    else {
      const msg = { role, content: text };
      // Attach accumulated reasoning to the assistant turn it belongs to.
      if (role === "assistant" && pendingReasoning.length) {
        msg.reasoning_content = pendingReasoning.splice(0).join("\n\n");
      }
      tail.push(msg);
    }
  }
  return [{ role: "system", content: sys.filter(Boolean).join("\n\n") || "You are a coding agent." }, ...tail];
}

function toChatTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const mapped = tools
    .filter((t) => t && (t.type === "function" || t.name))
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.parameters ?? { type: "object", properties: {} },
      },
    }));
  return mapped.length ? mapped : undefined;
}

function toChatBody(body, model, allowedEfforts = null) {
  const messages = toChatMessages(body);
  const chat = { model, messages, stream: true };
  const tools = toChatTools(body.tools);
  if (tools) chat.tools = tools;
  if (body.tool_choice && body.tool_choice !== "none") {
    chat.tool_choice = body.tool_choice === "required" ? "required" : body.tool_choice;
  }
  if (body.max_output_tokens) chat.max_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.parallel_tool_calls !== undefined) chat.parallel_tool_calls = body.parallel_tool_calls;
  // Forward the reasoning effort. Without this the upstream applies its own
  // default (wb2api injects `high`), so a codex request for max silently ran at
  // high - verified by measuring completion_thinking_tokens through the bridge
  // vs directly against the upstream.
  const effort = body.reasoning?.effort;
  if (typeof effort === "string" && effort) {
    // codex also emits levels the chat upstreams do not know (`ultra`,
    // `persistent`); agentrouter rejects unknown variants with 422, so clamp to
    // the highest level the upstreams accept.
    let level = effort === "ultra" || effort === "persistent" ? "max" : effort;
    // opencode-zen accepts only low/medium/high for the free models: `max` and
    // `xhigh` come back as a 400 "Invalid request parameters" (measured
    // 2026-09-22), while `minimal` is refused too. Clamp into that window.
    if (allowedEfforts) {
      const known = allowedEfforts;
      if (known.length && !known.includes(level)) {
        const rank = ["minimal", "low", "medium", "high", "xhigh", "max"];
        const target = rank.indexOf(level);
        let best = null;
        for (const k of known) {
          const r = rank.indexOf(k);
          if (r < 0) continue;
          if (best === null) { best = k; continue; }
          const br = rank.indexOf(best);
          if (r > target && (br <= target || r < br)) best = k;
          else if (br <= target && r > br) best = k;
        }
        if (best) level = best;
      }
    }
    chat.reasoning_effort = level;
  }
  return chat;
}

// ---------------------------------------------------------------------------
// responses -> anthropic/messages conversion (for Claude-wire upstreams)
// ---------------------------------------------------------------------------

// Merge a content block into the tail of `messages`, appending to the previous
// message when the role repeats. Anthropic expects alternating roles and rejects
// a tool_result that is not the first block of a user message, so several
// consecutive responses items of one role must collapse into ONE message rather
// than becoming sibling messages.
function pushBlocks(messages, role, blocks) {
  if (!blocks.length) return;
  const last = messages[messages.length - 1];
  if (last && last.role === role) last.content.push(...blocks);
  else messages.push({ role, content: blocks });
}

function toAnthropicBody(body, model) {
  const messages = [];
  const items = Array.isArray(body.input) ? body.input : [{ role: "user", content: body.input }];
  for (const it of items) {
    if (typeof it === "string") {
      pushBlocks(messages, "user", [{ type: "text", text: it }]);
      continue;
    }
    if (it.type === "reasoning") {
      // NOT replayed as a thinking block. Anthropic validates a thinking block's
      // signature, and a responses `reasoning` item carries only the text - there
      // is no signature to send back. Probe-verified: a tool round-trip that omits
      // the thinking block is accepted (200, stop_reason=end_turn), so dropping it
      // is safe; forging a signature-less thinking block is not.
      continue;
    }
    if (it.type === "function_call") {
      // Consecutive function_calls are ONE assistant turn with several tool_use
      // blocks (same collapse as the chat bridge; sibling assistant messages break
      // the tool_use/tool_result pairing).
      pushBlocks(messages, "assistant", [
        {
          type: "tool_use",
          id: it.call_id ?? it.id,
          name: it.name,
          input: safeParse(it.arguments),
        },
      ]);
      continue;
    }
    if (it.type === "function_call_output") {
      const out = typeof it.output === "string" ? it.output : JSON.stringify(it.output ?? "");
      pushBlocks(messages, "user", [{ type: "tool_result", tool_use_id: it.call_id, content: out }]);
      continue;
    }
    const role = it.role === "assistant" ? "assistant" : "user";
    const parts = Array.isArray(it.content) ? it.content : [{ type: "input_text", text: String(it.content ?? "") }];
    const text = parts
      .map((p) => {
        if (typeof p === "string") return p;
        if (p.type === "input_text" || p.type === "output_text" || p.type === "text") return p.text ?? "";
        return "";
      })
      .join("");
    if (text) pushBlocks(messages, role, [{ type: "text", text }]);
  }
  // Anthropic requires a non-empty message list starting with `user`.
  if (!messages.length || messages[0].role !== "user") messages.unshift({ role: "user", content: [{ type: "text", text: "." }] });

  const out = { model, messages, max_tokens: body.max_output_tokens ?? 8192, stream: true };
  // `system` is a top-level string here, not a message (unlike chat).
  if (body.instructions) out.system = body.instructions;

  const tools = (body.tools ?? [])
    .filter((t) => t && (t.type === "function" || t.name))
    .map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: t.parameters ?? { type: "object", properties: {} },
    }));
  if (tools.length) out.tools = tools;

  // tool_choice is an object here: "required" has no direct equivalent, the
  // closest is `any` (must call some tool).
  if (body.tool_choice === "required") out.tool_choice = { type: "any" };
  else if (body.tool_choice === "auto") out.tool_choice = { type: "auto" };
  return out;
}

function safeParse(s) {
  if (s === undefined || s === null || s === "") return {};
  if (typeof s === "object") return s;
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// SSE -> responses SSE (shared by both bridges)
// ---------------------------------------------------------------------------

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// The item/event emitter both bridges drive. Extracted so the two wires cannot
// drift on output_index ordering - that ordering was the hard-won part (see the
// openReasoning comment) and duplicating it invited a silent regression in one
// of the two paths.
function createResponsesEmitter({ res, model, stream, onUsage, toolGuard = null }) {
  const respId = "resp_" + Math.random().toString(36).slice(2, 14);
  const created = Math.floor(Date.now() / 1000);
  const base = { id: respId, object: "response", created_at: created, model, status: "in_progress", output: [] };
  // Streaming: write SSE headers up front and emit events as they arrive.
  // Non-streaming: write NOTHING here - `emit` becomes a no-op collector and
  // finish() writes a single JSON body. Writing the SSE header eagerly made a
  // stream:false request come back as text/event-stream.
  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
  }
  const emit = stream ? (ev, d) => sse(res, ev, d) : () => {};
  emit("response.created", { type: "response.created", response: base });
  emit("response.in_progress", { type: "response.in_progress", response: base });

  let seq = 2;
  let msgId = null;
  let msgOpen = false;
  let msgIndex = -1;
  let text = "";
  let reasoning = "";
  let rOpen = false;
  let rIndex = -1;
  const rId = "rs_" + Math.random().toString(36).slice(2, 14);
  const calls = new Map(); // key -> {id,name,args,itemId,added,outIndex}
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  // output_index must be a monotonic per-item counter, NOT output.length: items
  // are only appended to `output` at close/finish, so using output.length gave a
  // message and a function_call the same index, and codex drops such a stream
  // (observed as repeated identical resends). items[] keeps slot order so the
  // final `output` array matches the indices regardless of emit order.
  let nextOutIndex = 0;
  const items = [];
  const openItem = () => {
    const i = nextOutIndex++;
    items[i] = null;
    return i;
  };
  const placeItem = (i, item) => {
    items[i] = item;
  };

  const openMessage = () => {
    if (msgOpen) return;
    msgOpen = true;
    msgId = "msg_" + Math.random().toString(36).slice(2, 14);
    msgIndex = openItem();
    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: msgIndex,
      item: { type: "message", id: msgId, role: "assistant", status: "in_progress", content: [] },
      sequence_number: seq++,
    });
    emit("response.content_part.added", {
      type: "response.content_part.added",
      content_index: 0,
      item_id: msgId,
      output_index: msgIndex,
      part: { type: "output_text", text: "", annotations: [] },
      sequence_number: seq++,
    });
  };

  // Reasoning must claim its output_index BEFORE the message/function_call items,
  // because codex records it as the first item of the turn (a real session shows
  // `reasoning` immediately followed by `function_call`). Opening it lazily in
  // finish() put it after the tool calls, which replays as
  // [function_call, reasoning, output] - the assistant turn then still has no
  // reasoning_content and DeepSeek rejects it with code 11155.
  const openReasoning = () => {
    if (rOpen || !reasoning.trim()) return;
    rOpen = true;
    rIndex = openItem();
    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: rIndex,
      item: { type: "reasoning", id: rId, summary: [] },
      sequence_number: seq++,
    });
  };

  const closeMessage = () => {
    if (!msgOpen) return;
    const item = {
      type: "message",
      id: msgId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    emit("response.content_part.done", {
      type: "response.content_part.done",
      content_index: 0,
      item_id: msgId,
      output_index: msgIndex,
      part: { type: "output_text", text, annotations: [] },
      sequence_number: seq++,
    });
    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: msgIndex,
      item,
      sequence_number: seq++,
    });
    placeItem(msgIndex, item);
    msgOpen = false;
  };

  const finish = () => {
    // Non-streaming request: the client asked for one JSON object, but this
    // bridge consumes the upstream's SSE. Accumulate and emit the completed
    // response as JSON instead of the event stream. Codex always streams, so
    // this only shows up for other clients (curl, SDKs) - verified missing
    // before this fix: stream:false returned text/event-stream.
    if (!stream) {
      closeMessage();
      const out = [];
      for (const c of calls.values()) {
        if (!c.added) continue;
        out.push({ type: "function_call", id: c.itemId, status: "completed", arguments: c.args || "{}", call_id: c.id, name: c.name });
      }
      const items2 = items.filter(Boolean);
      const msg = items2.find((it) => it.type === "message");
      const rItemNs = reasoning.trim()
        ? { type: "reasoning", id: rId, summary: [], content: [{ type: "reasoning_text", text: reasoning }] }
        : null;
      const output = rItemNs
        ? (msg ? [rItemNs, msg, ...out] : [rItemNs, ...out])
        : (msg ? [msg, ...out] : out);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      if (onUsage) try { onUsage(usage); } catch {}
      res.end(JSON.stringify({ ...base, status: "completed", output, usage }));
      return;
    }
    // Close the reasoning item before the message/function_call items so the
    // final `output` array is [reasoning, ...] as codex expects.
    if (rOpen) {
      const rItem = {
        type: "reasoning",
        id: rId,
        summary: [],
        content: [{ type: "reasoning_text", text: reasoning }],
      };
      emit("response.output_item.done", {
        type: "response.output_item.done",
        output_index: rIndex,
        item: rItem,
        sequence_number: seq++,
      });
      placeItem(rIndex, rItem);
    }
    closeMessage();
    for (const c of calls.values()) {
      if (!c.added) continue;
      emit("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        arguments: c.args || "{}",
        item_id: c.itemId,
        output_index: c.outIndex,
        sequence_number: seq++,
      });
      const item = { type: "function_call", id: c.itemId, status: "completed", arguments: c.args || "{}", call_id: c.id, name: c.name };
      emit("response.output_item.done", {
        type: "response.output_item.done",
        output_index: c.outIndex,
        item,
        sequence_number: seq++,
      });
      placeItem(c.outIndex, item);
    }
    if (onUsage) try { onUsage(usage); } catch {}
    emit("response.completed", {
      type: "response.completed",
      response: { ...base, status: "completed", output: items.filter(Boolean), usage },
    });
    res.end();
  };

  const fail = () => {
    try {
      if (!stream) {
        // Non-streaming: a JSON body, never a bare end (which would look like an
        // empty success to the client).
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "upstream stream error", type: "upstream_error" } }));
        return;
      }
      sse(res, "response.failed", { type: "response.failed", response: { ...base, status: "failed" } });
      res.end();
    } catch {}
  };

  return {
    // Reasoning delta: opens the reasoning item on the first non-blank text.
    reasoning(chunk) {
      if (!chunk) return;
      reasoning += chunk;
      openReasoning();
    },
    // Visible-text delta.
    text(chunk) {
      if (!chunk) return;
      openMessage();
      text += chunk;
      emit("response.output_text.delta", {
        type: "response.output_text.delta",
        content_index: 0,
        delta: chunk,
        item_id: msgId,
        output_index: msgIndex,
        sequence_number: seq++,
      });
    },
    // Tool-call delta. `key` groups the pieces of one call (chat: the delta index;
    // anthropic: the content-block index). Name and arguments accumulate because
    // both wires stream them in pieces.
    call(key, { id, name, args }) {
      // A guarded tool (see oc-zen-proxy.mjs) is upstream-only bookkeeping: the
      // caller never declared it, so neither the item nor its deltas may surface.
      if (toolGuard && typeof name === "string" && name && toolGuard(name)) return;
      let c = calls.get(key);
      if (!c) {
        c = {
          id: id || `call_${key}_${Math.random().toString(36).slice(2, 10)}`,
          name: "",
          args: "",
          itemId: "fc_" + Math.random().toString(36).slice(2, 14),
          added: false,
          outIndex: -1,
        };
        calls.set(key, c);
      }
      if (id) c.id = id;
      if (name) c.name += name;
      if (!c.added && c.name) {
        c.added = true;
        c.outIndex = openItem();
        emit("response.output_item.added", {
          type: "response.output_item.added",
          output_index: c.outIndex,
          item: { type: "function_call", id: c.itemId, status: "in_progress", arguments: "", call_id: c.id, name: c.name },
          sequence_number: seq++,
        });
      }
      if (args) {
        c.args += args;
        emit("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          delta: args,
          item_id: c.itemId,
          output_index: c.outIndex,
          sequence_number: seq++,
        });
      }
    },
    setUsage(u) {
      usage = u;
    },
    finish,
    fail,
  };
}

// ---------------------------------------------------------------------------
// chat SSE -> responses SSE
// ---------------------------------------------------------------------------

function bridgeChatStream(upstream, res, model, effort, stream = true, onUsage = null, toolGuard = null) {
  const em = createResponsesEmitter({ res, model, stream, onUsage, toolGuard });
  let buf = "";
  upstream.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      let j;
      try {
        j = JSON.parse(payload);
      } catch {
        continue;
      }
      if (j.usage) {
        const u = {
          input_tokens: j.usage.prompt_tokens ?? 0,
          output_tokens: j.usage.completion_tokens ?? 0,
          total_tokens: j.usage.total_tokens ?? 0,
        };
        // Carry the upstream's reasoning counters through. Without these the
        // responses stream reports no reasoning usage, so callers (and effort
        // comparisons) cannot tell whether the requested level took effect.
        const detail = j.usage.completion_tokens_details;
        if (detail && typeof detail === "object") {
          u.output_tokens_details = { reasoning_tokens: detail.reasoning_tokens ?? 0 };
        }
        if (typeof j.usage.completion_thinking_tokens === "number") {
          u.output_tokens_details = u.output_tokens_details ?? {};
          u.output_tokens_details.reasoning_tokens = j.usage.completion_thinking_tokens;
        }
        em.setUsage(u);
      }
      const d = j.choices?.[0]?.delta;
      if (!d) continue;
      if (d.reasoning_content) em.reasoning(d.reasoning_content);
      if (d.content) em.text(d.content);
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          em.call(tc.index ?? 0, { id: tc.id, name: tc.function?.name, args: tc.function?.arguments });
        }
      }
    }
  });
  upstream.on("end", () => em.finish());
  upstream.on("error", () => em.fail());
}

// ---------------------------------------------------------------------------
// anthropic SSE -> responses SSE
// ---------------------------------------------------------------------------

// Anthropic's stream names its blocks by index and sends the tool id/name in
// content_block_start, so the block index doubles as the emitter's call key.
// Thinking blocks map to the responses `reasoning` item; text and tool_use map
// to the message and function_call items.
function bridgeAnthropicStream(upstream, res, model, stream = true, onUsage = null, toolGuard = null) {
  const em = createResponsesEmitter({ res, model, stream, onUsage, toolGuard });
  let buf = "";
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  const applyUsage = () => {
    em.setUsage({
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      ...(cachedTokens ? { input_tokens_details: { cached_tokens: cachedTokens } } : {}),
    });
  };
  upstream.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      let j;
      try {
        j = JSON.parse(payload);
      } catch {
        continue;
      }
      switch (j.type) {
        case "message_start": {
          const u = j.message?.usage ?? {};
          inputTokens = u.input_tokens ?? 0;
          cachedTokens = (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          applyUsage();
          break;
        }
        case "content_block_delta": {
          const d = j.delta ?? {};
          if (d.type === "thinking_delta") em.reasoning(d.thinking ?? "");
          else if (d.type === "text_delta") em.text(d.text ?? "");
          else if (d.type === "input_json_delta") em.call(j.index ?? 0, { args: d.partial_json ?? "" });
          // signature_delta carries the thinking signature, which has no
          // responses-side representation - dropping it is intentional.
          break;
        }
        case "content_block_start": {
          const b = j.content_block ?? {};
          // Only tool_use needs the start event: it carries the id/name that the
          // later input_json_delta fragments do not repeat.
          if (b.type === "tool_use") em.call(j.index ?? 0, { id: b.id, name: b.name });
          break;
        }
        case "message_delta": {
          outputTokens = j.usage?.output_tokens ?? outputTokens;
          applyUsage();
          break;
        }
        case "error": {
          const msg = j.error?.message ?? "anthropic stream error";
          process.stdout.write(`[anthropic-bridge] upstream error event: ${msg}\n`);
          break;
        }
        default:
          break;
      }
    }
  });
  upstream.on("end", () => em.finish());
  upstream.on("error", () => em.fail());
}

export {
  bridgeAnthropicStream,
  bridgeChatStream,
  createResponsesEmitter,
  toAnthropicBody,
  toChatBody,
  toChatMessages,
  toChatTools,
};

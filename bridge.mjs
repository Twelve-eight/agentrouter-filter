// responses <-> chat/completions translation, and the chat SSE -> responses
// SSE bridge. Side-effect free: this module binds no port and holds no global
// state, so tests can import it without starting a gateway (see
// tools/test-bridge-indices.mjs).
//
// The bridge is needed because Codex 0.154 accepts only wire_api = "responses",
// while some upstreams (wb2api) expose only chat/completions.

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
  for (const it of items) {
    if (typeof it === "string") {
      tail.push({ role: "user", content: it });
      continue;
    }
    if (it.type === "reasoning") continue;
    if (it.type === "function_call") {
      tail.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: it.call_id ?? it.id,
            type: "function",
            function: { name: it.name, arguments: it.arguments ?? "{}" },
          },
        ],
      });
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
    else tail.push({ role, content: text });
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

function toChatBody(body, model) {
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
    chat.reasoning_effort = effort === "ultra" || effort === "persistent" ? "max" : effort;
  }
  return chat;
}

// ---------------------------------------------------------------------------
// chat SSE -> responses SSE
// ---------------------------------------------------------------------------

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function bridgeChatStream(upstream, res, model, effort) {
  const respId = "resp_" + Math.random().toString(36).slice(2, 14);
  const created = Math.floor(Date.now() / 1000);
  const base = { id: respId, object: "response", created_at: created, model, status: "in_progress", output: [] };
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  sse(res, "response.created", { type: "response.created", response: base });
  sse(res, "response.in_progress", { type: "response.in_progress", response: base });

  let buf = "";
  let seq = 2;
  let msgId = null;
  let msgOpen = false;
  let msgIndex = -1;
  let text = "";
  let reasoning = "";
  const calls = new Map(); // index -> {id,name,args,itemId,added,outIndex}
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
    sse(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: msgIndex,
      item: { type: "message", id: msgId, role: "assistant", status: "in_progress", content: [] },
      sequence_number: seq++,
    });
    sse(res, "response.content_part.added", {
      type: "response.content_part.added",
      content_index: 0,
      item_id: msgId,
      output_index: msgIndex,
      part: { type: "output_text", text: "", annotations: [] },
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
    sse(res, "response.content_part.done", {
      type: "response.content_part.done",
      content_index: 0,
      item_id: msgId,
      output_index: msgIndex,
      part: { type: "output_text", text, annotations: [] },
      sequence_number: seq++,
    });
    sse(res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: msgIndex,
      item,
      sequence_number: seq++,
    });
    placeItem(msgIndex, item);
    msgOpen = false;
  };

  const openCall = (idx, delta) => {
    let c = calls.get(idx);
    if (!c) {
      c = { id: delta.id || `call_${idx}_${Math.random().toString(36).slice(2, 10)}`, name: "", args: "", itemId: "fc_" + Math.random().toString(36).slice(2, 14), added: false, outIndex: -1 };
      calls.set(idx, c);
    }
    if (delta.id) c.id = delta.id;
    if (delta.function?.name) c.name += delta.function.name;
    if (!c.added && c.name) {
      c.added = true;
      c.outIndex = openItem();
      sse(res, "response.output_item.added", {
        type: "response.output_item.added",
        output_index: c.outIndex,
        item: { type: "function_call", id: c.itemId, status: "in_progress", arguments: "", call_id: c.id, name: c.name },
        sequence_number: seq++,
      });
    }
    const chunk = delta.function?.arguments;
    if (chunk) {
      c.args += chunk;
      sse(res, "response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        delta: chunk,
        item_id: c.itemId,
        output_index: c.outIndex,
        sequence_number: seq++,
      });
    }
  };

  const finish = () => {
    closeMessage();
    for (const c of calls.values()) {
      if (!c.added) continue;
      sse(res, "response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        arguments: c.args || "{}",
        item_id: c.itemId,
        output_index: c.outIndex,
        sequence_number: seq++,
      });
      const item = { type: "function_call", id: c.itemId, status: "completed", arguments: c.args || "{}", call_id: c.id, name: c.name };
      sse(res, "response.output_item.done", {
        type: "response.output_item.done",
        output_index: c.outIndex,
        item,
        sequence_number: seq++,
      });
      placeItem(c.outIndex, item);
    }
    sse(res, "response.completed", {
      type: "response.completed",
      response: { ...base, status: "completed", output: items.filter(Boolean), usage },
    });
    res.end();
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
      if (j.usage) {
        usage = {
          input_tokens: j.usage.prompt_tokens ?? 0,
          output_tokens: j.usage.completion_tokens ?? 0,
          total_tokens: j.usage.total_tokens ?? 0,
        };
        // Carry the upstream's reasoning counters through. Without these the
        // responses stream reports no reasoning usage, so callers (and effort
        // comparisons) cannot tell whether the requested level took effect.
        const detail = j.usage.completion_tokens_details;
        if (detail && typeof detail === "object") {
          usage.output_tokens_details = { reasoning_tokens: detail.reasoning_tokens ?? 0 };
        }
        if (typeof j.usage.completion_thinking_tokens === "number") {
          usage.output_tokens_details = usage.output_tokens_details ?? {};
          usage.output_tokens_details.reasoning_tokens = j.usage.completion_thinking_tokens;
        }
      }
      const d = j.choices?.[0]?.delta;
      if (!d) continue;
      if (d.reasoning_content) reasoning += d.reasoning_content;
      if (d.content) {
        openMessage();
        text += d.content;
        sse(res, "response.output_text.delta", {
          type: "response.output_text.delta",
          content_index: 0,
          delta: d.content,
          item_id: msgId,
          output_index: msgIndex,
          sequence_number: seq++,
        });
      }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) openCall(tc.index ?? 0, tc);
      }
    }
  });
  upstream.on("end", finish);
  upstream.on("error", () => {
    try {
      sse(res, "response.failed", { type: "response.failed", response: { ...base, status: "failed" } });
      res.end();
    } catch {}
  });
}
export { bridgeChatStream, toChatBody, toChatMessages, toChatTools };

// Shell-carrier ("借壳") support for the justwoker/jw upstream.
//
// WHY THIS EXISTS
// ---------------
// Measured 2026-10-07 against https://api.justwoker.icu/v1/messages, model
// claude-opus-4-8 (jw): the endpoint REPLACES the caller's tool list instead of
// using it. Only four names survive - bash / grep / glob / apply_patch (the
// Claude Code CLI's names) - and it injects two of its own (read_tabular,
// system_todo_write). A zero-tool request still answers "my tools are
// read_tabular and system_todo_write", which is the decisive proof: the model
// never sees exec_command / spawn_agent / any Codex tool, thinks, and ends the
// turn with nothing. Codex renders that as an empty sub-agent.
//
// Two further measurements shape the design:
//   * its `bash` is CLIENT-SIDE. The call comes back to us and the model accepts
//     whatever result string we return (verified with a marker string).
//   * its streaming path emits NO content blocks at all (message_start ->
//     message_delta -> message_stop, output_tokens > 0, zero content). The same
//     request works on `stream:false`.
//
// So the gateway carries every real tool call through `bash`: the model is told
// to emit  `@tool:<name> <json>`  and the gateway unwraps that back into a real
// function_call for Codex. Full loop verified against the live upstream
// (2026-10-07): the model called `@tool:exec_command`, we returned a result, and
// it summarised correctly on the next turn.
//
// This module is pure (no sockets, no globals) so it can be unit-tested.

// The one tool name the upstream actually honours. If it ever starts honouring
// more, this is the knob to widen - but the code below rewrites EVERY call to it,
// so widening means teaching decodeCarrierCall several shapes first.
export const CARRIER_TOOL = "bash";

// Fallback shell tool for a command that carries no `@tool:` prefix. The real
// name comes from the caller's own tool list (see applyShellCarrier); this is
// only used when that list has no recognisable shell tool.
const SHELL_TOOL_FALLBACK = "exec_command";
const SHELL_TOOL_CANDIDATES = ["exec_command", "shell", "local_shell", "run_command"];

/** Compact one-line schema summary for the description (`{"cmd": string}`). */
function summariseSchema(schema) {
  const props = schema?.properties;
  if (!props || typeof props !== "object") return "{}";
  const parts = [];
  for (const [key, raw] of Object.entries(props)) {
    const type = typeof raw?.type === "string" ? raw.type : (raw?.anyOf ? "any" : "value");
    parts.push(`${key}: ${type}`);
  }
  return `{${parts.join(", ")}}`;
}

/**
 * The single tool the upstream will accept, with the protocol in its
 * description. `tools` are the caller's real tools (already flattened by
 * toAnthropicBody), each `{name, description, input_schema}`.
 */
export function buildCarrierTool(tools, { maxTools = 80, maxLineChars = 180 } = {}) {
  const lines = [];
  for (const t of tools) {
    if (!t || !t.name) continue;
    if (t.name === CARRIER_TOOL) continue; // never advertise the carrier itself
    const desc = String(t.description ?? "").replace(/\s+/g, " ").trim();
    const head = desc.split(/(?<=\.)\s/)[0] ?? "";
    const line = `- ${t.name} ${summariseSchema(t.input_schema)}` + (head ? ` -- ${head}` : "");
    lines.push(line.length > maxLineChars ? line.slice(0, maxLineChars - 3) + "..." : line);
    if (lines.length >= maxTools) break;
  }
  const description = [
    "Run a command on the user's Windows workstation. This is the only tool you have;",
    "every other capability is reached through it, and its output is returned to you",
    "as this tool's result.",
    "",
    "TO CALL A TOOL: set the command argument to exactly",
    "    @tool:<name> <json-arguments>",
    'for example  @tool:exec_command {"cmd": "dir"}',
    "Use one of the tool names listed at the end of this description.",
    "",
    "A command WITHOUT the @tool: prefix is executed as a plain shell command and",
    "its stdout/stderr come back as the result.",
    "",
    "Available tools:",
    ...(lines.length ? lines : ["- exec_command {cmd: string} -- run a shell command"]),
  ].join("\n");
  return {
    name: CARRIER_TOOL,
    description,
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Either @tool:<name> <json> or a plain shell command." },
      },
      required: ["command"],
    },
  };
}

/** `@tool:exec_command {"cmd":"dir"}` - the payload the model was taught to emit. */
export function encodeCarrierCall(name, argsString) {
  let payload = argsString;
  if (payload === undefined || payload === null || payload === "") payload = "{}";
  if (typeof payload !== "string") {
    try { payload = JSON.stringify(payload); } catch { payload = "{}"; }
  }
  // One line: the model is told the arguments are JSON and the whole call rides
  // in a single `command` string. Newlines inside a pretty-printed JSON would be
  // legal but harder for the model to reproduce, so flatten them.
  payload = payload.replace(/\s*\n\s*/g, " ").trim();
  return `@tool:${name} ${payload}`;
}

/**
 * Inverse of encodeCarrierCall. Returns `{name, args, raw}` when the command
 * carries the protocol, or `null` when it is a plain shell command.
 * A malformed JSON body still yields the name (with `args: null`) so the caller
 * can report it instead of silently running it as a shell command.
 */
export function decodeCarrierCall(command) {
  if (typeof command !== "string") return null;
  const m = /^\s*@tool:([A-Za-z0-9_.:-]+)\s*([\s\S]*)$/.exec(command);
  if (!m) return null;
  const name = m[1];
  const raw = (m[2] ?? "").trim();
  if (!raw) return { name, args: {}, raw };
  try {
    const args = JSON.parse(raw);
    if (args === null || typeof args !== "object") return { name, args: null, raw };
    return { name, args, raw };
  } catch {
    return { name, args: null, raw };
  }
}

/**
 * Return path: the upstream answers with ONE tool name (`bash`) whose
 * `command` carries  @tool:<name> <json>.  Rewrite that into the real
 * function_call's {name, args}. A plain shell command (no @tool: prefix)
 * becomes `shellTool` with {cmd}. Returns null for anything that is not a
 * carrier call, so callers can treat it as a no-op on other routes.
 */
export function unwrapCarrierCall(name, argsString, shellTool = SHELL_TOOL_FALLBACK) {
  if (name !== CARRIER_TOOL) return null;
  let command;
  try {
    command = JSON.parse(argsString || '{}')?.command;
  } catch {
    return null;
  }
  if (typeof command !== 'string') return null;
  const decoded = decodeCarrierCall(command);
  if (!decoded) return { name: shellTool, args: JSON.stringify({ cmd: command }) };
  if (decoded.args === null) {
    // Malformed JSON: never guess. Hand Codex a call it rejects with a readable
    // message, so the model learns its protocol line was invalid and can retry
    // instead of losing the turn to a silent no-op.
    return { name: decoded.name, args: JSON.stringify({ error: 'invalid @tool JSON payload', raw: decoded.raw }) };
  }
  return { name: decoded.name, args: JSON.stringify(decoded.args) };
}
/** The caller's shell tool name, or the documented fallback. */
export function shellToolName(tools) {
  const names = new Set((Array.isArray(tools) ? tools : []).map((t) => t?.name).filter(Boolean));
  for (const c of SHELL_TOOL_CANDIDATES) if (names.has(c)) return c;
  return SHELL_TOOL_FALLBACK;
}

/**
 * Rewrite an anthropic body built by toAnthropicBody so the upstream can use it.
 *
 *   * tools        -> the single carrier tool
 *   * tool_use     -> a carrier call whose input.command holds the @tool: payload
 *   * tool_result  -> untouched (the upstream pairs it by tool_use_id, which we
 *                     preserve end to end: the id we emit to Codex is the
 *                     upstream's own tool_use id, so its replay comes back with
 *                     the same call_id and needs no map)
 *
 * Returns a receipt describing what was taught, for the return path.
 */
export function applyShellCarrier(msg) {
  const originalTools = Array.isArray(msg.tools) ? msg.tools : [];
  const known = new Set(originalTools.map((t) => t?.name).filter(Boolean));
  const shellTool = shellToolName(originalTools);
  const carrierTool = buildCarrierTool(originalTools);

  for (const m of Array.isArray(msg.messages) ? msg.messages : []) {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block?.type !== "tool_use") continue;
      // Already a carrier call (a replayed turn from before this switch, or a
      // plain shell call): leave it alone rather than double-encoding.
      if (block.name === CARRIER_TOOL) continue;
      block.input = { command: encodeCarrierCall(block.name, JSON.stringify(block.input ?? {})) };
      block.name = CARRIER_TOOL;
    }
  }

  msg.tools = [carrierTool];
  // The upstream's streaming path produces no content blocks, so the gateway
  // always asks for the non-streaming form and re-emits the stream itself.
  msg.stream = false;
  return { known, shellTool, rawToolNames: [...known] };
}

// 验收：chat/anthropic 桥接层正确展开命名空间工具，并把回程调用还原为 name + namespace
// 用法: node repro-namespace-tools.mjs
//
// 2026-09-22 前：子工具全部丢失，上游只看到一个空 schema 的 multi_agent_v1，
// 于是所有 chat/anthropic 线路模型都无法使用 Codex 原生子代理设施。
import assert from "node:assert";
import { toChatTools, toAnthropicBody, toChatBody, toChatMessages } from "../bridge.mjs";

const nsTool = {
  type: "namespace",
  name: "multi_agent_v1",
  description: "Tools for spawning and managing sub-agents.",
  tools: [
    { type: "function", name: "spawn_agent", description: "Spawn a new agent",
      parameters: { type: "object", properties: { model: { type: "string" }, message: { type: "string" } }, required: ["message"] } },
    { type: "function", name: "wait_agent", description: "Wait for agents",
      parameters: { type: "object", properties: { targets: { type: "array" } } } },
    { type: "function", name: "close_agent", description: "Close an agent",
      parameters: { type: "object", properties: { target: { type: "string" } } } },
  ],
};
const flatTool = { type: "function", name: "exec_command", description: "Run a command",
  parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } };

console.log("=========== toChatTools ===========");
const chatOut = toChatTools([nsTool, flatTool]);
const chatNames = chatOut.map((t) => t.function.name);
console.log("输入工具数        : 2 (1 个命名空间含 3 个子工具 + 1 个普通工具)");
console.log("输出工具数        :", chatOut.length);
console.log("输出工具名        :", chatNames.join(", "));
assert.deepStrictEqual(chatNames, [
  "multi_agent_v1__spawn_agent",
  "multi_agent_v1__wait_agent",
  "multi_agent_v1__close_agent",
  "exec_command",
], "命名空间必须展开为 <namespace>__<subtool>");
const spawn = chatOut.find((t) => t.function.name === "multi_agent_v1__spawn_agent");
assert.deepStrictEqual(spawn.function.parameters.required, ["message"], "子工具 schema 必须完整保留");
console.log("子工具 schema     :", JSON.stringify(spawn.function.parameters));
assert.ok(!chatNames.includes("multi_agent_v1"), "空壳的命名空间条目必须消失");

console.log("");
console.log("=========== toAnthropicBody ===========");
const anthOut = toAnthropicBody({ model: "m", instructions: "i", input: [], tools: [nsTool, flatTool] }, "m");
const anthNames = anthOut.tools.map((t) => t.name);
console.log("输出工具名        :", anthNames.join(", "));
assert.deepStrictEqual(anthNames, chatNames, "anthropic 线路必须展开成同一组名字");
assert.deepStrictEqual(anthOut.tools[0].input_schema.required, ["message"], "anthropic schema 必须完整");

console.log("");
console.log("=========== 往返：name + namespace <-> 扁平线名 ===========");
const toolMap = { byWire: new Map(), byPair: new Map() };
const body = {
  model: "m",
  instructions: "i",
  tools: [nsTool],
  input: [{ type: "function_call", call_id: "c1", name: "spawn_agent", namespace: "multi_agent_v1", arguments: "{\"message\":\"hi\"}" }],
};
const chat = toChatBody(body, "m", null, toolMap);
const sent = chat.messages.at(-1).tool_calls[0].function.name;
console.log("回放给上游的工具名:", sent);
assert.strictEqual(sent, "multi_agent_v1__spawn_agent", "回放必须用上游学到的扁平名");
const back = toolMap.byWire.get(sent);
console.log("上游调回时还原为  :", JSON.stringify(back));
assert.deepStrictEqual(back, { namespace: "multi_agent_v1", name: "spawn_agent" });
assert.strictEqual(toChatMessages({ input: [{ type: "function_call", call_id: "c", name: "resume_agent", namespace: "multi_agent_v1" }] }).at(-1).tool_calls[0].function.name,
  "multi_agent_v1__resume_agent", "本请求未声明的子工具也要按约定还原");

console.log("");
console.log("全部断言通过：命名空间工具已展开，schema 完整，往返一致，扁平工具不受影响。");

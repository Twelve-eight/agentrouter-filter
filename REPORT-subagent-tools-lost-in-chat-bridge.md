# 缺陷报告：chat/anthropic 桥接层丢失命名空间工具，导致子代理工具不可用

- 报告时间：2026-09-22
- 报告来源：`G:\agentworks` 会话（用户目标为整理高考数学学习方案，因无法使用原生子代理而定位到本缺陷）
- 受影响项目：`G:\omp works\Tools\agentrouter-filter`
- 受影响文件：`bridge.mjs`
- 严重级别：高（走 chat / anthropic 线路的**全部**模型无法使用 Codex 原生子代理设施）
- 当前状态：根因已定位并有可复现证据；**尚未修复**

---

## 一、现象

在 Codex Desktop 会话中，当会话模型走 wb2api（chat/completions）线路时：

- 工具面里**存在** `multi_agent_v1`，但其参数 schema 是空的 `{"type":"object","properties":{}}`；
- 调用 `multi_agent_v1` 一律返回 `unsupported call`；
- `spawn_agent` / `wait_agent` / `close_agent` / `send_input` 等子工具**完全不可见**，模型无法派发子代理。

对照：同一个 Codex Desktop，当会话模型走 agentrouter（responses）线路时，工具面里出现的是扁平的 `collaboration.spawn_agent` / `collaboration.wait_agent` 等，可正常派发。

---

## 二、根因

Codex 0.155 把多智能体工具作为**命名空间工具**下发给模型，形态为：

```json
{
  "type": "namespace",
  "name": "multi_agent_v1",
  "description": "Tools for spawning and managing sub-agents.",
  "tools": [
    { "type": "function", "name": "spawn_agent", "description": "...", "inputSchema": {...} },
    { "type": "function", "name": "wait_agent",  "description": "...", "inputSchema": {...} }
  ]
}
```

而 `bridge.mjs` 的两处工具转换**只处理扁平 function 工具，且从不读取子数组 `tools`**：

### 缺陷点 1：`toChatTools()`，`bridge.mjs` 第 116–129 行

```js
function toChatTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const mapped = tools
    .filter((t) => t && (t.type === "function" || t.name))
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.parameters ?? { type: "object", properties: {} },   // ← 命名空间工具没有 t.parameters
      },
    }));
  return mapped.length ? mapped : undefined;
}
```

命名空间工具满足 `t.name` 因而**通过过滤**，但：

- `t.tools`（子工具数组）从未被读取 → 子工具全部丢失；
- `t.parameters` 不存在 → 回落到空对象 → schema 塌成 `{}`。

结果：上游只看到一个名叫 `multi_agent_v1`、无任何参数的空壳工具。

### 缺陷点 2：`toAnthropicBody()`，`bridge.mjs` 第 246–253 行

```js
const tools = (body.tools ?? [])
  .filter((t) => t && (t.type === "function" || t.name))
  .map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.parameters ?? { type: "object", properties: {} },   // ← 同一缺陷
  }));
```

同样只读 `t.name` / `t.parameters`，同样丢失 `t.tools`。因此走 anthropic 线路（justwoker）的模型也受影响。

> 全文检索确认：`bridge.mjs` 中**没有任何一处**出现 `namespace` 字符串，即桥接层从未处理过命名空间工具。

---

## 三、证据

### 证据 1（决定性）：单元级复刻

直接 import 桥接函数，喂入 Codex 真实发出的工具形态：

```powershell
node G:\agentworks\.tmp\t-final.mjs
```

脚本内容（可重建）：

```js
import { toChatTools } from 'file:///G:/omp%20works/Tools/agentrouter-filter/bridge.mjs';
const real = [
  { type:'function', name:'exec_command', parameters:{type:'object',properties:{cmd:{type:'string'}}} },
  { type:'namespace', name:'multi_agent_v1', description:'Tools for spawning and managing sub-agents.',
    tools:[
      {type:'function',name:'spawn_agent',parameters:{type:'object',properties:{model:{type:'string'},message:{type:'string'}}}},
      {type:'function',name:'wait_agent',parameters:{type:'object',properties:{targets:{type:'array'}}}},
      {type:'function',name:'close_agent',parameters:{type:'object',properties:{target:{type:'string'}}}},
    ]},
];
console.log(JSON.stringify(toChatTools(real), null, 2));
```

实测输出：

```
Codex 发出工具数 : 2
转发给上游工具数 : 2
丢失的子工具数   : 3

上游实际看到的 multi_agent_v1 定义：
{
  "type": "function",
  "function": {
    "name": "multi_agent_v1",
    "description": "Tools for spawning and managing sub-agents.",
    "parameters": { "type": "object", "properties": {} }
  }
}
```

对照组（扁平 function 工具）参数完好保留：

```
扁平工具参数完好 = {"type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"]}
```

### 证据 2：会话级相关性（全量对照）

遍历 `C:\Users\o_Obl\.codex\sessions\2026\09\22\*.jsonl`，按「模型 → provider wire 类型」与「该会话中 `spawn_agent` 调用次数」交叉统计：

| 模型 | wire | 会话数 | spawn_agent 调用数 |
|---|---|---|---|
| cn:deepseek-v4-flash | chat | 2 | 0 |
| cn:deepseek-v4-pro | chat | 12 | 0 |
| cn:deepseek-v4.1-flash | chat | 16 | 0 |
| cn:glm-5.3 | chat | 3 | 0 |
| cn:kimi-k3-1 | chat | 3 | 0 |
| cn:minimax-m3 | chat | 3 | 0 |
| global:deepseek-v4.1-flash | chat | 27 | 0 |
| zen:mimo-v2.6-flash | chat | 4 | 0 |
| deepseek-v4-flash | responses | 1 | 0 |
| gpt-5.6-luna | responses | 2 | 0 |
| gpt-6-astra | responses | 1 | 0 |
| **gpt-6-astra-an** | **responses** | 4 | **2** |
| **gpt-6-astra-ar** | **responses** | 14 | **5** |

结论：**所有 chat 线路模型（共 70 个会话）子代理调用数均为 0；唯一成功的全部来自 responses 线路。** 相关性完全吻合根因。

> 说明：`gpt-5.6-luna` / `gpt-6-astra` 虽为 responses 线路但调用数为 0，是因为样本会话未涉及子代理任务，不代表线路有问题。

### 证据 3：本会话的直接观测

本会话模型为 `global:deepseek-v4.1-flash`（wb2api / chat wire）。会话内 `multi_agent_v1` 三次调用全部返回 `unsupported call`；工具清单显示其 schema 为空。

---

## 四、影响范围

- **受影响**：所有 `wire = "chat"` 的 provider（wb2api、opencode-zen）与所有 `wire = "anthropic"` 的 provider（justwoker）下的模型 —— 即 `bridge.mjs` 两条转换路径覆盖的全部模型。
- **不受影响**：`wire = "responses"` 的 provider（agentrouter、relaycat、relaycat-cn、anyrouter），它们不经桥接，工具原样透传。
- 直接后果：这些模型在 Codex 中**无法使用原生子代理设施**。按工作区 `AGENTS.md` Sec 4b，此时应停止并报告限制，而不得绕道其它代理运行时（例如用 `codex exec` 起子进程充当"子代理"——那不是原生设施）。

---

## 五、修复要求

### 5.1 必须解决的三段式往返

这不是单点修改，需要保证**工具声明 → 上游调用 → 回程还原**三段一致：

1. **出程（工具声明）**：把命名空间工具的子工具**展开为扁平 function 工具**，名字需带命名空间前缀以避免与其它工具重名，例如 `multi_agent_v1__spawn_agent`。
2. **入程（历史回放）**：`toChatMessages()` 第 48–68 行把 `function_call` 项转成上游 `tool_calls` 时，只取了 `it.name`。若 Codex 回放的项带 `namespace` 字段（见下），必须重新拼成前缀名，否则上游会收到一个它没见过的工具名。
3. **回程（上游调用 → responses item）**：`createResponsesEmitter` 的 `call()`（第 504–530 行）与 `finish()`（第 407 行）只输出 `name: c.name`。必须把前缀名**拆回** `name` + `namespace` 两个字段，否则 Codex 认不出这是 `multi_agent_v1` 的子工具。

### 5.2 关于回程 namespace 字段的依据

Codex 的 app-server 协议 schema 中，`function_call` 项与 `TurnToolOutput` 都带可选的 `namespace` 字段：

- `G:\agentworks\.tmp\schema\codex_app_server_protocol.schemas.json` 第 21634 行附近：`function_call` 项的 `namespace`（`["string","null"]`）
- 同文件第 21737 行附近：`TurnToolOutput.namespace`

实盘佐证：`gpt-6-astra-ar` 会话（成功派发过子代理）的记录中，调用项形态为

```json
{"type":"function_call","id":"c755a84f-...","name":"spawn_agent","namespace":"multi_agent_v1", ...}
```

### 5.3 未知项（实现前需抓包确认，勿凭推理下结论）

- **子工具的 schema 字段名到底是 `parameters` 还是 `inputSchema`**。app-server 协议 schema 里 `DynamicToolNamespaceTool` 用的是 `inputSchema`（camelCase）；但那是 client→server 的协议层，**不等于** model-facing 的 responses 线上形态。桥接层看到的是后者。请抓一次真实请求体确认，两种字段名都做兼容是最稳妥的。
- **前缀分隔符的选择**：需确认上游（DeepSeek 等）对工具名允许的字符集。`__` 是常见安全选择，但请以实测为准。
- **是否需要同步修改 `toChatMessages` 的入程**：取决于 Codex 回放历史时是否携带 `namespace`（第 5.2 节的实盘记录是**会话存储**形态，回放形态需抓包确认）。

### 5.4 建议一并处理

- `toAnthropicBody()` 有**完全相同**的缺陷（第 246–253 行），修复时请一并覆盖，否则 justwoker 线路仍不可用。
- 两条路径的工具转换逻辑高度重复，可考虑抽出共享的展开/还原函数，避免今后再次分叉。

---

## 六、验收要求

1. **单元级**：为 `toChatTools()` 与 `toAnthropicBody()` 补测试，输入含命名空间工具的数组，断言子工具数量与参数 schema 均完整保留。现有 `tools/test-bridge-request.mjs` 第 254 行附近已有 anthropic tools 的测试，可参照扩展。
2. **往返级**：补测试覆盖"展开 → 上游返回带前缀的 tool_call → 还原为 name + namespace"的完整链路。
3. **端到端（必须实机验证，不能只靠绿测）**：在 Codex Desktop 中选一个 chat 线路模型（例如 `global:deepseek-v4.1-flash`），确认：
   - 工具面出现可调用的子代理工具（不再是空 schema 的 `multi_agent_v1`）；
   - 实际派发一次子代理并拿到结果；
   - 子代理线程出现在 app 侧栏 / `codex agents` 列表中。
4. **回归**：确认扁平工具（`exec_command` 等）的转换结果与修复前**逐字节一致**，避免改动波及既有行为。

---

## 七、附：环境事实

- Codex CLI：`0.155.0-alpha.9.2`
- 功能开关：`multi_agent` = `stable` / `true`；`multi_agent_v2` = `stable` / `false`
- 全局配置 `~/.codex/config.toml` 中**没有** `[agents]` 段（即 `agents.enabled` 取默认值 `true`），故多智能体工具**本应可用**
- 网关 provider wire 类型（`providers.json`）：agentrouter / relaycat / relaycat-cn / anyrouter = responses；wb2api / opencode-zen = chat；justwoker = anthropic

---

## 八、复现脚本清单

| 脚本 | 用途 |
|---|---|
| `G:\omp works\Tools\agentrouter-filter\tools\repro-namespace-tools.mjs` | **正式复现脚本**（已入库到项目 tools/ 目录）：同时覆盖 `toChatTools` 与 `toAnthropicBody` 两条路径 |

复现命令：

```powershell
node "G:\omp works\Tools\agentrouter-filter\tools\repro-namespace-tools.mjs"
```

实测输出（2026-09-22）：

```
=========== toChatTools ===========
输入工具数        : 2 (1 个命名空间含 3 个子工具 + 1 个普通工具)
输出工具数        : 2
输出工具名        : multi_agent_v1, exec_command
子工具是否保留    : NO  <-- 缺陷
multi_agent_v1 参数: {"type":"object","properties":{}} <-- 应为各子工具的 schema
对照-扁平工具参数  : {"type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"]}

=========== toAnthropicBody ===========
输出工具名        : multi_agent_v1, exec_command
子工具是否保留    : NO  <-- 同一缺陷
multi_agent_v1 schema: {"type":"object","properties":{}}
```


---

## 修复记录(2026-09-22,主会话)

状态:**已修复并实机验证**。原始缺陷描述保留在上面,本节记录结论与验收证据。

### 根因确认
报告的三段式分析与实际一致,另外用**抓到的真实请求体**补齐了报告 5.3 的三个未知项:

| 报告中的未知项 | 实测结论 |
|---|---|
| 子工具 schema 字段名是 `parameters` 还是 `inputSchema` | **`parameters`**(model-facing responses 形态)。抓包体里 `multi_agent_v1` 的 5 个子工具全部用 `parameters`;`inputSchema` 是 app-server 协议字段。实现里两者都兼容。 |
| 前缀分隔符 | `__` 可用。但**不能靠拆分字符串还原**:命名空间 id 本身就含 `__`(实测有 `mcp__cua_repl` / `mcp__node_repl`),两个命名空间还会各有同名子工具 `js`。所以实现用**映射表**(byWire / byPair),不做分隔符解析。 |
| 是否需要改入程回放 | **需要**。会话存储里的 function_call 带 `namespace`(实盘记录见下),上游只认识扁平名。 |

另外实测发现命名空间工具**不止一个**:除 `multi_agent_v1`(close_agent / resume_agent / send_input / spawn_agent / wait_agent)外,还有 `mcp__cua_repl`(2 个子工具)与 `mcp__node_repl`(3 个子工具)——报告只提到 multi_agent_v1,修复覆盖全部。

### 实现(`bridge.mjs`,共享同一套展开/还原逻辑)
1. `flattenTools()`:命名空间 -> 扁平 `<ns>__<subtool>`,子工具 schema 原样保留(`parameters` ?? `inputSchema`),嵌套命名空间继续递归;同时产出 `byWire`(线名 -> {namespace,name})与 `byPair`(namespace+name -> 线名)两张表。
2. 出程:`toChatTools` / `toAnthropicBody` 都用它展开;扁平工具走原映射路径不变。
3. 入程:`toChatMessages` / `toAnthropicBody` 回放 function_call 时用 `joinWireName(name, namespace)` 还原成上游学过的扁平名(表里查不到就按 `ns__name` 约定兜底)。
4. 回程:`createResponsesEmitter` 的 function_call item 改用 `splitWireName()`,输出 `{name, namespace}`;扁平工具保持 `namespace: null`。
5. 为了让拆分精确,function_call 的 `output_item.added` 从"名字首个 delta 到达时"**推迟到 finish()**(名字可能仍在流式拼接);`output_index` 的单调性不受影响(索引在 finish 时按调用顺序分配,与 reasoning/message 的相对顺序不变)。

### 验收证据
- **单元/往返**:`node tools/test-bridge-request.mjs` -> **32 checks passed**(新增 8 条命名空间断言:展开数量与 schema、两个命名空间同名子工具不冲突、`inputSchema` 兼容、扁平工具逐字节无回归、回放还原、约定兜底、anthropic 两条路径、回程 name+namespace 与扁平工具 namespace=null)。
- **复现脚本**:`node tools/repro-namespace-tools.mjs` -> 全部断言通过(该脚本已从"打印缺陷"改写为"断言修复后形态",作为回归脚本保留)。
- **实机端到端**(必须项,已做):
  `codex exec -c model_provider=gateway -c model=global:deepseek-v4.1-flash "Use the sub-agent tool to spawn exactly one sub-agent ... report its answer"` -> **exit 0**,输出 `SUBOK`;
  主会话记录里出现
  `{"type":"function_call","name":"spawn_agent","namespace":"multi_agent_v1",...}` 与
  `{"type":"function_call","name":"wait_agent","namespace":"multi_agent_v1",...}`,
  子代理线程 `01a0c778-7c3e-7013-be4e-777763c1a9b0` 出现在 sessions 目录。
- **回归**:`node tools/test-bridge-indices.mjs` -> PASS;`restart-gateway.ps1` 全模块语法门 + 自检通过(35 models)。

### 未验证 / 限制
- anthropic 线路(justwoker)只做了单元与往返验证,**未**做真实上游端到端(该 provider 需要 justwoker 凭证与可用模型);chat 线路已实机验证。
- `splitWireName` 依赖本请求的工具表;若上游把一个**未声明**的工具名(既不在表里也不是已知命名空间)调回来,则按扁平名透传(`namespace: null`),不猜命名空间——这是有意选择,避免编造归属。

# DESIGN: jw `@tool:` 透传协议（shell 壳 + 网关解包）

日期: 2026-10-07
状态: **设计已实测验证**，待用户批准后实现
前置阅读: DEVLOG 2026-10-07 (3)(4)(5) —— jw 上游已被换成 Snowflake 数据 agent

---

## 1. 问题

`claude-opus-4-8`（jw）的工具表被上游**按名字选择性过滤**：只有
`bash` / `grep` / `glob` / `apply_patch` 能过，Codex 的 `exec_command` / `spawn_agent`
等全部被丢弃 → 该模型当不了主模型/子代理。

用户提出：**借这四个合法工具的壳，把真实调用编码进 `bash` 的参数，由网关解包执行。**

---

## 2. 实测事实（全部亲测，决定方案形状）

| # | 事实 | 证据 |
|---|---|---|
| F1 | **`bash` 是客户端执行的** | 我们回假结果 `FAKE_RESULT_ABC_999`，模型照单全收并复述 —— 上游不自己跑 shell |
| F2 | 上游对 `bash` **用自己的 schema** | 它报告参数为 `command/description/run_in_background/secret_env/timeout_ms/dangerously_disable_sandbox` |
| F3 | `apply_patch` 的描述是**我们+它的拼接** | 尾部有 `# Additional Instructions (when in conflict...)` + 我们塞的 marker |
| F4 | **`@tool:<name> <json>` 协议模型稳定遵守** | 3 次测试全按格式，含非 shell 工具 `spawn_agent` |
| F5 | **路径保真** | `G:\omp works\Tools\...\DEVLOG.md` 原样传递（空格/反斜杠无损） |
| F6 | **完整 agent 循环可跑通** | 轮1 它发 `@tool:exec_command`，我们回结果，轮2 正确汇总 |
| F7 | **网关已有同类机制** | `server.mjs:165` 的 `TOOL_GUARD_NAMES = ["bash","edit","glob","grep","read"]` 已在**丢弃**这些名字 —— 就是为 opencode-zen 的同类问题写的 |

**F1 是方案成立的根本**：`bash` 交回给我们执行，所以我们可以当那个"远程执行器"。
**F7 是接入点**：guard 机制已经存在，新方案是把它从"丢弃"改成"解包+还原"。

---

## 3. 方案

### 3.1 出站（网关 → 上游）

provider 声明 `shellBridge: true`（仅 jw）时：

1. **工具表换成单一 `bash`**，description 写死协议：
   ```
   Run a command. Executed by a remote agent on the user's Windows workstation
   that owns these tools:
     - exec_command {"cmd": string}
     - apply_patch  {"patch": string}
     - spawn_agent  {"message": string, "model": string}
     - view_image   {"path": string}
     - write_stdin  {"session_id": number, "chars": string}
   TO CALL ONE: set command to exactly  @tool:<name> <json-arguments>
   A command WITHOUT the @tool: prefix runs as a plain shell command.
   ```
2. 记录"我们只发了一个 bash"这件事，供回程解包。

### 3.2 回程（上游 → 网关）★ 核心

上游回的 `tool_use` 恒为 `name="bash"`，`input.command` 里是载荷：

```
"@tool:exec_command {\"cmd\": \"dir\"}"   → 解包 → function_call(name=exec_command, args={"cmd":"dir"})
"echo hello"                                → 无前缀 → function_call(name=exec_command, args={"cmd":"echo hello"})
```

解包后**照常发给 Codex** —— Codex 完全不知道中间套了一层。

### 3.3 再出站（Codex 执行完，把结果送回上游）

Codex 的 `function_call_output` 要包回 anthropic 的 `tool_result`，
且 `tool_use_id` 必须匹配我们上一轮发出的那个 `bash` 调用的 id。

**关键简化**：`bridge.mjs:648` 的 `em.call` 用 `id` 作 `call_id` 传给 Codex。
若上游给的 `toolu_bdrk_*` 被原样透传，Codex 回传的 `call_id` 就是它 ——
**无需任何映射表**，回程直接按 `call_id` 复用即可。

---

## 4. 与现有 `TOOL_GUARD_NAMES` 的关系（必须先处理）

现在 `isGuardToolName("bash")` → `true` → **调用被整个丢掉**（我 mock 测试复现：
`output_index: -1`、`output: []`）。这是为 **opencode-zen** 写的：zen 免费档要求
请求里带它的 5 个内置工具名，那 5 个是**代理自己塞的**，所以回复里出现就当幻觉丢弃。

**jw 的情况不同**：`bash` 是**我们主动发出去的唯一工具**，它的调用**必须保留**。

→ 所以不能全局改 guard，要按 route 分开：

| route | guard 行为 |
|---|---|
| opencode-zen | **保持现状**（丢弃） |
| justwoker + shellBridge | **改为解包**（见 3.2） |

---

## 5. 待决问题

- **Q1（最重要）**：网关解包后，是**自己执行**工具，还是**还原成 function_call 交 Codex 执行**？
  - 交 Codex（推荐）：走 Codex 的沙箱/审批/超时，网关保持无状态，安全边界不变。
  - 网关自执行：需要网关实现 shell/补丁/子代理，等于重造一套 Codex —— 不建议。
- Q2：流式问题（上游流式不产正文）要不要一并解决？可能仍需退回非流式。
- Q3：`apply_patch` 原生可用 —— 是否也保留它作为第二条通道（减少一次编码开销）？
- Q4：这份协议的 description 很长，会不会被上游截断/改写？需实测。

---

## 6. 工作量估计

| 部分 | 说明 |
|---|---|
| `toAnthropicBody` 分支 | 工具表替换 + 协议 description（~40 行） |
| 回程解包 | `bridgeAnthropicStream` 里把 bash 调用改写（~50 行） |
| guard 按 route 分化 | `isGuardToolName` 改为接受 route 参数（~10 行） |
| 回程 tool_result 包回 | `toAnthropicBody` 的 function_call_output 分支（~20 行） |
| 测试 | mock 上游 + 解包单测 + 端到端（~150 行） |

**总计约 250-300 行 + 测试。** 不需要重启 Codex，只需重启网关。

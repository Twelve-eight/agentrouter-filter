# agentrouter-filter

Codex CLI 侧的 agentrouter 过滤/桥接网关。

## 为什么需要它

三件事在 Codex 上无法直接做到,必须由本地进程承接:

1. **Codex 0.154 只接受 `wire_api = "responses"`**。`wire_api = "chat"` 已硬删除
   (`no longer supported`),`chat_completions` 报 `unknown variant .. expected 'responses'`。
   凡只有 chat/completions 面的上游(wb2api)都必须做协议桥接。
2. **Codex 没有请求改写钩子**。它只暴露 `PreToolUse` / `UserPromptSubmit` /
   `SessionStart` / `Stop` 等事件,无法改写最终请求体。omp 侧为 agentrouter 写的
   `G:/omp works/.omp/hooks/pre/strip-illegal.ts`(字符白名单 + 网关敏感词表 +
   身份句屏蔽)只能改由传输层承接。
3. **agentrouter 有客户端白名单**。它按 `originator` 头放行
   (实测:`originator: codex_exec` / `pi` / `opencode` / `cline` / `openclaw` -> 200;
   `omp` / `codex` / `cursor` / 无头 -> 401 `unauthorized client detected`)。
   Codex 原生就发 `originator: codex_exec`,**网关原样转发,不伪造任何头**。

## 路由

Codex 的 `model_provider.base_url` 指向 `http://127.0.0.1:7878/<route>/v1`:

| route | 上游 | 方式 | filter | stripReasoning |
|---|---|---|---|---|
| `ar` | `https://ps.air-outer.com` | responses 透传 | 是 | 是 |
| `rc` | `https://api.relaycat.top` | responses 透传 | 否 | 否 |
| `wb` | `http://127.0.0.1:7863` | responses -> chat/completions 桥接 | 否 | 桥接天然丢弃 |
| `an` | `https://anyrouter.top` | responses 透传,经 `http://127.0.0.1:7897` CONNECT 隧道 | 否 | 否 |

**为什么只给 `ar` 开 filter**:字符剥离与词表改写只对 agentrouter 有意义
(它的词表会对不透明内容 400/500);对 relaycat/wb2api 跑这些规则只有保真度损失
(emoji 与非批准文字被删、`relic-bag`/`net id` 这类标识符被改写),包括模型正在读写的代码.

**为什么只给 `ar` 开 stripReasoning**:agentrouter 的 astra 位于多 Azure 资源池后且无
会话粘性,`encrypted_content` 绑定创建它的资源,回放落别的资源必 400.这是 models.yml
`compat.replayResponsesReasoning: false` 的 codex 侧等价物.其余上游无此问题.

`an` 单独走代理是因为 anyrouter.top 直连被 TLS 层拦截;其余路由保持直连
(agentrouter 经该代理会挂起).上游可用 `AR_UPSTREAM_<ROUTE>` / `AR_PROXY_AN` 覆盖.

## 过滤内容(`filter.mjs`)

**核心规则不在本仓库手写**.`filter-core.ts` 由 `tools/gen-filter-core.mjs`
从 omp 钩子 `G:/omp works/.omp/hooks/pre/strip-illegal.ts` 的纯核心段(第 19-196 行)
**字节级原样复制**而来:只丢弃 `import type` 行与 `export default function (pi)` 接线,
再追加一行 export.Node 24 原生擦除类型,该核心只用可擦除语法,所以**不做任何正则改写**
(正则改写可能悄悄破坏含 `": "` 的正则字面量或字符串).`tools/diff-test.mjs` 用
45 个样本 + 一棵嵌套树对"生成版 vs 原钩子"做逐字节比对(当前 0 处不一致).

**改规则请改钩子,然后重跑生成器**:

```
node tools/gen-filter-core.mjs   # 重新生成 filter-core.ts
node tools/diff-test.mjs         # 必须 0 mismatches
```

`filter.mjs` 只额外承担两件钩子没有的事:

- **身份句改写**(用户明确要求,无条件保留):
  `You are Claude Code, Anthropic's official CLI tool for Claude.` ->
  `You are Codex, an official CLI coding agent.`
  探针显示该句无论如何都能通过上游,所以它**不是**由阻断行为证明的条目.
- **额外要求注入**:工作区 AGENTS.md Sec 5 的语言卫生规则与身份规则以
  `Additional requirements for this provider. ..` 追加到请求体 `instructions`
  末尾(幂等).Codex 没有 provider 级 `instructions` 字段
  (`--strict-config` 直接报 `unknown configuration field`),网关是唯一可承载处.

**只对 `ar`(agentrouter)开启**.对 relaycat/wb2api 跑这些规则只有保真度损失.

### 关于"是否还需要这层过滤"的现状(2026-09-20)

**未定论,故保留**:

- 钩子源码注释写明词表是 **GLM 上游**词表,Sts2 的 500 也来自 GLM.
- 用 `deepseek-v4-flash` 复测时那些词组全部通过,但**不同上游**不能互证.
- `glm-5.3` 当前 **503**(无可用渠道),**无法复测**,所以不能判定该层过时.
- 上游是**累积式**分类器(Sts2 二分:5.5KB 纯 ASCII 工具结果只在 600 条消息的
  上下文中被拦),小请求单测不足以证明"安全".

待 `glm-5.3` 可探测后再复核.

失败时**放行不阻断**,与 omp 钩子一致.

## 运行

```
node server.mjs          # 监听 127.0.0.1:7878
```

开机自启注册为**单个** Run 项 `omp-services`(-> `autostart.cmd`),它用一个
Windows Terminal 窗口启动**全部三个服务**,每个服务一个标签:

| 服务 | 端口 | 目录 |
|---|---|---|
| agentrouter 网关 | 7878 | `G:\omp works\Tools\agentrouter-filter` |
| wb2api | 7863 | `G:\workbuddy2api` |
| wbgui(面板) | 8787 | `G:\workbuddy2api-gui` |

服务为**分离启动**,标签只 tail 日志,所以关窗口不会停服务.端口已在监听的会被跳过,
重复执行安全.旧的启动文件夹项 `WorkBuddyGateway.cmd` 已移除.

移除自启:

```
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v omp-services /f
```

**网关不在时,config.toml 里指向它的 provider 全部失败**,这是预期行为(不静默降级).

## 验证

```
# 过滤生效(应打印改写日志,且上游收到的 instructions 已是 Codex 身份)
AR_UPSTREAM_AR=http://127.0.0.1:7897 node server.mjs

# 各路由
curl -s -N -X POST http://127.0.0.1:7878/ar/v1/responses \
  -H "Authorization: Bearer $AGENTROUTER_API_KEY" -H "Content-Type: application/json" \
  -H "originator: codex_exec" -d @body.json
```

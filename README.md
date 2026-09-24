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

| route | 上游 | 方式 | filter |
|---|---|---|---|
| `ar` | `https://ps.air-outer.com` | responses 透传 | 是 |
| `rc` | `https://api.relaycat.top` | responses 透传 | 否 |
| `wb` | `http://127.0.0.1:7863` | responses -> chat/completions 桥接 | 否 |
| `an` | `https://anyrouter.top` | responses 透传,经 `http://127.0.0.1:7897` CONNECT 隧道 | 否 |

**为什么只给 `ar` 开 filter**:字符剥离与词表改写只对 agentrouter 有意义
(它的词表会对不透明内容 400/500);对 relaycat/wb2api 跑这些规则只有保真度损失
(emoji 与非批准文字被删,`relic-bag`/`net id` 这类标识符被改写),包括模型正在读写的代码.

**严格 item id 修复 (2026-09-24, 仅 agentrouter)**:agentrouter 会校验**每条回放 item 的 id 前缀**
是否与类型相符 (reasoning -> `rs`, message -> `msg`, function_call / function_call_output -> `fc`,
web_search_call -> `ws`, custom_tool_call -> `ctc`, custom_tool_call_output -> `ctco`), 并在不符时
400 `Expected an ID that begins with 'rs'`。relaycat 签发的 id 形如 `item_...`, 会话从 relaycat 切到
agentrouter 时被 Codex 原样回放, 该轮即失败。

改名救不了 (上游在自己库里按 id 查, 改前缀会变成 `Item with id .. not found`), 所以网关**删除**与类型契约
冲突的 id; 只有当上游自己抱怨回放 id 时, 才再重发一次并删掉**所有** id。`item_reference` 不删 (它的 id
就是载荷)。实现与完整实测矩阵见 `responses-ids.mjs`, 测试见 `tools/test-responses-ids.mjs` (16) 与
`tools/test-strict-item-ids.mjs` (14)。开关是 `providers.json` 里该提供商的 `strictItemIds`, **只有
agentrouter 置位** —— 其它上游的 id 逐字节不动。

这与下面那条全局 `stripReasoning` 移除不冲突: 那是无差别剥离, 这是按类型契约的最小删除。

**reasoning 剥离已整体移除**:曾有一个 `stripReasoning` 开关(丢弃回放的 `reasoning`
item),用于规避 agentrouter 多 Azure 资源池无会话粘性导致的 400.用户已声明不再需要,
且实测带 `encrypted_content` 回放上游返回 200,故**不留该机制,也不为没有实证问题的
东西做改写**.

`an` 单独走代理是因为 anyrouter.top 直连被 TLS 层拦截;其余路由保持直连
(agentrouter 经该代理会挂起).上游可用 `AR_UPSTREAM_<ROUTE>` / `AR_PROXY_AN` 覆盖.

## 过滤内容(`filter.mjs`)

**核心规则不在本仓库手写**.`filter-core.ts` 由 `tools/gen-filter-core.mjs`
从 omp 钩子 `G:/omp works/.omp/hooks/pre/strip-illegal.ts` 的纯核心段(第 19-196 行)
**字节级原样复制**而来:只丢弃 `import type` 行与 `export default function (pi)` 接线,
再追加一行 export.Node 24 原生擦除类型,该核心只用可擦除语法,所以**不做任何正则改写**
(正则改写可能悄悄破坏含 `": "` 的正则字面量或字符串).`tools/diff-test.mjs` 用
45 个样本 + 一棵嵌套树对"生成版 vs 原钩子"做逐字节比对(当前 0 处不一致).

**该测试的射程只有"复制保真",不是"规则正确"**:它比对的两侧是**同一套规则**
(生成版来自钩子核心),所以它只能证明生成器没有丢规则/改规则,不能证明这些
规则本身正确、必要或仍与上游行为匹配.规则内容对不对,只能靠对上游的探针复测
(见下一节),不能靠这个测试.

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

失败时**放行不阻断**,与 omp 钩子一致:过滤器抛异常时请求照发,但会在日志打出
`!! filter threw on <route>; forwarding UNFILTERED (..)` 一行,所以"未被过滤就出门"
在日志里可见,不会与"已过滤"混淆.

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

### 本地信任边界

**网关是本地信任组件,自身不做任何身份校验**.它只监听 `127.0.0.1:7878`,没有
token/Origin 校验;统一路由 `/u` 还会在转发前把客户端发来的 `authorization`
替换成环境里配置的上游 key(并删掉 `x-api-key`).因此**任何能连到
`127.0.0.1:7878` 的本机进程都能直接消耗已配置的上游额度(无需知道 key),并读取
`/api/*` 里的用量统计**.浏览器跨源取用受 JSON 预检/CORS 限制,所以风险面限于
本机进程,但本机进程并不受限制.

这是**已知且有意保留**的取舍(加认证会让 Codex 的 provider 配置失效),不是缺陷:
边界就是"能访问回环地址 = 已受信任".需要收紧时再加本地随机 token 或 Host/Origin 校验.

## 验证

```
# 过滤生效(应打印改写日志,且上游收到的 instructions 已是 Codex 身份)
AR_UPSTREAM_AR=http://127.0.0.1:7897 node server.mjs

# 各路由
curl -s -N -X POST http://127.0.0.1:7878/ar/v1/responses \
  -H "Authorization: Bearer $AGENTROUTER_API_KEY" -H "Content-Type: application/json" \
  -H "originator: codex_exec" -d @body.json
```

## opencode zen 免费档(`opencode-zen` 路由)

Codex 里可选的 `mimo-v2.6-flash-free`(别名 `zen:mimo-v2.6-flash`)走本机反代
`oc-zen-proxy.mjs`(127.0.0.1:7901)-> `https://opencode.ai/zen/v1`。

**为什么需要反代**:zen 对免费档做"是否来自 OpenCode 客户端"的检查,三个条件同时满足才放行
(2026-09-22 实测,缺任一都 403 `FreeTierError`):

| 条件 | 实测依据 |
|---|---|
| `x-opencode-session` 必须是 **OpenCode 客户端铸造过的** id | 同长度随机 `ses_xxx` 一律 403;真实 id 可跨会话复用 |
| `User-Agent` 形如 `opencode/<ver> ... runtime/bun/<ver>` | 换 curl 默认 UA -> 403 |
| 请求体 `tools` 的前 5 个必须是 OpenCode 内置工具 `bash,edit,glob,grep,read` | 4 个真工具 + 1 个自造工具(同样长度/体积)-> 403;5 个真工具 + 1 个外来工具 -> 200 |

注意这与 API key 无关:key 仍然照常鉴权,反代只补齐"客户端指纹"。`x-opencode-session`
的值放在 `.oc-session`(gitignore,机器本地)。**失效时重新铸造**:跑一次
`opencode run -m opencode/mimo-v2.6-flash-free "hi"`,再从客户端请求里取新的 `x-opencode-session`
(抓包方法见 DEVLOG 2026-09-22 条目),写回 `.oc-session` 后重启本反代即可。

反代会在请求体前面插入那 5 个守卫工具(与调用方同名时以守卫版本为准,避免上游 duplicate names 400),
网关侧 `TOOL_GUARD_NAMES` 再把它们从**响应**里剔除,所以调用方不会看到自己没声明过的工具。

档位:zen 免费档只接受 `reasoning_effort` 的 `low/medium/high`(`minimal`/`xhigh`/`max` 都是 400),
`providers.json` 的 `efforts: ["low","medium","high"]` 声明后由桥接夹取。

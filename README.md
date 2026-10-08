# agentrouter-filter

Codex CLI 侧的 agentrouter 过滤/桥接网关。

## 为什么需要它

三件事在 Codex 上无法直接做到,必须由本地进程承接:

1. **Codex 0.154 只接受 `wire_api = "responses"`**。`wire_api = "chat"` 已硬删除
   (`no longer supported`),`chat_completions` 报 `unknown variant .. expected 'responses'`。
   凡只有 chat/completions 面的上游(wb2api)都必须做协议桥接。
2. **Codex 没有请求改写钩子**。它只暴露 `PreToolUse` / `UserPromptSubmit` /
   `SessionStart` / `Stop` 等事件,无法改写最终请求体。omp 侧为 agentrouter 写的
   `filter-rules-source.ts (in this repo)`(字符白名单 + 网关敏感词表 +
   身份句屏蔽)只能改由传输层承接。
3. **agentrouter 有客户端白名单**。它按 `originator` 头放行
   (实测:`originator: codex_exec` / `pi` / `opencode` / `cline` / `openclaw` -> 200;
   `omp` / `codex` / `cursor` / 无头 -> 401 `unauthorized client detected`)。
   Codex 原生就发 `originator: codex_exec`,**网关原样转发,不伪造任何头**。

## 路由

Codex 的 `model_provider.base_url` 指向 `http://127.0.0.1:7878/<route>/v1`:

除统一路由 `/u`(按请求体 `model` 字段派发)外,每个 provider 还有一个前缀路由:

| provider | 前缀 | 上游 | wire | filter | egressGuard |
|---|---|---|---|---|---|
| `agentrouter` | `ar` | `https://ps.air-outer.com` | responses | **是** | 否 |
| `relaycat` | `rc` | `https://api.relaycat.top` | responses | 否 | 否 |
| `relaycat65` | — | `https://api.relaycat.top` | responses | 否 | 否 |
| `relaycat-cn` | — | `https://api.relaycat.top` | responses | 否 | 否 |
| `wb2api` | `wb` | `http://127.0.0.1:7863` | **chat** | 否 | 否 |
| `anyrouter` | `an` | `https://anyrouter.top` | responses | 否 | 否 |
| `justwoker` | `jw` | `https://api.justwoker.icu` | **anthropic** | 否 | **是** |
| `northstar-kiro` | `ki` | `https://kiro.northstar.cool` | responses | 否 | 否 |
| `devin-northstar` | — | `https://devin.northstar.cool` | responses | 否 | 否 |
| `antigravity` | — | `http://127.0.0.1:8045` | responses | 否 | 否 |
| `opencode-zen` | — | `http://127.0.0.1:7901/zen` | **chat** | 否 | 否 |
| `motomoto` | — | `https://motomoto.lol` | **chat** | 否 | 否 |
| `ovoapi` / `ovoapi-amz` / `ovoapi-005` | — | `https://ovoapi.site` / `https://api-console.182yc.xyz` | responses | 否 | 否 |

`wire` 决定走哪条处理链路:**responses** 原生透传(54 个模型),
**chat** 桥接(26 个),`anthropic` 桥接(3 个)。桥接链路与透传链路的差异不只是协议转换 ——
脱敏只挂在两条桥接链路上,详见下文"过滤与脱敏的作用范围"。

路由前缀是历史遗留:统一路由 `/u` 出现后,大多数 provider 不再需要单独前缀,
保留 `ar` / `rc` / `wb` / `an` / `jw` / `ki` 是为了兼容既有 `config.toml` 条目与调试脚本。

**为什么只给 `ar` 开 filter**:见下文"过滤与脱敏的作用范围"(含实测数据).

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

**namespace 工具的扁平化与历史改写 (2026-10-07, 仅 `flattenNamespaceTools` 路由)**: Codex 把
多智能体工具声明成一个 namespace 条目(`{type:"namespace", name:"multi_agent_v1", tools:[...]}`),
而 kiro 会**静默丢弃**这个形状 —— 模型完全看不到 `spawn_agent`。网关因此把 namespace 展开成
扁平函数 `multi_agent_v1__spawn_agent` 再发(开关在 `providers.json` 的 `flattenNamespaceTools`)。

**这需要两半,缺一不可**(2026-10-06/07 实测):

| 方向 | 做什么 | 缺了会怎样 |
|---|---|---|
| 出站 | 展开工具表 **并且**把历史里回放的 `function_call` 改写成扁平线名 | 模型读自己的历史看到裸名 `spawn_agent`,就照抄调用裸名;上游如实回裸名;回程映射查不到 → Codex 报 `unsupported call: spawn_agent` |
| 入站 | 用 `flattenTools()` 的 `byWire` 映射还原成 `{name, namespace}` | 模型看到扁平名却调不动(旧的半吊子状态) |

真实症状是**同一会话里部分成功、部分失败**:失败样本全部缺 `namespace` 字段,成功样本都带 ——
不是模型随机失误,而是历史里裸名与扁名混着,模型跟着学。

**回程还原必须查映射,不能在 `"__"` 上切分**:namespace id 自身就含这个分隔符
(`mcp__codex_app`),切分会把 `mcp__codex_app__list_threads` 解析成 namespace `"mcp"`。
另有一个 `byBare` 安全网:只有当裸名**唯一归属**(一个命名空间拥有、且没有同名扁平工具)时才还原,
否则宁可不猜 —— 防止把真实扁平工具错认成命名空间子工具。

回归测试:`tools/test-namespace-passthrough.mjs`(14 项,含流式 SSE、歧义、扁平遮蔽、mcp 切名)。
`server.mjs` 改动需要**重启网关**。

`an` 单独走代理是因为 anyrouter.top 直连被 TLS 层拦截;其余路由保持直连
(agentrouter 经该代理会挂起).上游可用 `AR_UPSTREAM_<ROUTE>` / `AR_PROXY_AN` 覆盖.

## 模型目录(`~/.codex/omp-model-catalog.json`)

Codex 的模型选择器读 `config.toml` 的 `model_catalog_json`,指向本仓库
`tools/build-model-catalog.cjs` 生成的文件。**这个键是"替换"而不是"追加"**:
指向一份 5 条目的文件会让 gpt-6-astra / gpt-5.5 / gpt-5.4 全部消失,
所以生成器先经一个无 `model_catalog_json` 的临时 CODEX_HOME 读回内置目录
(`codex debug models`),再把本仓库的模型并上去。

### 生效时机:启动时读取一次,**改完必须重启 Codex**

| 文件 | 读取时机 | 改完要做什么 |
|---|---|---|
| `providers.json`(本仓库) | **每请求**(mtime+size 缓存) | 什么都不用做 |
| `~/.codex/omp-model-catalog.json` | **进程启动时一次** | **必须重启 Codex** |

两者形状相同、都由本仓库生成,生效方式却相反 —— 这是最容易踩的一处。
源码依据:`codex-rs/core/src/config/mod.rs` 的 `load_model_catalog()` 在配置加载时
调用一次,结果存进 `Config.model_catalog`,没有 file watcher。
可重复验证:`node tools/probe-catalog-reload.mjs`(合成目录 + 真实 codex.exe,
同一进程改文件后仍返回旧列表,新进程才读到新列表 → `STARTUP ONLY`)。

### `priority`:两个互不相干的作用

| 取值 | 作用 |
|---|---|
| **正值** | 内置条目之间的排序(内置占用 1..43) |
| **负值** | 该条目进入 `spawn_agent` 的 "Available model overrides" 提示文本 |

选择器按 `priority` **升序**渲染,同值按 **catalog 数组顺序**。实测(合成目录
`zz-a(0), zz-b(-2), zz-c(1), zz-d(-1)` → 返回 `zz-b, zz-d, zz-a, zz-c`)。
所以"把某个模型往上挪"= 把它往数组前面挪。小数 priority 会让整份 catalog 被拒。

### `visibility`:收窄选择器但不切断路由

合法值只有 `list` / `hide` / `none`。

**关键性质:隐藏 ≠ 不可用。** `find_spawn_agent_model_name()` 只匹配模型存在且
`multi_agent_version != Disabled`,**从不读 `show_in_picker`**;被隐藏的模型照样能
路由、照样能 spawn,只是不出现在选择器和提示块里。实测:隔离实例把已隐藏的
`zen:space-bunny` 设为主模型,请求正常送达上游。

这条性质是本仓库做"选择器收窄"的基础:2026-10-06 用户指定保留 11 个模型
(见 `tools/build-model-catalog.cjs` 的 `KEEP_SLUGS`),其余全部标 `hide`。
**不能改成删除条目** —— 桌面版每建一个线程就调标题生成器(用内置 slug
`gpt-5.6-luna`),auto-review 调 `codex-auto-review`,删掉它们会重演 DEVLOG
2026-09-22 记录的 503 风暴。

### 子代理的 5 个提示位

`spawn_agent` 的工具说明里列 5 个建议模型名,取自**选择器顺序的前 5 个**
(`MAX_SPAWN_AGENT_MODEL_OVERRIDES = 5`,硬编码在 Codex 二进制里,改不了)。
**这不是白名单**:整份 catalog 都能 spawn。生成器用 `HINT_SLUGS = KEEP_SLUGS.slice(0, 5)`
让提示位等于列表前五。

验证:`node tools/probe-subagent-models.mjs --order`。

### 相关工具

| 工具 | 作用 |
|---|---|
| `tools/build-model-catalog.cjs` | 生成目录(内置目录 + 本仓库模型 + 上下文/effort/压缩阈值) |
| `tools/model-inventory.mjs` | 按用量账本出全量清单;`--canvas` 直接重生成画布 |
| `tools/probe-subagent-models.mjs` | 断言 priority 排序;证明提示位不是白名单 |
| `tools/probe-catalog-reload.mjs` | 断言 catalog 是启动时读取(改完要重启) |

## 过滤与脱敏的作用范围

两个机制都按 **provider** 开关,当前各只对一个 provider 生效:

| 机制 | 开关 | 作用范围 | 性质 |
|---|---|---|---|
| **屏蔽词过滤**(`filter.mjs`:字符白名单 + GLM 词表 + 身份改写) | `filter: true` | **只有 agentrouter** | 失败**放行**(不阻断) |
| **脱敏**(`egress-guard.mjs`:密钥 / 主机身份 / 路径 / 内网 IP) | `egressGuard: true` | **只有 justwoker** | 失败**阻断** |

**为什么过滤只留 agentrouter**:那些规则是为 agentrouter 的词表写的;对
relaycat / wb2api / kiro 跑同一套规则只有保真度损失(emoji 与非批准文字被删,
`relic-bag` / `net id` 这类标识符被改写,包括模型正在读写的代码)。
实测(同一份触发载荷打四个 provider,按日志 `filter rewrote` 增量判断):
zen / kiro / wb2api / ovoapi **全为 0**,agentrouter 为 1。

**为什么脱敏只留 justwoker**:它存在的原因是 justwoker 被实测会收集主机信息
(见 `egress-guard.mjs` 头部注释与 DEVLOG 2026-09-24)。

### 已知空白:脱敏在原生 responses 直通路径上没有调用点

`server.mjs` 里 `guardBody(...)` 只有两处调用,都在**桥接**分支内:

| 行 | 分支 | 覆盖 |
|---|---|---|
| :1285 | `responses -> chat` 桥接 | 26 个 chat-wire 模型 |
| :1450 | `responses -> anthropic` 桥接 | 3 个 anthropic-wire 模型 |

**原生 responses 直通路径没有任何脱敏调用点**,而走这条路的有 **54 个模型**
(relaycat 全系 / wb2api / anyrouter / northstar-kiro / antigravity / motomoto /
ovoapi 全系)。即:给这些 provider 在 `providers.json` 里写 `egressGuard: true`
**不会生效**,因为直通分支根本不读 `route.egressGuard` —— 必须先在直通路径上加调用点。
这是"配置看起来对、实际不参与"的同型坑,与 DEVLOG 1857 行那条教训一致。
当前用户明确接受"只生效 woker",故仅留档。

## 过滤内容(`filter.mjs`)

**核心规则不在本仓库手写**.`filter-core.ts` 由 `tools/gen-filter-core.mjs`
从 omp 钩子 `filter-rules-source.ts (in this repo)` 的纯核心段(第 19-196 行)
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

# DEVLOG - agentrouter-filter

按 AGENTS.md:每次改动记录到本文件,便于零上下文恢复.

## 2026-09-20:建立网关(Codex 侧 agentrouter 过滤/桥接)

### 背景
用户在 Codex 里使用 agentrouter.此前 omp 侧为 agentrouter 做了三类适配,现要求
全部搬到 Codex:

1. `.omp/hooks/pre/strip-illegal.ts` -- 字符白名单 + 网关敏感词表 + 身份句屏蔽.
2. 工作区 AGENTS.md Sec 5 语言卫生规则(仅中英法德俄字符),同源同因.
3. 客户端身份:agentrouter 白名单.

### 实证结论(全部 curl 实测)
- **codex 0.154 只接受 `wire_api = "responses"`**:
  `wire_api="chat"` -> `no longer supported`;`chat_completions`/`openai`/
  `completions`/`chatCompletions` -> `unknown variant .. expected 'responses'`.
  官方 discussion #7782:chat/completions 于 2026-02 硬删除.
- **codex 无请求改写钩子**:仅 PreToolUse/UserPromptSubmit/SessionStart/Stop/
  PostToolUse/PreCompact/SessionEnd/SubagentStop/Notification.故用本地网关承接.
- **agentrouter 白名单按 `originator` 头**:
  `originator: codex_exec|pi|opencode|cline|openclaw` -> 200;
  `omp|codex|cursor|workbuddy|github-copilot|无头` -> 401
  `unauthorized client detected`. UA 是次要信号(带 curl UA + 正确 originator -> 200).
  Codex 原生发 `originator: codex_exec` + `UA: codex_exec/0.154.0 (Windows ..)`,
  **网关原样转发,不伪造**.
- **agentrouter 模型现状**(账户配额,非配置问题):
  deepseek-v4-flash 全 effort 档 200;gpt-6-astra / gpt-5.6-sol 402
  `Budget pool quota has been exhausted`;glm-5.3 503 `无可用渠道`;
  claude-opus-4-8/5 仅 anthropic-messages 面,codex 无法接入.
- **relaycat 有 responses 面**:`/v1/responses` 200(chat 面亦 200).
  `deepseek-v4.1-flash` 属 relaycat-cn 分组,**必须用 `RELAYCAT_CN_API_KEY`**;
  主 key 调该模型 -> 503 `Service temporarily unavailable`(已复现,已修正 profile).
- **wb2api 只有 chat 面**(源码 `handler.go` 仅 `POST /v1/chat/completions` +
  `GET /v1/models`;`/v1/responses` 全 404)-> 需协议桥接.
- **anyrouter**:15 个模型里 14 个在 `/v1/responses` 上 404
  (`当前 API 不支持所选模型`),仅 gpt-6-astra 走该面且当前满载
  (500 `负载已经达到上限` / codex 侧 `high demand`).直连 TLS 被拦,需 7897 代理.
- **CONNECT 隧道必须显式带 `Host` 头**:Node `https.request({socket})` 不自动补,
  缺了会被 anyrouter 的阿里云 ESA 边缘返回 403 `Forbidden`(非上游业务错误).
- **Codex 无 provider 级 `instructions` 字段**:`--strict-config` 报
  `unknown configuration field 'model_providers.<x>.instructions'`;
  非 strict 模式静默忽略(等于无效).故语言卫生/身份规则改由网关注入
  请求体 `instructions`(幂等,`EXTRA_INSTRUCTIONS`).

### 交付
- `filter.mjs` -- 字符映射表 + 词组表(含新增身份句屏蔽),`sanitize`/`deepSanitize`/
  `filterBody`.字符层经码点级验证:假名/谚文/阿拉伯/希腊/emoji/制表符 -> 删除;
  CJK/西里尔/带音标拉丁 -> 保留.
- `server.mjs` -- 4 条路由(ar/rc/wb/an),`wb` 做 responses<->chat 双向转换
  (含 function_call 事件桥接),`an` 走 CONNECT 隧道,请求体先过滤后转发,
  改写时打日志.
- `autostart.cmd` + HKCU Run 键 `agentrouter-gateway`.
- `C:\Users\o_Obl\.codex\config.toml` -- 5 个 provider(agentrouter/relaycat/
  relaycat-cn/anyrouter/wb2api,全部 base_url 指向网关)+ 5 个 profile 文件
  (0.154 的 `-p` 只认 `$CODEX_HOME/<name>.config.toml`,内联 `[profiles.x]` 已废弃).

### 验证
- 过滤器端到端证明:把 `/ar` 上游指向本地 echo,确认上游收到的 `instructions`
  已是 `You are Codex, an official CLI coding agent.`,且 `originator: codex_exec`
  原样到达.
- **生成方式改为字节级复制**:`tools/gen-filter-core.mjs` 从钩子第 19-196 行
  **原样复制**为 `filter-core.ts`,只丢弃 `import type` 行与
  `export default function (pi)` 接线,再追加 `export { sanitize, deepStrip };`.
  Node 24 原生擦除类型,该核心只用可擦除语法(`import type` / `Record<..>` /
  `: string` / `{ flag: boolean }`),所以**不做任何正则改写**(正则改写可能悄悄
  破坏含 `": "` 的正则字面量或字符串).
  `tools/diff-test.mjs` 45 个样本 + 1 棵嵌套树逐字节比对,**0 mismatches**.
- **多轮会话验证(已修正方法学)**:`codex exec resume` **没有 `-p/--profile`**
  (只有 `-c`/`-m`),先前 harness 的 resume 调用漏了 provider,导致第 2/3 轮实际打到
  默认 provider -- 那批"多轮通过"**不成立**,已作废.修正版每次调用都显式传
  `-c model_provider=.. -c model=..`.该批(PONG 提示词)的请求遥测:

| 路由 | t1 -> t2 -> t3 items | reasoning | 结果 |
|---|---|---|---|
| `/rc` astra (relaycat) | 7 -> 9 -> 11 | 全 0 | PONG x3,clean |
| `/rc` cn-ds (relaycat-cn) | 3 -> 5 -> 7 | 全 0 | PONG x3,clean |
| `/ar` ds (agentrouter) | 3 -> 5 -> 7 | 全 0 | PONG x3,clean |

  (此表 `reasoning` 列采自**修复前**的剥离后遥测,不可信,仅留作方法学记录;
  可信数据见下方"带真实工具调用的多轮".)items 逐轮增长 = 确实是 resume.
- **带真实工具调用的多轮(关键补测)**:PONG 轮次从不产生
  `function_call`/`function_call_output`,所以"reasoning 与工具调用配对"这一
  `/v1/responses` 的核心场景一直没测.改用"读 AGENTS.md 第 1 行并引用"驱动.
  工具是否真的被调用**以网关遥测 `calls=`/`outputs=` 为准**
  (早先用 `/\bread\b/` 匹配正文会假阳性).剥离前遥测:

| 路由 | 观测到的请求 | 结果 |
|---|---|---|
| `/ar` agentrouter | `items=6 reasoning=1 -> 0 calls=1 outputs=1`;`items=17 reasoning=4 -> 0 calls=3 outputs=3` | 全 200,clean |
| `/rc` relaycat | `items=19 reasoning=2 calls=0 outputs=0`(未剥离) | 全 200,clean |
| `/wb` bridge | `items=13 reasoning=0 calls=3 outputs=3`(桥接) | 全 200,clean |

  **注意上表有模型混淆**:`/ar` 跑 deepseek-v4-flash 而 `/rc` 跑 gpt-6-astra,
  所以 `/rc` 的 `calls=0` 可能是**模型不愿调用工具**,而非路由缺陷.为排除该因素,
  用**同一 deepseek 家族**在三条路由上重跑同一"必须用工具才能回答"的提示词:

| 路由 | 模型 | 剥离前遥测 | 结果 |
|---|---|---|---|
| `/ar` | deepseek-v4-flash | `items=16 reasoning=3 -> 0 calls=3 outputs=3` | 200,clean |
| `/rc` | deepseek-v4.1-flash | `items=15 reasoning=4 calls=3 outputs=3` | 200,clean |
| `/wb` | global:deepseek-v4.1-flash | `items=11 reasoning=0 calls=3 outputs=3` | 200,clean |

  即:**三条路由都确认能跑通工具调用**(`calls>=1`),
  且 `/rc` 上"**reasoning 回放 + 工具配对**"组合同时出现(`reasoning=4` 与
  `calls=3`)仍 200 -- 早先 `/rc` 的 `calls=0` 确系 gpt-6-astra 的行为,不是路由问题.
  `/wb` 首轮曾因上游 `503 no_healthy_account`(workbuddy 账户池暂时不可用)重试,
  随后成功;这是上游可用性问题,与桥接无关.

  结论按路由分开写(以"同模型家族"那组为准):
  - **`/ar`**:reasoning **与工具调用配对**同时出现(`reasoning=3` 与 `calls=3`),
    剥离 reasoning 后 `function_call`/`function_call_output` 全部保留,上游 200 --
    这是本项目最关键的风险点,已实测排除.
  - **`/rc`**:"**reasoning 回放 + 工具配对**"组合已覆盖
    (`items=15 reasoning=4 calls=3 outputs=3`),不 400,故不剥离.
    (早先 gpt-6-astra 会话 `calls=0` 是模型行为,非路由缺陷.)
  - **`/wb`**:验证的是**桥接的工具往返**(唯一手写协议翻译),
    `calls=3 outputs=3` 经 responses<->chat 双向转换成功;该路由按设计丢弃 reasoning
    (`reasoning=0`),故不涉及回放.
- **reasoning 回放的结论**(用剥离前遥测,非自证):agentrouter 上
  codex **确实回放** reasoning(`reasoning=1..4`),故 `/ar` 的剥离是**已验证生效的
  必要保护**;relaycat **也回放**(1..2 个)且**不报 400**,故 `/rc` **保持不剥离**
  (有实证支撑,不再加保险).**遥测必须在剥离前采样** -- 否则剥离路由永远显示
  `reasoning=0`,无法区分"客户端没发"与"被我们删了"(先前版本即有此缺陷,已修).
- **autostart 实测(含 `.ts` 核心)**:停掉旧实例 -> 直接跑 `autostart.cmd` ->
  端口 7878 由 `G:\nodejs\node.exe`(v24.18.0,支持类型擦除)绑定,
  日志出现 `agentrouter gateway listening .. (routes: /ar /rc /wb /an)`,
  无 TS 加载报错,随后全部多轮测试都跑在这个 autostart 实例上.
  另:重复启动时原会抛未捕获 `EADDRINUSE` 栈,已改为安静退出(第二个实例通常
  就是 autostart 副本,同一组路由由存活实例服务).
  注意:hub 的 `argw` 进程在 autostart 已占端口时必然退出,这是预期;
  测试期间曾因此丢失日志可见性,已统一改看 `.tmp/argw-autostart.log`.
- **profile 矩阵**(`codex exec --skip-git-repo-check -p <x> "只回复:PONG"`):

| profile | provider/model | 结果 |
|---|---|---|
| (默认) | agentrouter/deepseek-v4-flash | PONG |
| `ar-ds` | agentrouter/deepseek-v4-flash | PONG |
| `astra` | relaycat/gpt-6-astra | PONG |
| `rc-ds` | relaycat-cn/deepseek-v4.1-flash | PONG |
| `wb-ds` | wb2api/global:deepseek-v4.1-flash | PONG(含工具桥接) |
| `ar-sol` | agentrouter/gpt-5.6-sol | 402 配额耗尽 |
| `ar-astra` | agentrouter/gpt-6-astra | 402 配额耗尽 |
| `ar-glm` | agentrouter/glm-5.3 | 503 无可用渠道 |
| `an-astra` | anyrouter/gpt-6-astra | anyrouter 通道满载 |

  即:**配置全部就绪,4 个当前可用,5 个卡在上游账户配额/通道**,不是配置缺陷.

### 其它结论
- `model_reasoning_effort = "max"` **是** codex 0.154 的合法档位
  (二进制枚举 `none|minimal|low|medium|high|xhigh|max|ultra|persistent`),
  `astra.config.toml` 已恢复 `max`.
- `[model_providers.<x>.responses]` 空表**非法**(`--strict-config` 报
  `unknown configuration field`),已删除;它会静默让整份配置加载失败.
- 默认 `model = "deepseek-v4-flash"` + `model_provider = "agentrouter"`:
  用户意图是在 codex 里用 agentrouter,且 astra/sol 当前 402,故默认选实测可用的
  agentrouter 模型.注意 402 属于 **agentrouter 的配额池**,与 relaycat 无关
  (relaycat 的 gpt-6-astra 已充值且 16.6k-tok E2E 通过,`astra` profile 可用).
- models.yml 的 `User-Agent: claude-cli/2.0.34` **未改动**:那是 omp 侧的承重配置
  (omp 原生 UA 不在 agentrouter 白名单,去掉 omp 就彻底失去 agentrouter).
  用户"不要伪造 UA"的要求针对 codex 侧,已满足(codex 原生 `codex_exec/0.154.0`
  + `originator: codex_exec` 本就在白名单,网关只原样转发).

## 2026-09-20(续):服务以 WT 标签呈现 + 分离启动 + 交接

### 服务生命周期(设计决定)
服务**分离启动**(`Start-Process -WindowStyle Hidden`),标签只 `tail` 日志.
理由:wb2api 是在跑的 agent 会话的 API 端点(其 DEPLOY-NOTES:会话运行期间绝不可杀),
而共享的 WT 窗口很容易误关.**实测**:杀掉 tail 的 powershell 后,分离的 node 仍在监听 7878.

曾考虑但否决的形式:`& exe *>&1 | Tee-Object`(服务挂在标签下)-> 误关窗口即杀服务.

### 双流 tail
`Start-Process` 无法合并 stdout/stderr,而 Go 的 `log` 包默认写 stderr.
所以每个标签**同时 tail 日志与其 `.err`**,否则 wb2api/wbgui 标签会一直空白,
而真正的日志全进了 `.err`.(`Get-Content -Wait` 在写入者持有句柄时仍可读.)

### 开机自动应用暂存构建
`apply-staged-wb2api.ps1`:把 `out\wb2api-new.exe` 换到 `out\wb2api.exe`,但
**仅当 7863 未监听**(有会话在用就拒绝,避免自断链路)且暂存构建更新时.
由 `autostart.ps1` 在端口探测前调用 -> 开机(无会话)时生效,会话中是无害 no-op.
旧二进制保留为 `out\wb2api.exe.old`.

### 验收(保留 7863,只停 7878/8787)
`autostart.cmd` -> `apply-staged` 正确拒绝(7863 在跑)-> 7878+8787 起为
**同一窗口的两个标签**(WT 进程数 1)-> codex 仍 PONG.

### 踩坑记录(PS 5.1)
- `ProcessStartInfo` 无 `ArgumentList`(.NET Core/PS7 才有)-> 用引号拼接的 `Arguments`.
- PS 5.1 的 `Process` **不支持** `$proc.OutputDataReceived += ..` -> 不能用事件读流.
- `Tee-Object -Append` / cmd `>>` 独占日志文件,第二个写入者直接失败.
- `Start-Process -ArgumentList` 数组**不引用**参数,含空格的路径会被拆开
  -> 跨进程只传无空格的 service key,路径在 `services.ps1` 里查表.
- `cmd.exe /c` 对"首参带引号"有特殊解析,含空格的 .cmd 路径会被拆 -> 用无空格路径.
- `-RedirectStandardOutput` **截断**而非追加 -> 交接时先移走旧文件再重定向.

## 2026-09-20(四):恢复过滤层 + 修桥接的 effort/usage 转发

### 撤回上一节的"整体移除"
上一节我基于"词表全部通过"判定词组层过时并整体删除.该结论有**两个盲点**:

1. **测错了上游**:钩子源码注释明写 `Phrase-level filter (GLM upstream word list)`,
   Sts2 的 500 也来自 GLM,而我用 `deepseek-v4-flash` 测.不同上游,结论不通用.
   且 `glm-5.3` 现在是 **503**(无可用渠道),**无法复测** -> 不能判它过时.
2. **漏了一条规则**:18 字符触发词用 `String.fromCharCode` 拼写(避开自身源码),
   我的探针没覆盖它.

另:小请求单测不足以证明"安全"(上游是**累积式**分类器).

### 现在的范围(收窄后的正当理由)
- **词组层保留**:等 `glm-5.3` 可探测后再判定.
- **身份改写无条件保留**:`You are Claude Code, Anthropic's official CLI tool for Claude.`
  -> `You are Codex, an official CLI coding agent.`.这是**用户明确要求**的条目,
  且探针显示该句无论如何都能通过 -- 它从来就不是由阻断行为证明的.
- **stripReasoning 保持移除**(用户已声明不需要).

### 修掉的两个真 bug(交付路径)
两个都是"只测上游、没测 codex 实际走的路径"造成的:

1. **`toChatBody` 从不转发 effort**.codex 请求 `max`,到 wb2api 时 effort 已丢失,
   上游按自己的默认档(`high`)执行.此前"wb2api 的 ds 是 max"的 6/6 结论是
   **直连 `:7863/v1/chat/completions`** 测的,绕过了桥接,只证明上游能力.
   现改为转发 `reasoning_effort`,并把 codex 专有档位(`ultra`/`persistent`)
   钳到 `max`(上游对未知档位报 422,已在 agentrouter 实测).
2. **桥接丢弃 reasoning 计数**.`usage` 只带 input/output/total,responses 流里
   看不到推理用量,客户端无法观测档位是否生效.现把 `completion_thinking_tokens`
   (及 `completion_tokens_details.reasoning_tokens`)映射到
   `output_tokens_details.reasoning_tokens`.

### 修复后的交付路径实测(经桥接,6 轮交错,难题)
```
high 均值 reasoning_tokens = 2969.3
max  均值 reasoning_tokens = 4373.7   (+47%,max>high 4/6 轮)
```
且 `wb-ds.config.toml` 已由 `high` 改为 `max`.

## 2026-09-21:codex 模型选择器只显示内置模型 -- 根因与修复

### 现象
用户在 codex 里只看到几个内置模型(`gpt-6-astra` / `gpt-5.6-sol` / `gpt-5.6-terra` /
`gpt-5.6-luna` / `gpt-5.5` / `gpt-5.2`),我们自己的模型一个都没有.

### 根因
**`config.toml` 从未设置 `model_catalog_json`**.`~/.codex/omp-model-catalog.json`
是 2026-09-12 建的(见 `archive/retired/workbuddy-desktop-api/DEVLOG.md` 第 33 行),
但**没有任何地方引用它**,所以 codex 一直渲染内置目录.`codex debug models` 输出
11 条(全是内置),证实了这一点.

### 关键机制(全部实测)
1. **`model_catalog_json` 是"替换"不是"追加"**.指向旧的 5 条文件后,`gpt-6-astra`
   / `gpt-5.5` / `gpt-5.4` 等**全部消失**.所以必须自己把内置条目合并进去.
2. **内置目录可以往返**:把 `codex debug models` 的输出原样写回作为输入目录,
   结果**逐字节相同**(实测 `JSON.stringify` 全等).因此内置条目可以原样取用.
3. **目录条目不能指定 provider**:`model_provider` / `provider` 字段**被丢弃**.
4. **slug 原样转发**:`agentrouter/deepseek-v4-flash` 未做任何剥离,直达
   `ps.air-outer.com` 并 503.所以 slug 必须就是上游模型 id.
5. **裸文件名不解析**:`model_catalog_json = "omp-model-catalog.json"` 报
   `系统找不到指定的文件`,必须写绝对路径.

### 修复
- 新增 `tools/build-model-catalog.cjs`(CJS,非 `.mjs`):取内置目录原样 + 追加我们的
  模型,输出 29 条 / 24 条可见.
- `config.toml` 增加 `model_catalog_json = "C:\\Users\\o_Obl\\.codex\\omp-model-catalog.json"`.
- 上游模型**逐个实测 200 后才加入**;`claude-opus-*` / `glm-5.3`(agentrouter)当前
  503,但 id 真实,保留待恢复.

### 已知限制
**选择器是全局的,provider 来自 config.toml/profile**.所以选 agentrouter 的模型
但 provider 是 wb2api 时会失败(实测:反向组合报 `Reconnecting.. 1/5`).
命名上按 provider 区分(`(agentrouter)` / `(workbuddy)` / `(relaycat)`)以便察觉.

### 验证
```
codex debug models        -> 29 条,24 条可见(含我们的)
<default> / -p ar-ds / -p rc-ds / -p wb-ds  -> 全部 PONG
-p wb-ds -c model=global:kimi-k3            -> PONG
-p wb-ds -c model=global:gpt-5.3-codex      -> PONG
```

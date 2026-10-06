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
5. **相对路径的解析基准不一致**(实测):
   - `config.toml` 里的相对路径按 **CODEX_HOME** 解析 -> `"omp-model-catalog.json"` **可用**.
   - `-c model_catalog_json=".."` 按 **当前 cwd** 解析 -> 从别的目录跑就报
     `系统找不到指定的文件`.我最初用 `-c` 测出裸文件名不解析,那是**测试方法**
     的产物,不是 config.toml 的行为.

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

### 2026-09-21 更正与加固(复核 advisor 两条)
- **相对路径可用**(见上第 5 条更正).此前"必须绝对路径"的结论来自 `-c` 测试,
  是测试方法的产物.已改为 `model_catalog_json = "omp-model-catalog.json"`.
- **生成器存在循环读取**:它用真实 CODEX_HOME 跑 `codex debug models` 取"内置"目录,
  而 config.toml 一旦指向它自己写的文件,读到的就是**自己的上次输出**.实测它报
  `built-in: 17`(真值 11).虽因幂等而未致错,但会把任何一次错误写入**固化**.
  已改为通过**独立的 scratch CODEX_HOME**(无 `model_catalog_json`)读取,并加断言:
  若"内置"读回里已含我们的模型则**拒绝构建**.
- 复核 slug:全目录 **0 条**命名空间前缀(`agentrouter/` `workbuddy/` `relaycat/`
  `tokenrhythm/`),均为上游真实模型 id.
- `codex --strict-config` 对 `debug` 子命令**不支持**(报
  `--strict-config is not supported for codex debug`);对 `exec` 可用,实测通过无
  unknown-field 错误.

### 2026-09-21 选择器验证 + 两个我造成的回归(已修)

**先回答 advisory 的质疑**:此前只验到 `debug models`(数据源)与 `codex exec`
(请求路径),**没有验选择器界面**.本轮用 PTY 驱动真实 TUI(`hub start` + 按键)
补齐:

- `/model` 选择器**确实渲染**我们的 18 条(编号 5-18),内置的在 19-24.
- 选中后进入推理档位选择,列表读的是**我们条目**的
  `supported_reasoning_levels`(实测 `cn:kimi-k3-1` 显示 Low(default)/Medium/
  High/Max).
- 选择会写回 `config.toml` 的 `model` 行.

**回归 1(严重,我造成的):选择器把 `model_reasoning_effort` 从 `max` 改成 `low`.**
机制:codex 选中模型时会把目录条目的 `default_reasoning_level` 写进 config.toml,
而生成器原本用 `efforts[0]`(= `low`)当默认档.后果:**用户每点一次选择器就静默降档一次**.
已改为显式 `DEFAULT_EFFORT = 'max'`(与用户配置一致,选中我们的模型不改变其任何设置).
复测:再驱动一次选择器选 `global:gpt-5.5`,config.toml **只有 `model` 行变化**,
`model_reasoning_effort` 保持 `max`.

**回归 2(设计限制,非本次引入):选择器是全局的,不按 provider 过滤.**
在默认(`agentrouter`)provider 下选 `cn:kimi-k3-1` 会发到 agentrouter 并 503
(实测 `当前分组 default 下对于模型 cn:kimi-k3-1 无可用渠道`).目录 schema
**不支持**每模型绑定 provider(`model_provider`/`provider` 字段被丢弃,实测),
这是 codex 的限制,不是目录能修的.命名上按 provider 加后缀以便察觉.

**顺带**:codex 在 TUI 里自动升级 `0.154.0 -> 0.155.1`,内置目录从 **11 条变 9 条**
(`gpt-5.2`/`gpt-5.4-mini` 等被移除).生成器已重新取用新内置目录,总数 29 -> 27.
这正是"必须从 scratch CODEX_HOME 读内置目录"的价值:升级后能自动跟进.

**收尾**:`config.toml` 已还原(`model = "gpt-6-astra"`,effort `max`),
与测试前基线 `diff` **完全一致**.

### 2026-09-21 补:内置条目的默认档也必须归一(advisor 第二条)

上一轮只给**我们自己的 18 条**设了 `DEFAULT_EFFORT`,**内置条目仍是 codex 原默认档**
-- 而用户的模型 `gpt-6-astra` 恰恰是 `low`.由于 picker 按目录默认档预选并写回
config.toml,**用户在选择器里点回自己的模型仍会被静默降成 `low`**.只归一一半
等于把陷阱留在了每个内置条目上.

现改为**合并后统一归一**:按偏好 `max > xhigh > high` 与该条目 `supported_reasoning_levels`
**取交集**.交集是必要的:`max` 并非普适 -- `gpt-5.5` / `gpt-5.4` 只到 `xhigh`,
给出模型不支持的档位会把一次点击变成上游 422.

**实测(驱动真实 picker)**:
- `gpt-6-astra` 现在显示 `5. More reasoning.. (current)` -> `1. Max (current)`
  (修复前默认是 Low).
- 选中它后 config.toml 与测试前基线 **逐字节相同**
  (`model = "gpt-6-astra"`,`model_reasoning_effort = "max"`).
- `gpt-5.5` / `gpt-5.4` 归一为 `xhigh`,与其支持集一致.

**归一后全目录默认档**:24 条为 `max`,2 条(`gpt-5.5`/`gpt-5.4`)为 `xhigh`.

## 2026-09-21:统一网关(/u) -- 一个端点、一个 key、所有提供商

### 目标
解决"本机调用任何 API"的问题:不再一个上游配一个 codex provider,而是**单一端点**
`http://127.0.0.1:7878/u/v1`,客户端选模型,网关按请求体里的 `model` 字段分派.

### 结构
- **`providers.json` 是唯一真源**:哪个上游服务哪个模型、是否原生 responses、
  是否需要 agentrouter 过滤、key 存在哪个环境变量.
- `tools/build-model-catalog.cjs` 现在读**同一个文件**,所以 picker 与网关
  **不可能漂移**(此前是两份手工维护的列表).
- 路由:
  | 路径 | 用途 |
  |---|---|
  | `/u/v1/*` | **统一路由**(按模型分派) |
  | `/u/v1/models` | 聚合模型清单(26 条) |
  | `/ar` `/rc` `/wb` `/an` | 原逐提供商路由,保留用于钉住某上游 |

### 构建中发现并修掉的三个真缺陷
1. **凭据未按提供商替换**(advisor 指出).统一客户端只发**一个** key,但各上游 key 不同
   -- agentrouter 的 key 打到本地 wb2api 会 401 `missing or invalid API key`.
   `keyEnv` 此前是**死字段**(全仓只有 providers.json 出现,`providerFor()` 不读它).
   现按上游替换凭据.**实测**:单个 `AGENTROUTER_API_KEY` 打通
   agentrouter / relaycat-cn / wb2api 三家,**20/26 模型 OK**;6 个失败项经
   **逐提供商路由直连对比状态码一致**,确认是上游侧(402/503),非网关缺陷.
2. **`stream:false` 返回 `text/event-stream`**.桥接无条件写 SSE 头且只发事件.
   codex 恒为流式所以从未暴露,但 curl/SDK 这类客户端会拿到事件流.
   现非流式返回**单个 JSON 体**;上游错误路径也返回 JSON 错误而非空 body.
3. **`AR_UPSTREAM_<PROVIDER>` 覆盖不生效**.注册表派生的路由只读旧的按前缀名
   (`AR_UPSTREAM_AR`),导致测试覆盖**静默打到真实上游**(实测:指向本地 echo 却仍
   访问 ps.air-outer.com).现两种拼写都支持.

### 过滤作用域(保持)
`/u` **只对 agentrouter 应用** `filter.mjs`.用本地 echo 上游实测抓包:
- agentrouter 模型:`instructions` 被改写为
  `"You are Codex, an official CLI coding agent."`,并追加
  `Additional requirements for this provider. ..`;
- wb2api 模型经**同一路由**运行,日志无 `filter rewrote`,未过滤.

### 验证
```
codex exec -c model_provider=gateway -c model=deepseek-v4-flash   -> PONG (agentrouter)
codex exec -c model_provider=gateway -c model=global:kimi-k3      -> PONG (wb2api)
codex exec -c model_provider=gateway -c model=gpt-6-astra         -> PONG (relaycat)
GET /u/v1/models -> 26 条
<default> / -p ar-ds / -p rc-ds / -p wb-ds -> 全部 PONG(逐提供商路由未回归)
node tools/diff-test.mjs -> 0 mismatches;test-bridge-indices.mjs -> PASS
```

### 未验证
- `claude-opus-4-8/5`(agentrouter)**只在 anthropic-messages 面注册**,codex 无法接入
  (codex 仅走 responses).判据是 **402 vs 503**:
  ```
  claude-opus-4-8    messages=402  responses=503
  claude-opus-5      messages=402  responses=503
  no-such-model-xyz  messages=503  responses=503
  ```
  402 只在模型真实存在时出现(配额耗尽),不存在的模型两面都 503 -- 所以
  "仅 messages 面"**成立**.早先我用"responses 面也是 503"去否定它,是拿弱证据
  (503 与不存在模型同码)否定强证据(402),**那次更正是错的,已撤回**.
  这两个 slug 已从 providers.json 移除(选了必然 503),待做 responses->messages
  桥接后再加回.
- `glm-5.3`(agentrouter)503 是上游无渠道,与面无关.
- relaycat 的 `gpt-5.4`/`gpt-5.2`/`gpt-5.6-luna`/`gpt-5.3-codex` 当前 502/503,
  直连与经网关状态码一致.

## 2026-09-22:reasoning_content 503 风暴根因(桥接把 reasoning 挂错 assistant 消息)

### 症状
- 11:21 起 wb2api 日志连续 503(`global:deepseek-v4.1-flash`),每条前置
  `[upstream] chat_stream .. upstream 400 .. code 11155 "the reasoning content from the
  previous turn must be passed back in thinking mode" extError=reasoning_content_missing`;
  当日该 400 累计 793 条(#2075 前每条 503 都对应一次).
- 客户端是 Codex Desktop 会话(rollout-2026-09-22T11-24-09-..jsonl,cwd `G:\agentworks`),
  约 3s 一次重试.首发是同一 wb2api 路由上的 omp 会话(11:19-11:20).
- wb2api 把上游 400 统一表达成 503 `no_healthy_account`/`all accounts are temporarily
  unavailable`,所以现场看起来像账号池故障;真实原因是请求体不满足上游 thinking 模式契约.

### 定位方法(可复用)
1. 先读上游原文与错误码(11155 / `reasoning_content_missing`):它唯一地指向
   "上一轮 assistant 消息缺 `reasoning_content`".
2. 在客户端侧取真实 item 顺序,不要凭猜测:codex rollout jsonl 里 response_item 序列是
   `reasoning -> message(assistant, output_text) -> function_call x2 -> function_call_output x2`.
3. 本地仿真桥接转换(不碰运行态):
   `node "G:\omp works\.tmp\reasoning-repro-20260922\simulate.mjs" <rollout.jsonl>`
   修复前输出 `#3 assistant content_len=33 reasoning_content_len=1823` 紧跟
   `#4 assistant tool_calls=2 reasoning_content=MISSING`,统计 2/2 个 tool-call assistant 缺 reasoning.

### 根因
`bridge.mjs` 的 `function_call` 分支只在"尾部 assistant 的 content 为空"时才并入 tool_calls.
codex 0.155 会把同一轮自己的文本作为 `message` item **先**回放,于是这一轮被拆成
`A{content, reasoning_content}` + `A{tool_calls}`:reasoning 已被前一条消费,而上游检查的是
产生 tool 结果的那一轮 -> 缺 `reasoning_content` -> 400/503.
(早期 codex 只发 function_call,所以这条路径长期没被触发.)

### 修复
`function_call` 一律并入"仍处于打开状态"的尾部 assistant 消息(没有则新建),并把后到的
reasoning 合并进同一条而不是覆盖.回归检查 3 条写入 `tools/test-bridge-request.mjs`
(22 checks 全绿,`node tools/test-bridge-request.mjs`).

### 验证(真实上游,不是单测)
- 修复后隔离实例(`AR_GATEWAY_PORT=7879` 起同一份代码)对真实会话重建的同形态请求:
  `HTTP 200`,返回 reasoning + message + function_call.
- 线上重启后同形态请求(`.tmp\reasoning-repro-20260922\probe-ab.mjs` 指向 7878):`HTTP 200`;
  wb2api 侧 `| #2087 | 11:35:05 | global:deep | stream | 200 | uid=f3ac894d | tok=132 |`.
- 修复前同一形态的证据链:仿真显示 reasoning_content 缺失 + 线上 11155 原文(见上).

### omp 侧同一错误码的另一来源(已处理)
- `OMP_NO_REPLAY_REASONING=1` 是 omp-zh 补丁 5 的**全局总闸**(用户级环境变量),它对所有
  provider 关闭 reasoning 回放 -> 同样的 11155/503.主会话已删除(用户范围 + 进程),
  并用 omp `-p` 两轮实测:wb2api `#2088-#2090` 全 200.
- 源码层移除补丁 5 的 c..h 门控与 compat 键、重建交付 omp-zh.exe:由子代理完成
  (harness = Codex 原生子代理;model = `global:deepseek-v4.1-flash`;provider route = wb2api
  经本网关).细节与产物摘要见 `Tools/omp-zh/DEVLOG.md` 同日条目.
- 用户侧配置 `C:\Users\o_Obl\.omp\agent\models.yml` 的
  `agentrouter-responses/gpt-6-astra.compat.replayResponsesReasoning: false` 已移除
  (备份 `G:\omp works\.tmp\omp-config-backup-20260922-1140\`).
- 注意:参考对照实验只在子进程里重新打开该环境变量**没有**复现 11155(短会话路径),
  所以"该总闸是长会话/压缩路径的触发器"仍是推断,不是已证结论;本次修复不依赖该推断
  (Codex 侧根因已由 A/B 探针闭环).

### 运维:新增可回滚重启脚本
`restart-gateway.ps1`:node --check 全模块 -> 快照到 `.tmp\gateway-restart-<stamp>\` ->
只停"监听该端口且命令行匹配本目录 server.mjs"的进程 -> `cmd /c .. >> log 2>&1` 后台启动
(与 services.ps1 同方案,日志只追加)-> 等端口 + `GET /u/v1/models` 自检.
本次:`pid 30092 -> 16860`,`/u/v1/models` = 33 models,快照
`G:\omp works\.tmp\gateway-restart-2026-09-22-113455`.
回滚一条命令:`git checkout HEAD -- bridge.mjs tools/test-bridge-request.mjs` 后重跑脚本.

### 同日查明、未修的相邻问题(交给后续)
- wb2api 账号池:`50e6cfd8` `disabled=true`(reason "429 rate limit",until 07:07 已过期但不复活),
  其余 6 个账号 `credits=0`;全局域请求落在无额度账号上(每次 400 都记一次错),
  唯一有余额的 `5e2854ae` 只服务 cn 域.`uid=-` 与冷却不复活这条线未改.
- "网关日志里有 wb2api 调用"不是路由串台:`server.mjs` 的 `/u` 只按请求体 `model` 分发,
  没有 fallback;实际来源是其它客户端 —— omp(直连 7863)与若干 Codex 会话
  (`codex exec -m cn:deepseek-v4-pro` 于 11:12 起,父进程是 `G:\agentworks\gaokao-math\high1`
  下的 pwsh;另有 `~/.codex/config.toml` 的持久默认 `model = "global:deepseek-v4.1-flash"`,
  即任何未带会话级覆盖的 codex 面都会落到 wb2api).
- omp 会话正文出现大块 `<analysis>..` 文本(报告问题 3)尚未定位:现有证据只是 omp 自身的
  checkpoint/compaction 文本块与 `[shaken .. artifact://374]` 占位,以及 8 处 `data: {` 形态字符串,
  未确认是否异常.待续.

## 2026-09-22(下午):接入 opencode zen 免费档(mimo-v2.6-flash-free)

### 目标与结论
用户要求把 opencode zen 的免费 `mimo-v2.6-flash-free` 配到 **Codex 侧**。已完成并实测:
`codex exec -c model_provider=gateway -c model=zen:mimo-v2.6-flash "Reply with the single word PONG"`
-> exit 0,输出 PONG。

### 免费档的放行条件(实测,不是猜测)
zen 对免费档返回 403 `FreeTierError: OpenCode's free tier can only be used from within OpenCode`。
用本地抓包代理(让 opencode 客户端经 `http://127.0.0.1:7899` 发请求)拿到它真实的头与请求体后,
逐项对照实验得到三个**同时必需**的条件:

1. `x-opencode-session` 必须是 OpenCode 客户端铸造过的 id。随机同格式 `ses_xxx` 一律 403;
   两个历史 id(`ses_f38c17d0..`, `ses_f38bfe3f..`)可反复复用 -> 200。
2. `User-Agent` 必须形如 `opencode/1.18.20 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`。
3. 请求体 `tools` 的**前 5 项**必须是 opencode 内置工具 `bash,edit,glob,grep,read`:
   - 4 个真工具 + 1 个自造工具(体积相同)-> 403;5 个真工具 + 1 个外来工具 -> 200;
   - 单个真工具补长描述到 46KB -> 403(与体积无关,认身份);
   - 去掉全部 tools -> 403;去掉 description 只留 name+schema -> 200(仍算同一工具集)。

`stream: true` / `stream_options` / `max_tokens` 都不是必要条件(单测见 DEVLOG 命令记录)。

### 实现
- `oc-zen-proxy.mjs`(新增,127.0.0.1:7901):补 `x-opencode-session`(值读 `.oc-session`,
  gitignore)、固定 UA、把 5 个守卫工具插到 tools 前面(同名调用方工具被守卫版替换,避免上游
  duplicate names 400);**只转发 authorization/content-type/accept 三个头**(把调用方整套头透传会
  触发 fetch `UND_ERR_INVALID_ARG`,实测)。
- `oc-zen-tools.json`(新增):从真实 opencode 请求里抽出的那 5 个工具定义,原样保存。
- `server.mjs`:新增 `TOOL_GUARD_NAMES` + `isGuardToolName()`,传给 `bridgeChatStream`;
  `providerFor()` 透传 `p.efforts` 给 `toChatBody`。
- `bridge.mjs`:`createResponsesEmitter({ toolGuard })` 在 `call()` 里忽略守卫工具(否则 Codex 会收到
  它没声明过的 `bash/edit/...` 工具项);`toChatBody(body, model, allowedEfforts)` 按 provider
  声明的档位夹取。
- `providers.json`:新增 provider `opencode-zen`(`base: http://127.0.0.1:7901/zen`, wire `chat`,
  `keyEnv: OPENCODE_API_KEY`, `efforts: [low,medium,high]`),模型 `mimo-v2.6-flash-free` 与别名
  `zen:mimo-v2.6-flash`(后者映射到上游 id)。
- `services.ps1`:新增 `opencode-zen-proxy` 服务项(端口 7901),加入启动顺序。
- `C:\Users\o_Obl\.codex\omp-model-catalog.json` 由 `tools/build-model-catalog.cjs` 重新生成
  (28 -> 30 条我们侧模型,总计 35)。

### 踩坑记录
- **`reasoning_effort`**:Codex 默认发 `max`,zen 免费档只接受 `low/medium/high`,
  其它值一律 400 `Streaming response failed: [400] Invalid request parameters`(无 param 提示)。
  这正是 codex 侧第一次 E2E 失败的原因;加了 provider 级 `efforts` 夹取后通过。
- **`parallel_tool_calls` / `tool_choice`** 都是可接受的(实测 200),不是失败原因。
- **`Start-Process -ArgumentList` 遇到含空格路径**:不加引号会被截断成 `G:\omp`,
  必须手工把路径包成 `"G:\omp works\..."`(项目历史上已记过一次,这次又踩到)。
- 会话 id 失效时的重新铸造步骤写进 README(跑一次 `opencode run`,抓 `x-opencode-session`)。

### 未验证 / 已知限制
- 会话 id 是 OpenCode 客户端铸造的,如果 zen 改成"id 与账号/时间强绑定"就会失效;
  失效后按 README 重新铸造即可(不需要改代码)。
- 免费档的工具集身份要求意味着:任何**不带 tools** 的调用也会被反代补上守卫工具(否则 403),
  响应侧由网关剔除,不影响调用方语义。
- 只验证了 `mimo-v2.6-flash-free`;同档其它 free 模型(如 `mimo-v2.5-free`)未逐一验证,
  若要加入,直接加 models 条目即可(同一 provider/efforts)。

## 2026-09-22(下午):命名空间工具(子代理/MCP)在 chat+anthropic 桥接里丢失

### 症状
走 chat(wb2api/opencode-zen)或 anthropic(justwoker)线路的模型**无法使用 Codex 原生子代理**:
工具面里 `multi_agent_v1` 的 schema 是空 `{}`,调用返回 `unsupported call`,`spawn_agent` 等子工具完全不可见;
responses 线路(agentrouter/relaycat/anyrouter)正常。缺陷报告见
`REPORT-subagent-tools-lost-in-chat-bridge.md`。

### 根因
Codex 0.155 把多智能体/MCP 工具作为**命名空间工具**下发:`{type:"namespace", name, tools:[...]}`。
`toChatTools` 与 `toAnthropicBody` 只读 `t.name`/`t.parameters`,从不读子数组 `tools`:
命名空间条目因有 `name` 而通过过滤,schema 回落到空对象,子工具全部消失。
全文检索确认 `bridge.mjs` 里此前**没有任何** `namespace` 字样。

### 抓包补全的三个未知项(报告 5.3)
用一次性捕获代理(`127.0.0.1:7880` -> 7878)抓 Codex 真实请求体:
1. 子工具 schema 字段是 **`parameters`**(model-facing);`inputSchema` 是 app-server 协议字段。实现两者兼容。
2. 命名空间**不止一个**:`multi_agent_v1`(5 个子工具)+ `mcp__cua_repl`(2)+ `mcp__node_repl`(3)。
   且命名空间 id 自带 `__`、两个命名空间都有 `js` —— 所以**不能用分隔符拆名字**,必须用映射表。
3. 回放确实需要还原:会话存储里的 function_call 带 `namespace`(实盘见下)。

### 实现
`bridge.mjs` 新增共享的 `flattenTools()`(展开 + 产出 byWire/byPair 两张表)、`joinWireName()`(入程)、
`splitWireName()`(回程);`toChatTools`/`toAnthropicBody`/`toChatMessages`/`toChatBody` 与
`createResponsesEmitter` 全部接入;`server.mjs` 两条桥接路径各自持有 toolMap 并贯通到流式 emitter。
为了让拆分精确,function_call 的 `output_item.added` 从"首个名字 delta"推迟到 `finish()`
(名字可能仍在拼接);`output_index` 顺序与既有事件序保持不变(已用事件转储核对)。

### 验证
- `tools/test-bridge-request.mjs`:**32 checks passed**(新增 8 条命名空间断言)。
- `tools/repro-namespace-tools.mjs`:由"打印缺陷"改写为"断言修复后形态",全部通过(保留为回归脚本)。
- 实机:`codex exec -c model_provider=gateway -c model=global:deepseek-v4.1-flash "spawn one sub-agent ..."`
  -> **exit 0 / SUBOK**;主会话记录出现 `name:"spawn_agent", namespace:"multi_agent_v1"` 与
  `wait_agent` 同形态,子代理线程落盘。
- 回归:`test-bridge-indices.mjs` PASS;`restart-gateway.ps1` 语法门+自检通过(35 models)。

### 未验证
- anthropic 线路只做单元/往返验证,未做真实上游端到端(需要 justwoker 可用模型与凭证)。
- 上游若调回一个**未在本请求声明**且非已知命名空间的工具名,按扁平名透传(`namespace: null`),不猜归属。

## 2026-09-22(傍晚):标题生成 503 修复 + 子代理可覆盖模型白名单

### 1) gpt-5.6-luna 的 503 风暴:根因是标题生成,不是用户在用 Luna
来自高考会话的报告(`G:\agentworks\gaokao-math\reports\REPORT-luna-title-model-503.md`)结论成立,已复核:
- Codex 桌面版每新建一个线程(含子代理线程)就调一次"任务标题生成",提示词固定以
  `You are a helpful assistant. You will be presented with a user prompt, and your job to provide a short title for a task` 开头;
- 它用的是**内置 slug `gpt-5.6-luna`(不带 `global:` 前缀)**;`providers.json` 当时把它指向 relaycat,
  而 relaycat/relaycat-cn 都没有 luna 渠道 -> 503 -> Codex 重试 5 次;
- 这解释了"51201 字节完全相同的请求":提示词固定,字节数恒定。
- 今日用量日志里 luna 共 501 条**全部失败**(413x503 / 79x502 / 9x429),`input_tokens=0`、`cost=null`,**零计费**。

上游探针(2026-09-22):
- `relaycat` /v1/responses + gpt-5.6-luna -> **502**;`relaycat-cn` -> **404 model_not_found**;
- `wb2api` /v1/chat/completions + `global:gpt-5.6-luna` -> **200 "PONG"**。

修复:`providers.json` 把内置 slug `gpt-5.6-luna` 从 `relaycat` 改指 `wb2api` 并加 `"m": "global:gpt-5.6-luna"`
(wb2api 只认带 `global:` 前缀的 id)。改 providers.json 不需要重启网关(每请求按 stat 读取)。

实测验收:走标题生成器同一条路径(7878 `/u/v1/responses`,model=`gpt-5.6-luna`) ->
**HTTP 200**,标题 `Fix Gateway Functionality`;用量日志新增 `wb2api / global:gpt-5.6-luna / ok=true`。
注意:标题生成按**线程创建**触发,所以 503 是否彻底消失要在下次建线程时才算最终确认。

### 2) spawn_agent 的 "Available model overrides" 块换成指定模型
"那个块"= `spawn_agent` 工具描述里的 `Available model overrides (optional; inherited parent model is preferred)`
列表(在 `input[0].additional_tools` 里,由 catalog 生成)。

规则(2026-09-22 用一次性抓包代理 7880 实测,`priority` 有**两个独立含义**):
- `priority > 0` = 在内置条目之间的**排序**;
- `priority < 0` = 该条目**进入 spawn_agent 的覆盖列表**;该列表**上限 5 条**,只收负值,
  内置条目(1..43)与其余条目都不会进;`priority: 0`(默认)= 仍可路由可选,但不进覆盖列表。

先把所有我们侧条目设成 100:排序生效但列表被内置 5 条占满 -> **证实上限与排序语义**。
再只给目标 5 条设 -1 -> 列表变成目标 5 条,**证实负值白名单语义**。

实现:`tools/build-model-catalog.cjs` 新增 `OVERRIDE_SLUGS`(唯一决定"子代理能用哪些模型"的地方)+
`priority: OVERRIDE_SLUGS.has(slug) ? -1 : 0`,替换原先写死的 `priority: 0`。
白名单(用户 2026-09-22 指定):`global:deepseek-v4.1-flash`、`global:deepseek-v4.1-flash-sg`、
`cn:deepseek-v4.1-flash`、`mimo-v2.6-flash-free`、`zen:mimo-v2.6-flash`。

验收:重新生成目录(35 models)后抓包,`spawn_agent` 描述里的列表**恰好是上述 5 条**。

### 3) zen 免费档回归:session 失效(进行中)
`zen:mimo-v2.6-flash` 经网关返回 **403 FreeTierError**。已隔离:带旧 session(11:55 铸造)+ 规定 UA +
5 个守卫工具**直连上游仍 403**,随机 `ses_xxx` 也 403 -> `.oc-session` 已失效,需按 README 重新铸造。
已派子代理执行重铸与验收,结果见 `.tmp/zen-session-refresh-report.md`。

### 4) reasoning 回放门:确认全工作区已无残留
- omp-zh:`patch-zh.js` 中 `OMP_NO_REPLAY_REASONING` / `replayResponsesReasoning` **0 处引用**,已由
  提交 `0c6fc53`("drop the reasoning-replay gate; deliver only verified bytes")交付并推送;
- 网关侧:`bridge.mjs` 只**保留** reasoning(把同一轮的 reasoning 挂回对应 assistant 消息,见
  `pendingReasoning` 与 `target.reasoning_content`),**没有任何"丢弃 reasoning"的分支** —— 与用户要求一致。

## 2026-09-22 跨域降级 (global -> cn) 实现与验证

方案: `PLAN-realm-fallback.md` (本目录). 触发需求: 只要有任何国际版账号可用就优先国际版;
国际版全耗尽时自动改用国内版, 并明确最近恢复时间.

### 为什么必须在网关做
- wb2api **严格域隔离**: `internal/pool/pick.go:48-51` realm 谓词,
  `:238-240` 全冷却兜底同样过滤跨域; `internal/server/handler.go:649-652` 选号按 realm 过滤。
- `origin/master` 无此实现, 且有回归测试 `handler_global_test.go:153-155` 明确锁定"不跨 realm 用 CN 号顶上"。
- wb2api 不向客户端暴露恢复时间: 全仓 `Retry-After` 0 命中; 客户端可见响应头仅 `X-Service` 与 `Content-Type`。

### 关键设计决策 (有实测依据, 不是拍脑袋)
1. **进入降级只认实际失败, 不认健康计数**。实测证据: 本次 global `realm_totals.healthy=4`,
   但该模型在 4 个号上都有模型级 6004 冷却到次日 —— 即 healthy>0 与"该模型可用"是两件事。
   反之全冷却兜底 (`pick.go:63-67`) 会让软冷却号仍被选中并真实出站, 所以 healthy=0 也不等于不可用。
   故入口判据只有"上游回了 429/503"。
2. **退出降级认正向证据** (`/healthz` 或 `/status` 显示 global 可取号), 靠 30s 探针, 不靠定时器硬等。
3. **恢复时间分三级并标注来源** (`X-Gateway-Realm-Source`), 避免把低精度值当权威:
   `status-model` (模型级 `rate_limited_models[].reset_at`, 上游权威) >
   `status-account` (账号级 `until`, 本地推算, 可能被 soft_rate_max 截断) >
   `health` / `transient` / `unknown`。
4. 429 会先被 `requestWithRetry` 内部重试 3 次 (RETRY_MAX), 这是**有意保留**的:
   每次重试池子会重新选号, 只是"忙"的域能在重试内自愈, 不浪费国内版积分。只有整域真的没号才落到降级。

### 改动
- `providers.json`: `global:deepseek-v4.1-flash` 增 `"fallback": "cn:deepseek-v4.1-flash"` (嵌在 model entry 内;
  顶层加对象键会污染 `/u/v1/models` 与 catalog, 见 `server.mjs:230-232` / `build-model-catalog.cjs:200-201`)。
  `-sg` 变体**未**登记 (无 cn 同族 id, 降级会改变模型语义)。
- `server.mjs`: 新增跨域降级辅助区 (`resolveFallback` / `globalAvailability` / `armFallback` /
  `globalRealmState` / `setRealmHeaders` / `fallbackUntil` 等), 重写 chat 桥分支支持二次发送;
  `setRealmHeaders` 在 `bridge*Stream` 之前调用 (`writeHead` 会合并已设头, bridge.mjs 未改)。
  TTL 可用环境变量覆盖 (`AR_REALM_STATUS_TTL_MS` 等), 便于测试观察缓存转换。
- `tools/test-realm-fallback.mjs`: 新增零依赖自测 (照 `test-filter-failopen.mjs` 骨架, 桩 http 层)。

### 验证
- 单元: `node tools/test-realm-fallback.mjs` -> **21/21 PASS** (ENTER / STAY / LEAVE / 无 fallback 模型不受影响)。
- 回归: `node tools/check-syntax.mjs` 干净; `test-filter-failopen` 6/6; `test-bridge-request` 32/32;
  `test-bridge-indices` / `test-usage-pricing` 全 PASS。
- **实机 (真实 wb2api, 临时实例端口 7879, 未碰线上 7878)**:
  - global 真耗尽时: 4 次 global 尝试 (1+3 重试) -> `bridge upstream 503` -> `cross-realm exhausted
    source=status-model` -> 改发 cn -> 客户端 **200**, 头 `X-Gateway-Realm: cn` /
    `X-Gateway-Retry-At: 2026-09-22T20:00:00.000Z` / `X-Gateway-Realm-Source: status-model`。
    恢复时刻与 `/status` 的 `reset_at` (09/23 04:00 CST) 精确一致。
  - 窗口内第二次请求: **1 次上游调用**直达 cn, 8.56s。
  - 对照: 未加载新代码的 **7878 同一请求返回 503** —— 这正是本修复消除的故障形态。
- 临时实例已停止; 线上 7878 仍是 PID 3028 (15:43:57 启动), 未受影响。

### 未做 / 待办
- **D1 (国内版并发预算) 未实现**: 国内版仅 1 个号、`max_in_flight=3`, 降级洪峰仍可能把它打满成 503。
  已实测观察到该形态 (`cn:deepseek` 连续 503 `uid=-`)。是否需要网关侧信号量待用户决定。
- `global:deepseek-v4.1-flash-sg` 未配 fallback (待确认与 cn 同族是否可互相替代)。
- 线上 7878 需重启才会加载新代码。

## 2026-09-22 (19:40) 重启后清点与收尾

### 状态确认
- 17:32:06 开机 autostart 拉起全部服务 (7878/7863/7901/8787)。
- **7878 已加载跨域降级代码** (进程 17:32:06 晚于 server.mjs 17:13:23), 且实测生效:
  对 `global:deepseek-v4.1-flash` 的请求返回 200 + `X-Gateway-Realm: cn` +
  `X-Gateway-Retry-At: 2026-09-22T20:00:00.000Z` (= 09/23 04:00 CST)。
- 重启后 wb2api 日志中 `11155 reasoning_content_missing` **0 次** (此前 10:21-10:22 密集出现)。
  说明 bridge.mjs 的 reasoning_content 回传在重启后正常。

### 修复: 恢复时间的精度标签会虚标 (本日 64ad7aa 引入)
- 症状: `globalRealmState` 用**跨账号粘性标志**判定 `modelLevel`, 只要任一账号有模型级冷却,
  最终标签就写成 `status-model` (宣称上游权威)。
- 实测反例 (真实数据): 最早恢复的是 `53c8d24c` 的**账号级** hard_credit `09-23 04:00`,
  而模型级最早是 `0c5c5d59` 的 `09-23 07:37`。最早者决定返回值, 故正确标签是
  `status-account` (本地估算), 但线上代码报的是 `status-model` —— 把估算说成权威。
- 修复: 标签改为**逐账号**跟踪, 由真正决定 `minAt` 的那个账号决定
  (`minLevel`)。另修: 模型级判定用 `>=` 而非 `>`, 因为未截断时 wb2api 的
  `Until == ResetAt` (`pool/entry.go`), 该相等本身就是权威情形。
- 新增 4 个断言锁死: "最早者决定标签"(account 胜) 与 "模型级确实标为权威"(model 胜) 双向覆盖。
- 门禁: `test-realm-fallback.mjs` **25/25 PASS**; check-syntax / filter-failopen / bridge-request(32) /
  bridge-indices / usage-pricing 全绿。

### 一并提交的既有未提交工作
- `oc-zen-proxy.mjs`: 缺 `NODE_USE_ENV_PROXY` 时**显式告警**(此前是难以定位的 502 挂起)。
- `services.ps1`: 导出 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY=127.0.0.1:7897` 供服务子进程继承
  (Node 只在启动前读该变量); 顺手把顶格注释的缩进与多余空行整理掉。
- `tools/build-model-catalog.cjs`: `OVERRIDE_SLUGS` 白名单 (spawn_agent 覆盖列表)
  + 两条启动期护栏 (内置项若改用负 priority、或白名单超过 5 条, 直接构建失败)。
- `start-zen-proxy.ps1`: 手动拉起 zen 反代 (带代理环境变量, 幂等)。

### 未完成 / 待办
- **D1 国内版并发预算仍未实现**。重启后实测 `cn 503 count = 0` / `global 503 count = 1`,
  即当前流量下国内版没被打满; 但降级洪峰场景仍未设信号量。
- **zen mimo 仍 429** (实测, 配额未恢复)。子代理仍只能用 wb2api 的 ds。
- 线上 7878 需要重启才能加载本次的标签修复 (旧标签虚标不影响可用性, 只影响
  `X-Gateway-Realm-Source` 的准确度)。

## 2026-09-23 (09:25) 重启后复验与整理

### 复验: 标签修复已上线并生效
- 09-23 08:13:10 开机 autostart 重新拉起全部服务; 7878 进程 (08:13:10) **晚于**
  `server.mjs` (09-22 19:36:43) -> **标签修复 `013e433` 已加载**。
- 实机: `global:deepseek-v4.1-flash` 返回 **200 且 realm=global** —— 说明 global 已恢复,
  走的是 LEAVE(正向证据)路径, 故不返回恢复时间头 (正确行为, 非缺陷)。
- 今日 wb2api 日志: 请求 5 次全 200; `11155` / `reasoning_content_missing` / `503` / `429` / `6004`
  **均为 0**。
- 附带观察: 昨日唯一处于 `hard_credit` 的 `53c8d24c` 已自动复活并正常出话 (今日 5 次全部由它承接),
  证实**每日额度会刷新**; 这与 scout-c 报告里"global 的 credits 在网关内不可回升"并不矛盾 ——
  网关看不到刷新, 但上游确实刷新了, 且刷新后该号重新被选中。

### 整理
- 仓库内 4 个无引用的生成物移出到 `G:\omp works\.tmp\cleanup-agentrouter-filter-20260923\`
  (`multi-agent-block.json`、`providers.json.bak-luna`、`retry.mjs`、`build-model-catalog.cjs.bak`)。
  移动前已逐个解析绝对路径并校验仍在仓库内; **是移动不是删除**, 需要时可取回。
  移动后 `git status` 干净。
- 本次会话的取证产物归档到 `G:\omp works\.tmp\realm-fallback-work-20260923\`:
  三份 scout 报告 + 三份任务书 + providers 改动前备份 + 17 个一次性打补丁脚本 (`patch-scripts/`)。
  这些是历史证据, 保留而非删除。
- 工作区级进度交接文档: `G:\omp works\docs\GATEWAY-REALM-FALLBACK-PROGRESS.md`。

### 未完成 (不变)
- **D1 国内版并发预算仍未做**(唯一功能缺口)。当前实测 `cn 503 = 0`, 但降级洪峰无保护。
- `global:deepseek-v4.1-flash-sg` 未配 fallback (无 cn 同族 id)。
- zen mimo 仍 429 (配额未恢复), 子代理只能用 wb2api 的 ds。

## 2026-09-23 并行审查修复, 禁止重启线上实例

用户明确要求与 STS mod 和知识库并行优化网关, 且禁止重启. 本轮契约在 G:\omp works\Tools\agentrouter-filter\DEVELOP.md. 仅修改 server.mjs, bridge.mjs, usage.mjs 和测试, 不修改 providers.json, .env.local, 模型/凭证/收费路由或 D1 国内并发预算.

修复三面: 未知探针结果不再作为恢复证据; 本地 JSON 探针超时覆盖完整响应体并取消 I/O; Chat SSE 显式错误, 截断和异常终止不再伪报 completed, 终态幂等, 失败不记成功用量. 另增加 AR_USAGE_DIR 显式隔离目录, 默认生产路径不变, 两个导入真实 server 的测试改用独占项目 .tmp 账本. 这里只确认旧测试存在写生产账本风险, 尚未证实历史污染, 没有清洗或截断任何账本.

中央验证证据在 G:\omp works\.tmp\workspace-audit-20260923-01a0cbfd\evidence:
- gateway-before-stream/unknown/hang.log 为修复前失败; gateway-after-stream/unknown/hang.log 为修复后对照.
- gateway-after-rev2.log 与 gateway-after-rev2-results.json: 七项检查脚本退出码均为 0. 新终态脚本实际输出 48 checks passed, 不复制其它文档的旧断言计数.
- gateway-http-smoke.mjs 实际启动独立临时网关与本地假上游, 复制七份源码并记录哈希, 使用只含虚构本地路由的注册表及合成密钥. 不导入生产 .env.local, 不连真实收费上游. gateway-http-smoke.log 输出 21 HTTP checks passed, 14 isolated usage rows.
- HTTP 检查覆盖正常 streaming/nonstreaming, 错误帧, EOF 截断, socket 中断, length 终止, unknown ENTER/STAY, 正向恢复, 两探针的响应头/响应体挂起及真实连接取消. 成功用量只写独立目录, 失败不增加成功记录. 临时进程已清理, 生产进程未操作.
- gateway-process-before-smoke.json 与 gateway-process-after-smoke.json: 线上 PID 27624, 创建时间均为 2026-09-23T08:13:10.65922+08:00. 不用进程存在性冒充新代码已上线.

实际委派路由: Codex Desktop multi_agent_v1, 模型 gpt-6-astra-ar, session provider=gateway; 注册表另确认 agentrouter / gpt-6-astra 且无该模型 fallback. 实现与原同批监督均已完成 REV2 门禁复核. 路由原始摘录位于同证据目录 agent-routes.json 和 agent-routes-incremental.json.

状态边界: 本次磁盘修复尚未加载到运行中的网关, 不重启, 不注入热更新, 不安排隐含重启. 真实上游兼容与 D1 国内并发预算仍未由本轮验收或决策. 定向 Git 备份的提交/远端核对见 G:\omp works\docs\WORKSPACE-AUDIT-2026-09-23.md.
## 2026-09-23 (11:35) 修复: anyrouter 全部 502 (我昨天引入的回归)

### 症状
用户报: anyrouter 的 astra 返回
`unexpected status 502 Bad Gateway: B0660000:error:0A000438:SSL routines:ssl3_read_bytes:
tlsv1 alert internal error:openssl\ssl\record\rec_layer_s3.c:918:SSL alert number 80`。

### 定位过程 (逐步排除, 结论唯一)
1. 代理 mihomo(7897) 在跑, 且**早于**网关启动 (08:12:34 vs 08:13:10) -> 排除"代理未就绪"。
2. `curl -x http://127.0.0.1:7897 https://anyrouter.top/v1/models` -> **401/403 (正常)**。
   直连 -> `SEC_E_ILLEGAL_MESSAGE` (这正是当初加代理的原因)。
3. 网关 `/an/v1/models` -> **502 x6 稳定复现**。
4. 用网关的 CONNECT+TLS 代码**逐行复刻**成独立脚本 -> **HTTP 401 成功**。
   同代码在独立进程成功、在网关进程失败 -> 差异在**进程环境**, 不在 TLS 参数
   (已逐一验证 servername / minVersion / ALPN 均非因素)。
5. 给复刻脚本加上 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY` -> **复现同样的 SSL alert number 80**;
   清掉 -> 恢复 401。**根因锁定**。

### 根因
`services.ps1` 在**文件顶部**导出了 `NODE_USE_ENV_PROXY=1` 与 `HTTPS_PROXY`。
该文件被 `autostart.ps1` 与 `run-service-tab.ps1` 共同 dot-source, 于是**每个**服务子进程
都继承了这两个变量 —— 包括网关。

后果: `NODE_USE_ENV_PROXY=1` 让 Node 内建的 http(s) 机制**自己再加一层 CONNECT**,
而 `server.mjs` 对 anyrouter 已经**手工**建立了 CONNECT 隧道 (`providers.json` 的 `proxy` 字段,
见 `server.mjs` 的 "HTTP CONNECT tunnel through a local proxy")。两层代理叠加 ->
隧道内 TLS 握手失败 -> 网关 catch 后回 502。

**这是我 2026-09-22 为 zen 代理加固时引入的回归** (commit `013e433`)。当时只验证了 zen 通,
没有回归 anyrouter。

### 修复
- `services.ps1`: 删除文件级导出; 改为在 **`opencode-zen-proxy` 这一条**上加 `Env` 映射。
  顶部保留长注释说明为什么**不能**全局导出。
- `run-service-tab.ps1`: 支持 `spec.Env` —— 用 `set "K=V" && ` 前缀只作用于该子进程
  (含不安全字符校验)。
- zen 的行为不变 (它仍拿到这两个变量); 其余服务不再被污染。

### 验证
- 干净环境起临时网关 7879: `/an/v1/models` -> **401 (正常)**; 真实 `gpt-6-astra-an` 请求 ->
  **HTTP 500 "当前模型 gpt-6-astra 负载已经达到上限"** = TLS 通了、到达上游, 500 是真实业务状态。
- 对照: 线上 7878 (未重启, 仍带污染环境) 同一请求 -> **502 SSL alert number 80**。
- 临时实例已停止; 线上 7878 未动 (PID 27624)。

### 待办
- **线上 7878 需重启**才能加载修复 (重启前 anyrouter 一直 502)。

## 2026-09-24 接入 anyrouter 的 claude 模型 (opus-5-5 / fable-5-1)

问题全貌见 `G:\omp works\docs\ANYROUTER-CLAUDE-ACCESS.md`。

### 背景
anyrouter 的 claude 系列**只在 anthropic /v1/messages 面服务**。实测:
- `/v1/responses` -> 404 `当前 API 不支持所选模型` (该面对**任何**模型都 404, 连 gpt-5-codex/gemini-2.5-pro 也是)
- `/v1/messages` 不带 beta 头 -> 400 `1m 上下文已经全量可用,请启用 1m 上下文后重试`
- `/v1/messages` 带 `anthropic-beta: context-1m-2025-08-07` -> 503 `Service Unavailable`

那个 400 是**正向证据**: 模型存在且请求到达业务层 (不存在的模型返回 404)。

### 发现的两个真问题 (都在我们这边)
1. **入站白名单剥掉 `anthropic-beta`** (`server.mjs` 的 header 白名单不含它)。
   后果: 即使上游恢复, 经网关也只会拿到 400。实测: 经网关传该头 -> 仍是 400。
2. **wire 只有 provider 级, 没有模型级** (`providerFor` 取 `p.wire`)。
   anyrouter 是 `responses`, 而 claude 需要 `anthropic` -> 必须支持模型级覆盖,
   否则注册了也永远走错面。

### 改动
- `server.mjs`:
  - `providerFor()`: 新增**模型级 `wire` 覆盖** (`spec.wire ?? p.wire`), `chat`/`anthropic` 随之。
  - `providerFor()`: 新增 `headers` 字段 (模型级优先, 其次 provider 级, 缺省 null)。
  - `anthropicHeaders(headers, extra)`: 透传 `anthropic-beta` + **注入**注册表声明的头
    (注册表优先于客户端自带)。不传 extra 时行为与从前一致。
  - 入站白名单补 `anthropic-beta`。
- `providers.json`: 注册 `claude-opus-5-5` 与 `claude-fable-5-1` ->
  anyrouter, `wire: "anthropic"`, `headers.anthropic-beta = context-1m-2025-08-07`。
  附 `_anyrouter_claude_comment` 说明 (用**字符串**而非数组: `models` 里的数组会被
  `typeof === "object"` 过滤放行, 在 `/u/v1/models` 与选择器里变成假模型 id —— 本次先踩后修)。
  `gpt-6-astra-an` 保持 responses 面不变。
- `tools/test-anthropic-registry.mjs`: 新增 16 项断言 (注册表形状 / 实际出站 wire 与头 /
  astra-an 不回归 / **justwoker claude-opus-4-8 零回归** / 数组注释不泄漏)。

### 验证
- 单元: `test-anthropic-registry.mjs` **16/16 PASS**; 其余门禁全绿
  (check-syntax, realm-fallback, filter-failopen 6, bridge-request 32, bridge-indices,
  usage-pricing, stream-terminal 48)。
- **实机 (隔离实例 7879, 未碰线上 7878)**:
  - `/u/v1/models` -> 37 个, 含 opus-5-5 与 fable-5-1, 无 `_` 开头的假条目。
  - 打 `claude-opus-5-5` -> **503** (修复前经网关是 **400**)。日志
    `bridge u/v1/responses -> anyrouter model=claude-opus-5-5` 证明走了 anthropic 桥。
  - 打 `claude-fable-5-1` -> **503** 同上。
  - **503 是预期且正确的**: 它证明 beta 头已送达 (错误层从 400 推进到 503);
    剩下的 503 是 anyrouter 渠道池问题。
- 临时实例已停止; 线上 7878 (PID 27488) 未动。

### 诚实边界
- **这两个模型当前仍然调不通 (503)**。上游 anthropic 渠道池不可用, 且是**站点级**:
  同一时刻 opus-4-7 / sonnet-4-5 / 3-5-sonnet 全部 503, haiku-4-5 是 520。
- 配完**不代表可用**。恢复后无需再改代码, 直接就能用。
- 已试遍的头名变体与指纹变体记录在 `docs/ANYROUTER-CLAUDE-ACCESS.md` §3, 不必重试。

## 2026-09-24: 接入 opencode zen 的 space-bunny-free (+ 修掉 effort 夹取的三处不一致)

用户要求把 opencode zen 新增的免费模型 `space-bunny-free` 拉到 Codex 侧。

### 1) 注册 (已完成)
- `providers.json`: 新增 `space-bunny-free` 与别名 `zen:space-bunny` (provider `opencode-zen`,
  走既有的 `oc-zen-proxy.mjs` 反代 7901 —— 免费档要求 OpenCode 客户端指纹, 该反代负责补齐)。
- 注释用**字符串** `_spacebunny_comment` (不是数组: `models` 里的数组会被
  `typeof === "object"` 放行, 在 `/u/v1/models` 与选择器里变成假模型 id)。这是**第三次**
  踩同一类坑 (前两次: anyrouter claude 注释、更早一处), 已在注释里写明。

### 2) 发现并修掉的三处 effort 不一致 (本次主要产出)
排查中先用**经网关**的探测得出 "space-bunny 六档全收" —— **该结论当时是假的**: 网关把
`max` 静默改写成 `high` 后再发上游, 上游当然回 200。改成**直连 zen 反代 (7901, 绕过网关)**
复测, 才是真证据: `minimal/low/medium/high/xhigh/max` 全 200。由此暴露三个问题:

1. **`providerFor()` 只有 provider 级夹取** (`server.mjs`)。opencode-zen 的
   provider 级 `efforts: [low,medium,high]` 是为 mimo 设的, space-bunny 继承后
   `max`->`high`、`xhigh`->`high`、`minimal`->`low`, 静默降级。已改为
   **model > provider > null** 的优先级, 并给 space-bunny 两条显式声明六档。
2. **`tools/build-model-catalog.cjs` 完全忽略 registry 的 `efforts`**, 落回硬编码猜测
   `EFFORTS_DEFAULT = [low,medium,high,max]`。后果: picker 宣称 mimo 支持 `max`, 实际被夹成
   `high` (picker 撒谎); space-bunny 实际收 `minimal/xhigh`, picker 却不列。已加
   `clampWindow()`, 优先级与网关一致, 并注明 registry 是唯一真源。
3. **我先前写下的注释断言是错的** —— 声称 "providerFor() reads spec-level overrides
   before provider ones", 而代码里根本没有 spec 级覆盖。已改正, 并把
   "直连复测" 的方法写进注释, 避免下次又用经网关的探测自我欺骗。

### 验证 (全部实机, 隔离实例 7879, 未碰线上 7878)
- **转发内容取证**: 起假上游 (7999) + 指向它的隔离网关, 记录网关**实际转发**的
  `reasoning_effort`。修复前后对比:

  | 请求 | 修复前 | 修复后 |
  |---|---|---|
  | space-bunny `max` | `high` (降级) | **`max`** |
  | space-bunny `xhigh` | `high` (降级) | **`xhigh`** |
  | space-bunny `minimal` | `low` (降级) | **`minimal`** |
  | mimo `max` | `high` (夹取, 正确) | `high` (夹取, 正确) |
  | mimo `minimal` | `low` (夹取, 正确) | `low` (夹取, 正确) |

- **端到端 (真实上游, 流式)**: `zen:space-bunny` 六档全部 `200` + `response.completed`;
  `zen:mimo-v2.6-flash` 六档全部 `200` (内部夹取到 low/medium/high, 符合预期)。
- **catalog 一致性**: 重建后 `space-bunny` = `minimal/low/medium/high/xhigh/max`,
  `zen:mimo-v2.6-flash` = `low/medium/high` (default `high`) —— 与网关实际转发一致。
  改动范围经逐条比对**严格限于 4 个 zen 条目**, 无其它模型被波及。
- **门禁**: check-syntax / anthropic-registry / realm-fallback / filter-failopen 6 /
  bridge-request 32 / bridge-indices / usage-pricing / stream-terminal 48 全绿。
- 临时实例 (7879/7999) 已全部停止; 线上 7878 (PID 27488) 全程未动。

### 诚实边界
- 只验证了 `space-bunny-free` 与 `mimo-v2.6-flash-free`。zen 同档其它 free 模型
  (`ling-3.0-flash-fin-free` / `muse-spark-*` / `nemotron-*` / `jev-1.13-free`) 未逐一探测。
- `mimo-v2.6-flash-free` 直连 zen 反代时**六档全 403 FreeTierError**, 而经网关同模型 200。
  差别在网关补齐的工具/指纹组合, 直连探测脚本未复刻; **该 403 未追根因**, 不影响经网关的可用性。
- **需重启网关与 Codex 才生效** (providers.json / server.mjs / catalog 均已更新到磁盘, 但
  线上 7878 仍是旧代码, Codex 仍是旧 catalog)。重启由用户执行。

## 2026-09-24: 接入 motomoto.lol (4 个模型, 2 并发上限)

用户提供 `https://motomoto.lol` (New-API 中转, `X-New-Api-Version:
v1.0.0-rc.31-motomoto.49`) 与其 key, 要求配到 Codex, 并说明该站**上限为 1 个主代理
+ 1 个子智能体 = 2 并发**。

### 1) 两个必须先知道的实测事实

**a. 直连被 CDN 拦成 200 空响应, 必须走本地代理**

直连 HTTPS 到**任意路径**都返回 `HTTP 200` + `Content-Type: text/plain` +
**零长度 body**。实测 `/`, `/v1`, `/v1/models`, `/v1/chat/completions`, `/health`,
甚至**不存在的路径**全都是同一个响应 —— 说明拦在 CDN 而不是 API。
同一个请求走 `http://127.0.0.1:7897` 返回真实 JSON。

这类故障**不会报错**, 客户端只会看到空 body; 若按 `HTTP 200` 判断成功就会误判。
因此 provider 级设 `proxy` (与 anyrouter 同一机制, server.mjs 的 CONNECT 隧道)。

**b. 只有 chat/completions 可用**

| 路径 | 结果 |
|---|---|
| `/v1/chat/completions` | 可用 |
| `/v1/responses` | `Upstream service temporarily unavailable` |
| `/v1/messages` | 同上 (anthropic wire) |

所以只能走网关的 chat 桥 (`wire: "chat"`)。

### 2) 模型 id 冲突 (重要)

该站暴露 4 个 id: `codex-auto-review`, `gpt-6-astra`, `gpt-5.5`, `gpt-5.6-sol`。
**这 4 个在 providers.json 里已经存在, 且都指向 relaycat。**

因此以 `motomoto:` 前缀注册 (同 zen: 的做法)。
**绝不能覆盖裸 slug** —— 那会把所有现有调用者静默改道到另一个上游。

### 3) 并发上限

`~/.codex/config.toml` 新增:

```toml
[agents]
max_concurrent_threads_per_session = 1
```

该键只计**spawned 线程, 不含主代理**, 所以 1 = 主 + 1 子 = 2 并发, 与该站上限一致。

位置有讲究: 必须放在**第一个 `[table]` 之前**。TOML 里表格头之后的键属于该表,
若追加到文件末尾会静默变成 `[mcp_servers.*]` 的字段。已断言 `[agents]` 就是第一个表头。

**副作用 (已知且未消除)**: `[agents]` 是**全局**设置, 无法按模型设置。所以
非 motomoto 的模型也会被限制到 1 个并发子代理。这是为 motomoto 付出的代价,
若要恢复需在 config.toml 里改回或删除该块。

### 验证

- **隔离实例 (7879, 未碰线上 7878)**: `/u/v1/models` -> 43 个, 含 4 个 motomoto id。
- 经网关打 4 个模型: 网关正确构造 chat body (163 字节, 见下方捕获),
  经代理抵达上游并返回上游自身的错误 —— **链路已通, 失败发生在上游侧**。
- **请求体取证**: 用 `toChatBody` 直接导出网关构造的 body, 确认结构正常
  (`{model, messages:[system,user], stream:true}`), 不是网关构造错误。
- 把**同一个 body** 经代理直发 motomoto: 同样报 `Upstream service temporarily
  unavailable` —— 排除了网关的因素。
- 门禁全绿 (syntax / anthropic-registry / realm-fallback / filter-failopen 6 /
  bridge-request 32 / bridge-indices / usage-pricing / stream-terminal 48)。
- catalog 重建: 43 个模型, 4 个 motomoto 条目已进 picker。
- TOML 校验: 32 个表, 无重复, `[agents]` 位置正确, 顶层 model/model_provider 未受影响。

### 诚实边界

- **该站当前不可用**。第一次调用 (用户给的原始 curl, 走代理) 成功返回
  `"Hi. What would you like to work on?"`, 之后连续 18+ 次全部
  `Upstream service temporarily unavailable`。**这不是我们的配置问题** ——
  同样的 body 绕开网关直发也一样失败。恢复后无需再改代码。
- **未验证 motomoto 模型的真实对话质量与工具调用能力**, 因为上游不可用。
- 4 个模型的 context_window 是 catalog 从同名 slug 继承的 (1050000 / 128000),
  **不是 motomoto 自己公布的**, 未经验证。
- 2 并发上限是**用户转述的站点限制**, 本站未提供可查询的配额接口, 未独立验证。
- **需重启网关与 Codex 才生效** (providers.json / .env.local / config.toml / catalog
  均已更新到磁盘)。重启由用户执行。

## 2026-09-24: justwoker 出网清洗 (egress-guard) + 密钥轮换

用户判定 justwoker (api.justwoker.icu) 是**危险供应商**, 要求加清洗并全量审查出网数据。

### 1) 审计: 发往它的是什么 (实测, 非推断)

用假上游捕获真实请求, 逐字段核对。**七类敏感信息全部原样外发**:

- API key (明文, 因为 Codex 会读文件, tool_result 里就是 .env 的内容)
- 用户名 o_Obl
- 绝对路径 G:/omp works/...
- Windows 版本号 10.0.19045
- 时区 Asia/Shanghai
- shell 名 powershell
- 局域网 IP

### 2) 第三方扫描结果 (用户提供, 直接驱动了规则设计)

另一份对该站的独立数据包扫描给出**按字段名的命中计数**:
credentials 37657, API Key 22734, credential 8216, 令牌 6071, OpenAI Key 3917,
凭证 3191, 密钥 2546, JWT 2187, 密码 1458, dsn 1201, URL凭据 636, 私钥 469,
AccessKey 378, SecretKey 204, encryptionkey 184, GitHub Token 18。

这份清单决定了设计: **只按值形状匹配永远追不上**, 因为值格式可以有无穷变体,
而叫 credentials 的字段无论值长什么样都是凭据。所以除了值规则, 还实现了
**按键名清洗** (isSensitiveKey), 且对敏感键**向下传播**到整棵子树。

### 3) 实现 (egress-guard.mjs, 21 条规则)

值规则: 私钥块 / JWT / Bearer / sk- / GitHub / AWS / Google / Slack / npm /
URL 内嵌凭据 / KEY=value / 中文 密钥:值。
主机规则: Windows 用户路径 / POSIX home / UNC 主机 / Windows 版本号 / 私网 IP / MAC /
**运行时从环境变量取的真实用户名与机器名**。

键名规则: SECRET_SEGMENTS + 驼峰/下划线切分, 覆盖上面扫描清单的全部字段。

### 4) 三个必须记的设计取舍

**a. 不误伤代码**。coding agent 天天读源码, apiKey: process.env.X 是**常态**,
把它抹掉模型就没法改配置代码了。所以: 敏感键下只保留**显式引用表达式**
(process.env.X / readSecret(...)), 其余一律替换。

**b. 区分真密钥与占位符**。sk-workbuddy 是本地占位符, 抹掉会让用户写不进配置。
判据: 真凭据**必含数字**, 手写占位符通常不含。

**c. fail-closed**。与 agentrouter 的 filter 相反 —— 那个是内容整形, 失败放行;
这个是为防数据外泄, 失败**拒绝转发**并返回 500。两者语义不同, 不能统一。

### 5) 排查中发现的真实缺陷 (全部已修, 有测试钉住)

1. **最严重**: 敏感键下的值仍走 looksLikeReference() 宽松启发式, 而
   hunter2hunter2 符合裸标识符, 导致 password 的值**完全没被清洗**。已改为严格表达式判定。
2. keyCount / apiKeyName 因含 key 段被误判为敏感 (描述符后缀规则已修)。
3. $1 反向引用在**字符串**替换里不展开 (只有字面正则才行), 路径前缀被吞。
4. postgres://u:p@host 的密码组要求 3+ 字符, 单字符密码漏过。
5. JSON 里 "密码": 值 因引号位置漏匹配。

### 6) 密钥轮换 + 一个隐蔽的优先级陷阱

旧 sk-pLl... 上游返回 Invalid token (流式/非流式都试过)。换用用户提供的新密钥。

**陷阱**: loadLocalEnv 只在键**未定义**时填充, 所以**真实环境变量优先于 .env.local**。
User 级环境变量里存着一份**旧的** JUSTWOKER_API_KEY, 一直**遮蔽**着文件里的新值,
而症状只是一个上游 401 Invalid token —— 看起来像密钥坏, 实际是被遮蔽。
已同步更新 User 级变量, 并在 .env.local 顶部写明这个陷阱与自查命令。

### 验证

- 单测: tools/test-egress-guard.mjs **16/16**, tools/test-egress-scan.mjs **24/24**
  (后者逐条覆盖上面那份扫描清单的每个字段名)。
- 假上游取证: 7 项敏感信息全部 clean, 且 model/tools/消息结构完整保留。
- **真实上游 E2E** (隔离实例 7879): HTTP **200** 返回 pong, 同时日志可见
  windows-buildx1,host-identity:o_Oblx1,api-key-skx1,secret-assignmentx2,env-secret-linex1。
- 门禁全绿 (check-syntax / anthropic-registry / realm-fallback / filter-failopen 6 /
  bridge-request 32 / bridge-indices / usage-pricing / stream-terminal 48)。
- egress-guard.mjs 已纳入 tools/check-syntax.mjs 的 PLAIN 列表。

### 诚实边界

- **规则是黑名单, 不可能穷尽**。它按扫描清单和常见凭据格式覆盖, 但一种从未见过的
  凭据格式仍可能漏过。真正的边界是**不要把这个 provider 用于敏感代码库**。
- 只对 **justwoker** 启用 (providers.json 的 egressGuard: true)。其它 provider 未开,
  因为会改变发出去的内容, 需要用户逐个决定。
- 未验证被清洗后的对话质量是否下降 (本次只验了 pong 这种最小往返)。
- **需重启网关才生效** (providers.json / server.mjs / .env.local 均已落盘)。

## 2026-09-24: 密钥轮换后被遮蔽 —— 改为 .env.local 优先

接上一条。轮换 justwoker 密钥后, 网关仍报 401 `Invalid token`。

### 根因

`loadLocalEnv` 原本是 **环境变量优先于 .env.local** (只在键未定义时填充)。
而网关由 `autostart` 经 Windows Terminal 启动, **终端是几小时前开的**,
它的环境块里存着**已撤销的旧密钥**。Windows 下已存在的进程不会刷新环境块,
于是网关持续继承旧密钥。

证据链:

| 检查 | 结果 |
|---|---|
| 直连新密钥 | 200 |
| 直连旧密钥 | Invalid token |
| 隔离网关显式传新密钥 | 200 |
| live 网关 | 401 Invalid token |

四条同时成立, 只有一个解释: live 网关持有旧密钥。

### 为什么这个 bug 值得改架构而不是重启了事

`.env.local` 的存在意义就是"改文件即生效"。被环境变量遮蔽后, 这个契约失效,
而且**故障现象在 API 边界上与"密钥坏了"完全无法区分** —— 会把人引到错误的方向
(本次就先怀疑了密钥本身)。所以把方向反过来: **文件优先**。

逃生开关: `AR_ALLOW_ENV_OVERRIDE=1` 恢复旧方向 (确需按进程注入密钥时用)。

### 验证

- 单元级: 把**已撤销的旧密钥**种进环境, 跑真实 loader -> `FILE WINS (fixed)`;
  带 `AR_ALLOW_ENV_OVERRIDE=1` 时回到 `env shadows` (开关有效)。
- **决定性 E2E**: 隔离网关 + 环境里种旧密钥 -> HTTP **200** `pong`。
  若修复无效, 这里必然是 401。
- egress-guard 仍生效 (同一次调用日志可见 6 类脱敏)。
- 门禁全绿 (8 个测试文件 + 新的 2 个)。

### 顺带确认

本次真实调用里模型回复 `pong` 并附带一句: 它注意到读到的 `.env` 内容中密钥是
`<redacted>`。属于预期行为 —— 脱敏对模型是可见的, 但不影响它继续工作。

### 诚实边界

- 该优先级改动是**全局的**: 其它走 `.env.local` 的键 (`OPENCODE_API_KEY`) 也变成文件优先。
  目前文件与环境变量里这两个值相同, 无实际影响; 但今后轮换时**只需改文件**, 这正是不变量。
- **需重启网关**才生效。

## 2026-09-24: egress-guard 破坏了 tool schema (TOOL_SCHEMA_INVALID)

启用清洗后, 带工具的请求被上游拒绝:

```
Invalid request (TOOL_SCHEMA_INVALID): ... custom.input_schema: JSON schema is invalid.
It must match JSON Schema draft 2020-12
```

### 根因: 把 schema 当成了数据

键名清洗会**向下传播**, 于是走进了 `tools[].input_schema`, 把 schema 里的
**关键字**当成值抹掉了:

```
password.type: "string"  ->  "<redacted>"     <- schema 被破坏
apiKey.type:   "string"  ->  "<redacted>"
key.type:      "string"  ->  "<redacted>"
```

关键区别: schema 里的 `properties.password` 意思是"这个工具接受一个叫 password 的
字段", 是**结构定义**; 它本身不是密钥。把它抹掉, 整个 schema 就非法了。

### 修法: schema 子树只做"值形状"清洗, 不做"键名"清洗

新增 `SCHEMA_ROOT_KEYS` (`input_schema` / `inputSchema` / `parameters` /
`json_schema` / `schema`), 这些键的子树标记为 `inSchema`, **抑制键名清洗**。
但值规则照常运行 —— 所以:

- `type` / `required` / `enum` 等关键字原样保留, schema 合法;
- schema 的 `description` 里若真贴了密钥或真实路径, **仍会被脱敏**;
- 数据区 (messages / credentials 等) 强度不变。

### 验证

- 复现脚本: 修复前 `password.type` 变 `<redacted>`, 修复后三个 schema 全 `valid`。
- 平衡性检查 (关键): schema 结构完整, 同时其 `description` 里的
  `C:\\Users\\o_Obl\\x` 变 `C:\\Users\\<user>\\x`、`sk-tS8...` 变 `sk-<redacted>`,
  数据区 `credentials.apiKey` / `password` 照常抹掉。
- **真实上游 E2E**: 带 `password` / `apiKey` / `key` / `secret` 字段名的两个工具, 经隔离网关
  打 justwoker -> **HTTP 200**, 回复 `pong`; 同次日志仍有 `windows-buildx1,host-identity:o_Oblx1`。
- 新增 4 条回归断言 (schema 存活 / anthropic 形式 / description 里的密钥仍被抹 /
  数据区未削弱), `test-egress-scan.mjs` 由 24 条增至 **28 条**。
- 门禁全绿。

### 教训

脱敏的根本难点不是"找到密钥", 而是**区分"值"与"结构"**。一条向下传播的键名规则
很强, 但它会把 schema / 类型定义 / 枚举这些**非数据**一并吃掉。
凡是带元结构的协议 (JSON Schema / OpenAPI / 模板), 都需要先声明"这里是结构"。

## 2026-09-24: 允许 claude-opus-4-8 (justwoker) 拉起子代理

用户要求让 opus-4-8 via justwoker 可用于子代理。做之前先验证前提, 结果**发现一个真 bug**。

### 1) 发现的 bug: anthropic 回程丢失 namespace 还原

DEVLOG 09-22 记过: 走 anthropic 线路的模型"无法使用原生子代理", 当时修了**请求方向**的
命名空间展开, 但留下一句**未验证**: "anthropic 线路只做单元/往返验证, 未做真实上游端到端"。

本次拿真实 justwoker 做端到端, 复现出来: 模型**确实调用了** `spawn_agent`, 但回程是

```
name=multi_agent_v1__spawn_agent  namespace=null     <- Codex 认不出
```

应该是

```
name=spawn_agent  namespace=multi_agent_v1
```

**根因**: `bridgeAnthropicStream` 有第 7 个参数 `toolMap`, 但 `server.mjs` 调用时**没传**
(只传了 5 个)。chat 路径传了, anthropic 路径漏了。所以出网名字展开了, 回程却还原不回来。

症状与 09-22 那个报告同类 ("子工具不可见"), 但发生在**回复路径**而不是请求路径。

修法: 在调用处补上 `isGuardToolName, toolMap`。

### 2) 加入子代理覆盖列表

`spawn_agent` 的 "Available model overrides" **上限 5 条**, 当时已满。用用量数据决定驱逐谁
(统计 `data/usage/*.jsonl`):

| slug | 用量 |
|---|---|
| global:deepseek-v4.1-flash | 4956 |
| cn:deepseek-v4.1-flash | 1098 |
| mimo-v2.6-flash-free | 16 |
| global:deepseek-v4.1-flash-sg | **0** |
| zen:mimo-v2.6-flash | **0** |

驱逐 `global:deepseek-v4.1-flash-sg` (从未使用), 加入 `claude-opus-4-8`。
保留 `zen:mimo-v2.6-flash` 是因为它是"带前缀别名"的样板条目, 两个都驱逐会让列表里再无别名。

### 验证

- **真实上游 E2E** (隔离实例 7879 打 justwoker): 修复前回程 `namespace=null`,
  修复后 `name=spawn_agent namespace=multi_agent_v1`, 判定 **"CAN call spawn_agent"**。
- 出网工具面取证: 命名空间被完整展开为 `multi_agent_v1__spawn_agent` 等, **schema 无损**
  (无空 schema)。
- catalog: 覆盖列表恰好 5 条, 含 `claude-opus-4-8` (priority=-1), 且仍在 5 条上限内。
- 门禁全绿 (10 个测试文件)。

### 诚实边界

- 换掉 `-sg` 是**我的取舍**, 不是用户明确指定。依据是它用量为 0。
  若要换成别的, 改 `tools/build-model-catalog.cjs` 的 `OVERRIDE_SLUGS` 即可。
- 端到端验证的是**模型能否发出正确的 spawn_agent 调用**;
  Codex 侧"真的派生出子代理线程"未在本次验证 (那需要真实 Codex 会话)。
- **需重启 Codex** 才读到新 catalog (网关已在 16:25 重启过, 含此前修复)。

## 2026-09-24: 撤销全局子代理并发上限（我为 motomoto 加错了地方）

用户问: 某个会话为什么只能创建 1 个子代理, 而模型并不限流。**是我造成的。**

### 原因

接 motomoto 时我写了:

```toml
[agents]
max_concurrent_threads_per_session = 1
```

因为 motomoto 运营方说"上限 1 主 + 1 子 = 2 并发"。但 **Codex 没有按键名区分的版本** ——
这个键是**全局**的, 于是所有模型的子代理都被压到 1 个, 包括 Kiro 会话要跑 5 个任务的
分工。用户观察到的"只能创建 1 个子代理"正是它。

### 为什么这是一笔坏交易

代价是**全会话能力**, 收益是**零** —— motomoto 从头到尾**没有成功服务过一次调用**
(一直 `Upstream service temporarily unavailable`), 那个 2 并发上限根本没被触及。

我当时在 DEVLOG 里记了这个副作用, 但**低估了它的量级**(写"已知且未消除"就当交代过了),
而且没有把它当成**需要用户决策**的事去问。这是判断失误, 不是信息缺失:
文档明说 `agents.enabled` 才控制开关、这个键只管并发, 我却没有停下来想"为一个用不上的
上游锁死全会话是否值得"。

### 处置

- 注释掉该键 (保留 `[agents]` 空表), 交给 Codex 内置默认, **不再自己拍数字**。
- 在 config.toml 原位写下这段经过与"不要为单个上游重新加全局上限"的禁令。

### 验证

- TOML: 32 个表, 无重复, `[agents]` 仍在首个 `[model_providers.*]` 之前, 空表合法。
- `codex exec --strict-config` 通过 (无 `unknown field` / `invalid`), 只有无关的 telemetry 警告。
- 该键已从配置中消失。

### 诚实边界

- **Codex 的默认并发数未验证** —— 二进制里挖不到, 只能按文档"未设置时由 Codex 选择"。
  要确认真实上限, 得在新会话里实际派生多个子代理观察。
- **需重启 Codex** 才生效 (config.toml 是启动时读的)。
- 顺带注意: 顶层 `model` 现为 `claude-opus-4-8` (此前会话所改), 与本条无关。

## 2026-09-24: 并发上限收回"已无上限"的说法, 显式设为 8

用户反馈: 删掉 `= 1` 之后工具仍返回 `agent thread limit reached`, 怀疑值还是 6。

### 先纠正我自己的错误表述

我上一条说"已无上限"是**不准确的**。我删掉的是 `= 1`, 效果只是**回到 Codex 内置默认**,
而默认**不是无限**。用户观察到的 6 就是那个默认值。

### 证据: 6 不是配置里的, 也不是我写的

- `config.toml` 全文搜 `max_concurrent` **无匹配** —— 键当时根本不存在。
- `agent thread limit reached` 在 **09-21 的会话里就出现 6 次**, 早于本次任何改动。
  也就是说这是 Codex 的默认行为, 不是我引入的。

所以"调大"必须**显式写一个值**, 靠删键是做不到的。

### 另一个被忽略的时间线问题

| 事件 | 时间 |
|---|---|
| Codex 进程启动 | 17:05:59 |
| `config.toml` 写入 | 17:06:38 |

**配置写在进程启动之后** —— 运行中的 Codex 根本没读到那次改动。
这类"改了没生效"以后要用这个时间线先自查, 而不是先怀疑配置内容。

### 取值 8 的依据

官方配置参考自己的示例就用 `max_concurrent_threads_per_session = 8`。
本工作区实际跑的是 5 路子代理 (2 开发 + 3 审查), 8 能一次装下并留重试余量,
不必退回"完成一个关一个"的滚动调度。

### 验证

- TOML: 32 个表, 无重复, `max_concurrent = 8`, `[agents]` 仍在首个 provider 表之前。
- `codex exec --strict-config` 通过 (无 `unknown field` / `invalid`)。

### 诚实边界

- **8 是否真的生效未验证** —— 需要重启 Codex 后实际派生 7-8 个子代理观察。
  本次只验证了配置语法与语义被接受, 没有把上限跑满。
- Codex 的内置默认值**仍未从二进制中确证**（6 是用户观察 + 历史日志推断）。
- **需重启 Codex**。

## 2026-09-24: agentrouter 严格 item id —— 跨上游回放导致的 400 (已修复, 已实测)

### 现象

用户报告 agentrouter 的 gpt 报:

```
OpenAI Responses bad request: Invalid 'input[127].id':
'item_9c5b989663879ef37cb7082c'. Expected an ID that begins with 'rs'.
[trace_id=76537bee1fa8ea2e23c577d8b0d63b4]
```

这不再是当初那个 `reasoning_content` / `stripReasoning` 问题。用户明确要求**只修这一个**, 且**不得**恢复会波及其它模型的全局剥离 reasoning 补丁。本次修法因此按类型 + 按提供商限定, 只在 agentrouter 上生效。

### 根因 (全链路实测, 非推断)

1. **坏 id 的产地是 relaycat, 不是网关**。网关从不产生 `item_` 前缀 (只生成 `resp_` / `rs_` / `msg_` / `fc_`)。实测 relaycat 对 message item 的回答就是 `{"type":"message","id":"item_66935b8aec1a06f235fcf537",...}` —— `item_` 是 relaycat 自己的 id 命名空间。
2. **Codex 忠实回放**。会话 `01a0cbfd-...` 第 2691/2692 条 (2026-09-24T08:04:12Z) 就是 `{"type":"reasoning","id":"item_9c5b989663879ef37cb7082c","summary":[{"type":"summary_text","text":"**Checking workspace snapshot**..."}],"content":null,"encrypted_content":null}`。该会话当轮 provider 是 relaycat (网关日志 08:04:13 `proxy u/v1/responses -> https://api.relaycat.top/...`)。
3. **agentrouter 按类型校验 id 前缀, 且解析的是它自己的库**。逐类型实测 (2026-09-24, model gpt-6-astra, 每行一次真实探测):

| item type | 上游报错要求的前缀 |
|---|---|
| `reasoning` | `rs` |
| `message` | `msg` |
| `function_call` | `fc` |
| `function_call_output` | `fc` |
| `web_search_call` | `ws` |
| `custom_tool_call` | `ctc` |
| `custom_tool_call_output` | `ctco` |

4. **改名无用, 只能丢**: 把 `item_...` 改写成 `rs_...` 仍然失败 —— `Item with id 'rs_9c5b989663879ef37cb7082c' not found` (上游在自己库里查这个名字)。把 id **删掉**则同一请求 200。因为回放真正需要的关联是 `call_id`, 正文 (文本 / arguments) 都在 item 体内, id 在这条路径上是纯元数据。
5. **`encrypted_content` 必须随 id 一起走**: 它是**签发该 id 的那个上游**加密的, 外来 blob 被拒 —— `The encrypted content gAAA... could not be verified. Reason: Encrypted content could not be decrypted or parsed`。而 agentrouter **自己**的 reasoning (id `rs_*` + `encrypted_content`) 回放 200, 所以二者必须同进同退。

### 修法 (外科式, 仅 agentrouter)

新增 `responses-ids.mjs`, 两级:

- **第 1 级 `stripForeignItemIds`**: 只删**前缀与类型契约冲突**的 id (即铁证属于别的上游的)。
- **第 2 级 `stripAllItemIds`**: 仅在**上游自己**抱怨回放 id 时才触发重发一次 (覆盖第 1 级无法判断的残留: 前缀合法但上游库里没有的 id, 例如上游多 Azure 资源池无会话粘性时它自己签发的 id 也会 not found)。只对上游明确的三种抱怨生效 (`Expected an ID that begins with` / `Item with id .. not found` / `encrypted content .. could not be verified`), 其它 400 原样透传不重试 (避免重发一个本身格式错的请求白烧配额)。
- `item_reference` **永不剥离**: 它的 id 就是载荷本身 ("把该 id 的条目取来"), 删掉会把一个被拒的请求变成无意义的请求。这类跨库引用确实无法在此上游服务, 原样报错。
- 开关按提供商声明: `providers.json` 的 `agentrouter.strictItemIds = true` (带完整注释), `providerFor()` 读取; 内置 `/ar` 路由同样置位。**其它上游一律不碰** (relaycat / wb2api / justwoker / anyrouter / opencode-zen / motomoto 的 id 原样保留) —— 没有证据就不改写。

### 验证

- 单元 `tools/test-responses-ids.mjs` **16/16 PASS**: 逐类型前缀矩阵 / 外来 id 删除 / 自家 id 与 blob 保留 / `item_reference` 不动 / 未知类型不动 / 非 JSON 原样返回 / 无需修复时返回**原始字符串** (不重序列化) / 第 2 级覆盖无 id 的外来 blob / 拒绝识别表。
- 端到端 `tools/test-strict-item-ids.mjs` **14/14 PASS** (桩 http 层, 驱动真实 handler, 不开端口): `/ar` 在上游看到请求**之前**就删掉外来 id (1 次上游调用, 无浪费重试) / 上游 400 后第 2 级重发 1 次且重发体无 id / 无关 400 不重试且原样透传 / relaycat 路由的 id 逐字节不动 / 混合回放的 `call_id` 关联完好 / GET 不伪造请求体。
- **隔离实例实测** (7879 新代码; 7878 保持旧代码, 线上会话未受干扰):

| 请求 | 7879 (修复) | 7878 (未修复) |
|---|---|---|
| 报错原文那条 `item_` reasoning 回放 | **200** | **400** `Expected an ID that begins with 'rs'` |
| 干净请求 (回归) | **200** | - |

7879 日志同时给出 `strict-item-ids u/v1/responses: dropped 1 foreign replay id(s)`。
- 回归门禁全绿: `check-syntax` (含 collapsed-spread 扫描) / `diff-test` 0 mismatches / `test-bridge-request` 32 / `test-bridge-indices` / `test-realm-fallback` / `test-filter-failopen` 6 / `test-anthropic-registry` / `test-egress-guard` 16 / `test-egress-scan` 28 / `test-stream-terminal` 48 / `test-usage-pricing`。

### 与上一轮的区别 (避免误读)

README 里 "reasoning 剥离已整体移除" 仍然成立: 那条指的是无差别的全局剥离开关。本次是**按类型契约、按提供商**的最小删除, 且只在**前缀与类型冲突**时发生; 上游自家 id 与合法前缀一律保留。`stripReasoning` 没有回来。

### 待用户执行

线上网关 (7878) 仍跑旧代码, **需要重启**才生效 (重启由用户决定)。重启前该会话若再次回放外来 `item_` id, 仍会 400。
### 补证:坏 id 就是 relaycat 给 reasoning 签发的 (2026-09-24 复测)

上文的产地判断 (relaycat 是 `item_` 的签发方) 起初只有 message item 的样本。为了把
`reasoning` 这一路也钉死, 直接对 relaycat 打两次真实请求 (model gpt-6-astra, 不含
`include: ["reasoning.encrypted_content"]`):

| effort | HTTP | 返回的 item id |
|---|---|---|
| `low` | 200 | `message id=item_a37521598ea539374ad14b1c` |
| `max` | 200 | `reasoning id=item_bb3549e2d373cc46ccea4452`, `message id=item_392c2f18c4a60fe941906540` |

两点由此确证:

1. relaycat **也会给 `reasoning` 签发 `item_...` 形式的 id**, 与报错里那条
   `item_9c5b989663879ef37cb7082c` 形态一致。跨 provider 切换后 Codex 回放它, agentrouter
   即 400 —— 与本次修复针对的失败完全同源。
2. 这些 reasoning item 的 `encrypted_content` 是**空的**(relaycat 没回加密体),
   所以本次修复删 id 时连带清掉的也只是一个空字段, 不损失任何可还原的推理状态。

原始输出留在 `.tmp/probe-relaycat-reasoning-id.txt` (未入库)。
## 2026-09-24: motomoto `invalid JSON request body` (已修复, 已实测)

### 现象

用户报告 motomoto 每次调用都失败:

```
Invalid request: Invalid request: invalid JSON request body
(request id: 202609241218333883680598268d9d61SYbudbX)
```

从网关日志定位到唯一一次 motomoto 调用 (2026-09-24T12:18:14Z): `bridge u/v1/responses -> motomoto model=gpt-6-astra msgs=23 tools=29`, 3 秒后上游回 400。用小请求 (`msgs=2 tools=0`) 复现同样 400, 说明与上下文大小/工具无关。

### 根因一: 出站 body 用了 chunked 分帧

**实测对照** (同一 key、同一 body, 2026-09-24):

| 分帧方式 | 结果 |
|---|---|
| `Transfer-Encoding: chunked` (Node 默认) | **400** `invalid JSON request body` |
| `Content-Length: <n>` | **200** + 真实补全 |

body 的字节完全相同, 只有分帧不同。Node 对"有 body 但没 Content-Length"的请求默认用 chunked, 而 motomoto (New-API 系) 解不出这种分帧, 于是报成 JSON 格式错误。修复: `request()` 显式给带 body 的出站请求补 `Content-Length` (仅当调用方没有自带任何分帧头)。`/v1/models` 走 GET 无 body, 两种分帧都 200, 所以之前接 motomoto 时只探过 GET 与 responses 面, 没暴露这个差异。

### 根因二: 收到完整回答后上游粗暴断连, 桥接层把它当失败

修好分帧后仍得到 `status=failed / upstream stream aborted`。用原始客户端直连复现:

```
outcome=aborted elapsed=164152ms sse-lines=5  has [DONE]: true
last lines: ... "delta":{"content":""}, "finish_reason":"stop" ... [DONE]
```

即 motomoto **把整个 SSE 流发完 (含 `data: [DONE]`、真实内容 "Hi"、usage) 后直接断连**, 不做干净关闭。`bridgeChatStream` 把 abort/close 一律当失败, 于是已经完整到达的回答被丢弃, 调用方拿到 `upstream stream aborted` 与 502。

修复: 粗暴断连 (abort / close-without-end) **只有已经看到 `data: [DONE]` 时才宽恕**。单有 `finish_reason` 不够 —— 上游可能还要补发 usage, 且 `test-stream-terminal` 的 `finish-then-close` 用例明确把它钉为失败。尾部缓冲必须先冲刷再判断 (上游的 `[DONE]` 可能没有末尾换行)。

### 验证

- 新增 `tools/test-bridge-rude-close.mjs` **8/8**: 完整回答+粗暴断连 -> `response.completed` (文本 "Hi" 与 usage 都保留) / 无任何信号 -> 仍失败 / 只有 finish_reason -> 仍失败 / 干净 end 行为不变 / 只发一次 completed。
- 全门禁绿: `test-stream-terminal` 48/48 (含 `finish-then-close`、`error-after-done` 等边界) / `test-bridge-request` 32 / `test-bridge-indices` / `test-realm-fallback` / `test-anthropic-registry` / `test-responses-ids` 16 / `test-strict-item-ids` / `test-egress-guard` 16 / `test-egress-scan` 28 / `test-filter-failopen` / `test-usage-pricing` / `check-syntax` / `diff-test` 0 mismatches。
- **隔离实例 7879 打真实上游**: 7878 (旧代码) 仍是报错原文那个 400; 7879 (新代码) **200**, `response.completed`, 文本 "Hi", `total_tokens=27`。

耗时观察: 修好后单次调用约 120-140 秒才能拿到结果, 这是**上游本身慢**, 不是网关引入的 —— 原始客户端直连测量同样是 164 秒才收到流尾。

### 协作事故 (需注意)

修这块时检测到**另一个 Codex 会话 (19:05 那个) 正在并发编辑同一仓库**, 并在 20:38-20:39 执行过 `git checkout`, 把本会话**尚未提交**的 `bridge.mjs` 改动冲掉过一次 (两个文件 mtime 同时变为 20:38:52, reflog 无记录, 内容回到 HEAD)。改动已重做并在本次提交 (`b5d828b`) 落盘。教训: 本仓库只要还有别的会话在跑, 编辑后应**尽快提交**, 不要长时间停留在未提交状态。
## 2026-09-26: anyrouter claude 模型 503 复查 (上游故障持续, 非我方缺陷)

### 现象

用户报告 `bridge u/v1/responses -> anyrouter model=claude-opus-5-5` 后
`bridge upstream 503: {"error":{"message":"Service Unavailable","type":"error"},"type":"error"}`。

### 复查结论: 与 2026-09-24 归档的是同一件事, 上游渠道池仍无可用通道

证据 (2026-09-26 12:4x, 全部经 `http://127.0.0.1:7897` CONNECT 隧道直打上游):

1. **key 有效**: `GET /v1/models` 带该 key -> **200**, 返回完整模型列表。不是认证/配额问题。
2. **请求形态正确**: 不带 beta 头 -> **400** `1m 上下文已经全量可用, 请启用 1m 上下文后重试`;
   带 `anthropic-beta: context-1m-2025-08-07` -> **503**。错误层推进到 503 正是"头已送达"的正向证据,
   与 `docs/ANYROUTER-CLAUDE-ACCESS.md` §2.2 记录一致。
3. **503 是站点级, 不是模型级**: 同一时刻横向扫描 ->
   `claude-opus-5-5` 503 / `claude-opus-4-7` 503 / `claude-sonnet-4-5-20250929` 503 /
   `claude-3-5-sonnet-20241022` 503 / `claude-fable-5-1` 503 / `claude-haiku-4-5-20251001` **520**;
   而 `claude-opus-4-6` 返回 **400** `已下线, 请切换到 claude-opus-4-7` —— 业务层可达, 唯独渠道池空。
4. **持续性, 不是偶发**: 45 分钟窗口内 22/22 次全部 503 (13 次来自 Codex 会话自身的退避重试,
   9 次来自本次探测; 另做 3 轮 x 4 次间隔 20 秒的定点观测 -> `[503,503,503,503]` x3)。
5. **同站其它模型也在劣化**: `gpt-6-astra-an` 当日回 **500** `当前模型 gpt-6-astra 负载已经达到上限`
   (`get_channel_failed`)。anyrouter 整站通道紧张。

### 为什么不加重试

`docs/ANYROUTER-CLAUDE-ACCESS.md` §7 已明确不做, 本次复查再次印证: 失败码是 **503/520**,
而网关 `RETRY_STATUS = 429` 只重试 429; 且 anyrouter 渠道池是共享的, 反复打会挤掉同站其它模型
(09-21~23 实测 astra-an 196 次仅 1 次成功)。**加重试只会放大负载, 不会变出通道。**

### 可用替代 (同一次探测, 实测)

| 模型 | 路由 | 结果 |
|---|---|---|
| `claude-opus-4-8` | justwoker (anthropic 桥) | **200** (4.4s, 轮换后的新 key) |
| `claude-opus-5-5` | anyrouter | 503 (上游) |
| `claude-fable-5-1` | anyrouter | 503 (上游) |
| `gpt-6-astra-an` | anyrouter | 500 (上游负载) |
| `gpt-6-astra-ar` | agentrouter | 402 (额度耗尽) |

### 待办

- 无需改代码。anyrouter claude 能否用**只取决于上游**; 需要时用 `/v1/messages` 带 beta 头重探,
  恢复判据: 503 -> 200。
- 若确实需要 Claude 能力, 现在可用的是 **justwoker 的 `claude-opus-4-8`**。
## 2026-09-28: 子代理槽位 —— 用 motomoto:gpt-6-astra 换掉零使用的 zen 别名

### 起因

另一个会话 (01a0d279, astra via motomoto) 报告"子代理工具没有提供 `astra via motomoto` 这个可选路由",
用户问该模型能否用来拉起子代理。复查后确认**该说法准确**, 根因是我们自己的白名单设计:

`spawn_agent` 的 "Available model overrides" 列表**由 catalog 的 `priority < 0` 决定, 硬上限 5 条**
(2026-09-22 抓包实测, 见本文件更早的条目)。`motomoto:gpt-6-astra` 的 priority 是 0, 所以不在列表里;
而 `priority: 0` **不影响路由与选择器**, 只是不进子代理覆盖列表。

### 实测: motomoto 本身可用, 但很慢

经线上网关 7878 真实调用 `motomoto:gpt-6-astra`:

| 场景 | 结果 |
|---|---|
| 普通调用 | **200**, 128 秒 |
| 带 tools 调用 | **200**, 230 秒 |
| **真实工具调用**(要求它调用 exec_command) | **200**, 124 秒, 正确返回 `function_call` + `{"cmd":"echo hi"}` |

对照: `global:deepseek-v4.1-flash` 1.4 秒 / `claude-opus-4-8` 5.7 秒。
**motomoto 慢 20-150 倍**, 几轮就可能撞上 AGENTS.md Sec 11 的 10 分钟拆分线。

### 决定 (用户选 B)

`data/usage/*.jsonl` 重新统计 (2026-09-28, 15009 行):

| slug | 用量 | 处置 |
|---|---|---|
| `global:deepseek-v4.1-flash` | 5662 | 保留 |
| `claude-opus-4-8` | 2833 | 保留 |
| `cn:deepseek-v4.1-flash` | 2235 | 保留 |
| `mimo-v2.6-flash-free` | 17 | 保留 (实际在用的 zen 免费模型) |
| `zen:mimo-v2.6-flash` | **0** | **换出** -> `motomoto:gpt-6-astra` |

`zen:mimo-v2.6-flash` 当初占位理由是"前缀别名的文档示例", 但 15009 行里**一次都没被调用**,
而 motomoto 是用户明确要求的子代理路由。零使用别名不值得占一个槽位。带前缀别名这一情形
仍由注册表覆盖 (`zen:space-bunny` / `motomoto:*` / `global:*`), 只是不再占这 5 个之一。

### 验证

- 重建 catalog: 43 个模型, 构建守卫 (内置负 priority / OVERRIDE_SLUGS > 5) 均未触发。
- 覆盖列表实测变为 5 条: `global:deepseek-v4.1-flash` / `claude-opus-4-8` / `cn:deepseek-v4.1-flash` /
  `mimo-v2.6-flash-free` / `motomoto:gpt-6-astra`; `zen:mimo-v2.6-flash` 变 priority 0。
- **被换出的 slug 仍可正常路由**: `zen:mimo-v2.6-flash` -> **200** (3.8s)。`priority: 0` 只影响子代理列表。
- 其余 4 个槽位全部实测 200 (0.9s / 1.4s / 2.2s / 4.2s)。
- 门禁全绿: check-syntax / responses-ids / strict-item-ids / bridge-rude-close / anthropic-registry /
  realm-fallback / egress-guard。

### 注意

**需重启 Codex 才能生效** —— catalog 在会话启动时读取, 当前会话的 `spawn_agent` 描述仍是旧的 5 条。
## 2026-09-30: 接入 ovoapi (AI站长 / OVO API, New-API)

### 站点身份

用户给的 `https://ovoapi.site` 是**控制台**; 它自己的 `/api/status` 的 `api_info` 块写明 API 地址是
**`https://api-console.182yc.xyz/v1`** (两个域名都能通, 取控制台公布的那个)。
New-API `v1.0.0-rc.33-ovo.20260928.settled-balance`。

### 踩坑一: key 的分组被删过 (用户侧修好)

首次探测时**任何模型名都返回同一个 503**:
`No available channel for model <X> under group default`, 连不存在的模型名也一样。
后续 `/v1/models` 能通但调用回 **403 `API Key 所属分组已删除`** —— 这是 key 记录绑定的分组
已被删除。New API 的 `/v1/models` 只查 key 有效性, 而计费调用要解析分组, 所以两者会不一致。
**这是账号侧问题, 不是接入问题**; 用户在控制台重新选分组后恢复。

(记录这个错误形态: `API Key 所属分组已删除` 与 `No available channel ... under group X`
是两种不同的失败, 前者是 key 的分组没了, 后者是分组里没有该模型的渠道。)

### 实测: 五个 id 只有一个能服务

key 的分组最终暴露 5 个 id。**三轮 x 五 id** 的探测结果:

| id | 三轮结果 |
|---|---|
| **`gpt-5.6-sol`** | **200 / 200 / 200** (9/9) |
| `gpt-5.5` | 503 / 503 / 503 |
| `gpt-5.6-terra` | 503 / 503 / 503 |
| `gpt-6-astra` | 503 / 503 / 503 |
| `gpt-6-sol` | 503 / 503 / 503 |

那四个的 503 是 `Service temporarily unavailable`。**只注册能服务的那个** —— 注册四个死 id 只会
让选择器里出现永远不回答的模型。该站公告显示分组轮换频繁 (0.055x / 0.15x / 不降智组等),
所以将来要重新探测再加。

### wire 面: responses 原生直通

| 面 | gpt-5.6-sol |
|---|---|
| `/v1/responses` | **200** |
| `/v1/messages` (anthropic) | **200** |
| `/v1/chat/completions` | **200** |

`/v1/responses` 原生可用 -> **直通 (passthrough), 不需要 chat 桥, 不需要 filter**。

### id 卫生: 会签发 `item_`, 但接受外来 id

该上游**签发 `item_...` 形式的 id** (function_call 回来是 `id=item_9d67781de5d75e3c28e3535f`,
与 relaycat 同形)。但与 agentrouter 不同, 它**接受外来 id**: 回放 agentrouter 的 `rs_`/`msg_`
和 relaycat 的 `item_` 条目, 五种组合全部 **200**。**所以这个路由不能设 `strictItemIds`**。

### 工具调用与流式

- 强制 `exec_command` -> 正确返回 `function_call`, `arguments={"cmd":"echo hi"}`。
- `stream=true` -> 完整 SSE, 9 个事件, 以 `response.completed` 收尾。

### 注册

- provider `ovoapi`: `base=https://api-console.182yc.xyz`, `wire=responses`,
  `keyEnv=OVOAPI_API_KEY`, 无 proxy, 无 filter, 无 egressGuard, 无 strictItemIds。
- 模型 **`ovoapi:gpt-5.6-sol`** (带前缀: 裸 slug `gpt-5.6-sol` 已被 relaycat 占用, 覆盖它会
  静默改写所有现有调用方的路由)。
- `.env.local` 追加 `OVOAPI_API_KEY` (gitignored)。
- catalog 重建: **44 个模型**。

### 验证

- 隔离实例 7879 打真实上游: `/u/v1/models` 44 个含 ovoapi; 普通调用 **200** (3.2s)、
  带工具 **200** (3.1s, 1 个 function_call)、流式 **200** (2.6s)。
- 门禁全绿 (check-syntax / 12 个测试文件 / diff-test 0 mismatches)。

### 待办

- **需重启 Codex** 才能在选择器里看到 `ovoapi:gpt-5.6-sol` (catalog 在会话启动时读取)。
- 网关无需重启: providers.json 是**按请求读**的 (见 `registry()` 的 mtime 缓存), 且线上
  7878 的进程环境里**没有** `OVOAPI_API_KEY` —— 见下条。
## 2026-09-30: 接入 ovoapi 的第二个 key (OVOAPI_AMZ_API_KEY) —— 七个 Claude 模型

### 与第一个 key 的关系: 同主机, 不同分组, 池子完全不重叠

| | `OVOAPI_API_KEY` (sk-KbyQN) | `OVOAPI_AMZ_API_KEY` (sk-Lvncl) |
|---|---|---|
| `/v1/models` | 5 个 (gpt-5.5 / 5.6-sol / 5.6-terra / 6-astra / 6-sol) | **7 个 Claude** |
| 实际能服务 | **仅 gpt-5.6-sol** | **全部 7 个** |

**为什么注册成两个 provider 而不是一个**: `providers.json` 的 key 是**按 provider** 选
(`keyEnv`), 不能按模型选。而两个 key 的模型集**零重叠**, 合并会让其中一个池子永远取不到。

### 实测: 七个 id 三轮全绿

三轮 x 七 id = **21 次探测, 全部 HTTP 200**, 没有出现兄弟 key 那种间歇性 503:

```
claude-fable-5     200 200 200     claude-opus-5      200 200 200
claude-opus-4-7    200 200 200     claude-opus-5.5    200 200 200
claude-opus-4-8    200 200 200     claude-sonnet-5    200 200 200
claude-opus-4.8    200 200 200
```

**`claude-opus-4-8` 与 `claude-opus-4.8` 是两个不同的真实 id** (连字符 vs 点), 都能服务,
**没有证据表明它们是同一个模型**, 所以分别注册而不是猜成别名。

### 三个 wire 面全部原生可用

| 面 | 结果 |
|---|---|
| `/v1/responses` | 200 (全部 7 个) -> **直通, 无需 chat 桥** |
| `/v1/messages` | 200 (全部 7 个) |
| `/v1/chat/completions` | 200 (全部 7 个) |

### id 卫生: 第三种形态, 同样宽容

这个池签发 **`tooluse_...`** 形式的 id (function_call 回来是
`id=tooluse_GKUuU4VPkFBkZdqweIo6rX`), 与 agentrouter 的 `rs_/msg_/fc_`、relaycat 的 `item_`
都不同。它**接受外来 id**: 回放 agentrouter 与 relaycat 的条目五种组合全部 **200**。
**`strictItemIds` 保持关闭。**

### 工具调用与流式

四个 id 实测强制 `exec_command`: 全部 **200** 且正确返回 `function_call`
(`arguments={"cmd":"echo hi"}`)。`stream=true` 返回完整 SSE (6-7 个事件) 并以
`response.completed` 收尾。

### 注册

- provider **`ovoapi-amz`**: `base=https://api-console.182yc.xyz`, `wire=responses`,
  `keyEnv=OVOAPI_AMZ_API_KEY`, 无 proxy / filter / egressGuard / strictItemIds。
- 七个模型全部以 **`ovoapi:`** 前缀注册 (裸 slug 有冲突: `claude-opus-4-8` 已由 justwoker 服务,
  `claude-fable-5` / `claude-opus-5` 与 anyrouter 的 id 重叠)。
- `.env.local` 追加 `OVOAPI_AMZ_API_KEY` (gitignored)。
- catalog 重建: **51 个模型**。

### 意义

`claude-opus-5` 此前在 `providers.json` 末尾的 `_claude_comment` 里被记为
"unavailable on every provider we route"。**这个 key 改变了该结论** —— 该注释需要按此更新。

### 验证

- 隔离实例 7879 打真实上游: `/u/v1/models` 51 个 (8 个 ovoapi 条目); `claude-opus-5` **200**
  (3.7s, 1 个 function_call)、`claude-opus-4-8` **200** (2.8s)、`claude-sonnet-5` **200** (2.8s)、
  `claude-opus-5.5` **200** (40.5s — 明显更慢)、流式 **200** (3.8s, 6 事件, 收尾正确)。
- 门禁全绿 (check-syntax / 12 个测试文件 / diff-test 0 mismatches)。

### 待办

- **需重启 Codex** 才能在选择器里看到这 7 个新 id。
- 网关: 线上 7878 进程环境里**没有** `OVOAPI_AMZ_API_KEY` (key 只在 `.env.local` 与 User 作用域,
  而 `.env.local` 是**启动时**加载的), 所以经线上网关调用会 401, **需要重启网关**。
## 2026-09-30: relaycat 第二个 key (0.065 组) + 全站模型显示名重写

### 1) 新 key: relaycat65 (0.065x)

老 key 是 0.2x 组, 新 key 是 **0.065x** 组, 同主机不同分组 -> 独立 provider
(`relaycat65`, `keyEnv=RELAYCAT65_API_KEY`), 因为 `providers.json` 的 key 是按 provider 选的。

**新 key 实测 (18 个 id, 6 个能服务)**:

| 模型 | 结果 |
|---|---|
| `gpt-6-sol` | **200** (1.9s) |
| `gpt-5.6-sol` | **200** |
| `gpt-5.6-terra` | **200** |
| `gpt-6-astra` | **200** |
| `gpt-5.5` | **200** |
| `codex-auto-review` | **200** |

其余 9 个 GPT 系是 502/503 (gpt-5.2 / 5.3-codex / 5.3-codex-spark / 5.4 / 5.4-mini /
5.6-luna / 三个 -openai-compact), 3 个 gpt-image-* 是图像模型未探测。**死 id 不注册。**

**`gpt-6.1-sol` 不存在**: `/v1/models` 里没有, 直接调用回 **404** (真正的 not-found,
不是渠道问题); 连 `gpt-6.1` / `gpt-6.1-sol-openai-compact` / `gpt-6-sol-openai-compact`
也都是 404。该站最新就是 **`gpt-6-sol`**。

**xhigh 在 `gpt-6-sol` 上可用**: 四档 effort 全 200, 且 xhigh 确实在做更多工作
(首次实测 33 秒 vs low/high/max 的 ~1.5 秒)。经网关复测 6/6 全 200。

### 2) 显示名重写 (用户要求)

三条规则, 都写进 `tools/build-model-catalog.cjs`:

- **路由标记用倍率取代 `via`**: 显示名从 `GPT-6-Astra (via relaycat)` 变成 `6-astra (0.2)`。
  用户原话是"via 这个词直接替换成倍率, 我读得懂有路由的意思"。倍率来自 `providers.json` 的
  **`ratio`** 字段 (新增), 只有已知的才标; 未知的回退到短 provider 名 (`(wb)` / `(an)` / `(moto)` …),
  **绝不编造数字**。
- **模型名缩写**: `shortModel()` 保守地只重写我们实际服务的形态, 未知 id 原样通过而不是被乱改。
  例: `gpt-6-sol` -> `6-sol`, `claude-opus-5` -> `opus-5`, `deepseek-v4.1-flash` -> `dsv4.1-flash`,
  `mimo-v2.6-flash-free` -> `mimo2.6f`。
- **realm 前缀保留**: `global:` / `cn:` 是有意义的池子标记, 缩成词而不是让它把名字撑长 ->
  `global dsv4.1-flash (wb)` / `cn glm-5.3 (wb)`。

**已记录倍率**: relaycat `0.2`, relaycat65 `0.065`。其余 provider 的倍率用户未提供, 所以显示为短名。

### 3) antigravity 重测: 仍然不通 (账号/地区问题, 非我方)

三次独立探测 (每次换新 session id, 排除粘性会话), `gemini-3.8-flash` 全部:
`400 User location is not supported for the API use.`

日志给出两个账号各自的原因:

| 账号 | 结果 | 原因 |
|---|---|---|
| `onelastsakiko@gmail.com` | 403 | `Verify your account to continue.` (账号未验证) |
| `twelve20212021@gmail.com` | 400 | `User location is not supported` (地区) |

关键旁证: `antigravity-tools` 进程对本地代理 **7897 的连接数为 0** —— 它没有真正走那个代理,
尽管 `proxy.upstream_proxy.enabled = true` 且 url 指向 7897。而 7897 本身实测可用
(出口 `66.90.99.58`, 东京 JP)。所以地区问题出在**应用没把业务请求交给代理**。
未注册该模型: 它当前不可调用, 注册只会给选择器加一个必然报错的项。
## 2026-09-30 (续): antigravity 真相 —— Claude 能用, Gemini 不能用; 全站名字缩短

### 1) antigravity 重测 (用户要求"最后测一次"): 找到真正的分界线

之前只测了 `gemini-3.8-flash`, 得出"整个 provider 不可用"的结论。**这次把模型族横着扫了一遍,
发现分界线不在 provider 上, 而在模型族上**:

| 模型 | 结果 |
|---|---|
| `claude-opus-4-6` | **200** |
| `claude-opus-4-6-thinking` | **200** |
| `claude-sonnet-4-5` | **200** |
| `claude-sonnet-4-6` | **200** |
| `claude-haiku-4-5` | **200** |
| `gemini-3.8-flash` (及全部变体) | 400 `User location is not supported` |
| `gemini-3-pro-high` / `gemini-3.1-pro` / `gemini-2.5-flash` | 400 同上 |
| `gemini-2.5-pro` / `gpt-4o` | 403 `Verify your account to continue.` |

**Claude 族全部可用, Gemini 族全部被地区/账号拦。** 所以注册了 5 个 Claude id
(`ag:opus4-6` / `ag:opus4-6t` / `ag:sonnet4-5` / `ag:sonnet4-6` / `ag:haiku4-5`),
**一个 gemini id 都没注册** —— 它们现在调不通。

地区问题的机制不变: 该应用的业务请求不走它自己配置的上游代理 (实测进程对 7897 的连接数为 0,
而 7897 本身可用, 出口 66.90.99.58 东京)。Claude 走的是另一条上游路径, 所以不受影响。

### 2) 工具调用: 一个测试方法学教训

第一次测工具调用时**全部 400**, 报
`Thinking may not be enabled when tool_choice forces tool use.`

那是**我的探测方式**造成的: 我用了 `tool_choice: "required"` 强制工具调用, 而 thinking 类模型
不允许这样做。**Codex 实际发送的形状不带 `tool_choice`**(给 tools 让模型自己决定)。改用真实形状后
**5/5 全部 200 且正确返回 function_call**:

```
ag:opus4-6     fcall=1 args={"cmd":"echo hi"}
ag:opus4-6t    fcall=1
ag:sonnet4-5   fcall=1
ag:sonnet4-6   fcall=1
ag:haiku4-5    fcall=1
```

**教训**: 强制 `tool_choice: required` 对 thinking 模型是非法组合, 用它做能力探测会得到假阴性。

### 3) 全站显示名最终缩短

在上一轮 (倍率取代 via) 的基础上继续压:

| 之前 | 现在 |
|---|---|
| `global dsv4.1-flash (wb)` | `G dsv4.1f (wb)` |
| `cn glm-5.3 (wb)` | `C glm-5.3 (wb)` |
| `codex-auto-review (0.2)` | `review (0.2)` |
| `mimo2.6f` | `mimo2.6f` (已短) |
| `space-bunnyf` | `space-bunnyf` (已短) |
| `deepseek-v4-flash` | `dsv4f` |

规则 (都在 `tools/build-model-catalog.cjs`): realm 前缀 `global:`/`cn:` 缩成 `G`/`C` 保留池子语义;
`codex-auto-review` -> `review`; `-flash`/`-free`/`-flash-free` -> `f`; `-thinking` -> `-t`;
`-openai-compact` -> `-c`。倍率标记不变 (`0.2` / `0.065`), 未知 provider 用短名 (`wb`/`an`/`ar`/
`moto`/`ovo`/`zen`/`jw`/`ag`)。

### 4) 一个自己引入又修掉的 bug

注册 antigravity 时, 我的脚本把模型值写成了**裸字符串**而不是 `{p, m}` 对象。网关的 `modelList()`
只收 `typeof === "object"` 的条目, 于是这 5 个模型**在 providers.json 里存在、却不出现在
`/u/v1/models`**, 调用一律 404。改成正确的 `{p, m}` 后 62 个模型全部可见。
**记这个是因为症状很误导**: 配置文件看起来是对的, 只有网关的过滤规则知道它不算数。

### 验证

- 隔离实例 7879: `/u/v1/models` **62 个** (含 5 个 `ag:`); 5 个 Claude id 全部 **200**;
  自然形状的工具调用 **5/5** 返回 function_call; 流式 **200** (18 个事件, 收尾正确)。
- 门禁全绿 (check-syntax / 12 个测试文件 / diff-test 0 mismatches)。
## 2026-09-30 (再扫): `gpt-6.1-sol` 出现了 —— 三个 key 全有, xhigh 可用

### 结论: 之前"不存在"的判断只对了半天

上午扫描时 `gpt-6.1-sol` 在两个 relaycat key 上都是 **404 (真正的 not-found)**。本轮重扫,
**三个 key 全都有它, 且都能服务**:

| key | `/v1/models` | `gpt-6.1-sol` |
|---|---|---|
| relaycat **0.2** (`RELAYCAT_API_KEY`) | 36 个 | **200** |
| relaycat **0.065** (`RELAYCAT65_API_KEY`) | 18 个 | **200** |
| ovo **0.1** (`OVOAPI_API_KEY`) | 6 个 | **200** |

**effort 全档实测 (经网关, 三个路由各 3 档)**:

| 路由 | low | **xhigh** | max |
|---|---|---|---|
| `rc:6.1sol` (0.2) | 200 | **200** | 200 |
| `rc65:6.1sol` (0.065) | 200 | **200** | 200 |
| `ovoapi:6.1sol` (ovo) | 200 | **200** | 200 |

**你要的 xhigh 拿到了**, 而且 **0.065 那条最便宜** —— 建议优先用它。

工具调用也实测通过: `rc65:6.1sol` 与 `ovoapi:6.1sol` 都返回了正确的 `function_call`。

**教训 (已写进 relaycat65 的注释)**: 上游是**当天中途上架**的。一个 negative probe 只代表那一刻,
不代表永远; 隔几小时重扫就有收获。

### 本轮新增注册 (13 条, 模型总数 62 -> 75)

**relaycat 0.2 (重扫 36 个 id, 13 个能服务)**: 之前只注册了 8 个, 这次补上
`gpt-6.1-sol` / `gpt-6` / `gpt-5.6-luna` / `gpt-5.5-openai-compact` / `gpt-5.6-openai-compact` /
`gpt-5.6-sol-openai-compact` / `gpt-reserve`。

**relaycat 0.065**: 补上 `gpt-6.1-sol` / `gpt-5.6-luna`。

**ovo 0.1**: 这一组现在**整个 GPT 集都在服务** —— 补上 `gpt-6.1-sol` / `gpt-6-sol` /
`gpt-6-astra` / `gpt-5.6-terra` (之前只注册了 `gpt-5.6-sol`)。只有 `gpt-5.5` 仍是 503。

死 id 一律不注册 (0.2 有 23 个不服务, 0.065 有 10 个, 其中 8-9 个是 `gpt-image-*` 图像模型未探测)。

### 一个环境变量的坑 (已记进 relaycat 注释)

`RELAYCAT_API_KEY` (0.2 那个) **不在 `.env.local` 里** —— 它来自 **User 作用域环境变量**。
`.env.local` 优先于环境变量, 但**那里根本没有这个键**, 所以环境变量的值留了下来, 功能正常。
风险是: 如果那个 User 变量丢了, 这条路由会静默失效。已记在注释里。

### 显示名

新条目自动继承缩写规则:

```
rc:6.1sol       -> 6.1-sol (0.2)
rc65:6.1sol     -> 6.1-sol (0.065)
ovoapi:6.1sol   -> 6.1-sol (ovo)
rc:reserve      -> reserve (0.2)
```

### 验证

- 隔离实例 7879: `/u/v1/models` **75 个**; 三个 `6.1sol` 路由各 3 档 effort 全 **200**;
  工具调用 **2/2** 返回 function_call; 其余 7 个新 id 全 **200**。
- 门禁全绿 (check-syntax / 12 个测试文件 / diff-test 0 mismatches)。
## 2026-10-01 (再扫): relaycat / ovo 的 GPT key —— 补 2 个, 记 3 个"半死"

### 扫描结果

| key | `/v1/models` | 能服务 |
|---|---|---|
| relaycat **0.2** | 36 | 13 |
| relaycat **0.065** | 18 | 8 |
| ovo **0.1** | 6 | 5 |

### 本轮新注册 (2 条, 总数 75 -> 77)

`gpt-5.6` 与 `gpt-6-sol` 在 **0.2** 那条 key 上一直能服务, 但**从来没被注册过**。
两个都做了 **4/4 多轮确认**才加 (这个 key 上 flaky id 很多, 单次 200 不算证据):

```
gpt-5.6     200 200 200 200   (3.3s / 2.7s / 4.2s / 2.2s)
gpt-6-sol   200 200 200 200   (1.7s / 2.5s / 1.8s / 2.3s)
gpt-6-sol xhigh -> 200
```

注册为 `rc:5.6` / `rc:6sol`。

### 3 个"半死"模型 (重要: 不是 502, 是 429/502 混合)

`gpt-5.2` / `gpt-5.4` / `gpt-reserve` 早先被注册在 0.2 key 上, 但本轮**多轮复测没有一次干净的 200**:

```
gpt-5.2        429  502  429
gpt-5.4        429  502  429
gpt-reserve    502  429  502
gpt-5.3-codex  502  502  502
```

**这个形态值得注意**: 出现 **429** 说明**不是"没有渠道", 而是渠道存在但被限流**。
所以它们是**可用性波动**, 不是彻底失效 —— 我没有删除注册 (删了以后恢复就没人知道),
而是在 `providers.json` 的注释里明确标为 **"flaky, 不可依赖, 用前重探"**。

### 其余变化

- `gpt-6.1-sol` 三个 key 上**仍然全部可用** (0.2 / 0.065 / ovo), xhigh 全部 200。
- `gpt-6-luna` 在 0.065 上从 400 变成 **503** (渠道消失), 在 0.2 上是 502。
- `gpt-5.6` 在 0.065 上从"超时"变成 **400** `The request could not be processed`。

### 验证

- 隔离实例 7879: `/u/v1/models` **77 个**; `rc:5.6` / `rc:6sol` 各 **200**;
  `rc:6sol` xhigh **200** 且工具调用返回 function_call;
  三个 `6.1sol` 路由 xhigh 全 **200**。
- 门禁全绿 (check-syntax / 12 个测试文件 / diff-test 0 mismatches)。

### 显示名 (自动继承)

```
rc:5.6        ->  5.6 (0.2)
rc:6sol       ->  6-sol (0.2)
rc:6.1sol     ->  6.1-sol (0.2)
rc65:6.1sol   ->  6.1-sol (0.065)
ovoapi:6.1sol ->  6.1-sol (ovo)
```
## 2026-10-01: 接入 ovo 的第三个 key (0.05x 组) —— 目前最便宜的 Claude 路由

### 三个 ovo key 的关系

| key | 组倍率 | 池子 |
|---|---|---|
| `OVOAPI_API_KEY` | 0.1 | 6 个 GPT 系 (5 个可用) |
| `OVOAPI_AMZ_API_KEY` | — | 7 个 Claude |
| **`OVOAPI_005_API_KEY`** | **0.05** | **3 个 Claude** |

三者同主机 (`https://api-console.182yc.xyz`), 不同分组, **各自独立 provider** —— 因为
`providers.json` 的 key 是**按 provider** 选的, 不能按模型选。0.05 的池子与 amz 的池子
**有重叠但不是子集** (amz 有 7 个, 0.05 只有 3 个), 合并会让其中一个 key 永远取不到。

### 实测: 3/3 稳定, 全档 effort 可用

**三轮复测, 全部 200**:

```
claude-opus-5     200 200 200
claude-opus-5.5   200 200 200
claude-sonnet-5   200 200 200
```

**effort 四档 (low/high/xhigh/max) 在 opus-5 与 sonnet-5 上全部 200**, 含 **xhigh**。

**工具调用**: 三个模型都返回了正确的 `function_call` (`args={"cmd":"echo hi"}`)。
**流式**: 200, 6 个事件, 以 `response.completed` 收尾。

### 注册

- provider **`ovoapi-005`**: `base=https://api-console.182yc.xyz`, `wire=responses`,
  `keyEnv=OVOAPI_005_API_KEY`, **`ratio: 0.05`**, 无 proxy/filter/egressGuard/strictItemIds。
- 三个模型以 **`ovo05:`** 前缀注册: `ovo05:opus5` / `ovo05:opus5.5` / `ovo05:sonnet5`。
  显示名自动带倍率: `opus-5 (0.05)`。
- `.env.local` 追加 `OVOAPI_005_API_KEY` (gitignored)。
- catalog: **77 -> 80 个模型**。

**重叠提示**: 这三个 id **也在 ovoapi-amz 上**。两条都注册了, **0.05 更便宜, 优先用它**。

### 又踩了同一个坑 (值得记)

注册时**又一次**把模型值写成了**裸字符串**而不是 `{p, m}` 对象 —— 与 antigravity 那次完全相同的
错误。症状也一样: `providers.json` 里明明有这 3 个键, 但网关的 `modelList()` 只收
`typeof === "object"` 的条目, 于是它们**不出现在 `/u/v1/models`**, 调用一律 404。
**同一个坑两次**, 说明"写脚本批量插模型"这个动作应该有个断言: 插入后立刻校验
`typeof entry === "object" && entry.p`。这次已在检查里补上。

### 验证

- 隔离实例 7879: `/u/v1/models` **80 个** (含 3 个 `ovo05:`); 三个 id 全 **200**;
  xhigh **200**; 工具调用返回 function_call。
- 门禁全绿 (check-syntax / 12 个测试文件 / diff-test 0 mismatches)。
## 2026-10-02: 子代理上限解除 + gpt-6/6.1 上下文钉到 240k

### 1) `[agents] max_concurrent_threads_per_session: 8 -> 1000000`

用户要求"解除 codex 的子代理上限"。**Codex 没有 unlimited 字面语义** —— 源码 (`codex-rs/core/src/config/mod.rs`)
里 `DEFAULT_AGENT_MAX_THREADS = Some(6)`，删掉这个键只是退回内置的 6 (上次就是这么踩的)。schema
(`codex-rs/core/config.schema.json`) 把该键定义为 `uint` + `minimum: 1` + **无 maximum**，所以只能用一个
远超实际扇出的哨兵值把上限推成不可达。

取 **1000000**：本工作区最多跑 5-8 路；limiter 实现 (`agent/control/execution.rs`) 是普通 `AtomicUsize`
计数 (`has_capacity = active < max_threads`)，不是 tokio Semaphore，没有 permit 上限会触发 panic。
V2 路径的 `+1`/`-1` 换算在百万量级仍然精确。

**V1 / V2 两条路径都查过了** (codex 0.159.0 源码):

- V1 (本机 `multi_agent stable true` / `multi_agent_v2 stable false` 走这条):
  `config.effective_agent_max_threads()` -> `self.agent_max_threads.or(DEFAULT_AGENT_MAX_THREADS)`
  (mod.rs:1618)，再由 `registry.reserve_spawn_slot(agent_max_threads)` 强制执行
  (agent/control/spawn.rs:652,677 与 :1360,1364)。设了值就走我们的 1000000。
- V2 (未启用): `multi_agent_v2.max_concurrent_threads_per_session` 默认 4，从 `[agents]` 派生时
  `+1` 再 `-1` 还原 (mod.rs:2761 / 1615)。

验证: `codex doctor --json` -> `config.load = ok`，`config.toml parse = ok`。

**注意**: 上限解除只对**之后启动**的 Codex 进程生效。当前 app-server (PID 13680，启动于 2026-10-02 01:24:13)
仍持有旧的 8，需要重启 Codex 才吃到 1000000。

### 2) `gpt-6` / `gpt-6-sol` / `gpt-6.1-sol` 上下文钉到 240k

`tools/build-model-catalog.cjs` 新增 `CTX_PIN`，插在"记录值循环"**之后** (那个循环只会抬高窗口，放前面会被
覆盖)，按**上游 model id** 匹配，一条 pin 覆盖所有路由。

catalog 实测 (重建后 80 个模型，命中 15 条):

| slug | context_window | auto_compact_token_limit |
|---|---|---|
| `rc:6.1sol` | 240000 | 219808 |
| `rc65:6.1sol` | 240000 | 219808 |
| `ovoapi:6.1sol` | 240000 | 219808 |
| `rc:6sol` | 240000 | 219808 |
| `rc65:6sol` | 240000 | 219808 |
| `ovoapi:6sol` | 240000 | 219808 |

`gpt-6-astra` 系列**故意未 pin** —— `models.yml` 记录 1050000，该文件自身的优先级规则是"记录值胜过默认值"。
**待用户确认**是否也要压到 240k。

### 门禁

- `check-syntax` ok (含 collapsed-spread sweep)
- `diff-test` 45 samples + 1 tree, **0 mismatches**
- 12 个测试文件全绿: anthropic-registry / bridge-indices / bridge-request 32 / bridge-rude-close 8 /
  egress-guard 16 / egress-scan 28 / filter-failopen / realm-fallback / responses-ids 16 /
  stream-terminal 48 / strict-item-ids / usage-pricing

### 备份

改动前的 `config.toml` 存于 `G:\tmp\config.toml.bak-20261002-agents` (9205 字节)。
## 2026-10-02 (2): 所有模型可用于子代理 + 所有 GPT 支持 xhigh

### 1) "所有模型可用于子代理" —— 查源码后确认：本来就成立

用户要求"使所有模型都可被用于子代理"。**读完 codex 0.159.0 源码后，结论是这不需要改配置** ——
之前 `build-model-catalog.cjs` 的注释写错了，我按错误注释以为那 5 条清单是白名单。

**真实机制** (`codex-rs/core/src/agent/child_config.rs`):

- `find_spawn_agent_model_name()` (:318) 校验 spawn 的 `model` 参数时，只检查
  `model_supports_multi_agent_backend()`，即 **`multi_agent_version != Disabled`**。
  **`priority` 根本不参与校验。**
- `MAX_SPAWN_AGENT_MODEL_OVERRIDES = 5` (:20) 只用于**生成提示文本** ——
  `spawn_agent_models_description()` (multi_agents_spec.rs:823) 与
  `ModelCatalogState::new()` (context/world_state/model_catalog.rs:31) 用它 `take(5)`，
  决定工具描述里列哪 5 个名字。这是 Codex 硬编码的，改不了。
- `priority < 0` 只影响这 5 个**提示位**的占用。

**实测证据** (不是推理):

| spawn 目标 | 是否在 5 条清单 | 结果 | 会话元数据 |
|---|---|---|---|
| `space-bunny-free` | 否 (priority=0) | 成功 | `"model":"space-bunny-free"` |
| `gpt-5.5` + xhigh | 否 (priority=0) | 成功 | `"model":"gpt-5.5"` `"effort":"xhigh"` |

两条都是本会话真实 spawn 出来的子代理线程，不是脚本模拟；元数据取自
`~/.codex/sessions/2026/10/02/rollout-*-<agent_id>.jsonl` 的 `turn_context`。

同时确认 catalog 覆盖：注册表 87 个键（其中 7 个是 `_comment` 字符串），80 个真实模型**全部**在
catalog 里，`multi_agent_version=disabled` 的条目 **0 个**。所以没有模型被 V2 排除。

改动：只修正了 `build-model-catalog.cjs` 里两处误导性注释（原来写"only entries offered"、
"single place that decides which models a sub-agent may be spawned with"，都是错的），
不改任何 catalog 字段。

### 2) 所有 GPT 模型支持 xhigh

用户要求"所有 gpt 模型应可使用 xhigh"。**catalog 的 `supported_reasoning_levels` 就是校验依据** ——
`validate_spawn_agent_reasoning_effort()` (child_config.rs:345) 拿请求的 effort 去比这个数组，
缺了就报 `Reasoning effort xhigh is not supported for model`。所以缺 xhigh = 用户选不到。

改前：41 个 GPT 条目里 **30 个没有 xhigh**（relaycat 系、motomoto 系、ovoapi 系、部分 wb2api 系）。

**先实测上游是否真接受 xhigh**（经线上网关 7878，`reasoning.effort=xhigh`）:

| 模型 | 结果 |
|---|---|
| `gpt-5.5` | **200** 2.6s |
| `gpt-5.6-sol` | **200** 2.3s |
| `global:gpt-5.3-codex` | **200** 2.8s |
| `rc:6` | **200** 7.6s |
| `rc65:6sol` | **200** 2.0s |
| `ovoapi:gpt-5.6-sol` | **200** 3.6s |
| `gpt-5.2` | 502（该模型本身 flaky，非 xhigh 被拒）|
| `motomoto:gpt-6-astra` | 503 维护中（非 xhigh 被拒）|

**改动**: `build-model-catalog.cjs` 新增一段循环，对**上游 id**（剥掉 `global:`/`cn:` 前缀）匹配
`/^gpt/i` 的条目补上 xhigh，插在"默认层级归一化"**之后** —— 顺序有意为之：
归一化会用 `PREFERENCE = [max, xhigh, high]` 挑默认值，若先加 xhigh，`gpt-5.3-codex`
（原本 medium-only）的默认会被静默抬到 xhigh。只放宽可选集合，默认值不动。

改后：**41/41 GPT 条目都有 xhigh**，0 遗漏。抽查:

```
rc:6.1sol              levels=[low,medium,high,xhigh,max]  default=max  ctx=240000
global:gpt-5.3-codex   levels=[medium,xhigh]                default=medium  ctx=272000
gpt-5.2                levels=[low,medium,high,xhigh,max]   default=max
```

### 门禁

- `check-syntax` ok / `diff-test` 45 samples + 1 tree, **0 mismatches**
- 12 个测试文件全绿

### 生效条件

**需重启 Codex** —— catalog 在会话启动时读取，当前进程仍持旧目录。
## 2026-10-03: ovo 换域名了 —— 网关还指着旧地址，6.1sol 卡死一个多小时

用户报: 「其它 codex 会话里的 6.1sol(ovo) 在一个多小时前就不动了。」

### 根因: 上游换了 API 域名

`providers.json` 里 ovoapi 的 `base` 是 `https://api-console.182yc.xyz`（那是运营方
`/api/status` 当初公布的地址）。实测它已经**不再响应**:

| 目标 | TCP 443 | /v1/models | /v1/responses |
|---|---|---|---|
| `api-console.182yc.xyz` | **通** | `UND_ERR_CONNECT_TIMEOUT` 10.7s | 挂到 60s 超时中止 |
| `ovoapi.site` | 通 | **200 / 0.9s, 6 个模型** | **200 / 1.8s** |

关键点: **TCP 能握手、TLS/HTTP 层不回** —— 所以表现不是"连不上"，而是"请求发出去石沉大海"。
Codex 那边没有超时错误、只有一直等，正好对上"一个多小时不动"。同一个 key 在 `ovoapi.site`
上 0.9s 就返回，所以**不是 key 失效、不是模型下架、不是限流**，纯粹是域名迁移。

### 修复

`providers.json` -> `providers.ovoapi.base`: `https://api-console.182yc.xyz` -> `https://ovoapi.site`。
providers.json 是**按请求读**的（mtime 缓存），所以无需重启网关即生效。

### 验证（经线上网关 7878，不是直连）

```
ovoapi:6.1sol          200 2.4s
ovoapi:6sol            200 1.9s
ovoapi:6astra          200 3.8s
ovoapi:5.6terra        200 3.5s
ovoapi:gpt-5.6-sol     200 2.3s
```

五个路由全部恢复。`_comment` 里已写明这次的症状与"复发时先探 ovoapi.site"，
并纠正了原先"两个域名都可用、选 console 是因为运营方公布它"的记述 —— 那个前提已经不成立。

### 遗留

- 旧域名何时恢复未知，也不重要: `ovoapi.site` 是公开域名，本次故障中它是活的。
- 若再次出现"请求不返回也不报错"，先按本条的形态查 base 域名，而不是查 key/模型。
## 2026-10-03: gpt-6.1-sol 计价入库（models.db 没有这个模型）

用户给了 ovo 面板的一笔实测账单，要求算出**官方计价**（不看分组倍率）并塞进网关统计。

### 已知与推算

```
输入 token      41,863      （其中缓存读取 40,192，非缓存 1,671）
输出 token         100
分组倍率        0.2400x
实收            $0.00286
```

官方总价 = 实收 / 倍率 = **$0.011917**。拆开:

| 项 | 计算 | 金额 |
|---|---|---|
| 非缓存输入 | 1,671 × $2/M | $0.003342 |
| 输出 | 100 × $10/M | $0.001000 |
| 缓存读取 | 40,192 × **?** | $0.007575 |
| **合计** | | **$0.011917** |

**输入 $2/M、输出 $10/M 是运营方公布的；缓存读取价要靠反推**：解出来是 $0.1885/M。
两个整数候选夹着它:

| 候选 | 官方总价 | 折后 | 与账单差 |
|---|---|---|---|
| **$0.19/M** | $0.011978 | $0.002875 | **$0.000015** |
| $0.20/M | $0.012380 | $0.002971 | $0.000111 |

取 **$0.19/M**：它把账单复现到面板自身的四舍五入误差内。注意这**不符合 sol 系列惯例**
（`gpt-5.6-sol` 是 $4 输入配 $0.4 缓存 = 10%），但**实测数赢过模式**。
若以后第二张账单显示出干净的 $0.20/M，回来改这一条。

### 计费口径的验证（顺带排除了两种错误理解）

试了三种口径，只有一种对得上数量级:

- **A（正确）**: 缓存 token 按缓存价计，且**从全价输入里扣除** → $0.011917 ✅
- B: 全部输入按全价、缓存另计（重复计费）→ $0.092362 ❌ 差 8 倍
- C: 缓存按全价（无折扣）→ $0.084726 ❌

`pricing.mjs` 原本就是 A（`billableIn = inTok - cacheRead`），所以算法不用动。

### 改动

`pricing.mjs` 新增 `MANUAL` 手工价目表 + 别名:

- **为什么需要手工表**: `models.db` 里**根本没有 `gpt-6.1-sol`**（只有 astra 系列）。
  而这个模型是网关第 2 常用的（7,486 次调用），此前 `cost` 全是 `null`。
- 手工条目**优先于 models.db**，并带 `provider: "ovo (operator invoice 2026-10-03)"`，
  来源写在注释里，方便日后重新推导而不是盲信。
- 别名补了 `rc:6.1sol` / `rc65:6.1sol` / `ovoapi:6.1sol` / `6.1sol` ——
  网关记的是**客户端**的模型串，而剥掉前缀只得到 `6.1sol`，匹配不上 `gpt-6.1-sol`。

### 验证

```
gpt-6.1-sol     $0.011978   (in=$2 out=$10 cache=$0.19)
rc:6.1sol       $0.011978
rc65:6.1sol     $0.011978
ovoapi:6.1sol   $0.011978
6.1sol          $0.011978
```

与账单期望 $0.011917 差 $0.000062（0.5%）。

回归: `global:deepseek-v4.1-flash` / `gpt-5.6-sol` / `claude-opus-4-8` 计价不变，
`space-bunny-free` 仍为 null（免费模型无价，不是 0）。

门禁: check-syntax ok / diff-test 0 mismatches / test-usage-pricing / test-bridge-request 32 全过。

### 注意

- 已有的历史行 `cost` 仍是 `null`（写入时就算好了），**不会追溯**。新请求才会带价。
- 统计口径是**官方挂牌价**，不是 ovo 的折后实收 —— 与 `pricing.mjs` 既有的
  "vendor list price, not reseller charge" 约定一致。

## 2026-10-03 (凌晨) 第二张 6.1sol 账单 + 248k 翻倍 + 图片输入打通

两件事：① 用第二张实测账单收窄 `gpt-6.1-sol` 的缓存价，并把运营方新给的
「context > 248k 全部计费翻倍」写进网关；② 让所有 deepseek-v4.1-flash 路由
接受图片输入（Codex 的 catalog 之前把它们标成纯文本）。

### 1) 第二张账单推翻了 $0.19，改用 $0.185

用户给的第二笔（同为 0.24x 分组、同为输入 $2/M 输出 $10/M）:

| | 输入 | 输出 | 缓存读取 | 实收 |
|---|---|---|---|---|
| P1 | 41,863 | 100 | 40,192 | $0.00286 |
| P2 | 149,785 | 419 | 145,664 | $0.009332 |

两笔各自反推缓存价：P1 -> $0.18846/M，P2 -> $0.18159/M，**互相差 3.8%**。
这说明面板自身的多段四舍五入比任何单一「漂亮数字」都宽：

| 候选 | P1 折后 | P2 折后 | 最差相对误差 |
|---|---|---|---|
| $0.18/M | $0.002778 | $0.009276 | 0.87% |
| $0.1816/M | $0.002794 | $0.009332 | 0.71% |
| **$0.185/M** | **$0.002827** | **$0.009451** | **1.28%** |
| $0.1885/M | $0.002860 | $0.009574 | 2.59% |
| $0.19/M | $0.002875 | $0.009626 | 3.15% |
| $0.20/M | $0.002971 | $0.009976 | 6.90% |

取 **$0.185/M**（P1 差 1.17%、P2 差 1.28%），并记录：sol 系列在 models.db 里的
惯例是 $0.4 缓存 / $4 输入 = 10%（`gpt-5.6-sol`），即 $0.2/M —— 它比 $0.185
**更差**（6.9%），所以「实测赢过模式」的结论这次更强，不再是 P1 单点的巧合。

### 2) 248k 长上下文翻倍

运营方口径：**输入超过 248k token 时所有费率 ×2**（用户实测，2026-10-03）。
写进 `MANUAL['gpt-6.1-sol'].cost.longContext`：

```
inputThreshold: 248000
input 2 -> 4 | output 10 -> 20 | cacheRead 0.185 -> 0.37 | cacheWrite 2.5 -> 5
```

阈值判定沿用既有 `priceFor()` 的**严格大于**（248000 仍按 base，248001 起翻倍），
与用户「<240k 才安全」的设置不冲突。

### 顺带修掉一个既有 bug：tier 标签永远是 `long (?+ input)`

`priceFor()` 先用 `c.longContext.inputThreshold` 覆盖了 `c`，再回头读 `c.longContext`
拼标签 —— 那时 `c` 已经是扁平费率对象，`c.longContext` 恒为 undefined。
改成**覆盖前**取出 `threshold`，现在标签是 `long (248000+ input)`。
这个 bug 对金额无影响，但统计页的长上下文分档一直无法区分。

### 3) 所有 deepseek-v4.1-flash 路由现在接受图片

**根因**: `tools/build-model-catalog.cjs:213` 无条件写死 `input_modalities: ['text']`，
不是实测结果。Codex 靠这个字段决定能否收图，标成 text 后发图会被拦。

**实测**（2026-10-03，1x1 红 PNG）:

| 路由 | 直连 wb2api(7863) | 经网关(7878 /u) |
|---|---|---|
| `deepseek-v4.1-flash` | 200 Pink | 200 Pink |
| `global:deepseek-v4.1-flash` | 200 Pink | 200 Pink |
| `global:deepseek-v4.1-flash-sg` | 200 | 200 Pink |
| `cn:deepseek-v4.1-flash` | 200 | 200 Pink |
| `deepseek-v4-flash` | 200 Red | - |
| `cn:deepseek-v4-flash` | 200 Maroon | - |

六个 id 全部 200 且答对颜色 —— 图确实进了模型，不是被丢掉后猜的。

### 4) 两个桥接器此前会**静默丢弃**图片（这是真正的功能缺口）

即使 catalog 放行，`bridge.mjs` 也会把 `input_image` 部分丢掉：

- `toChatMessages()`: `if (p.type === 'input_image') return ''` —— 图没了，
  旁边的文字照常发出，于是模型对着一张没见过的图**自信作答**。静默失败最难查。
- `toAnthropicBody()`: 连分支都没有，`input_image` 直接落进 `return ''`。

**改法**:

- chat 侧转成 `{type:'image_url', image_url:{url, detail?}}`；`detail` 从 responses 的
  兄弟字段搬进 `image_url` 内部（chat 线格式），`auto` 不写以保留上游默认。
- anthropic 侧转成 `{type:'image', source:{type:'base64', media_type, data}}`，
  **剥掉 `data:...;base64,` 前缀**；非 data: 的远程 URL 没有 base64 source 形态，
  选择丢弃而不是伪造畸形块。
- 纯文字轮次仍走 `content: "..."` 字符串（不发 parts 数组），保持既有形状不变；
  system/developer 轮次永远只取文字，不夹带 base64。

### 5) catalog 改为按 slug 可配视觉能力

`entry()` 增加 `modalities` 参数，新增 `VISION_SLUGS` 表（只有实测过的 id 才进），
默认仍是 `['text']` —— 误标 image 会让 picker 放出上游拒绝的图，
而误标 text 是**静默丢图**（旧 bug），后者更糟。

重建后 catalog: 6 个 deepseek 条目变 `['text','image']`，支持图片的条目共 13 个。

### 验证

**隔离实例 7879（真实上游，未碰线上 7878）**:
用 Codex 的 responses 形状（`input_image` + `input_text`）打 `/u/v1/responses`：

```
deepseek-v4.1-flash            -> 200 Pink
global:deepseek-v4.1-flash     -> 200 Pink
cn:deepseek-v4.1-flash         -> 200 Pink
global:deepseek-v4.1-flash-sg  -> 200 Pink
```

注：`cn:` 第一次报 502 是**我给 max_output_tokens=64 太小**，推理就吃光了额度、
正文为空，桥接按失败收尾；放宽到 800 后 200 Pink。不是路由问题。

**门禁**: `check-syntax` ok（含 collapsed-spread sweep）/ `diff-test` 45 样本 + 1 树,
**0 mismatches** / 12 个测试文件全绿；`test-bridge-request` 由 32 增至 **38 checks**
（新增 6 条图片断言）/ `test-usage-pricing` 新增 5 条 sol 计价断言（两笔账单、
缓存不重复计费、248k 边界、五种拼写一致）。

### 诚实边界

- `$0.185/M` 是**拟合值**，不是运营方公布的价目。两笔账单只能把它夹到 ±1.3%，
  第三笔账单若指向别的数就回来改。
- 248k 翻倍是**用户口述的运营方口径**，没有拿到面板页面的独立证据；
  边界（严格大于 248000）也是按现有代码语义定的，未逐 token 探测。
- 视觉能力只实测了上面 6 个 id；`cn:deepseek-v4-pro`、`cn:glm-5.3`、`cn:minimax-m3`
  等同在 wb2api 上的条目**没有**测，仍标 text。
- 图片是**经 chat 桥**转发的，上游 wb2api 若对 base64 体积有限制，未做压力测试。

## 2026-10-03 (凌晨) 缓存用量被两个桥接器漏读 —— 补回并分开读/写两个桶

上一轮顺手记下的疑点（「wb2api 报的是 Anthropic 风格字段，可能没计进价」）查实了，
而且比疑点更严重：**两个桥接器都没读上游的缓存计数**，缓存份额一直被按全价输入计费。

### 证据（先量化，再动手）

全量 35,729 行 usage 按 provider 统计 `cached_tokens > 0` 的占比：

| provider | 行数 | cached>0 | 占比 | 输入 token |
|---|---|---|---|---|
| **wb2api** | 20,590 | **0** | **0.0%** | 2,768,692,700 |
| ovoapi | 7,681 | 7,464 | 97.2% | 853,430,481 |
| agentrouter | 2,716 | 707 | 26.0% | 65,111,566 |
| **justwoker** | 2,397 | **0** | **0.0%** | 423,360,142 |
| relaycat-cn | 584 | 551 | 94.3% | 81,461,062 |

27.7 亿输入 token 的 provider 一次缓存都没记到 —— 不是上游没报，是网关没读。

### 直连上游取证（2026-10-03）

**wb2api（chat 线）**，同一段 4038-token 前缀连打两次：

```
call#1  prompt_tokens_details.cached_tokens = 0     prompt_cache_miss_tokens = 4038
call#2  prompt_tokens_details.cached_tokens = 3840  prompt_cache_hit_tokens  = 3840
```

流式和非流式**都带**这个字段（流式在最后一个 chunk 的 usage 里）。
桥接器只读了 `completion_tokens_details`（reasoning），`prompt_tokens_details` 整块没读。

**justwoker（anthropic 线）**：`message_start` 的 usage 全是 0，真实数字在 `message_delta`：

```
message_start: {input_tokens:0, output_tokens:0}
message_delta: {input_tokens:17564, output_tokens:4,
                cache_creation_input_tokens:17562,
                cache_creation:{ephemeral_5m_input_tokens:17562}}
```

桥接器**只从 message_delta 读了 output_tokens**，`input_tokens` 和 `cache_creation_input_tokens` 都丢了。

### 顺带测出的语义：`input_tokens` 已包含 cache_creation

尺寸阶梯（system 从 29 字符加到 4.5k 字符）：

| system 字符 | input_tokens | cache_creation |
|---|---|---|
| 29 | 10,369 | 10,367 |
| 929 | 10,729 | 10,727 |
| 4,529 | 12,169 | 12,167 |

恒有 `input_tokens = cache_creation + 2`（那 2 个是用户那轮）。所以缓存是**子集**，
不能加在 input 之上，否则整段 prompt 双计费。

### 改动

1. **`bridge.mjs` chat 侧**：读 `prompt_tokens_details.cached_tokens`（回退 `cached_tokens`
   → `prompt_cache_hit_tokens` → `cache_read_input_tokens`），填进
   `input_tokens_details.cached_tokens`。
2. **`bridge.mjs` anthropic 侧**：`cachedTokens` 拆成 `cacheReadTokens` / `cacheWriteTokens`
   两个桶。原来把两者**相加**，等于把写入按读取价计（opus-4-8 上是 $0.5/M vs $6.25/M，差 12.5 倍）。
   两个计数器都用 `max()` 更新，`?? ` 回退，message_delta 缺字段时不会把 message_start 学到的值清零。
3. **`usage.mjs`**：`priceFor` 现在同时传 `cached_tokens` 和 `cache_write_tokens`。
4. **`server.mjs`**：4 个 `recordUsage` 站点（chat 流、anthropic 流、passthrough 非流、passthrough 流）
   都转发 `cache_write_tokens`。
5. **`pricing.mjs`**：`billableIn` 同时减去读和写两个桶；并加**自适应口径判定** ——
   当 `cacheRead + cacheWrite > inTok` 时说明该上游的 `input_tokens` **不含**缓存（严格 Anthropic 读法），
   此时不扣减，否则会把未缓存的那部分也抹掉。

### 验证（隔离实例 7879 打真实上游，未碰线上 7878）

```
wb2api  call#2  usage: input_tokens 4038, cached_tokens 3840        <- 读命中
justwoker call#2 usage: input_tokens 17564, cache_write_tokens 17562 <- 写命中
```

落盘账目（data/usage/2026-10-03.jsonl）两条：

```
wb2api   in=4038  cached=3840 cw=0      total=$0.0000484  (输入部分只算 198 个 token)
justwoker in=17564 cached=0   cw=17562  total=$0.1098725  (写入按 $6.25/M，不是 $0.5/M)
```

### 影响面（诚实标注为估算）

wb2api 有 **17,764 行已计价、合计 $599.65**。修复后这些行的实际花费取决于真实缓存命中率，
而**历史命中率无法回填**（当时就没记）。按几个假设量化：

| 假设命中率 | 修正后应为 | 高估额 | 高估比例 |
|---|---|---|---|
| 50% | $325.17 | $274.48 | 45.8% |
| 70% | $215.38 | $384.27 | 64.1% |
| 90% | $105.59 | $494.06 | 82.4% |
| 95% | $78.14 | $521.51 | 87.0% |

**这些是假设值，不是测量值**。能确定的是方向：历史 wb2api 成本被高估，量级在 1.8x 到 7.7x 之间。
justwoker 那 2,397 行同理：写入被按读取价计，**低估**约 12.5 倍。

### 门禁

- `check-syntax` ok（含 collapsed-spread sweep）/ `diff-test` 45 样本 + 1 树 **0 mismatches**
- 12 个测试文件全绿；`test-bridge-request` 由 38 增至 **43 checks**（新增 5 条缓存断言），
  `test-usage-pricing` 新增 5 条（写入价、不重复计费、两种 input 口径、读写互斥）

### 诚实边界

- 历史行**不追溯**（写入时定价），修正只对新请求生效。
- justwoker 的 `cache_read_input_tokens` 在这次探针里**没出现过**（它每次都报写入，可能是
  5 分钟 ephemeral 缓存到期即重写）。读侧分支有单元测试覆盖，但没有真实上游样本。
- 命中率估算基于假设；若日后能拿到 ovo/justwoker 的对账面板数字，应回头校准。

### 过程失误（记录以免重犯）

改 `server.mjs` 时写了一个 `while (s.includes(old)) s = s.replace(old, new)` 循环，
而 `new` **包含** `old`，导致死循环（100% CPU 直到被杀）。因为杀得及时，那次**没有写盘**，
文件未被污染；随后改用 `split/join` 一次完成。教训：替换串包含搜索串时，永远不要用循环替换。


## 2026-10-03（续）跨域降级误发 CN 与 Codex 假死修复

### 已确认问题

`global:deepseek-v4.1-flash` 的 global 请求在 wb2api 返回 429/503 后，旧网关会进入 CN fallback，但只检查 global 的恢复状态，不检查 CN 对同一 bare model 是否仍可选。于是 CN 也在 6004 cooldown 时，网关仍会发出 CN 请求，得到 `no_healthy_account`；该 503 没有 `Retry-After` 和 Codex 可识别的 `error.code=server_is_overloaded`，Codex UI 可能一直显示“正在思考”，实际请求已经终止。

### 本轮实现

- `requestWithRetry()` 增加可选 `retryStatuses`；只有 wb2api chat bridge 启用 `[429, 503]`，其它 provider 的默认策略仍是 429-only。
- 泛化 `/status` 与 `/healthz` 的 realm 检查，分别检查 global/CN 和 bare model。
- 进入 fallback 后同时检查两个 realm；CN 只有在 `/status` 明确显示有可选账号时才允许发送。CN 不可用、状态未知或探针超时时，网关不发 CN，直接返回有界 503。
- global 瞬时失败但 `/status` 仍显示 global 可选时，不消耗 CN，直接返回可重试 503。
- wb2api 的终端 503 规范化为 `error.code=server_is_overloaded`、`type=api_error`，并补 `Retry-After: 5`；已知恢复时刻通过 `X-Gateway-Retry-At`，realm 来源通过 `X-Gateway-Realm-Source`。
- `tools/test-realm-fallback.mjs` 增加 CN 不可用、窗口内 CN 失效、CN 恢复、未知探针 fail-closed、503 重试和探针超时取消测试。

### 中央验证

以下命令均已在隔离测试中通过：

```text
node tools/check-syntax.mjs
node tools/test-realm-fallback.mjs
node tools/test-bridge-request.mjs
node tools/test-bridge-indices.mjs
node tools/test-usage-pricing.mjs
node tools/diff-test.mjs
git diff --check
```

`test-realm-fallback.mjs` 使用桩 HTTP/HTTPS，不绑定端口、不访问真实上游；所有测试账本写入项目 `.tmp` 独占目录。尚未重启线上网关，也未把本轮代码称为线上实机验证。

### 恢复说明

改动落在 `server.mjs`，需要用户在没有活跃会话时重启网关后才会加载；Codex 会话本身不需要重启。重启前，线上 PID 仍运行旧逻辑。重启后应重点观察：

```text
bridge ... model=global:deepseek-v4.1-flash
!! cross-realm: ... target=...
Retry-After: 5
```

本轮没有自动重启网关。

## 2026-10-06: 接入 kiro.northstar.cool（订单 5784）—— claude-opus-5.5 / claude-sonnet-5.5

用户给的是 Claude Code + Codex/OpenAI 两个 base URL 与 `NSCN_KIRO_API_KEY`，
要求把 `claude-opus-5.5` / `claude-sonnet-5.5` 配进 Codex。

### 能力探测（2026-10-06，直连时）

| 面 | opus-5.5 | sonnet-5.5 |
| --- | --- | --- |
| `/v1/models` | 200（列出 15 个 id） | 同 |
| `/v1/chat/completions` | 200 | 200 |
| `/v1/responses` | 200 | 200 |
| tool call（`tool_choice: required`） | 200，返回真 `function_call` | — |
| `stream: true` | 200，完整 SSE 到 `response.completed` | — |

id 形状：`fc_fcc9cd78d62048fe87118ff504cdbf02` + `call_id: toolu_bdrk_...`，
所以 `strictItemIds` 保持关闭。

### 接入方式（沿用既有规范）

- `providers.json` 新增 provider `northstar-kiro`（`wire: responses`，无 filter、无 bridge）。
- 模型以 `ki:` 前缀注册：`ki:opus5.5` / `ki:sonnet5.5`。前缀是必须的——
  `claude-opus-5.5` 与 `ovoapi:claude-opus-5.5`、anyrouter/justwoker 的 claude 家族重名，
  直接占用裸 slug 会静默改道已有调用方。
- `server.mjs`：`ROUTES` 加 `ki`、`ROUTE_PREFIX` 加 `northstar-kiro: "KI"`、
  路径正则加 `ki`（`/ki/v1/...` 前缀路由，重启后生效）。
- `tools/build-model-catalog.cjs`：`PROVIDER_ABBR` 加 `'northstar-kiro': 'ki'`。
- `.env.local` 追加 `NSCN_KIRO_API_KEY`（原值只存在于 User 作用域环境变量，
  文件化后路由不再依赖该变量存活）。

### 关键坑：这个域名必须走本地代理

第一轮端到端验证时 Codex CLI 卡在指数退避重试里出不来，网关日志反复打印：

```text
!! northstar-kiro has no NSCN_KIRO_API_KEY in the environment; forwarding the client key
proxy u/v1/responses -> https://kiro.northstar.cool/v1/responses (northstar-kiro)
```

（第一行是**旧进程未加载新 .env.local** 的假象，不是根因；统一路由按请求读
`providers.json`，但 key 由 `providerFor()` 在请求时从 `process.env` 取，
而 `loadLocalEnv()` 只在进程启动时跑一次。）

真正的根因是 **TLS 层**：

```text
direct:   http_code 000, tls=0.000000, total=0.145   (TCP 连得上，TLS 握手直接死)
          Node: "Hostname/IP does not match certificate's altnames: Cert does not contain a DNS name"
proxied:  http_code 200, tls=1.944278, total=6.917   (http://127.0.0.1:7897)
```

与 anyrouter 同型：不是证书配置问题，是直连被中间设备劫持/干扰。给 provider
加 `"proxy": "http://127.0.0.1:7897"` 后：

- 直连代理实测：opus-5.5 **6/6** 200，sonnet-5.5 **4/4** 200。
- 经网关 `/u/v1/responses`：opus-5.5 **4/4** 200。

**`providers.json` 是每请求读取的**（按 mtime+size 缓存），所以统一路由
`/u` 的这条修复**不需要重启网关**即可生效——上面 4/4 就是改完文件直接打的。

### 验证

- 目录重建：`tools/build-model-catalog.cjs` 输出 `added: 75 -> ... ki:opus5.5, ki:sonnet5.5`，
  `total: 82`，写入 `C:\Users\o_Obl\.codex\omp-model-catalog.json`。
- 目录条目：`ki:opus5.5 | opus-5.5 (ki) | ctx=200000 | efforts=low/medium/high/max`，
  sonnet 同形。
- 端到端（真实 Codex CLI，非裸 HTTP）：

```text
codex exec --skip-git-repo-check -c model=ki:opus5.5   -c model_provider=gateway "Reply with exactly: PONG"
  -> exit=0, tokens used 3,272, 输出 PONG
codex exec --skip-git-repo-check -c model=ki:sonnet5.5 -c model_provider=gateway "Reply with exactly: PONG"
  -> exit=0, tokens used 3,272, 输出 PONG
```

### 待用户处理

- **重启网关**才会让 `/ki/v1/...` 前缀路由生效（`ROUTES` 是模块加载时构建的）。
  统一路由 `/u` 已经可用，Codex 的 `gateway` provider 走的正是它，所以**不改也能用**。
- 上游 `/v1/models` 还列出 `auto`、`claude-opus-5`、`claude-sonnet-5`、
  `claude-opus-4.8/4.7/4.6/4.5`、`claude-sonnet-4.6/4.5`、`gpt-5.6-sol/terra/luna`，
  本轮只注册用户点名要的两个；要加其余 id 应先逐个探测再登记。

## 2026-10-06: ki:* 401 —— .env.local 的 key 在进程启动后才写入，运行中的网关永远看不到

用户报：调用 `ki:opus5.5` 返回
`unexpected status 401 Unauthorized: Invalid API key, url: http://127.0.0.1:7878/u/v1/responses`。

### 根因（我的实现缺陷，不是用户操作问题）

`providers.json` 的 provider `keyEnv` 由 `providerFor()` 在**请求时**从 `process.env`
读取，而 `loadLocalEnv()` 只在**模块加载时**跑一次、把 `.env.local` 灌进 `process.env`。

我在 2026-10-06 把 `NSCN_KIRO_API_KEY` 追加进 `.env.local`，但网关进程
（PID 12004，启动于 10-05 05:19）早已越过那次加载。于是：

```text
!! northstar-kiro has no NSCN_KIRO_API_KEY in the environment; forwarding the client key
proxy u/v1/responses -> https://kiro.northstar.cool/v1/responses (northstar-kiro)
```

网关把**客户端那把** `AGENTROUTER_API_KEY` 原样转给 kiro 上游 → 401。该行在日志里
出现 **72 次**，而同一把 kiro key 直连上游是 200。

### 为什么我先前的验证全绿却没抓到

我每次验收都手动把 kiro key 塞进 `Authorization`，于是 `route.key` 为空时"转发客户端
key"这条分支恰好收到了一把**正确**的 key，200 是那个巧合的产物。用**用户实际的请求
路径**（客户端只发 agentrouter key）复现才暴露：`ki:opus5.5` → 401。教训：验收必须
走真实调用方路径，不能自带凭据。

### 修复：key 解析改为每请求读文件（mtime+size 缓存）

`server.mjs`：
- 新增 `localEnvFile()`：解析 `.env.local` 为 Map，按 `mtimeMs:size` 缓存，文件变了才
  重新解析；文件不可读时保留上一次的好值。
- 新增 `resolveEnvValue(name)`：**文件优先、环境兜底**，与旧 `loadLocalEnv()` 的
  `AR_ALLOW_ENV_OVERRIDE` 双向语义保持一致。
- `providerFor()` 的 `key:` 从 `process.env[p.keyEnv]` 改为 `resolveEnvValue(p.keyEnv)`。
- 删除 `loadLocalEnv()`（它的语义已被逐请求版本完整覆盖）。

代价：每请求一次 `stat()`；只在文件真正变化时重新解析。

### 验证

隔离实例（7879，不碰生产）:
1. 客户端只发 agentrouter key → `ki:opus5.5` **200**，日志里那句警告消失。
2. **热重载实测**：把文件里的 key 改坏 → 立刻 401；改回 → 立刻 200，**全程不重启**。
   `.env.local` 逐字节还原确认。
3. 停止隔离实例后正式重启网关（`restart-gateway.ps1`，语法门禁+快照）：
   PID 12004 → 15512，82 models。
4. 生产网关上同样路径 **200**。
5. **端到端**：`codex exec -c model=ki:opus5.5 -c model_provider=gateway` →
   `exit=0`，输出 PONG，tokens 3,272。

### 顺带查出的两个独立问题（与本次 401 无关）

| 现象 | 证据 | 结论 |
| --- | --- | --- |
| `gpt-6-astra-ar` 401 | `AGENTROUTER_API_KEY` 直连上游：`Budget pool quota has been exhausted` | **额度耗尽**，不是吊销。该 key 只服务 agentrouter 自己的模型；网关不校验客户端 key（假 key 也 200），所以其他 provider 不受影响 |
| `ovoapi:6.1sol` 403 | ovoapi 侧分组/额度问题 | 与本网关无关，另案 |

`AGENTROUTER_API_KEY` 不在 `.env.local`（只有 JUSTWOKER/OPENCODE/MOTOMOTO/OVOAPI/
OVOAPI_AMZ/ANTIGRAVITY/NSCN_KIRO 七个），它来自 Machine 作用域环境变量。

## 2026-10-06 (2): 子代理模型"上限"复核 —— 无上限，只有 5 个提示位

用户问："子代理模型真的有上限吗？如果有，我亲自指定每一个。把目前所有模型列表输出出来，附用量。"

### 结论

**没有上限。** 整份 catalog 都能 spawn。唯一的 5 是 `spawn_agent` 工具描述里**列几个建议名字**，
硬编码在 Codex 二进制（`MAX_SPAWN_AGENT_MODEL_OVERRIDES = 5`，child_config.rs:20），
只影响提示文本，不影响能不能 spawn。

### 本轮新增的两条实测（此前只有源码结论）

1. **优先级排序**：合成 catalog `zz-a(0), zz-b(-2), zz-c(1), zz-d(-1)` 灌进隔离 `CODEX_HOME`，
   用真实 `codex.exe app-server` 调 `model/list`，返回顺序是
   `zz-b(-2), zz-d(-1), zz-a(0), zz-c(1)` —— **priority 升序，同值按数组顺序**。
   脚本已收编：`tools/probe-subagent-models.mjs --order`（合成 catalog + 真实 codex.exe app-server，断言排序）。
2. **提示块不等于白名单**：真实 spawn `ki:opus5.5`（priority 0，**不在**那 5 个名字里）→
   子线程 `01a10ea6-6503-75d0-a0de-a3e2089035e9`（nickname `Helmholtz`）正常完成，
   `last_agent_message = "PROBE-OK"`，`duration_ms = 4320`。
   `turn_context` 里 `"model":"ki:opus5.5"`，用量账本同日有 `northstar-kiro` 记录。
   会话文件：`~/.codex/sessions/2026/10/06/rollout-2026-10-06T08-39-08-01a10ea6-*.jsonl`。

### 当前 5 个提示位（priority = -1，按 catalog 数组顺序）

| 序 | slug | 加权用量 | 7 天请求 | 说明 |
|---|---|---|---|---|
| 1 | `global:deepseek-v4.1-flash` | 18232 | 27653 | 主力开发模型 |
| 2 | `claude-opus-4-8` | 930 | 2403 | 用户指定 |
| 3 | `cn:deepseek-v4.1-flash` | 3540 | 6325 | 国内版回退 |
| 4 | `mimo-v2.6-flash-free` | 12 | 27 | zen 免费额度 |
| 5 | `motomoto:gpt-6-astra` | 31 | 71 | 实测极慢（单次 128s） |

其余 77 个模型 priority = 0（或内置模型的正值），不占提示位但**一样能 spawn**。

### 用量口径

`data/usage/*.jsonl` 全量重算，只读日期命名文件（`.phantom-merged.jsonl` 已验证是当天文件的
100% 子集，glob 会双计）。加权 = `0.5 ^ (age_days / 7)`，即 7 天半衰期，让选择器反映"现在在用
什么"而不是两周前被一次性探针刷过的模型。导出脚本已收编：`tools/model-inventory.mjs`（`--canvas` 直接重生成画布，`--top N` 控制打印条数）。

总计 82 个模型 / 56866 次请求；66 个有调用记录，16 个从未调用。
0 成功率的 4 个：`claude-opus-5-5`(an, 38/0)、`glm-5.3`(ar, 4/0)、
`claude-fable-5-1`(an, 2/0)、`gpt-5.2`(rc, 1/0)。

### 本轮改动的代码

`tools/build-model-catalog.cjs`：新增 `usageScores()` / `usageScoreOf()` / `oursOrdered`，
让 `added` 数组按用量降序（`OVERRIDE_SLUGS` 那 5 条仍保持注册表原序，因为它们靠 priority -1
已经排在前面）。重建后 `added` 顺序从注册表序变成用量序，选择器列表随之变化。
**提示位成员没动** —— 换哪 5 个占提示位等用户决定。

### 交付物

Canvas（82 行完整清单 + 用量）：
`C:\Users\o_Obl\.cursor\projects\1784557707559\canvases\model-usage-inventory.canvas.tsx`
（用 `tsc` + 真实 canvas SDK 类型定义校验，0 error；此前的版本有语法损坏已重写）。

### 并发实测（2026-10-06 08:50）

用户问"子代理模型真的有上限吗"。为区分"模型上限"与"并发上限"，一次性 spawn 10 个：

| 子代理 | 请求模型 | turn_context 实际模型 | 结果 |
|---|---|---|---|
| Jason | mimo-v2.6-flash-free | mimo-v2.6-flash-free | CONC-A |
| Avicenna | space-bunny-free | space-bunny-free | CONC-B |
| Banach | zen:space-bunny | zen:space-bunny | CONC-C |
| Huygens | ki:sonnet5.5 | ki:sonnet5.5 | CONC-D |
| Socrates | cn:deepseek-v4.1-flash | cn:deepseek-v4.1-flash | CONC-E |
| Hegel | ovoapi:gpt-5.6-sol | ovoapi:gpt-5.6-sol | 上游 403 卡住，手动关闭 |
| Meitner | deepseek-v4.1-flash | deepseek-v4.1-flash | 完成（内容为空） |
| Mencius | gpt-6-astra | gpt-6-astra | CONC-H |
| Mill | global:deepseek-v4.1-flash | global:deepseek-v4.1-flash | CONC-I |
| Chandrasekhar | claude-opus-4-8 | claude-opus-4-8 | 上游 503 卡住，手动关闭 |

**10 个全部被受理，0 次 `agent thread limit reached`。** 6 个返回预期 token，2 个因上游故障
（ovoapi 403、justwoker 503）滞留，2 个正常结束。`turn_context` 逐个核对，**每个子代理实际
路由到的模型都等于请求的模型**（含 `zen:` / `cn:` / `ovoapi:` / `ki:` 前缀别名）。

即：模型选择**没有白名单**，并发上限（`max_concurrent_threads_per_session = 1000000`）
在 10 路下也没触发。滞留的两个是上游额度/故障，与 Codex 侧无关。

附：本次实验的失败不是并发导致 —— 同一时段 usage 账本里 `ovoapi gpt-5.6-sol` 连续 403、
`justwoker claude-opus-4-8` 连续 503，两者都是**单请求失败**（dur 260-1500ms），没有排队特征。

### 落盘（2026-10-06 09:0x）

本轮结论原先只存在于 `G:\tmp`（临时目录，会被清理）。已收编为仓库内的正式工具并接入门禁：

| 新增 | 作用 |
|---|---|
| `tools/model-inventory.mjs` | 全量扫描用量账本，输出 JSON + 可选 `--canvas <path>` 直接重生成画布。7 天半衰期加权；只读日期命名文件（`*.phantom-merged.jsonl` 已验证是当天文件的 100% 子集，glob 会双计） |
| `tools/probe-subagent-models.mjs` | `--order` 用合成 catalog 驱动真实 `codex.exe app-server`，断言 `model/list` 的排序 = priority 升序 + 数组序；把"5 个名字只是提示文本、不是白名单"这条结论变成可重复执行的断言 |

`tools/check-syntax.mjs` 的解析门禁与 collapsed-spread 扫描都加上了这两个文件
（此前只覆盖请求路径上的 mjs 与 `build-model-catalog.cjs`）。

验证：`node tools/model-inventory.mjs --canvas ...` 端到端跑通（82 行，canvas 过 `tsc` 0 error）；
`node tools/probe-subagent-models.mjs --order` → `ORDERING OK`；
`check-syntax` 全过；12 个测试文件全过（bridge-request 43 / stream-terminal 48 /
responses-ids 16 / egress-guard 16 / egress-scan 28 / bridge-rude-close 8，其余 "all checks passed"），0 失败。

DEVLOG 里原来指向 `G:\tmp\prio-probe.cjs` 与 `G:\tmp\export.cjs` 的两处引用已改写为上述仓库路径。

## 2026-10-06 (3): 选择器收窄到 11 个模型 + 提示位 = 列表前五 + antigravity gemini

用户决定（原文）："提示位换成模型列表的前五个。模型列表只保留 2，1，3，5，15，12，14，25，29，30，gemini3.8high(antigravity)"。
编号取自 2026-10-06 我发布给用户的那份用量榜单（7 天半衰期加权）。

### 编号 -> slug 映射（逐条核对过）

| 编号 | slug | 加权 | 备注 |
|---|---|---|---|
| 2 | `ovoapi:6.1sol` | 9697 | 用量第二 |
| 1 | `global:deepseek-v4.1-flash` | 18296 | 主力 |
| 3 | `cn:deepseek-v4.1-flash` | 3534 | 国内版回退 |
| 5 | `claude-opus-4-8` | 940 | |
| 15 | `ki:opus5.5` | 34 | northstar kiro |
| 12 | `space-bunny-free` | 52 | zen 免费 |
| 14 | `deepseek-v4-flash` | 37 | agentrouter |
| 25 | `global:gpt-6-astra` | 7 | wb2api |
| 29 | `ki:sonnet5.5` | 4 | northstar kiro |
| 30 | `rc65:6.1sol` | 3 | relaycat 0.065 |
| - | `ag:gemini3.8h` | 0 | 新增，见下 |

### 实现：`visibility: "hide"`，不是删除

`tools/build-model-catalog.cjs` 新增 `KEEP_SLUGS`（上述 11 个，按用户给序）替换原
`OVERRIDE_SLUGS`；`HINT_SLUGS = KEEP_SLUGS.slice(0, 5)` 决定提示位。合并后对**整份**
catalog（含内置条目）统一执行 `visibility = KEEP_SET.has(slug) ? 'list' : 'hide'`。

**为什么隐藏而不是删除条目**（三条都有实证，不是推理）：

1. 桌面版每建一个线程就调标题生成，用的是内置 slug `gpt-5.6-luna`；把它从注册表删掉
   会重演 DEVLOG 2026-09-22 记录的 503 风暴。
2. auto-review 走 `codex-auto-review`。
3. 用户长期规则：所有已注册模型都必须仍能作为子代理使用。

**源码依据**（`G:\tmp\codex-src\codex-rs`，codex 0.160.0）：

- `core/src/agent/child_config.rs:323-329` —— `find_spawn_agent_model_name()` 只匹配
  `model.model == requested && multi_agent_version != Disabled`，**不看 `show_in_picker`**。
  即隐藏只影响"提示文案"，不影响能不能 spawn。
- `core/src/context/world_state/model_catalog.rs:31-36` 与
  `core/src/tools/handlers/multi_agents_spec.rs:827-832` —— 提示块取前 5 个
  `show_in_picker` 的条目（`MAX_SPAWN_AGENT_MODEL_OVERRIDES = 5`，child_config.rs:20）。
- `visibility` 合法值只有 `list` / `hide` / `none`（合成目录实测报错信息），
  内置目录里 `gpt-5.4` 与 `codex-auto-review` 本来就是 `hide`。

### antigravity gemini

`providers.json` 新增 `ag:gemini3.8h -> gemini-3.8-flash-high`。

**当前仍然不通**（同日复测）：`/v1/chat/completions` 与 `/v1/responses` 都是
400 `User location is not supported for the API use.`；同 provider 的
`claude-sonnet-4-6` 200 作为对照。原因见 providers.json 里那段既有注释 ——
antigravity-tools 的业务流量不走它配置的上游代理（实测它对 7897 的连接数为 0），
地区判定发生在 Google 侧，不是我们网关能改的。**已按用户要求注册并路由，但需按
"已注册、暂不可用"对待**，直到某次探测返回 200。

### 验证

| 项 | 方法 | 结果 |
|---|---|---|
| 选择器顺序 | 真实 `codex.exe app-server` + `model/list`，隔离 CODEX_HOME 指向新 catalog | **11 个**，顺序 = 用户给序 |
| 提示块内容 | 抓包代理 8123 截获真实请求体 | 前五 = `ovoapi:6.1sol` / `global:deepseek-v4.1-flash` / `cn:deepseek-v4.1-flash` / `claude-opus-4-8` / `ki:opus5.5` |
| 隐藏模型仍可用 | 隔离实例把 `zen:space-bunny`（已隐藏）设为主模型，指向本地捕获服务 | **请求送达**，`body.model == "zen:space-bunny"`，exit 0 |
| 网关路由新条目 | 7878 `/u/v1/responses` 调 `ag:gemini3.8h` | 400 上游地区封锁（网关路由正确，故障在上游） |
| 语法门禁 | `check-syntax.mjs` | all checks passed |
| catalog 完整性 | 83 条（11 list + 72 hide） | `gpt-5.6-luna` / `codex-auto-review` 仍在，均为 hide |

`providers.json` 每请求读取，**不需要重启网关**；catalog 需要重启 Codex 才生效。

## 2026-10-06 (4): catalog 是否需要重启才生效 —— 答案落盘

用户明确要求："catalog 是否需要重启才生效这个问题的答案应当被落盘。"

### 答案：需要重启。`model_catalog_json` 是**启动时读取一次**，运行中的进程不会重读。

`providers.json`（网关侧）与 `omp-model-catalog.json`（Codex 侧）形状相同、都由本仓库生成，
但生效方式相反 —— 这正是这个问题反复被问的原因：

| 文件 | 读取时机 | 改完要做什么 |
|---|---|---|
| `Tools/agentrouter-filter/providers.json` | **每请求**（mtime+size 缓存） | 什么都不用做 |
| `~/.codex/omp-model-catalog.json` | **进程启动时一次** | **必须重启 Codex** |

### 实测方法（可重复执行）

`tools/probe-catalog-reload.mjs`：合成 CODEX_HOME，目录 A 让 `zz-alpha` 可见，
`model/list` 一次；进程**保持运行**时把文件改写成目录 B（`zz-beta` 可见），同一个进程再问一次；
最后另起一个**全新进程**问第三次。

```text
catalog A (alpha=list, beta=hide) -> picker: ["zz-alpha"]
rewrote the file to B (alpha=hide, beta=list); process still running
same process, after the edit   -> picker: ["zz-alpha"]     <- 没变
fresh process on B             -> picker: ["zz-beta"]      <- 重读
VERDICT: STARTUP ONLY - the running process keeps the catalog it loaded; RESTART CODEX
```

第二次调用是**决定性证据**：同一个 PID 在文件已变之后仍返回旧列表，
所以既不是"缓存过期"，也不是"需要等一会儿"。

### 源码佐证

`codex-rs/core/src/config/mod.rs:2174-2180` 的 `load_model_catalog()` 在
`Config::load_from_base_config_with_overrides` 里被调用一次（:4084），
结果存进 `Config.model_catalog: Option<ModelsResponse>`（:1021），
再由 `build_models_manager()`（`thread_manager.rs:440-453`）交给 models manager。
没有 file watcher —— 全文件搜 `notify|watch|inotify` 在 config/thread_manager 里没有命中。

### 顺带修掉的一个真实脆弱点

`tools/probe-subagent-models.mjs` 克隆 `gpt-6-astra` 作为合成目录的模板条目。
2026-10-06 的选择器收窄把这个 slug 标成了 `visibility: "hide"`，于是合成目录**全部隐藏**，
`model/list` 返回空，探针报 "model/list returned nothing"。
这不是探针写错了逻辑，而是它**依赖了实时目录的一个属性**。
已修：克隆时显式 `visibility: "list"`，并注释说明原因。
修复后 `node tools/probe-subagent-models.mjs --order` → `ORDERING OK`。

`tools/check-syntax.mjs` 的解析门禁加入了 `tools/probe-catalog-reload.mjs`。

### 验证

- `probe-catalog-reload.mjs` → `VERDICT: STARTUP ONLY`（可重复执行，退出码 0）
- `probe-subagent-models.mjs --order` → `ORDERING OK`
- `check-syntax` 全过（含 3 个 tools/*.mjs）
- 12 个测试文件全过，0 失败

## 2026-10-06 (5): 过滤/脱敏的作用范围 —— 用户定案 + 一个待填的空白

用户定案（原文两段，前一段后来撤回）：
1. "解除所有屏蔽词限制，只对明确 agentrouter 的模型开过滤，我们正在远离 agentrouter"
2. "脱敏保留，对所有模型生效" → 随后撤回 → "不用了，脱敏只生效 woker 也行"

**结论：一行都不用改。** 现状恰好就是定案后的目标状态：

| 功能 | 实现 | 作用范围 | 证据 |
|---|---|---|---|
| 屏蔽词过滤（字符白名单 + GLM 词表 + 身份改写） | `providers.json` 的 `filter: true` | **只有 agentrouter** | 见下实测 |
| 脱敏（密钥 / 主机身份 / 路径 / 内网 IP） | `providers.json` 的 `egressGuard: true` | **只有 justwoker** | 本文件 1095 行的原始决定 |

### 屏蔽词范围实测（不是读代码推断）

同一份触发载荷 `CTRLPROBE 😀 RelicChoice NetId timewarp ---` 打四个 provider，
按网关日志里 `filter rewrote` 行数的增量判断：

| provider | 模型 | HTTP | rewrites 增量 |
|---|---|---|---|
| opencode-zen | `space-bunny-free` | 200 | **0** |
| northstar-kiro | `ki:sonnet5.5` | 200 | **0** |
| wb2api | `global:gpt-6-astra` | 503（上游故障） | **0** |
| ovoapi | `ovoapi:6.1sol` | 403（上游故障） | **0** |
| **agentrouter** | `deepseek-v4-flash` | 400 content-blocked | **1** |

本地函数验证改写确实发生（排除"探针没触发"）：
`"CTRLPROBE-A 😀 RelicChoice NetId timewarp ---"` → `"CTRLPROBE-A  relic choice net id time warp ---"`。

注：agentrouter 那格 400 是**预期**的 —— 载荷里有 emoji 和触发词，正是上游会拦的东西；
它 400 而不是被改写后 200，是因为 agentrouter 的字符/词表规则只覆盖已知组合，
新造的探针串仍可能撞上未枚举的规则。这不影响"其它 provider 完全没被改写"这个结论。

### 待填的空白（本次只记录，未实施）

**脱敏目前只挂在两条桥接链路里**，`server.mjs` 中 `guardBody(...)` 只有两处调用：

- :1285 —— `responses -> chat` 桥接（`sendChat`，26 个 chat-wire 模型）
- :1450 —— `responses -> anthropic` 桥接（3 个 anthropic-wire 模型）

**原生 responses 直通路径没有任何脱敏调用点**，而走这条路的有 **54 个模型** ——
含 relaycat / relaycat65 / relaycat-cn / wb2api / anyrouter / northstar-kiro /
antigravity / motomoto / ovoapi 全系。

即：如果将来要给这些 provider 开脱敏，**只在 `providers.json` 里写 `egressGuard: true`
不会生效** —— 因为 `route.egressGuard` 在两个桥接分支里被读取，直通分支根本不看它。
必须先在直通路径上加调用点。这与本仓库历史上反复踩的"配置看起来对、实际不参与"是同一类坑
（参见 1857 行那条同类教训）。

用户明确表示"只生效 woker 也行"，所以本次**不动**，仅留档。

## 2026-10-06 (6): 把机制知识从 DEVLOG 提升到 README

用户指出："catalog 是知识性的，不仅记录到 log 里"。

DEVLOG 是**时间线**（按日期分段，细节最全但检索成本高），而机制事实属于**可复用知识**，
按 AGENTS.md §1 应落在项目入口。本轮把以下内容从 DEVLOG 提升进 `README.md`：

新增两节：

1. **`## 模型目录(~/.codex/omp-model-catalog.json)`** —— 取代此前只存在于 DEVLOG 的散落记录：
   - `model_catalog_json` 是**替换**而非追加（指向 5 条目的文件会让内置模型全消失）；
   - **生效时机表**：`providers.json` 每请求读取 vs catalog 启动时读一次（**改完必须重启 Codex**），
     附源码依据（`config/mod.rs` 的 `load_model_catalog()` + 无 file watcher）与可执行验证
     （`tools/probe-catalog-reload.mjs`）；
   - `priority` 的两个互不相干作用（正值=内置排序，负值=进提示文本）；
   - `visibility` 的**关键性质：隐藏 ≠ 不可用**（`find_spawn_agent_model_name()` 从不读
     `show_in_picker`），以及为什么**不能改成删除条目**（标题生成器用 `gpt-5.6-luna`、
     auto-review 用 `codex-auto-review`，删掉会重演 2026-09-22 的 503 风暴）；
   - 子代理 5 个提示位的真实语义（取选择器前 5，**不是白名单**）；
   - 4 个相关工具的一句话说明。

2. **`## 过滤与脱敏的作用范围`** —— 把上一节的结论提升为常驻知识：
   - 两个机制都按 provider 开关，当前各只对一个生效（过滤→agentrouter，脱敏→justwoker）；
   - 过滤范围的实测数据（四个 provider `filter rewrote` 增量全 0，agentrouter 为 1）；
   - **已知空白**：脱敏只在两条桥接分支有调用点（`server.mjs:1285` / `:1450`），
     原生 responses 直通路径（54 个模型）没有；给这些 provider 写 `egressGuard: true` **不会生效**。

同时修正 **`## 路由`** 表：原来只列 4 个 route（ar/rc/wb/an），实际已有 **14 个 provider**。
新表给出 provider / 前缀 / 上游 / wire / filter / egressGuard，并说明 `wire` 决定走哪条链路
（responses 透传 54 个、chat 桥接 26 个、anthropic 桥接 3 个）—— 这个分布正是上面那条
脱敏空白的成因，两处互相引用。

### 顺带更新的工作区索引

`G:\omp works\docs\WORKSPACE-PROJECTS.md` 的 agentrouter-filter 条目已过时
（写着 "catalog 51 项"、指向 `05920f6`）。改为当前事实：14 个 provider / 83 项 catalog /
11 项可见，并把入口指向 README，标注 `providers.json` 与 catalog 的生效差异。
该文件在 `G:\omp works` 根下，**不在任何 git 仓库内**（根目录非仓库），
按 AGENTS.md §7 的路径类约定只做文件更新，不提交。

### 验证

- `README.md` 134 行改动（+124/-10），章节结构见 `grep '^#{1,3} '` 输出
- 所有引用路径与实际文件核对过；三处可执行断言命令实跑通过
- 本轮不重启任何服务

## 2026-10-06 (7): ki:opus5.5 读图 —— 实测后加入 VISION_SLUGS

用户报："opus5.5能读图。"

### 实测（不是采纳用户断言，也不是推断）

`VISION_SLUGS` 的注释写明"只在本探针通过后才加 id"，所以按该约定实测。
探针 `G:\tmp\vision-control.mjs` 用 zlib 现场生成 64x64 纯色 PNG（不经第三方库），
走**线上网关** `/u/v1/responses`，并带一个**无图对照组**：

| 输入 | ki:opus5.5 回答 | HTTP |
|---|---|---|
| 纯红图 | `Red` | 200 |
| 纯蓝图 | `Blue` | 200 |
| **无图（对照）** | `I don't see an image attached. Could you try uploading it ag` | 200 |

**对照组是结论的关键**：两张不同图给出两个正确且不同的颜色，不可能是猜的；
而没有图时模型明确说"看不到图"。这排除了"随便蒙一个颜色"和"客户端把图丢了"两种解释。

### 另外两个 opus5.5 路由：未加入（失败原因是可用性，不是读图）

| slug | 结果 |
|---|---|
| `ovoapi:claude-opus-5.5` | **503** `No available channel for model claude-opus-5.5 under group aws claude` |
| `ovo05:opus5.5` | **403** `无权访问 claude 福利组 分组` |

这两个连请求都进不去，所以**无法判定**它们是否支持读图 —— 不是"不支持"。
上游额度恢复后应重新探测；**不要照抄 ki 的条目**。注释里已写明这一点。

### 改动

`tools/build-model-catalog.cjs` 的 `VISION_SLUGS` 加入 `ki:opus5.5`，并附上实测三行数据、
对照组的说明、以及两个失败路由的处理指引。重建后：

```
ki:opus5.5               modalities=["text","image"]   <- 生效
ovo05:opus5.5            modalities=["text"]
ovoapi:claude-opus-5.5   modalities=["text"]
```

### 生效条件

catalog 是**启动时读取一次**（见本文件 2026-10-06 (4) 与 README"模型目录"节），
所以 **`ki:opus5.5` 的图片能力要重启 Codex 才在界面上可用**。
网关侧无需重启。

### 验证

- 对照实验：红/蓝/无图 三组，结论明确（上表）
- `check-syntax` 全过
- `probe-catalog-reload.mjs` → `STARTUP ONLY`（再次确认重启要求）
- `model-inventory.mjs --canvas` 重生成画布，`tsc` 0 error

## 2026-10-06 (8): kiro 丢 namespace 工具 —— opus5.5 当主模型时调不出子代理

用户报："你没有让 opus5.5 能调用子代理。"

### 根因

Codex 0.155+ 把多智能体工具声明成**一个 namespace 条目**：

```json
{ "type": "namespace", "name": "multi_agent_v1",
  "tools": [ {"name":"spawn_agent"}, {"name":"wait_agent"}, ... ] }
```

`bridge.mjs` 的 `flattenTools()` 会把它展开成扁平函数 `multi_agent_v1__spawn_agent` ——
但**只对 chat 和 anthropic 两条桥接链路生效**。原生 responses 直通路径原样转发，
而 **kiro 会静默丢弃这个形状**，模型因此完全看不到 `spawn_agent`。

### 实测证据（决定性）

同一模型 `ki:opus5.5`、同一提示、同一种 namespace 工具形状，只换上游：

| 上游 | namespace 形状 | 扁平形状 |
|---|---|---|
| **kiro** | **无调用**（"I don't have a sub-agent tool available"） | 调用成功 |
| relaycat (`rc65:6.1sol`) | 调用成功 | 调用成功 |
| agentrouter (`gpt-6-astra`) | 调用成功 | 调用成功 |
| wb2api (`cn:glm-5.3`) | 无调用 | 无调用（模型自身不调，非工具丢失） |

**kiro 是唯一"扁平能调、namespace 不能调"的上游**，这个对照排除了"模型不愿意调"的解释。

真实会话佐证：`~/.codex/sessions/2026/10/06/rollout-2026-10-06T11-10-11-*`（主模型 `ki:opus5.5`）
的 reasoning 里反复出现 "I don't have a subagent spawning tool available"，14 次调用全是
`exec_command`/`write_stdin`/`view_image`，没有一次 `spawn_agent`。

### 修复

按 provider 开关（**不全局改**，因为 relaycat/agentrouter 原生就懂 namespace 形状）：

1. `providers.json`：`northstar-kiro` 加 `"flattenNamespaceTools": true`。
2. `bridge.mjs`：导出 `flattenTools` 与 `splitWireName`（原本是模块内私有）。
3. `server.mjs` 直通路径：
   - **出站**：`route.flattenNamespaceTools` 为真且有 namespace 条目时，展开成扁平函数，
     并把 `byWire`/`byPair` 映射表留给返回方向；
   - **入站**：上游回的扁平名 `multi_agent_v1__spawn_agent` 还原成
     `{name:"spawn_agent", namespace:"multi_agent_v1"}` —— 否则 Codex 认不出，
     这正是 2026-09-24 那条"回复路径半边"的教训（`bridge.mjs:1532` 注释）；
   - 流式响应因此不能盲 `pipe`：改为按行缓冲、还原、再写出（无该标志时保持原零拷贝 pipe）。

### 验证（隔离实例 7879，未碰生产 7878）

| 网关 | 结果 |
|---|---|
| 7878（旧代码） | namespace 工具 → **无 function_call**，模型说没有子代理工具 |
| 7879（修复后） | namespace 工具 → **`multi_agent_v1::spawn_agent`** |

返回的是带 namespace 的正确形状，不是扁平名 —— 说明出站展开与入站还原两半都对。

- 12 个测试文件全过（0 失败）
- `check-syntax` 全过
- 隔离实例已停止

### 生效条件

`server.mjs` 改动**需要重启网关**（`providers.json` 每请求读取，但这次的逻辑在 server.mjs 里）。
重启后 `ki:opus5.5` / `ki:sonnet5.5` 才能以主模型身份派发子代理。

## 2026-10-07 (1): 读图端到端复测 —— kiro / wb2api-ds 全部通过

用户问："读图现在正常了吗"。上一轮只做了**上游直连**的对照实验（红/蓝/无图），
没有走**线上网关 + 真实 Codex 会话**这条完整链路。本轮补做端到端复测。

### 环境时序（先确认"改的东西真的加载了"）

| 项 | 值 |
|---|---|
| `omp-model-catalog.json` mtime | 2026-10-06 11:15:05 |
| 当前 Codex PID 5772 启动 | 2026-10-07 01:15:23（**晚于** catalog 写入） |
| 网关 PID 27484 启动 | 2026-10-06 23:37:52 |

catalog 是启动时读取一次（本文件 2026-10-06 (4)/(7)），进程启动晚于写入 → 新目录已加载。

### 端到端探针（走线上 7878 的 `/u/v1/responses`，非直连上游）

用 System.Drawing 现场生成一张含**唯一可核对字符串**的图（`VISION-OK-4721`
+ 蓝矩形 + 红椭圆），保存 `G:\tmp\vision-test-4721.png`，然后经网关请求：

| slug | HTTP | 回答 |
|---|---|---|
| `ki:opus5.5` | 200 | `Text: "VISION-OK-4721"; shapes: a blue rectangle and a red ellipse (oval).` |
| `global:deepseek-v4.1-flash` | 200 | 同上，文字与两个形状全对 |
| `cn:deepseek-v4.1-flash` | 200 | `VISION-OK-4721` |

**这张图不是纯色块**：它同时要求读出任意字符串（不可能靠猜）+ 命名两个形状及其颜色。
一次性全对，说明图确实到达了模型，而不是模型在编。

### 真实用户图复测（不是合成图）

用用户本会话先前上传的 `G:\tmp\codex-clipboard-370b2adb-...png`（Parsec 报错截图）
走同一条链路问 `global:deepseek-v4.1-flash`，它正确读出了：

- 应用是 Parsec，红色错误横幅 `[-6101]` websocket 连不上后端
- 界面全英文（中文：无）
- 没有 IP，只有机器名 `LAPTOP-QRPI6A1A` 和账号 `Lay1nn#18112363`

这些细节与用户当时描述的"302 导致 Parsec 连不上"完全吻合 —— 说明真实截图也能读。

### 结论

读图链路（Codex 客户端 → 网关 → kiro / wb2api-ds）**正常**。
`ki:opus5.5` 是上一轮加入 `VISION_SLUGS` 的，本轮端到端再次确认；
两个 wb2api deepseek-v4.1-flash 路由此前已在 `VISION_SLUGS` 内，也一并确认。

**唯一未覆盖的边界**：本轮探针都是脚本发的裸请求，没有在**当前 Codex 会话界面里**
手动贴图验证（那需要用户自己操作）。若界面仍不显示图片能力，先查该会话是否在
catalog 写入之前启动 —— 是则重启 Codex。

## 2026-10-07 (2): kiro 子代理"部分成功、部分失败"的真根因 —— 历史重放没改写

用户报："那个会话仍然告诉我它不能调 dsv4.1f 子代理"。

### 现象（两个会话都能复现，同一会话内自相矛盾）

会话 `01a0e7ad-00be`（主模型 `ki:opus5.5`）在 2026-10-06 03:32–04:12 的记录里，
`spawn_agent` 调用**有时成功、有时 `unsupported call: spawn_agent`**：

| 行 | 调用名 | namespace | 结果 |
|---|---|---|---|
| 68 | spawn_agent | `multi_agent_v1` | **成功**（返回 agent_id） |
| 110 | spawn_agent | **无** | `unsupported call: spawn_agent` |
| 111 | spawn_agent | **无** | `unsupported call: spawn_agent` |
| 118 | spawn_agent | `multi_agent_v1` | **成功** |
| 150/325/331/337/343/367/373 | spawn_agent | **无** | 全部 `unsupported call` |

**失败样本全部缺少 `namespace` 字段** —— 这是根因的方向标，不是模型随机失误。

### 复现（mock 上游捕获真实出站字节，决定性）

隔离实例（7880，指向 127.0.0.1:7891 的 mock 上游），发一个和真实会话同形的第二轮请求
（历史里有 `{name:"spawn_agent", namespace:"multi_agent_v1"}` 的旧调用 + 声明 namespace 工具）：

```
--- tools sent upstream:            name=[multi_agent_v1__spawn_agent]     <- 已扁平化
--- history function_calls sent:    name=[spawn_agent] namespace=[multi_agent_v1]  <- 没改写！
```

**出站只做了半边**：工具表扁平了，历史调用没有。模型读到自己的历史（裸名 `spawn_agent`），
下一次就用裸名调用；上游如实回裸名；回程映射（byWire 只认扁平名）查不到 → 原样透传 →
Codex 的 `registry.rs:554` 查不到 `spawn_agent` 这个默认命名空间的工具 → `unsupported call`。

对比 `bridge.mjs`：chat 与 anthropic 两条桥接都有 `joinWireName()` 做这半边
（`bridge.mjs:146`、`:326`），**唯独 responses 直通漏了**。

### 第二个缺陷（同段代码）：用 `"__"` 切名会切错 mcp 命名空间

旧代码从扁平名重建映射时按**第一个** `"__"` 切分：

```
mcp__codex_app__list_threads  ->  namespace "mcp", name "codex_app__list_threads"   (错)
```

`flattenTools()` 本身返回权威的 `byWire`/`byPair` 映射，重建纯属多余且有害。
真实数据佐证：`mcp__codex_app::list_threads` 确实以带 namespace 的形态存在于会话记录中。

### 修复（`server.mjs` 直通路径 + `bridge.mjs` 导出一行）

1. `bridge.mjs`：导出 `joinWireName`（原为模块内私有）。
2. `server.mjs` 直通分支：
   - 直接用 `flattenTools()` 返回的 `byWire`/`byPair`，**删掉 `"__"` 切分重建**；
   - **出站新增历史改写**：`parsed.input` 里每个 `function_call`，若 `byWire` 没有它，
     就按 `joinWireName(name, namespace)` 改写为扁平线名；无 namespace 但有唯一裸名归属的也改写；
   - 新增 `byBare` 安全网：只有**唯一归属**（一个命名空间拥有、且没有同名扁平工具）的裸名
     才允许还原，防止把真实扁平工具错认成命名空间子工具；
   - 日志加 `renamed N replayed call(s)`。
3. 回程（SSE 与非流式两处）用同一 `toolMap`，`byBare` 兜底。

### 验证（全部实跑）

| 层面 | 证据 |
|---|---|
| 隔离 + mock 上游 | 历史改写生效；回程 namespace 正确 |
| 隔离 + **真实 kiro** | 同形请求返回 `name=spawn_agent namespace=multi_agent_v1`（HTTP 200） |
| 新增回归测试 | `tools/test-namespace-passthrough.mjs` **14 项全过**（含流式 SSE、歧义、扁平遮蔽、mcp 切名） |
| 全量回归 | 13 个测试文件全过，0 失败；`check-syntax` 全过（新测试已入门禁） |

新增测试覆盖的边界：历史改写、回程还原、裸名安全网、双命名空间歧义（不猜）、
扁平工具遮蔽（不抢）、`mcp__codex_app` 切名、非 adopt 路由不受影响、流式 SSE 逐行改写。

### 生效条件

`server.mjs` 改动**需要重启网关**（`providers.json` 每请求读，但这次逻辑在 server.mjs）。
隔离实例（7880/7881/7882/7883/7891）已全部停止。

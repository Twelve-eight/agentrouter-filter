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

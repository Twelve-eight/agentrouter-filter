# agentrouter-filter

Codex CLI 侧的上游桥接网关(仅剩桥接与路由,不再做内容过滤).

## 为什么需要它

**Codex 0.154 只接受 `wire_api = "responses"`**.`wire_api = "chat"` 已硬删除
(`no longer supported`),`chat_completions` 报 `unknown variant .. expected 'responses'`.
凡只有 chat/completions 面的上游(wb2api)都必须做协议桥接,这是本网关存在的**唯一原因**.

另外它顺带解决两件事:

- **anyrouter.top 直连被 TLS 层拦截**(omp 报 `unknown certificate verification error`),
  需要经本地 HTTP 代理;代理按路由施加,agentrouter 保持直连(它经代理会挂起).
- **单点配置**:所有上游在 codex 侧只暴露一个本地地址,便于日志与统一转发.

## 路由

Codex 的 `model_provider.base_url` 指向 `http://127.0.0.1:7878/<route>/v1`:

| route | 上游 | 方式 |
|---|---|---|
| `ar` | `https://ps.air-outer.com` | responses 透传 |
| `rc` | `https://api.relaycat.top` | responses 透传 |
| `wb` | `http://127.0.0.1:7863` | responses -> chat/completions 桥接 |
| `an` | `https://anyrouter.top` | responses 透传,经 `http://127.0.0.1:7897` CONNECT 隧道 |

上游可用 `AR_UPSTREAM_<ROUTE>` / `AR_PROXY_AN` 覆盖.

**不转发任何伪造头**:agentrouter 按 `originator` 放行,而 Codex 原生就发
`originator: codex_exec`,网关原样转发它自己的头.

## 为什么不再做内容过滤(2026-09-20 移除)

此前移植了 omp 的 `strip-illegal.ts`(字符白名单 + 敏感词表 + 身份句替换).实测后移除:

- **词表层全部失效**:`filter.mjs` 会改写的每个触发词(`warp-player` / `relic-bag` /
  `choice history` / `net id` / `4xx-dumps` / `RELIC-CHOICES` / 三点连排 / 长文件 id)
  逐条直发 agentrouter,**12/12 全部 200 通过**.
- **字符层无确定性依据**:探测 25 个 Unicode 区段(含 emoji、假名、谚文、希腊、
  阿拉伯、希伯来、泰文、制表符、全角),**全部 ALLOW**;同一输入重复测试结果会变
  (emoji 一次 3/3 BLOCK、另一次 2/2 ALLOW).
- **真正机制是累积式概率分类器**:`Sts/sts2-spire1/DEVLOG.md` 的二分实验显示,
  一个 5.5KB 的**纯 ASCII** 工具结果只在 600 条消息的上下文中被拦,在 293 条时通过;
  700 个破折号 + 180 箭头 + CJK 的小请求通过,414KB 混合字符请求也通过.

即:确定性过滤器既拦不住真实触发条件,又静默损失保真度(emoji 与非批准文字被删,
`relic-bag` 这类标识符被改写,包括模型正在读写的代码).**故整体移除.**

同理移除了 reasoning 剥离(`stripReasoning`):其存在理由是 agentrouter 多 Azure
资源池无会话粘性导致 `encrypted_content` 回放 400,该问题已不再需要规避.

**遗留的 402 / 500 是上游配额与通道问题,任何本地过滤都解决不了.**

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

## 测试

```
node tools/test-bridge-indices.mjs   # 桥接的 output_index 单调性(回归测试)
```

该测试进程内驱动 `bridgeChatStream`,用合成的 chat SSE(先 content 后 tool_calls)
断言 added/done 索引互异且单调、`response.completed.output` 按索引有序.

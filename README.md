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

| route | 上游 | 方式 |
|---|---|---|
| `ar` | `https://ps.air-outer.com` | responses 透传 |
| `rc` | `https://api.relaycat.top` | responses 透传 |
| `wb` | `http://127.0.0.1:7863` | responses -> chat/completions 桥接 |
| `an` | `https://anyrouter.top` | responses 透传,经 `http://127.0.0.1:7897` CONNECT 隧道 |

`an` 单独走代理是因为 anyrouter.top 直连被 TLS 层拦截;其余路由保持直连
(agentrouter 经该代理会挂起)。上游可用 `AR_UPSTREAM_<ROUTE>` / `AR_PROXY_AN` 覆盖。

## 过滤内容(`filter.mjs`)

从 omp 钩子逐条移植,全部经 ps.air-outer.com 实测:

- **字符层**:非批准字符替换为网关接受的 ASCII 等价物。批准集 = CJK 汉字 +
  带音标拉丁(法/德)+ 西里尔(俄)+ 书名号/ß。这也正是工作区"仅限中英法德俄字符"
  规则(AGENTS.md Sec 5)的执行点:假名、谚文、阿拉伯、希腊、emoji、制表符
  一律删除。
- **词组层**:网关不透明敏感词表的替换(`arp-player` 系,`relic choice` 系,
  `choice history`,`net id`,`4xx-dumps`,三点连排压缩等),以及
  `You are Claude Code, Anthropic's official CLI tool for Claude.` ->
  `You are Codex, an official CLI coding agent.`(用户指定的新增屏蔽词).
- **额外要求注入**:工作区 AGENTS.md Sec 5 的语言卫生规则与身份规则会以
  `Additional requirements for this provider. ...` 追加到请求体 `instructions`
  末尾(幂等).Codex 没有 provider 级 `instructions` 字段
  (`--strict-config` 直接报 `unknown configuration field`),网关是唯一可承载处.
- 失败时**放行不阻断**,与 omp 钩子一致.

## 运行

```
node server.mjs          # 监听 127.0.0.1:7878
```

开机自启已注册到 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
(`agentrouter-gateway` -> `autostart.cmd`)。移除:

```
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v agentrouter-gateway /f
```

**网关不在时,config.toml 里指向它的 provider 全部失败**,这是预期行为(不静默降级)。

## 验证

```
# 过滤生效(应打印改写日志,且上游收到的 instructions 已是 Codex 身份)
AR_UPSTREAM_AR=http://127.0.0.1:7897 node server.mjs

# 各路由
curl -s -N -X POST http://127.0.0.1:7878/ar/v1/responses \
  -H "Authorization: Bearer $AGENTROUTER_API_KEY" -H "Content-Type: application/json" \
  -H "originator: codex_exec" -d @body.json
```

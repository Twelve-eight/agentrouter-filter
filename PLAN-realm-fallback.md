# 方案: 国际版优先 + 跨域降级 (wb2api cn/global dsv4.1 合并)

状态: **待用户决策** (D1-D4 未定, 尚未写任何产品代码)
日期: 2026-09-22
证据来源: 三份 scout 报告 (本目录 `G:\omp works\.tmp\realm-scout-{a,b,c}-*.md`), 均为只读取证.

---

## 1. 目标 (用户原话拆解)

| 编号 | 要求 | 落点 |
|---|---|---|
| R1 | 只要有任何国际版账号可用, 优先国际版 | 每个请求先打 global; 不预判 |
| R2 | 国际版完全耗尽/限流时, 交由国内版消耗积分调用 | 收到 429/503 后同请求内切 cn |
| R3 | 明确"最近恢复时间" | 响应头 + 日志 |
| R4 | 恢复后立刻回到国际版 (不粘在国内版) | 有界窗口 + 恢复探针 |

---

## 2. 硬约束 (三份报告实证, 不是推测)

### 2.1 wb2api 没有跨域降级, 且严格域隔离
- `internal/pool/pick.go:48-51` realm 谓词; `:238-240` **全冷却兜底也过滤跨域账号**.
- `internal/server/handler.go:649-652` 选号同样按 realm 过滤.
- `origin/master` 亦无此实现 (回归测试 `handler_global_test.go:153-155` 明确断言"不跨 realm 用 CN 号顶上").
- **结论: 只能在网关侧做.**

### 2.2 wb2api 不向客户端暴露恢复时间
- 全仓 `Retry-After|retry_after|X-RateLimit` **0 命中** (本地与 origin/master 皆然).
- 客户端可见响应头仅两处: `handler.go:186` (`X-Service`, /healthz) 与 `:903` (`Content-Type`).
- 实测 429 响应头只有 `Content-Type` / `Date` / `Content-Length`.
- **结论: 恢复时间必须由网关自己从 `GET /status` 取.**

### 2.3 `/status` 的 `until` 目前**不可信** (会早于真实恢复 十几小时)
- 上游原文: `your usage will reset at 2026-09-23 07:37:58 UTC+8`.
- wb2api `/status` 记的: `until=2026-09-22 16:41:47` (= 撞 429 时刻 + `soft_rate_max` 默认 2h 封顶).
- 原因: 英文 reset 文案解析修复 (`4da4780`) **未部署** —— 运行进程 PID 20180 启动于 15:32:50,
  而二进制重建于 15:57:23, 提交时间 15:58:11. 进程早于三者.
- **结论: 可靠恢复时间依赖"重启 wb2api 部署 4da4780"这个前置条件 (P0).**

### 2.4 `/status` 的 `healthy=0` **不等于**该域不可用
- `internal/pool/pick.go:63-67` 存在全冷却兜底 `pickEarliestExpiryLocked` (`:190-214`):
  软冷却号仍会被重新选中并**真实出站重试**.
- 纯 503 只在兜底也返回 nil 时 (该域只剩 disabled, 或只剩有效 `hard_credit`) 出现 (`:203-208`).
- **结论: 不能用 `/status` 或 `/healthz` 的布尔值作为"进入降级"的判据 —— 那是假阴性, 会过早放弃国际版,
  违反 R1. 只能用"实际请求失败"作为判据 (反应式).**

### 2.5 国内版只有 **1 个号**, 并发上限 3
- `realm_totals.cn = {total:1, healthy:1}`; `max_in_flight` 默认 3 (`cmd/server/config.go:171`).
- 实机已观察到: 16:19:27-16:19:30 网关侧连续 `cn:deepseek` 503, `uid=-` (该号在途占满).
- **结论: 无预算的降级会把"429 中断"换成"503 中断", 只是换形状.**

### 2.6 网关具备落地条件
- `WORKBUDDY_API_KEY` 是用户级环境变量, 网关进程已继承 (日志中"缺 key"告警 0 次, 且有成功 429 记录).
- 该值与 wb2api `config.json` 的 `api_key` **逐字符相等** → 网关手上的 `route.key` 可直接调 `/status`.
- `/healthz` **无需鉴权**, 返回 `realm_servable.{cn,global}` 布尔.

### 2.7 域 = model id 前缀, 降级就是一次字符串替换
- `internal/server/resolve_model.go:13-23` 剥 `cn:`/`global:`; `handler.go:594-598` 出站前剥离.
- `global:deepseek-v4.1-flash` 与 `cn:deepseek-v4.1-flash` **同 provider (wb2api), 同 base, 同 key**:
  `providers.json` 两条都是 `{"p":"wb2api"}`.
- **结论: 降级不需要重新解析 provider, 只改 `parsed.model` 即可.**

---

## 3. 设计

### 3.1 分层

```
请求 (model = global:deepseek-v4.1-flash)
  |
  +-- [路由层] 该 model 是否配了 fallback 且当前处于降级窗口?
  |     否 -> 直接打 global
  |     是 -> 探针: GET /healthz (缓存 30s)
  |              realm_servable.global=true  -> 清除窗口, 打 global   (可靠正向)
  |              false                      -> 打 cn (本请求不消耗 global 重试)
  |
  +-- [执行层] 打 global
  |     429/503 -> 记录窗口 + 取恢复时间 -> 同请求内改 model 为 cn:... 重发一次 -> 返回
  |     2xx     -> 正常返回 (并清除该 model 的降级窗口)
  |
  +-- [暴露层] res.setHeader('X-Gateway-Realm', ...) + ('X-Gateway-Retry-At', ...)
```

要点: **进入降级只认实际失败; 退出降级认 /healthz 的布尔正向.**
这样既不会过早放弃国际版 (假阴性), 也不会粘在国内版 (R4).

### 3.2 恢复时间的三级来源 (诚实标注置信度)

| 级 | 来源 | 性质 | 置信度 |
|---|---|---|---|
| 1 | `/status` → 账号 `rate_limited_models[].reset_at` | 上游权威, **模型级** | 高 (需 P0 部署后才有值) |
| 2 | `/status` → 账号 `until` / `cool_remaining_sec` | 本地推算, **账号级**, 可能被 2h 封顶截断 | 低 (早于真实值) |
| 3 | 固定窗口 (默认 15 分钟) | 兜底 | 仅用于限流重探 |

`X-Gateway-Retry-At` 取**最早**时刻 (`min`) —— 对应需求原文"最近恢复时间".
并附 `X-Gateway-Realm-Source` 标注用的是哪一级, 避免把低置信度数字当权威.

### 3.3 为什么不用 `/status` 预判路由
见 2.4: `healthy=0` 时 global 仍可能被兜底选中并成功. 预判会误伤 R1.
`/status` 只在一个请求**已经失败**之后被调用一次 (每次降级事件一次, 不是每请求).

---

## 4. 改动清单

### 4.1 `providers.json` (新增 fallback 字段)
在 **model entry 内部**增字段 (不能新增顶层键 —— 见 4.4 硬约束):

```json
"global:deepseek-v4.1-flash": { "p": "wb2api", "fallback": "cn:deepseek-v4.1-flash" }
```

- 仅登记**已确认存在 cn 同族 id** 的模型. 目前只有 `global:deepseek-v4.1-flash`.
- `global:deepseek-v4.1-flash-sg` **暂不登记** (无 cn 同族 id; 见 D3).

### 4.2 `server.mjs` (核心改动, 约 60-90 行)

| 位置 | 改动 |
|---|---|
| 模块级 (约 330 行附近) | 新增 `const realmFallback = new Map()` (bare base -> until ms); `const globalProbe = { at: 0, value: null }` |
| 新增函数 | `async function globalServable()` = GET `/healthz`, 缓存 30s; `async function globalRecoveryAt(base)` = GET `/status` 取三级来源; `function fallbackRoute(model)` = 读 `spec.fallback` |
| 486-560 区间 (共同可控点) | 插入降级窗口判定 + 探针; 命中则把 `parsed.model` 改为 cn id 并 `body = JSON.stringify(parsed)` |
| 561-611 (线 A: chat 桥) | `requestWithRetry` 后判 `statusCode === 429 \|\| 503`: 若当前是 global 且有 fallback → 排空上游响应 → 记录窗口/恢复时间 → **用全新 toolMap 重建 chat body** → 重发一次 cn → 继续原有流程 |
| 596 之前 | `res.setHeader('X-Gateway-Realm', ...)` / `('X-Gateway-Retry-At', ...)` (setHeader 会被 bridge.mjs 的 writeHead 合并, **无需改 bridge.mjs**) |
| 596 / 648 / 680 | 三条线各自的"最晚设头点" (线 A/B 在 `bridge*Stream` 之前; 线 C 在 `res.writeHead` 之前) |

**为什么只做线 A (chat 桥)**: 降级目标全部是 wb2api 的 ds 模型, 走的就是 chat 桥.
线 B (anthropic) / 线 C (responses 直通) 当前**没有任何 wb2api 模型注册**, 无功能缺口.
以启动期断言固化这条前提 (若将来有 fallback 目标落在 B/C, 直接报错而不是静默失效).

### 4.3 `tools/test-realm-fallback.mjs` (新增, 零依赖)
照抄 `tools/test-filter-failopen.mjs:30-103` 骨架 (桩 `http.createServer` / `http.request`; `import("../server.mjs")` 不绑端口).
断言: (a) 第 1 次 forward 的 model 是 global, 第 2 次是 cn; (b) 客户端收到两个自定义头;
(c) 窗口内下一次请求**只有一次** forward 且直接命中 cn; (d) `/healthz` 报 true 后恢复打 global.
附带 `node tools/check-syntax.mjs` 作门禁.

### 4.4 新增字段的兼容性硬约束 (scout B 实测)
两个解析方都是"点读白名单", 新字段不破坏它们. 但**必须嵌在 model entry 内**:
- `server.mjs:230-232` `modelList()` 遍历 `models` 全部键, 顶层对象键会变成一个假模型 id;
- `build-model-catalog.cjs:200-201` 同理 (`typeof === "object"` 过滤).
- 实测: `models` 36 键中 35 个对象 → catalog slug 恰好 35 条, `_builtin_comment` 字符串被跳过.

---

## 5. 前置条件 P0: 重启 wb2api 部署 `4da4780`

**没有这一步, R3 交付不了可信数字.**
部署后 `rate_limited_models[].reset_at` 才会有上游权威值 (模型级), 否则网关只能拿到被 2h 封顶的 `until`.

部署后验证 (只读):
```powershell
# 1. 确认进程晚于二进制
Get-Process wb2api | Select-Object Id, StartTime
Get-Item 'G:\workbuddy2api\out\wb2api.exe' | Select-Object LastWriteTime

# 2. 触发一次 6004 后, 检查模型级冷却是否带 reset_at
Invoke-RestMethod 'http://127.0.0.1:7863/status' -Headers @{Authorization='Bearer sk-workbuddy'} |
  Select-Object -ExpandProperty accounts |
  Where-Object { $_.realm -eq 'global' } |
  Select-Object uid, cool_kind, until, rate_limited_models
```
判据: 出现非空 `rate_limited_models`, 且 `reset_at` ≈ 上游文案里的时刻 (而非 429 时刻+2h).

**重启由用户执行** (会掐断运行中的会话).

---

## 6. 待决策项 (需用户拍板)

**D1 — 国内版并发预算.** cn 只有 1 个号 / 上限 3 并发. 降级洪峰会把它打爆成 503.
- (a) 先不做, 观察实际表现;
- (b) 网关侧对"降级到 cn"的请求设信号量 (建议上限 1-2, 超出快速失败而非排队);
- (c) 先加 cn 账号 (最治本, 但要账号).

**D2 — 降级窗口上限.** `until` 说"明天早上", 但它是低置信度值.
- (a) 照用 (靠 `/healthz` 探针提前发现恢复);
- (b) 封顶 30-60 分钟, 到期无条件试一次 global.
建议 (a) + 探针, 因为探针免费且能提前恢复.

**D3 — `global:deepseek-v4.1-flash-sg` 是否也降级.** 它没有 cn 同族 id.
- (a) 不降级 (建议; 降级会改变模型语义);
- (b) 降级到 `cn:deepseek-v4.1-flash` (需你确认两者可互相替代).

**D4 — `stream:false` 路径是否也设头.** 建议是 (同一套逻辑, 成本为零).

---

## 7. 明确不做 (范围边界)

- **不改 wb2api 的选号核心** (realm 隔离是全仓库一致的设计 + 有回归测试锁定; 网关侧做风险低得多).
- **不动 `origin/master` 的 163 个提交** (本地分叉已存在; 合流是独立议题).
- **不给 wb2api 加 `Retry-After` 头** (那是上游 API 语义变更, 应单独提 issue; 网关侧已能取到同样信息).
- **不碰 wbgui** (`G:\workbuddy2api-gui`): 它的 `AccountStatus` 结构体缺 `realm` 与 `rate_limited_models`,
  拿不到域级视图; 且它只是 wb2api `/status` 的转发方, 不是独立探测源. 修它是可选顺手活, 非本方案依赖.

---

## 8. 验收标准

1. `node tools/test-realm-fallback.mjs` 全 PASS, `node tools/check-syntax.mjs` 干净.
2. 实机: global 全冷却时, 打 `global:deepseek-v4.1-flash` 返回 200, 响应头带
   `X-Gateway-Realm: cn` 与 `X-Gateway-Retry-At: <ISO>`.
3. 实机: global 恢复后 (`/healthz` `realm_servable.global=true`), 下一次请求回到 global
   (响应头 `X-Gateway-Realm: global`).
4. 网关日志出现一行降级记录, 含 base model / 恢复时间 / 来源级别.

# 网关修复契约, 2026-09-23

本次依据原生 Astra 审查与主会话隔离实验, 修复三类错误. 不修改 providers.json 或凭证/模型/收费路由, 不实现尚待用户选择的 D1 国内并发预算, 不重启在线实例.

## 已复现的缺陷

证据 G:\omp works\.tmp\workspace-audit-20260923-01a0cbfd\evidence\repro-gateway.mjs 直接导入真实 bridge/server, http/https 全部替换为隔离桩. 运行 stream/unknown/hang 三个模式, 修复前均退出 1.

- SSE 显式 error, 无终止标记 EOF, error 后 end 可产生 response.completed 和成功用量记录; error 后 end 还结束两次.
- /status 与 /healthz 均不可用后, unknown 被当作恢复证据, 下个请求重新打 global, 来源误标 transient.
- 状态响应头及时到达但响应体不结束时, 探针超时无效, 同请求无法转 cn.

## 不变量

- 降级窗口内未知不是正向恢复证据. 保留 unknown 标签与既有有界窗口, 只有真实可用证据或原有窗口到期规则允许返回 global.
- 本地 JSON 探针截止时间覆盖请求建立, 响应头, 全部响应体和解析. 超时主动取消请求/响应, 不留下挂起 I/O. 不改变其它正常上游重试语义, 不引入未证明合适的体积阈值.
- Chat SSE 必须识别显式错误及合法结束信号. 无完成证据的 EOF/aborted/提前 close 不能伪装成功. 保留正常文本, 推理, 命名空间工具, usage, streaming/nonstreaming 合同.
- 终态只能一次; error 后 end 不得再次成功或再次结束. 失败不调用成功用量回调. 输出开始后不自动重放其它 provider/realm.
- 合法完成由协议终止帧或明确 finish_reason 判定. 长度/过滤等非正常终态不可无条件标为 completed. 如实现 incomplete, 其形状必须来自项目/官方合同, 不编造字段.
- 共享 emitter 的幂等性同时保护 Anthropic 调用方, 但不顺带改变未覆盖的正常协议. 若扩展修复 Anthropic 错误终态, 必须补独立桩覆盖并明确记录.
- 旧正常测试夹具若只靠 EOF, 应补真实协议完成帧, 不能删除旧断言或仅改预期为成功来让测试变绿.

## 验收与边界

主会话集中运行新增复现, 现有六项测试, 本地 HTTP 假上游端到端程序烟测. 不调用真实收费上游或重启生产网关. 工作目录保持 G:, 仅定向提交本轮文件. 源码修复已提交不等于当前在线进程已加载新代码.

## 测试账本隔离补充

AR_USAGE_DIR 可显式覆写 usage 目录, 未设置时默认目录不变. 导入真实 server 的测试必须先设置独占项目 .tmp 目录, 不使用生产账本作为测试输出. 仅确认写入风险, 尚未证明历史账本污染, 不清洗或截断已有账本.

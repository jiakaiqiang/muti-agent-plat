# 原消息显式重新识别实施报告

日期：2026-10-20（Asia/Shanghai）。Run ID：`SDD-2026-10-20-recognition-retry`。依据四件套的失败分流、持久化预算、恢复、幂等和版本守卫要求，继续完成 IR03/IR09/IR10/IR12 的局部切片。整个专项仍处于实施中。

## 本轮行为

- 新增 `POST /sessions/:sessionId/message-routings/:routingId/retry-recognition`。仅接收合同版本、epoch、期望 revision、幂等键；202 只表示受理，不表示分类或执行成功。
- auth/config/transient/schema/budget 阻塞且没有有效语义/计划时，用户可以对原消息显式重新识别。保留唯一原 user_message、sourceEventId；归档旧失败原因、attemptLog、分类次数、deadline、快照和提案，创建新 recognitionOperationId。旧 LogicalOperation 及预算不改写。
- 同键同请求返回原回执；并发只创建一个操作。不同请求复用键、过期版本、epoch/generation 失配、删除/归档、未知停止、活跃旧调用和纠错屏障均拒绝。受理和回执/事件/Outbox 同事务保存，持久化失败完整回滚。
- Pipeline timer/in-flight、分类租约和最终回写绑定当前识别操作；旧 LogicalOperation 在 begin/reserve 和 Runtime 启动前不能再次进入模型，旧 worker 不能将新请求标记失败。
- 每次显式操作仍最多两次分类、一次结构修复，快照重建和重载恢复共享剩余预算；不会自动无限重试，也不绕过模型 provider circuit。认证故障触发的等待期返回 `INTENT_PROVIDER_CIRCUIT_OPEN`，有明确客户端提示。
- Web/Desktop 共用面板和 Store。未知响应以 sessionStorage 固定原请求，刷新只查询；匹配原回执才清除 pending，409 刷新但不自动提交，断连和只读视图限制写入口。暂停会话不隐式恢复。

已保存合法语义但缺权限的请求仍走 retry-authorization；语义歧义走澄清；已生效意图走 corrections。本入口不增加执行权限。

## 实际验证

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| 工作区全量 | 3097 通过，0 失败，37 条件跳过 | recognition-retry-workspace-tests.log |
| 分项 | CLI 102、Shared 282、Server 2143、Server 开发脚本 7、Web 512、开发监督脚本 37、Desktop 14 | 同上 |
| 真实 PostgreSQL | 32/32，0 跳过；新增跨连接重试/恢复和 SQL 回滚 | recognition-retry-postgres.log/json |
| 实际 HTTP | RR01–RR07，7/7；真实 Nest、Generic LLM adapter、File 状态、进程重启 | recognition-retry-http.log/results.json |
| 类型与构建 | 工作区 typecheck/build exit 0 | recognition-retry-typecheck-final.log、recognition-retry-build.log |
| 工程约束 | Harness、diff 检查 exit 0 | recognition-retry-harness.log、recognition-retry-diff-check.log |
| 最终后端增量 | 66/66；旧操作不能预约新操作的快照重建额度；后端 typecheck/build 通过 | recognition-retry-rebuild-final.log、recognition-retry-server-typecheck-final.log、recognition-retry-server-build-final.log |

全量跳过项为 32 项 PostgreSQL 和 5 项可选 Docker；数据库条件项由独立实际运行覆盖，Docker 条件项未在本轮声明通过。当前端证据为组件/Store 和双端时间线挂载，不是完整 Web/Electron/SSE 端到端验收。各验证范围重叠，不累计为独立题目数。

## HTTP 评测题目

固定原文：**“为天气查询建立任务”**。本地确定性 provider 先返回 HTTP 401，恢复后返回严格语义合同；不是准确率评测。

| 编号 | 场景 | 实测通过条件 |
| --- | --- | --- |
| RR01 | 首轮连接认证失败 | 仅一次网络调用，无自动 auth 重试，无任务 |
| RR02 | 注入 attempts、错误 epoch、旧 revision | 400/409 拒绝，无新操作 |
| RR03 | 等待期内再次显式请求 | 新有限预算操作被受理，circuit 阻止网络调用；旧预算保留 |
| RR04 | 修复连接并等待真实 circuit TTL 后并发提交 | 两个 202，一次受理、一次幂等重放 |
| RR05 | 恢复识别是否重复执行 | 共两次网络模型调用、三个独立 LogicalOperation 各一次尝试；一个 WorkItem，无 Brief |
| RR06 | 重试是否改变原文或丢失历史 | 一条 user_message、相同 sourceEventId、操作链和旧 deadline 保留 |
| RR07 | 实际服务重启后重放新旧回执 | 不再调用模型，不恢复旧操作；成功后用新键重试被拒绝 |

“三个操作、两次网络调用”来自中间操作在 circuit 检查处停止；操作尝试次数不能当作模型网络传输次数。本测试等待真实等待期结束，不清空 circuit 或修改生产模型配置。

## 失败、修正与证据边界

- 初始 HTTP 断言误以为每次受理都会访问模型；实际 provider circuit 在网络前拒绝。修正断言，并将该运行时原因映射为独立错误码和客户端提示；增加单元回归。初始和 circuit 失败日志保留。
- 初始 PostgreSQL 恢复夹具将 answer 目标填写为合同不支持的 chat，正确被拒绝。修正为合同中的 unresolved 并重跑，最终 32 项通过；初始失败日志保留。
- 数据库验证使用隔离 PostgreSQL 16.13，迁移 23，残留注入 trigger 为 0，容器已清理。File HTTP 服务与临时重启目录已清理。源码及文档 hash、日志范围见 recognition-retry-manifest.json。
- 全量测试覆盖 nested operation.id 的 Runtime 守卫和 circuit 回归。之后补充的快照重建额度操作绑定及 1 条测试，由最终 66 项相关回归、后端类型/构建和最终 HTTP 覆盖；PostgreSQL 32 项在此增量之前运行，不声称包含新增快照竞态。

## 仍未完成

通用 Brief/任务/源码/外部效果执行、复杂多目标澄清、特殊入口/Autopilot 完整矩阵、完整 CLI/Bridge 与 Web/Electron/SSE/进程故障矩阵、全部 58 场景仍需继续。ordered_plan 未启用；500+ 独立封存题、双人标注仲裁、三次真实模型评测与发布门尚未通过。相关 Task/Checklist 不整体勾选。

未提交、发布、部署或修改生产数据/模型连接配置。本轮完成恢复机制切片，不代表系统整体交付。

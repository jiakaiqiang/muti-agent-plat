# 执行停止状态一致性与通知 Tasks v1

状态：2026-09-15 已完成代码实现、独立 PostgreSQL 故障矩阵和 AC1-AC10 验收。

入口：[Spec](../product/runtime-stop-consistency-spec-v1.md) | [Plan](../design/runtime-stop-consistency-plan-v1.md) | [Checklist](../quality/runtime-stop-consistency-checklist-v1.md)。

## 第一批：修复状态残留与停止判断

- [x] T1 固化故障注入回归（AC1、2、4）。在 `runtime.service.spec.ts` 使用实际 RuntimeService/fixture 和内存 persistence，注入 settle 拒绝，重现原始 result 被拒绝、active=1、迟到确认后仍 waiting、取消超时；新增期望行为断言，保留修复前失败证据。
- [x] T2 设计并实现共享状态合同/存储（AC2、3、10；依赖 T1）。在 shared、persistence/relational 增加停止轮次、目标、版本及 file 默认；检查已有 migration，增加兼容迁移和回退测试。更新数据/API/runtime/event/UI 合同，不复制独立状态枚举。
- [x] T3 修复监督清理与待同步屏障（AC1、2、6；依赖 T1、T2）。在 RuntimeService 使用独立 finally 清理句柄，保留结束证据和错误，登记待同步后释放资源；状态失败不交付业务成功，不凭 Promise 拒绝确认进程结束。
- [x] T4 实现固定目标停止及统一查询（AC2、3；依赖 T2、T3）。同事务协调 stop/reserve，覆盖零目标、重复停止、并发启动、暂停/取消/超时/断线；Sessions 的停止、重试、resume 和删除前等待使用一致语义。
- [x] T5 实现有限核对与重启恢复（AC4、6、9；依赖 T3、T4）。复用可信回执，单 invocation 合并待同步，有限退避和耗尽状态；重启不遗失持久化未知屏障；诊断不含敏感正文。服务端丢失退出证据不得自动认定停止。

第一批退出条件：T1 原始故障在修复后通过，数据库失效不错误放行，恢复后不再因残留句柄阻塞；关键状态测试通过。不得以第一批通过声明整项 SDD 完成。

## 第二批：回执通知与双端展示

- [x] T6 统一 result/stopped 结束入口（AC4、5；依赖 T4、T5）。覆盖精确绑定、乱序、并发重复、迟到业务结果丢弃、无匹配历史回执和旧 result 客户端；不误确认新调用。
- [x] T7 实现原子事件/outbox 与 ACK（AC5、9；依赖 T2、T6）。同事务保存目标变化/聚合版本/事件/outbox；幂等键持久化判重，提交成功后 ACK；注入发布前/ACK 前崩溃，补发无重复通知。
- [x] T8 实现只读停止摘要接口和共享 store（AC7、10；依赖 T4、T7）。新增拟定 `/sessions/:id/stop-state`，沿用访问校验；快照/SSE 版本收敛、未知状态、断网恢复与旧事件兼容。
- [x] T9 接入 Web 与桌面展示（AC7、8；依赖 T8）。各自保留外观，一条实时停止摘要及可展开目标详情；连续历史重复事件只折叠展示，保留次数/时间；业务失败优先会话摘要，两个端一致。

## 整体验收与交付

- [x] T10 执行独立 PostgreSQL/传输故障矩阵（AC1–6、9、10；依赖 T5、T7）。多连接事务、reserve/stop 竞态、ACK 丢失、提交后崩溃、服务器重启、长期数据库失败及恢复；仅临时数据库/隔离进程，清理仅针对本次资源。
- [x] T11 执行双端 E2E 和构建门禁（AC7、8、10；依赖 T9、T10）。验证状态文案、刷新/SSE 重连、相邻业务消息不被折叠、移动/桌面布局无重叠；运行相关回归和 typecheck/build/harness，记录实际命令及限制。
- [x] T12 完成审查和交付记录（AC1–10；依赖 T11）。逐项填 Checklist，审查新增写入锁及 schema 兼容、异常清理、未知停止屏障；提供活动任务检查/迁移/运行更新/回退步骤。历史会话仅提供核对结果，不自动重跑。

## 2026-09-15 实施记录

- Runtime 在 Adapter 启动前和 reserve 提交后均检查 Session 停止摘要；settle 保存失败即使五轮重试耗尽，`start/run` 仍返回 `OPERATION_STOP_UNCONFIRMED`，显式核对成功后才放行，恢复过程不重启模型。
- `SessionStopStateStore`、`LogicalOperationStore`、Migration 9、`RUNTIME_STOP_STATE_CHANGED` 与 outbox 使用同一状态合同；停止事件幂等键为 `runtime-stop:<stopRequestId>:<version>`。
- Local Runtime 已验证 stopped/result 乱序、迟到 result 丢弃、错误 workspace 不 ACK，以及 100 次并发重复回执只产生一次确认通知；模拟 ACK 丢失后的重放不会增加停止版本、事件、outbox 或通知，提交失败时不发送 ACK。
- outbox 已验证“状态提交后、事件发布前进程退出”的恢复补发；同一停止事件幂等键出现状态/计数冲突时记录 `runtime_stop_event_idempotency_conflict_total`。
- Web 与 Electron desktop 共用停止状态模型，各自渲染稳定状态区；历史兼容回执仅按连续、同 invocation、同状态折叠。43 条匿名历史 fixture 折叠为一条展示，同时保留 43 条原始事件、次数和时间明细；停止状态查询失败覆盖旧 confirmed 快照并 fail closed。
- 停止链路日志已关联 `sessionId`、`stopRequestId`、`operationId`、`invocationId`、`deviceId`、`connectionId` 和 `version`；指标包含待同步数量、最长等待时间、重复回执和事件幂等冲突。
- `LogicalOperationStore.reserve` 已将持久化 Session 状态纳入同一集合事务；即使零目标停止立即 confirmed，`PAUSED/INTERRUPTED/CANCELLED/COMPLETED` Session 仍拒绝新预留，显式恢复到执行态后才放行。PostgreSQL 临时库已实测暂停 stop/reserve 竞争和跨连接重复回执/outbox 重启。
- 已通过 server 全量、Web `60 files / 281 tests`、desktop `13/13`、shared `92/92`、local-runtime-cli `83/83`，以及 cancel/recovery/client-presentation E2E、typecheck、build、Harness。最终命令和结果记录在 Checklist。
- T12 静态审查已核对集合锁按 key 排序、Migration 9 映射、未知停止屏障、幂等事件和模型零重放；临时库 runner 已补无 `.env` 环境兼容、强制终止测试库连接和 `pool.end()` 清理兜底。
- 用户明确授权后，`node scripts/test-session-persistence-postgres.mjs` 连续三轮各 8/8 通过，每轮均创建并删除唯一 `agent_cluster_sdd_test_*` 数据库。首次实跑暴露应用时钟略快于数据库时钟时 immediate outbox 暂不可领取；修复为未显式指定 `availableAt` 时使用 PostgreSQL 事务时钟，并以应用时钟领先 60 秒的确定性用例验证。

## 执行约束

每个任务先写可观测失败/预期，再实现，再附证据。跨层变更以 shared 合同为先；状态与事件不允许两套独立计数器。测试失败追到根因，不通过放松断言或关闭停止屏障规避。

任务文件路径是预计落点；新建测试或迁移的实际名称在实施时回填 Checklist。所有真实用户数据写入、历史任务恢复、服务更新都遵守当时授权和项目运维要求。完成条件为全部 AC 通过，跳过项不得写成通过。

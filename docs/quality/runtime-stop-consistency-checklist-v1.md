# 执行停止状态一致性与通知 Checklist v1

状态：2026-09-15 代码实现、独立 PostgreSQL 故障矩阵和 AC1-AC10 验收均已完成。

关联：[Spec](../product/runtime-stop-consistency-spec-v1.md) | [Plan](../design/runtime-stop-consistency-plan-v1.md) | [Tasks](../implementation/runtime-stop-consistency-tasks-v1.md)。

## 验收矩阵

| AC | 对应任务 | 必须执行的验证 | 当前结果/证据 |
| --- | --- | --- | --- |
| AC1 | T1、T3、T10 | settle 抛错时句柄/计时器清理，原结果诊断保留，未提交成功不进入业务交付 | 内存/file 通过：active=0，返回 `STOP_STATE_PERSISTENCE_FAILED`；真实 PostgreSQL 状态事务通过 |
| AC2 | T2–T5、T10 | 保存失败/进程未知时 resume、retry、reserve 不放行；已结束待保存与仍在执行明确区分 | 五轮耗尽仍以 `OPERATION_STOP_UNCONFIRMED` 拒绝 `start/run`，核对成功后放行；PostgreSQL 重构实例保留未知停止屏障 |
| AC3 | T2、T4、T10 | 固定目标、零目标、重复请求、并发 reserve/stop，计数和版本一致 | 重复请求复用 ID、目标固定、零目标 confirmed；真实 PostgreSQL stop/reserve 竞态拒绝预留，显式恢复后放行，版本保持单调 |
| AC4 | T5、T6、T10 | stopped/result 乱序、错误绑定、旧回执与新调用、跨重启证据恢复 | WebSocket/file 乱序、迟到结果和错误 workspace 用例通过；PostgreSQL 重启恢复停止请求、版本和目标证据通过 |
| AC5 | T6、T7、T10 | 100 次重复回执、跨连接竞争、提交前失败、提交后/ACK 前崩溃，事件只产生一次 | 100 次并发重复回执、ACK 丢失重放、提交失败不 ACK 均通过；PostgreSQL 跨连接仅一个有效确认，版本 1/2/3、事件/outbox 各唯一，重启可领取终态 outbox |
| AC6 | T3、T5、T10 | 事务重试上限、待同步退避/耗尽、数据库恢复；模型启动次数不因恢复增加 | 1/2/5/10/30 秒、最多五轮；耗尽时 Adapter starts=1，显式核对后 starts=2；PostgreSQL 恢复不触发模型重放 |
| AC7 | T8、T9、T11 | Web/桌面快照与 SSE 乱序、断线刷新、未知状态，旧版本不覆盖新版本 | 通过：store 版本/轮次收敛；HTTP 503 时旧 confirmed 快照被覆盖为 `unknown`、`canResume=false`、`state_query_failed`；双端 E2E 通过 |
| AC8 | T9、T11 | 历史 43 条通知的匿名 fixture 折叠/展开，跨调用/状态/业务消息边界，错误摘要优先 | 通过：43 条 fixture 折叠为一条且保留 43 条原始事件、次数和时间；仅连续同 invocation/状态折叠，业务消息截断分组；双端布局截图通过 |
| AC9 | T5、T7、T10 | 日志可关联调用/轮次/连接/版本，失败与重传可区分，无凭据/完整业务正文 | 结构化日志覆盖 receipt received/confirmed/replayed/ignored、persistence failed、ACK sent 及 `connectionId`；四项指标通过，数据库 runner 错误保持脱敏 |
| AC10 | T2、T8、T10–T12 | 隔离 PostgreSQL、file、新旧协议、迁移与受控回退、相关构建回归 | file、新旧协议、Migration 9、API、双端和构建通过；独立 PostgreSQL 连续三轮 8/8，通过后每轮临时库均删除 |

## 已有诊断证据与限制

- 父任务只读事件查询：同一 invocation 43 个独立通知 ID，时间见 Spec E1；不能据此证明具体 socket 重传来源。
- 独立 subagent 纯内存故障注入：settle 失败后 active=1；持久化恢复 confirmed 后 active=1/unknownDurable=false，取消仍超时。该修复前缺陷已固化为 `runtime.service.spec.ts` 回归；修复后 active 句柄释放、准入继续阻断，显式核对成功后才放行。
- 当前既有“正常结束静默、并发重复回执只通知一次”测试通过，仅说明连接层局部幂等；不替代 AC1、AC4、AC5 的故障/重启验证。
- 历史 `.cache/agent-cluster/auto-runtime-restart.stderr.log` 有同期停止回执版本冲突；日志不含 invocationId，不能逐条关联。最终根因报告应保留此限制。

## 实际验证记录

代码基线：`6cdbefb` 加当前未提交工作区差异；所有命令在仓库根目录执行，使用 mock、内存/file persistence 和隔离本地进程，未调用真实模型、未恢复历史业务任务。

| 命令 | 结果 |
| --- | --- |
| `npm run test -w @agent-cluster/server` | 通过：1304 passed、9 skipped、0 failed；附加控制测试 7/7 |
| `node scripts/test-session-persistence-postgres.mjs`（连续三轮） | 每轮 8/8 通过、0 skipped；覆盖多连接事务、暂停 stop/reserve 竞态、跨连接回执幂等、单调终态版本、唯一事件/outbox 和重启领取。三个 `agent_cluster_sdd_test_*` 数据库均成功删除 |
| 停止链路定向 spec（Runtime、LogicalOperation、Local Runtime、stop-state controller、stop event、metrics） | 已由 server 全量收集并通过；覆盖 ACK 丢失、发布前退出、指标与幂等冲突 |
| `npm run test -w @agent-cluster/shared` | 通过：92/92 |
| `npm run test -w @agent-cluster/local-runtime-cli` | 通过：83/83 |
| `npm run test -w @project/web` | 通过：60 files、281 tests |
| `npm run test:desktop` | 通过：13/13 |
| `npm run test:e2e:cancel` | 通过 |
| `npm run test:e2e:recovery` | 通过 |
| `npm run test:e2e:client-presentation` | 通过：Web/Desktop 的 1440 桌面和 720x900 窄屏检查均通过 |
| `npm run typecheck`、`npm run build`、`npm run test:harness` | 通过 |
| `git diff --check` | 通过，仅有仓库既有 CRLF 提示 |

停止诊断指标通过 `/api/ops/workspace-metrics` 的既有快照输出暴露：`runtime_stop_pending_sync_count`、`runtime_stop_pending_sync_oldest_ms`、`runtime_stop_receipt_replay_total`、`runtime_stop_event_idempotency_conflict_total`。指标不携带凭据、提示正文或业务产物。

双端截图保存在 `output/playwright/client-separation/`，其中包含 `web-chat-stopped*.png` 与 `desktop-chat-stopped*.png`。

## PostgreSQL 隔离验证

用户明确授权后执行：

```bash
node scripts/test-session-persistence-postgres.mjs
```

首次执行为 7/8，暴露 immediate outbox 的 `available_at` 使用应用事件时间，在应用时钟略领先 PostgreSQL 时会短暂不可领取。未通过增加等待规避；实现改为仅在显式指定 `availableAt` 时使用该值，否则使用事务内 `now()`，并将夹具固定为应用时钟领先 60 秒。修复后连续三轮均为 8/8。

runner 优先读取进程级 `DATABASE_URL`，仅在缺失时读取 `.env`；数据库名固定为 `agent_cluster_sdd_test_<pid>_<timestamp>` 并经过白名单校验。结束时先终止仅属于该临时库的残留连接，再删除该库，清理失败会返回失败且仍执行 `pool.end()`。数据库中未遗留该前缀的测试库。

无需连接数据库的安全预检：

```bash
node scripts/test-session-persistence-postgres.mjs --check
```

该模式只校验脱敏后的 PostgreSQL URL 类型、临时库命名规则与集成测试文件存在性，不创建连接、数据库或进程。

## 静态审查与运行恢复

- 集合事务统一按 key 排序取得 advisory lock；reserve 同时读取 `sessions`、`logicalOperationsBySession`、`sessionStopRequestsBySession`、`eventsBySession/eventOutbox`，停止轮次更新与事件/outbox 不拆分提交。
- Migration 9 的表、唯一开放轮次索引、定向读取、全量恢复、replace-state、cutover seed 和 collection write order 均有静态/单元覆盖；PostgreSQL 实际 DDL 与跨连接行为已由 T10 实测通过。
- 更新顺序：检查活动任务并暂停准入，备份文件和数据库，先执行 migration/verify，再启动依赖新集合的 server、Web 和 desktop，最后观察四项停止指标与结构化日志。
- 回退顺序：先停止所有写入副本并确认无未确认调用，保留 `session_stop_requests`、事件和 outbox，导出完整回滚快照，再切换到经过兼容验证的构建；禁止删除停止记录或事件来解除屏障。
- 历史会话只允许经只读核对后使用可信回执/显式 reconcile；不自动重跑模型、不应用迟到业务结果、不删除历史通知。

## 每次执行的证据记录

| 项目 | 需填写 |
| --- | --- |
| 代码版本 | commit 与工作区差异标识，source/build 是否一致 |
| 命令与环境 | 实际 cwd/命令、运行时间、独立数据库/端口、Runtime fixture 类型 |
| 覆盖范围 | AC、任务编号、故障注入点、实际事件数/模型启动数/残留句柄数 |
| 结果 | 退出码、通过/失败/跳过及原因、日志/截图路径 |
| 重启验证 | 持久化前后及 ACK 前后崩溃位置，重启后的屏障与通知数 |
| 清理与边界 | 只清理本次隔离资源；未写业务数据库、未重跑历史模型任务 |

## 完成检查

- [x] AC1–AC10 均有与范围匹配的实际证据，失败和跳过项已解决或明确阻塞交付。
- [x] 两批任务均完成，不能用消息折叠替代状态恢复，不能用局部测试替代端到端验收。
- [x] 合同、类型、迁移、兼容行为及文档和代码一致，不存在幽灵 API/脚本。
- [x] 已审查未知停止保护、原子提交、幂等、迟到结果丢弃和模型零重放。
- [x] 双端展示和历史消息折叠检查通过；业务失败原因不被协议进度覆盖。
- [x] 更新与回退步骤可执行，未以删除状态/事件释放屏障；真实会话是否恢复单独记录。

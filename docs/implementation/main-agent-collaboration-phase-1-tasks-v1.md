# 阶段 1：多会话执行隔离、停止与可恢复删除 — Tasks v1

> 日期：2026-09-16
> 状态：全部任务已完成并通过阶段验收（2026-09-16）。
> 依赖：阶段 0 通过。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-1-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-1-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-1-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-1-checklist-v1.md)

## 执行规则

- 阶段 0 前置已通过；实施未跳过安全与确认门禁。
- 每项先补合同/失败用例，再实现；数据库、模型、CLI 与双端边界分别验证。
- 复用现有能力仍需回归，不将既有专项的通过记录直接复制为本阶段通过。
- 验收使用 Mock Runtime，不调用真实付费模型；PostgreSQL 使用创建后自动删除的一次性数据库。

## 任务清单

### P1-T1 盘点所有会话工作句柄

- [x] 完成实现与审查。
- 前置：阶段 0 通过。
- 交付：登记调用、队列、路由、讨论、计时器、CLI 和写回归属，补上遗漏的取消入口。
- 覆盖：P1-AC1。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 结果：普通调用、队列、工作流、意图路由及异步结果均绑定 sessionId/operationId/generation；共享 Agent 未成为取消作用域。

### P1-T2 实现生命周期与原子准入

- [x] 完成实现与审查。
- 前置：P1-T1 完成；涉及的其他阶段依赖同页顶部。
- 交付：共享合同、加法迁移、generation/墓碑与 reserve/stop/delete 原子顺序。
- 覆盖：P1-AC2、P1-AC4、P1-AC5。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 结果：新增持久化 SessionLifecycleStore、PostgreSQL V10 表和 file 投影；reserve/stop/delete 进入相同 scoped mutation。

### P1-T3 补强停止与重启核对

- [x] 完成实现与审查。
- 前置：P1-T2 完成；涉及的其他阶段依赖同页顶部。
- 交付：复用现有可信回执屏障，加入其他受管工作，禁止设备级停止。
- 覆盖：P1-AC1、P1-AC2、P1-AC3。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 结果：先关闭准入再固定停止目标；未知和 pending_sync 保持可见，恢复前必须得到可信停止证据。

### P1-T4 实现可恢复删除/恢复

- [x] 完成实现与审查。
- 前置：P1-T3 完成；涉及的其他阶段依赖同页顶部。
- 交付：普通删除移除物理 purge，保留目录/产物，返回异步生命周期，恢复不启动模型。
- 覆盖：P1-AC4、P1-AC5、P1-AC6。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 结果：删除为 `active -> deleting -> deleted`，不调用物理 purge；恢复提升 generation 并固定为 `PAUSED`，不自动调用模型。

### P1-T5 接入共享状态与双端呈现

- [x] 完成实现与审查。
- 前置：P1-T4 完成；涉及的其他阶段依赖同页顶部。
- 交付：更新共享 API/store；各端用原样式显示停止中、删除阻塞和恢复结果。
- 覆盖：P1-AC3、P1-AC4、P1-AC6。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 结果：Web/桌面均查询 `visibility=all`，提供“已删除”列表、删除中状态和带 expectedGeneration 的恢复入口；两端保留各自样式。

### P1-T6 验证并发、崩溃与迟到事件

- [x] 完成实现与审查。
- 前置：P1-T5 完成；涉及的其他阶段依赖同页顶部。
- 交付：file + 独立 PostgreSQL + 隔离 CLI stub；验证 A/B 共用 Agent、同目录及删除恢复。
- 覆盖：P1-AC1、P1-AC2、P1-AC3、P1-AC4、P1-AC5、P1-AC6。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 结果：file E2E、独立 PostgreSQL 连接竞争、共享 Agent 双会话、旧 generation 回调和恢复后显式继续均通过；Runtime 后处理、Memory、Workspace Writeback 与 LogicalOperation 均在生命周期关闭后拒绝旧 generation，正常暂停不会再被记录为 pipeline crash。

## 完成定义

双会话隔离、可信停止、可恢复删除、迟到写回和真实 PostgreSQL 竞争全部通过。

P1-T1 至 P1-T6 及 P1-AC1 至 P1-AC6 均有实现和测试证据；未修改其他未通过阶段的状态。

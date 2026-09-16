# 阶段 1：多会话执行隔离、停止与可恢复删除 — Spec v1

> 日期：2026-09-16
> 状态：设计与实施基线，待实施；现有能力的复用不代表本阶段验收已完成。
> 依赖：阶段 0 通过。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-1-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-1-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-1-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-1-checklist-v1.md)

## 1. 目标与用户结果

同一 Agent 服务多个会话时，停止或删除其中一个只影响目标会话；未知停止状态不得伪装成功，删除不损毁源码或未合并产物。

## 2. 范围与非目标

- 补强执行实例隔离、统一停止屏障、持久化生命周期与迟到回调隔离。
- 将用户删除改为先封禁执行准入、停止、再可恢复隐藏；保留审计和产物。

非目标：

- 不停止共享本地助手设备进程，不全局禁用 Agent。
- 不实现自动物理清理，不回滚已经写入的用户文件，不更换现有工作区隔离设计。

## 3. 当前实现依据

- 已有 SessionStopStateStore 与 LogicalOperation 停止请求、固定目标和恢复屏障；需扩展覆盖未来讨论/摘要任务而非重做。 [源码/既有文档](../../apps/server/src/modules/runtimes/session-stop-state-store.ts)
- 当前 delete 在停止后删除会话目录、子系统记录并调用 deleteSessionData 物理清理；与可恢复删除目标存在明确差异。 [源码/既有文档](../../apps/server/src/modules/sessions/sessions.service.ts)
- 已有同目录多 Session 隔离/写回设计，不能退回整工作区单活动会话锁。 [源码/既有文档](../../docs/design/workspace-multi-session-isolation-writeback-v1.md)

以上为现状定位，不等于本专项测试结果；实施前复核当前工作树，不覆盖无关改动。

## 4. 验收条件

- P1-AC1：运行句柄、队列、重试、讨论、路由、摘要及 CLI 会话都归属于目标 Session/WorkItem/运行 ID；共享 Agent 只存配置和能力。
- P1-AC2：先持久化关闭目标会话的新调用准入，再锁定停止目标并发出取消；新预留与停止竞争只允许一个顺序结果。
- P1-AC3：停止以可信调用结束且状态提交成功为准；未知/待同步可见，重启后屏障保留；停止不撤销文件修改。
- P1-AC4：用户删除成为可恢复生命周期：deleting → deleted；删除中禁止消息、执行、写回、召回；停止未确认则停留 deleting 并给出阻塞。
- P1-AC5：通过 generation/墓碑校验阻止迟到结果、事件投影、缓存、写回重新激活已删除会话。
- P1-AC6：恢复仅恢复可见数据和停稳状态，不自动运行；目录/产物保留，其他会话与共享项目不被删除。

## 5. 约束与风险

- 旧代码继续调用物理删除会破坏恢复保证，必须覆盖所有删除入口和清理 worker。
- 只依赖进程内 Map 的删除标识不能抵御重启或多实例。

共同约束：复用 v2-only、现有 Runtime/Tool Authority 和持久化事务边界；Web 与桌面共享业务状态但保留各自样式；不自动重跑历史任务、不清库、不变更凭据或外部权限。

## 6. 阶段退出

双会话隔离、可信停止、可恢复删除、迟到写回和真实 PostgreSQL 竞争全部通过。

本阶段详细任务和证据填写位置见 Tasks/Checklist。只有实现与必须验证均完成后才可更新状态，文档生成不勾选开发项。

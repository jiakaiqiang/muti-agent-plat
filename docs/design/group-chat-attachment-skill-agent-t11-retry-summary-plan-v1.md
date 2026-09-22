# GC-11 取消、失败重试与重新汇总 Plan v1

> [Spec](../product/group-chat-attachment-skill-agent-t11-retry-summary-spec-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t11-retry-summary-task-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t11-retry-summary-checklist-v1.md)

## 研究定位

- 编排和任务状态：`apps/server/src/modules/orchestrator/`、`apps/server/src/modules/tasks/`。
- 取消/恢复：sessions、events、queue/execution 模块。
- 前端动作：`ConfirmationCard.vue`、协同任务面板和事件 store。

## 设计决策

- 取消是任务级状态转换，不能删除已完成 Agent 输出。
- 重试使用原 Agent/任务 ID 的新 attempt，结果与原失败 attempt 分开。
- 汇总使用不可变版本记录，手动重新汇总追加新版本。
- 汇总输入由确定性结果集构造，避免自动把失败结果当成功结果。

## 实施步骤

1. 增加任务取消和 Agent retry 状态。
2. 增加失败 Agent 单独重试入口。
3. 增加临时汇总和手动 re-summarize 命令。
4. 持久化 summary version 和输入结果集。
5. 增加状态机和版本测试。

## 风险

- 迟到结果不得写回已取消任务。
- 重试不能创建重复的最终汇总。

## 实际落点与验收结果

- 后端落点：`apps/server/src/modules/sessions/sessions.service.ts`、`sessions.controller.ts`；使用已有 Session 控制和事件持久化边界，新增取消、失败 Agent 重试、临时汇总及手动重汇总。
- 前端落点：`apps/web/src/stores/session.ts`、`SessionWorkspace.vue`、`CollaborationTaskBoard.vue`、`CollaborationTaskPanel.vue`、`collaborationTaskModel.ts`；面板动作通过 store 调用后端并重新对账事件。
- 版本策略：汇总事件保存 `summaryKind`、`summaryVersion`、`collaborationTaskId`、`sourceEventIds`；模型按事件 ID 去重并保留所有版本。
- 验收证据：Server 全量 `1675 passed / 17 skipped`，Server dev `7 passed`，Web 全量 `350 passed`；Server/Web typecheck 通过。

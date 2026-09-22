# GC-11 取消、失败重试与重新汇总 Spec v1

> 任务：GC-11 | 预计：10–15 分钟 | 前置：GC-10
> [总路线图](../roadmap/group-chat-attachment-skill-agent-sdd-roadmap-v1.md) · [Plan](../../docs/design/group-chat-attachment-skill-agent-t11-retry-summary-plan-v1.md) · [Task](../../docs/implementation/group-chat-attachment-skill-agent-t11-retry-summary-task-v1.md) · [Checklist](../../docs/quality/group-chat-attachment-skill-agent-t11-retry-summary-checklist-v1.md)

## 目标

支持协同任务中止、失败 Agent 单独重试和用户主动重新汇总，同时保留过程证据。

## 行为要求

- Agent 失败时其他 Agent 继续。
- 用户可中止整个任务。
- 中止后保留已完成结果，并由主 Agent 生成当前阶段临时汇总。
- 用户可单独重试失败 Agent。
- 重试完成后不自动更新汇总。
- 用户点击“重新汇总”后，纳入所有已完成和重试成功结果。
- 新汇总追加为新版本，不覆盖原汇总。
- 所有汇总由主 Agent 完成。

## 验收标准

- `GC11-AC1`：失败不阻塞其他 Agent。
- `GC11-AC2`：取消后已完成结果保留。
- `GC11-AC3`：失败 Agent 可单独重试。
- `GC11-AC4`：重试不自动重汇总。
- `GC11-AC5`：手动重汇总生成新版本并保留旧版本。

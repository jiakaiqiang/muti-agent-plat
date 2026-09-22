# GC-10 协同任务面板与阶段输出 Spec v1

> 任务：GC-10 | 预计：10–15 分钟 | 前置：GC-09
> [总路线图](../roadmap/group-chat-attachment-skill-agent-sdd-roadmap-v1.md) · [Plan](../../docs/design/group-chat-attachment-skill-agent-t10-collaboration-panel-plan-v1.md) · [Task](../../docs/implementation/group-chat-attachment-skill-agent-t10-collaboration-panel-task-v1.md) · [Checklist](../../docs/quality/group-chat-attachment-skill-agent-t10-collaboration-panel-checklist-v1.md)

## 目标

以一个可持久化的协同任务面板展示 Agent 分发、状态、进度和阶段性输出。

## 行为要求

- 展示参与 Agent、Skill、附件处理状态和路由结果。
- 展示每个 Agent 的阶段性输出和状态。
- 展示运行中、成功、失败、取消、重试状态。
- 面板默认可见，任务完成后保留在历史消息中。
- 可按 Agent 展开查看完整中间结果。
- 主 Agent 的汇总与各 Agent 阶段输出分离。

## 验收标准

- `GC10-AC1`：路由事件能形成任务面板。
- `GC10-AC2`：状态和进度按 Agent 独立更新。
- `GC10-AC3`：中间结果可展开查看。
- `GC10-AC4`：完成后面板仍可从历史消息打开。
- `GC10-AC5`：失败 Agent 与成功 Agent 明确区分。

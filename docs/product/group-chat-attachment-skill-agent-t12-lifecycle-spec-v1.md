# GC-12 历史、生命周期与删除一致性 Spec v1

> 任务：GC-12 | 预计：10–15 分钟 | 前置：GC-03、GC-08、GC-09
> [总路线图](../roadmap/group-chat-attachment-skill-agent-sdd-roadmap-v1.md) · [Plan](../../docs/design/group-chat-attachment-skill-agent-t12-lifecycle-plan-v1.md) · [Task](../../docs/implementation/group-chat-attachment-skill-agent-t12-lifecycle-task-v1.md) · [Checklist](../../docs/quality/group-chat-attachment-skill-agent-t12-lifecycle-checklist-v1.md)

## 目标

保证历史消息、Skill/Agent 快照、附件和群聊生命周期在删除、停用和重新执行时一致。

## 行为要求

- 历史消息保留可读文本和结构化引用。
- Skill 停用/删除后，历史 Tag 保留；重新执行使用当前最新启用版本。
- Agent 停用/删除后，历史 `@Agent` Tag 保留但不可再次执行。
- 新加入 Agent 可以访问加入前完整消息和附件。
- 群聊被删除时附件和临时 Agent 关系结束。
- 删除消息时同步删除附件本体和引用。

## 验收标准

- `GC12-AC1`：历史 Tag 不因列表变化消失。
- `GC12-AC2`：历史执行遵循当前 Skill 版本和权限。
- `GC12-AC3`：不可用 Agent 不能被历史消息再次执行。
- `GC12-AC4`：消息/群聊删除达到一致结果。
- `GC12-AC5`：新 Agent 能获得加入前上下文。

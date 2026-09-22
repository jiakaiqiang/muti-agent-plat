# GC-08 `@Agent` 列表与加入确认 Spec v1

> 任务：GC-08 | 预计：10–15 分钟 | 前置：GC-01
> [总路线图](../roadmap/group-chat-attachment-skill-agent-sdd-roadmap-v1.md) · [Plan](../../docs/design/group-chat-attachment-skill-agent-t08-agent-picker-plan-v1.md) · [Task](../../docs/implementation/group-chat-attachment-skill-agent-t08-agent-picker-task-v1.md) · [Checklist](../../docs/quality/group-chat-attachment-skill-agent-t08-agent-picker-checklist-v1.md)

## 目标

将 Agent 管理数据接入 `@` 选择器，支持多候选 Agent、分组、搜索和群外 Agent 加入确认。

## 行为要求

- Agent 来源是独立 Agent 管理模块，不是插件注册中心。
- 列表只展示当前用户有权限、已启用且当前可用的 Agent。
- 主 Agent 不出现在列表。
- 支持 Agent 分类/分组和按名称、显示名称、描述搜索。
- 一条消息允许多个 Agent Tag。
- 选择尚未加入当前群聊的 Agent 时，弹出确认；用户确认后加入当前群聊。
- 新加入 Agent 可读取加入前的历史消息和附件。
- 群聊被删除后，临时加入关系结束；本期不实现主动移除。

## 验收标准

- `GC08-AC1`：列表来源和权限过滤正确。
- `GC08-AC2`：主 Agent 不显示。
- `GC08-AC3`：搜索和分组可用。
- `GC08-AC4`：多个 Agent Tag 可以共存。
- `GC08-AC5`：群外 Agent 需要用户确认后加入。
- `GC08-AC6`：新加入 Agent 能获得完整历史上下文权限。

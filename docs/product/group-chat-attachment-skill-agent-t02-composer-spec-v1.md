# GC-02 输入框附件与 Tag 状态 Spec v1

> 任务：GC-02 | 预计：10–15 分钟 | 前置：GC-01
> [总路线图](../roadmap/group-chat-attachment-skill-agent-sdd-roadmap-v1.md) · [Plan](../../docs/design/group-chat-attachment-skill-agent-t02-composer-plan-v1.md) · [Task](../../docs/implementation/group-chat-attachment-skill-agent-t02-composer-task-v1.md) · [Checklist](../../docs/quality/group-chat-attachment-skill-agent-t02-composer-checklist-v1.md)

## 目标

在输入框中提供附件预览、删除和 `/`、`@` Tag 的可视化状态，不在本任务中连接真实上传服务。

## 行为要求

- 图片显示缩略图，文件显示预览 Tag。
- 图片最多 4 个，文件最多 4 个，总数最多 8 个。
- 每个附件可单独删除。
- `/Skill`、`@Agent` Tag 可单独删除和替换。
- `/Skill`、`@Agent`、附件使用固定视觉差异。
- `/` 未选择 Skill 可以作为普通字符发送。
- `@` 输入后未选择 Agent 不允许发送。
- `/` 和 `@` 选择顺序不受限制。

## 验收标准

- `GC02-AC1`：选择和删除附件不会影响其他附件。
- `GC02-AC2`：第二个 Skill 选择被阻止。
- `GC02-AC3`：多个 Agent Tag 可以共存。
- `GC02-AC4`：未完成 Agent 选择的 `@` 消息不能提交。
- `GC02-AC5`：普通 `/` 文本仍可提交。

## 非目标

- 不实现上传网络请求、识别状态和持久化。
- 不实现 Skill/Agent 列表数据源；仅消费选择器提供的引用。

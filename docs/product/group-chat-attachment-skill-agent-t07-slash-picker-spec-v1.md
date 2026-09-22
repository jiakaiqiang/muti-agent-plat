# GC-07 `/Skill` 分类选择器 Spec v1

> 任务：GC-07 | 预计：10–15 分钟 | 前置：GC-02、GC-06
> [总路线图](../roadmap/group-chat-attachment-skill-agent-sdd-roadmap-v1.md) · [Plan](../../docs/design/group-chat-attachment-skill-agent-t07-slash-picker-plan-v1.md) · [Task](../../docs/implementation/group-chat-attachment-skill-agent-t07-slash-picker-task-v1.md) · [Checklist](../../docs/quality/group-chat-attachment-skill-agent-t07-slash-picker-checklist-v1.md)

## 目标

在输入框中接入 Skill 注册中心，使用户输入 `/` 后可以按一级分类选择一个 Skill。

## 行为要求

- 只展示当前用户有权使用且已启用的 Skill。
- 分类和 Skill 按名称排序。
- 不支持关键词搜索。
- 选择一个 Skill 后生成 `/Skill` Tag 并关闭列表。
- 已有 Skill 时不能再选择第二个。
- Tag 可删除或替换。
- 未选择时 `/` 仍可作为普通字符发送。

## 验收标准

- `GC07-AC1`：输入 `/` 打开分类列表。
- `GC07-AC2`：停用/无权限 Skill 不显示。
- `GC07-AC3`：一次消息最多一个 Skill。
- `GC07-AC4`：选择结果带稳定 Skill ID 和版本。
- `GC07-AC5`：列表键盘/鼠标选择后 Tag 正确回填。

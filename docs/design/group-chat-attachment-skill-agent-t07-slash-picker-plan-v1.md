# GC-07 `/Skill` 分类选择器 Plan v1

> [Spec](../product/group-chat-attachment-skill-agent-t07-slash-picker-spec-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t07-slash-picker-task-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t07-slash-picker-checklist-v1.md)

## 研究定位

- 输入框：`apps/web/src/components/UserInputBox.vue`。
- Skill 状态：`apps/web/src/stores/skill.ts`、`apps/web/src/components/SkillManager.vue`。
- 样式：`apps/web/src/styles.css`，遵循现有 UI 规范。

## 设计决策

- 选择器消费后端已经合并好的可用 Skill 列表，不在前端重复计算权限覆盖。
- 分类使用扁平分组；同一 Skill 不在多个分类重复展示。
- 输入解析只负责触发 UI，提交时传递结构化引用。
- 列表无搜索框，避免与已确认的分类/列表交互冲突。
- 触发条件是草稿末尾的唯一 `/`（空草稿或空白后的 `/`）；`/path`、包含既有 `/` 的正文和多个 `/` 不打开选择器。
- 选择器通过 `GET /skills/available` 与 `GET /skills/categories/available` 获取服务端已完成权限过滤的 active 数据。
- 选择结果移除触发 `/`，写入带 `id/key/revision/scope/scopeId/categoryId/status` 的单一 `GroupChatSkillRef`；已有 Skill 时沿用单 Skill 限制并发出阻止事件。
- 通过 `role=listbox/option`、`aria-selected` 和键盘上下/回车/Esc 支持键盘操作；没有关键词输入控件。

## 实施步骤

1. 在输入框增加 `/` 触发状态。
2. 渲染分类和 Skill 列表。
3. 选择后写入单一 SkillRef。
4. 处理删除、替换、Esc 和普通 `/` 文本。
5. 增加组件测试。

## 已落地文件

- `apps/web/src/components/UserInputBox.vue`
- `apps/web/src/stores/skill.ts`
- `apps/web/src/components/UserInputBoxComposer.spec.ts`

## 风险

- 需要避免用户输入正文中的路径 `/foo` 被强制变成 Skill；只有打开列表并确认选择才生成引用。

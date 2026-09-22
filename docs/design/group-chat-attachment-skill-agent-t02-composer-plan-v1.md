# GC-02 输入框附件与 Tag 状态 Plan v1

> [Spec](../product/group-chat-attachment-skill-agent-t02-composer-spec-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t02-composer-task-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t02-composer-checklist-v1.md)

## 研究定位

- 输入框：`apps/web/src/components/UserInputBox.vue`。
- 消息类型：`apps/web/src/types/contracts.ts` 和 `packages/shared/src/contracts.ts`。
- 现有可复用 UI：`apps/web/src/components/UiIcon.vue`、`apps/web/src/styles.css`。

## 设计决策

- 将编辑态拆成纯状态对象，避免把展示 Tag 直接拼回正文。
- 附件限制在客户端即时提示，服务端 GC-03 再做最终校验。
- 删除操作只修改草稿，不触碰已发送消息。
- 预览组件提供失败/识别中占位状态，但由 GC-03/GC-04 提供真实状态。

## 实施步骤

1. 增加草稿附件和指令引用状态。
2. 在输入框渲染图片缩略图、文件 Tag、Skill/Agent Tag。
3. 添加单项删除和替换回调。
4. 加入数量限制与 `@` 未完成选择的提交守卫。
5. 增加组件测试，覆盖混合附件和 Tag 顺序。

## 风险与验证

- 风险：现有输入框可能直接依赖纯文本；先保持正文字段兼容。
- 验证：组件单测、中文可见文案测试和手工键盘操作。

# GC-02 输入框附件与 Tag 状态 Task v1

> [Spec](../product/group-chat-attachment-skill-agent-t02-composer-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t02-composer-plan-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t02-composer-checklist-v1.md)

> 状态：已完成（2026-09-22）

## 任务目标

只实现输入框草稿层的附件和 Tag 交互，不连接真实上传和 Agent 路由。

## 10–15 分钟执行清单

1. 在 `UserInputBox.vue` 找到现有提交和草稿状态。
2. 引入 GC-01 的附件、Skill、Agent 引用类型。
3. 增加图片缩略图、文件预览 Tag 和统一删除回调。
4. 增加最多 4 图/4 文件校验和 `@` 未选择阻止发送。
5. 添加组件测试并运行定向测试。

## 交付物

- 输入框草稿状态和 Tag 展示。
- 单项删除/替换交互。
- 数量和提交守卫测试。

## 完成定义

不依赖后端时，可以通过 fixture 在输入框完整演示附件、`/Skill`、`@Agent` 的选择和删除。

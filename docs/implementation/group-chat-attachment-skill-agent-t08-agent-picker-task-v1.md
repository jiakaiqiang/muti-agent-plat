# GC-08 `@Agent` 列表与加入确认 Task v1

> 状态：已完成（实现、测试和证据已闭环）

> [Spec](../product/group-chat-attachment-skill-agent-t08-agent-picker-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t08-agent-picker-plan-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t08-agent-picker-checklist-v1.md)

## 任务目标

完成 `@Agent` 的数据读取、分组/搜索、多选 Tag 和群外 Agent 加入确认。

## 10–15 分钟执行清单

1. 从 Agent 管理接口取得用户有权限且可用的 Agent。
2. 过滤主 Agent，按分类展示并支持名称/描述搜索。
3. 在输入框实现多个 AgentRef 的添加、删除和替换。
4. 选择群外 Agent 时创建确认状态，确认后写入群聊成员。
5. 增加历史消息/附件可见性 fixture 和单测。

## 不做

- 不实现 Agent 注册中心。
- 不实现 Agent 主动移除。
- 不决定 Skill 最终执行者。

## 完成定义

用户可以在一条消息中选多个候选 Agent；群外候选只有在用户确认后才加入群聊。

## 交付记录

- `UserInputBox.vue` 接入 Agent 管理模块的 `mention` catalog，过滤停用、无权限和主 Agent，按标签/角色分组并支持名称、key、描述、角色和标签搜索。
- `@` 支持键盘上下/回车/Esc；多个 Agent 以紫色 Tag 共存，发送时把结构化 AgentRef 合并为 `mentionedAgentIds`，不依赖正文解析。
- 群外 Agent 先进入确认对话框，取消不会改变草稿或成员；确认后发出 `agent-join-confirmed`，会话工作区调用加入 API。
- 新增 `POST /sessions/:sessionId/agents/:agentId/join`，服务端校验 `mention` surface、拒绝主 Agent，幂等追加会话成员并记录历史消息/附件索引可见性事件。
- 补齐既有讨论成员确认卡片的 Web 类型与处理分支，确认/拒绝走现有会话 API。

## 验证结果

- `npm run typecheck -w @agent-cluster/shared`、`@agent-cluster/server`、`@project/web`：通过。
- `node ../../node_modules/tsx/dist/cli.mjs --test --test-force-exit src/modules/sessions/sessions.service.spec.ts`（`apps/server`）：118/118 通过。
- `npm run test -w @project/web -- src/components/UserInputBoxComposer.spec.ts`：15/15 通过。
- `npm run test -w @project/web`：66 个文件、346 个测试通过。
- Server 全量回归：1665 通过、17 跳过；开发服务器套件 7/7 通过。

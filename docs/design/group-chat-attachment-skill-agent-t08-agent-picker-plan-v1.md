# GC-08 `@Agent` 列表与加入确认 Plan v1

> [Spec](../product/group-chat-attachment-skill-agent-t08-agent-picker-spec-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t08-agent-picker-task-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t08-agent-picker-checklist-v1.md)

## 研究定位

- Agent 后端：`apps/server/src/modules/agents/`。
- 默认 Agent：`packages/shared/src/default-agents.ts`。
- 输入框和确认卡片：`apps/web/src/components/UserInputBox.vue`、`apps/web/src/components/ConfirmationCard.vue`。
- 群聊历史/附件权限：sessions、persistence、attachments 边界。

## 设计决策

- 前端只消费 Agent 管理返回的可用结果，不自行隐藏主 Agent 之外的特殊角色。
- 多选只保存候选引用，不在选择时决定最终执行者。
- 群外 Agent 加入使用显式用户确认事件，确认前不改变群聊成员状态。
- 加入后授予只读历史/附件上下文读取能力，执行路由由 GC-09 决定。
- 数据源使用 `GET /agents?surface=mention`；输入框按 `status=active`、`allowedSurfaces` 和 `coordinator` 系统角色过滤，Agent 不进入 Skill 注册中心。
- `@` 后续文本作为查询串，匹配 `name/key/description/role/tags`；分组使用首个标签，缺失时回退到角色/未分类，组和 Agent 都按名称排序。
- 群外确认成功后调用 `POST /sessions/:sessionId/agents/:agentId/join`；服务端追加 `participatingAgentIds`，写入 `historyReadable`/`attachmentIndexReadable` 证据，并以成员 ID 幂等。
- 发送路径合并正文解析出的 Agent ID 与结构化 `GroupChatAgentRef`，服务器继续执行会话成员校验。

## 实施步骤

1. 暴露当前用户可用 Agent、分组和搜索数据。
2. 在输入框接入 `@` 触发、多选和 Tag。
3. 增加群外 Agent 加入确认卡片。
4. 增加历史上下文可见性标记。
5. 增加组件和权限测试。

## 已落地文件

- `apps/web/src/components/UserInputBox.vue`
- `apps/web/src/components/SessionWorkspace.vue`
- `apps/web/src/components/ChatTimeline.vue`
- `apps/web/src/stores/agent.ts`（复用现有 Agent 管理 catalog）
- `apps/web/src/stores/session.ts`
- `apps/web/src/types/contracts.ts`
- `apps/server/src/modules/sessions/sessions.controller.ts`
- `apps/server/src/modules/sessions/sessions.service.ts`

## 风险

- “可用 Agent”与“当前群成员”不能混为一谈；列表可以包含群外候选。
- 加入确认必须幂等，重复确认不能重复增加成员关系。

# GC-09 Tag 序列化与语义路由 Task v1

> [Spec](../product/group-chat-attachment-skill-agent-t09-routing-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t09-routing-plan-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t09-routing-checklist-v1.md)

## 任务目标

将输入框结构化引用接入消息和编排，实现 `/Skill`、`@Agent`、附件的统一路由。

## 10–15 分钟执行清单

1. 在消息创建入口保存可读文本和结构化引用。
2. 实现一个 Skill + 多 Agent 候选的语义选择函数。
3. 增加指定 Agent 不适配时回退主 Agent。
4. 增加无 `@` 时主 Agent 分发多个 Agent 的任务输入。
5. 发出路由状态事件和 resolvedAgent 快照。
6. 添加路由矩阵单测。

## 已交付实现

- 在 `packages/shared/src/group-chat-contracts.ts` 增加 `GroupChatRoutingSnapshot`，并在 `SessionFollowUpMessage`、`IntentContextSnapshot`、`IntentRoutingDecisionV2` 中保留 Skill、Agent、附件和 resolved route 的稳定引用。
- `apps/server/src/modules/message-routing/tag-routing.ts` 提供确定性路由守卫：无显式路由回主 Agent、无 Skill 的多 Agent 候选进入分发、Skill 候选按 key/name/role/tags/capability 语义重合选择单一执行者，不匹配回主 Agent。
- `SessionsService`、`MessageIngressService`、Sessions API、Web Session store 和 `SessionWorkspace` 统一传递并持久化可读文本与结构化 directives；intent 路径额外发出 `agent_message` 路由状态事件。
- Context snapshot 同步保存 `skillRef`、`agentRefs`、`attachmentRefs`，历史展示使用名称快照，执行仍使用稳定 ID。
- 新增 `tag-routing.spec.ts` 六项矩阵/顺序不变量测试，以及 MessageIngress 结构化持久化测试。

## 完成定义

同一条消息无论先选 `/` 还是 `@`，都能生成同一结构化执行输入，并可解释地确定执行 Agent。

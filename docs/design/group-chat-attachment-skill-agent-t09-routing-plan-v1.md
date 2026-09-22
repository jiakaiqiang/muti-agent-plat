# GC-09 Tag 序列化与语义路由 Plan v1

> [Spec](../product/group-chat-attachment-skill-agent-t09-routing-spec-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t09-routing-task-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t09-routing-checklist-v1.md)

## 研究定位

- 意图识别：`apps/server/src/modules/intent-recognition/`。
- 编排：`apps/server/src/modules/orchestrator/`。
- Context v2：`apps/server/src/modules/context-v2/`。
- 共享消息合同：`packages/shared/src/contracts.ts`。

## 设计决策

- 显式 Tag 先于自然语言推断进入路由候选范围。
- Skill 的最终执行者是单值 `resolvedAgentId`；无 `@` 的协同分发另存为任务参与者列表。
- 回退由确定性路由守卫执行，不依赖模型自行遵守提示词。
- 聊天展示使用快照，执行使用稳定 ID 和当前可用能力。

## 实施步骤

1. 将消息草稿转换为持久化 envelope。
2. 实现显式候选与 Skill 能力匹配。
3. 实现最匹配 Agent、主 Agent 回退和无 `@` 多 Agent 分发。
4. 发出路由事件供 GC-10 使用。
5. 添加路由矩阵测试。

## 实际落点与验收结果

1. 共享结构位于 `packages/shared/src/group-chat-contracts.ts` 与 `packages/shared/src/contracts.ts`。
2. 路由函数位于 `apps/server/src/modules/message-routing/tag-routing.ts`；它对候选排序、语义重合、回退原因和分发集合均采用确定性规则。
3. 消息入口覆盖 `apps/server/src/modules/sessions/sessions.service.ts`、`message-ingress.service.ts`、`sessions.controller.ts`；Web 通过 `apps/web/src/stores/session.ts` 和 `SessionWorkspace.vue` 传入完整 directives。
4. Context v2 快照由 `ContextManagementService.buildIntentSnapshot` 保存结构化 Tag 引用；intent 路径创建带 `routing` 的路由状态事件。
5. 测试证据：路由矩阵 6/6，消息入口 7/7，SessionService 118/118；Server 全量 1673 通过、17 跳过；Web 全量 346/346；三端 typecheck 通过。

## 风险

- 语义匹配结果不可解释时必须保留路由原因和候选集合。
- Agent/Skill 后续停用不应破坏历史展示，但不能绕过当前权限。

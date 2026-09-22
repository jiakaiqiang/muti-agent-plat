# GC-10 协同任务面板与阶段输出 Plan v1

> [Spec](../product/group-chat-attachment-skill-agent-t10-collaboration-panel-spec-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t10-collaboration-panel-task-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t10-collaboration-panel-checklist-v1.md)

## 研究定位

- 时间线：`apps/web/src/components/ChatTimeline.vue`。
- 协作日志：`apps/web/src/components/CollaborationLogPanel.vue`。
- 运行时过程：`apps/web/src/components/WorkflowRuntimeView.vue`。
- 事件 store：`apps/web/src/stores/event.ts`。

## 设计决策

- 复用事件流，不在 UI 侧轮询 Agent。
- 面板状态由任务 ID + Agent ID 归并，支持乱序和重复事件。
- 中间输出按事件分页/折叠，避免一次加载所有长文本。
- 历史消息保存任务面板引用和最终快照。

## 实施步骤

1. 定义协同任务和 Agent 状态事件映射。
2. 在时间线中渲染统一面板。
3. 添加按 Agent 展开中间输出。
4. 处理完成/失败/取消状态。
5. 增加事件乱序和刷新恢复测试。

## 实际落点与验收结果

1. `collaborationTaskModel.ts` 是唯一的事件归并入口；面板组件只负责展示和展开状态，符合 props-down、computed 派生的 Vue 数据流。
2. 路由 `agent_message` 的 `routing/agentRefs/skillRef/attachmentRefs` 形成历史面板；后续 task/runtime/agent-status 事件按 Agent 更新。
3. 每个阶段输出保存事件 ID、正文和时间；重复 ID 不重复渲染，终态强度高于迟到的运行中事件。
4. `CollaborationTaskBoard` 默认可见并嵌入 `CollaborationTaskPanel`，因而当前消息与历史刷新都复用同一面板。
5. 证据：Web typecheck 通过；协同模型 3/3；Web 全量 67 文件、349 测试通过。

## 风险

- 重复事件不能重复追加阶段输出。
- 中间结果可能包含敏感正文，需要复用现有脱敏/权限边界。

# GC-10 协同任务面板与阶段输出 Task v1

> [Spec](../product/group-chat-attachment-skill-agent-t10-collaboration-panel-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t10-collaboration-panel-plan-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t10-collaboration-panel-checklist-v1.md)

## 任务目标

把 GC-09 的路由事件和现有事件流接入一个可持久化、可展开的协同任务面板。

## 10–15 分钟执行清单

1. 复用现有事件归一化逻辑，建立任务/Agent 状态映射。
2. 在 `ChatTimeline` 或 `CollaborationLogPanel` 增加面板卡片。
3. 渲染 Agent 列表、状态、进度和阶段性输出。
4. 增加完成、失败、取消和折叠/展开状态。
5. 添加刷新恢复和重复事件测试。

## 完成定义

用户可以从当前消息看到完整协同进度，任务完成后从历史消息再次展开面板。

## 已交付实现

- 新增 `apps/web/src/components/collaborationTaskModel.ts`，按事件 ID 去重、按时间排序，并以任务/Agent 维度归并路由、运行、完成、失败和取消状态。
- 新增 `apps/web/src/components/CollaborationTaskPanel.vue`，展示 Skill、附件数量、路由结果、每个 Agent 的状态/进度和可展开阶段输出。
- 将面板接入 `CollaborationTaskBoard`；任务板默认展开，历史事件刷新后可由同一纯函数重建。
- 状态强度防止迟到事件回退终态，阶段输出按事件 ID 幂等追加。
- 新增 3 个 Web 归并模型测试，覆盖面板生成、独立状态/失败终态、重复输出和逆序刷新恢复。

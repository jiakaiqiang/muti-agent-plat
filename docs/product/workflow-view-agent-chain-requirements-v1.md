---
artifact: intent_contract
stage: requirement
producedBy: requirements
schemaVersion: "0.1"
status: confirmed
deliveryId: workflow-view-agent-chain-v1
createdAt: 2026-08-11T18:00:00+08:00
requiresHumanIntervention: false
---

# Intent Contract: 工作流视图 Agent 链路与执行流转可视化

> 日期：2026-08-11
> 状态：需求已确认，三项关键决策已由用户拍定
> 需求类型：前端视图重构（工作流视图）
> 下游设计：[`../design/workflow-view-agent-chain-system-design-v1.md`](../design/workflow-view-agent-chain-system-design-v1.md)

## 目标 (Goal)

工作流视图的中间可视区域只呈现 Agent 工作流拓扑与执行流转状态；Agent 节点只承载身份（头像、名称、状态），执行细节移入点击后的详情面板，Agent 讨论内容独立成区置于可视区域下方。

## 背景 (Background)

用户在实际使用工作流视图时反馈两个问题，并提出一组新功能要求。用户原话：

> 工作流页面问题：右侧展示的出现乱码的问题没有展示具体的执行 agent。加的功能：中间可视区域应该只展示 agent 工作流的东西，工作流需要有流转的状态，流转的状态使用动态脉冲线的方式，agent 不展示具体的执行任务内容只展示名称，用灰色状态、橙色状态以及绿色状态分别区分可视区域执行过的、当前的、还没有执行的 agent，点击 agent 可以查看 agent 能力以及 agent 在当前任务中的具体输出内容，可视化区域下方则展示的是 agent 讨论阶段的内容。

经代码核查，"乱码"是两个独立根因，都不是字符编码问题：

### 根因 A：右侧面板显示裸 UUID

`apps/web/src/components/CollaborationLogPanel.vue:24-27` 只在会话参与者列表内查名字，查不到即回退为 agentId 原文：

```ts
return props.agents.find((agent) => agent.agentId === agentId)?.name ?? agentId
```

`props.agents` 来自 `eventStore.agentCards(sessionId, session.participatingAgentIds)`（`SessionWorkspace.vue:335`）。参与者由服务端 `AgentsService.resolveIds()` 按 chat surface 解析（`agents.service.ts:88-93`），而接收者是系统 Agent，`allowedSurfaces: ['management']`（`system-agents.ts:16-23`），永远不进入参与者名单。于是接收者发出的事件在面板标题栏显示为 `00000000-0000-0000-0000-000000000001`。

三个相关缺陷：

1. 前端本已能查到名字。`agentStore` 通过 `mergeWithDefaultAgents` 兜底带上了接收者（`stores/agent.ts:52-63`），`agent-surface-catalog.spec.ts:27` 已断言 `agentName(coordinator.id) === '接收者'`。面板既没用 store，也没用现成的 `resolveActor()`（`composables/useActor.ts:20-34`）。
2. 面板过滤用 `event.fromAgentId`，该字段在合同中标记 `@deprecated`（`contracts.ts:1299-1300`），其他视图已迁移到 `actor`。
3. 面板只取最后 8 条（`slice(-8)`）且不折叠心跳。运行时心跳每 30 秒一条（`RUNTIME_HEARTBEAT_INTERVAL_MS`，`orchestrator.service.ts:239`、`:6800`），一次 5 分钟的模型调用即产生 10 条，把真实执行事件挤出窗口。这是"看不到具体执行 Agent"的直接体感原因。

### 根因 B：中间画布出现竖排文字块

画布节点渲染未截断的事件原文。`WorkflowRuntimeView.vue:549-553`：

```
<li>{{ node.latestTask?.title ?? node.agent.currentTaskTitle ?? node.agent.actionSummary ?? '等待任务分配' }}</li>
<li>任务 {{ node.completedTasks }}/{{ node.assignedTasks.length }}</li>
<li>{{ node.agent.recentLogs[0] ?? node.agent.role }}</li>
```

`recentLogs` 与 `actionSummary` 保存完整事件正文（`stores/event.ts:416`、`:419`）。讨论阶段 `actionSummary: output.content` 即整段 Agent 发言（`orchestrator.service.ts:3279`），结构化输出失败时是整段 schema 报错。CSS 为节点定义 `width: 190px` 但无任何 `max-height` / `overflow` / `line-clamp`（`styles.css:6601-6612`）。190px 宽配数千字正文 = 数千像素高的文字柱；节点为 `position: absolute` 圆周布局，多柱互相穿透。

### 附带发现

1. 左侧 Agent 列表显示阶段名而非 Agent 名：`WorkflowRuntimeView.vue:507` 写的是 `stages[index]?.title ?? agent.name`，导致前三个 Agent 被贴上"需求摄入/任务契约/分发接受"。
2. 讨论内容当前被阶段过滤器吃掉：`intake` 阶段要求 `phase ∈ {requirement_intake, workspace_analysis, discussion}`（`WorkflowRuntimeView.vue:82`），但多 Agent 讨论发出的 `agent_message` 只带 `round`，不带 `phase`（`orchestrator.service.ts:3283-3296`），故 `stageEvents` 对讨论消息一律返回 false。
3. 顶栏 `运行时长 00:18:42` 与 `运行中` 为硬编码假值（`WorkflowRuntimeView.vue:493-494`）。
4. 残留英文文案：`Awaiting final delivery`、`No delivery artifact has been created yet.`、`Agent 节点`。`chinese-visible-copy-smoke.mjs:7-20` 的文件清单未含 `WorkflowRuntimeView.vue`，故漏检。
5. 右侧面板底部输入框与"全部"按钮无任何 handler。

## 非目标 (Non-goals / Out of Scope)

- 不修改 API / Event / Runtime / Data 契约（`packages/shared/src/contracts.ts` 零改动）。
- 不修改群聊视图任何渲染行为（`ChatTimeline.vue`、`AgentStatusPanel.vue`）。
- 不修改 `apps/web/src/stores/event.ts` 的 `agentCards()` 签名或返回结构。
- 不修改服务端 Agent surface 归属；接收者仍只属 management surface。
- 不做群聊心跳折叠。群聊时间线现有 `collapseDuplicateFailureMessages` 只折叠失败卡、不折叠心跳，这是改动前既存现象，属独立议题。
- 不实现右侧面板底部输入框与"全部"按钮的交互功能。
- 不修改工作流编辑器（`components/workflow/` 下的 `WorkflowCanvas.vue` 等），本次只改运行时视图 `WorkflowRuntimeView.vue`。

## 约束 (Constraints)

- `agent-tone-*` 类的定义与语义不可变更。该组类被 `AgentPortrait.vue:22`、`CollaborationLogPanel.vue:53` 与群聊 `ChatTimeline` 的 `agentTone()` 三方共用，语义是"第 N 个 Agent 的身份配色"（蓝/绿/紫/橙/青轮换），与执行状态无关。三态色必须使用新类名。
- 三态色必须取自 `docs/design/ui-style-guide-v1.md` 既有色板，不得新增近似色。
- 必须遵守 `prefers-reduced-motion: reduce`，该场景下禁用脉冲动画（风格规范第 81-82 行）。
- 改动限于 `apps/web/`，`apps/server/**` 与 `packages/shared/**` 零改动。
- 可 `git revert` 单批回滚。

## 验收标准 (Acceptance Criteria)

- [ ] AC1 `CollaborationLogPanel` 渲染系统 Agent（接收者）发出的事件时，标题栏显示 `接收者`；组件渲染输出中不含 UUID 字面量。
- [ ] AC2 连续运行时心跳事件在 `CollaborationLogPanel` 中折叠为一条，并携带累计等待秒数。
- [ ] AC3 画布 Agent 节点的渲染文本不含 `recentLogs[0]`、`actionSummary`、`currentTaskTitle` 或任务标题内容。
- [ ] AC4 画布不再渲染中心"协同中"圆盘、`workflow-output` 交付卡、`arrow-1..5` 装饰箭头、`workflow-signal-strip`。
- [ ] AC5 每个画布 Agent 节点带且仅带 `is-done` / `is-active` / `is-pending` 之一；灰=未执行、橙=当前、绿=已执行。
- [ ] AC6 脉冲动画只出现在「上游 done → 下游 active」的边上；`kind: 'fallback'` 的边不得带脉冲。
- [ ] AC7 `prefers-reduced-motion: reduce` 媒体查询下，脉冲相关 `animation` 被置为 `none`。
- [ ] AC8 点击画布 Agent 节点打开详情面板，含该 Agent 的能力清单与其在本次会话中的输出内容。
- [ ] AC9 可视区域下方渲染 Agent 讨论内容，按 `round` 分组；判定不依赖 `payload.phase`（该字段在讨论消息中缺失）。
- [ ] AC10 `WorkflowRuntimeView.vue` 纳入 `tests/e2e/chinese-visible-copy-smoke.mjs` 检查清单并通过。
- [ ] AC11 群聊渲染基线快照在全部批次完成后零 diff。
- [ ] AC12 左侧 Agent 列表显示 Agent 名称，不显示 `stages[index].title` 阶段名。
- [ ] AC13 顶栏不含硬编码的 `00:18:42` 运行时长与无条件 `运行中` 状态。
- [ ] AC14 `npm run typecheck`、`npm run test -w @project/web`、`npm run test:e2e:chinese-copy`、`npm run test:harness` 全部通过。

## 风险 (Risks)

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 三态色误用 `agent-tone-*` | 群聊头像颜色随执行状态变化 | 三态色使用独立类名，收在 `.mode-workflow` 作用域；门禁断言设计文档保留该约束 |
| 为让接收者进入链首而改 `agentCards()` | 群聊右侧凭空多出接收者卡片 | `workflowChainModel` 自行从事件按 `actor.id` 收集 Agent，不碰 `agentCards()` |
| 节点只是"不渲染"长文本，未来有人再塞字段 | 竖排文字柱回归 | CSS 同时加 `max-height` + `line-clamp` 作为第二道防线 |
| `fallback` 边被当作真实流转 | pending 节点看起来有流转 | 脉冲判定显式排除 `kind: 'fallback'` |
| 群聊基线快照在改动后才补 | 基线已被污染，失去回归意义 | T0 排在所有视图改动之前，且 `forbiddenPaths` 含全部 `.vue` 与 `styles.css` |
| 删除装饰元素不可逆 | 若用户期望保留交付卡 | 已与用户确认工作流视图与协作图视图分化；如需保留则移至画布外与讨论区并列 |

## 需要用户确认的问题 (Open Questions)

三项均已确认，无未决问题：

| 问题 | 决策 |
| --- | --- |
| 三态色对应关系 | **灰=未执行，橙=当前，绿=已执行** |
| 接收者是否出现在画布 Agent 链上 | **作为链首节点显示，样式区分** |
| 画布现有拖拽功能如何处理 | **删掉连线拖拽，保留节点拖拽** |

## 完成标准 (Definition of Done)

- 七个小节齐全。
- 14 条验收标准均可客观验证。
- 三项待确认问题已由用户拍定，`requiresHumanIntervention = false`。
- `status = confirmed`，允许进入 Design 阶段。

## 交接 (Handoff)

- 下游消费者：Architect Agent（Design 阶段）→ [`../design/workflow-view-agent-chain-system-design-v1.md`](../design/workflow-view-agent-chain-system-design-v1.md)
- 关联规程：[`../harness-engineering/architecture-constraints/04-stage-workflow.md`](../harness-engineering/architecture-constraints/04-stage-workflow.md)、[`../harness-engineering/feedback-loop/07-feedback-loop.md`](../harness-engineering/feedback-loop/07-feedback-loop.md)

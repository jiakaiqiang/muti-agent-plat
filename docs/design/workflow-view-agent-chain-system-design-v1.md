---
artifact: design_plan
stage: design
producedBy: architect
schemaVersion: "0.1"
status: ready
deliveryId: workflow-view-agent-chain-v1
createdAt: 2026-08-11T18:00:00+08:00
intentContractRef: workflow-view-agent-chain-requirements-v1
---

# Design Plan: 工作流视图 Agent 链路与执行流转状态

> 上游需求：[`../product/workflow-view-agent-chain-requirements-v1.md`](../product/workflow-view-agent-chain-requirements-v1.md)
> 下游实施：[`../implementation/workflow-view-agent-chain-development-v1.md`](../implementation/workflow-view-agent-chain-development-v1.md)
> 风格约束：[`./ui-style-guide-v1.md`](./ui-style-guide-v1.md)

## 方案概述 (Overview)

把当前 `WorkflowRuntimeView.vue` 中「数据推导 + 布局 + 渲染」耦合在一起的实现，拆成三层：

1. **纯函数模型层** `workflowChainModel.ts`：输入 `events / tasks / agents`，输出有序 Agent 链、每节点三态、脉冲边集合、按 `round` 分组的讨论内容。不依赖 Vue、不依赖 Pinia store。
2. **视图层** `WorkflowRuntimeView.vue`：只做布局与渲染，消费模型层输出。画布内只保留 Agent 节点与真实流转边。
3. **详情层** `WorkflowAgentInspector.vue`：承接从画布节点移出的执行细节（能力、输出、任务、产物）。

右侧 `CollaborationLogPanel.vue` 的 UUID 与心跳问题独立修复，不依赖上述三层。

这样拆分的核心理由：三态推导是可客观验证的逻辑，抽成纯函数后可以先写测试再实现，且不受 Vue 渲染时序影响。当前实现把推导写在 `computed` 里，无法单独测试。

## 架构与模块边界 (Architecture & Module Boundaries)

### 涉及模块

| 模块 | 变更类型 | 说明 |
| --- | --- | --- |
| `apps/web/src/components/workflowChainModel.ts` | 新增 | 纯函数三态推导 |
| `apps/web/src/components/WorkflowRuntimeView.vue` | 修改 | 画布瘦身、接入模型层 |
| `apps/web/src/components/WorkflowAgentInspector.vue` | 新增 | Agent 详情面板 |
| `apps/web/src/components/CollaborationLogPanel.vue` | 修改 | 名称解析、心跳折叠 |
| `apps/web/src/styles.css` | 修改 | 三态 token、脉冲动画、节点截断 |
| `apps/web/src/composables/useActor.ts` | 复用 | 不修改，直接调用 `resolveActor()` |

### Architecture Constraints

- **module_boundaries**：改动限于 `apps/web/src/components/` 与 `apps/web/src/styles.css`。不触及 `apps/server/**`、`packages/shared/**`、`apps/web/src/stores/**`。
- **ownership_boundaries**：`workflowChainModel.ts` 独占三态与脉冲边推导；`WorkflowRuntimeView.vue` 不得内联任何状态推导逻辑；`WorkflowAgentInspector.vue` 只做展示，不推导状态。
- **dependency_direction**：`WorkflowRuntimeView.vue` → `workflowChainModel.ts` → `@/types/contracts`。模型层禁止反向依赖 Vue 组件、Pinia store 或 `composables/`。
- **contract_stability**：`packages/shared/src/contracts.ts` 与 `apps/web/src/types/contracts.ts` 零改动。API / Event / Runtime / Data 契约不变。
- **allowed_change_scope**：见下方 Task Plan 各任务 `allowedPaths` 的合集。
- **forbidden_change_scope**：
  - `apps/server/**`
  - `packages/shared/**`
  - `apps/web/src/stores/event.ts`
  - `apps/web/src/stores/agent.ts`
  - `apps/web/src/components/ChatTimeline.vue`
  - `apps/web/src/components/AgentStatusPanel.vue`
  - `apps/web/src/composables/useActor.ts`
- **invariants**：
  - `agent-tone-*` CSS 类的定义与语义不变（`AgentPortrait.vue`、`CollaborationLogPanel.vue`、`ChatTimeline.vue` 三方共用的身份配色）。
  - `useEventStore().agentCards()` 的签名与返回结构不变。
  - 群聊模式（`currentMode === 'chat'`）下 `CollaborationLogPanel` 仍不挂载，`AgentStatusPanel` 仍挂载。
  - 三态色值必须取自 `ui-style-guide-v1.md` 既有色板，不新增近似色。

## 影响范围 (Impact Scope)

### 代码路径

```
apps/web/src/components/workflowChainModel.ts          新增
apps/web/src/components/workflowChainModel.spec.ts     新增
apps/web/src/components/WorkflowAgentInspector.vue     新增
apps/web/src/components/WorkflowRuntimeView.vue        修改
apps/web/src/components/CollaborationLogPanel.vue      修改
apps/web/src/components/CollaborationLogPanel.spec.ts  新增
apps/web/src/components/ChatSurfaceBaseline.spec.ts    新增（群聊回归基线）
apps/web/src/styles.css                                修改
tests/e2e/chinese-visible-copy-smoke.mjs               修改（纳入 WorkflowRuntimeView.vue）
docs/ai-agent-context/project-map.md                   修改（文档与前端地图索引）
```

### 运行时与数据

- 服务端零影响。不新增、不修改任何 API 调用。
- 不新增网络请求。所有数据来自已有的 `events` / `tasks` / `agents` props 与 `agentStore`。
- 不写入 localStorage 或任何持久化。

### 前端视图

- **工作流视图**：中间画布、左侧 Agent 列表、右侧日志面板均有可见变化。
- **协作图视图**：右侧日志面板共用 `CollaborationLogPanel`，会继承名称解析与心跳折叠的修复。这是预期的正向影响。
- **群聊视图**：零变化。`CollaborationLogPanel` 在群聊下不挂载，`ChatTimeline` / `AgentStatusPanel` 不在改动清单内。
- **调试视图**：右侧共用 `CollaborationLogPanel`，同协作图。

## 契约影响 (Contract Impact)

**无。**

API / Data / Event / Runtime / UI-State 五类契约均无变化。本次改动只重新组织已有 `CollaborationEvent` / `TaskViewState` / `AgentCardState` 的前端呈现方式，不新增字段、不改变字段语义、不改变事件类型。

## 数据与状态流 (Data & State Flow)

### 三态推导

模型层从 `events` 按 `actor.id` 收集实际出现过的 Agent，与 `agentStore` 查名，形成 Agent 链。链首固定为接收者（系统 Agent，`kind: 'system'`）。

判定优先级（自上而下，首个命中即返回）：

| 状态 | 判定条件 |
| --- | --- |
| `done` | 该 Agent 有 `task_completed` / `runtime_completed` / `post_review_completed` 事件，且无更晚的活跃态事件 |
| `active` | `AgentCardState.status ∈ {running, thinking, discussing, reviewing, reworking}`，或持有未完成 `currentTaskId` |
| `pending` | 会话内不存在该 Agent 为 `actor` 的任何事件 |

缺省落 `pending`。`failed` 归入 `active`（仍需用户关注），不单独设色——需求非目标已明确本次只做三态。

### 脉冲边

复用现有 `workflowAgentEdges` 的推导来源（`agent_message` 的 `toAgentIds` + `mentionedAgentIds`、task 依赖链），但脉冲判定收紧：

```
脉冲 = 上游节点 done  AND  下游节点 active  AND  edge.kind !== 'fallback'
```

**关于 fallback 边**：现有实现（`WorkflowRuntimeView.vue:242-250`）会为每个未连通节点强行补一条从链首 Agent 出发的边，避免孤立节点在画布上完全无连接。这些是布局兜底，不代表真实流转。三态接入后若不排除，pending 节点会因为一条假边而显示脉冲，误导用户以为有数据在流动。因此 fallback 边保留（否则画布散乱），但显式排除在脉冲判定之外，且用虚线弱化。

### 讨论内容分组

按 `round` 分组，判定条件：

```
type === 'agent_message' AND (payload.round 存在 OR phase ∈ {discussion, follow_up_discussion})
```

**为什么不能只用 `phase`**：`orchestrator.service.ts:3283-3296` 发出讨论 `agent_message` 时只带 `round`、`messageKind`、`mentionedAgentIds`，**不带 `phase`**。而现有 `WorkflowRuntimeView.vue:82` 的 `intake` 阶段过滤器要求 `phase ∈ {requirement_intake, workspace_analysis, discussion}`，导致 `stageEvents()` 对讨论消息一律返回 `false`——讨论内容目前在阶段事件区完全不可见。新实现必须以 `round` 为主判据。

### 心跳折叠

`orchestrator.service.ts:6800` 每 30 秒发一条 `runtime_progress`，`metadata.payload.code === 'RUNTIME_HEARTBEAT'`，携带 `elapsedMs`。折叠规则：同一 `runtimeInvocationId` 的连续心跳合并为一条，显示最大 `elapsedMs`。

折叠是必需的而非优化：右侧面板窗口为 8 条，一个 5 分钟的模型调用会产生 10 条心跳，把全部真实执行事件挤出窗口。这正是「看不到具体执行 Agent」的直接成因。

### Agent 名称解析

改用 `resolveActor()`（`composables/useActor.ts:20`），它内部走 `agentStore.agentName()`。`agentStore` 通过 `mergeWithDefaultAgents()`（`stores/agent.ts:52-63`）兜底注入了系统 Agent，因此能解析出「接收者」——`agent-surface-catalog.spec.ts:27` 已断言此行为。

当前 `CollaborationLogPanel.vue:24-27` 只在 `props.agents`（会话参与者卡片）中查找，而接收者 `allowedSurfaces: ['management']`（`system-agents.ts:16-23`）永远不在参与者名单，故回退成 UUID 原文。

## 设计决策与取舍 (Decisions & Trade-offs)

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 三态推导位置 | 独立纯函数模块 | 可先写测试再实现；不受渲染时序影响 |
| 接收者数据来源 | 模型层自行从事件收集 | 避免改 `agentCards()` 污染群聊右侧 |
| 三态 CSS 类名 | 新增 `.workflow-chain-node.is-*` | 不复用 `agent-tone-*`，避免群聊头像随执行状态变色 |
| 节点内容超长 | 不渲染 + CSS 截断双保险 | 根因是数据无界；只靠「不渲染」防不住后续新增字段 |
| fallback 边 | 保留但排除脉冲 | 删除会让孤立节点散乱；保留会误导流转 |
| 连线拖拽 | 删除 | 用户已确认；边由真实事件推导，手工拖动无语义 |
| 节点拖拽 | 保留 | 用户已确认；节点位置是布局偏好，有意义 |

## 备选方案 (Alternatives)

### 备选一：扩展 `agentCards()` 纳入系统 Agent（已否决）

做法：在 `stores/event.ts` 的 `agentCards` getter 里把 `SYSTEM_AGENT_IDS` 一并建卡。

优点：工作流链首直接拿到接收者卡片，模型层不必自己收集 Agent，少写十几行。

**否决理由**：`agentCards()` 同时供群聊右侧 `AgentStatusPanel` 消费（`SessionWorkspace.vue:335` 是唯一调用点，两个视图共享）。加入系统 Agent 后群聊右侧会凭空多出一张「接收者」卡片，违反需求非目标「不改群聊视图任何渲染行为」。为省十几行代码而污染共享数据源，不划算。

### 备选二：三态色复用 `agent-tone-*`（已否决）

做法：把 `agent-tone-1/3/4` 重新定义为灰/橙/绿，节点直接套用。

否决理由：`agent-tone-*` 语义是「第 N 个 Agent 的身份配色」，被 `AgentPortrait.vue:22`、`CollaborationLogPanel.vue:53`、`ChatTimeline.vue` 的 `agentTone()` 三方共用。改其定义会让群聊头像颜色随 Agent 执行状态变化。

### 备选三：整个画布用 VueFlow 重写（已否决）

做法：像 `workflow/WorkflowCanvas.vue` 那样用 `@vue-flow/core` 重画。

否决理由：依赖已在（`package.json` 有 `@vue-flow/core@^1.48.2`），技术上可行，但会把改动从「视图重组」升级为「重写」，影响范围和回归风险远超需求。VueFlow 的自动布局也不适合本需求的「链式 + 圆周」混合布局。留作后续独立议题。

## 风险与缓解 (Risks & Mitigations)

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 改动波及群聊 | 高 | T0 先落群聊基线快照；`styles.css` 三态类全部收在 `.mode-workflow` 作用域；`forbidden_change_scope` 明确列出群聊文件 |
| `agent-tone-*` 被误改 | 中 | 门禁 spec 断言设计文档保留该约束；基线快照覆盖群聊头像 |
| 脉冲动画性能 | 低 | 只给符合条件的边加动画，非全量；`prefers-reduced-motion` 降级为静态 |
| 节点再次被塞入长文本 | 中 | CSS `max-height` + `line-clamp` 兜底；验收标准 3 断言 DOM 文本长度上限 |
| 三态与既有图例语义冲突 | 低 | 沿用「状态说明」区块现有四态文案，三态映射为子集，不改图例 |

## 对验收标准的覆盖 (Acceptance Mapping)

| 验收标准 | 由哪部分设计满足 | 任务 |
| --- | --- | --- |
| AC1 系统 Agent 显示「接收者」 | `resolveActor()` 替换本地查找 | T1 |
| AC2 无裸 UUID | 同上，回退文案改「系统 Agent」 | T1 |
| AC3 心跳折叠 | 按 `runtimeInvocationId` 合并，取最大 `elapsedMs` | T1 |
| AC4 节点无执行细节 | 删除节点 `<ul>`；CSS 截断兜底 | T3 |
| AC5 画布无装饰元素 | 删除 hub / output / arrow / signal-strip | T3 |
| AC6 三态互斥 | 模型层返回单一 `state` 字段 | T2 + T3 |
| AC7 脉冲仅 done→active | 脉冲判定排除 fallback 与非活跃下游 | T2 + T3 |
| AC8 reduced-motion 降级 | `@media (prefers-reduced-motion: reduce)` 关闭 animation | T3 |
| AC9 详情面板 | `WorkflowAgentInspector.vue` | T4 |
| AC10 讨论按 round 分组 | 模型层 `discussionRounds()` | T2 + T4 |
| AC11 中文文案门禁 | `chinese-visible-copy-smoke.mjs` 纳入本视图 | T4 |
| AC12 群聊零 diff | T0 基线快照，每批次复跑 | T0 |

---

# Task Plan（Planning 阶段产物）

> 本节承担 `task_plan` 产物职责。独立文档不再另开——Planning 阶段的实质产出是下方 `allowedPaths` / `forbiddenPaths` / `toolPolicy` 三组机器可检查的硬边界。

## 任务拆解 (Task Breakdown)

### T0 群聊回归基线
- 负责 Agent (assignee): test
- 依赖 (dependsOn): []
- 允许修改的文件范围 (allowedPaths):
  - `apps/web/src/components/ChatSurfaceBaseline.spec.ts`
- 禁止修改的文件范围 (forbiddenPaths):
  - `apps/web/src/components/**/*.vue`
  - `apps/web/src/styles.css`
  - `apps/web/src/stores/**`
- 工具权限 (toolPolicy):
  - `tool.file_write`: required
  - `tool.command_run`: required
- 验收标准 (acceptanceCriteria):
  - [ ] 群聊模式下 `CollaborationLogPanel` 不挂载、`AgentStatusPanel` 挂载，有断言覆盖
  - [ ] `agent-tone-*` 在群聊头像上的取值有断言覆盖
  - [ ] `agentCards()` 返回结构有断言覆盖
  - [ ] 基线在改动前通过
- 备注: 必须先于任何视图改动落地，否则基线本身被污染

### T1 右侧面板名称与心跳
- 负责 Agent (assignee): frontend
- 依赖 (dependsOn): [T0]
- 允许修改的文件范围 (allowedPaths):
  - `apps/web/src/components/CollaborationLogPanel.vue`
  - `apps/web/src/components/CollaborationLogPanel.spec.ts`
- 禁止修改的文件范围 (forbiddenPaths):
  - `apps/web/src/components/WorkflowRuntimeView.vue`
  - `apps/web/src/styles.css`
  - `apps/web/src/stores/**`
  - `apps/web/src/composables/useActor.ts`
- 工具权限 (toolPolicy):
  - `tool.file_write`: required
  - `tool.command_run`: on-demand
- 验收标准 (acceptanceCriteria):
  - [ ] AC1 / AC2 / AC3 通过
  - [ ] 过滤条件从 `fromAgentId` 迁移到 `actor`
  - [ ] T0 基线仍通过

### T2 纯函数链路模型
- 负责 Agent (assignee): frontend
- 依赖 (dependsOn): [T0]
- 允许修改的文件范围 (allowedPaths):
  - `apps/web/src/components/workflowChainModel.ts`
  - `apps/web/src/components/workflowChainModel.spec.ts`
- 禁止修改的文件范围 (forbiddenPaths):
  - `apps/web/src/components/**/*.vue`
  - `apps/web/src/styles.css`
  - `apps/web/src/stores/**`
- 工具权限 (toolPolicy):
  - `tool.file_write`: required
  - `tool.command_run`: on-demand
- 验收标准 (acceptanceCriteria):
  - [ ] 测试先行：先提交失败测试，再实现
  - [ ] 接收者为链首且 `kind === 'system'`
  - [ ] 三态推导覆盖 done / active / pending
  - [ ] 脉冲边排除 fallback
  - [ ] 讨论分组在 `phase` 缺失、仅有 `round` 时仍工作
  - [ ] 模型层无 Vue / Pinia 依赖

### T3 画布改造
- 负责 Agent (assignee): frontend
- 依赖 (dependsOn): [T2]
- 允许修改的文件范围 (allowedPaths):
  - `apps/web/src/components/WorkflowRuntimeView.vue`
  - `apps/web/src/styles.css`
- 禁止修改的文件范围 (forbiddenPaths):
  - `apps/web/src/components/ChatTimeline.vue`
  - `apps/web/src/components/AgentStatusPanel.vue`
  - `apps/web/src/stores/**`
  - `packages/shared/**`
- 工具权限 (toolPolicy):
  - `tool.file_write`: required
  - `tool.command_run`: on-demand
- 验收标准 (acceptanceCriteria):
  - [ ] AC4 / AC5 / AC6 / AC7 / AC8 通过
  - [ ] 左侧列表显示 Agent 名而非阶段名
  - [ ] 连线拖拽逻辑删除，节点拖拽保留
  - [ ] 硬编码的运行时长与运行状态替换为真实值或移除
  - [ ] 三态 CSS 类收在 `.mode-workflow` 作用域内
  - [ ] T0 基线仍通过

### T4 详情面板与讨论区
- 负责 Agent (assignee): frontend
- 依赖 (dependsOn): [T3]
- 允许修改的文件范围 (allowedPaths):
  - `apps/web/src/components/WorkflowAgentInspector.vue`
  - `apps/web/src/components/WorkflowRuntimeView.vue`
  - `apps/web/src/styles.css`
  - `tests/e2e/chinese-visible-copy-smoke.mjs`
  - `docs/ai-agent-context/project-map.md`
- 禁止修改的文件范围 (forbiddenPaths):
  - `apps/web/src/components/ChatTimeline.vue`
  - `apps/web/src/components/AgentStatusPanel.vue`
  - `apps/web/src/stores/**`
- 工具权限 (toolPolicy):
  - `tool.file_write`: required
  - `tool.command_run`: on-demand
- 验收标准 (acceptanceCriteria):
  - [ ] AC9 / AC10 / AC11 通过
  - [ ] 能力清单复用「优先 activeCapabilityNames，回退配置」逻辑
  - [ ] `project-map.md` 同步三份文档与新增组件索引
  - [ ] T0 基线仍通过

## 依赖关系 (Dependency Graph)

```
T0 ──┬── T1
     └── T2 ── T3 ── T4
```

T1 与 T2 可并行（互不重叠文件）。T3 依赖 T2 的模型层。T4 依赖 T3 的画布结构。

## 范围与权限总览 (Scope & Policy Summary)

### 允许触及的文件合集

```
apps/web/src/components/ChatSurfaceBaseline.spec.ts
apps/web/src/components/CollaborationLogPanel.vue
apps/web/src/components/CollaborationLogPanel.spec.ts
apps/web/src/components/workflowChainModel.ts
apps/web/src/components/workflowChainModel.spec.ts
apps/web/src/components/WorkflowRuntimeView.vue
apps/web/src/components/WorkflowAgentInspector.vue
apps/web/src/styles.css
tests/e2e/chinese-visible-copy-smoke.mjs
docs/ai-agent-context/project-map.md
```

### 禁止触及的文件合集

```
apps/server/**
packages/shared/**
apps/web/src/stores/**
apps/web/src/types/contracts.ts
apps/web/src/composables/useActor.ts
apps/web/src/components/ChatTimeline.vue
apps/web/src/components/AgentStatusPanel.vue
```

### 高风险能力清单

- `tool.file_write`：全部任务需要。均限于上方允许清单内，无服务端写权限。
- `tool.command_run`：T0 required（跑基线），其余 on-demand（`typecheck` / `test`）。无破坏性命令，无部署，无数据库操作。

## 风险与排序 (Risks & Sequencing)

- **关键路径**：T0 → T2 → T3 → T4。T2 是画布改造的前置，测试先行。
- **并行项**：T1 与 T2 无文件重叠，可同时进行。
- **阻塞风险**：T0 必须最先完成。若在视图改动后才补基线，基线记录的是已变更行为，失去回归意义。
- **每批次退出条件**：T0 基线复跑通过 + `npm run typecheck` 通过。

## 验证命令 (Verification Commands)

```
npm run typecheck
npm run test -w @project/web
npm run test:e2e:chinese-copy
npm run test:harness
```

`test:harness` 包含 `v2-only-documentation.spec.mjs`，它读取 `docs/ai-agent-context/project-map.md` 断言文档索引完整性。新增三份文档后必须同步该地图，否则门禁失败。

# 第一节点开发文档：Coordinator 需求接收与任务分配合同 v1

## 1. 开发目标

本开发文档承接 [第一节点需求文档](../product/coordinator-controlled-routing-node1-requirements-v1.md)，定义如何把“Coordinator 需求接收与任务分配合同”落到当前代码结构。

第一节点只负责生成任务计划和分配合同，不执行子任务。

## 2. 当前基础

当前项目已有可复用基础：

- `apps/server/src/modules/orchestrator/`：组织 brief、任务创建、任务执行和复盘。
- `apps/server/src/modules/tasks/`：管理 `AgentTask`。
- `apps/server/src/modules/events/`：写入协作事件。
- `packages/shared/src/contracts.ts`：定义任务、事件、Runtime 输出等共享合同。
- `apps/web/src/components/ChatTimeline.vue`：展示聊天和任务事件。
- `apps/web/src/components/CollaborationTaskBoard.vue`：展示任务状态。
- `apps/web/src/components/WorkflowRuntimeView.vue`：展示工作流和交接。

## 3. 建议影响范围

### 后端

- `apps/server/src/modules/orchestrator/orchestrator.service.ts`
- `apps/server/src/modules/tasks/tasks.service.ts`
- `apps/server/src/modules/runtimes/mock-runtime.service.ts`

### 共享合同

- `packages/shared/src/contracts.ts`
- `docs/contracts/event-contract-v0.1.md`
- `docs/contracts/data-contract-v0.1.md`
- `docs/contracts/ui-state-contract-v0.1.md`

### 前端

- `apps/web/src/components/ChatTimeline.vue`
- `apps/web/src/components/CollaborationTaskBoard.vue`
- `apps/web/src/components/WorkflowRuntimeView.vue`
- `apps/web/src/components/CollaborationGraphView.vue`
- `apps/web/src/stores/event.ts`

### 测试

- `tests/e2e/task-dependency-smoke.mjs`
- `tests/e2e/multi-agent-discussion-smoke.mjs`
- 新增 `tests/e2e/coordinator-controlled-routing-smoke.mjs`

## 4. 合同设计

### 4.1 路由模式

新增或预留：

```ts
export type TaskRoutingMode =
  | 'coordinator_controlled'
  | 'agent_suggested'
  | 'agent_delegated';
```

第一节点固定使用：

```text
coordinator_controlled
```

### 4.2 任务字段

建议在 `AgentTask` 逐步增加：

```ts
assignedByAgentId?: UUID;
routingMode?: TaskRoutingMode;
autoResolutionAttempted?: boolean;
handoffSuggestedByAgentId?: UUID;
handoffReason?: string;
handoffHistory?: TaskHandoffRecord[];
delegationDepth?: number;
maxDelegationDepth?: number;
requiresCoordinatorApproval?: boolean;
```

第一阶段可以先只落地必要字段：

- `assignedByAgentId`
- `routingMode`
- `autoResolutionAttempted`

其他字段作为后续自动流转预留。

### 4.3 接受决策输出

目标合同：

```ts
export type TaskAcceptanceDecisionOutput = {
  kind: 'task_acceptance_decision';
  status: 'accepted' | 'blocked' | 'rejected';
  reason: string;
  missingContext?: string[];
  handoffSuggestion?: HandoffSuggestion;
};
```

兼容策略：

- 短期保留 `TaskClaimDecisionOutput`。
- `accepted=true` 映射为 `status=accepted`。
- `accepted=false` 映射为 `status=rejected` 或 `status=blocked`。
- UI 和文档不再使用“认领”。

## 5. 后端实现步骤

### Step 1: 任务创建时写入 Coordinator 分配语义

在 Orchestrator 创建任务时：

- 设置 `assignedByAgentId=coordinator.id`。
- 设置 `routingMode=coordinator_controlled`。
- 保持 `assigneeAgentId` 来自任务建议或 Coordinator 分配结果。

事件策略：

- 若新增事件：写入 `task_assigned`。
- 若兼容旧合同：在 `task_created.metadata.payload` 中增加 `assignedByAgentId`、`routingMode`。

### Step 2: 将任务认领决策收敛为任务接受决策

当前 `task_claim_decision` 阶段可先保留，但内部命名和文案调整为：

- `task_acceptance`
- `task_acceptance_decision`
- `task_acceptance_declined`

短期可以继续兼容现有 `task_claim_decision` output。

### Step 3: 禁止子 Agent 自动转派

实现规则：

- 子 Agent 返回的 alternative 或 handoff 只作为建议。
- 只有 Coordinator 可以更新 `assigneeAgentId`。
- 只有 Coordinator 可以写入转派或重新分配事件。

### Step 4: 增加一次自动恢复

当子 Agent 返回 blocked/rejected：

```text
if task.autoResolutionAttempted !== true:
  Coordinator 尝试补上下文、改派或改写任务包
  task.autoResolutionAttempted = true
else:
  session.status = WAIT_USER_DECISION
```

自动恢复必须写事件，方便 UI 展示。

### Step 5: 保留 handoffSuggestion

`handoffSuggestion` 不直接改变任务，只进入 Coordinator 决策输入。

后续切换到 `agent_suggested` 时，可复用同一 payload。

## 6. 前端实现步骤

### Step 1: 文案调整

- `claimed` 显示为“已接受”。
- “认领”替换为“接受任务”。
- “转派”区分为“建议交接”和“Coordinator 已改派”。

### Step 2: 任务卡片展示

任务卡片增加：

- 分配者：Coordinator。
- 负责 Agent。
- 路由模式。
- 自动恢复次数或是否已自动处理。

### Step 3: 协作图展示

协作图中：

- Coordinator -> Agent：任务分配。
- Agent -> Coordinator：接受、阻塞、拒绝、建议交接。
- Coordinator -> Agent：重新分配。

不展示 Agent -> Agent 的直接转派边，除非只是完成后的依赖交接提示。

## 7. 测试计划

### 单元或服务测试

- 创建任务时写入 `assignedByAgentId` 和 `routingMode`。
- 子 Agent 返回拒绝时不会直接修改 `assigneeAgentId`。
- Coordinator 执行一次自动恢复。
- 第二次失败进入 `WAIT_USER_DECISION`。

### e2e smoke

新增建议：

```text
tests/e2e/coordinator-controlled-routing-smoke.mjs
```

覆盖：

- Coordinator 分配任务。
- Agent 接受并执行。
- Agent 拒绝后 Coordinator 自动改派一次。
- 第二次拒绝后进入用户确认。
- 事件流没有子 Agent 直接转派事件。

### 回归

```bash
npm run typecheck
npm run test:e2e:task-dependency
npm run test:e2e:multi-agent-discussion
npm run test:e2e:p1-behaviors
```

## 8. 兼容策略

- 不要求一次性删除 `claimed`。
- 不要求一次性删除 `task_claimed`。
- 短期在 UI 和文档层改语义。
- 共享合同可以先新增字段为可选字段。
- 新事件可以先通过 `metadata.payload.phase` 表达，稳定后再扩展枚举。

## 9. 完成标准

- 第一节点能生成可展示的任务计划。
- 每个任务都能追踪由 Coordinator 分配。
- 子 Agent 不能直接转派任务。
- blocked/rejected 后 Coordinator 自动处理一次。
- 自动处理失败后进入用户确认。
- 事件流能支持前端解释任务流向。

## 10. 关联文档

- [第一节点需求文档](../product/coordinator-controlled-routing-node1-requirements-v1.md)
- [Coordinator 中心流转与自动流转预留设计](../design/coordinator-controlled-routing-design-v1.md)
- [第一阶段任务清单](../roadmap/coordinator-controlled-routing-phase1-tasks.md)


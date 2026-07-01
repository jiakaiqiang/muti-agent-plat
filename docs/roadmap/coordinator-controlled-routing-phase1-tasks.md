# Coordinator 中心流转第一阶段任务清单

## 1. 阶段目标

第一阶段目标是把 Agent Cluster 的任务分发模型收敛为 `Coordinator Agent` 中心流转：

```text
Coordinator 拆分任务
  -> Coordinator 分配任务
  -> 子 Agent 接受 / 阻塞 / 拒绝
  -> Coordinator 自动处理一次
  -> 子 Agent 执行
  -> Coordinator 汇总交付
```

本阶段不实现子 Agent 自动转派，只保留 `handoffSuggestion` 扩展口。

## 2. 阶段边界

### 包含

- 明确 Coordinator 是唯一任务流转写入方。
- 取消“Agent 竞争接活”作为 v1 行为。
- 将 `claimed` 语义收敛为“已接受”。
- 设计并逐步引入任务接受、阻塞、拒绝和建议交接合同。
- Coordinator 支持一次自动恢复，第二次失败进入用户确认。
- 前端展示分配、接受、建议交接、自动恢复和用户决策。

### 不包含

- 子 Agent 自动转派。
- 复杂分布式任务抢锁。
- 多 Agent 竞争接活。
- `agent_delegated` 自动流转模式。
- 大规模数据表重构。

## 3. 第一阶段任务总表

| 任务 ID | 任务名称 | 类型 | 优先级 | 依赖 | 产物 |
| --- | --- | --- | --- | --- | --- |
| CCR-P1-01 | 第一节点需求与开发文档 | 文档 | P0 | 无 | 需求文档、开发文档 |
| CCR-P1-02 | 任务流转术语和合同梳理 | 合同/文档 | P0 | CCR-P1-01 | 状态、事件、兼容策略 |
| CCR-P1-03 | Coordinator 分配任务事件链 | 后端 | P0 | CCR-P1-02 | `task_assigned` 或兼容 payload |
| CCR-P1-04 | 子 Agent 接受决策合同 | 后端/Runtime | P0 | CCR-P1-02 | `task_acceptance_decision` |
| CCR-P1-05 | Coordinator 一次自动恢复 | 后端 | P0 | CCR-P1-03, CCR-P1-04 | 阻塞/拒绝处理规则 |
| CCR-P1-06 | 建议交接扩展口 | 合同/后端 | P1 | CCR-P1-04 | `handoffSuggestion` payload |
| CCR-P1-07 | 前端流转展示调整 | 前端 | P1 | CCR-P1-03, CCR-P1-05 | 任务卡片、协作图、聊天流文案 |
| CCR-P1-08 | 冒烟与回归验证 | 测试 | P0 | CCR-P1-03~CCR-P1-07 | e2e smoke |
| CCR-P1-09 | 文档回填与状态同步 | 文档 | P1 | CCR-P1-08 | PRD/设计/功能状态同步 |

## 4. 任务详情

### CCR-P1-01: 第一节点需求与开发文档

目标：

- 将“需求接收 -> Coordinator 拆分 -> 分配前合同”定义为第一节点。
- 产出产品需求文档和开发文档。

交付：

- [第一节点需求文档](../product/coordinator-controlled-routing-node1-requirements-v1.md)
- [第一节点开发文档](../implementation/coordinator-controlled-routing-node1-development-v1.md)

完成标准：

- 明确用户价值、范围、非目标、验收标准。
- 明确涉及模块、合同、实现步骤和测试策略。

### CCR-P1-02: 任务流转术语和合同梳理

目标：

- 统一“认领”和“接受”的语义。
- 给后续代码改造提供兼容策略。

建议内容：

- `claimed` 短期显示为“已接受”。
- 目标状态预留 `assigned`、`accepted`、`blocked`。
- 目标事件预留 `task_assigned`、`task_accepted`、`task_blocked`、`task_reassigned`。
- 保留旧事件兼容说明。

涉及文档：

- `docs/contracts/event-contract-v0.1.md`
- `docs/contracts/data-contract-v0.1.md`
- `docs/contracts/ui-state-contract-v0.1.md`
- `packages/shared/src/contracts.ts`

### CCR-P1-03: Coordinator 分配任务事件链

目标：

- 确保所有任务分配都由 Coordinator 写入。
- 每个任务都能追踪 `assignedByAgentId` 和 `assigneeAgentId`。

建议实现：

- 在任务创建后写入“分配”语义事件。
- 若暂不新增事件枚举，则在 `task_created` payload 中补充 `assignedByAgentId`、`routingMode`。
- Orchestrator 创建任务时默认 `routingMode=coordinator_controlled`。

### CCR-P1-04: 子 Agent 接受决策合同

目标：

- 将 `task_claim_decision` 收敛为“任务接受决策”语义。
- 子 Agent 只返回是否能执行，不改变任务流向。

建议输出：

```json
{
  "kind": "task_acceptance_decision",
  "status": "accepted",
  "reason": "任务与当前 Agent 职责匹配。",
  "missingContext": [],
  "handoffSuggestion": null
}
```

兼容策略：

- 短期可继续接受 `kind=task_claim_decision`。
- UI 文案显示“接受决策”，不显示“认领”。

### CCR-P1-05: Coordinator 一次自动恢复

目标：

- 子 Agent 返回 `blocked/rejected` 后，由 Coordinator 自动处理一次。
- 自动处理失败后进入 `WAIT_USER_DECISION`。

规则：

```text
autoResolutionAttempted=false:
  Coordinator 补上下文 / 改派 / 改写任务包
  autoResolutionAttempted=true

autoResolutionAttempted=true:
  Session -> WAIT_USER_DECISION
```

### CCR-P1-06: 建议交接扩展口

目标：

- 为后续自动流转保留数据结构。
- 第一阶段只展示建议，不执行子 Agent 自动转派。

建议 payload：

```json
{
  "handoffSuggestion": {
    "targetAgentKey": "backend",
    "reason": "该任务主要涉及后端接口。",
    "riskLevel": "low"
  }
}
```

### CCR-P1-07: 前端流转展示调整

目标：

- 用户能看清任务由 Coordinator 分配。
- 用户能看清子 Agent 是接受、阻塞还是建议交接。

建议改动：

- `claimed` 文案改为“已接受”。
- 任务卡片增加“分配者”和“负责 Agent”。
- 建议交接显示为“建议”，不是“已转派”。
- 第二次失败展示用户确认卡片。

### CCR-P1-08: 冒烟与回归验证

目标：

- 证明 Coordinator 中心流转闭环可用。
- 防止子 Agent 自动转派。

建议用例：

- 任务被 Coordinator 分配给目标 Agent。
- 目标 Agent 接受后进入执行。
- 目标 Agent 拒绝后 Coordinator 自动改派一次。
- 自动改派后仍失败进入 `WAIT_USER_DECISION`。
- 事件流中不存在子 Agent 直接改变任务归属的事件。

### CCR-P1-09: 文档回填与状态同步

目标：

- 将已确认并落地的语义同步回长期文档。

建议更新：

- `docs/product/agent-cluster-prd-v1.md`
- `docs/design/agent-cluster-system-design-v1.md`
- `docs/analysis/feature-inventory-and-status-v1.md`
- `docs/contracts/`

## 5. 验证建议

文档阶段：

```bash
npm run test:harness:phase1
```

实现阶段：

```bash
npm run typecheck
npm run test:e2e:task-dependency
npm run test:e2e:multi-agent-discussion
npm run test:e2e:p1-behaviors
```

若只改文档，可以不跑完整业务测试，但最终交付必须说明验证范围。


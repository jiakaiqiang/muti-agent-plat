# Coordinator 中心流转与自动流转预留设计 v1

## 1. 文档目标

本文档整理 Agent Cluster 在任务分发阶段的协作模型选择：

- 第一阶段采用 `Coordinator Agent` 中心流转。
- 取消子 Agent 自由竞争接活和子 Agent 之间自动转派。
- 子 Agent 可以提出交接或转派建议，但不能直接改变任务流向。
- 为后续半自动、自动流转保留合同、事件和策略扩展口。

本文档描述的是 Agent Cluster 业务系统的协作编排设计，不是 Harness Engineering 本体能力。

## 2. 背景与问题

现有产品和设计文档中已经存在两类语义：

- `Coordinator Agent` 将任务拆分为动态任务池。
- Agent 按职责认领或接受任务。

其中“认领”容易让系统走向子 Agent 自主抢任务、自主转派、自主补上下文的模型。该模型在长期目标上有价值，但第一阶段容易带来：

- 多个 Agent 重复理解全局需求，增加 token 消耗。
- Agent 之间反复拒绝、转派、补上下文，导致上下文卡死。
- 任务流向不稳定，用户难以理解谁决定了任务归属。
- 权限、依赖、用户确认的责任边界变模糊。

因此第一阶段需要将任务流转权收敛到 Coordinator。

## 3. 核心决策

第一阶段采用 `coordinator_controlled` 路由模式：

```text
用户需求
  -> Coordinator 接收和理解
  -> Coordinator 拆分任务
  -> Coordinator 指定负责 Agent
  -> 子 Agent 接受 / 阻塞 / 拒绝
  -> Coordinator 处理阻塞或拒绝
  -> 子 Agent 执行并回传
  -> Coordinator 汇总、复盘、交付给用户
```

规则：

- Coordinator 是唯一调度者。
- 子 Agent 不直接转派任务。
- 子 Agent 不直接创建新的执行流。
- 子 Agent 不直接决定是否询问用户。
- 子 Agent 只能向 Coordinator 回报执行状态、阻塞原因、缺失上下文和转派建议。
- Coordinator 最多自动处理一次阻塞或拒绝；再次失败进入 `WAIT_USER_DECISION`。

## 4. 路由模式分层

为了给后续自动流转留下口子，系统层面预留 `routingMode`：

| 模式 | 阶段 | 含义 | 子 Agent 能力 |
| --- | --- | --- | --- |
| `coordinator_controlled` | v1 | Coordinator 全权分发和转派 | 只能接受、阻塞、拒绝、建议 |
| `agent_suggested` | v2 | 子 Agent 可提出标准化交接建议，由 Coordinator 审核执行 | 可建议，不能直接转派 |
| `agent_delegated` | v3 | 子 Agent 可在策略允许范围内自动交接 | 可受控转派，必须有锁、上限、审计 |

第一阶段只实现或启用 `coordinator_controlled`，但合同字段按可扩展形态设计。

## 5. 角色职责

### 5.1 Coordinator Agent

职责：

- 接收用户需求。
- 形成任务理解和任务计划。
- 拆分子任务。
- 为每个子任务指定 `assigneeAgentId`。
- 组装每个子任务的上下文包。
- 接收子 Agent 的接受、阻塞、拒绝和完成结果。
- 判断是否补上下文、改派、暂停或请求用户决策。
- 汇总所有结果，组织复盘并交付给用户。

禁止：

- 绕过用户确认执行高风险操作。
- 在任务契约之外扩大范围。
- 将调度责任交给子 Agent。

### 5.2 子 Agent

职责：

- 只处理分配给自己的任务。
- 判断任务是否可执行。
- 执行任务并返回结果。
- 在不能执行时返回结构化原因。
- 可以提出 `handoffSuggestion`，但不能改变任务归属。

禁止：

- 自动转派给其他 Agent。
- 创建新任务流。
- 自行决定向用户提问。
- 修改不属于当前任务包的目标或验收标准。

## 6. 第一阶段主流程

```text
1. 用户确认任务契约。
2. Coordinator 根据 Task Brief 生成 Agent Tasks。
3. 每个任务写入 assigneeAgentId，并进入 assigned。
4. Coordinator 向目标 Agent 分发任务。
5. 目标 Agent 返回 task_acceptance_decision：
   - accepted
   - blocked
   - rejected
6. accepted 后任务进入 running。
7. blocked/rejected 后 Coordinator 自动处理一次：
   - 补上下文后重发。
   - 改派给另一个 Agent。
   - 缩小或重写任务包。
8. 自动处理后仍失败，Session 进入 WAIT_USER_DECISION。
9. 子 Agent 完成任务后回传结果。
10. Coordinator 汇总、复盘、生成最终交付。
```

## 7. 状态模型

推荐目标状态：

```text
pending
assigned
accepted
running
blocked
completed
failed
cancelled
```

兼容策略：

- 短期可以继续保留现有 `claimed`。
- UI、文档和事件展示应将 `claimed` 解释为“已接受”，而不是“已认领”。
- 后续合同迁移时再将 `claimed` 收敛为 `accepted` 或保留别名。

## 8. 事件模型

第一阶段推荐事件：

```text
task_created
task_assigned
task_accepted
task_blocked
task_reassigned
task_started
task_completed
task_failed
```

兼容策略：

- 若短期不扩展事件枚举，可复用 `task_claimed` 表示“任务已接受”。
- 事件 `metadata.payload.phase` 可以使用更准确的语义，例如 `task_acceptance`。
- 现有 `task_handoff` 可继续表示依赖任务完成后的交接提示；自动转派建议应使用更具体的 `handoffSuggestion` payload，避免和依赖交接混淆。

为后续自动流转预留事件：

```text
task_handoff_suggested
task_handoff_approved
task_handoff_rejected
task_handoff_executed
```

第一阶段只需要落地“建议”语义，其余可以先作为目标合同保留。

## 9. 任务合同预留字段

建议在任务合同中逐步引入以下字段：

```ts
type TaskRoutingMode =
  | 'coordinator_controlled'
  | 'agent_suggested'
  | 'agent_delegated';

type HandoffSuggestion = {
  targetAgentKey?: string;
  targetAgentId?: string;
  reason: string;
  missingContext?: string[];
  riskLevel?: 'low' | 'medium' | 'high';
};
```

任务侧预留：

```text
assignedByAgentId
assigneeAgentId
routingMode
handoffSuggestedByAgentId
handoffReason
handoffHistory
delegationDepth
maxDelegationDepth
requiresCoordinatorApproval
autoResolutionAttempted
```

第一阶段默认：

```text
routingMode = coordinator_controlled
delegationDepth = 0
maxDelegationDepth = 0
requiresCoordinatorApproval = true
autoResolutionAttempted = false
```

## 10. 子 Agent 输出合同

子 Agent 对分配任务的响应应结构化：

```json
{
  "kind": "task_acceptance_decision",
  "status": "blocked",
  "reason": "当前任务缺少接口路径和验收命令。",
  "missingContext": ["API contract path", "validation command"],
  "handoffSuggestion": {
    "targetAgentKey": "backend",
    "reason": "该任务主要涉及后端接口实现。"
  }
}
```

输出规则：

- `status=accepted` 时可以进入执行。
- `status=blocked` 时 Coordinator 优先补上下文。
- `status=rejected` 时 Coordinator 判断是否改派。
- `handoffSuggestion` 只是建议，不产生任务状态变更。

## 11. Coordinator 异常处理规则

Coordinator 收到 `blocked/rejected` 后执行一次自动恢复：

```text
if autoResolutionAttempted=false:
  1. 分析原因。
  2. 选择补上下文、改派或改写任务包。
  3. 记录自动处理事件。
  4. 将 autoResolutionAttempted 标记为 true。
else:
  进入 WAIT_USER_DECISION。
```

自动处理边界：

- 低风险、同范围、同任务目标内可以自动处理。
- 跨职责变化、影响任务契约、需要高风险工具或新增权限时必须问用户。
- 不允许子 Agent 之间绕过 Coordinator 自动流转。

## 12. UI 展示原则

前端应强调“主 Agent 调度”：

- 任务卡片显示“由 Coordinator 分配给 X”。
- `claimed` 显示为“已接受”。
- 子 Agent 的建议显示为“建议交接”，不是“已转派”。
- 转派卡片必须显示 Coordinator 是否采纳。
- 第二次失败应显示用户决策卡片。

## 13. 可执行性分析

第一阶段可执行性高，原因：

- 现有任务模型已有 `assigneeAgentId`。
- Orchestrator 已负责执行任务和生成事件。
- 事件流已能驱动聊天、工作流和协作图展示。
- `task_handoff` 已有展示语义雏形，可扩展为建议交接的入口。

主要改造点：

- 术语从“认领”收敛为“接受”。
- 明确 Coordinator 是唯一流转写入方。
- 引入或兼容 `task_acceptance_decision`。
- 增加一次自动处理和失败后用户确认规则。

## 14. 分期路线

### v1: Coordinator 中心流转

- 固定 `routingMode=coordinator_controlled`。
- 子 Agent 不自动转派。
- 支持接受、阻塞、拒绝、完成。
- Coordinator 自动处理一次异常。
- UI 展示分配、接受、建议交接、用户决策。

### v2: 子 Agent 建议流转

- 开启 `agent_suggested`。
- 子 Agent 可发出标准化 `handoffSuggestion`。
- Coordinator 可自动审核低风险建议。
- 所有流转仍由 Coordinator 写入。

### v3: 受控自动流转

- 开启 `agent_delegated`。
- 子 Agent 可在策略范围内直接流转。
- 必须具备 delegation depth、幂等锁、权限边界、审计、回滚和用户确认策略。

## 15. 第一阶段任务入口

第一阶段任务清单见：

- [Coordinator 中心流转第一阶段任务清单](../roadmap/coordinator-controlled-routing-phase1-tasks.md)

第一节点文档见：

- [第一节点需求文档](../product/coordinator-controlled-routing-node1-requirements-v1.md)
- [第一节点开发文档](../implementation/coordinator-controlled-routing-node1-development-v1.md)

---
artifact: design_plan
stage: design
producedBy: architect
schemaVersion: "0.1"
status: ready
deliveryId: workflow-quality-rejection-rework-v1
createdAt: 2026-09-08T00:00:00+08:00
intentContractRef: workflow-quality-rejection-rework-spec-v1
---

# Design Plan: 工作流质量拒绝与返工闭环

> 上游规格：[`../product/workflow-quality-rejection-rework-spec-v1.md`](../product/workflow-quality-rejection-rework-spec-v1.md)
>
> 下游任务：[`../implementation/workflow-quality-rejection-rework-tasks-v1.md`](../implementation/workflow-quality-rejection-rework-tasks-v1.md)
>
> 验收清单：[`../quality/workflow-quality-rejection-rework-checklist-v1.md`](../quality/workflow-quality-rejection-rework-checklist-v1.md)

## 1. 方案概述 (Overview)

采用“阶段语义分离 + 显式停车状态 + 既有质量闸口复用”的方案：

1. 保持 `task_acceptance_decision@1.0` 不变，但统一提示词，限定它只判断 Agent 是否能够开始任务。
2. 质量工程师需要裁决上游成果时，工作流必须使用现有 `robot_approval` 或 `human_approval` 节点；机器人质量结论仍为 `approve | revise | reject`。
3. `revise` 作为可恢复质量失败，回到最近上游 Agent 并创建新 attempt；`reject` 保持不可恢复终止。
4. 普通 Workflow Agent 执行后 `blocked` 的在途 `workflow_upstream_rerun` 能力作为安全回退：只提供人工选择，不自动把阻塞断言成质量失败。
5. Workflow Agent 接单拒绝时，Workflow Run 也进入 `waiting_human`，与 Session 的 `WAIT_USER_DECISION`、Task blocked 和 active confirmation 对齐。
6. 新增 `task_failed` 事件，把执行失败与接单拒绝拆开。

### 目标状态流

```text
                    +------------------+
assigned -> acceptance decision        |
                    |                  |
          accepted |          blocked/rejected
                    v                  v
                execution       waiting_human
                    |          substitution/skip/cancel
        +-----------+-----------+
        |                       |
    completed                 blocked
        |                       |
        v                       v
 robot/human quality gate   supplemental context
   |       |       |             |
approve  revise  reject        exhausted
   |       |       |             |
 next   upstream   failed    upstream-rerun card
 node   new attempt           / retry / cancel
```

## 2. 研究结论 (Current State Research)

### 2.1 当前合同

- `TaskAcceptanceDecisionOutputSchema`：`accepted | blocked | rejected`，包含缺失上下文、建议改派和候选 Agent；没有质量返工字段。
- `TaskExecutionResultOutputSchema`：`completed | failed | blocked | needs_review`；当前 `blocked` 会先尝试补上下文。
- `WorkflowApprovalRecord.decision`：`approve | revise | reject | cancel`。
- Workflow V1 节点：`agent | human_approval | robot_approval`，线性执行。

### 2.2 当前运行时

- `resolveTaskClaim()` 对普通非 Workflow 任务允许一次自动替代；Workflow 任务禁止自动跨角色改派，接单拒绝后返回 `workflowAgentSubstitution`。
- `resumeCurrentExecution()` 已显式拒绝恢复处于 Agent 替代或上游重跑等待态的节点。
- `handleRobotResult()` 已实现 approve/复审返工/reject 终止，但机器人决策由 `task_execution_result.summary` 中的 JSON 解析，提示中未明确普通缺陷必须使用 `revise`。
- 当前工作树已经实现 `pendingUpstreamRerun`、候选计算、选择上游重跑、重试当前节点、Session API 和前端确认卡路由；定向 Workflow Runtime 测试已覆盖主要服务逻辑。
- `SessionWorkspace.spec.ts` 尚未覆盖 `workflow_upstream_rerun` 分支；Session service 对该 API 的集成测试也未见覆盖。
- `markTaskFailed()` 使用 `runtime_failed` 后又发送 `task_rejected`，导致事件语义混淆。

### 2.3 关键根因

- 节点状态机由节点类型决定，不由 Agent 名称决定。
- 接单合同与质量决策合同被自然语言“不接受”混用。
- Agent 接单拒绝只在 Session 层停车，Workflow Run / NodeRun 投影仍可能像“运行中”。
- 机器人提示只枚举结果，没有给出 `revise` 与 `reject` 的业务边界。

## 3. 架构与模块边界 (Architecture & Module Boundaries)

| 模块 | 职责 | 计划变更 |
| --- | --- | --- |
| `packages/shared/src/runtime-contracts/` | Runtime 输出合同与统一输出纪律 | 保持 acceptance schema；集中加入阶段语义提示与测试 |
| `packages/shared/src/contracts.ts` | Workflow 状态、事件、共享类型 | 增加显式 pending substitution 状态与 `task_failed` 事件 |
| `apps/server/src/modules/orchestrator/` | 接单、执行、错误分类、事件产生 | 正确分类接受拒绝、执行失败和上游不足 |
| `apps/server/src/modules/workflows/` | Workflow Run、节点迁移、返工 attempt | 统一停车状态；严格质量决策；复用上游重跑能力 |
| `apps/server/src/modules/sessions/` | Session 投影和用户决策 API | 保持 active confirmation 与 Workflow pending state 一致 |
| `apps/server/src/modules/persistence/` | Workflow 状态持久化与恢复 | 兼容新增 pending 字段，保证重启恢复和幂等 |
| `apps/web/src/stores/` | API、事件和状态映射 | 接入 `task_failed`，补齐上游重跑与替代决策测试 |
| `apps/web/src/components/` | 运行视图、确认卡和工作流编辑器 | 显示真实等待原因与节点类型提示 |
| `docs/contracts/` | 对外合同文档 | 同步 Event/Data/UI/API 的语义说明 |

### Architecture Constraints

- `module_boundaries`：Orchestrator 只判断任务阶段和产生领域信号；Workflow Runtime 独占工作流图、候选节点和状态迁移。
- `ownership_boundaries`：Runtime Adapter 只负责生成严格输出，不决定工作流回退目标；Session 只做投影和用户命令入口。
- `dependency_direction`：Shared contracts -> Server state machine -> Session/API -> Web store/component。
- `contract_stability`：`task_acceptance_decision@1.0` 与 `task_execution_result@1.0` 结构不变；事件合同允许加法新增 `task_failed`。
- `allowed_change_scope`：仅限任务文档列出的 shared/server/web/contracts/tests 路径。
- `forbidden_change_scope`：Agent 名称启发式、第四类节点、非相关 Runtime、通知/DingTalk、部署与发布配置。
- `invariants`：历史 attempt 不可变；等待决策不得隐式恢复；一个 confirmation 只能消费一次；`reject` 不触发返工。

## 4. 核心设计

### 4.1 接单阶段语义护栏

新增统一的 acceptance 语义说明，由 Shared 导出并被本地 CLI、Claude/Codex/Generic LLM 服务端路径共同消费：

```text
Acceptance asks whether you can execute the assigned task.
If you are assigned to validate an upstream deliverable and are capable of
performing that validation, return accepted even when the deliverable may fail.
Report quality defects during execution/review, not as task rejection.
```

要求：

- 删除 Adapter 内重复或冲突的 acceptance 文案。
- Mock Runtime 增加“QA 接受评审任务后在执行阶段给出 revise”的场景夹具。
- Acceptance decision 结构不新增质量字段。

### 4.2 Agent 接单拒绝停车模型

为 Workflow Run 增加显式的 `pendingAgentSubstitution`（命名可在实现时与现有类型统一）：

```ts
type WorkflowPendingAgentSubstitution = {
  nodeId: string
  nodeRunId: string
  taskId: string
  currentAgentId: string
  reason: string
  candidateAgentIds: string[]
  requestedAt: string
}
```

状态迁移：

```text
node running + task acceptance rejected
  -> task blocked
  -> node waiting
  -> run waiting_human + pendingAgentSubstitution
  -> session WAIT_USER_DECISION + workflow_agent_substitution card
```

解除规则：

- 改派：清除 pending，Run 回 `running`，同节点使用明确覆盖 Agent 重新调度；产生可审计的新 acceptance invocation。
- 跳过：当前 NodeRun=`skipped`，Task=`cancelled`，清除 pending 并进入下一节点。
- 取消：Run/Session 进入取消终态。
- 普通继续：返回“仍需明确决策”，不得清除 pending。

### 4.3 质量闸口决策

保留现有 `robot_approval` 节点并强化其局部决策合同：

```ts
type WorkflowRobotDecision = {
  decision: 'approve' | 'revise' | 'reject'
  reason: string
  revisionInstruction: string | null
  evidenceRefs: string[]
}
```

验证规则：

- 对象只允许上述字段。
- `revise` 要求 `revisionInstruction` 非空。
- `approve/reject` 允许 `revisionInstruction = null`。
- 普通可修复缺陷使用 `revise`；`reject` 的提示必须明确其终止后果。
- 非法对象、Runtime 异常或返工超限统一转人工确认。

不新增全局 RuntimeOutput kind：V1 继续由 `task_execution_result.summary` 承载机器人局部 JSON，以控制变更范围；严格解析逻辑必须独立成可单测函数。若后续多个模块需要复用该决策，再升级为独立 RuntimeOutput 合同。

### 4.4 返工 attempt 和依赖

- 质量闸口 `revise`：默认目标为最近的上游 Agent 节点，符合 V1 线性工作流合同。
- `workflow_upstream_rerun`：由用户从真实上游 Agent 候选中选择。
- 被退回节点的新 attempt 必须带上修改指令，并读取上一轮输出作为返工上下文。
- 下游节点再次执行时，`dependsOnTaskIds` 和输入引用必须指向最新成功的上游 attempt。
- 停车任务必须进入终态，防止 Post Review 再次错误驱动旧任务。

### 4.5 事件和 UI 投影

事件语义：

| 事实 | 事件 |
| --- | --- |
| Agent 接单成功 | `task_accepted` |
| Agent 接单拒绝 | `task_rejected` |
| 执行等待更多上下文 | `task_waiting` + `runtime_failed(CONTEXT_INSUFFICIENT)` |
| 执行失败 | `task_failed` + `runtime_failed` |
| 节点要求返工 | `workflow_node_revision_requested` / `task_reworked` |
| 等待用户决策 | `user_confirmation_requested`，reason 精确区分 substitution/upstream-rerun/human-gate |

UI 状态优先级：active confirmation / persisted pending state 高于 Run 的普通运行投影。页面显示：

- `workflow_agent_substitution` -> “等待改派或跳过当前 Agent”
- `workflow_upstream_rerun` -> “等待选择返工节点”
- `confirm_workflow_human_gate` -> “等待人工验收”
- `task_failed` -> “任务执行失败”
- `task_rejected` -> “Agent 拒绝接单”

### 4.6 恢复和并发

- `pendingAgentSubstitution` 与 `pendingUpstreamRerun` 都进入 Workflow Runtime 持久化状态。
- 恢复时先重建 pending/confirmation，再考虑调度；存在 pending 时禁止 Runtime 自动启动。
- 所有决策 API 校验 sessionId、runId、nodeRunId、confirmationId 和候选目标。
- `expectedRunRevision` 继续用于拒绝过期命令；同一 confirmation 的重复请求不得产生第二个 attempt。

## 5. 契约影响 (Contract Impact)

| 契约 | 影响 | 兼容性 |
| --- | --- | --- |
| Runtime Output | 不修改 `task_acceptance_decision@1.0` / `task_execution_result@1.0` 结构；只加强提示 | 兼容 |
| Data | `WorkflowRun` 加法新增 pending substitution 字段 | 可向后读取；缺字段视为无 pending |
| Event | 加法新增 `task_failed`；收窄 `task_rejected` 的产生条件 | 消费端同批升级 |
| API | 复用现有 Agent substitution、skip、upstream-rerun、cancel API；补充状态和错误码说明 | 不新增主路径 endpoint |
| UI State | 使用既有 `WAIT_USER_DECISION` / `waiting_human`，新增更具体的展示文案 | 兼容 |
| Persistence | Workflow state schema 需要兼容新增可选字段 | 兼容迁移 |

需要同步更新：

- `docs/contracts/runtime-contract-v0.1.md`
- `docs/contracts/event-contract-v0.1.md`
- `docs/contracts/data-contract-v0.1.md`
- `docs/contracts/api-contract-v0.1.md`
- `docs/contracts/ui-state-contract-v0.1.md`

## 6. 方案比较与决策 (Decisions & Trade-offs)

### 方案 A：根据 Agent 名称自动识别质量工程师

放弃。名称可变、国际化且不可作为状态机合同，容易误判普通测试或 Review 任务。

### 方案 B：新增第四种 `quality_gate` 节点

放弃于 V1。现有 `robot_approval` / `human_approval` 已覆盖自动和人工质量闸口；新增节点会扩大编辑器、API、发布校验、持久化和迁移范围。

### 方案 C：复用现有确认节点并严格分离阶段语义

采用。它直接修复根因，保持 RuntimeOutput 主合同稳定，并能复用现有返工、人工回退和审计能力。

### 关于普通 Agent `blocked`

不自动认定为质量失败。保留当前 `workflow_upstream_rerun` 人工选择，既避免卡死，也避免系统把工作区缺失、外部依赖或能力阻塞误判成上游缺陷。

## 7. 风险与缓解 (Risks & Mitigations)

- 多 Runtime 提示不一致：用 Shared 单一来源和逐 Adapter 快照测试约束。
- 当前在途实现把所有 Workflow Agent `blocked` 都包装为 upstream incomplete：界面和文档使用“疑似上游输入不足”，不自动执行；后续如需精确分类再升级 Runtime 合同。
- pending 状态新增后恢复兼容：字段必须可选，旧状态加载为 undefined；增加持久化往返测试。
- `task_failed` 新事件遗漏某个 Web 映射：共享 union、event normalization、timeline 和 agent status 测试同批更新。
- 机器人 JSON 仍位于 summary：严格局部解析并完整测试；作为 V1 限制记录，不在本次扩大 RuntimeOutput 版本。

## 8. 对验收标准的覆盖 (Acceptance Mapping)

| AC | 设计覆盖 |
| --- | --- |
| AC1 | 4.1 统一接单语义护栏 |
| AC2-AC3 | 4.2 显式 substitution 停车模型 |
| AC4-AC7 | 4.3 严格质量决策 + 4.4 attempt 规则 |
| AC8-AC10 | 4.4 复用 `workflow_upstream_rerun` |
| AC11 | 4.5 事件语义分离 |
| AC12 | 4.6 恢复和并发 |
| AC13 | 4.5 UI 投影及编辑器提示 |
| AC14 | 下游任务与质量清单中的自动化门禁 |

## 9. 实施顺序

1. 先增加失败测试，固定四类“不接受”语义和当前状态差异。
2. 统一接单提示，阻止 QA 在接单阶段裁决成果质量。
3. 补齐 Agent substitution 的 Workflow pending 状态与恢复。
4. 强化 robot approval 解析和 revise/reject 边界。
5. 审计并补齐在途 `workflow_upstream_rerun` 的 API/UI/恢复测试。
6. 拆分 `task_failed` 与 `task_rejected`，更新 UI 映射。
7. 更新编辑器说明和合同文档。
8. 运行定向、全量与人工主场景验收。

## 10. 实施回填（2026-09-09）

- 接单语义已统一到 Shared 单一提示源，QA/Review Agent 能执行验收时必须返回 `accepted`；质量缺陷使用 `revise`，不可恢复问题使用 `reject`。
- Workflow Agent 接单拒绝已形成可持久化的 `pendingAgentSubstitution` 停车态，四层投影和显式改派、跳过、取消 API 已闭环；普通 `resume` 保持 fail-closed。
- `task_failed` 已与 `task_rejected` 分离；Workflow Runtime、Sessions、Web 运行视图和编辑器提示已同步。
- 自动返工、上游重跑、恢复幂等和 substitution HTTP E2E 均有直接证据。未引入 `quality_gate` 节点，也未改变既有 Runtime Output Schema。

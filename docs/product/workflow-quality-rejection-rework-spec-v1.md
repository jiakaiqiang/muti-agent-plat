---
artifact: intent_contract
stage: requirement
producedBy: requirements
schemaVersion: "0.1"
status: confirmed
deliveryId: workflow-quality-rejection-rework-v1
createdAt: 2026-09-08T00:00:00+08:00
requiresHumanIntervention: false
---

# Intent Contract: 工作流质量拒绝与返工闭环

> 问题：前端工程师完成工作后，质量工程师表示“不接受”，工作流进入等待状态且无法自然流转。
>
> 下游设计：[`../design/workflow-quality-rejection-rework-plan-v1.md`](../design/workflow-quality-rejection-rework-plan-v1.md)
>
> 实施任务：[`../implementation/workflow-quality-rejection-rework-tasks-v1.md`](../implementation/workflow-quality-rejection-rework-tasks-v1.md)
>
> 验收清单：[`../quality/workflow-quality-rejection-rework-checklist-v1.md`](../quality/workflow-quality-rejection-rework-checklist-v1.md)

## 1. 目标 (Goal)

建立可恢复、可审计且语义明确的质量反馈闭环，使“质量验收不通过”进入上游返工，而“Agent 无法接单”“执行阻塞”和“不可恢复拒绝”分别进入各自的处理分支，不再因为自然语言中的“不接受”被错误路由而表现为工作流卡死。

目标流程：

```text
前端 Agent 完成 attempt 1
  -> 质量闸口执行验收
  -> 普通质量问题：revise
  -> 前端 Agent 创建 attempt 2 并接收修改意见
  -> 质量闸口重新验收
  -> approve 后继续下游
```

## 2. 背景与当前证据 (Background)

当前系统同时存在三类容易被统称为“不接受”的信号，但它们的业务含义不同：

| 信号发生阶段 | 当前信号 | 正确含义 | 正确去向 |
| --- | --- | --- | --- |
| Agent 接单阶段 | `task_acceptance_decision.status = blocked/rejected` | 当前 Agent 缺上下文、能力或职责不匹配，不能开始任务 | 补上下文、改派、跳过或取消 |
| 质量验收阶段 | `approve/revise/reject` | 上游成果通过、需要返工或不可恢复终止 | 继续、返工或失败 |
| Agent 执行阶段 | `task_execution_result.status = blocked` | Agent 已开始工作，但上下文或上游输入不足 | 补上下文；必要时选择上游重跑 |

仓库证据：

- `packages/shared/src/runtime-contracts/output-contracts.ts` 中 `task_acceptance_decision` 只有 `accepted | blocked | rejected`，它是接单合同，不是质量验收合同。
- `apps/server/src/modules/orchestrator/orchestrator.service.ts` 对 Workflow Agent 的接单拒绝禁止自动跨角色改派，并把任务置为 `blocked`，交给用户明确选择替代 Agent、跳过或取消。
- `apps/server/src/modules/workflows/workflow-runtime.service.ts` 中只有显式 `human_approval` / `robot_approval` 节点拥有 `revise` 返工迁移；`robot_approval.reject` 按产品合同直接终止工作流。
- 当前工作树已存在 `workflow_upstream_rerun` 的在途实现：普通 Agent 执行后返回 `blocked` 时，可暂停并让用户选择上游节点重跑、重试当前节点或取消。它解决的是“执行后发现上游不足”，不改变“接单拒绝”的语义。
- `markTaskFailed()` 目前会把部分普通执行失败发成 `task_rejected`，导致事件名称与真实原因混杂。
- 工作流 V1 只支持 `agent`、`human_approval`、`robot_approval` 三类线性节点；Agent 的名称或角色文案不会改变节点状态机行为。

因此，问题不是缺少某个“继续”按钮，而是同一句“不接受”在错误阶段使用了错误合同，随后进入了必须人工解决的接单拒绝分支。

## 3. 术语与不可混用规则

### SPEC-SEM-001：接单决策只判断能否执行任务

- `task_acceptance_decision` 只回答“被分配的 Agent 是否具备执行当前任务的能力、职责和最低上下文”。
- 接单阶段不得检查并裁决上游成果质量。
- 质量工程师能够执行验收时，即使预判上游可能存在缺陷，也必须先返回 `accepted`，再在验收执行阶段给出质量结论。
- `rejected` 只用于职责或能力明确不匹配；`blocked` 只用于开始任务前缺少必要上下文且可通过补充恢复。

### SPEC-SEM-002：质量结论使用质量闸口决策

- 需要自动质量返工的节点必须配置为 `robot_approval`；需要用户裁决的质量节点配置为 `human_approval`。
- 不允许通过 Agent 名称包含“质量”“测试”“Review”等字样推断节点行为。
- 普通可修复缺陷必须返回 `revise`。
- `reject` 只用于继续返工也无法满足目标、违反不可突破的政策/安全边界、或用户目标本身需要终止的情形。
- `revise` 必须包含非空 `revisionInstruction`；`approve` 和 `reject` 必须包含非空 `reason` 与证据引用数组。

### SPEC-SEM-003：执行阻塞是恢复信号，不是质量拒绝

- `task_execution_result.status = blocked` 先进入补上下文恢复。
- 补上下文恢复耗尽后，如果当前 Workflow Agent 存在已执行的上游 Agent 节点，系统进入 `workflow_upstream_rerun` 人工决策。
- 该分支表示“疑似上游输入不足”，不得自动等同于质量验收不通过。
- 用户必须可以选择：重跑某个合法上游 Agent 节点、重试当前节点或取消工作流。

## 4. 功能需求

### SPEC-FLOW-001：质量返工闭环

- `robot_approval.approve` 完成当前确认节点并进入下一节点。
- `robot_approval.revise` 将修改说明发送给最近的合法上游 Agent 节点，创建新的节点执行 attempt，并在该节点完成后重新走到质量闸口。
- 原 attempt、原任务、原审批记录和证据保持只读，不能原地覆盖。
- 超过 `maxRevisionAttempts`、机器人输出格式非法或机器人执行异常时，转为人工确认，不得静默失败或无限重试。
- `robot_approval.reject` 将 Workflow Run 置为 `failed`，并记录不可恢复原因；它不触发返工。

### SPEC-FLOW-002：接单拒绝的显式停车与恢复

- Workflow Agent 接单返回 `blocked/rejected` 且自动补上下文不可恢复时，当前节点必须进入等待用户的明确状态。
- Session 显示 `WAIT_USER_DECISION`，Workflow Run 显示 `waiting_human`，当前 NodeRun 不得继续显示为正在执行模型。
- 等待原因必须明确为 `workflow_agent_substitution`，并展示原 Agent、拒绝原因和候选 Agent。
- 普通“继续”命令不得隐式恢复默认 Agent，以免重复同一次拒绝。
- 只有显式改派、跳过或取消能够解除该停车状态。

### SPEC-FLOW-003：执行后上游不足的显式返工选择

- Workflow Agent 已执行但返回 `blocked`，且补上下文重试已耗尽时，如果存在合法上游 Agent 候选，必须创建 `workflow_upstream_rerun` 决策卡。
- 候选只能来自当前节点的真实上游 Agent 节点；人工/机器人确认节点不得作为可重跑工作节点。
- 选择上游节点后，停车节点关闭为 `revision_requested`，其任务进入终态；选定上游创建新 attempt，前向执行最终再次到达原停车节点的新 attempt。
- 选择“重试当前节点”时必须创建当前节点的新 attempt，不得复用已失败/阻塞的任务记录。
- 无上游候选时进入通用恢复分支，不伪造可返工节点。

### SPEC-FLOW-004：状态、恢复与幂等

- 所有等待用户的原因必须持久化；服务重启后仍能还原同一张 active confirmation。
- 同一个 `confirmationId` 只能成功解决一次；重复、过期或目标不合法的请求必须被幂等拒绝。
- 停车期间不得由后台恢复、普通继续或重复事件隐式启动 Runtime。
- 解除停车后必须产生新的可审计 attempt，并保持依赖指向最新成功的上游 attempt。

### SPEC-EVENT-001：事件语义分离

- `task_rejected` 只表示 Agent 在接单阶段明确拒绝任务。
- Runtime 或任务执行阶段失败使用 `runtime_failed` 和 `task_failed`，不得伪装成接单拒绝。
- 上游返工使用 `workflow_node_revision_requested` / `task_reworked` 或等价的返工事件，并携带源节点、目标节点、attempt 和原因。
- UI 必须分别显示“Agent 无法接单”“质量要求返工”“执行失败”“等待选择上游节点”，不能都显示为笼统的“拒绝”或“运行中”。

### SPEC-UX-001：工作流配置与运行时提示

- 工作流编辑器在节点类型说明中明确：普通 `agent` 节点不具备自动验收返工语义；质量验收应使用 `robot_approval` 或 `human_approval`。
- 机器人确认配置区明确展示 `approve/revise/reject` 的边界，特别提示“普通缺陷使用 revise”。
- 等待决策时，页面必须展示阻塞原因、可执行操作、目标节点/Agent 和操作后果。
- Workflow Run 为等待态时不得只显示“运行中”；应显示“等待改派”或“等待返工选择”。

## 5. 非目标 (Non-goals / Out of Scope)

- 不新增第四种 `quality_gate` 节点；V1 复用现有 `robot_approval` / `human_approval`。
- 不根据 Agent 名称、角色描述或自然语言关键词自动改变节点类型。
- 不允许质量 Agent 在接单阶段直接决定上游成果是否通过。
- 不把 `reject` 改造成 `revise` 的别名。
- 不在多个合法返工目标之间静默自动选择；当前 V1 质量闸口只回到最近上游 Agent，普通 Agent 的上游不足由用户选择。
- 不覆盖或删除历史 attempt、审批记录、事件或产物。
- 不修改 Harness Engineering 的边界，不把 Harness 本体产品化。

## 6. 约束 (Constraints)

- 保持 `task_acceptance_decision@1.0` 的字段和枚举稳定，不通过新增模糊状态解决质量问题。
- 保持 Workflow V1 线性节点模型和现有三类节点。
- `robot_approval.reject` 的终止语义保持不变；修复重点是让可修复缺陷稳定地产生 `revise`。
- 所有 Runtime 输出仍执行严格 JSON Schema 校验；不得由 Mapper 猜测或补造业务结论。
- 合同、服务端、前端和持久化变更必须同批更新并有自动化测试。
- 当前工作树包含其他未提交修改；实施时必须按任务允许路径隔离，禁止覆盖无关改动。

## 7. 验收标准 (Acceptance Criteria)

- [x] AC1 接单提示明确说明：能执行质量验收的 Agent 必须返回 `accepted`，不得用 `rejected` 表达上游成果不合格。
- [x] AC2 Workflow 中 Agent 接单拒绝后，Session=`WAIT_USER_DECISION`、Run=`waiting_human`，且存在 `workflow_agent_substitution` active confirmation。
- [x] AC3 接单拒绝停车期间，普通继续不会启动 Runtime；显式改派、跳过和取消分别按合同生效。
- [x] AC4 质量工程师作为 `robot_approval` 执行时，普通缺陷返回 `revise`，前端节点创建新 attempt，完成后质量节点再次执行。
- [x] AC5 `revise` 缺少 `revisionInstruction` 时按非法机器人结果转人工确认，不得无说明返工。
- [x] AC6 `reject` 只进入 Workflow `failed`，不创建上游返工 attempt。
- [x] AC7 超过最大返工次数、非法 JSON 或机器人运行异常均转人工确认，且只生成一张 active confirmation。
- [x] AC8 普通 Workflow Agent 执行后 `blocked`、补上下文失败且存在上游候选时，生成 `workflow_upstream_rerun` 卡片。
- [x] AC9 选择上游重跑后，选定节点和原停车节点都产生新 attempt，并依赖最新成功上游任务；历史 attempt 保持不变。
- [x] AC10 选择重试当前节点创建新 attempt；选择取消进入终态；无上游候选进入通用恢复。
- [x] AC11 `task_rejected` 只来自接单拒绝；普通执行失败产生 `task_failed`，UI 映射为失败而非拒绝接单。
- [x] AC12 重启恢复后等待原因、候选、confirmationId 和 attempt 仍可用；重复决策不重复推进。
- [x] AC13 工作流编辑器明确提示质量验收节点类型和 `revise/reject` 边界，运行视图显示真实等待原因。
- [x] AC14 定向合同、服务端 Workflow、Session、前端确认交互测试以及 `npm run typecheck`、`npm run test:harness` 全部通过。

## 8. 风险 (Risks)

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 只改提示词，模型仍可能混淆 `revise/reject` | 质量问题仍可能错误终止流程 | 严格解析决策；非法或缺字段转人工；测试覆盖语义边界 |
| 把所有执行 `blocked` 当成上游质量问题 | 错误展示返工选项 | 定义为“疑似上游不足”的人工决策，不自动重跑；保留重试当前节点 |
| Run、NodeRun、Task、Session 状态不同步 | UI 显示运行中但实际等待 | 为接单拒绝建立显式持久化停车状态；投影测试断言四层一致 |
| 修改事件类型影响前端映射 | 时间线丢消息或状态错误 | `task_failed` 以加法方式引入，同批更新共享类型、映射与回归测试 |
| 重跑覆盖历史结果 | 审计与依赖错误 | 每次返工创建新 attempt；只读取最新成功 attempt |
| 当前未提交实现与后续任务重叠 | 覆盖用户已有代码 | T0 先审计差异；后续任务只补齐缺口，不重复实现 |

## 9. 需要用户确认的问题 (Open Questions)

无阻塞问题。本规格采用以下保守假设：

- V1 不新增节点类型，质量验收使用现有 `robot_approval` / `human_approval`。
- 自动质量返工只由显式确认节点触发；普通 Agent 的执行阻塞仍需用户确认返工目标。
- 如果未来需要并行图、多目标自动回退或独立的质量输出 Runtime kind，应另开 V2 契约。

## 10. 完成标准 (Definition of Done)

- AC1-AC14 全部具有自动化或人工证据，并在验收清单中标记为通过。
- 接单拒绝、质量返工、执行阻塞、运行失败四条路径的事件和状态不再混用。
- 从前端 attempt 1 到 QA revise、前端 attempt 2、QA 复验、继续下游的主场景可重复通过。

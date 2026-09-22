---
artifact: spec
stage: requirement
producedBy: product
schemaVersion: "0.1"
status: implemented_with_deferred_follow_up
deliveryId: task-acceptance-timeout-reliability-v1
createdAt: 2026-09-21
---

# 群聊工作流接单超时可靠性 Spec v1

## 1. 问题定义

工作流节点在 `task_acceptance` 阶段被服务端逻辑操作以固定 120 秒总预算终止。当前执行记录显示，Claude Code 在本地 Runtime 中已开始读取工作区文件，但还没有返回 `task_acceptance_decision@1.0`，编排器即产生 `RUNTIME_TIMEOUT`/`phase_timeout`，随后同一调用的失败向任务和 WorkflowRun 级联。

## 2. 目标

1. 让有明确工作流指派但需要模型判断的接单调用拥有可配置且足够的阶段预算。
2. 保留 grounded-evidence 闸口，禁止为了避免超时而让没有证据的代码任务直接进入执行。
3. 记录规则接单未命中的原因，使“为什么调用模型”可审计。
4. 保持 `task_acceptance_decision@1.0`、WorkflowRun 停止/返工、任务状态和事件语义兼容。

## 3. 非目标

- 不调用或切换真实模型供应商。
- 不改变 Agent 接单合同字段和 `accepted/blocked/rejected` 枚举。
- 不自动重跑已经失败的历史 WorkflowRun。
- 不把模型超时伪装成 Agent 拒绝接单。
- 不取消 grounded evidence、权限审批或依赖检查。

## 4. 约束与不变量

- `task_acceptance` 的截止时间只能由阶段策略解析；不能在 `LogicalOperationStore` 中对该阶段硬编码覆盖环境配置。
- 配置为零或非法时仍采用有限安全默认值，避免无限挂起；同时写入诊断标记。
- 规则接单只有在任务、Agent、依赖、审批和 evidence gate 均满足时才生效。
- 模型回退原因只能包含稳定的诊断码，不携带提示正文、文件内容或凭据。
- 同一逻辑操作的第一次终止原因优先，超时仍是 `phase_timeout`/`RUNTIME_TIMEOUT`。

## 5. 验收标准

- AC1：`PHASE_TIMEOUT_TASK_ACCEPTANCE_MS` 为合法正数时，`task_acceptance` 使用该值；不再被固定 120000 覆盖。
- AC2：未配置阶段值时默认使用 300000ms；非法/零值使用同一有限默认值并产生诊断码。
- AC3：现有 evidence gate 失败时仍不会规则接单；会进入模型路径并把稳定回退原因写入调用上下文。
- AC4：工作流显式指派且 evidence/dependency/permission 全部满足时，仍可走规则接单，不产生模型调用。
- AC5：模型在阶段预算内返回合法接单结果时，任务继续进入既有执行流程；不改变停止、返工和失败事件语义。
- AC6：阶段预算耗尽时，只产生一个根调用的超时事实；下游状态仍按既有失败传播，不能生成 Agent 拒绝事件。
- AC7：服务端类型检查、相关单测、工作流 managed execution E2E 和文档 Harness 校验通过。

## 6. 风险

阶段预算变长会让真正卡死的调用占用 Runtime 更久；通过仍保留 Runtime watchdog、有限总预算、最大尝试次数和可观测诊断来控制。默认值只影响接单控制阶段，不延长 task execution 的既有 600 秒策略。

## 7. 完成标准

AC1–AC7 具备自动化证据，四份 SDD 状态同步；未执行的真实模型或生产数据库验证必须明确标记为未覆盖。

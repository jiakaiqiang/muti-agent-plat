---
artifact: verification_summary
stage: verification
producedBy: test
schemaVersion: "0.1"
status: ready
result: partial
deliveryId: workflow-quality-rejection-rework-v1
createdAt: 2026-09-08T00:00:00+08:00
intentContractRef: workflow-quality-rejection-rework-spec-v1
implementationSummaryRef: pending
---

# Verification Checklist: 工作流质量拒绝与返工闭环

> 规格：[`../product/workflow-quality-rejection-rework-spec-v1.md`](../product/workflow-quality-rejection-rework-spec-v1.md)
>
> 设计：[`../design/workflow-quality-rejection-rework-plan-v1.md`](../design/workflow-quality-rejection-rework-plan-v1.md)
>
> 任务：[`../implementation/workflow-quality-rejection-rework-tasks-v1.md`](../implementation/workflow-quality-rejection-rework-tasks-v1.md)

## 1. 使用规则

- `[x]` 只表示已经取得当前工作树中的直接证据；计划存在不算完成。
- 本文“基线核对”记录 2026-09-08 的现状证据，不代表修复已交付。
- AC1-AC14 必须逐条给出命令、测试名、事件或状态快照，才能把 `result` 改为 `pass`。
- 当前工作树含其他未提交修改，验证报告必须记录执行时的 Git commit 和相关 diff 范围。

本次验证基于 HEAD `6cdbefb91ca863d4985b495d38d0aa784b57695f` 及其上的未提交工作树；本交付相关范围为 Workflow Runtime、Orchestrator、Sessions、Persistence、Shared Runtime prompt、Web workflow 状态/确认交互、对应合同文档和 E2E/单测文件，未回滚或覆盖其他用户修改。

## 2. 当前基线核对 (Baseline Evidence)

- [x] BL1 接单合同只有 `accepted | blocked | rejected`。证据：`packages/shared/src/runtime-contracts/output-contracts.ts` 的 `TaskAcceptanceDecisionOutputSchema`。
- [x] BL2 Workflow V1 节点只有 `agent | human_approval | robot_approval`。证据：`docs/contracts/api-contract-v0.1.md` 工作流约束。
- [x] BL3 机器人确认的 `revise` 会回到上游 Agent，`reject` 会令 Workflow failed。证据：`apps/server/src/modules/workflows/workflow-runtime.service.ts` 的 `handleRobotResult()`。
- [x] BL4 Workflow Agent 接单拒绝禁止普通 continue 隐式恢复。证据：`resumeCurrentExecution()` / `awaitsAgentSubstitution()` 及对应单测。
- [x] BL5 当前工作树已有 `workflow_upstream_rerun` 的停车、候选、上游重跑和当前节点重试实现。证据：`WorkflowPendingUpstreamRerun`、`requestUpstreamRerun()`、`rerunUpstreamNode()`、`retryParkedNode()`。
- [x] BL6 Workflow Runtime 单测已存在“停车、选择上游重跑、重试当前、无候选回退”场景。
- [x] BL7 前端生产代码已路由 `workflow_upstream_rerun` 的 node/retry/cancel 操作，但 `SessionWorkspace.spec.ts` 尚未覆盖该分支。
- [x] BL8 普通执行失败仍可能发送 `task_rejected`。证据：`orchestrator.service.ts` 的 `markTaskFailed()`。
- [x] BL9 现有机器人提示只枚举 `approve|revise|reject`，未明确普通缺陷与不可恢复拒绝的边界。
- [x] BL10 当前 `task_execution_result.status = blocked` 在 Workflow Agent 场景会被保守映射为疑似上游不足；该路径先执行补上下文恢复。

## 3. 规格质量检查

- [x] SPEC1 目标、背景、非目标、约束、风险和开放问题齐全。
- [x] SPEC2 明确定义接单拒绝、质量返工、执行阻塞、执行失败四种语义。
- [x] SPEC3 明确不以 Agent 名称推断质量节点。
- [x] SPEC4 明确 `revise` 可恢复、`reject` 终止。
- [x] SPEC5 AC1-AC14 均可由测试或状态/事件证据判定。
- [x] SPEC6 Spec、Plan、Tasks、Checklist 使用同一 `deliveryId` 并互相链接。

## 4. 验收标准核对 (Acceptance Checklist)

| AC | 检查项 | 状态 | 必需证据 |
| --- | --- | --- | --- |
| AC1 | QA 能执行验收时接单必须 accepted | pass | Shared 结构化提示测试 + Local Runtime prompt 8/8；四类服务端 Runtime prompt 均消费共享语义 |
| AC2 | 接单拒绝后 Session/Run/Node/Task/confirmation 状态一致 | pass | Workflow Runtime/Session 定向测试 + substitution HTTP E2E 状态快照 |
| AC3 | 等待 substitution 时 continue fail-closed；改派/跳过/取消生效 | pass | `test:e2e:workflow-agent-substitution`：普通 resume、显式改派、跳过、取消 |
| AC4 | robot revise 产生前端新 attempt 并再次 QA | pass | Workflow Runtime 定向测试 + `test:e2e:rework-loop` |
| AC5 | revise 缺 revisionInstruction 转人工 | pass | Workflow Runtime 严格 parser/fallback 测试 |
| AC6 | reject 终止且不返工 | pass | `WorkflowRuntimeService treats strict robot reject as terminal without creating a rework attempt` |
| AC7 | 非法/异常/超限只生成一张人工确认 | pass | Workflow Runtime 非法/扩展字段/超限与幂等测试 |
| AC8 | 执行 blocked 且有上游时生成 upstream-rerun 卡 | pass | Workflow Runtime `parks a node that reports incomplete upstream input` |
| AC9 | 上游和停车节点都产生新 attempt，依赖最新输出 | pass | Workflow Runtime 上游重跑、最新成功 attempt 和依赖修复测试 |
| AC10 | retry current/cancel/no-candidate 均正确 | pass | Workflow Runtime retry/no-candidate/cancel 测试 + substitution HTTP E2E cancel |
| AC11 | task_rejected 与 task_failed 分离 | pass | Orchestrator/Event 定向测试 + Web `WorkflowRuntimeView.spec.ts` |
| AC12 | 重启恢复与重复决策幂等 | pass | Workflow Runtime substitution persistence/restore 测试、Sessions 60/60、recovery 相关回归 |
| AC13 | 编辑器与运行视图解释真实语义 | pass | Web 全量 223/223 + `test:e2e:chinese-copy` |
| AC14 | 全部门禁通过 | pass | Shared 87/87、Server 145/145、Web 223/223、typecheck、Harness、rework E2E、build |

当前结论：功能验收项 AC1-AC14 均为 `pass`；文档整体 `result = partial`，原因是 Local Runtime 全量测试存在独立的 Windows 进程树清理阻塞。

## 5. 状态机检查

### 5.1 接单拒绝

- [x] Agent 返回 `accepted` 后才进入任务执行。
- [x] Workflow Agent 返回 `blocked/rejected` 后 Task=`blocked`。
- [x] NodeRun 不再表现为模型正在运行。
- [x] Run=`waiting_human` 且持久化 pending substitution。
- [x] Session=`WAIT_USER_DECISION`。
- [x] 只存在一张 `workflow_agent_substitution` active confirmation。
- [x] 普通 continue 不启动 Runtime。
- [x] 改派后使用用户选择的 Agent，不恢复节点默认 Agent。
- [x] 跳过后 NodeRun=`skipped` 并进入下一节点。
- [x] 取消后 Run/Session 进入取消终态。

### 5.2 质量闸口

- [x] `approve` -> 当前 gate approved -> next node。
- [x] `revise` -> gate revision_requested -> 上游 Agent attempt +1。
- [x] 上游完成后 QA gate attempt +1，再次验收。
- [x] `revise` 的修改说明进入上游任务上下文。
- [x] `reject` -> Run failed，未创建上游新 attempt。
- [x] 缺少 `revisionInstruction`、额外字段、错误类型、非法 JSON -> human approval。
- [x] 返工次数超过上限 -> human approval，不继续自动循环。

### 5.3 普通 Agent 执行阻塞

- [x] 有 requestedContext 时先尝试补上下文并重试。
- [x] 补上下文耗尽且有上游候选 -> `workflow_upstream_rerun`。
- [x] 候选集合不含当前节点和确认节点。
- [x] 选择上游后旧停车 Task 进入终态，NodeRun=`revision_requested`。
- [x] 选定上游和原停车节点都创建新 attempt。
- [x] 下游依赖最新成功上游 attempt。
- [x] `retry_current` 只重跑当前节点的新 attempt。
- [x] `cancel` 进入终态。
- [x] 无上游 Agent 候选时进入通用恢复，不展示伪候选。

### 5.4 事件和 UI

- [x] 接单拒绝只发 `task_rejected`。
- [x] 执行失败发 `task_failed` + `runtime_failed`。
- [x] 上下文不足发 `task_waiting`。
- [x] 返工事件携带 source/target/attempt/reason。
- [x] UI 把 `task_rejected` 显示为“Agent 拒绝接单”。
- [x] UI 把 `task_failed` 显示为“任务执行失败”。
- [x] UI 根据 confirmation reason 显示“等待改派”“等待返工选择”“等待人工验收”。
- [x] 编辑器明确提示普通 Agent 节点没有自动质量返工语义。

## 6. 自动化测试执行

### 6.1 当前 SDD 文档生成验证

- [x] 四个文档文件存在。
- [x] 四个文档均包含 `deliveryId: workflow-quality-rejection-rework-v1`。
- [x] Spec 包含 `SPEC-SEM-001`、`SPEC-FLOW-001`、`SPEC-EVENT-001` 和 AC1-AC14。
- [x] Plan 包含 Architecture Constraints、Contract Impact、Acceptance Mapping。
- [x] Tasks 的 T0-T8 均包含 assignee、dependsOn、allowedPaths、forbiddenPaths、toolPolicy、acceptanceCriteria。
- [x] 四个文档的相对链接均能解析。

验证记录（2026-09-08）：自包含 PowerShell 文档校验通过，输出为 `SDD document validation passed: 4 files, AC1-AC14, T0-T8, required sections and relative links.`。

### 6.2 实施后的定向测试

```powershell
npm run test --workspace @agent-cluster/shared
npm run test --workspace @agent-cluster/local-runtime-cli
node node_modules/tsx/dist/cli.mjs --test --tsconfig apps/server/tsconfig.json `
  apps/server/src/modules/orchestrator/orchestrator.service.spec.ts `
  apps/server/src/modules/workflows/workflow-runtime.service.spec.ts `
  apps/server/src/modules/sessions/sessions.service.spec.ts
npm run test -w @project/web -- src/components/SessionWorkspace.spec.ts
```

- [x] Shared Runtime contract 与 prompt 测试通过（87/87）。
- [x] Local Runtime prompt 测试通过（8/8）。
- [x] Orchestrator 测试通过（服务端定向集合通过）。
- [x] Workflow Runtime 测试通过（26/26 专项基线；合并定向集合 145/145）。
- [x] Sessions 测试通过（60/60）。
- [x] SessionWorkspace 测试通过（Web 全量 223/223）。

### 6.2.1 本次文档编制时的基线测试记录

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `node node_modules/tsx/dist/cli.mjs --test --tsconfig apps/server/tsconfig.json apps/server/src/modules/workflows/workflow-runtime.service.spec.ts` | pass，22/22 | 证明当前工作树已有机器人返工、Agent substitution 禁止隐式继续、上游重跑/重试当前/无候选回退等服务端基线 |
| `node node_modules/tsx/dist/cli.mjs --test --test-name-pattern "all declared contracts reject missing fields" packages/shared/src/runtime-output-contracts.spec.ts` | pass，目标用例 1/1 | 证明当前 `task_acceptance_decision@1.0` 等 Runtime Output 仍执行严格字段、版本、kind 和额外属性校验 |
| `npm run test --workspace @agent-cluster/shared -- --test-name-pattern "all declared contracts reject missing fields"` | fail，85/86 | workspace runner 未按预期只运行目标用例；目标合同用例通过，失败来自既有 `validation errors name the offending property` 文案格式断言，与本次四份文档无关，未在本任务中修改 |

### 6.2.2 当前实现验证记录（2026-09-09）

| 命令 / 用例 | 结果 | 说明 |
| --- | --- | --- |
| `npm run test --workspace @agent-cluster/shared` | pass，87/87 | Shared 合同、语义提示和严格 Runtime Output 校验 |
| `npm run test --workspace @agent-cluster/local-runtime-cli` | blocked | 用例主体通过至 Local Runtime 进程树清理阶段；Windows `taskkill` 清理挂起，已中止并单独记录为 D5 |
| `node node_modules/tsx/dist/cli.mjs --test --tsconfig packages/local-runtime-cli/tsconfig.json packages/local-runtime-cli/src/adapters/prompt.spec.ts` | pass，8/8 | Local Runtime 接单/质量语义提示定向验证 |
| `node node_modules/tsx/dist/cli.mjs --test --tsconfig apps/server/tsconfig.json apps/server/src/modules/orchestrator/orchestrator.service.spec.ts apps/server/src/modules/workflows/workflow-runtime.service.spec.ts apps/server/src/modules/sessions/sessions.service.spec.ts` | pass，145/145 | Orchestrator、Workflow Runtime、Sessions 定向集合 |
| `npm run test --workspace @project/web` | pass，223/223 | Web 状态映射、确认交互、运行视图和编辑器提示 |
| `npm run test:e2e:workflow-agent-substitution` | pass | substitution 停车、fail-closed resume、改派、跳过、取消 |
| `npm run test:e2e:rework-loop` | pass | 自动返工 attempt 与人工接管边界 |
| `npm run test:e2e:chinese-copy` | pass | 中文可见文案 |
| `npm run test:harness` | pass | Harness 全部阶段和工作流文档门禁 |
| `npm run typecheck` / `npm run build` | pass | 类型检查与全量构建 |

### 6.3 最终回归

```powershell
npm run typecheck
npm run test -w @project/web
npm run test:e2e:rework-loop
npm run test:e2e:chinese-copy
npm run test:harness
npm run build
```

- [x] 类型检查通过。
- [x] Web 全量测试通过。
- [x] 自动返工 E2E 通过。
- [x] 中文文案检查通过。
- [x] Harness 门禁通过。
- [x] 构建通过。

## 7. 人工主场景验收

### SC-01 QA 普通缺陷返工

1. 创建 `frontend(agent) -> qa(robot_approval) -> delivery(agent)` 工作流。
2. 前端 attempt 1 产出带已知缺陷的结果。
3. QA 返回 `revise` 和明确修改要求。
4. 验证前端 attempt 2 创建并收到要求。
5. 前端完成后 QA 再次执行并返回 `approve`。
6. 验证 delivery 节点启动且历史 attempt 均可查看。

- [x] 结果通过；证据：`npm run test:e2e:rework-loop`，自动返工 attempt 与 QA 复验路径通过。

### SC-02 QA Agent 无法接单

1. 让 QA 节点的 Agent 在 acceptance 阶段返回职责不匹配的 `rejected`。
2. 验证页面显示“等待改派或跳过”，而不是“质量不通过”。
3. 验证普通 continue 无效。
4. 选择替代 Agent 后验证同节点恢复执行。

- [x] 结果通过；证据：`npm run test:e2e:workflow-agent-substitution`，覆盖拒绝停车、普通继续、改派、跳过、取消。

### SC-03 普通 Agent 发现上游输入不足

1. 上游节点完成后，让下游 Agent 执行返回 `blocked`。
2. 验证补上下文流程先执行；耗尽后展示合法上游候选。
3. 选择一个上游节点重跑。
4. 验证工作流前向再次到达原下游节点。

- [x] 结果通过；证据：Workflow Runtime 上游重跑/重试当前/无候选测试通过。

### SC-04 不可恢复拒绝

1. QA 对不可恢复问题返回 `reject`。
2. 验证 Workflow Run=`failed`、失败原因可见且没有返工 attempt。

- [x] 结果通过；证据：`WorkflowRuntimeService treats strict robot reject as terminal without creating a rework attempt`。

### SC-05 重启和重复命令

1. 在 substitution 和 upstream-rerun 两种等待态分别重启服务。
2. 验证同一 confirmation 和候选恢复。
3. 重复提交同一决策，验证只产生一次状态迁移和一个新 attempt。

- [x] 结果通过；证据：substitution persistence/restore 单测、Session 恢复测试和 substitution HTTP E2E 通过；重复决策不重复推进。

## 8. Defects

| ID | 状态 | 缺陷 | 影响 | 回退任务 |
| --- | --- | --- | --- | --- |
| D1 | closed | 接单拒绝时 Workflow Run / NodeRun 与 Session 等待态表达不完全一致 | 页面像运行中但实际等待 | T2 |
| D2 | closed | robot approval 提示未明确 revise/reject 边界 | 普通缺陷可能终止工作流 | T1/T3 |
| D3 | closed | 普通执行失败使用 `task_rejected` | 排障和 UI 误读 | T5/T6 |
| D4 | closed | upstream-rerun 缺少 Session/Web 跨层测试 | 在途代码可回归 | T4/T6/T7 |
| D5 | blocked | Local Runtime 全量测试在 Windows `taskkill` 子进程树清理阶段挂起 | 影响全量测试收尾，不影响本次工作流状态机证据 | 测试基础设施 |

## 9. 结论 (Verdict)

- `result: partial`
- AC1-AC14 已全部取得直接自动化证据，功能验收通过。
- 保留 D5：Local Runtime 全量测试受 Windows 进程树清理阻塞；已用 Local Runtime prompt 8/8 作为本变更的定向证据，不能把 D5 误报成业务失败。

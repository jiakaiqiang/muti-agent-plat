---
artifact: task_plan
stage: planning
producedBy: coordinator
schemaVersion: "0.1"
status: ready
deliveryId: workflow-quality-rejection-rework-v1
createdAt: 2026-09-08T00:00:00+08:00
designPlanRef: workflow-quality-rejection-rework-plan-v1
---

# Task Plan: 工作流质量拒绝与返工闭环

> 需求：[`../product/workflow-quality-rejection-rework-spec-v1.md`](../product/workflow-quality-rejection-rework-spec-v1.md)
>
> 设计：[`../design/workflow-quality-rejection-rework-plan-v1.md`](../design/workflow-quality-rejection-rework-plan-v1.md)
>
> 验收：[`../quality/workflow-quality-rejection-rework-checklist-v1.md`](../quality/workflow-quality-rejection-rework-checklist-v1.md)

## 1. 执行原则

- 先测试后实现：每个行为任务先增加能在旧逻辑上失败的定向测试。
- 当前工作树已包含未提交的 `workflow_upstream_rerun` 代码；T0 必须先做差异审计，后续只补齐缺口。
- 不以 Agent 名称或角色文本判断质量节点。
- 不修改 `task_acceptance_decision@1.0` 和 `task_execution_result@1.0` 的结构。
- 每批修改只触及任务声明的 `allowedPaths`；发现需要越界时回到 Design，而不是顺手修改。

## 2. 任务拆解 (Task Breakdown)

### T0 固化问题复现与在途实现基线

- 负责 Agent (assignee): test
- 依赖 (dependsOn): []
- allowedPaths:
  - `apps/server/src/modules/orchestrator/orchestrator.service.spec.ts`
  - `apps/server/src/modules/workflows/workflow-runtime.service.spec.ts`
  - `apps/server/src/modules/sessions/sessions.service.spec.ts`
  - `apps/web/src/components/SessionWorkspace.spec.ts`
  - `apps/web/src/stores/*.spec.ts`
- forbiddenPaths:
  - `apps/server/src/**/*.ts`（除测试文件）
  - `apps/web/src/**/*.vue`
  - `packages/shared/src/**/*.ts`（除测试文件）
- toolPolicy:
  - `tool.file_write: required`
  - `tool.command_run: required`
- 工作项：
  - [x] 增加 QA 作为普通 Agent 在接单阶段返回 rejected 的复现，断言现状进入 substitution 而非返工。
  - [x] 增加 robot approval 的 approve/revise/reject 三分支测试，断言 revise 回到前端并再次经过 QA。
  - [x] 增加执行 blocked -> upstream-rerun、retry current、cancel、无候选四类测试。
  - [x] 增加事件误分类复现：普通执行失败当前会产生 `task_rejected`。
  - [x] 记录当前在途代码已经覆盖和尚未覆盖的用例，避免重复实现。
- acceptanceCriteria:
  - [x] 测试能分别识别接单拒绝、质量返工、执行阻塞和执行失败。
  - [x] 至少一个测试在修复前因状态/事件语义不一致而失败。

### T1 统一接单阶段语义提示

- 负责 Agent (assignee): backend
- 依赖 (dependsOn): [T0]
- allowedPaths:
  - `packages/shared/src/runtime-contracts/structured-output-instructions.ts`
  - `packages/shared/src/structured-output-instructions.spec.ts`
  - `packages/local-runtime-cli/src/adapters/prompt.ts`
  - `packages/local-runtime-cli/src/adapters/prompt.spec.ts`
  - `apps/server/src/modules/runtimes/*runtime*.ts`
  - `apps/server/src/modules/runtimes/*runtime*.spec.ts`
- forbiddenPaths:
  - `packages/shared/src/runtime-contracts/output-contracts.ts`
  - `apps/server/src/modules/workflows/**`
  - `apps/web/**`
- toolPolicy:
  - `tool.file_write: required`
  - `tool.command_run: required`
- 工作项：
  - [x] 在 Shared 中建立 `task_acceptance_decision` 语义说明单一来源。
  - [x] 明确“能执行评审即 accepted；质量问题在执行/评审阶段报告”。
  - [x] 所有本地和服务端 Runtime prompt 消费同一语义，删除重复冲突文案。
  - [x] 覆盖 Claude、Codex、Generic LLM、Local Runtime prompt 测试。
- acceptanceCriteria:
  - [x] AC1 通过。
  - [x] Runtime output schema hash 和 `task_acceptance_decision@1.0` 字段不变。

### T2 建立 Workflow Agent substitution 显式停车状态

- 负责 Agent (assignee): backend
- 依赖 (dependsOn): [T0]
- allowedPaths:
  - `packages/shared/src/contracts.ts`
  - `apps/server/src/modules/workflows/workflow-runtime.service.ts`
  - `apps/server/src/modules/workflows/workflow-runtime.service.spec.ts`
  - `apps/server/src/modules/orchestrator/orchestrator.service.ts`
  - `apps/server/src/modules/orchestrator/orchestrator.service.spec.ts`
  - `apps/server/src/modules/sessions/sessions.service.ts`
  - `apps/server/src/modules/sessions/sessions.service.spec.ts`
  - `apps/server/src/modules/persistence/**`
- forbiddenPaths:
  - `packages/shared/src/runtime-contracts/output-contracts.ts`
  - `apps/web/**`
  - `docs/product/**`
- toolPolicy:
  - `tool.file_write: required`
  - `tool.command_run: required`
- 工作项：
  - [x] 新增可持久化的 pending Agent substitution 数据。
  - [x] 接单拒绝后同步 Task、NodeRun、Run、Session 和 confirmation 状态。
  - [x] 改派、跳过、取消清除 pending；普通 continue 保持 fail-closed。
  - [x] 恢复旧状态时兼容字段缺失；重启后恢复同一 active confirmation。
  - [x] 校验重复/过期 confirmation 不产生第二次推进。
- acceptanceCriteria:
  - [x] AC2、AC3、AC12 通过。
  - [x] 历史状态文件无需破坏性迁移即可加载。

### T3 强化机器人质量决策和返工边界

- 负责 Agent (assignee): backend
- 依赖 (dependsOn): [T0]
- allowedPaths:
  - `apps/server/src/modules/workflows/workflow-runtime.service.ts`
  - `apps/server/src/modules/workflows/workflow-runtime.service.spec.ts`
  - `packages/shared/src/contracts.ts`
  - `docs/contracts/api-contract-v0.1.md`
- forbiddenPaths:
  - `packages/shared/src/runtime-contracts/output-contracts.ts`
  - `apps/web/**`
  - `apps/server/src/modules/orchestrator/**`
- toolPolicy:
  - `tool.file_write: required`
  - `tool.command_run: required`
- 工作项：
  - [x] 把机器人决策解析抽为严格、可单测的局部 validator。
  - [x] 要求 revise 必须带非空 `revisionInstruction`，拒绝额外字段和错误类型。
  - [x] 提示明确：可修复缺陷用 revise，reject 会终止工作流。
  - [x] 断言 revise 生成上游新 attempt，并在完成后重新执行 QA 节点。
  - [x] 断言 reject 不生成返工 attempt。
  - [x] 非法输出、运行异常和返工超限只创建一个人工确认。
- acceptanceCriteria:
  - [x] AC4-AC7 通过。
  - [x] 既有人工确认 approve/revise/cancel 行为不回归。

### T4 审计并补齐普通 Agent 上游重跑回退

- 负责 Agent (assignee): backend
- 依赖 (dependsOn): [T0, T2]
- allowedPaths:
  - `packages/shared/src/contracts.ts`
  - `apps/server/src/modules/orchestrator/orchestrator.service.ts`
  - `apps/server/src/modules/orchestrator/orchestrator.service.spec.ts`
  - `apps/server/src/modules/workflows/workflow-runtime.service.ts`
  - `apps/server/src/modules/workflows/workflow-runtime.service.spec.ts`
  - `apps/server/src/modules/sessions/sessions.controller.ts`
  - `apps/server/src/modules/sessions/sessions.service.ts`
  - `apps/server/src/modules/sessions/sessions.service.spec.ts`
- forbiddenPaths:
  - `packages/shared/src/runtime-contracts/output-contracts.ts`
  - `apps/web/**`
- toolPolicy:
  - `tool.file_write: required`
  - `tool.command_run: required`
- 工作项：
  - [x] 对照当前未提交实现确认候选只来自真实上游 Agent 节点。
  - [x] 保持补上下文优先，上游重跑只在自动补读耗尽后出现。
  - [x] 确保停车任务进入终态，避免 Post Review 再驱动旧任务。
  - [x] 补齐选择上游、重试当前、取消、无候选、非法目标和重复 confirmation 测试。
  - [x] 文案使用“上游输入不足/选择返工节点”，不把所有 blocked 断言为质量失败。
- acceptanceCriteria:
  - [x] AC8-AC10、AC12 通过。

### T5 拆分接单拒绝与执行失败事件

- 负责 Agent (assignee): backend
- 依赖 (dependsOn): [T0]
- allowedPaths:
  - `packages/shared/src/contracts.ts`
  - `apps/server/src/modules/orchestrator/orchestrator.service.ts`
  - `apps/server/src/modules/orchestrator/orchestrator.service.spec.ts`
  - `apps/server/src/modules/events/**`
  - `docs/contracts/event-contract-v0.1.md`
- forbiddenPaths:
  - `packages/shared/src/runtime-contracts/output-contracts.ts`
  - `apps/web/**`
- toolPolicy:
  - `tool.file_write: required`
  - `tool.command_run: required`
- 工作项：
  - [x] 加法新增 `task_failed` 事件类型。
  - [x] `markTaskFailed()` 发送 `task_failed`；接单 rejected 才发送 `task_rejected`。
  - [x] 上下文不足继续使用 `task_waiting`。
  - [x] 更新事件合同和服务端事件测试。
- acceptanceCriteria:
  - [x] AC11 服务端部分通过。
  - [x] 现有 SSE、事件持久化和幂等测试不回归。

### T6 前端决策路由、状态展示和配置提示

- 负责 Agent (assignee): frontend
- 依赖 (dependsOn): [T2, T3, T4, T5]
- allowedPaths:
  - `apps/web/src/types/contracts.ts`
  - `apps/web/src/stores/session.ts`
  - `apps/web/src/stores/event.ts`
  - `apps/web/src/stores/*.spec.ts`
  - `apps/web/src/components/SessionWorkspace.vue`
  - `apps/web/src/components/SessionWorkspace.spec.ts`
  - `apps/web/src/components/WorkflowRuntimeView.vue`
  - `apps/web/src/components/workflow/**`
  - `apps/web/src/styles.css`
- forbiddenPaths:
  - `apps/server/**`
  - `packages/shared/src/runtime-contracts/**`
- toolPolicy:
  - `tool.file_write: required`
  - `tool.command_run: required`
- 工作项：
  - [x] 映射 `task_failed` 为执行失败，`task_rejected` 为拒绝接单。
  - [x] 为 `workflow_upstream_rerun` 增加组件/路由测试，覆盖 node、retry_current、cancel。
  - [x] 为 `workflow_agent_substitution` 覆盖改派、跳过和取消。
  - [x] 运行视图根据 confirmation reason 显示具体等待状态。
  - [x] 编辑器说明普通 Agent 与确认节点的差异，并解释 revise/reject。
- acceptanceCriteria:
  - [x] AC3、AC10、AC11、AC13 的前端部分通过。
  - [x] 中文可见文案检查通过。

### T7 合同、恢复与跨层集成验证

- 负责 Agent (assignee): test
- 依赖 (dependsOn): [T1, T2, T3, T4, T5, T6]
- allowedPaths:
  - `docs/contracts/**`
  - `docs/quality/workflow-quality-rejection-rework-checklist-v1.md`
  - `tests/e2e/**`
  - `tests/harness-engineering/**`
  - `package.json`
- forbiddenPaths:
  - `apps/server/src/**/*.ts`（除测试修正需回退相应实现任务）
  - `apps/web/src/**/*.vue`
- toolPolicy:
  - `tool.file_write: required`
  - `tool.command_run: required`
- 工作项：
  - [x] 更新 Runtime/Event/Data/API/UI State 合同说明。
  - [x] 增加主场景 E2E：frontend attempt 1 -> QA revise -> frontend attempt 2 -> QA approve -> next node。
  - [x] 增加接单拒绝 substitution HTTP E2E，并以 Workflow Runtime 持久化恢复测试覆盖服务重启语义。
  - [x] 增加事件语义门禁，禁止 `markTaskFailed` 再发送 `task_rejected`。
  - [x] 执行质量清单中的全部自动化命令，回填证据。
- acceptanceCriteria:
  - [x] AC1-AC14 全部有 pass/fail/blocked 证据。
  - [x] 质量清单已回填为 feature acceptance pass；外部测试基础设施阻塞单独记录。

### T8 Review 与交付

- 负责 Agent (assignee): review
- 依赖 (dependsOn): [T7]
- allowedPaths:
  - `docs/quality/workflow-quality-rejection-rework-checklist-v1.md`
  - `docs/implementation/**`
- forbiddenPaths:
  - `apps/**`
  - `packages/**`
- toolPolicy:
  - `tool.file_write: on-demand`
  - `tool.command_run: on-demand`
- 工作项：
  - [x] 核对没有以名称启发式识别 QA。
  - [x] 核对 revise/reject、blocked/rejected、task_failed/task_rejected 四组语义未混用。
  - [x] 核对等待状态、恢复、幂等和历史 attempt 不变量。
  - [x] 核对范围未扩展为新节点类型或 RuntimeOutput 版本升级。
- acceptanceCriteria:
  - [x] 无 P0/P1 产品问题；仅保留 Windows 测试进程树清理阻塞。
  - [x] 最终交付包含改动、验证、剩余风险和回滚点。

## 3. 依赖关系 (Dependency Graph)

```text
T0
├── T1 ───────────────┐
├── T2 ──┐            │
├── T3 ──┼── T6 ──────┼── T7 ── T8
├── T4 ──┤            │
└── T5 ──┘            │
                      ┘
```

关键路径：`T0 -> T2/T3/T4/T5 -> T6 -> T7 -> T8`。

T1 可与 T2-T5 并行，但合并前必须确认所有 Runtime 路径都使用同一 acceptance 语义。

## 4. 范围与权限总览 (Scope & Policy Summary)

允许触及：

- `packages/shared/src/runtime-contracts/` 的提示构建和测试，但不修改两个既有输出 Schema。
- `packages/shared/src/contracts.ts` 的 Workflow pending 数据与事件 union。
- Workflow、Orchestrator、Sessions、Persistence 的状态和恢复逻辑。
- Web 的状态映射、确认操作和工作流节点帮助文案。
- 相关合同、定向测试、E2E 和 Harness 门禁。

禁止触及：

- 新增 `quality_gate` 节点。
- 通过 Agent 名称或角色关键词改变状态机。
- 修改 DingTalk、通知、部署或发布。
- 删除或重写历史 Workflow attempt。
- 为通过测试放宽严格 Runtime JSON Schema。

高风险能力：

- `tool.file_write`：仅限上述 allowedPaths。
- `tool.command_run`：仅用于格式检查、类型检查和测试；不启动外部服务、不部署。
- Git commit/push/release：不在本计划授权范围内，需要用户另行确认。

## 5. 测试命令

定向合同与服务端：

```powershell
npm run test --workspace @agent-cluster/shared
npm run test --workspace @agent-cluster/local-runtime-cli
node node_modules/tsx/dist/cli.mjs --test --tsconfig apps/server/tsconfig.json `
  apps/server/src/modules/orchestrator/orchestrator.service.spec.ts `
  apps/server/src/modules/workflows/workflow-runtime.service.spec.ts `
  apps/server/src/modules/sessions/sessions.service.spec.ts
```

前端：

```powershell
npm run test -w @project/web -- src/components/SessionWorkspace.spec.ts
npm run test -w @project/web
npm run test:e2e:chinese-copy
```

最终门禁：

```powershell
npm run typecheck
npm run test:harness
npm run test:e2e:rework-loop
npm run build
```

## 6. 退出规则

- 任一 AC 没有直接证据时，不得把清单标记为 pass。
- 任一接单拒绝仍能被普通 continue 隐式恢复时，回退 T2。
- 任一普通质量缺陷触发 `reject` 并终止时，回退 T1/T3。
- 任一执行失败仍产生 `task_rejected` 时，回退 T5/T6。
- 任一重跑复用旧 attempt 或依赖旧上游任务时，回退 T3/T4。

---
artifact: task_plan
stage: implementation
producedBy: implementation
schemaVersion: "0.1"
status: implemented_with_deferred_follow_up
deliveryId: task-acceptance-timeout-reliability-v1
intentContractRef: task-acceptance-timeout-reliability-v1
designPlanRef: task-acceptance-timeout-reliability-v1
createdAt: 2026-09-21
---

# 群聊工作流接单超时可靠性 Tasks v1

## 1. 实施任务

- [x] T1：让 `operationPolicy` 使用合法阶段配置，并为 `task_acceptance` 增加 300 秒有限默认值。
- [x] T2：为显式接单 preflight 增加稳定诊断码，保留原兼容函数。
- [x] T3：在 orchestrator 中保留 evidence gate，同时把 preflight/evidence 回退原因注入受控 Runtime context。
- [x] T4：增加配置、策略、preflight、orchestrator 回归测试。
- [x] T5：运行工作流 E2E、类型检查和 Harness；回填实际证据与剩余风险。

## 2. 文件边界

允许修改：

- `apps/server/src/common/runtime-config.ts`（如需导出策略默认值）及其 spec。
- `apps/server/src/modules/runtimes/logical-operation-store.ts` 及其 spec。
- `apps/server/src/modules/orchestrator/task-acceptance-preflight.ts` 及其 spec。
- `apps/server/src/modules/orchestrator/orchestrator.service.ts` 及其已有 spec。
- `.env.example`。
- 本四份 SDD 文档。

禁止修改：共享 Runtime output 合同、WorkflowRun 状态迁移、停止/返工逻辑、前端和真实数据库。

## 3. 任务级 Definition of Done

每个任务都必须有：失败前提、代码变化、自动化断言和命令证据。禁止通过删除 evidence gate 或吞掉 `RUNTIME_TIMEOUT` 让测试变绿。

## 4. 实施证据

- `apps/server/src/modules/runtimes/logical-operation-store.spec.ts`：合法配置、默认值、零值诊断三条策略回归。
- `apps/server/src/modules/orchestrator/task-acceptance-preflight.spec.ts`：reason codes 与旧 helper 兼容回归。
- `apps/server/src/modules/orchestrator/orchestrator.service.spec.ts`：证据不足时保留模型回退，并验证 `EVIDENCE_GATE:evidence-empty` 进入 Runtime context。
- server 全量单测：1658 tests / 1641 passed / 17 skipped / 0 failed。
- workflow managed execution smoke、Harness、`git diff --check`：通过。

---
artifact: verification_checklist
stage: quality
producedBy: quality
schemaVersion: "0.1"
status: implemented_with_deferred_follow_up
deliveryId: task-acceptance-timeout-reliability-v1
intentContractRef: task-acceptance-timeout-reliability-v1
designPlanRef: task-acceptance-timeout-reliability-v1
taskPlanRef: task-acceptance-timeout-reliability-v1
createdAt: 2026-09-21
---

# 群聊工作流接单超时可靠性 Checklist v1

## 验收矩阵

| AC | 证据要求 | 状态 |
| --- | --- | --- |
| AC1 | 合法 `PHASE_TIMEOUT_TASK_ACCEPTANCE_MS` 覆盖测试 | ☑ `logical-operation-store.spec.ts` |
| AC2 | 默认 300 秒、零/非法值和诊断码测试 | ☑ `logical-operation-store.spec.ts` |
| AC3 | evidence gate 失败仍模型回退，context 有稳定原因码 | ☑ `orchestrator.service.spec.ts` |
| AC4 | evidence 完整的显式工作流任务不启动模型 | ☑ 既有 orchestrator preflight 回归 |
| AC5 | 接单结果继续既有执行路径，合同不变 | ☑ server 全量单测、workflow E2E |
| AC6 | 超时仍映射为 `phase_timeout`/`RUNTIME_TIMEOUT`，不产生 `task_rejected` | ☑ 既有 Runtime/orchestrator timeout 回归；本专项未调用真实慢模型 |
| AC7 | server typecheck、server tests、workflow E2E、Harness、diff check | ☑ 全部通过 |

## 必查边界

- 不调用真实模型；E2E 使用隔离 mock/测试服务。
- 不修改 WorkflowRun、Session 停止和返工语义。
- 不把诊断码写入用户消息或事件正文。
- 若真实 Claude/本地 Runtime 仍在 300 秒内无法返回结构化结果，应作为供应商/提示性能问题单独记录，而不是继续无限延长预算。

## 交付回填

实施完成后填写每个 AC 的实际命令、退出码、测试数量和未覆盖项；在未完成项存在时保持 `pending` 或 `implemented_with_deferred_follow_up`，不得直接标记全部完成。

## 实际验证记录（2026-09-21）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck --workspace @agent-cluster/server` | 通过 |
| `npm run test --workspace @agent-cluster/server` | 通过：1658 tests，1641 passed，17 skipped，0 failed |
| `npm run test:e2e:workflow-managed-execution` | 通过：`workflow managed execution smoke ok` |
| `npm run test:harness` | 通过：各阶段 Harness conformance 全部通过 |
| `git diff --check` | 通过；仅工作树既有 LF/CRLF 提示 |

未覆盖：真实 Claude/local_bridge 慢调用的 300 秒现场采样、生产数据库和部署验证；这些不应在本地 mock 证据中冒充已通过。

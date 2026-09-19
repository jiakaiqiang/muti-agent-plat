# 阶段 4：主 Agent 文档、精确确认与所选工作流交接 — Checklist v1

> 日期：2026-09-16（2026-09-19 实施并填证据）
> 状态：已实现并于 2026-09-19 通过用户验收；顺延缺口见阶段 5 Tasks 承接说明。
> 依赖：阶段 3 已于 2026-09-19 验收通过，复用 1 与 2A～2C 的隔离、预算、记忆和缓存。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-4-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-4-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-4-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-4-checklist-v1.md)

## 1. 验收矩阵

| 验收 ID | 关联任务 | 场景与预期 | 状态/证据 |
| --- | --- | --- | --- |
| P4-AC1 | P4-T1、P4-T6 | 专家提出修订后，只有主 Agent 发布的新版本进入正式确认；文档引用当前需求与有效来源。 | 通过（单元+E2E）：`requirement-document-contracts.spec.ts` 7/7、`requirement-document-store.spec.ts` 8/8、`requirement-document.spec.ts`（发布引用 brief/决策/综合，正文不可变）；E2E `npm run test:e2e:requirement-document-handoff` 断言发布事件带 documentId/contentHash/fingerprint。**未覆盖**：「专家自行提出修订」由阶段 3 委派产生，本阶段只验证发布者唯一 |
| P4-AC2 | P4-T1、P4-T2、P4-T5、P4-T6 | 用户打开 v1/v2 能看到准确改动及历史内容；不存在显示 v1、实际确认 v2 的情况。 | 通过（单元，双端）：`collaboration-presentation.spec.ts` 11/11（时间线倒序、current、staleness 三分支）、web `requirementDocumentPresentation.spec.ts` 5/5（内联 add/remove）、desktop 同名 6/6（左右并排，复用既有 historyDiffModel）。确认绑定 contentHash，显示与确认同源。**未覆盖**：真实浏览器渲染快照 |
| P4-AC3 | P4-T2、P4-T4、P4-T6 | 两端同时确认只提交一次；旧卡片不能批准新文档或另一需求；未确认需求不能进入执行。 | 通过（单元+E2E）：`sessions.service.spec.ts` 过期拒绝并回传当前版本、重放幂等；PG `workflow_start_requests` 跨实例唯一（14/14）；E2E 重放确认返回同一 brief 且不推进状态、未确认 brief 不能选流程。**契约说明**：AC3 的「只提交一次」实现为重放返回首次结果（幂等），不是第二次点击报错 |
| P4-AC4 | P4-T3、P4-T5、P4-T6 | 确认需求前点击流程仅可预览；选择已下架/不兼容版本返回解释，不自动换图。 | 通过（单元+E2E）：`selectWorkflow` 仅 published 且需已确认 brief；`definitionHash` 在选择时捕获、bootstrap 恢复透传、`start()` 不一致即 `WORKFLOW_VERSION_CHANGED`（`workflow-runtime.service.spec.ts` 32/32 含该拒绝用例）；E2E 同一确认指向另一流程被拒。**未覆盖**：「已下架」是选择后 unpublish 的时序竞争，当前只验证 published 校验与 hash 绑定 |
| P4-AC5 | P4-T3、P4-T4、P4-T6 | 所选图缺质量 Agent 时不启动半条流程；完成用户映射后按同一确认范围校验再启动。 | 通过（单元+E2E）：`workflow-member-mapping.spec.ts` 4/4；`selectWorkflow` 不再静默并入 `involvedAgentIds`，缺成员抛 `capability_mapping_required` 并发映射卡（卡锁 definitionHash），批准后同一确认按锁定版本启动；disabled Agent 邀请无效仍 blocked；E2E 断言 0 次 start、状态仍 `WAIT_WORKFLOW_SELECT` |
| P4-AC6 | P4-T4、P4-T6 | 提交成功后网络断开/派发前崩溃，再次点击或重启最多一个有效运行；相同请求不同载荷被拒绝。 | 通过（单元+PG+E2E）：`workflow-start-contracts.spec.ts` 6/6（逻辑键含 documentRevision + definitionHash）、`workflow-start-store.spec.ts` 11/11（提交/派发分离、单一领取、崩溃后 reclaim 不分叉、完成后不二次领取）、PG 跨实例一请求一行并只派发一次；E2E 重放选择解析到同一 run。**未覆盖**：真实进程级崩溃注入（当前为重建 store 模拟重启） |
| P4-AC7 | P4-T5、P4-T6 | 质量拒绝进入可解释返工或主 Agent 决策，不能仅卡在非终态；专家不能改图绕过质量节点。 | 通过（单元）：返工目标改为按发布图的边回溯（原实现按节点数组顺序，与 `upstreamRerunCandidates` 不一致）；无合法返工边不再 `finishRun('failed')`，改为 `parkForRevisionHandoff` 停在 `waiting_human` 并发 `workflow_gate_requested` + 确认卡，二次决定被拒（`workflow-runtime.service.spec.ts` 3 条新用例）。图与节点顺序仍只来自发布快照，Agent 无法改图 |

## 2. 现有验证入口

以下命令从仓库根目录运行，是后续实施回归入口，本次文档交付未执行这些业务测试。运行 E2E 前检查脚本使用隔离环境/mock，不能默认连接当前业务服务或真实模型。

```powershell
npm run test:e2e:requirement-document-handoff
npm run test:e2e:memory-confirm
npm run test:e2e:workflow-managed-execution
npm run test:e2e:workflow-agent-substitution
npm run test:e2e:rework-loop
```

本阶段新增/实际执行（2026-09-19，仓库根目录）：

```powershell
npm run typecheck; npm run test; npm run test:harness; npm run build
npm run test:e2e:requirement-document-handoff
$env:RELATIONAL_TEST_DATABASE_URL='postgres://...@127.0.0.1:5432/<隔离库>'
node node_modules/tsx/dist/cli.mjs --test apps/server/src/modules/persistence/relational/postgres-migration-runner.integration.spec.ts
```

相关既有测试：

- [workflow-session-flow.spec.ts](../../apps/server/src/modules/sessions/workflow-session-flow.spec.ts)
- [workflow-runtime.service.spec.ts](../../apps/server/src/modules/workflows/workflow-runtime.service.spec.ts)
- [ConfirmationCard.spec.ts](../../apps/desktop/renderer/components/ConfirmationCard.spec.ts)

## 3. 必须补充的测试

- [ ] 需求/文档/流程三版本精确确认合同测试（待新增；不能用现有冒烟脚本代替）。
- [ ] 双端重复确认与启动派发崩溃 PostgreSQL 集成测试（待新增；不能用现有冒烟脚本代替）。

## 4. 跨阶段安全复核

- [ ] file/PostgreSQL 行为对等；涉及并发的场景用独立 PostgreSQL 和独立连接/实例验证，不只使用 mock。
- [ ] 重复、乱序、重启、取消/删除、迟到结果均不破坏幂等与版本边界。
- [ ] 未确认范围、高风险动作、未知停止状态均不会被摘要/缓存/模型判断绕过。
- [ ] 双端保持同一业务状态和各自样式；不依赖刷新才能修复状态。
- [ ] 无凭据、完整敏感提示或用户私有正文进入测试报告与指标。
- [ ] 所有文档/合同更新与实际实现一致，回退方案已演练或明确未执行。

## 5. 证据记录

每个结果记录：日期、构建/工作树版本、执行环境、fixture、命令、退出码、观察结果和证据路径；未执行/跳过必须写原因，不能记作通过。真实模型验证与 stub 验证分开记录。

阶段通过条件：当前文档确认后按用户所选流程唯一启动，过期/重复操作安全；Diff、成员映射和质量返工可追溯。

本次初始状态：所有业务验收待验证；只完成 SDD 文档编制，不代表功能已经开发或上线。

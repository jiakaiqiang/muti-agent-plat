# 阶段 6：双端综合验收、长会话成本评测与受控上线 — Checklist v1

> 日期：2026-09-16
> 状态：实施中（2026-09-20）；基础设施和部分证据已完成，阶段仍未通过退出门禁。
> 依赖：阶段 0、1、2A、2B、2C、3、4、5 均有独立验收记录；跨阶段追踪中的 partial/not-executed 项继续显式保留，不作为已完成证据。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-6-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-6-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-6-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-6-checklist-v1.md)

## 1. 验收矩阵

| 验收 ID | 关联任务 | 场景与预期 | 状态/证据 |
| --- | --- | --- | --- |
| P6-AC1 | P6-T1、P6-T6 | 追踪矩阵无孤立 AC/Task，任何缺少必须证据的阶段不能标完成。 | 通过（Harness：9 阶段、61 AC、54 Task；rollback 证据和发布门禁已记录） |
| P6-AC2 | P6-T2、P6-T5 | 所有模型调用通过完整预算；无关历史从 10 增至 100 个需求时，固定当前任务的受控输入不超过 1.2 倍基线且不超过配置上限。 | 部分通过（fixture 1.0 倍；真实模型完整调用与质量未执行） |
| P6-AC3 | P6-T2、P6-T5 | 固定验收集中安全/授权用例 100% 正确；召回/歧义分类每条有预期，失败样本不得用缓存命中掩盖。 | 部分通过（早期召回/同名澄清/修订排除通过；模型质量未测） |
| P6-AC4 | P6-T3 | 每个竞争场景业务效果最多一次；未知停止持续阻塞；重启不增加未授权模型调用。 | 通过（组合对等入口：6 个真实 file backend 场景、随机临时 PostgreSQL 15/15、真实子进程 claim/reclaim；迁移 projection 差异 fail-closed） |
| P6-AC5 | P6-T4 | 两端同时操作同一会话，旧快照不回退新状态；另一会话不受停止/删除影响；桌面布局不替换 Web 样式。 | 通过（Web/Desktop 呈现、桌面渲染、workflow managed、rework-loop、变更队列组合验收通过） |
| P6-AC6 | P6-T5 | Provider 返回的输入/输出、缓存读写、调用数和 TTFT/总耗时可采集；缺失字段标 unknown，未配置价格不得阻断正常流程。美元计费与账单核对不属于本阶段范围。 | 通过（流式 `include_usage`、OpenAI/Anthropic 兼容缓存字段、TTFT/总耗时和缺失字段 unknown 均有 fake Provider/定向回归；发布预检验证价格未配置不构成阻断） |
| P6-AC7 | P6-T6 | 故障演练能停用新入口而不清库；旧构建不兼容时执行向前修复，生产上线有单独授权记录。 | 部分通过（隔离 PostgreSQL rollback/reapply 已通过；策略准入、构建身份和正式发布授权仍未执行） |

## 2. 现有验证入口

以下命令从仓库根目录运行，是阶段 6 的专项回归入口。E2E 使用隔离环境/mock；未配置的 PostgreSQL、真实模型和发布操作不会被自动执行。

```powershell
npm run typecheck
npm run test
npm run test:harness
npm run build
npm run test:e2e:main-chain
npm run test:e2e:client-presentation
npm run test:e2e:desktop-render
npm run test:e2e:workflow-managed-execution
npm run test:e2e:rework-loop
npm run test:e2e:token-budget
npm run test:harness:main-agent-phase6
npm run phase-6:traceability
npm run test:e2e:phase-6-long-session
npm run test:e2e:phase-6-fault-matrix
npm run test:e2e:phase-6-crash-restart
npm run test:e2e:phase-6-postgres
npm run test:e2e:phase-6-backend-parity
npm run test:e2e:phase-6-migration-postgres
npm run test:e2e:phase-6-release-preflight
npm run phase-6:release-preflight
npm run test:e2e:phase-6-cost-report
npm run test:e2e:phase-6-live-model-preflight
npm run phase-6:live-model-preflight
npm run test:e2e:phase-6-live-model-evaluation
# 仅在取得独立真实模型授权并配置上限后，单独手动执行：
# npm run phase-6:live-model-evaluation
npm run test:e2e:phase-6-safety-gates
npm run test:e2e:phase-6-migration
npm run test:e2e:phase-6-dual-client
```

相关既有测试：

- [postgres-migration-runner.integration.spec.ts](../../apps/server/src/modules/persistence/relational/postgres-migration-runner.integration.spec.ts)
- [WorkspaceSync.spec.ts](../../apps/web/src/components/WorkspaceSync.spec.ts)
- [client-presentation-smoke.mjs](../../tests/e2e/client-presentation-smoke.mjs)

## 3. 必须补充的测试

- [x] 主 Agent 全链路组合 E2E（`npm run test:e2e:phase-6-dual-client`；返工预算结算修复后通过）。
- [x] 百需求千消息预算/召回/缓存评测（确定性 fixture 已通过；真实模型质量仍未执行）。
- [x] 讨论/确认/删除故障矩阵（6 个真实 file backend 组件级场景 + 隔离 PostgreSQL 15/15；PostgreSQL 使用显式 `RELATIONAL_TEST_DATABASE_URL`）。

## 4. 跨阶段安全复核

- [x] file/PostgreSQL 行为对等（`test:e2e:phase-6-backend-parity` 自动创建随机临时库，串行通过 file 6/6、PostgreSQL 15/15 和 migration apply/verify/rollback/reapply；临时库已删除）。
- [x] 重复、乱序、重启、取消/删除、迟到结果均不破坏幂等与版本边界（组合对等门 + 真实子进程 crash/reclaim smoke）。
- [x] 未确认范围、高风险动作、未知停止状态均不会被摘要/缓存/模型判断绕过（`test:e2e:phase-6-safety-gates`：确定性合同与真实服务 mock E2E，不依赖模型判断）。
- [x] 双端保持同一业务状态和各自样式（client-presentation、desktop-render、完整返工链通过）。
- [x] 无凭据、完整敏感提示或用户私有正文进入测试报告与指标（成本报告 smoke 对凭据模式和全部 1000 条 fixture 正文逐条做负向断言）。
- [x] 所有文档/合同更新与实际实现一致，回退方案已在随机临时数据库演练；生产策略启用和发布仍明确未执行。

## 5. 证据记录

每个结果记录：日期、构建/工作树版本、执行环境、fixture、命令、退出码、观察结果和证据路径；未执行/跳过必须写原因，不能记作通过。真实模型验证与 stub 验证分开记录。

阶段通过条件：所有硬性安全/一致性门禁与双端闭环通过；性能/成本/真实模型验证范围如实记录；测试完成不等同已经发布。

## 6. 本轮证据记录（2026-09-20）

| 证据 | 命令 | 结果 |
| --- | --- | --- |
| T1 | `npm run test:harness`; `npm run test:harness:main-agent-phase6` | 通过；全量 Harness 通过，阶段 6 专项为 9 阶段、61 AC、54 Task，无孤立引用。全局追踪校验已限定为当前阶段前缀，跨阶段证据引用（如 `P3-AC6`）不再误报为本阶段 AC |
| T2 | `npm run test:e2e:phase-6-long-session` | 通过；100 WorkItem/1000 messages，受控增长 1.0 倍 |
| T3 | `npm run test:e2e:phase-6-backend-parity` | 组合门通过：6 个真实 file 场景、随机临时 PostgreSQL 15/15、file/PG migration apply/verify/rollback/reapply 等价校验；临时库自动删除 |
| T3b | `npm run test:e2e:phase-6-crash-restart` | 实际调用 `PersistenceService` 的子进程 claim 后被终止，lease 过期后新进程 reclaim；attempts=2、publishedRecords=1，无重复发布 |
| T4 | `npm run test:e2e:phase-6-dual-client`; `npm run test:e2e:phase-6` | 既有隔离环境证据中 client-presentation、desktop-render、workflow-managed、rework-loop、phase5 全部通过；双端组合已纳入阶段 6 总入口。2026-09-20 本轮复测时，当前受限执行环境拒绝 Electron 沙箱/GPU 子进程并造成 renderer crash；`--no-sandbox` 诊断可正常渲染，但因会削弱安全边界未作为通过证据，待允许 GUI 子进程后重跑真实沙箱用例 |
| T5 | Server 定向测试；`npm run test:e2e:phase-6-cost-report` | 通过；Generic LLM 输入/输出、缓存读写、TTFT/总耗时和报告 unknown 边界均有回归；价格能力保持可选，计费不作为当前流程门禁 |
| T5 relay pricing | Server 定向测试；Web `RuntimeModelManager.spec.ts`；`npm run test:e2e:runtime-model-switch`；`npm run test:e2e:client-presentation` | 通过；模型级价格持久化/重载/环境兜底/清空/非法价格/脱敏和价格版本回归；共用 Web/桌面表单 3/3；隔离 file + fake Provider 的 HTTP 链路按实际 usage 计算金额，未触碰业务 PostgreSQL 或付费模型 |
| T5 PostgreSQL pricing | `node scripts/test-session-persistence-postgres.mjs --check`；`node scripts/test-session-persistence-postgres.mjs` | 通过；一次性 PostgreSQL 16/16，新增用例核验 runtime model 价格、版本的 JSON 投影、跨实例重载及改价再重载；测试库已删除，不使用业务库 |
| T5b | `npm run test:e2e:phase-6-cost-report` | 通过；报告不匹配凭据模式，且不包含 1000 条合成消息中的任何完整正文 |
| T5c | `npm run test:e2e:phase-6-live-model-preflight`; `npm run phase-6:live-model-preflight` | 历史计费抽样门禁 4/4 通过且当前保持 blocked；该入口现归后续计费专项，不由正常会话或阶段 6 usage 验收调用，未联网、未产生费用 |
| T5d | `npm run test:e2e:phase-6-live-model-evaluation` | 本地 fake Provider 验证真实 `RuntimeService` 固定 5 次调用、5/5 质量标记、usage/缓存/TTFT/脱敏报告；缺失缓存字段保持 unknown。实际真实模型抽样仍需独立调用授权，未执行；其中美元计费部分已移入后续专项 |
| Safety | `npm run test:e2e:phase-6-safety-gates` | 通过；unknown stop fail-closed、cache hit 预算拒绝、精确版本确认、高风险能力确认、停止迟到结果隔离 |
| Build | `npm run build` | 通过；local-runtime-cli、shared、desktop、server、web 均成功构建。Vite 仅报告既有大 chunk 警告；这证明当前工作树可构建，不替代正式发布所需的 commit/build-time 身份 |
| Docs | 合同/运维/四件套/roadmap 审查；`git diff --check` | 通过；版本化价格来源、安全组合证据和真实 rollback 结果已同步，策略启用/发布明确未执行 |
| T6 | `npm run test:e2e:phase-6-migration` | 通过；隔离 v3 dry-run 和 apply 确认门禁；该 fixture 入口不执行生产 rollback/发布 |
| T6b | `npm run test:e2e:phase-6-backend-parity` | 2026-09-20 经用户明确允许连接本地生成数据库后再次通过：创建随机临时库，apply/verify/non-empty rollback/reapply 成功并自动删除；无显式测试 URL 时仍 fail-closed，绝不回退到 `DATABASE_URL` |
| T6c | `npm run test:e2e:phase-6-release-preflight`; `npm run phase-6:release-preflight` | 14/14 通过；当前实际 preflight 为 `blocked`，准确列出验收、rollback 证据、构建身份和授权阻断；已有 rollback 证据时不再误报缺少测试 URL，且不输出 URL/价格正文/授权 ID。强制意图路由、主 Agent 讨论和需求文档任一启用均受完整准入门控制 |
| T6d | `node --import tsx --test apps/server/src/common/phase-6-release-admission.spec.ts`；生产服务进程启动拒绝验证 | 5/5 通过；三类策略启用在监听前复用发布门禁，漏设 `NODE_ENV` 也不能绕过；验收未完成、证据缺失或汇总伪装全绿但 AC 行为 partial 时拒绝监听。实际生产模式进程返回 `PHASE_6_POLICY_ADMISSION_BLOCKED` 且未监听；只有 `NODE_ENV=test` + 精确隔离测试 bypass 值可豁免。未执行真实策略启用或正式发布 |
| Migration comparator | `node --import tsx --test apps/server/src/modules/persistence/relational/relational-migration.cli.spec.ts` | 3/3 通过；空投影可规范化、非空差异和共同集合变更均 fail-closed |
| Cross-stage | Server 定向测试；`npm run phase-6:traceability` | P3-AC6 缺证路径补齐；多模态登记为后续专项；计费转入总计划第 21 节且不阻断正常流程。矩阵以本次重新生成结果为准 |
| Workspace regression | `npm run typecheck`; `npm test`; `git diff --check` | 通过；类型检查、全仓测试和差异空白校验均退出码 0 |

当前结论：阶段 6 仍为 partial，不能标记为完成或已发布。确定性双端闭环、file/隔离 PostgreSQL 组合门、真实子进程崩溃恢复、rollback/reapply 和真实中转 usage 合同已通过；真实模型质量、策略启用、构建身份和正式发布授权仍需按授权执行。美元计费、价格版本和账单核对已移入后续专项，不影响当前正常流程。

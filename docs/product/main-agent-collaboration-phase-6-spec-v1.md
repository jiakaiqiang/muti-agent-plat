# 阶段 6：双端综合验收、长会话成本评测与受控上线 — Spec v1

> 日期：2026-09-16
> 状态：实施中（2026-09-20）；追踪矩阵、长会话 fixture、usage/缓存/耗时采集、隔离 PostgreSQL 回归、迁移 dry-run 和确定性双端返工链已落地，真实模型质量/生产发布仍未执行；美元计费已按用户决定移入后续专项。
> 依赖：阶段 0、1、2A、2B、2C、3、4、5 均有独立验收记录；P2A-AC5 的文本适配器范围已验收，用户已确认真实多模态 Provider 接入延期为后续专项，不作为阶段 6 发布阻断项。P3-AC6 的 `blocked` 写入方已于 2026-09-20 补齐并回归。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-6-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-6-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-6-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-6-checklist-v1.md)

## 1. 目标与用户结果

用可重放的故障矩阵、长会话和多会话样本证明主 Agent 协作闭环、成本控制及双端一致性，再进行经授权的受控上线。

## 2. 范围与非目标

- 贯通消息→讨论→文档确认→选择流程→开发/验证/返工→补充与新需求→停止/删除/恢复。
- 验证长会话预算、召回质量、缓存失效、真实 PostgreSQL 竞争、CLI stub 和两端 UI。

非目标：

- 不把 mock 通过宣称真实模型全流程通过，不在业务库中制造测试故障。
- 不自动部署、重启活动服务、重放用户历史任务、发送外部通知或购买模型服务。
- 当前阶段不启用美元计费、费用预算或账单核对；已有价格配置保持可选且不得阻断正常业务流程。

## 3. 当前实现依据

- 已有各专项持久化/停止验收记录可作回归基线，本专项仍需重新执行新增组合场景。 [源码/既有文档](../../docs/quality/runtime-stop-consistency-checklist-v1.md)
- 已有隔离 PostgreSQL 测试 runner，可借鉴其建库/清理与脱敏规则。 [源码/既有文档](../../scripts/test-session-persistence-postgres.mjs)
- 根 package 脚本已有双端、流程、取消、恢复及 Token 冒烟入口。 [源码/既有文档](../../package.json)

以上为现状定位，不等于本专项测试结果；实施前复核当前工作树，不覆盖无关改动。

## 4. 验收条件

- P6-AC1：全部阶段 AC 有任务、测试、实际输出或审查证据，失败/跳过/未执行明确区分；不以文档创建代替交付。
- P6-AC2：长会话基准固定为同会话 100 个需求、至少 1000 条消息，包含早期需求续接、同名歧义、修订约束和长工具输出。
- P6-AC3：记忆回归使用人工标注 fixture，明确应召回/应澄清/禁止继承；硬约束与旧确认不得丢失或误用。
- P6-AC4：独立 PostgreSQL、多服务实例与 CLI stub 覆盖启动/停止/删除、确认、预算、摘要、缓存回填及 outbox 崩溃竞争。
- P6-AC5：Web 与桌面共享状态但保留独立呈现；断线、乱序、重复事件和切换会话后状态收敛，文件对比可追溯。
- P6-AC6：冷热缓存和摘要 usage 可测，分别报告每需求输入/输出 Token、缓存读写、调用数、TTFT/总耗时、模型失败和索引开销；中转未返回的字段保持 unknown。美元费用、价格版本和账单核对进入后续专项，不作为本阶段正常流程门禁。
- P6-AC7：先演练加法迁移和策略准入，再受控启用；活动会话沿用固定策略，回退保留新记录和停止屏障。

## 5. 约束与风险

- 本地 stub 能证明协议与状态，不证明真实模型质量或第三方缓存可用性。
- 性能基线取决于模型和硬件；无测量证据不得承诺所有超时消失或固定费用降幅。

共同约束：复用 v2-only、现有 Runtime/Tool Authority 和持久化事务边界；Web 与桌面共享业务状态但保留各自样式；不自动重跑历史任务、不清库、不变更凭据或外部权限。

## 6. 阶段退出

所有硬性安全/一致性门禁与双端闭环通过；性能/成本/真实模型验证范围如实记录；测试完成不等同已经发布。

本阶段详细任务和证据填写位置见 Tasks/Checklist。只有实现与必须验证均完成后才可更新状态，文档生成不勾选开发项。

## 7. 本轮实施结果（2026-09-20）

- P6-T1：已实现 `tests/harness-engineering/main-agent-collaboration-phase6.spec.mjs` 和[跨阶段追踪矩阵](../quality/main-agent-collaboration-phase-6-traceability-matrix-v1.md)，覆盖 9 阶段、61 条 AC、54 项 Task；矩阵区分 passed/partial/pending/not-executed。
- P6-T2：已实现 `scripts/phase-6-long-session-fixture.mjs` 与 `test:e2e:phase-6-long-session`，固定生成 100 WorkItem/1000 messages，覆盖早期召回、同名澄清、修订约束和长工具输出；受控上下文从 10 到 100 个无关需求增长为 1.0 倍。该结果是确定性 fixture 评测，不代表模型质量。
- P6-T3：已实现 `scripts/phase-6-fault-matrix.mjs`、真实子进程崩溃恢复入口 `scripts/phase-6-crash-restart-smoke.mjs`、显式隔离库入口 `scripts/phase-6-postgres-smoke.mjs` 和组合对等入口 `scripts/phase-6-backend-parity.mjs`；重复提交、乱序完成、重启回收、删除后迟到回调、预算耗尽和缓存迟到回填均直接调用真实 `WorkflowStartStore`、`DiscussionStore`、`WorkItemBudgetStore`、`DerivedCache` 与临时 file backend，不再用预填期望值模拟结果。组合入口在随机临时 PostgreSQL 库中通过并发/恢复 15/15，并完成 file→PostgreSQL apply/verify/rollback/reapply 等价校验；不回退到默认业务库。迁移校验同时修复了“缺失但为空的投影”误报，非空差异仍 fail closed。
- P6-T4：已实现 `phase-6:dual-client` 组合入口；Web/桌面呈现、桌面渲染、工作流 managed execution、阶段 5 变更队列和 `rework-loop` 均通过。返工链修复了内置非模型 Runtime 的零 token 结算误记为 unknown 的问题，并将 E2E 明确锁定隔离 mock Runtime。
- 跨阶段安全门禁：新增 `test:e2e:phase-6-safety-gates`，统一复跑未知停止 fail-closed、缓存命中仍受预算守卫、精确需求版本确认、高风险能力确认和停止后的迟到结果隔离；这些判断均由确定性服务端门禁执行，不委托模型或摘要判断。
- P6-T5：已生成[成本与质量报告](../quality/main-agent-collaboration-phase-6-cost-report-v1.md)，Generic LLM 可从中转终止 usage 帧读取输入/输出、缓存读写并测量 TTFT/总耗时；fake Provider 端到端测试通过，未返回字段保持 unknown。部署侧价格目录、模型级费率和估算金额作为可选基础保留，未配置时不阻断服务或模型调用。用户已将美元计费、费用预算和账单核对移入后续专项；本轮未调用真实 Provider，真实模型质量和实际性能仍为 unknown/not measured。
- P6-T6：已实现 `phase-6:migration-drill`、`test:e2e:phase-6-migration-postgres` 和只读 `phase-6:release-preflight`；隔离 v3 fixture 的 `dry-run` 和无数据库/确认时的 `apply` 门禁通过。组合对等入口已在随机临时 PostgreSQL 库完成空库 apply/verify、非空覆盖前 rollback export、rollback reapply/verify，并生成不含 URL 的脱敏证据。策略准入现统一识别强制意图路由、主 Agent 讨论和需求文档三类启用入口，任一启用均要求完整验收、rollback、构建身份和独立授权。正式启用和发布仍需独立授权，因此 P6-T6 的发布交接部分保持未完成。

当前阶段结论：确定性双端业务闭环、file/隔离 PostgreSQL 组合故障门、迁移 rollback、真实子进程崩溃恢复和 usage 采集合约已通过；P6-AC2、P6-AC3、P6-AC7 仍有真实模型质量或生产策略/发布范围的 partial 证据，阶段不能标记为完成或已发布。计费专项不再影响当前正常流程或阶段 6 的 usage 验收。

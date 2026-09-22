# 阶段 6：双端综合验收、长会话成本评测与受控上线 — Tasks v1

> 日期：2026-09-16
> 状态：实施中（2026-09-20）；验收工具链、确定性双端组合链和版本化价格目录已完成，外部资源门禁仍有未执行项。
> 依赖：阶段 0、1、2A、2B、2C、3、4、5 均有独立验收记录；跨阶段追踪中的 partial/not-executed 项继续显式保留，不作为已完成证据。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-6-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-6-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-6-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-6-checklist-v1.md)

## 执行规则

- 所有任务初始为待实施；先确认前置阶段退出条件，不跳过安全与确认门禁。
- 每项先补合同/失败用例，再实现；数据库、模型、CLI 与双端边界分别验证。
- 复用现有能力仍需回归，不将既有专项的通过记录直接复制为本阶段通过。
- 勾选项必须有实际代码、测试或审查证据；初始“只生成文档”的历史状态已结束，当前以各任务的实际证据为准。

## 任务清单

### P6-T1 建立端到端追踪矩阵

- [x] 完成实现与审查。
- 前置：阶段 0、1、2A、2B、2C、3、4、5 均有独立验收记录；未完成边界由本任务输出的跨阶段矩阵继续显式保留。
- 交付：汇总 9 阶段 AC/Task/用例/证据，未验证项保持 pending。
- 覆盖：P6-AC1。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 实际证据：`npm run test:harness:main-agent-phase6` 通过；生成 9 阶段/61 AC/54 Task 矩阵。2026-09-20 补齐 P3-AC6 和 P6-AC4、将多模态登记为后续专项，并按用户决定把计费移出当前范围后，矩阵为 passed 57、partial 3、deferred 1、not-executed 0。

### P6-T2 制作长会话与意图标注 fixture

- [x] 完成实现与审查。
- 前置：P6-T1 完成；涉及的其他阶段依赖同页顶部。
- 交付：100 需求/1000 消息、早期引用/歧义/约束修订/工具输出，固定输入增长阈值。
- 覆盖：P6-AC2、P6-AC3。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 实际证据：`npm run test:e2e:phase-6-long-session` 通过；100 WorkItem/1000 messages，受控输入增长 1.0 倍。仅为确定性 fixture，不是模型质量验收。

### P6-T3 执行数据库/CLI 故障矩阵

- [x] 故障矩阵、子进程 crash/reclaim、PostgreSQL 隔离回归和组合对等入口已实现并审查。
- [x] 真实 file backend 组件级场景、真实子进程恢复和随机临时 PostgreSQL 15/15 已验证。
- [x] 组合入口完成 file 故障矩阵 + PostgreSQL 并发/恢复 + migration rollback 等价校验。
- 前置：P6-T2 完成；涉及的其他阶段依赖同页顶部。
- 交付：隔离数据库与 stub，覆盖重复/乱序/崩溃/删除/预算/缓存竞争。
- 覆盖：P6-AC4。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 实际证据：`npm run test:e2e:phase-6-backend-parity` 通过。入口先执行 6 个真实 file backend 场景，再从显式 `RELATIONAL_TEST_DATABASE_URL` 创建随机临时 PostgreSQL 库执行 15/15 并发/恢复回归，最后执行 apply/verify/non-empty rollback/reapply 等价校验；测试库在 finally 中删除，不读取默认 `DATABASE_URL`。迁移比较器新增单测 3/3，覆盖空投影兼容、非空差异拒绝和共同集合变更拒绝。

### P6-T4 执行双端完整业务链

- [x] 完成实现与审查。
- 前置：P6-T3 完成；涉及的其他阶段依赖同页顶部。
- 交付：讨论→确认→选择流程→返工→变更→排队→停止/删除/恢复，截图分别回归。
- 覆盖：P6-AC5。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 实际证据：`npm run test:e2e:phase-6-dual-client` 中 Web/桌面呈现、桌面渲染、工作流 managed execution、`rework-loop` 和阶段 5 变更队列全部通过；该命令现已纳入 `npm run test:e2e:phase-6` 总入口，避免总回归绕过 P6-T4。`RuntimeService` 对 `mock`、`code_reader`、`test_runner` 的已知零 token 结果按实际零成本结算；新增 `runtime.service.spec.ts` 回归覆盖预算释放，并将返工 E2E 锁定 mock Runtime。
- 安全组合证据：`npm run test:e2e:phase-6-safety-gates` 串行验证未知停止不准入、缓存命中不绕过预算、未确认/过期版本不启动流程、高风险能力必须确认、停止后迟到结果不落地；不依赖模型自行遵守提示词。

### P6-T5 形成质量与成本报告

- [x] 完成实现与审查。
- 前置：P6-T4 完成；涉及的其他阶段依赖同页顶部。
- 交付：采集完整输入/输出 usage、冷/热缓存、调用数和耗时，报告真实模型未测/受批抽样的区别；美元计费另列后续专项。
- 覆盖：P6-AC2、P6-AC3、P6-AC6。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 实际证据：远程流式请求显式发送 `stream_options.include_usage=true`，Generic LLM 读取中转实际输入/输出、OpenAI/Anthropic 兼容缓存字段并测量 TTFT/总耗时；`test:e2e:phase-6-live-model-evaluation` 的 fake Provider 验证 5/5 请求、缓存读、usage、流式 TTFT、报告脱敏和缺失字段 unknown。版本化价格目录及金额估算作为可选基础保留，缺价格时不阻断正常模型调用。用户已将美元计费、费用预算和账单核对移入后续专项；实际真实模型质量仍未执行，因此 P6-AC2/3 保持 partial，P6-AC6 的 usage 合同通过。
- 可选价格基础（2026-09-20 历史实施）：Web/桌面共用模型管理表单可配置版本化费率，Server、Web、隔离 file/PostgreSQL 与双端回归均通过。该能力默认不启用，未配置价格时费用保持 unknown 且正常流程继续；其真实费率、费用预算和账单核对不在当前阶段验收，统一转入总计划第 21 节。
- 承接自阶段 2C 的 usage 归一化和缓存预算守卫已完成；`priceVersion`、真实费率及付费模型账单验证按用户最新决定移入后续计费专项，不再阻断 P6-T5 的 usage 交付。

### P6-T6 迁移回退演练与发布交接

- [ ] 完整任务未完成：策略准入和正式发布交接仍需独立授权。
- [x] 迁移 dry-run、确认门禁和 PostgreSQL apply/verify/rollback/reapply 工具已实现并审查。
- [x] 只读策略准入 preflight、脱敏 rollback 证据格式和发布交接文档已实现并验证 fail closed。
- [x] 生产服务启动对三类策略启用复用同一准入判定，缺少验收或授权时在监听前拒绝；独立的 mock E2E 不冒充发布证据。
- [x] 在显式隔离测试库执行 rollback 演练并记录脱敏证据。
- [ ] 经单独授权后完成策略准入和发布交接；测试完成不等同已发布。
- 前置：P6-T5 完成；涉及的其他阶段依赖同页顶部。
- 交付：核验活动任务、备份/恢复和策略开关，汇总风险并等待单独上线授权。
- 覆盖：P6-AC1、P6-AC7。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 实际证据：`npm run test:e2e:phase-6-backend-parity` 生成 `.cache/agent-cluster/phase-6/postgres-migration-evidence.json`，空库 apply/verify、非空覆盖前 rollback export、rollback reapply/verify 均通过且集合差异为 0；2026-09-20 经用户明确允许连接本地生成数据库后再次执行并通过，随机临时库已自动删除。`npm run test:e2e:phase-6-migration` 的 dry-run/apply 确认门禁和 `npm run test:e2e:phase-6-release-preflight` 9/9 仍通过；新增用例证明强制意图路由、主 Agent 讨论和需求文档任一启用都受同一准入门控制，且缺构建身份时不能启用。`npm run phase-6:release-preflight` 当前仍正确返回 `blocked`，原因是其他 AC、构建身份和发布授权缺失；未执行策略启用或正式发布。

## 完成定义

所有硬性安全/一致性门禁与双端闭环通过；性能/成本/真实模型验证范围如实记录；测试完成不等同已经发布。

完成一个任务不等于阶段完成；所有 AC 必须有证据。最后同步相关合同、测试说明与 Checklist，不修改其他未通过阶段的状态。

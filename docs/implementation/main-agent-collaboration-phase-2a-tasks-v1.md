# 阶段 2A：统一消息意图、需求隔离与完整 Token 预算 — Tasks v1

> 日期：2026-09-16（2026-09-17 回填执行结果）
> 状态：**已验收通过（2026-09-17）**。T1–T6 已完成；核心回归、跨进程预算竞争、真实 HTTP 路由、Web + Electron SSE、停止/删除/恢复、预算恢复、`npm run typecheck`、`npm run test`、`npm run build` 与 Harness 门禁均已通过。真实付费/多模态 Provider 未接入，明确不纳入本阶段验收范围。
> 依赖：阶段 0、1 通过；为 2B、2C、3 提供统一上下文入口。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-2a-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-2a-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-2a-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-2a-checklist-v1.md)

## 执行规则

- 所有任务初始为待实施；先确认前置阶段退出条件，不跳过安全与确认门禁。
- 每项先补合同/失败用例，再实现；数据库、模型、CLI 与双端边界分别验证。
- 复用现有能力仍需回归，不将既有专项的通过记录直接复制为本阶段通过。
- 执行状态与证据只以本文件和 Checklist 的实际回填为准；未执行的矩阵不能因文档存在而视为完成。

## 任务清单

### P2A-T1 统一入口与目标信息

- [x] 完成实现与审查。
- 前置：阶段 0、1 通过；为 2B、2C、3 提供统一上下文入口。
- 交付：为初始/后续消息传递需求、replyTo、@ 和幂等信息，覆盖精确控制分支。
- 覆盖：P2A-AC1、P2A-AC2、P2A-AC3。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 结果：shared 增加 `replyToEventId` 与快照目标字段；`MessageIngressService.commit` 持久化 replyTo 并覆盖幂等重放；`sessions.service` 透传 replyTo。核心 4 个 spec 33/33 通过；`npm run typecheck` 全 workspace 0 错误。

### P2A-T2 扩展有界意图快照及验证

- [x] 完成实现与审查。
- 前置：P2A-T1 完成；涉及的其他阶段依赖同页顶部。
- 交付：限定候选/近期对话，补分类合同、版本验证和成员请求保留。
- 覆盖：P2A-AC2、P2A-AC3、P2A-AC4。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 结果：`buildIntentSnapshot` 纳入 mentions/replyTo/有界近期对话并回报 `bounds`，replyTo 越界抛 `REPLY_TARGET_OUTSIDE_SESSION`；分类器输入携带 @ 约束，`validate` 新增 `MENTION_TARGET_DROPPED` 与 `AGENT_TARGET_OUTSIDE_SNAPSHOT`；快照 hash 覆盖新字段。核心 4 个 spec 33/33 通过。

### P2A-T3 实现角色化需求上下文

- [x] 完成实现与审查。
- 前置：P2A-T2 完成；涉及的其他阶段依赖同页顶部。
- 交付：收敛 ContextEnvelopeV2 装配、有效决策继承、信任边界与缺证拒绝。
- 覆盖：P2A-AC3、P2A-AC4、P2A-AC7。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 结果：新增 `context-v2/l0-trust-boundary.ts`（`assertL0SystemRuleTrustBoundary`）并在 `buildEnvelopeFromContextAssembly` 出口强制，越权抛 `L0_TRUST_BOUNDARY_VIOLATION` 而不静默放行；各层预算（15%/10%/40%）与 `contextScope` 固化；WorkItem 切片排除同会话其他需求。context-v2 全部 14 个 spec + `orchestrator.service.spec.ts` 共 139/139 通过。

### P2A-T4 加入最终请求预算守卫

- [x] 完成实现与审查。
- 前置：P2A-T3 完成；涉及的其他阶段依赖同页顶部。
- 交付：adapter 发送前与每轮工具循环计数，包含 schema/工具/输出保留并记录估算误差。
- 覆盖：P2A-AC5、P2A-AC7。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 结果：T4-2/T4-3——`TOOL_LOOP_OUTPUT_RESERVATION_RATIO=0.5` 预留输出/推理、`reserveInputTokenSafetyMargin` 接安全余量、超限在发送前以 `TOKEN_BUDGET_EXCEEDED` 拦截；轮末 `assertWithinInputBudget(round + 1)` 重算，assistant 调用轮与 user 工具结果轮成对保留。T4-1——请求计数按面归因（system 提示/工具定义/上下文信封/期望输出 schema/工具历史）并经 `AgentRunResult.tokenEstimation`（新增 `RuntimeTokenEstimationDiagnostic`，加法可选）记录估算器与实际误差；provider 上报 usage 不再被工具循环丢弃，跨轮累加后与估算比较得出 `drift`，缺失用量时不下沉为 0 误差。
- 证据：`generic-llm-tool-loop-budget.spec.ts` 3/3、`generic-llm-token-estimation.spec.ts` 5/5；server 全量 1360 项（1348 通过、9 跳过、3 失败为既有符号链接守卫缺陷）；`npm run typecheck` 全 workspace 0 错误。
- 遗留：`generic_llm` 适配器只发送字符串消息，多模态计数不适用；长 schema 与多模态矩阵并入 T6 验证。

### P2A-T5 实现累计预算预留与结算

- [x] 完成实现与审查。
- 前置：P2A-T4 完成；涉及的其他阶段依赖同页顶部。
- 交付：将重试/讨论/摘要/补读纳入 WorkItem 总账，跨实例原子预留、未知用量和去重结算。
- 覆盖：P2A-AC6。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 结果（T5-1）：shared 新增 `WorkItemBudgetLedger` 等合同；`runtimes/work-item-budget.ts` 提供纯函数账本，attemptId 作幂等键（重复预留不二次扣账、重放结算不改 revision、未预留不可结算），用量不可得时按预留上限计入 unknown 而非全额退还，超额记 `overrunTokens`，可用额度扣除未结算预留以满足并发语义。
- 结果（T5-2）：新增 `workItemBudgetsBySession` 集合与 `WorkItemBudgetStore`，按关系库约定接入 `KNOWN_COLLECTIONS`、`SESSION_KEYED_COLLECTIONS`、两处 load、`writeCollections` switch、`writeWorkItemBudgets`、`collectionWriteOrder`；`relational-schema.ts` 新增 V11 建表（`work_item_budgets`），迁移 runner 追加 version 11。拒绝的预留不落盘，避免 revision 守卫下失败方空账本与赢家行竞争。
- 证据：`work-item-budget.spec.ts` 9/9、`work-item-budget-store.spec.ts` 7/7；`node scripts/test-session-persistence-postgres.mjs` 一次性临时库 **10/10**（跨实例并发仅一个提交、账本跨实例读回、结算释放预留行、重放结算幂等、行级落库）；跨进程竞争验证恰好一个预留成功。最终回归的全量计数与命令见 Checklist 第 5 节。
- 结果（T5-3）：接线点在 `RuntimeService.start`（两个入口汇聚于此）。分类策略 `work-item-budget-policy.ts`（6/6，重试/补读优先于阶段）；`start` 内在所有廉价早返回之后、适配器启动之前预留，不足时以 `WORK_ITEM_BUDGET_EXHAUSTED`（已加入 `RuntimeError` 联合类型）+ 中文可解释文案 + `availableTokens/requestedTokens/limitTokens` 拦截；结算挂 `underlying.result`，失败同样结算、用量不可得按预留上限记 unknown。需求上限复用会话预算（`buildBudget(session).maxTotalTokens`），不新增配置键；无 `workItemId` 不接入。额度耗尽会将任务置为 `waiting`，会话置为 `WAIT_USER_DECISION`，只提供“提交拆分需求”或“取消会话”，不会重试旧 WorkItem；拆分后的消息原子创建关联的新 WorkItem。终端阶段的 `WORK_ITEM_BUDGET_EXHAUSTED` 也转换为同一等待结果，避免降级为普通失败。**教训**：结算不能在监督流程内 await——会破坏「未确认停止屏障不被迟到结果拖住」语义，既有用例当场挂死，改为 fire-and-forget。证据：策略 6/6、预算相关 server spec 156/156、`npm run test:e2e:work-item-budget-recovery` 通过。

### P2A-T6 验证意图与长输入矩阵

- [x] 完成实现与审查。
- 前置：P2A-T5 完成；涉及的其他阶段依赖同页顶部。
- 交付：中文/多意图/@/旧确认/历史需求、工具增长、跨进程预算竞争和 Context v2 回归。
- 覆盖：P2A-AC1、P2A-AC2、P2A-AC3、P2A-AC4、P2A-AC5、P2A-AC6、P2A-AC7。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 结果：T6-1 补齐 golden 数据集缺失的 @ 场景（`mention-target-preserved-zh` / `mention-target-dropped-zh`）并加两条不变量，数据集+路由 spec 7/7；T6-2 新增 `generic-llm-request-guard-matrix.spec.ts` 4/4（长中文在发送前拦截且未发请求、bulky schema 单独越界、估算随中文输入单调增长、单轮短载荷正常通过），多模态记为 not applicable；T6-3 新增 `scripts/test-work-item-budget-cross-process.mjs`（注册为 `npm run test:postgres:work-item-budget`），**两个独立进程竞争**、恰好一个预留成功且账本一行 700。
- 证据：`npm run typecheck`、`npm run test`、`npm run build`、`npm run test:harness`、`npm run test:e2e:token-budget`、`npm run test:e2e:work-item-budget-recovery`、`npm run test:e2e:client-presentation`、`npm run test:e2e:phase-2a-routing`、`npm run test:e2e:phase-2a-client-sse`、`npm run test:e2e:session-delete`、`npm run test:e2e:cancel`、`npm run test:e2e:recovery` 与 `npm run test:e2e:chinese-copy` 均退出码 0；`npm run test:postgres:work-item-budget` 验证两个独立进程恰好一个预留成功。定向服务端复验 58/58 通过，包含 1,000 条历史消息/101 个候选需求上界、L0 防污染、旧工具输出引用化、取消后的迟到结果仅结算一次。
- 验收边界：真实付费/多模态 Provider 未配置，不能作为通过证据；当前 `generic_llm` 只发送字符串消息，多模态计数为不适用。该限制已在 Checklist 显式记录，不影响当前适配器的 2A 验收，也不触及 2B。

## 完成定义

精确命令零语义调用、目标与 @ 保留、完整请求预算和累计并发预算用例通过；上下文不会随无关历史线性增长。阶段 2A 的所有 AC 均已有本阶段范围内的自动化证据；阶段 2B 保持待实施状态。

完成一个任务不等于阶段完成；所有 AC 必须有证据。最后同步相关合同、测试说明与 Checklist，不修改其他未通过阶段的状态。

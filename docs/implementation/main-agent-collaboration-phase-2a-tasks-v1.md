# 阶段 2A：统一消息意图、需求隔离与完整 Token 预算 — Tasks v1

> 日期：2026-09-16（2026-09-17 回填执行结果）
> 状态：实施中。T1–T3 已完成；T4 部分完成（T4-1 待合同决策）；T5、T6 待开始。
> 依赖：阶段 0、1 通过；为 2B、2C、3 提供统一上下文入口。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-2a-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-2a-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-2a-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-2a-checklist-v1.md)

## 执行规则

- 所有任务初始为待实施；先确认前置阶段退出条件，不跳过安全与确认门禁。
- 每项先补合同/失败用例，再实现；数据库、模型、CLI 与双端边界分别验证。
- 复用现有能力仍需回归，不将既有专项的通过记录直接复制为本阶段通过。
- 本轮只生成文档；以下路径与改动是后续开发范围，不是已完成修改。

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

- [ ] 完成实现与审查。
- 前置：P2A-T4 完成；涉及的其他阶段依赖同页顶部。
- 交付：将重试/讨论/摘要/补读纳入 WorkItem 总账，跨实例原子预留、未知用量和去重结算。
- 覆盖：P2A-AC6。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。

### P2A-T6 验证意图与长输入矩阵

- [ ] 完成实现与审查。
- 前置：P2A-T5 完成；涉及的其他阶段依赖同页顶部。
- 交付：中文/多意图/@/旧确认/历史需求、工具增长、跨进程预算竞争和 Context v2 回归。
- 覆盖：P2A-AC1、P2A-AC2、P2A-AC3、P2A-AC4、P2A-AC5、P2A-AC6、P2A-AC7。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。

## 完成定义

精确命令零语义调用、目标与 @ 保留、完整请求预算和累计并发预算用例通过；上下文不会随无关历史线性增长。

完成一个任务不等于阶段完成；所有 AC 必须有证据。最后同步相关合同、测试说明与 Checklist，不修改其他未通过阶段的状态。

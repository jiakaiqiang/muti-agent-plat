# 阶段 2A：统一消息意图、需求隔离与完整 Token 预算 — Spec v1

> 日期：2026-09-16
> 状态：设计与实施基线，待实施；现有能力的复用不代表本阶段验收已完成。
> 依赖：阶段 0、1 通过；为 2B、2C、3 提供统一上下文入口。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-2a-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-2a-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-2a-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-2a-checklist-v1.md)

## 1. 目标与用户结果

任何用户消息先明确属于哪个需求、要求什么动作、面向哪些 Agent；每次模型请求均在完整预算内，不随历史需求数量无界增长。

## 2. 范围与非目标

- 补强现有 MessageIngress/精确命令/语义路由链，纳入明确 @、回复对象、有限近期对话和历史候选。
- 按 WorkItem/角色组装 ContextEnvelopeV2；在实际请求发送与每轮工具循环前检查输入和累计预算。

非目标：

- 不重新创建第二个语义识别服务，不让主 Agent 重复执行已经完成的路由分类。
- 不在本阶段完成长期语义索引或模型厂商缓存；历史召回通过 2B 接口接入。

## 3. 当前实现依据

- 已有消息幂等落库和参与成员 @ 校验。 [源码/既有文档](../../apps/server/src/modules/message-routing/message-ingress.service.ts)
- 已有精确命令优先、模型分类、校验、有限重试及失败澄清。 [源码/既有文档](../../apps/server/src/modules/intent-recognition/semantic-intent-router.service.ts)
- 已有 WorkItem 筛选和版本快照；初始需求对未归属数据存在兼容规则，不能无限继承。 [源码/既有文档](../../apps/server/src/modules/context-management/context-management.service.ts)
- 现有 Token 基础估算按字符数/4，预算检查需要覆盖 adapter 真实发送内容。 [源码/既有文档](../../apps/server/src/common/token.ts)

以上为现状定位，不等于本专项测试结果；实施前复核当前工作树，不覆盖无关改动。

## 4. 验收条件

- P2A-AC1：初次需求和后续消息走统一可审计入口，保存 messageIdempotencyKey、replyTo、mentions 和需求目标；精确控制命令不调用语义模型。
- P2A-AC2：路由区分当前需求补充、范围变更、相关新需求、独立新需求、历史需求续接、一般问答和控制动作；歧义只澄清不执行。
- P2A-AC3：路由输入只包含当前消息、有限相关对话、有效决策及有界候选摘要；@ 约束不能被分类器静默抹除。
- P2A-AC4：当前需求上下文仅包含自身有效状态及显式继承证据；主 Agent、专家、路由器使用不同切片，摘要和外部内容均不成为系统权限指令。
- P2A-AC5：对最终发送请求计数，包含 system、schema、工具、对话、证据、多模态预算和工具历史；预留输出、推理及安全边界。
- P2A-AC6：单次输入预算与单需求累计预算分开，分类、咨询、重试、摘要、补读均计入；并发调用先预留额度，结束后结算，未知用量保守标记。
- P2A-AC7：超限处理保留不可裁剪的验收约束、授权和完整修订证据；旧工具输出可引用化，必要时拆任务或明确拒绝。

## 5. 约束与风险

- 更严格预算可能暴露当前请求超大问题，应返回可理解的容量阻塞而非偷偷截断。
- 工具定义、输出 schema 与 CLI 内部历史可能不在平台初始估算中，需分适配器验证。

共同约束：复用 v2-only、现有 Runtime/Tool Authority 和持久化事务边界；Web 与桌面共享业务状态但保留各自样式；不自动重跑历史任务、不清库、不变更凭据或外部权限。

## 6. 阶段退出

精确命令零语义调用、目标与 @ 保留、完整请求预算和累计并发预算用例通过；上下文不会随无关历史线性增长。

本阶段详细任务和证据填写位置见 Tasks/Checklist。只有实现与必须验证均完成后才可更新状态，文档生成不勾选开发项。

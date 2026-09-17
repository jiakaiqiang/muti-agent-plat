# 阶段 2A：统一消息意图、需求隔离与完整 Token 预算 — Plan v1

> 日期：2026-09-16
> 状态：实施中（2026-09-17）。设计与落点未变更；执行结果与证据见 Tasks/Checklist。
> 依赖：阶段 0、1 通过；为 2B、2C、3 提供统一上下文入口。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-2a-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-2a-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-2a-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-2a-checklist-v1.md)

## 1. 目标、依据与决策

任何用户消息先明确属于哪个需求、要求什么动作、面向哪些 Agent；每次模型请求均在完整预算内，不随历史需求数量无界增长。

当前依据见同阶段 Spec 第 3 节。已沟通决定统一见总计划，本文将其映射为实现边界。

方案选择：沿用现有领域模块与共享合同，增量补强；不新增平行编排/上下文系统。收益是保持现有 Runtime、流程图、双端状态和数据可追溯性；代价是必须覆盖旧入口并完成版本兼容验证。

## 2. 可执行设计

### 2.1

保留 message-ingress → deterministic-command-guard/semantic-intent-router → validation → route-application 的职责。扩展 IntentContextSnapshot 的 mentions、replyTo、recentRelevantMessages 和候选来源；候选先由服务端查询，不能让分类器先读取全部历史。

### 2.2

路由结果表达 scopeRelation、dialogueAct、requestedAction、selectedWorkItemId、requestedAgentIds/协作建议与理由。Schema、成员资格、引用、业务指纹和状态转换由服务端复核；版本过期只允许有界重建，仍冲突则等待用户，不循环调用模型。

### 2.3

精确 UI 操作携带目标 confirmationId/版本，不通过自然语言重分类。普通“好的/继续”只有唯一、当前、允许文本确认的待确认对象才可映射；高风险批准仍使用结构化动作。

### 2.4

ContextEnvelopeV2 保持唯一权威载荷。采用有效决策 → 当前任务 → 近期相关对话 → 检索证据的可解释装配顺序，各层有预算与来源。仅将必要的稳定项目规则跨需求复用，不携带整个参与者讨论记录。

### 2.5

新增预算策略与 adapter 发送前校验接口（拟定），tokenizer 优先使用与实际模型匹配的实现/计数接口；无法精确计数时显式记录估算器、误差和保守裕量，不把字符数/4 当保证。每轮工具循环都重新计算，涉及工具调用/结果的消息必须成对保留。

### 2.6

拟复用持久化逻辑操作实现 WorkItem 预算 reservation/settlement；request attempt ID 防重复结算，跨进程原子预留。失败但可能已计费的调用保留未知/预留上限待核对，不以异常直接退还全部额度。

### 2.7

预算规则：allowedInput = min(阶段上限, 模型窗口减输出/推理保留与安全余量)。生产数值由有效配置快照给出，模型上限未知时用已验证的保守适配策略或拒绝准入；测试使用可重复的小预算，不写死某厂商窗口。

## 3. 流转与失败边界

1. 消息落库 → 精确动作/有界语义分类 → 引用与状态验证 → 当前需求/新需求/澄清/排队。
2. 按角色组装 → 最终请求计数 → 原子额度预留 → 模型/工具循环 → 去重结算 → 结果提交。
3. 输入超限 → 去重与相关性裁剪/检查点请求 → 最小证据仍超限则拆分或等待，不升级全历史注入。

业务状态提交成功后才允许外部派发；事务重试回调仅做纯数据更新。任何失败都保留可定位的请求/需求/运行身份，不能用重复模型调用代替状态核对。

## 4. 数据与接口影响

- 扩展 IntentContextSnapshot、IntentRoutingDecisionV2、ContextEnvelopeV2 的来源/预算诊断，不复制另一份上下文给 adapter。
- 新增拟定的 BudgetReservation/UsageSettlement：workItemId、operationId、attemptId、reserved/actual/unknown、input/output/cache 分类及版本；成本价格另由 2C 处理。

拟新增类型、状态和接口均为设计项，不是当前可调用 API。涉及持久化时，实施必须同步 shared、API/event/data/runtime/UI-state 合同、PostgreSQL projection/迁移和 file backend，不能只加内存 Map。

## 5. 修改边界

允许修改的候选落点（实施时按任务裁剪）：

- `apps/server/src/modules/message-routing/`
- `apps/server/src/modules/intent-recognition/`
- `apps/server/src/modules/context-management/`
- `apps/server/src/modules/context-v2/`
- `apps/server/src/common/token.ts`
- `apps/server/src/modules/runtime-invocation/`
- `apps/server/src/modules/runtimes/`
- `packages/local-runtime-cli/src/`
- `packages/shared/src/`

禁止修改：无关业务、项目凭据、用户授权目录、用户源码/未合并产物，以及非本阶段所需的全局页面样式。不将 Harness Engineering 新建为业务模块。

## 6. 实施次序与验证

按 [tasks](../implementation/main-agent-collaboration-phase-2a-tasks-v1.md) 顺序推进，每项先补失败用例/合同断言，再实现并最小回归。完整场景和命令见 [checklist](../quality/main-agent-collaboration-phase-2a-checklist-v1.md)；现有命令并不自动覆盖拟新增场景。

## 7. 风险、回退与未决参数

- 更严格预算可能暴露当前请求超大问题，应返回可理解的容量阻塞而非偷偷截断。
- 工具定义、输出 schema 与 CLI 内部历史可能不在平台初始估算中，需分适配器验证。

回退：停止新语义策略入口可回到已验证入口，但不绕过预算或确认检查；有未结算 reservation 的需求保留总账，不通过重试清零。

产品交互按总计划已沟通边界执行。模型预算、并发、缓存容量与 TTL 等环境参数不在文档中冒充现有配置；在阶段 0 冻结配置合同、相关阶段实现前记录有效值和验证依据。新增破坏性维护/外部服务采购/发布需单独确认，不影响本轮生成设计文档。

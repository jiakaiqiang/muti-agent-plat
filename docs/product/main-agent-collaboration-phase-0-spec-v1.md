# 阶段 0：合同收敛、现状基线与迁移边界 — Spec v1

> 日期：2026-09-16
> 状态：设计与实施基线，待实施；现有能力的复用不代表本阶段验收已完成。
> 依赖：无；作为所有阶段的入口。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-0-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-0-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-0-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-0-checklist-v1.md)

## 1. 目标与用户结果

将主 Agent 主持、专家按需协作、需求确认后选择工作流、长会话管理和会话隔离收敛为一套可追踪合同，先锁定边界再改变行为。

## 2. 范围与非目标

- 盘点现有实现、专项验收记录和未落地目标，建立 Spec → Task → Checklist 对照。
- 冻结业务身份、主 Agent 职责、状态所有权、消息/确认/事件合同及分阶段启用规则。

非目标：

- 本阶段不启用新讨论流程，不执行历史数据重放或清库。
- 不新增登录权限系统，不改模型供应商，不重做 Web/桌面布局。

## 3. 当前实现依据

- 现有 WorkItem、DecisionRecord、IntentContextSnapshot、SummaryMemoryCheckpoint 合同可复用；扩展而非另造同义对象。 [源码/既有文档](../../packages/shared/src/contracts.ts)
- 已有受保护系统 Agent 目录与角色解析；主 Agent 应复用 coordinator 身份，不按产品命名新增第二个调度者。 [源码/既有文档](../../apps/server/src/modules/agents/agent-catalog.service.ts)
- 现有精确命令、语义路由、消息入口已经拆分，不按旧设计文档中的“尚未实现”重新开发。 [源码/既有文档](../../apps/server/src/modules/message-routing/message-ingress.service.ts)

以上为现状定位，不等于本专项测试结果；实施前复核当前工作树，不覆盖无关改动。

## 4. 验收条件

- P0-AC1：统一业务身份：Agent 是共享定义；Session 是会话；WorkItem 是需求；讨论轮次/委派/工作流运行/模型调用各有独立 ID，不以 agentId 充当执行实例键。
- P0-AC2：主 Agent 是唯一正式用户沟通、需求文档发布、确认发起者；意图路由器只提建议，专家只提供分析/执行结果，工作流引擎负责已选图的节点流转。
- P0-AC3：保留用户已确认边界：先讨论并确认需求，再由用户选已发布流程；桌面流程目录只读；成员外邀请需用户确认；专家发言可见但不代替主 Agent 确认。
- P0-AC4：合同变更采用加法迁移，标注 proposed 与 implemented；保持 ContextEnvelopeV2 唯一运行输入及现有 Tool Authority。
- P0-AC5：建立可复现基线和迁移清单，历史专项的通过记录只作证据引用，不自动勾选本专项。
- P0-AC6：确认分阶段开关、有效参数快照、活动会话升级策略；破坏性操作和生产发布仍需单独授权。

## 5. 约束与风险

- 旧目标文档部分已过时，必须按本轮代码及可复核证据更新差异判断。
- 不将模型缓存时长、精确性能或节省百分比写成跨厂商保证。

共同约束：复用 v2-only、现有 Runtime/Tool Authority 和持久化事务边界；Web 与桌面共享业务状态但保留各自样式；不自动重跑历史任务、不清库、不变更凭据或外部权限。

## 6. 阶段退出

AC 全部有审查/测试证据；状态所有权、迁移与策略快照明确；实现边界没有待裁决冲突。

本阶段详细任务和证据填写位置见 Tasks/Checklist。只有实现与必须验证均完成后才可更新状态，文档生成不勾选开发项。

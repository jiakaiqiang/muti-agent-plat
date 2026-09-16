# 阶段 5：执行中补充、新需求与范围变更治理 — Spec v1

> 日期：2026-09-16
> 状态：设计与实施基线，待实施；现有能力的复用不代表本阶段验收已完成。
> 依赖：阶段 4 通过；使用 2A 意图、2B 决策版本和 3 主 Agent 协作。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-5-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-5-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-5-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-5-checklist-v1.md)

## 1. 目标与用户结果

工作流运行时用户仍可提问、@ 专家或补充需求，由主 Agent 判断回答、咨询、变更还是排队，不能悄悄修改正在执行的已确认范围。

## 2. 范围与非目标

- 建立执行期 ChangeRequest/待处理消息与 WorkItem 队列的关联、影响分析与用户选择。
- 支持暂停后修订重确认、相关/独立需求排队及主 Agent 统一反馈。

非目标：

- 不自动将新需求塞入运行中的任务契约，不将每条聊天都当作停止命令。
- 首版同一会话仅一个活动开发工作流，其他需求可讨论或排队；多会话仍可并行。

## 3. 当前实现依据

- 已有 FollowUp 消息队列、需求关系路由及延迟激活能力。 [源码/既有文档](../../apps/server/src/modules/message-routing/route-application.service.ts)
- 已有执行期消息与中断/恢复入口，应复用而非新增旁路执行。 [源码/既有文档](../../apps/server/src/modules/sessions/sessions.service.ts)
- 已有决策版本与需求继承 ID，支持将相关新需求与独立新需求隔离。 [源码/既有文档](../../apps/server/src/modules/context-management/context-management.service.ts)

以上为现状定位，不等于本专项测试结果；实施前复核当前工作树，不覆盖无关改动。

## 4. 验收条件

- P5-AC1：执行期消息先记录当前运行、需求和版本，再区分状态询问、解释、普通补充、范围变更、相关/独立新需求与明确停止。
- P5-AC2：主 Agent 能直接回答的只读问题不触发全员讨论；需要专家时保留用户 @ 并使用有界只读委派，扩员依旧需确认。
- P5-AC3：改变目标、验收、接口或产物范围时先形成 ChangeRequest 和影响分析，用户选择暂停修订、当前结束后处理或不变更。
- P5-AC4：选择暂停修订必须先停稳并冻结写回，然后修订文档、失效旧批准、重确认与校验流程；复用完成工作须有版本匹配证据。
- P5-AC5：相关/独立新需求建立各自 WorkItem，只有显式继承的有效决定/产物进入新需求；用户可选择参与讨论成员。
- P5-AC6：排队与切换幂等、有序、可查看；当前执行失败/完成/取消时按明确策略提示下一需求，不能因队列存在自动获得执行授权。
- P5-AC7：删除/停止/重启与执行期消息竞争时保持一致；迟到影响分析、缓存或咨询不能重新激活已失效请求。

## 5. 约束与风险

- 执行与影响分析并行可能使分析失效，必须把变更建议与实际暂停时快照再次对齐。
- 自动复用旧测试或旧完成状态可能把新需求误判完成，需要证据版本校验。

共同约束：复用 v2-only、现有 Runtime/Tool Authority 和持久化事务边界；Web 与桌面共享业务状态但保留各自样式；不自动重跑历史任务、不清库、不变更凭据或外部权限。

## 6. 阶段退出

执行期提问不误中断，范围变更经用户选择和重确认，新需求独立排队，旧回调/重启不误执行。

本阶段详细任务和证据填写位置见 Tasks/Checklist。只有实现与必须验证均完成后才可更新状态，文档生成不勾选开发项。

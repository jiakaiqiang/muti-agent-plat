# 阶段 3：主 Agent 主持讨论与可恢复专家协作 — Spec v1

> 日期：2026-09-16
> 状态：设计与实施基线，待实施；现有能力的复用不代表本阶段验收已完成。
> 依赖：阶段 1、2A、2B、2C 通过；核心正确性不依赖缓存命中。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-3-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-3-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-3-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-3-checklist-v1.md)

## 1. 目标与用户结果

用户提出需求后由主 Agent 主持，按需咨询专家、接收用户 @ 补充、处理分歧并统一给出综合方案与澄清问题。

## 2. 范围与非目标

- 用持久化话题/轮次/委派取代仅内存轮询式讨论控制，复用 Runtime 与已有有界咨询工具。
- 用户和主 Agent 都可请求专家协助，正式结论与用户确认统一由主 Agent 发出。

非目标：

- 不实现专家自主扩员、自主转派或无限讨论的蜂群。
- 讨论不直接修改项目源码、启动工作流或发送外部通知；文档发布与确认在阶段 4 完成。

## 3. 当前实现依据

- 当前 runDiscussion 按参与者进行有限轮次咨询；runFollowUpDiscussion 将专家结果送回 coordinator，但缺少本专项的话题/委派全生命周期。 [源码/既有文档](../../apps/server/src/modules/orchestrator/orchestrator.service.ts)
- 已有只读咨询有界并发，不能把工作流依赖节点直接改为同样的并行循环。 [源码/既有文档](../../apps/server/src/modules/orchestrator/bounded-consultation.ts)
- 已有受保护系统角色、用户 @ 参与成员校验和统一 Runtime 调用。 [源码/既有文档](../../apps/server/src/modules/agents/agent-catalog.service.ts)

以上为现状定位，不等于本专项测试结果；实施前复核当前工作树，不覆盖无关改动。

## 4. 验收条件

- P3-AC1：新需求进入主 Agent 主持的讨论；主 Agent 明确目标、缺口、必要专家及结束条件，不默认要求所有成员重复回答每条消息。
- P3-AC2：用户 @ 具体成员形成有归属的委派，专家可见回复同时回传主 Agent；不能被普通补充消息吞掉。
- P3-AC3：主 Agent 可在已选参与者内咨询；新增成员、不可用替代成员需用户确认，不按模型生成的名字擅自加入。
- P3-AC4：每个委派有输入需求版本、负责人、期望输出、截止/预算、状态和调用关联；重复提交/重启不重复启动已完成工作。
- P3-AC5：讨论和执行分离；专家结果只作为建议，主 Agent 汇总冲突/不确定性并统一向用户提问，不伪造专家一致同意。
- P3-AC6：讨论存在有界轮次、并发、总预算和退出条件；主 Agent/专家失败可恢复或等待用户，不重启整轮循环掩盖失败。
- P3-AC7：用户新补充使旧输入过期时，旧专家结果不能覆盖新需求；双端显示同一主 Agent/专家进度与来源。

## 5. 约束与风险

- 只修改提示词无法获得可靠调度和恢复，必须以持久化计划为准。
- 过多主 Agent/路由模型调用可能抵消裁剪收益，路由结论应复用，简单动作走确定性路径。

共同约束：复用 v2-only、现有 Runtime/Tool Authority 和持久化事务边界；Web 与桌面共享业务状态但保留各自样式；不自动重跑历史任务、不清库、不变更凭据或外部权限。

## 6. 阶段退出

用户 @、按需咨询、主 Agent 实质汇总、统一澄清、成员授权、版本与重启恢复全部通过，讨论无源码写副作用。

本阶段详细任务和证据填写位置见 Tasks/Checklist。只有实现与必须验证均完成后才可更新状态，文档生成不勾选开发项。

# 阶段 4：主 Agent 文档、精确确认与所选工作流交接 — Spec v1

> 日期：2026-09-16
> 状态：设计与实施基线，待实施；现有能力的复用不代表本阶段验收已完成。
> 依赖：阶段 3 通过，复用 1 与 2A～2C 的隔离、预算、记忆和缓存。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-4-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-4-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-4-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-4-checklist-v1.md)

## 1. 目标与用户结果

主 Agent 将讨论收敛为可查看、可比较、可确认的版本化方案；用户确认后选择系统发布的工作流，经过兼容性校验后只启动一次。

## 2. 范围与非目标

- 统一正式需求/方案文档发布者，绑定文档版本、需求版本和用户确认。
- 接入现有工作流目录、版本快照和运行引擎，保留文件 Diff、事件追溯与双端表现。

非目标：

- 不让主 Agent 创建/编辑/自动替换用户选择的流程图，不开放桌面流程编辑。
- 不把需求确认等同任何后续高风险工具授权；不将专家分析草稿当正式确认文档。

## 3. 当前实现依据

- 现有 Session 负责 brief 生成、确认、选择流程和恢复，需拆出稳定的文档/确认握手而非绕开原入口。 [源码/既有文档](../../apps/server/src/modules/sessions/sessions.service.ts)
- 已有流程版本/运行时与流转能力，继续用所选图，不另造自由任务流替代。 [源码/既有文档](../../apps/server/src/modules/workflows/workflow-runtime.service.ts)
- 已有桌面只读历史 Diff 与共享历史状态。 [源码/既有文档](../../apps/desktop/renderer/components/workspace/HistoricalDiffDialog.vue)
- 已有工作区四件套记录了流程目录与客户端只读边界。 [源码/既有文档](../../docs/product/codex-style-multi-agent-workspace-spec-v1.md)

以上为现状定位，不等于本专项测试结果；实施前复核当前工作树，不覆盖无关改动。

## 4. 验收条件

- P4-AC1：主 Agent 根据当前有效决策与专家结论发布需求/方案文档，包含目标、范围、非目标、验收、风险和待确认项；所有关键结论可追溯。
- P4-AC2：文档不可变版本保存，修改生成新版本与 Diff；草稿/正式/已确认/已替代状态清晰，文件点击保持现有对比体验。
- P4-AC3：确认绑定 sessionId/workItemId、需求版本、文档 ID/版本/hash、confirmationId 和业务指纹；重复幂等，过期拒绝并展示新差异。
- P4-AC4：需求确认后才进入流程选择；流程来自 Web 管理的已发布目录，客户端只读查看与使用，版本锁定后不可悄悄升级。
- P4-AC5：启动前校验角色能力、目录授权、有效确认、工作流版本、停止屏障和预算；缺成员/映射由主 Agent 解释并请求选择。
- P4-AC6：创建 WorkflowRun、绑定需求/文档快照和启动请求幂等；提交与派发分离且可重放，恢复不重复创建运行。
- P4-AC7：需求澄清、验收失败与返工结果由主 Agent 对接用户；工作流节点/返工路径依图运行，无合法边则明确等待处理。

## 5. 约束与风险

- 只检查 confirmationId 而不检查内容版本会批准过期需求。
- 流程下架、角色配置和目录授权可能在选中与启动之间变化，必须启动前再次核实。

共同约束：复用 v2-only、现有 Runtime/Tool Authority 和持久化事务边界；Web 与桌面共享业务状态但保留各自样式；不自动重跑历史任务、不清库、不变更凭据或外部权限。

## 6. 阶段退出

当前文档确认后按用户所选流程唯一启动，过期/重复操作安全；Diff、成员映射和质量返工可追溯。

本阶段详细任务和证据填写位置见 Tasks/Checklist。只有实现与必须验证均完成后才可更新状态，文档生成不勾选开发项。

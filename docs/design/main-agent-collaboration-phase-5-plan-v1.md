# 阶段 5：执行中补充、新需求与范围变更治理 — Plan v1

> 日期：2026-09-16
> 状态：设计与实施基线，待实施；现有能力的复用不代表本阶段验收已完成。
> 依赖：阶段 4 通过；使用 2A 意图、2B 决策版本和 3 主 Agent 协作。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-5-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-5-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-5-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-5-checklist-v1.md)

## 1. 目标、依据与决策

工作流运行时用户仍可提问、@ 专家或补充需求，由主 Agent 判断回答、咨询、变更还是排队，不能悄悄修改正在执行的已确认范围。

当前依据见同阶段 Spec 第 3 节。已沟通决定统一见总计划，本文将其映射为实现边界。

方案选择：沿用现有领域模块与共享合同，增量补强；不新增平行编排/上下文系统。收益是保持现有 Runtime、流程图、双端状态和数据可追溯性；代价是必须覆盖旧入口并完成版本兼容验证。

## 2. 可执行设计

### 2.1

复用 FollowUp/WorkItem/IntentRoutingRecord，拟增加 ChangeRequest 聚合或等价扩展：sourceEventId、baseWorkItemRevision、baseWorkflowRunId、affectedRefs、analysisRevision、choice、status、generation。是否新建实体由阶段 0 合同矩阵约束，不能形成两套排队真相。

### 2.2

分类器只提供关系与动作建议，主 Agent 负责可读影响说明和咨询规划；状态查询优先确定性读投影，避免为了回答进度调用多个模型。多意图消息拆为可追溯段落，其中高优先级停止先处理，剩余请求持久化待办。

### 2.3

变更状态候选：received → analyzing → waiting_user → deferred / rejected / stopping → revising → waiting_confirmation → ready。分析版本绑定当前运行，任务继续导致影响证据变化时重新校验而非复用过期分析。

### 2.4

暂停变更关闭新节点准入并冻结未完成写回，使用现有停止屏障。停稳后创建新文档修订；复用已有结果须校验文件 hash、输入/验收版本与测试证据，不做全量自动回滚，也不默认从头重跑。

### 2.5

若所选流程支持明确检查点重规划，按其合同恢复受影响节点；不支持则由主 Agent 说明并让用户选择重新运行/另建需求，不通过修改工作流图解决。

### 2.6

同会话首版保持一个活动开发工作流，咨询/新需求草稿可在独立需求上下文中进行但无项目写能力。多会话写入继续沿用现有 worktree/写回隔离，不引入共享根目录并发写旁路。

### 2.7

队列使用幂等源消息和稳定排序版本；取消/删除同步使待处理项失效。每次领取检查当前 generation、用户选择、文档批准与预算，不能把“稍后处理”解释为无条件自动开发。

## 3. 流转与失败边界

1. 执行中消息 → 明确控制/只读回答/目标咨询/范围变更/新 WorkItem。
2. 范围变更 → 主 Agent 影响分析 → 用户选择：暂缓 / 放弃 / 停稳后修订。
3. 停稳 → 新文档版本 → 用户重确认 → 所选流程兼容校验 → 受影响节点恢复或用户选择重开。

业务状态提交成功后才允许外部派发；事务重试回调仅做纯数据更新。任何失败都保留可定位的请求/需求/运行身份，不能用重复模型调用代替状态核对。

## 4. 数据与接口影响

- 拟扩展 UserMessageHandlingPlan、FollowUp/ChangeRequest 投影及用户选择动作，记录 base/target 版本、影响证据和选择来源。
- 共享事件明确 change_received/analysis_ready/deferred/revision_required 等候选语义，展示由主 Agent 统一承担；客户端不自行决定暂停。

拟新增类型、状态和接口均为设计项，不是当前可调用 API。涉及持久化时，实施必须同步 shared、API/event/data/runtime/UI-state 合同、PostgreSQL projection/迁移和 file backend，不能只加内存 Map。

## 5. 修改边界

允许修改的候选落点（实施时按任务裁剪）：

- `apps/server/src/modules/message-routing/`
- `apps/server/src/modules/intent-recognition/`
- `apps/server/src/modules/context-management/`
- `apps/server/src/modules/sessions/`
- `apps/server/src/modules/orchestrator/`
- `apps/server/src/modules/workflows/`
- `apps/web/src/stores/`
- `apps/web/src/components/`
- `apps/desktop/renderer/components/`
- `packages/shared/src/`

禁止修改：无关业务、项目凭据、用户授权目录、用户源码/未合并产物，以及非本阶段所需的全局页面样式。不将 Harness Engineering 新建为业务模块。

## 6. 实施次序与验证

按 [tasks](../implementation/main-agent-collaboration-phase-5-tasks-v1.md) 顺序推进，每项先补失败用例/合同断言，再实现并最小回归。完整场景和命令见 [checklist](../quality/main-agent-collaboration-phase-5-checklist-v1.md)；现有命令并不自动覆盖拟新增场景。

## 7. 风险、回退与未决参数

- 执行与影响分析并行可能使分析失效，必须把变更建议与实际暂停时快照再次对齐。
- 自动复用旧测试或旧完成状态可能把新需求误判完成，需要证据版本校验。

回退：停用新变更提交后保留已经确认的选择和停止屏障，待处理请求转为显式等待；不能悄悄丢弃队列或恢复旧范围执行。

产品交互按总计划已沟通边界执行。模型预算、并发、缓存容量与 TTL 等环境参数不在文档中冒充现有配置；在阶段 0 冻结配置合同、相关阶段实现前记录有效值和验证依据。新增破坏性维护/外部服务采购/发布需单独确认，不影响本轮生成设计文档。

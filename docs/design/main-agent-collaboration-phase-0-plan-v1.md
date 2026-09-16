# 阶段 0：合同收敛、现状基线与迁移边界 — Plan v1

> 日期：2026-09-16
> 状态：设计与实施基线，待实施；现有能力的复用不代表本阶段验收已完成。
> 依赖：无；作为所有阶段的入口。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-0-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-0-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-0-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-0-checklist-v1.md)

## 1. 目标、依据与决策

将主 Agent 主持、专家按需协作、需求确认后选择工作流、长会话管理和会话隔离收敛为一套可追踪合同，先锁定边界再改变行为。

当前依据见同阶段 Spec 第 3 节。已沟通决定统一见总计划，本文将其映射为实现边界。

方案选择：沿用现有领域模块与共享合同，增量补强；不新增平行编排/上下文系统。收益是保持现有 Runtime、流程图、双端状态和数据可追溯性；代价是必须覆盖旧入口并完成版本兼容验证。

## 2. 可执行设计

### 2.1

角色决策：产品称“主 Agent”，后端继续通过 AgentCatalog.resolveSystemRole 解析 coordinator；其 Profile/模型可配置，但不得绕过系统 Agent 保护策略。意图识别保留独立、只读、结构化建议职责，避免主 Agent 与路由器重复分类同一消息。

### 2.2

身份链拟统一为 sessionId → workItemId → discussionId/delegationId 或 workflowRunId/taskId → operationId → invocationId，并关联 profileRevision、contextSnapshotId、generation。现有字段先复用；generation 表示会话/轮次写入资格，不用全局数据库 revision。

### 2.3

主 Agent 专有动作是发布综合结论、正式需求文档和用户确认；领域服务校验并持久化后才生效。专家可在群聊显示可见结论，不允许其直接推进已确认范围或向用户生成另一套待确认卡。

### 2.4

状态分别归属：Session 管会话准入/生命周期，WorkItem 管需求版本，讨论对象管话题/委派，WorkflowRun 管图节点，LogicalOperation 管调用预算与停止证据。聊天文案与前端 busy 状态均不是状态真相。

### 2.5

所有拟新增实体在进入实现前映射 existing collection/新增 projection；事务、事件 outbox、唯一幂等键、file/PostgreSQL 对等作为统一合同。数据库迁移编号实施时读取最新版本，不在本文预占。

### 2.6

历史 v2 会话不自动改变运行语义：存量活动执行保留当前策略快照，停稳/完成后显式升级；已退役 dataEpoch 不复活。新能力开关是本专项策略，不恢复已经废弃的 CONTEXT_PIPELINE_V2_ENABLED。

## 3. 流转与失败边界

1. 读取当前代码、测试和各专项 Checklist → 建立实现差异表。
2. 把已讨论产品决定写成合同与状态所有权表 → 固化版本/幂等/安全不变量。
3. 准备隔离 fixture 与迁移演练方案 → 基线验收后准入阶段 1。

业务状态提交成功后才允许外部派发；事务重试回调仅做纯数据更新。任何失败都保留可定位的请求/需求/运行身份，不能用重复模型调用代替状态核对。

## 4. 数据与接口影响

- 拟新增/扩展字段统一登记：会话生命周期与 generation、讨论/委派 ID、文档版本与内容 hash、确认绑定、上下文依赖版本、缓存用量。字段名为设计候选，阶段入口完成正式共享合同。
- API 继续基于现有 Sessions/Workflow 入口；新增操作必须在 API、event、data、runtime、UI-state 合同同步，未知事件安全忽略，未知执行状态不可默认为允许。

拟新增类型、状态和接口均为设计项，不是当前可调用 API。涉及持久化时，实施必须同步 shared、API/event/data/runtime/UI-state 合同、PostgreSQL projection/迁移和 file backend，不能只加内存 Map。

## 5. 修改边界

允许修改的候选落点（实施时按任务裁剪）：

- `packages/shared/src/`
- `docs/contracts/`
- `apps/server/src/modules/agents/`
- `apps/server/src/modules/sessions/`
- `tests/harness-engineering/`

禁止修改：无关业务、项目凭据、用户授权目录、用户源码/未合并产物，以及非本阶段所需的全局页面样式。不将 Harness Engineering 新建为业务模块。

## 6. 实施次序与验证

按 [tasks](../implementation/main-agent-collaboration-phase-0-tasks-v1.md) 顺序推进，每项先补失败用例/合同断言，再实现并最小回归。完整场景和命令见 [checklist](../quality/main-agent-collaboration-phase-0-checklist-v1.md)；现有命令并不自动覆盖拟新增场景。

## 7. 风险、回退与未决参数

- 旧目标文档部分已过时，必须按本轮代码及可复核证据更新差异判断。
- 不将模型缓存时长、精确性能或节省百分比写成跨厂商保证。

回退：本阶段默认无行为切换；合同版本评审未通过时只回退设计，保留已采集基线。将来涉及 schema 的回退必须先验证旧代码能读取新数据。

产品交互按总计划已沟通边界执行。模型预算、并发、缓存容量与 TTL 等环境参数不在文档中冒充现有配置；在阶段 0 冻结配置合同、相关阶段实现前记录有效值和验证依据。新增破坏性维护/外部服务采购/发布需单独确认，不影响本轮生成设计文档。

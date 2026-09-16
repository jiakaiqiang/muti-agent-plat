# 阶段 2B：版本化长期记忆、增量摘要与历史需求召回 — Plan v1

> 日期：2026-09-16
> 状态：设计与实施基线，待实施；现有能力的复用不代表本阶段验收已完成。
> 依赖：阶段 2A 通过；使用阶段 1 生命周期/取消屏障。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-2b-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-2b-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-2b-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-2b-checklist-v1.md)

## 1. 目标、依据与决策

长期保留聊天与产物，但只向模型提供当前需求的有效事实、增量摘要和按需证据；历史可召回，新决定不会被旧摘要覆盖。

当前依据见同阶段 Spec 第 3 节。已沟通决定统一见总计划，本文将其映射为实现边界。

方案选择：沿用现有领域模块与共享合同，增量补强；不新增平行编排/上下文系统。收益是保持现有 Runtime、流程图、双端状态和数据可追溯性；代价是必须覆盖旧入口并完成版本兼容验证。

## 2. 可执行设计

### 2.1

存储事实分层：事件与 artifact 正文为可追溯原始材料；DecisionRecord/版本化需求文档是权威状态；SummaryMemoryCheckpoint 是可重建的派生数据。已确认来源优先于模型摘要，矛盾内容需明确 supersedes 关系。

### 2.2

扩展检查点元数据：checkpointId、sessionId/workItemId、coveredEventSeq、workItemRevision、decisionLedgerRevision、sourceRefs、policyVersion、contentHash、generation。唯一逻辑键采用需求+覆盖范围+版本指纹，生成过程不持有长数据库事务。

### 2.3

先读取不可变快照并预留摘要预算，再生成增量摘要，提交时验证消息范围、需求版本与生命周期。语义数据版本变更则拒绝旧结果；心跳/流式进度不无故使摘要失效。

### 2.4

摘要状态仅保留有效事实、已做/未做事项、当前风险与待办，并引用原文。新增/修改/解决是不同操作；不能只累加 openQuestions。用来源回查/抽样校验控制多代摘要漂移，不把模型置信度当用户确认。

### 2.5

归档索引只保存需求标题、状态、时间、关键词、摘要引用和依赖版本。先按显式引用检索，再按词法/别名匹配，有已授权可用语义能力时加语义候选并重排；最终读取受预算限制的正文。首版不要求额外 SaaS，能力不足需标注并澄清。

### 2.6

把按会话全量 Map 的读取逐步替换为分页与按需求查询；派生缓存有 LRU/容量上限。数据库查询索引、file 模式等价行为和历史懒加载纳入测试；原始持久化数据的保留不受缓存 TTL 支配。

### 2.7

Runtime conversationKey 至少包含 sessionId/workItemId/role/上下文代次，不复用 agentId 的全局 CLI 会话。达到内部窗口阈值时先写检查点、确认当前调用停稳，再受控创建新上下文；调用结果与副作用去重仍由原 operationId 体系控制。

## 3. 流转与失败边界

1. 新消息/阶段变化 → 更新权威需求与决策 → 判断阈值 → 快照增量摘要 → 版本验证提交检查点。
2. 用户提及旧需求 → 有界候选召回 → 明确选中/澄清 → 读取有效决定与必要证据 → 重建当前工作上下文。
3. CLI 接近容量 → 保存交接检查点 → 停稳当前执行 → 新上下文代次 → 显式/既有授权范围内续接未完成步骤。

业务状态提交成功后才允许外部派发；事务重试回调仅做纯数据更新。任何失败都保留可定位的请求/需求/运行身份，不能用重复模型调用代替状态核对。

## 4. 数据与接口影响

- 扩展现有 SummaryMemoryCheckpoint，而非让新旧摘要服务同时发布。新增历史需求检索/分页接口与来源可用性标记，接口返回受访问范围限制的候选。
- 摘要生成任务纳入统一 operation、取消、预算和持久化恢复；删除墓碑排除归档索引，恢复时重新验证版本再建索引。

拟新增类型、状态和接口均为设计项，不是当前可调用 API。涉及持久化时，实施必须同步 shared、API/event/data/runtime/UI-state 合同、PostgreSQL projection/迁移和 file backend，不能只加内存 Map。

## 5. 修改边界

允许修改的候选落点（实施时按任务裁剪）：

- `apps/server/src/modules/memory/`
- `apps/server/src/modules/context-management/`
- `apps/server/src/modules/orchestrator/`
- `apps/server/src/modules/persistence/`
- `apps/server/src/modules/rag/`
- `packages/local-runtime-cli/src/`
- `packages/shared/src/`

禁止修改：无关业务、项目凭据、用户授权目录、用户源码/未合并产物，以及非本阶段所需的全局页面样式。不将 Harness Engineering 新建为业务模块。

## 6. 实施次序与验证

按 [tasks](../implementation/main-agent-collaboration-phase-2b-tasks-v1.md) 顺序推进，每项先补失败用例/合同断言，再实现并最小回归。完整场景和命令见 [checklist](../quality/main-agent-collaboration-phase-2b-checklist-v1.md)；现有命令并不自动覆盖拟新增场景。

## 7. 风险、回退与未决参数

- 摘要有损且检索可能漏召回，必须保留原文/权威状态和澄清通道。
- 应用侧限上下文不能自动限制第三方 CLI 私有历史，须按适配器声明能力。

回退：停用摘要生成/语义检索时仍使用当前权威状态和已有有效检查点；不得退回全历史注入。不删除检查点或原文，索引可按版本重建。

产品交互按总计划已沟通边界执行。模型预算、并发、缓存容量与 TTL 等环境参数不在文档中冒充现有配置；在阶段 0 冻结配置合同、相关阶段实现前记录有效值和验证依据。新增破坏性维护/外部服务采购/发布需单独确认，不影响本轮生成设计文档。

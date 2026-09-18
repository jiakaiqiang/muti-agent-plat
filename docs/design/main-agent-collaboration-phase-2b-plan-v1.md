# 阶段 2B：版本化长期记忆、增量摘要与历史需求召回 — Plan v1

> 日期：2026-09-16
> 状态：已实现并验收（2026-09-18）；实现证据见 Tasks/Checklist。
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

事件读取已提供 cursor/limit 分页（默认 200、最大 500）。PostgreSQL 直接执行数据库页查询；file backend 返回同形状的有界页，并用 32 页 LRU、事件写入/会话删除失效控制派生缓存。原始数据不受缓存淘汰影响。file backend 启动仍加载完整 JSON/事件投影，因此这里只声明请求级有界，不声明存储完全懒加载；生产长历史以 PostgreSQL 路径为准。

### 2.7

Runtime conversationKey 至少包含 sessionId/workItemId/role/上下文代次，不复用 agentId 的全局 CLI 会话。达到内部窗口阈值时先写检查点、确认当前调用停稳，再受控创建新上下文；调用结果与副作用去重仍由原 operationId 体系控制。

## 3. 流转与失败边界

1. 新消息/阶段变化 → 更新权威需求与决策 → 判断阈值 → 快照增量摘要 → 版本验证提交检查点。
2. 用户提及旧需求 → 有界候选召回 → 明确选中/澄清 → 读取有效决定与必要证据 → 重建当前工作上下文。
3. CLI 接近容量 → 保存交接检查点 → 停稳当前执行 → 新上下文代次 → 显式/既有授权范围内续接未完成步骤。

业务状态提交成功后才允许外部派发；事务重试回调仅做纯数据更新。任何失败都保留可定位的请求/需求/运行身份，不能用重复模型调用代替状态核对。

## 4. 数据与接口影响

- 已加法扩展 `SummaryMemoryCheckpoint`，并新增独立 `SummaryCheckpointRecord`/V12 `summary_checkpoints` 持久化；旧 artifact 内嵌检查点仍可读取。
- 历史召回结果进入版本化 Intent Snapshot；`GET /sessions/:id/events?limit=` 返回有界页，不带 `limit` 保持旧响应兼容。
- 摘要检查点提交受 Session lifecycle generation/admission、WorkItem/Decision revision 和可选 WorkItem 摘要预算约束；原始事件/产物不被压缩删除。
- CLI invocation 记录补充 WorkItem/上下文代次边界和累计输入轮换阈值，副作用继续由既有 LogicalOperation 去重。

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

T1-T6 已按 [tasks](../implementation/main-agent-collaboration-phase-2b-tasks-v1.md) 完成。定向回归 176/176、独立 PostgreSQL 11/11、预算/记忆/取消/恢复/删除 E2E、全仓 typecheck/test/Harness/build 均通过；完整命令和退出码见 [checklist](../quality/main-agent-collaboration-phase-2b-checklist-v1.md)。

## 7. 风险、回退与未决参数

- 摘要有损且检索可能漏召回，必须保留原文/权威状态和澄清通道。
- 应用侧限上下文不能自动限制第三方 CLI 私有历史，须按适配器声明能力。

回退：停用摘要生成/语义检索时仍使用当前权威状态和已有有效检查点；不得退回全历史注入。不删除检查点或原文，索引可按版本重建。

本阶段未接入外部语义检索或真实付费模型；无匹配或低可信召回均走澄清。file backend 的启动期完整投影属于已知开发模式限制，后续若要消除需单独重构持久化装载模型，不能用本阶段的有界页测试冒充完成。新增破坏性维护、外部服务采购、部署或发布仍需单独确认。

# 阶段 2B：版本化长期记忆、增量摘要与历史需求召回 — Spec v1

> 日期：2026-09-16
> 状态：已实现并验收（2026-09-18）；证据见同阶段 Checklist。
> 依赖：阶段 2A 通过；使用阶段 1 生命周期/取消屏障。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-2b-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-2b-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-2b-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-2b-checklist-v1.md)

## 1. 目标与用户结果

长期保留聊天与产物，但只向模型提供当前需求的有效事实、增量摘要和按需证据；历史可召回，新决定不会被旧摘要覆盖。

## 2. 范围与非目标

- 增强现有 SummaryMemoryCheckpoint 与 DecisionRecord，不另造一套事实账本。
- 按 WorkItem 建立归档索引、历史需求召回和受控 CLI 上下文轮换。

非目标：

- 不删除原始聊天来节约 Token，不每次加载所有历史需求摘要。
- 不把全部专家发言自动提升为项目长期规则；不强制新增外部向量服务或发送历史数据给新供应商。

## 3. 当前实现

- `SummaryCheckpointRecord` 以 WorkItem、事件覆盖序号、需求/决策版本、策略版本、generation 和来源引用持久化；同一逻辑键只允许一次有效提交，迟到版本拒绝。 [实现](../../apps/server/src/modules/memory/summary-checkpoint-store.ts)
- 阶段结束、需求结束和事件阈值进入统一检查点服务；本地派生不调用模型，模型化生成入口支持摘要预算预留，持久化提交最多重试 3 次。 [实现](../../apps/server/src/modules/memory/summary-checkpoint.service.ts)
- 当前摘要只从有效 `DecisionRecord` 派生决定；需求/决策版本变化时不转发旧事实，已确认约束与验收标准保留，superseded 决策仅作为来源回查。 [实现](../../apps/server/src/modules/memory/summary-memory-derivation.ts)
- WorkItem 归档索引只保留元数据和检查点引用，显式引用优先，词法候选有界；低可信、相似候选或索引故障均要求澄清。 [实现](../../apps/server/src/modules/context-management/work-item-recall.ts)
- 事件 API 支持游标分页；PostgreSQL 走数据库分页，file backend 提供有界页和 32 页 LRU。CLI 续接同时校验 WorkItem 与上下文代次，达到阈值后轮换且复用 operation 去重。 [实现](../../apps/server/src/modules/events/events.service.ts)

已知边界：file backend 仍在启动时加载完整 JSON，并由 `EventsService` 保留完整事件投影；它不是完全懒加载的生产存储。阶段 2B 验收的是有界 API/缓存、PostgreSQL 数据库分页和模型上下文隔离，不把该开发模式限制描述为已消除。

## 4. 验收条件

- P2B-AC1：原始事件/产物、权威决策、工作摘要和运行输入分层；压缩不删除原始数据，不使模型摘要成为确认事实。
- P2B-AC2：检查点按需求与消息范围增量生成，绑定 workItemRevision、decisionRevision、coveredEventSeq、来源、生成策略版本；同一输入只提交一次。
- P2B-AC3：用户修订后旧决定标记被替代；摘要提交使用快照版本和 generation 检查，不可让迟到摘要覆盖新事实。
- P2B-AC4：历史需求召回按当前消息检索有界候选，支持精确引用、关键词/别名及可选语义检索；低可信结果先澄清。
- P2B-AC5：归档/召回保持 Session/WorkItem 边界，继承项目规则须有显式有效来源；检索失败不解释为历史不存在。
- P2B-AC6：阶段结束、需求结束或预算阈值触发摘要；保留硬约束、未决问题、下一步及来源，摘要失败有界重试且不阻塞停止。
- P2B-AC7：服务端历史分页/数据库查询与有界内存缓存配套；CLI 内部历史也按需求隔离，轮换只交接状态不重播副作用。

## 5. 约束与风险

- 摘要有损且检索可能漏召回，必须保留原文/权威状态和澄清通道。
- 应用侧限上下文不能自动限制第三方 CLI 私有历史，须按适配器声明能力。

共同约束：复用 v2-only、现有 Runtime/Tool Authority 和持久化事务边界；Web 与桌面共享业务状态但保留各自样式；不自动重跑历史任务、不清库、不变更凭据或外部权限。

## 6. 阶段退出

长会话可继续、旧需求可追溯、旧摘要不能覆盖新决定、取消与 CLI 交接不重播副作用；最终输入通过 2A 预算。

本阶段详细任务和证据见 Tasks/Checklist。7 条 AC 已通过确定性测试、独立 PostgreSQL、关键 E2E 和全仓门禁；未执行真实付费模型、部署或发布。

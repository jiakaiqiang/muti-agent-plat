# TASK.md — 阶段 2B：版本化长期记忆、增量摘要与历史需求召回

状态：T1-T6 已完成，P2B-AC1～AC7 已验收（2026-09-18）。阶段 2C 及以后未开始。

依据文档（四件套，2026-09-16 生成）：
`docs/product/main-agent-collaboration-phase-2b-spec-v1.md`（AC）、
`docs/design/main-agent-collaboration-phase-2b-plan-v1.md`（设计与落点）、
`docs/implementation/main-agent-collaboration-phase-2b-tasks-v1.md`（任务）、
`docs/quality/main-agent-collaboration-phase-2b-checklist-v1.md`（验收与证据）。

前置：阶段 0、1、2A 已验收（2A 于 2026-09-17 回填，其 TASK 记录已转入 2A Checklist §5）。

**纪律**：严格串行；每项先补失败用例再实现；每项结束时仓库必须绿；
持久化改动必须同步 shared 合同 + file backend + PostgreSQL 迁移/投影（不能只加内存 Map）。

## 开工前已核实的代码事实（2026-09-17）

- `SummaryMemoryCheckpoint`（`contracts.ts:2578`）只有 checkpointId/sessionId/workItemId/phase/
  agentId/summaryMemory/source*Ids/createdAt；**无** coveredEventSeq、workItemRevision、
  decisionLedgerRevision、policyVersion、contentHash、generation、唯一逻辑键。
- 检查点**没有独立集合**：嵌在 `artifacts` 的 `metadata.summaryMemoryCheckpoint` 里，
  `latestSummaryMemoryCheckpoint` 逆序扫全部 artifact；无跨进程唯一提交。
- `createSummaryMemory`（orchestrator 6379）纯字符串合并 + 限条；`openQuestions` 只累加不消解；
  `decisions` 取自事件 content 而非 `DecisionRecord`，被替代的决策无法从摘要中剔除。
- `createSummaryMemoryCheckpoint` 同步、无模型调用、无预算预留、无生命周期/版本校验，
  在 brief_generation / task_execution / post_review / final_delivery 四处调用。
- `DecisionRecord` 已有 `supersedesDecisionId` + `superseded` 状态（`recordDecision`）。
- `MemoryService`：按会话全量 Map + 关键词评分；`search(sessionId, …)` 天然按会话隔离，
  但无 WorkItem 维度、无分页、无归档索引。
- CLI 续接键 `findPriorInvocation(sessionId, agentId, taskId, runtimeType)`，无 workItemId/
  role/上下文代次；无轮换检查点。
- 阶段 2A 已提供 `WorkItemBudgetStore`（含 `summary` 类别）与 `LogicalOperationStore`，
  T2 的预算预留与 single-flight 复用它们。

## T1 扩展权威事实与检查点合同（AC1/AC2/AC3）

- [x] T1-1 shared：`SummaryMemoryCheckpoint` 加法扩展（coveredEventSeq/workItemRevision/
      decisionLedgerRevision/policyVersion/contentHash/generation/logicalKey/sourceDecisionIds，
      均可选以兼容旧 artifact 内嵌检查点）；新增 `SummaryCheckpointRecord`、
      `SUMMARY_CHECKPOINT_POLICY_VERSION`、`SummaryCheckpointRejectionCode`
- [x] T1-2 `memory/summary-checkpoint-store.ts`：逻辑键 = workItemId|seq|wi|dl|policy；
      同键并发 → 恰一个 `committed` 一个 `duplicate`；旧 workItemRevision/decisionLedgerRevision
      → `SUMMARY_CHECKPOINT_STALE_VERSION`；覆盖范围倒退 → `_COVERAGE_REGRESSED`；
      旧 generation → `_STALE_GENERATION`；**拒绝不落盘**（沿用 2A T5-2 教训）
- [x] T1-3 PostgreSQL：`summaryCheckpointsBySession` 接入 6 处约定（KNOWN/SESSION_KEYED/
      两处 load/write switch/writer/writeOrder）；V12 `summary_checkpoints`
      （`logical_key` unique、行不可变 `on conflict do nothing`）；cutover seed 与 schema
      COMMENT 门禁同步。一次性临时库 11/11 已通过，含跨实例唯一提交、迟到旧版本拒绝和分页。

## T2 实现增量摘要任务（AC2/AC3/AC6）

- [x] T2-1 `SummaryCheckpointService.shouldCheckpoint`：同逻辑键 → `already_covered`；
      `budget_threshold` 需新事件 ≥ 24 或版本变动；phase/work_item 边界有变动即摘要
- [x] T2-2 生成前 `structuredClone` 快照、预留 `summary` 类别预算（不足 → `budget_insufficient`
      跳过不生成）；提交走 store 版本校验；按实际摘要体积结算
- [x] T2-3 提交有界重试 3 次；生成器抛错 → 按预留上限记 unknown、返回 `failed` 不抛；
      orchestrator 五处 `createSummaryMemoryCheckpoint` 改 `await`，非 `committed` 不再
      物化 memory/artifact（同一覆盖范围不会二次摘要）。本地派生无模型调用，故未传 budget。

## T3 实现决策替代与摘要校验（AC1/AC3/AC6）

- [x] T3-1 `memory/summary-memory-derivation.ts`：decisions 只取 `DecisionRecord.status==='confirmed'`
      并带 `[id]` 前缀；**不再从上一检查点合并转发**，superseded 当场消失；proposed 不入 facts
- [x] T3-2 `reconcileOpenQuestions`：added/resolved/open 三态；被新确认决策回答的问题被消解
      （关键词重叠，CJK 用二元组）；brief/review 事件正文不进入 `confirmedFacts`，只通过
      `sourceEventIds` 保留来源回查，避免旧需求文本重新污染当前上下文
- [x] T3-3 迟到摘要拒绝由 T1-2 store 覆盖；`sourceDecisionIds` 落到检查点供回查

## T4 实现有界历史召回（AC4/AC5）

- [x] T4-1 `context-management/work-item-recall.ts`：归档索引只含标题/状态/时间/关键词/
      最新检查点引用/coveredEventSeq，不含正文（用例断言）
- [x] T4-2 显式引用 → 词法二元组重排 → 有界（默认 5）；`no_match`/`low_confidence`/
      `multiple_similar_candidates`（次优 ≥ 最优 80%）→ `needsClarification`
- [x] T4-3 `index.availability==='limited'` → `index_unavailable`，不解释为"不存在"；
      `buildIntentSnapshot` 接入召回并把 `recall` 写进快照（含 hash）；router 新增
      `HISTORICAL_RECALL_AMBIGUOUS`：召回要求澄清时模型擅自选中召回候选 → 不自动应用。
      跨会话隔离由既有 `listWorkItems(sessionId)` 天然保证。语义检索首版未接（能力不足即澄清）。

## T5 实现历史分页与 CLI 交接（AC5/AC7）

- [x] T5-1 `EventsService.listPage`（cursor + limit，夹在 [1,500]，默认 200）；
      `GET /sessions/:id/events?limit=` 走分页，不带 `limit` 保持旧全量形状；PostgreSQL
      执行数据库页查询，file backend 使用 32 页 LRU 并在写入/删除时失效。file 启动仍加载
      完整 JSON/事件投影，不宣称完全懒加载
- [x] T5-2 `findPriorInvocation` 增加 `{ workItemId }` 作用域 + `contextGeneration`
      （记录在 invocation log）；跨需求或代次已恢复的会话不复用 CLI 私有历史；
      orchestrator 调用点传入 `resolvedPlan.workItemId`
- [x] T5-3 轮换：同 cliSessionId 累计 `usage.inputTokens` ≥ `CLI_CONTEXT_ROTATION_INPUT_TOKENS`
      （默认 150k）→ 不 resume、计 `cli_context_rotated_total`；状态由阶段末检查点交接，
      副作用去重仍由 `LogicalOperation` 控制（未改）

## T6 验证长会话与摘要竞争（AC1–AC7）

- [x] T6-1 百需求/千消息 fixture；早期需求召回——context-management spec
      「an early requirement among a hundred…」现含 100 需求 + 1,000 消息 + 版本化检查点，
      断言召回命中早期需求、携带 `latestCheckpointId`、不内联摘要正文、序列化 < 40 KB
- [x] T6-2 版本冲突 / 删除 / 重启 / 模型失败 / 原文保留——store spec
      （旧版本/覆盖倒退/旧代次/准入关闭拒绝、重建后可读、原始事件不被改写）+ service spec
      （生成器失败按预留上限记 unknown 且不抛）+ postgres 集成（跨实例并发一提交、迟到旧版本拒绝）
- [x] T6-3 typecheck + test + harness + build；定向、PostgreSQL、关键 E2E 及 Checklist 证据已回填

## 验证结果（2026-09-18）

- 2B 定向回归：176/176，通过。
- 独立 PostgreSQL：11/11，通过；一次性数据库已删除。
- E2E：memory-confirm、token-budget、work-item-budget-recovery、cancel、recovery、session-delete 全部通过。
- 全仓：`npm run typecheck`、`npm run test`、`npm run test:harness`、`npm run build` 全部通过。
- `work-item-budget-recovery` fixture 从 2,000 调整为 2,100：为单次输入保留已确认约束/验收摘要的余量，同时仍验证累计 WorkItem 预算耗尽及缩小需求恢复；没有改变生产预算逻辑。
- `git diff --check` 仅报告既有 `context-management.service.spec.ts` EOF 空行，未擅自清理。

## 遗留（上一专项，未完成）

- [ ] 中断会话续接 G3：`npm run dev:restart-server` + 真实场景手测（上一专项人工项，不是 2B 门禁）。
- [x] 2A 临时文件 `apps/server/src/modules/runtimes/debug-guard.spec.ts` 当前不存在。

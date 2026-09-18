# TASK.md — 阶段 4：主 Agent 文档、精确确认与所选工作流交接

状态：进行中（2026-09-19 开工）。阶段 3 已于同日验收（用户确认），准入成立。

依据文档（四件套，2026-09-16 生成）：
`docs/product/main-agent-collaboration-phase-4-spec-v1.md`（AC）、
`docs/design/main-agent-collaboration-phase-4-plan-v1.md`（设计与落点）、
`docs/implementation/main-agent-collaboration-phase-4-tasks-v1.md`（任务）、
`docs/quality/main-agent-collaboration-phase-4-checklist-v1.md`（验收与证据）。

前置：阶段 0、1、2A、2B、2C、3 已验收（3 的记录见其 Checklist §5 与提交 `f80e27f`）。
阶段 3 承接项（已挂在 P4-T2 / P4-T5）：两张确认卡的选项处理、双端呈现、`blocked` 写入方、
`MAIN_AGENT_DISCUSSION_ENABLED` 默认值。

**纪律**：严格串行；每项先补失败用例再实现；每项结束时仓库必须绿；
持久化改动必须同步 shared 合同 + file backend + PostgreSQL 迁移/投影；
主 Agent 只发布/提议，确认与启动由领域事务落实；**不让模型创建/编辑/替换用户选的流程图**。

## 开工前已核实的代码事实（2026-09-19）

- `sessions.service.ts confirmBrief`（:2767）只检查三件事：brief 是 `currentTaskBriefId`、
  确认卡按 confirmationId+reason 存在且未 resolved。**不检查**需求 revision、brief 正文 hash、
  业务指纹——这正是 spec §5 第一条风险"只检查 confirmationId 会批准过期需求"（AC3 缺口）。
- `TaskBrief` 只有 `version: number`；**没有** contentHash、状态（草稿/正式/已确认/已替代）、
  sourceDecisionIds / sourceDelegationIds（AC1/AC2 缺口）。阶段 3 的 `run.synthesis.
  sourceDelegationIds` 已可作为文档来源引用。
- 阶段 0 冻结的 `RequirementConfirmationBinding`（sessionId/workItemId/workItemRevision/
  confirmationId/documentId/documentRevision/contentHash/businessFingerprint）与
  `matchesRequirementConfirmation` 在服务端**零消费者**——T2 的确认事务应直接消费它。
- `selectWorkflow`（:2873）：要求 `WAIT_WORKFLOW_SELECT`、workflow published、brief
  `confirmedByUser`、`getVersion` 取版本；**把 `version.involvedAgentIds` 静默并入
  `participatingAgentIds`**——AC5 要求"缺成员/映射由主 Agent 解释并请求选择"，不是静默扩员。
- `workflowRuntime.start`（`workflow-runtime.service.ts:193`）：幂等键 = `${sessionId}:
  ${confirmationId}`（同键返回既有 run），校验 generation、published、版本；**只绑
  confirmationId，不绑文档 hash / 需求 revision**（AC6 "绑定需求/文档快照" 缺口）。
  是否已有事务 outbox 派发与 worker 唯一领取需在 T4 核实（plan §2.6）。
- 桌面端已有 `HistoricalDiffDialog.vue` 只读 Diff；web 端 `SessionWorkspace.vue`。双端复用 API/store，
  T5 只改必要展示。
- 阶段 3 留下的可直接复用件：`DiscussionRun.synthesis`（署名结论 + sourceDelegationIds）、
  `DecisionRecord`（2B，confirmed/superseded）、`SummaryCheckpointStore` 的"逻辑键唯一提交"模式。

## T1 实现正式文档版本聚合（AC1/AC2）

- [ ] T1-1 shared：`RequirementDocument`（sessionId/workItemId/workItemRevision/documentRevision/
      contentHash/status: draft|formal|confirmed|superseded/sourceBriefId/sourceDecisionIds/
      sourceDelegationIds/sections{goal,scope,outOfScope,acceptance,risks,pendingItems}）；
      不可变版本、修改生成新 documentRevision；纯校验 + 确定性 contentHash（浏览器安全，
      hash 由 server 侧算——2C 教训）
- [ ] T1-2 `requirement-document-store.ts`：`documentsBySession` 集合，逻辑键 =
      workItemId|documentRevision 唯一，旧 workItemRevision 拒绝不落盘；发布新版 → 旧版
      `superseded`；PostgreSQL V14 + 6 处接线 + cutover seed + COMMENT 门禁
- [ ] T1-3 主 Agent 发布入口：由 brief + 当前有效 DecisionRecord + 讨论综合聚合成文档
      （引用不复制正文，plan §2.1），发布事件带 documentId/documentRevision/contentHash

## T2 实现精确确认事务（AC3）

- [ ] T2-1 确认卡携带完整 `RequirementConfirmationBinding`；`confirmBrief` 改为消费
      `matchesRequirementConfirmation`：workItemRevision / documentRevision / contentHash /
      businessFingerprint 任一不匹配 → `stale_confirmation` 拒绝并展示新差异（不是静默通过）
- [ ] T2-2 重复确认幂等；文档修订 → 旧确认失效但历史保留（plan §2.3）
- [ ] T2-3 承接阶段 3：`confirm_member_addition` approve/decline、`discussion_clarification`
      answer_in_chat/proceed_anyway 的选项处理；决定 `MAIN_AGENT_DISCUSSION_ENABLED` 默认值

## T3 接入只读流程选择与映射（AC4/AC5）

- [ ] T3-1 只有已确认文档才进入 `WAIT_WORKFLOW_SELECT`；候选只来自 published 目录，版本快照
      锁定 workflowId/version/hash
- [ ] T3-2 `selectWorkflow` 不再静默并入 `involvedAgentIds`：角色/能力/目录授权差异 →
      `capability_mapping_required`，由主 Agent 解释并请求用户选择映射或确认扩员

## T4 实现启动握手与持久化派发（AC6）

- [ ] T4-1 启动请求绑定 confirmation binding + workflow 快照 + 需求/文档 hash；幂等键含
      documentRevision；提交（事务内写 run + outbox）与派发（worker 领取）分离
- [ ] T4-2 崩溃恢复不重复创建 run；停止屏障与预算在启动前再核一次（spec §5 第二条风险）

## T5 接入双端文档 Diff 和返工沟通（AC2/AC7）

- [ ] T5-1 文档版本 Diff 复用既有 Diff 组件（web/desktop 各自样式）；确认卡/过期差异双端同状态
- [ ] T5-2 承接阶段 3：讨论计划/委派进度/综合/两张卡的双端专用呈现；`blocked` 状态是否映射
- [ ] T5-3 质量拒绝 → 图内返工或有原因的等待，由主 Agent 对接用户

## T6 验证版本竞争和完整交接（AC1–AC7）

- [ ] T6-1 旧卡/重复点击/文档修订后确认/流程下架/能力缺失/启动崩溃/质量拒绝矩阵
- [ ] T6-2 独立 PostgreSQL（新集合）+ E2E + 四门禁

## 遗留（跨阶段，未完成）

- [ ] 中断会话续接 G3：`npm run dev:restart-server` + 真实场景手测（上一专项人工项）。
- [ ] 跨实例 CAS（讨论/预算 run 的并发写守卫），阶段 3 T1-3 起延后。

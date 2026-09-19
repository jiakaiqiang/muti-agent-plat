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

落点：`packages/shared/src/requirement-document-contracts.ts` + `.spec.ts`（7 例）；
`apps/server/src/modules/sessions/requirement-document-store.ts` + `.spec.ts`（8 例，file）；
PG 集成 +1（临时库 13/13）；`orchestrator.service.ts publishRequirementDocument` +
`requirement-document.spec.ts`（3 例）。

- [x] T1-1 `RequirementDocument`（workItemRevision / documentRevision / contentHash / status:
      draft|formal|confirmed|superseded / sourceBriefId / sourceDecisionIds / sourceDelegationIds /
      confirmationId? / sections 封闭六节）；`canonicalRequirementDocumentContent` 规范化字符串
      （字段序固定、trim、**列表顺序保留**——验收标准的顺序是语义）；hash 在 server 侧算；
      `isRequirementDocumentSections` 拒多余键（批准不是正文）；迁移表：draft→formal→confirmed，
      任意→superseded，confirmed 不可回 formal（改动 = 新版本）；`supersedeOlderDocuments`
      旧版保留为历史
- [x] T1-2 `RequirementDocumentStore.publish`：sections 先校验再进事务；workItemRevision 与当前
      不符 → `DOCUMENT_STALE_REQUIREMENT` 不落盘；同需求同修订同 hash → `duplicate`（不产生新版）；
      内容变化 → documentRevision+1 并把旧版（含 confirmed）标 superseded；`confirm` formal→
      confirmed 一次、重放 idempotent、superseded 不可确认；重启可读。PostgreSQL V14
      `requirement_documents`（logical_key unique，正文不变、status 单向 upsert），8 处 relational
      接线 + cutover seed + COMMENT 门禁；跨实例同内容并发只留 1 行、旧修订拒绝无行、确认重放幂等
- [x] T1-3 `publishRequirementDocument`（`REQUIREMENT_DOCUMENT_ENABLED` 闸，默认关）：在两处
      `confirm_task_brief` 发卡前发布——sections 取自 brief，`sourceDecisionIds` 只取本需求
      `confirmed` 的 DecisionRecord，`sourceDelegationIds` 取当前 generation 最新 `run.synthesis`，
      `pendingItems` = brief.openQuestions ∪ synthesis.unresolved；卡片 payload 带 documentId /
      documentRevision / contentHash / workItemRevision（T2-1 的绑定材料）；发布事件带同一组 id；
      同 brief 重发布得同版本；store 拒绝时发 system_notice 不阻断 brief 流（orchestrator 无 logger）

## T2 实现精确确认事务（AC3）

落点：`packages/shared/src/requirement-document-contracts.ts`（`requirementConfirmationFingerprint`，
spec 共 8）；`sessions.service.ts confirmBrief` + `assertConfirmationCurrent` + 两个卡片决策方法；
`sessions.controller.ts` 两条新路由；`sessions.service.spec.ts` +4（共 89）；
`orchestrator.service.ts consultApprovedMember` / `acceptDiscussionSynthesis`（`planned-discussion.spec` 共 12）。

- [x] T2-1 卡片携带完整绑定：`publishRequirementDocument` 返回 documentId / documentRevision /
      contentHash / workItemRevision / **businessFingerprint**（= 合同版本|需求修订|文档修订|hash|
      决策账本修订，确定性字符串，不另 hash）。**踩坑**：第一版漏了 businessFingerprint，单测因
      fixture 手填指纹而假绿——真实流程会全部判 stale；已补并让 spec 调 helper 而非手写字符串。
      `confirmBrief`：卡片有 `documentId` 时用 `documentBindingFromCard` 组 `received`、从当前
      状态（最新文档版本 + `workItemsBySession` 修订 + `session.decisionLedgerRevision`）组
      `current`，`matchesRequirementConfirmation` 逐字段比对；不匹配 → 发 `user_confirmation_resolved
      {status:'expired', resolution:'stale_confirmation', received, current}` 事件（双端可见新版本）
      并抛 `ConflictException{code:'stale_confirmation', received, current}`（409），会话状态不动、
      文档不确认。匹配 → `orchestrator.confirmBrief` 后 `RequirementDocumentStore.confirm`（记
      confirmationId）。无绑定的旧卡片走原逻辑不变
- [x] T2-2 重复确认幂等：同 confirmationId 已 approved → 直接返回当前 brief，不再抛 400、不发第二条
      resolved 事件；文档修订使旧确认失效由 T1-2 的 supersede 保证（旧版 superseded 不可确认，历史保留）
- [x] T2-3 承接阶段 3 的两张卡：`POST sessions/:id/discussions/:discussionId/member-addition`
      {confirmationId, decision: approve|decline} —— approve 把成员加入 `participatingAgentIds`
      并调 `orchestrator.consultApprovedMember`（在活 run 上 reserve `origin:'coordinator'` 委派、
      新一轮 consulting、dispatch、重新综合 → 唯一未决项被回答后 run 进 ready_for_confirmation）；
      decline 只关卡。`POST …/discussions/:discussionId/clarification` {confirmationId, decision:
      answer_in_chat|proceed_anyway} —— proceed_anyway 调 `acceptDiscussionSynthesis`（run
      waiting_user → ready_for_confirmation，迁移表新增该边并清 `pendingConfirmationId`）；
      answer_in_chat 只关卡，下一条 @/补充按 T4 重开一轮。同卡不可二次决定（既有
      `assertPendingConfirmation`）。**两个开关（`MAIN_AGENT_DISCUSSION_ENABLED`、
      `REQUIREMENT_DOCUMENT_ENABLED`）默认值留到阶段 4 验收时定**

## T3 接入只读流程选择与映射（AC4/AC5）

落点：`apps/server/src/modules/sessions/workflow-member-mapping.ts` + `.spec.ts`（4/4）、
`sessions.service.ts`（selectWorkflow + resolveWorkflowMemberMapping）、
`workflows/workflow-runtime.service.ts`（start 绑定 definitionHash）。

- [x] T3-1 版本锁定落到**启动层**而非只在选择层：`StartWorkflowRunInput.definitionHash` 为
      选择时捕获的哈希，`start()` 在 published 校验之后比对 `version.definitionHash`，
      不一致抛 `WORKFLOW_VERSION_CHANGED` 并带 expected/actual；bootstrap 路径把哈希存进
      `PendingBootstrapWorkflow.definitionHash` 再透传，恢复时**不重查**版本。
      用例：workflow-runtime.spec「a republished version between selection and start is refused」
- [x] T3-2 `selectWorkflow` 不再静默 `Array.from(new Set([...participating, ...involvedAgentIds]))`：
      先过 `evaluateWorkflowMemberMapping` 纯函数，分三类——可邀请（active 且允许 chat）→
      `confirm_workflow_member_mapping` 卡（含 workflowId/version/definitionHash，选择保持
      `WAIT_WORKFLOW_SELECT` 不变）；不可用（disabled/不在目录）→ 卡上标 blocked，
      批准也不会加入；无差异 → 直接启动。`resolveWorkflowMemberMapping` 只在 approve 时
      并入 addable，随后同一 confirmationId 的 selectWorkflow 才能启动。
      用例：sessions.service.spec 3 条（缺成员拒绝并出卡、批准后同一选择启动并绑定哈希、
      disabled 成员邀请无效仍 blocked）

踩坑（记进 Checklist 证据）：T3 守卫落地后全量 `npm run test` 报 5 条失败，均在
`workflow-session-flow.spec.ts`（不是 `sessions.service.spec.ts`，单跑后者会误判为已绿）。
根因不是测试环境泄漏，而是这 5 条用例的夹具依赖 T3 之前的「静默并入 involvedAgentIds」行为：
session 只有 coordinator，工作流版本需要 requirements，旧代码直接并入。按 AC5 守卫是对的，
已把夹具改为预置工作流所需成员，并把原「断言静默并入成功」改为「断言不发生静默扩员」。

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

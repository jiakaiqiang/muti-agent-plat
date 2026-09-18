# TASK.md — 阶段 3：主 Agent 主持讨论与可恢复专家协作

状态：进行中（2026-09-19 开工）。阶段 2C 已于同日验收（用户确认），准入成立。

依据文档（四件套，2026-09-16 生成）：
`docs/product/main-agent-collaboration-phase-3-spec-v1.md`（AC）、
`docs/design/main-agent-collaboration-phase-3-plan-v1.md`（设计与落点）、
`docs/implementation/main-agent-collaboration-phase-3-tasks-v1.md`（任务）、
`docs/quality/main-agent-collaboration-phase-3-checklist-v1.md`（验收与证据）。

前置：阶段 0、1、2A、2B、2C 已验收（2C 记录见其 Checklist §5 与提交 `1d2ec8d`）。

**纪律**：严格串行；每项先补失败用例再实现；每项结束时仓库必须绿；
持久化改动必须同步 shared 合同 + file backend + PostgreSQL 迁移/投影（不能只加内存 Map）；
主 Agent 只**提议**，领域服务校验后落实，模型不直接写业务状态（plan §2.1）。

## 开工前已核实的代码事实（2026-09-19）

- `runDiscussion`（`orchestrator.service.ts:3424-3524`）是**纯内存 `for round` 循环**：每轮
  `participants.map(...)` 让**所有**参与者回答（AC1 明确反对"默认要求所有成员重复回答每条消息"）；
  无持久化计划/话题/委派；任一必需参与者失败即 `throw new Error('Required discussion did not
  complete')` 中止整场——这就是 AC6 禁止的"重启整轮循环掩盖失败"；无 requirementRevision 绑定、
  无 reservation/幂等，重试会把所有人再跑一遍。
- `runFollowUpDiscussion`（`:3359`）同样按 `participants.map` 全员咨询，只是加了 system rule；
  用户 @ 在这里没有"有归属的委派"形态（AC2 缺口）。
- `boundedConsultations`（`bounded-consultation.ts`）是纯执行器：并发 ≤ 4，首个失败 `stopped=true`
  并重抛。plan §2.4 要求它**只作为执行器**，持久化计划才是恢复真相——所以调用方不能把
  "首失即停"当成"全部重来"。`consultationConcurrency()` 读 `DISCUSSION_CONCURRENCY`，
  `discussionMaxRounds()` 读 `DISCUSSION_MAX_ROUNDS`，`DISCUSSION_AGENT_KEYS` 可过滤参与者。
- 已注册的 `RuntimeOutput` kind（`packages/shared/src/runtime-contracts/`）共 9 种：agent_message /
  file_revision_candidate / final_delivery / intent_routing_decision / post_review_report /
  task_acceptance_decision / task_brief / task_execution_result / user_message_handling_plan。
  **没有** plan §2.1 要的 propose_consultation / propose_question / propose_summary。
  新 kind 要走 `registry.ts` + `output-contracts.ts` + server `runtime-output-schema.ts` 三处。
- 阶段 0 合同（`collaboration-contracts.ts`）**已有**：`CollaborationExecutionScope.discussion
  { discussionId, delegationId? }`、`COLLABORATION_ACTION_OWNERS.delegate_expert = 'coordinator'`、
  feature `main_agent_discussion`（依赖 `long_term_memory`）与 `parameters.discussion
  { maxConcurrency, maxRounds }`。所以 T1 要加的是**生命周期记录**（DiscussionRun / Delegation），
  不是 scope 和归属——那两样已冻结。
- 持久化：`SESSION_KEYED_COLLECTIONS` 现有 15 个，最新迁移 V12（`summary_checkpoints`）。
  新集合按 2B 的 6 处约定接入 relational store + V13 + cutover seed + schema COMMENT 门禁。
- plan §2.2 要求"先审查可扩展现有 task 的边界"：`AgentTask` 是工作流执行单元（验收检查点、
  工作流节点、写副作用），而委派是**只读咨询**，spec §2 非目标明确"避免把只读咨询伪装成已选择
  工作流节点"。**决定：新建 DiscussionRun/Delegation，不复用 AgentTask。**
- 2B 留下的可复用件：`LogicalOperationStore`（副作用去重）、`WorkItemBudgetStore`（累计预算，
  委派的 `category` 应为 `consultation`）、`SummaryCheckpointStore` 的"逻辑键唯一提交 + 拒绝不落盘"
  模式（Delegation 的 reservation 照抄）。

## T1 固化讨论与委派合同（AC1/AC4/AC6/AC7）

- [ ] T1-1 shared：`DiscussionRun`（sessionId/workItemId/requirementRevision/generation/
      parentDiscussionId?/status: planning|consulting|synthesizing|waiting_user|
      ready_for_confirmation|paused|failed，objective/exitCondition/budget/roundLimit/
      revision/createdAt/updatedAt）与 `Delegation`（discussionId/targetAgentId/
      requirementRevision/objective/expectedResult/deadline?/budgetTokens/operationId/
      invocationId?/status: pending|running|completed|blocked|failed|cancelled|superseded/
      result?/origin: coordinator|user_mention）；纯校验函数（同阶段 0 风格）；
      专家结果 schema：conclusion/evidenceRefs/risks/openQuestions/suggestedActions（plan §2.6，
      不含思考过程）
- [ ] T1-2 状态机纯函数：合法迁移表 + `supersede`（需求修订使旧委派 stale，AC7）+
      重复提交/重启只运行未完成项（AC4）
- [ ] T1-3 `discussion-store.ts`：`discussionsBySession` 集合（Delegation 内嵌于 run），
      Delegation reservation 以 `discussionId|targetAgentId|requirementRevision` 为逻辑键，
      同键并发恰一个 `reserved`，旧 requirementRevision 拒绝且不落盘；PostgreSQL V13
      `discussion_runs` + `delegations`（unique logical_key）；6 处 relational 约定 + cutover seed

## T2 实现主 Agent 规划与派发（AC1/AC3/AC5/AC6）

- [ ] T2-1 新 RuntimeOutput kind `discussion_plan`（propose_consultation[] / propose_question? /
      propose_summary?），三处注册 + 结构化输出指令
- [ ] T2-2 领域服务校验：目标成员必须在 `session.participatingAgentIds` 内，否则生成
      `member_addition` 用户确认而不是擅自加入（AC3）；只读工具策略；预算走
      `WorkItemBudgetStore.reserve(category:'consultation')`
- [ ] T2-3 首轮由主 Agent 出计划替换 `runDiscussion` 的全员轮询；计划持久化后再派发

## T3 实现持久化专家执行（AC4/AC6）

- [ ] T3-1 委派执行复用 `boundedConsultations` + `runDiscussionRuntime`，每个委派
      先 reserve 再跑；专家失败只标该委派 `failed`，不中止整场
- [ ] T3-2 重启恢复：只运行 `pending|running` 且 generation 当前的委派；`completed` 不重跑
- [ ] T3-3 停止/删除：讨论进入 `paused`，委派 `cancelled`，遵守阶段 1 准入

## T4 接入用户 @ 与中途补充（AC2/AC7）

- [ ] T4-1 `@成员` 补充 → `Delegation{origin:'user_mention'}` 而不是全员 follow-up；
      专家回复同时回传主 Agent
- [ ] T4-2 目标/验收改变 → 新 requirementRevision，旧委派 `superseded`，结果不进汇总

## T5 实现综合与统一澄清投影（AC1/AC2/AC5/AC7）

- [ ] T5-1 主 Agent 综合读取真实委派结果，冲突/失败/未决显式列出，不用固定文案
- [ ] T5-2 澄清卡由主 Agent 持有 confirmation ID；事件带 discussionId/delegationId/
      requirementRevision，双端共用事件各自渲染

## T6 验证协作故障矩阵（AC1–AC7）

- [ ] T6-1 @、扩员拒绝、专家失败、冲突、主 Agent 失败、重启、停止/删除、Token 累计
- [ ] T6-2 独立 PostgreSQL（新增集合）+ E2E + 四门禁

## 遗留（跨阶段，未完成）

- [ ] 中断会话续接 G3：`npm run dev:restart-server` + 真实场景手测（上一专项人工项）。

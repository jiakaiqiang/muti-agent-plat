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

落点：`packages/shared/src/discussion-contracts.ts` + `.spec.ts`（8 例）；
`apps/server/src/modules/orchestrator/discussion-store.ts` + `.spec.ts`（10 例，file backend）；
`postgres-migration-runner.integration.spec.ts` 新增用例（临时库 12/12）。

- [x] T1-1 `DiscussionRun`（status: planning|consulting|synthesizing|waiting_user|
      ready_for_confirmation|paused|failed，含 roundLimit/roundsStarted/budgetTokens/
      synthesis?/pendingConfirmationId?/delegations[]）与 `Delegation`（status: pending|running|
      completed|blocked|failed|cancelled|superseded，origin: coordinator|user_mention，
      requirementRevision/generation/operationId/invocationId?/result?/failure?/stale?）；
      `ExpertReport` 五字段**封闭形状**，`isExpertReport` 拒绝任何额外字段（思考过程进不来）。
      浏览器安全：无 `node:` import（2C 教训）
- [x] T1-2 迁移表 `canTransitionDiscussion` / `canTransitionDelegation`（终态不可回退、
      不可跳过 synthesizing 直达 confirmation、waiting_user 只能回 consulting）；
      `delegationLogicalKey` = discussionId|targetAgentId|requirementRevision；
      `delegationsToRun` 只取当前 generation 的 pending|running（blocked 等输入不盲派）；
      `supersedeStaleDelegations` 旧修订未完成 → superseded，已完成 → 保留但 `stale:true`
- [x] T1-3 `DiscussionStore`：`open` 校验 lifecycle admission + generation + workItem revision；
      `reserveDelegation` 同逻辑键并发 12 个恰一个 `reserved`（其余 `duplicate`），旧修订 →
      `DELEGATION_STALE_REVISION` 且不落盘；`transitionDelegation` 校验迁移表 + 报告形状，
      重放 `idempotent`；`transitionRun` 进入 consulting 计一轮、超 roundLimit →
      `DISCUSSION_ROUND_LIMIT`（限制在 store 里，调用方重试绕不过）；`reviseRequirement`
      落实 supersede；重启后 `runnableDelegations` 只给未完成项。
      PostgreSQL：V13 `discussion_runs`（revision 守卫 upsert，委派内嵌 jsonb），relational
      store 8 处接线 + cutover seed + COMMENT 门禁；跨实例同键并发只留 1 条委派，修订后旧
      ask 拒绝且 jsonb 委派数不变。
      **记到 T3**：V11/V13 的 `revision <= excluded.revision` 守卫在跨实例并发写同一 run 时
      会静默丢一方更新（与既有 budgets 语义一致）；T3 的"租约/幂等"要补 CAS（`<` + 0 行受影响
      → 事务回滚）。
      **环境教训**：集成 spec 前 8 条直接用共享开发库，开发数据的内容引用在测试进程读不到会报
      `CONTENT_UNAVAILABLE`——这是环境不是回归；把 `RELATIONAL_TEST_DATABASE_URL` 指向临时空库
      即 12/12。

## T2 实现主 Agent 规划与派发（AC1/AC3/AC5/AC6）

落点：`packages/shared/src/runtime-contracts/output-contracts.ts`（新 kind）+
`discussion-plan-output.spec.ts`（5 例）；`orchestrator/discussion-planner.ts` + `.spec.ts`（8 例）；
`orchestrator.service.ts` `runPlannedDiscussion` + `planned-discussion.spec.ts`（3 例）。

- [x] T2-1 新 RuntimeOutput kind `discussion_plan`：objective / gaps[] / exitCondition /
      consultations[{targetAgentKey, objective, expectedResult}] / questionsForUser[] /
      readyToSummarize。**封闭 schema**：`addMembers`、`approvedByUser` 之类多余字段直接拒绝
      ——成员与批准不是模型能声明的。注册实际只在一处（`RUNTIME_OUTPUT_KINDS` + schema map +
      example + union），registry/server 是泛型派生；公开类型走 `contracts.ts` 的
      `Registered*` 别名（在 `runtime-contracts/index.ts` 重复导出会撞 TS2308）。
      现有表驱动 spec（example 必过、拒多余属性、preflight 禁 optional）自动覆盖新 kind
- [x] T2-2 `resolveDiscussionPlan` 纯函数：目标是参与者 → 委派；在目录但不在会话 →
      `memberAdditions`（用户确认，模型不能加人，AC3）；名字哪都没有 → `unknownTargets`
      （报出来，不编造）；主 Agent 点自己 → dropped(self_consultation)；同人两次 → 一次。
      "空计划"按**原始提议**判（consultations/questions 全空且未 ready），解析后全被拒的计划
      仍是 resolved——诊断信息正是主 Agent 重规划需要的
- [x] T2-3 orchestrator：`MAIN_AGENT_DISCUSSION_ENABLED`（默认关，回退 = 取消设置；阶段 0
      的 `main_agent_discussion` 策略特性在服务端无消费者，先用 env 闸，记为缺口）。
      开启时 `runDiscussion` 先走 `runPlannedDiscussion`：无 activeWorkItem/contextManagement
      → 返回 false 回落旧循环；否则主 Agent 出 `discussion_plan`（system rule 里给出可用专家
      key 名单）→ `resolveDiscussionPlan` → `DiscussionStore.open` 持久化 → 扩员发
      `confirm_member_addition` 确认卡 → 逐条 `reserveDelegation` → `consulting` →
      `boundedConsultations(…, shouldStop=()=>false)` 只跑被点名的专家，异常/失败只标该委派
      `failed`（**不再中止整场**，AC6）→ `synthesizing`。事件带 discussionId/delegationId。
      专家仍返回 agent_message，`ExpertReport` 只填 conclusion，不编造 evidenceRefs。
      mock runtime 加 `discussion_plan` 分支（固定提议 architect）。
      测试夹具从 spec 抽到 `orchestrator.test-fixtures.ts`——spec 互相 import 会让 node:test
      把整套用例重复注册。
      **未做**：一次 `runDiscussion` 只跑 1 轮计划（多轮重规划归 T5）；扩员确认卡的
      approve/decline 处理（用户点了之后把该成员加入并补委派）归 T4；`runFollowUpDiscussion`
      仍是旧全员路径（T4）

## T3 实现持久化专家执行（AC4/AC6）

落点：`orchestrator.service.ts` `dispatchDelegations`（从 T2-3 抽出）+ `DiscussionStore.findResumable`；
`planned-discussion.spec.ts` +2 例（共 5）、`discussion-store.spec.ts` +1 例（共 11）。

- [x] T3-1 委派执行已在 T2-3 落地：每条先 `reserveDelegation` 再 running → completed/failed，
      `boundedConsultations(shouldStop=()=>false)`，异常与失败只标该委派，整场继续
- [x] T3-2 重启/重试幂等：`runPlannedDiscussion` 入口先 `findResumable`（同 workItem +
      requirementRevision + generation，状态 planning|consulting|paused）；命中且已有委派 →
      **不再问主 Agent 要计划**（用例断言 planCalls=0）、只跑 `runnableDelegations`
      （pending|running）、已完成的结果原样保留、不开第二个 run、`roundsStarted` 不重复计。
      `synthesizing` 及之后无可派发项、`failed` 是有意的侧出口（重试走重规划）——两者不算可续
- [x] T3-3 停止：abort 时 `dispatchDelegations` 把 run → `paused` 后重抛，被打断的委派**保持
      `running`**（reservation 仍有效，恢复时算 runnable）；`paused` → 恢复入口先转回
      `consulting`。删除：阶段 1 关准入后 store 的 `checkAdmission` 结构上拒写，恢复换 generation
      后 `delegationsToRun` 忽略旧代次——无需额外动作，且**不能**在删除时改写记录（会被拒）。
      **仍记着**：跨实例 CAS（`revision <` + 0 行受影响回滚）未做，T1-3 已记

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

# 阶段 3：主 Agent 主持讨论与可恢复专家协作 — Tasks v1

> 日期：2026-09-16
> 状态：**已完成并通过验收（2026-09-19，用户确认）**。四项缺口（双端呈现、卡片选项处理、`blocked` 写入方、开关默认值）归阶段 4；
> 新路径由 `MAIN_AGENT_DISCUSSION_ENABLED` 闸控（默认关）。
> 依赖：阶段 1、2A、2B、2C 通过；核心正确性不依赖缓存命中。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [spec](../product/main-agent-collaboration-phase-3-spec-v1.md) | [plan](../design/main-agent-collaboration-phase-3-plan-v1.md) | [tasks](../implementation/main-agent-collaboration-phase-3-tasks-v1.md) | [checklist](../quality/main-agent-collaboration-phase-3-checklist-v1.md)

## 执行规则

- 所有任务初始为待实施；先确认前置阶段退出条件，不跳过安全与确认门禁。
- 每项先补合同/失败用例，再实现；数据库、模型、CLI 与双端边界分别验证。
- 复用现有能力仍需回归，不将既有专项的通过记录直接复制为本阶段通过。
- 本轮只生成文档；以下路径与改动是后续开发范围，不是已完成修改。

## 任务清单

### P3-T1 固化讨论与委派合同

- [x] 完成实现与审查（2026-09-19 验收）。
- 前置：阶段 1、2A、2B、2C 通过；核心正确性不依赖缓存命中。
- 交付：定义生命周期、需求版本、来源、结果 schema、停止与恢复关联。
- 覆盖：P3-AC1、P3-AC4、P3-AC6、P3-AC7。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 证据（2026-09-19）：`packages/shared/src/discussion-contracts.ts`（8/8）：DiscussionRun /
  Delegation 生命周期、迁移表、逻辑键、`delegationsToRun`、`supersedeStaleDelegations`、封闭的
  `ExpertReport`。`apps/server/src/modules/orchestrator/discussion-store.ts`（14/14）+ PostgreSQL V13
  `discussion_runs`（临时库集成 12/12：跨实例同键只留一条委派、旧修订 ask 拒绝不落盘）。

### P3-T2 实现主 Agent 规划与派发

- [x] 完成实现与审查（2026-09-19 验收）。
- 前置：P3-T1 完成；涉及的其他阶段依赖同页顶部。
- 交付：结构化咨询计划、成员校验、显式扩员确认、只读工具策略和预算。
- 覆盖：P3-AC1、P3-AC3、P3-AC5、P3-AC6。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 证据（2026-09-19）：新 RuntimeOutput kind `discussion_plan`（封闭 schema，5/5）；
  `discussion-planner.resolveDiscussionPlan`（8/8）：参与者→委派、目录内非成员→用户确认、
  未知名→报出不编造、自咨询/重复丢弃；`orchestrator.runPlannedDiscussion`（`planned-discussion.spec`
  10/10）：计划持久化后才派发，只跑被点名的专家。闸：`MAIN_AGENT_DISCUSSION_ENABLED`。

### P3-T3 实现持久化专家执行

- [x] 完成实现与审查（2026-09-19 验收）。
- 前置：P3-T2 完成；涉及的其他阶段依赖同页顶部。
- 交付：复用有界咨询和逻辑操作；租约/幂等/乱序/重启恢复只运行未完成项。
- 覆盖：P3-AC4、P3-AC6。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 证据（2026-09-19）：`dispatchDelegations` 逐条 reserve→running→completed/failed，失败不中止；
  `findResumable` + 入口续跑：重启不重问计划、只跑 pending|running、已完成不重跑、不开第二个 run；
  abort → run paused、委派保持 running 可续。**延后**：跨实例 CAS（`revision <` + 0 行回滚），
  当前守卫与既有 budgets 一致。

### P3-T4 接入用户 @ 与中途补充

- [x] 完成实现与审查（2026-09-19 验收）。
- 前置：P3-T3 完成；涉及的其他阶段依赖同页顶部。
- 交付：保留明确目标、反馈主 Agent、处理版本变化并失效旧结果。
- 覆盖：P3-AC2、P3-AC7。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 证据（2026-09-19）：有 @ 时 `runMentionDelegations` 为每个被 @ 成员 reserve `origin:'user_mention'`
  委派（objective=用户原话），回复带 delegationId 回主 Agent，不再发固定"已汇总"文案；需求修订 →
  `reviseRequirement` 就地 supersede（旧结论保留但 stale）并在同一 run 重规划。无 @ 的补充仍走旧路径。

### P3-T5 实现综合与统一澄清投影

- [x] 完成实现与审查（2026-09-19 验收）。
- 前置：P3-T4 完成；涉及的其他阶段依赖同页顶部。
- 交付：真实汇总专家结果、冲突和失败显式呈现、双端同状态各自样式。
- 覆盖：P3-AC1、P3-AC2、P3-AC5、P3-AC7。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 证据（2026-09-19）：`discussion-synthesis.synthesizeDiscussion`（6/6）确定性综合——署名逐条、
  不合并成共识、冲突=同 objective 不同结论、失败/未回复点名、`sourceDelegationIds` 可核验；
  `recordSynthesis` 持久化并转 ready_for_confirmation / waiting_user；`needs_user` 时主 Agent
  持 confirmationId 发一张 `discussion_clarification` 卡。事件带 discussionId/requirementRevision/
  sourceDelegationIds，双端共用（未改渲染）。**未做**：卡片选项处理、综合喂 brief（归阶段 4）。

### P3-T6 验证协作故障矩阵

- [x] 完成实现与审查（2026-09-19 验收）。
- 前置：P3-T5 完成；涉及的其他阶段依赖同页顶部。
- 交付：@、扩员拒绝、专家失败、冲突、主 Agent 失败、重启、停止/删除及 Token 累计测试。
- 覆盖：P3-AC1、P3-AC2、P3-AC3、P3-AC4、P3-AC5、P3-AC6、P3-AC7。
- 验证：执行 Checklist 对应场景，记录命令/环境/结果；失败时保留证据并回到所属任务。
- 证据（2026-09-19）：单测矩阵覆盖 @/扩员拒绝/专家失败/冲突/主 Agent 失败/重启/停止/删除；
  Token 累计复用 2A（`budgetCategoryFor('discussion')='consultation'`）。E2E
  `npm run test:e2e:planned-discussion`（真服务 + mock）：场景 A 只咨询被点名者并综合 1 条真实结果，
  场景 B 扩员卡 + 一张澄清卡且零委派运行。独立 PostgreSQL 12/12。四门禁全绿。

## 完成定义

用户 @、按需咨询、主 Agent 实质汇总、统一澄清、成员授权、版本与重启恢复全部通过，讨论无源码写副作用。

完成一个任务不等于阶段完成；所有 AC 必须有证据。最后同步相关合同、测试说明与 Checklist，不修改其他未通过阶段的状态。

# TASK.md — 阶段 2A：统一消息意图、需求隔离与完整 Token 预算

依据文档（四件套，2026-09-16 生成）：
`docs/product/main-agent-collaboration-phase-2a-spec-v1.md`（AC）、
`docs/design/main-agent-collaboration-phase-2a-plan-v1.md`（设计与落点）、
`docs/implementation/main-agent-collaboration-phase-2a-tasks-v1.md`（任务）、
`docs/quality/main-agent-collaboration-phase-2a-checklist-v1.md`（验收与证据）。

前置：阶段 0（合同冻结）、阶段 1（生命周期/隔离）已完成并验收。

**纪律**：严格串行，上一项退出标准满足才开始下一项；每项先补失败用例再实现；
每项结束时仓库必须绿；测试与实现同项完成。

## 开工前已核实的代码事实

- `estimateRuntimeInputTokens` / `reserveInputTokenSafetyMargin` / `inputTokenEstimationDrift`
  在 `apps/server/src` 内**除定义处零调用方**，属已定义未接入。
- 唯一生效的输入预算检查在 `orchestrator.service.ts:6928`，用 `estimateTokens`（字符数/4），
  覆盖 systemPrompt + contextEnvelope + toolCatalog + expectedOutput，
  **无输出/推理保留、无安全余量、无工具循环重算、无估算误差记录**。
- `IntentContextSnapshot` 无 `mentionedAgentIds` / `replyToEventId` / 近期对话字段。
- `MessageIngressService.commit` 已有 mentions 与幂等键，**无 replyTo**。
- 阶段 0 已冻结 `CollaborationMessageTarget`，含 replyToEventId 与 mentionedAgentIds。

## T1 统一入口与目标信息（AC1/AC2/AC3）

- [x] T1-1 shared 扩展：`SessionFollowUpMessage.replyToEventId`、快照目标字段（加法，不改必填）
- [x] T1-2 `MessageIngressService.commit` 接收并持久化 replyToEventId（含幂等重放路径）
- [x] T1-3 `sessions.service` 透传 replyTo；精确控制命令分支不调用语义模型（固化测试）
      证据：`message-ingress.service.spec.ts` 17/17 通过（含 reply 目标越界拒绝、幂等重放保留目标）；
      `npm run typecheck` 五个 workspace 全绿。

## T2 扩展有界意图快照及验证（AC2/AC3/AC4）

- [x] T2-1 `buildIntentSnapshot` 纳入 mentions/replyTo/有界近期对话，候选由服务端查询并封顶
      落点：`context-management.service.ts` 新增 `SNAPSHOT_CANDIDATE_WORK_ITEM_LIMIT=5`、
      `SNAPSHOT_RECENT_MESSAGE_LIMIT=8`、`SNAPSHOT_MESSAGE_CHAR_LIMIT=400`，快照回报 `bounds`；
      replyTo 越界抛 `REPLY_TARGET_OUTSIDE_SESSION`。
- [x] T2-2 分类器输入携带 @ 约束；`validate` 增加 @ 被静默抹除的判据
      落点：wire 合同加必填 `requestedAgentIds`（strict schema 不允许可选字段），
      `IntentRoutingDecisionV2.requestedAgentIds` 为可选以兼容旧路由记录；
      L5 bullets 携带 @/replyTo/有界近期对话/bounds；`validate` 新增
      `MENTION_TARGET_DROPPED` 与 `AGENT_TARGET_OUTSIDE_SNAPSHOT`，精确命令分支自带 @ 目标。
- [x] T2-3 快照 hash/businessFingerprint 覆盖新字段，版本过期仍走有界重建
      hash 覆盖新字段已由用例固化；`businessFingerprint` 保持只覆盖投影状态（否则
      `isSnapshotCurrent` 永远为假）；6 处 `buildIntentSnapshot` 调用点全部透传
      `followUp.mentionedAgentIds` / `replyToEventId`，重建不再丢目标。
      证据：context-management 17/17、semantic-intent-router 7/7、message-ingress 与
      deterministic-guard 合计 33/33；`npm run typecheck` 五 workspace 全绿；
      `npm run test` 83/107/1347/7/37/13 全过 0 失败；`npm run test:harness` 全过。

## T3 实现角色化需求上下文（AC3/AC4/AC7）

- [x] T3-1 按角色切片装配 ContextEnvelopeV2，装配顺序可解释且各层有预算
      落点：`build-envelope-from-context-assembly.ts` 各层预算（15%/10%/40%）与
      `contextScope`（workItemId/decisionSetHash/继承 ID）已由用例固化；
      WorkItem 切片隔离已由既有 `buildWorkItemContextSlice` + 新用例覆盖。
- [x] T3-2 信任边界：摘要/文件/聊天正文不得进入 L0 系统规则，固化越权用例
      落点：新增 `context-v2/l0-trust-boundary.ts`（`assertL0SystemRuleTrustBoundary`），
      在 `buildEnvelopeFromContextAssembly` 出口强制执行；越权时抛
      `L0_TRUST_BOUNDARY_VIOLATION`，不静默放行。
- [x] T3-3 独立需求不继承旧约束；A 的私有片段不进入 B
      既有用例「independent route creates a clean WorkItem even when the model selects
      old context」+ 新用例「a work-item slice excludes other requirements」覆盖。
      证据：context-v2 全部 76/76、orchestrator 63/63、`npm run typecheck` 全绿。

## T4 加入最终请求预算守卫（AC5/AC7）

- [x] T4-1 扩展请求计数覆盖 system/schema/工具定义/工具历史/多模态，记录估算器与误差
      落点：`runWithToolLoop` 新增逐面归因 `breakdown`（systemPromptTokens /
      toolDefinitionTokens / contextEnvelopeTokens / expectedOutputTokens /
      toolHistoryTokens），并累计每轮发送前的输入估算；provider 上报的 usage
      不再被丢弃（原先工具循环硬编码 0），跨轮累加后与估算比较得出 `drift`
      （缺失用量时不下沉为 0 误差）。
      合同：`RuntimeTokenEstimationDiagnostic` + `AgentRunResult.tokenEstimation`
      （加法、可选，不破坏既有生产者；`withTokenEstimationDiagnostic` 落成单点装配）。
      注意 `estimatedInputTokens` 只含输入、不含输出预留，否则误差会被预留额度虚高。
      多模态：`generic_llm` 适配器只发字符串消息，本条不适用，已在 Checklist 记明。
      证据：`generic-llm-token-estimation.spec.ts` 5/5；runtimes+common 无回归；
      server 全量 1360 项 1348 通过；`npm run typecheck` 全 workspace 0 错误。
- [x] T4-2 发送前守卫接入输出与推理保留 + 安全余量，超限返回可理解容量阻塞而非静默截断
      落点：`TOOL_LOOP_OUTPUT_RESERVATION_RATIO=0.5` 预留输出/推理，
      `reserveInputTokenSafetyMargin` 接安全余量；超限返回 `TOKEN_BUDGET_EXCEEDED`
      并在 `details` 记录 estimator/round/estimatedInputTokens/effectiveMaxInputTokens/
      maxInputTokens/safetyMarginTokens/outputReservationTokens；用户可见文案保持中文
      （`tests/e2e/chinese-visible-copy-smoke.mjs` 明确禁止英文 "Token budget exceeded"）。
- [x] T4-3 每轮工具循环重新计数，工具调用/结果消息成对保留
      落点：轮末 `assertWithinInputBudget(round + 1)`；assistant 调用轮与 user 工具结果轮
      成对写入 messages（`role:'assistant'` 原文 + `role:'user'` 含 `<<TOOL_RESULT>>`
      ...`<<END_TOOL_RESULT>>`）。
      证据：`generic-llm-tool-loop-budget.spec.ts` 3/3 通过（含「超预算轮在发送前被拦截、
      未被截断」断言）；本项开工时修复了两个编译错误——`llmInputSafetyMarginRatio`
      漏导入、catch 分支误用未定义的 `selectedModel`；
      runtimes + common 434/434；server 全量 1355 项（1343 通过、9 跳过、3 失败均为
      `workspace-symlink-guard` / `artifact-cutover-cleanup` 的既有 symlink 用例，
      与被改文件无关）；`npm run typecheck` 全 workspace 0 错误。

## T5 实现累计预算预留与结算（AC6）

- [ ] T5-1 WorkItem 级总账合同（reserved/actual/unknown，attemptId 防重复结算）
- [ ] T5-2 原子预留与去重结算落持久化，file 与 PostgreSQL 对等
- [ ] T5-3 分类/咨询/重试/摘要/补读全部计入；并发先预留后结算；预算耗尽进入可解释等待

## T6 验证意图与长输入矩阵（AC1–AC7）

- [ ] T6-1 中文/多意图/@/旧确认/历史需求 fixture 回归
- [ ] T6-2 工具增长与长输入下的守卫矩阵
- [ ] T6-3 跨进程预算竞争（独立 PostgreSQL）
- [ ] T6-4 `npm run typecheck` + `npm run test` + `npm run test:harness`，回填 Checklist 证据

## 遗留（上一专项，未完成）

- [ ] 中断会话续接 G3：`npm run dev:restart-server` + 真实场景手测
      （带内容消息续接 / 裸「继续」恢复）。定义见
      `docs/implementation/interrupted-session-continuation-tasks-v1.md`。

## 暂不动（需用户另行决策）

- 左侧项目树 + 批量删除：`projectId` 是幽灵字段，无 projects 表 / 无 CRUD / 无写入方。
- 语义层可提议 resume：挂 P1，门禁为 rollout 推到 `enforce_*`。

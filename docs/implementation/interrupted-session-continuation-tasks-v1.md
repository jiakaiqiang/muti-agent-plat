# 中断会话续接 Tasks v1

依据 [Spec](../product/interrupted-session-continuation-spec-v1.md) 与 [Design](../design/interrupted-session-continuation-design-v1.md)。
验收证据回填 [Checklist](../quality/interrupted-session-continuation-checklist-v1.md)。

## 执行纪律

- **严格串行**：只有上一个任务的「退出标准」全部满足，才能开始下一个任务。
- **每个任务结束时仓库必须是绿色的**：定向测试通过、`typecheck` 不报新错。任何任务不得留下红状态给下一个任务。
- **测试与实现同任务**：每个功能点的任务内先写/改测试，再改实现，最后跑定向验证。不允许把测试推到后面统一补。
- **任务粒度**：单个任务 15–20 分钟。超时说明拆得不够细，停下来重新拆，不要硬做。
- **带前置调查的任务（D1、F2）**：调查结论与假设矛盾时**停止并报告**，不要按原假设改代码。
- 位置引用以函数名为准，行号只是当前快照的提示，改动过程中会漂移。
- `rg` 在当前开发机缺失，Glob/Grep 不可用，查引用点走 Bash。

## 阶段 A：中断元数据（其余任务的前置）

### A1 合同字段与写入

- [x] 目标：中断时记下"中断前处于什么阶段"，供后续判定使用。
- 改动：`packages/shared/src/contracts.ts` 的 `SessionDetail.interruption` 增加 `previousStatus` / `workItemId` / `phase`（全部可选，无迁移）；`sessions.service.ts` 的 `markSessionInterrupted` 写入三个字段，`previousStatus` 必须在 `setStatus(session, 'INTERRUPTED')` **之前**取。
- `phase` 词表：`AGENT_DISCUSSING` → `discussion`；`REVISING_BRIEF` → `brief_revision`；`EXECUTING` / `POST_REVIEW` / `REWORKING` → `task_execution`。
- 验证：新增后端用例，断言从 `AGENT_DISCUSSING` 被中断后 `session.interruption.phase === 'discussion'`、`previousStatus === 'AGENT_DISCUSSING'`；`npm run typecheck`。
- 退出标准：新用例通过，既有 sessions 定向回归无新增失败。**本任务同时确认后端定向测试的实际命令形式并记录**（后续任务复用）。
- 对应：AC3 / Design「中断元数据补全」。

### A2 `retryFailedSession` 读取中断阶段

- [x] 目标：讨论阶段被中断后点"继续"，走契约重建而不是 resume 一份未定稿的契约。
- 改动：`retryFailedSession` 的 `failurePhase` 改为优先取 `interruption.phase`，缺失回落 `latestFailurePhase`。**坑**：该函数先执行 `session.interruption = undefined`，phase 必须在清空前取入局部变量。
- 验证：新增用例「`AGENT_DISCUSSING` 被中断 → `retryFailedSession` → 状态为 `AGENT_DISCUSSING` 且触发契约重建」；另一条断言 `interruption` 缺失时仍回落 `latestFailurePhase`。
- 退出标准：两条用例通过。
- 对应：AC3 / Design「中断元数据补全」。

## 阶段 B：shadow 模式门禁

### B1 实时路径门禁

- [x] 目标：shadow 模式下模型推断出的 `pause` 不再真的暂停会话。
- 改动：v2 实时应用点（`applyIntentRoutingOutcome` 内 `requestedAction` 为 `pause` / `cancel` 的分支，当前约 2529）加 `shouldEnforceIntentRouting` 判据；shadow 下只往 routing 记录追加 `reasonCodes` 标记后返回，不调 `applyPersistedRoutingAction`。用 `reasonCodes`（`string[]`）打标记，不扩 `actionStatus` 联合类型。
- 验证：新增用例「shadow + 模型判定 pause → 会话状态不变 + routing 记录含跳过标记」；补一条「enforce 模式下仍然暂停」防止门禁写反。
- 退出标准：两条用例通过。
- 对应：AC1 / Design「shadow 门禁」。

### B2 重启恢复门禁

- [x] 目标：rollout 回退到 shadow 后，已落库的 ROUTED 控制动作不被追溯执行。
- 改动：`recoverIntentRoutings` 中 `pendingControlAction` 判定与两处 `applyPersistedRoutingAction`（当前约 1131、1145、1148）套用同一判据。
- 验证：新增用例「shadow + 已落库 ROUTED pause → 重启恢复后会话状态不变」。
- 退出标准：用例通过；B1 的用例不回归。
- 对应：AC1 / Design「shadow 门禁」。

## 阶段 C：迟到执行结果

### C1 `applyOutcome` 分级放行

- [x] 目标：中断会话收到迟到的 `delivered` 时转 `COMPLETED`，其余结果仍吞。
- 改动：`applyOutcome` 的开头守卫把 `INTERRUPTED` 从统一 return 中拆出，改为 `if (session.status === 'INTERRUPTED' && outcome.kind !== 'delivered') return;`。写清注释：中断意味着丢了调用所有权，迟到的 `failed` / `rework` 不该盖掉中断标记与恢复卡；`delivered` 是产物真的落地的权威终态。
- 验证：改 `sessions.service.spec.ts` 中固化旧行为的「keeps interrupted status」用例，断言改为 `COMPLETED`；**新增**一条断言迟到 `failed` 仍被吞、`interruption` 与恢复卡保留——否则本改动会退化成"什么都能盖"。
- 退出标准：两条用例通过。
- 对应：AC2 / Design「`applyOutcome` 对中断分级处理」。

## 阶段 D：解开队列（核心）

### D1 状态机前置确认

- [x] 目标：确认 `INTERRUPTED → AGENT_DISCUSSING` 这条转移是否需要显式登记，避免 D3 解锁后在 `setStatus` 处硬失败。
- 改动：先读 `setStatus` 实现，确认它是否经 `assertControlTransition`。经过 → 给转移表的 `INTERRUPTED` 增加 `AGENT_DISCUSSING`；不经过 → 仍然增加（让显式 `control()` 请求合法），但在任务记录里写明这不是 D3 的必要条件。
- 验证：`npm run typecheck`；若改了转移表，补一条 `control()` 走 `INTERRUPTED → AGENT_DISCUSSING` 合法的用例。
- 退出标准：`setStatus` 的校验路径有明确结论并记录在案。**结论与 Design 的推断（`setStatus` 不过转移校验）矛盾时停止并报告**，因为那会改变 D3 的改法。
- 对应：AC4 / Design 决策段末节。

### D2 `resumableFailure` 纳入中断

- [x] 目标：中断会话的补充需求拿到 `replan`，从而走方案 A 的契约重建。
- 改动：`normalizeFollowUpHandlingPlan` 的 `resumableFailure` 纳入 `INTERRUPTED`，且中断场景强制 `failedExecutionAction = 'replan'`（不是 `resume`）。
- 验证：直接对 `normalizeFollowUpHandlingPlan` 写单元级用例：`INTERRUPTED` + `continuation` → `replan`；`FAILED` + `continuation` 保持原有 `resume` / `replan` 行为不变。
- 退出标准：新用例通过，`FAILED` 的既有行为无回归。
- 说明：此时出队口仍焊死，本任务只改函数级行为，不产生运行时效果——这是安全的中间态，也是把它排在 D3 之前的原因。
- 对应：AC4 / Design「方案 A 通过 `replan` 落地」。

### D3 双锁与启动门禁（同批）

- [x] 目标：中断会话里发带内容的消息能被消费，同时启动路径不自动重驱。
- 改动三处，必须同批：
  1. `hasActiveSessionWork` 移除 `session.status === 'INTERRUPTED'`；
  2. `processNextFollowUp` 开头的早退条件移除 `INTERRUPTED`；
  3. `recoverIntentRoutings` 的重排门禁（当前约 1175，原本靠 `hasActiveSessionWork` 间接屏蔽中断会话）就地补显式 `INTERRUPTED` 判断。
- 只改前两处会破坏 `recovery.service.ts:24-27` 的"运行时调用绝不自动重驱"边界（重复执行命令、重复写文件）；只改第三处则队列仍不通。
- 验证：新增用例「`INTERRUPTED` 会话发带内容消息 → 队列被消费 → 状态进入 `AGENT_DISCUSSING`」；新增用例「启动恢复时中断会话的排队消息保持 `queued`，不触发 `scheduleFollowUpPlanning`」。
- 退出标准：两条用例通过；后端 sessions 定向回归全绿。
- 对应：AC4、AC6 / Design「队列双锁」「启动路径保持保守」。

### D4 裸「继续」与崩溃前排队消息

- [x] 目标：崩溃前已入队消息 + 用户重启后只打"继续"时，控制权交给队列而不是静默 resume 忽略排队消息。
- 改动：`retryFailedSession` 读 `session.pendingFollowUpMessages`，存在 `queued` 项时把控制权交给 `scheduleFollowUpPlanning`，而不是直接 `resumeExecution`。
- 验证：新增用例「中断 + 已有 queued 消息 → 发送"继续" → 排队消息被消费」；另一条断言「中断 + 无排队消息 → 发送"继续" → 仍走检查点恢复」，确认裸命令词路径没被改坏。
- 退出标准：两条用例通过。
- 对应：AC5 / Design「带内容的消息与裸命令词天然分流」。

## 阶段 E：前端

### E1 会话状态工具终态集合

- [x] 目标：`INTERRUPTED` 不再被前端当成终态。
- 改动：`apps/web/src/utils/sessionStatus.ts` 的终态集合移除 `INTERRUPTED`。**改前用 Bash 查全部消费方**——`SessionWorkspace` 另有一份独立的终态集合，说明该导出还有别的读取点。
- 验证：修 `session-connection-lifecycle.spec.ts` 中断言字面量字符串的用例；跑 Web 定向回归。
- 退出标准：定向 spec 通过；消费方清单记录在案。
- 对应：AC7 / Design「前端拆分两个独立条件」。

### E2 拆分不可达与被中断

- [x] 目标：中断时输入框可用，后端真不可达时仍禁用。
- 改动：`SessionWorkspace.vue` 把 `backendDisconnected` 拆成 `backendUnreachable`（探测不可达）与 `sessionInterrupted`（会话中断）；输入框禁用只绑前者；更新"系统不会自动重新连接或续跑"的提示文案，改为说明可直接输入新需求或补充说明、会接上原有上下文。
- 验证：新增/调整组件用例：中断态输入框可用、不可达态输入框禁用。
- 退出标准：用例通过。
- 对应：AC7 / Design「前端拆分两个独立条件」。

### E3 SSE 生命周期

- [x] 目标：中断会话不再被断开事件流，用户发完消息看得到回流。
- 改动：`SessionWorkspace.vue` 的 `terminalSessionStatuses` 移除 `INTERRUPTED`，避免 watcher 调 `finalizeSessionEvents` 后在 `finally` 里 `disconnectSse()`。
- 验证：新增用例断言中断态不触发 `finalizeSessionEvents` / 不断开 SSE。
- 退出标准：用例通过；E1、E2 的用例不回归。
- 对应：AC7 / Design「前端拆分两个独立条件」。

## 阶段 F：一致性与兜底

### F1 WorkItem 状态映射统一

- [x] 目标：两侧对中断会话的 WorkItem 状态判断一致。
- 改动：`recovery.service.ts` 的 `workItemStatusForSession` 把 `INTERRUPTED` 从 `FAILED` 改为 `WAITING_USER`，与 `sessions.service.ts` 的 `workItemStatusForSessionStatus` 对齐。
- 验证：连带检查并按需更新 `recovery.service.spec.ts`；跑 recovery 定向回归。
- 退出标准：定向回归通过。
- 对应：AC8。

### F2 澄清卡补恢复选项

- [x] 目标：两层意图识别都不命中时，中断会话拿到的选项对应其处境。
- 改动：`emitIntentClarification` 在会话为 `INTERRUPTED` 时增加"从中断点恢复"选项（现有三项是「继续当前任务 / 相关新任务 / 独立新任务」）。
- **前置调查**：该函数从 v2 路由结果应用点调用，shadow 模式下 v2 是影子运行，**是否真能走到该调用点尚未追踪**。先确认可达性：不可达则需同时给 legacy 侧兜底，或把本任务降级为 P1 并说明理由。
- 验证：按调查结论补对应用例（可达 → 断言中断会话的选项集合含恢复项）。
- 退出标准：可达性有明确结论并记录；改动与结论一致。
- 对应：AC9 / Design「L3 的真实缺口」。

## 阶段 G：整体验收

### G1 全量自动验证

- [x] 命令：`npm run typecheck`（整个 workspace）、`npm run test`、`npm run test:harness`。
- 连带检查 `tests/e2e/recovery-smoke.mjs` 是否仍指向当前行为。
- 退出标准：全绿，或对每一处失败给出归因（既有失败 vs 本次引入）。计数与命令原文记入 Checklist。

### G2 AC 与 Design 对账

- [x] 逐条走 Spec 的 AC1–AC10，回填 Checklist 的「结果」列，未实测的不得写"通过"。
- 检查 Design 的「不改动」清单是否守住：`semantic-intent-router.service.ts` 的 `transitionValid` / `deterministicDecision`、`deterministic-command-guard.service.ts` 的命令词表——被动过说明实施偏离了设计。
- 检查 Spec 列出的四类语义分裂是否都有了出口，17 个读取点里是否还有遗漏的终态判断。
- 退出标准：Checklist 无「待验证」残留；偏离设计之处已记录并说明。

### G3 真实场景手测

- [ ] `npm run dev:restart-server`（后端改动必须手动重启，项目禁用 watch）。
- 手测主场景：重启后端 → 会话进入 `INTERRUPTED` → 在对话框发一条带内容的补充需求 → 确认接上原有上下文、进入讨论并重建契约。
- 手测对照场景：同一会话只打"继续" → 确认走检查点恢复而非重建契约。
- 退出标准：两个场景表现与 AC4、AC5 一致。**不一致时不得声称完成**，记录实际表现并给出下一步。
- 边界：不重放历史会话、不调真实模型做批量验证、不改模型与供应商配置。

## 不改动（避免后续误判为遗漏）

- `semantic-intent-router.service.ts` 的 `transitionValid`：它是校验函数，去掉 `INTERRUPTED` 只会让模型推断的 resume 被判非法掉进 clarify，即减少续接能力。
- `semantic-intent-router.service.ts` 的 `deterministicDecision`：精确命令分支从聊天入口不可达（词表拦截在 rollout 分派之前）。
- `deterministic-command-guard.service.ts` 的命令词表：保持闭集合六词与整串精确匹配，不加「断开 / 关闭」。

判据与完整理由见 Design 的「三层意图识别：分层结论」。

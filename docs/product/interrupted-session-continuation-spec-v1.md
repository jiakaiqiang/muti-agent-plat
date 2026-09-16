# 中断会话续接 Spec v1

## 目标与证据

后端重启后会话必然进入 `INTERRUPTED`：优雅关闭时 `sessions.service.ts` 的 `beforeApplicationShutdown` 主动标记，被 `taskkill /t /f`（`scripts/dev-all.mjs` 在 Windows 上的清理方式）或 OOM 杀掉时由 `RecoveryService.onApplicationBootstrap` 在启动时回填。这两条都是既定设计。`recovery.service.ts:24-27` 明确不自动重驱运行时调用（会重复执行命令和写文件），这条边界继续保留。

实际缺陷是**没有出口**：用户在中断会话里发消息，消息进队列后不会被消费。已定位的三重阻塞和四类语义分裂：

- `hasActiveSessionWork` 把 `INTERRUPTED` 当作"有活儿在跑"，使新消息被判 `deferred`，不触发 `scheduleFollowUpPlanning`。
- `processNextFollowUp` 开头对 `INTERRUPTED` 直接 return，五个出队触发点全部失效。
- `normalizeFollowUpHandlingPlan` 的 `resumableFailure` 只认 `FAILED`，中断会话拿不到 `failedExecutionAction`。
- `latestFailurePhase` 只匹配 `error_reported` 或 `status === 'FAILED'`，而中断写的是 `session_status_changed` + `INTERRUPTED`，因此对中断恒返回 `undefined`；此时 `currentTaskBriefId` 通常非空，`retryFailedSession` 会跳过契约重建、直接 resume 一份未定稿的契约。
- `INTERRUPTED` 在 17 个读取点上被当成五种互斥语义：等同 `FAILED`（resume / 命令解析 / 语义路由 / recovery）、等同 `PAUSED`（队列双锁）、终态（Web `sessionStatus.ts`、`SessionWorkspace.vue`、`applyOutcome`）、等待用户（`list` 的 `requiresUserAction`、WorkItem 映射）、可恢复（状态机转移表）。

另有一处独立隐患：意图路由 v2 当前 rollout 为 `shadow`（`.env` 未设 `INTENT_ROUTING_MODE`，默认 `shadow`，`shouldEnforceIntentRouting` 返回 false，实际跑的是 legacy 路径），实时应用点已有 shadow 早退（`applyIntentRoutingOutcome` 在 pause / cancel 分支之前就 return，见 `sessions.service.ts` 的 `routing.rolloutMode === 'shadow'` 分支），**但重启恢复点原先不检查 rollout 模式**：`finish()` 把 shadow 下的判定也记成 `ROUTED`，于是模型推断出的 `pause`（riskLevel `low`，过得了 high-risk 校验）会在下次启动时被补执行。精确命令词在 `sendMessage` 里被 `deterministicCommandGuard` 提前拦走，不经此路；模型推断的 `cancel` 被 `HIGH_RISK_REQUIRES_CONFIRMATION` 拦住。真实暴露面只有模型推断的 `pause`。

## 验收条件

- AC1：`shadow` 模式下，v2 判定出的 `pause` / `cancel` 只落库记录，不改变会话状态；重启恢复不补执行历史 ROUTED 控制动作。`enforce_*` 模式行为不变。
- AC2：`INTERRUPTED` 会话收到迟到的 `delivered` 执行结果时转入 `COMPLETED`；迟到的 `failed` / `rework` 仍被吞掉，中断标记和恢复卡保留。
- AC3：中断时记录 `previousStatus` / `workItemId` / `phase`，`phase` 使用与失败阶段一致的词表（`discussion` / `brief_revision` / `task_execution`）。`retryFailedSession` 优先读它，缺失时回落 `latestFailurePhase`。讨论阶段被中断后点继续，必须重新生成契约而不是 resume 空契约。
- AC4：用户在中断会话里发**带内容的**消息时，队列被消费，会话进入 `AGENT_DISCUSSING` 并基于原有上下文重新生成任务契约（方案 A），旧契约的已接受约束和已完成工作参与合并。
- AC5：用户只说"继续 / 恢复 / resume"时，仍走检查点恢复而非重新生成契约；若崩溃前已有排队消息，控制权交给队列而不是静默忽略。
- AC6：解开队列双锁后，**启动路径**保持保守：`recoverIntentRoutings` 不因中断会话可续而自动重排任务，只有用户真的发消息才唤醒。
- AC7：前端区分"后端不可达"和"会话被中断"。中断时输入框可用、SSE 不断开；后端不可达时仍然禁用。
- AC8：`INTERRUPTED` 的 WorkItem 状态映射在 `sessions.service.ts` 和 `recovery.service.ts` 两侧一致（统一为 `WAITING_USER`）。
- AC9：两层意图识别都不命中而落到澄清卡时，中断会话的选项包含"从中断点恢复"，不再只给「继续当前任务 / 相关新任务 / 独立新任务」三个不对应其处境的选项。兜底保持 fail-closed：不确定时问用户，不自动进入群聊讨论与任务拆解。
- AC10：类型检查、后端定向回归、Web 定向回归通过；固化旧行为的测试同步更新。

## 影响与边界

改动集中在 `packages/shared`（`SessionDetail.interruption` 加三个可选字段）、`apps/server` 的 sessions 与 recovery、`apps/web` 的会话状态工具与工作区组件。

无 schema 迁移、无数据改写、无清库：新增字段全部可选，旧快照反序列化不受影响，缺 `phase` 时回落原有推断。不删除用户数据、历史记录、配置或密钥。不自动重跑用户历史会话，不改模型与供应商配置，不把 Harness 产品化。

改动**不是**只落在 legacy 路径上：`normalizeFollowUpHandlingPlan` 是两条路径的共享收口（`processNextFollowUp` 无条件调用它，v2 实时路径写完 handlingPlan 后经 `scheduleFollowUpPlanning` 回到同一处被重新规范化），因此 P0-D 改它必然同时影响 v2，这不是可选项。

明确不改的两处：`semantic-intent-router.service.ts` 的 `transitionValid`（它是校验函数，去掉 `INTERRUPTED` 只会让模型推断的 resume 被判非法掉进 clarify，即减少续接能力）与 `deterministicCommandGuard` 的词表（保持闭集合六词与整串精确匹配）。理由与三层意图识别的分层结论见 Design。

不在本轮范围：左侧会话项目树与批量删除。`projectId` 是幽灵字段（DB 列 + 合同 + 创建透传都在，但没有 projects 表、没有 CRUD、没有写入方，唯一读取方直接显示原始 UUID），多级树需新表和迁移，等用户另行决策。

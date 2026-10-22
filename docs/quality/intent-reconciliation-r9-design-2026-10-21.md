# R9：人工对账出口设计（M-007，R9a 服务端实施）

## 1. 范围与来源

仅 `intentContractVersion === 'intent-understanding-v1'`；旧链路不变。采用**统一证据视图、按来源限制动作**，本轮人工出口覆盖 R7/R8，不新增自动对账。以下为现有全部 `reconciliation_required` 写入来源（服务端目录简称 S=`apps/server/src/modules/`）：

| 来源与触发 | 当前存储对象／代码 |
| --- | --- |
| R7 派发抛错、遗留 running／非 queued 且非 completed 的控制 step，交付结果未知 | `intentPlanStepsBySession`：原 step 的 `resumeReceipts` 和控制 step.status；S/`message-routing/intent-resume-control.service.ts` |
| R8 派发未知、跨进程执行认领、执行异常；operation 状态不允许重试 | 同集合 `retryReceipts`、嵌套 `execution` 及控制 step.status；S/`message-routing/intent-{resume-control.service,retry-guard}.ts`；部分仅抛阻止码 |
| R8 Runtime 无只读证明（含 CLI） | `assertIntentRetryRuntimeSafe` 在 binding／最终 Runtime 启动前拒绝；可能只有异常，没有对账回执；已有 invocation.error／任务失败记录按实际展示 |
| answer／prepare_brief／review_brief 停止未确认 | `IntentPlanStepRecord.status/failureCode/processing`；S/`message-routing/intent-{answer,brief}-executor.service.ts` |
| 意图纠错停止／效果未核清、分类调用仍活动或 unknown_effect 失败 | `intentCorrectionsBySession` 的 status/reasonCodes/failureClass、`effectReconciliation`；S/`message-routing/intent-correction{,-planner}.service.ts` |
| 隔离测试停止／清理未确认 | 测试 step.status；`logicalOperationsBySession[].isolatedTestAttempts[].phase/stopConfirmed/cleanupRequired`；S/`message-routing/intent-test-executor.service.ts`、`runtimes/isolated-test-{run-store,runner.service}.ts` |

后面三类统一展示但不套用 R7/R8 三动作；保留原处理器和已存在的隔离清理／纠错证据核验。写回 conflicted/failed 属于关联阻塞，指向现有 `workspace-writebacks/:writebackId/resolve`，不能通过本卡伪造已解决。

## 2. 案件与证据

新增持久化 `intentReconciliationsBySession`：caseId、sourceRefs、原 binding、目标、revision、决策审计和一次性 attempt。以明确来源身份关联，R7 列全原 binding.tasks，R8 仅一个失败 task/nodeRun；缺失／多解只展示并阻止，不猜“最新”。读取可发现历史记录，错误入口补记仅有异常的案件；展示本身不认领、不派发。

卡片列服务端已有 invocation/LogicalOperation 的 ID、末次状态、时间、stopState、活动调用、剩余预算；候选／submission checkpoint、writeback、Artifact 的 ID/状态；原授权、版本、目标和 Runtime。每项附记录来源与观测时间。工作区仅展示已存 `workspaceExecution/systemEvidence.workspaceChangeSet/dirtyBaseline`；这些不能证明当前改动归属，缺实时归属证据时明确“未归属改动：未知”。查询无候选记录只说明“未记录”，不等于未执行；缺关联、效果或停止信息均写“未知”。

## 3. 三动作、CAS 与派发互斥

三动作共用：事务内重读事实，校验 owner/actor、session/dataEpoch/generation、目标和案件证据版本；请求带 `caseId + expectedCaseRevision + expectedSessionRevision + idempotencyKey`。幂等范围为 actor/session/epoch/case/key，同键同载荷返回原结果，同键异载荷或不同决定竞争返回 409；陈旧证据须刷新。与正常 resume/retry、队列消费共用**会话持久化派发栅栏**：事务 CAS 案件和目标版本、唯一认领 attempt；启动及结果落账均复核栅栏代次，不能只靠进程 Map。

| 用户动作 | 原子认领后的行为 |
| --- | --- |
| ① 确认没有执行，重新派发一次 | 仅在服务端确认停止且无活动执行后，经 `SessionsService.resume()` 共用路径完整重跑 R7/R8 守卫：原计划／grant、Brief/WorkItem/intent/requirement 版本、epoch/generation、取消／替代检查、R8 检查点及无候选／提交／写回限制、Runtime 安全和原 operation 次数／时间预算。R6 hold 优先，仍由原确认卡授权与消费，不清 hold、不新建 operation 绕预算。任一失败零派发。 |
| ② 确认已经执行过，按完成处理 | 同样要求无活动执行且停止确认；仅将明确绑定的任务／nodeRun 记为“人工确认完成”并关闭案件，会话进入 WAIT_USER_DECISION 并附结果通知，零派发，不推进下游／评审／交付。不改历史 invocation 结果，不制造 Artifact、测试通过或写回成功；未解决写回／隔离清理仍阻止此动作。 |
| ③ 放弃这个任务 | 事务关闭该目标的派发资格、标记取消并审计；必要时复用停止端口，停止不明事实继续保留。只取消卡上明确目标，会话保留、不置 CANCELLED；旧队列和迟到结果被栅栏拒绝，不能复活。 |

①以新 attemptId 关联旧 binding，在 R7/R8 控制／执行认领端识别此人工一次性派发；原终态 receipts、claim、binding 均保留，不重置、不追加重复 pause/checkpoint 身份，不放宽既有唯一性。只替代已由人工裁决的未知交付／执行认领阻塞，其余守卫不变；不能满足守卫时①仍禁用并展示原因，不补造状态。派发接受≠执行成功；认领后崩溃或结果再未知，保留新 attempt 并重新出卡，不自动重派。②③同事务完成审计与状态写入，重复点击零额外变更。

## 4. 用户决定：CLI 显式确认后放行（2026-10-21）

仅动作①、仅 codex/claude_code，可用 `acceptWorkspaceResponsibility: true` 加风险说明版本显式确认，缺一即拒绝；确认绑定本案件本次 attempt，不能跨案件或下次派发复用，审计 actor、时间、证据版本、风险说明版本和 Runtime。在 `assertIntentRetryRuntimeSafe` 调用点核验该 attempt 的人工确认，不改变该函数其它判断；R6/R7/R8 其它守卫及原 operation 预算不豁免，mcp_tool/test_runner/human 始终阻止。

## 5. 卡片与 API

仿 R6 `input-budget/decision`，拟增 `GET /sessions/:sessionId/intent-reconciliations`（no-store）和 `POST .../:caseId/decision`。复用 `user_confirmation_requested/resolved`，reason=`intent_reconciliation_required`；自然语言“继续”不代替结构化决定。Web 与 desktop 各自的 ConfirmationCard、ChatTimeline、SessionWorkspace 接线，共用 Web session/event store 和卡片类型；刷新从持久化案件恢复，显示未知证据、动作禁用原因和原决定，提交中／已消费不重复执行。沿用当前本地 owner 入口边界，不将 ownerId 冒充新增身份认证。

## 6. 改动文件与验收（M-007 分轮）

R9a 仅实施下述服务端及共享合同；Web/desktop 接线留到 R9b。关系型新表迁移接在仓库最新编号后；PostgreSQL 集成测试只使用 `agent_cluster_<...>_<pid>_<ts>` 一次性库并清理，无 `RELATIONAL_TEST_DATABASE_URL` 则 skip 并如实报告，禁止连接主库。

合同：`packages/shared/src/{contracts,intent-reconciliation-contracts,index}.ts`；S 下新增 `message-routing/intent-reconciliation.service.ts` 及 spec，接入 `message-routing/intent-{resume-control.service,retry-guard}.ts`、`sessions/sessions.{controller,service,module}.ts`、`queue/execution.{queue,worker}.ts`、`orchestrator/orchestrator.service.ts`、`runtimes/runtime.service.ts` 的认领及结果栅栏；`persistence/{persistence.service,intent-record-invariants}.ts`、其下 `relational/relational-{schema,state-store}.ts` 配套持久化与不变式。两端改 `components/{ConfirmationCard,ChatTimeline,SessionWorkspace}.vue`，共享 `apps/web/src/{types/contracts,stores/session,stores/event}.ts`。不改编译器、范围解析器、提交层、默认开关、.env、semantic-intent-router。

先红例证明目前无对账决定接口可退出；再测来源全量展示／未知事实、①全守卫及 R6 优先、②③零派发、兄弟／上游零变化、取消不复活、原回执不可变、幂等／并发／迟到结果／崩溃，CLI 缺字段／跨案件／跨 attempt 和禁止 Runtime 确认均拒绝；File/Postgres 事务并发单列验收。补②状态与通知、旧链路不变。R9a 跑定向 spec、R6–R8 回归、server typecheck/build、隔离重启冒烟；R9b 再测两端卡片。不跑真实模型、不提交推送，完成后停止等待监督方复核。

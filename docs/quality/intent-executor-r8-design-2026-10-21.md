# R8：失败任务重试与检查点接线设计（M-005 实施版）

范围：M-004 设计、M-005 有条件通过后收窄实施，仅 `retry_failed_step`；依据[设计 §6.3](../design/intent-recognition-correction-system-development-design-v1.md#63-状态和风险)及 2026-10-21 用户决定“只重跑失败的那一个任务”和 [R7](intent-executor-r7-design-2026-10-21.md)。实施与验证见本轮报告。

## 1. 检查点对象、来源与失效

现有 `SessionRecoveryCheckpoint` 只是恢复卡；`AgentTask.executionCheckpoint` 记录 candidate/submission/writeback 阶段，workflow 失败 nodeRun 会复制它；`LogicalOperation` 提供调用和授权身份。三者单独均不足以证明可单步重试。

在 `session.activeRecoveryCheckpoint` 增加不可变 `retryBinding`：以 `confirmationId` 为 checkpointId，绑定 actor/session/dataEpoch/generation、WorkItem/Brief 及版本、原 operation/intentStep/executionBinding、失败 invocation/phase/runtime/attempt；workflow 再绑定 run/revision/nodeRun/attempt/definitionHash。失败落账时，Orchestrator 传明确失败任务和调用证据，workflow 固定失败 nodeRun，Sessions 在 `createRecoveryCheckpoint` 写入；缺证据只生成原恢复卡。候选/提交/写回不作为阶段接续授权，进入时重新查证并阻止；启动重建不得猜造 binding。

卡已解决/替换、取消/归档、目标或授权版本变化、epoch/generation 改变、候选过期/基线或权限哈希变化即失效；认领后不可再次消费，下一次确证失败生成新检查点。历史缺绑定记录阻止，不补造。

## 2. 编译接线与共用入口

提交层从事务 draft 的 activeRecoveryCheckpoint 读取 binding，联查任务、operation、原计划、失败 nodeRun 和效果证据，唯一且有效才把 `confirmationId` 作为 `recoverableCheckpointId` 传入现有编译器；编译器不改。无有效绑定：`RETRY_CHECKPOINT_REQUIRED`；多解：`INTENT_RETRY_CHECKPOINT_AMBIGUOUS`；版本失效：`INTENT_RETRY_CHECKPOINT_STALE`。模型/客户端提供的 ID 不作依据。

语义提交 → R7 控制端口 → `SessionsService.resume()`；精确“重试/继续执行”的 `retry_current` 也进入此处。仅 `intentContractVersion === 'intent-understanding-v1'` 的 FAILED/INTERRUPTED 分派到受限 retry 分支，再经 `resumeExecution()`/既有 workflow 恢复入口；旧链路原分支不变。新分支不能调用旧 `retryFailedSession` 的全量 failed 重置、Brief 重建或 follow-up 兜底。

## 3. 单任务边界与原授权（M-005 / 2026-10-21 用户决定）

重试单位为唯一绑定的失败 AgentTask（workflow 为其失败 nodeRun）。仅该次失败尚无候选、提交和写回时，从调用开始重跑这个任务一次；兄弟任务、成功任务和上游 nodeRun 的状态与调用次数均为零变化。已有候选/提交/写回返回 `INTENT_RETRY_STEP_UNSUPPORTED`，详情指向现有 workspace writeback resolve / 冲突处理入口，不新增阶段接续或工具循环发送断点。

队列与本地执行携带同一 binding，调度前再核验；Orchestrator 只加按绑定运行一个任务的窄分支，现有评审、交付、返工和依赖扩集合逻辑不改。workflow 精确绑定失败 nodeRun，禁止“找最近失败节点”。Generic LLM 的三个只读工具允许安全重跑；CLI 或其他 Runtime 不能证明无直接写入时返回 `INTENT_RETRY_RECONCILIATION_REQUIRED`，实际 Runtime 选择处也守卫，防切换绕过。

| 守卫 | 复用或新增规则及阻止码 |
| --- | --- |
| R7 公共授权核验 | 复用 actor/生命周期、stopConfirmed、原 revision/step/grants、Brief、WorkItem 版本、范围/禁止项、dispatchHold 和 decision/scope hash；保留 R7 各错误码及 `assertIntentExecutionCurrent`。原计划须 validated/applicable；恢复消息的空效果不授新权限。 |
| retry 专属状态 | 不套用 PAUSED/pausedAt 与“排除 failed”规则；只接唯一失败槽位，WorkItem FAILED 仅在匹配该失败证据时允许，cancelled/completed/stale 永不复活；不匹配报 `INTENT_RETRY_TARGET_OBSOLETE`。原 step 若 failed，须证明仅本次执行失败；invalidated/reconciliation_required 仍阻止。 |
| retry 专属身份 | 检查 binding、原 operation、失败 attempt/nodeRun 的 epoch/generation 和版本完全一致；不接纳新 generation。失败步骤仍用原 effectScope 与有效 grant，不扩效果；分别报 `INTENT_RETRY_CHECKPOINT_STALE` / R7 `INTENT_RESUME_GRANT_STALE`。 |

## 4. 效果对账、幂等与 R6

外部调用结果未知或 Runtime 无只读证明不得重试；无记录不等于无效果，超时不等于已停止。复用 `reconciliation_required` 并返回 `INTENT_RETRY_RECONCILIATION_REQUIRED`；已有候选/提交/任何写回一律 `INTENT_RETRY_STEP_UNSUPPORTED`，走原 resolution 入口，本轮不自动跳过或接续阶段。**目前无通用外部效果对账/解除回执入口及专用前端提示，本轮不补，未对账保持阻止**。

沿用 R7 会话串行、事务认领和回执模式，在原 step 追加 retryReceipts，以 checkpointId+失败 invocation 唯一认领（不用 pausedAt），控制 step 保存 binding；重复返回原回执，跨入口并发只派一次。另在同一回执上持久化执行认领，防队列重复投递；遗留 running 或派发/执行结果未知转 reconciliation_required，不自动重派；成功控制认领后才解决恢复卡。沿用原 operation 的次数和时间预算，不新建 operation 绕过预算。

两入口在状态/任务变更及认领前先跑 `assertNoPendingInputBudget`：未决 hold/预算卡返回 `INPUT_BUDGET_STRUCTURED_DECISION_REQUIRED`，所有对象和调用数不变。因 input_budget_exceeded 停下只能走 R6 卡；“继续”的一次放行仍由 R6 消费，“结束”的取消任务不可由 retry 复活，不清 hold、不换 operation 绕过预算。

## 5. 改动文件与验收顺序

合同：`packages/shared/src/{contracts,intent-correction-contracts}.ts`（binding/回执）；服务端 `src/modules/` 下：`message-routing/intent-plan-commit.service.ts`（补参数/执行器）、`intent-resume-{guard,control.service}.ts`（抽公共核验/端口）、新增 `intent-retry-guard.ts`；`sessions/sessions.service.ts`（写检查点/共用恢复）、`orchestrator/orchestrator.service.ts`（失败阶段/窄执行）、`workflows/workflow-runtime.service.ts`（固定 node attempt）、`execution/execution.service.ts`、`queue/execution.{queue,worker}.ts`（传递/复核）、`persistence/intent-record-invariants.ts`（不可变绑定/追加回执），及对应 spec。不改编译器、execution-scope-resolver、默认开关、.env、semantic-intent-router。

先红例：生产 retry 缺参数得 `RETRY_CHECKPOINT_REQUIRED`，缺执行器仍为 `INTENT_ACTION_EXECUTOR_UNAVAILABLE`。再覆盖：单任务正例及兄弟/上游零重做；缺失/歧义/失效、撤权/版本竞争、取消、已有候选/提交/写回、未知效果、重复/并发/崩溃；精确与语义入口同路，旧链路调用数/状态不变；两入口 R6 未决卡零变化和结束不可复活。按 M-005 跑定向 spec、R7/R6 回归、server typecheck/build 与隔离重启冒烟；结果和范围外配套文件说明见 [report.md](intent-executor-r8-2026-10-21/report.md)。不跑真实模型，不提交推送，完成后交监督方复核。

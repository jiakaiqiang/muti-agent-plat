# R7：resume 与空效果延续设计（待复核）

依据：[设计 §6.3](../design/intent-recognition-correction-system-development-design-v1.md#63-状态和风险) 与 M-002。只设计 PAUSED 纯恢复、EXECUTING 空效果延续；replan、retry_failed_step、带效果延续仍阻止，recoverableCheckpointId 接线另议。本次不实施。

## 1. 原计划的定位与授权来源

原授权是 `IntentRouteRevision.validatedPlan` 中的执行 step（executionBinding/effectScope）及 revision.authorityGrants，须 validated/applicable；任务/流程是载体。`TaskBrief.intentConfirmationReceipt` 只证明草稿确认；流程选择返回 `executionAuthorized:false`，均不授执行权限。

定位：`Session.activeWorkItemId + currentTaskBriefId` → 同属目标的已确认 Brief；有 workflowRunId 只取该 run，核对 briefId/workItemId/definitionSnapshot，再取当前 nodeRun.relatedTaskId；无 run 则固定该 WorkItem 原待恢复任务集合。每个任务以 executionOperationId 关联 `LogicalOperation`，核对 taskId/workItemId，再以其 dataEpoch/intentStepId/executionBinding 精确关联原 revision/step。所有任务须归属唯一原计划；Brief 收据 requirementRevision 须匹配原 binding，不挑“最新”记录。

缺关联：`INTENT_RESUME_PLAN_MISSING`；多解：`INTENT_RESUME_PLAN_AMBIGUOUS`；只有 Brief/选流程/unknown 授权：`INTENT_RESUME_AUTHORITY_UNPROVEN`。现存记录未必有完整执行授权链，含无绑定 pending 任务时仍阻止；不补造授权，不借 prepare_brief 空效果授权。

## 2. 共用恢复路径与逐项守卫

提交层只接纳单段 resume、requestedEffects=[]，拟在 `IntentPlanStepRecord.resumeBinding` 保存原计划/Brief/run/任务/版本标识；提交后经控制端口调用 `SessionsService.resume()` → `resumeExecution()` → 现有流程恢复/执行入口，与精确命令“继续”同路。现有恢复缺完整授权版本检查，流程入口还会将 task 改回 pending、接纳新 generation；新链路会话的两个入口须统一补齐下表，旧链路不推断新授权。

| 检查（提交及调度前） | 拟新增阻止码：前缀 `INTENT_RESUME_` |
| --- | --- |
| actor 匹配、会话未删除/归档 | `SESSION_UNAVAILABLE` |
| PAUSED、暂停前 EXECUTING、纯恢复 | `STATE_INVALID` |
| stopConfirmed：持久化停止汇总可恢复，idle/confirmed，无 requested/unconfirmed 或仍运行调用 | `STOP_UNCONFIRMED` |
| operation/revision.dataEpoch 匹配 Session；operation/原 step binding/run 的 sessionGeneration 匹配 lifecycle，缺失即阻止 | `IDENTITY_STALE` |
| 原 route.effectiveIntentRevision、WorkItem.requirementRevision/executionEpoch、Brief 版本匹配 | `VERSION_STALE` |
| 活动 WorkItem 同一目标；任务非 cancelled/stale；Brief 未替代；run 非终态/待改派或返工 | `TARGET_OBSOLETE` |
| 原 grant 的 id/revision/resource/effect 与当前有效授权一致、未撤销；范围/禁止项仍可执行 | `GRANT_STALE` |

dispatchHold、decisionSetHash、step/scopeHash 失效分别沿用 `INTENT_DISPATCH_HELD`、`INTENT_EXECUTION_DECISIONS_STALE`、`INTENT_EXECUTION_SCOPE_STALE`。

复用 `assertIntentExecutionCurrent` 并补齐上述检查；使用原 binding/scope，恢复消息空 scope 不覆盖它。按会话串行，以暂停版本 CAS+回执认领一次；调度前复核，防取消/撤权竞争。重复只返回执；崩溃后派发不明置 reconciliation_required，不盲重试。禁止复活 cancelled task 或进入 FAILED/INTERRUPTED 整任务重试分支。

## 3. 空效果延续与 R6 隔离

**提交层零派发**：单段、当前 WorkItem、EXECUTING、单纯延续且无效果/纠错/新增约束/目标变更，原 enqueue_follow_up 步骤原子记 completed、route.actionStatus=applied，记录 acknowledge 回执；不改编译器动作。该分支不创建 FollowUp/任务、不调用 executor/resume/队列、不推进 WorkItem 版本；其它 enqueue 仍 `INTENT_ACTION_EXECUTOR_UNAVAILABLE`，状态竞争重新裁决。

未决 R6 hold（WAIT_USER_DECISION / input_budget_exceeded，含暂停前预算等待）优先于 resume/failed-run 兜底：精确命令及自然语言“继续”均返回 `INPUT_BUDGET_STRUCTURED_DECISION_REQUIRED`，指向原卡，保持 hold/Session/任务不变。路由自身预算 hold 同样只能走 R6 结构化决定；一次放行仍绑定 actor/epoch/generation/槽位/E/R/C，不授新效果。

## 4. 后续实施顺序与验收（本次不执行）

先在 `message-routing/intent-plan-commit.service.spec.ts` 写红例：恢复调用共用端口一次；空效果延续成功且零派发；当前均为 `INTENT_ACTION_EXECUTOR_UNAVAILABLE`。再覆盖上表负例、缺失/歧义/仅 Brief 授权、撤权/版本竞争、重复/并发/崩溃；sessions/workflows spec 验证共用路径且取消任务不复活。

负向断言：延续/重复提交前后 invocation 次数、派发事件/入队/FollowUp/任务数不变（允许路由审计事件）；预算等待两入口及 failed-run 兜底不消费 hold；范围外动作仍阻止。全部 fixture/mock，不调模型。

拟改：server modules 下上述 commit 服务/spec；新增 `message-routing/intent-resume-guard.ts`/spec；`sessions/sessions.service.ts`、`workflows/workflow-runtime.service.ts`、`execution/execution.service.ts`/spec（共用守卫）、必要 module 接线；`packages/shared/src/intent-correction-contracts.ts`（回执）。获准后跑定向 spec、R6 回归、server typecheck/build、重启冒烟。编译器、范围解析器、默认开关、.env、semantic-intent-router 不动。

R6 五文件复跑：36/36，exit=0；时间与完整 stdout/stderr 见 [日志](intent-input-budget-r6-2026-10-21/evidence/supervisor-rerun.log)。本次未额外构建、未提交推送。

# R7 / M-003 实施与验证报告

日期：2026-10-21。状态：实施和本地验证完成，等待监督方复核；未提交、未推送。

## 1. 结论与依据

按 [R7 设计](../intent-executor-r7-design-2026-10-21.md) 和收件箱 M-003 的 C1–C3 实施，补齐新链路两个最窄的动作：

- PAUSED 下的单段纯 `resume`：`requestedEffects=[]`，服务端定位原执行授权，复核后进入与精确命令“继续”相同的 `SessionsService.resume()` 恢复路径。
- EXECUTING 下的单段空效果 `enqueue_follow_up`：当前 WorkItem 有活动任务或业务调用时，只确认收到，不重复派发；没有活动执行时阻止。

最终 11 个 spec 文件合并运行 **303/303 通过，失败/跳过均为 0**；server typecheck、server build、`npm run dev:restart-server` 隔离冒烟均通过。此次验证使用 fixture/mock 和真实 File 持久化，没有真实模型调用，不能据此得出意图识别准确率提升的结论。

加载依据包括项目地图、Harness 执行协议、R7 设计、M-003，以及恢复、提交、执行、队列、持久化的相关代码与测试。本次已进入实现；工作区原有大量未提交修改，本报告仅描述本轮增量，不把完整 Git diff 归为 R7。

## 2. 行为与验收对应

| 验收项 | 实现结果 | 验证证据 |
| --- | --- | --- |
| C1：只影响新链路 | 恢复授权守卫由 `intentContractVersion === 'intent-understanding-v1'` 限定；旧链路继续走原恢复逻辑 | sessions spec：旧会话暂停后精确“继续”，PAUSED→EXECUTING，执行启动恰好 1 次；再次“继续”无新增启动 |
| 共用恢复入口 | 自然语言提交层经控制端口调用 `SessionsService.resume()`；精确命令进入同一方法；后续复用 `resumeExecution()` | sessions spec：两入口各恢复 1 次，实际只传原绑定任务，未绑定任务不被重置 |
| 原授权唯一定位 | 活动 WorkItem/Brief → 原 task/LogicalOperation → 原 routing/revision/执行 step；工作流固定 run、当前 nodeRun、relatedTaskId 和任务归属 | guard spec：缺失、多解、仅 Brief、unknown 授权均阻止；工作流归属、generation、定义变更负例 |
| C2：活动执行证明 | 仅当前 WorkItem 的运行任务，或当前 epoch/generation 的活动 business operation 可证明活动；路由调用、其他 WorkItem、无活动状态不能证明 | commit/guard specs：有效延续完成回执；无活动返回 `INTENT_CONTINUATION_NOT_ACTIVE` |
| 延续零派发 | 提交层将控制 step 记为 completed、route.actionStatus=applied；不创建新任务/FollowUp、不调用恢复或其它执行器 | commit spec：重复提交后 executor 调用数为 0，invocation/任务/WorkItem 不变，派发事件数为 0，FollowUp ID 集合不增加 |
| C3：预算等待优先 | 新链路两个“继续”入口均先拒绝未决 R6 hold，不消费放行、不进入失败重试兜底 | sessions spec 覆盖 PAUSED/WAIT_USER_DECISION；commit spec 覆盖 resume/空效果延续；错误均为 `INPUT_BUDGET_STRUCTURED_DECISION_REQUIRED`，hold、Session、任务及执行启动次数不变 |
| 版本/撤权竞争 | 提交、状态迁移、实际派发前复核原 binding、scope、grant、决策和版本；队列出队再复核 | guard/execution/queue specs：撤权、版本变化和任务取消阻止；被取消任务没有 pipeline/queue 调用 |
| 不复活旧任务 | 排除 cancelled/stale/failed/completed 任务和废弃目标；恢复只操作原绑定任务集合 | guard、sessions、workflow、queue specs；工作流取消任务不回到 pending |
| 重复/并发/崩溃 | 会话内串行；原 step 上持久化认领，按 session/epoch/generation/pausedAt 识别同一次暂停；已完成回执不重派 | guard spec：并发、重放、File 重载、进程重启遗留 running、派发异常；修改消息 revision 不能绕过待核对回执 |

`IntentResumeControlService` 只负责端口和派发回执，不包含另一套恢复引擎。派发结果不明时写 `reconciliation_required`，不自动重试。`resumeBinding` 保持不可变；回执只能追加，已存在回执的绑定与认领身份不能篡改，终态不能回退。

已有输入 FollowUp 路由封套可以按原提交逻辑被消费/取消；“零派发”不要求这类旧封套状态不变，也不禁止路由审计事件。测试分别断言没有新 FollowUp、任务和业务派发。

## 3. 阻止规则

| 检查失败 | 返回/记录的错误码 |
| --- | --- |
| actor 不符、Session 不可用/归档 | `INTENT_RESUME_SESSION_UNAVAILABLE` |
| 非 PAUSED 纯执行恢复、暂停前不是 EXECUTING | `INTENT_RESUME_STATE_INVALID` |
| 停止未确认、仍有业务调用运行 | `INTENT_RESUME_STOP_UNCONFIRMED` |
| dataEpoch/generation 缺失或失配 | `INTENT_RESUME_IDENTITY_STALE` |
| 原意图/需求/执行 epoch/Brief 版本改变，或固定绑定不符 | `INTENT_RESUME_VERSION_STALE` |
| 找不到唯一原计划 / 存在多解 | `INTENT_RESUME_PLAN_MISSING` / `INTENT_RESUME_PLAN_AMBIGUOUS` |
| 只有 Brief 收据、准备步骤或未知授权 | `INTENT_RESUME_AUTHORITY_UNPROVEN` |
| WorkItem/任务取消、过期或归属改变、Brief 被替代、run 不可恢复 | `INTENT_RESUME_TARGET_OBSOLETE` |
| 原 grant 撤销、变化或效果资源不匹配 | `INTENT_RESUME_GRANT_STALE` |
| dispatchHold、决策集或范围失效 | `INTENT_DISPATCH_HELD` / `INTENT_EXECUTION_DECISIONS_STALE` / `INTENT_EXECUTION_SCOPE_STALE` |
| 预算 hold 未决 | `INPUT_BUDGET_STRUCTURED_DECISION_REQUIRED` |
| 空效果延续没有活动执行 | `INTENT_CONTINUATION_NOT_ACTIVE` |
| 本进程已有恢复认领 / 派发结果不明 | `INTENT_RESUME_IN_PROGRESS` / `INTENT_RESUME_RECONCILIATION_REQUIRED` |

提交前的授权负例形成 blocked plan；入口/派发阶段的冲突抛出对应错误。已经认领后失败会保留待核对状态，不以错误消息推断“可以安全再次执行”。

## 4. 改动范围

实际涉及 18 个源码/测试文件，完整路径与逐文件 SHA-256 见 [verification.json](evidence/verification.json)：

- message-routing：commit 服务及 spec、resume guard/control/fixture/spec、module 接线。
- sessions：共用入口、新链路守卫、原绑定任务选择及回归测试。
- workflows：恢复前检查、原绑定传到实际执行入口及测试；未新增节点、动作或工作流能力。
- execution/queue：实际派发前和出队前复核；只传递、选择原绑定任务。
- shared：恢复绑定及回执合同。
- persistence：恢复回执的窄范围状态变更约束。

### 设计 §4 未逐项列出的文件及原因

以下文件是已批准方案所需的配套实现，单独列出供复核：

| 文件 | 原因及边界 |
| --- | --- |
| `apps/server/src/modules/message-routing/intent-resume-control.service.ts` | 用薄控制端口连接提交层与现有 Sessions 恢复入口，避免另写恢复引擎；同时持久化认领和不明派发回执 |
| `apps/server/src/modules/message-routing/intent-resume.fixture.ts` | 仅供测试构造历史原执行授权；不从空效果恢复消息推导权限 |
| `apps/server/src/modules/queue/execution.queue.ts` | 现有 job 合同携带原 `intentResumeBinding`，避免延迟队列丢失授权上下文 |
| `apps/server/src/modules/queue/execution.worker.ts` | 出队时重新复核撤权/版本/取消，且只重置和派发原绑定任务；旧链路走原分支 |
| `apps/server/src/modules/queue/execution.worker.spec.ts` | 不连 Redis，直接验证真实 worker 处理函数：无跨 WorkItem/无归属任务派发，取消后零调用 |
| `apps/server/src/modules/persistence/intent-record-invariants.ts` | 真实 File 测试暴露新增回执被 `INTENT_RECORD_IMMUTABLE` 拒绝；仅放开 resumeReceipts 的合法状态推进，保留 step/binding 不可变与终态限制 |

`.cache/supervisor/r7-smoke.mjs`、`r7-capture-delivery.mjs` 是本地验证脚本；本目录报告/证据和收件箱 DONE 回执属于交付材料。module、sessions/workflows/execution 的对应 spec 已在设计 §4 的服务/spec 和必要接线范围内。

## 5. 验证与失败记录

| 阶段 | 结果 | 完整证据 |
| --- | --- | --- |
| 最初先写两条动作红例 | 2 条目标用例失败，当前均为 `INTENT_ACTION_EXECUTOR_UNAVAILABLE`；22 条按名称过滤跳过 | [red.log](evidence/red.log) |
| File 回执红→绿 | 先复现 `INTENT_RECORD_IMMUTABLE`，修正后 guard+commit 66/66 通过；包含重载、绑定篡改及终态回退负例 | [红例](evidence/receipt-persistence-red.log)、[绿例](evidence/receipt-persistence-green.log) |
| 派发边界补充红→绿 | 先复现任务越界选择、工作流未传 binding、归属未校验；修正后 235/235 通过 | [红例](evidence/dispatch-boundary-red.log)、[派发红例](evidence/dispatch-boundary-red-dispatch.log)、[绿例](evidence/dispatch-boundary-green.log) |
| 最终合并 spec | **303/303，exit=0**，11 文件，0 失败/跳过 | [spec-delivery.log](evidence/spec-delivery.log) |
| server typecheck | **exit=0** | [typecheck-delivery.log](evidence/typecheck-delivery.log) |
| server build | **exit=0** | [build-delivery.log](evidence/build-delivery.log) |
| 实际 npm 重启冒烟 | **exit=0**，健康正常、PID 切换、构建不陈旧、错误预算请求拒绝 | [smoke.json](evidence/smoke.json)、[运行日志](evidence/smoke-run-complete.log)、[重启日志](evidence/dev-restart-final.log) |
| 哈希与证据断言 | 18 份 source、18 份对应 dist，4 个受保护文件与开工前哈希一致 | [capture.log](evidence/capture.log)、[verification.json](evidence/verification.json) |

最终 spec 覆盖以下文件（`apps/server/src/modules/` 下，均为 `.spec.ts`）：

```text
message-routing/intent-plan-commit.service
message-routing/intent-resume-guard
sessions/sessions.service
workflows/workflow-runtime.service
execution/execution.service
queue/execution.worker
runtimes/generic-llm-input-budget
runtimes/input-budget-store
runtimes/input-budget-tool-rerun
runtimes/generic-llm-tool-loop-budget
message-routing/intent-message-pipeline.service
```

执行器为 `node node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json --test --test-concurrency=1 --test-force-exit <上述文件路径>`。R6 指定五文件包含在本次最终运行中；`generic-llm-tool-loop-budget.spec.ts` 在本次没有失败。类型检查/构建分别使用 `npm run typecheck -w @agent-cluster/server`、`npm run build -w @agent-cluster/server`。

中间失败均保留，未覆盖：初期测试/类型错误为新夹具缺字段，已修；`spec-verified.log` 曾有 1 条 FollowUp 断言失败，因为旧输入路由封套按既有逻辑由 queued 转 cancelled，测试改为验证 ID 集合不增加，同时验证所有执行器零调用。最终日志为 `spec-delivery.log`。

冒烟使用随机独立端口 56036、独立临时 File 数据和仅对子进程生效的 mock/禁用自动 Local Runtime 环境；未修改 `.env` 或默认配置。第一次缺 v3 初始化元数据而启动失败，第二次 Windows shell 参数解析失败，记录分别保留于 `smoke-run.log`、`smoke-run-final.log`。补齐测试数据后，用 Node 直接执行 npm CLI 的 `run dev:restart-server`，实际运行原仓库重启脚本成功：PID **3392→102376**，`runtimeBuildStale=false`；预算接口空请求返回 **400 / INPUT_BUDGET_DECISION_INVALID**，Session/invocation 为 0，临时后端进程树已关闭，数据留存。重启日志前一条 shell 错误属于失败尝试，后续成功记录与 `smoke.json` 对应。

未跑 Web/desktop 测试或全仓全量测试：本轮未改双端，按 M-003 指定最小验证集合执行。未连接真实 Redis/Postgres 验证多进程并发。

## 6. 冻结哈希与边界

聚合算法：对 `verification.json` 中按源码路径排序的 `{path,sha256}` 数组做 `JSON.stringify`，再计算 SHA-256；dist 数组依对应源码顺序生成。各文件独立 SHA 均列在 manifest 中，聚合值不代替逐文件值。

| 项目 | SHA-256 |
| --- | --- |
| 18 文件源码聚合 | `ddd845797d2fcd730033863eb72c954a4ed8855c52671e6702cd4681f7b3cb59` |
| 18 文件 dist 聚合 | `a487774d0107266ed7eabfbb249b15cf8f300a886af4593fd920004404d6b7bd` |
| `evidence/verification.json` | `d4dfb44eab6a2ac2297ec5ea0841e2b8ca7576d8231604d6024276649c3cf9e0` |

与 [protected-before.json](evidence/protected-before.json) 对比，编译器、`execution-scope-resolver`、`semantic-intent-router`、`.env` 的 SHA-256 全部相同。没有改提示词、模型配置或新链路默认开关；新链路默认仍关闭。构建产生的 dist 反映当前工作区完整源码，不代表所有原有未提交改动都属于本轮。

仍存在的适用限制：

1. 历史会话可能没有完整、唯一的原执行授权链；这些会话在新链路上会被阻止，不补造授权。Brief 确认和流程选择本身都不授权执行。
2. `replan`、`retry_failed_step` 以及带效果的非测试延续未增加执行器；`recoverableCheckpointId` 接线不在本轮。
3. 崩溃后派发不明只标记待核对并阻止盲重试；未新增自动 reconciliation 引擎或前端处理页。
4. 并发/竞争通过本地事务、同进程并发、真实 File 重载和模拟重启验证；真实 Redis/Postgres、多服务进程及真实模型端到端链路未验证。健康冒烟不等于完整业务恢复端到端验收。

交付后停止，等待监督方复核；未启动模型评测、未提交、未推送。

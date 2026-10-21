# R8 / M-005 实施与验证报告

日期：2026-10-21。状态：实施和本地验证完成，等待监督方复核；未提交、未推送。

## 1. 结论与边界

按 [M-005 收窄后的设计](../intent-executor-r8-design-2026-10-21.md) 实现新链路 `retry_failed_step`：只重跑唯一绑定的失败 AgentTask，workflow 下固定原失败 nodeRun；只接受原失败调用尚无候选、提交和写回、原授权仍有效且 Runtime 可证明无直接写入的情况。语义重试与精确“重试 / 继续执行”共用 `SessionsService.resume()`，没有另造恢复引擎。

最终 **15 个 spec 文件、535/535 通过，失败/跳过均为 0**；server typecheck、build 和隔离 `npm run dev:restart-server` 冒烟通过。验证使用 fixture、模拟适配器、真实 File 持久化和真实 LogicalOperationStore，没有真实模型调用。这是执行接线与安全边界验证，不能据此得出意图识别准确率提高的结论。

只对 `intentContractVersion === 'intent-understanding-v1'` 生效。默认开关与旧链路未改，`replan`、带效果的非测试延续仍不在本轮；未改编译器、范围解析器、semantic router、`.env`，未新增工作流节点、阶段接续或对账页面。

## 2. 实现与验收对应

| 验收项 | 实现与验证结果 |
| --- | --- |
| 失败时绑定，不猜造 | Orchestrator 为真实 task_execution 失败保存最终失败 invocation 身份，Sessions 在失败/中断落账时捕获不可变 retryBinding；绑定 actor、Session、epoch/generation、WorkItem/Brief/原授权、operation、调用及 attempt，workflow 再绑定 run/revision/nodeRun/attempt/定义哈希。没有明确任务/调用或完整授权时只保留普通恢复卡。sessions 与 guard spec 验证有证据/无证据两类结果。 |
| 编译器参数接线 | 提交层在事务 draft 复核服务端 binding，从其 checkpointId 传 `recoverableCheckpointId`。不采信模型/客户端的 checkpoint ID。先复现生产入口 `RETRY_CHECKPOINT_REQUIRED`，实现后计划可提交，重复提交只派发一次；没有可用控制端口仍阻止。编译器文件 SHA 不变。 |
| 单任务边界 | Orchestrator 在常规流水线前进入窄分支，只调用绑定任务；验证依赖已完成，不扩集合，不进入常规评审、交付或返工循环。该模式不触发 runOneTask 的整任务超时/补上下文递归重跑；旧模式分支保留。测试调用列表恰为 `['original-task']`，兄弟/上游对象不变，评审入口若被调用即失败。 |
| 工作流边界 | 原失败 nodeRun/task 原地恢复，nodeRun ID 和 attempt 不变，仅 run 的本次状态迁移使 revision 加 1。不调用旧失败分支的节点重建，不重做上游或兄弟任务。workflow/queue spec 验证只传这一个 task，并保留 retryBinding；需求版本竞争时零派发。成功后复用既有 workflow_step_completed 处理，后续正常推进规则未改。 |
| 已有候选/提交/写回 | 检查 task.executionCheckpoint、调用的 executionCandidate/githubCandidate/workspaceExecution、systemEvidence.workspaceChangeSet、关联 task_execution Artifact、关联 WorkspaceWriteback。命中即 `INTENT_RETRY_STEP_UNSUPPORTED`、零调用。错误 details 带 writebackIds/artifactIds 和现有 POST `/sessions/:sessionId/workspace-writebacks/:writebackId/resolve` 路径；没有 writebackId 时明确不支持自动阶段接续。guard 的七类证据及生产提交 spec 均覆盖。 |
| 共用入口 | 精确“重试”“继续执行”和语义控制端口均进入 Sessions.resume → 同一 retry 守卫/认领 → retryWithBinding → resumeExecution。sessions spec 三入口各只启动一个绑定任务，恢复卡在成功控制认领后才解决；语义重复派发无新增调用。 |
| 原授权/版本/取消 | 复用 R7 公共原授权核验；重试仅替换 PAUSED/失败目标的状态规则。提交、恢复、实际派发/出队、执行认领时复核，最终 Runtime 选择处再次限制适配器。撤权、generation/epoch/意图/需求/执行版本变化、废弃 Brief、dispatchHold、停止未确认、取消/完成/stale 任务均阻止。 |
| 原 operation 预算 | 保留原 operation 和 executionBinding，不新建 operation 重置预算。真实 LogicalOperationStore 测试确认 operation 仍只有一个，旧 invocation 保留，attemptsUsed 在 reserve 时从原值加 1，deadline 不被重建。原次数/时间耗尽阻止，interrupted 等未可安全恢复的 operation 要求对账。 |
| 重复/并发/崩溃 | 原 step 的 retryReceipts 只能追加，checkpoint+失败 invocation 唯一；绑定、认领身份不可改，派发状态不能回退。控制端口会话串行并事务认领；派发异常/遗留外进程 running 不盲重派。另在同一回执上持久化执行 claim，防已接受调度后队列重复投递：同进程 running 返回 IN_PROGRESS，settled 不再次执行，外进程遗留 running 转 reconciliation_required。真实 File 测试覆盖重载、不可删改、终态回退、执行 claim 不可移除/伪造；并发投递任务调用数为 1。 |
| R6 优先 | 两入口先检查预算 hold/确认卡，返回 `INPUT_BUDGET_STRUCTURED_DECISION_REQUIRED`；hold、Session、task、operation 不变，执行调用为 0。因 INPUT_BUDGET_EXCEEDED 停下的失败调用仍要求 R6 结构化决定。预算“结束”后已取消任务不可由 retry 复活；不消费 hold、不替代一次放行。 |
| 旧链路回归 | 版本判断之前保持旧入口；旧会话“重试”仍进入原 retryFailedSession，既有 failed/interrupted/上下文恢复测试保留。R7 旧暂停继续、R6 五文件及原 Orchestrator/Runtime spec 纳入最终合并验证。 |

`retryReceipts.status=applied` 表示控制端口已经接受派发，**不表示任务成功**；真正执行另有 execution.running/settled/reconciliation_required。settled 表示本次窄执行已返回（也可能再次失败或等待预算），不能据此重放同一检查点。普通任务重试成功后进入 WAIT_USER_DECISION 并记录结果，不自动触发整条流水线的评审/交付；再次确证失败可产生新的检查点。

## 3. Runtime 逐项结论与代码依据

允许名单由历史失败 Runtime 和本次最终选中 Runtime 两处共同约束；原 Runtime 安全不代表可以切换到不安全的适配器。以下是本轮审查的代码事实，不以名称或声明的 capability 作为只读证明。

| Runtime | 本轮裁决 | 代码依据及限制 |
| --- | --- | --- |
| generic_llm | 可进入受限重试 | `generic-llm-runtime.service.ts:212` 冻结三个只读工具，`:1220` 拒绝名单外工具；`:1251`、`:1294`、`:1316` 分支只读文件、搜索、读附件。R6 工具集守卫测试包含在最终回归中。模型可返回提案，成功后的原有结果处理仍受原授权限制；本轮只证明失败前无候选/提交/写回时可以重跑。 |
| code_reader | 可进入受限重试 | `code-reader-runtime-adapter.service.ts:51` 的 execute 只获取 read_file，`:72` 调用其 execute；结果构造 `:145` 返回结构化阅读结果，无工作区写入调用。工具审计可写平台审计记录，不是工作区写回。 |
| mock | 可进入受限重试 | `mock-runtime.service.ts:54` 的 execute 构造合成 output/artifacts/events，`:338` 等 fileChanges 是返回提案，不直接写文件；该文件没有文件系统/工具执行导入。启用与否沿原配置；本轮未更改默认 mock 配置。 |
| codex | 阻止，RECONCILIATION_REQUIRED | `codex-runtime-adapter.service.ts:270` / `:647` 使用 CLI authority/sandbox；`cli-tool-authority.ts:5` 起允许有写权限时 workspace-write。历史 binding 没有足够证据证明实际 CLI 模式及所有直接写入均受 writeback 管理，本轮不为 read-only 字样增加例外。 |
| claude_code | 阻止，RECONCILIATION_REQUIRED | `claude-code-runtime-adapter.service.ts:320`、`:326`、`:872` 传递 CLI 权限/工具；`cli-tool-authority.ts:12` 起可允许 acceptEdits、Edit/MultiEdit/Write 及测试命令。不能仅凭无 writeback 记录证明没有直接修改工作区。 |
| test_runner | 阻止，RECONCILIATION_REQUIRED | `test-runner-runtime-adapter.service.ts:78` 获取 run_test，后者 `tools/builtin/test-runner.tool.ts:175` 实际运行 npm 命令；脚本可能产生写入，本轮不审查并放行任意测试脚本的直接效果。 |
| mcp_tool | 阻止，RECONCILIATION_REQUIRED | RuntimeType 有此值，但当前 `runtime.service.ts:309` configuredAdapters 仅注册六个具体适配器，没有可供审计的 MCP 执行实现；无只读证明即拒绝。 |
| human | 阻止，RECONCILIATION_REQUIRED | 同上，没有可证明直接操作效果的具体适配器实现；不推断人工执行无副作用。 |

生产 `RuntimeService.start()` 的负例对后五类逐项断言适配器启动次数为 0，防止最终选择或 fallback 绕过 guard。当前没有允许 CLI 特定只读模式重跑的实现。

## 4. 主要阻止码

| 情况 | 错误码 |
| --- | --- |
| 无服务端 retryBinding / 多条相同任务或调用证据 / 检查点或失败 attempt 已变 | `RETRY_CHECKPOINT_REQUIRED` / `INTENT_RETRY_CHECKPOINT_AMBIGUOUS` / `INTENT_RETRY_CHECKPOINT_STALE` |
| 当前状态不允许、任务已取消/完成/stale | `INTENT_RETRY_STATE_INVALID` / `INTENT_RETRY_TARGET_OBSOLETE` |
| 已有候选、提交或写回 | `INTENT_RETRY_STEP_UNSUPPORTED`，details 指向原写回处理入口 |
| 无只读证明、停止效果未知、派发/执行遗留不明 | `INTENT_RETRY_RECONCILIATION_REQUIRED` |
| 原 operation 次数/时间耗尽 | `INTENT_RETRY_OPERATION_BUDGET_EXHAUSTED` |
| 重复执行认领 | `INTENT_RETRY_IN_PROGRESS` / `INTENT_RETRY_ALREADY_EXECUTED` |
| 依赖仍未完成 / 非纯控制重试 / 无控制端口 | `INTENT_RETRY_DEPENDENCIES_INCOMPLETE` / `INTENT_RETRY_EFFECT_CONFLICT` / `INTENT_ACTION_EXECUTOR_UNAVAILABLE` |
| R6 未决预算 | `INPUT_BUDGET_STRUCTURED_DECISION_REQUIRED` |

R7 公共错误码继续表达身份、停止确认、原计划缺失/歧义、授权不明、版本失配、grant 撤销、目标废弃、范围和决策失效，不统一改写为可重试错误。提交阶段记录 blocked plan，入口/派发阶段抛冲突；认领后结果不明保留对账状态，不自动解除。

## 5. 改动范围

本轮 23 个源码/测试文件，以开工前 [before.json](evidence/before.json) 对照实际文件 SHA 确认；不是把完整工作区 Git diff 归为 R8。逐文件清单见 [verification.json](evidence/verification.json)。

- shared：retryBinding、失败 invocation、回执及 execution claim 合同。
- message-routing：R7 公共授权核验抽取；新增 retry guard/fixture/spec；控制端口认领、编译参数和提交接线及测试。
- sessions：失败检查点捕获、共用恢复入口和单任务选择及测试。
- orchestrator：失败调用证据、窄执行、原 operation/授权传递及测试。
- execution/queue/workflows：传递与再核验 binding、精确任务/nodeRun 选择及测试。
- persistence：不可变检查点、追加回执和执行 claim 的合法状态推进。

### 设计 §5 之外或未单列的配套文件

| 文件 | 为什么需要及边界 |
| --- | --- |
| `apps/server/src/modules/runtimes/runtime.service.ts` | 在最终选中的适配器启动前限制 Runtime，防止历史 generic_llm 安全而本次改选 CLI；仅新链路且携带 retryBinding 时触发，没有更改旧 Runtime 选择策略。 |
| `apps/server/src/modules/runtimes/runtime.service.spec.ts` | 验证最终五类不可证明安全的 Runtime 均零启动，补足只测 guard 纯函数不能证明生产接线的问题。 |
| `apps/server/src/modules/message-routing/intent-retry.fixture.ts` | 测试构造原授权及明确失败证据；生产不从恢复消息推导授权。拟改文件中的“对应 spec”未逐名列出该夹具，故单列。 |
| `apps/server/src/modules/orchestrator/intent-retry-task.spec.ts` | 把单任务、重复投递、崩溃和真实 operation 预算验证独立放入定向 spec；属于 Orchestrator 对应测试，未新增产品模块。 |

本目录报告/证据、R8 设计修订、`.cache/supervisor/r8-smoke.mjs`、`r8-capture-delivery.mjs` 和收件箱结果是交付配套材料。Web/desktop 没有本轮改动；监督文档和既有评测题目未修改。

## 6. 验证与保留的失败记录

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 首批先红后绿 | 修正夹具后，生产提交缺 checkpoint、窄执行误入 review 两项真实红例；实现后 68/68 通过 | [red-contract.log](evidence/red-contract.log)、[targeted-1.log](evidence/targeted-1.log) |
| 队列执行认领红→绿 | 先复现重复/崩溃投递未阻止；持久化 execution claim 后对应 43/43 通过 | [execution-claim-red-verified.log](evidence/execution-claim-red-verified.log)、[execution-claim-green.log](evidence/execution-claim-green.log) |
| 提交证据漏项红例 | 已捕获变更、提交 Artifact 两项先复现未被阻止；补查后纳入最终绿例 | [submission-proof-red.log](evidence/submission-proof-red.log) |
| 中间回归 | 初次合并 433/433；补充提交负例、File 执行 claim、operation 预算等后定向 77/77 和 operation 4/4 | [spec-combined-1.log](evidence/spec-combined-1.log)、[commit-guard-3.log](evidence/commit-guard-3.log)、[orchestrator-operation-3.log](evidence/orchestrator-operation-3.log) |
| 最终合并 spec | **535/535，exit=0；15 文件；0 失败、取消、跳过** | [spec-delivery.log](evidence/spec-delivery.log) |
| server typecheck | **exit=0** | [typecheck-delivery.log](evidence/typecheck-delivery.log) |
| server build | **exit=0** | [build-delivery.log](evidence/build-delivery.log) |
| 隔离实际重启 | **exit=0**；PID 114708→112716，health 正常，runtimeBuildStale=false | [smoke.json](evidence/smoke.json)、[运行日志](evidence/smoke-run.log)、[重启日志](evidence/dev-restart-final.log) |
| 源码/构建与保护文件核验 | 23 份 source、23 份 server tsc 输出、7 个受保护文件 SHA 不变；断言全部通过 | [capture.log](evidence/capture.log)、[verification.json](evidence/verification.json) |

最终 spec（`apps/server/src/modules/` 下，均为 `.spec.ts`）：

```text
message-routing/intent-plan-commit.service
message-routing/intent-resume-guard
message-routing/intent-retry-guard
message-routing/intent-message-pipeline.service
orchestrator/intent-retry-task
orchestrator/orchestrator.service
sessions/sessions.service
workflows/workflow-runtime.service
execution/execution.service
queue/execution.worker
runtimes/runtime.service
runtimes/generic-llm-input-budget
runtimes/input-budget-store
runtimes/input-budget-tool-rerun
runtimes/generic-llm-tool-loop-budget
```

命令使用 `node node_modules/tsx/dist/cli.mjs --tsconfig apps/server/tsconfig.json --test --test-concurrency=1 --test-force-exit <上述路径>`；类型检查与构建分别为 `npm run typecheck -w @agent-cluster/server`、`npm run build -w @agent-cluster/server`。R6 指定五文件均纳入；`generic-llm-tool-loop-budget.spec.ts` 本次无失败。日志里 ExecutionService 的“Codex output rejected”是既有结构化错误保留负例的预期日志，不是模型调用或测试失败。

中间失败完整保留：最初 red.log 的夹具缺生命周期字段；执行认领前两次红例夹具缺 Runtime 和等待未释放，修正后才得到 red-verified 的真实失败；session-r8-1 的历史 WorkItem 状态错误、boundaries-1 的 makeInvocationPlan 参数错误、commit-guard-2 的重新生成随机授权夹具、orchestrator-2 的缺 persistence，均为测试夹具问题并已修正。typecheck-1 唯一错误为可选 checkpoint 的空值访问，修正后 typecheck-2 和最终检查通过。没有删除或覆盖这些日志。

冒烟在随机独立端口 54294、独立临时 File 目录运行，仅子进程设置 mock/禁用自动 Local Runtime/不可达测试连接；`.env` 未修改。通过 Node 执行 npm CLI 的原 `run dev:restart-server`，不是替代重启脚本。预算空请求返回 400 / INPUT_BUDGET_DECISION_INVALID；Session、invocation、真实模型调用均为 0；子进程树已关闭，数据留存供核查。此项仅证明启动/重启与健康接口，不冒充真实业务端到端重试。

## 7. 冻结哈希与已知缺口

聚合方式：按源码路径排序，把对应 `{path,sha256}` 数组 `JSON.stringify` 后计算 SHA-256；dist 使用同一源码顺序，路径为 server tsc 实际生成的 `apps/server/dist/<source path>.js`，包含 server 编译产生的 shared 文件。逐文件值和开工前值均在 manifest 中。

| 项目 | SHA-256 |
| --- | --- |
| 23 文件源码聚合 | `c0bbe2685bef3882a724da954f321cd976fbac9b23d5e0585210690b4884417c` |
| 23 文件 dist 聚合 | `f60eb01bad5d12ea72f049bccce39713c1742652e3437e9b78d4baea9f2ef70e` |
| verification.json | `6e2822ff3a6acf7cb944589fe5ea7b0f16c31689e25e2797d2b1fb14cceafc12` |

编译器、execution-scope-resolver、semantic-intent-router、runtime-config、default-capabilities、default-agent-presets 和 `.env` 与本轮开工前 SHA 相同。工作区已有大量其他未提交修改；构建反映当前整个工作区，不表示那些改动属于 M-005。

仍存在的适用限制：

1. 历史会话常缺原授权/失败调用证据；仅 Brief、缺失/歧义/过期 binding、没有可安全恢复的 operation 都会阻止，不补造、不重置预算。非 task_execution 失败、合法完成输出但业务判失败而无失败调用证明等情况可能只得到普通恢复卡，本轮不扩大恢复范围。
2. 已有候选、提交或任意写回不自动接续。没有 writebackId 时无法直接使用 resolve；该路径说明现有处理入口，不代表每种失败都有通用处理 UI。CLI 全部保守阻止，尚未实现特定模式的直接副作用证明。
3. 对派发/执行结果不明，重入时拒绝或转 reconciliation_required；没有新增启动时自动对账、外部效果核实或解除回执入口。已接受调度与执行完成分开记录；本地并发/崩溃、File 重载验证不等同于真实 Redis/Postgres 多进程故障验收。
4. 未连接真实 Redis/Postgres，未跑真实模型、全仓全量测试或业务端到端。Web/desktop 没有本轮改动，因此未重跑双端检查。普通任务重试完成只通知等待下一决定，不补评审/交付执行器，也不自动重跑剩余任务。
5. 本轮没有修改提示词、评测题目、默认链路或此前模型评测结果；未重新生成识别准确率对比报告。

交付后停止，等待监督方复核；未提交、未推送。

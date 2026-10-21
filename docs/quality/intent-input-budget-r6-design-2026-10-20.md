# R6 输入预算超限处理方案（按设计复核修订）

依据：[第六轮监督要求及设计复核](intent-codex-supervisor-review-2026-10-20.md)、项目地图及 Harness 规程。用户已授权按 R6-M1/M2 实施“继续一次／结束本任务”；编译器、范围解析器、提交层、默认开关、`.env`、R5 L0 均冻结。

**1．检查点。** `generic-llm-runtime` 的 `requestCompletion()` 及工具循环在**每个 fetch 前**检查实际 messages，覆盖重试、模式回退、schema repair。统一 `E=estimateTokens({messages})`，R 为现有输出保留，C 为 `reserveInputTokenSafetyMargin` 后的上限；`E+R>C` 停下并记录 E/R/C，不当作 provider 故障重试／切模型。调用前守卫保留；范围内 generic_llm 共享请求构造器预备相同 messages，避免双重估算／消费。

**2．调用方清单。** 已检索生产 `RuntimeInvocationService.invoke`、`RuntimeService.start/run` 和全部 `orchestrator.runRuntime` 调用。入口设置服务端内部 `inputBudgetPolicy` 并校验归属，不以空工具目录或 phase 单独判范围；未标记者保持原行为。

| 调用入口（server modules） | 本轮处理 |
| --- | --- |
| `semantic-intent-router.understand` | 停下询问 |
| `orchestrator.runOneTask`／`retryPendingApprovalInvocation` 的真实 AgentTask、task_execution | 停下询问；适配器调用前守卫纳入，请求级检查限 generic_llm |
| `semantic-intent-router.classify`（intent_routing_decision，4000） | 保持现状 |
| `orchestrator.recognizeFollowUpMessage`（旧 follow-up） | 保持现状 |
| 编排器其余：brief_generation（建 brief／follow-up／修订汇总）、brief_revision、brief_consultation、discussion（计划／专家）、revision_synthesis、task_acceptance、post_review、final_delivery | 各项保持现状，即使有 taskId |
| `intent-answer-executor`／`intent-brief-executor` | 回答、brief 生成／评审保持现状 |
| `runtime.controller` generic_llm smoke | 保持现状，即使 phase=task_execution |
| `intent-test-executor` | 固定 test_runner，非 generic_llm，保持现状 |

**3．Agent 与只读重跑（R6-M1）。** 三处守卫统一返回待决定结果；任务 `waiting`，宿主 `WAIT_USER_DECISION`，以 `input_budget_exceeded`＋`createOnce` 建卡，不走 failed／自动恢复，不取消其它在途任务。继续重跑同一 task/phase/逻辑调用槽位，不持久化 messages、工具历史或发送断点。工具循环可调用集合严格为 `read_file/search_code/read_attachment`，全部只读；守卫测试锁定此集合。Codex/Claude 的调用前检查先于适配器启动，尚无副作用。等待释放租约／计时器，恢复重验其它预算与授权。

**4．路由与结束。** `understand` 超限为 `BLOCKED / INTENT_INPUT_BUDGET_EXCEEDED / failureClass=budget`，释放租约；不用次数／截止时间的 `INTENT_BUDGET_EXHAUSTED`，不改 Session 状态。继续走现有 recognition retry 的预算分支：CAS 绑定原 source/snapshot，保留快照并重跑同一识别槽位；快照／代次失效则撤销放行、重新准备，必要时再问。结束仅将该消息路由 `REJECTED`。Agent 结束仅取消绑定任务、更新依赖调度并解除此等待；会话保留、恢复有效状态，均不置会话 `CANCELLED`，不调用 `cancelSession`／全会话 control。

**5．一次性放行（R6-M2）。** 持久化 hold／回执，绑定 actor、session/dataEpoch/generation、调用槽位（task＋phase＋逻辑调用，或 routing＋revision）及停下时 E/R/C，不绑定 requestHash。首次实际发送前 CAS 消费一次；整次重跑任意一轮 `E+R ≤ 停下时 E+R` 可发送，超过重新询问。双击／并发／重启不得把已消费放行复用于另一次重跑；网络失败也不复用。不改配置、不豁免 maxTotalTokens、WorkItem 累计预算、工具次数或授权；结束幂等。

**6．两端与验收。** web/desktop 的 `SessionWorkspace.vue` 扩展现有卡；路由扩展 `IntentRecognitionRetryPanel`、store/API，展示估算／上限与“继续执行（本次放行）／结束此任务（消息）”，刷新恢复、点击幂等，不建页面。先写失败用例：provider=0、等待、一次性／再次询问、估算增大、schema repair、只读工具集恰为三个、重跑工具次数可不同但 workspace writeback 记录为 0、重启／并发、结束不取消会话、范围外回归；再做 server specs/typecheck/build、两端 vitest/vue-tsc、后端重启冒烟。验收后停等监督复核，不提交、不推送。

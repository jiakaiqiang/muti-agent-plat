# R6 输入预算确认实施与验收报告

执行依据为监督文档末尾「第六轮设计复核」及用户的 R6-M1/M2 实施授权。结果：指定的相关检查通过，代码保留在工作区，等待监督方复核；未提交、未推送。原 R5 评测报告和成绩未改，本报告不产生新的意图识别准确率结论。

## 实施结果

- 仅给新链路 `understand()` 与真实 Agent `task_execution` 标记服务端输入预算策略。无工具请求、工具循环、结构化模式回退、schema repair、provider attempt 均在实际发送前检查 messages；Codex/Claude 在适配器启动前检查。超限返回非重试的阻塞结果，不作为 provider 故障重试或切换模型。
- AgentTask 进入 `waiting`，Session 进入 `WAIT_USER_DECISION`，两端使用现有确认卡。`understand()` 使用独立的 `INTENT_INPUT_BUDGET_EXCEEDED`，路由进入 `BLOCKED` 并释放租约，不更改 Session 状态。
- 放行记录复用 `LogicalOperation.inputBudgetDecisions`，保存身份、槽位、E/R/C 和决定回执，不新增 messages、工具历史、发送断点或 requestHash 持久化。放行绑定 actor、session/dataEpoch/generation、task/phase/operation 或 routing/revision。实际首发前 CAS 消费，整次重跑内各轮满足 `E+R ≤ 停下时 E+R` 即可发送；超过重新建卡询问。新 invocation、并发调用及进程重启不能复用已消费放行。
- 继续重跑同一调用槽位。工具循环白名单锁定 `read_file/search_code/read_attachment`，重复读取允许发生；写回由原来的独立流程管理。已发送轮次的 usage 继续结算，不以重跑清零累计预算。
- 结束只取消绑定 AgentTask，或将原消息路由置为 `REJECTED`，不调用全会话取消。现有 workflow 宿主取消此任务后停在 `PAUSED`，保留原节点供后续处理；没有增加流程推进能力。追问执行在预算等待时保留，恢复执行后才结算。旧“继续”回执在出现新询问后不再触发调度。

Agent 确认接口为 `POST /api/sessions/:sessionId/input-budget/decision`，请求 `{operationId, decisionId, decision: "continue" | "end"}`。路由复用 `retry-recognition` 接口，增加 `inputBudget: {decisionId, decision}`；继续保留原 snapshot、逻辑操作、attemptLog、已使用次数和截止时间，结束只拒绝原消息。授权不放宽 maxTotalTokens、WorkItem 累计预算、工具次数、权限或逻辑操作时限。

## M-001：设计第 6 条未逐文件列出的修改说明

设计第 6 条列出了确认卡、重试面板、store/API 等入口，没有逐项列出下面四个文件。这里补充实际修改、依赖原因和边界，供监督方复核；本次说明没有追加产品改动。

| 文件 | R6 修改及必要性 | 修改边界与验证 |
| --- | --- | --- |
| `apps/server/src/modules/sessions/sessions.controller.ts` | 增加输入预算决定的 POST 入口，将“继续／结束”转给 `SessionsService.decideInputBudget` 并返回 202。Agent 确认卡需要服务端接收决定；路由已有的 retry-recognition 入口绑定消息路由，不能用于 AgentTask。 | 只增加此接口，不调用取消整个 Session 的控制入口；重启冒烟验证该路由已注册，无效输入返回 400，任务决定语义由 store/Session 相关 spec 验证。 |
| `apps/server/src/modules/workflows/workflow-runtime.service.ts` | 原本仅将 `approval_required` 转交 Session 的等待分支，增加接受 `input_budget_exceeded`。真实 AgentTask 可能由现有 workflow 节点承载；缺少这一行兼容时，预算等待会落入失败处理，确认卡无法正确保持可恢复的宿主状态。 | 产品文件仅改这一行条件，复用已有 session_outcome 转交，不增加节点、边、推进策略或执行器；`existing Agent node forwards input-budget waiting without failing the run` 用例覆盖。 |
| `apps/web/src/stores/session.ts` | 增加 `decideInputBudget(sessionId, input)`，调用上述接口。Web 与 desktop 的 `SessionWorkspace.vue` 都通过共享 store 提交 Agent 预算决定。 | 只增加 API action，决定仍由后端验证和持久化；不把已有的全会话继续／取消接口用于该决定。两端类型检查通过，接口已做后端冒烟；未声称完成真实浏览器点击到后端的端到端验证。 |
| `apps/web/src/stores/event.ts` | 将确认事件的 `inputBudgetDecision` 投影到 `ConfirmationCardState`。两端工作区需要 hold 的 operationId/decisionId 才能提交绑定的决定，刷新或重放事件后也需要保留这些信息。 | 只补该字段投影，沿用原确认卡及 resolved 事件机制；已跑 event-normalization 回归和两端卡片测试，但没有该字段跨刷新投影的专用断言，不把这些测试等同于刷新端到端验证。 |

以上是本轮预算确认在现有入口上的接线依赖；编译器、范围解析器、提交层及默认开关继续冻结。核查记录见 [m001-review.json](evidence/m001-review.json)。

## 逐项验收

以下 spec 位于 `apps/server/src/modules/`；前端 spec 位于 Web/desktop 对应组件和 store。精确命令与全文件哈希见 [verification.json](verification.json)。

| 设计第 6 条及监督新增项 | 结果与证据 |
| --- | --- |
| 无工具超限 provider 请求数为 0 | `runtimes/generic-llm-input-budget.spec.ts`：显式范围内阻塞，fetch=0 |
| 超限停在等待用户，不变成 provider failed | 同上检查 blocked、非 retry、无 runtime_failed；Session 相关 spec 检查 WAIT_USER_DECISION；审批重试入口使用同一确认卡 |
| 继续覆盖整次重跑，下次超限再次询问 | `runtimes/input-budget-store.spec.ts`、`input-budget-tool-rerun.spec.ts`：多轮复用一次授权，新调用取得不同 hold |
| 继续后估算变大重新询问 | store spec：已消费重跑的较大轮次、未消费放行的较大前置估算均新建 hold；旧回执不重启调度 |
| schema repair 第二次发送受检查 | generic input-budget spec：第一次 fetch=1，修复请求超限后不再发送、不 provider 重试 |
| R6-M1：工具集合恰为三个只读工具 | generic input-budget spec：精确集合断言；实际执行白名单引用同一集合 |
| R6-M1：重跑工具次数可变化，写回为 0 | tool-rerun spec：首次读取 2 次、重跑读取 1 次，真实 File Persistence 的 workspaceWritebacks 为 []；首轮已发 usage 保留 |
| R6-M2：不受 envelope 时间变化影响 | store spec：更新 createdAt、重跑多轮仍在估算上界内放行，不绑定请求内容哈希 |
| 放行持久化、并发、重启与过期身份 | store spec：File Persistence 重载、重复决定仅一次受理、并发 invocation 拒绝、另一进程不能复用已消费授权、epoch/generation 失效或会话停止后关闭准入均拒绝 |
| 结束不取消 Session、重复结束幂等 | store spec：只取消绑定任务，不置 Session CANCELLED，不重复调度；pipeline spec：结束仅拒绝原消息，Session 状态保留 |
| 路由继续保留快照及其它预算 | `message-routing/intent-message-pipeline.service.spec.ts`：snapshot/operation/attemptLog/已用次数保留，继续可路由，结束不再识别 |
| 范围外旧分类器与其它调用保持原行为 | generic input-budget spec：未标记无工具请求仍按原逻辑发送；与 R5 冻结文件比较，classify 整段及 L0 均未改变 |
| Web 与 desktop 展示、选择与刷新投影 | 两端 ConfirmationCard spec、共享 IntentRecognitionRetryPanel spec、event-normalization/session-intent-routing/SessionWorkspace spec；两端 vue-tsc 通过 |
| 追问等待与恢复保持对应关系 | sessions spec：等待不清除 executing follow-up，预算恢复完成后结算原 follow-up |
| 失效准入不伪装成预算确认 | orchestrator spec：scope stale 为 CAPABILITY_BLOCKED，不生成没有 hold 的预算等待，不启动适配器 |

## 验证记录

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| Server 15 个相关 spec 文件 | **496/496 通过，0 失败、0 跳过** | [server-spec.log](evidence/server-spec.log) |
| Server typecheck / build | 均退出 0 | [typecheck](evidence/server-typecheck.log)、[build](evidence/server-build.log) |
| Shared build | 退出 0 | [shared-final.log](evidence/shared-final.log) |
| Web 与 desktop 相关 Vitest，共 6 个文件 | **54/54 通过** | [client-vitest.log](evidence/client-vitest.log) |
| Web vue-tsc / desktop renderer vue-tsc | 均退出 0 | [Web](evidence/web-typecheck.log)、[desktop](evidence/desktop-typecheck.log)；desktop 成功时无文本输出 |
| `npm run dev:restart-server` | 独立环境重启成功，进程 114116 → 108940，health=ok，runtimeBuildStale=false；无效确认请求返回 400 / INPUT_BUDGET_DECISION_INVALID | [重启日志](evidence/dev-restart-final.log)、[smoke.json](evidence/smoke.json) |

重启首次因现有开发启动器未运行而退出；另建临时数据目录、42161 端口，仅使用子进程环境隔离持久化后，空库首次启动被 v3 启动门禁拒绝。随后使用仓库既有 `createSmokeV2State()` 初始化临时空库，启动并实际重启健康后端。未改 `.env`，没有创建 Session；临时启动器和后端已停止。保留[首次记录](evidence/dev-restart.log)与[空库初始化后启动记录](evidence/dev-restart-isolated.log)。

**既有失败单独说明：** 监督要求提到 `generic-llm-tool-loop-budget.spec.ts` 曾有失败；本轮修改前实跑 **4/4 通过**，最终相关 spec 中仍 **4/4 通过**，当前工作区未复现该历史失败，不能将其记作本轮修复。见[修改前日志](evidence/budget-baseline.log)及最终 server 日志。

先失败后实现的代表证据：[无工具旧行为发出请求、工具集守卫缺失](evidence/red.log)、[预算面板缺失](evidence/ui-red.log)、[重启复用未被拒绝](evidence/restart-red.log)、[预算等待被标成 runtime_failed](evidence/wait-event-red.log)。末次状态流复查先补用例，复现追问提前结算、旧回执重复调度和审批重试缺卡的[3 个失败](evidence/final-red.log)，以及[失效 scope 被误标预算超限](evidence/admission-red.log)，之后修正并纳入最终 496 项验证。中间出现的测试类型错误已修正，最终 typecheck 通过。

最后检查补充了[会话已停止后点击旧预算卡的失败用例](evidence/closed-admission-red.log)，在持久化准入验证中拒绝 `admission=closed`，避免旧回执恢复已停止会话；最终 496 项 spec、typecheck/build 和重启冒烟均在此修正后重新执行。

## 冻结边界与哈希

编译器、execution-scope-resolver、提交层、`.env` 与本轮开始时 SHA-256 完全一致，记录在 verification.json 的 protectedFiles。新链路默认仍要求 `INTENT_UNDERSTANDING_ENABLED === 'true'` 才启用；未更改默认开关。

semantic router 只新增调用范围和超限错误传递：去掉获准新增的 7 行后，**整个文件与 R5 冻结源码逐字节一致**，不仅是提示词相同。其原 SHA-256 为 `9025a2428fa8d486f735683454f7c466a8ae22eddd5bc18e2e36685fb43e2828`，因此旧 classify 与所有 L0 规则均保持冻结。

| 文件 | 源码 SHA-256 | 构建 JS SHA-256 |
| --- | --- | --- |
| input-budget-store | `1f3f78261b98c1cdef112e15feaf0f04191a9d6f8b8e7cf872fc48ef6a38d504` | `db68ff07444c2dfddf2954ce3c08127c03ef5dfc73b4d58aab9bf52fbbcca045` |
| generic-llm-runtime.service | `3a73857ce3bb45fc03ff8c5600d4983533e912711596579459365cac7ed5a807` | `4b97da992ce08650d8aa1da93e840e66590ecabda122a13a4dec20586c472814` |

其余涉及源码和构建文件的完整路径、SHA-256 也在 verification.json；文件哈希包含工作区此前已有内容，不代表整份 git diff 都由 R6 引入。

## 验证边界

本轮使用模拟 provider 验证预算协议，并使用真实 File Persistence 验证持久化和重载。启动时现有 generic_llm 连接探测返回 HTTP 401；没有进行真实模型生成评测，不能据此宣称远端模型连接已经修复。输入估算仍使用现有估算器和安全边距，不是模型服务商的精确 tokenizer 计费值。

**M-001：HTTP 401 归因。** 现有证据支持将其归为本地已配置模型连接的既有认证问题，未发现由 R6 预算改动引入的证据。R6 开始前的 [2026-10-19 评测报告](../intent-evaluation-2026-10-19/README.md) 第 106 行已记录原连接的 `/models` 预检返回 401；当前 `GenericLlmRuntimeService.checkAvailability()` 仍直接以配置的 Bearer 凭据执行 `GET /models`，该方法与 Git HEAD 逐字一致，不经过新增的调用预算守卫；`.env` 也与 R6 开始时哈希一致。上述核查已记入 m001-review.json。401 只能定位到该连接的认证被拒绝，尚未独立核实是密钥失效、网关认证策略还是上游账户状态；本次未重新请求模型服务或修改凭据。

两端完成组件/store Vitest 与类型检查，没有声称完成真实浏览器/安装版端到端交互或 PostgreSQL 多进程压力测试；未运行整个仓库的全量测试。工具重跑会增加读取和 token 消耗，仍受原累计预算约束。重启后的已消费放行需要重新询问，不支持工具断点恢复。R5 的执行器缺口、默认旧分类器行为以及范围外 generic_llm 调用均未在本轮补齐；没有扩展工作流。

M-001 本次仅补充报告和核查证据，未改产品代码，未重跑测试／构建或真实模型评测；上表测试成绩沿用 R6 已完成的验证，核对源码、构建及受保护文件哈希均未变化。完成后停止，等待监督方复核。

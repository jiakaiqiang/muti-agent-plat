# 阶段 6：跨阶段 AC/Task/证据追踪矩阵 v1

> 生成日期：2026-09-20T05:59:08.689Z  
> 来源：阶段 0～6 的 Spec、Tasks、Checklist；本文件只反映文档中已有的证据状态，不把文档存在视为业务通过。

## 汇总

- 阶段：9
- AC：61
- passed：57；partial：3；pending：0；not-executed：0；deferred：1；failed/missing：0

## 矩阵

| 阶段 | AC | 关联 Task | 当前状态 | Checklist 证据摘要 |
| --- | --- | --- | --- | --- |
| 0 | P0-AC1 | P0-T1、P0-T2、P0-T5 | passed | 通过：身份/作用域/分隔符碰撞单测；见 E1、冻结合同 §2 |
| 0 | P0-AC2 | P0-T2、P0-T3 | passed | 通过：角色矩阵、系统 coordinator 唯一及越权归属拒绝单测；E1/E2、合同 §3 |
| 0 | P0-AC3 | P0-T3、P0-T6 | passed | 通过：合同 §4/10 五个交互案例审查、精确确认单测；E1。不是端到端业务验证 |
| 0 | P0-AC4 | P0-T4、P0-T5 | passed | 通过：只增量导出新类型/纯函数，保留既有 SessionStatus/InvocationPlan；E2/E5 与合同 §1/8 |
| 0 | P0-AC5 | P0-T1、P0-T5、P0-T6 | passed | 通过：新建现状/句柄/迁移基线；本轮 E3 重新验证，不复制旧专项结果 |
| 0 | P0-AC6 | P0-T4、P0-T6 | passed | 合同级通过：E1 模拟不支持版本/特性的读端、活动执行与未停稳拒绝；合同 §5～9 明确旧 writer 部署门禁。未部署旧二进制演练 |
| 1 | P1-AC1 | P1-T1、P1-T3、P1-T6 | passed | 通过：Sessions 单测和 `test:e2e:session-delete` 验证 sibling 不受影响。 |
| 1 | P1-AC2 | P1-T2、P1-T3、P1-T6 | passed | 通过：PostgreSQL 集成 9/9，覆盖 delete/reserve 与 stop/reserve 竞争。 |
| 1 | P1-AC3 | P1-T3、P1-T5、P1-T6 | passed | 通过：LogicalOperation/停止屏障定向测试、cancel/recovery E2E 与 PostgreSQL 重建测试。 |
| 1 | P1-AC4 | P1-T2、P1-T4、P1-T5、P1-T6 | passed | 通过：delete 幂等、超时释放 UI 状态、墓碑投影和不调用 purge 均有断言。 |
| 1 | P1-AC5 | P1-T2、P1-T4、P1-T6 | passed | 通过：普通执行、队列、意图路由、Runtime 后处理、Memory、Workspace Writeback、LogicalOperation 和 WorkflowRun 使用 generation 门禁，旧结果测试通过。 |
| 1 | P1-AC6 | P1-T4、P1-T5、P1-T6 | passed | 通过：恢复保持历史、返回 PAUSED、不自动运行；file E2E 验证显式继续和 sibling 隔离。 |
| 2a | P2A-AC1 | P2A-T1、P2A-T6 | passed | **已验收**：`npm run test:e2e:phase-2a-routing` 以真实 HTTP 模拟 Web/桌面并发同一幂等键，断言只有一条业务消息、同一 follow-up/routing ID 且恰有一方为重放；既有 deterministic guard 单测确认普通自然语言不误触发停止、精确 continue 不调用模型。 |
| 2a | P2A-AC2 | P2A-T1、P2A-T2、P2A-T6 | passed | **已验收**：同一真实 HTTP 路由 E2E 用“继续修复登录，同时新增导出”验证多意图只进入 `CLARIFICATION_REQUIRED`，不会猜测执行；semantic-intent-router golden dataset 与 fail-closed 校验覆盖 @、旧 WorkItem、无绑定确认和 Runtime 失败澄清。 |
| 2a | P2A-AC3 | P2A-T1、P2A-T2、P2A-T3、P2A-T6 | passed | **已验收**：`context-management.service.spec.ts` 注入 1,000 条历史消息和 101 个候选需求，断言快照使用声明上限、旧消息不进入分类输入且序列化载荷小于 40 KB；同组用例断言服务端解析的 @ 与 replyTo 被保留、跨会话 reply 被拒绝。 |
| 2a | P2A-AC4 | P2A-T2、P2A-T3、P2A-T6 | passed | **已验收**：Context v2 的 WorkItem 切片排除同会话其他需求；`l0-trust-boundary.spec.ts` 断言摘要、文件与聊天内容一旦进入 L0 即以 `L0_TRUST_BOUNDARY_VIOLATION` 失败；预算恢复 E2E 断言拆分后的关联 WorkItem 不继承旧决策或产物。 |
| 2a | P2A-AC5 | P2A-T4、P2A-T6 | deferred | **文本适配器已验收；多模态延期**：请求按 system / 工具 / ContextEnvelope / schema / 工具历史归因并逐轮复算；`token-budget` E2E 验证正常用量记录与极小预算发送前拒绝，T6 长输入矩阵覆盖长中文和长 schema。当前 `generic_llm` 只发送字符串消息，图片/多模态 Provider 接入列入后续专项，不作为阶段 6 发布门禁阻断项。 |
| 2a | P2A-AC6 | P2A-T5、P2A-T6 | passed | **已验收**：一次性 PostgreSQL 与跨进程脚本断言并发只允许一个预留、重放结算幂等且重启读回；`work-item-budget-recovery` E2E 验证额度耗尽进入 `WAIT_USER_DECISION`、仅可拆分或取消、旧 WorkItem 不会被重试。取消后迟到结果由 `runtime.service.spec.ts` 断言只结算一次，不能复活成功状态。 |
| 2a | P2A-AC7 | P2A-T3、P2A-T4、P2A-T6 | passed | **已验收**：超限在发送前返回可理解的容量阻塞，补读去重沿用既有 `supplemental-context-dedupe`；`generic-llm-tool-loop-budget.spec.ts` 断言旧工具结果转为 `TOOL_RESULT_REFERENCE`，最新工具调用/结果对仍完整保留。 |
| 2b | P2B-AC1 | P2B-T1、P2B-T3、P2B-T6 | passed | 通过：store 原文保留、DecisionRecord 权威派生及 memory-confirm E2E。 |
| 2b | P2B-AC2 | P2B-T1、P2B-T2、P2B-T6 | passed | 通过：file 并发/重建单测；PostgreSQL 跨实例唯一提交 11/11 集成集。 |
| 2b | P2B-AC3 | P2B-T1、P2B-T2、P2B-T3、P2B-T6 | passed | 通过：stale version 拒绝；旧 CSV 事实剔除、当前 Excel 约束/验收保留；superseded 来源可回查但不注入。 |
| 2b | P2B-AC4 | P2B-T4、P2B-T6 | passed | 通过：100 WorkItem/1,000 消息 fixture，候选最多 5，Intent Snapshot < 40 KB，相似项要求澄清。 |
| 2b | P2B-AC5 | P2B-T4、P2B-T5、P2B-T6 | passed | 通过：跨 Session 隔离、显式引用优先和 `index_unavailable` 固定语料测试。 |
| 2b | P2B-AC6 | P2B-T2、P2B-T3、P2B-T6 | passed | 通过：阶段/需求/24 事件阈值、当前验收保留、generation/admission 拒绝；取消/恢复 E2E。生成失败不自动重放模型调用，持久化提交重试最多 3 次。 |
| 2b | P2B-AC7 | P2B-T5、P2B-T6 | passed | 通过（有边界）：PostgreSQL 数据库分页、file 有界页/32 页 LRU、CLI WorkItem/generation 隔离和轮换去重；file 启动仍加载完整投影，见 §6。 |
| 2c | P2C-AC1 | P2C-T1、P2C-T2、P2C-T4、P2C-T6 | passed | **系统级通过（2026-09-19，mock runtime）**。`npm run test:e2e:context-bundle-cache`（`tests/e2e/context-bundle-cache-smoke.mjs`）起真服务：(A) 正常会话跑到 COMPLETED，`/ops/workspace-metrics` 上 `context_bundle_cache_total{outcome=hit}` = 2；(B) **同一个** 预算 10 的会话，第一次尝试 miss + `TOKEN_BUDGET_EXCEEDED`，发 `继续` 重试后 **hit +1 且第二次仍 `TOKEN_BUDGET_EXCEEDED`**。路径级：`context-bundle-cache.spec` 命中后 `budget` 与新建 deepEqual。结算侧按 `logicalInputTokens` 计入需求预算。**未做**：真实付费模型下的同一场景。 |
| 2c | P2C-AC2 | P2C-T1、P2C-T3、P2C-T6 | passed | **原语级通过（2026-09-18）**。`derived-cache.spec` 8/8：B 持 A 的 key 读不到、`invalidateSession` 只清本会话、恢复后旧 generation 未命中、丢失作用域的回填 `set` 返回 false 且 `rejectedBackfills+1`。`cache-contracts.spec` 私有 key 含 session/workItem/agent/generation，公共 key 不含 session 字样。系统级（真实删除/恢复流程）未验。 |
| 2c | P2C-AC3 | P2C-T2、P2C-T3、P2C-T6 | passed | **原语级通过（2026-09-18）**。`cache-contracts.spec`：六项依赖任一变化指纹即变；心跳字段按名读取结构上进不了指纹；文件 hash 顺序无关。`derived-cache.invalidateFingerprint` 按指纹后缀清理。未接入真实文件变更事件。 |
| 2c | P2C-AC4 | P2C-T3、P2C-T6 | passed | **原语级通过（2026-09-18）**。`cache-single-flight.spec` 8/8：100 并发同 key → 1 次构建、恰一个 `owner:true`；构建失败不做负缓存；连续失败达阈值 → `circuit_open` 不再打原点，熔断按 key 独立。"回源仍受总预算"依赖 2A 预算门禁，本阶段未新增绕过路径。跨进程 single-flight **未做**。 |
| 2c | P2C-AC5 | P2C-T1、P2C-T4、P2C-T6 | passed | **三条 runtime 路径通过（2026-09-18）**。能力声明：`runtime-cache-capability.spec` 8/8 + `generic-llm-token-estimation.spec` 新增用例，未声明 model → `unknown`、第三方 host → `unsupported`，两者 `blocksExecution:false` 正常执行，每次 generic-llm run 写 `tokenEstimation.cacheCapability`。无回执 → `unknown`：generic-llm `toUsage`、claude_code / codex 的 `usage-from-frames.spec` 6/6 均断言无 usage 帧时 `measurement:'unknown'` 且不伪造 cacheRead 计数。决定不单独记录 CLI 内建缓存能力（平台不控制 CLI 提示词，声明恒为 unknown，见 tasks T4）。 |
| 2c | P2C-AC6 | P2C-T1、P2C-T5、P2C-T6 | passed | **generic-llm 路径通过（2026-09-18）**。`cache-contracts.spec`：anthropic（input 不含 cache，logical = input + read）/ openai（input 含 cache，不重复加）/ ollama（unknown）；raw 缺失 → 各字段 `undefined` 非 0；金额无 `priceVersion` 整个 cost 不出具；`summarizeUsageBreakdown` 按 attemptId 去重。`toUsage`/`mergeUsage`/`settleRequirementBudget` 已接线。价格版本实际来源归阶段 6「形成质量与成本报告」任务（在此之前金额一律不出具）；摘要额外成本单列未做。 |
| 2c | P2C-AC7 | P2C-T1、P2C-T2、P2C-T6 | passed | **原语级通过 + 可观测（2026-09-18/19）**。`derived-cache.spec`：`maxEntries` 满时 LRU 逐出、过期读判失效并释放容量（`size` 归零）、`stats()` 只有计数不含正文。命中率已暴露：`context_bundle_cache_total{layer,outcome}`，outcome 互斥（hit/miss/expired/evicted/rejected_backfill），标签不含 session（用例断言 + E2E 断言）。"历史与决策仍在"由设计保证（缓存是派生态，不触碰原始记录）。"安全动作不命中旧回答"当前不适用：没有调用方把动作结果放进缓存。 |
| 3 | P3-AC1 | P3-T1、P3-T2、P3-T5、P3-T6 | passed | **通过（单测 + E2E，mock runtime）**。主 Agent 出 `discussion_plan` 只点名需要的专家（`planned-discussion.spec` 用例 1：参与者 test 未被点名即不咨询）；每轮以 `synthesizeDiscussion` 收口，综合事件 `sourceDelegationIds` 可核验（用例 8；E2E 场景 A 恰 1 条）。"简单补充可主 Agent 处理"由 planner 支持零咨询 + `readyToSummarize`/`questionsForUser`（`discussion-planner.spec` 用例 7），未做端到端。 |
| 3 | P3-AC2 | P3-T4、P3-T5、P3-T6 | passed | **通过（单测）**。用户 @ → 每个被 @ 成员一条 `origin:'user_mention'` 委派，objective=用户原话，回复事件带 `delegationId` 并进入本轮综合（用例 6：run 复用、`roundsStarted`+1、无固定"已汇总"文案）。**未做**：@ 的 E2E 与双端展示。 |
| 3 | P3-AC3 | P3-T2、P3-T6 | passed | **通过（单测 + E2E）**。目录内非成员 → `confirm_member_addition` 卡，未批准零委派（用例 1；E2E 场景 B）；名字不存在 → `unknownTargets` 报出不编造（`discussion-planner.spec` 用例 3）；模型无法通过多余字段自行加人（`discussion-plan-output.spec` 用例 5）。**未做**：禁用 Agent 的专门用例（`participatingAgents` 过滤 `status==='active'`，禁用者只会落到扩员/未知两条路径之一，未单独断言）；扩员卡 approve/decline 的落实。 |
| 3 | P3-AC4 | P3-T1、P3-T3、P3-T6 | passed | **通过（file + PostgreSQL）**。同键（discussion\|expert\|revision）并发 12 个恰一个 reserved（store 用例 2）；跨实例只留一条委派（PG 集成 12/12）；完成重放 `idempotent`、终态不可回退（store 用例 6）；重启只跑未完成、不重问计划、不开第二个 run（用例 4）。账单：委派经 `runRuntime` 走 2A `budgetCategoryFor('discussion')='consultation'` 预留结算，按实际尝试记。**延后**：跨实例并发写同一 run 的 CAS（T1-3 已记）。 |
| 3 | P3-AC5 | P3-T2、P3-T5、P3-T6 | passed | **通过（单测）**。同 objective 不同结论 → `conflicts` 列出两条待选、outcome `needs_user`、正文不含"一致同意"（`discussion-synthesis.spec` 用例 2）；专家失败点名列出且 run 进 `waiting_user`、主 Agent 发一张 `discussion_clarification` 卡（用例 9），不以完整方案结束。 |
| 3 | P3-AC6 | P3-T1、P3-T2、P3-T3、P3-T6 | passed | **通过（单测）**。普通调用失败/超时 → 委派 `failed{code,retryable}`；缺少证据 `CONTEXT_INSUFFICIENT` → `blocked{failure}`，原因持久化且不盲目重派，Agent 投影为 `waiting`，主 Agent 只发一张澄清卡并将 run 置为 `waiting_user`。主 Agent 规划失败仍抛 `runtimeError` 交 `retry_failed_execution`，不咨询、不落半开 run；停止仍令 run `paused`、运行中委派可续。恢复点 = 持久化 run/delegation + `findResumable`，定向 36/36 通过。 |
| 3 | P3-AC7 | P3-T1、P3-T4、P3-T5、P3-T6 | passed | **通过（服务端）**。需求修订 → `reviseRequirement`：旧修订未完成委派 `superseded`、已完成保留但 `stale:true`（store 用例 7），综合只读当前 revision 非 stale（synthesis 用例 3），同一 run 重规划（用例 7）。**未做**：双端刷新的验证（未改前端；事件带 requirementRevision 供前端判旧）。 |
| 4 | P4-AC1 | P4-T1、P4-T6 | passed | 通过（单元+E2E）：`requirement-document-contracts.spec.ts` 7/7、`requirement-document-store.spec.ts` 8/8、`requirement-document.spec.ts`（发布引用 brief/决策/综合，正文不可变）；E2E `npm run test:e2e:requirement-document-handoff` 断言发布事件带 documentId/contentHash/fingerprint。**未覆盖**：「专家自行提出修订」由阶段 3 委派产生，本阶段只验证发布者唯一 |
| 4 | P4-AC2 | P4-T1、P4-T2、P4-T5、P4-T6 | passed | 通过（单元，双端）：`collaboration-presentation.spec.ts` 11/11（时间线倒序、current、staleness 三分支）、web `requirementDocumentPresentation.spec.ts` 5/5（内联 add/remove）、desktop 同名 6/6（左右并排，复用既有 historyDiffModel）。确认绑定 contentHash，显示与确认同源。**未覆盖**：真实浏览器渲染快照 |
| 4 | P4-AC3 | P4-T2、P4-T4、P4-T6 | passed | 通过（单元+E2E）：`sessions.service.spec.ts` 过期拒绝并回传当前版本、重放幂等；PG `workflow_start_requests` 跨实例唯一（14/14）；E2E 重放确认返回同一 brief 且不推进状态、未确认 brief 不能选流程。**契约说明**：AC3 的「只提交一次」实现为重放返回首次结果（幂等），不是第二次点击报错 |
| 4 | P4-AC4 | P4-T3、P4-T5、P4-T6 | passed | 通过（单元+E2E）：`selectWorkflow` 仅 published 且需已确认 brief；`definitionHash` 在选择时捕获、bootstrap 恢复透传、`start()` 不一致即 `WORKFLOW_VERSION_CHANGED`（`workflow-runtime.service.spec.ts` 32/32 含该拒绝用例）；E2E 同一确认指向另一流程被拒。**未覆盖**：「已下架」是选择后 unpublish 的时序竞争，当前只验证 published 校验与 hash 绑定 |
| 4 | P4-AC5 | P4-T3、P4-T4、P4-T6 | passed | 通过（单元+E2E）：`workflow-member-mapping.spec.ts` 4/4；`selectWorkflow` 不再静默并入 `involvedAgentIds`，缺成员抛 `capability_mapping_required` 并发映射卡（卡锁 definitionHash），批准后同一确认按锁定版本启动；disabled Agent 邀请无效仍 blocked；E2E 断言 0 次 start、状态仍 `WAIT_WORKFLOW_SELECT` |
| 4 | P4-AC6 | P4-T4、P4-T6 | passed | 通过（单元+PG+E2E）：`workflow-start-contracts.spec.ts` 6/6（逻辑键含 documentRevision + definitionHash）、`workflow-start-store.spec.ts` 11/11（提交/派发分离、单一领取、崩溃后 reclaim 不分叉、完成后不二次领取）、PG 跨实例一请求一行并只派发一次；E2E 重放选择解析到同一 run。**未覆盖**：真实进程级崩溃注入（当前为重建 store 模拟重启） |
| 4 | P4-AC7 | P4-T5、P4-T6 | passed | 通过（单元）：返工目标改为按发布图的边回溯（原实现按节点数组顺序，与 `upstreamRerunCandidates` 不一致）；无合法返工边不再 `finishRun('failed')`，改为 `parkForRevisionHandoff` 停在 `waiting_human` 并发 `workflow_gate_requested` + 确认卡，二次决定被拒（`workflow-runtime.service.spec.ts` 3 条新用例）。图与节点顺序仍只来自发布快照，Agent 无法改图 |
| 5 | P5-AC1 | P5-T1、P5-T2、P5-T6 | passed | 通过：确定性状态投影、停止优先拆段、范围变更单独建 ChangeRequest；阶段 5 E2E exit 0 |
| 5 | P5-AC2 | P5-T2、P5-T6 | passed | 通过：SessionsService 定向咨询用例 + E2E 执行中 `@` 场景 |
| 5 | P5-AC3 | P5-T1、P5-T2、P5-T3、P5-T6 | passed | 通过：影响分析卡包含版本/任务/文件与选项，未决前契约保持不变 |
| 5 | P5-AC4 | P5-T3、P5-T5、P5-T6 | passed | 通过：需求版本进入验收指纹，旧 generation/旧分析/旧结果均被 fencing 或标 stale |
| 5 | P5-AC5 | P5-T1、P5-T4、P5-T6 | passed | 通过：WorkItem 隔离、显式继承校验、稳定队列投影与 Agent 定义只读 |
| 5 | P5-AC6 | P5-T1、P5-T4、P5-T5、P5-T6 | passed | 通过：Web/Desktop 幂等提交、FIFO 队列、终态 `next_requirement_pending` 卡不授予执行权 |
| 5 | P5-AC7 | P5-T5、P5-T6 | passed | 通过：删除/恢复 generation fencing、重启恢复 store 用例与隔离 E2E |
| 6 | P6-AC1 | P6-T1、P6-T6 | passed | 通过（Harness：9 阶段、61 AC、54 Task；rollback 证据和发布门禁已记录） |
| 6 | P6-AC2 | P6-T2、P6-T5 | partial | 部分通过（fixture 1.0 倍；真实模型完整调用与质量未执行） |
| 6 | P6-AC3 | P6-T2、P6-T5 | partial | 部分通过（早期召回/同名澄清/修订排除通过；模型质量未测） |
| 6 | P6-AC4 | P6-T3 | passed | 通过（组合对等入口：6 个真实 file backend 场景、随机临时 PostgreSQL 15/15、真实子进程 claim/reclaim；迁移 projection 差异 fail-closed） |
| 6 | P6-AC5 | P6-T4 | passed | 通过（Web/Desktop 呈现、桌面渲染、workflow managed、rework-loop、变更队列组合验收通过） |
| 6 | P6-AC6 | P6-T5 | passed | 通过（流式 `include_usage`、OpenAI/Anthropic 兼容缓存字段、TTFT/总耗时和缺失字段 unknown 均有 fake Provider/定向回归；发布预检验证价格未配置不构成阻断） |
| 6 | P6-AC7 | P6-T6 | partial | 部分通过（隔离 PostgreSQL rollback/reapply 已通过；策略准入、构建身份和正式发布授权仍未执行） |

## 解释

- `passed`：Checklist 已记录实际验证证据。
- `partial`：存在明确的未覆盖范围，不能作为阶段全绿。
- `pending` / `not-executed`：尚无本阶段可接受的执行证据。
- `deferred`：明确记录为后续专项，不属于本阶段发布范围；不能被解释为已完成。
- 真实付费模型、生产发布、外部通知和未配置的 PostgreSQL 均不因本矩阵生成而自动执行。

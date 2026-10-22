# R10：带效果的追加需求设计（待监督复核）

依据：M-009、[SDD §5.3、§6.3](../design/intent-recognition-correction-system-development-design-v1.md)、[IR05.1–IR05.4](../implementation/intent-recognition-correction-task-v1.md#ir05效果范围与实际执行授权)。本次仅交付设计；后续实施须另行批准，仅作用于 `intent-understanding-v1`，不扩展工作流。

## 1. 已核实的根本阻塞与目标

**当前没有 Runtime 接受 `modify_source`。** `packages/shared/src/intent-runtime-policy.ts:27–35`：generic_llm/mock 只收 answer/read_workspace，test_runner 只收隔离测试，其余拒绝；`:91–98` 在调用边界再验。`intent-plan-commit.service.ts:131–159` 的能力/资源/实时授权也未接源码写入，`:189` 阻止非测试带效果追加。故真实范围是“让新链路首次安全改源码”，涉及 IR05.1–IR05.4，不能只补执行器。

另有两处接缝：generic_llm 当前只返回 changedArtifacts/systemEvidence，未构造可信候选（`runtimes/generic-llm-runtime.service.ts:525–548`）；现有 writeback 的 intent 守卫主要查版本，尚未逐文件检查源码授权/局部禁止（`workspaces/workspace-writeback.service.ts:453–465`）。以下 server 路径均相对 `apps/server/src/modules/`。本方案只完成 generic_llm 的窄切片，不宣称完整 IR05 或 CLI 隔离已完成。

## 2. 最窄路径、能力策略与真实强制点

路径：**已授权追加需求 → 只读 generic_llm → 结构化修改提议 → 服务端候选 ChangeSet → 现有 writeback 门 → provider 落盘。** 首期只选 server_local，mock 仅用于验证；只允许清单内既有 UTF-8 源文件的 update，创建/删除/move/二进制均阻止。不开放 CLI、命令、测试或外部写入。

generic_llm 仍只使用 `read_file/search_code/read_attachment`（现有只读集合 `generic-llm-runtime.service.ts:212`），实际暴露取授权交集；附件仍须独立读取许可。新增候选输出合同，模型只能提议相对路径/内容；候选 ID、baseHash、读集、workspace/任务/operation/版本、grant/禁止项摘要由服务端生成并保存。changedArtifacts 不作为已落盘证据；候选保存与任务“已产生候选”标记原子关联，之后才可进入写回。

| 位置 | 拟增的约束与强制行为 |
| --- | --- |
| `supportsIntentEffectScope` / `assertIntentInvocationScope` | supports 新增受信 candidate-only 能力入参，Runtime 筛选与最终 assert 均传递；旧调用缺描述仍拒绝 modify_source，仅 generic_llm 上述模式可接受。assert 同查 business/task_execution、server_local、候选输出合同、有效 binding/scopeHash、`writeMode=none`、requiredCapabilities 至多 read、工具仅只读集合；缺项拒绝，模式字段本身不授权。 |
| `intentScopeToolNames` / `runtime-routing/invocation-resolver.service.ts` | candidate 分支不把 modify_source 映射成 write_file，也不派生 write/command；保留逐次工具守卫，候选绑定在 Runtime 启动前以持久化权威重验。其它 Runtime/模式维持原策略。 |
| 新源码 authority / candidate 校验器 | `source` 不透明资源 ID 绑定服务端不可变的精确文件清单、根目录身份、授权版本和禁止策略；模型路径不能直接变成授权资源。逐项校验规范化路径、大小写/别名、穿越、symlink/junction、内容/数量上限与读集 baseHash；未知资源或操作拒绝。 |
| `workspace-writeback.service.ts` → `workspace-apply-change-set.ts` | enqueue、最终 force/冲突编辑后的候选、文件锁内合并后的真实 ChangeSet 均重验绑定、当前 grant、文件清单和禁止项；在实际落盘前持有授权/版本栅栏，撤权与 applying 互斥，禁止检查后换内容。复用 baseHash、敏感路径、回滚机制；force 不豁免授权/禁止项。 |

“不改表结构”不能只靠目录黑名单：绑定版本化 schema 禁止策略，检查迁移/DDL/ORM 定义及最终内容差异；只自动放行可由受支持语法/修改形态证明满足约束的候选，动态 SQL、未知语法或分析不完整均 blocked，不自动写回。SDD §5.3 原文：“业务级禁止项如‘不改表结构’还需由候选 ChangeSet/迁移检查和写回门验证；无法可靠验证则不自动写回。”保留候选供用户复核，不能把人工点击 force 当作取消禁止项。

## 3. 范围解析器冻结与授权来源

**最窄方案无需改 `execution-scope-resolver.service.ts`。** 现有 `:17–46` 已支持 grant/可信 resources/四层能力交集/可强制禁止项，`:49` 按 kind/refId 精确匹配。仅调用方提供服务端已解析资源与具备上述强制证据的 policy；源码清单和 schema 子资源各用可信 ID，不引入路径前缀授权。禁止对象与效果对象相同仍整体拒绝；局部禁止不能可靠解析成独立资源时继续 blocked，不能丢掉禁止项。若未来确需子资源包含关系或局部扣减语义，才提出最小 resolver 变更，**需用户解冻后另审**，本方案不采用。

SDD §5.3：grant 来自“当前经过验证的明确请求”或“仍有效、未撤销且目标范围匹配的历史授权”。新增源码 authority 保存 actor/sourceEventId、WorkItem/workspace、epoch/generation、文件清单、禁止项、revision/撤销状态及继承条件；当前请求只有被服务端验证且范围明确才签发，否则复用现有确认卡模式让 owner 结构化确认，不从模型 requestedEffects/证据引用/置信度猜授权。历史写授权须逐项匹配且明确允许继承；读取授权、Brief 确认、requiresCodeChanges 均不能替代。新增 live source grant 查询须同时接入 execution guard 与 R7/R8 的 authority snapshot，避免沿用已撤销 grant 或恢复恒报 GRANT_STALE。

## 4. 挂靠 WorkItem、版本与串行消费

仅单段 `same_requirement + enqueue_follow_up`，目标必须唯一绑定当前 WorkItem；其它关系/多段继续原裁决。持久化 FollowUp 投影关联 sourceEventId/routingId/workItemId/stepId；**唯一派发权威为新链路持久化 step/认领记录**，不交旧 `processNextFollowUp` 消费（commit 当前会取消旧队列项，orchestrator 的旧入口也拒绝新合同）。

入队时保存原文、已校验理解、范围/授权与基线，**不递增 requirementRevision/executionEpoch，不改变当前 Decision 集或旧 route 有效 revision**，否则 `intent-execution-guard.ts:77–79、143–144` 会使旧任务失效。激活须旧版本全部任务终结，无 pending/assigned/waiting/claimed 或 live workflow，且候选/写回及 R6/R8/R9 未决事项均解决；仅 invocation=0 不够。PAUSED/预算等待不隐含恢复，取消/删除则失效队列。

安全边界到达后重读事实和授权，保持原文/证据，调用现有编译器重新校验（不调用模型、不改编译器）；基线变化且不能证明请求仍适用则阻止。CAS 激活时 requirementRevision **+1**，新增 immutable intent revision/plan，executionEpoch 不因追加递增。不改旧任务；复用版本化 Brief 流程并补追加入口接线，生成匹配新版本的 Brief、经 owner 真实确认后才创建并派发一个绑定新 step 的 AgentTask/LogicalOperation（否则 R7/R8 收据版本检查不通过）。源码 grant 不代造 Brief 收据，旧收据不冒充新确认。

以 actor/session/dataEpoch/generation/sourceEvent/routing/segment 稳定键防重复入队；激活 step/attempt 唯一认领，确认后原子关联 task/operation/outbox 回执。多实例只认领一次；崩溃仅恢复确定未派发的 outbox，派发未知则阻止，不能因租约到期重做。下一条须重验基线；新 Brief 拒绝/取消不创建任务。

## 5. R6–R9 不变量

R6：路由及 Agent 执行仍走预算槽位；hold 优先，continue 一次放行不授源码权限，end 只结束对应调用/任务，保留会话；不另建 operation 重置预算。R7：空效果活动延续仍零任务/零派发，纯 resume 仍绑定原授权。R8：只重跑绑定的一个失败任务；已有候选/提交/写回仍 `INTENT_RETRY_STEP_UNSUPPORTED` 并指向原写回入口，不增加阶段接续。R9：追加 step 的未知派发按其它 plan-step 只读展示、指向原处理器；不冒充 resume/retry 来源开放三动作。CLI 人工例外不扩展到 candidate 模式。

## 6. 建议拆轮、文件与先红后绿验收

建议分两轮，均须复核后另行授权：**R10a** 建立 source authority、只读候选及实际写回强制点，先用绑定夹具验证，不开放生产追加入口；**R10b** 接带效果 enqueue、版本化队列与单任务派发。先不接 CLI、多段、replan 或 workflow 调度。

拟改文件组（均含相应 spec）：shared 的 `intent-runtime-policy.ts`、intent/Invocation/candidate 合同及输出验证；server 的 `message-routing/intent-plan-commit.service.ts`、新增 `intent-source-authority*` / `intent-source-candidate*` / `intent-follow-up-executor*`，`intent-execution-guard.ts`、`intent-test-authority.ts`（统一 live-authority 查询）；`runtime-routing/invocation-resolver.service.ts`、`runtimes/generic-llm-runtime.service.ts`；`workspaces/workspace-writeback.service.ts`、`workspace-apply-change-set.ts` 及新范围/禁止校验器；`sessions`/`orchestrator` 仅增加绑定任务入口和 module 接线；持久化合同、不变式、File/关系型存储（如需迁移，接当前最大版本）；双端仅复用授权确认卡/store，不新建页面。实施前列明实际文件差异，不能借此解冻其它模块。

先写红例证明当前带效果追加为 `INTENT_ACTION_EXECUTOR_UNAVAILABLE` 或能力阻止（策略层 `INTENT_EFFECT_SCOPE_UNSUPPORTED`）；再按下列验收转绿，全部 fixture/mock，无真实模型：

1. 唯一授权文件的候选只在 writeback 后改变真实文件 hash；调用前/模型返回后源码不变；三个只读工具集合锁定，伪造模式、write_file、command、CLI 均零执行。
2. 越界/路径穿越/链接/伪资源/创建删除 move、旧 grant/撤权/版本竞争拒绝；force、冲突编辑、锁内 merge 不能绕过；含 schema 禁止时合法 handler 修改可过，DDL/ORM/未知分析拒绝，失败前后文件 hash 不变。
3. 活动期追加只入队，当前任务状态/调用数/binding 不变；pending/waiting/live workflow 不误当静止。静止后 revision 仅 +1，新 Brief 真正确认后任务仅一次；拒绝/取消零派发。重复/多实例/重启/不明派发不重做，成功兄弟与旧任务零变化。File 和一次性 PostgreSQL 库验证认领与事务，不碰主库。
4. R6 hold 两入口、R7 空效果/resume、R8 有候选拒绝重跑、R9 只读来源与旧链路回归。获准实施后跑定向 spec、server typecheck/build；改双端则 vitest/vue-tsc/build，再做隔离重启及临时目录实际写回冒烟。

本次未实施、未运行测试/构建或模型；编译器、scope resolver、runtime policy、默认配置、`.env`、L0 均保持原样，未提交推送。停下等待监督复核。

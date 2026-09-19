# TASK.md — 阶段 5：执行中补充、新需求与范围变更治理

状态：进行中（2026-09-19 开工）。阶段 4 已于同日验收（用户确认），准入成立。

依据文档（四件套，2026-09-16 生成）：
`docs/product/main-agent-collaboration-phase-5-spec-v1.md`（AC）、
`docs/design/main-agent-collaboration-phase-5-plan-v1.md`（设计与落点）、
`docs/implementation/main-agent-collaboration-phase-5-tasks-v1.md`（任务）、
`docs/quality/main-agent-collaboration-phase-5-checklist-v1.md`（验收矩阵）。

## 已核实的代码事实（开工前读出，不是设计愿望）

- `SessionFollowUpMessage`（`packages/shared/src/contracts.ts:2280`）已有队列语义：
  `status: 'queued' | 'planning' | 'executing' | 'completed' | 'failed' | 'cancelled'`、
  `sourceEventId`、`workItemId`、`routingId`、`handlingPlan`。**没有** base 版本字段
  （`baseWorkItemRevision` / `baseWorkflowRunId`）——这是 AC3/AC4 要补的洞。
- 队列存在 session 投影上：`session.pendingFollowUpMessages`，写入方只有
  `context-management.service.ts:703/727`（`applyRoutingDecision`）。
- `UserMessageHandlingPlan.intent` 已有 `'question' | 'constraint' | 'scope_change' | 'stop' | 'other'`，
  但 `route-application.service.ts` 的 `handlingPlanFromDecision` 把 `requiresBriefRevision`
  简化为 `scopeRelation !== 'same_requirement'`，且 `affectedTaskIds` / `affectedAgentIds`
  恒为空数组 —— 影响分析没有真实来源。
- **仓库中没有任何 ChangeRequest 实体/状态机**（grep `ChangeRequest` 无业务命中），
  plan §2.1 列的状态（received → analyzing → waiting_user → deferred/rejected/
  stopping → revising → waiting_confirmation → ready）需要从零建。
- 复用已具备的基础：阶段 3 `DiscussionStore`（有界只读委派、成员确认卡）、
  阶段 4 `RequirementDocumentStore`（文档修订 + 确认绑定）、
  `WorkflowStartStore`（逻辑键含 documentRevision，重确认后自然是新启动请求）。

## T1 扩展执行期消息合同（AC1/AC3/AC5/AC6）

- [x] T1-1 shared 合同：ChangeRequest 聚合（sourceEventId、baseWorkItemRevision、
      baseWorkflowRunId、affectedRefs、analysisRevision、choice、status、generation）
      + 状态迁移表，browser-safe（不 import `node:*`），导出 index 并重建 dist
      → `change-request-contracts.spec.ts` 8/8（版本钉死、逻辑键含需求修订、单向迁移、
      已决状态不可重开、deferred 只能回到 analyzing、分析时效三分支）；shared 168/168；
      5 workspace typecheck 干净
- [x] T1-2 多意图消息拆段：一条消息含「停止 + 补充」时停止优先处理，其余持久化待办，
      不丢段、不把整条当停止
      → `splitExecutionMessageSegments`：停止段前置、无段丢弃、同优先级保持稳定顺序
      （重放同计划）、空消息返回空数组而非占位段
- [x] T1-3 持久化 store（file + PostgreSQL V16 **八处**接线 + cutover seed + schema 门禁）：
      同一 sourceEventId 幂等、稳定排序、generation fencing
      → `change-request-store.spec.ts` 10/10（一条消息一个请求、admission/generation 拒绝、
      分析绑定版本、过期分析被拒且不推进、选择只记一次且冲突选择不覆盖、未提供的选项被拒、
      deferred 需重新分析、重启保留分析与选择、不存模型正文）；
      schema/cutover 18/18；隔离 PostgreSQL **15/15**（V16 跨实例一条消息一行、只记一个选择）；
      四门禁全绿

  踩坑（对比阶段 4 的 V15 教训）：接线改为**逐处 grep 核对 + 每处改完即 typecheck**，
  八处一次到位。V16 唯一的生产缺陷是 writer 插入列名写成 `choice` 而表列为 `user_choice`。
  另外三次 PG 失败都在**测试自身**：①并发两调用都返回 `opened` 被我误判为「去重失效」——
  实际 PG 始终只有 1 行（主键 + `logical_key` 唯一约束保证），断言对快照重叠情形过强；
  ②校验查询 select 了不存在的 `choice` 列；③`analysis_revision` 是 bigint，node-pg 返回字符串。
  教训：PG 不变量要查**列值**，不要拿内存态 JSON 的 id 当证据。

## T2 实现主 Agent 影响分流（AC1/AC2/AC3）

- [x] T2-1 只读状态询问走确定性读投影直答，不触发讨论、不调多次模型
      证据：shared `execution-progress-projection.spec.ts` 10/10（措辞取自固定词表，阶段名只来自
      发布快照，未声明的 currentNodeId 不编造阶段；blocked/failed 任务、等待原因
      approval_gate / revision_handoff / upstream_rerun、待处理变更都进答案）；
      `execution-status-question.spec.ts` 6/6 + 既有守卫 6/6（含「顺便加一个导出按钮」不短路、
      控制命令与 @ 专家不短路）；`sessions.service.spec.ts` 110/110（新增 2 条：状态询问
      runtimeCalls=0 且不进语义路由、夹带需求的消息仍进路由）。
- [x] T2-2 执行中 @ 专家 → 有界只读委派（复用阶段 3 `DiscussionStore`），不重跑全部专家/节点
  证据：`execution-status-question.spec.ts` 16/16（新增 4 条咨询匹配用例：影响类提问命中；
  「能不能顺便加一个导出按钮」等带需求的提问**不**命中，仍走变更路径；控制命令/纯陈述不命中；
  超长消息回落语义路由）；`sessions.service.spec.ts` 100/100（执行中 @architect 提问只产生
  1 次定向咨询、不再拆任务、不改契约、不取消节点、状态仍 EXECUTING）。
  实现：orchestrator 新增 `consultDuringExecution`，复用阶段 3 `runMentionDelegations`
  （有界只读委派、回复落在 delegation 上进入主 Agent 综合）；`sendMessage` 在 EXECUTING +
  有 @ + 命中咨询匹配时短路。缺口：`prepareFollowUpExecution` 原先只在 @ 人数>1 或
  discussionRequired 时才走委派，单个 @ 会落到跟进执行路径（重新拆任务）。
- [x] T2-3 范围变更 → 影响分析（受影响任务/文件/确认版本 + 代价），用户未选前不改当前契约
  证据：`deterministic-command-guard.service.spec` + `execution-status-question.spec` 13/13
  （`matchExecutionScopeChange`：补充类措辞成立；只读问句/控制命令/超长消息不成立）；
  `sessions.service.spec` 101/101 新增「执行期范围变更开一个已分析的 ChangeRequest 且不动契约」：
  一条消息一个请求、状态停在 `waiting_user`、卡片 reason=`execution_scope_change` 带
  受影响任务与可选项、`requiresBriefRevision=false`、不触发跟进重规划、会话仍 `EXECUTING`、
  重复提交不二次排队。四门禁全绿。

## T3 实现用户选择与暂停修订（AC3/AC4）

- [x] T3-1 选择「停稳后修订」：先停稳 + 冻结未完成写回（复用现有停止屏障），再建文档新修订
  证据：`resolveExecutionScopeChange`（sessions.service）+ controller 路由
  `POST /sessions/:id/execution-scope-change`；三条新用例（停稳顺序、defer 不停运行、
  重放幂等/改选被拒）随 `sessions.service.spec` 104/104 绿。顺序上先 `pause()` 再
  `changeRequests.transition('revising')`，只冻结未完成写回（applied 不动）。
- [x] T3-2 旧批准失效、重确认后按同一范围重新校验流程；复用已完成结果必须有版本匹配证据
  证据（两部分）：
  ① shared `result-reuse-contracts.ts` 8/8：`canReuseCompletedResult` 逐项校验
     needRevision/docRevision/contentHash/inputFingerprint/fileHashes，缺证据即不可复用
     （absence of proof is not proof）；只校验结果自己声明过的文件，无关文件不阻断复用。
  ② 真实缺陷已修：`acceptanceFingerprint` 原先只含任务/Agent/工具/工作区，**不含需求与文档
     版本**，导致需求改版后 `orchestrator.service.ts:2437` 仍命中旧验收 checkpoint，把旧范围
     的验收算作新需求成果。已把 requirementVersion 并入指纹并在编排器接线
     （`requirementVersionBinding`，无文档的会话返回 undefined 保持指纹稳定）。
     `task-acceptance-preflight.spec` 4/4、`orchestrator.service.spec` 69/69。
  「旧批准失效 + 重确认后按同一范围重新校验」沿用阶段 4 已验收机制：`assertConfirmationCurrent`
  拒过期确认，`WorkflowStartStore` 逻辑键含 documentRevision + definitionHash，重确认自然是新
  启动请求并重走成员/版本校验，不另造一套。
  **未接线**：`isLateResultForSupersededRevision` 目前只有合同与单测，迟到回调的实际拦截点
  与 T5-2 的「删除后回调只允许审计」同族，统一在 T5-2 接线。

## T4 实现新需求排队/切换（AC5/AC6）

- [x] T4-1 相关/独立新需求各自 WorkItem；只有显式继承的有效决定/产物进入新需求
  证据：缺口是产物继承**零校验**（决定早有 `assertInheritedDecisions`，产物 id 直接照抄，
  跨会话 id 或拼写错误都能被记为「继承证据」）。新增 `assertInheritedArtifacts`：
  只接受本会话 `artifactIdsBySession` 里的产物。`context-management.service.spec` 22/22 绿
  （新增 2 条：未知产物 id 被拒 / 真实产物仍可显式继承）。
  踩坑：既有用例 14 回归，根因是它的夹具依赖旧的零校验行为——产物只作为内存数组传给切片函数、
  从未落库；已改为按真实系统方式先落库再继承，守卫按 AC5 保留。
- [x] T4-2 排队幂等有序可查看；当前运行 完成/失败/取消 时提示下一需求，
      队列存在**不等于**自动获得执行授权（仍走文档 + 流程选择）
  证据：`setStatus` 的终态分支（COMPLETED/FAILED/CANCELLED，且前态非终态）新增
  `offerNextRequirement`：按 `changeRequests.deferred()` 的排队顺序发 reason=`next_requirement_pending`
  确认卡，卡片带 `changeRequestIds` + `summaries`，文案明确「排队不等于已获批执行」。
  用 `events.createOnce` + 队列 id 集合的 hash 做键，重放终态不会发第二张卡；队列为空不发卡。
  `sessions.service.spec` 107/107 绿（新增 3 条：提示但不自动启动执行、幂等且顺序稳定、空队列不造卡）。
  踩坑：我最初用 `control(session, 'COMPLETED')` 驱动终态，被 `assertControlTransition` 拒
  （EXECUTING→COMPLETED 不是合法控制边）；生产是由执行完成路径经 `setStatus` 到达终态，
  已改为按生产路径驱动。

## T5 接入状态投影和恢复（AC6/AC7）

- [x] T5-1 双端共享队列/变更卡投影（shared 投影 + web/desktop 各自样式）
  证据：shared `change-queue-projection.ts`（browser-safe，已导出 index 并重建 dist）9/9——
  排队顺序按 raisedAt + id 稳定、waiting_user 与 deferred 分流、已结束状态不入队、
  过期行带 `staleReason`、`grantsExecution:false` + `requiresReconfirmation:true`、
  逐字段投影不带模型推理。双端各自样式：web `changeQueuePresentation.ts` 渲染单条内联列表
  （6 条用例），desktop 同名模块渲染分组小节（8 条用例）。
  `npm run test -w @project/web` 64 文件 / 312 用例全绿（该命令同时覆盖 desktop renderer spec）。
- [x] T5-2 取消/删除 fencing：删除后回调只允许审计；重启保留用户选择与已完成分析，
      不自动重播模型
  证据：缺口是 `open()` 有 `admissionRefusal` 守卫，但 `recordAnalysis` / `recordChoice` /
  `transition` 三个变更方法都**没有**——会话删除后迟到的分析回调、迟到的用户点击仍会写入。
  三处统一接入 lifecycle 守卫（锁集合加 `SESSION_LIFECYCLES_COLLECTION`，按请求自身记录的
  `generation` 比对）：删除后写入返回 `SESSION_ADMISSION_CLOSED`、恢复后旧代次返回
  `CHANGE_REQUEST_STALE_GENERATION`，记录保持可读供审计。
  `change-request-store.spec` 15/15 绿（新增 5 条：删除后分析被拒且不落库、删除后选择被拒、
  恢复后旧代次分析被拒、重启保留选择与分析且 analysisRevision 不被重启抬升、
  已删除会话队列只读可审计）。

## T6 验证执行中交互矩阵（AC1–AC7）

- [ ] T6-1 多意图、重复提交、影响过期、旧结果、流程不支持恢复、同会话串行/跨会话并行
- [ ] T6-2 独立 PostgreSQL（新集合）+ E2E + 四门禁

## 纪律（每个任务都要做，做完才勾）

1. 先写失败用例，再实现。
2. 新 shared 模块：导出 `packages/shared/src/index.ts` + 重建 dist，否则 server 解析旧 dist。
3. server spec 必须在 `apps/server` 下跑 tsx（装饰器）。
4. 跑全量 `npm run test` 时注意失败可能在**别的 spec 文件**里（阶段 4 T3 教训：
   单跑 `sessions.service.spec.ts` 全绿，真实回归在 `workflow-session-flow.spec.ts`）。
5. 四门禁 + 隔离 PostgreSQL 全绿后提交并推送，用 `git status -sb` 的 ahead 标记核对推送。

## 遗留（跨阶段，未完成）

- [ ] 中断会话续接 G3：`npm run dev:restart-server` + 真实场景手测（上一专项人工项）。
- [ ] 跨实例 CAS（讨论/预算 run 的并发写守卫），阶段 3 T1-3 起延后。
- [ ] 成本评测（冷/热缓存对比、priceVersion 来源）归阶段 6。
- [ ] 阶段 4 带入：真实浏览器渲染快照、进程级崩溃注入、流程「已下架」时序竞争、
      `blocked` 委派状态无写入方。

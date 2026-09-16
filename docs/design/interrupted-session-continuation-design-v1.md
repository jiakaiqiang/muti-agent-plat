# 中断会话续接 Design v1

依据 [Spec](../product/interrupted-session-continuation-spec-v1.md)，遵循项目 Harness 协议。

## 决策

保留 `INTERRUPTED` 作为进程所有权标记的既有语义，不改变它的产生方式，也不引入自动重驱。修复方向是给它一个**出口**：把"中断"从"终态 / 有活儿在跑"两种错误解读中拆出来，统一成"等用户，且可续"。

**中断元数据补全是其余改动的前置。** `SessionDetail.interruption` 增加 `previousStatus` / `workItemId` / `phase` 三个可选字段，由 `markSessionInterrupted` 在切状态之前写入。`phase` 复用失败阶段词表，使 `retryFailedSession` 的 `shouldRetryBrief` 判定不必区分来源：

| previousStatus | phase |
| --- | --- |
| `AGENT_DISCUSSING` | `discussion` |
| `REVISING_BRIEF` | `brief_revision` |
| `EXECUTING` / `POST_REVIEW` / `REWORKING` | `task_execution` |

`ACTIVE_INVOCATION_SESSION_STATUSES` 恰好是这五个状态，映射全覆盖。`retryFailedSession` 优先读 `interruption.phase`，缺失时回落 `latestFailurePhase`；注意该函数会先清空 `session.interruption`，phase 必须在清空前取入局部变量。

**队列双锁必须同时解开。** `hasActiveSessionWork` 移除 `INTERRUPTED`（新消息不再判 `deferred`），`processNextFollowUp` 移除 `INTERRUPTED` 早退（队列可被消费）。只改一处无效：前者不改则消息永不入调度，后者不改则调度进来立刻退出。

**方案 A 通过 `replan` 落地，不走 `retryFailedSession`。** `normalizeFollowUpHandlingPlan` 把 `INTERRUPTED` 纳入 `resumableFailure`，且中断场景强制 `failedExecutionAction = 'replan'`。这样 `discussionRequired` 为真 → 会话落 `AGENT_DISCUSSING` → `prepareFollowUpExecution` 带 `requirementRelation` 做契约合并（该函数本就对 `continuation` 传入"保留当前契约已接受约束与已完成工作"的指令）。反向走 `retryFailedSession` → `generateBriefInBackground` 那条路**不接收 followUp 内容**，用户新说的话会丢，因此不采用。

带内容的消息与裸命令词天然分流，不需要额外判断：`继续 / 恢复 / resume` 在 `sendMessage` 早期就被 `deterministicCommandGuard` 拦走，经命令状态解析把 `INTERRUPTED` 映射为 `retry_current`，到不了 `normalizeFollowUpHandlingPlan`。所以**裸"继续"仍是检查点恢复，带需求内容的消息才重新生成契约**——这正是方案 A 要的分工。`retryFailedSession` 只在一个场景需要读 `pendingFollowUpMessages`：崩溃前已入队消息 + 用户重启后只打了"继续"，此时把控制权交给队列而非静默 resume。

**启动路径保持保守。** 双锁解开后 `recoverIntentRoutings` 的重排门禁（原本依赖 `hasActiveSessionWork` 间接屏蔽中断会话）会失守，导致启动即自动重排任务，违反"运行时调用绝不自动重驱"的既有边界。在该门禁处就地补显式 `INTERRUPTED` 判断，只有用户真的发消息才唤醒。

**`applyOutcome` 对中断分级处理。** 迟到的 `delivered` 是产物真的落地的权威终态，允许它把会话推到 `COMPLETED`；迟到的 `failed` / `rework` 仍被吞，保留中断标记与恢复卡供用户决策。这与该函数对 `WAIT_USER_DECISION` 的现有处理同构，有先例可循。

**shadow 门禁的判据是记录自身的 `rolloutMode`，不是当前进程的 rollout 模式。**
（2026-09-15 实施修正：原设计写的是用 `shouldEnforceIntentRouting` 作判据，被既有用例证伪。）

实施时实测到两点，与原判断不同：

1. **实时路径没有暴露面。** `processIntentRouting` 在 pause/cancel 分支之前已有 shadow 早退——
   比较 v2 与 legacy 判定后只记 `SHADOW_MATCH` / `SHADOW_DIFFERENCE` 就返回，shadow 下走不到控制动作。
   原设计称"实时应用点不检查 rollout 模式"是错的，该处无需改动。
2. **暴露面只在重启恢复。** `recoverIntentRoutings` 全函数没有任何 rollout 判断，而
   `semantic-intent-router.finish()` 在 shadow 下会把 autoApplicable 的判定也记成 `ROUTED`。
   于是 shadow 期间落库、下次启动补跑——这才是真实缺陷。

判据只用 `routing.rolloutMode !== 'shadow'`。曾尝试再叠加 `shouldEnforceIntentRouting(session, 当前模式)`，
但既有用例「已取消会话的幂等补记」立刻失败：测试环境未设 `INTENT_ROUTING_MODE`，默认 `shadow`，
该判据把 `enforce_new_sessions` 记录的合法补记也拦掉了。
**结论：记录出自哪个模式才是权威依据，当前进程的环境变量不是。**
原设计"控制动作应服从当前 rollout 模式"那句反而有害——它让重启后的行为依赖环境变量而非记录本身。

**前端拆分两个独立条件。** `backendUnreachable`（后端探测不可达）继续禁用输入框；`sessionInterrupted`（会话被中断）放开输入。同时必须把 `INTERRUPTED` 从 `SessionWorkspace` 的终态集合移除，否则其 watcher 会调 `finalizeSessionEvents`，其 `finally` 直接断开 SSE，用户发了新消息也看不到回流。`utils/sessionStatus.ts` 的终态集合同步移除；该导出另有消费方，改前需查全。

状态机转移表给 `INTERRUPTED` 增加 `AGENT_DISCUSSING` 目标态。这一项不是上述流程的必要条件——`markSessionInterrupted` 直接调 `setStatus`，且转移表中没有任何状态指向 `INTERRUPTED`，说明 `setStatus` 不过转移校验，该表只约束显式 `control()` API。加它是为了让显式控制请求也合法；实施时先确认 `setStatus` 实现再定改法。

## 三层意图识别：分层结论

用户 2026-09-15 提出两版方案：(a) 对已有会话的全部输入都做意图识别，由模型判断"继续 / 需求变了 / 拒绝"；(b) 三层结构——第一层精确词（继续 / 断开 / 关闭）、第二层语义识别、第三层两层都不命中时整体走群聊分析。评估结论：前两层即当前架构，第三层不采纳。

### L1 确定性词表：不扩

`sendMessage` 的 `matchExactUserCommand` 拦在 rollout 分派之前，是闭集合六个词（resume / retry / pause / cancel / confirm / reject），每个词对应 `command-state-resolver` 矩阵上一条确定的状态机转移。

`断开` / `关闭` 不进这张表：它们在本系统没有唯一的会话语义（断 Local Runtime？断 SSE？等于 cancel？）。**判据是"该词能否映射到状态机上唯一一条转移"**，答不出来即属语义层。确定性层唯一的价值是不猜，放进无唯一解的词等于把它变成猜测层。

守卫同时必须保持整串精确匹配。上游设计 [`exact-command-first-intent-routing-system-development-design-v1.md`](./exact-command-first-intent-routing-system-development-design-v1.md) 6.1 节明确要求「继续补充实现审计日志」不得被截获；改成包含匹配或正则即越过这条线。

### L2 语义层：已存在，本轮只需通电

模型推断路径已具备三类判断：`requestedAction: 'resume'`（继续）、`scopeRelation: 'new_requirement'` + `contextPolicy: 'clean_task_context'`（需求变更）、`requestedAction: 'reject'`（拒绝）。`transitionValid` 也已放行 `INTERRUPTED` 的 resume。

所以方案 (a) 的实质不是增加能力，而是**移除 L1 让模型统管控制语义**。不采纳，四条理由：

| 理由 | 依据 |
| --- | --- |
| 闭词表高后果决策放到开词表概率分类器后面是范畴错误 | 六个控制词零歧义、高后果；需求文本无界，必须语义理解 |
| 可用性耦合 | 上游代理账号池已实测 424/429/524、单 step 重试打满 8/8、退避顶到 30s；刹车不能依赖发动机 |
| 信任层级 | 上游设计 12 节：`currentUserMessage` 是不可信 L1 输入。控制语义交给模型判定，等于让不可信输入参与"会话是否被取消"的决策 |
| 双写真相制造优先级 bug | 本轮已发现一例：`normalizeFollowUpHandlingPlan` 静默覆盖 v2 算出的 resume，上游有结论下游当不存在 |

历史事故同形：上游设计 3.2 节记录用户输入「继续」被旧接收者 Runtime 判成 `constraint`，系统去创建新 Brief 和任务拆解。误判控制词的后果不是分类错误，是产生了不该有的副作用——runtime 调用会真实写文件、跑命令。

### L3 兜底：保持 fail-closed，不走群聊

两层都不命中时系统已有兜底，且是 fail-closed 的：

- v2 侧：模型最多 2 次失败 → `requestedAction: 'clarify'` → `finish` 判 `autoApplicable=false` → `CLARIFICATION_REQUIRED` → `emitIntentClarification` 发确认卡问用户。
- legacy 侧：`recognizeFollowUpHandlingPlan` catch 模型失败 → `intentRecognition.recognizeUserMessage` 本地正则。

"整体走群聊"会把兜底从 fail-closed 换成 fail-open：不确定 → `prepareFollowUpExecution` → 生成 brief + 拆任务 → `execution.start` → 真实 runtime 调用。这正是 3.2 节事故的形状。代价也不对称：问用户的代价是点一下，走群聊的代价是一轮多 Agent 讨论 + 契约 + 可能的文件写入，需人工回滚。叠加上述账号池问题，fail-open 会恰好在模型最不可用、最不该自动执行时自动执行。

### L3 的真实缺口：澄清卡选项对中断会话是错的

`emitIntentClarification` 给的三个选项是「继续当前任务 / 作为相关新任务 / 作为独立新任务」，没有"从中断点恢复"。中断会话触发澄清时，用户拿到的选项都不对应其处境。本轮补此项（P0-F）。

**前置未验证**：该函数从 v2 路由结果应用点调用，shadow 模式下 v2 是影子运行，是否会走到该调用点尚未追踪。实施时先确认可达性，再决定是否同时需要 legacy 侧兜底。

### 结论表

| 层 | 用户提议 | 本轮决定 |
| --- | --- | --- |
| L1 精确词 | 加「断开 / 关闭」 | 不加；词无唯一状态机转移语义 |
| L2 语义 | 新建 | 已存在；只需 `resumableFailure` 认 `INTERRUPTED` |
| L3 兜底 | 整体走群聊 | 保持问用户；补"从中断点恢复"选项 |
| 下游前提 | — | 解开队列双锁，否则三层的下游全部不通电 |

真正的瓶颈不在分类层：`hasActiveSessionWork` 与 `processNextFollowUp` 焊死了出队口，中断会话连裸「继续」都走不通。分类质量不是当前限制项。

## v2 与 legacy 的 `INTERRUPTED` 判断：不对齐

`normalizeFollowUpHandlingPlan` 是两条路径的**共享收口**，不是 legacy 专属：`processNextFollowUp` 无条件调用它，而 v2 实时路径写完 `followUp.handlingPlan` 后经 `scheduleFollowUpPlanning` 回到 `processNextFollowUp`，被重新规范化一遍。因此 P0-D 改它必然同时影响 v2，这不是可选项。

三条通路各自独立，现状分工正确：

| 用户输入 | 路径 | 结果 | 决定方 |
| --- | --- | --- | --- |
| 裸「继续 / 恢复」 | `sendMessage` 精确词拦截 → `retry_current` | 检查点恢复 | `command-state-resolver`，已认 `INTERRUPTED` |
| 带内容的需求 | 队列 → `processNextFollowUp` | 回 `AGENT_DISCUSSING` 重建契约 | `normalizeFollowUpHandlingPlan`（P0-D 改） |
| 模型推断 resume | 仅 `enforce_*` 下的 v2 | 经 `transitionValid` 校验 | `semantic-intent-router` |

前两条覆盖"断掉的会话可以继续续接"的全部实际场景，不受对齐影响。第三条只在 rollout 推到 `enforce_*` 后才活，且 `transitionValid` 是**校验函数**——去掉其中的 `INTERRUPTED` 只会让模型推断的 resume 被判非法掉进 clarify，即减少续接能力。因此保留。

`deterministicDecision` 中对精确命令的分支从聊天入口不可达：`sendMessage` 的词表拦截在 rollout 分派之前，该分支要生效需另有不经此入口的调用方。标注为不可达，不删除，避免后续误判为遗漏。

代价是可读性：`semantic-intent-router` 承认 `INTERRUPTED` 可 resume，而共享收口会覆盖该判定。已在此记录，后续改 `normalizeFollowUpHandlingPlan` 的人必须知道它同时影响 v2。

`shouldPause` 已排除为第二条暂停通路：全仓消费点只有 Web/桌面的展示组件，服务端无分支据此暂停，`orchestrator` prompt 反而要求模型恒置 false。shadow 门禁在行为上是够的，残留仅为展示层噪音。

### P1：语义层可提议 resume

用户提议的"模型判定继续则直接用上下文续接"挂 P1，门禁为 rollout 推到 `enforce_*`。理由：届时 v2 是唯一语义入口，有结构化输出可作证据（如 `goalSegments` 是否为空 = 有无新增目标待吸收），而非只信模型给出的动作动词。shadow 下走的是 legacy，其 `UserMessageHandlingPlan` 只有 `requirementRelation` / `failedExecutionAction`，不含可核验的新增目标证据，强度不足以支撑该分支。`goalSegments` 的 prompt 填充要求未验证，采纳前需先确认。

方案 A 默认 `replan` 与失败代价的不对称一致：该 replan 判成 resume 会静默丢掉用户新说的需求；该 resume 判成 replan 只多一轮契约重建，旧约束照样合并，用户意图不丢。带内容的消息按定义有内容要吸收，因此"有内容即重建契约"是构造上正确，不是粗糙。

## 实施笔记：构造中断态的正确方式

`beforeApplicationShutdown` 把 `shuttingDown` 永久置真且全文件无复位处，而
`scheduleFollowUpPlanning` 的第一道守卫就是 `if (... || this.shuttingDown) return;`。
所以用它在测试里造"重启后的中断会话"会让出队永远不触发，测出来的失败是假的——
真实重启后是新进程实例，该标志为假。

造中断态用 `interruptForRuntimeDisconnect`，它走同一个 `markSessionInterrupted`
但不设该标志。D3 实施时踩过这个坑：`deferred=false`、`handlingPlan` 已算成
`replan`、消息也入队了，但 `activeFollowUpMessageId` 始终为空。

另一处相关事实：`AGENT_DISCUSSING` 在 follow-up 链路里是**中间态**。
`processNextFollowUp` 在 `prepareFollowUpExecution` 返回后无条件 `setStatus(EXECUTING)`，
因此验收"补充需求回到讨论态"要断言事件流里的 `follow_up_discussion_started`，
而不是断言终态等于 `AGENT_DISCUSSING`。

## 顺序与风险

1. P0-C 中断元数据（合同字段 + 写入 + phase 读取），其余项依赖它。
2. P0-A shadow 门禁两处，附 shadow 下 pause 不改状态的测试。
3. P0-B `applyOutcome` 分级，改掉固化旧行为的测试并补 `failed` 仍被吞的用例。
4. P0-D 队列双锁 + `resumableFailure` + 状态机，与 P1 的启动门禁同批改，避免中间态破坏自动重驱边界。
5. P0-E 前端拆分与两个 spec 字面量断言。
6. P0-F 澄清卡补"从中断点恢复"选项；先确认 shadow 下该调用点是否可达。
7. P1 WorkItem 映射统一，确认崩溃前入队消息的重排行为。
8. 类型检查、后端定向回归、Web 定向回归；后端改完手动 `npm run dev:restart-server`。

核心风险与控制：

| 风险 | 控制 |
| --- | --- |
| 双锁只解一半，队列仍不消费或状态错乱 | 两处同批改，测试覆盖"中断会话发消息后进 `AGENT_DISCUSSING`" |
| 启动即自动重排，重复执行命令 / 写文件 | 重排门禁就地补显式 `INTERRUPTED` 判断，与双锁同批 |
| `applyOutcome` 放开后退化成"什么都能盖" | 只放开 `delivered`，同时补 `failed` 仍被吞的用例 |
| 前端去终态后 SSE 生命周期变化 | 两个既有 spec 兜底，断言字面量同步更新 |
| `retryFailedSession` 先清 `interruption` 再读 phase | phase 在清空前取入局部变量 |

## 影响落点

- `packages/shared/src/contracts.ts`：`SessionDetail.interruption` 加三个可选字段，全可选、无迁移。
- `apps/server` sessions：约 8 个 hunk（元数据写入、phase 读取、双锁两处、`resumableFailure`、`applyOutcome`、shadow 门禁两处、状态机、重排门禁、`emitIntentClarification` 选项）。
- 不改动：`semantic-intent-router.service.ts`（`transitionValid` 与 `deterministicDecision` 保持现状，理由见上）、`deterministic-command-guard.service.ts`（词表不扩）。
- `apps/server` recovery：WorkItem 映射统一为 `WAITING_USER`。
- `apps/web`：会话状态工具终态集合、工作区组件拆分两个 computed 与提示文案。
- 测试：后端 sessions 定向回归、Web 会话连接生命周期 spec，可能连带 recovery spec 与 recovery smoke 脚本。

全部改动放一个 commit，出问题 `git revert` 即可回退。无 schema 迁移、无数据改写、不删除用户数据与密钥、不自动重跑历史会话。验证只用测试 fixture，不调用真实模型、不重放历史会话。

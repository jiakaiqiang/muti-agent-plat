# 中断会话续接 Checklist v1

当前状态：2026-09-16 完成阶段 A–F 的实现与 G1 全量自动验证。AC 逐条结论由 G2 对账后回填；未实测的不得写“通过”。真实场景手测（G3）见文末。

任务拆分与每项的退出标准见 [Tasks](../implementation/interrupted-session-continuation-tasks-v1.md)：阶段 A（元数据）→ B（shadow 门禁）→ C（迟到结果）→ D（解开队列）→ E（前端）→ F（一致性与兜底）→ G（整体验收）。下表的「任务」列指向该功能点所在的任务编号，G2 负责逐条对账回填。

| 条件 | 任务 | 验证 | 结果 |
| --- | --- | --- | --- |
| AC1 | B1、B2 | shadow 下 ROUTED+pause 不改变会话状态；enforce 下仍暂停；重启恢复不补执行历史控制动作 | 部分通过。重启恢复侧 B2 已实测：`intent routing recovery does not apply a shadow-mode pause after restart`、`...shadow-mode cancel...`（`sessions.service.spec.ts:3072`、`:3090`）；正向对照 `...already cancelled Session as an idempotently applied action`（`:3037`，fixture 默认 `enforce_new_sessions`）证明门禁没写反。实时侧 B1 无新增用例——`applyIntentRoutingOutcome` 的 shadow 早退是本轮之前就存在的代码（`sessions.service.ts:2497`，`git diff` 显示该行未改动），且当前 rollout 下没有自动化用例覆盖到该分支。 |
| AC2 | C1 | 中断会话收到迟到 `delivered` 转 `COMPLETED`；迟到 `failed` / `rework` 仍被吞 | 通过。`backend shutdown persists active work as wakeable and ignores late execution outcomes`（`:1210`）末尾断言 `delivered` → `COMPLETED`；`an interrupted Session still swallows a late failure so the recovery card survives`（`:1253`）断言状态保持 `INTERRUPTED`、`interruption.reason` 保持 `service_shutdown`、`activeRecoveryCheckpoint` 保留。 |
| AC3 | A1、A2 | 讨论阶段中断后点继续走契约重建；`phase` 缺失时回落 `latestFailurePhase` | 通过。`interruption records the phase of the status it interrupted`（`:1332`，含 `previousStatus`/`workItemId`/`phase` 整体断言）；`retry after a discussion-phase interruption regenerates the contract instead of resuming a draft`（`:1344`）；`retry falls back to the latest failure phase when no interruption phase was recorded`（`:1369`）。 |
| AC4 | D1、D2、D3 | 中断会话发带内容消息 → 队列被消费 → `AGENT_DISCUSSING` → 契约合并旧约束 | 通过（合并语义为代码路径结论，非断言）。`an interrupted Session normalises a continuation follow-up into a replan`（`:1269`，断言 `failedExecutionAction === 'replan'`）与对照 `a failed Session keeps resuming a continuation follow-up rather than replanning`（`:1295`，断言 `'resume'`）；`a content message in an interrupted Session drains the queue into discussion`（`:1715`）；`an interrupted Session can be moved to discussion by an explicit control request`（`:1319`，覆盖 D1 的转移表）。 |
| AC5 | D4 | 只说“继续”走检查点恢复；崩溃前已排队消息由队列接管 | 通过。`a bare resume hands control to a message queued before the crash`（`:1746`）；`a bare resume without queued messages still recovers from the checkpoint`（`:1795`）。 |
| AC6 | D3 | 启动时中断会话不被自动重排；运行时调用不自动重驱 | 通过。`restart recovery leaves an interrupted Session queued instead of redriving it`（`:1823`）。启动门禁为 `recoverIntentRoutings` 内显式 `session.status !== 'INTERRUPTED'`（`:1199`），与双锁同批。 |
| AC7 | E1、E2、E3 | 中断时输入框可用且 SSE 不断开；后端不可达时仍禁用 | 通过。`treats an interrupted snapshot as a live status rather than a terminal one`（`sessionStatus.spec.ts:16`）；`treats an interrupted Session as writable while a truly unreachable backend stays disabled`（`session-connection-lifecycle.spec.ts:28`，断言 `:disabled="backendUnreachable"`、新提示文案、且不再出现 `const backendDisconnected`）。**注**：本项的 SSE 不断开是断言 `INTERRUPTED` 已移出 `terminalSessionStatuses`（`SessionWorkspace.vue:452`），非运行时连接观测。 |
| AC8 | F1 | 两侧 WorkItem 映射一致为 `WAITING_USER` | 通过。`recovery.service.ts` 的 `workItemStatusForSession` 改为 `INTERRUPTED` → `WAITING_USER`，与 `sessions.service.ts` 的 `workItemStatusForSessionStatus`（`:5674`）一致；新增用例 `bootstraps an interrupted Session WorkItem as WAITING_USER rather than FAILED`（`recovery.service.spec.ts:251`）。 |
| AC9 | F2 | 中断会话的澄清卡含"从中断点恢复"选项；不确定时问用户而非自动进入群聊讨论 | 未实现（可达性结论已确认，按 F2 前置调查的降级路径处理）。可达性结论：`emitIntentClarification` 唯一调用点在 `sessions.service.ts:2528`，位于 shadow 早退（`:2497`–`:2513`）**之后**；当前 rollout 为 `shadow`（`.env` 未设 `INTENT_ROUTING_MODE`，`.env.example:41` 亦为 `shadow`，`intentRoutingMode()` 兜底 `shadow`），故该调用点在现网配置下不可达，补选项不产生任何用户可见效果。fail-closed 一侧本来就成立：三层都不命中时走的是这张澄清卡而非自动群聊。恢复该项需先把 rollout 推到 `enforce_*`，与 P1「语义层可提议 resume」同一门禁。 |
| AC10 | G1、G2 | 类型检查、后端定向回归、Web 定向回归；固化旧行为的测试已更新 | 通过。见下方「G2 复测」。固化的旧行为测试有两处：`applyOutcome` 的「keeps interrupted status」类断言、`session-connection-lifecycle.spec.ts:14` 的终态字面量断言（后者在 G2 才被发现是失败状态，已随 E3 一并更新）。 |

## 可复核证据（G1 实测）

- `npm run typecheck`：整个 workspace 通过，含 server、shared、local-runtime-cli、desktop、web。
- `npm run test -w @agent-cluster/server`：主测试 1326 通过、**0 失败**、9 跳过；开发启动脚本测试 7/7 通过。
- `npm run test -w @project/web`：28 个文件、183 通过、0 失败。
- `npm run test:harness`：16/16 通过。
- sessions 定向回归：`tsx --test --tsconfig tsconfig.json src/modules/sessions/sessions.service.spec.ts` → 81/81 通过（本轮从 68 增至 81，新增 13 条）。
- recovery 定向回归：`recovery.service.spec.ts` 6/6 通过。
- Web 定向回归：`sessionStatus.spec.ts` 4/4、`session-connection-lifecycle.spec.ts` 3/3、`SessionWorkspace.spec.ts` 12/12。

一处需要记录的排查过程：全量首跑曾报 1 个失败（`workspace-writeback-recovery.spec.ts` 的「restores a Session that was interrupted before the workspace writeback finished」，期望 `INTERRUPTED` 实际 `AGENT_DISCUSSING`）。核查确认该文件已不在磁盘上（Read 与 `fs.existsSync` 均报不存在，标题在 src 与 dist 全仓搜索无命中），而 `scripts/run-unit-tests.mjs` 是运行时递归扫描 `src/` 收集用例，说明它是首跑那一刻存在的临时文件。重跑后 0 失败。**当前源码没有该回归。**

## G2 复测（2026-09-16，AC 对账后）

G2 期间又改了两处（F1 的 `WAITING_USER`、desktop 镜像修复），故重跑全套，以下为当前权威计数：

- `npm run typecheck`：整个 workspace 通过（local-runtime-cli、shared、desktop、server、web）。
- `npm run test -w @agent-cluster/server`：`# tests 1327 / # pass 1318 / # fail 0 / # skipped 9`；开发启动脚本测试 `7/7`。
- `npm run test -w @project/web`：`60 files / 283 passed / 0 failed`（含纳入的 `../desktop/renderer/components/**/*.spec.ts`）。
- sessions 定向回归：`tsx --test --tsconfig tsconfig.json src/modules/sessions/sessions.service.spec.ts` → `80/80`（与 G1 记的 81 差 1，见下）。
- recovery 定向回归：`recovery.service.spec.ts` → `7/7`（F1 新增 1 条）。
- 后端其余定向：`recovery + sessions + semantic-intent-router + deterministic-command-guard + intent-recognition + command-application + command-state-resolver` 合跑 → `114/114`。
- Web 定向：`sessionStatus.spec.ts` 4/4、`session-connection-lifecycle.spec.ts` 3/3、`SessionWorkspace.spec.ts` 9/9、`event-normalization.spec.ts` 9/9，合跑 `25/25`。

两处与 G1 记录不一致，均属测量口径而非代码回归，记录备查：

- **sessions 81 → 80**：G1 记的「从 68 增至 81，新增 13 条」当时取自整包汇总、未单独复跑本文件核对。当前单独跑该 spec 权威计数为 `80`（`# fail 0`），且 13 条新增用例名逐条 grep 均存在且唯一，据此反推改动前基线是 67 而非 68——G1 的两端计数各差 1。
- **`session-connection-lifecycle.spec.ts` 3/3 → 曾为 2 passed / 1 failed**：G1 记的 3/3 是错的——该结论取自整包汇总（整包确为全绿），但此文件 L14 的字面量断言 `"['INTERRUPTED', 'COMPLETED', 'FAILED', 'CANCELLED']"` 在 E3 移除 `INTERRUPTED` 后按字面失败，G2 单独跑该文件时才暴露（整包当时未覆盖到，说明汇总计数掩盖了它）。G2 已把 L14 更新为 `"['COMPLETED', 'FAILED', 'CANCELLED']"`，改后单独跑 `3/3`。**教训：字面量断言的 spec 必须单独跑，不能只信整包汇总。**
- **web 28 files/183 → 60 files/283**：G1 的 28 文件偏小，当前 vitest `include` 覆盖 `../desktop/renderer/components/**/*.spec.ts` 及更多 store/component spec，为 60 文件；两次都是 `0 failed`。

## 偏离与未实现记录

1. **AC1 的实时侧（B1）未新增用例**：`applyIntentRoutingOutcome` 的 shadow 早退（`sessions.service.ts:2497`）经 `git diff` 确认是本轮之前就存在的代码，本轮无需改动；AC1 的「重启恢复不补执行」由 B2 两条新用例实测通过，「enforce 下仍暂停」由正向对照用例覆盖。实时侧缺一条独立新用例，是已知的证据缺口。
2. **AC9（F2）未实现，降级为 P1**：`emitIntentClarification` 调用点在 shadow 早退之后，现网 rollout 为 `shadow` 故不可达，补「从中断点恢复」选项无实际效果。详见上表 AC9 行。fail-closed 语义（不确定时问用户、不自动群聊）在现有代码里已成立。恢复该项与「语义层可提议 resume」共用同一门禁：rollout 推到 `enforce_*`。
3. **desktop 渲染层同步修复**：`apps/desktop/renderer/components/SessionWorkspace.vue` 有与 web 同源的 `INTERRUPTED` 当终态的缺陷（`terminalSessionStatuses` 含 `INTERRUPTED`、`backendDisconnected` 把中断与不可达混为一谈），本轮镜像 web 的 E1/E2/E3 改法（拆 `backendUnreachable`/`sessionInterrupted`、移出终态集合、更新提示文案）。desktop 无 `SessionWorkspace.spec.ts`（只有 `ConfirmationCard`/`SessionSidebar` 两个 spec），故该项靠 renderer typecheck（`vue-tsc -p renderer/tsconfig.json`，exit 0）+ web 全量（含 desktop 的 `readonly-chat.spec.ts`）兜底，无组件级断言。
4. **`APPLYING_CHANGES` 未纳入中断阶段映射**：`INTERRUPTION_PHASE_BY_STATUS` 曾试加 `APPLYING_CHANGES: 'task_execution'`，随后回退——`recoverWorkspaceWritebackState`（`:5202`）设 `INTERRUPTED` 时直接赋 `session.interruption`、不走该映射表，加它不影响任何实际路径，属超出本轮范围。当前 `APPLYING_CHANGES` 被中断（经 `markSessionInterrupted`）时 `phase` 为 `undefined`，回落 `latestFailurePhase`，行为不变。
5. **17 个读取点复查结论**：G2 全仓 grep `'INTERRUPTED'`（排除 spec）确认非 spec 读取点均已有出口或语义正确——队列双锁已解、`applyOutcome` 分级、启动门禁显式、`command-state-resolver`/`semantic-intent-router` 把中断并入可重试/可 resume 是有意的、`normalizeFollowUpHandlingPlan` 强制 replan、转移表加 `AGENT_DISCUSSING`、`assertControlTransition` 与 `requiresUserAction`/WorkItem 映射的「等待用户」语义正确。`execution.worker.ts:45` 与 `logical-operation-store.ts:9` 把 `INTERRUPTED` 当"停止态"跳过执行/拒绝新预留，与"不自动重驱运行时调用"边界一致，保留。
6. **「不改动」清单守住**：`git diff` 确认 `semantic-intent-router.service.ts` 的 `transitionValid` 与 `deterministicDecision` 函数体未被本轮改动（该文件的 diff 是更早的 lease/retry 相关工作），`deterministic-command-guard.service.ts` 的 `COMMANDS` 六词词表与 `matchExactUserCommand` 未动（diff 仅为新增 workflow-directive 匹配函数）。

## 交付边界

不自动重跑用户历史会话，不改模型与供应商配置，不清库、不做 schema 迁移、不改写既有数据。`interruption` 新增字段全部可选，旧快照反序列化不受影响。

已知未覆盖：真实模型全链路续接效果不由自动化测试保证。

`normalizeFollowUpHandlingPlan` 是 legacy 与 v2 的共享收口，改它同时影响两条路径，因此本轮改动不限于 legacy。`semantic-intent-router` 的 `transitionValid` 保留 `INTERRUPTED`，与共享收口的强制 `replan` 判断相反，是刻意保留的不对齐（理由见 Design）。用户提议的"语义层可提议 resume"挂 P1，门禁为 rollout 推到 `enforce_*`。

左侧项目树与批量删除不在本轮。

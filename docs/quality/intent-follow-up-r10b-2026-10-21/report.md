# M-011 / R10b：带效果追加需求服务端交付报告

日期：2026-10-22。依据：[R10 设计](../intent-follow-up-r10-design-2026-10-21.md)第 3、4、5 节及第 6 节验收 3、4。本轮只接服务端，未改 web / desktop、CLI、多段、replan 或 workflow 调度。

## 交付结果

R10a 的源码授权和候选写回门已接入单段 `same_requirement + enqueue_follow_up + modify_source` 链路。提交时不从模型输出推断写权限；没有有效源码授权时只创建结构化 owner 确认卡。批准后由 `IntentSourceAuthorityStore.issue()` 签发不可变的精确文件范围、根身份、版本和禁止策略。

追加需求先持久化为 FollowUp 投影和版本化 plan step，入队时不改变当前 `requirementRevision` / `executionEpoch`。扫描器只在活动 WorkItem 静止、预算/对账/写回栅栏清空且基线未变化时激活；激活通过 CAS 将 `requirementRevision` 增加 1，重新编译并生成新的 Brief。Brief 由 owner 确认后，在同一事务中创建一个绑定新 step 的 AgentTask 和 LogicalOperation；拒绝或取消不会创建任务。旧 `processNextFollowUp` 不参与派发。

源码未知写回现在有服务端对账出口：GET 返回候选 baseHash、目标 hash 和当前 hash，决定接口只接受“确认未写入，可重新应用”“确认已写入，按已应用处理”或“放弃候选”，每次决定都校验证据 hash 和当前 claim 状态。

## 主要改动

- `apps/server/src/modules/message-routing/intent-source-authorization.service.ts`：owner 确认卡、CAS、幂等和 authority 签发接线。
- `apps/server/src/modules/message-routing/intent-follow-up.service.ts`、`intent-follow-up-state.ts`：追加需求提交、持久化投影、静止条件、版本化激活和取消。
- `packages/shared/src/intent-follow-up-contracts.ts`：FollowUp、授权请求和 apply resolution 合同。
- `apps/server/src/modules/message-routing/intent-source-reconciliation.service.ts`：未知源码写回的 hash 证据和人工决定出口。
- `intent-plan-commit.service.ts`、`intent-brief-confirmation.service.ts`：提交分流及 Brief 确认后的单任务创建。
- `sessions.controller.ts`、`sessions.module.ts`、`message-routing.module.ts`：注册授权和源码对账 API/服务。
- `intent-follow-up.service.spec.ts`：R10b 入口、版本化消费者和未知 claim 出口的定向测试。

设计清单外的接线文件均只用于调用已有 Brief/持久化/事件能力；未修改 compiler、`execution-scope-resolver.service.ts`、semantic-intent-router、默认开关或 `.env`。

## 验证证据

| 检查 | 结果 |
| --- | --- |
| 先红后绿 | 初始 3 项因 R10b 服务模块不存在而失败，见 [red.log](evidence/red.log)；实现后 3/3 通过，见 [followup-test-1.log](evidence/followup-test-1.log)。随后补充原始文件 hash 对齐回归，定向测试 **4/4 通过**，见 [followup-test-2.log](evidence/followup-test-2.log)。 |
| R6–R10a 串行回归及 R10b 定向回归 | **725 项：723 通过、0 失败、2 跳过，exit=0**，见 [r10b-r10a-regression-1.log](evidence/r10b-r10a-regression-1.log)。跳过项为一次性 PostgreSQL 未启用和 Windows 文件 symlink 创建权限 `EPERM`。 |
| Server typecheck | 初始及 hash 修复后的复检均 exit=0，见 [server-typecheck-r10b.log](evidence/server-typecheck-r10b.log) 和 [server-typecheck-r10b-2.log](evidence/server-typecheck-r10b-2.log)。 |
| Shared build | exit=0，见 [shared-build-r10b.log](evidence/shared-build-r10b.log)。 |
| Server build | exit=0，见 [server-build-r10b.log](evidence/server-build-r10b.log)。 |
| 隔离重启和新 API 路由 | health、进程替换、`intent-source-authorization` 与 `intent-source-reconciliations` 路由探测通过，见 [isolated-restart-smoke.log](evidence/isolated-restart-smoke.log) 和 [smoke.json](evidence/smoke.json)。使用临时 File 状态、child-only mock、真实模型调用 0 次。 |
| FollowUp 链路夹具 | 临时 server-local 工作区中验证授权绑定后的“提交 → 排队 → 静止激活 → 新 Brief 确认 → 一个任务/操作”，`requirementRevision` 从 1 到 2，见 [full-chain-smoke.log](evidence/full-chain-smoke.log)。候选生成和真实 writeback 仍由 R10a 冒烟覆盖。 |

该链路冒烟使用本地持久化和已签发夹具 authority，不调用真实模型，也不替代生产 HTTP/LLM 集成验收；R10c 再补前端确认卡交互。

## 已知限制

- R10b 只支持单段追加需求，目标固定为当前 WorkItem；多段、replan、workflow 调度和 CLI 未开放。
- `no_schema_change` 继续沿用 R10a 的失败关闭窄语法检查；不能证明的修改会阻止自动写回。
- PostgreSQL 本轮只纳入既有关系型投影回归，未连接主库；一次性 PostgreSQL 用例因环境不可用跳过。
- 未知源码 claim 的决定已提供服务端出口，但前端卡片展示留到 R10c。

未提交、未推送、未调用真实模型。

## M-012 / R10b-r2 返工补充

本轮没有扩展产品功能，补齐了 R10b 的行为验证和两个代码问题。

### 代码修正与行为覆盖

- `IntentFollowUpService.scan()` 激活异常现在会把 FollowUp 置为 `blocked`，保存 `failureCode`，把投影置为 `failed`，并发出 `intent_plan_blocked` 事件；状态不再是 `queued`，同一异常不会每 2 秒重复激活。
- 授权请求不再接受客户端提交的 `paths` / `prohibitions`。请求卡只建立待决定记录；精确清单必须由 owner 的结构化 approve 决定提交。服务端在决定前验证 server-local 根、规范化路径、文件存在性、别名、总大小和 32 文件上限，随后仍由 `IntentSourceAuthorityStore.issue()` 复核根/文件身份和版本。
- 源码对账 resolution 持久化 `idempotencyKey`，相同案件、owner、键和证据重复点击返回同一结果；不同证据或动作继续拒绝。
- `intent-follow-up.service.spec.ts` 已删除“只断言函数存在”的测试，改为 6 条行为测试：owner 授权/CAS/幂等/越界、入队版本与执行不变、静止条件、扫描失败持久化、Brief 单任务、unknown claim 证据和幂等。

正常追加需求从提交到源码落盘需要 **2 次用户点击**：①源码授权卡批准精确文件和禁止项；②追加需求生成的新 Brief 确认。候选生成和写回自动走既有服务端门；若写回结果未知，则额外进入 R9 对账卡，需要一次人工决定。

源码 unknown claim 已作为 `source_writeback` 来源加入 R9 的 `reconciliationSources()` / 证据视图，并在通用案件决定层保持只读；三项源码动作由 `IntentSourceReconciliationService` 的专用接口处理，因为它需要额外核对候选 baseHash、目标 hash、当前 hash 和源码 apply 栅栏，不能复用 R9 的 resume/retry 三动作。

`packages/shared/src/intent-runtime-policy.ts` 本轮未修改。M-010 交付 hash 与本轮 hash 均为 `abdb42ddbe306eddfdb96974a055292cad62a9429e7168e532194c8a8928eea8`，逐文件记录见 [verification-r2.json](evidence/verification-r2.json)。

### R10a 30 文件逐文件回归

R10a 基线为 30 文件、769 项、768 通过、0 失败、1 跳过。本轮 30 个原文件逐项复跑，项数没有减少；新增 R10b FollowUp 测试和一次关系型对账 skip 后，总计 32 文件、776 项、774 通过、0 失败、2 跳过，全部退出码为 0。两个跳过分别是 Windows symlink `EPERM` 和缺少一次性 PostgreSQL 测试库。

| 文件 | 项数 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: | ---: |
| `apps/server/src/modules/message-routing/intent-source-authority.spec.ts` | 12 | 12 | 0 | 0 |
| `apps/server/src/modules/message-routing/intent-source-candidate.spec.ts` | 33 | 33 | 0 | 0 |
| `apps/server/src/modules/message-routing/intent-reconciliation.service.spec.ts` | 38 | 38 | 0 | 0 |
| `apps/server/src/modules/message-routing/intent-plan-commit.service.spec.ts` | 31 | 31 | 0 | 0 |
| `apps/server/src/modules/message-routing/intent-resume-guard.spec.ts` | 40 | 40 | 0 | 0 |
| `apps/server/src/modules/message-routing/intent-retry-guard.spec.ts` | 45 | 45 | 0 | 0 |
| `apps/server/src/modules/message-routing/intent-message-pipeline.service.spec.ts` | 25 | 25 | 0 | 0 |
| `apps/server/src/modules/runtime-routing/invocation-resolver.service.spec.ts` | 38 | 38 | 0 | 0 |
| `apps/server/src/modules/runtimes/generic-llm-source-candidate.spec.ts` | 9 | 9 | 0 | 0 |
| `apps/server/src/modules/runtimes/generic-llm-runtime.service.spec.ts` | 40 | 40 | 0 | 0 |
| `apps/server/src/modules/runtimes/runtime.service.spec.ts` | 82 | 82 | 0 | 0 |
| `apps/server/src/modules/runtimes/generic-llm-input-budget.spec.ts` | 3 | 3 | 0 | 0 |
| `apps/server/src/modules/runtimes/input-budget-store.spec.ts` | 3 | 3 | 0 | 0 |
| `apps/server/src/modules/runtimes/input-budget-tool-rerun.spec.ts` | 1 | 1 | 0 | 0 |
| `apps/server/src/modules/runtimes/generic-llm-tool-loop-budget.spec.ts` | 4 | 4 | 0 | 0 |
| `apps/server/src/modules/orchestrator/intent-retry-task.spec.ts` | 4 | 4 | 0 | 0 |
| `apps/server/src/modules/orchestrator/orchestrator.service.spec.ts` | 93 | 93 | 0 | 0 |
| `apps/server/src/modules/sessions/sessions.service.spec.ts` | 163 | 163 | 0 | 0 |
| `apps/server/src/modules/workflows/workflow-runtime.service.spec.ts` | 36 | 36 | 0 | 0 |
| `apps/server/src/modules/execution/execution.service.spec.ts` | 7 | 7 | 0 | 0 |
| `apps/server/src/modules/queue/execution.worker.spec.ts` | 2 | 2 | 0 | 0 |
| `apps/server/src/modules/workspaces/intent-source-write-guard.spec.ts` | 15 | 14 | 0 | 1 |
| `apps/server/src/modules/workspaces/workspace-source-apply.spec.ts` | 5 | 5 | 0 | 0 |
| `apps/server/src/modules/workspaces/workspace-source-writeback.spec.ts` | 7 | 7 | 0 | 0 |
| `apps/server/src/modules/workspaces/workspace-writeback-intent.spec.ts` | 4 | 4 | 0 | 0 |
| `apps/server/src/modules/workspaces/workspace-writeback.service.spec.ts` | 16 | 16 | 0 | 0 |
| `apps/server/src/modules/workspaces/workspace-apply-change-set.spec.ts` | 8 | 8 | 0 | 0 |
| `apps/server/src/modules/workspaces/workspace-apply-change-set-concurrency.spec.ts` | 1 | 1 | 0 | 0 |
| `apps/server/src/modules/workspaces/server-local-workspace-provider.spec.ts` | 1 | 1 | 0 | 0 |
| `packages/shared/src/intent-source-runtime.spec.ts` | 3 | 3 | 0 | 0 |
| `apps/server/src/modules/message-routing/intent-follow-up.service.spec.ts` | 6 | 6 | 0 | 0 |
| `apps/server/src/modules/persistence/relational/intent-reconciliation.integration.spec.ts` | 1 | 0 | 0 | 1 |

原始日志、逐文件计数和哈希见 [r2-files-final](evidence/r2-files-final/)、[full-chain-smoke-r2.json](evidence/full-chain-smoke-r2.json)、[full-chain-smoke-r2.log](evidence/full-chain-smoke-r2.log) 与 [verification-r2.json](evidence/verification-r2.json)。

### 本轮设计清单外文件

- `apps/server/src/modules/message-routing/intent-source-authorization.service.ts`：将精确清单从请求体移到 owner approve 决定，并在签发前做文件/根/大小校验。
- `apps/server/src/modules/message-routing/intent-follow-up.service.ts`：持久化扫描失败、失败事件和停止重试；同步更新授权请求调用。
- `apps/server/src/modules/message-routing/intent-source-reconciliation.service.ts`、`packages/shared/src/intent-follow-up-contracts.ts`：为 unknown claim 增加持久化幂等键，并使重复决定可安全重放。
- `intent-follow-up.service.spec.ts` 与 `evidence/*-r2*`：行为测试、逐文件回归、完整链路和交付哈希证据。

本轮仍未修改 compiler、`execution-scope-resolver.service.ts`、semantic-intent-router、默认开关、`.env`、web / desktop；未提交、未推送、未调用真实模型。

## M-013 A / R10b-r3 补充

A 部分补齐了监督复核要求的四类行为测试，写入 `apps/server/src/modules/message-routing/intent-follow-up.service.spec.ts`：

- 三种基线变化（授权清单文件 hash、confirmed Decision 集、workspace binding）都会持久化为 `blocked`，`failureCode=INTENT_FOLLOW_UP_BASELINE_CHANGED`，需求版本不递增且不生成新的 Brief step。
- 两个共享持久化的 FollowUp service 并发激活，以及新实例的重启激活/scan，只产生一次 `brief`、一次 `requirementRevision +1` 和一个 Brief step。
- queued 与 brief 两种真实取消路径都不创建 `followup-task:` 或新的 LogicalOperation，FollowUp 与投影都落为 `cancelled`。
- unknown claim 的 `redispatch` 重复点击幂等，之后最多允许一次新的 apply；第二次拒绝；`abandon` 重复点击幂等且后续 apply 被拒绝。

定向执行结果：`intent-follow-up.service.spec.ts` 共 10/10 通过，0 失败，exit=0。先红后绿过程中发现并修复两处服务端缺陷：workspace binding stale 现在按基线变化持久化 blocked；同一候选的 redispatch resolution 现在只允许一次后续 apply。

B 部分按要求停止：当前 `POST /sessions/:sessionId/intent-source-authorization` 只返回 `paths: []`，没有服务端允许候选文件列表的 GET/字段；批准接口仍由客户端提交 `paths`，因此前端无法安全实现“只能从服务端候选范围选择”。未新增 web/desktop 代码、未拼接路径、未改服务端 API 逃避该阻断。待服务端先提供候选文件范围后再实施 R10c。

本轮证据：`evidence/verification-r3.json`。未调用真实模型、未提交、未推送。

### M-013 A / R10b-r3 回归补充

四类行为测试已补齐并通过：基线文件 hash / Decision 集 / workspace binding 变化都会持久化阻止激活；双实例并发与重启扫描只产生一次 requirementRevision、Brief step 和 brief 状态；Brief 拒绝与追加需求取消均为零 follow-up task / LogicalOperation；unknown claim 的「确认未写入」与「放弃」动作均为证据约束、单次 apply 与重复点击幂等。

定向 `intent-follow-up.service.spec.ts` 为 10/10 通过。R10a 原 30 文件加新增文件共 32 文件、780 项：778 通过、0 失败、2 跳过，exit=0；完整日志见 [regression-r3.log](evidence/regression-r3.log)，机器可读证据见 [verification-r3.json](evidence/verification-r3.json)。

本轮测试暴露并修复两处服务端问题：workspace binding 变化原先在 baseline 比较前抛出 stale authority，现持久化为 `blocked` / `INTENT_FOLLOW_UP_BASELINE_CHANGED`；源码 redispatch 后的 apply 现在只允许一次，后续拒绝 `INTENT_SOURCE_CANDIDATE_REDISPATCH_ALREADY_USED`。未修改冻结文件、web / desktop，未调用真实模型、未提交、未推送。

### M-013 B 阻塞

服务端当前没有提供工作区内已存在文件的候选列表字段或接口；源码授权决定接口仍接收客户端 `paths`，不满足“前端只能从服务端候选范围选择、不得拼路径”的前置条件。按 M-013 要求停止 B，不修改 web / desktop，阻塞详情另见 [R10c report](../intent-follow-up-r10c-2026-10-22/report.md)。

服务端 `npm run typecheck -w @agent-cluster/server` 与 `npm run build -w @agent-cluster/server` 均 exit=0；定向 10 项回归在构建修正后仍为 10/10。构建期间仅补充测试中的 TypeScript unknown 类型断言，不改变测试行为或产品逻辑。

# Agent Cluster 修复任务执行计划（Batch 2 / Batch 3）

> 生成时间：2026-06-04
> 上游文档：[remediation-plan-v1.md](./remediation-plan-v1.md)（方案级）、[feature-inventory-and-status-v1.md](./feature-inventory-and-status-v1.md)（问题清单）。
> 本文是**执行级**计划：每个任务含 目标 / 前置依赖 / 起点现状 / 改动文件 / 分步 checklist / 验收标准 / 验证命令 / 回归风险 / 工作量。
> 约定：`- [ ]` 为可勾选执行项；引用方法名/文件名（不引用行号，因 Batch 1 后已变动）。

---

## 0. 基线：Batch 1 已完成状态（执行起点）

Batch 2 必须在此基线上推进，避免重复或冲突。Batch 1（已合入、E2E 14/14 通过）已建立：

| 能力 | 现状（Batch 2 的起点） |
| --- | --- |
| 后台执行 | `ExecutionService.start(session, brief, tasks, onOutcome)`：后台跑 `OrchestratorService.runPipeline`，持有 `Map<sessionId, AbortController>`，提供 `cancel()` / `isRunning()` |
| 执行流水线 | `runPipeline(session, brief, tasks, signal?)` 返回 `ExecutionOutcome`（`delivered`/`rework`/`ask_user`/`failed`）；拆出 `runOneTask`/`runPostReview`/`runFinalDelivery`；任务边界检查 `signal.aborted`；交付前查重 |
| 状态机 | `SessionsService.applyOutcome` 按 outcome 落终态；`create`/`confirmBrief` 受理即返回（后台执行 + SSE 跟进） |
| 取消（部分） | `control()`（`/pause`、`/cancel`）已调用 `execution.cancel`；**但 `/messages` 插话仅 soft-pause、不取消；resume 不重新触发；在途 LLM 请求不可中断** ← T3 待补 |
| 恢复 | `RecoveryService`(OnApplicationBootstrap) 扫描续跑；`ENABLE_BULLMQ=true` 或 `AGENT_CLUSTER_RECOVER_ON_BOOT=false` 时关闭 |
| LLM 健壮性 | `generic-llm` 已有超时(`AbortController`)+退避重试；`llmTimeoutMs()`/`llmMaxRetries()` |
| 持久化 | `writeFileState` 已**原子 rename**；但 postgres 仍 `execFileSync` 全量、`events.create` 仍每条 persist ← T2 待补 |
| 运行时路由 | `runtime.service.run` 仍是 `generic_llm ? generic : mock` 二元判断；codex/claude adapter（throw stub）**未注册到 RuntimeModule** ← T1 待补 |

---

## 1. 执行总览与顺序

| 序 | 任务 | 问题 | 依赖 | 量级 | 状态 |
| :--: | --- | :--: | --- | :--: | :--: |
| T1 | 运行时注册表派发 | P1-8 | 无（独立） | S | ⬜ 未开始 |
| T2 | 持久化连接池 + 增量写 + 事件批量 | P1-6 | 无 | M | ⬜ |
| T3 | 执行可中断（补全取消/恢复） | P1-9 | Batch1 ExecutionService | M | ⬜ |
| T4 | BullMQ 真正承载执行 | P1-5 | T1 优先、复用 ExecutionService | L | ⬜ |
| T5 | 多 Agent 讨论 + 任务依赖 | P1-7 | 无（建议最后） | L | ⬜ |
| T6 | 后端文案统一 | P2-10 | 无 | S | ⬜ |
| T7 | Token 预算落地 | P2-11 | 无 | M | ⬜ |
| T8 | 长期记忆确认写入 | P2-12 | 无 | S | ⬜ |
| T9 | 运行态可观测 + README 订正 | P2-13 | T1–T5 落地后更准 | S | ⬜ |

**推荐顺序**：T1 →（T2 ∥ T3）→ T4 → T5 →（T6 ∥ T7 ∥ T8 ∥ T9）。
**里程碑**：
- **M-B2a（执行硬化）**：T1 + T3 完成 → 运行时显式化 + 真正可中断/可恢复。
- **M-B2b（队列化）**：T4 完成 → 执行进入 BullMQ，跨重启由队列重试。
- **M-B2c（协作深度）**：T2 + T5 完成 → 持久化生产级 + 真实多 Agent。
- **M-B3（治理）**：T6–T9 完成 → 文案/成本/记忆/可观测达标。

每个里程碑结束跑一次[全量验证](#10-全量验证矩阵)。

---

## 2. T1 — 运行时注册表派发（P1-8）

**目标**：按 `runtimeType` 显式派发运行时；未实现类型显式失败而非静默降级到 mock。
**前置依赖**：无。**工作量**：S（~0.5d）。

**起点现状**：`runtime.service.ts` 二元判断；`codex-runtime-adapter.service.ts` / `claude-code-runtime-adapter.service.ts` 为 throw stub 且未在 `runtime.module.ts` 注册。

**改动文件**：`runtime.module.ts`、`runtime.service.ts`（必要时 `codex/claude adapter`）。

**实施步骤**：
- [ ] `runtime.module.ts` 的 providers 注册 `CodexRuntimeAdapterService`、`ClaudeCodeRuntimeAdapterService`。
- [ ] `runtime.service.ts` 构造 `Map<RuntimeType, { run }>`：`mock`、`generic_llm`、`codex`、`claude_code`（注入对应 adapter）。
- [ ] `run()` 用 Map 派发；**未注册类型**（`mcp_tool`/`human` 等）不再 fallback mock。
- [ ] 统一失败语义：用 try/catch 包裹 `adapter.run`，把 adapter 抛出的异常转成 `failed` 的 `AgentRunResult`（`error.code='CAPABILITY_BLOCKED'`，message 含 "runtime not implemented"），**保证 `recordInvocation` 仍记录**、且 orchestrator 走正常失败路径（→ `ask_user`）。
- [ ] 未知 `runtimeType` 同样返回 failed result（而非进程抛错）。

**关键骨架**：
```ts
private adapters = new Map<RuntimeType, { run(i: AgentRunInput): Promise<AgentRunResult> }>();
// constructor: set mock/generic_llm/codex/claude_code
async run(input: AgentRunInput) {
  const startedAt = nowIso();
  const adapter = this.adapters.get(input.agent.runtimeType);
  let result: AgentRunResult;
  if (!adapter) {
    result = this.unsupportedResult(input, `Unsupported runtime: ${input.agent.runtimeType}`);
  } else {
    try { result = await adapter.run(input); }
    catch (e) { result = this.unsupportedResult(input, e instanceof Error ? e.message : String(e)); }
  }
  this.recordInvocation(input, result, startedAt);
  return result;
}
```

**验收标准**：
- [ ] 某 Agent 配 `mcp_tool` 调用 → 返回 failed（非 mock 输出），会话进入 `WAIT_USER_DECISION`。
- [ ] 某 Agent 配 `codex`/`claude_code` → failed，message 指明 v2 reserved。
- [ ] 默认 `generic_llm`/`mock` 行为不变。

**验证命令**：`npm run typecheck -w @agent-cluster/server` → `npm run test:e2e:main-chain` → `npm run test:e2e:real-agents-no-seed`；[新增] `tests/e2e/runtime-routing-smoke.mjs`（断言未实现类型 failed）。

**回归风险**：低。注意 `real-session-custom-agent` 若用非 generic_llm 类型需复核。

---

## 3. T2 — 持久化连接池 + 增量写 + 事件批量（P1-6）

**目标**：消除 `execFileSync` 子进程与每事件全量写；postgres 用常驻连接池、按 key 写、事件批量 flush。
**前置依赖**：无（`writeFileState` 原子化已在 Batch 1 完成）。**工作量**：M（~1.5d）。

**起点现状**：`persistence.service.ts` 的 `readPostgresState`/`writePostgresState` 用 `execFileSync(node -e ...)` 全量；`events.service.ts` 每条 `create` 调用 `persist()`。

**改动文件**：`persistence.service.ts`、`events.service.ts`（可选新增 `common/pg-pool.ts`）。

**实施步骤**：
- [ ] `persistence.service.ts` 引入 `pg.Pool`（已是依赖）；`onModuleInit` 建池建表，`onModuleDestroy` `pool.end()`。
- [ ] `readPostgresState` 改用池查询全量加载（启动一次）。
- [ ] `writePostgresState`/`setCollection`：**按单 key upsert**（不再整 state 序列化）。
- [ ] 决策 `setCollection` 签名：保持同步签名、内部 `void pool.query(...).catch(log)`（不阻塞事件循环）；或改 async 并统一所有 `persist()` 调用方加 `.catch`。**二选一并在 PR 描述注明**（推荐前者，最小波及面）。
- [ ] `events.service.ts`：内存 push 后立即 `subjectFor().next()`（SSE 不受影响），持久化改 **200ms 合并 flush**（`dirty` 集合 + 定时器）。
- [ ] （可选增强）事件存储粒度从单 key `eventsBySession` 改 `events:<sessionId>` 分键；**兼容读取旧 key**（启动时若存在旧 key 则迁移）。
- [ ] 删除 `runPostgresPersistenceScript`（execFileSync 路径）。

**验收标准**：
- [ ] `postgres-persistence` 通过；进程重启数据完整。
- [ ] 连发 N 条事件，DB 写次数从 ≈N 降到 ≈N/批（日志或计数验证）。
- [ ] 不再 spawn 子进程（进程树无额外 node 子进程）。

**验证命令**：`npm run test:e2e:postgres-persistence` → `npm run test:e2e:persistence` → `npm run test:e2e:main-chain`。

**回归风险**：中。`setCollection` 若改 async 波及所有 `persist()`；分键改动需迁移旧 state。缓解：分两步提交（先连接池替换，后事件批量/分键）；保留旧 key 兼容读。

---

## 4. T3 — 执行可中断：补全取消与恢复（P1-9）

**目标**：让"执行中插话/暂停"真正中断执行，并支持 resume 重新推进；在途 LLM 请求可被取消。
**前置依赖**：Batch 1 的 `ExecutionService`/`runPipeline(signal)`。**工作量**：M（~1.5d）。

**起点现状（Batch 1 已完成的部分，勿重复）**：`control()`(pause/cancel) 已 `execution.cancel`；`runPipeline` 任务边界检查 `signal.aborted`。**本任务只做剩余 4 项**：

**改动文件**：`sessions.service.ts`、`sessions.module.ts`、`execution.service.ts`、`runtime.service.ts`、`generic-llm-runtime.service.ts`、`packages/shared/src/contracts.ts`（adapter 接口加可选 signal）。

**实施步骤**：
- [ ] **(a) message 插话也取消**：`sessions.service.ts` 的 `sendMessage` 在 `handlingPlan.shouldPause` 分支调用 `this.execution.cancel(sessionId)`。
- [ ] **(b) resume 重新触发**：注入 `TasksService` 到 `SessionsService`（`sessions.module.ts` import `TasksModule`）；新增 `resumeExecution(session)`：取 `currentTaskBriefId` 对应 brief + `tasks.resetStaleRunning` + `tasks.unfinished` → `execution.start(...)`；在 `control()` 中 `nextStatus==='EXECUTING'` 时调用（加 `execution.isRunning` 守卫防重复）。
- [ ] **(c) 在途 LLM 取消**：`AgentRuntimeAdapter.run` 增加可选第二参 `signal?: AbortSignal`（或 `input.options.signal`）；`RuntimeService.run` 透传；`generic-llm` 用 `AbortSignal.any([外部signal, 超时controller.signal])`；`runPipeline` 把 `signal` 透传给 `runtime.run`。
- [ ] **(d) 取消事件**：取消时 `runOneTask`/`runPipeline` 发 `runtime_failed`（`code='RUNTIME_CANCELLED'`）并让 `applyOutcome` 落 `WAIT_USER_DECISION`。
- [ ] **(e) 更新 `applyOutcome` 守卫**：被用户取消（ask_user/cancelled）后不被后续 outcome 覆盖。

**验收标准**：
- [ ] 执行中 `POST /messages`（约束）后，**不再产生该会话新的 `runtime_*` 事件**（真中断，非 soft-pause）。
- [ ] `POST /resume` 后未完成任务继续执行直至 `COMPLETED`。
- [ ] `POST /cancel` 后在途 LLM 请求被 abort（真实模式下连接关闭）。

**验证命令**：`npm run test:e2e:p1-behaviors`（**需同步更新**：从"soft-pause 自完成"改为"真暂停→resume 重新触发→完成"，更贴近原 intent）→ [新增] `tests/e2e/cancel-smoke.mjs`。

**回归风险**：中。改变插话语义（之前 soft-pause 会自完成）；`p1-behaviors` 断言需同步更新；注意 cancel→resume 的双流水线竞态（用 `isRunning` 守卫）。

---

## 5. T4 — BullMQ 真正承载执行（P1-5）

**目标**：把后台执行从进程内 Promise 切到 BullMQ 队列消费；并发/重试/跨重启由队列承担。
**前置依赖**：建议 T1 先行；复用 Batch 1 `ExecutionService`/`runPipeline`。**工作量**：L（~2d）。

**起点现状**：`ops.controller.ts` 有 `redisConnectionOptions`（仅监控用）；编排器从不入队、无 worker；`bullmq`/`ioredis` 已依赖；`RecoveryService` 已在 `ENABLE_BULLMQ=true` 时禁用（Batch 1）。

**改动文件**：新增 `common/redis.ts`、`modules/queue/execution.queue.ts`、`modules/queue/execution.worker.ts`、`modules/queue/queue.module.ts`；改 `execution.service.ts`、`ops.controller.ts`、`app.module.ts`。

**实施步骤**：
- [ ] 抽 `common/redis.ts`：把 `redisConnectionOptions()` 从 `ops.controller.ts` 移出共享。
- [ ] `ExecutionQueue`（生产）：`add('execute', {sessionId, briefId})`，`attempts`(`QUEUE_ATTEMPTS`)、`backoff` 指数、`removeOnComplete/Fail`；`onModuleDestroy` 关闭。
- [ ] `ExecutionWorker`（消费）：`onModuleInit` 仅当 `ENABLE_BULLMQ==='true'` 创建 `Worker('agent-task-queue', ...)`，`concurrency=QUEUE_CONCURRENCY`；process 内取 session+brief+`tasks.unfinished` → `orchestrator.runPipeline` → `sessions.applyOutcome`；`onModuleDestroy` 关闭。
- [ ] `ExecutionService.start`：`ENABLE_BULLMQ==='true'` → `queue.enqueue`；否则进程内 Promise（保留现状）。
- [ ] `QueueModule` 接线 + `app.module.ts` 引入；worker 注入 `OrchestratorService`/`SessionsService`/`TasksService`。
- [ ] 文档：明确队列模式下 cancel 需 job 级取消（**本任务先支持任务边界 signal；job 运行中取消标注为 v-next**）。

**验收标准**：
- [ ] `ENABLE_BULLMQ=true` + Redis：confirm 后 `GET /api/ops/queues` 的 `agent-task-queue` `active/completed > 0`（不再恒空）。
- [ ] 进程在执行中重启 → 未完成 job 由队列重试至 `COMPLETED`（无重复 `final_delivery_created`）。
- [ ] `ENABLE_BULLMQ=false` 时回退进程内执行 + RecoveryService，行为同 Batch 1。

**验证命令**：`npm run test:e2e:bullmq-ops`（**扩展**为"入队→消费→完成"）→ `npm run test:e2e:main-chain`（`ENABLE_BULLMQ=false` 回归）→ [新增] `tests/e2e/bullmq-execution-smoke.mjs`（`ENABLE_BULLMQ=true` 全链）。

**回归风险**：中高。worker 与 HTTP 同进程（单体，先这样）；幂等依赖 `runPipeline` 的"跳过 completed + 交付查重"（Batch 1 已具备）；Redis 不可用时需优雅降级或明确报错。

---

## 6. T5 — 多 Agent 讨论 + 任务依赖（P1-7）

**目标**：讨论由各 Agent 真实 runtime 产出；任务支持依赖按序执行。
**前置依赖**：无（建议最后做，影响面与成本最大）。**工作量**：L（~2d）。

**起点现状**：`discussAndCreateBrief` 硬编码 2 条 `agent_message`；`tasks.createFromSuggestions` 写死 `dependsOnTaskIds: []`。

**改动文件**：`orchestrator.service.ts`、`tasks.service.ts`。

**实施步骤**：
- [ ] **讨论多轮**：`discussAndCreateBrief` 遍历参与 Agent（`requirements`/`architect`/`backend`/`test`），各自以 `phase:'discussion'`、`expectedOutput.kind:'agent_message'` 调 runtime，产出真实 `agent_message`；coordinator 汇总成 brief（保留现有 brief_created/确认卡逻辑）。
- [ ] 参与者与轮次**可配置**（`DISCUSSION_AGENT_KEYS`、`DISCUSSION_MAX_ROUNDS`）以控 token 成本；缺省限 1 轮。
- [ ] **任务依赖**：`createFromSuggestions` 两遍——先建 `title→id` 映射，再解析 `dependsOnTaskTitles → dependsOnTaskIds`。
- [ ] `runPipeline` 改按就绪度执行：仅当 `dependsOnTaskIds` 全部 `completed` 才执行；用就绪轮询或拓扑排序；检测环路报错。

**验收标准**：
- [ ] discussion 阶段 `GET /debug/runtime-invocations` 出现多条不同 Agent 的调用。
- [ ] 构造带依赖的建议任务，执行顺序遵守依赖（被依赖者先 completed）。
- [ ] token 成本受开关与上限约束。

**验证命令**：`npm run test:e2e:main-chain`（mock 下多轮讨论不超时）→ [新增] `tests/e2e/task-dependency-smoke.mjs`、`tests/e2e/multi-agent-discussion-smoke.mjs`。

**回归风险**：中。LLM 调用次数与时延↑（真实模式成本敏感）；mock 模式影响小。务必带开关与上限。

---

## 7. T6 — 后端文案统一（P2-10）

**目标**：后端事件文案统一中文（与前端一致），抽常量表便于后续 i18n。
**前置依赖**：无。**工作量**：S（~0.5d）。

**起点现状**：`orchestrator.service.ts` 事件 content 多为英文（Batch 1 重构时**特意保留原英文**以不破坏断言）；`sessions.service.ts` 为中文。

**改动文件**：新增 `common/messages.ts`、`orchestrator.service.ts`、`sessions.service.ts`、`tests/e2e/chinese-visible-copy-smoke.mjs`。

**实施步骤**：
- [ ] 新增 `common/messages.ts` 文案常量（中文），含 task/runtime/review/delivery/artifact 等。
- [ ] `orchestrator.service.ts` 全部英文事件 content 替换为常量（≈15 处）。
- [ ] 复核 feishu draft 的 title/contentSummary 等 metadata 文案。
- [ ] 扩展 `chinese-visible-copy-smoke.mjs` 覆盖 orchestrator 事件。

**验收标准**：
- [ ] 前端时间线全中文，无中英混排。
- [ ] `chinese-copy` 扩展通过。

**验证命令**：`npm run test:e2e:chinese-copy` → `npm run test:e2e:main-chain`（**先核查** main-chain 是否断言英文 content；当前以 `type` 断言为主，content 断言少）。

**回归风险**：低-中。改 content 可能影响断言英文文案的测试 → 同 PR 更新断言。

---

## 8. T7 — Token 预算落地（P2-11）

**目标**：填充分层预算、调用前 preflight 估算、回写 `tokenUsed`。
**前置依赖**：无。**工作量**：M（~1d）。

**起点现状**：`createContextPack` 的 `budget` 恒 `{}`；`session.tokenUsed` 恒 0；`TOKEN_BUDGET_DEFAULT` 未生效。

**改动文件**：`orchestrator.service.ts`、新增 `common/token.ts`、`sessions.service.ts`（回写 tokenUsed）。

**实施步骤**：
- [ ] `common/token.ts`：`estimateTokens(text)`（字符/4 粗估）、`buildBudget(session)`（`session.tokenBudget ?? TOKEN_BUDGET_DEFAULT` 分层）。
- [ ] `createContextPack` 填充 `budget`；调用前 preflight：估算 contextPack，超预算则裁剪 `relevantEvents`/`ragSnippets`，仍超则发 `error_reported`(`TOKEN_BUDGET_EXCEEDED`)。
- [ ] 每次 runtime 返回后累计 `usage.totalTokens` 回写 `session.tokenUsed` 并 persist。

**验收标准**：
- [ ] `GET /sessions/:id/debug/token-usage` 非零且随调用递增。
- [ ] 构造超小预算 → 出现裁剪或 `TOKEN_BUDGET_EXCEEDED` 事件。

**验证命令**：`npm run test:e2e:debug-memory` → [新增] `tests/e2e/token-budget-smoke.mjs`。

**回归风险**：低。裁剪逻辑需保证不破坏必需上下文（taskBrief/currentTask 不裁）。

---

## 9. T8 — 长期记忆确认写入（P2-12）

**目标**：偏好类长期记忆改为用户确认后写入。
**前置依赖**：无。**工作量**：S（~0.5d）。

**起点现状**：`sessions.service.ts` 的 `sendMessage` 对 `preference_input` 自动 `memories.create(long_term_candidate)`。

**改动文件**：`sessions.service.ts`、`memory.controller.ts`/`memory.service.ts`（确认端点）。

**实施步骤**：
- [ ] `sendMessage` 不再直接写库；改为发 `user_confirmation_requested`（`reason='confirm_memory_write'`，payload 带候选内容）。
- [ ] 新增确认入口：`POST /sessions/:id/memories/confirm`（body 带候选内容/confirmationId），确认后 `memories.create`；并发 `user_confirmation_resolved`。
- [ ] 前端 `ConfirmationCard` 处理 `confirm_memory_write`（可后续）。

**验收标准**：
- [ ] 偏好消息后 `GET /memories` **不**立即出现该记忆。
- [ ] 确认后才出现。

**验证命令**：`npm run test:e2e:debug-memory`（**更新**为确认后写入）→ [新增] `tests/e2e/memory-confirm-smoke.mjs`。

**回归风险**：低。`debug-memory` 现有断言需更新。

---

## 10. T9 — 运行态可观测 + README 订正（P2-13）

**目标**：启动即明示运行态；文档与实现对齐。
**前置依赖**：建议 T1–T5 后做（描述更准）。**工作量**：S（~0.5d）。

**起点现状**：`main.ts` 启动日志仅打印 listening；README 关于"后台异步"在 Batch 1 后已属实但措辞需更新（confirm 现也后台、新增 recover/queue 开关）。

**改动文件**：`main.ts`、`apps/web/src/config/runtime.ts`（顶栏显示）、`README.md`、`.env.example`（补 `AGENT_CLUSTER_RECOVER_ON_BOOT`、`QUEUE_ATTEMPTS` 等新变量）。

**实施步骤**：
- [ ] `main.ts` 启动日志打印：API base、持久化后端 + 数据文件/`DATABASE_URL`、运行时模式(real/mock)、`ENABLE_BULLMQ`、`AGENT_CLUSTER_RECOVER_ON_BOOT`。
- [ ] 前端顶栏显示运行模式（real/mock + 后端 base）。
- [ ] README 订正：confirm/create 均后台、新增 ExecutionService/Recovery/Queue 说明、新增环境变量。
- [ ] `.env.example` 补齐 Batch 1/2 新增变量。

**验收标准**：
- [ ] 启动日志含上述全部字段。
- [ ] README 与实现一致（无"同步阻塞"等过期描述）。

**验证命令**：`npm run test:e2e:ops`（健康/日志路径）→ 人工核对启动日志与 README。

**回归风险**：低。

---

## 11. 全量验证矩阵

每个里程碑结束执行：

```bash
npm run typecheck          # 全 workspace
npm run build
npm run test:e2e:main-chain
npm run test:e2e:p1-behaviors
npm run test:e2e:generic-llm-real
npm run test:e2e:persistence
npm run test:e2e:postgres-persistence
npm run test:e2e:bullmq-ops
npm run test:e2e:real-data-mode
npm run test:e2e:ops
npm run test:e2e:security
npm run test:e2e:agent-create
npm run test:e2e:debug-memory
npm run test:e2e:real-agents-no-seed
npm run test:e2e:real-session-custom-agent
npm run test:e2e:chinese-copy
# 按任务新增：runtime-routing / cancel / bullmq-execution / task-dependency /
#            multi-agent-discussion / token-budget / memory-confirm
```

**每个任务的"完成定义（DoD）"**：① 该任务验收项全勾；② 上述全量矩阵相关项 PASS；③ typecheck/build 通过；④ 不破坏 v0.1 契约字段（`packages/shared/src/contracts.ts`），新增仅在 `metadata.payload` 内扩展。

---

## 12. 跨任务约束（所有任务遵守）

- **契约稳定**：不改 `contracts.ts` 既有字段/状态枚举；新增放 `metadata.payload`。前端事件派生依赖契约，破坏即回归。
- **响应语义已变**：`confirm`/`create` 为"受理 + SSE 跟进"，新增端点遵循同一风格（受理即返回，进度走事件流）。
- **开关优先**：高成本/高风险能力（多轮讨论、BullMQ、真实运行时）均带 env 开关与缺省安全值。
- **测试同改**：凡改变行为/文案，同一提交内更新对应 e2e 断言并保留原始 intent。
- **幂等**：所有"重跑/恢复/重试"路径复用 `runPipeline` 的"跳过 completed + 交付查重"，禁止重复 `final_delivery_created`。

---

## 13. 风险登记

| 风险 | 关联 | 影响 | 缓解 |
| --- | :--: | --- | --- |
| `setCollection` 异步化波及全量 persist 调用 | T2 | 编译/运行面广 | 保持同步签名内部 fire-and-forget；或分步提交 |
| 事件分键迁移破坏旧 state 读取 | T2 | 启动丢数据 | 兼容读旧 key + 迁移；先连接池后分键 |
| cancel→resume 双流水线竞态 | T3/T4 | 重复执行/状态错乱 | `execution.isRunning` 守卫；queue job 唯一 id |
| 队列模式 job 运行中无法取消 | T4 | 取消延迟到任务边界 | 先支持边界取消，job 内取消标 v-next |
| 多轮讨论 token 成本/时延↑ | T5 | 真实模式费用 | 开关 + 轮次/参与者上限 + 缺省 1 轮 |
| 文案改动破坏英文断言 | T6 | 测试红 | 同 PR 更新断言；优先 type 断言 |

---

## 14. 进度跟踪

| 任务 | 负责人 | 起 | 止 | 状态 | 备注 |
| :--: | --- | --- | --- | :--: | --- |
| T1 运行时注册表 |  |  |  | ⬜ |  |
| T2 持久化连接池 |  |  |  | ⬜ |  |
| T3 执行可中断 |  |  |  | ⬜ |  |
| T4 BullMQ 队列化 |  |  |  | ⬜ |  |
| T5 多 Agent + 依赖 |  |  |  | ⬜ |  |
| T6 文案统一 |  |  |  | ⬜ |  |
| T7 Token 预算 |  |  |  | ⬜ |  |
| T8 记忆确认写入 |  |  |  | ⬜ |  |
| T9 可观测 + README |  |  |  | ⬜ |  |

> 状态图例：⬜ 未开始 / 🟡 进行中 / ✅ 完成 / ⛔ 阻塞

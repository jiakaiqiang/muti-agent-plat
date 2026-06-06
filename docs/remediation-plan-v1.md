# Agent Cluster 修复方案（Remediation Plan）

> 生成时间：2026-06-04
> 配套问题清单见 [feature-inventory-and-status-v1.md](./feature-inventory-and-status-v1.md) 第五节。
> 本方案给出**代码级**可落地改动：每项含 根因 → 改动文件 → 关键代码 → 验证方式。
> 代码片段遵循现有风格（ESM `.js` 后缀导入、NestJS、camelCase API）。

---

## 0. 修复总览与实施批次

| 编号 | 问题 | 方案要点 | 主要改动文件 | 批次 | 量级 |
| --- | --- | --- | --- | :--: | :--: |
| P0-1 | 执行绑定 HTTP 同步 | 抽 `ExecutionService`，受理即返回，后台跑 | sessions、orchestrator、新增 execution | B1 | L |
| P0-2 | LLM 无超时/重试 | `AbortController`+退避重试，读取已有配置 | runtime-config、generic-llm-runtime | B1 | S |
| P0-3 | 状态机收尾/复盘结论被忽略 | `runExecution` 返回 outcome，按结论落状态 | orchestrator、sessions、execution | B1 | M |
| P0-4 | 重启不恢复执行 | `RecoveryService`(OnApplicationBootstrap) 扫描续跑 | 新增 recovery、tasks | B1 | M |
| P1-5 | BullMQ 未承载执行 | 真正入队 + Worker 消费，按开关切换 | 新增 queue、execution | B2 | L |
| P1-6 | Postgres 子进程全量写 | 常驻 `pg.Pool` + 按 key 增量 + 事件批量 flush | persistence、events | B2 | M |
| P1-7 | 多 Agent 协作被脚本化 | 真实多轮讨论 + 任务依赖拓扑执行 | orchestrator、tasks | B2 | L |
| P1-8 | 非 generic_llm 静默降级 mock | 注册表派发，未实现类型显式报错 | runtime.module、runtime.service | B2 | S |
| P1-9 | 执行中暂停无法中断 | 贯穿 `AbortSignal`，pause/cancel 时 abort | sessions、execution、runtime | B2 | M |
| P2-10 | 文案中英混杂 | 统一中文文案（或 i18n 表） | orchestrator | B3 | S |
| P2-11 | Token 预算空转 | 填充 budget + 调用前 preflight | orchestrator、新增 token | B3 | M |
| P2-12 | 长期记忆自动写入 | 改为确认后写入 | sessions、memory | B3 | S |
| P2-13 | 多端口易混淆/README 失真 | 启动日志打印运行态 + 修 README | main、README | B3 | S |

**实施顺序建议**：
- **Batch 1（可靠性硬门槛，必须先做）**：P0-2 → P0-1+P0-3 → P0-4。P0-2 最独立，先做立即收益；P0-1/P0-3 一起重构；P0-4 依赖 P0-1 的执行入口。
- **Batch 2（架构演进）**：P1-8（独立小改）→ P1-6 → P1-9 → P1-5（队列化，复用 P0-1 的 ExecutionService）→ P1-7。
- **Batch 3（治理/体验）**：P2 各项可并行、低风险。

---

## Batch 1 — P0 可靠性

### P0-2　Generic LLM Runtime 超时 + 重试 ⭐先做

**根因**：`runOpenAiCompatible` 直接 `await fetch`，未用 `LLM_TIMEOUT_MS`/`LLM_MAX_RETRIES`（`generic-llm-runtime.service.ts:46`）。

**改动 1**：`apps/server/src/common/runtime-config.ts` 末尾新增配置读取：

```ts
export function llmTimeoutMs() {
  const parsed = Number(process.env.LLM_TIMEOUT_MS ?? 60_000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
}

export function llmMaxRetries() {
  const parsed = Number(process.env.LLM_MAX_RETRIES ?? 2);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 2;
}
```

**改动 2**：`generic-llm-runtime.service.ts` 用 `AbortController` + 重试循环包裹请求，并区分可重试错误：

```ts
import { llmApiKey, llmBaseUrl, llmMaxRetries, llmModel, llmTimeoutMs, genericLlmMockFallbackEnabled } from '../../common/runtime-config.js';

private async runOpenAiCompatible(input: AgentRunInput): Promise<AgentRunResult> {
  const startedAt = nowIso();
  const maxRetries = llmMaxRetries();
  let lastMessage = 'unknown error';
  let lastCode: RuntimeError['code'] = 'MODEL_ERROR';

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), llmTimeoutMs());
    try {
      const response = await fetch(this.chatCompletionsUrl(), {
        method: 'POST',
        signal: controller.signal,
        headers: { authorization: `Bearer ${llmApiKey()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ /* 同现有 model/temperature/response_format/messages */ })
      });
      if (!response.ok) throw Object.assign(new Error(`LLM request failed: ${response.status}`), { retryable: response.status >= 500 || response.status === 429 });

      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: any; model?: string };
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error('LLM response did not include message content');

      const output = JSON.parse(content) as RuntimeOutput;       // schema 错误：不重试
      if (output.kind !== input.expectedOutput.kind) {
        return this.failedResult(input, startedAt, `Expected ${input.expectedOutput.kind}, got ${output.kind}`, 'OUTPUT_SCHEMA_INVALID');
      }
      return { /* 同现有 completed 结果 */ } as AgentRunResult;
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError';
      lastCode = isAbort ? 'RUNTIME_TIMEOUT' : 'MODEL_ERROR';
      lastMessage = isAbort ? `LLM timeout after ${llmTimeoutMs()}ms` : (error instanceof Error ? error.message : String(error));
      const retryable = isAbort || (error as { retryable?: boolean }).retryable !== false;
      if (!retryable || attempt === maxRetries) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));   // 指数退避 0.5s,1s,2s...
    } finally {
      clearTimeout(timer);
    }
  }
  return this.failedResult(input, startedAt, lastMessage, lastCode);
}
```

**改动 3**：`failedResult` 增加 `code` 参数（当前写死 `MODEL_ERROR`）：

```ts
private failedResult(input: AgentRunInput, startedAt: string, message: string, code: RuntimeError['code'] = 'MODEL_ERROR'): AgentRunResult {
  // ...其余不变，error 处用 code，retryable: code !== 'OUTPUT_SCHEMA_INVALID'
}
```

**验证**：`npm run typecheck -w @agent-cluster/server`；`npm run test:e2e:generic-llm-real`；临时把 `LLM_BASE_URL` 指向不可达地址，确认 ≤(timeout×(retries+1)) 内返回 `RUNTIME_TIMEOUT` 而非永久挂起。

---

### P0-1 + P0-3　执行后台化 + 状态机收尾（一起重构）⭐核心

**根因**：`confirmBrief` 在单个 HTTP 请求内 `await` 整条执行链（`sessions.controller.ts:58`→`orchestrator.service.ts:206`）；复盘 `recommendation` 未消费、任务失败即整会话 `FAILED`。

**设计**：新增 `ExecutionService` 承载"执行流水线"，把 orchestrator 的 `executeRuntimeTasks` 拆成两段——`prepareExecution`（同步、快，确认 brief + 建任务 + 发 `task_created`）与 `runPipeline`（后台、慢，执行→复盘→交付，返回 `outcome`）。`SessionsService` 受理后立即返回，后台跑完由 `outcome` 决定终态。

**新增** `apps/server/src/modules/execution/execution.service.ts`：

```ts
export type ExecutionOutcome =
  | { kind: 'delivered' }
  | { kind: 'rework'; reason: string }
  | { kind: 'ask_user'; reason: string }
  | { kind: 'failed'; reason: string };

@Injectable()
export class ExecutionService {
  private readonly running = new Map<string, AbortController>();   // 供 P1-9 取消

  constructor(private readonly orchestrator: OrchestratorService, private readonly sessions: SessionStore /* 见下 */) {}

  /** 后台启动，立即返回，不阻塞 HTTP */
  start(session: SessionDetail, brief: TaskBrief, tasks: AgentTask[]) {
    const controller = new AbortController();
    this.running.set(session.id, controller);
    void this.orchestrator
      .runPipeline(session, brief, tasks, controller.signal)        // 返回 ExecutionOutcome
      .then((outcome) => this.sessions.applyOutcome(session.id, outcome))
      .catch((error) => this.sessions.applyOutcome(session.id, { kind: 'failed', reason: String(error) }))
      .finally(() => this.running.delete(session.id));
  }

  cancel(sessionId: string) { this.running.get(sessionId)?.abort(); }
  isRunning(sessionId: string) { return this.running.has(sessionId); }
}
```

> 为避免 `orchestrator ↔ sessions` 循环依赖，把"设状态"能力抽成窄接口 `SessionStore`（仅 `applyOutcome`/`getRaw`），由 SessionsService 实现并通过 token 注入；或更简单：ExecutionService 不回调 sessions，而是**只发事件 + 改 task 状态**，由 SessionsService 在 `start` 返回的 Promise 上 `applyOutcome`。推荐后者（见下方 sessions 改法），可省去新接口。

**改 `orchestrator.service.ts`**：把 `confirmBrief` 拆开，新增 `prepareExecution` 与 `runPipeline`：

```ts
/** 同步、快：确认 brief、建任务、发 task_created */
prepareExecution(session: SessionDetail, briefId: string): { brief: TaskBrief; tasks: AgentTask[] } {
  const brief = this.getBrief(session.id, briefId);
  if (!brief) throw new Error(`Brief not found: ${briefId}`);
  brief.confirmedByUser = true; brief.confirmedAt = nowIso(); this.persistBriefs();
  const agentIdByKey = new Map(this.agents.list().map((a) => [a.key, a.id]));
  const suggestions = this.suggestedTasksByBriefId.get(brief.id) ?? this.defaultSuggestedTasks();
  const tasks = this.tasks.createFromSuggestions(session.id, suggestions, agentIdByKey);
  this.events.create({ sessionId: session.id, type: 'brief_confirmed', /* ... */ });
  for (const task of tasks) this.events.create({ /* task_created，同现有 */ });
  return { brief, tasks };
}

/** 后台、慢：执行→复盘→交付；不再 throw，统一返回 outcome */
async runPipeline(session: SessionDetail, brief: TaskBrief, tasks: AgentTask[], signal?: AbortSignal): Promise<ExecutionOutcome> {
  for (const task of tasks) {
    if (signal?.aborted) return { kind: 'ask_user', reason: 'cancelled-by-user' };   // P1-9
    const result = await this.runOneTask(session, brief, task);                       // 由现有循环体抽出
    if (!result.ok) return { kind: 'ask_user', reason: `task ${task.title} failed: ${result.message}` }; // P0-3：失败→等用户，不再整会话 FAILED
  }
  const review = await this.runPostReview(session, brief);          // 返回 PostReviewReportOutput
  if (review.recommendation === 'rework')   return { kind: 'rework',   reason: review.mismatchedItems.join('; ') }; // P0-3
  if (review.recommendation === 'ask_user') return { kind: 'ask_user', reason: review.mismatchedItems.join('; ') };
  await this.runFinalDelivery(session, brief);                       // 仅 deliver 才交付
  return { kind: 'delivered' };
}
```

> `runOneTask`/`runPostReview`/`runFinalDelivery` 即把现有 `executeRuntimeTasks`（`orchestrator.service.ts:206-453`）按段拆分，逻辑搬运即可，无需重写。

**改 `sessions.service.ts`**：

```ts
async confirmBrief(sessionId: string, briefId: string) {
  const session = this.get(sessionId);
  const { brief, tasks } = this.orchestrator.prepareExecution(session, briefId); // 同步、快
  this.setStatus(session, 'EXECUTING');
  this.execution.start(session, brief, tasks);                       // 后台跑，不 await
  return { accepted: true, sessionId: session.id, status: session.status, createdTasks: tasks };
}

/** 由后台流水线完成时回调 */
applyOutcome(sessionId: string, outcome: ExecutionOutcome) {
  const session = this.sessions.get(sessionId);
  if (!session || session.status === 'CANCELLED') return;            // 已取消则不覆盖
  if (outcome.kind === 'delivered') this.setStatus(session, 'COMPLETED');
  else if (outcome.kind === 'rework') this.setStatus(session, 'REWORKING');
  else this.setStatus(session, 'WAIT_USER_DECISION');               // ask_user / failed
  if (outcome.kind !== 'delivered') {
    this.events.create({ sessionId, type: 'session_status_changed', priority: 'high',
      content: `执行结束：${outcome.kind}（${'reason' in outcome ? outcome.reason : ''}）`,
      metadata: createMetadata('system_notice', { status: session.status, outcome }) });
  }
}
```

**改 `sessions.controller.ts`**：`confirmBrief` 现在立即返回 `{accepted:true,...}`（已是 `.then(ok)`，无需改签名，响应体语义变化即可）。

**改 `create()`**（同样别阻塞）：把 `await this.orchestrator.discussAndCreateBrief(session)` 改为后台执行：

```ts
this.events.create({ /* user_message */ });
this.setStatus(session, 'AGENT_DISCUSSING');
void this.orchestrator.discussAndCreateBrief(session)
  .then((brief) => { session.currentTaskBriefId = brief.id; this.setStatus(session, 'WAIT_USER_CONFIRM'); })
  .catch((error) => this.failSession(session, error, 'brief_generation'));
return { session, firstEvent };       // 立即返回，前端经 SSE 看到 brief_created
```

**模块接线**：新增 `ExecutionModule`（providers: `ExecutionService`，imports: `OrchestratorModule`），`SessionsModule` 导入它；`OrchestratorModule` 导出 `OrchestratorService`（应已导出）。

**验证**：`npm run test:e2e:main-chain`（确认主链仍走通，注意断言可能要改：confirm 返回体由"最终结果"变为"已受理"）；新增用例：confirm 后立即收到 200，再轮询/SSE 看到 `final_delivery_created`；构造复盘 `rework` 场景（mock `outputFor` 的 `post_review_report` 返回 `recommendation:'rework'`）确认会话进入 `REWORKING`。

---

### P0-4　服务重启后执行恢复

**根因**：构造函数只恢复数据，不恢复执行；运行中任务永久停滞，无 recover/retry 入口。

**改动 1**：`tasks.service.ts` 增加未完成任务查询与"重置 running→pending"（幂等续跑）：

```ts
unfinished(sessionId: string) {
  return this.list(sessionId).filter((t) => ['pending', 'running', 'claimed', 'waiting', 'reworking'].includes(t.status));
}
resetStaleRunning(sessionId: string) {
  for (const t of this.list(sessionId)) if (t.status === 'running') this.update(t, { status: 'pending' });
}
```

**改动 2**：新增 `apps/server/src/modules/recovery/recovery.service.ts`：

```ts
@Injectable()
export class RecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RecoveryService.name);
  constructor(private readonly sessions: SessionsService, private readonly tasks: TasksService,
              private readonly orchestrator: OrchestratorService, private readonly execution: ExecutionService) {}

  async onApplicationBootstrap() {
    for (const session of this.sessions.listRaw()) {                 // 新增 listRaw() 返回 SessionDetail[]
      if (!['EXECUTING', 'POST_REVIEW', 'REWORKING'].includes(session.status)) continue;
      const brief = this.orchestrator.listBriefs(session.id).find((b) => b.id === session.currentTaskBriefId);
      if (!brief) { this.sessions.applyOutcome(session.id, { kind: 'ask_user', reason: 'recovery: brief missing' }); continue; }
      this.tasks.resetStaleRunning(session.id);
      const remaining = this.tasks.unfinished(session.id);
      this.logger.log(`Recovering session ${session.id}: ${remaining.length} unfinished tasks`);
      this.execution.start(session, brief, remaining.length ? remaining : this.tasks.list(session.id));
    }
  }
}
```

**幂等注意**：`runOneTask` 对已 `completed` 的任务应跳过；交付前检查是否已存在 `final_delivery_created` 事件（避免重复交付）——`sessions.service.hasFinalDelivery` 已有此判断，复用它。

**开关**：受 `AGENT_CLUSTER_RECOVER_ON_BOOT`（默认 true）控制，便于测试关闭。

**验证**：新增 `tests/e2e/recovery-smoke.mjs`——启动→confirm→进程未完成即重启→断言会话最终到 `COMPLETED`/`WAIT_USER_DECISION` 且无重复 `final_delivery_created`。

> 说明：启用 BullMQ（P1-5）后，跨重启恢复由队列 `attempts` 天然承担，本 RecoveryService 仅在**进程内后台模式**（`ENABLE_BULLMQ=false`）启用。

---

## Batch 2 — P1 架构

### P1-8　运行时注册表派发（独立小改，建议 B2 先做）

**根因**：`runtime.service.ts:43` 二元判断，非 generic_llm 静默 fallback mock；Codex/Claude 适配器未注册。

**改 `runtime.module.ts`**：注册两个已存在的适配器：

```ts
providers: [RuntimeService, MockRuntimeService, GenericLlmRuntimeService, CodexRuntimeAdapterService, ClaudeCodeRuntimeAdapterService],
```

**改 `runtime.service.ts`**：用 Map 派发，未知/未实现类型显式失败：

```ts
private readonly adapters = new Map<RuntimeType, { run(i: AgentRunInput): Promise<AgentRunResult> }>();
constructor(/* 注入 */ ) {
  this.adapters.set('mock', mockRuntime);
  this.adapters.set('generic_llm', genericLlmRuntime);
  this.adapters.set('codex', codexAdapter);
  this.adapters.set('claude_code', claudeAdapter);
}
async run(input: AgentRunInput) {
  const adapter = this.adapters.get(input.agent.runtimeType);
  if (!adapter) throw new Error(`Unsupported runtime: ${input.agent.runtimeType}`); // 不再静默 mock
  const result = await adapter.run(input);
  this.recordInvocation(input, result, startedAt);
  return result;
}
```

**验证**：把某 Agent 配为 `mcp_tool` 调用，应得明确错误而非 mock 结果；`npm run test:e2e:main-chain` 不回归。

---

### P1-6　持久化：常驻连接池 + 增量写 + 事件批量

**根因**：`execFileSync` 每次起子进程 + 全量 upsert；`events.create` 每条都 `persist()`（`persistence.service.ts:103`、`events.service.ts:51`）。

**改 `persistence.service.ts`**：用 `pg.Pool`（已是依赖）替换子进程，`setCollection` 改为异步单 key upsert：

```ts
import { Pool } from 'pg';
private pool?: Pool;
private ensurePool() { return (this.pool ??= new Pool({ connectionString: this.databaseUrl, max: 4 })); }

async setCollection<T>(key: string, value: T) {
  this.state[key] = this.clone(value);
  if (!this.enabled) return;
  if (this.backend !== 'postgres') return this.writeFileState();
  await this.ensurePool().query(
    `insert into ${this.postgresCollectionTable}(key,value,updated_at) values($1,$2::jsonb,now())
     on conflict(key) do update set value=excluded.value, updated_at=now()`,
    [key, JSON.stringify(value)]);            // 仅写单 key，不再全量
}
async onModuleDestroy() { await this.pool?.end(); }
```

> 注意：`setCollection` 变 async 会波及所有调用方（多为"fire-and-forget"，可不 await，但需 `.catch` 兜底日志）。最小风险做法：保留同步签名，内部 `void this.ensurePool().query(...).catch(...)`，牺牲强一致换取不阻塞。建议二者权衡后选其一并统一。

**改 `events.service.ts`**：事件批量 flush，降低写放大：

```ts
private dirty = new Set<string>();
private flushTimer?: NodeJS.Timeout;
create(input) {
  /* ...push 到内存... */
  this.scheduleFlush(input.sessionId);
  this.subjectFor(input.sessionId).next(event);   // SSE 立即推，体验不受 flush 影响
  return event;
}
private scheduleFlush(sessionId: string) {
  this.dirty.add(sessionId);
  this.flushTimer ??= setTimeout(() => this.flush(), 200);   // 200ms 合并窗口
}
private flush() { for (const id of this.dirty) this.persistence.setCollection(`events:${id}`, this.eventsBySession.get(id)); this.dirty.clear(); this.flushTimer = undefined; }
```

> 顺带把存储粒度从单 key `eventsBySession`（全量）改为 `events:<sessionId>`（分会话），进一步减小每次写体积。需同步调整启动加载逻辑。

**验证**：`npm run test:e2e:postgres-persistence`、`npm run test:e2e:persistence`；压测：连发 N 条事件，确认 DB 写次数从 N 降到 ≈N/批。

---

### P1-9　执行可中断（取消令牌）

**根因**：`WAIT_USER_DECISION`/`cancel` 只改状态，跑着的循环不停（`sessions.service.ts:145`）。

**做法**：P0-1 的 `ExecutionService` 已持有 `Map<sessionId, AbortController>`；`runPipeline` 每个任务前检查 `signal.aborted`（已在 P0-1 骨架中）。补：

- `sessions.control()` 在切到 `WAIT_USER_DECISION`/`CANCELLED` 时调用 `this.execution.cancel(sessionId)`。
- `generic-llm-runtime` 的 `run` 接受并透传 `signal` 给 `fetch`（与 P0-2 的 controller 合并：外部 signal abort 时连带取消在途请求）。

**验证**：执行中 `POST /cancel`，确认后续不再产生该会话的 `runtime_*` 事件。

---

### P1-5　BullMQ 真正承载执行

**根因**：编排器从不入队、无 worker（`ops.controller.ts` 仅读计数）。

**做法**：新增 `QueueModule`，把"后台执行"从进程内 Promise 切换为队列任务（复用 P0-1 的 `ExecutionService.runPipeline`）。用 `ENABLE_BULLMQ` 切换两种执行后端。

**新增 `apps/server/src/modules/queue/execution.queue.ts`（生产端）**：

```ts
@Injectable()
export class ExecutionQueue implements OnModuleDestroy {
  private readonly queue = new Queue('agent-task-queue', { connection: redisConnection(), prefix: process.env.BULLMQ_PREFIX });
  async enqueue(sessionId: string, briefId: string) {
    await this.queue.add('execute', { sessionId, briefId }, { attempts: Number(process.env.QUEUE_ATTEMPTS ?? 3), backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 100, removeOnFail: 200 });
  }
  async onModuleDestroy() { await this.queue.close(); }
}
```

**新增 worker（消费端）`execution.worker.ts`**：

```ts
@Injectable()
export class ExecutionWorker implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker;
  constructor(private readonly orchestrator: OrchestratorService, private readonly sessions: SessionsService) {}
  onModuleInit() {
    if (process.env.ENABLE_BULLMQ !== 'true') return;
    this.worker = new Worker('agent-task-queue', async (job) => {
      const { sessionId, briefId } = job.data;
      const session = this.sessions.get(sessionId);
      const brief = this.orchestrator.listBriefs(sessionId).find((b) => b.id === briefId)!;
      const outcome = await this.orchestrator.runPipeline(session, brief, this.tasks.unfinished(sessionId));
      this.sessions.applyOutcome(sessionId, outcome);
    }, { connection: redisConnection(), prefix: process.env.BULLMQ_PREFIX, concurrency: Number(process.env.QUEUE_CONCURRENCY ?? 4) });
  }
  async onModuleDestroy() { await this.worker?.close(); }
}
```

**改 `ExecutionService.start`**：`ENABLE_BULLMQ==='true'` 时 `enqueue`，否则走进程内 Promise（P0-1 路径）。`redisConnection()` 复用 `ops.controller.ts` 的 `redisConnectionOptions()`（抽到 `common/redis.ts` 共享）。

**收益**：并发、自动重试（`attempts`+`backoff`）、跨重启恢复（任务在 Redis，替代 P0-4 的进程内恢复）、削峰。

**验证**：`ENABLE_BULLMQ=true` 起服务 + Redis，confirm 后 `GET /api/ops/queues` 看到 `agent-task-queue` 有 active/completed 计数（不再恒空）；`npm run test:e2e:bullmq-ops` 扩展为"入队→消费→完成"。

---

### P1-7　真实多 Agent 讨论 + 任务依赖

**根因**：讨论是 2 条硬编码消息；`dependsOnTaskIds` 恒空、顺序执行（`orchestrator.service.ts:93`、`tasks.service.ts:25`）。

**讨论多轮化**：`discussAndCreateBrief` 改为遍历参与 Agent，依次以 `phase:'discussion'` 调用各自 runtime 产出 `agent_message`，coordinator 汇总：

```ts
const speakers = ['requirements', 'architect', 'backend', 'test'];
for (const key of speakers) {
  const agent = this.pickSessionAgent(session, [key]);
  const r = await this.runtime.run({ runId: crypto.randomUUID(), sessionId: session.id, phase: 'discussion',
    agent: this.toRuntimeAgent(agent), contextPack: this.createContextPack(session, agent),
    expectedOutput: { kind: 'agent_message', schemaVersion: '0.1' }, budget: {} });
  if (r.status === 'completed') this.events.create({ sessionId: session.id, type: 'agent_message', fromAgentId: agent.id,
    content: (r.output as AgentMessageOutput).content, metadata: createMetadata('chat_message', { messageKind: 'discussion' }) });
}
// 之后 coordinator 汇总 brief（现有逻辑）
```

**任务依赖**：`createFromSuggestions` 解析 `dependsOnTaskTitles`→`dependsOnTaskIds`（两遍：先建 title→id 映射）；`runPipeline` 按就绪度执行（依赖全 `completed` 才可跑），简单实现为拓扑排序或循环挑选就绪任务。

**验证**：discussion 阶段 `runtime_invocations` 出现多条 agent 调用；构造带依赖的建议任务，确认执行顺序遵守依赖。

> 说明：此项改动面大且影响 token 成本，建议放 B2 末尾，且讨论 Agent 数量/轮次可配置以控成本。

---

## Batch 3 — P2 治理与体验

### P2-10　统一后端文案
`orchestrator.service.ts` 所有 `events.create` 的英文 `content`（"Created task…""Started task…"等，约 15 处）改为中文，与 `sessions.service.ts` 一致。建议同时抽一个 `messages.ts` 文案常量表，便于后续 i18n。**验证**：`npm run test:e2e:chinese-copy` 扩展覆盖 orchestrator 事件。

### P2-11　Token 预算落地
- `createContextPack` 的 `budget` 由 `{}` 改为按 `session.tokenBudget ?? TOKEN_BUDGET_DEFAULT` 分层填充。
- runtime 调用前做 preflight：估算 `contextPack` token（字符数/4 粗估），超预算则裁剪 `relevantEvents`/`ragSnippets` 或产出 `error_reported`。
- 累计 `usage.totalTokens` 回写 `session.tokenUsed`（当前恒为 0）。**验证**：`debug/token-usage` 返回非零并随调用增长。

### P2-12　长期记忆确认后写入
`sessions.service.ts:135` 不再直接 `memories.create`，改为发 `user_confirmation_requested`（reason: `confirm_memory_write`）；用户确认（新增 `POST /sessions/:id/memories/:candidateId/confirm` 或复用 control）后才落库。**验证**：偏好类消息不立即出现在 `GET /memories`，确认后才出现。

### P2-13　运行态可观测 + 文档订正
- `main.ts` 启动日志补充：`API base`、`持久化后端 + 数据文件路径`、`运行时模式（real/mock）`、`BullMQ 开关`，并在前端顶栏显示（`config/runtime.ts`）。
- 修 `README.md`：把"`generateBriefInBackground` 异步"措辞与实际实现对齐（P0-1 落地后即为真正后台，可保留但需更新函数名/描述）。

---

## 验证清单（每批完成后跑）

```bash
npm run typecheck            # 全 workspace 类型检查
npm run build                # 编译
npm run lint
npm run test:e2e:main-chain          # P0-1/P0-3 主链
npm run test:e2e:p1-behaviors        # 插话/SSE/状态迁移
npm run test:e2e:generic-llm-real    # P0-2
npm run test:e2e:postgres-persistence # P1-6
npm run test:e2e:bullmq-ops          # P1-5
npm run test:e2e:persistence
# 新增建议：recovery-smoke（P0-4）、cancel-smoke（P1-9）
```

## 回归风险提示
- **P0-1 改变 `confirm`/`create` 响应语义**（从"返回最终结果"→"返回已受理"）：前端 `session.ts`/`event.ts` 与 e2e 断言需同步调整为"受理 + SSE 跟进"。
- **P1-6 `setCollection` 若改 async**：波及所有 Service 的 `persist()` 调用，需统一处理。
- **P1-7 多轮讨论增加 LLM 调用次数**：直接影响 token 成本与时延，需可配置开关与上限。
- 所有改动保持 **v0.1 契约字段不变**（`packages/shared/src/contracts.ts`）；新增仅在 `metadata.payload` 内扩展，避免破坏前端事件派生。

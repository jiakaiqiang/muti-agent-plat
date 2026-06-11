# Agent Cluster 修复任务执行计划（Batch 2 / Batch 3）当前状态

> 更新时间：2026-06-11
> 上游文档：[remediation-plan-v1.md](./remediation-plan-v1.md)、[feature-inventory-and-status-v1.md](../analysis/feature-inventory-and-status-v1.md)。
> 本文已经从“待执行计划”更新为“执行状态与剩余工作”。旧版中标为未开始的 T1-T9 多数已在当前工作树落地。

## 1. 执行结论

Batch 2 / Batch 3 的主干目标已经完成：运行时显式派发、PostgreSQL 连接池持久化、事件批量 flush、执行取消/恢复、BullMQ 执行队列、多 Agent 讨论、任务依赖、中文文案、token 预算、记忆确认写入和运行态可观测均已进入代码实现，并有对应 e2e 或 smoke 脚本。

剩余工作不再是原计划的 P0/P1 修复，而是 v2 生产化增强：真实代码代理 runtime、真实高风险工具、pgvector/embedding、细粒度数据库 schema、任务级并发认领、diff 审阅和真实外部通知。

## 2. Batch 2 / 3 状态表

| 任务 | 原问题 | 当前状态 | 证据 |
| --- | --- | --- | --- |
| T1 运行时注册表派发 | P1-8 | 已完成 | `apps/server/src/modules/runtimes/runtime.service.ts` 使用 `Map<RuntimeType, AgentRuntimeAdapter>`；`runtime-routing-smoke` 覆盖未实现 runtime 显式失败。 |
| T2 持久化连接池 + 增量写 + 事件批量 | P1-6 | 已完成核心目标 | `PersistenceService` 使用 `pg.Pool` 单 key upsert；`EventsService` 200ms 合并写入 `eventsBySession`；仍未拆分为细粒度事件表。 |
| T3 执行可中断 | P1-9 | 已完成 | `ExecutionService`、`ExecutionQueue` 持有 AbortController；generic/mock runtime 接收 `AbortSignal`；`cancel-smoke` 覆盖取消。 |
| T4 BullMQ 真正承载执行 | P1-5 | 已完成 | `ExecutionQueue`/`ExecutionWorker` 生产和消费 `agent-task-queue`；`ENABLE_BULLMQ` 控制；`bullmq-ops-smoke` 覆盖队列观测。 |
| T5 多 Agent 讨论 + 任务依赖 | P1-7 | 已完成 | `runDiscussion` 按 `DISCUSSION_AGENT_KEYS`/轮次调用 runtime；`TasksService` 解析 `dependsOnTaskTitles`；`task-dependency`、`multi-agent-discussion` 覆盖。 |
| T6 后端文案统一 | P2-10 | 已完成 | `apps/server/src/common/messages.ts` 集中中文文案；`chinese-visible-copy-smoke` 防回潮。 |
| T7 Token 预算落地 | P2-11 | 已完成 | `common/token.ts`、`runRuntime` preflight、`session.tokenUsed` 回写；`token-budget-smoke` 覆盖。 |
| T8 长期记忆确认写入 | P2-12 | 已完成 | `sendMessage` 生成 `confirm_memory_write` 确认卡；`POST /memories/confirm` 后写入；`memory-confirm-smoke` 覆盖。 |
| T9 运行态可观测 + README | P2-13 | 已完成 | `main.ts` 启动日志输出 runtime/persistence/data/BullMQ/recovery；README 和 devops 文档说明真实优先模式。 |

## 3. 当前实现细节

### 3.1 执行后台化与队列化

- `confirmBrief` 不再等待整条执行链完成，而是创建任务后返回 `{ accepted: true }`。
- `ExecutionService.start` 在 `ENABLE_BULLMQ=false` 时启动进程内后台 pipeline；在 `ENABLE_BULLMQ=true` 时投递 BullMQ job。
- `ExecutionWorker` 从 `agent-task-queue` 读取 `{ sessionId, briefId }`，恢复 unfinished tasks 并调用 `runPipeline`。
- `RecoveryService` 只在非 BullMQ 模式启用，启动时恢复中断的 `EXECUTING/POST_REVIEW/REWORKING` 会话。

### 3.2 状态机、返工和用户决策

- `runPipeline` 统一返回 `ExecutionOutcome`：`delivered`、`rework`、`ask_user`、`cancelled`、`failed`。
- `applyOutcome` 消费 outcome 并避免覆盖 `CANCELLED/COMPLETED/WAIT_USER_DECISION` 等用户决策状态。
- `rework` 会触发自动返工，受 `REWORK_MAX_ROUNDS` 限制；超限后转为用户确认。
- 用户补充需求可重新打开 brief 生成循环，取消未完成任务，并把相关上下文写入 session memory。

### 3.3 Runtime 与 token 治理

- `RuntimeService` 使用注册表派发，不支持的 runtime 返回 `CAPABILITY_BLOCKED`，并保留 invocation log。
- `GenericLlmRuntimeService` 支持超时、退避重试、取消信号、缺配置显式失败和 Ollama/OpenAI-compatible 连接。
- `fitContextToBudget` 会逐级裁剪事件、RAG、artifact 和 workspace snapshot 内容；仍超预算时发 `TOKEN_BUDGET_EXCEEDED`。

### 3.4 工作区感知与产物写回

- 前端 `localWorkspace` store 扫描目录并过滤敏感/超限文件。
- `workspaceSnapshot` 随会话创建传给后端，进入 context pack。
- 编排器生成工作区分析 artifact，并在执行产物 metadata 中携带 `fileChanges`。
- 浏览器端可将 artifact 文件变更写回用户选择的本地目录；server-local 会话可写 `agent-output/`。

## 4. 剩余路线图

| 优先级 | 后续任务 | 说明 |
| --- | --- | --- |
| V2-P0 | Codex / Claude Code runtime 真实接入 | 当前 adapter 已注册但显式 failed；下一步需要进程执行、workspace sandbox、日志、取消和用户确认。 |
| V2-P0 | 高风险工具端到端执行 | `file_write`、`command_run` 等能力只做策略门控；真实执行前必须补审计、确认和回滚。 |
| V2-P1 | pgvector/embedding RAG | 替换本地关键词检索，增加权限、索引、召回质量和回归测试。 |
| V2-P1 | 细粒度数据库 schema | 从 JSONB collection 迁移到 sessions/events/tasks/artifacts/runtime_invocations 等表。 |
| V2-P1 | 任务级并发调度 | 当前是 ready task 循环；后续可把 task 粒度入队，使用 claimed/lock 做并发认领。 |
| V2-P1 | 文件变更 diff 审阅 | 前端在写回前展示 before/after diff，支持逐文件确认、跳过、冲突提示。 |
| V2-P2 | 真实飞书发送 | 当前只创建草稿和 dry-run tool 事件；后续接真实 API 并保留显式确认。 |
| V2-P2 | 工作流模板化 | 将架构分析等特化逻辑从通用 orchestrator 抽成 workflow/template。 |

## 5. 推荐验证矩阵

每次修改执行链、Runtime、持久化或工作区相关能力后至少运行：

```bash
npm run typecheck
npm run build
npm run test:e2e:main-chain
npm run test:e2e:p1-behaviors
npm run test:e2e:runtime-routing
npm run test:e2e:task-dependency
npm run test:e2e:multi-agent-discussion
npm run test:e2e:rework-loop
npm run test:e2e:cancel
npm run test:e2e:recovery
npm run test:e2e:memory-confirm
npm run test:e2e:token-budget
npm run test:e2e:artifact-file-changes
npm run test:e2e:workspace-snapshot-payload
npm run test:e2e:postgres-persistence
npm run test:e2e:bullmq-ops
```

发布前仍应补跑 `ops`、`security`、`real-data-mode`、`generic-llm-real`、`chinese-copy` 和 `test:harness`。

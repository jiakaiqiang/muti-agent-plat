# Agent Cluster 功能清单与当前状态

> 更新时间：2026-06-11
> 适用版本：`agent-cluster@0.1.0` 当前工作树
> 本文基于 `apps/server/`、`apps/web/`、`packages/shared/`、`tests/e2e/` 和现有质量文档重新盘点。旧版 2026-06-04 的 P0/P1 问题多数已经修复，不再作为当前事实来源。

## 1. 总体结论

Agent Cluster 当前已经从“v1 dry-run 演示闭环”推进到“真实优先、后台执行、可恢复、可观测”的 v1+ 状态。核心链路已经具备：会话创建、工作区快照、Agent 讨论、任务契约确认、后台执行、RAG/Memory 注入、复盘、自动返工、最终交付、飞书通知草稿、文件变更产物、SSE 事件驱动 UI 和多组 e2e 冒烟测试。

当前仍不应把它描述为完整生产级真实研发平台。主要剩余缺口集中在：真实 Codex/Claude/MCP/Human runtime 未落地、RAG 仍是本地关键词检索、外部通知仍为 dry-run、工作区写入缺少 before/after diff 审阅、任务执行尚未实现真正并发认领和细粒度业务表。

## 2. 当前架构

```text
apps/web (Vue 3 + Pinia)
  SessionWorkspace
  ├─ chat / workflow / collaboration_graph / debug
  ├─ Agent / Knowledge / Models / Tools / Notifications 管理入口
  ├─ File System Access 工作区扫描与 fileChanges 写回
  └─ SSE + REST，所有主视图由 collaboration_events 派生

apps/server (NestJS)
  sessions -> orchestrator -> execution -> runtimes
     │            │             ├─ in-process background pipeline
     │            │             └─ BullMQ agent-task-queue worker
     │            ├─ tasks / events / artifacts
     │            ├─ rag / memory / capabilities
     │            └─ workspace snapshot + fileChanges
  persistence(file JSON / PostgreSQL JSONB collection)
  recovery(on boot, non-BullMQ mode)
  ops/debug endpoints

packages/shared
  Contract types, default agents, metadata, mock fixtures
```

## 3. 能力状态

状态图例：`完成` = 当前代码已有闭环和测试保护；`部分` = 有可用骨架但仍有限制；`预留` = 合同或适配器存在但真实能力未接入。

| 领域 | 状态 | 当前事实 |
| --- | --- | --- |
| 会话创建与事件流 | 完成 | `POST /api/sessions` 创建会话并立即返回；brief 生成在后台执行；前端通过 SSE 和事件回补跟进。 |
| 多 Agent 讨论 | 完成 | `DISCUSSION_AGENT_KEYS`、`DISCUSSION_MAX_ROUNDS`、`DISCUSSION_TIMEOUT_MS` 控制讨论参与者、轮次和超时；超时会降级为风险消息继续生成 brief。 |
| 任务契约 | 完成 | Coordinator 生成 `TaskBrief`，保存建议任务，创建 brief markdown 产物和确认卡；用户可确认或要求修订。 |
| 执行后台化 | 完成 | `ExecutionService` 让 HTTP 只返回受理结果；实际任务、复盘、交付在后台流水线或 BullMQ worker 中推进。 |
| 执行取消与恢复 | 完成 | in-process 模式下持有 `AbortController`；pause/cancel 可中断运行时；resume 重置 stale running 任务后继续；`RecoveryService` 启动时恢复未完成执行。 |
| BullMQ 队列 | 完成 | `ENABLE_BULLMQ=true` 时执行入 `agent-task-queue`，worker 消费并使用 job id 保证幂等；`GET /api/ops/queues` 读取队列计数。 |
| 状态机与复盘 | 完成 | `runPipeline` 返回 `delivered/rework/ask_user/cancelled/failed`；`applyOutcome` 消费复盘建议，自动返工受 `REWORK_MAX_ROUNDS` 限制。 |
| 任务依赖 | 完成 | `SuggestedAgentTask.dependsOnTaskTitles` 会解析为 `dependsOnTaskIds`，执行时只选择依赖已完成的 ready task。 |
| Runtime 路由 | 完成 | `RuntimeService` 使用注册表派发 `mock/generic_llm/codex/claude_code`；未实现或未注册 runtime 显式 failed，不再静默回退 mock。 |
| Generic LLM | 完成 | OpenAI-compatible/Ollama endpoint；缺配置时失败可见；支持超时、退避重试、取消信号和结构化 JSON 输出校验。 |
| Mock Runtime | 完成 | 支持确定性 dry-run、延迟、失败率、工作区 fileChanges 和多种输出 kind，供本地/e2e 使用。 |
| Codex/Claude/MCP/Human Runtime | 预留 | `codex`、`claude_code` adapter 已注册但返回未实现；`mcp_tool`、`human` 仍未接入真实执行。 |
| RAG | 部分 | 知识库 CRUD、文档录入、关键词检索、`rag_retrieved` 事件和 context pack 注入已可用；pgvector/embedding 仍未落地。 |
| Memory | 完成 | session memory 创建/检索/注入；偏好类消息先发确认卡，`POST /memories/confirm` 后才写长期记忆候选。 |
| Capability governance | 部分 | 能力注册、风险分级、check/approve 可用；真实高风险工具执行仍默认关闭且未做端到端真实工具链。 |
| Artifacts | 完成 | brief、执行结果、复盘、最终交付、通知草稿均创建 artifact；metadata 支持 `fileChanges`。 |
| 工作区感知 | 完成 | 前端可扫描本地目录并上传 `workspaceSnapshot`；后端可解析 server-local 路径；运行时基于真实文件结构生成影响面和 fileChanges。 |
| 文件变更写回 | 部分 | 浏览器端可应用 artifact `fileChanges`；server-local 会话可写 `agent-output/`；缺少 before/after diff 审阅和细粒度冲突处理。 |
| 飞书通知 | 部分 | 最终交付会创建 `feishu_draft` artifact 和确认卡；确认后记录 dry-run tool 完成事件；不会调用真实飞书接口。 |
| 前端工作台 | 完成 | 三栏工作台、群聊、工作流、协作图、debug、Agent/Knowledge/Model/Tool/Notification 管理入口和中文可见文案。 |
| 持久化 | 部分 | file backend 原子 rename；PostgreSQL backend 使用常驻 `pg.Pool` 和 JSONB collection 单 key upsert；尚未拆成细粒度关系表。 |
| 可观测性 | 完成 | 启动日志输出 runtime/persistence/data/BullMQ/recovery；debug API 暴露 context packs、runtime invocations、RAG 和 token usage。 |
| Token 预算 | 完成 | `buildBudget`、`fitContextToBudget` 做估算、裁剪和超预算失败事件；runtime usage 回写 `session.tokenUsed`。 |

## 4. 当前主流程

### 4.1 新会话到任务契约

1. 前端可选本地工作区，扫描生成 `WorkspaceSnapshot`。
2. `POST /api/sessions` 创建 `AGENT_DISCUSSING` 会话并写首条 `user_message`。
3. `SessionsService.generateBriefInBackground` 后台调用 `OrchestratorService.discussAndCreateBrief`。
4. 如有工作区快照，先生成工作区分析消息和 `agent-output/workspace-analysis.md` 产物。
5. 多 Agent 讨论按配置轮次运行；讨论超时不会阻断 brief。
6. Coordinator 生成 `brief_created`、brief artifact 和 `user_confirmation_requested`。

### 4.2 确认后执行

1. `POST /api/sessions/:id/briefs/:briefId/confirm` 只返回 `{ accepted: true }`。
2. `prepareExecution` 标记 brief 已确认，按建议任务创建 `AgentTask`，解析依赖并发 `task_created`。
3. `ExecutionService.start` 根据 `ENABLE_BULLMQ` 选择 in-process 后台 pipeline 或 BullMQ job。
4. `runPipeline` 循环选择 ready task，调用 runtime，写入 RAG/Memory/Artifact/Runtime/Task 事件。
5. 复盘输出 `deliver/rework/ask_user` 后决定交付、自动返工或等待用户。
6. 最终交付创建 markdown artifact、`feishu_draft` artifact 和通知确认卡。

### 4.3 用户插话与需求修订

- 执行前、确认中或等待决策时的补充需求会重新打开需求理解循环，取消未完成任务，重新生成 brief。
- 执行中的 pause/cancel 会取消当前执行；resume 会重置 stale running 任务并重新推进。
- 偏好类消息不会直接写长期记忆，而是先请求用户确认。

## 5. 当前剩余风险

| 优先级 | 风险 | 影响 | 建议 |
| --- | --- | --- | --- |
| P0 | 真实 Codex/Claude/MCP/Human runtime 未实现 | 平台不能真正调用代码代理或人工 runtime 完成真实开发任务 | v2 优先实现 Codex/Claude adapter，保留注册表失败语义和审计日志。 |
| P0 | 真实高风险工具未端到端接入 | 文件写入、命令执行、外部工具执行仍只在策略层预留 | 在 workspace sandbox、用户确认和审计事件齐备后逐项开启。 |
| P1 | RAG 仍是关键词检索 | 大规模知识库召回质量有限 | 接入 embeddings/pgvector，并新增检索质量与权限测试。 |
| P1 | Postgres 是 JSONB collection 存储 | 可恢复但难以做复杂查询、索引和审计 | 后续以 migration 拆分 sessions/events/tasks/artifacts/runtime_invocations 表。 |
| P1 | 任务执行是 ready task 循环，未并发认领 | 多 Agent 并行度有限，`claimed` 状态仍少用 | 在 BullMQ 模式下按任务粒度入队，补并发认领和幂等锁。 |
| P1 | 工作区写回缺少 diff 审阅 | 用户难以在写入前精确审查变更 | 前端增加 before/after diff、冲突检测和逐文件确认。 |
| P2 | 通知仍为 dry-run | 无真实飞书发送能力 | 增加真实发送 adapter，并保持显式确认和失败回滚。 |
| P2 | 部分架构分析特化逻辑混在通用编排 | 特定需求措辞会触发特殊产物路径 | 抽成可配置模板或专题 workflow，避免通用 orchestrator 膨胀。 |

## 6. 当前验证入口

常规质量门：

```bash
npm run typecheck
npm run build
npm run test:harness
npm run test:e2e:main-chain
npm run test:e2e:p1-behaviors
npm run test:e2e:runtime-routing
npm run test:e2e:runtime-model-switch
npm run test:e2e:task-dependency
npm run test:e2e:multi-agent-discussion
npm run test:e2e:rework-loop
npm run test:e2e:cancel
npm run test:e2e:recovery
npm run test:e2e:memory-confirm
npm run test:e2e:token-budget
npm run test:e2e:artifact-file-changes
npm run test:e2e:workspace-snapshot-payload
npm run test:e2e:server-local-project-analysis
npm run test:e2e:postgres-persistence
npm run test:e2e:bullmq-ops
npm run test:e2e:ops
npm run test:e2e:security
```

真实环境相关测试会依赖本地 PostgreSQL/Redis/Ollama 或自动拉起临时容器；只改文档时可不跑完整矩阵，但最终交付需说明。

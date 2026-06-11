# Agent Cluster 项目分析

生成时间：2026-06-11

## 结论概览

Agent Cluster 是一个多 Agent 协作与运行时编排平台，采用 npm workspaces 组织 NestJS 后端、Vue 3 前端和共享 TypeScript 契约包。当前工作树已经完成文档分类归档，并把早期 v1 的多项可靠性短板推进为可运行实现：后台执行、队列执行、启动恢复、运行时显式路由、任务依赖、自动返工、长期记忆确认、工作区快照、文件变更产物和 token 预算治理。

当前项目适合描述为“v1+ 工程闭环”：它能以 mock 或 OpenAI-compatible/Ollama runtime 完成协作链路，也能在前端展示完整过程。但它还不是“真实代码代理生产平台”：Codex/Claude Code/MCP/Human runtime、真实高风险工具执行、真实飞书发送、pgvector 向量检索和细粒度数据库 schema 仍是后续版本范围。

## 目录结构

```text
.
├── apps
│   ├── server              NestJS API 服务和编排运行时
│   └── web                 Vue 3 + Vite + Pinia 工作台
├── packages
│   └── shared              前后端共享合同、默认 Agent、metadata、mock fixtures
├── tests
│   ├── contracts           契约测试计划
│   ├── e2e                 主链路、运行时、队列、恢复、工作区等 smoke 测试
│   ├── fixtures            协作链路固定数据
│   └── harness-engineering Harness Engineering 文档规程验证
├── docs
│   ├── ai-agent-context    AI 代理条件加载上下文
│   ├── analysis            当前状态、项目分析、问题分级
│   ├── contracts           API、事件、数据、运行时、UI 状态合同
│   ├── design              系统设计、专题设计、UI 风格规范
│   ├── devops              本地开发、CI、发布检查
│   ├── harness-engineering 工程协议、模板、对齐文档
│   ├── implementation      实施拆解
│   ├── product             PRD 与产品范围
│   ├── quality             验收矩阵与闭环报告
│   └── roadmap             修复计划与执行批次
├── docker-compose.yml      本地 PostgreSQL/Redis 依赖
├── package.json            workspace 脚本入口
└── tsconfig.base.json      TypeScript 基础配置
```

## 技术栈

- 后端：NestJS、TypeScript、ESM、模块化服务。
- 前端：Vue 3、Vite、Pinia、File System Access API。
- 共享层：`@agent-cluster/shared` 提供会话、任务、事件、Agent、Runtime、Artifact、Workspace Snapshot 等合同。
- Runtime：`mock`、`generic_llm` 可运行；`codex`、`claude_code` 已注册但返回未实现；`mcp_tool`、`human` 仍为合同预留。
- 持久化：默认 file JSON 快照；可选 PostgreSQL JSONB collection，通过常驻 `pg.Pool` 单 key upsert。
- 队列：可选 BullMQ/Redis，当前执行队列名为 `agent-task-queue`。
- 测试：e2e smoke 覆盖主链、P1 行为、队列、恢复、任务依赖、运行时路由、工作区、token、记忆、Postgres、BullMQ、中文文案、安全和运维。

## 后端结构

入口在 `apps/server/src/main.ts`，负责加载 `.env`、配置 CORS、安全响应头、请求体大小、全局 `/api` 前缀、异常过滤器和启动日志。模块装配在 `apps/server/src/app.module.ts`。

主要模块：

| 模块 | 职责 |
| --- | --- |
| `sessions` | 会话创建、消息、brief 确认/修订、暂停/恢复/取消、记忆确认、飞书通知决策。 |
| `orchestrator` | 工作区分析、Agent 讨论、brief 生成、任务执行、RAG/Memory 注入、复盘、返工、最终交付。 |
| `execution` | 后台执行入口；根据 `ENABLE_BULLMQ` 选择进程内 pipeline 或 BullMQ job。 |
| `queue` | `ExecutionQueue` 与 `ExecutionWorker`，负责 `agent-task-queue` 入队和消费。 |
| `recovery` | 非 BullMQ 模式下，启动时恢复 `EXECUTING/POST_REVIEW/REWORKING` 会话。 |
| `runtimes` | Runtime 注册表、mock runtime、generic LLM、Codex/Claude stub、模型配置管理。 |
| `tasks` | 任务创建、依赖解析、状态更新、unfinished 查询、rework/reset/cancel。 |
| `events` | 协作事件存储、SSE、afterEventId 回补和 200ms 批量持久化。 |
| `artifacts` | 产物创建、列表、详情和下载。 |
| `memory` | 会话记忆创建、检索和注入。 |
| `rag` | 知识库、文档和本地关键词检索。 |
| `capabilities` | 能力注册、风险等级、check/approve。 |
| `debug` | context packs、runtime invocations、RAG retrievals、token usage。 |
| `ops` | 健康检查和 BullMQ 队列状态。 |
| `persistence` | file/PostgreSQL collection 持久化抽象。 |

## 前端结构

前端入口在 `apps/web/src/main.ts`，核心页面是 `SessionWorkspace.vue`。当前工作台不是单纯聊天页，而是包含会话、Agent、知识库、模型、工具和通知管理的操作台。

关键组件：

- `SessionSidebar.vue`：会话列表、状态和 token 使用概览。
- `SessionWorkspace.vue`：主工作区，承载导航、工作区扫描、文件变更应用、视图切换和管理区。
- `ChatTimeline.vue`：把事件流映射为聊天消息、结构化区块、工作区分析和 fileChanges。
- `AgentStatusPanel.vue`、`AgentPortrait.vue`：Agent 状态、任务和能力展示。
- `WorkflowRuntimeView.vue`：运行时阶段和任务流程展示。
- `CollaborationGraphView.vue`：协作图谱。
- `DebugRuntimeView.vue`：上下文包、调用记录、RAG、token 调试。
- `RuntimeModelManager.vue`：模型连接、模型选择和运行时配置。
- `ConfirmationCard.vue`：brief、记忆写入、飞书通知、等待决策等确认卡。
- `UserInputBox.vue`：用户输入、@Agent、工作区相关交互。

前端状态主要由 Pinia store 维护：`session`、`event`、`agent`、`knowledge`、`runtimeModel`、`localWorkspace`。其中 `event` store 是 UI 派生的核心，任务卡、Agent 卡、确认卡和聊天消息都从同一事件流得出。

## 核心执行流

1. 用户创建会话，可附带前端扫描得到的 `workspaceSnapshot`，或在输入中引用 server-local 路径。
2. 后端立即返回会话和首条事件，后台生成工作区分析、Agent 讨论和任务契约。
3. 用户确认 brief 后，后端创建任务并返回 accepted；执行进入后台或 BullMQ。
4. 编排器按任务依赖选择 ready task，构造 context pack，注入 RAG、Memory、workspace focus 和 token budget。
5. Runtime 返回结构化输出；编排器记录 runtime 事件、任务状态、artifact 和 fileChanges。
6. 复盘 Agent 输出建议：`deliver` 进入最终交付，`rework` 受上限自动返工，`ask_user` 进入等待用户决策。
7. 最终交付创建 markdown artifact、飞书通知草稿和确认卡；前端可根据 artifact `fileChanges` 写回用户选择的本地工作区。

## 契约与数据模型

核心合同集中在 `packages/shared/src/contracts.ts`：

- `SessionStatus`：`AGENT_DISCUSSING`、`WAIT_USER_CONFIRM`、`EXECUTING`、`POST_REVIEW`、`REWORKING`、`WAIT_USER_DECISION`、`COMPLETED` 等状态。
- `AgentTaskStatus`：`pending`、`claimed`、`running`、`waiting`、`reworking`、`completed`、`failed` 等任务状态。
- `RuntimeType`：`mock`、`generic_llm`、`codex`、`claude_code`、`mcp_tool`、`human`。
- `CollaborationEventType`：覆盖消息、brief、任务、runtime、RAG、memory、artifact、review、delivery、tool、错误和进度事件。
- `WorkspaceSnapshot` / `RuntimeFileChange`：支撑工作区感知和本地文件变更。
- `RuntimeBudget` / `RuntimeUsage`：支撑 token preflight、裁剪和调用用量回写。

稳定性关键点：前端依赖事件契约派生 UI，因此新增行为应优先扩展 `metadata.payload`，避免破坏既有事件字段和枚举语义。

## 配置与运行模式

默认本地模板是“真实优先”：

- `DEFAULT_AGENT_RUNTIME_TYPE=generic_llm`
- `LLM_DRY_RUN=false`
- `LLM_MOCK_FALLBACK=false`
- `VITE_ENABLE_MOCKS=false`
- `AGENT_CLUSTER_PERSISTENCE_BACKEND=postgres`
- `ENABLE_BULLMQ=true`

如需本地演示或 e2e mock 闭环，需要显式开启 mock：

```bash
VITE_ENABLE_MOCKS=true
DEFAULT_AGENT_RUNTIME_TYPE=mock
LLM_MOCK_FALLBACK=true
MOCK_RUNTIME_ENABLED=true
```

后端启动日志会输出 API 地址、runtime 模式、持久化后端、数据位置、BullMQ 状态和 recovery 开关，降低多端口/多服务混淆。

## 测试与质量

当前 `package.json` 暴露的关键验证入口包括：

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
npm run test:e2e:workspace-chrome
npm run test:e2e:server-local-project-analysis
npm run test:e2e:postgres-persistence
npm run test:e2e:bullmq-ops
npm run test:e2e:real-data-mode
npm run test:e2e:generic-llm-real
npm run test:e2e:ops
npm run test:e2e:security
npm run test:e2e:chinese-copy
```

质量文档以 `docs/quality/v1-acceptance-matrix.md` 和 `docs/quality/v1-closure-acceptance-report.md` 为入口；功能状态以 `docs/analysis/feature-inventory-and-status-v1.md` 为准。

## 当前主要风险

1. 真实代码代理 runtime 未实现：Codex/Claude Code adapter 目前只给出显式失败，尚不能完成真实代码执行。
2. 高风险工具仍停留在治理层：文件写入、命令执行、外部工具调用需要端到端确认、sandbox、审计和回滚后才能开启。
3. RAG 仍是关键词检索：适合 v1 验证链路，不适合大规模知识库质量要求。
4. Postgres 仍是 collection 持久化：能恢复状态，但缺少细粒度 schema、索引、迁移和审计能力。
5. 工作区写回需要更强审阅体验：当前能应用 `fileChanges`，但 diff、冲突、逐文件确认和失败回滚仍需增强。
6. 任务并发模型仍保守：依赖顺序已可用，但尚未按任务粒度并发认领和调度。
7. 通知发送仍为 dry-run：飞书确认只记录工具完成事件，不调用真实 Feishu API。

## 总体评价

项目已经具备一条比较完整的多 Agent 协作工程链路：事件事实源、后台执行、队列/恢复、运行时注册、工作区感知、复盘返工、记忆确认、token 治理和浏览器工作台已经互相接上。下一阶段应少做“再加一个面板”，多做“真实执行闭环”：Codex/Claude runtime、真实工具权限、向量检索、细粒度持久化、diff 审阅和并发任务调度。

---
summary: "已读取当前项目架构与已实现功能，并整理为 AgentRoom 状态快照。项目处于 v1+ 工程闭环状态，但还不是完整生产级真实研发平台。"
changed_files:
  - "AGENTROOM_SUMMARY.md"
tests:
  - "未运行自动化测试；本次仅阅读文档和源码结构，并新增总结文档，未修改业务代码。"
claims:
  - "agent-cluster 是一个多 Agent 协作与运行时编排项目，采用 npm workspaces 组织 apps/server、apps/web 和 packages/shared。"
  - "后端是 NestJS，核心链路为 sessions -> orchestrator -> execution -> runtimes，并配套 tasks、events、artifacts、rag、memory、capabilities、persistence、recovery、queue、ops 和 debug 模块。"
  - "前端是 Vue 3 + Vite + Pinia 工作台，使用 REST + SSE，主要 UI 由 collaboration_events 派生。"
  - "packages/shared 提供前后端共享合同、默认 Agent、metadata、mock fixtures 和时间工具。"
  - "当前已实现会话创建、工作区快照、多 Agent 讨论、任务契约确认、后台/BullMQ 执行、任务依赖、RAG/Memory 注入、复盘、自动返工、最终交付、飞书草稿、文件变更产物、可观测调试入口和多组 e2e 冒烟测试入口。"
  - "真实 Codex/Claude/MCP/Human runtime、真实高风险工具链、pgvector/embedding、真实飞书发送、diff 审阅和细粒度关系表仍是主要缺口。"
---

# AgentRoom 项目架构与功能读取总结

## 读取依据

- `docs/ai-agent-context/project-map.md`
- `docs/analysis/feature-inventory-and-status-v1.md`
- `docs/analysis/project-analysis.md`
- `package.json`
- 源码结构：`apps/server/src`、`apps/web/src`、`packages/shared/src`、`tests/e2e`

## 当前项目定位

本仓库是 `agent-cluster`，目标是提供一个多 Agent 协作与运行时编排平台。用户通过自然语言发起任务，系统组织 Agent 讨论、形成任务契约、等待用户确认，再进入执行、复盘、返工和最终交付。当前实现可描述为 v1+ 工程闭环：协作链路已跑通，具备后台执行、队列、恢复、事件驱动 UI、工作区感知、记忆、RAG 和 token 治理；但真实代码代理和外部工具执行仍未完整生产化。

## 架构分层

```text
apps/web (Vue 3 + Vite + Pinia)
  SessionWorkspace
  ├─ chat / workflow / collaboration_graph / debug
  ├─ Agent / Knowledge / Models / Tools / Notifications 管理入口
  ├─ File System Access 工作区扫描与 fileChanges 写回
  └─ REST + SSE，主视图由 collaboration_events 派生

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

## 后端实现

后端入口是 `apps/server/src/main.ts` 和 `apps/server/src/app.module.ts`。主要模块包括：

| 模块 | 当前职责 |
| --- | --- |
| `sessions` | 会话创建、消息、brief 确认/修订、暂停/恢复/取消、记忆确认、通知决策。 |
| `orchestrator` | 工作区分析、Agent 讨论、brief 生成、任务执行、RAG/Memory 注入、复盘、返工、最终交付。 |
| `execution` | 后台执行入口，根据 `ENABLE_BULLMQ` 选择进程内 pipeline 或 BullMQ job。 |
| `queue` | `agent-task-queue` 入队和消费。 |
| `recovery` | 非 BullMQ 模式下恢复未完成执行会话。 |
| `runtimes` | Runtime 注册表、mock runtime、generic LLM、Codex/Claude stub、模型配置管理。 |
| `tasks` | 任务创建、依赖解析、状态更新、取消、重置、返工。 |
| `events` | 协作事件存储、SSE、事件回补和批量持久化。 |
| `artifacts` | 产物创建、列表、详情和下载。 |
| `memory` | 会话记忆创建、检索和注入。 |
| `rag` | 知识库、文档录入和本地关键词检索。 |
| `capabilities` / `tools` | 能力注册、风险等级、授权检查、内置工具骨架。 |
| `debug` / `ops` | context packs、runtime invocations、RAG、token usage、健康检查和队列状态。 |
| `persistence` | file JSON 与 PostgreSQL JSONB collection 持久化抽象。 |

## 前端实现

前端入口是 `apps/web/src/main.ts` 和 `apps/web/src/App.vue`，核心工作台是 `SessionWorkspace.vue`。当前前端不是单纯聊天页，而是一个协作操作台：

- `SessionSidebar.vue`：会话列表、状态和 token 概览。
- `ChatTimeline.vue`：把事件流映射为聊天消息、结构化区块、工作区分析和 fileChanges。
- `AgentStatusPanel.vue`、`AgentPortrait.vue`：Agent 状态、任务和能力展示。
- `WorkflowRuntimeView.vue`：运行时阶段和任务流程。
- `CollaborationGraphView.vue`、`CollaborationTaskBoard.vue`、`CollaborationLogPanel.vue`：协作图谱、任务板和协作日志。
- `DebugRuntimeView.vue`：Context Pack、Runtime 调用、RAG、token 调试。
- `RuntimeModelManager.vue`：模型连接、模型选择和运行时配置。
- `ConfirmationCard.vue`：brief、记忆写入、飞书通知和等待决策确认。
- `UserInputBox.vue`：用户输入、@Agent 和工作区相关交互。

Pinia store 包括 `session`、`event`、`agent`、`knowledge`、`runtimeModel` 和 `localWorkspace`。其中 `event` store 是 UI 派生核心。

## 已实现功能

| 领域 | 状态 | 摘要 |
| --- | --- | --- |
| 会话创建与事件流 | 完成 | `POST /api/sessions` 创建会话并返回，brief 后台生成，前端通过 SSE 和事件回补跟进。 |
| 多 Agent 讨论 | 完成 | 支持配置讨论 Agent、轮次和超时，超时降级后继续生成 brief。 |
| 任务契约 | 完成 | Coordinator 生成 `TaskBrief`、建议任务、brief artifact 和确认卡。 |
| 后台执行 | 完成 | HTTP 只返回受理结果，实际任务、复盘和交付在后台或 BullMQ worker 中推进。 |
| 取消与恢复 | 完成 | in-process 模式支持 `AbortController`；pause/cancel/resume 和启动恢复可用。 |
| BullMQ 队列 | 完成 | `ENABLE_BULLMQ=true` 时使用 `agent-task-queue`，并提供队列状态接口。 |
| 任务依赖 | 完成 | `dependsOnTaskTitles` 可解析为 `dependsOnTaskIds`，只执行依赖完成的 ready task。 |
| Coordinator 任务流转 | 完成 | Coordinator 负责分配、改派和失败后进入用户决策，子 Agent 不自由抢占任务。 |
| Runtime 路由 | 完成 | `mock` 和 `generic_llm` 可运行；未实现 runtime 显式失败，不静默回退 mock。 |
| Generic LLM | 完成 | 支持 OpenAI-compatible/Ollama endpoint、超时、重试、取消和结构化 JSON 校验。 |
| Mock Runtime | 完成 | 支持 dry-run、延迟、失败率、fileChanges 和多种输出 kind。 |
| RAG | 部分 | 知识库 CRUD、文档录入、关键词检索、事件和 Context Pack 注入已可用。 |
| Memory | 完成 | 支持 session memory 创建、检索、注入；长期偏好写入前需要用户确认。 |
| Capability governance | 部分 | 能力注册、风险分级、check/approve 可用；真实高风险工具链仍未端到端开启。 |
| Artifacts | 完成 | brief、执行结果、复盘、最终交付、通知草稿均创建 artifact，metadata 支持 `fileChanges`。 |
| 工作区感知 | 完成 | 前端可扫描本地目录上传 `workspaceSnapshot`；后端可解析 server-local 路径。 |
| 文件变更写回 | 部分 | 浏览器端可应用 artifact `fileChanges`；server-local 会话可写 `agent-output/`。 |
| 飞书通知 | 部分 | 生成 `feishu_draft` artifact 和确认卡；确认后只记录 dry-run tool 完成事件。 |
| 前端工作台 | 完成 | 三栏工作台、群聊、工作流、协作图、debug 和管理入口已实现。 |
| 持久化 | 部分 | file backend 和 PostgreSQL JSONB collection 可用，尚未拆成细粒度关系表。 |
| 可观测性 | 完成 | debug API 暴露 context packs、runtime invocations、RAG 和 token usage。 |
| Token 预算 | 完成 | 支持预算估算、裁剪、超预算失败事件和 runtime usage 回写。 |

## 当前主流程

1. 用户创建会话，可附带前端扫描得到的 `workspaceSnapshot` 或 server-local 路径。
2. 后端立即返回会话和首条事件，后台生成工作区分析、Agent 讨论和任务契约。
3. 用户确认 brief 后，后端创建任务并返回 accepted，执行进入后台或 BullMQ。
4. 编排器按依赖选择 ready task，构造 Context Pack，注入 RAG、Memory、workspace focus 和 token budget。
5. Runtime 返回结构化输出，编排器写入 runtime 事件、任务状态、artifact 和 fileChanges。
6. 复盘输出 `deliver`、`rework` 或 `ask_user`，决定最终交付、自动返工或等待用户。
7. 最终交付创建 markdown artifact、飞书通知草稿和确认卡；前端可按 artifact `fileChanges` 写回本地工作区。

## 主要缺口

- 真实 Codex/Claude/MCP/Human runtime 尚未实现，当前 Codex/Claude adapter 仍是显式 stub/失败语义。
- 真实高风险工具执行尚未端到端接入，文件修改、命令执行和外部系统调用仍需 sandbox、确认、审计和回滚。
- RAG 仍是关键词检索，尚未接入 embeddings/pgvector。
- PostgreSQL 目前是 JSONB collection 持久化，尚未拆成 sessions/events/tasks/artifacts/runtime_invocations 等细粒度关系表。
- 工作区写回缺少 before/after diff 审阅、冲突检测和逐文件确认。
- 飞书通知仍为 dry-run，未调用真实 Feishu API。
- 任务执行模型仍偏保守，依赖顺序可用，但细粒度并发认领和调度仍需增强。

## 验证入口

常规验证命令包括：

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

本次任务是读取和总结，没有修改业务代码，因此未运行自动化测试。

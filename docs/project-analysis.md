# Agent Cluster 项目分析

生成时间: 2026-06-03

## 结论概览

Agent Cluster 是一个多 Agent 协作平台单仓项目，采用 npm workspaces 组织 NestJS 后端、Vue 3 前端和共享 TypeScript 契约包。项目的核心目标是把用户需求转成任务简报、等待用户确认、分配 Agent 执行、记录运行时事件、生成复盘与最终交付物。

当前代码已经具备较完整的 v0.1 协作链路: 会话、Agent、任务、事件流、运行时、RAG、记忆、产物、调试接口、能力管控和本地持久化。主要风险集中在真实运行时稳定性、服务重启后的执行恢复、中文文本编码、状态机收尾一致性，以及高风险工具执行的策略边界。

## 目录结构

```text
.
├── apps
│   ├── server              NestJS API 服务
│   └── web                 Vue 3 + Vite 前端
├── packages
│   └── shared              共享契约、默认 Agent、元数据工具
├── tests
│   ├── contracts           契约测试计划
│   ├── e2e                 端到端和冒烟测试
│   └── fixtures            协作链路固定数据
├── docs
│   ├── architecture        前后端架构说明
│   ├── contracts           API、数据、事件、运行时、UI 状态契约
│   ├── devops              本地开发、CI、Postgres 说明
│   └── quality             验收矩阵和验收报告
├── docker-compose.yml      本地 Postgres/Redis 依赖
├── package.json            workspace 脚本入口
└── tsconfig.base.json      TypeScript 基础配置
```

## 技术栈

- 后端: NestJS，TypeScript，ESM，模块化服务。
- 前端: Vue 3，Vite，Pinia，组件化工作台。
- 共享层: `@agent-cluster/shared` 提供会话、任务、事件、Agent、运行时、产物等契约类型。
- 运行时: `mock`、`generic_llm`、`codex`、`claude_code`、`mcp_tool`、`human`。
- 本地状态: 默认 JSON 快照，支持 Postgres 作为持久化后端的过渡设计。
- 测试: 多组 E2E smoke 脚本，覆盖主链路、P1 行为、持久化、Agent 管理、真实模型、工具运行时等。

## 后端结构

后端入口在 `apps/server/src/main.ts`，加载本地环境变量，配置 CORS、安全响应头、全局 `/api` 前缀和异常过滤器。模块装配在 `apps/server/src/app.module.ts`。

主要模块如下:

- `sessions`: 会话创建、消息发送、简报确认、暂停、继续、取消、写入确认。
- `orchestrator`: 核心编排器，负责讨论、简报生成、任务创建、任务队列执行、复盘和最终交付。
- `tasks`: 按会话维护任务列表，支持创建、查询、更新和持久化。
- `events`: 协作事件存储和 SSE 事件流。
- `runtimes`: 统一运行时执行入口，封装 mock、通用 LLM、Codex CLI、Claude Code CLI 和工具执行。
- `agents`: Agent 列表、默认 Agent、Agent 维护。
- `capabilities`: 能力注册、风险等级、能力检查和批准。
- `models`: 模型连接、凭据和配置管理。
- `rag`: 知识库和本地检索。
- `memory`: 会话记忆。
- `artifacts`: 产物创建、查询和下载。
- `debug`: 上下文包、运行时调用、RAG 检索、token 使用调试接口。
- `ops`: 健康检查、队列和 Redis 运行状态。
- `persistence`: JSON/Postgres 持久化抽象。

## 前端结构

前端入口在 `apps/web/src/main.ts`，主要页面由 `SessionWorkspace.vue` 承载。它把会话、事件、任务、Agent、产物和调试视图组合成协作工作台。

关键组件:

- `SessionSidebar.vue`: 会话列表。
- `SessionWorkspace.vue`: 主工作区，连接聊天、任务、Agent、图谱、运行时视图和产物面板。
- `ChatTimeline.vue`: 事件转聊天消息的时间线。
- `AgentStatusPanel.vue`: Agent 状态和任务步骤。
- `WorkflowRuntimeView.vue`: 运行时流程视图。
- `CollaborationGraphView.vue`: 协作关系和当前任务图谱。
- `ArtifactPanel.vue`: 产物展示。
- `ConfirmationCard.vue`: 简报确认、写入确认、用户决策卡片。
- `DebugRuntimeView.vue`: 调试运行时调用、上下文包和 token 使用。
- `ModelManagementPanel.vue`: 模型和连接管理。

前端状态主要由 Pinia store 维护:

- `session`: 会话列表、当前会话、创建、删除、确认、暂停、继续、取消。
- `event`: 事件拉取、SSE 连接、从事件派生任务状态和 Agent 卡片。
- `agent`: Agent 与能力信息。
- `knowledge`: 知识库状态。
- `model`: 模型配置。

## 核心执行流

1. 用户创建会话，后端记录 `user_message`。
2. `SessionsService` 异步调用 `generateBriefInBackground`。
3. `OrchestratorService` 组织协调者和参与 Agent 讨论。
4. 协调者生成 `task_brief`，系统创建简报产物和确认卡。
5. 用户确认简报后，会话进入 `EXECUTING`。
6. 编排器根据建议任务创建 `AgentTask`。
7. 每个任务依次进入 `running`，调用对应 Agent 的运行时。
8. 运行时产出结构化 `task_execution_result`、工具产物或待确认写入。
9. 任务完成后进入复盘，生成 `post_review_report`。
10. 协调者生成最终交付，事件流推送到前端。

## 契约与数据模型

核心契约集中在 `packages/shared/src/contracts.ts`。其中最关键的类型包括:

- `SessionStatus`: 会话状态机，如 `AGENT_DISCUSSING`、`WAIT_USER_CONFIRM`、`EXECUTING`、`WAIT_USER_DECISION`、`COMPLETED`。
- `AgentTaskStatus`: 任务状态，如 `pending`、`running`、`completed`、`failed`。
- `CollaborationEventType`: 协作事件类型，覆盖消息、简报、任务、运行时、RAG、产物、复盘和错误。
- `RuntimeType`: Agent 运行时类型。
- `ArtifactType`: 文本、Markdown、代码 diff、测试报告、飞书草稿、文件等产物类型。

前端不是直接轮询任务内部状态，而是通过事件派生 UI 状态。这一点让事件契约成为系统稳定性的关键。

## 测试与质量

仓库提供了较多 E2E 脚本:

- `npm run test:e2e:main-chain`
- `npm run test:e2e:p1-behaviors`
- `npm run test:e2e:persistence`
- `npm run test:e2e:v2-runtime`
- `npm run test:e2e:interactive-messaging`
- `npm run test:e2e:artifact-write`
- `npm run test:e2e:local-ollama`

这些测试覆盖了协作主链路、SSE、持久化、Postgres、Agent 管理、模型回退、运行时工具、写入确认和工作区同步。质量文档位于 `docs/quality`，契约测试计划位于 `tests/contracts`。

## 当前观察到的运行状态

本次排查时发现有多套本地服务同时运行:

- `3001`: 有历史会话和任务，是当前任务列表的主要来源。
- `3100`: 新启动的 mock 服务，当前无会话。
- `3000`: 旧服务，仅有失败历史会话。
- `5173`、`5180`: 前端 Vite 服务。

`3001` 上有一个真正未完成的会话:

- 会话 `c0b99524-7a67-4ebc-9f52-b96943bf467d`
- 目标: 读取项目目录结构并生成分析 Markdown 文档
- 任务 `4a040cdb-8af2-4c0d-a32f-d4f7c854466d`: `running`
- 任务 `786737f7-4ebc-482b-afe3-d5c61ccbc429`: `pending`

这个文档即为该会话目标的人工续跑交付物。

## 主要风险

1. 服务重启后缺少执行恢复机制

   会话和任务状态会持久化，但后台 Promise/运行时进程不会随状态自动恢复。本次观察到的 `running` 任务最后停在 `runtime_started`，服务重启后没有继续推进。

2. 状态机收尾可能不一致

   有会话的任务已全部 `completed`，但会话仍停留在 `EXECUTING`。说明复盘或最终交付失败时，状态可能没有被可靠修正。

3. 中文字符串存在编码异常

   多个后端源码字符串显示为乱码，可能是文件编码或历史写入编码不一致导致。虽然业务逻辑仍可运行，但会影响前端可读性和测试稳定性。

4. 真实 LLM 运行时易受超时影响

   历史会话中有多次 `generic_llm runtime failed` 或 timeout。需要明确默认模型、超时、重试和 fallback 策略。

5. 高风险工具能力需要持续收紧

   文件写入、命令执行、测试运行等工具已做能力和环境变量门控，但后续接入真实 CLI Agent 时，仍要坚持 workspace sandbox 和用户确认。

## 建议改进

1. 增加运行中任务恢复机制

   服务启动时扫描 `EXECUTING`、`POST_REVIEW`、`REWORKING` 会话，以及 `running`、`pending`、`waiting` 任务。对缺少活跃 runtime invocation 的任务执行恢复、重试或标记为可恢复失败。

2. 增加任务超时巡检

   为 `running` 任务记录最近事件时间。如果超过 `RUNTIME_TIMEOUT_MS` 的合理倍数仍无 `runtime_completed` 或 `runtime_failed`，自动发出 `runtime_failed` 并进入下一任务或等待用户决策。

3. 修复中文源码编码

   对后端中文提示、事件内容、确认卡文本做一次 UTF-8 规范化，并增加 `tests/e2e/chinese-visible-copy-smoke.mjs` 的覆盖范围。

4. 把复盘和最终交付的失败显式化

   `reviewAndDeliver` 中任何运行时失败都应生成清晰的 `error_reported` 或 `runtime_failed`，并让会话进入 `FAILED` 或 `WAIT_USER_DECISION`，避免停在 `EXECUTING`。

5. 建立任务恢复 API

   可以新增 `POST /api/sessions/:sessionId/recover` 或 `POST /api/sessions/:sessionId/tasks/:taskId/retry`，让前端和运维都能明确恢复卡住任务，而不是只能暂停或取消。

6. 收敛本地多服务端口

   当前 `3000`、`3001`、`3100` 多套服务并存，容易误判任务来源。建议本地运行脚本输出当前 API base、数据文件路径和运行模式，并在前端显著显示。

## 总体评价

项目已经形成了清晰的多 Agent 协作产品骨架，事件契约和运行时契约也有比较完整的测试支撑。下一阶段的重点不是继续增加功能，而是提升执行链路的可靠性: 任务恢复、状态一致性、真实运行时错误处理、中文可读性和本地环境可观测性。


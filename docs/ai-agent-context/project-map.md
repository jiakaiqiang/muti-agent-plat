# 项目地图

本文档用于帮助 Codex、Claude 等 AI 工程代理根据用户需求精准定位项目上下文。

先通过本地图判断任务落点，再读取对应代码、合同、测试和设计文档。

## 项目定位

本仓库是 `agent-cluster`，一个多 Agent 协作与运行时编排项目。

核心能力包括：

- 会话与用户需求输入。
- 多 Agent 讨论、任务简报、任务拆解与执行。
- Runtime 适配，包括 mock、Generic LLM、Codex、Claude Code。
- 事件流、产物、记忆、知识检索、能力治理。
- Web 工作台展示协作过程、任务状态和运行时结果。
- Harness Engineering 作为 AI 工程代理完成任务的工程化协议。

## 顶层目录

| 路径 | 用途 | 典型任务 |
| --- | --- | --- |
| `apps/server/` | NestJS 后端服务 | API、会话、编排、运行时、事件、任务、记忆、RAG、能力治理 |
| `apps/web/` | Vue 前端工作台 | 页面、组件、状态管理、用户交互、运行时展示 |
| `packages/shared/` | 前后端共享合同与类型 | 合同、事件类型、Agent 类型、metadata、mock fixtures |
| `docs/` | 产品、设计、合同、质量、运维、Harness 文档 | 需求分析、设计依据、验收标准、永久知识 |
| `tests/` | 合同测试、e2e、Harness 验证 | 自动化验证、冒烟测试、工程规程校验 |
| `.claude/` | Claude 本地配置与协议入口 | Claude 工作方式 |
| `AGENTS.md` | Codex/AI 代理入口规则 | Codex 和通用代理工作方式 |

## 后端地图

后端入口：

- `apps/server/src/main.ts`
- `apps/server/src/app.module.ts`

常见模块：

| 需求关键词 | 主要路径 | 相关文档/测试 |
| --- | --- | --- |
| 会话、用户输入、确认、恢复 | `apps/server/src/modules/sessions/` | `docs/contracts/api-contract-v0.1.md`, `tests/e2e/memory-confirm-smoke.mjs` |
| 编排、brief、任务执行、review、delivery | `apps/server/src/modules/orchestrator/` | `docs/harness-engineering/alignment/`, `tests/e2e/run-main-chain.mjs` |
| Runtime、模型切换、LLM、Codex、Claude Code | `apps/server/src/modules/runtimes/` | `docs/contracts/runtime-contract-v0.1.md`, `tests/e2e/runtime-routing-smoke.mjs` |
| Agent 管理、默认 Agent | `apps/server/src/modules/agents/`, `packages/shared/src/default-agents.ts` | `docs/harness-engineering/10-agent-working-protocol.md` |
| 任务、依赖、状态 | `apps/server/src/modules/tasks/` | `tests/e2e/task-dependency-smoke.mjs` |
| 事件流 | `apps/server/src/modules/events/` | `docs/contracts/event-contract-v0.1.md`, `apps/web/src/stores/event.ts` |
| 产物 | `apps/server/src/modules/artifacts/` 或编排内产物创建逻辑 | `docs/harness-engineering/alignment/artifacts-alignment.md` |
| 记忆 | `apps/server/src/modules/memory/` | `docs/harness-engineering/delivery-memory/`, `tests/e2e/debug-memory-smoke.mjs` |
| 知识检索、RAG | `apps/server/src/modules/rag/` | `tests/e2e/real-data-mode-smoke.mjs` |
| 能力、工具治理 | `apps/server/src/modules/capabilities/` | `docs/harness-engineering/capability-binding/` |
| 队列、执行 worker | `apps/server/src/modules/queue/`, `apps/server/src/modules/execution/` | `tests/e2e/bullmq-ops-smoke.mjs` |
| 持久化、恢复 | `apps/server/src/modules/persistence/`, `apps/server/src/modules/recovery/` | `tests/e2e/persistence-smoke.mjs`, `tests/e2e/postgres-persistence-smoke.mjs` |
| 运维、健康检查 | `apps/server/src/modules/ops/` | `docs/devops/`, `tests/e2e/ops-smoke.mjs` |

## 前端地图

前端入口：

- `apps/web/src/main.ts`
- `apps/web/src/App.vue`

常见区域：

| 需求关键词 | 主要路径 | 相关文档/测试 |
| --- | --- | --- |
| 工作台整体布局 | `apps/web/src/components/SessionWorkspace.vue` | `docs/design/ui-style-guide-v1.md` |
| 会话侧栏 | `apps/web/src/components/SessionSidebar.vue` | `apps/web/src/stores/session.ts` |
| 聊天时间线、事件展示 | `apps/web/src/components/ChatTimeline.vue` | `docs/contracts/event-contract-v0.1.md` |
| 用户输入框 | `apps/web/src/components/UserInputBox.vue` | `tests/e2e/chinese-visible-copy-smoke.mjs` |
| Agent 状态、画像、图谱 | `apps/web/src/components/AgentStatusPanel.vue`, `AgentPortrait.vue`, `CollaborationGraphView.vue` | `docs/design/agent-cluster-system-design-v1.md` |
| 运行时模型管理 | `apps/web/src/components/RuntimeModelManager.vue` | `apps/web/src/stores/runtimeModel.ts`, `tests/e2e/runtime-model-switch-smoke.mjs` |
| 运行时过程展示 | `apps/web/src/components/WorkflowRuntimeView.vue`, `DebugRuntimeView.vue` | `docs/contracts/runtime-contract-v0.1.md` |
| 确认卡片 | `apps/web/src/components/ConfirmationCard.vue` | `tests/e2e/memory-confirm-smoke.mjs` |
| 样式 | `apps/web/src/styles.css` | `docs/design/ui-style-guide-v1.md` |
| API 客户端 | `apps/web/src/api/client.ts` | `docs/contracts/api-contract-v0.1.md` |

## 共享包地图

| 需求关键词 | 主要路径 | 注意事项 |
| --- | --- | --- |
| 合同类型、事件、会话、任务、产物 | `packages/shared/src/contracts.ts` | 修改后通常影响前后端和测试 |
| metadata | `packages/shared/src/metadata.ts` | 事件卡片和产物语义依赖这里 |
| 默认 Agent | `packages/shared/src/default-agents.ts` | 影响初始化、协作角色和前端展示 |
| mock 数据 | `packages/shared/src/mock-fixtures.ts` | 影响 mock runtime 和前端示例 |
| 时间工具 | `packages/shared/src/time.ts` | 避免引入不一致时间格式 |

## 文档地图

| 路径 | 用途 |
| --- | --- |
| `docs/README.md` | 文档分类索引 |
| `docs/product/agent-cluster-prd-v1.md` | 产品需求与范围 |
| `docs/design/agent-cluster-system-design-v1.md` | 系统设计 |
| `docs/design/workspace-aware-chat-agent-design-v1.md` | 聊天室 Agent 借鉴 Codex/Claude 工作区感知模型的产品与系统设计 |
| `docs/design/ui-style-guide-v1.md` | 前端 UI 风格规范 |
| `docs/implementation/agent-team-implementation-breakdown-v1.md` | Agent 团队实现拆解 |
| `docs/analysis/feature-inventory-and-status-v1.md` | 功能清单与当前状态 |
| `docs/analysis/project-analysis.md` | 项目分析 |
| `docs/roadmap/remediation-plan-v1.md` | 修复计划 |
| `docs/roadmap/remediation-execution-plan-batch2-3.md` | 修复执行计划 |
| `docs/contracts/` | API、事件、数据、运行时、UI 状态合同 |
| `docs/quality/` | 验收矩阵与质量报告 |
| `docs/devops/` | 本地开发、CI、发布检查 |
| `docs/harness-engineering/` | Harness Engineering 详细规程 |
| `docs/ai-agent-context/` | AI 工程代理条件加载上下文 |

## 测试地图

| 验证目标 | 命令 |
| --- | --- |
| Harness 文档和规程完整性 | `npm run test:harness` |
| TypeScript 类型检查 | `npm run typecheck` |
| 全部 workspace 测试 | `npm run test` |
| 构建 | `npm run build` |
| 主链路 e2e | `npm run test:e2e:main-chain` |
| P1 行为 | `npm run test:e2e:p1-behaviors` |
| 运维冒烟 | `npm run test:e2e:ops` |
| 安全冒烟 | `npm run test:e2e:security` |
| 中文可见文案 | `npm run test:e2e:chinese-copy` |
| Runtime 路由 | `npm run test:e2e:runtime-routing` |
| Runtime 模型切换 | `npm run test:e2e:runtime-model-switch` |
| 任务依赖 | `npm run test:e2e:task-dependency` |
| 多 Agent 讨论 | `npm run test:e2e:multi-agent-discussion` |
| 自动返工 | `npm run test:e2e:rework-loop` |
| 取消/中断 | `npm run test:e2e:cancel` |
| 启动恢复 | `npm run test:e2e:recovery` |
| 记忆确认 | `npm run test:e2e:memory-confirm` |
| Token 预算 | `npm run test:e2e:token-budget` |
| 工作区快照 | `npm run test:e2e:workspace-snapshot-payload` |
| 工作区 fileChanges | `npm run test:e2e:artifact-file-changes` |
| Server-local 项目分析 | `npm run test:e2e:server-local-project-analysis` |
| Postgres 持久化 | `npm run test:e2e:postgres-persistence` |
| BullMQ 队列 | `npm run test:e2e:bullmq-ops` |
## 需求到上下文的路由

| 如果用户说 | 优先读取 |
| --- | --- |
| “实现一个功能” | 本文档、Harness 协议、相关 app/package、合同、测试 |
| “看看现在实现了什么” | `docs/analysis/feature-inventory-and-status-v1.md`, `docs/analysis/project-analysis.md`, 相关代码 |
| “补齐未完成项” | `docs/roadmap/remediation-plan-v1.md`, `docs/roadmap/remediation-execution-plan-batch2-3.md`, 功能状态文档 |
| “优化前端体验” | 前端地图、UI 风格文档、相关组件 |
| “调整 API/事件/类型” | 合同文档、`packages/shared/src/contracts.ts`、前后端调用点 |
| “改 Agent 协作/编排” | Orchestrator、sessions、tasks、events、runtime、Harness alignment 文档 |
| “改 Runtime/模型配置” | runtimes 模块、runtime contract、runtime e2e |
| “改记忆/RAG/知识库” | memory、rag、delivery-memory 文档、相关 e2e |
| “改 Codex/Claude 工作方式” | `AGENTS.md`, `.claude/CLAUDE.md`, `docs/ai-agent-context/` |
| “只问概念/方案” | 只读相关文档，不编辑文件 |

## 永久记忆维护位置

| 记忆类型 | 维护位置 |
| --- | --- |
| AI 工具如何执行任务 | `docs/ai-agent-context/` |
| Harness Engineering 规程 | `docs/harness-engineering/` |
| 产品范围和目标 | `docs/product/agent-cluster-prd-v1.md` |
| 系统设计 | `docs/design/agent-cluster-system-design-v1.md` |
| 功能状态 | `docs/analysis/feature-inventory-and-status-v1.md` |
| 合同与数据结构 | `docs/contracts/` |
| UI 风格 | `docs/design/ui-style-guide-v1.md` |
| 质量验收 | `docs/quality/` |
| 运维和本地开发 | `docs/devops/` |

新增永久记忆前，先判断它属于哪一类。不要把所有记忆都堆到 `AGENTS.md` 或 `.claude/CLAUDE.md`。

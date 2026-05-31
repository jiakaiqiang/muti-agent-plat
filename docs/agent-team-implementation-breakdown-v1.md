# Agent Cluster 系统实施拆分设计 v1

## 1. 文档目标

本文档基于 [Agent Cluster 协作系统设计文档 v1](./agent-cluster-system-design-v1.md)，使用 Agent Team 的方式，对系统实施进行拆分设计。

这里的 Agent Team 指研发实施过程中的协作团队，而不是系统运行时的业务 Agent。

目标是明确：

- 前端 Agent Team 负责什么。
- 后端 Agent Team 负责什么。
- 测试 Agent Team 负责什么。
- 质量验收 Agent Team 负责什么。
- 运维 Agent Team 负责什么。
- 各 Agent Team 之间如何协作、交接和验收。
- 每个阶段的产物、依赖、风险和完成标准。

## 2. 总体实施组织

整个系统实施由一个总控团队和多个专业 Agent Team 协同完成。

```text
System Coordinator Agent Team
  ├─ Product & Architecture Agent Team
  ├─ Frontend Agent Team
  ├─ Backend Agent Team
  ├─ Runtime & Integration Agent Team
  ├─ RAG & Memory Agent Team
  ├─ Test Agent Team
  ├─ Quality Acceptance Agent Team
  └─ DevOps Agent Team
```

核心协作原则：

- Product & Architecture Team 输出需求契约和架构契约。
- Frontend Team 和 Backend Team 并行开发，但通过 API Contract 交接。
- Runtime、RAG、Memory 属于高复杂后端能力，独立成专项 Team。
- Test Team 负责测试设计和自动化测试。
- Quality Acceptance Team 负责从用户价值和 PRD 一致性角度验收。
- DevOps Team 负责本地开发、部署、环境、监控和交付流水线。
- System Coordinator Team 负责跨团队依赖、冲突、进度和最终集成。

## 3. Agent Team 总览

### 3.1 System Coordinator Agent Team

定位：

负责整体实施协调，相当于项目级 Coordinator。

成员：

- Project Coordinator Agent
- Delivery Manager Agent
- Risk Controller Agent
- Dependency Tracker Agent

职责：

- 维护实施总计划。
- 拆分 milestone。
- 跟踪跨团队依赖。
- 组织技术评审和集成评审。
- 处理冲突和阻塞。
- 汇总阶段交付报告。
- 判断是否进入下一个阶段。

输入：

- PRD。
- 系统设计文档。
- 各 Team 的实施计划。
- 各 Team 的进度事件和风险事件。

输出：

- 实施任务总看板。
- milestone 计划。
- 跨团队依赖图。
- 风险清单。
- 阶段交付报告。

完成标准：

- 所有 Team 的边界清晰。
- 跨团队接口有明确负责人。
- 每个 milestone 都有验收条件。
- 关键风险都有处理策略。

### 3.2 Product & Architecture Agent Team

定位：

负责把 PRD 和系统设计进一步转化为可执行的产品契约、架构契约和接口契约。

成员：

- Product Analyst Agent
- System Architect Agent
- API Contract Agent
- Data Model Agent
- UX Flow Agent

职责：

- 梳理核心用户流程。
- 确认 v1 范围。
- 细化页面信息架构。
- 细化模块边界。
- 细化 API Contract。
- 细化数据库 schema。
- 定义跨 Team 交接物。

输入：

- PRD。
- 系统设计文档。
- 用户补充需求。

输出：

- v1 scope contract。
- API contract。
- database schema contract。
- event type contract。
- frontend route contract。
- acceptance criteria contract。

完成标准：

- 前后端可基于 API contract 并行开发。
- 测试 Team 可基于验收标准设计用例。
- 运维 Team 可基于模块清单准备环境。

## 4. Frontend Agent Team 拆分

### 4.1 Team 定位

负责 Vue3 前端应用的页面、交互、状态管理、实时事件展示和可视化视图。

### 4.2 Team 成员

- Frontend Lead Agent
- UI Layout Agent
- Chat Workspace Agent
- Agent Status Panel Agent
- Collaboration Graph Agent
- Workflow View Agent
- Frontend State Agent
- Frontend API Integration Agent

### 4.3 模块拆分

#### 4.3.1 应用基础

负责 Agent：

- Frontend Lead Agent
- Frontend State Agent

范围：

- Vue3 项目结构。
- TypeScript 配置。
- Vue Router。
- Pinia。
- Element Plus。
- API client。
- SSE client。
- 全局 layout。

产物：

- `apps/web/src/router`
- `apps/web/src/stores`
- `apps/web/src/api`
- `apps/web/src/layouts`

依赖：

- 后端 API Contract。
- Event Contract。

#### 4.3.2 三栏群聊主界面

负责 Agent：

- UI Layout Agent
- Chat Workspace Agent
- Agent Status Panel Agent

范围：

- 左侧操作区。
- 左侧会话历史。
- 中间群聊消息区。
- 用户输入框。
- 用户确认卡片。
- 右侧 Agent 状态卡片。

核心组件：

```text
SessionWorkspace.vue
SessionSidebar.vue
ChatTimeline.vue
ChatMessageItem.vue
UserInputBox.vue
ConfirmationCard.vue
AgentStatusPanel.vue
AgentStatusCard.vue
```

验收标准：

- 用户可以创建会话。
- 用户可以查看历史会话。
- 用户可以发送消息。
- Agent 消息可以实时出现。
- 任务契约可以以确认卡片展示。
- 右侧 Agent 卡片能展示状态、当前任务、行动日志、RAG 片段摘要。

#### 4.3.3 协作流转图

负责 Agent：

- Collaboration Graph Agent
- Frontend State Agent

范围：

- 基于 `collaboration_events` 生成 Agent 节点。
- 基于 @、handoff、task 事件生成信息流边。
- 展示 Agent 气泡。
- 点击节点过滤消息。
- 点击边定位事件。

核心组件：

```text
CollaborationGraphView.vue
AgentGraphNode.vue
MessageBubbleLayer.vue
GraphEventInspector.vue
```

验收标准：

- 可以看到 Agent 之间的信息流转。
- 当前活跃 Agent 高亮。
- 用户可以从图上定位到对应群聊事件。

#### 4.3.4 工作流视图

负责 Agent：

- Workflow View Agent

范围：

- 基于 `agent_tasks`、`task_briefs`、`events` 生成阶段图。
- 展示任务理解、用户确认、执行、测试、复盘、交付。
- 节点展示关联 Agent 和状态。

核心组件：

```text
WorkflowRuntimeView.vue
TaskFlowNode.vue
TaskFlowEdge.vue
TaskNodeInspector.vue
```

验收标准：

- 可以看到任务整体进度。
- 节点状态与任务状态一致。
- 点击节点可以查看关联任务和事件。

### 4.4 Frontend Team 交付物

- 页面路由。
- 三栏主界面。
- 群聊消息渲染。
- Agent 卡片。
- 任务契约确认卡片。
- SSE 实时事件接入。
- 协作流转图简版。
- 工作流视图简版。
- RAG 命中来源展示。

### 4.5 Frontend Team 依赖

依赖 Backend Team：

- Session API。
- Event API。
- SSE API。
- Agent API。
- Task Brief API。
- Knowledge API。

依赖 Product & Architecture Team：

- 页面信息架构。
- API Contract。
- Event Contract。
- UI 状态定义。

## 5. Backend Agent Team 拆分

### 5.1 Team 定位

负责 NestJS 后端核心服务、数据模型、事件流、会话状态机、任务调度和 API。

### 5.2 Team 成员

- Backend Lead Agent
- Database Schema Agent
- Session Service Agent
- Event Service Agent
- User Message Router Agent
- Orchestrator Agent
- Task Service Agent
- Realtime Service Agent
- API Contract Agent

### 5.3 模块拆分

#### 5.3.1 数据库与基础设施

负责 Agent：

- Database Schema Agent
- Backend Lead Agent

范围：

- PostgreSQL schema。
- migration。
- seed 默认 Agent。
- pgvector 扩展。
- Redis 连接。
- BullMQ 配置。

产物：

- sessions。
- agents。
- collaboration_events。
- task_briefs。
- agent_tasks。
- memories。
- knowledge_bases。
- knowledge_documents。
- knowledge_chunks。
- capability_invocations。
- artifacts。

验收标准：

- 数据库 migration 可重复执行。
- 默认研发 Agent 可初始化。
- pgvector 可用于 RAG 检索。

#### 5.3.2 Session 与状态机

负责 Agent：

- Session Service Agent

范围：

- 创建会话。
- 会话列表。
- 会话详情。
- 状态流转。
- 暂停、恢复、取消。

验收标准：

- 状态流转符合设计文档。
- 非法状态迁移被拒绝。
- 会话状态变更写入事件流。

#### 5.3.3 Collaboration Event

负责 Agent：

- Event Service Agent
- Realtime Service Agent

范围：

- 事件写入。
- 事件查询。
- SSE 推送。
- 事件类型校验。
- 事件与任务、Agent、Artifact 关联。

验收标准：

- 所有关键动作都有事件。
- SSE 可实时推送。
- 前端刷新后可以恢复完整事件流。

#### 5.3.4 User Message Router

负责 Agent：

- User Message Router Agent

范围：

- 用户消息意图识别。
- handling plan 生成。
- 影响范围判断。
- 是否暂停判断。
- 是否需要任务契约修订判断。

验收标准：

- 可以识别 clarification、constraint、command、question、correction、knowledge_input、preference_input。
- 执行中用户插话能生成处理计划。
- 与任务契约冲突时进入等待用户决策。

#### 5.3.5 Orchestrator 与 Task

负责 Agent：

- Orchestrator Agent
- Task Service Agent

范围：

- 组织 Agent 讨论。
- 生成任务契约。
- 用户确认后生成动态任务池。
- 投递 BullMQ 任务。
- 处理任务完成、失败、返工。
- 触发执行后复盘。

验收标准：

- 能跑通 v1 闭环。
- Agent 任务状态正确。
- 任务完成后能进入复盘。
- 复盘一致后生成最终交付。

### 5.4 Backend Team 交付物

- NestJS 模块。
- REST API。
- SSE API。
- PostgreSQL schema。
- BullMQ worker。
- 默认 Agent seed。
- 状态机。
- 事件流。
- User Message Router。
- Orchestrator。

### 5.5 Backend Team 依赖

依赖 Product & Architecture Team：

- API Contract。
- Event Contract。
- 数据模型确认。

依赖 Runtime & Integration Team：

- Runtime Adapter 接口。
- Capability 调用接口。

依赖 RAG & Memory Team：

- Context Pack 接口。
- RAG 检索接口。
- Memory 检索接口。

## 6. Runtime & Integration Agent Team 拆分

### 6.1 Team 定位

负责 Agent Runtime、MCP、技能、工具和外部系统集成。

### 6.2 Team 成员

- Runtime Lead Agent
- Mock Runtime Agent
- Generic LLM Runtime Agent
- Codex Runtime Agent
- Claude Code Runtime Agent
- MCP Adapter Agent
- Feishu Connector Agent
- Capability Policy Agent

### 6.3 v1 范围

v1 优先实现：

- MockRuntime。
- GenericLlmRuntime。
- Capability Registry 雏形。
- Feishu mock 或草稿能力。
- Runtime Invocation 记录。

v1 不实现或仅预留：

- 真实 Codex Runtime。
- 真实 Claude Code Runtime。
- 真实文件修改。
- 真实飞书发送。

### 6.4 v2 范围

v2 实现：

- CodexRuntimeAdapter。
- ClaudeCodeRuntimeAdapter。
- 受控代码修改。
- run_test。
- git_diff。
- 飞书确认后发送。
- runtime cancel、timeout、retry。

实施状态（2026-05-30）：

- 已落地：CodexRuntimeAdapter、ClaudeCodeRuntimeAdapter 通过子进程接入真实 CLI（real-first，默认关闭或 CLI 不可用时返回可见失败而非崩溃）；受控代码修改（file_write）、command_run、run_test、git_diff 经 ToolExecutorService 在工作区沙箱内执行，受能力策略与 `ENABLE_HIGH_RISK_TOOLS` / `ALLOW_FILE_WRITE_RUNTIME` / `ALLOW_COMMAND_RUNTIME` 多重 gate；runtime timeout、retry、cancel 已接入。回归见 `npm run test:e2e:v2-runtime`，配置见 README「Agentic Coding Runtimes (v2)」。
- 后置：真实 Codex/Claude Code CLI 的生产级深度接入与凭证管理、飞书确认后真实发送仍属后续范围。

### 6.5 交付物

- Runtime Adapter 接口。
- MockRuntime。
- GenericLlmRuntime。
- Capability Registry。
- Invocation Log。
- 高风险能力确认流程。

## 7. RAG & Memory Agent Team 拆分

### 7.1 Team 定位

负责 RAG 知识库、Memory 分层、Context Pack 组装和 token 上下文治理。

### 7.2 Team 成员

- Context Manager Agent
- RAG Knowledge Agent
- Document Indexing Agent
- Memory Manager Agent
- Token Budget Agent
- Context Compression Agent

### 7.3 模块拆分

#### 7.3.1 RAG Knowledge

范围：

- knowledge_bases。
- knowledge_documents。
- knowledge_chunks。
- agent_knowledge_bases。
- rag_retrieval_logs。
- 文本粘贴。
- Markdown 上传。
- 文档切分。
- 向量化。
- Agent 专属知识库检索。

验收标准：

- 用户可以给指定 Agent 添加 RAG。
- Agent 执行前可以检索自己的 RAG。
- RAG 命中结果可以展示来源。
- RAG 不覆盖任务契约。

#### 7.3.2 Memory

范围：

- 短期记忆。
- 会话记忆。
- 长期记忆候选。
- Memory 检索。
- Memory 冲突提示。

验收标准：

- 任务契约能生成会话记忆。
- 用户偏好可以作为长期记忆候选。
- Agent Context Pack 能拿到相关 Memory。

#### 7.3.3 Context Pack

范围：

- Context Pack 组装。
- 事件摘要。
- RAG 注入。
- Memory 注入。
- Capability 注入。
- token 预检。

验收标准：

- 不把完整群聊历史传给 Agent。
- 不同 Agent 拿到不同上下文。
- Context Pack 可审计。

### 7.4 交付物

- RAG API。
- 文档索引 worker。
- Context Pack Service。
- Memory Service。
- Token Budget Service。
- RAG 命中日志。

## 8. Test Agent Team 拆分

### 8.1 Team 定位

负责测试策略、测试用例、自动化测试和回归验证。

### 8.2 Team 成员

- Test Lead Agent
- Backend Test Agent
- Frontend Test Agent
- E2E Test Agent
- Contract Test Agent
- Regression Test Agent

### 8.3 测试范围

#### 8.3.1 后端测试

覆盖：

- Session 状态机。
- Event 写入和查询。
- User Message Router。
- Task Brief。
- Orchestrator。
- RAG 检索。
- Memory 检索。
- Capability 权限。
- Token Budget。

#### 8.3.2 前端测试

覆盖：

- 三栏布局。
- 会话列表。
- 群聊消息。
- Agent 状态卡片。
- 确认卡片。
- SSE 事件更新。
- 视图切换。

#### 8.3.3 契约测试

覆盖：

- API request/response。
- Event payload。
- Task Brief schema。
- Context Pack schema。
- Runtime Adapter schema。

#### 8.3.4 E2E 测试

核心链路：

```text
创建会话
  -> Agent 讨论
  -> 生成任务契约
  -> 用户确认
  -> dry-run 执行
  -> Agent 状态变化
  -> 复盘一致性
  -> 最终交付
```

执行中插话链路：

```text
执行中用户发送“不要修改数据库”
  -> User Message Router 识别 constraint
  -> 暂停受影响任务
  -> Agent 评估影响
  -> 更新任务契约或等待用户确认
```

RAG 链路：

```text
给测试 Agent 添加测试规范
  -> 创建知识库
  -> 上传 Markdown
  -> 索引完成
  -> 测试 Agent 执行前命中 RAG
  -> 群聊中展示引用来源
```

### 8.4 交付物

- 测试计划。
- 测试用例。
- 单元测试。
- 集成测试。
- E2E 测试。
- 契约测试。
- 回归测试报告。

## 9. Quality Acceptance Agent Team 拆分

### 9.1 Team 定位

质量验收 Team 不只看测试是否通过，而是从 PRD、系统设计和用户体验角度判断 v1 是否真的可交付。

### 9.2 Team 成员

- QA Lead Agent
- PRD Consistency Agent
- UX Acceptance Agent
- Security Acceptance Agent
- Data Integrity Agent
- Delivery Acceptance Agent

### 9.3 验收维度

#### 9.3.1 PRD 一致性

检查：

- 是否支持多 Agent 讨论。
- 是否支持用户确认任务契约。
- 是否支持执行中用户插话。
- 是否支持执行后复盘一致性。
- 是否支持三种视图的基础能力。
- 是否支持 Agent 专属 RAG。

#### 9.3.2 用户体验验收

检查：

- 用户是否能理解当前状态。
- 用户是否知道哪个 Agent 正在做什么。
- 用户是否能看到 Agent 之间的协作。
- 用户是否能方便地确认、暂停、继续、补充。
- 事件很多时是否可读。

#### 9.3.3 数据一致性验收

检查：

- 事件流和任务状态是否一致。
- Agent 卡片状态是否与后端一致。
- SSE 断开重连后是否能恢复。
- 任务契约版本是否正确。
- RAG 命中日志是否可追溯。

#### 9.3.4 安全验收

检查：

- 高风险能力是否需要确认。
- 用户最新约束是否优先。
- RAG 权限是否按 Agent 生效。
- Runtime 是否不能越权访问能力。

### 9.4 验收产物

- PRD 验收矩阵。
- 系统设计验收矩阵。
- UX 验收报告。
- 安全验收报告。
- 发布建议。

## 10. DevOps Agent Team 拆分

### 10.1 Team 定位

负责开发环境、运行环境、部署、日志、监控、CI 和交付。

### 10.2 Team 成员

- DevOps Lead Agent
- Local Environment Agent
- Database Ops Agent
- Queue Ops Agent
- Observability Agent
- CI Agent
- Release Agent

### 10.3 模块拆分

#### 10.3.1 本地开发环境

范围：

- Docker Compose。
- PostgreSQL。
- Redis。
- pgvector。
- 后端启动脚本。
- 前端启动脚本。

验收标准：

- 新开发者可以一键启动本地环境。
- migration 可执行。
- seed 可执行。

#### 10.3.2 CI

范围：

- lint。
- typecheck。
- unit tests。
- integration tests。
- build。

#### 10.3.3 观测

范围：

- 后端结构化日志。
- Runtime invocation log。
- Queue job log。
- token usage log。
- RAG retrieval log。
- SSE connection log。

#### 10.3.4 发布

范围：

- 环境变量模板。
- 部署文档。
- release checklist。
- rollback checklist。

### 10.4 交付物

- Docker Compose。
- 环境变量模板。
- CI 配置。
- migration 运行说明。
- 日志规范。
- 发布手册。

## 11. Team 间协作协议

### 11.1 交接物

Product & Architecture -> Frontend：

- 页面信息架构。
- 路由设计。
- UI 状态定义。
- Event Contract。

Product & Architecture -> Backend：

- API Contract。
- Event Contract。
- 数据模型。
- 状态机。

Backend -> Frontend：

- REST API。
- SSE 事件。
- 错误码。
- mock 数据。

Backend -> Test：

- API 文档。
- 数据库 schema。
- 状态机规则。
- 测试账号或 seed 数据。

RAG & Memory -> Backend：

- Context Pack 接口。
- RAG 检索接口。
- Memory 检索接口。

Runtime & Integration -> Backend：

- Runtime Adapter。
- Capability 调用接口。
- invocation result schema。

Test -> Quality Acceptance：

- 测试报告。
- 覆盖率。
- 已知问题。
- 回归结论。

DevOps -> 所有 Team：

- 本地环境。
- CI 结果。
- 部署环境。
- 日志入口。

### 11.2 协作事件类型

实施过程中的 Agent Team 也使用事件同步：

```text
design_contract_created
api_contract_updated
frontend_mock_ready
backend_api_ready
runtime_adapter_ready
rag_indexing_ready
test_case_created
test_failed
quality_issue_found
deployment_ready
risk_reported
dependency_blocked
milestone_completed
```

### 11.3 冲突处理

常见冲突：

- 前端需要字段但 API Contract 没有。
- 后端事件类型变化导致前端渲染失败。
- Runtime 输出不符合 Orchestrator 预期。
- RAG 检索结果不稳定影响测试。
- 测试发现 PRD 与实现不一致。

处理流程：

```text
发现冲突
  -> 写入 risk_reported 或 dependency_blocked
  -> System Coordinator 召集相关 Team
  -> Product & Architecture 判断是否修改契约
  -> 生成 contract update
  -> 受影响 Team 评估返工
  -> 更新实施计划
```

## 12. 按 Milestone 的 Team 协作拆分

### 12.1 Milestone 1：基础会话与事件流

主责 Team：

- Backend Agent Team
- Frontend Agent Team
- DevOps Agent Team

关键交付：

- 数据库 schema。
- Session API。
- Event API。
- SSE。
- 三栏页面框架。
- 本地开发环境。

验收 Team：

- Test Agent Team。
- Quality Acceptance Agent Team。

### 12.2 Milestone 2：Agent 讨论与任务契约

主责 Team：

- Backend Agent Team。
- Runtime & Integration Agent Team。
- Frontend Agent Team。

关键交付：

- GenericLlmRuntime 或 MockRuntime。
- Agent 讨论事件。
- 任务契约生成。
- 用户确认卡片。

### 12.3 Milestone 3：任务执行与 Agent 状态

主责 Team：

- Backend Agent Team。
- Runtime & Integration Agent Team。
- Frontend Agent Team。

关键交付：

- agent_tasks。
- BullMQ worker。
- dry-run 执行。
- Agent 状态卡片。
- 执行事件实时展示。

### 12.4 Milestone 4：RAG 与 Memory

主责 Team：

- RAG & Memory Agent Team。
- Backend Agent Team。
- Frontend Agent Team。

关键交付：

- Knowledge Base。
- 文档上传/粘贴。
- RAG 检索。
- Agent 绑定 RAG。
- Context Pack。
- Memory 基础分层。

### 12.5 Milestone 5：用户消息处理协议

主责 Team：

- Backend Agent Team。
- Frontend Agent Team。
- Test Agent Team。

关键交付：

- User Message Router。
- 执行中插话。
- 影响范围判断。
- 任务暂停和恢复。
- 群聊处理过程展示。

### 12.6 Milestone 6：复盘与交付

主责 Team：

- Backend Agent Team。
- Runtime & Integration Agent Team。
- Frontend Agent Team。
- Quality Acceptance Agent Team。

关键交付：

- Post Review。
- 一致性检查。
- 最终交付卡片。
- Artifact 展示。

### 12.7 Milestone 7：可视化增强

主责 Team：

- Frontend Agent Team。
- Backend Agent Team。

关键交付：

- 协作流转图。
- 工作流视图。
- 三种视图数据适配。

## 13. v1 完成定义

v1 完成时，所有 Team 需要共同满足：

- 用户可以创建会话并输入自然语言需求。
- Agent 可以讨论并生成任务契约。
- 用户可以确认或补充需求。
- 系统可以 dry-run 执行任务。
- 群聊视图可以展示 Agent 协作过程。
- 右侧 Agent 卡片可以展示动态状态。
- 用户执行中插话可以被路由和处理。
- 每个 Agent 可以绑定并检索自己的 RAG。
- 执行完成后可以进行复盘一致性检查。
- 最终交付卡片可以展示完成结果。
- 所有关键动作进入事件流。
- 基础测试通过。
- 质量验收通过。
- 本地环境可一键启动。

## 14. 开工顺序与阻塞关系

### 14.1 第一批必须先完成的契约

正式编码前，Product & Architecture Agent Team 需要先冻结以下契约的 v0.1 版本：

- [Event Contract](./contracts/event-contract-v0.1.md)：事件类型、payload、metadata、前端渲染规则。
- [API Contract](./contracts/api-contract-v0.1.md)：Session、Event、Agent、Task Brief、Knowledge 的核心接口。
- [Data Contract](./contracts/data-contract-v0.1.md)：sessions、agents、collaboration_events、task_briefs、agent_tasks、knowledge_bases 的最小字段。
- [UI State Contract](./contracts/ui-state-contract-v0.1.md)：会话状态、任务状态、Agent 状态、确认卡片状态。
- [Runtime Contract](./contracts/runtime-contract-v0.1.md)：MockRuntime 和 GenericLlmRuntime 的输入输出结构。

这些契约不是最终版本，但必须能支撑 Milestone 1 到 Milestone 3 并行开发。

### 14.2 开工顺序

建议按以下顺序启动：

```text
Step 1：Product & Architecture Team 冻结 v0.1 契约
  ↓
Step 2：DevOps Team 搭建本地环境
  ↓
Step 3：Backend Team 建立 schema、Session、Event、SSE
  ↓
Step 4：Frontend Team 基于 mock API 搭三栏主界面
  ↓
Step 5：Runtime Team 提供 MockRuntime
  ↓
Step 6：Backend Team 接 Orchestrator 和 Task Brief
  ↓
Step 7：Frontend Team 接确认卡片和 Agent 状态卡片
  ↓
Step 8：RAG & Memory Team 接基础 RAG 和 Context Pack
  ↓
Step 9：Test Team 补齐核心 E2E
  ↓
Step 10：Quality Acceptance Team 做 v1 闭环验收
```

### 14.3 关键阻塞关系

- Frontend Team 不应等待后端全部完成，可以先基于 Event Contract 和 mock 数据开发。
- Backend Team 不应等待真实 LLM/Codex，可以先接 MockRuntime。
- Test Team 不应等待全部功能完成，应从 Milestone 1 开始写契约测试和 E2E 骨架。
- RAG & Memory Team 不应阻塞基础会话，可以在 Milestone 4 接入 Context Pack。
- DevOps Team 必须在 Milestone 1 前完成本地 PostgreSQL、Redis、pgvector 环境。
- Quality Acceptance Team 从 Milestone 2 开始参与，不要最后才验收。

## 15. v1 可执行任务清单

### 15.1 Product & Architecture Team Tasks

P0：

- 输出 [event-contract-v0.1.md](./contracts/event-contract-v0.1.md)。
- 输出 [api-contract-v0.1.md](./contracts/api-contract-v0.1.md)。
- 输出 [data-contract-v0.1.md](./contracts/data-contract-v0.1.md)。
- 输出 [ui-state-contract-v0.1.md](./contracts/ui-state-contract-v0.1.md)。
- 输出 [runtime-contract-v0.1.md](./contracts/runtime-contract-v0.1.md)。

P1：

- 输出 v1 用户主流程图。
- 输出任务契约字段说明。
- 输出前端页面信息架构。
- 输出质量验收矩阵初版。

完成标准：

- Frontend、Backend、Test 三个 Team 可以基于契约并行开发。

### 15.2 Frontend Team Tasks

P0：

- 初始化 Vue3 + TypeScript + Pinia + Element Plus 项目。
- 实现三栏基础 layout。
- 实现会话历史 sidebar。
- 实现群聊消息列表。
- 实现用户输入框。
- 实现 SSE client。
- 实现 AgentStatusPanel 和 AgentStatusCard。
- 实现任务契约确认卡片。
- 基于 mock events 渲染完整协作过程。

P1：

- 实现消息过滤。
- 实现 RAG 命中来源卡片。
- 实现工具调用卡片。
- 实现协作流转图简版。
- 实现工作流视图简版。

完成标准：

- 即使后端只有 mock events，前端也能演示完整 v1 协作闭环。

### 15.3 Backend Team Tasks

P0：

- 初始化 NestJS 项目结构。
- 配置 PostgreSQL、Redis、BullMQ。
- 实现 migration。
- 实现默认 Agent seed。
- 实现 Session Module。
- 实现 Collaboration Event Module。
- 实现 SSE 推送。
- 实现 Task Brief 基础 API。
- 实现 Agent Task 基础模型。
- 实现 User Message Router 雏形。
- 实现 Orchestrator v0。

P1：

- 实现任务暂停、恢复、取消。
- 实现 Post Review 流程。
- 实现 Artifact Module。
- 实现 Debug API。

完成标准：

- 可以通过 API 完成“创建会话 -> 写事件 -> 生成任务契约 -> 用户确认 -> dry-run 执行 -> 复盘交付”。

### 15.4 Runtime & Integration Team Tasks

P0：

- 定义 `AgentRuntimeAdapter` 接口。
- 实现 MockRuntime。
- 实现 GenericLlmRuntime 的接口封装。
- 实现 Runtime Invocation 记录。
- 实现 Capability Registry 雏形。

P1：

- 实现 Feishu draft mock。
- 实现高风险能力确认流程。
- 预留 CodexRuntimeAdapter 和 ClaudeCodeRuntimeAdapter 文件结构。

完成标准：

- Backend Orchestrator 可以通过 Runtime Module 统一调用 MockRuntime 或 GenericLlmRuntime。

### 15.5 RAG & Memory Team Tasks

P0：

- 实现 knowledge_bases、knowledge_documents、knowledge_chunks。
- 实现文本粘贴导入。
- 实现 Markdown 上传导入。
- 实现文档切分。
- 实现向量化和 pgvector 检索。
- 实现 Agent 绑定知识库。
- 实现 RAG retrieval log。
- 实现 Context Pack v0。

P1：

- 实现短期记忆。
- 实现会话记忆。
- 实现长期记忆候选。
- 实现 Context Pack debug view。

完成标准：

- 指定 Agent 执行前可以检索自己的 RAG，并在事件或 Agent 卡片中展示引用来源。

### 15.6 Test Team Tasks

P0：

- 输出测试计划。
- 建立后端单元测试框架。
- 建立 API 契约测试。
- 建立前端组件测试框架。
- 建立 E2E 测试骨架。
- 编写创建会话 E2E。
- 编写任务契约确认 E2E。
- 编写 dry-run 执行 E2E。

P1：

- 编写用户执行中插话 E2E。
- 编写 RAG 命中 E2E。
- 编写 SSE 重连测试。
- 编写非法状态迁移测试。

完成标准：

- v1 核心闭环有自动化回归用例。

### 15.7 Quality Acceptance Team Tasks

P0：

- 输出 PRD 验收矩阵。
- 输出系统设计验收矩阵。
- 定义 v1 演示脚本。
- 定义阻断级问题标准。

P1：

- 执行 UX 验收。
- 执行数据一致性验收。
- 执行安全验收。
- 输出发布建议。

完成标准：

- 能明确判断 v1 是“可交付”“带风险交付”还是“不可交付”。

### 15.8 DevOps Team Tasks

P0：

- 提供 Docker Compose。
- 配置 PostgreSQL。
- 配置 Redis。
- 配置 pgvector。
- 提供 `.env.example`。
- 提供本地启动文档。
- 配置 lint、typecheck、test、build 脚本。

P1：

- 配置 CI。
- 配置结构化日志。
- 配置队列监控基础能力。
- 输出 release checklist。

完成标准：

- 新开发者可以按文档启动前端、后端、数据库、Redis，并跑通 migration 和 seed。

## 16. 是否可以按本文档直接开发

结论：可以作为 v1 开发拆分和协作依据，但开工前必须先补齐第 14.1 节的五份 v0.1 契约。

原因：

- 当前文档已经明确 Team、职责、模块、交付物、依赖、里程碑和完成定义。
- 但真正并行编码需要稳定的 API、事件、数据、状态和 Runtime 契约。
- 如果不先冻结这些契约，前后端、测试和 Runtime Team 会在字段和状态上反复返工。

推荐开工方式：

1. 先让 Product & Architecture Team 在 1 到 2 天内输出五份 v0.1 契约。
2. Frontend Team 和 Backend Team 同时基于 mock 开始 Milestone 1。
3. Runtime Team 同步完成 MockRuntime。
4. Test Team 从第一天开始写 E2E 骨架。
5. 每完成一个 Milestone，由 Quality Acceptance Team 做一次小验收。

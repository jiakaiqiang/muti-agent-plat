# Agent Cluster 协作系统设计文档 v1

## 1. 文档目标

本文档基于 [Agent Cluster 协作系统 PRD v1](../product/agent-cluster-prd-v1.md)，给出第一版可落地的系统设计。

设计重点：

- 以多 Agent 协作为核心，而不是传统固定工作流。
- 用统一协作事件流驱动群聊、协作流转图、工作流视图。
- 支持用户自然语言下发任务、Agent 讨论、用户确认、执行、复盘一致性检查。
- 支持每个 Agent 拥有自己的 RAG 知识库。
- 支持 Memory、Context、Token、MCP/技能的统一治理。
- 支持接入 Codex、Claude Code、通用 LLM、MCP Tool 等不同 Runtime。

## 2. 技术栈

前端：

- Vue 3
- TypeScript
- Pinia
- Element Plus
- Vue Router
- Vue Flow，用于协作流转图和工作流视图
- SSE 或 WebSocket，用于实时事件推送

后端：

- NestJS
- TypeScript
- PostgreSQL
- Redis
- BullMQ，用于异步任务队列
- pgvector，用于 RAG 和 Memory 向量检索

运行时：

- Generic LLM Runtime
- Codex Runtime
- Claude Code Runtime
- MCP Tool Runtime
- Human Runtime
- Feishu Connector

第一版优先实现单用户模式，但表结构保留 `owner_id`、`workspace_id`、`project_id` 等字段。

## 3. 总体架构

```text
Vue 3 Frontend
  ├─ Chat Workspace
  ├─ Agent Status Panel
  ├─ Collaboration Graph
  └─ Workflow View
        │
        │ REST + SSE/WebSocket
        ▼
NestJS API
  ├─ Session Module
  ├─ Agent Module
  ├─ Collaboration Event Module
  ├─ User Message Router Module
  ├─ Orchestrator Module
  ├─ Task Module
  ├─ Context Module
  ├─ Memory Module
  ├─ RAG Knowledge Module
  ├─ Runtime Module
  ├─ Capability Module
  ├─ Token Budget Module
  ├─ Artifact Module
  └─ Notification Module
        │
        ├───────────────┐
        ▼               ▼
PostgreSQL          Redis + BullMQ
  ├─ Events           ├─ Agent jobs
  ├─ Sessions         ├─ RAG indexing jobs
  ├─ Tasks            ├─ Runtime jobs
  ├─ Memories         └─ Notification jobs
  ├─ RAG chunks
  └─ Invocations
        │
        ▼
Runtime Layer
  ├─ Generic LLM Provider
  ├─ Codex Adapter
  ├─ Claude Code Adapter
  ├─ MCP Adapter
  ├─ Local Tool Adapter
  └─ Feishu Adapter
```

## 4. 核心设计原则

### 4.1 事件流是事实源

系统底层以 `collaboration_events` 作为事实源。

群聊消息、Agent 状态变化、任务创建、任务认领、工具调用、用户确认、RAG 命中、复盘结论都写入事件流。

三种视图都基于事件流渲染：

- 群聊视图：按时间排序展示事件。
- 协作流转图：按 `from_agent_id`、`to_agent_ids`、`task_id` 生成信息流。
- 工作流视图：按任务状态、阶段和依赖关系生成过程图。

### 4.2 Agent 身份与 Runtime 解耦

Agent 是系统定义的协作角色。

Runtime 是 Agent 背后的执行能力。

同一个 Agent 可以使用不同 Runtime：

```text
架构 Agent -> Generic LLM Runtime
后端 Agent -> Codex Runtime
Review Agent -> Claude Code Runtime 或 Generic LLM Runtime
通知 Agent -> Generic LLM Runtime + Feishu Connector
```

### 4.3 Context Pack 动态组装

系统不把完整群聊历史传给每个 Agent。

每次 Agent 执行前，由 Context Module 生成精准的 Context Pack：

- 当前任务契约。
- 当前任务。
- Agent 职责。
- 相关事件摘要。
- 相关 Memory。
- 相关 RAG 检索结果。
- 可用工具。
- 安全策略。
- token 预算。

### 4.4 用户消息优先

用户在 Agent 群中的发言是高优先级协作事件。

用户最新明确要求优先于 Agent 当前计划。

如果用户消息影响任务范围、约束或验收标准，必须进入任务契约修订或用户确认流程。

### 4.5 RAG 与 Memory 分离

RAG 是用户主动补充的知识材料。

Memory 是系统从协作过程中沉淀出的事实、偏好和经验。

二者都可以进入 Context Pack，但来源、写入方式和生命周期不同。

## 5. 后端模块设计

### 5.1 Session Module

职责：

- 创建协作会话。
- 管理会话状态机。
- 维护当前任务契约版本。
- 维护 token 使用总量。
- 提供会话列表、详情、归档能力。

核心状态：

```text
DRAFT_INPUT
AGENT_DISCUSSING
WAIT_USER_CONFIRM
REVISING_BRIEF
EXECUTING
POST_REVIEW
REWORKING
WAIT_USER_DECISION
COMPLETED
FAILED
CANCELLED
```

### 5.2 Agent Module

职责：

- 管理 Agent 定义。
- 管理 Agent 默认 Runtime。
- 管理 Agent 可用 Capability。
- 管理 Agent 绑定的 RAG 知识库。
- 管理 Agent Memory/RAG/token 策略。

第一版内置默认研发 Agent：

- Coordinator Agent
- 需求 Agent
- 架构 Agent
- 前端 Agent
- 后端 Agent
- 测试 Agent
- Review Agent
- 通知 Agent

### 5.3 Collaboration Event Module

职责：

- 写入协作事件。
- 查询会话事件流。
- 推送实时事件。
- 将事件转换为群聊消息、协作图边、工作流节点状态。

事件类型：

```text
user_message
agent_message
agent_mention
task_created
task_claimed
task_started
task_completed
task_rejected
task_reworked
brief_created
brief_updated
brief_confirmed
tool_called
tool_completed
rag_retrieved
memory_used
artifact_created
status_changed
user_confirmation_requested
post_review_started
post_review_completed
final_delivery_created
```

### 5.4 User Message Router Module

职责：

- 识别用户消息意图。
- 判断消息优先级。
- 判断是否影响当前任务契约。
- 判断是否需要暂停任务。
- 找到受影响任务和 Agent。
- 生成 Coordinator 指令。

输入：

```ts
type RouteUserMessageInput = {
  sessionId: string
  userMessage: string
  currentSessionStatus: SessionStatus
  currentBrief?: TaskBrief
  activeTasks: AgentTask[]
  activeAgents: Agent[]
}
```

输出：

```ts
type UserMessageHandlingPlan = {
  intent:
    | 'clarification'
    | 'constraint'
    | 'command'
    | 'question'
    | 'correction'
    | 'knowledge_input'
    | 'preference_input'
  priority: 'low' | 'normal' | 'high' | 'critical'
  shouldPause: boolean
  affectedTaskIds: string[]
  affectedAgentIds: string[]
  requiresBriefRevision: boolean
  requiresUserConfirmation: boolean
  coordinatorInstruction: string
}
```

### 5.5 Orchestrator Module

职责：

- 组织 Agent 讨论。
- 触发任务契约生成。
- 处理用户确认。
- 将任务契约转换为动态任务池。
- 调度 Agent 执行任务。
- 处理返工、等待、复盘、交付。

Orchestrator 不直接做模型推理，而是调度 Agent Runtime。

### 5.6 Task Module

职责：

- 管理动态任务池。
- 管理任务依赖。
- 管理任务状态。
- 支持 Agent 认领任务或 Coordinator 指派任务。
- 记录任务结果和验收状态。

任务状态：

```text
pending
claimed
running
waiting
reviewing
rejected
reworking
completed
cancelled
failed
```

### 5.7 Context Module

职责：

- 为每次 Agent 调用生成 Context Pack。
- 按 Agent、任务、阶段裁剪上下文。
- 调用 Memory Module 获取相关记忆。
- 调用 RAG Module 获取相关知识。
- 调用 Token Budget Module 做 token 预检。

Context Pack 结构：

```ts
type ContextPack = {
  systemRules: string[]
  sessionGoal: string
  taskBrief?: TaskBrief
  currentTask?: AgentTask
  agentProfile: AgentProfile
  relevantEvents: EventSummary[]
  relevantMemories: MemoryItem[]
  ragSnippets: RagSnippet[]
  artifacts: ArtifactSummary[]
  capabilities: CapabilityDefinition[]
  constraints: string[]
  budget: TokenBudgetSnapshot
}
```

### 5.8 Memory Module

职责：

- 管理短期记忆、会话记忆、长期记忆。
- 从事件中提取候选记忆。
- 检索与当前任务相关的记忆。
- 处理记忆冲突。
- 对长期记忆写入发起用户确认。

第一版策略：

- 短期记忆自动生成。
- 会话记忆由任务契约和用户确认生成。
- 长期记忆需要用户确认后写入。

### 5.9 RAG Knowledge Module

职责：

- 管理知识库。
- 管理文档上传、粘贴、导入。
- 文档解析、切分、向量化。
- 按 Agent 权限检索知识片段。
- 记录 RAG 检索日志。

知识库作用域：

```text
global
project
session
agent
role_type
```

RAG 检索流程：

```text
Agent 执行请求
  -> Context Module 生成检索 query
  -> RAG Knowledge Module 找到可访问知识库
  -> pgvector 检索 chunk
  -> 去重、排序、摘要
  -> 注入 Context Pack
  -> 写入 rag_retrieval_logs
```

### 5.10 Runtime Module

职责：

- 统一封装不同 Agent Runtime。
- 对外提供统一 `runAgentTask` 接口。
- 将 Runtime 内部事件转换为协作事件。
- 记录 Runtime 调用、token、错误、产物。

统一接口：

```ts
interface AgentRuntimeAdapter {
  type: RuntimeType
  run(input: AgentRunInput): Promise<AgentRunResult>
  stream?(runId: string): AsyncIterable<AgentRuntimeEvent>
  cancel?(runId: string): Promise<void>
}
```

第一版 Runtime：

- `GenericLlmRuntimeAdapter`
- `CodexRuntimeAdapter`
- `ClaudeCodeRuntimeAdapter`
- `McpToolRuntimeAdapter`
- `HumanRuntimeAdapter`

### 5.11 Capability Module

职责：

- 管理 MCP、工具、技能、Connector。
- 控制 Agent 可用能力。
- 做权限判断。
- 对高风险能力触发用户确认。
- 记录能力调用审计日志。

风险等级：

```text
low: 读取、搜索、摘要
medium: 创建文档、生成草稿、准备通知
high: 修改文件、运行命令、发送飞书、创建 PR
```

### 5.12 Token Budget Module

职责：

- 记录每次模型调用 token 和成本。
- 做调用前 token 预检。
- 支持会话、阶段、Agent、任务预算。
- 超预算时暂停并通知用户。

预算层级：

```text
session
phase
agent
task
runtime_invocation
```

### 5.13 Artifact Module

职责：

- 管理 Agent 产物。
- 支持文本、Markdown、JSON、代码 diff、测试报告、飞书草稿、URL 等产物类型。
- 将产物关联到任务、Agent、事件。

### 5.14 Notification Module

职责：

- 生成通知草稿。
- 调用 Feishu Connector。
- 发送前执行权限检查和用户确认。
- 写入通知结果事件。

## 6. 核心执行链路

### 6.1 创建会话与任务理解

```text
用户输入自然语言任务
  -> POST /sessions
  -> 创建 session
  -> 写入 user_message 事件
  -> User Message Router 识别为新任务
  -> Orchestrator 召集默认 Agent
  -> Context Module 为各 Agent 生成 Context Pack
  -> Runtime Module 调用 Agent 讨论
  -> 写入 agent_message 事件
  -> Coordinator 汇总 Task Brief
  -> 写入 brief_created 事件
  -> Session 状态变为 WAIT_USER_CONFIRM
  -> 前端展示确认卡片
```

### 6.2 用户继续补充需求

```text
用户发送补充消息
  -> 写入 user_message 事件
  -> User Message Router 判断 intent
  -> 如果影响任务契约，Session 状态变为 REVISING_BRIEF
  -> Orchestrator 召集受影响 Agent 重新讨论
  -> 生成新版本 Task Brief
  -> 写入 brief_updated 事件
  -> 等待用户确认
```

### 6.3 用户确认执行

```text
用户点击确认执行
  -> POST /sessions/:id/briefs/:briefId/confirm
  -> 写入 brief_confirmed 事件
  -> Orchestrator 根据 Task Brief 创建 Agent Tasks
  -> 写入 task_created 事件
  -> Session 状态变为 EXECUTING
  -> BullMQ 投递可执行任务
```

### 6.4 Agent 执行任务

```text
Worker 获取任务
  -> Task Module 锁定任务
  -> Context Module 组装 Context Pack
  -> Token Budget Module 预检
  -> Capability Module 注入可用能力
  -> Runtime Module 调用对应 Runtime
  -> Runtime 返回过程事件和结果
  -> 写入 collaboration_events
  -> 写入 artifacts / capability_invocations
  -> 更新 task 状态
  -> Orchestrator 判断下一个可执行任务
```

### 6.5 执行中用户插话

```text
用户发送消息
  -> 写入 user_message 事件
  -> User Message Router 生成 handling plan
  -> 如果 shouldPause=true，暂停受影响任务
  -> Coordinator 在群聊中说明处理策略
  -> 受影响 Agent 评估影响
  -> 必要时更新 Task Brief 或创建返工任务
  -> 如果 requiresUserConfirmation=true，进入 WAIT_USER_DECISION
```

### 6.6 执行后复盘

```text
所有执行任务完成
  -> Session 状态变为 POST_REVIEW
  -> Review Agent 对比 Task Brief 与实际结果
  -> Test Agent 对比验收标准与测试结果
  -> Coordinator 汇总复盘结论
  -> 如果一致，生成 final delivery
  -> 如果不一致，创建 rework task 或进入 WAIT_USER_DECISION
```

## 7. 数据库设计

### 7.1 sessions

```sql
create table sessions (
  id uuid primary key,
  title text not null,
  original_input text not null,
  status text not null,
  owner_id text not null default 'local-user',
  workspace_id text not null default 'default-workspace',
  project_id uuid null,
  current_task_brief_id uuid null,
  token_budget integer null,
  token_used integer not null default 0,
  metadata jsonb not null default '{}',
  created_at timestamptz not null,
  updated_at timestamptz not null
);
```

### 7.2 agents

```sql
create table agents (
  id uuid primary key,
  name text not null,
  role text not null,
  description text null,
  system_prompt text not null,
  runtime_type text not null,
  runtime_config jsonb not null default '{}',
  capability_ids uuid[] not null default '{}',
  rag_policy jsonb not null default '{}',
  default_knowledge_base_ids uuid[] not null default '{}',
  memory_policy jsonb not null default '{}',
  budget_policy jsonb not null default '{}',
  status text not null default 'active',
  created_at timestamptz not null,
  updated_at timestamptz not null
);
```

### 7.3 collaboration_events

```sql
create table collaboration_events (
  id uuid primary key,
  session_id uuid not null references sessions(id),
  type text not null,
  user_message_intent text null,
  priority text null,
  from_agent_id uuid null references agents(id),
  to_agent_ids uuid[] not null default '{}',
  task_id uuid null,
  content text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null
);
```

建议索引：

```sql
create index idx_events_session_created on collaboration_events(session_id, created_at);
create index idx_events_task on collaboration_events(task_id);
create index idx_events_from_agent on collaboration_events(from_agent_id);
```

### 7.4 user_message_handling_plans

```sql
create table user_message_handling_plans (
  id uuid primary key,
  session_id uuid not null references sessions(id),
  event_id uuid not null references collaboration_events(id),
  intent text not null,
  priority text not null,
  should_pause boolean not null default false,
  affected_task_ids uuid[] not null default '{}',
  affected_agent_ids uuid[] not null default '{}',
  requires_brief_revision boolean not null default false,
  requires_user_confirmation boolean not null default false,
  coordinator_instruction text not null,
  status text not null,
  created_at timestamptz not null
);
```

### 7.5 task_briefs

```sql
create table task_briefs (
  id uuid primary key,
  session_id uuid not null references sessions(id),
  version integer not null,
  goal text not null,
  scope jsonb not null default '[]',
  out_of_scope jsonb not null default '[]',
  constraints jsonb not null default '[]',
  acceptance_criteria jsonb not null default '[]',
  risks jsonb not null default '[]',
  open_questions jsonb not null default '[]',
  confirmed_by_user boolean not null default false,
  confirmed_at timestamptz null,
  created_at timestamptz not null
);
```

### 7.6 agent_tasks

```sql
create table agent_tasks (
  id uuid primary key,
  session_id uuid not null references sessions(id),
  title text not null,
  description text not null,
  status text not null,
  assignee_agent_id uuid null references agents(id),
  depends_on_task_ids uuid[] not null default '{}',
  acceptance_criteria jsonb not null default '[]',
  result_summary text null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null,
  updated_at timestamptz not null
);
```

### 7.7 memories

```sql
create table memories (
  id uuid primary key,
  scope text not null,
  owner_id text null,
  project_id uuid null,
  session_id uuid null references sessions(id),
  agent_id uuid null references agents(id),
  content text not null,
  summary text null,
  embedding vector null,
  confidence numeric not null default 1,
  source_event_id uuid null references collaboration_events(id),
  expires_at timestamptz null,
  created_at timestamptz not null
);
```

### 7.8 knowledge_bases

```sql
create table knowledge_bases (
  id uuid primary key,
  name text not null,
  description text null,
  scope text not null,
  owner_id text null,
  project_id uuid null,
  session_id uuid null references sessions(id),
  agent_id uuid null references agents(id),
  role_type text null,
  visibility text not null default 'private',
  embedding_model text not null,
  chunk_strategy jsonb not null default '{}',
  created_at timestamptz not null,
  updated_at timestamptz not null
);
```

### 7.9 knowledge_documents

```sql
create table knowledge_documents (
  id uuid primary key,
  knowledge_base_id uuid not null references knowledge_bases(id),
  title text not null,
  source_type text not null,
  source_uri text null,
  content_hash text not null,
  status text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null,
  updated_at timestamptz not null
);
```

### 7.10 knowledge_chunks

```sql
create table knowledge_chunks (
  id uuid primary key,
  knowledge_document_id uuid not null references knowledge_documents(id),
  knowledge_base_id uuid not null references knowledge_bases(id),
  chunk_index integer not null,
  content text not null,
  summary text null,
  embedding vector not null,
  token_count integer not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null
);
```

### 7.11 agent_knowledge_bases

```sql
create table agent_knowledge_bases (
  id uuid primary key,
  agent_id uuid not null references agents(id),
  knowledge_base_id uuid not null references knowledge_bases(id),
  access_level text not null,
  retrieval_policy jsonb not null default '{}',
  created_at timestamptz not null
);
```

### 7.12 rag_retrieval_logs

```sql
create table rag_retrieval_logs (
  id uuid primary key,
  session_id uuid not null references sessions(id),
  task_id uuid null references agent_tasks(id),
  agent_id uuid not null references agents(id),
  query text not null,
  matched_chunk_ids uuid[] not null default '{}',
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  created_at timestamptz not null
);
```

### 7.13 capability_invocations

```sql
create table capability_invocations (
  id uuid primary key,
  session_id uuid not null references sessions(id),
  agent_id uuid null references agents(id),
  capability_id uuid null,
  runtime_type text not null,
  input_summary text null,
  output_summary text null,
  status text not null,
  risk_level text not null,
  token_input integer not null default 0,
  token_output integer not null default 0,
  cost numeric not null default 0,
  started_at timestamptz not null,
  ended_at timestamptz null
);
```

### 7.14 artifacts

```sql
create table artifacts (
  id uuid primary key,
  session_id uuid not null references sessions(id),
  task_id uuid null references agent_tasks(id),
  agent_id uuid null references agents(id),
  type text not null,
  title text not null,
  uri text null,
  content_summary text null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null
);
```

## 8. API 设计

### 8.1 Sessions

```text
GET    /api/sessions
POST   /api/sessions
GET    /api/sessions/:sessionId
POST   /api/sessions/:sessionId/messages
POST   /api/sessions/:sessionId/pause
POST   /api/sessions/:sessionId/resume
POST   /api/sessions/:sessionId/cancel
```

`POST /api/sessions`：

```json
{
  "input": "帮我重构登录模块，保持旧 token 兼容",
  "agentIds": ["coordinator", "architect", "backend", "test", "review"],
  "tokenBudget": 100000
}
```

### 8.2 Task Briefs

```text
GET  /api/sessions/:sessionId/briefs
POST /api/sessions/:sessionId/briefs/:briefId/confirm
POST /api/sessions/:sessionId/briefs/:briefId/reject
```

### 8.3 Events

```text
GET /api/sessions/:sessionId/events
GET /api/sessions/:sessionId/events/stream
```

第一版推荐使用 SSE：

```text
GET /api/sessions/:sessionId/events/stream
```

推送事件：

```json
{
  "eventId": "evt_1",
  "type": "agent_message",
  "sessionId": "session_1",
  "payload": {}
}
```

### 8.4 Agents

```text
GET    /api/agents
POST   /api/agents
GET    /api/agents/:agentId
PATCH  /api/agents/:agentId
POST   /api/agents/:agentId/knowledge-bases/:knowledgeBaseId
DELETE /api/agents/:agentId/knowledge-bases/:knowledgeBaseId
```

### 8.5 RAG Knowledge

```text
GET    /api/knowledge-bases
POST   /api/knowledge-bases
GET    /api/knowledge-bases/:knowledgeBaseId
POST   /api/knowledge-bases/:knowledgeBaseId/documents
GET    /api/knowledge-bases/:knowledgeBaseId/documents
POST   /api/knowledge-bases/:knowledgeBaseId/search
```

上传或粘贴知识：

```json
{
  "title": "登录模块接口文档",
  "sourceType": "text",
  "content": "..."
}
```

### 8.6 Capabilities

```text
GET   /api/capabilities
GET   /api/capabilities/:capabilityId
POST  /api/capabilities/:capabilityId/approve
```

### 8.7 Artifacts

```text
GET /api/sessions/:sessionId/artifacts
GET /api/artifacts/:artifactId
```

## 9. 前端设计

### 9.1 页面结构

```text
/sessions
  协作会话主页面

/sessions/:sessionId
  单个会话详情，默认群聊视图

/agents
  Agent 管理

/knowledge-bases
  RAG 知识库管理

/capabilities
  MCP/技能/工具能力管理
```

### 9.2 协作会话页面布局

```text
┌──────────────────┬──────────────────────────────┬──────────────────────┐
│ 左侧栏            │ 中间群聊区                    │ 右侧 Agent 状态区     │
│ 30% 操作区        │ Agent / 用户消息流             │ Agent cards           │
│ 70% 历史区        │ 用户输入框 / 确认卡片           │ 动态状态/任务/知识引用 │
└──────────────────┴──────────────────────────────┴──────────────────────┘
```

左侧操作区：

- 新建会话。
- 添加 Agent。
- 添加技能。
- 添加 RAG 知识。
- 添加 MCP 能力。
- 切换视图。

中间群聊区：

- 用户消息。
- Agent 消息。
- @ 消息。
- 任务卡片。
- 用户确认卡片。
- 工具调用卡片。
- RAG 命中来源卡片。
- 复盘结论卡片。

右侧 Agent 状态区：

- Agent 状态。
- 当前任务。
- 思考摘要。
- 行动日志。
- 使用中的工具。
- 使用到的 RAG 片段摘要。
- 阻塞原因。
- 产物链接。

### 9.3 Pinia Store

建议 Store：

```text
useSessionStore
useEventStore
useAgentStore
useTaskStore
useKnowledgeStore
useCapabilityStore
useRuntimeStatusStore
```

`useEventStore` 是前端实时更新核心：

- 连接 SSE。
- 增量写入事件。
- 派生聊天消息。
- 派生协作图节点和边。
- 派生任务流程状态。

### 9.4 三种视图的数据适配

群聊视图：

```text
collaboration_events -> ChatMessage[]
```

协作流转图：

```text
agents + collaboration_events -> GraphNode[] + GraphEdge[] + Bubble[]
```

工作流视图：

```text
agent_tasks + task_briefs + events -> FlowNode[] + FlowEdge[]
```

## 10. 队列与并发

### 10.1 BullMQ 队列

建议队列：

```text
agent-discussion-queue
agent-task-queue
runtime-invocation-queue
rag-indexing-queue
notification-queue
post-review-queue
```

### 10.2 锁和幂等

需要保证：

- 同一个 `agent_task` 同一时间只能被一个 worker 执行。
- 同一个用户消息只生成一个 handling plan。
- 同一个 knowledge document 相同 content_hash 不重复切分。
- Runtime 调用失败重试不能重复写最终产物。

建议：

- 使用 Redis lock 控制任务执行。
- 所有队列 job 使用业务 id 作为幂等 key。
- 写事件时保留 `metadata.idempotency_key`。

## 11. 安全与权限

第一版单用户，但仍需要能力级权限。

规则：

- 低风险能力可以直接执行。
- 中风险能力需要在 Agent 消息中展示，必要时确认。
- 高风险能力必须用户确认。
- 外部通知发送前必须确认。
- 文件修改、命令执行、PR 创建属于高风险。
- RAG 知识库按 Agent 权限检索。

高风险调用流程：

```text
Agent 请求调用能力
  -> Capability Module 判断 risk_level=high
  -> 写入 user_confirmation_requested 事件
  -> Session 进入 WAIT_USER_DECISION
  -> 用户确认
  -> 执行能力
```

## 12. 观测与审计

第一版需要记录：

- 每个事件。
- 每次 Runtime 调用。
- 每次 MCP/工具调用。
- 每次 RAG 检索。
- 每次 Memory 注入。
- 每次 token 消耗。
- 每个任务状态变化。
- 每个用户确认。

建议增加后台查询能力：

```text
/api/sessions/:sessionId/debug/context-packs
/api/sessions/:sessionId/debug/runtime-invocations
/api/sessions/:sessionId/debug/rag-retrievals
/api/sessions/:sessionId/debug/token-usage
```

这些接口第一版可以只做开发态。

## 13. 错误处理

常见错误：

- Runtime 调用失败。
- Agent 输出结构不合法。
- RAG 文档解析失败。
- token 超预算。
- 高风险工具未授权。
- 用户消息与任务契约冲突。
- 外部系统调用失败。

处理策略：

- Runtime 调用失败：按任务重试策略重试，超过次数后进入 `failed` 或 `WAIT_USER_DECISION`。
- 输出结构不合法：要求 Agent 重新生成结构化输出。
- RAG 解析失败：标记 document status 为 `failed`，展示错误。
- token 超预算：暂停会话，请用户确认是否继续。
- 高风险工具未授权：暂停对应任务。
- 契约冲突：暂停受影响任务，要求 Coordinator 给用户解释。
- 外部系统失败：创建补偿任务或通知用户。

## 14. 第一版实现里程碑

### Milestone 1：基础会话与事件流

- NestJS 项目结构。
- PostgreSQL 表结构。
- Session API。
- Event API。
- SSE 实时推送。
- Vue3 三栏群聊页面。

### Milestone 2：Agent 讨论与任务契约

- Agent 定义。
- Generic LLM Runtime。
- Orchestrator 基础流程。
- 任务契约生成。
- 用户确认卡片。
- 用户补充后重新生成任务契约。

### Milestone 3：任务执行与 Agent 状态

- Agent Task。
- BullMQ Worker。
- Context Pack。
- Runtime Invocation 记录。
- 右侧 Agent 状态卡片。
- 执行事件实时展示。

### Milestone 4：RAG 与 Memory

- Knowledge Base。
- 文档上传/粘贴。
- 切分和向量化。
- Agent 绑定 RAG。
- RAG 检索注入 Context Pack。
- Memory 基础分层。

### Milestone 5：用户消息处理协议

- User Message Router。
- 执行中用户插话。
- 影响范围判断。
- 任务暂停和恢复。
- 任务契约冲突处理。

### Milestone 6：复盘与交付

- Post Review 流程。
- Task Brief vs 实际结果一致性检查。
- 最终交付卡片。
- Artifact 展示。
- 飞书草稿或 mock 通知。

### Milestone 7：可视化增强

- 协作流转图简版。
- 工作流视图简版。
- RAG 命中来源展示。
- 工具调用卡片增强。

## 15. 第一版工程目录建议

### 15.1 后端

```text
apps/server/src
  ├─ modules
  │  ├─ sessions
  │  ├─ agents
  │  ├─ events
  │  ├─ user-message-router
  │  ├─ orchestrator
  │  ├─ tasks
  │  ├─ context
  │  ├─ memory
  │  ├─ rag
  │  ├─ runtimes
  │  ├─ capabilities
  │  ├─ token-budget
  │  ├─ artifacts
  │  └─ notifications
  ├─ workers
  │  ├─ agent-discussion.worker.ts
  │  ├─ agent-task.worker.ts
  │  ├─ rag-indexing.worker.ts
  │  └─ post-review.worker.ts
  ├─ common
  │  ├─ db
  │  ├─ queue
  │  ├─ realtime
  │  └─ errors
  └─ main.ts
```

### 15.2 前端

```text
apps/web/src
  ├─ pages
  │  ├─ sessions
  │  ├─ agents
  │  ├─ knowledge-bases
  │  └─ capabilities
  ├─ components
  │  ├─ chat
  │  ├─ agent-status
  │  ├─ collaboration-graph
  │  ├─ workflow-view
  │  ├─ artifacts
  │  └─ confirmations
  ├─ stores
  │  ├─ session.store.ts
  │  ├─ event.store.ts
  │  ├─ agent.store.ts
  │  ├─ task.store.ts
  │  └─ knowledge.store.ts
  ├─ api
  └─ router
```

## 16. 关键开放问题

第一版开工前仍需确认：

- Codex Runtime 和 Claude Code Runtime 是通过 CLI、SDK、MCP 还是子进程接入。
- 是否第一版就需要真实执行文件修改，还是先以 mock runtime 验证协作链路。
- RAG 第一版是否只支持文本粘贴和 Markdown 上传，还是支持飞书文档导入。
- SSE 是否足够，还是需要 WebSocket 支持双向实时控制。
- 是否需要项目维度的代码仓库配置。

建议第一版先做 mock + Generic LLM Runtime 跑通闭环，再逐步接入 Codex、Claude Code 和真实 MCP 工具。

## 17. 分期落地路线

### 17.1 v1：协作闭环优先

v1 的目标是验证多 Agent 协作系统本身，而不是一开始追求真实代码修改和深度外部系统集成。

核心目标：

- 跑通“用户需求 -> Agent 讨论 -> 任务契约 -> 用户确认 -> Agent 执行 -> 复盘一致性 -> 最终交付”的完整闭环。
- 验证群聊式协作体验。
- 验证右侧 Agent 状态卡片。
- 验证用户执行前确认和执行中插话。
- 验证 RAG 按 Agent 权限检索。
- 验证 Context Pack、Memory、Token、Capability 的基本治理。

v1 Runtime 策略：

- 优先实现 `MockRuntime`。
- 实现 `GenericLlmRuntime`，用于 Agent 讨论、任务契约、复盘总结。
- Coding Runtime 先不深度接入 Codex/Claude Code。
- 代码执行能力先使用 `dry-run` 模式。

v1 RAG 策略：

- 支持文本粘贴。
- 支持 Markdown 或纯文本文件上传。
- 支持项目级知识库。
- 支持 Agent 专属知识库。
- 支持 RAG 命中来源展示。
- 飞书文档导入后置。

v1 实现重点：

1. 建立基础数据模型和事件流。
2. 完成 Vue3 三栏群聊主界面。
3. 完成 Agent 讨论和任务契约生成。
4. 完成用户确认和补充需求后重新讨论。
5. 完成 User Message Router 雏形。
6. 完成 dry-run 执行和 Agent 状态卡片。
7. 完成执行后复盘一致性检查。
8. 完成基础 RAG 和 Context Pack。

v1 不重点做：

- 真实修改代码。
- 真实执行高风险命令。
- 深度接入 Codex/Claude Code。
- 真实发送飞书消息。
- 多用户权限。
- 工作流市场。
- 复杂知识库权限。

### 17.2 v2：真实研发执行能力

v2 的目标是让系统从“协作闭环验证”进入“可完成真实研发任务”。

核心目标：

- 接入真实 Coding Runtime。
- 支持受控代码修改。
- 支持运行测试。
- 支持生成 diff、测试报告、修复总结。
- 支持飞书草稿和用户确认后发送。
- 支持项目仓库配置。

v2 Runtime 策略：

- 接入 `CodexRuntimeAdapter`。
- 接入 `ClaudeCodeRuntimeAdapter`。
- 优先使用 CLI 或子进程方式接入，保持 Adapter 边界稳定。
- Runtime 输出统一转换为 `collaboration_events`、`artifacts`、`capability_invocations`。
- 支持 cancel、timeout、retry。

v2 代码执行策略：

- 引入 `controlled-execution` 模式。
- 文件修改、命令执行、发送飞书、创建 PR 均需要权限策略。
- 高风险能力必须用户确认。
- 记录完整 diff 和命令输出摘要。
- 支持失败后返工任务。

v2 项目配置：

- 项目名称。
- 本地仓库路径。
- 默认技术栈。
- 默认 Agent 团队。
- 默认项目 RAG。
- 允许的工具范围。
- 测试命令配置。

v2 RAG 策略：

- 支持飞书文档导入。
- 支持接口文档导入。
- 支持代码仓库自动生成项目说明。
- 支持知识库重建索引。
- 支持 Agent 卡片展示当前使用的 RAG 片段。

v2 可视化增强：

- 协作流转图从简版升级为可点击、可过滤。
- 工作流视图展示任务依赖和状态。
- 工具调用、RAG 命中、产物生成可在三种视图中互相定位。

v2 成功标准：

- 用户可以让 Agent 团队完成一个小型真实 bug 修复。
- 系统能展示完整讨论、确认、执行、测试、复盘过程。
- 用户能看到代码 diff、测试结果、RAG 引用和最终交付。
- 高风险操作不会绕过用户确认。

### 17.3 v3：规模化协作与生态扩展

v3 的目标是将系统从研发个人工具扩展为可支持更多角色、更多场景、更多外部系统的 Agent 协作平台。

核心目标：

- 支持更多业务场景：产品、运营、数据分析。
- 支持多 Agent 团队模板。
- 支持更丰富的 MCP/技能生态。
- 支持工作流协议编辑器。
- 支持更完善的 Memory 和 RAG 治理。
- 支持多用户、多项目、多权限。

v3 Agent 能力：

- 支持自定义 Agent。
- 支持 Agent 模板。
- 支持 Agent 主动接活。
- 支持 Agent 能力评分和历史表现。
- 支持 Agent 间协作策略配置。

v3 工作流与协作协议：

- 工作流不作为主系统，但作为协作协议和可视化视角增强。
- 支持用户配置协作阶段门禁。
- 支持某些任务必须经过 Review 或测试。
- 支持用户配置不同场景下的 Agent 团队和协作规则。

v3 Memory/RAG：

- 支持长期项目记忆后台。
- 支持记忆冲突检测和人工合并。
- 支持知识库版本管理。
- 支持跨项目知识复用。
- 支持知识来源可信度。
- 支持 RAG 命中效果评估。

v3 MCP/技能生态：

- 支持 MCP server 管理。
- 支持技能市场或内部技能库。
- 支持技能权限分级。
- 支持外部系统 Connector：GitHub、GitLab、Jenkins、飞书、Confluence、Jira、数据库、监控系统。

v3 成本与治理：

- 支持成本报表。
- 支持模型路由策略。
- 支持 Agent 预算策略。
- 支持低价值讨论压缩。
- 支持任务级 ROI 分析。

v3 多用户能力：

- 用户、团队、工作区。
- Agent 权限。
- 项目权限。
- 知识库权限。
- 审批权限。
- 操作审计。

### 17.4 版本边界总结

```text
v1：证明多 Agent 协作闭环成立
  - MockRuntime + GenericLlmRuntime
  - dry-run 执行
  - 基础 RAG
  - 群聊主视图
  - 用户确认和复盘一致性

v2：让系统能完成真实研发任务
  - Codex/Claude Code Runtime
  - controlled-execution
  - 仓库配置
  - 测试执行
  - 飞书草稿和确认发送
  - 协作图/工作流图增强

v3：平台化和生态化
  - 多场景 Agent 团队
  - 多用户权限
  - 工作流协议编辑器
  - MCP/技能生态
  - 高级 Memory/RAG 治理
  - 成本与审计体系
```

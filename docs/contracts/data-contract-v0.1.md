# Data Contract v0.1

## 1. 目标

本契约定义 v1 最小可开发数据模型。后端 migration、前端 mock、测试 fixtures 需要以此为准。

当前 TypeScript 结构以 `packages/shared/src/contracts.ts` 为准。本文档中的 SQL 表结构是目标关系模型；当前实现仍允许使用 file JSON 或 PostgreSQL JSONB collection 作为持久化后端，具体状态见 [功能清单与当前状态](../analysis/feature-inventory-and-status-v1.md)。

### 1.1 当前实现状态

截至 `agent-cluster@0.1.0` 当前工作树：

- 默认持久化可使用本地 file JSON 快照。
- PostgreSQL 后端使用 JSONB collection 单 key upsert 保存集合状态，尚未拆分为本文第 4 节的细粒度关系表。
- RAG 当前使用关键词检索；`knowledge_chunks.embedding` 和 pgvector 属于目标模型和后续迁移范围。
- `capability_invocations` 的目标表语义当前主要由 capability 审计事件和 Runtime invocation log 承载。

## 2. 命名约定

- 数据库字段使用 `snake_case`。
- API 字段使用 `camelCase`。
- 主键使用 UUID。
- 时间字段使用 `timestamptz`。
- JSON 字段使用 `jsonb`。
- 向量字段使用 pgvector `vector`。

## 3. 核心枚举

```ts
type SessionStatus =
  | 'DRAFT_INPUT'
  | 'AGENT_DISCUSSING'
  | 'WAIT_USER_CONFIRM'
  | 'REVISING_BRIEF'
  | 'EXECUTING'
  | 'POST_REVIEW'
  | 'REWORKING'
  | 'WAIT_USER_DECISION'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

type AgentTaskStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'waiting'
  | 'reviewing'
  | 'rejected'
  | 'reworking'
  | 'completed'
  | 'cancelled'
  | 'failed'

type AgentStatus =
  | 'idle'
  | 'discussing'
  | 'thinking'
  | 'running'
  | 'waiting'
  | 'reviewing'
  | 'reworking'
  | 'completed'
  | 'failed'
  | 'disabled'

type RuntimeType =
  | 'mock'
  | 'generic_llm'
  | 'codex'
  | 'claude_code'
  | 'mcp_tool'
  | 'human'

type KnowledgeScope =
  | 'global'
  | 'project'
  | 'session'
  | 'agent'
  | 'role_type'

type CapabilityRiskLevel = 'low' | 'medium' | 'high'

type ArtifactType =
  | 'text'
  | 'markdown'
  | 'json'
  | 'code_diff'
  | 'test_report'
  | 'feishu_draft'
  | 'url'
  | 'file'
```

## 4. 最小表结构

本节是目标关系模型，用于后续 migration 拆分和查询能力增强；不表示当前 PostgreSQL backend 已经以这些表逐项落地。

### 4.1 sessions

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

### 4.2 agents

```sql
create table agents (
  id uuid primary key,
  key text not null unique,
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

默认 Agent key：

```text
coordinator
requirements
architect
frontend
backend
test
review
notification
```

### 4.3 session_agents

```sql
create table session_agents (
  id uuid primary key,
  session_id uuid not null references sessions(id),
  agent_id uuid not null references agents(id),
  status text not null default 'idle',
  current_task_id uuid null,
  thought_summary text null,
  action_summary text null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (session_id, agent_id)
);
```

### 4.4 collaboration_events

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

索引：

```sql
create index idx_events_session_created on collaboration_events(session_id, created_at);
create index idx_events_task on collaboration_events(task_id);
create index idx_events_from_agent on collaboration_events(from_agent_id);
```

### 4.5 user_message_handling_plans

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

### 4.6 task_briefs

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
  created_at timestamptz not null,
  unique (session_id, version)
);
```

### 4.7 agent_tasks

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

### 4.8 knowledge_bases

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

### 4.9 knowledge_documents

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

### 4.10 knowledge_chunks

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

### 4.11 agent_knowledge_bases

```sql
create table agent_knowledge_bases (
  id uuid primary key,
  agent_id uuid not null references agents(id),
  knowledge_base_id uuid not null references knowledge_bases(id),
  access_level text not null,
  retrieval_policy jsonb not null default '{}',
  created_at timestamptz not null,
  unique (agent_id, knowledge_base_id)
);
```

### 4.12 rag_retrieval_logs

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

### 4.13 memories

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
  created_at timestamptz not null,
  updated_at timestamptz not null
);
```

### 4.14 capability_invocations

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

### 4.15 artifacts

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

## 5. 关系规则

- 一个 session 有多个 collaboration_events。
- 一个 session 有多个 task_briefs，但只有一个 current_task_brief。
- 一个 session 有多个 agent_tasks。
- session_agents 表示某个 Agent 在某次会话内的状态。
- knowledge_base 可以绑定到 agent、session、project 或 global。
- agent_knowledge_bases 定义 Agent 对知识库的访问关系。
- memories 可以绑定 session，也可以进一步绑定到指定 agent。
- Runtime Context Pack 中的 `relevantMemories` 必须来自 memories 的可追溯记录。
- artifacts 必须关联 session，可选关联 task 和 agent。

## 6. v0.1 迁移要求

- migration 必须可重复执行和回滚。
- seed 必须创建默认研发 Agent。
- 所有枚举先用 text，后续稳定后再考虑数据库 enum。
- pgvector 扩展需要在初始化 migration 中开启。

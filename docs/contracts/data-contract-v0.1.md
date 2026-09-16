# Data Contract v0.1

主 Agent 协作的身份链、文档确认和策略快照见 [阶段 0 冻结合同](./main-agent-collaboration-contract-v1.md)。本阶段仅新增共享合同/纯校验，不改既有必填数据模型；新增集合和 projection 尚待对应阶段迁移。

## 1. 目标

本契约定义 v1 最小可开发数据模型。后端 migration、前端 mock、测试 fixtures 需要以此为准。

当前 TypeScript 结构以 `packages/shared/src/contracts.ts` 为准。本文档中的 SQL 表结构是目标关系模型；当前实现仍允许使用 file JSON 或 PostgreSQL JSONB collection 作为持久化后端，具体状态见 [功能清单与当前状态](../analysis/feature-inventory-and-status-v1.md)。

### 1.1 当前实现状态

截至 `agent-cluster@0.1.0` 当前工作树：

- 默认持久化可使用本地 file JSON 快照。
- PostgreSQL 后端由版本化关系迁移和集合投影读写，完整记录保留于 source_snapshot；当前迁移与字段以 `modules/persistence/relational/` 为准，本文第 4 节还包含目标模型。
- RAG 当前使用关键词检索；`knowledge_chunks.embedding` 和 pgvector 属于目标模型和后续迁移范围。
- `capability_invocations` 的目标表语义当前主要由 capability 审计事件和 Runtime invocation log 承载。

### 1.2 活动数据规范与硬切换

当前进程只接受以下系统 metadata：

```ts
type SystemDataMetadata = {
  dataSchemaVersion: 3
  dataEpoch: string
  pipelineVersion: 'v2'
  cutoverAt: string
  cutoverAuditId: string
}
```

- `dataSchemaVersion: 3` 是唯一活动数据 schema；版本 2 及更早状态不会被兼容、补字段或迁移后加载。
- `dataEpoch` 在每次受控 cutover 时重新生成。Session、Queue Job、Runtime Invocation、Artifact、Recovery 与 Local Runtime registration 必须与当前 epoch 完全一致。
- file backend 的新默认文件为 `state.v3.json`。显式配置其他文件名不改变 schema 门禁。
- 旧状态必须保留在活动数据根之外的加密只读归档中，供离线审计；Session/Queue/Recovery/Resume 不得读取该归档。
- Runtime output 另有独立 `schemaVersion: "1.0"` 及协商式最小提交 `task_execution_result@2.0`，不能与系统 `dataSchemaVersion: 3` 混用。
- Runtime Invocation 和 Artifact 加载时若缺少 `dataEpoch`、epoch 不匹配或不满足 v3 必填结构，启动门禁直接失败；不补字段、不清洗 metadata、不读取旧记录。
- Artifact 顶层分别持久化必填的 `runtimeProposals`、`platformProjections` 与 `systemEvidence`。`metadata` 是平台白名单类型，不接受任意键，也不再包含 `output`、`fileChanges` 或 `validationEvidence`。模型提议不得混入平台投影；待写入投影不得冒充真实 ChangeSet；真实 ChangeSet 与真实测试不得混入 proposal。
- 启动顺序固定为：加载持久化状态、校验 schema/epoch metadata、完成 Runtime 合同 preflight，然后才允许接收任务。

### 1.3 执行可靠性增量（2026-09-14）

- `logicalOperationsBySession` 保存 LogicalOperation。PostgreSQL V8 新增 `agent_cluster.logical_operations`，关联 Session，source_snapshot 保留完整记录；file 模式保存同名集合。V8 是关系迁移版本，不改变活动 dataSchemaVersion=3。
- 操作字段包括 id/sessionId/taskId/phase、parentId/previousId/scopeKey、policyVersion、deadlineAt/remainingActiveMs、attemptsUsed/maxAttempts/correctionsUsed、status、stopState、activeInvocationId/invocationIds、ownerId、transport、outputContractKey、pauseRequested、executionKind 和诊断/时间字段。所有额度预留须原子持久化后才启动调用；停止未确认及旧进程所有权不明时禁止替代。
- `RoutingContextSnapshot.businessFingerprint` 排除心跳、工具日志计数和用量，纳入业务范围与任务状态；`UserMessageRouting.snapshotRebuildCount` 独立持久化，原因标签覆盖不能重置重建额度。旧终态不能因缺少新字段复活。
- `AgentTask.acceptanceCheckpoint` 保存 inputFingerprint、agentId、decisionSource（rule/model）、decision、invocationId、createdAt。复用前重新检查权限、工具、目标、范围和依赖；接单不等于质量批准。
- `AgentTask.executionOperationId/previousExecutionOperationId/recoveryOriginTaskId` 关联当前及显式新尝试。`executionCheckpoint` 保存 operationId、invocationId、candidateId/hash、stage、writebackId，并投影到 Workflow NodeRun；当前 stage 为 candidate_captured/submission_validated/writeback_confirmed，不能把没有测试证据的记录标为验证通过。
- `RuntimeExecutionCandidate` 经调用日志持久化，内容为有界 ChangeSet、基线、manifestHash/permissionHash、session/workItem/task/workspace 归属、outputVersion、创建/过期时间、原始提交及 Schema 错误。不是可任意读取的文件路径，恢复不读取用户临时目录。
- 向当前 v3 数据新增集合/可选字段，恢复仍停车而非自动重放。旧版本二进制不保证识别新操作/输出；不得通过清空检查点回滚。迁移测试与能力边界见 [可靠性验收](../quality/agent-execution-reliability-checklist-v1.md)。

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
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

type AgentTaskStatus =
  | 'pending'
  | 'assigned'
  | 'accepted'
  | 'claimed'
  | 'running'
  | 'waiting'
  | 'blocked'
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

type TaskRoutingMode =
  | 'coordinator_controlled'
  | 'agent_suggested'
  | 'agent_delegated'

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
  assigned_by_agent_id uuid null references agents(id),
  assignee_agent_id uuid null references agents(id),
  routing_mode text not null default 'coordinator_controlled',
  auto_resolution_attempted boolean not null default false,
  depends_on_task_ids uuid[] not null default '{}',
  acceptance_criteria jsonb not null default '[]',
  result_summary text null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null,
  updated_at timestamptz not null
);
```

说明：

- v1 已落地的 Coordinator 任务规划补充信息，如 `assignmentReason`、`contextRequirements`、`verificationPlan`、`riskNotes`、`requiresUserConfirmation`，当前可放入 `metadata` 做兼容存储，不要求第一阶段立即拆成独立列。

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
- 第一阶段任务流转必须使用 `routing_mode='coordinator_controlled'`。
- `claimed` 是历史兼容状态，显示和产品语义均应解释为“已接受”；目标状态优先使用 `assigned`、`accepted` 和 `blocked`。
- 只有 Coordinator 可以写入 `assigned_by_agent_id` 和改变 `assignee_agent_id`；子 Agent 只能返回接受、阻塞、拒绝或建议交接。
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

## 7. v0.2 迁移说明（双写期）

与 event-contract v0.2、runtime-contract 演进保持一致，`agent_tasks` 增加 `assignee` / `assigned_by` 两列（JSONB, `ActorRef` 结构），旧 `assignee_agent_id` / `assigned_by_agent_id` 保留为双写字段，v0.3 起废弃。

- 结构：`assignee` / `assigned_by` 各存 `{ type: 'user' | 'agent' | 'system', id: uuid, displayName?: string }`。
- 双写：Coordinator 写入任务或改派时，同时写入新旧字段；读侧优先读 `assignee` / `assigned_by`，缺失时回退到旧 id 字段。
- 兼容：M3-05 回填脚本负责为历史数据补齐 `assignee` / `assigned_by`。
- 变更日志：v0.2（2026-07-09，M3-03 起草）新增 `assignee` / `assigned_by`，旧 id 字段进入弃用期。

## 8. v0.2 当前 JSONB collection 实现

当前 file/PostgreSQL persistence backend 新增或扩展以下 collection；这仍是过渡存储，不代表第 4 节关系表已经落地：

| Collection | 结构 | 用途 |
| --- | --- | --- |
| `agents` | `Agent[]` | `Agent.skillIds` 持久化；Skill 删除时清理悬空引用 |
| `skills` | `Skill[]` | Skill CRUD 与受限文件内容 |
| `autopilots` | `Autopilot[]` | Autopilot 配置、schedule 和 enabled 状态 |
| `autopilotRuns` | `AutopilotRun[]` | trigger、issueguard、sessionId 和运行终态 |
| `runtimeInvocations` | invocation log | CLI `cliSessionId/workDir`、status、usage 和 runtimeType |
| `eventsBySession` | session-keyed events | `actor` 与旧 `fromAgentId` 双写 |
| `tasksBySession` | session-keyed tasks | `assignee/assignedBy` 与旧 agentId 双写 |
| `workflowCatalog` | `{ schemaVersion, workflows, versionsByWorkflowId }` | 可变草稿、三类节点、不可变发布版本和归档状态；兼容期双写旧 `workflows` |
| `workflowRuntime` | `{ schemaVersion, runs, nodeRunsByRunId, approvalsByRunId, effectsByRunId }` | 运行快照、节点尝试、人工/机器人决策、显式停车决策、幂等副作用和恢复状态 |

新增 shared 数据结构：

```ts
type Skill = {
  id: string
  name: string
  description?: string
  content: string
  files: Array<{ path: string; content: string }>
  createdAt: string
  updatedAt: string
}

type Autopilot = {
  id: string
  name: string
  prompt: string
  schedule?: string
  enabled: boolean
  runtimeType: 'mock'
  riskLevel: 'low'
  agentIds: string[]
  tokenBudget?: number
}

type AutopilotRun = {
  id: string
  autopilotId: string
  trigger: 'manual' | 'scheduled'
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped'
  issueguardKey: string
  sessionId?: string
}
```

Session 增加 `origin?: 'user' | 'autopilot'` 和 `autopilotRunId?: string`。Autopilot 创建的会话必须写入二者，保证事件、任务、artifact 可沿 session 回溯到 run。

Session 使用 `workflowRunId` 关联独立运行实例；`workflowRun` 仅作为旧版兼容投影，不再是工作流事实源。工作流任务仍存入 `tasksBySession`，并携带 `workflowRunId/workflowNodeId/workflowNodeRunId/workflowAttempt/executionPurpose`。运行事实保存在 `workflowRuntime`，阶段输出和用户确认继续以协作事件形成可审计记录。

Workflow 显式停车状态持久化在对应 `WorkflowRun` 上：

```ts
type WorkflowPendingAgentSubstitution = {
  nodeId: string
  nodeRunId: string
  taskId: string
  currentAgentId: string
  reason: string
  candidates: Array<{ id: string; key: string; name: string; role: string }>
  confirmationId: string
  requestedAt: string
}

type WorkflowRun = {
  // ...
  pendingAgentSubstitution?: WorkflowPendingAgentSubstitution
  pendingUpstreamRerun?: WorkflowPendingUpstreamRerun
}
```

`pendingAgentSubstitution` 存在时必须同时满足 Task=`blocked`、NodeRun=`waiting`、Run=`waiting_human`；Session 投影为 `WAIT_USER_DECISION`。服务重启后必须恢复相同的等待原因、候选、`confirmationId` 和节点 attempt，不能创建新 attempt 或自动调度 Runtime。同一 `runId + taskId` 的确认请求使用固定幂等键，重复恢复只能得到同一张 active confirmation。

改派会清除 pending、将原 Task 改为新 Agent 并恢复当前 NodeRun；跳过会清除 pending、将原 Task 置为终态并将 NodeRun 置为 `skipped`；取消会清除所有 pending 并将 Run/Session 置为取消终态。任何返工或重试都必须追加新 Task 和新 NodeRun attempt，历史记录不得覆盖。

Actor PostgreSQL 回填针对 collection 表执行，默认表名遵循 persistence 配置；`--apply` 前创建时间戳备份表并在事务内更新 `eventsBySession/tasksBySession`。默认仅 dry-run。

## 10. 用户原文件修订数据

`FileRevisionBaseline` 是用户编辑前的不可变 Workspace 基线；`FileRevisionChain` 保存链头、轮次、`workspaceExpectedHash` 和 `stateVersion`；`FileRevisionRun` 是每一轮冻结的处理事实；`FileRevisionEditorDraft` 是候选编辑器中尚未提交的用户草稿。基线、用户稿、内部 Diff、Agent 提案、Receiver 候选和草稿正文都通过 `ContentReference` 保存，确认前不写 Workspace。

正文保留边界与 Session 生命周期一致。Session 存续时保留活动链和终态链正文；删除 Session 时先持久化删除修订状态，再删除当前持久状态中无引用的 ContentStore 对象。内容寻址导致相同正文跨 Session 或模块复用时，仍存在引用的对象不得删除。

第一轮 Run 的 `baseKind='workspace_baseline'`，基线为 `W0`、用户稿为 `U1`；后续轮的 `baseKind='previous_candidate'`，基线为上一轮 `G(n-1)`、用户稿为当前 `Un`。Run 必须保存 `chainId/iteration/parentRevisionId/reprocessKey`、base/userDraft/diff 的 Hash 与内容引用、完整 Agent Result、Receiver invocation、候选 Hash/引用、确认标识、错误和时间戳。同一轮所有 Agent 使用相同 `revisionId/iteration/baseHash/userDraftHash/diffHash/contextSnapshotHash`。

Run 活动状态为 `submitted/processing/synthesizing/awaiting_confirmation/applying`，历史或终态为 `superseded/applied/abandoned/stale/failed/interrupted`。Chain 状态为 `active/applying/applied/abandoned/stale/failed`。所有提交下一轮、应用、放弃和恢复操作按 `chainId` 串行，并通过 `stateVersion` CAS；最终写回以链创建时冻结的 `workspaceExpectedHash` 为乐观并发条件。显式恢复在 Run 保存 `recoveryRetryKey` 和 `recoveryRetryMode='run_agents'|'receiver_only'|'apply_reconcile'`，相同幂等键不得重复推进状态或重复副作用。

`failed` Run 若错误码为 `REVISION_PARTIAL_AGENT_FAILURE`，必须保留每个 Agent 的成功或失败结果并等待显式决策。`retry_agents` 清空旧结果并把同一 Run 重新置为 `submitted`；`continue_with_successful` 保留全部结果、把 Run 置回 `processing` 并只将成功结果交给 Receiver；`abandon_revision` 将 Run 和 Chain 置为 `abandoned`。三种决策都校验链头和 `expectedStateVersion`，不得从其他失败类型恢复。

持久化 collection 的活动结构固定为 `{ schemaVersion: 2, baselines, chains, runs, drafts }`。重启必须恢复待确认候选和草稿；`submitted/processing/synthesizing` 转为可见 `interrupted`，由用户显式重试后根据已持久化 Agent 结果选择 `run_agents` 或 `receiver_only`。`applying` 根据 Workspace Hash 对账为 `applied/awaiting_confirmation/stale`；若写回异常后连 Workspace 也无法读取，则保存 `REVISION_APPLY_OUTCOME_UNKNOWN`，后续显式重试只执行 `apply_reconcile`。删除 Session 时级联清理其修订记录。

候选已经写回但 Run 终态或新基线持久化失败时，只允许保存稳定错误码 `REVISION_APPLY_PERSISTENCE_RECOVERY_REQUIRED` 或 `REVISION_POST_APPLY_BASELINE_FAILED`。Provider、文件系统或数据库的原始错误文本不得进入 Run、协作事件或前端状态。

## Codex 式任务工作区历史合同（2026-09-11）

`SessionListItem` 增加可选 `projectId/workspaceId`，用于真实项目或工作区分组；旧记录缺字段时显示未分组，不猜测目录或项目名。产品新建任务仍创建 Session，旧 WorkItem/sessionId 归属不反转、不迁移。

`WorkflowRun.fileBaseline?: WorkflowFileBaseline` 保存 `{capturedAt,complete,hashes:Record<path,sha256>,reason?}`。在首个节点启动前持久化。基线只保存 Provider 可见文件的哈希，不保存任意本地目录全文。15 秒/512 目录/1024 文件/单文件 2 MiB/总计 32 MiB 的任何缺口都使 complete=false。旧运行没有字段时不可推定存在历史基线。

`WorkflowDeliveryFileDiff` 保存展示结果 `{status:'complete'|'unavailable',source,reason?,files}`；files 为路径、操作与历史 before/after。计算只读取该运行任务关联 Artifact 的 `systemEvidence.workspaceChangeSet`，过滤完成时间之后的产物、去重 ChangeSet ID、校验每步 expectedHash 与开始哈希及前一步目标内容。缺本轮原文、缺任何任务（含取消）的权威证据、断链、只有路径的 move 均明确降级。最终按两端内容对比，create/delete 的存在性与空字符串分开处理；完全撤回的修改不残留。基线扫描不提供文件系统原子快照，对未进入证据的外部修改不作完整性保证。

本轮 Diff 来自保存的 WorkspaceChange；平台生成但尚未写入的内容、报告摘要/正文标为 reference。读取历史不回写文件、不补造旧 baseContent，也不复用 FileRevisionCandidateEditor 的可写操作。

## 11. 会话停止轮次

`sessionStopRequestsBySession` 按 Session 保存 `SessionStopRequest[]`。一次停止轮次具有稳定 `id`、固定 `targetInvocationIds/targets` 和从 1 开始的单调 `version`；未完成轮次上的重复停止复用同一个 `id`，不能重新采样目标。零目标轮次立即进入 `confirmed`。

目标状态仅允许 `waiting/pending_sync/confirmed/unknown`。`confirmed` 必须来自 Adapter 结果或精确匹配的 Local Runtime transport receipt；服务重启后缺失退出证据的活动操作恢复为 unknown，不得按进程内句柄消失推断结束。状态、版本、事件和 outbox 在同一个 `mutateCollections` 事务中提交。

停止轮次与 `logicalOperationsBySession` 共用集合事务锁。存在未确认停止时，新的 operation reserve、Session resume 和 retry 必须 fail closed；禁止删除停止记录、重写目标或重放历史模型调用来解除屏障。

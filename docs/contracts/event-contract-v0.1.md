# Event Contract v0.1

## 1. 目标

协作事件是系统事实源。群聊视图、协作流转图、工作流视图、Agent 状态卡片、测试回放都基于事件流渲染。

本契约定义 v0.1 最小事件结构、事件类型、payload、metadata 和前端渲染规则。

## 2. 基础结构

```ts
type CollaborationEvent = {
  id: string
  sessionId: string
  type: CollaborationEventType
  userMessageIntent?: UserMessageIntent
  priority?: EventPriority
  fromAgentId?: string
  toAgentIds: string[]
  taskId?: string
  content: string
  metadata: EventMetadata
  createdAt: string
}
```

## 3. 通用枚举

```ts
type EventPriority = 'low' | 'normal' | 'high' | 'critical'

type UserMessageIntent =
  | 'clarification'
  | 'constraint'
  | 'command'
  | 'question'
  | 'correction'
  | 'knowledge_input'
  | 'preference_input'
```

## 4. 事件类型

```ts
type CollaborationEventType =
  | 'user_message'
  | 'agent_message'
  | 'agent_mention'
  | 'session_status_changed'
  | 'agent_status_changed'
  | 'brief_created'
  | 'brief_updated'
  | 'brief_confirmed'
  | 'brief_rejected'
  | 'user_confirmation_requested'
  | 'user_confirmation_resolved'
  | 'task_created'
  | 'task_assigned'
  | 'task_accepted'
  | 'task_claimed'
  | 'task_blocked'
  | 'task_reassigned'
  | 'task_started'
  | 'task_waiting'
  | 'task_completed'
  | 'task_rejected'
  | 'task_reworked'
  | 'runtime_started'
  | 'runtime_progress'
  | 'runtime_completed'
  | 'runtime_failed'
  | 'tool_called'
  | 'tool_completed'
  | 'tool_failed'
  | 'rag_retrieved'
  | 'memory_used'
  | 'artifact_created'
  | 'post_review_started'
  | 'post_review_completed'
  | 'final_delivery_created'
  | 'error_reported'
```

## 5. Metadata 基础结构

```ts
type EventMetadata = {
  schemaVersion: '0.1'
  idempotencyKey?: string
  renderAs?: EventRenderType
  title?: string
  summary?: string
  payload?: Record<string, unknown>
}

type EventRenderType =
  | 'chat_message'
  | 'system_notice'
  | 'task_card'
  | 'brief_card'
  | 'confirmation_card'
  | 'tool_card'
  | 'rag_card'
  | 'artifact_card'
  | 'review_card'
  | 'delivery_card'
  | 'error_card'
```

## 6. 核心事件 Payload

### 6.1 user_message

```ts
type UserMessagePayload = {
  text: string
  attachments?: AttachmentRef[]
  mentionedAgentIds?: string[]
}
```

规则：

- 必须写入事件流后再路由。
- 如果识别出意图，`userMessageIntent` 必填。
- 执行中用户插话如果影响任务契约，`priority` 至少为 `high`。

### 6.2 agent_message

```ts
type AgentMessagePayload = {
  messageKind:
    | 'discussion'
    | 'answer'
    | 'handoff'
    | 'progress'
    | 'risk'
    | 'decision'
    | 'summary'
  mentionedAgentIds?: string[]
  mentionedUser?: boolean
  relatedArtifactIds?: string[]
}
```

规则：

- 群聊视图默认按普通消息展示。
- 如果 `mentionedAgentIds` 非空，协作流转图生成从 `fromAgentId` 到 `toAgentIds` 的信息流边。

### 6.3 brief_created / brief_updated

```ts
type BriefEventPayload = {
  briefId: string
  version: number
  goal: string
  scope: string[]
  outOfScope: string[]
  constraints: string[]
  acceptanceCriteria: string[]
  risks: string[]
  openQuestions: string[]
  requiresUserConfirmation: boolean
}
```

前端渲染：

- `renderAs = 'brief_card'`。
- 如果 `requiresUserConfirmation = true`，同时展示“确认执行”“继续沟通”操作。

### 6.4 user_confirmation_requested

```ts
type ConfirmationRequestedPayload = {
  confirmationId: string
  reason:
    | 'confirm_task_brief'
    | 'approve_high_risk_capability'
    | 'resolve_contract_conflict'
    | 'continue_after_budget_warning'
  title: string
  description: string
  options: ConfirmationOption[]
}

type ConfirmationOption = {
  key: string
  label: string
  style?: 'primary' | 'default' | 'danger'
}
```

### 6.5 task_created / task_assigned / task_accepted / task_started / task_completed

```ts
type TaskEventPayload = {
  taskId: string
  title: string
  description?: string
  status: AgentTaskStatus
  assignedByAgentId?: string
  assigneeAgentId?: string
  routingMode?: 'coordinator_controlled' | 'agent_suggested' | 'agent_delegated'
  autoResolutionAttempted?: boolean
  assignmentReason?: string
  contextRequirements?: string[]
  verificationPlan?: string[]
  riskNotes?: string[]
  requiresUserConfirmation?: boolean
  dependsOnTaskIds?: string[]
  acceptanceCriteria?: string[]
  resultSummary?: string
  missingContext?: string[]
  handoffSuggestion?: {
    targetAgentKey?: string
    targetAgentId?: string
    reason: string
    missingContext?: string[]
    riskLevel?: 'low' | 'medium' | 'high'
  } | null
}
```

Coordinator 中心流转兼容规则：

- v1 目标语义中，`task_assigned` 表示 Coordinator 已将任务分配给 `assigneeAgentId`。
- v1 目标语义中，`task_accepted` 表示子 Agent 已接受被分配任务。
- 现有 `task_claimed` 保留兼容，但必须解释为“已接受”，不得解释为子 Agent 自由竞争接活。
- `task_blocked` 表示子 Agent 无法继续，等待 Coordinator 补上下文、改派或请求用户决策。
- `task_reassigned` 必须由 Coordinator 写入；子 Agent 只能通过 `agent_message.metadata.payload.handoffSuggestion` 提出建议。
- 当 Coordinator 已在任务规划阶段确定分配理由、上下文需求、验证方式或风险提示时，应通过 `assignmentReason/contextRequirements/verificationPlan/riskNotes/requiresUserConfirmation` 同步到任务事件 payload，供 UI 解释“为什么这样分配、执行前还缺什么、如何验证、是否要先问用户”。

### 6.6 agent_status_changed

```ts
type AgentStatusChangedPayload = {
  agentId: string
  status: AgentStatus
  currentTaskId?: string
  currentTaskTitle?: string
  thoughtSummary?: string
  actionSummary?: string
  waitingFor?: string[]
  activeCapabilityIds?: string[]
  usedKnowledgeBaseIds?: string[]
}
```

### 6.7 runtime_started / runtime_progress / runtime_completed / runtime_failed

```ts
type RuntimeEventPayload = {
  runtimeInvocationId: string
  runtimeType: RuntimeType
  agentId: string
  taskId?: string
  status: RuntimeInvocationStatus
  progressMessage?: string
  tokenInput?: number
  tokenOutput?: number
  cost?: number
  error?: RuntimeError
  requestedContext?: RuntimeContextRequest
}
```

When `error.code='CONTEXT_INSUFFICIENT'`, `runtime_failed` should render as a visible waiting/blocking card and include the same `requestedContext` on the payload for debug and retry planning.

For real coding runtimes, `runtime_started` must be emitted only after `cap-file-write` preflight passes. If the preflight blocks `codex` or `claude_code`, emit `task_waiting` with `relatedCapabilityId='cap-file-write'`; no `runtime_started` event should be created for that blocked invocation.

### 6.8 tool_called / tool_completed / tool_failed

```ts
type ToolEventPayload = {
  invocationId: string
  capabilityId: string
  capabilityName: string
  riskLevel: CapabilityRiskLevel
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked'
  inputSummary?: string
  outputSummary?: string
  requiresUserConfirmation?: boolean
  error?: string
}
```

### 6.9 rag_retrieved

```ts
type RagRetrievedPayload = {
  retrievalLogId: string
  agentId: string
  query: string
  matchedChunks: RagMatchedChunk[]
}

type RagMatchedChunk = {
  chunkId: string
  knowledgeBaseId: string
  documentId: string
  title: string
  snippet: string
  score: number
}
```

### 6.10 final_delivery_created

```ts
type FinalDeliveryPayload = {
  deliveryId: string
  summary: string
  completedItems: string[]
  incompleteItems: string[]
  outOfScopeChanges: string[]
  testResults: string[]
  risks: string[]
  artifactIds: string[]
}
```

## 7. SSE 推送格式

```text
event: collaboration-event
id: <eventId>
data: <CollaborationEvent JSON>
```

心跳：

```text
event: heartbeat
data: {"time":"2026-05-27T00:00:00.000Z"}
```

重连规则：

- 前端保存最后一个 `event.id`。
- 重连时请求 `GET /api/sessions/:sessionId/events?afterEventId=<id>` 补齐缺失事件。

## 8. 前端渲染规则

- `user_message` 渲染为用户气泡。
- `agent_message` 渲染为 Agent 气泡。
- `brief_created` 和 `brief_updated` 渲染为任务契约卡片。
- `user_confirmation_requested` 渲染为确认卡片。
- `task_*` 渲染为任务状态卡片，同时更新工作流视图。
- `agent_status_changed` 不一定进入聊天主流，但必须更新右侧 Agent 卡片。
- `rag_retrieved` 默认折叠展示，Agent 卡片展示摘要。
- `tool_*` 渲染为工具调用卡片。
- `final_delivery_created` 渲染为最终交付卡片。

## 9. 校验规则

- 所有事件必须有 `id`、`sessionId`、`type`、`content`、`metadata.schemaVersion`、`createdAt`。
- Agent 发出的事件必须有 `fromAgentId`。
- @ 事件必须有 `toAgentIds`。
- 任务事件必须有 `taskId` 或 `metadata.payload.taskId`。
- 高风险工具事件必须包含 `requiresUserConfirmation`。
- `createdAt` 使用 ISO 8601。

## 10. v0.2 迁移说明（双写期）

v0.2 引入统一的 `ActorRef` 表达"事件/任务是谁发起、谁负责、谁分配"，同时保留 v0.1 的旧字段作为双写降级。发布时间点：M3 阶段随 event 序列化改造合入，v0.3 起旧字段将被移除。

### 10.1 新增类型

```ts
type ActorType = 'user' | 'agent' | 'system'

type ActorRef = {
  type: ActorType
  id: string
  displayName?: string
}
```

### 10.2 事件结构新增字段

```ts
type CollaborationEvent = {
  // ...v0.1 已有字段
  actor?: ActorRef            // v0.2 新增；未来主字段
  fromAgentId?: string        // v0.2 保留；v0.3 移除（deprecated）
}
```

### 10.3 任务结构新增字段

```ts
type AgentTask = {
  // ...v0.1 已有字段
  assignee?: ActorRef         // v0.2 新增
  assignedBy?: ActorRef       // v0.2 新增
  assigneeAgentId?: string    // v0.2 保留；v0.3 移除（deprecated）
  assignedByAgentId?: string  // v0.2 保留；v0.3 移除（deprecated）
}
```

### 10.4 双写与推导规则

M3-04 `events.create` 内部依据下列规则推导 `actor`，写入事件时 `actor` 与旧字段同时落盘（双写）：

| 事件场景 | actor.type | actor.id 来源 |
| --- | --- | --- |
| 用户消息 | `user` | 会话用户 id |
| Agent 输出 | `agent` | `fromAgentId` |
| Coordinator 分派/改派/取消 | `agent` | 会话 Coordinator agent id |
| 系统/编排器自身事件（heartbeat、status 切换） | `system` | 固定 `system` |
| Runtime 侧事件（有 `fromAgentId`） | `agent` | 关联 agent id |
| Runtime 侧事件（无 `fromAgentId`） | `system` | 固定 `system` |

任务的 `assignee` / `assignedBy` 由 orchestrator 在分派/接受路径上填入，`AgentTask` 落库同时保留 `assigneeAgentId` / `assignedByAgentId` 直至 v0.3。

### 10.5 前端契约

- 前端时间线组件必须**优先读 `actor`**（M3-06 落地）；`actor` 缺失回退到旧字段：
  - 事件：`actor.id` → `fromAgentId`
  - 任务：`assignee.id` → `assigneeAgentId`；`assignedBy.id` → `assignedByAgentId`
- 展示名优先取 `actor.displayName`，否则由前端根据 `actor.type` + id 查会话 agent 名字兜底。

### 10.6 弃用字段清单

以下字段在 v0.2 保留双写，v0.3 移除：

- `CollaborationEvent.fromAgentId`
- `TaskEventPayload.assigneeAgentId`（v0.2 仍写入以兼容 v0.1 UI）
- `TaskEventPayload.assignedByAgentId`（同上）
- `AgentTask.assigneeAgentId`
- `AgentTask.assignedByAgentId`

### 10.7 迁移清单

- M3-02：`ActorType` / `ActorRef` 加入 `packages/shared/src/contracts.ts`，事件类型追加 `actor?`。
- M3-03：`AgentTask` 追加 `assignee?` / `assignedBy?`；数据层同步。
- M3-04：`events.create` 推导 `actor` 并双写。
- M3-05：历史事件/任务回填脚本，为已有数据补 `actor` / `assignee` / `assignedBy`。
- M3-06：前端时间线读 `actor` 优先，回退旧字段。
- M3-07：v0.2 合同测试回归。

### 10.8 变更日志

- v0.2（2026-07-09，M3-01 起草）：引入 `actor` / `assignee` / `assignedBy` 统一 actor 契约，旧字段进入双写弃用期；v0.3 计划移除。
- v0.2（2026-07-09，M3-07 回归）：`events.service.create` 单点推导 actor（M3-04）、backfill 脚本落地（M3-05）、前端 timeline 走 `useActor` 双数据源渲染（M3-06）。
- v0.2（2026-07-10，R3 完成）：任务创建/更新/改派路径完成 `assignee/assignedBy` 与旧字段双写；file/PostgreSQL collection 回填支持 dry-run、备份和 apply；Actor/Task/backfill 单测及 Web build 通过。

### 10.9 Runtime 恢复审计事件

CLI Resume 失败或 session id 不一致并触发单次 fresh-session fallback 时，必须写入：

```ts
{
  type: 'runtime_progress',
  metadata: {
    code: 'RESUME_FALLBACK',
    runtimeType: 'codex' | 'claude_code',
    priorCliSessionId?: string
  }
}
```

该事件只表达恢复路径切换，不等于运行失败；最终状态仍由后续 `runtime_completed/runtime_failed` 决定。

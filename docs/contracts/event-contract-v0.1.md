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
  | 'task_claimed'
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

### 6.5 task_created / task_started / task_completed

```ts
type TaskEventPayload = {
  taskId: string
  title: string
  description?: string
  status: AgentTaskStatus
  assigneeAgentId?: string
  dependsOnTaskIds?: string[]
  acceptanceCriteria?: string[]
  resultSummary?: string
}
```

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
}
```

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

# API Contract v0.1

## 1. 目标

本契约定义 v1 开发所需的最小 REST API 和 SSE API。第一阶段不做多用户权限，但所有接口保留 `ownerId`、`workspaceId`、`projectId` 字段。

## 2. 通用约定

Base URL：

```text
/api
```

时间格式：

```text
ISO 8601，例如 2026-05-27T14:30:00.000Z
```

通用响应：

```ts
type ApiResponse<T> = {
  data: T
  requestId: string
}
```

通用错误：

```ts
type ApiError = {
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
  requestId: string
}
```

分页响应：

```ts
type PageResponse<T> = {
  items: T[]
  nextCursor?: string
  hasMore: boolean
}
```

## 3. Sessions API

### 3.1 获取会话列表

```text
GET /api/sessions?status=&cursor=&limit=
```

响应：

```ts
type SessionListItem = {
  id: string
  title: string
  status: SessionStatus
  agentCount: number
  requiresUserAction: boolean
  latestEventSummary?: string
  tokenBudget?: number
  tokenUsed: number
  createdAt: string
  updatedAt: string
}
```

### 3.2 创建会话

```text
POST /api/sessions
```

请求：

```ts
type CreateSessionRequest = {
  input: string
  agentIds?: string[]
  projectId?: string
  tokenBudget?: number
  knowledgeBaseIds?: string[]
}
```

响应：

```ts
type CreateSessionResponse = {
  session: SessionDetail
  firstEvent: CollaborationEvent
}
```

### 3.3 获取会话详情

```text
GET /api/sessions/:sessionId
```

响应：

```ts
type SessionDetail = {
  id: string
  title: string
  originalInput: string
  status: SessionStatus
  ownerId: string
  workspaceId: string
  projectId?: string
  currentTaskBriefId?: string
  tokenBudget?: number
  tokenUsed: number
  participatingAgentIds: string[]
  createdAt: string
  updatedAt: string
}
```

### 3.4 发送用户消息

```text
POST /api/sessions/:sessionId/messages
```

请求：

```ts
type SendUserMessageRequest = {
  content: string
  mentionedAgentIds?: string[]
  attachments?: AttachmentInput[]
}
```

响应：

```ts
type SendUserMessageResponse = {
  event: CollaborationEvent
  handlingPlan?: UserMessageHandlingPlan
}
```

### 3.5 暂停、恢复、取消

```text
POST /api/sessions/:sessionId/pause
POST /api/sessions/:sessionId/resume
POST /api/sessions/:sessionId/cancel
```

请求：

```ts
type SessionControlRequest = {
  reason?: string
}
```

响应：

```ts
type SessionControlResponse = {
  session: SessionDetail
  event: CollaborationEvent
}
```

## 4. Task Brief API

### 4.1 获取任务契约列表

```text
GET /api/sessions/:sessionId/briefs
```

响应：

```ts
type TaskBrief = {
  id: string
  sessionId: string
  version: number
  goal: string
  scope: string[]
  outOfScope: string[]
  constraints: string[]
  acceptanceCriteria: string[]
  risks: string[]
  openQuestions: string[]
  confirmedByUser: boolean
  confirmedAt?: string
  createdAt: string
}
```

### 4.2 确认任务契约

```text
POST /api/sessions/:sessionId/briefs/:briefId/confirm
```

请求：

```ts
type ConfirmBriefRequest = {
  note?: string
}
```

响应：

```ts
type ConfirmBriefResponse = {
  brief: TaskBrief
  event: CollaborationEvent
  createdTasks: AgentTask[]
}
```

### 4.3 拒绝或继续沟通

```text
POST /api/sessions/:sessionId/briefs/:briefId/reject
```

请求：

```ts
type RejectBriefRequest = {
  reason: string
  userMessage?: string
}
```

响应：

```ts
type RejectBriefResponse = {
  event: CollaborationEvent
  sessionStatus: SessionStatus
}
```

## 5. Events API

### 5.1 查询事件

```text
GET /api/sessions/:sessionId/events?afterEventId=&cursor=&limit=
```

响应：

```ts
type EventsResponse = PageResponse<CollaborationEvent>
```

### 5.2 SSE 事件流

```text
GET /api/sessions/:sessionId/events/stream
```

SSE event：

```text
event: collaboration-event
id: <eventId>
data: <CollaborationEvent JSON>
```

## 6. Agents API

### 6.1 Agent 列表

```text
GET /api/agents
```

响应：

```ts
type Agent = {
  id: string
  key: string
  name: string
  role: string
  description?: string
  runtimeType: RuntimeType
  status: 'active' | 'disabled'
  capabilityIds: string[]
  defaultKnowledgeBaseIds: string[]
  createdAt: string
  updatedAt: string
}
```

### 6.2 创建 Agent

```text
POST /api/agents
```

请求：

```ts
type CreateAgentRequest = {
  name: string
  role: string
  description?: string
  systemPrompt: string
  runtimeType: RuntimeType
  runtimeConfig?: Record<string, unknown>
  capabilityIds?: string[]
  defaultKnowledgeBaseIds?: string[]
}
```

### 6.3 更新 Agent

```text
PATCH /api/agents/:agentId
```

请求：

```ts
type UpdateAgentRequest = Partial<CreateAgentRequest> & {
  status?: 'active' | 'disabled'
}
```

### 6.4 绑定/解绑知识库

```text
POST   /api/agents/:agentId/knowledge-bases/:knowledgeBaseId
DELETE /api/agents/:agentId/knowledge-bases/:knowledgeBaseId
```

请求：

```ts
type BindKnowledgeBaseRequest = {
  accessLevel: 'read'
  retrievalPolicy?: {
    topK?: number
    minScore?: number
  }
}
```

## 7. Tasks API

```text
GET /api/sessions/:sessionId/tasks
```

响应：

```ts
type AgentTask = {
  id: string
  sessionId: string
  title: string
  description: string
  status: AgentTaskStatus
  assigneeAgentId?: string
  dependsOnTaskIds: string[]
  acceptanceCriteria: string[]
  resultSummary?: string
  createdAt: string
  updatedAt: string
}
```

## 8. Knowledge API

### 8.1 知识库列表

```text
GET /api/knowledge-bases?scope=&agentId=&projectId=&sessionId=
```

响应：

```ts
type KnowledgeBase = {
  id: string
  name: string
  description?: string
  scope: KnowledgeScope
  ownerId?: string
  projectId?: string
  sessionId?: string
  agentId?: string
  roleType?: string
  visibility: 'private' | 'workspace'
  embeddingModel: string
  createdAt: string
  updatedAt: string
}
```

### 8.2 创建知识库

```text
POST /api/knowledge-bases
```

请求：

```ts
type CreateKnowledgeBaseRequest = {
  name: string
  description?: string
  scope: KnowledgeScope
  projectId?: string
  sessionId?: string
  agentId?: string
  roleType?: string
}
```

### 8.3 添加文档

```text
POST /api/knowledge-bases/:knowledgeBaseId/documents
```

请求：

```ts
type CreateKnowledgeDocumentRequest = {
  title: string
  sourceType: 'text' | 'markdown' | 'file' | 'feishu_doc'
  content?: string
  sourceUri?: string
  metadata?: Record<string, unknown>
}
```

响应：

```ts
type KnowledgeDocument = {
  id: string
  knowledgeBaseId: string
  title: string
  sourceType: string
  sourceUri?: string
  status: 'pending' | 'indexing' | 'ready' | 'failed'
  createdAt: string
  updatedAt: string
}
```

### 8.4 检索知识库

```text
POST /api/knowledge-bases/:knowledgeBaseId/search
```

请求：

```ts
type KnowledgeSearchRequest = {
  query: string
  topK?: number
  minScore?: number
}
```

响应：

```ts
type KnowledgeSearchResponse = {
  chunks: RagMatchedChunk[]
}
```

## 9. Artifacts API

```text
GET /api/sessions/:sessionId/artifacts
GET /api/artifacts/:artifactId
```

响应：

```ts
type Artifact = {
  id: string
  sessionId: string
  taskId?: string
  agentId?: string
  type: ArtifactType
  title: string
  uri?: string
  contentSummary?: string
  metadata: Record<string, unknown>
  createdAt: string
}
```

## 10. Capabilities API

```text
GET  /api/capabilities
POST /api/capabilities/:capabilityId/approve
```

```ts
type Capability = {
  id: string
  key: string
  name: string
  type: 'mcp' | 'tool' | 'skill' | 'connector' | 'runtime'
  riskLevel: CapabilityRiskLevel
  description?: string
  requiresCredential: boolean
  requiresUserConfirmation: boolean
}
```

## 11. 错误码

```text
SESSION_NOT_FOUND
INVALID_SESSION_STATUS
BRIEF_NOT_FOUND
BRIEF_ALREADY_CONFIRMED
EVENT_NOT_FOUND
AGENT_NOT_FOUND
KNOWLEDGE_BASE_NOT_FOUND
KNOWLEDGE_DOCUMENT_INDEXING
CAPABILITY_REQUIRES_CONFIRMATION
TOKEN_BUDGET_EXCEEDED
RUNTIME_INVOCATION_FAILED
VALIDATION_ERROR
```

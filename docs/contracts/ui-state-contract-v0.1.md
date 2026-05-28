# UI State Contract v0.1

## 1. 目标

本契约定义前端 v1 最小状态模型、状态流转和事件到 UI 的派生规则。Frontend Team 可基于本契约使用 mock events 开发三栏群聊页面。

## 2. 页面视图

```ts
type SessionViewMode = 'chat' | 'collaboration_graph' | 'workflow'
```

默认视图：

```text
chat
```

## 3. 会话状态

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
```

状态展示文案：

```ts
const sessionStatusLabel = {
  DRAFT_INPUT: '待理解',
  AGENT_DISCUSSING: 'Agent 讨论中',
  WAIT_USER_CONFIRM: '等待确认',
  REVISING_BRIEF: '修订任务契约',
  EXECUTING: '执行中',
  POST_REVIEW: '复盘中',
  REWORKING: '返工中',
  WAIT_USER_DECISION: '等待用户决策',
  COMPLETED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消'
}
```

用户可操作规则：

- `WAIT_USER_CONFIRM`：展示确认执行、继续沟通。
- `EXECUTING`：展示暂停、发送消息、@Agent。
- `WAIT_USER_DECISION`：展示决策卡片。
- `COMPLETED`：展示接受结果、查看产物。
- `FAILED`：展示重试、查看错误。

## 4. Agent 状态

```ts
type AgentCardState = {
  agentId: string
  name: string
  role: string
  status: AgentStatus
  currentTaskId?: string
  currentTaskTitle?: string
  thoughtSummary?: string
  actionSummary?: string
  recentLogs: string[]
  waitingFor: string[]
  activeCapabilityNames: string[]
  usedRagSnippets: RagSnippetSummary[]
  artifactIds: string[]
  updatedAt: string
}
```

Agent 状态文案：

```ts
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
```

颜色建议：

- idle：灰色。
- discussing/thinking：蓝色。
- running：绿色。
- waiting：黄色。
- reviewing：紫色。
- reworking：橙色。
- completed：绿色。
- failed：红色。
- disabled：灰色。

## 5. 聊天消息状态

```ts
type ChatMessage = {
  id: string
  sessionId: string
  senderType: 'user' | 'agent' | 'system'
  senderAgentId?: string
  toAgentIds: string[]
  messageType:
    | 'text'
    | 'task'
    | 'brief'
    | 'confirmation'
    | 'tool'
    | 'rag'
    | 'artifact'
    | 'review'
    | 'delivery'
    | 'error'
  content: string
  createdAt: string
  rawEventId: string
  payload?: Record<string, unknown>
}
```

事件到消息映射：

- `user_message` -> `senderType=user`、`messageType=text`
- `agent_message` -> `senderType=agent`、`messageType=text`
- `brief_created` -> `messageType=brief`
- `user_confirmation_requested` -> `messageType=confirmation`
- `task_*` -> `messageType=task`
- `tool_*` -> `messageType=tool`
- `rag_retrieved` -> `messageType=rag`
- `artifact_created` -> `messageType=artifact`
- `post_review_completed` -> `messageType=review`
- `final_delivery_created` -> `messageType=delivery`
- `error_reported` -> `messageType=error`

## 6. 确认卡片状态

```ts
type ConfirmationCardState = {
  confirmationId: string
  reason:
    | 'confirm_task_brief'
    | 'approve_high_risk_capability'
    | 'resolve_contract_conflict'
    | 'continue_after_budget_warning'
  title: string
  description: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  options: ConfirmationOption[]
  relatedBriefId?: string
  relatedTaskId?: string
  relatedCapabilityId?: string
}
```

规则：

- 同一会话可以有多个历史确认卡片，但同时只能有一个 active confirmation。
- `WAIT_USER_CONFIRM` 时 active confirmation 通常关联 Task Brief。
- `WAIT_USER_DECISION` 时 active confirmation 通常关联冲突、预算或高风险能力。

## 7. Task 状态

```ts
type TaskViewState = {
  taskId: string
  title: string
  status: AgentTaskStatus
  assigneeAgentId?: string
  dependsOnTaskIds: string[]
  acceptanceCriteria: string[]
  resultSummary?: string
}
```

工作流视图节点规则：

- `pending`：灰色。
- `claimed/running`：蓝色或绿色。
- `waiting`：黄色。
- `reviewing`：紫色。
- `rejected/reworking`：橙色。
- `completed`：绿色。
- `failed`：红色。

## 8. Pinia Store 合约

### 8.1 useSessionStore

```ts
type SessionStoreState = {
  sessions: SessionListItem[]
  currentSession?: SessionDetail
  currentViewMode: SessionViewMode
  loading: boolean
}
```

必要 actions：

```ts
loadSessions()
createSession(input)
loadSession(sessionId)
sendMessage(sessionId, content, mentionedAgentIds?)
pauseSession(sessionId)
resumeSession(sessionId)
cancelSession(sessionId)
switchViewMode(mode)
```

### 8.2 useEventStore

```ts
type EventStoreState = {
  eventsBySessionId: Record<string, CollaborationEvent[]>
  connectedSessionId?: string
  sseConnected: boolean
  lastEventIdBySessionId: Record<string, string>
}
```

派生数据：

```ts
chatMessages(sessionId): ChatMessage[]
agentCards(sessionId): AgentCardState[]
taskStates(sessionId): TaskViewState[]
activeConfirmation(sessionId): ConfirmationCardState | undefined
```

### 8.3 useKnowledgeStore

```ts
type KnowledgeStoreState = {
  knowledgeBases: KnowledgeBase[]
  documentsByKnowledgeBaseId: Record<string, KnowledgeDocument[]>
  indexingStatusByDocumentId: Record<string, string>
}
```

## 9. SSE 客户端规则

- 进入会话详情页时连接 `/api/sessions/:sessionId/events/stream`。
- 离开会话详情页时关闭连接。
- 断线后自动重连。
- 重连后根据 `lastEventId` 补拉事件。
- 收到事件后先写入 `useEventStore`，再派生 UI。

## 10. Mock 数据要求

前端 Milestone 1 必须能用 mock events 渲染以下过程：

```text
用户创建会话
需求 Agent 讨论
架构 Agent 讨论
Coordinator 生成任务契约
用户确认执行
后端 Agent dry-run 执行
测试 Agent dry-run 验证
Review Agent 复盘
最终交付
```

## 11. UI 验收规则

- 会话状态和确认卡片状态一致。
- Agent 卡片状态来自事件派生，不手动伪造。
- 群聊消息刷新后可恢复。
- SSE 断开重连后不重复显示事件。
- RAG 命中来源在 Agent 卡片和聊天消息中至少出现一处。

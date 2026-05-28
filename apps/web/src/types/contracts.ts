export type SessionViewMode = 'chat' | 'collaboration_graph' | 'workflow'

export type SessionStatus =
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

export type AgentTaskStatus =
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

export type AgentStatus =
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

export type RuntimeType = 'mock' | 'generic_llm' | 'codex' | 'claude_code' | 'mcp_tool' | 'human'
export type RuntimeInvocationStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked'
export type CapabilityRiskLevel = 'low' | 'medium' | 'high'
export type KnowledgeScope = 'global' | 'project' | 'session' | 'agent' | 'role_type'
export type EventPriority = 'low' | 'normal' | 'high' | 'critical'

export type UserMessageIntent =
  | 'clarification'
  | 'constraint'
  | 'command'
  | 'question'
  | 'correction'
  | 'knowledge_input'
  | 'preference_input'

export type CollaborationEventType =
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

export type EventRenderType =
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

export type ConfirmationReason =
  | 'confirm_task_brief'
  | 'approve_high_risk_capability'
  | 'resolve_contract_conflict'
  | 'continue_after_budget_warning'

export type ConfirmationOption = {
  key: string
  label: string
  style?: 'primary' | 'default' | 'danger'
}

export type RuntimeError = {
  code:
    | 'RUNTIME_TIMEOUT'
    | 'RUNTIME_CANCELLED'
    | 'MODEL_ERROR'
    | 'OUTPUT_SCHEMA_INVALID'
    | 'CAPABILITY_BLOCKED'
    | 'TOKEN_BUDGET_EXCEEDED'
    | 'UNKNOWN_ERROR'
  message: string
  retryable: boolean
  details?: Record<string, unknown>
}

export type EventMetadata<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  schemaVersion: '0.1'
  idempotencyKey?: string
  renderAs?: EventRenderType
  title?: string
  summary?: string
  payload?: TPayload
}

export type CollaborationEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  id: string
  sessionId: string
  type: CollaborationEventType
  userMessageIntent?: UserMessageIntent
  priority?: EventPriority
  fromAgentId?: string
  toAgentIds: string[]
  taskId?: string
  content: string
  metadata: EventMetadata<TPayload>
  createdAt: string
}

export type BriefEventPayload = {
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

export type ConfirmationRequestedPayload = {
  confirmationId: string
  reason: ConfirmationReason
  title: string
  description: string
  options: ConfirmationOption[]
}

export type TaskEventPayload = {
  taskId: string
  title: string
  description?: string
  status: AgentTaskStatus
  assigneeAgentId?: string
  dependsOnTaskIds?: string[]
  acceptanceCriteria?: string[]
  resultSummary?: string
}

export type AgentStatusChangedPayload = {
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

export type RuntimeEventPayload = {
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

export type ToolEventPayload = {
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

export type RagMatchedChunk = {
  chunkId: string
  knowledgeBaseId: string
  documentId: string
  title: string
  snippet: string
  score: number
}

export type RagRetrievedPayload = {
  retrievalLogId: string
  agentId: string
  query: string
  matchedChunks: RagMatchedChunk[]
}

export type FinalDeliveryPayload = {
  deliveryId: string
  summary: string
  completedItems: string[]
  incompleteItems: string[]
  outOfScopeChanges: string[]
  testResults: string[]
  risks: string[]
  artifactIds: string[]
}

export type SessionListItem = {
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

export type SessionDetail = {
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

export type Agent = {
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

export type ChatMessage = {
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

export type RagSnippetSummary = {
  title: string
  snippet: string
  score: number
}

export type AgentCardState = {
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

export type ConfirmationCardState = {
  confirmationId: string
  reason: ConfirmationReason
  title: string
  description: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  options: ConfirmationOption[]
  relatedBriefId?: string
  relatedTaskId?: string
  relatedCapabilityId?: string
}

export type TaskViewState = {
  taskId: string
  title: string
  status: AgentTaskStatus
  assigneeAgentId?: string
  dependsOnTaskIds: string[]
  acceptanceCriteria: string[]
  resultSummary?: string
}

export type KnowledgeBase = {
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

export type KnowledgeDocument = {
  id: string
  knowledgeBaseId: string
  title: string
  sourceType: string
  sourceUri?: string
  status: 'pending' | 'indexing' | 'ready' | 'failed'
  createdAt: string
  updatedAt: string
}

export const sessionStatusLabel: Record<SessionStatus, string> = {
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

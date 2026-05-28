import type {
  Agent,
  AgentStatus,
  AgentTaskStatus,
  CapabilityRiskLevel,
  CollaborationEvent,
  EventPriority,
  KnowledgeBase,
  KnowledgeDocument,
  RagMatchedChunk,
  RuntimeCapabilityDefinition,
  RuntimeInvocationStatus,
  RuntimeType,
  SessionDetail,
  SessionListItem,
  SessionStatus,
  UserMessageIntent
} from '@agent-cluster/shared'

export type {
  Agent,
  AgentStatus,
  AgentTaskStatus,
  Artifact,
  ArtifactType,
  CapabilityRiskLevel,
  CollaborationEvent,
  CollaborationEventType,
  EventMetadata,
  EventPriority,
  EventRenderType,
  KnowledgeBase,
  KnowledgeDocument,
  KnowledgeScope,
  RagMatchedChunk,
  RuntimeCapabilityDefinition,
  RuntimeInvocationStatus,
  RuntimeType,
  SessionDetail,
  SessionListItem,
  SessionStatus,
  UserMessageIntent
} from '@agent-cluster/shared'

export type SessionViewMode = 'chat' | 'collaboration_graph' | 'workflow'

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
  invocationId?: string
  capabilityId: string
  capabilityKey?: string
  capabilityName: string
  riskLevel: CapabilityRiskLevel
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'allowed' | 'approved'
  approvalKey?: string
  reason?: string
  inputSummary?: string
  outputSummary?: string
  requiresUserConfirmation?: boolean
  allowed?: boolean
  code?: string
  error?: string
}

export type ArtifactEventPayload = {
  artifactId: string
  type: string
  title: string
  contentSummary?: string
  relatedCapabilityId?: string
}

export type RagRetrievedPayload = {
  retrievalLogId: string
  agentId: string
  query: string
  matchedChunks: RagMatchedChunk[]
}

export type FinalDeliveryPayload = {
  deliveryId?: string
  summary: string
  completedItems: string[]
  incompleteItems: string[]
  outOfScopeChanges?: string[]
  testResults?: string[]
  risks: string[]
  artifactIds?: string[]
  artifactRefs?: string[]
  notificationDraftArtifactId?: string
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

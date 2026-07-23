import type {
  ActorRef,
  ActorType,
  AgentDefinition,
  AgentStatus,
  AgentTaskStatus,
  CapabilityDefinition,
  CapabilityKind,
  CapabilityRiskLevel,
  CollaborationEvent,
  CompiledAgentProfile,
  ContextEnvelopeV2,
  ContextPipelineVersion,
  EventPriority,
  ExecutionTermination,
  KnowledgeBase,
  KnowledgeDocument,
  OpsHealth,
  PostReviewAction,
  ProfileDiagnostic,
  RagMatchedChunk,
  RuntimeAvailabilityStatus,
  RuntimeCapabilityDefinition,
  RuntimeFileChange,
  RuntimeModelConfig,
  RuntimeModelCreateInput,
  RuntimeModelKind,
  RuntimeModelOption,
  RuntimeModelProvider,
  RuntimeModelUpdateInput,
  RuntimeInvocationStatus,
  RuntimeInvocationProfileSnapshot,
  RuntimePreference,
  ResolvedToolCatalog,
  ResolvedExecutionTarget,
  HandoffSuggestion,
  TaskRoutingMode,
  RuntimeType,
  SessionDetail,
  SessionListItem,
  SessionWorkingDirectory,
  SessionStatus,
  SupplementalContextResolution,
  Skill,
  SkillFile,
  SuggestedAgentTask,
  WorkspaceFileSnapshot,
  WorkspaceSnapshot,
  WorkspaceSkippedReason,
  WorkspaceTreeNode,
  WorkspaceChange,
  UserMessageIntent,
  WorkflowStatus
} from '@agent-cluster/shared'

export type {
  ActorRef,
  ActorType,
  AgentDefinition,
  AgentStatus,
  AgentTaskStatus,
  Artifact,
  ArtifactType,
  CapabilityDefinition,
  CapabilityKind,
  CapabilityRiskLevel,
  CollaborationEvent,
  CollaborationEventType,
  CompiledAgentProfile,
  ContextEnvelopeV2,
  ContextPipelineVersion,
  EventMetadata,
  EventPriority,
  ExecutionTermination,
  EventRenderType,
  KnowledgeBase,
  KnowledgeDocument,
  KnowledgeScope,
  OpsHealth,
  PostReviewAction,
  ProfileDiagnostic,
  RagMatchedChunk,
  RuntimeAvailabilityStatus,
  RuntimeCapabilityDefinition,
  RuntimeFileChange,
  RuntimeModelConfig,
  RuntimeModelCreateInput,
  RuntimeModelKind,
  RuntimeModelOption,
  RuntimeModelProvider,
  RuntimeModelUpdateInput,
  RuntimeInvocationStatus,
  RuntimeInvocationProfileSnapshot,
  RuntimePreference,
  ResolvedExecutionTarget,
  ResolvedToolCatalog,
  HandoffSuggestion,
  TaskRoutingMode,
  RuntimeType,
  SessionDetail,
  SessionListItem,
  SessionWorkingDirectory,
  SessionStatus,
  SupplementalContextResolution,
  Skill,
  SkillFile,
  SuggestedAgentTask,
  WorkspaceFileSnapshot,
  WorkspaceSnapshot,
  WorkspaceSkippedReason,
  WorkspaceTreeNode,
  WorkspaceChange,
  UserMessageIntent,
  AgentWorkflowNode,
  HumanApprovalWorkflowNode,
  RobotApprovalWorkflowNode,
  WorkflowNode,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowVersion,
  WorkflowRun,
  WorkflowNodeRun,
  WorkflowApprovalRecord,
  WorkflowRunState,
  WorkflowStatus
} from '@agent-cluster/shared'

export { DEFAULT_CONTEXT_PIPELINE_VERSION, SUPPORTED_CONTEXT_PIPELINE_VERSIONS } from '@agent-cluster/shared'

export type SessionViewMode = 'chat' | 'collaboration_graph' | 'workflow' | 'debug'

export type ConfirmationReason =
  | 'confirm_task_brief'
  | 'select_workflow'
  | 'initialize_empty_workspace'
  | 'confirm_workflow_step'
  | 'confirm_workflow_human_gate'
  | 'approve_high_risk_capability'
  | 'resolve_contract_conflict'
  | 'confirm_memory_write'
  | 'confirm_local_report_save'
  | 'confirm_feishu_notification'
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
    | 'RUNTIME_INVOCATION_ERROR'
    | 'MODEL_ERROR'
    | 'RUNTIME_OUTPUT_CONTRACT_VIOLATION'
    | 'CAPABILITY_BLOCKED'
    | 'CONTEXT_INSUFFICIENT'
    | 'TOKEN_BUDGET_EXCEEDED'
    | 'UNKNOWN_ERROR'
  message: string
  retryable: boolean
  requestedContext?: RuntimeContextRequest
  details?: Record<string, unknown>
  termination?: ExecutionTermination
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
  suggestedTasks?: SuggestedAgentTask[]
  requiresUserConfirmation: boolean
}

export type ConfirmationRequestedPayload = {
  confirmationId: string
  reason: ConfirmationReason
  title: string
  description: string
  options: ConfirmationOption[]
  actions?: PostReviewAction[]
  relatedBriefId?: string
  relatedTaskId?: string
  relatedCapabilityId?: string
  relatedArtifactId?: string
  targetPath?: string
  workflowId?: string
  workflowName?: string
  workflowRunId?: string
  workflowNodeId?: string
  workflowNodeRunId?: string
  expectedRunRevision?: number
  workflowStepIndex?: number
  workflowStepCount?: number
  outputSummary?: string
  workflowOptions?: Array<{
    id: string
    name: string
    version: number
    nodeCount: number
    agentCount?: number
    humanApprovalCount?: number
    robotApprovalCount?: number
    status: WorkflowStatus
  }>
  candidate?: {
    content?: string
    sourceEventId?: string
    confidence?: number
  }
}

export type TaskEventPayload = {
  taskId: string
  title: string
  description?: string
  status: AgentTaskStatus
  assignedBy?: ActorRef
  assignee?: ActorRef
  routingMode?: TaskRoutingMode
  autoResolutionAttempted?: boolean
  assignmentReason?: string
  contextRequirements?: string[]
  verificationPlan?: string[]
  riskNotes?: string[]
  requiresUserConfirmation?: boolean
  handoffSuggestion?: HandoffSuggestion | null
  dependsOnTaskIds?: string[]
  acceptanceCriteria?: string[]
  resultSummary?: string
  requestedContext?: RuntimeContextRequest
}

export type RuntimeContextRequest = {
  reason?: string
  requestedRefs?: Array<{
    type?: string
    label?: string
    ref?: string
  }>
  requestedPaths?: string[]
  requestedCommands?: string[]
  followUpInstruction?: string
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
  executionTarget?: ResolvedExecutionTarget
  agentId: string
  taskId?: string
  status: RuntimeInvocationStatus
  progressMessage?: string
  tokenInput?: number
  tokenOutput?: number
  cost?: number
  error?: RuntimeError
  termination?: ExecutionTermination
  requestedContext?: RuntimeContextRequest
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
  platformProjections?: RuntimeFileChange[]
  runtimeProposals?: Array<{
    type: string
    title: string
    summary: string | null
    content: string
    uri: string | null
    metadata: {
      fileChanges: RuntimeFileChange[]
      validationEvidence: unknown | null
      summaryMemoryCheckpoint: unknown | null
    }
  }>
  systemEvidence?: {
    workspaceChangeSet: { id: string; changes: WorkspaceChange[] } | null
    verifiedTestResults: Array<{
      command: string
      status: 'passed' | 'failed'
      exitCode: number | null
      stdout: string
      stderr: string
      startedAt: string
      completedAt: string
    }>
    capturedAt: string
    invocationId: string
  } | null
  report?: {
    kind: 'project_architecture_analysis'
    title: string
    content: string
  }
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
  report?: {
    artifactId: string
    title: string
    format: 'markdown'
    content: string
    suggestedPath: string
    requiresUserConfirmation: boolean
  }
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
  actions?: PostReviewAction[]
  candidate?: {
    content?: string
    sourceEventId?: string
    confidence?: number
  }
  relatedBriefId?: string
  relatedTaskId?: string
  relatedCapabilityId?: string
  relatedArtifactId?: string
  targetPath?: string
  workflowId?: string
  workflowName?: string
  workflowRunId?: string
  workflowNodeId?: string
  workflowNodeRunId?: string
  expectedRunRevision?: number
  workflowStepIndex?: number
  workflowStepCount?: number
  outputSummary?: string
  workflowOptions?: ConfirmationRequestedPayload['workflowOptions']
}

export type TaskViewState = {
  taskId: string
  title: string
  status: AgentTaskStatus
  assignedBy?: ActorRef
  assignee?: ActorRef
  routingMode?: TaskRoutingMode
  autoResolutionAttempted?: boolean
  assignmentReason?: string
  contextRequirements: string[]
  verificationPlan: string[]
  riskNotes: string[]
  requiresUserConfirmation?: boolean
  handoffSuggestion?: HandoffSuggestion | null
  dependsOnTaskIds: string[]
  acceptanceCriteria: string[]
  resultSummary?: string
  artifacts: TaskArtifactSummary[]
}

export type TaskArtifactSummary = {
  artifactId: string
  type: string
  title: string
  contentSummary?: string
  fileChangeCount: number
}

export const sessionStatusLabel: Record<SessionStatus, string> = {
  DRAFT_INPUT: '待理解',
  AGENT_DISCUSSING: 'Agent 讨论中',
  WAIT_USER_CONFIRM: '等待确认',
  WAIT_WORKFLOW_SELECT: '选择工作流',
  WAIT_WORKFLOW_STEP_CONFIRM: '确认工作流环节',
  REVISING_BRIEF: '修订任务契约',
  EXECUTING: '执行中',
  POST_REVIEW: '复盘中',
  REWORKING: '返工中',
  WAIT_USER_DECISION: '等待用户决策',
  COMPLETED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消'
}

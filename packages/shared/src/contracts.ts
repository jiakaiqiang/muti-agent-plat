export type UUID = string;
export type ISODateTime = string;

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
  | 'CANCELLED';

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
  | 'failed';

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
  | 'disabled';

export type RuntimeType =
  | 'mock'
  | 'generic_llm'
  | 'codex'
  | 'claude_code'
  | 'mcp_tool'
  | 'human';

export type KnowledgeScope = 'global' | 'project' | 'session' | 'agent' | 'role_type';
export type CapabilityRiskLevel = 'low' | 'medium' | 'high';

export type ArtifactType =
  | 'text'
  | 'markdown'
  | 'json'
  | 'code_diff'
  | 'test_report'
  | 'feishu_draft'
  | 'url'
  | 'file';

export type EventPriority = 'low' | 'normal' | 'high' | 'critical';

export type UserMessageIntent =
  | 'clarification'
  | 'constraint'
  | 'command'
  | 'question'
  | 'correction'
  | 'knowledge_input'
  | 'preference_input';

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
  | 'error_reported';

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
  | 'error_card';

export type EventMetadata<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  schemaVersion: '0.1';
  idempotencyKey?: string;
  renderAs?: EventRenderType;
  title?: string;
  summary?: string;
  payload?: TPayload;
};

export type CollaborationEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  id: UUID;
  sessionId: UUID;
  type: CollaborationEventType;
  userMessageIntent?: UserMessageIntent;
  priority?: EventPriority;
  fromAgentId?: UUID;
  toAgentIds: UUID[];
  taskId?: UUID;
  content: string;
  metadata: EventMetadata<TPayload>;
  createdAt: ISODateTime;
};

export type SessionDetail = {
  id: UUID;
  title: string;
  originalInput: string;
  status: SessionStatus;
  ownerId: string;
  workspaceId: string;
  projectId?: UUID;
  currentTaskBriefId?: UUID;
  tokenBudget?: number;
  tokenUsed: number;
  participatingAgentIds: UUID[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

export type SessionListItem = Pick<
  SessionDetail,
  'id' | 'title' | 'status' | 'tokenBudget' | 'tokenUsed' | 'createdAt' | 'updatedAt'
> & {
  agentCount: number;
  requiresUserAction: boolean;
  latestEventSummary?: string;
};

export type Agent = {
  id: UUID;
  key: string;
  name: string;
  role: string;
  description?: string;
  runtimeType: RuntimeType;
  status: 'active' | 'disabled';
  capabilityIds: UUID[];
  defaultKnowledgeBaseIds: UUID[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

export type TaskBrief = {
  id: UUID;
  sessionId: UUID;
  version: number;
  goal: string;
  scope: string[];
  outOfScope: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  risks: string[];
  openQuestions: string[];
  confirmedByUser: boolean;
  confirmedAt?: ISODateTime;
  createdAt: ISODateTime;
};

export type AgentTask = {
  id: UUID;
  sessionId: UUID;
  title: string;
  description: string;
  status: AgentTaskStatus;
  assigneeAgentId?: UUID;
  dependsOnTaskIds: UUID[];
  acceptanceCriteria: string[];
  resultSummary?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

export type KnowledgeBase = {
  id: UUID;
  name: string;
  description?: string;
  scope: KnowledgeScope;
  ownerId?: string;
  projectId?: UUID;
  sessionId?: UUID;
  agentId?: UUID;
  roleType?: string;
  visibility: 'private' | 'workspace';
  embeddingModel: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

export type KnowledgeDocument = {
  id: UUID;
  knowledgeBaseId: UUID;
  title: string;
  sourceType: 'text' | 'markdown' | 'file' | 'feishu_doc';
  sourceUri?: string;
  status: 'pending' | 'indexing' | 'ready' | 'failed';
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

export type RagMatchedChunk = {
  chunkId: UUID;
  knowledgeBaseId: UUID;
  documentId: UUID;
  title: string;
  snippet: string;
  score: number;
};

export type Artifact = {
  id: UUID;
  sessionId: UUID;
  taskId?: UUID;
  agentId?: UUID;
  type: ArtifactType;
  title: string;
  uri?: string;
  contentSummary?: string;
  metadata: Record<string, unknown>;
  createdAt: ISODateTime;
};

export type UserMessageHandlingPlan = {
  intent: UserMessageIntent;
  priority: EventPriority;
  shouldPause: boolean;
  affectedTaskIds: UUID[];
  affectedAgentIds: UUID[];
  requiresBriefRevision: boolean;
  requiresUserConfirmation: boolean;
  coordinatorInstruction: string;
};

export type RuntimeInvocationStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export type RuntimeUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost?: number;
  model?: string;
};

export type RuntimeBudget = {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  maxCost?: number;
};

export type RuntimeAgentProfile = {
  id: UUID;
  key: string;
  name: string;
  role: string;
  systemPrompt: string;
  runtimeType: RuntimeType;
  capabilityIds: UUID[];
};

export type RuntimeTaskBrief = Omit<TaskBrief, 'confirmedByUser' | 'confirmedAt' | 'createdAt'>;
export type RuntimeAgentTask = AgentTask;

export type RuntimeEventSummary = {
  eventId: UUID;
  type: CollaborationEventType;
  summary: string;
  createdAt: ISODateTime;
};

export type RuntimeMemoryItem = {
  id: UUID;
  scope: string;
  content: string;
  confidence: number;
};

export type RuntimeRagSnippet = RagMatchedChunk;

export type RuntimeArtifactSummary = {
  artifactId: UUID;
  type: ArtifactType;
  title: string;
  summary?: string;
};

export type RuntimeCapabilityDefinition = {
  id: UUID;
  key: string;
  name: string;
  riskLevel: CapabilityRiskLevel;
  description?: string;
};

export type ContextPack = {
  systemRules: string[];
  sessionGoal: string;
  taskBrief?: RuntimeTaskBrief;
  currentTask?: RuntimeAgentTask;
  agentProfile: RuntimeAgentProfile;
  relevantEvents: RuntimeEventSummary[];
  relevantMemories: RuntimeMemoryItem[];
  ragSnippets: RuntimeRagSnippet[];
  artifacts: RuntimeArtifactSummary[];
  capabilities: RuntimeCapabilityDefinition[];
  constraints: string[];
  budget: RuntimeBudget;
};

export type AgentRunPhase =
  | 'discussion'
  | 'brief_generation'
  | 'brief_revision'
  | 'task_execution'
  | 'post_review'
  | 'final_delivery'
  | 'user_message_routing';

export type AgentRunInput = {
  runId: UUID;
  sessionId: UUID;
  taskId?: UUID;
  phase: AgentRunPhase;
  agent: RuntimeAgentProfile;
  contextPack: ContextPack;
  expectedOutput: ExpectedRuntimeOutput;
  budget: RuntimeBudget;
  options?: Record<string, unknown>;
};

export type ExpectedRuntimeOutput = {
  kind:
    | 'agent_message'
    | 'task_brief'
    | 'task_execution_result'
    | 'post_review_report'
    | 'final_delivery'
    | 'user_message_handling_plan';
  schemaVersion: '0.1';
  jsonSchema?: Record<string, unknown>;
};

export type RuntimeArtifactOutput = {
  type: ArtifactType;
  title: string;
  content?: string;
  uri?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
};

export type RuntimeError = {
  code:
    | 'RUNTIME_TIMEOUT'
    | 'RUNTIME_CANCELLED'
    | 'MODEL_ERROR'
    | 'OUTPUT_SCHEMA_INVALID'
    | 'CAPABILITY_BLOCKED'
    | 'TOKEN_BUDGET_EXCEEDED'
    | 'UNKNOWN_ERROR';
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export type AgentRuntimeEvent = {
  runId: UUID;
  type:
    | 'runtime_started'
    | 'runtime_progress'
    | 'runtime_completed'
    | 'runtime_failed'
    | 'tool_called'
    | 'tool_completed'
    | 'artifact_created';
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: ISODateTime;
};

export type AgentRunResult<TOutput = RuntimeOutput> = {
  runId: UUID;
  runtimeType: RuntimeType;
  status: RuntimeInvocationStatus;
  output: TOutput;
  events: AgentRuntimeEvent[];
  artifacts: RuntimeArtifactOutput[];
  usage: RuntimeUsage;
  error?: RuntimeError;
};

export type RuntimeOutput =
  | AgentMessageOutput
  | TaskBriefOutput
  | TaskExecutionResultOutput
  | PostReviewReportOutput
  | FinalDeliveryOutput
  | UserMessageHandlingPlanOutput;

export type AgentMessageOutput = {
  kind: 'agent_message';
  messageKind: 'discussion' | 'answer' | 'handoff' | 'progress' | 'risk' | 'decision' | 'summary';
  content: string;
  mentionedAgentIds?: UUID[];
  relatedTaskIds?: UUID[];
};

export type SuggestedAgentTask = {
  title: string;
  description: string;
  suggestedAgentKey?: string;
  dependsOnTaskTitles?: string[];
  acceptanceCriteria: string[];
};

export type TaskBriefOutput = {
  kind: 'task_brief';
  goal: string;
  scope: string[];
  outOfScope: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  risks: string[];
  openQuestions: string[];
  suggestedTasks: SuggestedAgentTask[];
};

export type TaskExecutionResultOutput = {
  kind: 'task_execution_result';
  status: 'completed' | 'failed' | 'blocked' | 'needs_review';
  summary: string;
  completedItems: string[];
  changedArtifacts: RuntimeArtifactOutput[];
  nextSuggestedActions: string[];
  risks: string[];
};

export type PostReviewReportOutput = {
  kind: 'post_review_report';
  isConsistentWithBrief: boolean;
  matchedItems: string[];
  mismatchedItems: string[];
  missingItems: string[];
  outOfScopeChanges: string[];
  testResults: string[];
  recommendation: 'deliver' | 'rework' | 'ask_user';
};

export type FinalDeliveryOutput = {
  kind: 'final_delivery';
  summary: string;
  completedItems: string[];
  incompleteItems: string[];
  risks: string[];
  artifactRefs: string[];
};

export type UserMessageHandlingPlanOutput = UserMessageHandlingPlan & {
  kind: 'user_message_handling_plan';
};

export type AgentRuntimeAdapter = {
  type: RuntimeType;
  run(input: AgentRunInput): Promise<AgentRunResult>;
  stream?: (runId: UUID) => AsyncIterable<AgentRuntimeEvent>;
  cancel?: (runId: UUID) => Promise<void>;
};

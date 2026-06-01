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

export type ModelProvider = 'openai-compatible' | 'ollama' | 'anthropic';

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
  /** 用户为本会话选择的本地运行环境根目录(绝对路径),不是上传目录。为空时回退到 AGENT_WORKSPACE_ROOT 或进程工作目录。 */
  workspaceDir?: string;
  projectId?: UUID;
  currentTaskBriefId?: UUID;
  knowledgeBaseIds?: UUID[];
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
  tags?: string[];
  runtimeType: RuntimeType;
  modelId?: UUID;
  status: 'active' | 'disabled';
  capabilityIds: UUID[];
  defaultKnowledgeBaseIds: UUID[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

export type ModelFeatureFlags = {
  toolCalling: boolean;
  vision: boolean;
  jsonMode: boolean;
  contextWindow: number;
};

export type ModelDefaults = {
  temperature?: number;
  maxOutputTokens?: number;
};

export type ModelSource = 'local' | 'official' | 'custom';

export type ModelConnection = {
  id: UUID;
  name: string;
  source: ModelSource;
  provider: ModelProvider;
  runtimeType: RuntimeType;
  baseUrl: string;
  /** Whether a usable credential (encrypted at rest or env-backed) is configured; never the secret. */
  hasCredential: boolean;
  isDefault?: boolean;
  status: 'active' | 'disabled';
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

export type ModelDefinition = {
  id: UUID;
  connectionId: UUID;
  name: string;
  upstreamModel: string;
  features: ModelFeatureFlags;
  defaults?: ModelDefaults;
  status: 'active' | 'disabled';
  isDefault?: boolean;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

/** Non-secret view of a model joined with its connection, resolved for a runtime call. */
export type ResolvedRuntimeModel = {
  modelId: UUID;
  connectionId: UUID;
  source: ModelSource;
  provider: ModelProvider;
  runtimeType: RuntimeType;
  baseUrl: string;
  upstreamModel: string;
  features: ModelFeatureFlags;
  defaults?: ModelDefaults;
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

/**
 * Coordinator 对一条用户消息做出的路由决策。这是「单点收口」的核心:用户消息先经
 * Coordinator 分诊得到一个 route，再决定是直接回答、回到用户追问，还是同步给相关 Agent，
 * 而不是按正则把消息直接 fan-out 给所有 Agent 各自处理。
 */
export type UserMessageRoute =
  | 'answer' // Coordinator 直接回答用户
  | 'ask_user' // 信息不足，回到用户追问澄清（唯一一条、由 Coordinator 发出）
  | 'apply_to_agents' // 约束/澄清：内部同步相关 Agent 后由 Coordinator 收口为一条回执
  | 'revise_brief' // 针对尚未确认的任务简报的补充 → 修订简报后重新等待确认
  | 'new_task' // 新任务请求
  | 'command'; // 暂停/继续/取消等控制指令（由前端调用 control API）

export type UserMessageHandlingPlan = {
  intent: UserMessageIntent;
  /** Coordinator 的路由决策，决定这条消息如何被处理。 */
  route: UserMessageRoute;
  priority: EventPriority;
  shouldPause: boolean;
  /** 是否需要回到用户（追问澄清）。为 true 时不向其它 Agent 分发，避免「一群 Agent 追问」。 */
  needsUserInput: boolean;
  /** Coordinator 面向用户的话术：answer 的回答、ask_user 的追问、apply_to_agents 的收口回执。 */
  replyToUser?: string;
  /** apply_to_agents 时 Coordinator 指定的相关 Agent key（精准同步，而非全体广播）。 */
  targetAgentKeys?: string[];
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
  modelId?: UUID;
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

export type MemoryScope = 'short_term' | 'session' | 'long_term_candidate';

export type MemoryItem = {
  id: UUID;
  sessionId: UUID;
  agentId?: UUID;
  scope: MemoryScope;
  content: string;
  sourceEventId?: UUID;
  confidence: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
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
  /** 当前需要 Coordinator 优先处理的用户消息（用户消息分诊/路由阶段填入）。 */
  focusMessage?: string;
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
  /** Resolved model + connection the runtime should use; filled in by RuntimeService before dispatch. */
  model?: ResolvedRuntimeModel;
  /** 本会话选择的本地运行环境根目录(绝对路径);运行时用它解析文件读写路径,为空时回退全局配置。 */
  workspaceDir?: string;
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
  /**
   * 运行时请求的文件写入「提案」。这些写入不会立即落盘——编排器会先暂停到 WAIT_USER_DECISION
   * 并把 before/after 内容呈现给用户确认,确认后才由 ToolExecutor 真正写入会话目录。
   */
  proposedWrites?: ProposedFileWrite[];
  usage: RuntimeUsage;
  error?: RuntimeError;
};

/** 一次待确认的文件写入提案。previousContent 为目标文件的当前内容(不存在则为 undefined),用于前端 diff 预览。 */
export type ProposedFileWrite = {
  path: string;
  content: string;
  summary?: string;
  previousContent?: string;
};

/** confirmation_card 上承载的文件写入确认载荷:用户在写盘前看到这批写入的完整 before/after 内容。 */
export type FileWriteConfirmationPayload = {
  confirmationId: UUID;
  sessionId: UUID;
  taskId?: UUID;
  taskTitle?: string;
  writes: ProposedFileWrite[];
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

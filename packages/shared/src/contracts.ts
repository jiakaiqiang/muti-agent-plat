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
  | 'code_reader'
  | 'test_runner'
  | 'codex'
  | 'claude_code'
  | 'mcp_tool'
  | 'human';

/** Classifies whether a Runtime is provided by this system or an external provider. */
export type RuntimeAdapterCategory = 'external' | 'internal';

/** Describes a Runtime Adapter for registry, routing, and operator visibility. */
export type RuntimeAdapterMetadata = {
  readonly name: string;
  readonly version: string;
  readonly category: RuntimeAdapterCategory;
  readonly provider: string;
  readonly capabilityIds: readonly UUID[];
};

/** Result returned by a Runtime Adapter availability preflight. */
export type RuntimeAvailability = {
  available: boolean;
  reason?: string;
};

/** Health snapshot used by Runtime registries and smart routing. */
export type RuntimeHealthStatus = {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency?: number;
  lastCheckAt: ISODateTime;
  message?: string;
};

export type RuntimeSelectionSource =
  | 'agent_override'
  | 'session_override'
  | 'project_default'
  | 'global_default';

export type EngineeringRuntimeSelection = {
  effectiveRuntimeType: RuntimeType;
  source: RuntimeSelectionSource;
  agentRuntimeType?: RuntimeType;
  sessionRuntimeType?: RuntimeType;
  projectRuntimeType?: RuntimeType;
  globalRuntimeType: RuntimeType;
  reason: string;
};

export type EngineeringRuntimeConfig = {
  sessionDefaultRuntimeType?: RuntimeType;
  projectDefaultRuntimeType?: RuntimeType;
  agentRuntimeOverrides?: Record<string, RuntimeType>;
};

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

export type TaskDomain = 'coding' | 'non_coding' | 'mixed';
export type TaskRoutingMode = 'coordinator_controlled' | 'agent_suggested' | 'agent_delegated';
export type HandoffRiskLevel = 'low' | 'medium' | 'high';
export type HandoffSuggestion = {
  targetAgentKey?: string;
  targetAgentId?: UUID;
  reason: string;
  missingContext?: string[];
  riskLevel?: HandoffRiskLevel;
};
export type TaskIntent =
  | 'inquiry'
  | 'analysis'
  | 'implementation'
  | 'planning'
  | 'troubleshooting'
  | 'review'
  | 'validation'
  | 'delivery'
  | 'qa';
export type EvidenceSourceType =
  | 'project_map'
  | 'workspace_snapshot'
  | 'workspace_file'
  | 'workspace_symbol'
  | 'log'
  | 'test'
  | 'diff'
  | 'event_log'
  | 'memory'
  | 'artifact'
  | 'user_input'
  | 'external_reference'
  | 'document_fragment'
  | 'meeting_note'
  | 'data_table'
  | 'historical_decision';

export type SessionWorkingDirectory = {
  kind: 'browser_local' | 'server_local';
  id: UUID;
  name: string;
  path?: string;
  selectedAt: ISODateTime;
};

export type WorkspaceSkippedReason =
  | 'ignored_directory'
  | 'binary'
  | 'too_large'
  | 'sensitive'
  | 'limit_exceeded'
  | 'read_error';

export type WorkspaceTreeNode = {
  path: string;
  kind: 'file' | 'directory';
  children?: WorkspaceTreeNode[];
};

export type WorkspaceFileSnapshot = {
  path: string;
  size: number;
  language?: string;
  content?: string;
  summary?: string;
};

export type WorkspaceSkippedFile = {
  path: string;
  reason: WorkspaceSkippedReason;
  detail?: string;
};

export type WorkspaceManifestCoverage = {
  totalEntriesSeen: number;
  scannedEntries: number;
  readableFiles: number;
  skippedByReason: Partial<Record<WorkspaceSkippedReason, number>>;
};

export type EvidenceTruncationStrategy = 'slice' | 'ts-symbol-window' | 'md-section-window';

export type EvidenceTruncatedHint = {
  strategy: EvidenceTruncationStrategy;
  originalBytes: number;
  keptBytes: number;
  droppedRanges?: Array<[number, number]>;
  keptSections?: string[];
  droppedSections?: string[];
};

export type WorkspaceSnapshot = {
  rootName: string;
  scannedAt: ISODateTime;
  fileCount: number;
  totalBytes: number;
  tree: WorkspaceTreeNode[];
  files: WorkspaceFileSnapshot[];
  skipped: WorkspaceSkippedFile[];
  detectedStack?: string[];
  entrypoints?: string[];
  coverage?: WorkspaceManifestCoverage;
};

export type ProjectMapSource = 'static' | 'generated' | 'merged';

export type ProjectMapModule = {
  name: string;
  path: string;
  responsibility: string;
  entrypoints: string[];
  contracts: string[];
  tests: string[];
  commonTasks: string[];
};

export type ProjectMap = {
  source: ProjectMapSource;
  modules: ProjectMapModule[];
  validationCommands: string[];
  riskBoundaries: string[];
  memoryLocations: string[];
  sourceRefs: string[];
  generatedAt: ISODateTime;
};

export type RuntimeFileChange = {
  path: string;
  content?: string;
  previousContent?: string | null;
  operation: 'create' | 'update' | 'delete';
  encoding?: 'utf-8';
  source?: 'stage_artifact' | 'runtime_proposed_change' | 'actual_filesystem_snapshot';
};

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
  knowledgeBaseIds?: UUID[];
  workingDirectory?: SessionWorkingDirectory;
  workspaceSnapshot?: WorkspaceSnapshot;
  engineeringRuntime?: EngineeringRuntimeConfig;
  supplementalContextRequests?: Array<{
    id: UUID;
    taskId: UUID;
    agentId: UUID;
    requestedContext: RuntimeContextRequest;
    createdAt: ISODateTime;
  }>;
  tokenBudget?: number;
  tokenUsed: number;
  taskDomain?: TaskDomain;
  taskIntent?: TaskIntent;
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
  profileMarkdown?: string;
  tags?: string[];
  modelId?: string;
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
  assignedByAgentId?: UUID;
  assigneeAgentId?: UUID;
  routingMode?: TaskRoutingMode;
  autoResolutionAttempted?: boolean;
  assignmentReason?: string;
  contextRequirements?: string[];
  verificationPlan?: string[];
  riskNotes?: string[];
  requiresUserConfirmation?: boolean;
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
  sourceType: 'text' | 'markdown' | 'file' | 'feishu_doc' | 'meeting_note' | 'data_table' | 'external_reference';
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
  sourceType?: KnowledgeDocument['sourceType'];
  sourceUri?: string;
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

export type RuntimeModelProvider = 'openai-compatible' | 'ollama';
export type RuntimeModelKind = 'local' | 'remote';
export type RuntimeModelSource = 'env' | 'default' | 'local' | 'remote';

export type RuntimeModelOption = {
  id: string;
  label: string;
  provider: RuntimeModelProvider;
  source: RuntimeModelSource;
  kind: RuntimeModelKind;
  model: string;
  baseUrl?: string;
  hasApiKey: boolean;
  /** True when the entry is stored via model management (editable/deletable). */
  persisted: boolean;
  agents: RuntimeModelAgent[];
  createdAt?: ISODateTime;
  updatedAt?: ISODateTime;
};

export type RuntimeModelAgent = Pick<
  Agent,
  'id' | 'key' | 'name' | 'role' | 'status' | 'runtimeType' | 'modelId' | 'capabilityIds'
>;

export type RuntimeModelConfig = {
  provider: RuntimeModelProvider;
  baseUrl?: string;
  currentModelId: string;
  currentModel: string;
  defaultModel: string;
  currentModelOption: RuntimeModelOption;
  availableModels: RuntimeModelOption[];
  mockFallbackEnabled: boolean;
  updatedAt?: ISODateTime;
};

export type RuntimeModelCreateInput =
  | {
      kind: 'local';
      model: string;
      label?: string;
    }
  | {
      kind: 'remote';
      model: string;
      baseUrl: string;
      apiKey: string;
      label?: string;
    };

export type RuntimeModelUpdateInput = {
  label?: string;
  model?: string;
  baseUrl?: string;
  /** Omit to keep the stored key unchanged. */
  apiKey?: string;
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
  profileMarkdown?: string;
  systemPrompt: string;
  runtimeType: RuntimeType;
  configuredRuntimeType?: RuntimeType;
  runtimeSelection?: EngineeringRuntimeSelection;
  modelId?: string;
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

export type TaskEvidenceRef = {
  type: EvidenceSourceType;
  label: string;
  ref?: string;
  estimatedTokens?: number;
  selectionReason?: string;
  omissionReason?: string;
};

export type EvidenceSelectionStrategy = 'coding_minimal' | 'non_coding_minimal' | 'mixed_minimal';

export type TaskEvidenceSelection = {
  phase: AgentRunPhase;
  strategy: EvidenceSelectionStrategy;
  query: string;
  maxEvidenceRefs: number;
  selectedCount: number;
  omittedCount: number;
  selectedTypes: EvidenceSourceType[];
  omittedTypes: EvidenceSourceType[];
  selectedRefs: TaskEvidenceRef[];
  omittedRefs: TaskEvidenceRef[];
  rules: string[];
};

export type TaskMapKind = 'project_map' | 'domain_map';
export type TaskMapItemType = 'module' | 'boundary' | 'entrypoint' | 'key_material' | 'validation_path';

export type TaskMapItem = {
  type: TaskMapItemType;
  label: string;
  ref?: string;
  reason?: string;
};

export type TaskMap = {
  kind: TaskMapKind;
  summary: string;
  items: TaskMapItem[];
};

export type TaskValidationRule = {
  label: string;
  evidenceRequired: string;
};

export type TaskStagePlanItem = {
  action: 'read' | 'do' | 'validate';
  label: string;
  refs?: string[];
  reason?: string;
};

export type TaskStagePlan = {
  phase: AgentRunPhase;
  read: TaskStagePlanItem[];
  do: TaskStagePlanItem[];
  validate: TaskStagePlanItem[];
};

export type AgentResponsibility = {
  role: 'execution' | 'review' | 'validation';
  agentKey: string;
  independentFrom?: string[];
};

export type SummaryMemory = {
  goal: string;
  currentState: string;
  confirmedFacts: string[];
  completed: string[];
  decisions: string[];
  openQuestions: string[];
  risks: string[];
  nextSteps: string[];
  checkpointRefs?: UUID[];
  sourceEventIds?: UUID[];
  sourceArtifactIds?: UUID[];
  sourceMemoryIds?: UUID[];
};

export type SummaryMemoryCheckpoint = {
  kind: 'summary_memory_checkpoint';
  checkpointId: UUID;
  sessionId: UUID;
  phase: AgentRunPhase;
  taskId?: UUID;
  agentId?: UUID;
  summaryMemory: SummaryMemory;
  sourceEventIds: UUID[];
  sourceArtifactIds: UUID[];
  sourceMemoryIds: UUID[];
  createdAt: ISODateTime;
};

export type TaskContinuationState = {
  phase: AgentRunPhase;
  sessionStatus: SessionStatus;
  activeTaskId?: UUID;
  activeAgentKey?: string;
  lastCheckpointRef?: UUID;
  pendingTaskIds: UUID[];
  runningTaskIds: UUID[];
  completedTaskIds: UUID[];
  blockedTaskIds: UUID[];
  nextAgentKeys: string[];
  handoffRefs: UUID[];
  sourceEventIds: UUID[];
  sourceArtifactIds: UUID[];
  resumeHints: string[];
};

export type TaskContext = {
  domain: TaskDomain;
  intent: TaskIntent;
  currentStage: AgentRunPhase;
  taskMap: TaskMap;
  stagePlan: TaskStagePlan;
  executionMode: 'single_agent' | 'multi_agent';
  validationMode: 'runtime_checks' | 'human_review' | 'mixed';
  requiresCodeChanges: boolean;
  requiresExternalEvidence: boolean;
  validationRules: TaskValidationRule[];
  agentResponsibilities: AgentResponsibility[];
  evidenceSelection: TaskEvidenceSelection;
  evidenceRefs: TaskEvidenceRef[];
};

export type ContextPack = {
  systemRules: string[];
  sessionGoal: string;
  taskContext: TaskContext;
  summaryMemory: SummaryMemory;
  continuationState: TaskContinuationState;
  workingDirectory?: SessionWorkingDirectory;
  workspaceSnapshot?: WorkspaceSnapshot;
  workspaceManifest?: {
    rootName: string;
    fileCount: number;
    readableFileCount: number;
    skippedFileCount: number;
    tree: WorkspaceSnapshot['tree'];
    files: Array<Omit<WorkspaceFileSnapshot, 'content'> & { contentLength?: number }>;
    detectedStack?: string[];
    entrypoints?: string[];
    coverage?: WorkspaceManifestCoverage;
  };
  selectedEvidenceContents?: Array<{
    type: TaskEvidenceRef['type'];
    label: string;
    ref?: string;
    source: 'workspace_file' | 'rag' | 'memory' | 'artifact' | 'event' | 'project_map' | 'workspace_manifest';
    content?: string;
    summary?: string;
    contentLength?: number;
    truncated?: boolean;
    truncatedHint?: EvidenceTruncatedHint;
    tokenEstimate?: number;
    selectionReason?: string;
  }>;
  runtimeSelection?: EngineeringRuntimeSelection;
  projectMap?: ProjectMap;
  workspaceFocus?: {
    relevantFiles: string[];
    impactedFiles: string[];
    testFiles: string[];
    configFiles: string[];
    possibleEntryPoints: string[];
    detectedStack: string[];
    validationCommands: string[];
    rationale: string;
  };
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
  /**
   * Pull-mode workspace tools the agent may invoke during execution. Only
   * populated when the runtime actually supports the custom tool-call protocol
   * (currently `generic_llm` against a server_local working directory). Other
   * runtimes ignore this field. See docs/design/executing-pull-context-design-v1.md.
   */
  availableTools?: WorkspaceToolDescriptor[];
};

export type WorkspaceToolName = 'read_file';

export type WorkspaceToolDescriptor = {
  name: WorkspaceToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type AgentRunPhase =
  | 'discussion'
  | 'brief_generation'
  | 'brief_revision'
  | 'task_acceptance'
  | 'task_execution'
  | 'post_review'
  | 'final_delivery'
  | 'user_message_routing';

export type ValidationVerdictStatus = 'passed' | 'warning' | 'failed' | 'not_applicable';

export type ValidationEvidenceVerdict = {
  ruleLabel: string;
  status: ValidationVerdictStatus;
  evidenceRefs: TaskEvidenceRef[];
  notes: string[];
  missingEvidence?: string[];
};

export type ValidationEvidenceReport = {
  kind: 'validation_evidence_report';
  domain: TaskDomain;
  intent: TaskIntent;
  stage: AgentRunPhase;
  taskTitle?: string;
  validatorAgentKey: string;
  validatorAgentId?: UUID;
  independentFromAgentKeys: string[];
  rules: TaskValidationRule[];
  evidenceRefs: TaskEvidenceRef[];
  verdicts: ValidationEvidenceVerdict[];
  overallStatus: Exclude<ValidationVerdictStatus, 'not_applicable'>;
};

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
    | 'task_acceptance_decision'
    | 'task_claim_decision'
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
  metadata?: Record<string, unknown> & {
    fileChanges?: RuntimeFileChange[];
    validationEvidence?: ValidationEvidenceReport;
    summaryMemoryCheckpoint?: SummaryMemoryCheckpoint;
  };
};

export type RuntimeContextRequest = {
  reason: string;
  requestedRefs: TaskEvidenceRef[];
  requestedPaths?: string[];
  requestedCommands?: string[];
  followUpInstruction?: string;
};

export type RuntimeError = {
  code:
    | 'RUNTIME_TIMEOUT'
    | 'RUNTIME_CANCELLED'
    | 'MODEL_ERROR'
    | 'OUTPUT_SCHEMA_INVALID'
    | 'CAPABILITY_BLOCKED'
    | 'CONTEXT_INSUFFICIENT'
    | 'TOKEN_BUDGET_EXCEEDED'
    | 'UNKNOWN_ERROR';
  message: string;
  retryable: boolean;
  requestedContext?: RuntimeContextRequest;
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
  | TaskAcceptanceDecisionOutput
  | TaskClaimDecisionOutput
  | TaskBriefOutput
  | TaskExecutionResultOutput
  | PostReviewReportOutput
  | FinalDeliveryOutput
  | UserMessageHandlingPlanOutput;

export type AgentMessageOutput = {
  kind: 'agent_message';
  messageKind: 'discussion' | 'answer' | 'handoff' | 'progress' | 'risk' | 'decision' | 'summary';
  content: string;
  targetAgentIds?: UUID[];
  targetAgentKeys?: string[];
  mentionedAgentIds?: UUID[];
  relatedTaskIds?: UUID[];
};

export type TaskClaimDecisionOutput = {
  kind: 'task_claim_decision';
  accepted: boolean;
  reason: string;
  confidence?: number;
  missingContext?: string[];
  handoffSuggestion?: HandoffSuggestion | null;
  alternativeAgentKeys?: string[];
  alternativeAgentIds?: UUID[];
  agentMessages?: AgentMessageOutput[];
};

export type TaskAcceptanceDecisionOutput = {
  kind: 'task_acceptance_decision';
  status: 'accepted' | 'blocked' | 'rejected';
  reason: string;
  missingContext?: string[];
  handoffSuggestion?: HandoffSuggestion | null;
  confidence?: number;
  alternativeAgentKeys?: string[];
  alternativeAgentIds?: UUID[];
  agentMessages?: AgentMessageOutput[];
};

export type SuggestedAgentTask = {
  title: string;
  description: string;
  suggestedAgentKey?: string;
  routingMode?: TaskRoutingMode;
  assignmentReason?: string;
  contextRequirements?: string[];
  verificationPlan?: string[];
  riskNotes?: string[];
  requiresUserConfirmation?: boolean;
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
  requestedContext?: RuntimeContextRequest;
  agentMessages?: AgentMessageOutput[];
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
  metadata?: RuntimeAdapterMetadata;
  run(input: AgentRunInput, signal?: AbortSignal): Promise<AgentRunResult>;
  stream?: (runId: UUID) => AsyncIterable<AgentRuntimeEvent>;
  cancel?: (runId: UUID) => Promise<void>;
  checkAvailability?: () => Promise<RuntimeAvailability>;
  healthCheck?: () => Promise<RuntimeHealthStatus>;
};

import { RUNTIME_ARTIFACT_TYPES, type RuntimeOutputKind } from './runtime-contracts/contract-types.js';
import type { RuntimeNotificationDisposition } from './runtime-contracts/event-policy.js';
import type {
  RuntimeArtifactOutput as RegisteredRuntimeArtifactOutput,
  RuntimeArtifactProposal as RegisteredRuntimeArtifactProposal,
  RuntimeArtifactProposalMetadata as RegisteredRuntimeArtifactMetadata
} from './runtime-contracts/artifact-contracts.js';
import type {
  AgentMessageOutput as RegisteredAgentMessageOutput,
  FinalDeliveryOutput as RegisteredFinalDeliveryOutput,
  PostReviewAction as RegisteredPostReviewAction,
  PostReviewReportOutput as RegisteredPostReviewReportOutput,
  RuntimeOutput as RegisteredRuntimeOutput,
  SuggestedAgentTask as RegisteredSuggestedAgentTask,
  TaskAcceptanceDecisionOutput as RegisteredTaskAcceptanceDecisionOutput,
  TaskBriefOutput as RegisteredTaskBriefOutput,
  TaskExecutionResultOutput as RegisteredTaskExecutionResultOutput,
  UserMessageHandlingPlanOutput as RegisteredUserMessageHandlingPlanOutput
} from './runtime-contracts/output-contracts.js';

export type UUID = string;
export type ISODateTime = string;

export type SessionStatus =
  | 'DRAFT_INPUT'
  | 'AGENT_DISCUSSING'
  | 'WAIT_USER_CONFIRM'
  | 'WAIT_WORKFLOW_SELECT'
  | 'WAIT_WORKFLOW_STEP_CONFIRM'
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

export type ContextPipelineVersion = 'v2';

export const SUPPORTED_CONTEXT_PIPELINE_VERSIONS = ['v2'] as const satisfies readonly ContextPipelineVersion[];
export const DEFAULT_CONTEXT_PIPELINE_VERSION: ContextPipelineVersion = 'v2';

export type OpsHealth = {
  status: 'ok';
  service: string;
  version: string;
  buildTime: string;
  commit: string;
  processId: number;
  startedAt: ISODateTime;
  pipelineVersion: ContextPipelineVersion;
  dataSchemaVersion: 3;
  dataEpoch: UUID;
  persistenceBackend: 'file' | 'postgres';
  persistenceLocation: string;
  maintenanceMode: boolean;
  timestamp: ISODateTime;
};

/** Classifies whether a Runtime is provided by this system or an external provider. */
export type RuntimeAdapterCategory = 'external' | 'internal';

/** Describes a Runtime Adapter for registry, routing, and operator visibility. */
export type RuntimeAdapterMetadata = {
  readonly name: string;
  readonly version: string;
  readonly category: RuntimeAdapterCategory;
  readonly provider: string;
  readonly capabilityIds: readonly UUID[];
  readonly supportedWorkspaceCapabilities: readonly WorkspaceCapabilityKey[];
  readonly supportedWorkspaceProviderKinds?: readonly WorkspaceProviderKind[];
  readonly supportedToolNames: readonly string[];
};

/** Result returned by a Runtime Adapter availability preflight. */
export type RuntimeAvailability = {
  available: boolean;
  reason?: string;
};

export type RuntimeAvailabilityStatus = RuntimeAvailability & {
  runtimeType: RuntimeType;
  registered: boolean;
  supportedWorkspaceProviderKinds: readonly WorkspaceProviderKind[];
};

/** Health snapshot used by Runtime registries and smart routing. */
export type RuntimeHealthStatus = {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency?: number;
  lastCheckAt: ISODateTime;
  message?: string;
};

export type KnowledgeScope = 'global' | 'project' | 'session' | 'agent' | 'role_type';
export type CapabilityRiskLevel = 'low' | 'medium' | 'high';

export const ARTIFACT_TYPES = RUNTIME_ARTIFACT_TYPES;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

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

export const WORKSPACE_PROVIDER_KINDS = [
  'server_local',
  'browser_broker',
  'local_bridge'
] as const;

export type WorkspaceProviderKind = (typeof WORKSPACE_PROVIDER_KINDS)[number];

export const WORKSPACE_CAPABILITY_KEYS = ['read', 'write', 'command', 'test'] as const;

export type WorkspaceCapabilityKey = (typeof WORKSPACE_CAPABILITY_KEYS)[number];

export type WorkspaceCapabilities = Readonly<Record<WorkspaceCapabilityKey, boolean>>;

export type WorkspaceRevision = {
  id: string;
  observedAt: ISODateTime;
};

export type FileHash = {
  algorithm: 'sha256';
  value: string;
};

type FileMetadataBase = {
  path: string;
  revision: WorkspaceRevision;
  modifiedAt?: ISODateTime;
  language?: string;
};

export type FileMetadata =
  | (FileMetadataBase & {
      kind: 'file';
      size: number;
      hash: FileHash;
    })
  | (FileMetadataBase & {
      kind: 'directory';
      size?: number;
      hash?: never;
    });

export type ListDirectoryInput = {
  path?: string;
  recursive?: boolean;
  maxDepth?: number;
  cursor?: string;
  limit?: number;
};

export type ListDirectoryResult = {
  path: string;
  entries: FileMetadata[];
  revision: WorkspaceRevision;
  nextCursor?: string;
};

export type StatFileInput = {
  path: string;
};

export type ReadFileInput = {
  path: string;
  startLine?: number;
  endLine?: number;
  maxBytes?: number;
};

export type ReadFileResult = {
  path: string;
  content: string;
  encoding: 'utf-8';
  byteLength: number;
  truncated: boolean;
  revision: WorkspaceRevision;
  hash: FileHash;
  startLine?: number;
  endLine?: number;
};

export type SearchTextInput = {
  query: string;
  path?: string;
  include?: string[];
  exclude?: string[];
  caseSensitive?: boolean;
  maxResults?: number;
};

export type SearchTextMatch = {
  path: string;
  line: number;
  column?: number;
  preview: string;
};

export type SearchTextResult = {
  matches: SearchTextMatch[];
  truncated: boolean;
  revision: WorkspaceRevision;
};

export const WORKSPACE_CHANGE_OPERATIONS = ['create', 'update', 'delete', 'move'] as const;

export type WorkspaceChangeOperation = (typeof WORKSPACE_CHANGE_OPERATIONS)[number];

export type WorkspaceChange =
  | {
      operation: 'create';
      path: string;
      content: string;
      encoding: 'utf-8';
    }
  | {
      operation: 'update';
      path: string;
      content: string;
      encoding: 'utf-8';
      expectedHash: FileHash;
    }
  | {
      operation: 'delete';
      path: string;
      expectedHash: FileHash;
    }
  | {
      operation: 'move';
      fromPath: string;
      toPath: string;
      expectedHash: FileHash;
    };

export type WorkspaceChangeSet = {
  id: UUID;
  baseRevision: WorkspaceRevision;
  changes: WorkspaceChange[];
  createdAt: ISODateTime;
};

export type VerifiedTestResult = {
  command: string;
  status: 'passed' | 'failed';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: ISODateTime;
  completedAt: ISODateTime;
};

export type RuntimeArtifactSystemEvidence = {
  workspaceChangeSet: WorkspaceChangeSet | null;
  verifiedTestResults: VerifiedTestResult[];
  capturedAt: ISODateTime;
  invocationId: UUID;
};

export type RuntimeWorkspaceExecution =
  | {
      mode: 'git_worktree';
      repositoryId: string;
      baseRevision: WorkspaceRevision;
      changeSet: WorkspaceChangeSet;
      dirtyBaseline: boolean;
      requiresUserConfirmation: true;
    }
  | {
      mode: 'browser_mirror';
      workspaceId: string;
      baseRevision: WorkspaceRevision;
      changeSet: WorkspaceChangeSet;
      dirtyBaseline: false;
      requiresUserConfirmation: true;
    };

export const WORKSPACE_BASE_HASH_MISMATCH = 'WORKSPACE_BASE_HASH_MISMATCH' as const;

export type WorkspaceConflictErrorCode = typeof WORKSPACE_BASE_HASH_MISMATCH;

export type WorkspaceConflictError = {
  code: WorkspaceConflictErrorCode;
  message: string;
  changeSetId: UUID;
  operation: WorkspaceChangeOperation;
  path: string;
  baseHash?: FileHash;
  actualHash?: FileHash;
  actualRevision: WorkspaceRevision;
};

export type ExecutionTargetSource =
  | 'task_override'
  | 'session_preference'
  | 'project_policy'
  | 'smart_router'
  | 'global_default';

export type ResolvedExecutionTarget = {
  runtimeType: RuntimeType;
  modelId?: string;
  source: ExecutionTargetSource;
  reason: string;
  requiredCapabilities: readonly WorkspaceCapabilityKey[];
  requiredToolIds: readonly UUID[];
  writeMode: RuntimeWriteMode;
  workspaceProviderKind: WorkspaceProviderKind;
};

export type WorkspaceLeaseMode = 'read' | 'read_write';

export type WorkspaceLease = {
  leaseId: UUID;
  workspaceId: string;
  mode: WorkspaceLeaseMode;
  allowedOperations: readonly WorkspaceOperationKind[];
  issuedAt: ISODateTime;
  expiresAt: ISODateTime;
  issuedBySessionId: UUID;
};

export type WorkspaceOperationKind =
  | 'capabilities'
  | 'getRevision'
  | 'listDirectory'
  | 'statFile'
  | 'readFile'
  | 'searchText'
  | 'applyChangeSet';

export type WorkspaceOperationStatus = 'pending' | 'ok' | 'error';

export type WorkspaceOperationRequest =
  | { requestId: UUID; workspaceId: string; operation: 'capabilities' }
  | { requestId: UUID; workspaceId: string; operation: 'getRevision' }
  | { requestId: UUID; workspaceId: string; operation: 'listDirectory'; input: ListDirectoryInput }
  | { requestId: UUID; workspaceId: string; operation: 'statFile'; input: StatFileInput }
  | { requestId: UUID; workspaceId: string; operation: 'readFile'; input: ReadFileInput }
  | { requestId: UUID; workspaceId: string; operation: 'searchText'; input: SearchTextInput }
  | { requestId: UUID; workspaceId: string; operation: 'applyChangeSet'; input: WorkspaceChangeSet };

export type WorkspaceOperationErrorPayload = {
  code: string;
  message: string;
  conflicts?: WorkspaceConflictError[];
};

export type WorkspaceOperationResult<T = unknown> = {
  requestId: UUID;
  workspaceId: string;
  operation: WorkspaceOperationKind;
  status: WorkspaceOperationStatus;
  data?: T;
  error?: WorkspaceOperationErrorPayload;
};

export type RuntimeWriteMode = 'none' | 'propose_changes' | 'direct_audited';

export type ContextEnvelopeV2Layer = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';

export type ContextWorkspaceIdentity = {
  workspaceId: string;
  rootName: string;
  providerKind: WorkspaceProviderKind;
  revision: WorkspaceRevision;
};

export type ContextL0Authority = {
  systemRules: string[];
  agentId: UUID;
  profileHash: string;
  profileRevision: number;
  toolCatalogHash: string;
  workspace: ContextWorkspaceIdentity;
};

export type ContextL1NavigationEntry = {
  path: string;
  kind: 'file' | 'directory';
  generated: boolean;
  sensitive: boolean;
  size?: number;
  language?: string;
};

export type ContextL1NavigationManifest = {
  entries: ContextL1NavigationEntry[];
  truncated: boolean;
  nextCursor?: string;
};

export type ContextL1Task = {
  id: UUID;
  title: string;
  description: string;
  acceptanceCriteria: string[];
};

export type ContextL1Invocation = {
  sessionGoal: string;
  /**
   * 当前任务契约的最新目标。存在时为本次调用的权威目标,优先于 sessionGoal。
   * sessionGoal 保留用户原始需求原文,便于对照;currentContractGoal 反映
   * 讨论/修订后已被确认或最新产出的契约目标。
   */
  currentContractGoal?: string;
  phase: AgentRunPhase;
  task?: ContextL1Task;
  navigation: ContextL1NavigationManifest;
};

export type ContextL2ProjectMapModule = {
  name: string;
  path: string;
  responsibility: string;
  entrypoints?: string[];
  tests?: string[];
};

export type ContextL2ProjectMap = {
  source: 'static' | 'generated' | 'merged';
  modules: ContextL2ProjectMapModule[];
  detectedStack?: string[];
};

export type ContextL3EvidenceFile = {
  path: string;
  content: string;
  byteLength: number;
  startLine?: number;
  endLine?: number;
  hash?: FileHash;
};

export type ContextL3SelectedEvidence = {
  files: ContextL3EvidenceFile[];
  totalByteLength: number;
  truncated: boolean;
};

export type ContextL4ToolCall = {
  tool: string;
  arguments: Record<string, unknown>;
  resultSummary: string;
  durationMs?: number;
  succeeded?: boolean;
};

export type ContextL4ToolResults = {
  calls: ContextL4ToolCall[];
};

export type ContextL5SummaryMemory = {
  bullets: string[];
  turnCount: number;
};

export type ContextL6DeliveryArtifacts = {
  changeSetIds: UUID[];
  reportIds: UUID[];
};

export type ContextEnvelopeV2Budget = {
  inputTokens: number;
  navigationTokens: number;
  projectMapTokens: number;
  evidenceTokens: number;
};

export type ContextEnvelopeV2 = {
  version: 'v2';
  createdAt: ISODateTime;
  workspaceId: string;
  sessionId: UUID;
  L0: ContextL0Authority;
  L1: ContextL1Invocation;
  L2: ContextL2ProjectMap;
  L3: ContextL3SelectedEvidence;
  L4: ContextL4ToolResults;
  L5: ContextL5SummaryMemory;
  L6: ContextL6DeliveryArtifacts;
  budget: ContextEnvelopeV2Budget;
};

export type WorkspaceIndexEntryKind = 'file' | 'directory';

export type WorkspaceIndexEntry =
  | {
      path: string;
      kind: 'file';
      size: number;
      hash: FileHash;
      revision: WorkspaceRevision;
      generated: boolean;
      sensitive: boolean;
      language?: string;
      modifiedAt?: ISODateTime;
    }
  | {
      path: string;
      kind: 'directory';
      revision: WorkspaceRevision;
      generated: boolean;
      sensitive: boolean;
      modifiedAt?: ISODateTime;
    };

export type ApplyChangeSetResult =
  | {
      ok: true;
      changeSetId: UUID;
      revision: WorkspaceRevision;
      appliedCount: number;
    }
  | {
      ok: false;
      changeSetId: UUID;
      revision: WorkspaceRevision;
      conflicts: WorkspaceConflictError[];
    };

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
  generatedSkipped: number;
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
  /** Immutable workspace version observed when this snapshot was captured. */
  revision?: WorkspaceRevision;
  fileCount: number;
  totalBytes: number;
  tree: WorkspaceTreeNode[];
  files: WorkspaceFileSnapshot[];
  skipped: WorkspaceSkippedFile[];
  detectedStack?: string[];
  entrypoints?: string[];
  coverage?: WorkspaceManifestCoverage;
};

export type WorkspaceMode = 'existing_project' | 'empty_pending_decision' | 'bootstrap';

export type PendingBootstrapWorkflow = {
  workflowId: UUID;
  workflowVersion: number;
  selectionConfirmationId: UUID;
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
  | 'workflow_published'
  | 'workflow_run_started'
  | 'workflow_node_started'
  | 'workflow_node_completed'
  | 'workflow_gate_requested'
  | 'workflow_gate_decided'
  | 'workflow_node_revision_requested'
  | 'workflow_run_completed'
  | 'workflow_run_failed'
  | 'workflow_run_cancelled'
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
  relatedBriefId?: UUID;
};

export type ActorType = 'user' | 'agent' | 'system';

export interface ActorRef {
  type: ActorType;
  id: UUID;
  displayName?: string;
}

export type CollaborationEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  id: UUID;
  sessionId: UUID;
  type: CollaborationEventType;
  userMessageIntent?: UserMessageIntent;
  priority?: EventPriority;
  actor?: ActorRef;
  /** @deprecated v0.3 移除,改读 actor.id (type='agent')。v0.2 双写期保留。 */
  fromAgentId?: UUID;
  toAgentIds: UUID[];
  taskId?: UUID;
  content: string;
  metadata: EventMetadata<TPayload>;
  createdAt: ISODateTime;
};

export type SessionDetail = {
  id: UUID;
  dataEpoch: UUID;
  title: string;
  originalInput: string;
  /**
   * 最新任务契约(brief)的 goal,每次讨论产出新契约时同步更新。
   * 与永不变化的 originalInput 并存:originalInput 保留用户原始需求,
   * latestContractGoal 是当前权威目标,供 Agent 上下文作为最新目标注入。
   */
  latestContractGoal?: string;
  status: SessionStatus;
  ownerId: string;
  workspaceId: string;
  projectId?: UUID;
  origin?: 'user' | 'autopilot';
  autopilotRunId?: UUID;
  currentTaskBriefId?: UUID;
  knowledgeBaseIds?: UUID[];
  workingDirectory?: SessionWorkingDirectory;
  workspaceSnapshot?: WorkspaceSnapshot;
  workspaceMode?: WorkspaceMode;
  pendingBootstrapWorkflow?: PendingBootstrapWorkflow;
  runtimePreference?: RuntimePreference;
  workflowRunId?: UUID;
  workflowRun?: WorkflowRunState;
  supplementalContextRequests?: Array<{
    id: UUID;
    taskId: UUID;
    agentId: UUID;
    requestedContext: RuntimeContextRequest;
    resolution: SupplementalContextResolution;
    createdAt: ISODateTime;
  }>;
  tokenBudget?: number;
  tokenUsed: number;
  taskDomain?: TaskDomain;
  taskIntent?: TaskIntent;
  requiresCodeChanges?: boolean;
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

export type RuntimePreference = {
  preferredRuntimeType?: RuntimeType;
  preferredModelId?: string;
  allowedRuntimeTypes?: RuntimeType[];
};

export type AgentDefinition = {
  id: UUID;
  key: string;
  name: string;
  role: string;
  description?: string;
  profileMarkdown: string;
  tags: string[];
  status: 'active' | 'disabled';
  capabilityIds: UUID[];
  defaultKnowledgeBaseIds: UUID[];
  profileRevision: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

export type WorkflowStatus = 'draft' | 'published' | 'archived';

export type WorkflowNodeBase = {
  id: UUID;
  name?: string;
  order: number;
  ui?: {
    x: number;
    y: number;
  };
};

export type AgentWorkflowNode = WorkflowNodeBase & {
  type: 'agent';
  agentId: UUID;
  stageDescription?: string;
  inputContract?: string[];
  outputContract?: string[];
};

export type HumanApprovalWorkflowNode = WorkflowNodeBase & {
  type: 'human_approval';
  title: string;
  instruction?: string;
  assignee: 'session_owner';
  allowedDecisions: Array<'approve' | 'revise' | 'cancel'>;
};

export type RobotApprovalWorkflowNode = WorkflowNodeBase & {
  type: 'robot_approval';
  reviewerAgentId: UUID;
  reviewPrompt: string;
  criteria: string[];
  maxRevisionAttempts: number;
  fallback: 'human_approval';
};

export type WorkflowNode = AgentWorkflowNode | HumanApprovalWorkflowNode | RobotApprovalWorkflowNode;

export type WorkflowEdge = {
  id: UUID;
  sourceNodeId: UUID;
  targetNodeId: UUID;
};

export type WorkflowDefinition = {
  id: UUID;
  name: string;
  description?: string;
  status: WorkflowStatus;
  draftRevision: number;
  currentPublishedVersion?: number;
  /** @deprecated Use draftRevision for editing and currentPublishedVersion for execution. */
  version: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  archivedAt?: ISODateTime;
};

export type WorkflowVersion = {
  id: UUID;
  workflowId: UUID;
  version: number;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  involvedAgentIds: UUID[];
  definitionHash: string;
  publishedBy: UUID;
  publishedAt: ISODateTime;
};

export type WorkflowRunStatus = 'running' | 'waiting_human' | 'completed' | 'failed' | 'cancelled';

export type WorkflowNodeRunStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'approved'
  | 'revision_requested'
  | 'completed'
  | 'failed'
  | 'skipped';

export type WorkflowNodeRun = {
  id: UUID;
  workflowRunId: UUID;
  nodeId: UUID;
  nodeType: WorkflowNode['type'];
  attempt: number;
  status: WorkflowNodeRunStatus;
  inputRefs: string[];
  outputSummary?: string;
  outputRefs: string[];
  relatedTaskId?: UUID;
  confirmationId?: UUID;
  fallbackFromRobot?: boolean;
  startedAt?: ISODateTime;
  completedAt?: ISODateTime;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
};

export type WorkflowApprovalRecord = {
  id: UUID;
  workflowRunId: UUID;
  nodeRunId: UUID;
  confirmationId?: UUID;
  actor: ActorRef;
  decision: 'approve' | 'revise' | 'reject' | 'cancel';
  reason: string;
  revisionInstruction?: string;
  evidenceRefs: string[];
  createdAt: ISODateTime;
};

export type WorkflowEffectType =
  | 'create_agent_task'
  | 'execute_agent_task'
  | 'emit_event'
  | 'update_session_projection'
  | 'cancel_task'
  | 'start_post_review';

export type WorkflowEffect = {
  id: UUID;
  workflowRunId: UUID;
  type: WorkflowEffectType;
  payload: Record<string, unknown>;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  lastError?: string;
};

export type WorkflowRun = {
  id: UUID;
  workflowId: UUID;
  workflowVersion: number;
  workflowName: string;
  sessionId: UUID;
  briefId: UUID;
  ownerId: UUID;
  definitionSnapshot: WorkflowVersion;
  status: WorkflowRunStatus;
  currentNodeId?: UUID;
  revision: number;
  runtimeVersion: 'v2';
  startIdempotencyKey: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  completedAt?: ISODateTime;
  failure?: {
    code: string;
    message: string;
    nodeId?: UUID;
  };
};

export type WorkflowRunState = {
  id: UUID;
  workflowId: UUID;
  workflowVersion: number;
  workflowName: string;
  nodeTaskIds: UUID[];
  completedTaskIds: UUID[];
  currentStepIndex: number;
  status: 'running' | 'awaiting_step_confirmation' | WorkflowRunStatus;
  runtimeVersion?: 'v1' | 'v2';
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

export type Autopilot = {
  id: UUID;
  name: string;
  prompt: string;
  schedule?: string;
  enabled: boolean;
  runtimeType: 'mock';
  riskLevel: 'low';
  agentIds: UUID[];
  tokenBudget?: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

export type AutopilotRun = {
  id: UUID;
  autopilotId: UUID;
  trigger: 'manual' | 'scheduled';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
  issueguardKey: string;
  sessionId?: UUID;
  error?: string;
  createdAt: ISODateTime;
  startedAt?: ISODateTime;
  completedAt?: ISODateTime;
};

export type SkillFile = {
  path: string;
  content: string;
};

export type Skill = {
  id: UUID;
  /**
   * 稳定引用键。创建后不可修改，用作 `${skill:key}` 占位符解析。
   * 兼容期：v0.4 前旧数据允许缺失，读取路径会补齐。
   */
  key: string;
  name: string;
  description?: string;
  content: string;
  files: SkillFile[];
  /** @default 'active' — 兼容期允许缺失，读取路径视为 active。 */
  status: 'active' | 'disabled';
  /** 每次内容修改递增；兼容期允许缺失，读取路径视为 1。 */
  revision: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

export type CapabilityKind = 'internal' | 'tool' | 'mcp' | 'connector';

/**
 * 完整能力定义（tool/capability 管理页面使用）。
 * 与 RuntimeCapabilityDefinition 的区别：后者是运行时快照（只保留 id/key/name/risk/description），
 * 前者是管理层完整记录，多出 kind、状态、schema、系统所有权等字段。
 */
export type CapabilityDefinition = {
  id: UUID;
  key: string;
  kind: CapabilityKind;
  name: string;
  descriptionMarkdown?: string;
  usageMarkdown?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  riskLevel: CapabilityRiskLevel;
  status: 'active' | 'disabled' | 'unconfigured';
  systemOwned: boolean;
  createdAt?: ISODateTime;
  updatedAt?: ISODateTime;
};

export type ProfileReferenceKind = 'skill' | 'tool';

export type ProfileDiagnosticCode =
  | 'unknown_skill'
  | 'unknown_tool'
  | 'disabled_skill'
  | 'disabled_tool'
  | 'unconfigured_tool'
  | 'internal_tool_not_insertable'
  | 'tool_capability_missing'
  | 'duplicate_reference'
  | 'profile_over_budget';

export type ProfileDiagnostic = {
  severity: 'error' | 'warning';
  code: ProfileDiagnosticCode;
  message: string;
  kind?: ProfileReferenceKind;
  refKey?: string;
  line?: number;
  column?: number;
};

export type CompiledAgentProfile = {
  sourceMarkdown: string;
  systemPrompt: string;
  skillIds: UUID[];
  toolIds: UUID[];
  /** 稳定 key 记录，便于跨模型持久化。 */
  skillKeys: string[];
  toolKeys: string[];
  skillRevisions: Record<string, number>;
  diagnostics: ProfileDiagnostic[];
  contentHash: string;
  characterCount: number;
  estimatedTokens: number;
};

export type SkillBindingSnapshot = {
  id: UUID;
  key: string;
  revision: number;
  contentHash: string;
};

export type CompiledAgentIdentity = {
  agentId: UUID;
  key: string;
  name: string;
  role: string;
  systemPrompt: string;
  profileHash: string;
  profileRevision: number;
  skillBindings: SkillBindingSnapshot[];
  requestedToolIds: UUID[];
  requestedToolKeys: string[];
  capabilityIds: UUID[];
  knowledgeBaseIds: UUID[];
};

export type ToolAuthorityDecision = {
  toolId: UUID;
  toolKey: string;
  status: 'allowed' | 'blocked';
  reasons: string[];
  approvalId?: UUID;
};

export type ResolvedToolCatalog = {
  tools: WorkspaceToolDescriptor[];
  decisions: ToolAuthorityDecision[];
  catalogHash: string;
};

export type RuntimeInvocationProfileSnapshot = {
  agentId: UUID;
  profileHash: string;
  profileRevision: number;
  resolvedSkillIds: UUID[];
  resolvedSkillRevisions: Record<string, number>;
  resolvedToolIds: UUID[];
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
  /** 指派方。 */
  assignedBy?: ActorRef;
  /** 被指派方。 */
  assignee?: ActorRef;
  routingMode?: TaskRoutingMode;
  autoResolutionAttempted?: boolean;
  assignmentReason?: string;
  contextRequirements?: string[];
  verificationPlan?: string[];
  riskNotes?: string[];
  requiresUserConfirmation?: boolean;
  workflowRunId?: UUID;
  workflowNodeId?: UUID;
  workflowNodeRunId?: UUID;
  workflowNodeType?: WorkflowNode['type'];
  workflowAttempt?: number;
  executionPurpose?: 'agent_work' | 'workflow_review';
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

export type ArtifactMetadata = {
  phase:
    | 'task_brief'
    | 'workspace_analysis'
    | 'task_execution'
    | 'post_review'
    | 'final_delivery'
    | 'notification_draft'
    | 'summary_memory_checkpoint';
  briefId?: UUID;
  status?: string;
  workspace?: unknown;
  limitations?: string[];
  report?: {
    title: string;
    format: 'markdown';
    content: string;
    suggestedPath: string;
    requiresUserConfirmation: true;
  };
  channel?: 'feishu';
  mode?: 'draft';
  dryRun?: true;
  title?: string;
  body?: {
    sessionId: UUID;
    goal: string;
    summary: string;
    completedItems: string[];
    risks: string[];
  };
  sourceArtifactId?: UUID;
  recoveredFromHistoricalRuntimeArtifact?: true;
  checkpointId?: UUID;
  summaryMemoryCheckpoint?: SummaryMemoryCheckpoint;
};

export type Artifact = {
  id: UUID;
  dataEpoch: UUID;
  sessionId: UUID;
  taskId?: UUID;
  agentId?: UUID;
  type: ArtifactType;
  title: string;
  uri?: string;
  contentSummary?: string;
  metadata: ArtifactMetadata;
  runtimeProposals: RuntimeArtifactProposal[];
  platformProjections: RuntimeFileChange[];
  systemEvidence: RuntimeArtifactSystemEvidence | null;
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
  createdAt?: ISODateTime;
  updatedAt?: ISODateTime;
};

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

export type EvidenceSelectionStrategy = 'coding_minimal' | 'non_coding_minimal' | 'mixed_minimal' | 'architecture_analysis';

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

export type ContextAssembly = {
  /** Present for v2 sessions. This is the bounded, phase-specific runtime context surface. */
  contextEnvelopeV2?: ContextEnvelopeV2;
  /** Auditable task/phase execution target chosen for this invocation. */
  resolvedExecutionTarget?: ResolvedExecutionTarget;
  systemRules: string[];
  sessionGoal: string;
  /** 当前契约的最新目标;存在时为本次调用的权威目标,优先于 sessionGoal。 */
  currentContractGoal?: string;
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
  agentProfile: CompiledAgentIdentity;
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

export type WorkspaceToolName = string;

export type WorkspaceToolDescriptor = {
  name: WorkspaceToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type AgentRunPhase =
  | 'discussion'
  | 'brief_generation'
  | 'brief_revision'
  | 'brief_consultation'
  | 'task_acceptance'
  | 'task_execution'
  | 'post_review'
  | 'final_delivery'
  | 'user_message_routing';

export type SystemDataMetadata = {
  dataSchemaVersion: 3;
  dataEpoch: UUID;
  pipelineVersion: 'v2';
  cutoverAt: ISODateTime;
  cutoverAuditId: UUID;
};

export type InvocationPlan = {
  invocationId: UUID;
  sessionId: UUID;
  taskId?: UUID;
  phase: AgentRunPhase;
  agent: CompiledAgentIdentity;
  executionTarget: ResolvedExecutionTarget;
  toolCatalog: ResolvedToolCatalog;
  contextEnvelope: ContextEnvelopeV2;
  expectedOutput: ExpectedRuntimeOutput;
  budget: RuntimeBudget;
  attempt?: RuntimeAttemptTrace;
  resume?: RuntimeResumeRequest;
};

export type RuntimeAttemptTrace = {
  attemptGroupId: UUID;
  attempt: number;
  retryOfInvocationId?: UUID;
  fallbackFromRuntimeType?: RuntimeType;
  fallbackReason?: string;
};

export type RuntimeResumeRequest = {
  cliSessionId: string;
  workDir?: string;
};

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

export type ExpectedRuntimeOutput = {
  kind: RuntimeOutputKind;
  schemaVersion: '1.0';
};

export type RuntimeArtifactOutput = RegisteredRuntimeArtifactOutput;
export type RuntimeArtifactProposal = RegisteredRuntimeArtifactProposal;
export type RuntimeArtifactMetadata = RegisteredRuntimeArtifactMetadata;

export type RuntimeContextRequest = {
  reason: string;
  requestedRefs: TaskEvidenceRef[];
  requestedPaths?: string[];
  requestedCommands?: string[];
  followUpInstruction?: string;
};

export type SupplementalContextPathFailureCode =
  | 'NOT_FOUND'
  | 'PERMISSION_REQUIRED'
  | 'BROKER_OFFLINE'
  | 'READ_UNAVAILABLE'
  | 'READ_ERROR';

export type SupplementalContextResolution = {
  requestedPaths: string[];
  hydratedPaths: string[];
  failedPaths: Array<{
    path: string;
    code: SupplementalContextPathFailureCode;
    retryable: boolean;
    message?: string;
  }>;
  deferredPaths: string[];
  contentBytes: number;
};

export type ExecutionTerminationKind =
  | 'user_cancelled'
  | 'phase_timeout'
  | 'runtime_timeout'
  | 'service_shutdown'
  | 'superseded'
  | 'maintenance';

export type ExecutionTerminationSource = 'user' | 'orchestrator' | 'runtime' | 'system' | 'operator';
export type ExecutionTerminationScope = 'session' | 'phase' | 'invocation' | 'service';
export type ExecutionTerminationDisposition = 'stop' | 'retry' | 'replace' | 'recover';

export type ExecutionTermination = {
  schemaVersion: '1.0';
  terminationId: UUID;
  kind: ExecutionTerminationKind;
  source: ExecutionTerminationSource;
  scope: ExecutionTerminationScope;
  occurredAt: ISODateTime;
  phase?: AgentRunPhase;
  timeout?: {
    mode: 'deadline' | 'first_frame' | 'idle' | 'absolute';
    timeoutMs: number;
  };
  graceful?: boolean;
  replacementInvocationId?: UUID;
  maintenanceId?: string;
  diagnosticRef?: string;
};

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
    | 'UNKNOWN_ERROR';
  message: string;
  retryable: boolean;
  requestedContext?: RuntimeContextRequest;
  details?: Record<string, unknown>;
  termination?: ExecutionTermination;
};

export type AgentRuntimeEvent = {
  invocationId: UUID;
  type:
    | 'runtime_started'
    | 'runtime_progress'
    | 'runtime_completed'
    | 'runtime_failed'
    | 'tool_called'
    | 'tool_completed'
    | 'artifact_created';
  content: string;
  visibility: 'user' | 'debug';
  metadata?: Record<string, unknown>;
  createdAt: ISODateTime;
};

export type RuntimeDebugNotification = {
  method: string;
  disposition: RuntimeNotificationDisposition;
  payload: unknown;
};

export type RuntimeDiagnostics = {
  providerNotifications: RuntimeDebugNotification[];
  unknownNotificationCount: number;
  stderrTail: string | null;
};

export type RuntimeSessionRef = {
  cliSessionId?: string;
  workDir?: string;
};

export type RuntimeStreamMetrics = {
  startedAt: ISODateTime;
  completedAt: ISODateTime;
  durationMs: number;
  frameCount: number;
  firstFrameAt?: ISODateTime;
  firstFrameLatencyMs?: number;
  lastActivityAt: ISODateTime;
  maxInterFrameGapMs: number;
};

export type AgentRunResult<TOutput = RuntimeOutput> = {
  invocationId: UUID;
  runtimeType: RuntimeType;
  status: RuntimeInvocationStatus;
  output: TOutput;
  events: AgentRuntimeEvent[];
  artifacts: RuntimeArtifactProposal[];
  systemEvidence: RuntimeArtifactSystemEvidence;
  usage: RuntimeUsage;
  runtimeSession?: RuntimeSessionRef;
  workspaceExecution?: RuntimeWorkspaceExecution;
  streamMetrics?: RuntimeStreamMetrics;
  runtimeDiagnostics?: RuntimeDiagnostics;
  error?: RuntimeError;
  termination?: ExecutionTermination;
};

export type AgentRuntimeRunHandle = {
  events: AsyncIterable<AgentRuntimeEvent>;
  result: Promise<AgentRunResult>;
  cancel(termination?: ExecutionTermination): Promise<void>;
};

export type RuntimeOutput = RegisteredRuntimeOutput;
export type AgentMessageOutput = RegisteredAgentMessageOutput;
export type TaskAcceptanceDecisionOutput = RegisteredTaskAcceptanceDecisionOutput;
export type SuggestedAgentTask = RegisteredSuggestedAgentTask;
export type TaskBriefOutput = RegisteredTaskBriefOutput;
export type TaskExecutionResultOutput = RegisteredTaskExecutionResultOutput;

export const POST_REVIEW_ACTION_KEYS = [
  'request_workspace_context',
  'deliver_with_limitations',
  'save_progress',
  'cancel'
] as const;

export type PostReviewActionKey = (typeof POST_REVIEW_ACTION_KEYS)[number];

export type PostReviewAction = RegisteredPostReviewAction;
export type PostReviewReportOutput = RegisteredPostReviewReportOutput;
export type FinalDeliveryOutput = RegisteredFinalDeliveryOutput;
export type UserMessageHandlingPlanOutput = RegisteredUserMessageHandlingPlanOutput;

export type AgentRuntimeAdapter = {
  type: RuntimeType;
  metadata?: RuntimeAdapterMetadata;
  start(input: InvocationPlan, signal?: AbortSignal): AgentRuntimeRunHandle;
  checkAvailability?: () => Promise<RuntimeAvailability>;
  healthCheck?: () => Promise<RuntimeHealthStatus>;
};

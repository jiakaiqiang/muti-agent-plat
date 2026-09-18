import { RUNTIME_ARTIFACT_TYPES, type RuntimeOutputKind } from './runtime-contracts/contract-types.js';
import type { RuntimeNotificationDisposition } from './runtime-contracts/event-policy.js';
import type {
  RuntimeArtifactOutput as RegisteredRuntimeArtifactOutput,
  RuntimeArtifactProposal as RegisteredRuntimeArtifactProposal,
  RuntimeArtifactProposalMetadata as RegisteredRuntimeArtifactMetadata
} from './runtime-contracts/artifact-contracts.js';
import type {
  AgentMessageOutput as RegisteredAgentMessageOutput,
  FileRevisionCandidateOutput as RegisteredFileRevisionCandidateOutput,
  FinalDeliveryOutput as RegisteredFinalDeliveryOutput,
  PostReviewAction as RegisteredPostReviewAction,
  PostReviewReportOutput as RegisteredPostReviewReportOutput,
  RuntimeOutput as RegisteredRuntimeOutput,
  SuggestedAgentTask as RegisteredSuggestedAgentTask,
  TaskAcceptanceDecisionOutput as RegisteredTaskAcceptanceDecisionOutput,
  TaskBriefOutput as RegisteredTaskBriefOutput,
  TaskExecutionResultOutput as RegisteredTaskExecutionResultOutput,
  UserMessageHandlingPlanOutput as RegisteredUserMessageHandlingPlanOutput,
  IntentRoutingDecisionOutput as RegisteredIntentRoutingDecisionOutput
} from './runtime-contracts/output-contracts.js';

export type UUID = string;
export type ISODateTime = string;

/** Maximum complete UTF-8 file accepted by the revision iteration workflow. */
export const FILE_REVISION_MAX_BYTES = 200_000;

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
  | 'APPLYING_CHANGES'
  | 'WAIT_WORKSPACE_CONFLICT_RESOLUTION'
  | 'WAIT_USER_DECISION'
  | 'PAUSED'
  | 'INTERRUPTED'
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
  buildId: string;
  runtimeBuildStale: boolean;
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

export type UserMessageRequirementRelation = 'continuation' | 'new_requirement';

export type RequirementScopeRelation =
  | 'same_requirement'
  | 'related_new_requirement'
  | 'independent_new_requirement'
  | 'ambiguous';

export type ContextInheritancePolicy =
  | 'inherit_confirmed'
  | 'inherit_selected'
  | 'clean_task_context'
  | 'ask_user';

export type WorkItemStatus =
  | 'OPEN'
  | 'WAITING_USER'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type IntentRoutingStatus =
  | 'RECEIVED'
  | 'SNAPSHOT_READY'
  | 'CLASSIFYING'
  | 'VALIDATING'
  | 'APPLYING'
  | 'ROUTED'
  | 'CLARIFICATION_REQUIRED'
  | 'PENDING_RETRY'
  | 'REJECTED';

export type IntentRoutingAction =
  | 'continue_active_work_item'
  | 'create_related_work_item'
  | 'create_independent_work_item'
  | 'clarify'
  | 'pause'
  | 'cancel'
  | 'confirm'
  | 'reject'
  | 'resume'
  | 'replan';

export type IntentRoutingRolloutMode =
  | 'disabled'
  | 'shadow'
  | 'enforce_new_sessions'
  | 'enforce_selected_sessions'
  | 'enforce_all_current_epoch';

export type FailedExecutionAction = 'none' | 'resume' | 'replan';

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

export type WorkspaceBinding = {
  workspaceId: UUID;
  providerKind: WorkspaceProviderKind;
  displayName: string;
  capabilities: WorkspaceCapabilities;
  boundRevision: WorkspaceRevision;
  boundAt: ISODateTime;
};

export type WorkspaceIndexStatus = 'empty' | 'building' | 'ready' | 'stale' | 'failed';

export type WorkspaceNavigationEntry = {
  path: string;
  kind: 'file' | 'directory';
  size?: number;
  modifiedAt?: ISODateTime;
  language?: string;
  generated: boolean;
  sensitive: boolean;
};

/**
 * Aggregate coverage counts for an index generation. Contains only counts,
 * never local absolute paths or sensitive file names. `indexedEntries` on the
 * snapshot MUST equal `coverage.indexedEntries`.
 */
export type WorkspaceIndexCoverage = {
  visitedEntries: number;
  indexedEntries: number;
  excludedGenerated: number;
  sensitiveEntries: number;
  skippedSymlinks: number;
  failedEntries: number;
};

export type WorkspaceIndexSnapshot = {
  workspaceId: UUID;
  revision: WorkspaceRevision;
  generation: number;
  status: WorkspaceIndexStatus;
  complete: boolean;
  entries: WorkspaceNavigationEntry[];
  entrypoints: string[];
  detectedStack: string[];
  indexedEntries: number;
  truncated: boolean;
  updatedAt: ISODateTime;
  errorCode?: string;
  coverage: WorkspaceIndexCoverage;
};

export type WorkspaceIndexSnapshotPage = Omit<WorkspaceIndexSnapshot, 'entries'> & {
  entries: WorkspaceNavigationEntry[];
  nextCursor?: string;
};

export type WorkspaceIndexSummary = Omit<WorkspaceIndexSnapshot, 'entries'>;

export type WorkspaceIndexSnapshotInput = {
  cursor?: string;
  limit?: number;
  generation?: number;
};

/** Bounded metadata-only lookup used to discover task-relevant workspace paths. */
export type WorkspaceIndexQueryInput = {
  query?: string;
  pathHints?: string[];
  symbols?: string[];
  intent?: string;
  limit?: number;
  generation?: number;
};

export type WorkspaceIndexQueryResult = Omit<WorkspaceIndexSnapshot, 'entries'> & {
  entries: WorkspaceNavigationEntry[];
  matched: number;
};

export type SessionWorkspaceContext = {
  binding: WorkspaceBinding;
  indexGeneration?: number;
  indexRevision?: WorkspaceRevision;
  indexComplete: boolean;
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
      /** Present for stat/read evidence, omitted for metadata-only navigation. */
      hash?: FileHash;
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
  deadlineMs?: number;
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
  /** Full-file hash. Present only when the complete file was intentionally read. */
  hash?: FileHash;
  /** Hash of the returned bytes for range/truncated evidence. */
  rangeHash?: FileHash;
  fileSize?: number;
  modifiedAt?: ISODateTime;
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
  deadlineMs?: number;
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
      /** UTF-8 baseline used for a provider-owned three-way merge. */
      baseContent?: string;
    }
  | {
      operation: 'delete';
      path: string;
      expectedHash: FileHash;
      /** UTF-8 baseline retained for conflict inspection and recovery. */
      baseContent?: string;
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

export type WorkspaceWritebackStatus =
  | 'queued'
  | 'merging'
  | 'applying'
  | 'conflicted'
  | 'applied'
  | 'failed'
  | 'abandoned';

export type WorkspaceWritebackResolutionAction =
  | 'retry_merge'
  | 'resolve_with_agent'
  | 'keep_workspace'
  | 'use_session'
  | 'abandon_writeback';

export type WorkspaceWritebackRecord = {
  id: UUID;
  sessionId: UUID;
  /** Session generation that admitted this writeback; stale generations cannot apply after restore. */
  sessionGeneration?: number;
  taskId?: UUID;
  invocationId: UUID;
  workspaceId: string;
  providerKind: WorkspaceProviderKind;
  changeSet: WorkspaceChangeSet;
  /** Original completed Runtime summary, retained while writeback waits for resolution. */
  resultSummary?: string;
  status: WorkspaceWritebackStatus;
  conflicts: WorkspaceConflictError[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  appliedRevision?: WorkspaceRevision;
  error?: string;
  resolution?: WorkspaceWritebackResolutionAction;
};

export type ResolveWorkspaceWritebackInput = {
  action: WorkspaceWritebackResolutionAction;
  /** Required when `action` is `use_session`, which can overwrite current files. */
  confirmationId?: UUID;
};

export type RuntimeWorkspaceExecution = {
  mode: 'git_worktree' | 'staging_copy';
  repositoryId?: string;
  baseRevision: WorkspaceRevision;
  changeSet: WorkspaceChangeSet;
  dirtyBaseline: boolean;
  requiresUserConfirmation: boolean;
  writeback?: WorkspaceWritebackRecord;
};

export const WORKSPACE_BASE_HASH_MISMATCH = 'WORKSPACE_BASE_HASH_MISMATCH' as const;
export const WORKSPACE_MERGE_CONFLICT = 'WORKSPACE_MERGE_CONFLICT' as const;

export type WorkspaceConflictErrorCode =
  | typeof WORKSPACE_BASE_HASH_MISMATCH
  | typeof WORKSPACE_MERGE_CONFLICT;

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

export type RuntimeExecutionLocation = 'local' | 'server';

export type ResolvedExecutionTarget = {
  providerIdentity?: {
    connectionId: string;
    modelId: string;
    protocol: string;
    source: 'configured_connection' | 'unknown';
  };
  runtimeType: RuntimeType;
  modelId?: string;
  source: ExecutionTargetSource;
  reason: string;
  requiredCapabilities: readonly WorkspaceCapabilityKey[];
  requiredToolIds: readonly UUID[];
  writeMode: RuntimeWriteMode;
  workspaceProviderKind: WorkspaceProviderKind;
  executionLocation: RuntimeExecutionLocation;
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
  | 'getIndexSnapshot'
  | 'queryWorkspaceIndex'
  | 'listDirectory'
  | 'statFile'
  | 'readFile'
  | 'searchText'
  | 'applyChangeSet';

export type WorkspaceOperationStatus = 'pending' | 'ok' | 'error';

export type WorkspaceOperationRequest = {
  requestId: UUID;
  invocationId: UUID;
  workspaceId: string;
} & (
  | { operation: 'capabilities' }
  | { operation: 'getRevision' }
  | { operation: 'getIndexSnapshot'; input: WorkspaceIndexSnapshotInput }
  | { operation: 'queryWorkspaceIndex'; input: WorkspaceIndexQueryInput }
  | { operation: 'listDirectory'; input: ListDirectoryInput }
  | { operation: 'statFile'; input: StatFileInput }
  | { operation: 'readFile'; input: ReadFileInput }
  | { operation: 'searchText'; input: SearchTextInput }
  | { operation: 'applyChangeSet'; input: WorkspaceChangeSet }
);

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

export type RuntimeWriteMode = 'none' | 'propose_changes' | 'proposal_only' | 'direct_audited';

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
  indexGeneration?: number;
  indexStatus?: WorkspaceIndexStatus;
  indexComplete?: boolean;
  indexRevision?: WorkspaceRevision;
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
  /** The exact message that triggered this invocation. Never reinterpret it as a constraint. */
  currentUserMessage?: string;
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
  revision?: WorkspaceRevision;
};

export type FileRevisionDiffLine = {
  kind: 'context' | 'add' | 'remove';
  content: string;
};

export type FileRevisionDiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: FileRevisionDiffLine[];
};

export type FileRevisionDiffSummary = {
  addedLines: number;
  removedLines: number;
  unchangedLines: number;
  hunkCount: number;
};

export type FileRevisionAgentResult = {
  id: UUID;
  taskId: UUID;
  agentId: UUID;
  status: 'completed' | 'failed';
  artifactIds: UUID[];
  summary: string;
  proposedContentRef?: string;
  /** Hydrated only inside an invocation envelope; persisted runs keep the contentRef. */
  proposedContent?: string;
  completedAt: ISODateTime;
  error?: string;
};

/** Complete immutable evidence distributed to every Agent selected for one revision iteration. */
export type FileRevisionEvidence = {
  chainId: UUID;
  revisionId: UUID;
  iteration: number;
  filePath: string;
  baseKind: 'workspace_baseline' | 'previous_candidate';
  base: {
    hash: FileHash;
    contentRef: string;
    content: string;
    byteLength: number;
  };
  userDraft: {
    hash: FileHash;
    contentRef: string;
    content: string;
    byteLength: number;
  };
  diff: {
    hash: FileHash;
    contentRef: string;
    hunks: FileRevisionDiffHunk[];
    summary: FileRevisionDiffSummary;
  };
  evidenceHash: string;
  agentResults?: FileRevisionAgentResult[];
  complete: true;
  truncated: false;
};

export type FileRevisionBaseline = {
  id: UUID;
  dataEpoch: UUID;
  sessionId: UUID;
  workspaceId: string;
  filePath: string;
  workspaceRevision: WorkspaceRevision;
  hash: FileHash;
  contentRef: string;
  sizeBytes: number;
  source: 'system_output' | 'user_selected' | 'post_apply';
  capturedAt: ISODateTime;
};

export type FileRevisionChainStatus =
  | 'active'
  | 'applying'
  | 'applied'
  | 'abandoned'
  | 'stale'
  | 'failed';

export type FileRevisionChain = {
  id: UUID;
  dataEpoch: UUID;
  sessionId: UUID;
  workspaceId: string;
  filePath: string;
  rootBaselineId: UUID;
  workspaceExpectedRevision: WorkspaceRevision;
  workspaceExpectedHash: FileHash;
  latestRevisionId: UUID;
  latestIteration: number;
  stateVersion: number;
  status: FileRevisionChainStatus;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  completedAt?: ISODateTime;
  postApplyBaselineStatus?: 'pending' | 'captured' | 'failed';
  postApplyBaselineId?: UUID;
  postApplyBaselineError?: string;
};

export type FileRevisionRunStatus =
  | 'submitted'
  | 'processing'
  | 'synthesizing'
  | 'awaiting_confirmation'
  | 'superseded'
  | 'applying'
  | 'applied'
  | 'abandoned'
  | 'stale'
  | 'failed'
  | 'interrupted';

export type FileRevisionRun = {
  id: UUID;
  chainId: UUID;
  dataEpoch: UUID;
  sessionId: UUID;
  baselineId: UUID;
  workspaceId: string;
  filePath: string;
  iteration: number;
  parentRevisionId?: UUID;
  /** Stable key used to collapse retries of the same next-iteration request. */
  reprocessKey?: string;
  /** Stable key used to collapse retries after a process restart. */
  recoveryRetryKey?: string;
  recoveryRetryMode?: 'run_agents' | 'receiver_only' | 'apply_reconcile';
  status: FileRevisionRunStatus;
  baseKind: 'workspace_baseline' | 'previous_candidate';
  baseHash: FileHash;
  baseContentRef: string;
  baseSizeBytes: number;
  userDraftHash: FileHash;
  userDraftContentRef: string;
  userDraftSizeBytes: number;
  diffContentRef: string;
  diffHash: FileHash;
  diffSummary: FileRevisionDiffSummary;
  targetAgentIds: UUID[];
  instruction?: string;
  contextSnapshotHash: string;
  agentResults: FileRevisionAgentResult[];
  synthesisTaskId?: UUID;
  receiverInvocationId?: UUID;
  candidateChangeSetId?: UUID;
  candidateContentRef?: string;
  candidateHash?: FileHash;
  candidateSizeBytes?: number;
  confirmationId?: UUID;
  errorCode?: string;
  errorMessage?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  completedAt?: ISODateTime;
};

export type FileRevisionEditorDraft = {
  chainId: UUID;
  sourceRevisionId: UUID;
  sourceCandidateHash: FileHash;
  contentRef: string;
  contentHash: FileHash;
  sizeBytes: number;
  updatedBy: ActorRef;
  updatedAt: ISODateTime;
};

export type FileRevisionEditorDraftContent = FileRevisionEditorDraft & {
  content: string;
};

export type FileRevisionState = {
  baselines: FileRevisionBaseline[];
  chains: FileRevisionChain[];
  runs: FileRevisionRun[];
  drafts: FileRevisionEditorDraft[];
};

export type FileRevisionCandidate = {
  revisionId: UUID;
  chainId: UUID;
  iteration: number;
  candidateHash: FileHash;
  content: string;
  sizeBytes: number;
  status: FileRevisionRunStatus;
  stateVersion: number;
};

export type CaptureFileRevisionBaselineInput = {
  filePath: string;
  source?: FileRevisionBaseline['source'];
};

export type CreateFileRevisionRunInput = {
  baselineId: UUID;
  targetAgentIds: UUID[];
  instruction?: string;
};

export type SaveFileRevisionDraftInput = {
  expectedCandidateHash: FileHash;
  content: string;
};

export type ReprocessFileRevisionInput = {
  draftHash: FileHash;
  expectedCandidateHash: FileHash;
  expectedStateVersion: number;
  targetAgentIds?: UUID[];
  instruction?: string;
};

export type ResolveFileRevisionFailureInput = {
  expectedStateVersion: number;
  decision: 'retry_agents' | 'continue_with_successful' | 'abandon_revision';
  instruction?: string;
};

export type RetryInterruptedFileRevisionInput = {
  expectedStateVersion: number;
  retryKey: string;
};

export type DecideFileRevisionInput = {
  confirmationId: UUID;
  candidateHash: FileHash;
  expectedStateVersion: number;
  decision: 'apply_candidate' | 'abandon_revision';
};

export type ContextL3SelectedEvidence = {
  files: ContextL3EvidenceFile[];
  fileRevisions?: FileRevisionEvidence[];
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
  /** Runtime context ownership and decision provenance. Optional for persisted v2 envelopes created before WorkItem isolation. */
  contextScope?: {
    workItemId?: UUID;
    contextSnapshotId?: UUID;
    decisionSetHash?: string;
    inheritedDecisionIds: UUID[];
    inheritedArtifactIds: UUID[];
  };
};

export type WorkspaceIndexEntryKind = 'file' | 'directory';

export type WorkspaceIndexEntry =
  | {
      path: string;
      kind: 'file';
      size: number;
      /** Content hashes are intentionally absent from the metadata index. */
      hash?: FileHash;
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
  kind: 'local_bridge' | 'server_local';
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
  hash?: FileHash;
  revision?: WorkspaceRevision;
  startLine?: number;
  endLine?: number;
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
  | 'session_lifecycle_changed'
  | 'agent_status_changed'
  | 'brief_created'
  | 'brief_updated'
  | 'brief_confirmed'
  | 'brief_rejected'
  | 'user_confirmation_requested'
  | 'user_confirmation_resolved'
  | 'capability_approval_required'
  | 'capability_approved'
  | 'task_created'
  | 'task_assigned'
  | 'task_accepted'
  | 'task_claimed'
  | 'task_blocked'
  | 'task_reassigned'
  | 'task_started'
  | 'task_waiting'
  | 'task_completed'
  | 'task_dependency_reconciled'
  | 'task_failed'
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
  | 'file_revision_baseline_captured'
  | 'file_revision_chain_created'
  | 'file_revision_iteration_submitted'
  | 'file_revision_dispatched'
  | 'file_revision_agent_completed'
  | 'file_revision_synthesis_started'
  | 'file_revision_candidate_generated'
  | 'file_revision_draft_saved'
  | 'file_revision_candidate_superseded'
  | 'file_revision_failure_decision_requested'
  | 'file_revision_failure_resolved'
  | 'file_revision_apply_started'
  | 'file_revision_applied'
  | 'file_revision_stale'
  | 'file_revision_failed'
  | 'intent_clarification_required'
  | 'work_item_created'
  | 'work_item_activated'
  | 'decision_superseded'
  | 'follow_up_queued'
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
  workItemId?: UUID;
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
  /** Optimistic concurrency revision for Session-scoped routing mutations. */
  revision?: number;
  /** The logical requirement currently selected in this chat window. */
  activeWorkItemId?: UUID;
  /** Revision of the Session-wide decision ledger used by intent snapshots. */
  decisionLedgerRevision?: number;
  /** Marks Sessions created after WorkItem-aware routing became available. */
  intentRoutingGeneration?: 'v2';
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
  workspaceContext?: SessionWorkspaceContext;
  /** Provider-owned metadata index projection; never contains file content. */
  workspaceIndex?: WorkspaceIndexSnapshot;
  workspaceSnapshot?: WorkspaceSnapshot;
  workspaceMode?: WorkspaceMode;
  pendingBootstrapWorkflow?: PendingBootstrapWorkflow;
  runtimePreference?: RuntimePreference;
  workflowRunId?: UUID;
  workflowRun?: WorkflowRunState;
  supplementalContextRequests?: Array<{
    id: UUID;
    taskId?: UUID;
    agentId: UUID;
    phase?: AgentRunPhase;
    requestedContext: RuntimeContextRequest;
    resolution: SupplementalContextResolution;
    createdAt: ISODateTime;
  }>;
  /**
   * Existing-session messages that have completed receiver intent recognition
   * and are waiting for receiver decomposition/execution. The queue is
   * persisted so an in-flight task can finish without losing later input.
   */
  pendingFollowUpMessages?: SessionFollowUpMessage[];
  activeFollowUpMessageId?: UUID;
  /** Durable checkpoint used to resume a user-paused Session without replaying completed work. */
  pauseState?: {
    previousStatus: SessionStatus;
    pausedAt: ISODateTime;
    reason?: string;
  };
  /**
   * Durable pointer to the one user action that can recover the current execution.
   * Historical confirmation events remain audit records and are not used as control state.
   */
  activeRecoveryCheckpoint?: SessionRecoveryCheckpoint;
  /**
   * Invocations that are paused waiting for capability approval.
   * After user approves, these are automatically retried.
   */
  pendingInvocations?: PendingInvocation[];
  /** Durable writeback history for isolated executions in this Session. */
  workspaceWritebacks?: WorkspaceWritebackRecord[];
  tokenBudget?: number;
  tokenUsed: number;
  taskDomain?: TaskDomain;
  taskIntent?: TaskIntent;
  requiresCodeChanges?: boolean;
  participatingAgentIds: UUID[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  interruption?: {
    reason:
      | 'local_runtime_disconnected'
      | 'frontend_disconnected'
      | 'service_shutdown';
    invocationId?: UUID;
    occurredAt: ISODateTime;
    wakeable: true;
    /** Status held when the interruption happened, captured before the switch to INTERRUPTED. */
    previousStatus?: SessionStatus;
    /** WorkItem that owned the interrupted execution. */
    workItemId?: UUID;
    /**
     * Phase derived from previousStatus, in the same vocabulary as failure phases
     * (discussion / brief_revision / task_execution). Interruptions emit no failure
     * event, so this is the only reliable phase source for resume decisions.
     */
    phase?: string;
  };
};

export type SessionRecoveryCheckpoint = {
  confirmationId: UUID;
  reason:
    | 'coordinator_routing_needs_user_decision'
    | 'reconnect_local_runtime'
    | 'recover_interrupted_execution'
    | 'retry_failed_execution';
  workflowRunId?: UUID;
  workflowNodeRunId?: UUID;
  phase?: string;
  sourceEventId?: UUID;
  retryable: true;
  createdAt: ISODateTime;
};

export type SessionListItem = Pick<
  SessionDetail,
  'id' | 'title' | 'status' | 'tokenBudget' | 'tokenUsed' | 'createdAt' | 'updatedAt'
> & {
  agentCount: number;
  requiresUserAction: boolean;
  latestEventSummary?: string;
  projectId?: UUID;
  workspaceId?: string;
  lifecycleState?: 'active' | 'deleting' | 'deleted';
  lifecycleGeneration?: number;
  lifecycleRevision?: number;
  deleteRequestId?: UUID;
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
  /** Server-derived policy. Persisted values never grant system privileges. */
  management?: AgentManagementPolicy;
};

export type SystemAgentRole = 'intent_router' | 'coordinator';
export type AgentCatalogSurface = 'management' | 'chat' | 'workflow' | 'mention';
export type AgentEditableField = 'name' | 'description' | 'profileMarkdown';

export type AgentManagementPolicy = {
  owner: 'system' | 'user';
  systemRole?: SystemAgentRole;
  protected: boolean;
  allowedSurfaces: AgentCatalogSurface[];
  editableFields: AgentEditableField[];
};

export type SystemAgentRuntimePolicy = RuntimePreference & {
  role: SystemAgentRole;
  updatedAt?: ISODateTime;
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
  executionCheckpoint?: AgentTask['executionCheckpoint'];
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

/**
 * One previously executed Agent node a blocked downstream node can be sent back
 * to. Only Agent nodes are offered: approval gates carry no re-executable work.
 */
export type WorkflowUpstreamRerunCandidate = {
  nodeId: UUID;
  nodeName: string;
  agentId: UUID;
  agentName: string;
  lastOutputSummary?: string;
};

/**
 * Parks a run whose current Agent node reported that its upstream input is
 * incomplete. While this is set the run must never resume implicitly: doing so
 * would re-run the same node against the same missing upstream output.
 */
export type WorkflowPendingUpstreamRerun = {
  nodeId: UUID;
  nodeRunId: UUID;
  taskId: UUID;
  reason: string;
  missingInputs: string[];
  candidates: WorkflowUpstreamRerunCandidate[];
  requestedAt: ISODateTime;
};

/** Durable user-decision point for an Agent that cannot accept its assignment. */
export type WorkflowPendingAgentSubstitution = {
  nodeId: UUID;
  nodeRunId: UUID;
  taskId: UUID;
  currentAgentId: UUID;
  reason: string;
  candidates: Array<{ id: UUID; key: string; name: string; role: string }>;
  confirmationId: string;
  requestedAt: ISODateTime;
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
  /** Session generation captured when the run started; rejects results from a deleted/restored generation. */
  sessionGeneration?: number;
  workItemId?: UUID;
  briefId: UUID;
  ownerId: UUID;
  definitionSnapshot: WorkflowVersion;
  status: WorkflowRunStatus;
  currentNodeId?: UUID;
  pendingAgentSubstitution?: WorkflowPendingAgentSubstitution;
  pendingUpstreamRerun?: WorkflowPendingUpstreamRerun;
  revision: number;
  runtimeVersion: 'v2';
  startIdempotencyKey: string;
  /** Read-only hash manifest captured before the first node; no current-file fallback. */
  fileBaseline?: WorkflowFileBaseline;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  completedAt?: ISODateTime;
  failure?: {
    code: string;
    message: string;
    nodeId?: UUID;
  };
};

export type WorkflowFileBaseline = {
  capturedAt: ISODateTime;
  complete: boolean;
  hashes: Record<string, string>;
  reason?: string;
};

export type WorkflowDeliveryFileDiff = {
  status: 'complete' | 'unavailable';
  source: string;
  reason?: string;
  files: Array<{
    path: string;
    operation: 'create' | 'update' | 'delete' | 'move';
    previousPath?: string;
    before?: string;
    after?: string;
  }>;
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
  workItemId?: UUID;
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
  recoveryOriginTaskId?: UUID;
  previousExecutionOperationId?: UUID;
  executionCheckpoint?: {
    operationId?: string;
    invocationId: string;
    candidateId?: string;
    candidateHash?: string;
    stage: 'candidate_captured' | 'submission_validated' | 'writeback_confirmed';
    writebackId?: string;
  };
  executionOperationId?: UUID;
  acceptanceCheckpoint?: {
    inputFingerprint: string;
    agentId: UUID;
    decisionSource: 'rule' | 'model';
    decision: TaskAcceptanceDecisionOutput;
    invocationId: UUID;
    createdAt: ISODateTime;
  };
  id: UUID;
  sessionId: UUID;
  workItemId?: UUID;
  title: string;
  description: string;
  status: AgentTaskStatus;
  /** 指派方。 */
  assignedBy?: ActorRef;
  /** 被指派方。 */
  assignee?: ActorRef;
  /** Explicit receiver routing boundary, used by @Agent follow-up tasks. */
  eligibleAgentIds?: UUID[];
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
  /** True only when the user explicitly selected a replacement Agent for this workflow node. */
  workflowAgentOverride?: boolean;
  executionPurpose?: 'agent_work' | 'workflow_review' | 'file_revision' | 'revision_synthesis';
  /** Links task execution to the immutable user-revision snapshot in L3. */
  fileRevisionId?: UUID;
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
  workItemId?: UUID;
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
  /** Optional only for persisted plans created before this routing contract was introduced. */
  requirementRelation?: UserMessageRequirementRelation;
  /** Optional only for persisted plans created before this routing contract was introduced. */
  failedExecutionAction?: FailedExecutionAction;
  priority: EventPriority;
  shouldPause: boolean;
  affectedTaskIds: UUID[];
  affectedAgentIds: UUID[];
  requiresBriefRevision: boolean;
  requiresUserConfirmation: boolean;
  coordinatorInstruction: string;
};

export type WorkItem = {
  id: UUID;
  sessionId: UUID;
  parentWorkItemId?: UUID;
  title: string;
  goal: string;
  status: WorkItemStatus;
  revision: number;
  createdFromEventId: UUID;
  inheritedDecisionIds: UUID[];
  inheritedArtifactIds: UUID[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

export type DecisionRecordStatus = 'proposed' | 'confirmed' | 'superseded' | 'rejected';
export type DecisionRecordKind = 'requirement' | 'constraint' | 'preference' | 'approval' | 'correction';

export type DecisionRecord = {
  id: UUID;
  sessionId: UUID;
  workItemId: UUID;
  kind: DecisionRecordKind;
  status: DecisionRecordStatus;
  content: string;
  sourceEventId: UUID;
  supersedesDecisionId?: UUID;
  revision: number;
  confirmedBy?: ActorRef;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

export type IntentSnapshotRevision = {
  sessionRevision: number;
  activeWorkItemId?: UUID;
  activeWorkItemRevision?: number;
  decisionLedgerRevision: number;
  workflowRunId?: UUID;
  workflowRevision?: number;
  latestEventSeq: number;
};

export type PendingConfirmationContext = {
  confirmationId: UUID;
  reason: string;
  content: string;
  title?: string;
  description?: string;
  options: Array<{
    key: string;
    label: string;
    style?: 'primary' | 'default' | 'danger';
  }>;
  requiresStructuredAction?: boolean;
  createdAt: ISODateTime;
};

/** Bounded excerpt of one durable Session event; never the full event payload. */
export type IntentSnapshotMessageExcerpt = {
  eventId: UUID;
  role: 'user' | 'agent' | 'system';
  content: string;
  truncated?: boolean;
  createdAt: ISODateTime;
};

/**
 * Declared caps for a routing snapshot plus what those caps left out, so a routing
 * decision can be audited without replaying the whole Session history.
 */
export type IntentSnapshotBounds = {
  recentMessageLimit: number;
  messageCharLimit: number;
  candidateWorkItemLimit: number;
  totalCandidateWorkItems: number;
  omittedCandidateWorkItems: number;
  omittedRecentMessages: number;
};

export type IntentSnapshotRecall = {
  availability: 'ok' | 'limited';
  needsClarification: boolean;
  clarificationReason?: 'no_match' | 'multiple_similar_candidates' | 'low_confidence' | 'index_unavailable';
  candidates: Array<{
    workItemId: UUID;
    matchedBy: 'explicit' | 'lexical';
    matchedTerms: string[];
    latestCheckpointId?: UUID;
  }>;
};

export type IntentContextSnapshot = {
  /** Business inputs only; progress and heartbeat events never invalidate routing. */
  businessFingerprint?: string;
  id: UUID;
  sessionId: UUID;
  sourceEventId: UUID;
  activeWorkItemId?: UUID;
  activeWorkItem?: Pick<WorkItem, 'id' | 'title' | 'goal' | 'status' | 'revision'>;
  currentMessage: string;
  /** Server-resolved @ targets. The classifier may not add, replace or silently drop them. */
  mentionedAgentIds?: UUID[];
  replyToEventId?: UUID;
  replyToMessage?: IntentSnapshotMessageExcerpt;
  /** Bounded recent dialogue for the current requirement, oldest first. */
  recentRelevantMessages?: IntentSnapshotMessageExcerpt[];
  bounds?: IntentSnapshotBounds;
  /**
   * Bounded historical-requirement recall (phase 2B). Ambiguity is surfaced here
   * so the router clarifies instead of switching requirements on a guess.
   */
  recall?: IntentSnapshotRecall;
  pendingConfirmation?: string;
  pendingConfirmationContext?: PendingConfirmationContext;
  validDecisionIds: UUID[];
  validDecisions: Array<Pick<DecisionRecord, 'id' | 'kind' | 'status' | 'content' | 'revision'>>;
  candidateWorkItemIds: UUID[];
  candidateWorkItems: Array<Pick<WorkItem, 'id' | 'title' | 'goal' | 'status' | 'revision'>>;
  failureCheckpoint?: string;
  revision: IntentSnapshotRevision;
  snapshotHash: string;
  createdAt: ISODateTime;
};

export type IntentRoutingDecisionV2 = {
  dialogueAct: UserMessageIntent;
  scopeRelation: RequirementScopeRelation;
  contextPolicy: ContextInheritancePolicy;
  requestedAction: IntentRoutingAction;
  selectedWorkItemId?: UUID;
  selectedDecisionIds: UUID[];
  selectedArtifactIds: UUID[];
  /**
   * Agents the route should address. Optional so routing records persisted before
   * this field existed stay readable; the server rejects a decision that drops an
   * explicit @ target rather than trusting the classifier to repeat it.
   */
  requestedAgentIds?: UUID[];
  goalSegments: string[];
  missingFields: string[];
  ambiguityReasons: string[];
  reasonCodes: string[];
  riskLevel: CapabilityRiskLevel;
  modelConfidence?: number;
};

export type IntentRoutingValidation = {
  schemaValid: boolean;
  referencesValid: boolean;
  transitionValid: boolean;
  snapshotCurrent: boolean;
  safeToApply: boolean;
  serverConfidence: number;
  errors: string[];
};

export type IntentRoutingRecord = {
  /** Durable monotonic allowance, independent from diagnostic reasonCodes. */
  snapshotRebuildCount?: number;
  id: UUID;
  sessionId: UUID;
  sourceEventId: UUID;
  sessionSeq: number;
  status: IntentRoutingStatus;
  policyVersion: string;
  rolloutMode: IntentRoutingRolloutMode;
  snapshotId?: UUID;
  invocationId?: UUID;
  decision?: IntentRoutingDecisionV2;
  validation?: IntentRoutingValidation;
  finalAction?: IntentRoutingAction;
  actionStatus?: 'pending' | 'applying' | 'applied' | 'failed';
  /** Persisted because a replay must not activate a deferred WorkItem early. */
  deferredActivation?: boolean;
  /**
   * A server-created replacement context. The semantic classifier may describe
   * the new message, but it must never redirect this recovery message back to
   * the WorkItem whose cumulative budget was exhausted.
   */
  forcedWorkItemId?: UUID;
  leaseOwner?: string;
  leaseExpiresAt?: ISODateTime;
  reasonCodes: string[];
  retryCount: number;
  idempotencyKey: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

export type SessionFollowUpMessage = {
  id: UUID;
  sourceEventId: UUID;
  content: string;
  mentionedAgentIds: UUID[];
  /** Explicit user reply target. Server-validated to the same Session; the classifier cannot invent it. */
  replyToEventId?: UUID;
  handlingPlan: UserMessageHandlingPlan;
  workItemId?: UUID;
  routingId?: UUID;
  receiverRecognitionPending?: boolean;
  status: 'queued' | 'planning' | 'executing' | 'completed' | 'failed' | 'cancelled';
  queuedAt: ISODateTime;
  startedAt?: ISODateTime;
};

export type RuntimeInvocationStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'pending_approval';

export type RuntimeUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost?: number;
  model?: string;
  /**
   * Provider cache counters, kept separate from `inputTokens` because providers
   * disagree about whether their input counter already contains the cached
   * prefix. Absent means the provider reported nothing — not a zero-token miss.
   */
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  /**
   * What the model had to read this call, cached or not. Absent when usage is
   * unknown, so a silent provider is never settled as a free call.
   */
  logicalInputTokens?: number;
  /**
   * How the numbers were obtained. Existing call sites that hard-code zeros are
   * indistinguishable from a measured zero without this, which is why unknown is
   * a first-class value rather than a missing field.
   */
  measurement?: 'actual' | 'estimated' | 'unknown';
  /** Required before `cost` can be explained; an amount without it is not reportable. */
  priceVersion?: string;
};

/**
 * Every counted model call against one requirement. Classification, consultation,
 * retries, summaries and supplemental reads all draw on the same requirement
 * budget, so they share one ledger rather than each holding its own allowance.
 */
export type WorkItemBudgetCategory =
  | 'classification'
  | 'consultation'
  | 'retry'
  | 'summary'
  | 'supplemental_read'
  | 'execution';

export type WorkItemBudgetReservation = {
  attemptId: string;
  operationId: string;
  category: WorkItemBudgetCategory;
  reservedTokens: number;
  reservedAt: ISODateTime;
};

/**
 * `reported` carries a provider measurement; `unavailable` keeps the reservation
 * cap as a conservative bound because the call may still have been billed.
 */
export type WorkItemBudgetSettlement = {
  attemptId: string;
  settledAt: ISODateTime;
  outcome: 'reported' | 'unavailable';
  actualTokens: number;
  unknownTokens: number;
};

export type WorkItemBudgetLedger = {
  workItemId: UUID;
  limitTokens: number;
  reservedTokens: number;
  actualTokens: number;
  unknownTokens: number;
  /** Spend that already went past the limit; kept visible instead of clamped away. */
  overrunTokens: number;
  reservations: WorkItemBudgetReservation[];
  settlements: WorkItemBudgetSettlement[];
  revision: number;
  updatedAt: ISODateTime;
};

/**
 * Per-surface attribution of one invocation's request budget. A single opaque
 * total cannot show that the system prompt, tool definitions, schema, evidence
 * and tool history were all counted, so each surface is reported separately.
 */
export type RuntimeTokenEstimationBreakdown = {
  systemPromptTokens: number;
  toolDefinitionTokens: number;
  contextEnvelopeTokens: number;
  expectedOutputTokens: number;
  toolHistoryTokens: number;
};

/**
 * Request-budget accounting for one invocation. The platform cannot tokenise an
 * upstream payload exactly, so every check records which estimator was used,
 * what it predicted per surface, and — when the provider reports usage — how far
 * the prediction was off. `drift` is absent when usage is unknown rather than
 * reported as zero error.
 */
export type RuntimeTokenEstimationDiagnostic = {
  estimator: string;
  estimatedInputTokens: number;
  actualInputTokens: number;
  drift?: {
    estimated: number;
    actual: number;
    ratio: number;
  };
  outputReservationTokens: number;
  safetyMarginTokens: number;
  maxInputTokens?: number;
  effectiveMaxInputTokens?: number;
  rounds: number;
  breakdown: RuntimeTokenEstimationBreakdown;
  /**
   * What the platform declared about prompt caching for this provider/model/
   * endpoint before sending. Absent on adapters that never resolve a provider
   * connection. `unknown` is recorded, not skipped: it is the difference between
   * "no cache counters because none were expected" and "a zero-token miss".
   */
  cacheCapability?: 'supported' | 'unsupported' | 'unknown';
};

export type RuntimeModelProvider = 'openai-compatible' | 'anthropic-compatible' | 'ollama';
export type RuntimeModelKind = 'local' | 'remote';
export type RuntimeModelSource = 'env' | 'default' | 'local' | 'remote';
export type RuntimeCredentialLocation = 'local' | 'server';

export const RUNTIME_MODEL_PROVIDER_RUNTIMES = {
  'openai-compatible': ['generic_llm', 'codex'],
  'anthropic-compatible': ['claude_code'],
  ollama: ['generic_llm']
} as const satisfies Readonly<Record<RuntimeModelProvider, readonly RuntimeType[]>>;

export function runtimeTypesForModelProvider(provider: RuntimeModelProvider): readonly RuntimeType[] {
  return RUNTIME_MODEL_PROVIDER_RUNTIMES[provider];
}

export function modelProviderSupportsRuntime(provider: RuntimeModelProvider, runtimeType: RuntimeType): boolean {
  return (RUNTIME_MODEL_PROVIDER_RUNTIMES[provider] as readonly RuntimeType[]).includes(runtimeType);
}

export type RuntimeModelOption = {
  id: string;
  label: string;
  provider: RuntimeModelProvider;
  source: RuntimeModelSource;
  kind: RuntimeModelKind;
  credentialLocation: RuntimeCredentialLocation;
  deviceId?: UUID;
  compatibleRuntimeTypes: readonly RuntimeType[];
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
      provider?: 'ollama';
      credentialLocation?: 'server';
      model: string;
      label?: string;
    }
  | {
      kind: 'remote';
      provider?: Extract<RuntimeModelProvider, 'openai-compatible' | 'anthropic-compatible'>;
      credentialLocation?: RuntimeCredentialLocation;
      deviceId?: UUID;
      model: string;
      baseUrl: string;
      apiKey: string;
      label?: string;
    };

export type RuntimeModelUpdateInput = {
  label?: string;
  model?: string;
  baseUrl?: string;
  provider?: Extract<RuntimeModelProvider, 'openai-compatible' | 'anthropic-compatible'>;
  credentialLocation?: RuntimeCredentialLocation;
  deviceId?: UUID;
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
  workItemId?: UUID;
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
  workItemId?: UUID;
  phase: AgentRunPhase;
  taskId?: UUID;
  agentId?: UUID;
  summaryMemory: SummaryMemory;
  sourceEventIds: UUID[];
  sourceArtifactIds: UUID[];
  sourceMemoryIds: UUID[];
  createdAt: ISODateTime;
  /**
   * Version binding (phase 2B). Optional so checkpoints persisted before this
   * field set stay readable; a checkpoint without them is treated as legacy and
   * never wins over a versioned one.
   */
  coveredEventSeq?: number;
  workItemRevision?: number;
  decisionLedgerRevision?: number;
  policyVersion?: string;
  contentHash?: string;
  generation?: number;
  logicalKey?: string;
  sourceDecisionIds?: UUID[];
};

/** Current summary generation strategy; bump when the derivation rules change. */
export const SUMMARY_CHECKPOINT_POLICY_VERSION = 'summary-checkpoint-v2' as const;

export type SummaryCheckpointRejectionCode =
  | 'SUMMARY_CHECKPOINT_STALE_GENERATION'
  | 'SUMMARY_CHECKPOINT_STALE_VERSION'
  | 'SUMMARY_CHECKPOINT_COVERAGE_REGRESSED'
  | 'SESSION_ADMISSION_CLOSED';

/**
 * Durable, queryable checkpoint row. The checkpoint itself stays derived data:
 * events, artifacts and DecisionRecords remain the traceable source; this row
 * only pins which versions of them a summary was built from.
 */
export type SummaryCheckpointRecord = {
  checkpointId: UUID;
  sessionId: UUID;
  workItemId: UUID;
  /** workItemId + coveredEventSeq + version fingerprint; one commit per key across processes. */
  logicalKey: string;
  coveredEventSeq: number;
  workItemRevision: number;
  decisionLedgerRevision: number;
  policyVersion: string;
  contentHash: string;
  generation?: number;
  phase: AgentRunPhase;
  summaryMemory: SummaryMemory;
  sourceEventIds: UUID[];
  sourceArtifactIds: UUID[];
  sourceMemoryIds: UUID[];
  sourceDecisionIds: UUID[];
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
  /** The logical WorkItem that owns this Runtime invocation's context. */
  workItemId?: UUID;
  contextSnapshotId?: UUID;
  decisionSetHash?: string;
  inheritedDecisionIds?: UUID[];
  inheritedArtifactIds?: UUID[];
  /** Auditable task/phase execution target chosen for this invocation. */
  resolvedExecutionTarget?: ResolvedExecutionTarget;
  systemRules: string[];
  sessionGoal: string;
  /** 当前契约的最新目标;存在时为本次调用的权威目标,优先于 sessionGoal。 */
  currentContractGoal?: string;
  /** The exact message that triggered this invocation. */
  currentUserMessage?: string;
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
    hash?: FileHash;
    revision?: WorkspaceRevision;
    startLine?: number;
    endLine?: number;
    tokenEstimate?: number;
    selectionReason?: string;
  }>;
  /** Frozen original/revised/diff evidence for file-revision tasks. */
  fileRevisionEvidence?: FileRevisionEvidence[];
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
  | 'revision_synthesis'
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

export type PendingApprovalInfo = {
  toolId: string;
  toolKey: string;
  approvalId: string;
  reasons: string[];
};

export type PendingInvocation = {
  invocationId: UUID;
  sessionId: UUID;
  taskId: UUID;
  agentId: UUID;
  phase: AgentRunPhase;
  pendingApprovals: PendingApprovalInfo[];
  createdAt: ISODateTime;
};

export type LogicalOperation = {
  scopeKey?: string;
  diagnostics?: string[];
  correctionsUsed?: number;
  pauseRequested?: boolean;
  executionKind?: 'internal' | 'process';
  previousId?: UUID;
  id: UUID;
  sessionId: UUID;
  /** Captured Session lifecycle generation; stale callbacks cannot cross a delete/restore boundary. */
  sessionGeneration?: number;
  parentId?: UUID;
  taskId?: UUID;
  phase: AgentRunPhase;
  policyVersion: 'execution-reliability-v1';
  status: 'ready' | 'running' | 'paused' | 'interrupted' | 'exhausted';
  deadlineAt: ISODateTime;
  remainingActiveMs: number;
  maxAttempts: number;
  attemptsUsed: number;
  stopState: 'none' | 'requested' | 'confirmed' | 'unconfirmed';
  activeInvocationId?: UUID;
  transport?: { deviceId: string; workspaceId: string; runtimeType: RuntimeType };
  outputContractKey?: string;
  ownerId?: string;
  invocationIds: UUID[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

export type SessionStopTargetState = 'waiting' | 'pending_sync' | 'confirmed' | 'unknown';

export type SessionStopTarget = {
  invocationId: UUID;
  operationId?: UUID;
  state: SessionStopTargetState;
  evidence?: 'adapter_result' | 'transport_receipt';
  diagnostic?: string;
  updatedAt: ISODateTime;
};

export type SessionStopRequest = {
  id: UUID;
  sessionId: UUID;
  reason: string;
  targetInvocationIds: UUID[];
  targets: SessionStopTarget[];
  version: number;
  status: 'requested' | 'waiting' | 'confirmed';
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

export type RuntimeStopBlocker = {
  invocationId?: UUID;
  operationId?: UUID;
  reason: 'process_running' | 'process_exit_unknown' | 'stop_state_pending_sync' | 'stop_state_sync_exhausted' | 'state_query_failed';
  message: string;
};

export type RuntimeStopSummary = {
  sessionId: UUID;
  stopRequestId?: UUID;
  version: number;
  status: 'idle' | 'requested' | 'waiting' | 'confirmed' | 'unknown';
  requestedCount: number;
  confirmedCount: number;
  targets: SessionStopTarget[];
  blockers: RuntimeStopBlocker[];
  canResume: boolean;
  updatedAt?: ISODateTime;
};

export type RuntimeExecutionCandidate = {
  id: string;
  invocationId: string;
  sessionId: string;
  taskId?: string;
  workItemId?: string;
  workspaceId: string;
  baseRevision: WorkspaceRevision;
  changeSet: WorkspaceChangeSet;
  manifestHash: string;
  permissionHash: string;
  outputVersion: '1.0' | '2.0';
  createdAt: ISODateTime;
  expiresAt: ISODateTime;
  stage: 'candidate_captured' | 'submission_validated';
  originalSubmission?: unknown;
  schemaErrors?: string[];
};

export type InvocationPlan = {
  recoveryOriginTaskId?: UUID;
  recoveryCandidate?: RuntimeExecutionCandidate;
  submissionRepair?: boolean;
  invocationId: UUID;
  sessionId: UUID;
  workItemId?: UUID;
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
  pendingApprovals?: PendingApprovalInfo[];
  operation?: Pick<LogicalOperation, 'id' | 'deadlineAt' | 'policyVersion' | 'maxAttempts' | 'sessionGeneration'>;
};

export type RuntimeAttemptTrace = {
  attemptGroupId: UUID;
  attempt: number;
  retryOfInvocationId?: UUID;
  fallbackFromRuntimeType?: RuntimeType;
  fallbackReason?: string;
  supplementalContextAttempt?: number;
  supplementalContextDurationMs?: number;
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
  schemaVersion: '1.0' | '2.0';
};

export type RuntimeArtifactOutput = RegisteredRuntimeArtifactOutput;
export type FileRevisionCandidateOutput = RegisteredFileRevisionCandidateOutput;
export type RuntimeArtifactProposal = RegisteredRuntimeArtifactProposal;
export type RuntimeArtifactMetadata = RegisteredRuntimeArtifactMetadata;

/**
 * Canonical file request with optional line range. `requestedFiles` is the
 * only canonical field persisted, audited and processed internally; legacy
 * `requestedPaths: string[]` is accepted only at the Runtime Normalizer
 * boundary and immediately converted.
 */
export type RuntimeContextFileRequest = {
  path: string;
  startLine?: number;
  endLine?: number;
  maxBytes?: number;
};

export type RuntimeContextRequest = {
  reason: string;
  requestedRefs: TaskEvidenceRef[];
  requestedFiles?: RuntimeContextFileRequest[];
  requestedDirectories?: Array<{
    path: string;
    depth?: number;
  }>;
  requestedSearches?: Array<{
    query: string;
    path?: string;
    include?: string[];
    exclude?: string[];
  }>;
  requestedCommands?: string[];
  followUpInstruction?: string;
  /**
   * @deprecated Legacy alias accepted only by the Runtime Normalizer migration
   * entry; production code must read `requestedFiles`. Never persisted on new
   * records.
   */
  requestedPaths?: string[];
};

export type SupplementalContextPathFailureCode =
  | 'NOT_FOUND'
  | 'PERMISSION_REQUIRED'
  | 'BROKER_OFFLINE'
  | 'READ_UNAVAILABLE'
  | 'DEADLINE_EXCEEDED'
  | 'WORKSPACE_REVISION_UNSTABLE'
  | 'READ_ERROR';

export type SupplementalContextRefFailureCode =
  | 'INVALID_REFERENCE'
  | 'NOT_FOUND'
  | 'AMBIGUOUS_REFERENCE'
  | 'READ_ERROR';

/** Terminal state of a supplemental hydration pass. */
export type SupplementalContextOutcome =
  | 'resolved'
  | 'partial'
  | 'exhausted'
  | 'cancelled';

export type SupplementalContextResolution = {
  requestedFiles: RuntimeContextFileRequest[];
  hydratedPaths: string[];
  /** Canonical evidence references that were found and can be promoted to L3. */
  resolvedRefs?: TaskEvidenceRef[];
  /** Explicit failures for semantic evidence references; unresolved refs are never treated as hydrated. */
  failedRefs?: Array<{
    type: EvidenceSourceType;
    label: string;
    ref?: string;
    code: SupplementalContextRefFailureCode;
    retryable: boolean;
    message?: string;
  }>;
  /** Revision for each successfully materialized workspace evidence path. */
  evidenceRevisions?: Record<string, WorkspaceRevision>;
  listedDirectories?: string[];
  completedSearches?: string[];
  failedPaths: Array<{
    path: string;
    code: SupplementalContextPathFailureCode;
    retryable: boolean;
    message?: string;
  }>;
  deferredPaths: string[];
  contentBytes: number;
  outcome: SupplementalContextOutcome;
  attempt: number;
  maxAttempts: number;
};

export type ExecutionTerminationKind =
  | 'output_contract_failure'
  | 'user_cancelled'
  | 'user_paused'
  | 'frontend_disconnected'
  | 'runtime_disconnected'
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
    | 'HUMAN_APPROVAL_REQUIRED'
    | 'CONTEXT_INSUFFICIENT'
    | 'CONTEXT_RETRY_EXHAUSTED'
    | 'TOKEN_BUDGET_EXCEEDED'
    | 'WORK_ITEM_BUDGET_EXHAUSTED'
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
  operationTelemetry?: {
    operationId: string;
    policyVersion: string;
    startedAt: ISODateTime;
    adapterStartedAt?: ISODateTime;
    firstUsefulOutputAt?: ISODateTime;
    preparationMs?: number;
    observedToolMs?: number;
    unclassifiedMs?: number;
    queueWaitMs?: null;
    initialEvidenceBytes?: number;
    completedAt: ISODateTime;
    elapsedMs: number;
    remainingMs: number;
    stopState: LogicalOperation['stopState'];
    upstreamWaitMs: null;
    usageScope: 'reported_cumulative';
    billableTokens: null;
  };
  executionCandidate?: RuntimeExecutionCandidate;
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
  tokenEstimation?: RuntimeTokenEstimationDiagnostic;
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
export type IntentRoutingDecisionOutput = RegisteredIntentRoutingDecisionOutput;

export type AgentRuntimeAdapter = {
  type: RuntimeType;
  metadata?: RuntimeAdapterMetadata;
  maxStructuredOutputTokens?: (input: { modelId?: string }) => number | undefined;
  start(input: InvocationPlan, signal?: AbortSignal): AgentRuntimeRunHandle;
  checkAvailability?: () => Promise<RuntimeAvailability>;
  healthCheck?: () => Promise<RuntimeHealthStatus>;
};

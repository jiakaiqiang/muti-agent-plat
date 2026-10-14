import type {
  AgentRunResult,
  AgentRuntimeEvent,
  ExecutionTermination,
  ISODateTime,
  InvocationPlan,
  RuntimeExecutionLocation,
  RuntimeModelProvider,
  RuntimeType,
  UUID,
  WorkspaceCapabilities,
  WorkspaceIndexSummary,
  WorkspaceProviderKind,
  WorkspaceRevision
} from './contracts.js';
import type { ConflictView, DeliveryDiff, DeliveryValidation, GitTaskCandidate, RepositoryValidationCommand } from './contracts.js';

export const LOCAL_RUNTIME_PROTOCOL_VERSION = 11 as const;

export type LocalGitHubAuthorizationSummary = {
  id: UUID;
  kind?: 'pat' | 'github_app';
  deviceId: UUID;
  accountId: string;
  accountLogin: string;
  accountEmail?: string;
  repositoryId: string;
  repositoryUrl: string;
  state: 'active' | 'invalid' | 'disconnected';
  expiresAt?: ISODateTime;
  version: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
};

export type LocalGitHubAuthorizationAction =
  | { action: 'save_pat'; token: string; authorizationId?: never }
  | { action: 'save_oauth'; token: string; expiresAt?: ISODateTime; authorizationId?: never }
  | { action: 'find_reusable'; token?: never; authorizationId?: never }
  | { action: 'disconnect'; authorizationId: UUID; token?: never };

export type LocalGitHubAuthorizationRequest = {
  requestId: UUID;
  repositoryUrl: string;
} & LocalGitHubAuthorizationAction;

export type LocalGitHubAuthorizationResult = {
  requestId: UUID;
  status: 'ok' | 'error';
  authorization?: LocalGitHubAuthorizationSummary;
  error?: { code: string };
};

export type LocalGitHubSourceAction =
  | { action: 'prepare'; sessionId: UUID; repositoryUrl: string; authorizationId: UUID }
  | { action: 'branches'; sessionId: UUID }
  | { action: 'select_branch'; sessionId: UUID; baseBranch: string }
  | { action: 'cleanup'; sessionId: UUID };

export type LocalGitHubSourceRequest = LocalGitHubSourceAction & { requestId: UUID };

export type LocalGitHubSourceResult = {
  requestId: UUID;
  status: 'ok' | 'error';
  repositoryId?: string;
  defaultBranch?: string;
  cacheKey?: string;
  workspaceId?: UUID;
  baseSha?: string;
  branches?: Array<{ name: string; sha: string }>;
  workspace?: LocalRuntimeWorkspaceRegistration;
  error?: { code: string };
};

export type LocalGitHubDeliveryAction =
  | { action: 'integrate_validate'; sessionId: UUID; baseSha: string; round: number;
      candidates: GitTaskCandidate[]; command?: RepositoryValidationCommand }
  | { action: 'validate'; sessionId: UUID; treeSha: string; comparisonSha: string;
      command?: RepositoryValidationCommand }
  | { action: 'publish'; sessionId: UUID; authorizationId: UUID; repositoryUrl: string;
      round: number; baseBranch: string; baseSha: string; treeSha: string;
      previousCommitSha?: string; integratedRemoteSha?: string }
  | { action: 'status'; sessionId: UUID; authorizationId: UUID; repositoryUrl: string;
      pullRequestNumber: number }
  | { action: 'merge'; sessionId: UUID; authorizationId: UUID; repositoryUrl: string;
      pullRequestNumber: number; expectedHeadSha: string }
  | { action: 'diff'; sessionId: UUID; authorizationId: UUID; repositoryUrl: string;
      kind: 'pull_request' | 'merged_commit'; pullRequestNumber?: number;
      sha: string; page: number }
  | { action: 'start_conflict'; sessionId: UUID; authorizationId: UUID;
      repositoryUrl: string; round: number; headSha: string; baseBranch: string }
  | { action: 'conflict_view'; sessionId: UUID; conflictId: UUID }
  | { action: 'conflict_save'; sessionId: UUID; conflictId: UUID; fileId: UUID;
      expectedVersion: number; resultContent?: string; binaryChoice?: 'ours' | 'theirs';
      confirm: boolean }
  | { action: 'conflict_complete'; sessionId: UUID; conflictId: UUID;
      expectedVersion: number };

export type LocalGitHubDeliveryRequest = LocalGitHubDeliveryAction & { requestId: UUID };

export type LocalGitHubDeliveryResult = {
  requestId: UUID;
  sessionId: UUID;
  status: 'ok' | 'error';
  outcome?: 'needs_input' | 'conflict' | 'validated' | 'no_changes' | 'published' | 'remote_changed' | 'status' | 'merged' | 'diff' | 'conflict_view' | 'conflict_complete';
  treeSha?: string;
  changedPaths?: string[];
  conflicts?: string[];
  validation?: DeliveryValidation;
  command?: RepositoryValidationCommand;
  taskBranch?: string;
  remoteHeadSha?: string;
  commitSha?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  pullRequestHeadSha?: string;
  ciStatus?: 'not_configured' | 'pending' | 'failed' | 'passed';
  pullRequestState?: 'open' | 'closed';
  mergeable?: boolean | null;
  mergedCommitSha?: string;
  diff?: DeliveryDiff;
  conflictView?: ConflictView;
  error?: { code: string };
};

export const LOCAL_RUNTIME_PERMISSION_KEYS = [
  'workspace_read',
  'workspace_write',
  'workspace_delete',
  'command_execute',
  'test_execute',
  'dependency_install'
] as const;

export type LocalRuntimePermission = (typeof LOCAL_RUNTIME_PERMISSION_KEYS)[number];

export type LocalRuntimePermissionPolicy = Readonly<Record<LocalRuntimePermission, 'allow' | 'confirm' | 'deny'>>;

export const DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY: LocalRuntimePermissionPolicy = {
  workspace_read: 'allow',
  workspace_write: 'allow',
  workspace_delete: 'confirm',
  command_execute: 'allow',
  test_execute: 'allow',
  dependency_install: 'confirm'
};

export type LocalRuntimeWorkspaceRegistration = {
  workspaceId: UUID;
  displayName: string;
  capabilities: WorkspaceCapabilities;
  revision: WorkspaceRevision;
  permissions: LocalRuntimePermissionPolicy;
  registeredAt: ISODateTime;
  /**
   * Required in protocol v6+. Must include `coverage`. Omitting this field or
   * sending a Summary without `coverage` is a protocol violation.
   */
  index: WorkspaceIndexSummary;
};

export type LocalRuntimeWorkspaceSummary = LocalRuntimeWorkspaceRegistration & {
  deviceId: UUID;
  connectedAt: ISODateTime;
  runtimeTypes: readonly RuntimeType[];
  runtimeCapabilities: readonly LocalRuntimeCapabilityStatus[];
};

export type LocalRuntimeCapabilityStatus = {
  runtimeType: Extract<RuntimeType, 'codex' | 'claude_code'>;
  status: 'ready' | 'not_found' | 'probe_failed';
  version?: string;
  reasonCode?: string;
  checkedAt: ISODateTime;
};

export type LocalRuntimeCapabilityRefreshResult = {
  requestId: UUID;
  capabilities: readonly LocalRuntimeCapabilityStatus[];
};

export type LocalRuntimeWorkspaceAuthorizationRequest = {
  requestId: UUID;
  title?: string;
};

export type LocalRuntimeWorkspaceAuthorizationResult = {
  requestId: UUID;
  status: 'selected' | 'cancelled' | 'error';
  workspace?: LocalRuntimeWorkspaceRegistration;
  error?: { code: string; message: string };
};

export type LocalRuntimeWorkspacePermissionGrantRequest = {
  requestId: UUID;
  workspaceId: UUID;
  permission: LocalRuntimePermission;
  scope: 'once';
  /** Exact user-confirmed conflict result; grants deletion only for this digest. */
  writeback?: { changeSetId: UUID; digest: string };
};

export type LocalRuntimeWorkspacePermissionGrantResult = {
  requestId: UUID;
  workspaceId: UUID;
  permission: LocalRuntimePermission;
  status: 'granted' | 'error';
  workspace?: LocalRuntimeWorkspaceRegistration;
  error?: { code: string; message: string };
};

export type LocalRuntimeProviderConnectionInput = {
  connectionId: string;
  provider: Extract<RuntimeModelProvider, 'openai-compatible' | 'anthropic-compatible'>;
  model: string;
  baseUrl: string;
  apiKey: string;
};

export type LocalRuntimeProviderConnectionSummary = Omit<LocalRuntimeProviderConnectionInput, 'apiKey'> & {
  deviceId: UUID;
  hasApiKey: boolean;
  compatibleRuntimeTypes: readonly RuntimeType[];
  updatedAt: ISODateTime;
};

export type LocalRuntimeProviderConnectionUpsertRequest = {
  requestId: UUID;
  connection: LocalRuntimeProviderConnectionInput;
};

export type LocalRuntimeProviderConnectionDeleteRequest = {
  requestId: UUID;
  connectionId: string;
};

export type LocalRuntimeProviderConnectionResult = {
  requestId: UUID;
  status: 'ok' | 'error';
  connection?: LocalRuntimeProviderConnectionSummary;
  error?: { code: string; message: string };
};

export type LocalRuntimeDeviceRegistration = {
  deviceId: UUID;
  displayName: string;
  cliVersion: string;
  protocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  runtimes: Readonly<Record<string, string>>;
  connectedAt: ISODateTime;
  lastSeenAt: ISODateTime;
};

export type LocalRuntimeExecutionTarget = {
  executionLocation: Extract<RuntimeExecutionLocation, 'local'>;
  workspaceProviderKind: Extract<WorkspaceProviderKind, 'local_bridge'>;
  runtimeType: RuntimeType;
  workspaceId: UUID;
};

export type LocalRuntimeCompatibility = {
  compatible: boolean;
  cliVersion: string;
  protocolVersion: number;
  requiredProtocolVersion: typeof LOCAL_RUNTIME_PROTOCOL_VERSION;
  requiredCliVersion?: string;
  reason?: string;
  upgradeRequired?: boolean;
  upgradeAvailable?: boolean;
  upgradeInfo?: LocalRuntimeUpgradeInfo;
};

export type LocalRuntimeUpgradeSubject = 'desktop' | 'local-runtime' | 'server';

export type LocalRuntimeUpgradeInfo = {
  upgradeId: UUID;
  subject: LocalRuntimeUpgradeSubject;
  fromVersion: string;
  toVersion: string;
  fromProtocolVersion?: number;
  toProtocolVersion?: number;
  fromBuildId?: string;
  toBuildId: string;
  releaseNotes: readonly string[];
  packageSize?: number;
  sha256?: string;
  signature?: string;
  installerType: 'windows-nsis' | 'manual-package';
  mandatory: boolean;
  releaseUrl?: string;
};

export type LocalRuntimeUpgradeProgressState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'stopping'
  | 'installing'
  | 'restarting'
  | 'reconnecting'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type LocalRuntimeUpgradeProgress = {
  upgradeId: UUID;
  state: LocalRuntimeUpgradeProgressState;
  percent?: number;
  message?: string;
  errorCode?: string;
  updatedAt?: ISODateTime;
};

export type LocalRuntimeProtocolError = {
  code: string;
  message: string;
  compatibility?: LocalRuntimeCompatibility;
  upgradeInfo?: LocalRuntimeUpgradeInfo;
};

export type LocalRuntimeDeviceStatus = 'pending' | 'active' | 'revoked';

export type LocalRuntimeDevice = {
  deviceId: UUID;
  ownerId: UUID;
  displayName: string;
  status: LocalRuntimeDeviceStatus;
  cliVersion: string;
  protocolVersion: number;
  runtimes: Readonly<Partial<Record<RuntimeType, string>>>;
  createdAt: ISODateTime;
  lastSeenAt?: ISODateTime;
  revokedAt?: ISODateTime;
};

export type CreateLocalRuntimeDeviceCodeRequest = {
  deviceId: UUID;
  displayName: string;
  cliVersion: string;
  protocolVersion: number;
  runtimes: Readonly<Partial<Record<RuntimeType, string>>>;
};

export type LocalRuntimeDeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: ISODateTime;
  intervalSeconds: number;
  compatibility: LocalRuntimeCompatibility;
};

export type LocalRuntimeTokenResponse = {
  deviceId: UUID;
  accessToken: string;
  accessTokenExpiresAt: ISODateTime;
  refreshToken: string;
  refreshTokenExpiresAt: ISODateTime;
};

export type LocalRuntimeTokenPendingResponse = {
  status: 'authorization_pending';
  retryAfterSeconds: number;
};

export type LocalRuntimeHello = {
  requestHealthProtocol?: 1;
  outputContractVersions?: readonly string[];
  deviceId: UUID;
  cliVersion: string;
  protocolVersion: number;
  runtimes: Readonly<Partial<Record<RuntimeType, string>>>;
  capabilities?: readonly LocalRuntimeCapabilityStatus[];
};

export type LocalRuntimeInvocationRequest = {
  plan: InvocationPlan;
  workspaceId: UUID;
  workspaceRevision: WorkspaceRevision;
  permissions: LocalRuntimePermissionPolicy;
};

export type LocalRuntimeInvocationResult = {
  result: AgentRunResult;
  workspaceId: UUID;
  workspaceRevision: WorkspaceRevision;
};

export type LocalRuntimeWorkspaceOperationRequest = import('./contracts.js').WorkspaceOperationRequest & {
  invocationId: UUID;
  ownerId: UUID;
  workspaceRevision: WorkspaceRevision;
  permissions: LocalRuntimePermissionPolicy;
};

export type LocalRuntimeStopReceipt = {
  invocationId: UUID;
  workspaceId: UUID;
  runtimeType: RuntimeType;
};

export type LocalRuntimeInvocationProbe = import('./runtime-request-health.js').RuntimeHealthIdentity & {
  requestId: UUID; deviceId: UUID; workspaceId: UUID;
};
export type LocalRuntimeInvocationProbeResult = LocalRuntimeInvocationProbe & {
  status: 'ok' | 'unsupported'; processStatus: 'alive' | 'exited' | 'unknown';
  processInstanceId?: string; requestStatus: 'pending' | 'receiving' | 'ended' | 'unknown';
};

export type LocalRuntimeClientMessage =
  | { kind: 'local_runtime.invocation.probe.result'; payload: LocalRuntimeInvocationProbeResult }
  | { kind: 'local_runtime.hello'; payload: LocalRuntimeHello }
  | { kind: 'local_runtime.heartbeat'; payload: { deviceId: UUID; sentAt: ISODateTime } }
  | { kind: 'local_runtime.workspace.register'; payload: LocalRuntimeWorkspaceRegistration }
  | { kind: 'local_runtime.workspace.unregister'; payload: { workspaceId: UUID } }
  | {
      kind: 'local_runtime.workspace.authorization.prompted';
      payload: { requestId: UUID; promptedAt: ISODateTime };
    }
  | { kind: 'local_runtime.workspace.authorization.result'; payload: LocalRuntimeWorkspaceAuthorizationResult }
  | { kind: 'local_runtime.workspace.permission.grant.result'; payload: LocalRuntimeWorkspacePermissionGrantResult }
  | { kind: 'local_runtime.capabilities.result'; payload: LocalRuntimeCapabilityRefreshResult }
  | { kind: 'local_runtime.provider_connection.result'; payload: LocalRuntimeProviderConnectionResult }
  | { kind: 'local_runtime.github.authorization.result'; payload: LocalGitHubAuthorizationResult }
  | { kind: 'local_runtime.github.source.result'; payload: LocalGitHubSourceResult }
  | { kind: 'local_runtime.github.delivery.result'; payload: LocalGitHubDeliveryResult }
  | { kind: 'local_runtime.workspace.operation.result'; payload: import('./contracts.js').WorkspaceOperationResult }
  | { kind: 'local_runtime.invocation.event'; payload: AgentRuntimeEvent }
  | { kind: 'local_runtime.invocation.result'; payload: LocalRuntimeInvocationResult }
  | { kind: 'local_runtime.invocation.stopped'; payload: LocalRuntimeStopReceipt };

export type LocalRuntimeServerMessage =
  | { kind: 'local_runtime.invocation.probe'; payload: LocalRuntimeInvocationProbe }
  | {
      kind: 'local_runtime.connected';
      payload: { deviceId: UUID; compatibility: LocalRuntimeCompatibility; connectedAt: ISODateTime; stopReceiptProtocol?: 1 };
    }
  | { kind: 'local_runtime.invocation.stop_ack'; payload: { invocationId: UUID } }
  | { kind: 'local_runtime.workspace.registered'; payload: LocalRuntimeWorkspaceRegistration }
  | { kind: 'local_runtime.workspace.registration_rejected'; payload: { workspaceId: UUID; code: string; message: string } }
  | { kind: 'local_runtime.workspace.authorization.request'; payload: LocalRuntimeWorkspaceAuthorizationRequest }
  | { kind: 'local_runtime.workspace.authorization.cancel'; payload: { requestId: UUID } }
  | { kind: 'local_runtime.workspace.permission.grant.request'; payload: LocalRuntimeWorkspacePermissionGrantRequest }
  | { kind: 'local_runtime.capabilities.request'; payload: { requestId: UUID } }
  | { kind: 'local_runtime.provider_connection.upsert'; payload: LocalRuntimeProviderConnectionUpsertRequest }
  | { kind: 'local_runtime.provider_connection.delete'; payload: LocalRuntimeProviderConnectionDeleteRequest }
  | { kind: 'local_runtime.github.authorization.request'; payload: LocalGitHubAuthorizationRequest }
  | { kind: 'local_runtime.github.source.request'; payload: LocalGitHubSourceRequest }
  | { kind: 'local_runtime.github.delivery.request'; payload: LocalGitHubDeliveryRequest }
  | { kind: 'local_runtime.workspace.operation.request'; payload: LocalRuntimeWorkspaceOperationRequest }
  | { kind: 'local_runtime.invocation.start'; payload: LocalRuntimeInvocationRequest }
  | {
      kind: 'local_runtime.invocation.cancel';
      payload: { invocationId: UUID; termination?: ExecutionTermination };
    }
  | { kind: 'local_runtime.protocol.error'; payload: LocalRuntimeProtocolError };

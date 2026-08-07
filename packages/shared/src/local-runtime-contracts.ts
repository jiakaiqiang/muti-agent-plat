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

export const LOCAL_RUNTIME_PROTOCOL_VERSION = 7 as const;

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
  reason?: string;
  upgradeRequired?: boolean;
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

export type LocalRuntimeClientMessage =
  | { kind: 'local_runtime.hello'; payload: LocalRuntimeHello }
  | { kind: 'local_runtime.heartbeat'; payload: { deviceId: UUID; sentAt: ISODateTime } }
  | { kind: 'local_runtime.workspace.register'; payload: LocalRuntimeWorkspaceRegistration }
  | { kind: 'local_runtime.workspace.unregister'; payload: { workspaceId: UUID } }
  | { kind: 'local_runtime.workspace.authorization.result'; payload: LocalRuntimeWorkspaceAuthorizationResult }
  | { kind: 'local_runtime.workspace.permission.grant.result'; payload: LocalRuntimeWorkspacePermissionGrantResult }
  | { kind: 'local_runtime.capabilities.result'; payload: LocalRuntimeCapabilityRefreshResult }
  | { kind: 'local_runtime.provider_connection.result'; payload: LocalRuntimeProviderConnectionResult }
  | { kind: 'local_runtime.workspace.operation.result'; payload: import('./contracts.js').WorkspaceOperationResult }
  | { kind: 'local_runtime.invocation.event'; payload: AgentRuntimeEvent }
  | { kind: 'local_runtime.invocation.result'; payload: LocalRuntimeInvocationResult };

export type LocalRuntimeServerMessage =
  | {
      kind: 'local_runtime.connected';
      payload: { deviceId: UUID; compatibility: LocalRuntimeCompatibility; connectedAt: ISODateTime };
    }
  | { kind: 'local_runtime.workspace.registered'; payload: LocalRuntimeWorkspaceRegistration }
  | { kind: 'local_runtime.workspace.registration_rejected'; payload: { workspaceId: UUID; code: string; message: string } }
  | { kind: 'local_runtime.workspace.authorization.request'; payload: LocalRuntimeWorkspaceAuthorizationRequest }
  | { kind: 'local_runtime.workspace.authorization.cancel'; payload: { requestId: UUID } }
  | { kind: 'local_runtime.workspace.permission.grant.request'; payload: LocalRuntimeWorkspacePermissionGrantRequest }
  | { kind: 'local_runtime.capabilities.request'; payload: { requestId: UUID } }
  | { kind: 'local_runtime.provider_connection.upsert'; payload: LocalRuntimeProviderConnectionUpsertRequest }
  | { kind: 'local_runtime.provider_connection.delete'; payload: LocalRuntimeProviderConnectionDeleteRequest }
  | { kind: 'local_runtime.workspace.operation.request'; payload: LocalRuntimeWorkspaceOperationRequest }
  | { kind: 'local_runtime.invocation.start'; payload: LocalRuntimeInvocationRequest }
  | {
      kind: 'local_runtime.invocation.cancel';
      payload: { invocationId: UUID; termination?: ExecutionTermination };
    }
  | { kind: 'local_runtime.protocol.error'; payload: { code: string; message: string } };

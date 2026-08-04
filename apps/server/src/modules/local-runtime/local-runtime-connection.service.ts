import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  Optional,
  RequestTimeoutException,
  ServiceUnavailableException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type {
  AgentRunResult,
  AgentRuntimeEvent,
  AgentRuntimeRunHandle,
  ExecutionTermination,
  InvocationPlan,
  LocalRuntimeClientMessage,
  LocalRuntimeHello,
  LocalRuntimePermission,
  LocalRuntimePermissionPolicy,
  LocalRuntimeProviderConnectionInput,
  LocalRuntimeProviderConnectionResult,
  LocalRuntimeProviderConnectionSummary,
  LocalRuntimeWorkspaceAuthorizationResult,
  LocalRuntimeWorkspacePermissionGrantResult,
  LocalRuntimeWorkspaceOperationRequest,
  LocalRuntimeServerMessage,
  LocalRuntimeWorkspaceRegistration,
  LocalRuntimeWorkspaceSummary,
  RuntimeType,
  WorkspaceCapabilityKey
} from '@agent-cluster/shared';
import { createAgentMessageOutput } from '@agent-cluster/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { Subject } from 'rxjs';
import { createExecutionTermination } from '../../common/execution-termination.js';
import { nowIso } from '../../common/time.js';
import { workspaceMetrics } from '../../common/workspace-metrics.js';
import { BrokerGateway, type BrokerClient } from '../workspaces/runtime-broker/broker-gateway.js';
import { HeartbeatTracker } from '../workspaces/runtime-broker/heartbeat-tracker.js';
import { PendingRequestRegistry } from '../workspaces/runtime-broker/pending-request-registry.js';
import { LocalRuntimeAuthService } from './local-runtime-auth.service.js';
import { PersistenceService } from '../persistence/persistence.service.js';

type LocalRuntimeClient = {
  clientId: string;
  deviceId: string;
  ownerId: string;
  socket: WebSocket;
  brokerClient: BrokerClient;
  hello?: LocalRuntimeHello;
  connectedAt: string;
};

type LocalRuntimeOperationAudit = {
  requestId: string;
  invocationId: string;
  ownerId: string;
  workspaceId: string;
  operation: string;
  revisionId: string;
  status: 'pending' | 'ok' | 'error';
  requestedAt: string;
  completedAt?: string;
  errorCode?: string;
};

const OPERATION_AUDIT_COLLECTION = 'localRuntimeOperationAudits';

type ActiveInvocation = {
  invocationId: string;
  deviceId: string;
  workspaceId: string;
  runtimeType: RuntimeType;
  sessionId: string;
  queue: RuntimeEventQueue;
  resolve: (result: AgentRunResult) => void;
};

type PendingWorkspaceAuthorization = {
  deviceId: string;
  resolve: (workspace: LocalRuntimeWorkspaceSummary) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingWorkspacePermissionGrant = {
  deviceId: string;
  workspaceId: string;
  permission: LocalRuntimePermission;
  resolve: (workspace: LocalRuntimeWorkspaceSummary) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingProviderConnection = {
  deviceId: string;
  resolve: (connection: LocalRuntimeProviderConnectionSummary) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type LocalRuntimeCandidate = {
  runtimeType: RuntimeType;
  available: true;
  supportedWorkspaceCapabilities: readonly WorkspaceCapabilityKey[];
  supportedWorkspaceProviderKinds: readonly ['local_bridge'];
  supportedToolNames: readonly string[];
};

@Injectable()
export class LocalRuntimeConnectionService {
  private readonly logger = new Logger(LocalRuntimeConnectionService.name);
  private readonly clientsByDeviceId = new Map<string, LocalRuntimeClient>();
  private readonly workspaces = new Map<
    string,
    LocalRuntimeWorkspaceRegistration & { deviceId: string; connectedAt: string }
  >();
  private readonly activeInvocations = new Map<string, ActiveInvocation>();
  private readonly pendingWorkspaceAuthorizations = new Map<string, PendingWorkspaceAuthorization>();
  private readonly pendingWorkspacePermissionGrants = new Map<string, PendingWorkspacePermissionGrant>();
  private readonly pendingProviderConnections = new Map<string, PendingProviderConnection>();
  private readonly operationAudits: LocalRuntimeOperationAudit[];
  private readonly interruptionSubject = new Subject<{
    sessionId: string;
    invocationId: string;
    workspaceId: string;
    reason: 'local_runtime_disconnected';
    occurredAt: string;
  }>();
  private attached = false;

  constructor(
    private readonly auth: LocalRuntimeAuthService,
    private readonly gateway: BrokerGateway,
    private readonly pendingWorkspaceRequests: PendingRequestRegistry,
    private readonly heartbeats: HeartbeatTracker,
    @Optional() private readonly persistence?: PersistenceService
  ) {
    this.operationAudits = persistence?.getCollection<LocalRuntimeOperationAudit[]>(OPERATION_AUDIT_COLLECTION, []) ?? [];
  }

  attach(server: Server): void {
    if (this.attached) return;
    this.attached = true;
    const webSocketServer = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== '/local-runtime') return;
      try {
        const accessToken = bearerToken(request.headers.authorization) || url.searchParams.get('accessToken') || '';
        const device = this.auth.authenticate(accessToken);
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          this.attachClient(webSocket, device.deviceId, device.ownerId);
        });
      } catch (error) {
        rejectUpgrade(socket, 401, error instanceof Error ? error.message : String(error));
      }
    });
  }

  listWorkspaces(): LocalRuntimeWorkspaceSummary[] {
    return [...this.workspaces.values()].map((workspace) => {
      const client = this.clientsByDeviceId.get(workspace.deviceId);
      const runtimeTypes = Object.keys(client?.hello?.runtimes ?? {}).filter(isRuntimeType);
      return structuredClone({ ...workspace, runtimeTypes });
    });
  }

  authorizeWorkspace(deviceId?: string): Promise<LocalRuntimeWorkspaceSummary> {
    const connectedClients = [...this.clientsByDeviceId.values()]
      .filter((client) => client.hello && client.socket.readyState === WebSocket.OPEN)
      .sort((left, right) => right.connectedAt.localeCompare(left.connectedAt));
    const client = deviceId
      ? connectedClients.find((candidate) => candidate.deviceId === deviceId)
      : connectedClients[0];
    if (!client) {
      throw new ServiceUnavailableException('Local Runtime 未连接，请先启动本机 Runtime。');
    }
    if ([...this.pendingWorkspaceAuthorizations.values()].some((pending) => pending.deviceId === client.deviceId)) {
      throw new ConflictException('本机 Runtime 正在等待目录选择，请先处理已打开的系统目录选择窗口，或等待当前请求超时后重试。');
    }

    const requestId = randomUUID();
    return new Promise<LocalRuntimeWorkspaceSummary>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingWorkspaceAuthorizations.delete(requestId);
        reject(new RequestTimeoutException('等待本机目录选择超时，请重试。'));
      }, 120_000);
      this.pendingWorkspaceAuthorizations.set(requestId, {
        deviceId: client.deviceId,
        resolve,
        reject,
        timer
      });
      this.send(client, {
        kind: 'local_runtime.workspace.authorization.request',
        payload: { requestId, title: '选择 Agent Runtime 授权工作目录' }
      });
    });
  }

  grantWorkspacePermissionOnce(
    workspaceId: string,
    permission: LocalRuntimePermission
  ): Promise<LocalRuntimeWorkspaceSummary> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new ServiceUnavailableException('Local Runtime 工作区未连接。');
    const client = this.clientsByDeviceId.get(workspace.deviceId);
    if (!client?.hello || client.socket.readyState !== WebSocket.OPEN) {
      throw new ServiceUnavailableException('Local Runtime CLI 未连接。');
    }
    const requestId = randomUUID();
    return new Promise<LocalRuntimeWorkspaceSummary>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingWorkspacePermissionGrants.delete(requestId);
        reject(new RequestTimeoutException('等待本机危险动作授权超时，请重试。'));
      }, 120_000);
      this.pendingWorkspacePermissionGrants.set(requestId, {
        deviceId: client.deviceId,
        workspaceId,
        permission,
        resolve,
        reject,
        timer
      });
      this.send(client, {
        kind: 'local_runtime.workspace.permission.grant.request',
        payload: { requestId, workspaceId, permission, scope: 'once' }
      });
    });
  }

  getWorkspace(workspaceId: string) {
    const workspace = this.workspaces.get(workspaceId);
    return workspace ? structuredClone(workspace) : undefined;
  }

  isDeviceConnected(deviceId: string) {
    return this.clientsByDeviceId.get(deviceId)?.socket.readyState === WebSocket.OPEN;
  }

  upsertProviderConnection(deviceId: string, connection: LocalRuntimeProviderConnectionInput): Promise<LocalRuntimeProviderConnectionSummary> {
    const client = this.clientsByDeviceId.get(deviceId);
    if (!client?.hello || client.socket.readyState !== WebSocket.OPEN) {
      throw new ServiceUnavailableException('Local Runtime CLI is not connected.');
    }
    if (!connection.connectionId || !connection.apiKey?.trim() || !connection.baseUrl?.trim() || !connection.model?.trim()) {
      throw new BadRequestException('Local provider connection is incomplete.');
    }
    if (!['openai-compatible', 'anthropic-compatible'].includes(connection.provider)) {
      throw new BadRequestException('Unsupported local provider protocol.');
    }
    const requestId = randomUUID();
    return new Promise<LocalRuntimeProviderConnectionSummary>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingProviderConnections.delete(requestId);
        reject(new RequestTimeoutException('Timed out while Local Runtime stored the provider credential.'));
      }, 30_000);
      this.pendingProviderConnections.set(requestId, { deviceId, resolve, reject, timer });
      this.send(client, {
        kind: 'local_runtime.provider_connection.upsert',
        payload: { requestId, connection }
      });
    });
  }

  deleteProviderConnection(deviceId: string, connectionId: string): Promise<void> {
    const client = this.clientsByDeviceId.get(deviceId);
    if (!client?.hello || client.socket.readyState !== WebSocket.OPEN) {
      throw new ServiceUnavailableException('Local Runtime CLI is not connected.');
    }
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingProviderConnections.delete(requestId);
        reject(new RequestTimeoutException('Timed out while Local Runtime removed the provider credential.'));
      }, 30_000);
      this.pendingProviderConnections.set(requestId, {
        deviceId,
        resolve: () => resolve(),
        reject,
        timer
      });
      this.send(client, { kind: 'local_runtime.provider_connection.delete', payload: { requestId, connectionId } });
    });
  }

  interruptions() {
    return this.interruptionSubject.asObservable();
  }

  listOperationAudits() {
    return structuredClone(this.operationAudits);
  }

  disconnectDevice(deviceId: string, reason: string) {
    const client = this.clientsByDeviceId.get(deviceId);
    client?.socket.close(4001, reason.slice(0, 120));
  }

  listRuntimeCandidates(workspaceId: string): LocalRuntimeCandidate[] {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return [];
    const client = this.clientsByDeviceId.get(workspace.deviceId);
    if (!client?.hello || client.socket.readyState !== WebSocket.OPEN) return [];
    const capabilities = (['read', 'write', 'command', 'test'] as const).filter(
      (key) => workspace.capabilities[key]
    );
    return Object.keys(client.hello.runtimes)
      .filter(isRuntimeType)
      .map((runtimeType) => ({
        runtimeType,
        available: true as const,
        supportedWorkspaceCapabilities: capabilities,
        supportedWorkspaceProviderKinds: ['local_bridge'] as const,
        supportedToolNames: toolNamesFor(capabilities)
      }));
  }

  startInvocation(plan: InvocationPlan): AgentRuntimeRunHandle {
    const workspaceId = plan.contextEnvelope.L0.workspace.workspaceId;
    this.assertLocalPlan(plan, workspaceId);
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return settledHandle(this.failedResult(plan, 'LOCAL_RUNTIME_WORKSPACE_OFFLINE', 'Local Runtime workspace is not connected.'));
    const client = this.clientsByDeviceId.get(workspace.deviceId);
    if (!client?.hello || client.socket.readyState !== WebSocket.OPEN) {
      return settledHandle(this.failedResult(plan, 'LOCAL_RUNTIME_OFFLINE', 'Local Runtime CLI is not connected.'));
    }
    if (!client.hello.runtimes[plan.executionTarget.runtimeType]) {
      return settledHandle(this.failedResult(plan, 'LOCAL_RUNTIME_UNAVAILABLE', `Runtime ${plan.executionTarget.runtimeType} is unavailable on the connected device.`));
    }
    if (this.activeInvocations.has(plan.invocationId)) {
      return settledHandle(this.failedResult(plan, 'LOCAL_RUNTIME_DUPLICATE_INVOCATION', 'Invocation id is already active.'));
    }

    const queue = new RuntimeEventQueue();
    let resolveResult!: (result: AgentRunResult) => void;
    const result = new Promise<AgentRunResult>((resolve) => {
      resolveResult = resolve;
    });
    this.activeInvocations.set(plan.invocationId, {
      invocationId: plan.invocationId,
      deviceId: workspace.deviceId,
      workspaceId,
      runtimeType: plan.executionTarget.runtimeType,
      sessionId: plan.sessionId,
      queue,
      resolve: resolveResult
    });
    this.send(client, {
      kind: 'local_runtime.invocation.start',
      payload: {
        plan,
        workspaceId,
        workspaceRevision: workspace.revision,
        permissions: workspace.permissions
      }
    });
    return {
      events: queue,
      result,
      cancel: async (termination) => {
        const resolvedTermination = termination ?? createExecutionTermination({
          kind: 'user_cancelled',
          source: 'user',
          scope: 'invocation',
          phase: plan.phase
        });
        this.send(client, {
          kind: 'local_runtime.invocation.cancel',
          payload: { invocationId: plan.invocationId, termination: resolvedTermination }
        });
        this.finishInvocation(
          plan.invocationId,
          this.cancelledResult(plan, resolvedTermination, 'Local Runtime invocation was cancelled.')
        );
      }
    };
  }

  private attachClient(socket: WebSocket, deviceId: string, ownerId: string) {
    const previousClient = this.clientsByDeviceId.get(deviceId);
    if (previousClient) {
      this.detachClient(previousClient);
      previousClient.socket.close(4001, 'superseded_connection');
    }
    const clientId = `local-runtime:${deviceId}:${randomUUID()}`;
    const client: LocalRuntimeClient = {
      clientId,
      deviceId,
      ownerId,
      socket,
      connectedAt: nowIso(),
      brokerClient: {
        clientId,
        send: (payload) => {
          const message = payload as { kind?: string; payload?: unknown };
          if (message.kind === 'workspace.operation.request') {
            const request = message.payload as import('@agent-cluster/shared').WorkspaceOperationRequest;
            const workspace = this.workspaces.get(request.workspaceId);
            if (!workspace || workspace.deviceId !== client.deviceId) {
              throw new Error('Local Runtime workspace operation does not belong to this device.');
            }
            const payload: LocalRuntimeWorkspaceOperationRequest = {
              ...request,
              ownerId: client.ownerId,
              workspaceRevision: workspace.revision,
              permissions: workspace.permissions
            };
            this.recordOperationRequest(payload);
            this.send(client, {
              kind: 'local_runtime.workspace.operation.request',
              payload
            });
          }
        }
      }
    };
    this.clientsByDeviceId.set(deviceId, client);
    this.gateway.attachClient(client.brokerClient);
    socket.on('message', (data) => {
      try {
        this.handleMessage(client, JSON.parse(data.toString()) as LocalRuntimeClientMessage);
      } catch (error) {
        this.send(client, {
          kind: 'local_runtime.protocol.error',
          payload: { code: 'LOCAL_RUNTIME_PROTOCOL_ERROR', message: error instanceof Error ? error.message : String(error) }
        });
      }
    });
    socket.on('close', () => this.detachClient(client));
    socket.on('error', (error) => this.logger.warn(`Local Runtime socket error for ${deviceId}: ${error.message}`));
  }

  private handleMessage(client: LocalRuntimeClient, message: LocalRuntimeClientMessage) {
    if (message.kind === 'local_runtime.hello') {
      if (message.payload.deviceId !== client.deviceId) throw new Error('Authenticated device does not match hello deviceId.');
      const device = this.auth.touch(client.deviceId, message.payload);
      client.hello = structuredClone(message.payload);
      this.send(client, {
        kind: 'local_runtime.connected',
        payload: {
          deviceId: client.deviceId,
          compatibility: this.auth.compatibility(device.cliVersion, device.protocolVersion),
          connectedAt: client.connectedAt
        }
      });
      return;
    }
    if (!client.hello) throw new Error('local_runtime.hello must be the first message.');
    if (message.kind === 'local_runtime.heartbeat') {
      if (message.payload.deviceId !== client.deviceId) throw new Error('Heartbeat deviceId mismatch.');
      this.auth.touch(client.deviceId);
      for (const workspace of this.workspaces.values()) {
        if (workspace.deviceId === client.deviceId) this.heartbeats.record(workspace.workspaceId);
      }
      return;
    }
    if (message.kind === 'local_runtime.workspace.register') {
      this.registerWorkspace(client, message.payload);
      return;
    }
    if (message.kind === 'local_runtime.workspace.unregister') {
      this.unregisterWorkspace(client, message.payload.workspaceId, 'local workspace unregistered');
      return;
    }
    if (message.kind === 'local_runtime.workspace.authorization.result') {
      this.finishWorkspaceAuthorization(client, message.payload);
      return;
    }
    if (message.kind === 'local_runtime.workspace.permission.grant.result') {
      this.finishWorkspacePermissionGrant(client, message.payload);
      return;
    }
    if (message.kind === 'local_runtime.provider_connection.result') {
      this.finishProviderConnection(client, message.payload);
      return;
    }
    if (message.kind === 'local_runtime.workspace.operation.result') {
      const workspace = this.workspaces.get(message.payload.workspaceId);
      if (!workspace || workspace.deviceId !== client.deviceId) throw new Error('Workspace result does not belong to this device.');
      this.recordOperationResult(message.payload);
      if (message.payload.status === 'ok') {
        const revision = workspaceRevisionFromOperationData(message.payload.data);
        if (revision?.id) workspace.revision = structuredClone(revision);
      }
      if (!this.pendingWorkspaceRequests.settle(message.payload)) {
        this.logger.warn(`Ignored unmatched Local Runtime workspace result: ${message.payload.requestId}`);
      }
      return;
    }
    if (message.kind === 'local_runtime.invocation.event') {
      const active = this.activeInvocations.get(message.payload.invocationId);
      if (!active || active.deviceId !== client.deviceId) throw new Error('Invocation event does not belong to this device.');
      active.queue.push(message.payload);
      return;
    }
    if (message.kind === 'local_runtime.invocation.result') {
      const { result, workspaceId, workspaceRevision } = message.payload;
      const active = this.activeInvocations.get(result.invocationId);
      if (!active || active.deviceId !== client.deviceId) throw new Error('Invocation result does not belong to this device.');
      if (workspaceId !== active.workspaceId) throw new Error('Invocation result workspace does not match the active invocation.');
      if (result.runtimeType !== active.runtimeType) throw new Error('Invocation result runtime type mismatch.');
      if (!workspaceRevision?.id || !workspaceRevision.observedAt) throw new Error('Invocation result workspace revision is incomplete.');
      const workspace = this.workspaces.get(workspaceId);
      if (!workspace || workspace.deviceId !== client.deviceId) throw new Error('Invocation result workspace does not belong to this device.');
      workspace.revision = structuredClone(workspaceRevision);
      this.finishInvocation(result.invocationId, result);
      return;
    }
    throw new Error('Unsupported Local Runtime message.');
  }

  private registerWorkspace(client: LocalRuntimeClient, registration: LocalRuntimeWorkspaceRegistration) {
    if (!registration.workspaceId || !registration.displayName || !registration.revision?.id) {
      throw new Error('Local Runtime workspace registration is incomplete.');
    }
    const permissionKeys = [
      'workspace_read',
      'workspace_write',
      'workspace_delete',
      'command_execute',
      'test_execute',
      'dependency_install'
    ] as const;
    if (permissionKeys.some((key) => !['allow', 'confirm', 'deny'].includes(registration.permissions?.[key]))) {
      throw new Error('Local Runtime workspace permission policy is invalid.');
    }
    const expectedCapabilities = {
      read: registration.permissions.workspace_read === 'allow',
      write: registration.permissions.workspace_write === 'allow',
      command: registration.permissions.command_execute === 'allow',
      test: registration.permissions.test_execute === 'allow'
    };
    if ((Object.keys(expectedCapabilities) as Array<keyof typeof expectedCapabilities>).some(
      (key) => registration.capabilities[key] !== expectedCapabilities[key]
    )) {
      throw new Error('Local Runtime workspace capabilities do not match the local permission policy.');
    }
    const existing = this.workspaces.get(registration.workspaceId);
    if (existing && existing.deviceId !== client.deviceId) {
      this.send(client, {
        kind: 'local_runtime.workspace.registration_rejected',
        payload: {
          workspaceId: registration.workspaceId,
          code: 'WORKSPACE_ID_CONFLICT',
          message: 'workspaceId is already registered by another device.'
        }
      });
      return;
    }
    const gatewayRegistration = {
      clientId: client.clientId,
      workspaceId: registration.workspaceId,
      providerKind: 'local_bridge',
      capabilities: registration.capabilities,
      displayName: registration.displayName
    } as const;
    if (existing) this.gateway.refreshWorkspace(client.brokerClient, gatewayRegistration);
    else this.gateway.registerWorkspace(client.brokerClient, gatewayRegistration);
    this.workspaces.set(registration.workspaceId, {
      ...structuredClone(registration),
      deviceId: client.deviceId,
      connectedAt: existing?.connectedAt ?? nowIso()
    });
    this.heartbeats.record(registration.workspaceId);
    if (registration.index) {
      workspaceMetrics.increment('workspace_index_status_total', 1, {
        providerKind: 'local_bridge',
        status: registration.index.status
      });
      workspaceMetrics.set('workspace_index_entries_total', registration.index.indexedEntries, {
        providerKind: 'local_bridge'
      });
    }
    this.send(client, { kind: 'local_runtime.workspace.registered', payload: registration });
  }

  private finishWorkspaceAuthorization(
    client: LocalRuntimeClient,
    result: LocalRuntimeWorkspaceAuthorizationResult
  ) {
    const pending = this.pendingWorkspaceAuthorizations.get(result.requestId);
    if (!pending) {
      this.logger.warn(`Ignored unmatched Local Runtime workspace authorization: ${result.requestId}`);
      return;
    }
    if (pending.deviceId !== client.deviceId) {
      throw new Error('Workspace authorization result does not belong to this device.');
    }
    clearTimeout(pending.timer);
    this.pendingWorkspaceAuthorizations.delete(result.requestId);

    if (result.status === 'cancelled') {
      pending.reject(new BadRequestException('已取消选择本机工作目录。'));
      return;
    }
    if (result.status === 'error' || !result.workspace) {
      pending.reject(new BadRequestException(result.error?.message ?? '本机工作目录授权失败。'));
      return;
    }

    this.registerWorkspace(client, result.workspace);
    const workspace = this.listWorkspaces().find(
      (candidate) => candidate.workspaceId === result.workspace?.workspaceId && candidate.deviceId === client.deviceId
    );
    if (!workspace) {
      pending.reject(new BadRequestException('本机工作目录注册失败。'));
      return;
    }
    pending.resolve(workspace);
  }

  private finishWorkspacePermissionGrant(
    client: LocalRuntimeClient,
    result: LocalRuntimeWorkspacePermissionGrantResult
  ) {
    const pending = this.pendingWorkspacePermissionGrants.get(result.requestId);
    if (!pending) {
      this.logger.warn(`Ignored unmatched Local Runtime permission grant: ${result.requestId}`);
      return;
    }
    if (
      pending.deviceId !== client.deviceId ||
      pending.workspaceId !== result.workspaceId ||
      pending.permission !== result.permission
    ) {
      throw new Error('Workspace permission grant result does not match the pending request.');
    }
    clearTimeout(pending.timer);
    this.pendingWorkspacePermissionGrants.delete(result.requestId);
    if (result.status === 'error' || !result.workspace) {
      pending.reject(new BadRequestException(result.error?.message ?? '本机危险动作授权失败。'));
      return;
    }
    this.registerWorkspace(client, result.workspace);
    const workspace = this.listWorkspaces().find(
      (candidate) => candidate.workspaceId === result.workspace?.workspaceId && candidate.deviceId === client.deviceId
    );
    if (!workspace) {
      pending.reject(new BadRequestException('本机危险动作授权后工作区注册失败。'));
      return;
    }
    pending.resolve(workspace);
  }

  private finishProviderConnection(client: LocalRuntimeClient, result: LocalRuntimeProviderConnectionResult) {
    const pending = this.pendingProviderConnections.get(result.requestId);
    if (!pending) {
      this.logger.warn(`Ignored unmatched Local Runtime provider connection result: ${result.requestId}`);
      return;
    }
    if (pending.deviceId !== client.deviceId) throw new Error('Provider connection result does not belong to this device.');
    clearTimeout(pending.timer);
    this.pendingProviderConnections.delete(result.requestId);
    if (result.status === 'error' || !result.connection) {
      pending.reject(new BadRequestException(result.error?.message ?? 'Local Runtime could not store the provider credential.'));
      return;
    }
    pending.resolve(result.connection);
  }

  private recordOperationRequest(request: LocalRuntimeWorkspaceOperationRequest) {
    this.operationAudits.push({
      requestId: request.requestId,
      invocationId: request.invocationId,
      ownerId: request.ownerId,
      workspaceId: request.workspaceId,
      operation: request.operation,
      revisionId: request.workspaceRevision.id,
      status: 'pending',
      requestedAt: nowIso()
    });
    this.trimAndPersistOperationAudits();
  }

  private recordOperationResult(result: import('@agent-cluster/shared').WorkspaceOperationResult) {
    const audit = [...this.operationAudits].reverse().find((item) => item.requestId === result.requestId);
    if (!audit) return;
    audit.status = result.status === 'ok' ? 'ok' : 'error';
    audit.completedAt = nowIso();
    if (result.error?.code) audit.errorCode = result.error.code;
    this.trimAndPersistOperationAudits();
  }

  private trimAndPersistOperationAudits() {
    if (this.operationAudits.length > 5_000) this.operationAudits.splice(0, this.operationAudits.length - 5_000);
    void this.persistence?.setCollection(OPERATION_AUDIT_COLLECTION, this.operationAudits);
  }

  private unregisterWorkspace(client: LocalRuntimeClient, workspaceId: string, reason: string) {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || workspace.deviceId !== client.deviceId) return;
    this.workspaces.delete(workspaceId);
    this.gateway.unregisterWorkspace(client.clientId, workspaceId);
    this.heartbeats.drop(workspaceId);
    this.pendingWorkspaceRequests.rejectByWorkspace(workspaceId, new Error(reason));
    this.interruptInvocations(client.deviceId, reason, workspaceId);
  }

  private detachClient(client: LocalRuntimeClient) {
    if (this.clientsByDeviceId.get(client.deviceId) !== client) return;
    this.clientsByDeviceId.delete(client.deviceId);
    for (const [requestId, pending] of this.pendingWorkspaceAuthorizations) {
      if (pending.deviceId !== client.deviceId) continue;
      clearTimeout(pending.timer);
      pending.reject(new ServiceUnavailableException('Local Runtime 已断开，目录授权未完成。'));
      this.pendingWorkspaceAuthorizations.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingWorkspacePermissionGrants) {
      if (pending.deviceId !== client.deviceId) continue;
      clearTimeout(pending.timer);
      pending.reject(new ServiceUnavailableException('Local Runtime 已断开，危险动作授权未完成。'));
      this.pendingWorkspacePermissionGrants.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingProviderConnections) {
      if (pending.deviceId !== client.deviceId) continue;
      clearTimeout(pending.timer);
      pending.reject(new ServiceUnavailableException('Local Runtime disconnected before storing the provider credential.'));
      this.pendingProviderConnections.delete(requestId);
    }
    const workspaceIds = [...this.workspaces.values()]
      .filter((workspace) => workspace.deviceId === client.deviceId)
      .map((workspace) => workspace.workspaceId);
    for (const workspaceId of workspaceIds) this.unregisterWorkspace(client, workspaceId, 'local runtime disconnected');
    this.gateway.detachClient(client.clientId);
    this.interruptInvocations(client.deviceId, 'Local Runtime CLI disconnected.');
  }

  private interruptInvocations(deviceId: string, message: string, workspaceId?: string) {
    for (const active of [...this.activeInvocations.values()]) {
      if (active.deviceId !== deviceId || (workspaceId && active.workspaceId !== workspaceId)) continue;
      const termination = createExecutionTermination({
        kind: 'runtime_disconnected',
        source: 'runtime',
        scope: 'invocation',
        diagnosticRef: 'local_runtime_disconnected'
      });
      this.interruptionSubject.next({
        sessionId: active.sessionId,
        invocationId: active.invocationId,
        workspaceId: active.workspaceId,
        reason: 'local_runtime_disconnected',
        occurredAt: termination.occurredAt
      });
      this.finishInvocation(
        active.invocationId,
        this.cancelledResultForActive(active, termination, message)
      );
    }
  }

  private finishInvocation(invocationId: string, result: AgentRunResult) {
    const active = this.activeInvocations.get(invocationId);
    if (!active) return;
    this.activeInvocations.delete(invocationId);
    active.queue.close();
    active.resolve(result);
  }

  private assertLocalPlan(plan: InvocationPlan, workspaceId: string) {
    if (
      plan.executionTarget.executionLocation !== 'local' ||
      plan.executionTarget.workspaceProviderKind !== 'local_bridge' ||
      plan.contextEnvelope.L0.workspace.providerKind !== 'local_bridge' ||
      !workspaceId
    ) {
      throw new Error('LOCAL_RUNTIME_ROUTE_MISMATCH: invocation is not bound to a local_bridge workspace.');
    }
  }

  private failedResult(plan: InvocationPlan, code: string, message: string): AgentRunResult {
    return baseResult(plan, 'failed', message, {
      code: 'CAPABILITY_BLOCKED',
      message: `${code}: ${message}`,
      retryable: false,
      details: { localRuntimeCode: code }
    });
  }

  private cancelledResult(plan: InvocationPlan, termination: ExecutionTermination, message: string): AgentRunResult {
    return baseResult(plan, 'cancelled', message, {
      code: 'RUNTIME_CANCELLED',
      message,
      retryable: false,
      termination
    }, termination);
  }

  private cancelledResultForActive(
    active: ActiveInvocation,
    termination: ExecutionTermination,
    message: string
  ): AgentRunResult {
    return {
      invocationId: active.invocationId,
      runtimeType: active.runtimeType,
      status: 'cancelled',
      output: createAgentMessageOutput({ messageKind: 'risk', content: message }),
      events: [],
      artifacts: [],
      systemEvidence: {
        workspaceChangeSet: null,
        verifiedTestResults: [],
        capturedAt: nowIso(),
        invocationId: active.invocationId
      },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: active.runtimeType },
      error: { code: 'RUNTIME_CANCELLED', message, retryable: false, termination },
      termination
    };
  }

  private send(client: LocalRuntimeClient, message: LocalRuntimeServerMessage) {
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(message));
  }
}

function baseResult(
  plan: InvocationPlan,
  status: 'failed' | 'cancelled',
  message: string,
  error: AgentRunResult['error'],
  termination?: ExecutionTermination
): AgentRunResult {
  const event: AgentRuntimeEvent = {
    invocationId: plan.invocationId,
    type: 'runtime_failed',
    visibility: 'user',
    content: message,
    metadata: { code: error?.code },
    createdAt: nowIso()
  };
  return {
    invocationId: plan.invocationId,
    runtimeType: plan.executionTarget.runtimeType,
    status,
    output: createAgentMessageOutput({ messageKind: 'risk', content: message }),
    events: [event],
    artifacts: [],
    systemEvidence: {
      workspaceChangeSet: null,
      verifiedTestResults: [],
      capturedAt: nowIso(),
      invocationId: plan.invocationId
    },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: plan.executionTarget.runtimeType },
    ...(error ? { error } : {}),
    ...(termination ? { termination } : {})
  };
}

class RuntimeEventQueue implements AsyncIterable<AgentRuntimeEvent> {
  private readonly values: AgentRuntimeEvent[] = [];
  private readonly waiters: Array<(value: IteratorResult<AgentRuntimeEvent>) => void> = [];
  private closed = false;

  push(event: AgentRuntimeEvent) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else this.values.push(event);
  }

  close() {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()?.({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentRuntimeEvent> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push(resolve));
      }
    };
  }
}

function settledHandle(result: AgentRunResult): AgentRuntimeRunHandle {
  return {
    events: { async *[Symbol.asyncIterator]() {} },
    result: Promise.resolve(result),
    cancel: async () => {}
  };
}

function bearerToken(value: string | undefined) {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function rejectUpgrade(socket: Duplex, status: number, message: string) {
  const body = JSON.stringify({ error: message });
  socket.end(
    `HTTP/1.1 ${status} Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
  );
}

function isRuntimeType(value: string): value is RuntimeType {
  return ['mock', 'generic_llm', 'code_reader', 'test_runner', 'codex', 'claude_code', 'mcp_tool', 'human'].includes(value);
}

function toolNamesFor(capabilities: readonly WorkspaceCapabilityKey[]) {
  const values = new Set(capabilities);
  return [
    ...(values.has('read') ? ['read_file', 'search_code'] : []),
    ...(values.has('write') ? ['write_file'] : []),
    ...(values.has('test') || values.has('command') ? ['run_test'] : [])
  ];
}

function workspaceRevisionFromOperationData(data: unknown): import('@agent-cluster/shared').WorkspaceRevision | undefined {
  if (!data || typeof data !== 'object') return undefined;
  if ('id' in data && 'observedAt' in data && typeof data.id === 'string' && typeof data.observedAt === 'string') {
    return { id: data.id, observedAt: data.observedAt };
  }
  if (!('revision' in data)) return undefined;
  const revision = data.revision;
  if (!revision || typeof revision !== 'object') return undefined;
  if (!('id' in revision) || !('observedAt' in revision)) return undefined;
  return typeof revision.id === 'string' && typeof revision.observedAt === 'string'
    ? { id: revision.id, observedAt: revision.observedAt }
    : undefined;
}

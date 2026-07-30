import type {
  LocalRuntimeClientMessage,
  LocalRuntimeDeviceCode,
  LocalRuntimePermission,
  LocalRuntimePermissionPolicy,
  LocalRuntimeProviderConnectionInput,
  LocalRuntimeProviderConnectionSummary,
  LocalRuntimeServerMessage,
  LocalRuntimeTokenPendingResponse,
  LocalRuntimeTokenResponse,
  WorkspaceOperationRequest,
  WorkspaceOperationResult
} from '@agent-cluster/shared';
import { LOCAL_RUNTIME_PROTOCOL_VERSION, runtimeTypesForModelProvider } from '@agent-cluster/shared';
import WebSocket from 'ws';
import { detectAvailableLocalRuntimes } from './adapters/registry.js';
import { executeLocalInvocation } from './runtime.js';
import type { LocalRuntimeState } from './state.js';
import { saveState } from './state.js';
import { createWorkspaceState, LocalWorkspace } from './workspace.js';
import { selectWorkspaceDirectory } from './directory-picker.js';
import { LocalSecretStore } from './local-secret-store.js';

export async function createDeviceCode(state: LocalRuntimeState, cliVersion: string) {
  const runtimes = await detectAvailableLocalRuntimes();
  return apiJson<LocalRuntimeDeviceCode>(state.serverUrl, '/api/local-runtime/device-codes', {
    method: 'POST',
    body: JSON.stringify({
      deviceId: state.deviceId,
      displayName: state.displayName,
      cliVersion,
      protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
      runtimes
    })
  });
}

export async function approveDeviceCode(state: LocalRuntimeState, userCode: string, adminToken?: string) {
  return apiJson(state.serverUrl, '/api/local-runtime/device-codes/approve', {
    method: 'POST',
    headers: adminToken ? { authorization: `Bearer ${adminToken}` } : undefined,
    body: JSON.stringify({ userCode })
  });
}

export async function authorizeLoopbackDevice(state: LocalRuntimeState, cliVersion: string) {
  const runtimes = await detectAvailableLocalRuntimes();
  state.tokens = await apiJson<LocalRuntimeTokenResponse>(
    state.serverUrl,
    '/api/local-runtime/device-tokens/loopback',
    {
      method: 'POST',
      body: JSON.stringify({
        deviceId: state.deviceId,
        displayName: state.displayName,
        cliVersion,
        protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
        runtimes
      })
    }
  );
  await saveState(state);
  return state.tokens;
}

export async function exchangeDeviceCode(state: LocalRuntimeState, deviceCode: string) {
  return apiJson<LocalRuntimeTokenResponse | LocalRuntimeTokenPendingResponse>(
    state.serverUrl,
    '/api/local-runtime/device-tokens',
    { method: 'POST', body: JSON.stringify({ deviceCode }) }
  );
}

export async function fetchDeviceStatus(state: LocalRuntimeState) {
  if (!state.tokens) return [];
  await ensureAccessToken(state);
  const device = await apiJson<Record<string, unknown>>(state.serverUrl, '/api/local-runtime/device-tokens/current', {
    headers: { authorization: `Bearer ${state.tokens.accessToken}` }
  });
  return [device];
}

export async function revokeDevice(state: LocalRuntimeState) {
  await ensureAccessToken(state);
  if (!state.tokens?.accessToken) throw new Error('Device is not authenticated.');
  return apiJson(state.serverUrl, '/api/local-runtime/device-tokens/current', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${state.tokens.accessToken}` }
  });
}

export async function runBridge(state: LocalRuntimeState, cliVersion: string, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      if (state.tokens) await ensureAccessToken(state);
      else await authorizeLoopbackDevice(state, cliVersion);
      await runBridgeConnection(state, cliVersion, signal);
    } catch (error) {
      if (signal.aborted) break;
      if (isAuthorizationFailure(error) && state.tokens) {
        delete state.tokens;
        await saveState(state);
      }
      process.stderr.write(`Local Runtime connection failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    if (!signal.aborted) await abortableDelay(2_000, signal).catch(() => undefined);
  }
}

async function runBridgeConnection(state: LocalRuntimeState, cliVersion: string, signal: AbortSignal) {
  const accessToken = state.tokens?.accessToken;
  if (!accessToken) throw new Error('Local Runtime access token is unavailable.');
  const socketUrl = new URL('/local-runtime', state.serverUrl);
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(socketUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  const active = new Map<string, AbortController>();
  const secrets = new LocalSecretStore();
  const workspaces = new Map(state.workspaces.map((workspace) => [
    workspace.workspaceId,
    new LocalWorkspace(workspace, { onIndexUpdated: () => saveState(state) })
  ]));
  let heartbeat: NodeJS.Timeout | undefined;
  const send = (message: LocalRuntimeClientMessage) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const closeForAbort = () => socket.close(1000, 'local_runtime_stopped');
  signal.addEventListener('abort', closeForAbort, { once: true });

  await new Promise<void>((resolve, reject) => {
    let opened = false;
    socket.on('open', async () => {
      opened = true;
      const runtimes = await detectAvailableLocalRuntimes();
      send({
        kind: 'local_runtime.hello',
        payload: {
          deviceId: state.deviceId,
          cliVersion,
          protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
          runtimes
        }
      });
      for (const workspace of workspaces.values()) {
        send({
          kind: 'local_runtime.workspace.register',
          payload: await workspaceRegistration(workspace)
        });
      }
      heartbeat = setInterval(() => {
        send({
          kind: 'local_runtime.heartbeat',
          payload: { deviceId: state.deviceId, sentAt: new Date().toISOString() }
        });
      }, 15_000);
    });
    socket.on('message', (data) => {
      void handleServerMessage(JSON.parse(data.toString()) as LocalRuntimeServerMessage, state, workspaces, active, secrets, send)
        .catch((error) => process.stderr.write(`Local Runtime request failed: ${error instanceof Error ? error.message : String(error)}\n`));
    });
    socket.on('unexpected-response', (_, response) => reject(new Error(`WebSocket upgrade rejected with HTTP ${response.statusCode}.`)));
    socket.on('error', (error) => { if (!opened) reject(error); });
    socket.on('close', () => {
      if (heartbeat) clearInterval(heartbeat);
      for (const controller of active.values()) controller.abort(new Error('Local Runtime connection closed.'));
      active.clear();
      resolve();
    });
  }).finally(() => {
    signal.removeEventListener('abort', closeForAbort);
    if (heartbeat) clearInterval(heartbeat);
    for (const workspace of workspaces.values()) workspace.close();
  });
}

async function handleServerMessage(
  message: LocalRuntimeServerMessage,
  state: LocalRuntimeState,
  workspaces: Map<string, LocalWorkspace>,
  active: Map<string, AbortController>,
  secrets: LocalSecretStore,
  send: (message: LocalRuntimeClientMessage) => void
) {
  if (message.kind === 'local_runtime.provider_connection.upsert') {
    const { requestId, connection } = message.payload;
    try {
      await secrets.set(connection.connectionId, connection.apiKey);
      const summary: LocalRuntimeProviderConnectionSummary = {
        connectionId: connection.connectionId,
        provider: connection.provider,
        model: connection.model,
        baseUrl: connection.baseUrl,
        deviceId: state.deviceId,
        hasApiKey: true,
        compatibleRuntimeTypes: runtimeTypesForModelProvider(connection.provider),
        updatedAt: new Date().toISOString()
      };
      state.providerConnections = [
        ...state.providerConnections.filter((item) => item.connectionId !== connection.connectionId),
        summary
      ];
      await saveState(state);
      send({ kind: 'local_runtime.provider_connection.result', payload: { requestId, status: 'ok', connection: summary } });
    } catch (error) {
      send({
        kind: 'local_runtime.provider_connection.result',
        payload: {
          requestId,
          status: 'error',
          error: { code: 'LOCAL_CREDENTIAL_STORE_FAILED', message: error instanceof Error ? error.message : String(error) }
        }
      });
    }
    return;
  }
  if (message.kind === 'local_runtime.provider_connection.delete') {
    const { requestId, connectionId } = message.payload;
    try {
      await secrets.delete(connectionId);
      state.providerConnections = state.providerConnections.filter((item) => item.connectionId !== connectionId);
      await saveState(state);
      send({ kind: 'local_runtime.provider_connection.result', payload: { requestId, status: 'ok', connection: deletedConnectionSummary(state.deviceId, connectionId) } });
    } catch (error) {
      send({
        kind: 'local_runtime.provider_connection.result',
        payload: {
          requestId,
          status: 'error',
          error: { code: 'LOCAL_CREDENTIAL_DELETE_FAILED', message: error instanceof Error ? error.message : String(error) }
        }
      });
    }
    return;
  }
  if (message.kind === 'local_runtime.workspace.authorization.request') {
    try {
      const selectedPath = await selectWorkspaceDirectory(message.payload.title);
      if (!selectedPath) {
        send({
          kind: 'local_runtime.workspace.authorization.result',
          payload: { requestId: message.payload.requestId, status: 'cancelled' }
        });
        return;
      }
      let workspaceState = state.workspaces.find(
        (workspace) => workspace.rootPath.toLowerCase() === selectedPath.toLowerCase()
      );
      if (!workspaceState) {
        workspaceState = await createWorkspaceState(selectedPath);
        state.workspaces.push(workspaceState);
        await saveState(state);
      }
      let workspace = workspaces.get(workspaceState.workspaceId);
      if (!workspace) {
        workspace = new LocalWorkspace(workspaceState, { onIndexUpdated: () => saveState(state) });
        workspaces.set(workspaceState.workspaceId, workspace);
      }
      send({
        kind: 'local_runtime.workspace.authorization.result',
        payload: {
          requestId: message.payload.requestId,
          status: 'selected',
          workspace: await workspaceRegistration(workspace)
        }
      });
    } catch (error) {
      send({
        kind: 'local_runtime.workspace.authorization.result',
        payload: {
          requestId: message.payload.requestId,
          status: 'error',
          error: {
            code: 'LOCAL_WORKSPACE_AUTHORIZATION_FAILED',
            message: error instanceof Error ? error.message : String(error)
          }
        }
      });
    }
    return;
  }
  if (message.kind === 'local_runtime.workspace.permission.grant.request') {
    const { requestId, workspaceId, permission, scope } = message.payload;
    const workspace = workspaces.get(workspaceId);
    if (!workspace) {
      send({
        kind: 'local_runtime.workspace.permission.grant.result',
        payload: {
          requestId,
          workspaceId,
          permission,
          status: 'error',
          error: { code: 'LOCAL_WORKSPACE_NOT_FOUND', message: 'Workspace is not registered on this device.' }
        }
      });
      return;
    }
    try {
      workspace.grantPermission(permission, scope);
      await saveState(state);
      send({
        kind: 'local_runtime.workspace.permission.grant.result',
        payload: {
          requestId,
          workspaceId,
          permission,
          status: 'granted',
          workspace: await workspaceRegistration(workspace)
        }
      });
    } catch (error) {
      send({
        kind: 'local_runtime.workspace.permission.grant.result',
        payload: {
          requestId,
          workspaceId,
          permission,
          status: 'error',
          error: {
            code: 'LOCAL_PERMISSION_GRANT_FAILED',
            message: error instanceof Error ? error.message : String(error)
          }
        }
      });
    }
    return;
  }
  if (message.kind === 'local_runtime.workspace.operation.request') {
    const result = await handleWorkspaceOperation(message.payload, workspaces);
    send({ kind: 'local_runtime.workspace.operation.result', payload: result });
    return;
  }
  if (message.kind === 'local_runtime.invocation.start') {
    const { plan, workspaceId } = message.payload;
    const workspace = workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Unregistered local workspace: ${workspaceId}`);
    if (active.has(plan.invocationId)) throw new Error(`Duplicate invocation: ${plan.invocationId}`);
    const localPermissions = workspace.permissionPolicy();
    if (workspace.consumeOneTimePermissions().length) await saveState(state);
    const controller = new AbortController();
    active.set(plan.invocationId, controller);
    const emit = (event: Parameters<typeof send>[0] extends never ? never : import('@agent-cluster/shared').AgentRuntimeEvent) => {
      send({ kind: 'local_runtime.invocation.event', payload: event });
    };
    const providerConnection = await localConnectionForPlan(message.payload.plan, state, secrets)
      .then((connection) => ({ connection }))
      .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    const resolvedConnection = 'connection' in providerConnection ? providerConnection.connection : undefined;
    const providerConnectionError = 'error' in providerConnection ? providerConnection.error : undefined;
    void executeLocalInvocation(
      message.payload,
      workspace,
      controller.signal,
      emit,
      localPermissions,
      resolvedConnection,
      providerConnectionError
    )
      .then(async (result) => {
        const workspaceRevision = await workspace.revision();
        send({
          kind: 'local_runtime.invocation.result',
          payload: {
            result,
            workspaceId: workspace.state.workspaceId,
            workspaceRevision
          }
        });
        send({
          kind: 'local_runtime.workspace.register',
          payload: { ...await workspaceRegistration(workspace), revision: workspaceRevision }
        });
      })
      .finally(() => active.delete(plan.invocationId));
    return;
  }
  if (message.kind === 'local_runtime.invocation.cancel') {
    active.get(message.payload.invocationId)?.abort(message.payload.termination);
    return;
  }
  if (message.kind === 'local_runtime.protocol.error') {
    throw new Error(`${message.payload.code}: ${message.payload.message}`);
  }
  if (message.kind === 'local_runtime.workspace.registration_rejected') {
    throw new Error(`${message.payload.code}: ${message.payload.message}`);
  }
  if (message.kind === 'local_runtime.workspace.registered') return;
  if (message.kind === 'local_runtime.connected') {
    process.stdout.write(`Connected Local Runtime device ${message.payload.deviceId}.\n`);
  }
}

function deletedConnectionSummary(deviceId: string, connectionId: string): LocalRuntimeProviderConnectionSummary {
  return {
    connectionId,
    provider: 'openai-compatible',
    model: '',
    baseUrl: '',
    deviceId,
    hasApiKey: false,
    compatibleRuntimeTypes: [],
    updatedAt: new Date().toISOString()
  };
}

async function localConnectionForPlan(
  plan: import('@agent-cluster/shared').InvocationPlan,
  state: LocalRuntimeState,
  secrets: LocalSecretStore
): Promise<LocalRuntimeProviderConnectionInput | undefined> {
  const modelId = plan.executionTarget.modelId;
  if (!modelId) return undefined;
  const summary = state.providerConnections.find((connection) => connection.connectionId === modelId);
  if (!summary) return undefined;
  if (!summary.compatibleRuntimeTypes.includes(plan.executionTarget.runtimeType)) {
    throw new Error(`MODEL_PROTOCOL_MISMATCH: ${summary.provider} cannot be used by ${plan.executionTarget.runtimeType}.`);
  }
  const apiKey = await secrets.get(summary.connectionId);
  if (!apiKey) throw new Error('LOCAL_CREDENTIAL_MISSING: The selected local provider credential is unavailable.');
  return {
    connectionId: summary.connectionId,
    provider: summary.provider,
    model: summary.model,
    baseUrl: summary.baseUrl,
    apiKey
  };
}

export async function workspaceRegistration(workspace: LocalWorkspace) {
  return {
    workspaceId: workspace.state.workspaceId,
    displayName: workspace.state.displayName,
    capabilities: workspace.capabilities(),
    revision: await workspace.revision(),
    ...(workspace.state.index ? { index: indexSummary(workspace.state.index) } : {}),
    permissions: workspace.permissionPolicy(),
    registeredAt: workspace.state.registeredAt
  };
}

function indexSummary(index: NonNullable<LocalWorkspace['state']['index']>) {
  const { entries: _entries, ...summary } = index;
  return summary;
}

async function handleWorkspaceOperation(
  request: Extract<LocalRuntimeServerMessage, { kind: 'local_runtime.workspace.operation.request' }>['payload'],
  workspaces: Map<string, LocalWorkspace>
): Promise<WorkspaceOperationResult> {
  const workspace = workspaces.get(request.workspaceId);
  if (!workspace) return operationError(request, 'LOCAL_WORKSPACE_NOT_FOUND', 'Workspace is not registered on this device.');
  try {
    if (request.ownerId !== 'local-user') throw new Error('LOCAL_OWNER_MISMATCH: Workspace operation owner is invalid.');
    const actualRevision = await workspace.revision();
    if (!['getRevision', 'getIndexSnapshot', 'queryWorkspaceIndex'].includes(request.operation) && actualRevision.id !== request.workspaceRevision.id) {
      throw new Error('LOCAL_WORKSPACE_REVISION_CONFLICT: Workspace changed before the requested operation.');
    }
    const permissions = intersectOperationPermissions(request.permissions, workspace.permissionPolicy());
    assertOperationPermission(request.operation, permissions);
    let data: unknown;
    if (request.operation === 'capabilities') data = workspace.capabilities();
    else if (request.operation === 'getRevision') data = await workspace.revision();
    else if (request.operation === 'getIndexSnapshot') data = await workspace.getIndexSnapshot(request.input);
    else if (request.operation === 'queryWorkspaceIndex') data = await workspace.queryWorkspaceIndex(request.input);
    else if (request.operation === 'listDirectory') data = await workspace.listDirectory(request.input);
    else if (request.operation === 'statFile') data = await workspace.statFile(request.input);
    else if (request.operation === 'readFile') data = await workspace.readFile(request.input);
    else if (request.operation === 'searchText') data = await workspace.searchText(request.input);
    else data = await workspace.applyChangeSet(request.input, permissions);
    return { requestId: request.requestId, workspaceId: request.workspaceId, operation: request.operation, status: 'ok', data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.includes(':') ? message.slice(0, message.indexOf(':')) : 'LOCAL_WORKSPACE_OPERATION_FAILED';
    return operationError(request, code, message);
  }
}

function intersectOperationPermissions(
  platform: LocalRuntimePermissionPolicy,
  local: LocalRuntimePermissionPolicy
) {
  const keys: readonly LocalRuntimePermission[] = [
    'workspace_read',
    'workspace_write',
    'workspace_delete',
    'command_execute',
    'test_execute',
    'dependency_install'
  ];
  return Object.fromEntries(keys.map((key) => {
    const values = [platform[key], local[key]];
    const value = values.includes('deny') ? 'deny' : values.includes('confirm') ? 'confirm' : 'allow';
    return [key, value];
  })) as unknown as LocalRuntimePermissionPolicy;
}

function assertOperationPermission(
  operation: WorkspaceOperationRequest['operation'],
  permissions: LocalRuntimePermissionPolicy
) {
  const key: LocalRuntimePermission | undefined = operation === 'applyChangeSet'
    ? 'workspace_write'
    : operation === 'capabilities' || operation === 'getRevision'
      ? undefined
      : 'workspace_read';
  if (!key || permissions[key] === 'allow') return;
  const prefix = permissions[key] === 'confirm' ? 'LOCAL_CONFIRMATION_REQUIRED' : 'LOCAL_PERMISSION_DENIED';
  throw new Error(`${prefix}: ${key}`);
}

function operationError(request: WorkspaceOperationRequest, code: string, message: string): WorkspaceOperationResult {
  return {
    requestId: request.requestId,
    workspaceId: request.workspaceId,
    operation: request.operation,
    status: 'error',
    error: { code, message }
  };
}

async function ensureAccessToken(state: LocalRuntimeState) {
  if (state.tokens && Date.parse(state.tokens.accessTokenExpiresAt) > Date.now() + 60_000) return;
  if (!state.tokens?.refreshToken) throw new Error('Local Runtime refresh token is unavailable.');
  state.tokens = await apiJson<LocalRuntimeTokenResponse>(state.serverUrl, '/api/local-runtime/device-tokens/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken: state.tokens.refreshToken })
  });
  await saveState(state);
}

function isAuthorizationFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP 401|HTTP 403|access token is invalid|refresh token is invalid/i.test(message);
}

async function apiJson<T>(serverUrl: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(new URL(path, serverUrl), {
    ...init,
    headers: { 'content-type': 'application/json', accept: 'application/json', ...init.headers }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as unknown : undefined;
  if (!response.ok) {
    const message = apiErrorMessage(body) ?? text;
    throw new Error(`HTTP ${response.status}: ${message || response.statusText}`);
  }
  if (isApiResponse(body)) return body.data as T;
  return body as T;
}

function isApiResponse(body: unknown): body is { data: unknown; requestId: string } {
  return Boolean(
    body
    && typeof body === 'object'
    && 'data' in body
    && 'requestId' in body
    && typeof (body as { requestId?: unknown }).requestId === 'string'
  );
}

function apiErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  if ('message' in body) return String((body as { message: unknown }).message);
  const error = 'error' in body ? (body as { error?: unknown }).error : undefined;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return undefined;
}

function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

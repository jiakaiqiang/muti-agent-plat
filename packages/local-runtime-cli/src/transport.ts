import { createHash } from 'node:crypto';
import { unwatchFile, watchFile } from 'node:fs';
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
  WorkspaceIndexSnapshot,
  WorkspaceOperationRequest,
  WorkspaceOperationResult
} from '@agent-cluster/shared';
import { LOCAL_RUNTIME_PROTOCOL_VERSION, runtimeTypesForModelProvider } from '@agent-cluster/shared';
import WebSocket from 'ws';
import { detectAvailableLocalRuntimes, probeLocalRuntimeCapabilities } from './adapters/registry.js';
import { executeLocalInvocation } from './runtime.js';
import type { LocalRuntimeState } from './state.js';
import {
  loadPersistedWorkspaceIds,
  saveState,
  saveWorkspaceIndex,
  stateFilePath
} from './state.js';
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
    signal: AbortSignal.timeout(10_000),
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

/** Optional desktop lifecycle; the standalone CLI keeps its existing behavior. */
export type BridgeLifecycle = {
  isDraining?: () => boolean;
  onActivityChange?: (count: number) => void;
  onConnectionChange?: (connected: boolean) => void;
  onConnectionError?: (error: unknown) => void;
  stopOnAuthorizationFailure?: boolean;
  /** Explicit recovery policy supplied by the local development launcher. */
  authorizeMissingTokens?: () => Promise<unknown>;
};

export async function runBridge(state: LocalRuntimeState, cliVersion: string, signal: AbortSignal, lifecycle: BridgeLifecycle = {}) {
  const writebackAuthorizations = new LocalWritebackAuthorizationStore();
  const activityByConnection = new Map<object, number>();
  while (!signal.aborted) {
    try {
      if (state.tokens) await ensureAccessToken(state);
      else if (lifecycle.authorizeMissingTokens) await lifecycle.authorizeMissingTokens();
      else await authorizeLoopbackDevice(state, cliVersion);
      if (signal.aborted) break;
      const connectionKey = {};
      await runBridgeConnection(state, cliVersion, signal, writebackAuthorizations, {
        ...lifecycle,
        onActivityChange(count) {
          if (count) activityByConnection.set(connectionKey, count);
          else activityByConnection.delete(connectionKey);
          lifecycle.onActivityChange?.([...activityByConnection.values()].reduce((sum, value) => sum + value, 0));
        }
      });
    } catch (error) {
      if (signal.aborted) break;
      const canRecover = Boolean(state.tokens && lifecycle.authorizeMissingTokens);
      if (isAuthorizationFailure(error) && state.tokens) {
        delete state.tokens;
        await saveState(state);
      }
      if (isAuthorizationFailure(error) && lifecycle.stopOnAuthorizationFailure && !canRecover) throw error;
      lifecycle.onConnectionError?.(error);
      process.stderr.write(`Local Runtime connection failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    if (!signal.aborted) await abortableDelay(2_000, signal).catch(() => undefined);
  }
}

async function runBridgeConnection(
  state: LocalRuntimeState,
  cliVersion: string,
  signal: AbortSignal,
  writebackAuthorizations: LocalWritebackAuthorizationStore,
  lifecycle: BridgeLifecycle
) {
  const accessToken = state.tokens?.accessToken;
  if (!accessToken) throw new Error('Local Runtime access token is unavailable.');
  const socketUrl = new URL('/local-runtime', state.serverUrl);
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(socketUrl, { handshakeTimeout: 10_000, headers: { Authorization: `Bearer ${accessToken}` } });
  const active = new Map<string, AbortController>();
  let pendingMessages = 0;
  const reportActivity = () => lifecycle.onActivityChange?.(pendingMessages + active.size);
  const workspaceAuthorizations = new Map<string, AbortController>();
  const workspaceInitializations = new Map<string, Promise<void>>();
  const secrets = new LocalSecretStore();
  const indexPersistence = createWorkspaceIndexPersistence(state);
  const workspaces = new Map(state.workspaces.map((workspace) => [
    workspace.workspaceId,
    new LocalWorkspace(workspace, { onIndexUpdated: indexPersistence.onIndexUpdated })
  ]));
  let heartbeat: NodeJS.Timeout | undefined;
  let stopReceiptProtocol = false;
  const send = (message: LocalRuntimeClientMessage) => {
    if (message.kind === 'local_runtime.invocation.stopped' && !stopReceiptProtocol) return;
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const watchedStatePath = stateFilePath();
  let workspaceRevocationSync = Promise.resolve();
  const syncWorkspaceRevocations = () => {
    workspaceRevocationSync = workspaceRevocationSync.then(async () => {
      const persistedWorkspaceIds = await loadPersistedWorkspaceIds();
      unregisterRemovedWorkspaces(
        state,
        workspaces,
        persistedWorkspaceIds,
        send,
        indexPersistence.drop
      );
    }).catch((error) => {
      process.stderr.write(`Failed to synchronize Local Runtime workspace revocations: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  };
  watchFile(watchedStatePath, { interval: 250, persistent: false }, syncWorkspaceRevocations);
  const closeForAbort = () => socket.close(1000, 'local_runtime_stopped');
  signal.addEventListener('abort', closeForAbort, { once: true });

  await new Promise<void>((resolve, reject) => {
    let opened = false;
    socket.on('open', async () => {
      opened = true;
      if (signal.aborted || lifecycle.isDraining?.()) { socket.close(); return; }
      pendingMessages++;
      reportActivity();
      try {
        const capabilities = await probeLocalRuntimeCapabilities();
        if (signal.aborted) return;
        const runtimes = runtimesFromCapabilities(capabilities);
        send({
          kind: 'local_runtime.hello',
          payload: {
            outputContractVersions: ['1.0', '2.0'],
            deviceId: state.deviceId,
            cliVersion,
            protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
            runtimes,
            capabilities
          }
        });
        for (const workspace of workspaces.values()) {
          send({
            kind: 'local_runtime.workspace.register',
            payload: await workspaceRegistration(workspace)
          });
        }
        heartbeat = setInterval(() => {
          for (const receipt of state.pendingStopReceipts ?? []) {
            send({ kind: 'local_runtime.invocation.stopped', payload: receipt });
          }
          send({
            kind: 'local_runtime.heartbeat',
            payload: { deviceId: state.deviceId, sentAt: new Date().toISOString() }
          });
        }, 15_000);
      } catch (error) {
        reject(error);
        socket.close();
      } finally {
        pendingMessages--;
        reportActivity();
      }
    });
    socket.on('message', (data) => {
      if (signal.aborted || lifecycle.isDraining?.()) return;
      let message: LocalRuntimeServerMessage;
      try { message = JSON.parse(data.toString()) as LocalRuntimeServerMessage; }
      catch { socket.close(1002, 'invalid_json'); return; }
      if (message.kind === 'local_runtime.connected') {
        stopReceiptProtocol = message.payload.stopReceiptProtocol === 1;
        lifecycle.onConnectionChange?.(true);
        for (const receipt of state.pendingStopReceipts ?? []) {
          send({ kind: 'local_runtime.invocation.stopped', payload: receipt });
        }
      }
      pendingMessages++;
      reportActivity();
      void handleServerMessage(
        message,
        state,
        workspaces,
        active,
        workspaceAuthorizations,
        workspaceInitializations,
        writebackAuthorizations,
        secrets,
        indexPersistence,
        send,
        reportActivity
      )
        .catch((error) => process.stderr.write(`Local Runtime request failed: ${error instanceof Error ? error.message : String(error)}\n`))
        .finally(() => { pendingMessages--; reportActivity(); });
    });
    socket.on('unexpected-response', (_, response) => reject(new Error(`WebSocket upgrade rejected with HTTP ${response.statusCode}.`)));
    socket.on('error', (error) => { if (!opened) reject(error); });
    socket.on('close', () => {
      lifecycle.onConnectionChange?.(false);
      if (heartbeat) clearInterval(heartbeat);
      for (const controller of active.values()) controller.abort(new Error('Local Runtime connection closed.'));
      // Keep invocation activity until execution and its result persistence settle.
      // Clearing here could allow an updater to kill work still unwinding after disconnect.
      for (const controller of workspaceAuthorizations.values()) controller.abort(new Error('Local Runtime connection closed.'));
      workspaceAuthorizations.clear();
      resolve();
    });
  }).finally(async () => {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    unwatchFile(watchedStatePath, syncWorkspaceRevocations);
    await workspaceRevocationSync;
    signal.removeEventListener('abort', closeForAbort);
    if (heartbeat) clearInterval(heartbeat);
    for (const workspace of workspaces.values()) workspace.close();
    await indexPersistence.flush();
  });
}

async function handleServerMessage(
  message: LocalRuntimeServerMessage,
  state: LocalRuntimeState,
  workspaces: Map<string, LocalWorkspace>,
  active: Map<string, AbortController>,
  workspaceAuthorizations: Map<string, AbortController>,
  workspaceInitializations: Map<string, Promise<void>>,
  writebackAuthorizations: LocalWritebackAuthorizationStore,
  secrets: LocalSecretStore,
  indexPersistence: WorkspaceIndexPersistence,
  send: (message: LocalRuntimeClientMessage) => void,
  reportActivity: () => void = () => undefined
) {
  if (message.kind === 'local_runtime.capabilities.request') {
    const capabilities = await probeLocalRuntimeCapabilities();
    send({
      kind: 'local_runtime.capabilities.result',
      payload: { requestId: message.payload.requestId, capabilities }
    });
    return;
  }
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
    const { requestId } = message.payload;
    if (workspaceAuthorizations.has(requestId)) {
      send({
        kind: 'local_runtime.workspace.authorization.result',
        payload: {
          requestId,
          status: 'error',
          error: { code: 'DUPLICATE_WORKSPACE_AUTHORIZATION', message: 'Workspace authorization request is already active.' }
        }
      });
      return;
    }
    const controller = new AbortController();
    workspaceAuthorizations.set(requestId, controller);
    try {
      const selectedPath = await selectWorkspaceDirectory(
        message.payload.title,
        process.platform,
        undefined,
        controller.signal,
        // Report to the server that the OS dialog actually appeared. Without this the server
        // cannot distinguish a user who is slow to click from a dialog that never spawned.
        () => {
          send({
            kind: 'local_runtime.workspace.authorization.prompted',
            payload: { requestId, promptedAt: new Date().toISOString() }
          });
        }
      );
      if (!selectedPath) {
        send({
          kind: 'local_runtime.workspace.authorization.result',
          payload: { requestId, status: 'cancelled' }
        });
        return;
      }
      if (controller.signal.aborted) return;
      const workspace = await initializeSelectedWorkspace(
        selectedPath,
        state,
        workspaces,
        workspaceInitializations,
        controller.signal,
        indexPersistence.onIndexUpdated
      );
      if (controller.signal.aborted) return;
      send({
        kind: 'local_runtime.workspace.authorization.result',
        payload: {
          requestId,
          status: 'selected',
          workspace: await workspaceRegistration(workspace)
        }
      });
    } catch (error) {
      send({
        kind: 'local_runtime.workspace.authorization.result',
        payload: controller.signal.aborted
          ? { requestId, status: 'cancelled' }
          : {
              requestId,
              status: 'error',
              error: {
                code: 'LOCAL_WORKSPACE_AUTHORIZATION_FAILED',
                message: error instanceof Error ? error.message : String(error)
              }
            }
      });
    } finally {
      workspaceAuthorizations.delete(requestId);
    }
    return;
  }
  if (message.kind === 'local_runtime.workspace.authorization.cancel') {
    workspaceAuthorizations.get(message.payload.requestId)?.abort(new Error('Workspace authorization cancelled.'));
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
    const result = await handleWorkspaceOperation(message.payload, workspaces, writebackAuthorizations);
    send({ kind: 'local_runtime.workspace.operation.result', payload: result });
    return;
  }
  if (message.kind === 'local_runtime.invocation.start') {
    const { plan, workspaceId } = message.payload;
    const workspace = workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Unregistered local workspace: ${workspaceId}`);
    if (active.has(plan.invocationId)) throw new Error(`Duplicate invocation: ${plan.invocationId}`);
    if ((state.pendingStopReceipts?.length ?? 0) >= 256) throw new Error('STOP_RECEIPT_BACKLOG: reconnect before starting more work.');
    const localPermissions = workspace.permissionPolicy();
    const consumedPermissions = workspace.consumeOneTimePermissions();
    if (consumedPermissions.length) await saveState(state);
    const controller = new AbortController();
    active.set(plan.invocationId, controller);
    reportActivity();
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
        const receipt = { invocationId: plan.invocationId, workspaceId, runtimeType: result.runtimeType };
        state.pendingStopReceipts = [...(state.pendingStopReceipts ?? []).filter(item => item.invocationId !== plan.invocationId), receipt];
        // Persist before sending. A disconnect must not lose the process-exit receipt.
        await saveState(state);
        const changeSet = result.workspaceExecution?.changeSet;
        if (
          changeSet &&
          consumedPermissions.includes('workspace_delete') &&
          changeSet.changes.some((change) => change.operation === 'delete' || change.operation === 'move')
        ) {
          writebackAuthorizations.authorizeDelete(workspaceId, changeSet);
        }
        const workspaceRevision = await workspace.revision();
        send({
          kind: 'local_runtime.invocation.result',
          payload: {
            result,
            workspaceId: workspace.state.workspaceId,
            workspaceRevision
          }
        });
        send({ kind: 'local_runtime.invocation.stopped', payload: receipt });
        send({
          kind: 'local_runtime.workspace.register',
          payload: { ...await workspaceRegistration(workspace), revision: workspaceRevision }
        });
      })
      .catch((error) => process.stderr.write(`Local Runtime invocation failed: ${error instanceof Error ? error.message : String(error)}\n`))
      .finally(() => { active.delete(plan.invocationId); reportActivity(); });
    return;
  }
  if (message.kind === 'local_runtime.invocation.cancel') {
    active.get(message.payload.invocationId)?.abort(message.payload.termination);
    return;
  }
  if (message.kind === 'local_runtime.invocation.stop_ack') {
    state.pendingStopReceipts = (state.pendingStopReceipts ?? []).filter(item => item.invocationId !== message.payload.invocationId);
    await saveState(state);
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

function runtimesFromCapabilities(
  capabilities: Awaited<ReturnType<typeof probeLocalRuntimeCapabilities>>
) {
  return Object.fromEntries(
    capabilities
      .filter((capability) => capability.status === 'ready' && capability.version)
      .map((capability) => [capability.runtimeType, capability.version] as const)
  );
}

export async function initializeSelectedWorkspace(
  selectedPath: string,
  state: LocalRuntimeState,
  workspaces: Map<string, LocalWorkspace>,
  initializationTails: Map<string, Promise<void>>,
  signal: AbortSignal,
  onIndexUpdated: (snapshot: WorkspaceIndexSnapshot) => void | Promise<void> = () => saveState(state)
) {
  const key = process.platform === 'win32' ? selectedPath.toLowerCase() : selectedPath;
  const previous = initializationTails.get(key) ?? Promise.resolve();
  const initialization = previous.catch(() => undefined).then(async () => {
    signal.throwIfAborted();
    let workspaceState = state.workspaces.find((workspace) => {
      const rootPath = process.platform === 'win32' ? workspace.rootPath.toLowerCase() : workspace.rootPath;
      return rootPath === key;
    });
    if (!workspaceState) {
      workspaceState = await createWorkspaceState(selectedPath);
      signal.throwIfAborted();
      state.workspaces.push(workspaceState);
      try {
        await saveState(state);
        signal.throwIfAborted();
      } catch (error) {
        state.workspaces = state.workspaces.filter((candidate) => candidate !== workspaceState);
        await saveState(state).catch(() => undefined);
        throw error;
      }
    }
    signal.throwIfAborted();
    let workspace = workspaces.get(workspaceState.workspaceId);
    if (!workspace) {
      workspace = new LocalWorkspace(workspaceState, { onIndexUpdated });
      workspaces.set(workspaceState.workspaceId, workspace);
    }
    return workspace;
  });
  const tail = initialization.then(() => undefined, () => undefined);
  initializationTails.set(key, tail);
  try {
    return await initialization;
  } finally {
    if (initializationTails.get(key) === tail) initializationTails.delete(key);
  }
}

type WorkspaceIndexPersistence = ReturnType<typeof createWorkspaceIndexPersistence>;

export function createWorkspaceIndexPersistence(
  state: LocalRuntimeState,
  debounceMs = 500
) {
  const pending = new Map<string, WorkspaceIndexSnapshot>();
  let timer: NodeJS.Timeout | undefined;
  let writeTail = Promise.resolve();

  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!pending.size) {
      await writeTail;
      return;
    }
    const snapshots = [...pending.values()];
    pending.clear();
    const operation = writeTail.then(async () => {
      await Promise.all(snapshots.map((snapshot) => (
        saveWorkspaceIndex(snapshot.workspaceId, snapshot.entries)
      )));
      await saveState(state);
    });
    writeTail = operation.catch(() => undefined);
    await operation;
  };

  const onIndexUpdated = (snapshot: WorkspaceIndexSnapshot) => {
    pending.set(snapshot.workspaceId, snapshot);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void flush().catch((error) => {
        process.stderr.write(`Failed to persist Local Runtime workspace index: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }, debounceMs);
    timer.unref?.();
  };

  const drop = (workspaceId: string) => {
    pending.delete(workspaceId);
  };

  return { onIndexUpdated, flush, drop };
}

export function unregisterRemovedWorkspaces(
  state: LocalRuntimeState,
  workspaces: Map<string, LocalWorkspace>,
  persistedWorkspaceIds: ReadonlySet<string>,
  send: (message: LocalRuntimeClientMessage) => void,
  onRemoved?: (workspaceId: string) => void
) {
  for (const [workspaceId, workspace] of workspaces) {
    if (persistedWorkspaceIds.has(workspaceId)) continue;
    onRemoved?.(workspaceId);
    workspace.close();
    workspaces.delete(workspaceId);
    state.workspaces = state.workspaces.filter((candidate) => candidate.workspaceId !== workspaceId);
    send({ kind: 'local_runtime.workspace.unregister', payload: { workspaceId } });
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
  const index = workspace.state.index;
  if (!index) {
    throw new Error('LOCAL_WORKSPACE_INDEX_MISSING: Workspace index is required in protocol v6+.');
  }
  return {
    workspaceId: workspace.state.workspaceId,
    displayName: workspace.state.displayName,
    capabilities: workspace.capabilities(),
    revision: await workspace.revision(),
    index: indexSummary(index),
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
  workspaces: Map<string, LocalWorkspace>,
  writebackAuthorizations = new LocalWritebackAuthorizationStore()
): Promise<WorkspaceOperationResult> {
  const workspace = workspaces.get(request.workspaceId);
  if (!workspace) return operationError(request, 'LOCAL_WORKSPACE_NOT_FOUND', 'Workspace is not registered on this device.');
  try {
    if (request.ownerId !== 'local-user') throw new Error('LOCAL_OWNER_MISMATCH: Workspace operation owner is invalid.');
    const actualRevision = await workspace.revision();
    if (!['getRevision', 'getIndexSnapshot', 'queryWorkspaceIndex', 'applyChangeSet'].includes(request.operation) && actualRevision.id !== request.workspaceRevision.id) {
      throw new Error('LOCAL_WORKSPACE_REVISION_CONFLICT: Workspace changed before the requested operation.');
    }
    const basePermissions = intersectOperationPermissions(request.permissions, workspace.permissionPolicy());
    const permissions = writebackAuthorizations.permissionsFor(request, basePermissions);
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
    else {
      data = await workspace.applyChangeSet(request.input, permissions);
      writebackAuthorizations.recordApplyResult(request, data as import('@agent-cluster/shared').ApplyChangeSetResult);
    }
    return { requestId: request.requestId, workspaceId: request.workspaceId, operation: request.operation, status: 'ok', data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.includes(':') ? message.slice(0, message.indexOf(':')) : 'LOCAL_WORKSPACE_OPERATION_FAILED';
    return operationError(request, code, message);
  }
}

export class LocalWritebackAuthorizationStore {
  private readonly deleteAuthorizations = new Map<string, Map<string, { digest: string; expiresAt: number }>>();

  constructor(
    private readonly ttlMs = 30 * 60 * 1_000,
    private readonly now: () => number = Date.now
  ) {}

  authorizeDelete(workspaceId: string, changeSet: import('@agent-cluster/shared').WorkspaceChangeSet) {
    const authorized = this.deleteAuthorizations.get(workspaceId) ?? new Map<string, { digest: string; expiresAt: number }>();
    authorized.set(changeSet.id, { digest: canonicalChangeSetDigest(changeSet), expiresAt: this.now() + this.ttlMs });
    this.deleteAuthorizations.set(workspaceId, authorized);
  }

  permissionsFor(
    request: Extract<LocalRuntimeServerMessage, { kind: 'local_runtime.workspace.operation.request' }>['payload'],
    base: LocalRuntimePermissionPolicy
  ): LocalRuntimePermissionPolicy {
    if (request.operation !== 'applyChangeSet' || !this.hasDelete(request.workspaceId, request.input)) return base;
    return { ...base, workspace_delete: 'allow' };
  }

  recordApplyResult(
    request: Extract<LocalRuntimeServerMessage, { kind: 'local_runtime.workspace.operation.request' }>['payload'],
    result: import('@agent-cluster/shared').ApplyChangeSetResult
  ) {
    if (request.operation !== 'applyChangeSet' || !result.ok) return;
    const authorized = this.deleteAuthorizations.get(request.workspaceId);
    authorized?.delete(request.input.id);
    if (authorized?.size === 0) this.deleteAuthorizations.delete(request.workspaceId);
  }

  private hasDelete(workspaceId: string, changeSet: import('@agent-cluster/shared').WorkspaceChangeSet) {
    const authorized = this.deleteAuthorizations.get(workspaceId);
    const entry = authorized?.get(changeSet.id);
    if (!entry) return false;
    if (entry.expiresAt <= this.now()) {
      authorized?.delete(changeSet.id);
      if (authorized?.size === 0) this.deleteAuthorizations.delete(workspaceId);
      return false;
    }
    if (entry.digest === canonicalChangeSetDigest(changeSet)) return true;
    return false;
  }
}

function canonicalChangeSetDigest(changeSet: import('@agent-cluster/shared').WorkspaceChangeSet) {
  return createHash('sha256').update(stableJson(changeSet)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
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
    signal: AbortSignal.timeout(10_000),
    method: 'POST',
    body: JSON.stringify({ refreshToken: state.tokens.refreshToken })
  });
  await saveState(state);
}

function isAuthorizationFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP 401|HTTP 403|access token is invalid|refresh token is (invalid|unavailable)/i.test(message);
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

export function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

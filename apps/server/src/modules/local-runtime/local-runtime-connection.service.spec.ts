import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY,
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  type LocalRuntimeServerMessage
} from '@agent-cluster/shared';
import { firstValueFrom } from 'rxjs';
import { WebSocket } from 'ws';
import { makeInvocationPlan } from '../runtimes/invocation-plan.fixture.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { BrokerGateway } from '../workspaces/runtime-broker/broker-gateway.js';
import { HeartbeatTracker } from '../workspaces/runtime-broker/heartbeat-tracker.js';
import { PendingRequestRegistry } from '../workspaces/runtime-broker/pending-request-registry.js';
import { LocalRuntimeAuthService } from './local-runtime-auth.service.js';
import { LocalRuntimeConnectionService } from './local-runtime-connection.service.js';

test('authenticated Local Runtime carries an invocation and disconnects without a server fallback', async () => {
  const persistence = new PersistenceService({ enabled: false });
  const auth = new LocalRuntimeAuthService(persistence);
  const gateway = new BrokerGateway(() => 'epoch-test');
  const pending = new PendingRequestRegistry();
  const connections = new LocalRuntimeConnectionService(
    auth,
    gateway,
    pending,
    new HeartbeatTracker(30_000),
    persistence
  );
  const code = auth.createDeviceCode({
    deviceId: 'device-local-runtime',
    displayName: 'developer-pc',
    cliVersion: '0.1.0',
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    runtimes: { codex: 'codex-cli 1.0.0', claude_code: 'claude-code 2.1.220' }
  }, 'http://localhost');
  auth.approveDeviceCode(code.userCode);
  const tokens = auth.exchangeDeviceCode(code.deviceCode);
  assert.ok('accessToken' in tokens);
  if (!('accessToken' in tokens)) return;

  const server = createServer();
  connections.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/local-runtime`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` }
  });
  const inbox = new LocalRuntimeMessageInbox(socket);

  try {
    await once(socket, 'open');
    socket.send(JSON.stringify({
      kind: 'local_runtime.hello',
      payload: {
        deviceId: 'device-local-runtime',
        cliVersion: '0.1.0',
        protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
        runtimes: { codex: 'codex-cli 1.0.0', claude_code: 'claude-code 2.1.220' }
      }
    }));
    assert.equal((await inbox.next('local_runtime.connected')).payload.deviceId, 'device-local-runtime');

    const capabilityRefresh = connections.refreshCapabilities('device-local-runtime');
    const capabilityRequest = await inbox.next('local_runtime.capabilities.request');
    socket.send(JSON.stringify({
      kind: 'local_runtime.capabilities.result',
      payload: {
        requestId: capabilityRequest.payload.requestId,
        capabilities: [
          {
            runtimeType: 'codex',
            status: 'ready',
            version: 'codex-cli 1.1.0',
            checkedAt: '2026-08-06T00:00:00.000Z'
          },
          {
            runtimeType: 'claude_code',
            status: 'ready',
            version: 'claude-code 2.2.0',
            checkedAt: '2026-08-06T00:00:00.000Z'
          }
        ]
      }
    }));
    assert.deepEqual(await capabilityRefresh, [
      {
        runtimeType: 'codex',
        status: 'ready',
        version: 'codex-cli 1.1.0',
        checkedAt: '2026-08-06T00:00:00.000Z'
      },
      {
        runtimeType: 'claude_code',
        status: 'ready',
        version: 'claude-code 2.2.0',
        checkedAt: '2026-08-06T00:00:00.000Z'
      }
    ]);

    const cancelledAuthorization = connections.authorizeWorkspace(undefined, 'authorization-cancelled');
    const cancelledRequest = await inbox.next('local_runtime.workspace.authorization.request');
    const authorization = connections.authorizeWorkspace(undefined, 'authorization-selected');
    const authorizationRequest = await inbox.next('local_runtime.workspace.authorization.request');
    assert.equal(cancelledRequest.payload.requestId, 'authorization-cancelled');
    assert.equal(authorizationRequest.payload.requestId, 'authorization-selected');

    assert.equal(connections.cancelWorkspaceAuthorization('authorization-cancelled'), true);
    await assert.rejects(cancelledAuthorization, /已取消选择本机工作目录/);
    assert.equal(
      (await inbox.next('local_runtime.workspace.authorization.cancel')).payload.requestId,
      'authorization-cancelled'
    );
    socket.send(JSON.stringify({
      kind: 'local_runtime.workspace.authorization.result',
      payload: {
        requestId: authorizationRequest.payload.requestId,
        status: 'selected',
        workspace: {
          workspaceId: 'workspace-picker',
          displayName: 'picked-project',
          capabilities: { read: true, write: true, command: true, test: true },
          revision: { id: 'revision-picker-1', observedAt: '2026-07-24T00:00:00.000Z' },
          permissions: DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY,
          registeredAt: '2026-07-24T00:00:00.000Z'
        }
      }
    }));
    assert.equal((await authorization).workspaceId, 'workspace-picker');
    assert.equal((await inbox.next('local_runtime.workspace.registered')).payload.workspaceId, 'workspace-picker');

    socket.send(JSON.stringify({
      kind: 'local_runtime.workspace.register',
      payload: {
        workspaceId: 'workspace-local-runtime',
        displayName: 'local-project',
        capabilities: { read: true, write: true, command: true, test: true },
        revision: { id: 'revision-local-1', observedAt: '2026-07-24T00:00:00.000Z' },
        permissions: DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY,
        registeredAt: '2026-07-24T00:00:00.000Z'
      }
    }));
    await inbox.next('local_runtime.workspace.registered');

    const summary = connections.listWorkspaces().find((workspace) => workspace.workspaceId === 'workspace-local-runtime');
    assert.equal(summary?.workspaceId, 'workspace-local-runtime');
    assert.equal(summary?.displayName, 'local-project');
    assert.deepEqual(summary?.runtimeTypes, ['codex', 'claude_code']);
    assert.equal(summary?.runtimeCapabilities[0]?.version, 'codex-cli 1.1.0');
    assert.equal('path' in (summary ?? {}), false);
    assert.equal(gateway.getRegistration('workspace-local-runtime')?.providerKind, 'local_bridge');

    const permissionGrant = connections.grantWorkspacePermissionOnce('workspace-local-runtime', 'workspace_delete');
    const permissionGrantRequest = await inbox.next('local_runtime.workspace.permission.grant.request');
    assert.equal(permissionGrantRequest.payload.workspaceId, 'workspace-local-runtime');
    assert.equal(permissionGrantRequest.payload.permission, 'workspace_delete');
    assert.equal(permissionGrantRequest.payload.scope, 'once');
    socket.send(JSON.stringify({
      kind: 'local_runtime.workspace.permission.grant.result',
      payload: {
        requestId: permissionGrantRequest.payload.requestId,
        workspaceId: 'workspace-local-runtime',
        permission: 'workspace_delete',
        status: 'granted',
        workspace: {
          workspaceId: 'workspace-local-runtime',
          displayName: 'local-project',
          capabilities: { read: true, write: true, command: true, test: true },
          revision: { id: 'revision-local-1', observedAt: '2026-07-24T00:00:00.000Z' },
          permissions: { ...DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY, workspace_delete: 'allow' },
          registeredAt: '2026-07-24T00:00:00.000Z'
        }
      }
    }));
    assert.equal((await permissionGrant).permissions.workspace_delete, 'allow');
    assert.equal((await inbox.next('local_runtime.workspace.registered')).payload.workspaceId, 'workspace-local-runtime');

    const operationResult = pending.waitFor('workspace-operation-1', 'workspace-local-runtime');
    gateway.dispatch({
      requestId: 'workspace-operation-1',
      invocationId: 'workspace-operation-invocation-1',
      workspaceId: 'workspace-local-runtime',
      operation: 'getRevision'
    });
    const workspaceOperation = await inbox.next('local_runtime.workspace.operation.request');
    assert.equal(workspaceOperation.payload.invocationId, 'workspace-operation-invocation-1');
    assert.equal(workspaceOperation.payload.ownerId, 'local-user');
    assert.equal(workspaceOperation.payload.workspaceRevision.id, 'revision-local-1');
    assert.deepEqual(workspaceOperation.payload.permissions, {
      ...DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY,
      workspace_delete: 'allow'
    });
    socket.send(JSON.stringify({
      kind: 'local_runtime.workspace.operation.result',
      payload: {
        requestId: 'workspace-operation-1',
        workspaceId: 'workspace-local-runtime',
        operation: 'getRevision',
        status: 'ok',
        data: { id: 'revision-local-2', observedAt: '2026-07-24T00:01:00.000Z' }
      }
    }));
    await operationResult;
    const [operationAudit] = connections.listOperationAudits();
    assert.equal(operationAudit.status, 'ok');
    assert.equal(operationAudit.revisionId, 'revision-local-1');
    assert.equal(JSON.stringify(operationAudit).includes('README.md'), false);

    const plan = makeInvocationPlan({
      invocationId: 'invocation-local-runtime',
      sessionId: 'session-local-runtime',
      executionTarget: {
        runtimeType: 'codex',
        workspaceProviderKind: 'local_bridge',
        executionLocation: 'local'
      },
      contextEnvelope: {
        workspaceId: 'workspace-local-runtime',
        L0: {
          workspace: {
            workspaceId: 'workspace-local-runtime',
            rootName: 'local-project',
            providerKind: 'local_bridge',
            revision: { id: 'revision-local-2', observedAt: '2026-07-24T00:01:00.000Z' }
          }
        }
      }
    });
    const handle = connections.startInvocation(plan);
    const request = await inbox.next('local_runtime.invocation.start');
    assert.equal(request.payload.plan.executionTarget.executionLocation, 'local');
    assert.equal(request.payload.workspaceId, 'workspace-local-runtime');

    socket.send(JSON.stringify({
      kind: 'local_runtime.workspace.register',
      payload: {
        workspaceId: 'workspace-local-runtime',
        displayName: 'local-project',
        capabilities: { read: true, write: true, command: true, test: true },
        revision: { id: 'revision-local-3', observedAt: '2026-07-24T00:02:00.000Z' },
        permissions: DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY,
        registeredAt: '2026-07-24T00:00:00.000Z'
      }
    }));
    await inbox.next('local_runtime.workspace.registered');
    assert.equal(connections.getWorkspace('workspace-local-runtime')?.revision.id, 'revision-local-3');

    const streamedEvent = handle.events[Symbol.asyncIterator]().next();
    socket.send(JSON.stringify({
      kind: 'local_runtime.invocation.event',
      payload: {
        invocationId: plan.invocationId,
        type: 'runtime_started',
        visibility: 'user',
        content: 'still active after workspace refresh',
        createdAt: '2026-07-24T00:02:00.000Z'
      }
    }));
    socket.send(JSON.stringify({
      kind: 'local_runtime.invocation.result',
      payload: {
        workspaceId: 'workspace-local-runtime',
        workspaceRevision: { id: 'revision-local-4', observedAt: '2026-07-24T00:03:00.000Z' },
        result: {
          invocationId: plan.invocationId,
          runtimeType: 'codex',
          status: 'completed',
          output: {
            schemaVersion: '1.0',
            kind: 'agent_message',
            messageKind: 'answer',
            content: 'completed after refresh',
            targetAgentIds: [],
            targetAgentKeys: [],
            mentionedAgentIds: [],
            relatedTaskIds: []
          },
          events: [],
          artifacts: [],
          systemEvidence: {
            workspaceChangeSet: null,
            verifiedTestResults: [],
            capturedAt: '2026-07-24T00:02:00.000Z',
            invocationId: plan.invocationId
          },
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'codex' }
        }
      }
    }));
    assert.equal((await streamedEvent).value?.content, 'still active after workspace refresh');
    assert.equal((await handle.result).status, 'completed');
    assert.equal(connections.getWorkspace('workspace-local-runtime')?.revision.id, 'revision-local-4');

    const indexResult = pending.waitFor('workspace-operation-index', 'workspace-local-runtime');
    gateway.dispatch({
      requestId: 'workspace-operation-index',
      invocationId: 'workspace-operation-index-invocation',
      workspaceId: 'workspace-local-runtime',
      operation: 'getIndexSnapshot',
      input: { limit: 10 }
    });
    await inbox.next('local_runtime.workspace.operation.request');
    socket.send(JSON.stringify({
      kind: 'local_runtime.workspace.operation.result',
      payload: {
        requestId: 'workspace-operation-index',
        workspaceId: 'workspace-local-runtime',
        operation: 'getIndexSnapshot',
        status: 'ok',
        data: {
          workspaceId: 'workspace-local-runtime',
          revision: { id: 'revision-local-5', observedAt: '2026-07-24T00:04:00.000Z' },
          generation: 2,
          status: 'ready',
          complete: true,
          entries: [],
          entrypoints: [],
          detectedStack: [],
          indexedEntries: 0,
          truncated: false,
          updatedAt: '2026-07-24T00:04:00.000Z',
          coverage: {
            visitedEntries: 0,
            indexedEntries: 0,
            excludedGenerated: 0,
            sensitiveEntries: 0,
            skippedSymlinks: 0,
            failedEntries: 0
          }
        }
      }
    }));
    await indexResult;
    assert.equal(connections.getWorkspace('workspace-local-runtime')?.revision.id, 'revision-local-5');

    const disconnectPlan = {
      ...plan,
      invocationId: 'invocation-local-runtime-disconnect',
      sessionId: 'session-local-runtime-disconnect'
    };
    const interruption = firstValueFrom(connections.interruptions());
    const disconnectHandle = connections.startInvocation(disconnectPlan);
    const disconnectRequest = await inbox.next('local_runtime.invocation.start');
    assert.equal(disconnectRequest.payload.workspaceRevision.id, 'revision-local-5');

    socket.close(1000, 'test disconnect');
    await once(socket, 'close');
    const [result, interrupted] = await Promise.all([disconnectHandle.result, interruption]);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.termination?.kind, 'runtime_disconnected');
    assert.equal(interrupted.sessionId, 'session-local-runtime-disconnect');
    assert.equal(interrupted.invocationId, 'invocation-local-runtime-disconnect');
    assert.equal(connections.listRuntimeCandidates('workspace-local-runtime').length, 0);
  } finally {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('same Local Runtime device can immediately re-register workspaces after reconnecting', async () => {
  const persistence = new PersistenceService({ enabled: false });
  const auth = new LocalRuntimeAuthService(persistence);
  const gateway = new BrokerGateway(() => 'epoch-test');
  const connections = new LocalRuntimeConnectionService(
    auth,
    gateway,
    new PendingRequestRegistry(),
    new HeartbeatTracker(30_000),
    persistence
  );
  const code = auth.createDeviceCode({
    deviceId: 'device-reconnect',
    displayName: 'developer-pc',
    cliVersion: '0.1.0',
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    runtimes: { codex: 'codex-cli 1.0.0' }
  }, 'http://localhost');
  auth.approveDeviceCode(code.userCode);
  const tokens = auth.exchangeDeviceCode(code.deviceCode);
  assert.ok('accessToken' in tokens);
  if (!('accessToken' in tokens)) return;

  const server = createServer();
  connections.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const socketUrl = `ws://127.0.0.1:${address.port}/local-runtime`;
  const headers = { Authorization: `Bearer ${tokens.accessToken}` };
  const registration = {
    workspaceId: 'workspace-reconnect',
    displayName: 'local-project',
    capabilities: { read: true, write: true, command: true, test: true },
    revision: { id: 'revision-reconnect-1', observedAt: '2026-07-30T00:00:00.000Z' },
    permissions: DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY,
    registeredAt: '2026-07-30T00:00:00.000Z'
  };
  const first = new WebSocket(socketUrl, { headers });
  const firstInbox = new LocalRuntimeMessageInbox(first);
  let second: WebSocket | undefined;

  try {
    await once(first, 'open');
    first.send(JSON.stringify({
      kind: 'local_runtime.hello',
      payload: {
        deviceId: 'device-reconnect',
        cliVersion: '0.1.0',
        protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
        runtimes: { codex: 'codex-cli 1.0.0' }
      }
    }));
    await firstInbox.next('local_runtime.connected');
    first.send(JSON.stringify({ kind: 'local_runtime.workspace.register', payload: registration }));
    await firstInbox.next('local_runtime.workspace.registered');
    assert.ok(gateway.getRegistration(registration.workspaceId));

    const firstClosed = once(first, 'close');
    second = new WebSocket(socketUrl, { headers });
    const secondInbox = new LocalRuntimeMessageInbox(second);
    await once(second, 'open');
    await firstClosed;
    second.send(JSON.stringify({
      kind: 'local_runtime.hello',
      payload: {
        deviceId: 'device-reconnect',
        cliVersion: '0.1.0',
        protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
        runtimes: { codex: 'codex-cli 1.0.0' }
      }
    }));
    await secondInbox.next('local_runtime.connected');
    second.send(JSON.stringify({
      kind: 'local_runtime.workspace.register',
      payload: {
        ...registration,
        revision: { id: 'revision-reconnect-2', observedAt: '2026-07-30T00:01:00.000Z' }
      }
    }));
    await secondInbox.next('local_runtime.workspace.registered');

    assert.equal(connections.listWorkspaces().length, 1);
    assert.equal(connections.getWorkspace(registration.workspaceId)?.revision.id, 'revision-reconnect-2');
    assert.equal(connections.listRuntimeCandidates(registration.workspaceId)[0]?.runtimeType, 'codex');
    assert.ok(gateway.getRegistration(registration.workspaceId));
  } finally {
    if (first.readyState === WebSocket.OPEN || first.readyState === WebSocket.CONNECTING) first.terminate();
    if (second?.readyState === WebSocket.OPEN || second?.readyState === WebSocket.CONNECTING) second.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

class LocalRuntimeMessageInbox {
  private readonly messages: LocalRuntimeServerMessage[] = [];
  private readonly waiters: Array<{
    kind: LocalRuntimeServerMessage['kind'];
    resolve: (message: LocalRuntimeServerMessage) => void;
  }> = [];

  constructor(socket: WebSocket) {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as LocalRuntimeServerMessage;
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.kind === message.kind);
      const waiter = waiterIndex >= 0 ? this.waiters.splice(waiterIndex, 1)[0] : undefined;
      if (waiter) waiter.resolve(message);
      else this.messages.push(message);
    });
  }

  next<TKind extends LocalRuntimeServerMessage['kind']>(kind: TKind) {
    type Message = Extract<LocalRuntimeServerMessage, { kind: TKind }>;
    const index = this.messages.findIndex((message) => message.kind === kind);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0] as Message);
    return new Promise<Message>((resolve) => {
      this.waiters.push({ kind, resolve: (message) => resolve(message as Message) });
    });
  }
}

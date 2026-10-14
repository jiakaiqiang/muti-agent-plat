import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY,
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  canonicalWorkspaceChangeSetJson,
  type LocalRuntimeServerMessage
} from '@agent-cluster/shared';
import { firstValueFrom } from 'rxjs';
import { WebSocket } from 'ws';
import { makeInvocationPlan } from '../runtimes/invocation-plan.fixture.js';
import { SessionStopStateStore } from '../runtimes/session-stop-state-store.js';
import { PersistenceService } from '../persistence/persistence.service.js';
import { BrokerGateway } from '../workspaces/runtime-broker/broker-gateway.js';
import { HeartbeatTracker } from '../workspaces/runtime-broker/heartbeat-tracker.js';
import { PendingRequestRegistry } from '../workspaces/runtime-broker/pending-request-registry.js';
import { LocalRuntimeAuthService } from './local-runtime-auth.service.js';
import { LocalRuntimeConnectionService } from './local-runtime-connection.service.js';

test('bound open control socket remains connected without claiming fresh model progress', () => {
  const persistence = new PersistenceService({ enabled: false });
  let now = 0;
  const heartbeats = new HeartbeatTracker(30_000, () => now);
  const connections = new LocalRuntimeConnectionService(
    new LocalRuntimeAuthService(persistence), new BrokerGateway(() => 'epoch-test'),
    new PendingRequestRegistry(), heartbeats, persistence
  );
  const plan = makeInvocationPlan();
  const workspaceId = plan.contextEnvelope.L0.workspace.workspaceId;
  const internals = connections as any;
  const socket = { readyState: WebSocket.OPEN as number };
  internals.workspaces.set(workspaceId, { deviceId: 'bound-device' });
  internals.clientsByDeviceId.set('bound-device', { hello: {}, socket });
  assert.equal(connections.isInvocationConnected(plan), true);
  heartbeats.record(workspaceId);
  assert.equal(connections.isInvocationConnected(plan), true);
  now = 30_001;
  assert.equal(connections.isInvocationConnected(plan), true, 'heartbeat age is not proof of a lost request');
  heartbeats.record(workspaceId);
  assert.equal(connections.isInvocationConnected(plan), true);
  socket.readyState = WebSocket.CLOSED;
  assert.equal(connections.isInvocationConnected(plan), false);
  socket.readyState = WebSocket.OPEN;
  internals.workspaces.delete(workspaceId);
  assert.equal(connections.isInvocationConnected(plan), false);
});

test('local GitHub PAT is handed to the selected connected device without server persistence', async () => {
  const persistence = new PersistenceService({ enabled: false });
  const connections = new LocalRuntimeConnectionService(
    new LocalRuntimeAuthService(persistence), new BrokerGateway(() => 'epoch-test'),
    new PendingRequestRegistry(), new HeartbeatTracker(30_000), persistence
  );
  const internals = connections as any;
  const sent: LocalRuntimeServerMessage[] = [];
  const client = { deviceId: 'device-a', hello: {}, socket: { readyState: WebSocket.OPEN } };
  internals.clientsByDeviceId.set(client.deviceId, client);
  internals.send = (_client: unknown, message: LocalRuntimeServerMessage) => sent.push(message);
  const pending = connections.requestGitHubAuthorization('device-a', {
    action: 'save_pat', repositoryUrl: 'https://github.com/example/project', token: 'fixture-secret'
  });
  const request = sent[0];
  assert.equal(request.kind, 'local_runtime.github.authorization.request');
  if (request.kind !== 'local_runtime.github.authorization.request') return;
  assert.equal(request.payload.token, 'fixture-secret');
  const result = { requestId: request.payload.requestId, status: 'ok' as const,
    authorization: {
      id: 'auth-a', deviceId: 'device-a', accountId: '42', accountLogin: 'octocat',
      repositoryId: '73', repositoryUrl: 'https://github.com/example/project',
      state: 'active' as const, version: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }
  };
  assert.throws(() => internals.handleMessage({ ...client, deviceId: 'device-b' }, {
    kind: 'local_runtime.github.authorization.result', payload: result
  }), /device/);
  internals.handleMessage(client, { kind: 'local_runtime.github.authorization.result', payload: result });
  assert.deepEqual(await pending, result.authorization);
  assert.equal(JSON.stringify(persistence.snapshotState()).includes('fixture-secret'), false);
});

test('local GitHub source response binds a session worktree to the selected device', async () => {
  const persistence = new PersistenceService({ enabled: false });
  const connections = new LocalRuntimeConnectionService(
    new LocalRuntimeAuthService(persistence), new BrokerGateway(() => 'epoch-test'),
    new PendingRequestRegistry(), new HeartbeatTracker(30_000), persistence
  );
  const internals = connections as any;
  const sent: LocalRuntimeServerMessage[] = [];
  const registered: string[] = [];
  const client = { deviceId: 'device-a', hello: {}, socket: { readyState: WebSocket.OPEN } };
  internals.clientsByDeviceId.set(client.deviceId, client);
  internals.send = (_client: unknown, message: LocalRuntimeServerMessage) => sent.push(message);
  internals.registerWorkspace = (_client: unknown, workspace: { workspaceId: string }) =>
    registered.push(workspace.workspaceId);
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const pending = connections.requestGitHubSource('device-a', {
    action: 'prepare', sessionId, repositoryUrl: 'https://github.com/example/project',
    authorizationId: 'auth-a'
  });
  const request = sent[0];
  assert.equal(request.kind, 'local_runtime.github.source.request');
  if (request.kind !== 'local_runtime.github.source.request') return;
  const payload = { requestId: request.payload.requestId, status: 'ok' as const,
    repositoryId: '73', defaultBranch: 'develop', cacheKey: 'cache-a',
    workspaceId: `github-session:${sessionId}`,
    workspace: { workspaceId: `github-session:${sessionId}` }
  };
  assert.throws(() => internals.handleMessage({ ...client, deviceId: 'device-b' }, {
    kind: 'local_runtime.github.source.result', payload
  }), /device/);
  internals.handleMessage(client, { kind: 'local_runtime.github.source.result', payload });
  assert.equal((await pending).defaultBranch, 'develop');
  assert.deepEqual(registered, [`github-session:${sessionId}`]);
});

test('normal completion receipts stay silent; concurrent stop receipts notify only once', async () => {
  const persistence = new PersistenceService({ enabled: false });
  const connections = new LocalRuntimeConnectionService(
    new LocalRuntimeAuthService(persistence), new BrokerGateway(() => 'epoch-test'),
    new PendingRequestRegistry(), new HeartbeatTracker(30_000), persistence
  );
  const internals = connections as any;
  const operations = internals.operationStops;
  const transport = { deviceId: 'device', workspaceId: 'workspace', runtimeType: 'codex' };
  const notices: unknown[] = [];
  const receiptLogs: Array<Record<string, unknown>> = [];
  internals.logger = {
    log: (message: string) => receiptLogs.push(JSON.parse(message)),
    warn: () => undefined
  };
  const subscription = connections.stopConfirmations().subscribe(notice => notices.push(notice));
  try {
    await operations.begin({ id: 'operation', sessionId: 'session', phase: 'task_execution' });
    await operations.reserve('session', 'operation', 'normal', { transport });
    await internals.confirmStopReceipt('device', { invocationId: 'normal', ...transport });
    assert.equal(notices.length, 0);
    await operations.reserve('session', 'operation', 'stopped', { transport });
    await operations.settle('session', 'operation', 'stopped', 'unconfirmed', true);
    await internals.confirmStopReceipt('foreign', { invocationId: 'stopped', ...transport });
    assert.equal(operations.hasUnknownStop('session'), true);
    await Promise.all(Array.from({ length: 100 }, () =>
      internals.confirmStopReceipt('device', { invocationId: 'stopped', ...transport })));
    assert.deepEqual(notices, [{ sessionId: 'session', invocationId: 'stopped' }]);
    assert.equal(operations.hasUnknownStop('session'), false);
    await internals.confirmStopReceipt('device', { invocationId: 'stopped', ...transport });
    assert.equal(notices.length, 1);
    assert.equal(receiptLogs.some(log => log.event === 'local_runtime_stop_receipt_ignored' && log.matched === false), true);
    assert.equal(receiptLogs.some(log => log.event === 'local_runtime_stop_receipt_replayed' &&
      log.operationId === 'operation' && log.invocationId === 'stopped'), true);
  } finally { subscription.unsubscribe(); }
});

test('a receipt replay after simulated ACK loss does not duplicate stop state, event, outbox, or notice', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-stop-ack-replay-'));
  const persistence = new PersistenceService({
    enabled: true,
    backend: 'file',
    filePath: join(directory, 'state.json')
  });
  await persistence.initialize();
  const connections = new LocalRuntimeConnectionService(
    new LocalRuntimeAuthService(persistence), new BrokerGateway(() => 'epoch-test'),
    new PendingRequestRegistry(), new HeartbeatTracker(30_000), persistence
  );
  const internals = connections as any;
  const operations = internals.operationStops;
  const stops = new SessionStopStateStore(persistence);
  const transport = { deviceId: 'device', workspaceId: 'workspace', runtimeType: 'codex' as const };
  const notices: unknown[] = [];
  const subscription = connections.stopConfirmations().subscribe(notice => notices.push(notice));
  try {
    await operations.begin({ id: 'operation', sessionId: 'session', phase: 'task_execution' });
    await operations.reserve('session', 'operation', 'stopped', { transport });
    const request = await stops.request('session', 'user_paused');
    await operations.settle('session', 'operation', 'stopped', 'unconfirmed', true);

    assert.equal(await internals.confirmStopReceipt('device', { invocationId: 'stopped', ...transport }), true);
    const committed = stops.summary('session');
    const committedEvents = persistence.getCollection<Record<string, Array<{ id: string; metadata: { idempotencyKey?: string } }>>>(
      'eventsBySession', {}
    ).session;
    const committedOutbox = persistence.getCollection<Array<{ id: string }>>('eventOutbox', []);
    assert.equal(committed.status, 'confirmed');
    assert.equal(committed.version, 3);
    assert.equal(committedEvents.at(-1)?.metadata.idempotencyKey, `runtime-stop:${request.id}:3`);
    assert.equal(notices.length, 1);

    assert.equal(await internals.confirmStopReceipt('device', { invocationId: 'stopped', ...transport }), true);
    assert.equal(stops.summary('session').version, committed.version);
    assert.deepEqual(
      persistence.getCollection<Record<string, Array<{ id: string }>>>('eventsBySession', {}).session.map(event => event.id),
      committedEvents.map(event => event.id)
    );
    assert.deepEqual(
      persistence.getCollection<Array<{ id: string }>>('eventOutbox', []).map(record => record.id),
      committedOutbox.map(record => record.id)
    );
    assert.equal(notices.length, 1);
  } finally {
    subscription.unsubscribe();
    await persistence.onModuleDestroy();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a stop receipt persistence failure is never acknowledged', async () => {
  const persistence = new PersistenceService({ enabled: false });
  const connections = new LocalRuntimeConnectionService(
    new LocalRuntimeAuthService(persistence), new BrokerGateway(() => 'epoch-test'),
    new PendingRequestRegistry(), new HeartbeatTracker(30_000), persistence
  );
  const internals = connections as any;
  const sent: LocalRuntimeServerMessage[] = [];
  const warnings: Array<Record<string, unknown>> = [];
  internals.operationStops.confirmTransportReceipt = async () => {
    throw new Error('isolated receipt commit failure');
  };
  internals.send = (_client: unknown, message: LocalRuntimeServerMessage) => sent.push(message);
  internals.logger = {
    log: () => undefined,
    warn: (message: string) => warnings.push(JSON.parse(message))
  };

  internals.handleMessage({ clientId: 'connection-test', deviceId: 'device', hello: {} }, {
    kind: 'local_runtime.invocation.stopped',
    payload: { invocationId: 'stopped', deviceId: 'device', workspaceId: 'workspace', runtimeType: 'codex' }
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(sent.some(message => message.kind === 'local_runtime.invocation.stop_ack'), false);
  assert.equal(warnings.some(log => log.event === 'local_runtime_stop_receipt_persistence_failed' &&
    log.reason === 'STOP_RECEIPT_PERSISTENCE_FAILED' && log.connectionId === 'connection-test'), true);
});

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

    socket.send(JSON.stringify({
      kind: 'local_runtime.workspace.authorization.prompted',
      payload: {
        requestId: authorizationRequest.payload.requestId,
        promptedAt: '2026-07-24T00:00:00.000Z'
      }
    }));

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

    socket.send(JSON.stringify({
      kind: 'local_runtime.workspace.register',
      payload: {
        workspaceId: 'workspace-remove',
        displayName: 'remove-project',
        capabilities: { read: true, write: true, command: true, test: true },
        revision: { id: 'revision-remove-1', observedAt: '2026-07-24T00:00:00.000Z' },
        permissions: DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY,
        registeredAt: '2026-07-24T00:00:00.000Z'
      }
    }));
    await inbox.next('local_runtime.workspace.registered');
    assert.equal(connections.unregisterWorkspace('workspace-remove'), true);
    assert.equal(connections.getWorkspace('workspace-remove'), undefined);
    assert.equal(gateway.getRegistration('workspace-remove'), undefined);
    assert.equal(connections.unregisterWorkspace('workspace-remove'), false);

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

    const resolvedChangeSet = {
      id: 'resolved-writeback', baseRevision: { id: 'revision-local-1', observedAt: '2026-07-24T00:00:00.000Z' },
      changes: [{ operation: 'delete' as const, path: 'old.txt',
        expectedHash: { algorithm: 'sha256' as const, value: 'a'.repeat(64) } }],
      createdAt: '2026-07-24T00:00:00.000Z'
    };
    const exactGrant = connections.grantWorkspacePermissionOnce(
      'workspace-local-runtime', 'workspace_delete', resolvedChangeSet);
    const exactRequest = await inbox.next('local_runtime.workspace.permission.grant.request');
    assert.deepEqual(exactRequest.payload.writeback, {
      changeSetId: resolvedChangeSet.id,
      digest: createHash('sha256').update(canonicalWorkspaceChangeSetJson(resolvedChangeSet)).digest('hex')
    });
    socket.send(JSON.stringify({ kind: 'local_runtime.workspace.permission.grant.result', payload: {
      requestId: exactRequest.payload.requestId, workspaceId: 'workspace-local-runtime',
      permission: 'workspace_delete', status: 'granted', workspace: {
        workspaceId: 'workspace-local-runtime', displayName: 'local-project',
        capabilities: { read: true, write: true, command: true, test: true },
        revision: { id: 'revision-local-1', observedAt: '2026-07-24T00:00:00.000Z' },
        permissions: { ...DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY, workspace_delete: 'allow' },
        registeredAt: '2026-07-24T00:00:00.000Z'
      }
    } }));
    await exactGrant;
    await inbox.next('local_runtime.workspace.registered');

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

    const stoppedFirstPlan = {
      ...plan,
      invocationId: 'invocation-stopped-before-result',
      sessionId: 'session-stopped-before-result'
    };
    const stoppedFirstHandle = connections.startInvocation(stoppedFirstPlan);
    await inbox.next('local_runtime.invocation.start');
    socket.send(JSON.stringify({
      kind: 'local_runtime.invocation.stopped',
      payload: {
        invocationId: stoppedFirstPlan.invocationId,
        workspaceId: 'workspace-local-runtime',
        runtimeType: 'codex'
      }
    }));
    assert.equal((await inbox.next('local_runtime.invocation.stop_ack')).payload.invocationId, stoppedFirstPlan.invocationId);
    const stoppedFirstResult = await stoppedFirstHandle.result;
    assert.equal(stoppedFirstResult.status, 'cancelled');
    assert.equal(stoppedFirstResult.termination?.diagnosticRef, 'local_runtime_stopped_without_result');

    socket.send(JSON.stringify({
      kind: 'local_runtime.invocation.result',
      payload: {
        workspaceId: 'workspace-local-runtime',
        workspaceRevision: { id: 'revision-late-result-ignored', observedAt: '2026-07-24T00:03:30.000Z' },
        result: {
          invocationId: stoppedFirstPlan.invocationId,
          runtimeType: 'codex',
          status: 'completed',
          output: {
            schemaVersion: '1.0',
            kind: 'agent_message',
            messageKind: 'answer',
            content: 'this late business result must be ignored',
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
            capturedAt: '2026-07-24T00:03:30.000Z',
            invocationId: stoppedFirstPlan.invocationId
          },
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'codex' }
        }
      }
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
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

test('a silent Local Runtime invocation is retained until explicit cancellation, with trusted stop receipts', async () => {
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
    deviceId: 'device-idle',
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
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/local-runtime`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` }
  });
  const inbox = new LocalRuntimeMessageInbox(socket);
  const previousIdleTimeout = process.env.LOCAL_RUNTIME_IDLE_TIMEOUT_MS;
  const previousStopTimeout = process.env.LOCAL_RUNTIME_STOP_ACK_TIMEOUT_MS;
  process.env.LOCAL_RUNTIME_IDLE_TIMEOUT_MS = '60';

  try {
    await once(socket, 'open');
    socket.send(JSON.stringify({
      kind: 'local_runtime.hello',
      payload: {
        deviceId: 'device-idle',
        cliVersion: '0.1.0',
        protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
        runtimes: { codex: 'codex-cli 1.0.0' }
      }
    }));
    await inbox.next('local_runtime.connected');
    socket.send(JSON.stringify({
      kind: 'local_runtime.workspace.register',
      payload: {
        workspaceId: 'workspace-idle',
        displayName: 'local-project',
        capabilities: { read: true, write: true, command: true, test: true },
        revision: { id: 'revision-idle-1', observedAt: '2026-08-27T00:00:00.000Z' },
        permissions: DEFAULT_LOCAL_RUNTIME_PERMISSION_POLICY,
        registeredAt: '2026-08-27T00:00:00.000Z'
      }
    }));
    await inbox.next('local_runtime.workspace.registered');

    const plan = makeInvocationPlan({
      invocationId: 'invocation-idle',
      sessionId: 'session-idle',
      phase: 'discussion',
      executionTarget: {
        runtimeType: 'codex',
        workspaceProviderKind: 'local_bridge',
        executionLocation: 'local'
      },
      contextEnvelope: {
        workspaceId: 'workspace-idle',
        L0: {
          workspace: {
            workspaceId: 'workspace-idle',
            rootName: 'local-project',
            providerKind: 'local_bridge',
            revision: { id: 'revision-idle-1', observedAt: '2026-08-27T00:00:00.000Z' }
          }
        }
      }
    });
    // The CLI stays connected and simply never answers, which is the shape that used to
    // leave the invocation promise unsettled forever.
    const handle = connections.startInvocation(plan);
    await inbox.next('local_runtime.invocation.start');

    await new Promise(resolve => setTimeout(resolve, 110));
    assert.equal(inbox.count('local_runtime.invocation.cancel'), 0, 'silence does not cancel the original request');
    const cancelling = handle.cancel();
    const stop = await inbox.next('local_runtime.invocation.cancel');
    assert.equal(stop.payload.invocationId, plan.invocationId);
    let settled = false;
    void handle.result.then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'sending cancel must not count as a stopped process');
    socket.send(JSON.stringify({ kind: 'local_runtime.invocation.result', payload: {
      workspaceId: 'workspace-idle', workspaceRevision: { id: 'revision-idle-1', observedAt: new Date().toISOString() },
      result: { invocationId: plan.invocationId, runtimeType: 'codex', status: 'cancelled',
        output: {}, events: [], artifacts: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
    } }));
    const result = await handle.result;
    await cancelling;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.termination?.kind, 'user_cancelled');
    process.env.LOCAL_RUNTIME_STOP_ACK_TIMEOUT_MS = '25';
    const unconfirmedPlan = { ...plan, invocationId: 'invocation-unconfirmed' };
    const unconfirmedHandle = connections.startInvocation(unconfirmedPlan);
    await inbox.next('local_runtime.invocation.start');
    await unconfirmedHandle.cancel();
    await inbox.next('local_runtime.invocation.cancel');
    const unconfirmedResult = await unconfirmedHandle.result;
    assert.equal(unconfirmedResult.error?.details?.stopUnconfirmed, true);
    assert.equal(connections.hasUnconfirmedStops(plan.sessionId), true);
    assert.equal(connections.hasUnconfirmedStops('another-session'), false);
    const confirmedReceipt = firstValueFrom(connections.stopConfirmations());
    socket.send(JSON.stringify({ kind: 'local_runtime.invocation.stopped', payload: {
      invocationId: unconfirmedPlan.invocationId, workspaceId: 'foreign-workspace', runtimeType: 'codex'
    } }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(inbox.count('local_runtime.invocation.stop_ack'), 0, 'a foreign receipt must not be acknowledged');
    assert.equal(connections.hasUnconfirmedStops(plan.sessionId), true, 'a foreign workspace cannot release the barrier');
    socket.send(JSON.stringify({ kind: 'local_runtime.invocation.stopped', payload: {
      invocationId: unconfirmedPlan.invocationId, workspaceId: 'workspace-idle', runtimeType: 'codex'
    } }));
    await inbox.next('local_runtime.invocation.stop_ack');
    assert.equal((await confirmedReceipt).sessionId, plan.sessionId);
    assert.equal(connections.hasUnconfirmedStops(plan.sessionId), false);
    socket.send(JSON.stringify({ kind: 'local_runtime.invocation.result', payload: {
      workspaceId: 'workspace-idle', workspaceRevision: { id: 'late-revision', observedAt: new Date().toISOString() },
      result: { invocationId: unconfirmedPlan.invocationId, runtimeType: 'codex', status: 'completed', output: {} }
    } }));
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(connections.hasUnconfirmedStops(plan.sessionId), false);
    assert.equal(connections.getWorkspace('workspace-idle')?.revision.id, 'revision-idle-1', 'late business result must not be applied');
  } finally {
    if (previousStopTimeout === undefined) delete process.env.LOCAL_RUNTIME_STOP_ACK_TIMEOUT_MS;
    else process.env.LOCAL_RUNTIME_STOP_ACK_TIMEOUT_MS = previousStopTimeout;
    if (previousIdleTimeout === undefined) delete process.env.LOCAL_RUNTIME_IDLE_TIMEOUT_MS;
    else process.env.LOCAL_RUNTIME_IDLE_TIMEOUT_MS = previousIdleTimeout;
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

test('an incompatible hello is reported and is never considered connected', async () => {
  const persistence = new PersistenceService({ enabled: false });
  const auth = new LocalRuntimeAuthService(persistence);
  const connections = new LocalRuntimeConnectionService(
    auth, new BrokerGateway(() => 'epoch-test'), new PendingRequestRegistry(), new HeartbeatTracker(30_000), persistence
  );
  const token = auth.authorizeTrustedDevice({
    deviceId: 'device-downgraded', displayName: 'old-runtime', cliVersion: '0.1.0',
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION, runtimes: {}
  });
  const server = createServer();
  connections.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/local-runtime`, {
    headers: { Authorization: `Bearer ${token.accessToken}` }
  });
  const inbox = new LocalRuntimeMessageInbox(socket);
  try {
    await once(socket, 'open');
    socket.send(JSON.stringify({ kind: 'local_runtime.hello', payload: {
      deviceId: 'device-downgraded', cliVersion: '0.1.0',
      protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION - 1, runtimes: {}
    } }));
    const error = await inbox.next('local_runtime.protocol.error');
    assert.equal(error.payload.code, 'LOCAL_RUNTIME_PROTOCOL_INCOMPATIBLE');
    assert.equal(error.payload.compatibility?.compatible, false);
    await once(socket, 'close');
    assert.equal(connections.isDeviceConnected('device-downgraded'), false);
  } finally {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
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

  count(kind: LocalRuntimeServerMessage['kind']) {
    return this.messages.filter((message) => message.kind === kind).length;
  }
}

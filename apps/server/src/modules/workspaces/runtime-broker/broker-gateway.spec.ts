import assert from 'node:assert/strict';
import test from 'node:test';
import { BrokerGateway, type BrokerClient } from './broker-gateway.js';

function fakeClient(id = 'client-1'): { client: BrokerClient; sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    client: { clientId: id, send: (payload) => sent.push(payload) }
  };
}

test('BrokerGateway registers a workspace from a client and returns the registration', () => {
  const gateway = new BrokerGateway(() => 'epoch-test');
  const { client } = fakeClient();
  const registration = gateway.registerWorkspace(client, {
    clientId: 'client-1',
    workspaceId: 'ws-96',
    providerKind: 'local_bridge',
    capabilities: { read: true, write: false, command: false, test: false },
    displayName: 'demo-repo',
    now: '2026-07-11T00:00:00.000Z'
  });
  assert.equal(registration.workspaceId, 'ws-96');
  assert.equal(gateway.getRegistration('ws-96')?.clientId, 'client-1');
});

test('BrokerGateway resolves registration waiters when a Local Runtime workspace connects', async () => {
  const gateway = new BrokerGateway(() => 'epoch-test');
  const { client } = fakeClient();
  const waiting = gateway.waitForRegistration('ws-96');

  const registration = gateway.registerWorkspace(client, {
    clientId: 'client-1',
    workspaceId: 'ws-96',
    providerKind: 'local_bridge',
    capabilities: { read: true, write: true, command: false, test: false },
    displayName: 'demo'
  });

  assert.strictEqual(await waiting, registration);
});

test('BrokerGateway returns an existing registration without waiting', async () => {
  const gateway = new BrokerGateway(() => 'epoch-test');
  const { client } = fakeClient();
  const registration = gateway.registerWorkspace(client, {
    clientId: 'client-1',
    workspaceId: 'ws-96',
    providerKind: 'local_bridge',
    capabilities: { read: true, write: true, command: false, test: false },
    displayName: 'demo'
  });

  assert.strictEqual(await gateway.waitForRegistration('ws-96'), registration);
});

test('BrokerGateway rejects duplicate workspaceId registrations', () => {
  const gateway = new BrokerGateway(() => 'epoch-test');
  const { client } = fakeClient();
  gateway.registerWorkspace(client, {
    clientId: 'client-1',
    workspaceId: 'ws-96',
    providerKind: 'local_bridge',
    capabilities: { read: true, write: true, command: false, test: false },
    displayName: 'demo'
  });
  assert.throws(
    () => gateway.registerWorkspace(client, {
      clientId: 'client-2',
      workspaceId: 'ws-96',
      providerKind: 'local_bridge',
      capabilities: { read: true, write: true, command: false, test: false },
      displayName: 'other'
    }),
    /ws-96/
  );
});

test('BrokerGateway refreshes a workspace for the owning client without unregistering it', () => {
  const gateway = new BrokerGateway(() => 'epoch-test');
  const { client } = fakeClient();
  gateway.registerWorkspace(client, {
    clientId: 'client-1',
    workspaceId: 'local-ws',
    providerKind: 'local_bridge',
    capabilities: { read: true, write: false, command: false, test: true },
    displayName: 'local'
  });

  const refreshed = gateway.refreshWorkspace(client, {
    clientId: 'client-1',
    workspaceId: 'local-ws',
    providerKind: 'local_bridge',
    capabilities: { read: true, write: true, command: true, test: true },
    displayName: 'local-updated'
  });

  assert.equal(refreshed.displayName, 'local-updated');
  assert.equal(refreshed.capabilities.command, true);
  assert.strictEqual(gateway.getRegistration('local-ws'), refreshed);
});

test('BrokerGateway dispatch forwards operation requests to the owning client', () => {
  const gateway = new BrokerGateway(() => 'epoch-test');
  const { client, sent } = fakeClient();
  gateway.registerWorkspace(client, {
    clientId: 'client-1',
    workspaceId: 'ws-96',
    providerKind: 'local_bridge',
    capabilities: { read: true, write: false, command: false, test: false },
    displayName: 'demo'
  });
  gateway.dispatch({
    requestId: '00000000-0000-4000-8000-000000000096',
    invocationId: '00000000-0000-4000-8000-000000000196',
    workspaceId: 'ws-96',
    operation: 'readFile',
    input: { path: 'src/index.ts' }
  });
  assert.equal(sent.length, 1);
  const message = sent[0] as { kind: string; payload: { operation: string } };
  assert.equal(message.kind, 'workspace.operation.request');
  assert.equal(message.payload.operation, 'readFile');
});

test('BrokerGateway detachClient drops registrations belonging to the disconnected client', () => {
  const gateway = new BrokerGateway(() => 'epoch-test');
  const { client } = fakeClient();
  gateway.registerWorkspace(client, {
    clientId: 'client-1',
    workspaceId: 'ws-96',
    providerKind: 'local_bridge',
    capabilities: { read: true, write: false, command: false, test: false },
    displayName: 'demo'
  });
  gateway.detachClient('client-1');
  assert.equal(gateway.getRegistration('ws-96'), undefined);
});

test('BrokerGateway only lets the owning client unregister a workspace', () => {
  const gateway = new BrokerGateway(() => 'epoch-test');
  const { client } = fakeClient();
  gateway.registerWorkspace(client, {
    clientId: 'client-1',
    workspaceId: 'ws-96',
    providerKind: 'local_bridge',
    capabilities: { read: true, write: true, command: false, test: false },
    displayName: 'demo'
  });
  assert.equal(gateway.unregisterWorkspace('client-2', 'ws-96'), false);
  assert.ok(gateway.getRegistration('ws-96'));
  assert.equal(gateway.unregisterWorkspace('client-1', 'ws-96'), true);
  assert.equal(gateway.getRegistration('ws-96'), undefined);
});

test('BrokerGateway dispatch throws when no client is registered for the workspace', () => {
  const gateway = new BrokerGateway(() => 'epoch-test');
  assert.throws(
    () => gateway.dispatch({
      requestId: '00000000-0000-4000-8000-000000000097',
      invocationId: '00000000-0000-4000-8000-000000000197',
      workspaceId: 'missing',
      operation: 'getRevision'
    }),
    /missing/
  );
});

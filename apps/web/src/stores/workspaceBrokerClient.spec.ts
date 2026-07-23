import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceBrokerClient } from './workspaceBrokerClient';

test('WorkspaceBrokerClient tracks connection state transitions with attempt counter', () => {
  const client = new WorkspaceBrokerClient();
  assert.equal(client.snapshot().connection, 'idle');
  client.connect();
  assert.equal(client.snapshot().connection, 'connecting');
  assert.equal(client.snapshot().attempt, 1);
  client.markConnected();
  assert.equal(client.snapshot().connection, 'connected');
});

test('WorkspaceBrokerClient registers workspaces only when connected', () => {
  const client = new WorkspaceBrokerClient();
  assert.throws(
    () => client.registerWorkspace({ workspaceId: 'ws-100', displayName: 'demo', registeredAt: '2026-07-11T00:00:00.000Z' }),
    /idle/
  );
  client.connect();
  client.markConnected();
  client.registerWorkspace({ workspaceId: 'ws-100', displayName: 'demo', registeredAt: '2026-07-11T00:00:00.000Z' });
  assert.deepEqual(
    client.snapshot().registered.map((r) => r.workspaceId),
    ['ws-100']
  );
});

test('WorkspaceBrokerClient reRegisterOnReconnect returns the previously registered workspaces', () => {
  const client = new WorkspaceBrokerClient();
  client.connect();
  client.markConnected();
  client.registerWorkspace({ workspaceId: 'a', displayName: 'A', registeredAt: 't1' });
  client.registerWorkspace({ workspaceId: 'b', displayName: 'B', registeredAt: 't2' });
  client.markDisconnected('network');
  assert.equal(client.snapshot().lastError, 'network');
  client.connect();
  client.markConnected();
  const workspaces = client.reRegisterOnReconnect().map((w) => w.workspaceId).sort();
  assert.deepEqual(workspaces, ['a', 'b']);
  assert.equal(client.snapshot().attempt, 2);
});

test('WorkspaceBrokerClient clearWorkspace removes an entry from future re-registration', () => {
  const client = new WorkspaceBrokerClient();
  client.connect();
  client.markConnected();
  client.registerWorkspace({ workspaceId: 'a', displayName: 'A', registeredAt: 't1' });
  client.clearWorkspace('a');
  assert.deepEqual(client.snapshot().registered, []);
});

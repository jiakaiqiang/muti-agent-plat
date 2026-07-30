import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { SessionDetail } from '@agent-cluster/shared';
import { BrokerGateway } from '../workspaces/runtime-broker/broker-gateway.js';
import { assertCurrentDataEpoch, filterSessionsForDataEpoch } from './data-epoch-guard.js';
import { PersistenceService } from './persistence.service.js';

const repositoryRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

function currentState(dataEpoch = 'epoch-current') {
  return {
    systemDataMetadata: {
      dataSchemaVersion: 3,
      dataEpoch,
      pipelineVersion: 'v2',
      cutoverAt: '2026-07-12T12:00:00.000Z',
      cutoverAuditId: 'audit-current'
    }
  };
}

test('PersistenceService exposes the current schema-v3 dataEpoch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-cluster-epoch-'));
  const filePath = join(directory, 'state.json');
  writeFileSync(filePath, JSON.stringify(currentState('epoch-a')), 'utf8');
  try {
    const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath });
    await persistence.initialize();
    assert.equal(persistence.currentDataEpoch(), 'epoch-a');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('schema-v3 startup gate rejects schema-v2 state without migration', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-cluster-epoch-'));
  const filePath = join(directory, 'state.json');
  writeFileSync(
    filePath,
    JSON.stringify({
      ...currentState('epoch-old'),
      systemDataMetadata: {
        ...currentState('epoch-old').systemDataMetadata,
        dataSchemaVersion: 2
      }
    }),
    'utf8'
  );
  try {
    const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath });
    await persistence.initialize();
    assert.throws(() => persistence.assertCurrentDataReady(), /CUTOVER_REQUIRED/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('currentDataEpoch refuses state without cutover metadata', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-cluster-epoch-'));
  const filePath = join(directory, 'state.json');
  writeFileSync(filePath, '{}', 'utf8');
  try {
    const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath });
    await persistence.initialize();
    assert.throws(() => persistence.currentDataEpoch(), /CUTOVER_REQUIRED/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('dataEpoch guard accepts only an exact epoch match', () => {
  assert.doesNotThrow(() => assertCurrentDataEpoch('epoch-a', 'epoch-a', 'queue job'));
});

test('dataEpoch guard rejects stale execution state', () => {
  assert.throws(() => assertCurrentDataEpoch('epoch-a', 'epoch-old', 'queue job'), /STALE_DATA_EPOCH/);
});

test('Recovery filtering returns only Sessions from the current epoch', () => {
  const sessions = [
    { id: 'current', dataEpoch: 'epoch-a' },
    { id: 'stale', dataEpoch: 'epoch-old' }
  ] as SessionDetail[];
  assert.deepEqual(filterSessionsForDataEpoch(sessions, 'epoch-a').map((session) => session.id), ['current']);
});

test('Local Runtime workspace registrations are stamped with the current epoch', () => {
  const gateway = new BrokerGateway(() => 'epoch-a');
  const client = { clientId: 'client-1', send: () => undefined };
  const registration = gateway.registerWorkspace(client, {
    clientId: client.clientId,
    workspaceId: 'workspace-1',
    providerKind: 'local_bridge',
    capabilities: { read: true, write: false, command: false, test: false },
    displayName: 'Workspace'
  });
  assert.equal(registration.dataEpoch, 'epoch-a');
});

test('Local Runtime broker rejects dispatch through a registration from an old epoch', () => {
  let epoch = 'epoch-a';
  const sent: unknown[] = [];
  const gateway = new BrokerGateway(() => epoch);
  const client = { clientId: 'client-1', send: (payload: unknown) => sent.push(payload) };
  gateway.registerWorkspace(client, {
    clientId: client.clientId,
    workspaceId: 'workspace-1',
    providerKind: 'local_bridge',
    capabilities: { read: true, write: false, command: false, test: false },
    displayName: 'Workspace'
  });
  epoch = 'epoch-b';
  assert.throws(
    () => gateway.dispatch({
      requestId: 'request-1',
      invocationId: 'invocation-1',
      workspaceId: 'workspace-1',
      operation: 'capabilities'
    }),
    /STALE_DATA_EPOCH/
  );
  assert.deepEqual(sent, []);
});

test('maintenance invalidates all Local Runtime broker registrations and notifies clients', () => {
  const sent: unknown[] = [];
  const gateway = new BrokerGateway(() => 'epoch-a');
  const client = { clientId: 'client-1', send: (payload: unknown) => sent.push(payload) };
  gateway.registerWorkspace(client, {
    clientId: client.clientId,
    workspaceId: 'workspace-1',
    providerKind: 'local_bridge',
    capabilities: { read: true, write: false, command: false, test: false },
    displayName: 'Workspace'
  });
  gateway.invalidateAll('maintenance');
  assert.deepEqual(gateway.listRegistrations(), []);
  assert.deepEqual(sent, [{ kind: 'workspace.registration.invalidated', payload: { reason: 'maintenance' } }]);
});

test('Session and Queue contracts carry dataEpoch as a required field', () => {
  const contracts = readFileSync(resolve(repositoryRoot, 'packages/shared/src/contracts.ts'), 'utf8');
  const queue = readFileSync(resolve(repositoryRoot, 'apps/server/src/modules/queue/execution.queue.ts'), 'utf8');
  assert.match(contracts, /type SessionDetail = \{[\s\S]*?dataEpoch: UUID;/);
  assert.match(queue, /type ExecutionJobData = \{[\s\S]*?dataEpoch: string;/);
});

test('Session creation, Queue worker, and Recovery all enforce the current epoch', () => {
  const sessions = readFileSync(resolve(repositoryRoot, 'apps/server/src/modules/sessions/sessions.service.ts'), 'utf8');
  const worker = readFileSync(resolve(repositoryRoot, 'apps/server/src/modules/queue/execution.worker.ts'), 'utf8');
  const recovery = readFileSync(resolve(repositoryRoot, 'apps/server/src/modules/recovery/recovery.service.ts'), 'utf8');
  assert.match(sessions, /assertWritable\(\)[\s\S]*?currentDataEpoch\(\)/);
  assert.match(worker, /assertCurrentDataEpoch/);
  assert.match(recovery, /filterSessionsForDataEpoch/);
});

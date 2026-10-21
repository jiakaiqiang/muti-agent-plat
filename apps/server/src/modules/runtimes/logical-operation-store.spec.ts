import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistenceService } from '../persistence/persistence.service.js';
import { LogicalOperationStore, operationPolicy } from './logical-operation-store.js';
import { SessionStopStateStore } from './session-stop-state-store.js';

function withEnv(name: string, value: string | undefined, fn: () => void) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { fn(); } finally {
    if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
  }
}

async function restrictedFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'restricted-routing-'));
  const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath: join(directory, 'state.json') });
  t.after(async () => { await persistence.onModuleDestroy(); rmSync(directory, { recursive: true, force: true }); });
  await persistence.initialize();
  const session = { id: 'session', status: 'PAUSED', dataEpoch: 'epoch' };
  const lifecycle = { contractVersion: 'main-agent-collaboration/v1', sessionId: 'session', dataEpoch: 'epoch',
    generation: 2, revision: 5, state: 'active', admission: 'closed', stopStatus: 'confirmed' };
  await persistence.setCollection('sessions', [session]);
  await persistence.setCollection('sessionLifecyclesBySession', { session: lifecycle });
  const store = new LogicalOperationStore(persistence);
  const input = { id: 'routing', sessionId: 'session', phase: 'user_message_routing' as const,
    admissionClass: 'routing' as const, dataEpoch: 'epoch' };
  return { persistence, session, lifecycle, store, input };
}

test('restricted routing survives a paused session without reopening business admission or its budget', async (t) => {
  const { persistence, lifecycle, store, input } = await restrictedFixture(t);
  const operation = await store.begin(input);
  await store.reserve('session', operation.id, 'classify', { admissionClass: 'routing', executionKind: 'internal' });
  assert.equal(await store.reserveCorrection('session', operation.id), true);
  await store.settle('session', operation.id, 'classify');
  const restored = new LogicalOperationStore(persistence);
  const replay = await restored.begin(input);
  assert.equal(replay.attemptsUsed, 1);
  assert.equal(replay.deadlineAt, operation.deadlineAt);
  assert.deepEqual(persistence.getCollection<Record<string, unknown>>('sessionLifecyclesBySession', {}).session, lifecycle);
  await assert.rejects(restored.begin({ ...input, id: 'business', admissionClass: 'business' }), /SESSION_ADMISSION_CLOSED/);
  await assert.rejects(restored.reserve('session', operation.id, 'forged-business'), /ADMISSION_MISMATCH/);
  await restored.reserve('session', operation.id, 'repair', { admissionClass: 'routing', executionKind: 'internal' });
  await restored.settle('session', operation.id, 'repair');
  await assert.rejects(restored.reserve('session', operation.id, 'third', { admissionClass: 'routing' }), /BUDGET_EXHAUSTED/);
});

test('restricted routing rechecks archive, epoch, generation and unknown stop before reserve', async (t) => {
  for (const change of ['archive', 'epoch', 'generation', 'deleted', 'unknown'] as const) {
    const { persistence, session, lifecycle, store, input } = await restrictedFixture(t);
    await store.begin(input);
    if (change === 'archive') await persistence.setCollection('sessions', [{ ...session, archivedAt: new Date().toISOString() }]);
    if (change === 'epoch') await persistence.setCollection('sessions', [{ ...session, dataEpoch: 'new-epoch' }]);
    if (change === 'generation') await persistence.setCollection('sessionLifecyclesBySession', { session: { ...lifecycle, generation: 3 } });
    if (change === 'deleted') await persistence.setCollection('sessionLifecyclesBySession', { session: { ...lifecycle, state: 'deleted' } });
    if (change === 'unknown') await persistence.setCollection('sessionLifecyclesBySession', { session: { ...lifecycle, stopStatus: 'unknown' } });
    await assert.rejects(store.reserve('session', 'routing', 'late', { admissionClass: 'routing' }), /ADMISSION_CLOSED|STOP_UNCONFIRMED/, change);
    assert.equal(store.list('session')[0].attemptsUsed, 0);
  }
});

test('targeted correction stop preserves unknown process evidence and blocks restricted classification until confirmation', async t => {
  const { persistence, store, input } = await restrictedFixture(t);
  const previous = await store.begin(input);
  for (const stopState of ['unconfirmed', 'requested'] as const) {
    await persistence.setCollection('logicalOperationsBySession', { session: [{ ...previous, id: 'old-business',
      phase: 'task_execution', admissionClass: 'business', activeInvocationId: 'unknown-process',
      invocationIds: ['unknown-process'], stopState, status: 'interrupted' }] });
    await store.requestIntentStop('session', ['unknown-process']);
    assert.equal(store.list('session')[0].stopState, stopState);
    await assert.rejects(store.begin({ ...input, id: 'new-classification' }), /OPERATION_STOP_UNCONFIRMED/);
  }
});

test('restricted routing rejects execution phases, task bindings and stale epoch at begin', async (t) => {
  const { store, input } = await restrictedFixture(t);
  await assert.rejects(store.begin({ ...input, phase: 'task_execution' }), /ROUTING_ADMISSION_INVALID/);
  await assert.rejects(store.begin({ ...input, taskId: 'task' }), /ROUTING_ADMISSION_INVALID/);
  await assert.rejects(store.begin({ ...input, dataEpoch: 'other' }), /SESSION_ADMISSION_CLOSED/);
  assert.equal(store.list('session').length, 0);
});

test('absolute routing deadline can tighten but cannot expand across retry, pause or store restart', async () => {
  const persistence = new PersistenceService({ enabled: false });
  let now = 1000;
  const store = new LogicalOperationStore(persistence, () => now);
  const input = { id: 'bounded', sessionId: 'session', phase: 'user_message_routing' as const,
    deadlineCeilingAt: new Date(3000).toISOString() };
  const original = await store.begin(input);
  assert.equal(Date.parse(original.deadlineAt), 3000);
  await assert.rejects(store.begin({ ...input, id: 'invalid', deadlineCeilingAt: 'invalid-date' }), /OPERATION_DEADLINE_INVALID/);
  await store.reserve('session', input.id, 'first', { executionKind: 'internal' });
  now = 1500;
  await store.settle('session', input.id, 'first', 'confirmed', true);
  now = 2000;
  const restored = new LogicalOperationStore(persistence, () => now);
  const replay = await restored.begin({ ...input, deadlineCeilingAt: new Date(100_000).toISOString() });
  assert.equal(Date.parse(replay.deadlineAt), 3000);
  assert.equal(Date.parse(replay.deadlineCeilingAt!), 3000);
  assert.equal(Date.parse((await restored.resume('session', input.id)).deadlineAt), 3000);
  const tightened = await restored.begin({ ...input, deadlineCeilingAt: new Date(2500).toISOString() });
  assert.equal(Date.parse(tightened.deadlineAt), 2500);
  assert.equal(tightened.attemptsUsed, 1);
  now = 2501;
  await assert.rejects(restored.reserve('session', input.id, 'too-late'), /OPERATION_BUDGET_EXHAUSTED/);
});

test('absolute wall deadline expiry prevents resuming even with remaining active time', async () => {
  const persistence = new PersistenceService({ enabled: false });
  let now = 1000;
  const store = new LogicalOperationStore(persistence, () => now);
  await store.begin({ id: 'paused', sessionId: 'session', phase: 'user_message_routing', deadlineCeilingAt: new Date(2000).toISOString() });
  await store.reserve('session', 'paused', 'first');
  await store.settle('session', 'paused', 'first', 'confirmed', true);
  now = 2500;
  await assert.rejects(store.resume('session', 'paused'), /OPERATION_BUDGET_EXHAUSTED/);
});

test('an active control call keeps one correction after deadline but cannot start another attempt', async () => {
  const persistence = new PersistenceService({ enabled: false });
  let now = 1_000;
  const store = new LogicalOperationStore(persistence, () => now);
  const operation = await store.begin({ id: 'late-correction', sessionId: 'session', phase: 'task_acceptance' });
  await store.reserve('session', operation.id, 'active', { executionKind: 'internal' });
  now = Date.parse(operation.deadlineAt) + 1;
  assert.equal(await store.reserveCorrection('session', operation.id), true);
  assert.equal(await store.reserveCorrection('session', operation.id), false);
  await store.settle('session', operation.id, 'active', 'confirmed');
  await assert.rejects(store.reserve('session', operation.id, 'retry'), /OPERATION_BUDGET_EXHAUSTED/);
  const inactive = await store.begin({ id: 'inactive', sessionId: 'session', phase: 'task_acceptance' });
  now = Date.parse(inactive.deadlineAt) + 1;
  assert.equal(await store.reserveCorrection('session', inactive.id), false);
});

test('task acceptance uses a configurable phase budget instead of the old hard-coded 120 seconds', () => {
  withEnv('PHASE_TIMEOUT_TASK_ACCEPTANCE_MS', '240000', () => {
    assert.equal(operationPolicy('task_acceptance').timeoutMs, 240_000);
    assert.deepEqual(operationPolicy('task_acceptance').diagnostics, []);
  });
  withEnv('PHASE_TIMEOUT_TASK_ACCEPTANCE_MS', undefined, () => {
    assert.equal(operationPolicy('task_acceptance').timeoutMs, 300_000);
  });
  withEnv('PHASE_TIMEOUT_TASK_ACCEPTANCE_MS', '0', () => {
    const policy = operationPolicy('task_acceptance');
    assert.equal(policy.timeoutMs, 300_000);
    assert.deepEqual(policy.diagnostics, ['INVALID_OR_DISABLED_PHASE_TIMEOUT_USING_FINITE_DEFAULT']);
  });
});

test('pause keeps unused active time and only a matching receipt releases the barrier', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'operation-pause-'));
  const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath: join(directory, 'state.json') });
  await persistence.initialize();
  let now = 1_000;
  try {
    const store = new LogicalOperationStore(persistence, () => now);
    await store.begin({ id: 'op', sessionId: 'session', phase: 'user_message_routing' });
    const transport = { deviceId: 'device', workspaceId: 'workspace', runtimeType: 'codex' as const };
    await store.reserve('session', 'op', 'call', { transport, outputContractKey: 'agent_message@1.0' });
    now += 30_000;
    await store.settle('session', 'op', 'call', 'confirmed', true);
    now += 500_000;
    const resumed = await store.resume('session', 'op');
    assert.equal(Date.parse(resumed.deadlineAt) - now, 90_000);
    assert.equal(await store.reserveCorrection('session', 'op'), true);
    assert.equal(await new LogicalOperationStore(persistence, () => now).reserveCorrection('session', 'op'), false);
    await assert.rejects(store.resume('session', 'op'), /NOT_PAUSED/);
    await assert.rejects(store.reserve('session', 'op', 'next', { outputContractKey: 'agent_message@2.0' }), /VERSION_CHANGED/);
    await store.reserve('session', 'op', 'next', { transport });
    await store.settle('session', 'op', 'next', 'unconfirmed');
    assert.equal(await store.confirmTransportResult('next', { ...transport, deviceId: 'foreign' }), false);
    assert.equal(store.hasUnknownStop('session'), true);
    assert.equal(await store.confirmTransportResult('next', transport), true);
    assert.equal(store.hasUnknownStop('session'), false);
    const duplicate = await store.confirmTransportReceipt('next', transport);
    assert.equal(duplicate.confirmed, true);
    assert.equal(duplicate.alreadyConfirmed, true);
  } finally { await persistence.onModuleDestroy(); rmSync(directory, { recursive: true, force: true }); }
});

test('stop requests freeze targets, block reserve, and advance monotonically on trusted settlement', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'session-stop-state-'));
  const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath: join(directory, 'state.json') });
  await persistence.initialize();
  let now = 10_000;
  try {
    const operations = new LogicalOperationStore(persistence, () => now);
    const stops = new SessionStopStateStore(persistence, () => now);
    await operations.begin({ id: 'op-1', sessionId: 'session', phase: 'task_execution' });
    await operations.reserve('session', 'op-1', 'call-1');

    const requested = await stops.request('session', 'user_paused', ['call-1']);
    const repeated = await stops.request('session', 'user_paused', ['unrelated-call']);
    assert.equal(repeated.id, requested.id);
    assert.deepEqual(repeated.targetInvocationIds, ['call-1']);
    assert.equal(stops.summary('session').version, 1);
    assert.equal(persistence.getCollection<Record<string, unknown[]>>('eventsBySession', {}).session.length, 1);
    assert.equal(persistence.getCollection<unknown[]>('eventOutbox', []).length, 1);

    await operations.begin({ id: 'op-2', sessionId: 'session', phase: 'task_execution' });
    await assert.rejects(operations.reserve('session', 'op-2', 'call-2'), /STOP_UNCONFIRMED/);

    now += 100;
    await operations.settle('session', 'op-1', 'call-1', 'confirmed', true);
    const confirmed = stops.summary('session');
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.version, 2);
    assert.equal(confirmed.canResume, true);
    assert.equal(persistence.getCollection<Record<string, unknown[]>>('eventsBySession', {}).session.length, 2);
    assert.equal(persistence.getCollection<unknown[]>('eventOutbox', []).length, 2);
    await operations.reserve('session', 'op-2', 'call-2');

    const next = await stops.request('session', 'second_stop', ['call-2']);
    assert.notEqual(next.id, requested.id);
    assert.deepEqual(next.targetInvocationIds, ['call-2']);
  } finally { await persistence.onModuleDestroy(); rmSync(directory, { recursive: true, force: true }); }
});

test('a zero-target stop request is confirmed immediately', async () => {
  const persistence = new PersistenceService({ enabled: false });
  await persistence.initialize();
  const stops = new SessionStopStateStore(persistence);
  const request = await stops.request('empty-session', 'user_paused');
  assert.equal(request.status, 'confirmed');
  assert.equal(stops.summary('empty-session').canResume, true);
});

test('a persisted stopped Session blocks reserve after a zero-target stop until explicit resume', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'operation-session-stop-'));
  const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath: join(directory, 'state.json') });
  await persistence.initialize();
  const now = new Date().toISOString();
  try {
    await persistence.setCollection('sessions', [{
      id: 'session', title: 'Stopped session', status: 'PAUSED', ownerId: 'test', createdAt: now, updatedAt: now
    }]);
    const operations = new LogicalOperationStore(persistence);
    const stops = new SessionStopStateStore(persistence);
    await operations.begin({ id: 'op', sessionId: 'session', phase: 'task_execution' });
    assert.equal((await stops.request('session', 'user_paused')).status, 'confirmed');
    await assert.rejects(operations.reserve('session', 'op', 'call-during-pause'), /STOP_UNCONFIRMED/);

    await persistence.setCollection('sessions', [{
      id: 'session', title: 'Stopped session', status: 'EXECUTING', ownerId: 'test', createdAt: now, updatedAt: now
    }]);
    await operations.reserve('session', 'op', 'call-after-resume');
  } finally {
    await persistence.onModuleDestroy();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('attempt allowance and deadline survive retries, recreation and snapshot rebuilds', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'operation-budget-'));
  const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath: join(directory, 'state.json') });
  await persistence.initialize();
  let now = 1000;
  try {
    const store = new LogicalOperationStore(persistence, () => now);
    const input = { id: 'routing-1', sessionId: 'session', phase: 'user_message_routing' as const };
    const operation = await store.begin(input);
    const reservations = await Promise.allSettled([
      store.reserve('session', operation.id, 'call-1'), store.reserve('session', operation.id, 'call-2')
    ]);
    assert.equal(reservations.filter(item => item.status === 'fulfilled').length, 1);
    now += 30_000;
    await store.settle('session', operation.id, 'call-1');
    const restored = new LogicalOperationStore(persistence, () => now);
    assert.equal((await restored.begin(input)).deadlineAt, operation.deadlineAt);
    await restored.reserve('session', operation.id, 'call-2');
    await restored.settle('session', operation.id, 'call-2');
    await assert.rejects(restored.reserve('session', operation.id, 'call-3'), /BUDGET_EXHAUSTED/);
    const other = await store.begin({ ...input, id: 'expired' });
    now += 120_001;
    await assert.rejects(store.reserve('session', other.id, 'call-4'), /BUDGET_EXHAUSTED/);
  } finally { await persistence.onModuleDestroy(); rmSync(directory, { recursive: true, force: true }); }
});

test('a restarted owner blocks replacement until the previous process has really ended', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'operation-stop-'));
  const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath: join(directory, 'state.json') });
  await persistence.initialize();
  try {
    const store = new LogicalOperationStore(persistence);
    const input = { id: 'task', sessionId: 'session', phase: 'task_execution' as const };
    await store.begin(input);
    await store.reserve('session', 'task', 'old-process');
    const restored = new LogicalOperationStore(persistence);
    assert.equal(restored.hasUnknownStop('session'), true);
    await restored.begin({ ...input, id: 'replacement' });
    await assert.rejects(restored.reserve('session', 'replacement', 'new-process'), /STOP_UNCONFIRMED/);
    await store.settle('session', 'task', 'old-process', 'unconfirmed');
    await assert.rejects(restored.reserve('session', 'replacement', 'new-process'), /STOP_UNCONFIRMED/);
    await store.settle('session', 'task', 'old-process', 'confirmed');
    await restored.reserve('session', 'replacement', 'new-process');
  } finally { await persistence.onModuleDestroy(); rmSync(directory, { recursive: true, force: true }); }
});

test('a restored generation gets a new idempotent operation without overwriting its audit predecessor', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'operation-generation-'));
  const persistence = new PersistenceService({ enabled: true, backend: 'file', filePath: join(directory, 'state.json') });
  await persistence.initialize();
  const timestamp = new Date().toISOString();
  try {
    await persistence.setCollection('sessions', [{
      id: 'session', title: 'Generation session', status: 'EXECUTING', ownerId: 'test',
      createdAt: timestamp, updatedAt: timestamp
    }]);
    await persistence.setCollection('sessionLifecyclesBySession', {
      session: {
        contractVersion: 'main-agent-collaboration/v1', sessionId: 'session', dataEpoch: 'epoch',
        generation: 1, revision: 1, state: 'active', admission: 'open', stopStatus: 'idle'
      }
    });
    const store = new LogicalOperationStore(persistence);
    const original = await store.begin({
      id: 'brief-operation', sessionId: 'session', phase: 'brief_generation', scopeKey: 'brief-scope'
    });
    await store.reserve('session', original.id, 'original-invocation');
    await store.settle('session', original.id, 'original-invocation', 'confirmed', true);
    await persistence.setCollection('sessionLifecyclesBySession', {
      session: {
        contractVersion: 'main-agent-collaboration/v1', sessionId: 'session', dataEpoch: 'epoch',
        generation: 3, revision: 4, state: 'active', admission: 'open', stopStatus: 'confirmed'
      }
    });

    const restored = await store.begin({
      id: 'brief-operation', sessionId: 'session', phase: 'brief_generation', scopeKey: 'brief-scope'
    });
    const replay = await store.begin({
      id: 'brief-operation', sessionId: 'session', phase: 'brief_generation', scopeKey: 'brief-scope'
    });
    await store.reserve('session', restored.id, 'restored-invocation');

    assert.equal(store.findResumable('session', 'brief-scope'), undefined);
    await assert.rejects(store.resume('session', original.id), /SESSION_ADMISSION_CLOSED/);
    await assert.rejects(store.reserveCorrection('session', original.id), /SESSION_ADMISSION_CLOSED/);
    assert.equal(original.id, 'brief-operation');
    assert.equal(original.sessionGeneration, 1);
    assert.equal(restored.id, 'brief-operation:generation:3');
    assert.equal(restored.sessionGeneration, 3);
    assert.equal(replay.id, restored.id);
    assert.equal(store.list('session').length, 2);
  } finally {
    await persistence.onModuleDestroy();
    rmSync(directory, { recursive: true, force: true });
  }
});

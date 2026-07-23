import assert from 'node:assert/strict';
import test from 'node:test';
import { MaintenanceCoordinatorService } from './maintenance-coordinator.service.js';

function setup(options: { queueFailure?: Error } = {}) {
  const calls: string[] = [];
  let maintenance = false;
  const persistence = {
    enterMaintenanceMode() {
      calls.push('persistence.enter');
      maintenance = true;
    },
    isInMaintenanceMode: () => maintenance,
    currentDataEpoch: () => 'epoch-current'
  };
  const execution = {
    async cancelAllAndWait() {
      calls.push('execution.cancelAllAndWait');
      return { requestedCount: 2, completedCount: 2, timedOutSessionIds: [] };
    }
  };
  const queue = {
    async pauseForMaintenance() {
      calls.push('queue.pause');
      if (options.queueFailure) throw options.queueFailure;
    }
  };
  const gateway = {
    listRegistrations: () => [{ workspaceId: 'workspace-1' }, { workspaceId: 'workspace-2' }],
    invalidateAll(reason: string) {
      calls.push(`gateway.invalidate:${reason}`);
    }
  };
  const pending = {
    rejectByWorkspace(workspaceId: string, error: Error) {
      calls.push(`pending.reject:${workspaceId}:${error.message}`);
      return workspaceId === 'workspace-1' ? 2 : 1;
    }
  };
  const service = new MaintenanceCoordinatorService(
    persistence as never,
    execution as never,
    queue as never,
    gateway as never,
    pending as never
  );
  return { service, calls, persistence };
}

test('maintenance enters the persistence write gate before stopping subsystems', async () => {
  const { service, calls } = setup();
  await service.enter({ reason: 'cutover', requestedBy: 'operator' });
  assert.equal(calls[0], 'persistence.enter');
});

test('maintenance cancels all in-process executions', async () => {
  const { service, calls } = setup();
  await service.enter({ reason: 'cutover', requestedBy: 'operator' });
  assert.equal(calls.includes('execution.cancelAllAndWait'), true);
});

test('maintenance pauses the execution queue', async () => {
  const { service, calls } = setup();
  await service.enter({ reason: 'cutover', requestedBy: 'operator' });
  assert.equal(calls.includes('queue.pause'), true);
});

test('maintenance rejects pending requests for every registered Browser workspace', async () => {
  const { service, calls } = setup();
  const result = await service.enter({ reason: 'cutover', requestedBy: 'operator' });
  assert.equal(calls.some((call) => call.startsWith('pending.reject:workspace-1:')), true);
  assert.equal(calls.some((call) => call.startsWith('pending.reject:workspace-2:')), true);
  assert.equal(result.rejectedRequestCount, 3);
});

test('maintenance invalidates Browser registrations after pending requests are rejected', async () => {
  const { service, calls } = setup();
  await service.enter({ reason: 'cutover', requestedBy: 'operator' });
  const lastPendingIndex = Math.max(...calls.map((call, index) => call.startsWith('pending.reject:') ? index : -1));
  const invalidationIndex = calls.indexOf('gateway.invalidate:cutover');
  assert.ok(invalidationIndex > lastPendingIndex);
});

test('maintenance reports only operational metadata and the current dataEpoch', async () => {
  const { service } = setup();
  const result = await service.enter({ reason: 'cutover', requestedBy: 'operator' });
  assert.deepEqual(result, {
    status: 'active',
    reason: 'cutover',
    requestedBy: 'operator',
    dataEpoch: 'epoch-current',
    invalidatedWorkspaceCount: 2,
    rejectedRequestCount: 3,
    cancellationRequestedCount: 2,
    cancellationCompletedCount: 2,
    cancellationTimedOutSessionIds: []
  });
});

test('entering maintenance repeatedly is idempotent', async () => {
  const { service, calls } = setup();
  const first = await service.enter({ reason: 'cutover', requestedBy: 'operator' });
  const callCount = calls.length;
  const second = await service.enter({ reason: 'ignored', requestedBy: 'other' });
  assert.deepEqual(second, first);
  assert.equal(calls.length, callCount);
});

test('queue pause failure keeps persistence in maintenance and does not invalidate Browser registrations', async () => {
  const { service, calls, persistence } = setup({ queueFailure: new Error('redis unavailable') });
  await assert.rejects(() => service.enter({ reason: 'cutover', requestedBy: 'operator' }), /redis unavailable/);
  assert.equal(persistence.isInMaintenanceMode(), true);
  assert.equal(calls.some((call) => call.startsWith('gateway.invalidate:')), false);
});

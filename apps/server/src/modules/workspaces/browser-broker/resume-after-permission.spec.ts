import assert from 'node:assert/strict';
import test from 'node:test';
import { BrokerSuspensionRegistry, type SuspendedTaskEntry } from './resume-after-permission.js';

function baseEntry(overrides: Partial<Omit<SuspendedTaskEntry, 'suspendedAt'>> = {}): Omit<SuspendedTaskEntry, 'suspendedAt'> {
  return {
    taskId: 'task-108',
    sessionId: 'session-108',
    workspaceId: 'ws-108',
    requiredMode: 'read',
    reason: 'permission-prompt',
    ...overrides
  };
}

test('BrokerSuspensionRegistry resumes tasks when granted mode satisfies required mode', () => {
  const registry = new BrokerSuspensionRegistry(() => '2026-07-11T00:00:00.000Z');
  registry.suspend(baseEntry());
  const resumed = registry.resumeReadyForWorkspace('ws-108', 'read');
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].taskId, 'task-108');
  assert.equal(resumed[0].resumedAt, '2026-07-11T00:00:00.000Z');
  assert.deepEqual(registry.list(), []);
});

test('BrokerSuspensionRegistry does not resume when granted mode is insufficient', () => {
  const registry = new BrokerSuspensionRegistry();
  registry.suspend(baseEntry({ requiredMode: 'read_write' }));
  const resumed = registry.resumeReadyForWorkspace('ws-108', 'read');
  assert.equal(resumed.length, 0);
  assert.equal(registry.list().length, 1);
});

test('BrokerSuspensionRegistry resumes read_write task when granted mode is read_write', () => {
  const registry = new BrokerSuspensionRegistry();
  registry.suspend(baseEntry({ requiredMode: 'read_write' }));
  const resumed = registry.resumeReadyForWorkspace('ws-108', 'read_write');
  assert.equal(resumed.length, 1);
});

test('BrokerSuspensionRegistry only resumes tasks scoped to the matching workspaceId', () => {
  const registry = new BrokerSuspensionRegistry();
  registry.suspend(baseEntry({ taskId: 'a', workspaceId: 'ws-A' }));
  registry.suspend(baseEntry({ taskId: 'b', workspaceId: 'ws-B' }));
  const resumed = registry.resumeReadyForWorkspace('ws-A', 'read_write');
  assert.deepEqual(resumed.map((entry) => entry.taskId), ['a']);
  assert.equal(registry.list().length, 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceOperationResult } from '@agent-cluster/shared';
import { PendingRequestRegistry } from './pending-request-registry.js';

function okResult(requestId: string, workspaceId: string): WorkspaceOperationResult {
  return { requestId, workspaceId, operation: 'readFile', status: 'ok', data: { path: 'a' } };
}

test('PendingRequestRegistry resolves the waiter matching the requestId', async () => {
  const registry = new PendingRequestRegistry();
  const promise = registry.waitFor('req-1', 'ws-98');
  const settled = registry.settle(okResult('req-1', 'ws-98'));
  assert.equal(settled, true);
  const result = await promise;
  assert.equal(result.status, 'ok');
});

test('PendingRequestRegistry keeps concurrent requests separate by requestId', async () => {
  const registry = new PendingRequestRegistry();
  const first = registry.waitFor('req-a', 'ws-98');
  const second = registry.waitFor('req-b', 'ws-98');
  registry.settle({ requestId: 'req-b', workspaceId: 'ws-98', operation: 'readFile', status: 'ok', data: { tag: 'B' } });
  registry.settle({ requestId: 'req-a', workspaceId: 'ws-98', operation: 'readFile', status: 'ok', data: { tag: 'A' } });
  const [aResult, bResult] = await Promise.all([first, second]);
  assert.equal((aResult.data as { tag: string }).tag, 'A');
  assert.equal((bResult.data as { tag: string }).tag, 'B');
});

test('PendingRequestRegistry rejects duplicate requestId', async () => {
  const registry = new PendingRequestRegistry();
  registry.waitFor('req-1', 'ws-98');
  await assert.rejects(() => registry.waitFor('req-1', 'ws-98'), /duplicate/);
});

test('PendingRequestRegistry rejects waiter when workspaceId mismatches on settle', async () => {
  const registry = new PendingRequestRegistry();
  const promise = registry.waitFor('req-1', 'ws-98');
  const settled = registry.settle(okResult('req-1', 'other-ws'));
  assert.equal(settled, false);
  await assert.rejects(() => promise, /workspaceId mismatch/);
});

test('PendingRequestRegistry rejectByWorkspace clears all waiters for a workspace', async () => {
  const registry = new PendingRequestRegistry();
  const first = registry.waitFor('req-1', 'ws-98');
  const second = registry.waitFor('req-2', 'ws-98');
  const other = registry.waitFor('req-3', 'other-ws');
  const rejected = registry.rejectByWorkspace('ws-98', new Error('client disconnected'));
  assert.equal(rejected, 2);
  await assert.rejects(() => first, /disconnected/);
  await assert.rejects(() => second, /disconnected/);
  registry.settle(okResult('req-3', 'other-ws'));
  const other3 = await other;
  assert.equal(other3.status, 'ok');
});

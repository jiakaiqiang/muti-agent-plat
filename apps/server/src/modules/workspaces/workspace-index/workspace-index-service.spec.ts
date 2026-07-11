import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceIndexEntry, WorkspaceRevision } from '@agent-cluster/shared';
import { WorkspaceIndexService } from './workspace-index-service.js';

const revA = {
  id: 'rev-a',
  observedAt: '2026-07-11T00:00:00.000Z'
} satisfies WorkspaceRevision;

const revB = {
  id: 'rev-b',
  observedAt: '2026-07-11T00:00:01.000Z'
} satisfies WorkspaceRevision;

function entry(path: string, revision: WorkspaceRevision): WorkspaceIndexEntry {
  return {
    path,
    kind: 'file',
    size: 1,
    hash: { algorithm: 'sha256', value: 'b'.repeat(64) },
    revision,
    generated: false,
    sensitive: false
  };
}

test('WorkspaceIndexService hits cache on same workspaceId + revision', () => {
  const service = new WorkspaceIndexService();
  const entries = [entry('a.ts', revA)];
  service.setIndex('ws-1', revA, entries);
  assert.deepEqual(service.getIndex('ws-1', revA), entries);
});

test('WorkspaceIndexService misses cache on a different revision', () => {
  const service = new WorkspaceIndexService();
  service.setIndex('ws-1', revA, [entry('a.ts', revA)]);
  assert.equal(service.getIndex('ws-1', revB), undefined);
});

test('WorkspaceIndexService keeps workspaces independent', () => {
  const service = new WorkspaceIndexService();
  const wsOne = [entry('a.ts', revA)];
  const wsTwo = [entry('b.ts', revA)];
  service.setIndex('ws-1', revA, wsOne);
  service.setIndex('ws-2', revA, wsTwo);
  assert.deepEqual(service.getIndex('ws-1', revA), wsOne);
  assert.deepEqual(service.getIndex('ws-2', revA), wsTwo);
});

test('WorkspaceIndexService invalidateOn drops the workspace cache when revision changes', () => {
  const service = new WorkspaceIndexService();
  service.setIndex('ws-1', revA, [entry('a.ts', revA)]);
  service.invalidateOn('ws-1', revB);
  assert.equal(service.getIndex('ws-1', revA), undefined);
  assert.equal(service.currentRevisionId('ws-1'), null);
});

test('WorkspaceIndexService drop removes an entire workspace cache', () => {
  const service = new WorkspaceIndexService();
  service.setIndex('ws-1', revA, [entry('a.ts', revA)]);
  service.drop('ws-1');
  assert.equal(service.getIndex('ws-1', revA), undefined);
});

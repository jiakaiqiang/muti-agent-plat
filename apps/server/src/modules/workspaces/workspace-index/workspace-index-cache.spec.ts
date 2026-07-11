import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceIndexEntry, WorkspaceRevision } from '@agent-cluster/shared';
import { WorkspaceIndexCache } from './workspace-index-cache.js';

const oldRevision = {
  id: 'revision-67-old',
  observedAt: '2026-07-11T00:00:00.000Z'
} satisfies WorkspaceRevision;

const newRevision = {
  id: 'revision-67-new',
  observedAt: '2026-07-11T00:00:01.000Z'
} satisfies WorkspaceRevision;

function entry(path: string, revision: WorkspaceRevision): WorkspaceIndexEntry {
  return {
    path,
    kind: 'file',
    size: 1,
    hash: { algorithm: 'sha256', value: 'a'.repeat(64) },
    revision,
    generated: false,
    sensitive: false
  };
}

test('WorkspaceIndexCache returns entries for the current revision', () => {
  const cache = new WorkspaceIndexCache();
  const entries = [entry('a.ts', oldRevision)];
  cache.set(oldRevision, entries);
  assert.deepEqual(cache.get(oldRevision), entries);
});

test('WorkspaceIndexCache returns undefined for a mismatched revision', () => {
  const cache = new WorkspaceIndexCache();
  cache.set(oldRevision, [entry('a.ts', oldRevision)]);
  assert.equal(cache.get(newRevision), undefined);
});

test('WorkspaceIndexCache invalidateOn drops entries when the revision changes', () => {
  const cache = new WorkspaceIndexCache();
  cache.set(oldRevision, [entry('a.ts', oldRevision)]);
  cache.invalidateOn(newRevision);
  assert.equal(cache.get(oldRevision), undefined);
  assert.equal(cache.currentRevisionId(), null);
});

test('WorkspaceIndexCache invalidateOn keeps entries when revision matches', () => {
  const cache = new WorkspaceIndexCache();
  const entries = [entry('a.ts', oldRevision)];
  cache.set(oldRevision, entries);
  cache.invalidateOn(oldRevision);
  assert.deepEqual(cache.get(oldRevision), entries);
});

test('WorkspaceIndexCache clear removes any cached entries', () => {
  const cache = new WorkspaceIndexCache();
  cache.set(oldRevision, [entry('a.ts', oldRevision)]);
  cache.clear();
  assert.equal(cache.get(oldRevision), undefined);
});

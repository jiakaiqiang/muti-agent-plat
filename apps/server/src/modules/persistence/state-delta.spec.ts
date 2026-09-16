import assert from 'node:assert/strict';
import test from 'node:test';

test('an initially absent nested collection preserves records added by another writer', () => {
  assert.deepEqual(applyStateDelta(undefined, { session: [{ id: 'local' }] }, { session: [{ id: 'remote' }] }),
    { session: [{ id: 'remote' }, { id: 'local' }] });
});
import { applyStateDelta } from './state-delta.js';

test('merges changes without losing concurrent records or unmodified fields', () => {
  const before = [{ id: 's', status: 'RUNNING', activeWorkItemId: 'old' }];
  const changed = [{ ...before[0], status: 'PAUSED' }];
  const current = [{ ...before[0], activeWorkItemId: 'new' }, { id: 'other', status: 'RUNNING' }];
  assert.deepEqual(applyStateDelta(before, changed, current), [
    { id: 's', status: 'PAUSED', activeWorkItemId: 'new' }, current[1]
  ]);
});
test('preserves concurrent additions while applying explicit deletion and nested updates', () => {
  assert.deepEqual(applyStateDelta({ s: [{ id: 'a' }] }, { s: [{ id: 'b' }] }, { s: [{ id: 'a' }, { id: 'c' }] }),
    { s: [{ id: 'c' }, { id: 'b' }] });
  assert.deepEqual(applyStateDelta({ a: 1 }, {}, { a: 1, b: 2 }), { b: 2 });
});
test('unchanged local snapshot retains canonical database fields and updates', () => {
  const base = { id: 'outbox', status: 'pending' };
  const database = { ...base, status: 'published', leaseOwner: null };
  assert.deepEqual(applyStateDelta(base, base, database), database);
  assert.deepEqual(applyStateDelta(['old'], ['new'], ['other']), ['new']);
});

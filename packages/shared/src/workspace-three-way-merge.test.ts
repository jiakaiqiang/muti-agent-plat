import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeWorkspaceText } from './workspace-three-way-merge.js';

test('three-way merge combines non-overlapping edits', () => {
  const result = mergeWorkspaceText('one\ntwo\nthree\n', 'ONE\ntwo\nthree\n', 'one\ntwo\nTHREE\n');
  assert.deepEqual(result, { ok: true, content: 'ONE\ntwo\nTHREE\n', merged: true });
});

test('three-way merge reports overlapping edits without conflict markers', () => {
  const result = mergeWorkspaceText('one\ntwo\n', 'ONE\ntwo\n', 'first\ntwo\n');
  assert.deepEqual(result, { ok: false, reason: 'overlapping_changes' });
});

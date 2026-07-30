import assert from 'node:assert/strict';
import test from 'node:test';
import { createFileRevisionDiff } from './file-revision-diff.js';

test('createFileRevisionDiff returns deterministic line additions and removals', () => {
  const first = createFileRevisionDiff('one\ntwo\nthree', 'one\nTWO\nthree\nfour');
  const second = createFileRevisionDiff('one\ntwo\nthree', 'one\nTWO\nthree\nfour');

  assert.deepEqual(first, second);
  assert.deepEqual(first.summary, {
    addedLines: 2,
    removedLines: 1,
    unchangedLines: 2,
    hunkCount: 1
  });
  assert.deepEqual(
    first.hunks[0]?.lines.filter((line) => line.kind !== 'context'),
    [
      { kind: 'remove', content: 'two' },
      { kind: 'add', content: 'TWO' },
      { kind: 'add', content: 'four' }
    ]
  );
});

test('createFileRevisionDiff returns no hunks for identical content', () => {
  const result = createFileRevisionDiff('same\ncontent', 'same\ncontent');
  assert.equal(result.hunks.length, 0);
  assert.equal(result.summary.addedLines, 0);
  assert.equal(result.summary.removedLines, 0);
});

test('createFileRevisionDiff separates distant edits into bounded hunks', () => {
  const original = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join('\n');
  const revised = original.replace('line-2', 'changed-2').replace('line-19', 'changed-19');
  const result = createFileRevisionDiff(original, revised);
  assert.equal(result.hunks.length, 2);
});

test('createFileRevisionDiff fails closed when configured limits are exceeded', () => {
  assert.throws(
    () => createFileRevisionDiff('one\ntwo', 'three\nfour', {
      maxInputBytes: 1_000,
      maxLines: 100,
      maxEditDistance: 1,
      timeoutMs: 1_000
    }),
    /REVISION_DIFF_COMPLEXITY_EXCEEDED/
  );
  assert.throws(
    () => createFileRevisionDiff('one', 'two', {
      maxInputBytes: 2,
      maxLines: 100,
      maxEditDistance: 100,
      timeoutMs: 1_000
    }),
    /REVISION_DIFF_INPUT_TOO_LARGE/
  );
});

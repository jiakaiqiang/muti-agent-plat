import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildReportDiffPreview } from './reportDiffPreview';

test('buildReportDiffPreview returns all rows as add for a new file', () => {
  const preview = buildReportDiffPreview({
    path: 'agent-output/report.md',
    nextContent: '# Title\nline 2\nline 3'
  });
  assert.equal(preview.mode, 'create');
  assert.deepEqual(preview.rows.map((r) => r.kind), ['add', 'add', 'add']);
  assert.equal(preview.addedLines, 3);
  assert.equal(preview.removedLines, 0);
  assert.equal(preview.requiresConfirmation, true);
});

test('buildReportDiffPreview finds add/remove pairs on modified lines', () => {
  const preview = buildReportDiffPreview({
    path: 'r.md',
    previousContent: 'one\ntwo\nthree',
    nextContent: 'one\ntwo-modified\nthree'
  });
  assert.equal(preview.mode, 'update');
  const kinds = preview.rows.map((r) => r.kind);
  assert.deepEqual(kinds, ['equal', 'remove', 'add', 'equal']);
});

test('buildReportDiffPreview marks preview requiresConfirmation=false when content is identical', () => {
  const preview = buildReportDiffPreview({
    path: 'r.md',
    previousContent: 'one\ntwo',
    nextContent: 'one\ntwo'
  });
  assert.equal(preview.requiresConfirmation, false);
  assert.equal(preview.addedLines, 0);
  assert.equal(preview.removedLines, 0);
});

test('buildReportDiffPreview handles pure appends', () => {
  const preview = buildReportDiffPreview({
    path: 'r.md',
    previousContent: 'one\ntwo',
    nextContent: 'one\ntwo\nthree'
  });
  assert.equal(preview.addedLines, 1);
  assert.equal(preview.removedLines, 0);
  const kinds = preview.rows.map((r) => r.kind);
  assert.deepEqual(kinds, ['equal', 'equal', 'add']);
});
